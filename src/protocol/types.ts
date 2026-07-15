export interface GspInfo {
  protocolVersion: number;
  fwMajor: number;
  fwMinor: number;
  fwPatch: number;
  boardId: number;
  motorProfile: number;
  motorPolePairs: number;
  featureFlags: number;
  pwmFrequency: number;
  maxErpm: number;
}

export interface GspSnapshot {
  state: number;
  faultCode: number;
  currentStep: number;
  direction: number;
  throttle: number;
  dutyPct: number;
  vbusRaw: number;
  ibusRaw: number;
  ibusMax: number;
  bemfRaw: number;
  zcThreshold: number;
  stepPeriod: number;
  goodZcCount: number;
  risingZcWorks: boolean;
  fallingZcWorks: boolean;
  zcSynced: boolean;
  zcConfirmedCount: number;
  zcTimeoutForceCount: number;
  hwzcEnabled: boolean;
  hwzcPhase: number;
  hwzcTotalZcCount: number;
  hwzcTotalMissCount: number;
  hwzcStepPeriodHR: number;
  hwzcDbgLatchDisable: boolean;
  morphSubPhase: number;
  morphStep: number;
  morphZcCount: number;
  morphAlpha: number;
  clpciTripCount: number;
  fpciTripCount: number;
  systemTick: number;
  uptimeSec: number;
  // FOC telemetry (zero when FOC not enabled)
  focIdMeas: number;
  focIqMeas: number;
  focTheta: number;
  focOmega: number;
  focVbus: number;
  focIa: number;
  focIb: number;
  focThetaObs: number;
  focVd: number;
  focVq: number;
  // Observer internals
  focFluxAlpha: number;
  focFluxBeta: number;
  focLambdaEst: number;
  focObsGain: number;
  // PI controller internals
  focPidDInteg: number;
  focPidQInteg: number;
  focPidSpdInteg: number;
  // Derived diagnostics
  focModIndex: number;
  focObsConfidence: number;
  focSubState: number;
  focOffsetIa: number;
  focOffsetIb: number;
  /* ── AN1078 FOC 254B tail (snapshot grew 248→254B, 2026-07-14) ──
   * Real 3rd-phase current (Iw, best-2-of-3), real DC-bus current (Ibus,
   * ATA CSA — valley-sampled, under-reads at low duty, not for protection),
   * and NTC board temperature. int16 centi-amps @248/@250 + raw NTC counts
   * @252. null when the snapshot is the older/shorter format (mirrors
   * decode.py leaving them None). tempC is also null on open/short NTC. */
  focIw_A: number | null;
  focIbus_A: number | null;
  tempC: number | null;
  tempRaw: number;
  /* ── 6-step AKESC v3 tail (length-guarded; 0/[] when the snapshot is shorter) ──
   * Engineering-derived bus current: the firmware exposes three views.
   *   ibusInstA — valley-sampled instantaneous (UNRELIABLE: phantom ~-20A idle)
   *   ibusAvgA  — firmware IIR of the pulse-center conduction sample (trustworthy)
   *   ibusWinA  — windowed peak over the PWM cycle, signed (motoring +, regen -) */
  ibusInstA: number;
  ibusAvgA: number;
  ibusWinA: number;
  hwzcReject: number;
  iaPkMagA: number;
  ibPkMagA: number;
  cpuLoadPct: number;
  missBySector: number[];
  snapBytes: number;
  /* ── dspic33AKESC-Simplified real units (firmware-scaled on-chip) ──
   * Only meaningful when `simplified` is true (snapshot is exactly 68B); 0/false
   * otherwise. eRPM and currents are already real; vbusV uses the firmware's own
   * divider (23.2) rather than the Studio default. */
  erpmReal: number;
  vbusV: number;
  simplified: boolean;
}

/* ── Board IDs ─────────────────────────────────────────────── */
export const BOARD_ID_AK = 0x0001;  /* MCLV-48V-300W (dsPIC33AK) */

export const BOARD_NAMES: Record<number, string> = {
  [BOARD_ID_AK]: 'MCLV-48V-300W (AK)',
};


export interface ParamDescriptor {
  id: number;
  type: number;
  group: number;
  min: number;
  max: number;
}

/* GarudaESE ATA6847 gate-driver diagnostics (CMD_ATA_DIAG reply, 13 bytes).
 * NOTE: reading is destructive — the SIR fault registers are read-to-clear. */
