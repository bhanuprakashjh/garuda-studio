/* fallingZc.ts — analytic model of why the falling (alternate) sector loses true
 * zero-cross above ~70k eRPM. TypeScript port of the Python tools
 *   tools/garuda_debug/garuda_gui/zcsim.py  (simulate)
 *   tools/garuda_debug/garuda_gui/zcsim_falling.py  (falling_walk / feedforward)
 *
 * For each eRPM it drives one FALLING sector and compares where the RC-filtered
 * OFF-center sampler (the firmware bemfRaw path, runs at PWM rate) first sees the
 * crossing vs where the un-filtered BEMF truly crosses neutral — averaged over
 * PWM grid alignments. Decomposes the 547->900 permille walk into true rotor
 * geometry (stays ~500) vs RC-lag + quantization measurement error, and tests the
 * learned-offset feed-forward fix.
 */

// ── motor / board constants (2810 1350KV on MCLV-48V @ 24V) ──
const KV = 1350.0;
const POLES_PP = 7;
const KE = 60.0 / (2 * Math.PI * KV); // V*s/rad mech
const PWM_HZ = 45000.0;
const ADC_PER_V = 625.0 / 12.0; // divider: Vbus/2 = 12V -> ~625 ADC counts
const DEADBAND = 4; // ADC counts (HWZC_CMP_DEADBAND)
const ADC_MAX = 4095;

// floating phase + zc polarity per 60deg sector (matches firmware commutationTable)
const SECTORS: Array<[number, number]> = [[2, 1], [0, -1], [1, 1], [2, -1], [0, 1], [1, -1]];

/** Normalized trapezoidal BEMF: +1 flat 120deg, ramp 60, -1 flat 120, ramp 60. */
function trap(thetaDeg: number): number {
  const t = ((thetaDeg % 360) + 360) % 360;
  if (t < 120) return 1.0;
  if (t < 180) return 1.0 - 2.0 * (t - 120) / 60;
  if (t < 300) return -1.0;
  return -1.0 + 2.0 * (t - 300) / 60;
}

export interface SimResult {
  offcFiredUs: number | null; // OFF-center detection time into the sector
  sectorUs: number;
  truePermille: number; // where un-filtered BEMF truly crosses neutral
}

/** Simulate ONE sector's floating-phase OFF-center detection. */
function simulate(erpm: number, dutyFrac: number, opts: {
  vbus: number; rcFc: number; sectorIndex: number; pwmPhase: number; nSub: number;
}): SimResult {
  const { vbus, rcFc, sectorIndex, pwmPhase, nSub } = opts;
  const wE = (erpm / 60) * 2 * Math.PI;
  const wMech = wE / POLES_PP;
  const E = KE * wMech;
  const Te = 1.0 / (erpm / 60);
  const sectorT = Te / 6;
  const Tpwm = 1.0 / PWM_HZ;
  const dt = Tpwm / nSub;
  const n = Math.max(8, Math.round(sectorT / dt));
  const pol = SECTORS[((sectorIndex % 6) + 6) % 6][1];

  const rc = 1.0 / (2 * Math.PI * rcFc);
  const alpha = dt / (rc + dt);
  const thrAdc = dutyFrac * (vbus / 2) * ADC_PER_V;
  const theta0 = pol > 0 ? 120.0 : 300.0;

  let filt = thrAdc;
  let offcFiredUs: number | null = null;
  // true ZC: first sign change of the un-filtered BEMF after 1/4 sector
  let prevE = E * trap(theta0);
  let truePermille = 500;
  let foundTrue = false;

  for (let k = 0; k < n; k++) {
    const t = k * dt;
    const frac = t / sectorT;
    const thetaE = theta0 + 60 * frac;
    const e = E * trap(thetaE);

    if (!foundTrue && k > n / 4 && prevE * e < 0) {
      // linear interp of the zero crossing between k-1 and k
      const fk = (k - 1 + (0 - prevE) / (e - prevE)) / (n - 1);
      truePermille = 1000 * fk;
      foundTrue = true;
    }
    prevE = e;

    const tph = t + pwmPhase * Tpwm;
    let vn = e * 1.5;
    const ph = ((tph % Tpwm) / Tpwm);
    const on = Math.abs(ph - 0.5) < dutyFrac / 2;
    if (on) vn = vbus / 2 + 1.5 * e;
    else if (vn < -0.7) vn = -0.7;

    const adc = Math.min(ADC_MAX, Math.max(0, vn * ADC_PER_V));
    filt = filt + alpha * (adc - filt);

    // OFF-center sampler: once per PWM period at the boundary
    if (k > 0 && (tph % Tpwm) < dt && offcFiredUs === null && frac > 0.25) {
      const crossed = pol > 0 ? filt > thrAdc + DEADBAND : filt < thrAdc - DEADBAND;
      if (crossed && frac > 0.5) offcFiredUs = t * 1e6;
    }
  }
  return { offcFiredUs, sectorUs: sectorT * 1e6, truePermille };
}

