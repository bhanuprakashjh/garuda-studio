/* zcsim.ts — 6-step sensorless BEMF zero-cross simulator (model only).
 *
 * Faithful TypeScript port of the Python physics module
 *   tools/garuda_debug/garuda_gui/zcsim.py
 * with the falling-sector study helpers from
 *   tools/garuda_debug/garuda_gui/zcsim_falling.py
 *
 * Reproduces, from physics, the falling-polarity ZC masking measured on the
 * bench: the floating-phase BEMF is clean in the PWM-OFF (freewheel) window but,
 * in the PWM-ON window, gets swamped by switching transients. The 1 MHz
 * comparator (gated to ON) therefore sees corrupted data on falling sectors,
 * while the RC-filtered OFF-center sample stays clean.
 *
 * Pure TypeScript, ZERO external dependencies. Where the Python uses numpy
 * vectorised ops, this rewrites them as plain loops / typed arrays.
 *
 * Python originals are noted in comments (snake_case) next to each export so the
 * math can be cross-checked line-for-line.
 */

// ── motor / board constants (2810 1350KV on MCLV-48V @ 24V) ──────────────────
// Python: VBUS_DEFAULT, KV, POLES_PP, KE, PWM_HZ, ADC_PER_V, CMP_HZ, DEADBAND, ADC_MAX
export const VBUS_DEFAULT = 24.0;
export const KV = 1350.0; // rpm/V
export const POLES_PP = 7; // pole pairs (14-pole 2810)
export const KE = 60.0 / (2 * Math.PI * KV); // V*s/rad mech (line-neutral peak = KE*w_mech)
export const PWM_HZ = 45000.0;
export const ADC_PER_V = 625.0 / 12.0; // divider: Vbus/2 = 12V -> ~625 ADC counts
export const CMP_HZ = 1.0e6; // comparator sample rate
export const DEADBAND = 4; // ADC counts (HWZC_CMP_DEADBAND)
export const ADC_MAX = 4095;

/** Python: _trap — normalized trapezoidal BEMF: +1 flat 120deg, ramp 60, -1 flat 120, ramp 60. */
export function trap(thetaDeg: number): number {
  // np.mod(theta_deg, 360.0) — Python mod is always non-negative
  const t = ((thetaDeg % 360.0) + 360.0) % 360.0;
  if (t < 120.0) return 1.0;
  if (t < 180.0) return 1.0 - 2.0 * (t - 120.0) / 60.0;
  if (t < 300.0) return -1.0;
  return -1.0 + 2.0 * (t - 300.0) / 60.0;
}

/** Python: bemf_volts — three line-neutral BEMFs (volts), phases at 0/120/240 deg. */
export function bemfVolts(thetaEDeg: number, amp: number): [number, number, number] {
  return [
    amp * trap(thetaEDeg),
    amp * trap(thetaEDeg - 120.0),
    amp * trap(thetaEDeg - 240.0),
  ];
}

/**
 * Python: SECTORS — floating phase + zc polarity per 60 deg sector
 * (matches firmware commutationTable). [floatingPhase, polarity].
 */
export const SECTORS: ReadonlyArray<readonly [number, number]> = [
  [2, +1],
  [0, -1],
  [1, +1],
  [2, -1],
  [0, +1],
  [1, -1],
];

// ── motor library (approx params; KV/poles drive the eRPM range + BEMF) ──────
/** Describes one motor in the {@link MOTORS} library. Python: MOTORS dict value. */
export interface MotorSpec {
  /** display name / dictionary key (Python: MOTORS key) */
  name: string;
  /** rpm/V (Python: kv) */
  kv: number;
  /** pole pairs (Python: poles_pp) */
  polesPp: number;
  /** phase resistance, ohms (Python: R) */
  R: number;
  /** phase inductance, henries (Python: L) */
  L: number;
  /** bus voltage, volts (Python: vbus) */
  vbus: number;
  /** max closed-loop eRPM (Python: erpm_max) */
  erpmMax: number;
}

