import type { GspInfo, GspSnapshot, GspRxStatus, ParamDescriptor, ParamListPage } from './types';

export function decodeInfo(data: Uint8Array): GspInfo {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    protocolVersion: v.getUint8(0),
    fwMajor: v.getUint8(1),
    fwMinor: v.getUint8(2),
    fwPatch: v.getUint8(3),
    boardId: v.getUint16(4, true),
    motorProfile: v.getUint8(6),
    motorPolePairs: v.getUint8(7),
    featureFlags: v.getUint32(8, true),
    pwmFrequency: v.getUint32(12, true),
    maxErpm: v.getUint32(16, true),
  };
}

/* ── NTC temperature (GarudaESE) — mirrors garuda_gsp/protocol.py ─────────
 * +3.3V -> TH1 (10k NTC) -> TEMP node -> R65 (4.7k) -> GND, read on AD3AN5.
 * NTC on TOP: resistance FALLS as it heats -> counts RISE with temperature.
 *   R_ntc = R_fix * (4095/counts - 1);  1/T = 1/T0 + (1/Beta)*ln(R_ntc/R25)
 * BETA UNCONFIRMED on this board — 3435 typical for a 10k 0402 NTC. */
const NTC_R_FIXED = 4700.0;   // R65 (node -> GND)
const NTC_R25 = 10000.0;      // TH1 nominal @25 C
const NTC_BETA = 3435.0;      // UNCONFIRMED — bench-calibrate
const NTC_T0_K = 298.15;      // 25 C in Kelvin

/** Convert raw NTC ADC counts (0..4095) to degrees Celsius. Returns null
 * for non-physical readings (open/short). */
function ntcCountsToC(counts: number): number | null {
  if (counts <= 0 || counts >= 4095) return null;
  const rNtc = NTC_R_FIXED * (4095.0 / counts - 1.0);
  if (rNtc <= 0.0) return null;
  const invT = 1.0 / NTC_T0_K + (1.0 / NTC_BETA) * Math.log(rNtc / NTC_R25);
  return 1.0 / invT - 273.15;
}