export interface AtaDiag {
  DSR1: number;
  DSR2: number;
  SIR1: number;
  SIR2: number;
  SIR3: number;
  SIR4: number;
  SIR5: number;
  GOPMCR: number;
  lastDsr1AtNormal: number;
  lastGduAttempts: number;
  lastGduResult: number;
  ataReady: number;
}

export interface ParamListPage {
  totalCount: number;
  startIndex: number;
  entries: ParamDescriptor[];
}

export const ESC_STATES = ['IDLE', 'ARMED', 'DETECT', 'ALIGN', 'OL_RAMP', 'MORPH', 'CLOSED_LOOP', 'BRAKING', 'RECOVERY', 'FAULT'] as const;
export const FAULT_CODES = ['NONE', 'OVERVOLTAGE', 'UNDERVOLTAGE', 'OVERCURRENT', 'BOARD_PCI', 'STALL', 'DESYNC', 'STARTUP_TIMEOUT', 'MORPH_TIMEOUT', 'RX_LOSS', 'FOC_INTERNAL', 'FOC_BUSLOSS', 'TRAP_BUS', 'TRAP_ILLEGAL', 'TRAP_ADDRESS', 'TRAP_STACK', 'TRAP_MATH', 'TRAP_GENERAL', 'TRAP_DEFAULT'] as const;
export const FOC_SUB_STATES = ['IDLE', 'ARMED', 'ALIGN', 'I/F RAMP', 'CLOSED_LOOP'] as const;
export const DETECT_PHASE_NAMES = ['Idle', 'Measuring Rs', 'Measuring Ls', 'Re-Aligning', 'Measuring Lambda', 'Auto-Tuning', 'Complete', 'Failed'] as const;

/* Profile slot 2 (originally "5010 750KV", then the PRODRONE 2810) now holds
 * the T-Motor U3 KV700 — see dspic33AKESC motors.h / an1078_params.h
 * (GSP_PROFILE_U3 = 2; the slot value stays 2 for EEPROM compat).  The label
 * must match what the firmware tunes for.  Slot 3 still holds 5055 (kept
 * since profile defaults haven't been rewritten). */
export const PROFILE_NAMES = ['Hurst Long (300W)', 'A2212 1400KV', 'U3-KV700', '5055 580KV', 'Custom'] as const;
export const PROFILE_COUNT = 4; /* built-in profiles (excl. Custom) */

/* Display-only names by profile id, covering ids the (write-)selector array above
 * doesn't - e.g. the dspic33AKESC-Simplified compile-time motors GET_INFO reports
 * (6 = VEX, 9 = U3). Used for SHOWING the connected board's profile, not selection. */
export const PROFILE_DISPLAY_NAMES: Record<number, string> = {
  0: 'Hurst Long (300W)', 1: 'A2212 1400KV', 2: 'U3-KV700', 3: '5055 580KV',
  4: 'Custom', 6: 'VEX 4000KV', 9: 'U3 KV700',
};