/**
 * Python: MOTORS dict. Keyed by the same display strings the Python uses.
 * Numeric values preserved exactly.
 */
export const MOTORS: Record<string, MotorSpec> = {
  "2810 1350KV (24V)": {
    name: "2810 1350KV (24V)",
    kv: 1350,
    polesPp: 7,
    R: 0.05,
    L: 30e-6,
    vbus: 24.0,
    erpmMax: 235000,
  },
  "Cobra CM-2814 470KV (24V)": {
    name: "Cobra CM-2814 470KV (24V)",
    kv: 470,
    polesPp: 7,
    R: 0.09,
    L: 70e-6,
    vbus: 24.0,
    erpmMax: 92000,
  },
  "XRotor 3110 1150KV (24V)": {
    name: "XRotor 3110 1150KV (24V)",
    kv: 1150,
    polesPp: 7,
    R: 0.04,
    L: 24e-6,
    vbus: 24.0,
    erpmMax: 205000,
  },
  "A2212 1000KV (12V)": {
    name: "A2212 1000KV (12V)",
    kv: 1000,
    polesPp: 7,
    R: 0.11,
    L: 55e-6,
    vbus: 12.0,
    erpmMax: 85000,
  },
};

/** Python: KE_of(kv) — back-EMF constant V*s/rad mech for a given KV. */
export function keOf(kv: number): number {
  return 60.0 / (2 * Math.PI * kv);
}

/** clamp helper (np.clip on a scalar). */
function clip(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Python: vf_duty — physical-ish V/f duty: duty ~ BEMF_peak / (Vbus/2), clamped. */
export function vfDuty(erpm: number, motor: MotorSpec): number {
  const wM = (erpm / motor.polesPp) / 60.0 * 2 * Math.PI;
  const bemfPk = keOf(motor.kv) * wM;
  return clip(bemfPk / (motor.vbus * 0.5), 0.05, 0.98);
}

// ── capture model ────────────────────────────────────────────────────────────
/** Result of {@link captureModel}. Python: capture_model return dict. */
export interface CaptureResult {
  /** OFF-center samples per 60deg sector (Python: spp) */
  spp: number;
  /** V/f duty at this eRPM (Python: duty) */
  duty: number;
  /** rising-sector capture fraction 0..1 (Python: rising) */
  rising: number;
  /** falling-sector capture fraction 0..1 (Python: falling) */
  falling: number;
  /** aggregate measured fraction 0..1 (Python: measured) */
  measured: number;
  /** per-sector capture fractions [6], even=rising / odd=falling (Python: per_sector) */
  perSector: number[];
}

/**
 * Python: capture_model — mechanism model of ZC detection, calibrated to the
 * 2810 bench sweep.
 *
 * rising sectors (even 0/2/4): ON-window HW comparator -> ~100% across CL range.
 * falling sectors (odd 1/3/5): RC-filtered OFF-center SW sample; logistic in
 * samples/sector (center 5.0, width 0.6) fit to the bench (88% @50-90k, 12%
 * @90-130k, 0% >=130k).
 */
export function captureModel(erpm: number, motor: MotorSpec): CaptureResult {
  if (erpm < 1500) {
    return {
      spp: 0,
      duty: 0.05,
      rising: 0.0,
      falling: 0.0,
      measured: 0.0,
      perSector: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    };
  }
  const spp = PWM_HZ * (10.0 / erpm); // OFF-center samples per 60deg sector
  const duty = vfDuty(erpm, motor);
  const rising = 1.0; // ON-window comparator: always (in CL)
  // falling: logistic in samples/sector (center 5.0, width 0.6 -> fits bench)
  let falling = 1.0 / (1.0 + Math.exp(-(spp - 5.0) / 0.6));
  falling = clip(falling, 0.0, 1.0);
  const measured = 0.5 * rising + 0.5 * falling;
  const perSector = [rising, falling, rising, falling, rising, falling]; // even=rising, odd=falling
  return { spp, duty, rising, falling, measured, perSector };
}

// ── BEMF curves (for plotting) ───────────────────────────────────────────────
/** Result of {@link bemfCurves}. Python: bemf_curves return tuple (th,a,b,c). */
export interface BemfCurves {
  /** electrical angle, deg, 0..360 (Python: th) */
  theta: number[];
  /** phase A normalized BEMF (Python: a) */
  a: number[];
  /** phase B normalized BEMF (Python: b) */
  b: number[];
  /** phase C normalized BEMF (Python: c) */
  c: number[];
}

/**
 * Python: bemf_curves — one electrical cycle of the 3 normalized BEMFs.
 * Note: the Python signature takes (erpm, motor, n=720) but uses none of erpm/
 * motor in the body (the curves are normalized). They are accepted for parity.
 */
export function bemfCurves(_erpm: number, _motor: MotorSpec, n = 720): BemfCurves {
  // np.linspace(0, 360, n) — inclusive of both endpoints
  const theta: number[] = new Array(n);
  const a: number[] = new Array(n);
  const b: number[] = new Array(n);
  const c: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : (360.0 * i) / (n - 1);
    theta[i] = x;
    a[i] = trap(x);
    b[i] = trap(x - 120);
    c[i] = trap(x - 240);
  }
  return { theta, a, b, c };
}

