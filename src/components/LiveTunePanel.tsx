import { useEffect, useRef, useState } from 'react';
import { useEscStore } from '../store/useEscStore';
import { serial } from './ConnectionBar';
import { buildPacket, CMD } from '../protocol/gsp';
import { isFocEnabled, isLiveTuneEnabled, ESC_STATES } from '../protocol/types';

/* LiveTunePanel — sliders for the parameters the firmware actually consumes in
 * its control loop, so you can drag and watch the live telemetry respond.
 *
 * FIRMWARE REALITY (gsp_commands.c HandleSetParam idle-gate):
 *   SET_PARAM is rejected unless the motor is IDLE — EXCEPT ids 0x90–0x93
 *   (AN1078 live overrides), which are whitelisted while spinning.
 * So `liveRun: true` specs change the motor in real time; `liveRun: false` specs
 * are read live in the ISR but can only be SET while IDLE (badge says so).
 * Dead knobs (OC-SW/OC-fault in 6-step, FOC_V2/V3 ids in AN1078) are excluded. */

type Group = 'live' | 'isr' | 'protect' | 'startup';

interface Spec {
  id: number; vbl: string; label: string; min: number; max: number; step: number;
  unit: string; group: Group; liveRun: boolean; effect: string;
  /** only show in this build: 'foc' | '6step' | 'both' */ build: 'foc' | '6step' | 'both';
  /** display scale: shown = raw * scale */ scale?: number;
}

const SPECS: Spec[] = [
  // ── FOC (AN1078) — TRULY live while spinning (whitelisted past the idle gate) ──
  { id: 0x90, vbl: 'an1078ThetaBaseDegX10', label: 'θ advance (base)', min: 0, max: 600, step: 10, unit: '°', scale: 0.1, group: 'live', liveRun: true, build: 'foc', effect: 'static commutation-angle offset → shifts Vd/Iq efficiency' },
  { id: 0x91, vbl: 'an1078ThetaKE7', label: 'θ advance (speed K)', min: 0, max: 1000, step: 25, unit: '', group: 'live', liveRun: true, build: 'foc', effect: 'speed-proportional advance, compensates observer LPF lag' },
  { id: 0x92, vbl: 'an1078KslideMv', label: 'Observer gain (Kslide)', min: 1000, max: 10000, step: 250, unit: 'mV', group: 'live', liveRun: true, build: 'foc', effect: '↑ faster BEMF lock, more θ chatter; ↓ may desync' },
  { id: 0x93, vbl: 'an1078IdFwMaxDecia', label: 'Field-weakening (Id max)', min: 0, max: 200, step: 10, unit: 'A', scale: 0.1, group: 'live', liveRun: true, build: 'foc', effect: '↑ more negative Id when saturated → higher top speed' },

  // ── 6-step — read live in the 24 kHz ISR, but SET only while IDLE ──
  { id: 0x22, vbl: 'timingAdvMaxDeg', label: 'Timing advance (max)', min: 0, max: 25, step: 1, unit: '°', group: 'isr', liveRun: false, build: '6step', effect: '↑ → Ibus ↓ at speed, higher top eRPM; too high → desync/OC' },
  { id: 0x64, vbl: 'zcBlankingPercent', label: 'ZC blanking', min: 1, max: 15, step: 1, unit: '%', group: 'isr', liveRun: false, build: '6step', effect: '↑ → fewer false ZC after commutation; too high → missed ZC' },
  { id: 0x65, vbl: 'zcAdcDeadband', label: 'ZC ADC deadband', min: 0, max: 20, step: 1, unit: 'cnt', group: 'isr', liveRun: false, build: '6step', effect: '↑ → noise immunity, but more timing jitter/lag' },
  { id: 0x56, vbl: 'zcDemagDutyThresh', label: 'Demag duty thresh', min: 20, max: 90, step: 5, unit: '%', group: 'isr', liveRun: false, build: '6step', effect: 'duty above which extra demag blanking engages' },
  { id: 0x57, vbl: 'zcDemagBlankExtraPct', label: 'Demag blank extra', min: 0, max: 30, step: 1, unit: '%', group: 'isr', liveRun: false, build: '6step', effect: 'duty-proportional blank extension; cleaner ZC at high duty' },
  { id: 0x66, vbl: 'zcSyncThreshold', label: 'ZC sync threshold', min: 4, max: 20, step: 1, unit: 'cnt', group: 'isr', liveRun: false, build: '6step', effect: 'good-ZCs to declare lock; ↑ slower but more robust (keep > filter)' },
  { id: 0x67, vbl: 'zcFilterThreshold', label: 'ZC filter threshold', min: 1, max: 10, step: 1, unit: 'cnt', group: 'isr', liveRun: false, build: '6step', effect: 'consecutive samples before accepting an edge (keep < sync)' },
  { id: 0x60, vbl: 'dutySlewUpPctPerMs', label: 'Duty slew up', min: 1, max: 20, step: 1, unit: '%/ms', group: 'isr', liveRun: false, build: '6step', effect: '↑ snappier throttle, more inrush/OC risk' },
  { id: 0x61, vbl: 'dutySlewDownPctPerMs', label: 'Duty slew down', min: 1, max: 50, step: 1, unit: '%/ms', group: 'isr', liveRun: false, build: '6step', effect: '↓ softer decel, less regen-OV; too slow → sluggish' },

  // ── protection (live every tick — guarded) ──
  { id: 0x68, vbl: 'vbusOvAdc', label: 'Vbus OV trip', min: 2000, max: 4000, step: 25, unit: 'adc', group: 'protect', liveRun: false, build: '6step', effect: 'over-voltage / regen-brake trip point' },
  { id: 0x69, vbl: 'vbusUvAdc', label: 'Vbus UV trip', min: 200, max: 2000, step: 25, unit: 'adc', group: 'protect', liveRun: false, build: '6step', effect: 'under-voltage (sag) trip point' },
  { id: 0x58, vbl: 'ocLimitMa', label: 'OC chop limit', min: 5000, max: 40000, step: 500, unit: 'A', scale: 0.001, group: 'protect', liveRun: false, build: '6step', effect: 'HW CMP3 current-chop level (re-latched on next state change)' },

  // ── startup (applies on NEXT start) ──
  { id: 0x17, vbl: 'rampDutyPct', label: 'OL ramp duty cap', min: 5, max: 80, step: 1, unit: '%', group: 'startup', liveRun: false, build: '6step', effect: 'open-loop / pre-sync duty cap' },
  { id: 0x16, vbl: 'rampAccelErpmPerS', label: 'OL ramp accel', min: 50, max: 20000, step: 50, unit: 'eRPM/s', group: 'startup', liveRun: false, build: '6step', effect: 'open-loop acceleration' },
  { id: 0x15, vbl: 'rampTargetErpm', label: 'OL handoff eRPM', min: 500, max: 20000, step: 100, unit: 'eRPM', group: 'startup', liveRun: false, build: '6step', effect: 'OL→CL handoff speed (also low knee of advance curve)' },
  { id: 0x54, vbl: 'sineAlignModPct', label: 'Sine align amp', min: 2, max: 50, step: 1, unit: '%', group: 'startup', liveRun: false, build: '6step', effect: 'sine-startup amplitude floor' },
  { id: 0x55, vbl: 'sineRampModPct', label: 'Sine ramp amp', min: 5, max: 80, step: 1, unit: '%', group: 'startup', liveRun: false, build: '6step', effect: 'sine-ramp amplitude ceiling' },
];