export const PARAM_NAMES: Record<number, string> = {
  // Startup & Ramp (group 0)
  0x15: 'Handoff Speed [rampTargetErpm]',
  0x16: 'Ramp Acceleration [rampAccelErpmPerS]',
  0x17: 'Ramp Max Duty [rampDutyPct]',
  0x51: 'Alignment Duty [alignDutyPct]',
  0x52: 'Initial Speed [initialErpm]',
  0x54: 'Sine Align Modulation [sineAlignModPct]',
  0x55: 'Sine Ramp Modulation [sineRampModPct]',
  // Closed-Loop Control (group 1)
  0x20: 'Idle Duty [clIdleDutyPct]',
  0x22: 'Timing Advance Limit [timingAdvMaxDeg]',
  0x30: 'HW Zero-Cross Enable Speed [hwzcCrossoverErpm]',
  0x53: 'Max Closed-Loop Speed [maxClosedLoopErpm]',
  0x56: 'Demag Duty Threshold [zcDemagDutyThresh]',
  0x57: 'Demag Extra Blanking [zcDemagBlankExtraPct]',
  // Current Protection (group 2)
  0x42: 'Current Soft Limit [ocSwLimitMa]',
  0x41: 'Current Hard Fault [ocFaultMa]',
  0x58: 'CMP3 Current Limit [ocLimitMa]',
  0x59: 'Startup Current Limit [ocStartupMa]',
  0x5A: 'Ramp Current Gate [rampCurrentGateMa]',
  // ZC Detection (group 3)
  0x64: 'ZC Blanking [zcBlankingPercent]',
  0x65: 'ZC ADC Deadband [zcAdcDeadband]',
  0x66: 'ZC Sync Threshold [zcSyncThreshold]',
  0x67: 'ZC Filter Threshold [zcFilterThreshold]',
  // Duty Slew (group 4)
  0x60: 'Duty Slew Up Rate [dutySlewUpPctPerMs]',
  0x61: 'Duty Slew Down Rate [dutySlewDownPctPerMs]',
  0x62: 'Post-Sync Settle Time [postSyncSettleMs]',
  0x63: 'Post-Sync Slew Divisor [postSyncSlewDivisor]',
  // Voltage Protection (group 5)
  0x68: 'Overvoltage Threshold [vbusOvAdc]',
  0x69: 'Undervoltage Threshold [vbusUvAdc]',
  // Recovery (group 6)
  0x6A: 'Desync Coast Time [desyncCoastMs]',
  0x6B: 'Max Restart Attempts [desyncMaxRestarts]',
  0x6C: 'Morph Lock ZC Count [morphLockZcCount]',
  0x6D: 'Morph Lock Tolerance [morphLockTolPct]',
  0x6E: 'I-f Startup Current [ifCurrentCa]',
  0x6F: 'I-f Ramp Rate [ifRampErpmPerS]',
  // Motor Hardware (group 7)
  0x50: 'Motor Pole Pairs [motorPolePairs]',
  // FOC Motor Model (group 8)
  0x70: 'Phase Resistance [focRsMilliOhm]',
  0x71: 'Phase Inductance [focLsMicroH]',
  0x72: 'Back-EMF Constant [focKeUvSRad]',
  0x73: 'Nominal Bus Voltage [focVbusNomCentiV]',
  0x74: 'Max Phase Current [focMaxCurrentCentiA]',
  0x75: 'Max Electrical Speed [focMaxElecRadS]',
  // FOC Tuning (group 9)
  0x76: 'Current Loop Kp [focKpDqMilli]',
  0x77: 'Current Loop Ki [focKiDq]',
  0x78: 'Observer LPF Alpha [focObsLpfAlphaMilli]',
  // FOC Startup (group 10)
  0x79: 'Align Current [focAlignIqCentiA]',
  0x7A: 'Ramp Current [focRampIqCentiA]',
  0x7B: 'Alignment Time [focAlignTimeMs]',
  0x7C: 'Iq Ramp Time [focIqRampTimeMs]',
  0x7D: 'Speed Ramp Rate [focRampRateRps2]',
  0x7E: 'CL Handoff Speed [focHandoffRadS]',
  0x7F: 'OC Fault Threshold [focFaultOcCentiA]',
  0x80: 'Stall Speed Threshold [focFaultStallDeciRadS]',
  // AN1078 SMO Live Tuning (group 11) — settable while motor is running
  0x90: 'AN1078 Theta Offset BASE [an1078ThetaBaseDegX10]',
  0x91: 'AN1078 Theta Offset K [an1078ThetaKE7]',
  0x92: 'AN1078 SMC Kslide [an1078KslideMv]',
  0x93: 'AN1078 FW Max |Id| [an1078IdFwMaxDecia]',
  /* ── Params advertised by current firmware but previously unnamed in the
   * studio (mirrors garuda_gsp/protocol.py PARAM_NAMES exactly). protocol.py
   * carries no units/tooltips/groups for these, so those tables stay silent. */
  // WS1 load-adaptive demag blank, WS2 phase-stall fault
  0x5B: 'zcDemagBlankPerA', 0x5C: 'zcDemagBlankIbusDb',
  0x5D: 'stallIphaseAdc', 0x5E: 'stallDebounceMs', 0x5F: 'stallArmErpm',
  // AN_STA super-twisting observer tuning (FEATURE_AN_STA build)
  0x94: 'staK1bMilli', 0x95: 'staK1aE6',
  0x96: 'staK2b', 0x97: 'staK2aE6',
  0x98: 'staWClampFloorMv', 0x99: 'staThetaBaseDegX10',
  0x9A: 'staThetaKlatE7',
  // WS3 duty-adaptive BEMF sample trigger + WS1 demag blank cap
  0x9B: 'bemfTrigBasePct', 0x9C: 'bemfTrigDutyThreshPct', 0x9D: 'bemfTrigShiftQ',
  0x9E: 'zcDemagBlankMaxPct',
  // Diag / FOC OC-forensics latch (dual-purpose spares)
  0xA0: 'dbgMinStepPeriod', 0xA1: 'dbgMistimeEvents',
  0xA2: 'dbgFeSamples', 0xA3: 'dbgFeVoteResets',
  0xA4: 'dbgFeD3Min', 0xA5: 'dbgFeD3Max',
  // OL→CL handoff settling-window iqRef clamp (both observers, live-tunable)
  0xB0: 'handoffSettleTicks', 0xB1: 'handoffIqCapCa',
};