// ── single-sector simulation ─────────────────────────────────────────────────
/** Options for {@link simulate} (Python: simulate keyword args, with defaults). */
export interface SimulateOptions {
  vbus?: number; // Python: vbus=VBUS_DEFAULT
  rcFc?: number; // Python: rc_fc=5500.0
  spikeAmp?: number; // Python: spike_amp=0.0
  spikeTauUs?: number; // Python: spike_tau_us=0.6
  ringAmp?: number; // Python: ring_amp=0.0
  ringFhz?: number; // Python: ring_fhz=120e3
  ringTauUs?: number; // Python: ring_tau_us=3.0
  nSub?: number; // Python: n_sub=64
  pwmPhase?: number; // Python: pwm_phase=0.0
  // Python also has sector_index/seed; sector_index is a positional arg here,
  // seed is unused (the rng is constructed but never sampled in simulate()).
}

/** Result of {@link simulate}. Python: simulate return dict. */
export interface SimulateResult {
  /** time series, microseconds (Python: t_us) */
  tUs: number[];
  /** raw floating-node ADC counts (Python: v_node) */
  vNode: number[];
  /** RC-filtered sense line, ADC counts (Python: v_sense) */
  vSense: number[];
  /** floating-phase BEMF, volts (Python: e_float) */
  eFloat: number[];
  /** detection threshold, ADC counts (Python: thr_adc) */
  thrAdc: number;
  /** zc polarity for this sector, +1/-1 (Python: polarity) */
  polarity: number;
  /** floating phase index 0..2 (Python: fphase) */
  fphase: number;
  /** BEMF amplitude, volts (Python: E_volts) */
  eVolts: number;
  /** neutral level, ADC counts (Python: neutral_adc, == thrAdc) */
  neutralAdc: number;
  /** sector duration, microseconds (Python: sector_us) */
  sectorUs: number;
  /** first valid ON-window comparator detection, us, or null (Python: comp_fired_us) */
  compFiredUs: number | null;
  /** first valid OFF-center detection, us, or null (Python: offc_fired_us) */
  offcFiredUs: number | null;
  /** comparator ON-window envelope [min,max], ADC (Python: comp_on_env) */
  compOnEnv: [number, number];
  /** OFF-center sample envelope [min,max], ADC (Python: offc_env) */
  offcEnv: [number, number];
}

/**
 * Python: simulate — simulate ONE sector's floating-phase signal + detection.
 *
 * sectorIndex: which of the 6 sectors (default 1 = a falling sector).
 * Returns time series (us) and detection results for both the OFF-center sampler
 * and the ON-gated 1 MHz comparator.
 */
