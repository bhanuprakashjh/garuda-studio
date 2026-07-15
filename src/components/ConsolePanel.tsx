import { useEffect, useRef, useState } from 'react';
import { useEscStore } from '../store/useEscStore';
import { serial } from './ConnectionBar';
import { buildPacket, CMD } from '../protocol/gsp';
import { ESC_STATES, FAULT_CODES, PARAM_NAMES } from '../protocol/types';
import type { AtaDiag } from '../protocol/types';
import { localDiagnose } from '../sim/diagnose';

interface Line { t: number; text: string; kind: 'in' | 'out' | 'err' | 'sys' | 'telem'; }

const KIND_COLOR: Record<Line['kind'], string> = {
  in: 'var(--accent-cyan)', out: 'var(--text-secondary)', err: 'var(--accent-red)',
  sys: 'var(--accent-purple)', telem: 'var(--text-muted)',
};

/** variable name from "Display [variable]" */
function varName(id: number): string {
  const m = PARAM_NAMES[id]?.match(/\[([^\]]+)\]/);
  return m ? m[1] : `0x${id.toString(16)}`;
}

export function ConsolePanel({ fill = false }: { fill?: boolean } = {}) {
  const [lines, setLines] = useState<Line[]>([{ t: 0, text: 'Garuda Studio console — type "help".', kind: 'sys' }]);
  const [cmd, setCmd] = useState('');
  const [recording, setRecording] = useState(false);
  const recRef = useRef<any[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const lastMirror = useRef({ ms: 0, state: -1 });
  const paused = useRef(false);   // gates the telemetry-mirror output (pause/resume)
  const store = useEscStore;

  const push = (text: string, kind: Line['kind'] = 'out') =>
    setLines(l => [...l.slice(-499), { t: Date.now(), text, kind }]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [lines]);

  // telemetry mirror + CSV capture
  useEffect(() => {
    const unsub = store.subscribe((st) => {
      const s = st.snapshot;
      if (!s) return;
      const now = Date.now();
      if (recording) recRef.current.push(rowOf(s, st.info?.pwmFrequency ?? 45000));
      const stateChanged = s.state !== lastMirror.current.state;
      if (!paused.current && st.telemActive && (stateChanged || now - lastMirror.current.ms > 1000)) {
        if (s.state !== 0 || stateChanged) push(mirrorLine(s, st.info?.pwmFrequency ?? 45000), 'telem');
        lastMirror.current = { ms: now, state: s.state };
      }
    });
    return () => unsub();
  }, [recording]);

  const run = async (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    push('› ' + line, 'in');
    const [c, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ');
    switch (c.toLowerCase()) {
      case 'help': case '?':
        push('commands: help, clear, pause, resume, params, get <name>, set <name> <val>, reload, save, defaults, export, mark <txt>, rec, ata, raw, diagnose'); break;
      case 'clear': setLines([]); break;
      case 'pause': paused.current = true; push('(telemetry mirror paused)', 'sys'); break;
      case 'resume': paused.current = false; push('(telemetry mirror resumed)', 'sys'); break;
      case 'params': {
        const p = store.getState().params;
        if (!p.size) { push('no params (connect + reload)', 'err'); break; }
        [...p.entries()].sort((a, b) => a[0] - b[0]).forEach(([id, pv]) =>
          push(`  ${varName(id).padEnd(22)} = ${pv.value}   [${pv.descriptor.min}..${pv.descriptor.max}]`));
        break;
      }
      case 'get': {
        const ent = findParam(arg);
        if (!ent) { push(`param not found: ${arg}`, 'err'); break; }
        push(`  ${varName(ent[0])} = ${ent[1].value}`); break;
      }
      case 'set': {
        const name = rest[0]; const val = parseInt(rest[1], 10);
        const ent = findParam(name);
        if (!ent || Number.isNaN(val)) { push('usage: set <name> <int>', 'err'); break; }
        const buf = new Uint8Array(6); const id = ent[0];
        buf[0] = id & 0xff; buf[1] = (id >> 8) & 0xff;
        buf[2] = val & 0xff; buf[3] = (val >> 8) & 0xff; buf[4] = (val >> 16) & 0xff; buf[5] = (val >> 24) & 0xff;
        await serial.write(buildPacket(CMD.SET_PARAM, buf)).catch(() => {});
        push(`  set ${varName(id)} = ${val}`); break;
      }
      case 'reload':
        await serial.write(buildPacket(CMD.GET_PARAM_LIST)).catch(() => {});
        push('  requested param list'); break;
      case 'export': exportC(); break;
      case 'mark': push('— ' + (arg || 'mark') + ' —', 'sys'); if (recording) recRef.current.push({ _mark: arg }); break;
      case 'rec': toggleRec(); break;
      case 'save':
        await serial.write(buildPacket(CMD.SAVE_CONFIG)).catch(() => {});
        push('flash save → writing param table (motor must be stopped)…', 'sys'); break;
      case 'defaults':
        await serial.write(buildPacket(CMD.LOAD_DEFAULTS)).catch(() => {});
        push("factory defaults → restoring (RAM only until 'save')…", 'sys'); break;
      case 'ata': await ataDiag(); break;
      case 'raw': rawDump(); break;
      case 'diagnose': diagnose(); break;
      default: push(`unknown command: ${c} (try help)`, 'err');
    }
  };

  const findParam = (name: string): [number, any] | undefined => {
    if (!name) return undefined;
    const n = name.toLowerCase();
    return [...store.getState().params.entries()].find(([id]) => varName(id).toLowerCase() === n
      || (PARAM_NAMES[id] || '').toLowerCase().includes(n));
  };

  const exportC = () => {
    const p = store.getState().params;
    if (!p.size) { push('nothing to export (reload params first)', 'err'); return; }
    const body = [...p.entries()].sort((a, b) => a[0] - b[0])
      .map(([id, pv]) => `    .${varName(id)} = ${pv.value},`).join('\n');
    const c = `/* Garuda Studio — live params export */\n{\n${body}\n}\n`;
    downloadText(c, 'garuda_params.c');
    push('  exported live params → garuda_params.c');
  };

  const toggleRec = () => {
    if (!recording) { recRef.current = []; setRecording(true); push('● recording telemetry…', 'sys'); }
    else {
      setRecording(false);
      const rows = recRef.current.filter(r => !r._mark);
      if (!rows.length) { push('no samples recorded', 'err'); return; }
      const cols = Object.keys(rows[0]);
      const csv = [cols.join(','), ...rows.map(r => cols.map(c => r[c]).join(','))].join('\n');
      downloadText(csv, `garuda_telemetry_${rows.length}.csv`);
      push(`■ saved ${rows.length} samples → CSV`, 'sys');
    }
  };

  // ATA6847 gate-driver diagnostics — request/response one-shot. Write the
  // request, wait (≤1.2s) for the RX switch to land the reply in the store, then
  // print. NOTE the read is destructive: the SIR fault regs are read-to-clear.
  const ataDiag = async () => {
    store.setState({ ataDiag: null });
    await serial.write(buildPacket(CMD.ATA_DIAG)).catch(() => {});
    const d = await new Promise<AtaDiag | null>((resolve) => {
      let unsub = () => {};
      const timer = setTimeout(() => { unsub(); resolve(null); }, 1200);
      unsub = store.subscribe((st) => {
        if (st.ataDiag) { clearTimeout(timer); unsub(); resolve(st.ataDiag); }
      });
    });
    if (!d) { push('ata: no reply (connected?)', 'err'); return; }
    formatAtaDiag(d).forEach(l => push(l));
  };

  // Dump the current-sense chain from the latest snapshot (local, no protocol).
  const rawDump = () => {
    const s = store.getState().snapshot;
    if (!s) { push('no snapshot yet — connect first', 'err'); return; }
    const sgn = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(3);
    push('current-sense chain (raw ADC counts, healthy bias ≈ 2048):');
    push(`  focOffsetIa = ${s.focOffsetIa}   focOffsetIb = ${s.focOffsetIb}   (boot calibration)`);
    push(`  focIa = ${sgn(s.focIa)} A   focIb = ${sgn(s.focIb)} A   (offset-subtracted)`);
    push(`  vbusRaw-derived Vbus = ${s.vbusV.toFixed(2)} V   state = ${ESC_STATES[s.state] ?? s.state}`);
  };

  const diagnose = () => {
    const st = store.getState();
    const hist = st.history;
    if (hist.length < 5) { push('not enough telemetry — let it run a few seconds', 'err'); return; }
    const res = localDiagnose(hist, { info: st.info ?? undefined });
    push('— diagnosis —', 'sys');
    push(`  ${res.summary}`, res.severity === 'critical' ? 'err' : 'out');
    if (res.findings.length === 0) {
      push('  ✓ no obvious issues in the recent window', 'out');
      return;
    }
    const sevKind: Record<string, Line['kind']> = { error: 'err', warn: 'out', info: 'sys' };
    for (const f of res.findings) {
      const kind = sevKind[f.severity] ?? 'out';
      push(`  [${f.severity.toUpperCase()}] ${f.title}`, kind);
      if (f.evidence) push(`      evidence: ${f.evidence}`, 'out');
      if (f.fix) push(`      fix: ${f.fix}`, 'out');
    }
  };

  return (
    <div className={fill ? '' : 'glass'} style={{ padding: fill ? '8px 12px' : 14, display: 'flex', flexDirection: 'column', height: fill ? '100%' : 'calc(100vh - 130px)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span className="hud-label">Console</span>
        <button onClick={toggleRec} className="glass glass-hover" style={{
          padding: '4px 12px', fontSize: 12, color: recording ? 'var(--accent-red)' : 'var(--accent-green)',
          border: `1px solid ${recording ? 'var(--accent-red)' : 'var(--border)'}`,
        }}>{recording ? '■ Stop & save CSV' : '● Record'}</button>
      </div>
      <div className="mono" style={{
        flex: 1, overflow: 'auto', fontSize: 11.5, lineHeight: 1.55,
        background: 'rgba(0,0,0,0.35)', borderRadius: 8, padding: 10, whiteSpace: 'pre-wrap',
      }}>
        {lines.map((l, i) => <div key={i} style={{ color: KIND_COLOR[l.kind] }}>{l.text}</div>)}
        <div ref={endRef} />
      </div>
      <form onSubmit={e => { e.preventDefault(); run(cmd); setCmd(''); }} style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        <span className="mono" style={{ color: 'var(--accent-cyan)', alignSelf: 'center' }}>›</span>
        <input value={cmd} onChange={e => setCmd(e.target.value)} placeholder="type a command (help)…"
          className="mono" style={{ flex: 1, fontSize: 12, padding: '6px 8px' }} autoFocus />
      </form>
    </div>
  );
}

function deriveErpm(s: any, pwm: number): number {
  if (s.hwzcEnabled && s.hwzcStepPeriodHR > 0) return Math.round(1e9 / s.hwzcStepPeriodHR);
  if (s.stepPeriod > 0) return Math.round(pwm * 10 / s.stepPeriod);
  return 0;
}
function rowOf(s: any, pwm: number) {
  return {
    t: (Date.now() / 1000).toFixed(2), state: ESC_STATES[s.state] ?? s.state, fault: FAULT_CODES[s.faultCode] ?? s.faultCode,
    throttle: s.throttle, duty: s.dutyPct, eRPM: deriveErpm(s, pwm),
    vbus: (s.vbusRaw * 3.3 / 4096 * 19.8).toFixed(1),
    ibusAvg: (s.ibusAvgA ?? 0).toFixed(2), iaPk: (s.iaPkMagA ?? 0).toFixed(2), cpu: (s.cpuLoadPct ?? 0).toFixed(0),
  };
}
function mirrorLine(s: any, pwm: number): string {
  const st = (ESC_STATES[s.state] ?? `?${s.state}`).padEnd(11);
  const f = s.faultCode ? ' ' + (FAULT_CODES[s.faultCode] ?? s.faultCode) : '';
  return `${st} thr=${String(s.throttle).padStart(4)} duty=${String(s.dutyPct).padStart(3)}% ` +
    `eRPM=${String(deriveErpm(s, pwm)).padStart(7)} Vbus=${(s.vbusRaw * 3.3 / 4096 * 19.8).toFixed(1)} ` +
    `Ibus=${(s.ibusAvgA ?? 0).toFixed(1)} Ia=${(s.iaPkMagA ?? 0).toFixed(1)}${f}`;
}
/** Mirrors the Python _log_ata_diag() output verbatim. */
function formatAtaDiag(d: AtaDiag): string[] {
  const hx = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  const gdus = (d.DSR1 !== 0xFF && (d.DSR1 & 0x04)) ? 'NORMAL' : 'NOT normal';
  const sirs = [d.SIR1, d.SIR2, d.SIR3, d.SIR4, d.SIR5].map((v, i) => `SIR${i + 1}=${hx(v)}`).join(' ');
  const faults = [d.SIR1, d.SIR2, d.SIR3, d.SIR4, d.SIR5].some(v => v !== 0);
  const lines = [
    'ATA6847 gate driver:',
    `  DSR1=${hx(d.DSR1)} (${gdus})  DSR2=${hx(d.DSR2)}  GOPMCR=${hx(d.GOPMCR)}`,
    `  ${sirs}` + (faults ? '   ← LATCHED FAULT FLAGS (now cleared by this read)' : '   (no latched faults)'),
    `  last GDU bring-up: result=${d.lastGduResult} attempts=${d.lastGduAttempts} dsr1=${hx(d.lastDsr1AtNormal)}  ataReady=${d.ataReady}`,
  ];
  if (d.DSR1 === 0xFF) lines.push('  ⚠ DSR1=FF: SPI likely not answering (all-ones bus)');
  return lines;
}
function downloadText(text: string, name: string) {
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