const GROUP_META: Record<Group, { title: string; color: string }> = {
  live: { title: '⚡ Live while running', color: 'var(--accent-green)' },
  isr: { title: 'ISR-live · set while IDLE', color: 'var(--accent-cyan)' },
  protect: { title: '🛡 Protection · set while IDLE', color: 'var(--accent-orange)' },
  startup: { title: '🚀 Startup · applies next start', color: 'var(--accent-purple)' },
};

function deriveErpm(s: any, pwmHz: number): number {
  if (s?.hwzcEnabled && s.hwzcStepPeriodHR > 0) return 1_000_000_000 / s.hwzcStepPeriodHR;
  if (s?.stepPeriod > 0) return (pwmHz * 10) / s.stepPeriod;
  return 0;
}

function sendSetParam(id: number, value: number) {
  const v = value >>> 0;
  const buf = new Uint8Array(6);
  buf[0] = id & 0xff; buf[1] = (id >> 8) & 0xff;
  buf[2] = v & 0xff; buf[3] = (v >> 8) & 0xff; buf[4] = (v >> 16) & 0xff; buf[5] = (v >> 24) & 0xff;
  serial.write(buildPacket(CMD.SET_PARAM, buf)).catch(() => {});
}

function Slider({ spec, raw, onSet, idle, liveRun }: { spec: Spec; raw: number; onSet: (v: number) => void; idle: boolean; liveRun: boolean }) {
  const [val, setVal] = useState(raw);
  const timer = useRef<any>(null);
  const dragging = useRef(false);
  useEffect(() => { if (!dragging.current) setVal(raw); }, [raw]);   // sync from board readback when not dragging

  const sc = spec.scale ?? 1;
  const disabled = !liveRun && !idle;     // can't set while running unless firmware allows it
  const commit = (v: number) => {
    setVal(v); dragging.current = true;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { onSet(v); dragging.current = false; }, 120);  // debounce the link
  };
  return (
    <div style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card-alt)', opacity: disabled ? 0.55 : 1 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{spec.label}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--accent-cyan)' }}>
          {(val * sc).toFixed(sc < 1 ? 1 : 0)}<span style={{ color: 'var(--text-muted)', fontSize: 10 }}> {spec.unit}</span>
        </span>
      </div>
      <input type="range" min={spec.min} max={spec.max} step={spec.step} value={val} disabled={disabled}
        onChange={e => commit(+e.target.value)} style={{ width: '100%', accentColor: liveRun ? 'var(--accent-green)' : 'var(--accent-cyan)' }} />
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>
        <span style={{ fontFamily: 'var(--font-mono)' }}>{spec.vbl}</span> · {spec.effect}
        {disabled && <span style={{ color: 'var(--accent-orange)' }}> · stop motor to change</span>}
      </div>
    </div>
  );
}