export function simulate(
  erpm: number,
  dutyFrac: number,
  sectorIndex = 1,
  opts: SimulateOptions = {},
): SimulateResult {
  const vbus = opts.vbus ?? VBUS_DEFAULT;
  const rcFc = opts.rcFc ?? 5500.0;
  const spikeAmp = opts.spikeAmp ?? 0.0;
  const spikeTauUs = opts.spikeTauUs ?? 0.6;
  const ringAmp = opts.ringAmp ?? 0.0;
  const ringFhz = opts.ringFhz ?? 120e3;
  const ringTauUs = opts.ringTauUs ?? 3.0;
  const nSub = opts.nSub ?? 64;
  const pwmPhase = opts.pwmPhase ?? 0.0;

  const wE = (erpm / 60.0) * 2.0 * Math.PI; // elec rad/s
  const wMech = wE / POLES_PP;
  const E = KE * wMech; // BEMF amplitude (V)
  const Te = 1.0 / (erpm / 60.0); // elec period (s)
  const sectorT = Te / 6.0; // sector duration (s)
  const Tpwm = 1.0 / PWM_HZ;
  const dt = Tpwm / nSub;
  const n = Math.max(8, Math.round(sectorT / dt));
  const sec = SECTORS[((sectorIndex % 6) + 6) % 6];
  const fphase = sec[0];
  const pol = sec[1];

  const rc = 1.0 / (2.0 * Math.PI * rcFc);
  const alpha = dt / (rc + dt); // 1st-order LP coeff

  const thrAdc = dutyFrac * (vbus / 2.0) * ADC_PER_V; // firmware: duty*Vbus/2
  // ramp start (rising at 120, falling at 300)
  const theta0 = pol > 0 ? 120.0 : 300.0;

  const tUs: number[] = new Array(n);
  const vNode: number[] = new Array(n);
  const vSense: number[] = new Array(n);
  const eFloat: number[] = new Array(n);
  let filt = thrAdc;
  let spike = 0.0;
  let prevOn: boolean | null = null;
  let compFiredT: number | null = null; // first valid ON-window comparator detection (us)
  let offcFiredT: number | null = null; // first valid OFF-center detection (us)
  let compOnMin = 1e9;
  let compOnMax = -1e9; // comparator ON-window envelope (ADC)
  let offcMin = 1e9;
  let offcMax = -1e9; // OFF-center sample envelope (ADC)

  for (let k = 0; k < n; k++) {
    const t = k * dt;
    const frac = t / sectorT; // 0..1 through the ramp
    const thetaE = theta0 + 60.0 * frac; // floating phase sweeps its 60-deg ramp
    const e = E * trap(thetaE); // floating-phase BEMF (V), crosses 0 mid-ramp
    eFloat[k] = e;

    // center-aligned PWM: ON in the central 'duty' fraction; OFF at the edges
    // (period boundary = OFF-center, where bemfRaw samples).
    const tph = t + pwmPhase * Tpwm; // grid-phase offset (sector vs PWM)
    const ph = ((tph % Tpwm) + Tpwm) % Tpwm / Tpwm; // 0..1 within PWM period
    const on = Math.abs(ph - 0.5) < dutyFrac / 2.0;

    // ideal floating-node voltage (V, ref to ground): ON ~ Vbus/2 + 3/2 e ;
    // OFF (freewheel) ~ 3/2 e around 0 (body-diode clamp at ~ -0.7V).
    let vn: number;
    if (on) {
      vn = vbus / 2.0 + 1.5 * e;
    } else {
      vn = 1.5 * e;
      if (vn < -0.7) vn = -0.7;
    }

    // ---- Layer 2 parasitics ----
    // switching-edge dv/dt spike: injected at each ON<->OFF transition, decays.
    if (prevOn !== null && on !== prevOn) {
      spike = spikeAmp * (on ? 1.0 : -0.6); // rising edge bigger
    }
    spike *= Math.exp(-dt * 1e6 / Math.max(0.05, spikeTauUs));
    // freewheel L-C resonance during OFF (patent: parasitic C * motor L)
    let ring = 0.0;
    if (!on && ringAmp > 0) {
      // (t % T_pwm) — Python mod, non-negative for t>=0
      const tm = ((t % Tpwm) + Tpwm) % Tpwm;
      ring =
        ringAmp *
        Math.exp(-tm * 1e6 / Math.max(0.1, ringTauUs)) *
        Math.sin(2 * Math.PI * ringFhz * tm);
    }
    prevOn = on;

    const vnodeTotal = vn + spike + ring;
    const adc = clip(vnodeTotal * ADC_PER_V, 0, ADC_MAX);
    vNode[k] = adc;
    filt = filt + alpha * (adc - filt); // RC-filtered sense line
    vSense[k] = filt;
    tUs[k] = t * 1e6;

    // ---- detectors ----
    // comparator: 1 MHz, gated to ON, reads the (lightly) filtered node.
    if (on) {
      const compIn = filt + 0.5 * spike * ADC_PER_V; // residual edge that passes RC
      compOnMin = Math.min(compOnMin, compIn);
      compOnMax = Math.max(compOnMax, compIn);
      if (compFiredT === null) {
        const crossed =
          pol > 0 ? compIn > thrAdc + DEADBAND : compIn < thrAdc - DEADBAND;
        // plausibility: only accept past 1/4 of the sector (firmware floor)
        if (crossed && frac > 0.25 && frac > 0.5) {
          // past the true ZC (mid)
          compFiredT = tUs[k];
        }
      }
    }

    // OFF-center sampler: once per PWM period at the boundary (ph wrap),
    // reads the RC-filtered line (clean average).
    if (k > 0 && (((tph % Tpwm) + Tpwm) % Tpwm) < dt) {
      offcMin = Math.min(offcMin, filt);
      offcMax = Math.max(offcMax, filt);
      if (offcFiredT === null && frac > 0.25) {
        const crossed = pol > 0 ? filt > thrAdc + DEADBAND : filt < thrAdc - DEADBAND;
        if (crossed && frac > 0.5) {
          offcFiredT = tUs[k];
        }
      }
    }
  }

  return {
    tUs,
    vNode,
    vSense,
    eFloat,
    thrAdc,
    polarity: pol,
    fphase,
    eVolts: E,
    neutralAdc: thrAdc,
    sectorUs: sectorT * 1e6,
    compFiredUs: compFiredT,
    offcFiredUs: offcFiredT,
    compOnEnv: [compOnMin, compOnMax],
    offcEnv: [offcMin, offcMax],
  };
}

