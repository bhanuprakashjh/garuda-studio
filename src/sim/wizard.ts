/* wizard.ts — Motor Profile Wizard physics + C code-gen.
 * Faithful TypeScript port of tools/garuda_debug/garuda_gui/wizard.py.
 * Turns datasheet numbers into a current-safe Garuda profile (gsp_params.c block)
 * with heuristics calibrated to the proven 2810 profile. */

const BOARD_OC_MAX_MA = 22000;
const RAMP_I_FRAC_OF_OC = 0.70;
const RAMP_I_MIN = 8.0, RAMP_I_MAX = 15.0;
const ALIGN_I_FRAC_OF_RAMP = 0.75;

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export interface MotorSpec {
  name: string; kv: number; rPpOhm: number; poles: number; weightG: number;
  maxCurrentA: number; vbusNom: number; inductanceUh: number | null;
  profileId: number; enumName: string;
}

export interface Profile {
  spec: MotorSpec; polePairs: number; noLoadErpm: number; maxClErpm: number;
  ocSwMa: number; ocLimitMa: number; ocFaultMa: number; ocStartupMa: number; rampCurrentGateMa: number;
  sineAlignModPct: number; sineRampModPct: number; alignDutyPct: number; rampDutyPct: number;
  clIdleDutyPct: number; rampAccel: number; rampTargetErpm: number; initialErpm: number;
  timingAdvDeg: number; zcDemagDutyThresh: number; zcDemagBlankExtraPct: number;
  rampCurrentA: number; alignCurrentA: number;
  focRsMohm: number; focLsUh: number; focKeUvSRad: number; lsEstimated: boolean;
  warnings: string[];
}

export function computeProfile(spec: MotorSpec): Profile {
  const pp = Math.floor(spec.poles / 2);
  const noLoad = Math.floor(spec.kv * spec.vbusNom * pp);
  const maxCl = Math.round(noLoad * 1.05 / 1000) * 1000;

  let ocSw = Math.min(Math.floor(spec.maxCurrentA * 1000), BOARD_OC_MAX_MA - 4000);
  let ocLimit = Math.min(Math.floor(ocSw * 1.25), BOARD_OC_MAX_MA - 2000);
  let ocFault = Math.min(Math.floor(ocLimit * 1.05), BOARD_OC_MAX_MA - 1000);
  let ocStartup = Math.min(Math.floor(ocFault * 1.05), BOARD_OC_MAX_MA);
  ocLimit = Math.max(ocLimit, ocSw + 500);
  ocFault = Math.max(ocFault, ocLimit);
  ocStartup = Math.max(ocStartup, ocFault);

  const ocSwA = ocSw / 1000;
  const rampI = clamp(RAMP_I_FRAC_OF_OC * ocSwA, RAMP_I_MIN, RAMP_I_MAX);
  const alignI = ALIGN_I_FRAC_OF_RAMP * rampI;

  const pctAmp = (i: number) => clamp(Math.round(i * spec.rPpOhm / spec.vbusNom * 200), 2, 50);
  const pctDuty = (i: number, scale = 1.0) => clamp(Math.round(i * spec.rPpOhm / spec.vbusNom * 100 * scale), 2, 25);

  const prof: Profile = {
    spec, polePairs: pp, noLoadErpm: noLoad, maxClErpm: maxCl,
    ocSwMa: ocSw, ocLimitMa: ocLimit, ocFaultMa: ocFault, ocStartupMa: ocStartup,
    rampCurrentGateMa: Math.min(ocLimit - 2000, Math.round(rampI * 1000) + 2000),
    sineAlignModPct: pctAmp(alignI), sineRampModPct: pctAmp(rampI),
    alignDutyPct: pctDuty(alignI), rampDutyPct: pctDuty(rampI, 1.5),
    clIdleDutyPct: clamp(Math.round(6.0 * spec.rPpOhm / spec.vbusNom * 100), 5, 14),
    rampAccel: Math.round(clamp(3000 * (spec.kv / 1350) * (90 / spec.weightG), 500, 5000)),
    rampTargetErpm: 3000,
    initialErpm: spec.weightG < 100 ? 150 : 100,
    timingAdvDeg: Math.round(clamp(10 + 15 * (maxCl / 260000), 8, 28)),
    zcDemagDutyThresh: 45, zcDemagBlankExtraPct: 18,
    rampCurrentA: rampI, alignCurrentA: alignI,
    focRsMohm: Math.round(spec.rPpOhm / 2 * 1000),
    focKeUvSRad: Math.round(60 / (Math.sqrt(3) * 2 * Math.PI * spec.kv * pp) * 1e6),
    lsEstimated: spec.inductanceUh == null,
    focLsUh: spec.inductanceUh ? Math.floor(spec.inductanceUh) : 30,
    warnings: [],
  };
  prof.warnings = validate(prof);
  return prof;
}

function validate(p: Profile): string[] {
  const w: string[] = [];
  const vb = p.spec.vbusNom, r = p.spec.rPpOhm;
  const rampA = p.sineRampModPct / 200 * vb / r;
  if (rampA > p.ocSwMa / 1000)
    w.push(`sineRampModPct=${p.sineRampModPct} → ~${rampA.toFixed(0)}A exceeds OC soft limit ${(p.ocSwMa / 1000).toFixed(0)}A — lower it`);
  if (!(p.ocSwMa < p.ocLimitMa && p.ocLimitMa <= p.ocFaultMa && p.ocFaultMa <= p.ocStartupMa))
    w.push('OC chain ordering violated (sw < limit ≤ fault ≤ startup)');
  if (p.ocStartupMa > BOARD_OC_MAX_MA)
    w.push(`ocStartupMa ${p.ocStartupMa} > board shunt max ${BOARD_OC_MAX_MA}`);
  if (p.lsEstimated)
    w.push('inductance ESTIMATED (30µH) — affects only FOC + ZC blanking; if ZC won\'t lock in MORPH, nudge zcDemagBlankExtraPct');
  if (p.spec.kv * p.spec.vbusNom * p.polePairs > 250000)
    w.push('no-load eRPM is very high — may approach the BEMF/speed ceiling near full throttle');
  return w;
}

