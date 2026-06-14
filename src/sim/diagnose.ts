/**
 * diagnose.ts — Tier-1 (LOCAL) rule-based diagnosis engine.
 *
 * Faithful TypeScript port of the LOCAL rule engine in
 *   tools/garuda_debug/garuda_gui/diagnose.py
 * (the Python `summarize()` + `local_diagnose()` functions).
 *
 * The Python Tier-2 Claude/Anthropic deepening (`claude_diagnose`,
 * `claude_available`, KNOWLEDGE, DIAGNOSIS_SCHEMA, the `diagnose()` dispatcher)
 * is INTENTIONALLY NOT PORTED — this module is pure, dependency-free, and makes
 * no network calls.
 *
 * Data model mapping (Python snapshot dict key → web GspSnapshot field):
 *   t              → uptimeSec            (time base; web has no raw `t`)
 *   state_name     → state               (number → name via STATE_NAMES below;
 *                                          note Python uses "CL", not the
 *                                          ESC_STATES "CLOSED_LOOP" label)
 *   fault_name     → faultCode           (number → name via FAULT_NAMES below)
 *   eRPM           → derived from hwzcStepPeriodHR / stepPeriod (see erpmOf)
 *   ia_pk_mag      → iaPkMagA
 *   ib_pk_mag      → ibPkMagA
 *   ibus_pk_mag    → |ibusWinA|          (web exposes only the signed dominant
 *                                          window current; magnitude is the best
 *                                          available equivalent)
 *   ibus_win_A     → ibusWinA
 *   ibus_A         → ibusInstA           (valley-sampled, unreliable; fallback)
 *   ibus_avg_A     → ibusAvgA
 *   synced         → zcSynced
 *   hwzc_zc        → hwzcTotalZcCount
 *   hwzc_reject    → hwzcReject
 *   duty           → dutyPct
 *
 * Params: the web history does not carry the SET_PARAM descriptor table, so the
 * param-related rules (config out-of-range; param `current` values in fixes)
 * accept an optional `params` map. When absent, those rules degrade gracefully
 * (range rule is skipped; `current` shows undefined) — exactly the Python
 * behaviour when session.params is empty.
 */

import type { GspInfo, GspSnapshot } from '../protocol/types';

/* ── Name tables (mirror garuda_gsp/protocol.py STATE_NAMES / FAULT_NAMES) ──
 * Kept local (NOT the ESC_STATES/FAULT_CODES in types.ts) because the Python
 * rules compare against these exact short labels: "CL", "OL_RAMP", "OC_SW", … */
const STATE_NAMES: Record<number, string> = {
  0: 'IDLE', 1: 'ARMED', 2: 'DETECT', 3: 'ALIGN', 4: 'OL_RAMP',
  5: 'MORPH', 6: 'CL', 7: 'BRAKING', 8: 'RECOVERY', 9: 'FAULT',
};
const FAULT_NAMES: Record<number, string> = {
  0: 'NONE', 1: 'OV', 2: 'UV', 3: 'OC_SW', 4: 'BOARD_PCI',
  5: 'STALL', 6: 'DESYNC', 7: 'START_TO', 8: 'MORPH_TO',
  9: 'RX_LOSS', 10: 'FOC_INT', 11: 'FOC_BUS',
};

const stateName = (s: number): string => STATE_NAMES[s] ?? `?${s}`;
const faultName = (f: number): string => FAULT_NAMES[f] ?? `?${f}`;

/* eRPM derivation (mirrors garuda_gsp/decode.py): from the HWZC high-res tick
 * period when the comparator path is active, else from the software stepPeriod. */
const HWZC_ERPM_FROM_TICKS = 1_000_000_000;
function erpmOf(x: GspSnapshot): number {
  if (x.hwzcEnabled && x.hwzcStepPeriodHR > 0) {
    return Math.floor(HWZC_ERPM_FROM_TICKS / x.hwzcStepPeriodHR);
  }
  if (x.stepPeriod > 0) return Math.floor(450_000 / x.stepPeriod);
  return 0;
}