export interface WalkRow {
  erpm: number;
  duty: number;
  spp: number; // OFF-center samples per sector
  truePm: number;
  detPm: number | null; // mean detected permille over grid phases
  detStd: number; // jitter (std of detected permille)
  lagUs: number | null;
  missPct: number;
  detected: boolean;
}

/** Rough V/f duty schedule matching the 2810 bench sweep. */
export function defaultDuty(erpm: number): number {
  return Math.min(0.98, Math.max(0.05, 0.06 + erpm / 240000));
}

export function fallingWalk(erpms: number[], opts?: {
  vbus?: number; rcFc?: number; nPhase?: number; nSub?: number;
}): WalkRow[] {
  const vbus = opts?.vbus ?? 24.0;
  const rcFc = opts?.rcFc ?? 5500.0;
  const nPhase = opts?.nPhase ?? 16;
  const nSub = opts?.nSub ?? 48;
  const rows: WalkRow[] = [];
  for (const erpm of erpms) {
    const duty = defaultDuty(erpm);
    const spp = 450000 / erpm;
    const detPms: number[] = [];
    const lagUss: number[] = [];
    let truePm = 500;
    let misses = 0;
    for (let p = 0; p < nPhase; p++) {
      const pwmPhase = p / nPhase;
      const r = simulate(erpm, duty, { vbus, rcFc, sectorIndex: 1, pwmPhase, nSub });
      truePm = r.truePermille;
      if (r.offcFiredUs === null) { misses++; continue; }
      const detPm = (r.offcFiredUs / r.sectorUs) * 1000;
      detPms.push(detPm);
      lagUss.push(r.offcFiredUs - (truePm / 1000) * r.sectorUs);
    }
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    const detPm = detPms.length ? mean(detPms) : null;
    const detStd = detPms.length
      ? Math.sqrt(mean(detPms.map(x => (x - (detPm as number)) ** 2))) : 0;
    rows.push({
      erpm, duty, spp, truePm,
      detPm, detStd,
      lagUs: lagUss.length ? mean(lagUss) : null,
      missPct: (100 * misses) / nPhase,
      detected: detPm !== null,
    });
  }
  return rows;
}

export interface FfResult {
  learnedUs: number;
  rows: Array<{ erpm: number; rawErr: number | null; corrErr: number | null; timerErr: number }>;
}

/** Feed-forward test: learn the falling lag at low speed, apply it everywhere. */
export function feedforwardTest(rows: WalkRow[], learnLo = 30000, learnHi = 60000): FfResult | null {
  const learn = rows.filter(r => r.detected && r.lagUs !== null && r.erpm >= learnLo && r.erpm <= learnHi);
  if (!learn.length) return null;
  const learnedUs = learn.reduce((s, r) => s + (r.lagUs as number), 0) / learn.length;
  const out = rows.map(r => {
    const sectorUs = (1.0 / (r.erpm / 60) / 6) * 1e6;
    const rawErr = r.detPm !== null ? r.detPm - r.truePm : null;
    const corrErr = r.detPm !== null ? r.detPm - (learnedUs / sectorUs) * 1000 - r.truePm : null;
    const timerErr = 500 - r.truePm; // what the >70k timer extrapolation costs
    return { erpm: r.erpm, rawErr, corrErr, timerErr };
  });
  return { learnedUs, rows: out };
}

export const FALLING_CAP_ERPM = 70000; // firmware HWZC_FALLING_SW_MAX_ERPM