export function report(p: Profile): string {
  const s = p.spec;
  return `${s.name}: ${p.polePairs}PP  no-load≈${p.noLoadErpm.toLocaleString()} eRPM  cap=${p.maxClErpm.toLocaleString()}
  startup: sineAlign=${p.sineAlignModPct}(~${p.alignCurrentA.toFixed(1)}A)  sineRamp=${p.sineRampModPct}(~${p.rampCurrentA.toFixed(1)}A)  accel=${p.rampAccel}  timingAdv=${p.timingAdvDeg}
  OC chain (mA): sw=${p.ocSwMa} < limit=${p.ocLimitMa} ≤ fault=${p.ocFaultMa} ≤ startup=${p.ocStartupMa}`;
}

export function renderProfileC(p: Profile): string {
  const s = p.spec;
  const lsNote = p.lsEstimated ? '   /* ESTIMATE — measure */' : '';
  const head = '/* ' + '═'.repeat(70) + ' */';
  const warnBlock = p.warnings.length
    ? '/* ⚠ WARNINGS:\n' + p.warnings.map(w => ` *   - ${w}`).join('\n') + '\n */\n'
    : '';
  return `${head}
/* Garuda Studio Wizard — profile for ${s.name} (profile ${s.profileId}, GSP_PROFILE_${s.enumName}) */
${head}
${warnBlock}    [GSP_PROFILE_${s.enumName}] = {
        /* ${s.name} (${s.poles}poles/${p.polePairs}PP, ${s.vbusNom.toFixed(0)}V, ${s.weightG.toFixed(0)}g)
         * Rs(ph-ph)=${s.rPpOhm}Ω, KV=${s.kv.toFixed(0)}, max cont ${s.maxCurrentA.toFixed(0)}A.
         * Startup current-matched: ramp≈${p.rampCurrentA.toFixed(1)}A, align≈${p.alignCurrentA.toFixed(1)}A
         * (both < OC soft ${(p.ocSwMa / 1000).toFixed(0)}A). Raise sineRampModPct if it stalls in
         * OL_RAMP, lower if OC_SW. */
        .rampTargetErpm     = ${p.rampTargetErpm},
        .rampAccelErpmPerS  = ${p.rampAccel},
        .rampDutyPct        = ${p.rampDutyPct},
        .clIdleDutyPct      = ${p.clIdleDutyPct},
        .timingAdvMaxDeg    = ${p.timingAdvDeg},
        .hwzcCrossoverErpm  = 1500,
        .ocSwLimitMa        = ${p.ocSwMa},
        .ocFaultMa          = ${p.ocFaultMa},
        .motorPolePairs     = ${p.polePairs},
        .alignDutyPct       = ${p.alignDutyPct},
        .initialErpm        = ${p.initialErpm},
        .maxClosedLoopErpm  = ${p.maxClErpm},   /* ${s.kv.toFixed(0)} * ${s.vbusNom.toFixed(0)}V * ${p.polePairs}pp ≈ ${p.noLoadErpm.toLocaleString()} */
        .sineAlignModPct    = ${p.sineAlignModPct},
        .sineRampModPct     = ${p.sineRampModPct},
        .zcDemagDutyThresh  = ${p.zcDemagDutyThresh},
        .zcDemagBlankExtraPct = ${p.zcDemagBlankExtraPct},
        .ocLimitMa          = ${p.ocLimitMa},   /* CMP3 chop */
        .ocStartupMa        = ${p.ocStartupMa},
        .rampCurrentGateMa  = ${p.rampCurrentGateMa},
        /* --- FOC (compile-only in 6-step) --- */
        .focRsMilliOhm       = ${p.focRsMohm},
        .focLsMicroH         = ${p.focLsUh},${lsNote}
        .focKeUvSRad         = ${p.focKeUvSRad},
        .focVbusNomCentiV    = ${Math.round(s.vbusNom * 100)},
        .focMaxCurrentCentiA = ${Math.round(s.maxCurrentA * 100)},
        .focMaxElecRadS      = 9000,
        .focKpDqMilli        = 188,
        .focKiDq             = 590,
        .focObsLpfAlphaMilli = 200,
        .focAlignIqCentiA    = 400,
        .focRampIqCentiA     = 500,
        .focAlignTimeMs      = 800,
        .focIqRampTimeMs     = 300,
        .focRampRateRps2     = 200,
        .focHandoffRadS      = 800,
        .focFaultOcCentiA    = ${Math.round(s.maxCurrentA * 100 * 1.2)},
        .focFaultStallDeciRadS = 50,
    }},

/* gsp_params.h enum:  GSP_PROFILE_${s.enumName} = ${s.profileId},  (then bump COUNT)
 * garuda_config.h:    #elif MOTOR_PROFILE==${s.profileId}  // ${s.name}
 * Build-test: set MOTOR_PROFILE=${s.profileId}, make clean && make. */`;
}