/* ── Param descriptor shape (optional; mirrors session.params dict entries) ──
 * Python entries are either a scalar value or { value, min, max }. */
export interface ParamEntry {
  value?: number | string | null;
  min?: number | null;
  max?: number | null;
}
export type ParamsMap = Record<string, ParamEntry | number | string | null>;

/** Optional extra context, mirroring the Python session.info / session.params. */
export interface DiagnoseContext {
  info?: GspInfo | Record<string, unknown>;
  params?: ParamsMap;
}

/* ── Public result shapes ─────────────────────────────────────────────── */

export interface Fix {
  param: string;
  current: string;
  suggested: string;
  why: string;
}

/** Python `confidence` ("low"|"medium"|"high") → the requested
 * severity('info'|'warn'|'error') mapping, plus the original fields. */
export type Severity = 'info' | 'warn' | 'error';

export interface Finding {
  severity: Severity;
  title: string;       // the human-readable root cause (Python `cause`)
  cause: string;       // alias of title (Python `cause`)
  fix: string;         // one-line digest of the fixes
  evidence: string;    // Python `evidence`
  confidence: 'low' | 'medium' | 'high';  // original Python confidence
  fixes: Fix[];        // full structured fix list (Python `fixes`)
}

export interface TimelineEntry {
  state: string;
  t0: number;
  t1: number;
  next: string | null;
}

export interface PerStateStat {
  peak_eRPM: number;
  peak_Ia: number;
  dur_s: number;
}

export interface RunSummary {
  info: GspInfo | Record<string, unknown> | undefined;
  params: Record<string, number | string | null | undefined>;
  empty?: boolean;
  duration_s?: number;
  samples?: number;
  timeline?: TimelineEntry[];
  faults?: { t: number; fault: string }[];
  peak_eRPM?: number;
  peak_Ia_A?: number;
  peak_Ibus_A?: number;
  hwzc_accept?: number;
  hwzc_reject?: number;
  hwzc_reject_pct?: number;
  per_state?: Record<string, PerStateStat>;
}

export interface DiagnosisResult {
  summary: string;
  severity: 'ok' | 'warning' | 'critical';
  findings: Finding[];
  engine: 'local-rules';
  raw: RunSummary;
}

/* ── Helpers ──────────────────────────────────────────────────────────── */

const round1 = (x: number): number => Math.round(x * 10) / 10;
const roundN = (x: number, n: number): number => {
  const f = 10 ** n;
  return Math.round(x * f) / f;
};

/** Mirrors Python diagnose.py `_params()`: flatten {value} entries to scalars. */
function flattenParams(params?: ParamsMap): Record<string, number | string | null | undefined> {
  const out: Record<string, number | string | null | undefined> = {};
  if (!params) return out;
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && typeof v === 'object') {
      out[k] = (v as ParamEntry).value ?? null;
    } else {
      out[k] = v as number | string | null;
    }
  }
  return out;
}

/** Build [(state, t0, t1, next)] from samples — mirrors session.state_timeline(). */
function stateTimeline(s: GspSnapshot[]): TimelineEntry[] {
  if (s.length === 0) return [];
  const out: TimelineEntry[] = [];
  let cur = stateName(s[0].state);
  let t0 = s[0].uptimeSec;
  for (let i = 1; i < s.length; i++) {
    const nm = stateName(s[i].state);
    if (nm !== cur) {
      out.push({ state: cur, t0, t1: s[i].uptimeSec, next: nm });
      cur = nm;
      t0 = s[i].uptimeSec;
    }
  }
  out.push({ state: cur, t0, t1: s[s.length - 1].uptimeSec, next: null });
  return out;
}

/** Faults seen in the run — mirrors session.faults (a row enters a fault when
 * its faultCode becomes non-NONE; we record the rising edges). */
