import { useEffect, useRef, useState } from 'react';
import { useEscStore } from '../store/useEscStore';
import { serial } from './ConnectionBar';
import { buildPacket, CMD } from '../protocol/gsp';
import { ESC_STATES, FAULT_CODES, PARAM_NAMES } from '../protocol/types';

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

export function ConsolePanel() {
  const [lines, setLines] = useState<Line[]>([{ t: 0, text: 'Garuda Studio console — type "help".', kind: 'sys' }]);
  const [cmd, setCmd] = useState('');
  const [recording, setRecording] = useState(false);
  const recRef = useRef<any[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const lastMirror = useRef({ ms: 0, state: -1 });
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
      if (st.telemActive && (stateChanged || now - lastMirror.current.ms > 1000)) {
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
        push('commands: help, clear, params, get <name>, set <name> <val>, reload, export, mark <txt>, rec, diagnose'); break;
      case 'clear': setLines([]); break;
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
      case 'rec': case 'save': toggleRec(); break;
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

  const diagnose = () => {
    const st = store.getState();
    const hist = st.history;
    if (hist.length < 5) { push('not enough telemetry — let it run a few seconds', 'err'); return; }
    push('— diagnosis —', 'sys');
    const last = hist[hist.length - 1];
    const faults = new Set(hist.map(h => h.faultCode).filter(f => f));
    if (faults.size) push(`  faults seen: ${[...faults].map(f => FAULT_CODES[f] ?? f).join(', ')}`, 'err');
    const maxIa = Math.max(...hist.map(h => h.iaPkMagA ?? 0));
    if (maxIa > 18) push(`  ⚠ high phase current peak ${maxIa.toFixed(1)}A (OC region ~22A)`, 'err');
    const idleIbus = Math.abs(last.ibusAvgA ?? 0);
    if (last.state === 0 && idleIbus > 1) push(`  ⚠ bus current ${idleIbus.toFixed(1)}A at idle — possible sense offset`, 'err');
    const rejHi = hist.slice(-30).some(h => (h.hwzcTotalMissCount ?? 0) > 0);
    if (rejHi) push('  note: HWZC misses present — check ZC at the speed band where they spike');
    if (!faults.size && maxIa <= 18) push('  ✓ no obvious faults in the recent window', 'out');
  };

  return (
    <div className="glass" style={{ padding: 14, display: 'flex', flexDirection: 'column', height: 'calc(100vh - 130px)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
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
function downloadText(text: string, name: string) {
  const blob = new Blob([text], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