function Readout({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 70 }}>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 700, fontFamily: 'var(--font-mono)', color }}>{value}</div>
    </div>
  );
}

export function LiveTunePanel() {
  const params = useEscStore(s => s.params);
  const info = useEscStore(s => s.info);
  const snapshot = useEscStore(s => s.snapshot);
  const connected = useEscStore(s => s.connected);
  const foc = info ? isFocEnabled(info.featureFlags) : false;
  const liveTune = info ? isLiveTuneEnabled(info.featureFlags) : false;  // firmware allows ISR-live 6-step sets mid-run
  // effective "settable while running" per group: FOC whitelist always; ISR group only if firmware advertises it
  const effLiveRun = (sp: Spec) => sp.group === 'live' ? true : sp.group === 'isr' ? liveTune : false;
  const pwmHz = info?.pwmFrequency ?? 45000;
  const state = snapshot ? (ESC_STATES[snapshot.state] ?? '—') : '—';
  const idle = state === 'IDLE' || !snapshot;

  // show a spec only if (a) its build matches and (b) the board actually reports that param id
  const visible = SPECS.filter(sp => (sp.build === 'both' || sp.build === (foc ? 'foc' : '6step')) && params.has(sp.id));

  const card: React.CSSProperties = { background: 'var(--bg-card)', borderRadius: 'var(--radius)', padding: 14, border: '1px solid var(--border)' };
  const groups: Group[] = ['live', 'isr', 'protect', 'startup'];

  // live-effect readout strip
  const erpm = Math.round(deriveErpm(snapshot, pwmHz));
  const rd = foc
    ? [
        ['eRPM', erpm.toLocaleString(), 'var(--accent-blue)'],
        ['Id', `${(snapshot?.focIdMeas ?? 0).toFixed(2)}A`, 'var(--accent-red)'],
        ['Iq', `${(snapshot?.focIqMeas ?? 0).toFixed(2)}A`, 'var(--accent-yellow)'],
        ['|E|²', `${(snapshot?.focObsConfidence ?? 0).toFixed(2)}`, 'var(--accent-green)'],
        ['mod', `${(snapshot?.focModIndex ?? 0).toFixed(2)}`, 'var(--accent-cyan)'],
      ] as const
    : [
        ['eRPM', erpm.toLocaleString(), 'var(--accent-blue)'],
        ['Ia pk', `${(snapshot?.iaPkMagA ?? 0).toFixed(1)}A`, 'var(--accent-orange)'],
        ['Ibus', `${(snapshot?.ibusAvgA ?? 0).toFixed(1)}A`, 'var(--accent-red)'],
        ['Duty', `${snapshot?.dutyPct ?? 0}%`, 'var(--accent-cyan)'],
        ['ZC sync', snapshot?.zcSynced ? 'LOCK' : '—', snapshot?.zcSynced ? 'var(--accent-green)' : 'var(--text-muted)'],
      ] as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* live-effect telemetry strip */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>Live effect</span>
        {rd.map(([l, v, c]) => <Readout key={l} label={l} value={connected ? v : '—'} color={c as string} />)}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', padding: '3px 10px', borderRadius: 12,
          background: idle ? 'var(--accent-green-dim)' : 'var(--accent-orange-dim, rgba(255,167,38,0.15))',
          color: idle ? 'var(--accent-green)' : 'var(--accent-orange)', border: `1px solid ${idle ? 'var(--accent-green)' : 'var(--accent-orange)'}` }}>
          {state}{!idle && ' · only ⚡ sliders change live'}
        </span>
      </div>

      {!connected && <div style={{ ...card, color: 'var(--text-muted)', fontSize: 13 }}>Connect to a board to load tunable parameters.</div>}
      {connected && visible.length === 0 && <div style={{ ...card, color: 'var(--text-muted)', fontSize: 13 }}>No tunable params reported — press Reload params.</div>}

      {groups.map(g => {
        const specs = visible.filter(s => s.group === g);
        if (!specs.length) return null;
        const meta = GROUP_META[g];
        const title = g === 'isr'
          ? (liveTune ? '⚡ Live while running (ISR knobs)' : 'ISR-live · set while IDLE (no live-tune firmware)')
          : meta.title;
        const color = g === 'isr' && liveTune ? 'var(--accent-green)' : meta.color;
        return (
          <div key={g} style={card}>
            <div style={{ fontSize: 12, color, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 10, fontWeight: 700 }}>{title}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
              {specs.map(sp => (
                <Slider key={sp.id} spec={sp} idle={idle} liveRun={effLiveRun(sp)}
                  raw={params.get(sp.id)?.value ?? sp.min}
                  onSet={v => sendSetParam(sp.id, v)} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