function collectFaults(s: GspSnapshot[]): { t: number; fault: string }[] {
  const out: { t: number; fault: string }[] = [];
  let prevFault = 0;
  for (const x of s) {
    if (x.faultCode !== 0 && x.faultCode !== prevFault) {
      out.push({ t: x.uptimeSec, fault: faultName(x.faultCode) });
    }
    prevFault = x.faultCode;
  }
  return out;
}

/** Population standard deviation (Python statistics.pstdev). */
function pstdev(xs: number[]): number {
  if (xs.length <= 1) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

/* ── Compact run summary — mirrors diagnose.py summarize() ──────────────── */
export function summarize(history: GspSnapshot[], ctx?: DiagnoseContext): RunSummary {
  const s = history;
  const info = ctx?.info;
  const params = flattenParams(ctx?.params);

  if (s.length === 0) {
    return { info, params, empty: true };
  }

  const peak = (fn: (x: GspSnapshot) => number): number =>
    s.reduce((m, x) => Math.max(m, fn(x) || 0), 0);

  // commutation-health: reject rate over the run
  const zc0 = s[0];
  const zc1 = s[s.length - 1];
  const span = Math.max(zc1.uptimeSec - zc0.uptimeSec, 1e-3);
  const acc = Math.max(0, zc1.hwzcTotalZcCount - zc0.hwzcTotalZcCount);
  const rej = Math.max(0, zc1.hwzcReject - zc0.hwzcReject);
  const rejPct = Math.min(100.0, (100.0 * rej) / Math.max(acc + rej, 1)); // can't exceed 100%

  // per-state stats
  interface Acc { n: number; peak_eRPM: number; peak_Ia: number; t0: number; t1: number }
  const perStateAcc: Record<string, Acc> = {};
  for (const x of s) {
    const st = stateName(x.state);
    let d = perStateAcc[st];
    if (!d) {
      d = { n: 0, peak_eRPM: 0, peak_Ia: 0, t0: x.uptimeSec, t1: x.uptimeSec };
      perStateAcc[st] = d;
    }
    d.n += 1;
    d.peak_eRPM = Math.max(d.peak_eRPM, erpmOf(x));
    d.peak_Ia = Math.max(d.peak_Ia, x.iaPkMagA || 0);
    d.t1 = x.uptimeSec;
  }
  const per_state: Record<string, PerStateStat> = {};
  for (const [k, v] of Object.entries(perStateAcc)) {
    per_state[k] = {
      peak_eRPM: v.peak_eRPM,
      peak_Ia: round1(v.peak_Ia),
      dur_s: roundN(v.t1 - v.t0, 2),
    };
  }

  const timeline = stateTimeline(s).map((e) => ({
    state: e.state,
    t0: roundN(e.t0, 2),
    t1: roundN(e.t1, 2),
    next: e.next,
  }));

  return {
    info,
    params,
    duration_s: round1(span),
    samples: s.length,
    timeline,
    faults: collectFaults(s).map((f) => ({ t: roundN(f.t, 2), fault: f.fault })),
    peak_eRPM: peak((x) => erpmOf(x)),
    peak_Ia_A: round1(peak((x) => x.iaPkMagA)),
    // ibus_pk_mag has no direct web field; |ibusWinA| is the closest equivalent
    peak_Ibus_A: round1(peak((x) => Math.abs(x.ibusWinA))),
    hwzc_accept: acc,
    hwzc_reject: rej,
    hwzc_reject_pct: round1(rejPct),
    per_state,
  };
}

/* ── Tier 1: local rule engine — mirrors diagnose.py local_diagnose() ───── */
export function localDiagnose(history: GspSnapshot[], ctx?: DiagnoseContext): DiagnosisResult {
  const d = summarize(history, ctx);
  const findings: Finding[] = [];
  const p = d.params ?? {};
  const faults = new Set((d.faults ?? []).map((f) => f.fault));
  const last_state = d.timeline && d.timeline.length
    ? d.timeline[d.timeline.length - 1].state
    : '?';
  const rejp = d.hwzc_reject_pct ?? 0;
  const peak_ia = d.peak_Ia_A ?? 0;
  const peak_erpm = d.peak_eRPM ?? 0;

  // Python confidence → requested severity('info'|'warn'|'error')
  const sevOf = (conf: 'low' | 'medium' | 'high'): Severity =>
    conf === 'high' ? 'error' : conf === 'medium' ? 'warn' : 'info';

  const ps = (name: string): string => {
    const v = p[name];
    return v === undefined || v === null ? 'undefined' : String(v);
  };

  // add(): Python local_diagnose.add() — pushes a finding with cause/conf/evid/fixes.
  const add = (
    cause: string,
    conf: 'low' | 'medium' | 'high',
    evid: string,
    fixes: Fix[],
  ): void => {
    findings.push({
      severity: sevOf(conf),
      title: cause,
      cause,
      fix: fixes.map((f) => `${f.param} → ${f.suggested}`).join('; '),
      evidence: evid,
      confidence: conf,
      fixes,
    });
  };

  // RULE (Python: config — param outside descriptor range / EEPROM mismatch).
  // Requires the descriptor table (min/max); degrades gracefully when absent.
  for (const [name, v] of Object.entries(ctx?.params ?? {})) {
    if (
      v !== null && typeof v === 'object'
    ) {
      const e = v as ParamEntry;
      const val = e.value;
      if (
        val !== undefined && val !== null &&
        e.min !== undefined && e.min !== null &&
        e.max !== undefined && e.max !== null &&
        typeof val === 'number' &&
        !(e.min <= val && val <= e.max)
      ) {
        add(
          `${name} is outside its descriptor range`,
          'high',
          `${name}=${val} vs [${e.min}..${e.max}]`,
          [{
            param: name,
            current: String(val),
            suggested: 'verify intended; profileDefaults bypasses SET_PARAM limits',
            why: 'value the firmware would reject via SET_PARAM is active',
          }],
        );
      }
    }
  }

  // RULE (Python: startup never left ramp).
  if (
    (faults.has('START_TO') || faults.has('MORPH_TO')) ||
    (['ALIGN', 'OL_RAMP', 'MORPH'].includes(last_state) && peak_erpm < 1000)
  ) {
    add(
      'Startup never reached closed loop (torque starvation or ramp too fast)',
      'high',
      `ended in ${last_state}, peak ${peak_erpm} eRPM, faults ${faults.size ? [...faults].join(', ') : 'none'}`,
      [
        {
          param: 'sineRampModPct', current: ps('sineRampModPct'),
          suggested: "raise (scale ∝ Rs vs 2810's 5%)",
          why: 'open-loop sine amplitude is the real startup torque knob',
        },
        {
          param: 'rampAccelErpmPerS', current: ps('rampAccelErpmPerS'),
          suggested: 'lower if it slips after moving',
          why: "heavy/high-inertia rotor can't follow a fast ramp",
        },
      ],
    );
  }

  // RULE (Python: low-speed idle desync → OC_SW).
  if (faults.has('OC_SW') && ['CL', 'FAULT', 'IDLE'].includes(last_state) && rejp > 80) {
    add(
      'Low-speed ZC-noise desync → wrong-angle commutation → OC_SW',
      'high',
      `OC_SW with HWZC reject ${Math.round(rejp)}%, peak Ia ${peak_ia}A`,
      [
        {
          param: 'zcBlankingPercent', current: ps('zcBlankingPercent'),
          suggested: 'raise',
          why: 'longer blanking rejects post-commutation PWM-noise ZCs',
        },
        {
          param: 'zcAdcDeadband', current: ps('zcAdcDeadband'),
          suggested: 'raise',
          why: 'wider deadband ignores low-eRPM switching noise',
        },
      ],
    );
  }

  // RULE (Python: overcurrent during startup — amplitude too high for Rs).
  if ((faults.has('OC_SW') || faults.has('BOARD_PCI')) && ['ALIGN', 'OL_RAMP'].includes(last_state)) {
    add(
      'Overcurrent during startup — amplitude too high for this Rs',
      'medium',
      `OC in ${last_state}, peak Ia ${peak_ia}A`,
      [{
        param: 'sineRampModPct', current: ps('sineRampModPct'),
        suggested: 'lower',
        why: 'low-Rs motor turns small amplitude into large current',
      }],
    );
  }

  // RULE block (Python: in-CL behaviour — regen / oscillation / intermittent lock).
  const cl = history.filter((x) => stateName(x.state) === 'CL');
  if (cl.length >= 10) {
    // windowed bus current — NOT the valley-sampled inst (phantom -20A artifact)
    const ibusMean = cl.reduce((a, x) => a + (x.ibusWinA ?? x.ibusInstA ?? 0), 0) / cl.length;
    const erpms = cl.map((x) => erpmOf(x));
    const emean = erpms.reduce((a, b) => a + b, 0) / erpms.length;
    const estd = pstdev(erpms);

    // RULE (Python: sustained regen in CL).
    if (ibusMean < -10) {
      add(
        'Sustained regen in CL — commutation mistimed at this speed/duty (BEMF≈applied balance zone)',
        'high',
        `mean Ibus in CL = ${ibusMean.toFixed(1)}A (heavy regen / shunt near rail)`,
        [{
          param: 'timingAdvMaxDeg', current: ps('timingAdvMaxDeg'),
          suggested: 'review advance at this eRPM band',
          why: 'when BEMF≈applied V, a small late-commutation error flips motoring→regen',
        }],
      );
    }

    // RULE (Python: eRPM oscillation — marginal sensorless lock).
    if (emean > 0 && estd / emean > 0.03) {
      add(
        'eRPM oscillation — marginal sensorless lock',
        'medium',
        `eRPM σ/μ = ${Math.round((100 * estd) / emean)}% (μ=${Math.round(emean).toLocaleString('en-US')})`,
        [{
          param: 'zcFilterThreshold', current: ps('zcFilterThreshold'),
          suggested: 'raise slightly',
          why: 'period estimate dithering between two values',
        }],
      );
    }

    // RULE (Python: BEMF lock intermittent in CL).
    const notsync = cl.filter((x) => !x.zcSynced).length;
    if (notsync > 0.3 * cl.length) {
      add(
        'BEMF lock intermittent in CL',
        'medium',
        `${Math.round((100 * notsync) / cl.length)}% of CL samples report not-synced`,
        [{
          param: 'hwzcCrossoverErpm', current: ps('hwzcCrossoverErpm'),
          suggested: 'review crossover / blanking',
          why: 'sync flag dropping during CL',
        }],
      );
    }
  }

  // RULE (Python: regen OV on throttle-down).
  if (faults.has('OV')) {
    add(
      'Regen overvoltage on throttle-down',
      'medium',
      'OV fault present',
      [{
        param: 'dutySlewDownPctPerMs', current: ps('dutySlewDownPctPerMs'),
        suggested: 'lower (slower down-slew)',
        why: 'limits regen energy dumped to the bus',
      }],
    );
  }

  // Overall severity + summary line (mirrors Python tail of local_diagnose()).
  const severity: DiagnosisResult['severity'] =
    faults.size ? 'critical' : findings.length ? 'warning' : 'ok';

  const summary = d.empty
    ? 'No telemetry captured.'
    : `${d.samples ?? 0} samples / ${d.duration_s ?? 0}s, `
      + `peak ${(peak_erpm).toLocaleString('en-US')} eRPM, HWZC reject ${Math.round(rejp)}%. `
      + (faults.size ? 'Faults: ' + [...faults].join(', ') : 'No faults.');

  return {
    summary,
    severity,
    findings,
    engine: 'local-rules',
    raw: d,
  };
}