export function decodeSnapshot(data: Uint8Array): GspSnapshot {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const hasDiag = data.byteLength >= 150;  // v3: observer/PI/diag fields
  const hasFocVdVq = data.byteLength >= 114;
  const hasFoc = data.byteLength >= 106;

  /* ── 6-step AKESC v3 tail (mirrors Python garuda_gsp/decode.py) ──
   * These offsets are disjoint from the FOC float region (68-148), so both
   * formats decode from one buffer; the consumer picks by mode. Bus/phase
   * current scale: 3mΩ shunt × 24.95 gain ≈ 93 counts/A, 2048 = rest bias. */
  const n = data.byteLength;

  /* dspic33AKESC-Simplified ships EXACTLY 68B and computes REAL units on-chip,
   * placed in a tail that OVERLAPS the production morph/tick fields (eRPM u32 @50,
   * Vbus mV @54, currents centi-amps signed @56..64). So trust that tail ONLY when
   * the snapshot is exactly 68B (production sends 106B+). See dspic33AKESC-
   * Simplified/src/gsp.c sendSnapshot() for the byte map. */
  const isSimplified = n === 68;

  const IBUS_A = 3.3 / (4095 * 24.95 * 0.003);    // ≈ 0.01077 A / ADC count
  const adcToA = (raw: number) => (raw - 2048) * IBUS_A;

  let ibusInstA: number, ibusAvgA: number, ibusWinA: number;
  let iaPkMagA = 0, ibPkMagA = 0;
  let erpmReal = 0, vbusV = 0;
  let hwzcEnabled = v.getUint8(30) !== 0;
  let hwzcStepPeriodHR = v.getUint32(40, true);

  if (isSimplified) {
    erpmReal = v.getUint32(50, true);
    vbusV = v.getUint16(54, true) / 1000;                 // firmware mV (divider 23.2)
    const iaCa = v.getInt16(56, true), ibCa = v.getInt16(58, true);
    const ibusCa = v.getInt16(62, true), ibusAvgCa = v.getInt16(64, true);
    ibusInstA = ibusCa / 100;
    ibusAvgA = ibusAvgCa / 100;                            // smoothed EMA (trustworthy)
    ibusWinA = ibusAvgA;
    iaPkMagA = Math.abs(iaCa) / 100;
    ibPkMagA = Math.abs(ibCa) / 100;
    // The simplified omits hwzcStepPeriodHR, but it is EXACTLY 1e9/eRPM (firmware
    // HR_ERPM_CONST = 1e9) so synthesise it -> every `1e9 / hwzcStepPeriodHR` eRPM
    // consumer (App, LiveTunePanel) reads the real speed with no further change.
    hwzcEnabled = true;
    hwzcStepPeriodHR = erpmReal > 0 ? Math.round(1e9 / erpmReal) : 0;
  } else {
    ibusInstA = adcToA(v.getUint16(10, true));            // valley inst (unreliable)
    ibusAvgA = n >= 248 ? adcToA(v.getUint16(246, true)) : ibusInstA;
    ibusWinA = ibusInstA;
    if (n >= 208) {
      const pos = adcToA(v.getUint16(198, true));         // window max
      const neg = adcToA(v.getUint16(200, true));         // window min
      ibusWinA = Math.abs(neg) > Math.abs(pos) ? neg : pos; // signed dominant
    }
    if (n >= 198) {
      // 174:ia 176:ib 178:iaMax 180:iaMin 182:ibMax 184:ibMin
      iaPkMagA = Math.max(Math.abs(adcToA(v.getUint16(178, true))), Math.abs(adcToA(v.getUint16(180, true))));
      ibPkMagA = Math.max(Math.abs(adcToA(v.getUint16(182, true))), Math.abs(adcToA(v.getUint16(184, true))));
    }
  }
  /* ── AN1078 FOC 254B tail (mirrors decode.py struct.unpack_from("<hhH", p, 248)) ──
   * Real 3rd-phase current (Iw, best-2-of-3), real DC-bus current (Ibus, ATA CSA),
   * and NTC temperature. Compact int16 centi-amps + raw NTC counts appended at
   * offset 248 (snapshot grew 248→254B). Only populated in the AN1078 FOC build;
   * older/other builds stop before 254 → null (matches decode.py's None). */
  let focIw_A: number | null = null;
  let focIbus_A: number | null = null;
  let tempC: number | null = null;
  let tempRaw = 0;
  if (n >= 254) {
    const iwCa = v.getInt16(248, true);
    const ibusCa = v.getInt16(250, true);
    tempRaw = v.getUint16(252, true);
    focIw_A = iwCa / 100;
    focIbus_A = ibusCa / 100;
    tempC = ntcCountsToC(tempRaw);
  }

  const hwzcReject = n >= 174 ? v.getUint32(170, true) : 0;
  const cpuLoadPct = n >= 242 ? v.getUint16(228, true) / 10 : 0;
  const missBySector = n >= 242
    ? [0, 1, 2, 3, 4, 5].map(i => v.getUint16(230 + i * 2, true))
    : [];

  return {
    state: v.getUint8(0),
    faultCode: v.getUint8(1),
    currentStep: v.getUint8(2),
    direction: v.getUint8(3),
    throttle: v.getUint16(4, true),
    dutyPct: v.getUint8(6),
    vbusRaw: v.getUint16(8, true),
    ibusRaw: v.getUint16(10, true),
    ibusMax: v.getUint16(12, true),
    bemfRaw: v.getUint16(14, true),
    zcThreshold: v.getUint16(16, true),
    stepPeriod: v.getUint16(18, true),
    goodZcCount: v.getUint16(20, true),
    risingZcWorks: v.getUint8(22) !== 0,
    fallingZcWorks: v.getUint8(23) !== 0,
    zcSynced: v.getUint8(24) !== 0,
    zcConfirmedCount: v.getUint16(26, true),
    zcTimeoutForceCount: v.getUint16(28, true),
    hwzcEnabled,
    hwzcPhase: v.getUint8(31),
    hwzcTotalZcCount: v.getUint32(32, true),
    hwzcTotalMissCount: v.getUint32(36, true),
    hwzcStepPeriodHR,
    hwzcDbgLatchDisable: v.getUint8(44) !== 0,
    morphSubPhase: v.getUint8(46),
    morphStep: v.getUint8(47),
    morphZcCount: v.getUint16(48, true),
    morphAlpha: v.getUint16(50, true),
    clpciTripCount: v.getUint32(52, true),
    fpciTripCount: v.getUint32(56, true),
    systemTick: v.getUint32(60, true),
    uptimeSec: v.getUint32(64, true),
    // FOC fields (backward-compatible: zero if snapshot is old format)
    focIdMeas: hasFoc ? v.getFloat32(68, true) : 0,
    focIqMeas: hasFoc ? v.getFloat32(72, true) : 0,
    focTheta: hasFoc ? v.getFloat32(76, true) : 0,
    focOmega: hasFoc ? v.getFloat32(80, true) : 0,
    focVbus: hasFoc ? v.getFloat32(84, true) : 0,
    focIa: hasFoc ? v.getFloat32(88, true) : 0,
    focIb: hasFoc ? v.getFloat32(92, true) : 0,
    focThetaObs: hasFoc ? v.getFloat32(96, true) : 0,
    focVd: hasFocVdVq ? v.getFloat32(100, true) : 0,
    focVq: hasFocVdVq ? v.getFloat32(104, true) : 0,
    // Observer internals (v3)
    focFluxAlpha: hasDiag ? v.getFloat32(108, true) : 0,
    focFluxBeta: hasDiag ? v.getFloat32(112, true) : 0,
    focLambdaEst: hasDiag ? v.getFloat32(116, true) : 0,
    focObsGain: hasDiag ? v.getFloat32(120, true) : 0,
    // PI controller internals (v3)
    focPidDInteg: hasDiag ? v.getFloat32(124, true) : 0,
    focPidQInteg: hasDiag ? v.getFloat32(128, true) : 0,
    focPidSpdInteg: hasDiag ? v.getFloat32(132, true) : 0,
    // Derived diagnostics (v3)
    focModIndex: hasDiag ? v.getFloat32(136, true) : 0,
    focObsConfidence: hasDiag ? v.getFloat32(140, true) : 0,
    // Sub-state and offsets — position depends on format version
    focSubState: hasDiag ? v.getUint8(144) : (hasFocVdVq ? v.getUint8(108) : (hasFoc ? v.getUint8(100) : 0)),
    focOffsetIa: hasDiag ? v.getUint16(146, true) : (hasFocVdVq ? v.getUint16(110, true) : (hasFoc ? v.getUint16(102, true) : 0)),
    focOffsetIb: hasDiag ? v.getUint16(148, true) : (hasFocVdVq ? v.getUint16(112, true) : (hasFoc ? v.getUint16(104, true) : 0)),
    // AN1078 FOC 254B tail (null when snapshot < 254B)
    focIw_A, focIbus_A, tempC, tempRaw,
    // 6-step AKESC v3 tail
    ibusInstA, ibusAvgA, ibusWinA, hwzcReject, iaPkMagA, ibPkMagA,
    cpuLoadPct, missBySector, snapBytes: n,
    // dspic33AKESC-Simplified real units (0 / false for other firmware)
    erpmReal, vbusV, simplified: isSimplified,
  };
}

/** V2 paginated param list: 3-byte header + 12 bytes/entry (u32 min/max) */
export function decodeParamList(data: Uint8Array): ParamListPage {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const totalCount = v.getUint8(0);
  const startIndex = v.getUint8(1);
  const entryCount = v.getUint8(2);
  const entries: ParamDescriptor[] = [];
  for (let i = 0; i < entryCount; i++) {
    const off = 3 + i * 12;
    entries.push({
      id: v.getUint16(off, true),
      type: v.getUint8(off + 2),
      group: v.getUint8(off + 3),
      min: v.getUint32(off + 4, true),
      max: v.getUint32(off + 8, true),
    });
  }
  return { totalCount, startIndex, entries };
}

export function decodeRxStatus(data: Uint8Array): GspRxStatus {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    linkState: v.getUint8(0),
    protocol: v.getUint8(1),
    dshotRate: v.getUint8(2),
    // byte 3 = pad
    throttle: v.getUint16(4, true),
    pulseUs: v.getUint16(6, true),
    crcErrors: v.getUint16(8, true),
    droppedFrames: v.getUint16(10, true),
  };
}

export function decodeParamValue(data: Uint8Array): { id: number; value: number } {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { id: v.getUint16(0, true), value: v.getUint32(2, true) };
}