export const PARAM_UNITS: Record<number, string> = {
  0x15: 'eRPM', 0x16: 'eRPM/s', 0x17: '%',
  0x51: '%', 0x52: 'eRPM', 0x54: '%', 0x55: '%',
  0x20: '%', 0x22: '\u00b0', 0x30: 'eRPM',
  0x53: 'eRPM', 0x56: '%', 0x57: '%',
  0x42: 'mA', 0x41: 'mA', 0x58: 'mA', 0x59: 'mA', 0x5A: 'mA',
  0x64: '%', 0x65: 'counts', 0x66: 'count', 0x67: 'count',
  0x60: '%/ms', 0x61: '%/ms', 0x62: 'ms', 0x63: '\u00f7',
  0x68: 'ADC', 0x69: 'ADC',
  0x6A: 'ms', 0x6B: 'count',
  0x6C: 'count', 0x6D: '%', 0x6E: 'cA', 0x6F: 'eRPM/s',
  0x50: 'pairs',
  // FOC Motor Model
  0x70: 'm\u03A9', 0x71: '\u00B5H', 0x72: '\u00B5V\u00B7s/rad',
  0x73: 'cV', 0x74: 'cA', 0x75: 'rad/s',
  // FOC Tuning
  0x76: '\u00D71000', 0x77: '1/s', 0x78: '\u00D71000',
  // FOC Startup
  0x79: 'cA', 0x7A: 'cA', 0x7B: 'ms', 0x7C: 'ms',
  0x7D: 'rad/s\u00B2', 0x7E: 'rad/s', 0x7F: 'cA', 0x80: 'drad/s',
  // AN1078 SMO live tuning
  0x90: '\u00B0\u00D710',     /* deg × 10 */
  0x91: '\u00D71e7',          /* K × 1e7 */
  0x92: 'mV',
  0x93: 'dA',                 /* deci-amp */
};