// ── sweep / duty schedule ────────────────────────────────────────────────────
/** One row of {@link sweep}. Python: sweep return list element. */
export interface SweepRow {
  erpm: number;
  duty: number;
  compRise: boolean; // Python: comp_rise
  compFall: boolean; // Python: comp_fall
  offcRise: boolean; // Python: offc_rise
  offcFall: boolean; // Python: offc_fall
  compOnEnvFall: [number, number]; // Python: comp_on_env_fall
  offcEnvFall: [number, number]; // Python: offc_env_fall
}

/**
 * Python: sweep — sweep eRPM; return per-band rising/falling capture for both
 * detectors. `dutyFn(erpm)->dutyFrac` models the throttle/duty schedule.
 */
export function sweep(
  erpmList: number[],
  dutyFn: (erpm: number) => number,
  opts: SimulateOptions = {},
): SweepRow[] {
  const out: SweepRow[] = [];
  for (const erpm of erpmList) {
    const duty = dutyFn(erpm);
    // rising sector (even, index 0) and falling sector (odd, index 1)
    const r = simulate(erpm, duty, 0, opts);
    const f = simulate(erpm, duty, 1, opts);
    out.push({
      erpm,
      duty,
      compRise: r.compFiredUs !== null,
      compFall: f.compFiredUs !== null,
      offcRise: r.offcFiredUs !== null,
      offcFall: f.offcFiredUs !== null,
      compOnEnvFall: f.compOnEnv,
      offcEnvFall: f.offcEnv,
    });
  }
  return out;
}

/** Python: default_duty — rough V/f duty schedule matching the 2810 bench sweep. */
export function defaultDuty(erpm: number): number {
  return clip(0.06 + erpm / 240000.0, 0.05, 0.98);
}