export const PARAM_TOOLTIPS: Record<number, string> = {
  0x15: 'Speed at which open-loop ramp hands off to closed-loop BEMF tracking. Higher = more reliable lock, but slower startup.',
  0x16: 'How fast the motor accelerates during open-loop ramp. Lower = gentler start for heavy props.',
  0x17: 'Maximum duty cycle allowed during open-loop ramp. Limits startup current.',
  0x51: 'Duty cycle during rotor alignment phase. Higher = stronger alignment but more current.',
  0x52: 'Initial forced commutation speed at start of ramp. Lower = gentler start.',
  0x54: 'Sine drive modulation during alignment. Controls alignment current.',
  0x55: 'Sine drive modulation during V/f ramp. Controls ramp torque.',
  0x20: 'Minimum duty when motor is running at zero throttle. Keeps motor spinning at idle.',
  0x22: 'Maximum commutation timing advance at top speed. Improves efficiency but too much causes instability.',
  0x30: 'Speed above which hardware ADC comparators take over zero-crossing detection from software polling.',
  0x53: 'Maximum electrical RPM for closed-loop operation. Affects timing advance interpolation and step period limits.',
  0x56: 'Duty % above which extra demagnetization blanking is applied to ZC detection.',
  0x57: 'Extra blanking percentage added at 100% duty to reject demag noise.',
  0x42: 'Soft overcurrent threshold. Duty is reduced proportionally when bus current exceeds this.',
  0x41: 'Hard overcurrent threshold. Motor faults immediately if bus current exceeds this.',
  0x58: 'CMP3 hardware comparator threshold for cycle-by-cycle current chopping (CLPCI).',
  0x59: 'CMP3 threshold during startup/alignment. Set high to avoid false trips during switching transients.',
  0x5A: 'Hold ramp acceleration when bus current exceeds this. 0 = disabled.',
  0x64: 'Percentage of step period to blank after commutation before accepting ZC events.',
  0x65: 'ADC count deadband around ZC threshold. Reduces noise-triggered false crossings.',
  0x66: 'Consecutive confirmed zero-crossings needed to declare sync lock. Min 4 (morph exit requirement).',
  0x67: 'Consecutive matching ADC reads needed to confirm a single zero-crossing event.',
  0x60: 'Maximum duty increase rate. Limits acceleration torque impulse.',
  0x61: 'Maximum duty decrease rate. Limits regenerative braking current.',
  0x62: 'Time after ZC sync lock during which slew rate is reduced for smooth transition.',
  0x63: 'Slew-up rate divisor during post-sync settle. Higher = gentler closed-loop entry.',
  0x68: 'Bus voltage ADC reading above which an overvoltage fault triggers.',
  0x69: 'Bus voltage ADC reading below which an undervoltage fault triggers.',
  0x6A: 'Coast-down time after desync before attempting restart.',
  0x6B: 'Maximum restart attempts after desync before permanent fault. 0 = no restarts.',
  0x6C: 'Consecutive in-tolerance ZC intervals required to lock and exit MORPH into closed loop.',
  0x6D: 'Allowed ZC-interval variation (%) for a sample to count toward the morph lock.',
  0x6E: 'I-f startup commanded current in centi-amps (e.g. 800 = 8.00 A).',
  0x6F: 'I-f startup forced-commutation ramp rate (eRPM per second).',
  0x50: 'Number of magnetic pole pairs. Informational: used for eRPM to mechanical RPM conversion in GUI.',
  // FOC Motor Model
  0x70: 'Phase resistance in milliohms. Critical for FOC current control — wrong Rs causes observer drift and PI mismatch.',
  0x71: 'Phase inductance in microhenries. Affects current loop bandwidth and observer L\u00B7dI cancellation.',
  0x72: 'Back-EMF constant in \u00B5V\u00B7s/rad (electrical). Ke = \u03BB_pm. Formula: 60 / (\u221A3 \u00D7 2\u03C0 \u00D7 KV \u00D7 pole_pairs).',
  0x73: 'Nominal bus voltage in centivolts. Used for voltage clamp, dead-time comp, and speed limiting.',
  0x74: 'Maximum phase current in centiamps. Limits speed PI output and defines OC fault threshold.',
  0x75: 'Maximum electrical speed in rad/s. Caps speed reference and observer LPF tuning.',
  // FOC Tuning
  0x76: 'D/Q current loop proportional gain \u00D71000. Kp = \u03C9_bw \u00D7 Ls. Too high = current ringing.',
  0x77: 'D/Q current loop integral gain. Ki = \u03C9_bw \u00D7 Rs (parallel form). Too high = overshoot.',
  0x78: 'Observer low-pass filter coefficient \u00D71000. Higher = less filtering, better for high-speed motors.',
  // FOC Startup
  0x79: 'Alignment current in centiamps. Must overcome cogging torque. Too high = excess heating.',
  0x7A: 'Open-loop ramp current in centiamps. Must overcome prop drag during I/f acceleration.',
  0x7B: 'Alignment dwell time in ms. Heavy rotors need more time to settle.',
  0x7C: 'Duration to ramp Iq from alignment to running current. Smoother = less vibration.',
  0x7D: 'I/f speed ramp rate in rad/s\u00B2. Lower = gentler startup for heavy props.',
  0x7E: 'Speed threshold for closed-loop handoff. PLL must track within 20% for 10ms.',
  0x7F: 'Software overcurrent fault threshold in centiamps. Motor faults if |I| exceeds this.',
  0x80: 'Stall detection speed in decirad/s. Motor faults if speed stays below this while commanding motion.',
  // AN1078 SMO Live Tuning — these can be changed WHILE motor is running
  0x90: 'AN1078 SMO theta-offset BASE in 0.1° units. Compensates BEMF→rotor offset at low speed. 200=20°. Watch focVd in scope: -ve=lags, +ve=leads, 0=aligned. Tune at low CL speed first.',
  0x91: 'AN1078 SMO theta-offset speed coefficient × 1e7. Compensates LPF lag that grows with speed. 1000 = 1.0e-4 rad/(rad/s elec). Tune at high CL speed AFTER BASE is dialed in.',
  0x92: 'AN1078 SMC sliding gain (Kslide) in mV. Magnitude of Z signal. 2500=2.5V good for low-Rs motors (2810). Higher motors (Hurst) want 6000-20000. Too high → buries weak BEMF.',
  0x93: 'AN1078 field-weakening max |Id|, in deci-amps. 120 = 12A. 0 disables FW (motor speed capped at voltage limit). Engage cautiously — increases motor heating.',
};

export const PARAM_GROUPS: Record<number, string> = {
  0: 'Startup & Ramp',
  1: 'Closed-Loop Control',
  2: 'Current Protection',
  3: 'ZC Detection',
  4: 'Duty Slew',
  5: 'Voltage Protection',
  6: 'Recovery',
  7: 'Motor Hardware',
  8: 'FOC Motor Model',
  9: 'FOC Tuning',
  10: 'FOC Startup',
  11: 'AN1078 SMO Live Tune',
};

export const FEATURE_NAMES: Record<number, string> = {
  0: 'BEMF_CLOSED_LOOP', 1: 'VBUS_FAULT', 2: 'DESYNC_RECOVERY',
  3: 'DUTY_SLEW', 4: 'TIMING_ADVANCE', 5: 'DYNAMIC_BLANKING',
  6: 'VBUS_SAG_LIMIT', 7: 'BEMF_INTEGRATION', 8: 'SINE_STARTUP',
  9: 'ADC_CMP_ZC', 10: 'HW_OVERCURRENT', 11: 'LEARN_MODULES',
  12: 'ADAPTATION', 13: 'COMMISSION', 14: 'EEPROM_V2',
  15: 'X2CSCOPE', 16: 'GSP', 17: 'OC_CLPCI_ENABLE', 18: 'PRESYNC_RAMP',
  19: 'ADC_POT', 20: 'RX_PWM', 21: 'RX_DSHOT', 22: 'RX_AUTO',
  23: 'FOC',
  24: 'BURST_SCOPE',
};

export const FEATURE_BIT_FOC = 23;
export const FEATURE_BIT_BURST_SCOPE = 24;
export const FEATURE_BIT_LIVE_TUNE = 25;

export interface GspRxStatus {
  linkState: number;
  protocol: number;
  dshotRate: number;
  throttle: number;
  pulseUs: number;
  crcErrors: number;
  droppedFrames: number;
}

/** Helper: check if FOC feature is enabled in feature flags */
export function isFocEnabled(featureFlags: number): boolean {
  return (featureFlags & (1 << FEATURE_BIT_FOC)) !== 0;
}

/** Helper: check if firmware is V4 sector-PI (CK board only).
 * Firmware sets bit 31 (0x80000000) of featureFlags when
 * FEATURE_V4_SECTOR_PI is enabled. */
export function isV4Firmware(featureFlags: number): boolean {
  return (featureFlags & 0x80000000) !== 0;
}

/** Helper: check if burst scope is enabled */
export function isBurstScopeEnabled(featureFlags: number): boolean {
  return (featureFlags & (1 << FEATURE_BIT_BURST_SCOPE)) !== 0;
}

/** Helper: firmware allows the safe ISR-live 6-step knobs to be SET while
 * spinning (FEATURE_LIVE_TUNE, bit 25). When false, those sliders are
 * stop-to-change. */
export function isLiveTuneEnabled(featureFlags: number): boolean {
  return (featureFlags & (1 << FEATURE_BIT_LIVE_TUNE)) !== 0;
}

/* ── Burst Scope Types ─────────────────────────────────────────── */

export const SCOPE_TRIG_MODES = ['Manual', 'Fault', 'State Change', 'Threshold'] as const;
export const SCOPE_STATES = ['IDLE', 'ARMED', 'FILLING', 'READY'] as const;
export const SCOPE_CHANNELS = ['Ia', 'Ib', 'Id', 'Iq', 'Vd', 'Vq', 'Theta', '', '', 'Omega', 'ModIndex'] as const;
export const SCOPE_EDGES = ['Rising', 'Falling'] as const;

export const SCOPE_SAMPLE_SIZE = 26;
export const SCOPE_MAX_CHUNK = 9;
export const SCOPE_BUF_SIZE = 128;

export interface ScopeSample {
  ia: number;     /* A */
  ib: number;
  id: number;
  iq: number;
  vd: number;     /* V */
  vq: number;
  theta: number;  /* rad */
  obsX1: number;  /* V·s */
  obsX2: number;
  omega: number;  /* rad/s */
  modIndex: number; /* 0-1 */
  flags: number;
  state: number;
  tickLsb: number;
  cl: boolean;
  fault: boolean;
  mode: number;
}

export interface ScopeStatus {
  state: number;
  trigMode: number;
  preTrigPct: number;
  trigIdx: number;
  sampleCount: number;
  sampleSize: number;
}

export interface ScopeArmConfig {
  trigMode: number;
  preTrigPct: number;
  trigChannel: number;
  trigEdge: number;
  threshold: number;
}
