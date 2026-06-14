import { memo, useEffect, useRef, useState } from 'react';
import { useEscStore } from '../store/useEscStore';
import { ESC_STATES, FAULT_CODES } from '../protocol/types';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

/* Monitor — multi-channel oscilloscope (port of the desktop garuda_gui Monitor
 * tab).  Per-channel units/div + position + autoscale, freeze, timebase, and the
 * ZC↔BEMF scale link, all overlaid on a shared division grid like a real scope. */

const STATE_PILLS = ['IDLE', 'ARMED', 'ALIGN', 'OL_RAMP', 'MORPH', 'CLOSED_LOOP', 'FAULT'];
const DIVS = 8;  // vertical divisions

interface Chan {
  key: string; label: string; color: string; fmt: (v: number) => string;
  defaultOn: boolean; scale: number; bipolar: boolean;
}
const CHANS: Chan[] = [
  { key: 'eRPM', label: 'eRPM', color: '#42a5f5', fmt: v => `${Math.round(v).toLocaleString()}`, defaultOn: true, scale: 260000, bipolar: false },
  { key: 'ia', label: 'Ia pk', color: '#ffa726', fmt: v => `${v.toFixed(1)} A`, defaultOn: true, scale: 30, bipolar: false },
  { key: 'ibus', label: 'Ibus', color: '#ef5350', fmt: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} A`, defaultOn: true, scale: 30, bipolar: true },
  { key: 'rej', label: 'HWZC rej', color: '#ab47bc', fmt: v => `${v.toFixed(0)} %`, defaultOn: true, scale: 100, bipolar: false },
  { key: 'vbus', label: 'Vbus', color: '#66bb6a', fmt: v => `${v.toFixed(1)} V`, defaultOn: false, scale: 40, bipolar: false },
  { key: 'bemf', label: 'BEMF', color: '#90caf9', fmt: v => `${Math.round(v)}`, defaultOn: false, scale: 4095, bipolar: false },
  { key: 'zcthr', label: 'ZC thr', color: '#bdbdbd', fmt: v => `${Math.round(v)}`, defaultOn: false, scale: 4095, bipolar: false },
  { key: 'duty', label: 'Duty', color: '#26c6da', fmt: v => `${Math.round(v)} %`, defaultOn: false, scale: 100, bipolar: false },
  { key: 'throttle', label: 'Throttle', color: '#ffee58', fmt: v => `${Math.round(v)}`, defaultOn: false, scale: 4096, bipolar: false },
  { key: 'cpu', label: 'CPU', color: '#f06292', fmt: v => `${v.toFixed(0)} %`, defaultOn: false, scale: 100, bipolar: false },
];
const CH = (k: string) => CHANS.find(c => c.key === k)!;
const READOUTS = ['eRPM', 'ia', 'ibus', 'rej', 'vbus', 'duty', 'throttle', 'cpu'];
const TIMEBASES = [2, 5, 10, 20, 60];

interface ChanCfg { div: number; pos: number; }       // units per division, position in divisions
const defaultCfg = (c: Chan): ChanCfg => ({ div: c.scale / DIVS, pos: c.bipolar ? DIVS / 2 : 0.4 });

function StateBar() {
  const snapshot = useEscStore(s => s.snapshot);
  const state = snapshot ? (ESC_STATES[snapshot.state] ?? `?${snapshot.state}`) : '—';
  const faultCode = snapshot?.faultCode ?? 0;
  const fault = FAULT_CODES[faultCode] ?? `?${faultCode}`;
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {STATE_PILLS.map(p => {
        const active = state === p || (p === 'FAULT' && faultCode !== 0);
        const isFault = p === 'FAULT' && faultCode !== 0;
        return (
          <span key={p} style={{
            padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)',
            background: isFault ? '#b71c1c' : active ? '#1b5e20' : '#2a2a2a',
            color: isFault || active ? '#fff' : '#bbb',
          }}>{p}</span>
        );
      })}
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 12, color: faultCode ? 'var(--accent-red)' : 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
        fault: {fault}
      </span>
    </div>
  );
}

function deriveErpm(s: any, pwmHz: number): number {
  if (s.hwzcEnabled && s.hwzcStepPeriodHR > 0) return 1_000_000_000 / s.hwzcStepPeriodHR;
  if (s.stepPeriod > 0) return (pwmHz * 10) / s.stepPeriod;
  return 0;
}

/* The recharts plot, memoised on (data, active, cfg) so 50 Hz parent re-renders
 * (live readouts) don't touch it — only the 10 Hz throttled data / a control
 * change does.  Each channel is plotted in division-space (raw/div + pos). */
const OscChart = memo(function OscChart({ data, active, zcLink }: {
  data: any[]; active: Set<string>; zcLink: boolean;
}) {
  const tip = (value: any, name: any, props: any) => {
    const c = CHANS.find(x => x.label === name);
    if (!c) return value;
    return [c.fmt(props.payload?.[c.key] ?? 0), c.label];
  };
  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="var(--border-light)" />
        <XAxis dataKey="t" tick={{ fill: 'var(--text-muted)', fontSize: 9 }} tickFormatter={v => `${v}s`} />
        <YAxis domain={[0, DIVS]} hide />
        <Tooltip formatter={tip} labelFormatter={l => `${l}s`}
          contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 10, fontFamily: 'var(--font-mono)' }} />
        <Legend wrapperStyle={{ fontSize: 10 }} />
        {CHANS.filter(c => active.has(c.key)).map(c => (
          <Line key={c.key} dataKey={`${c.key}__d`} name={c.label} stroke={c.color}
            strokeWidth={c.key === 'zcthr' && zcLink ? 1 : 1.5}
            strokeDasharray={c.key === 'zcthr' && zcLink ? '5 4' : undefined}
            type="monotone" dot={false} isAnimationActive={false} connectNulls />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
});

export function MonitorPanel() {
  const snapshot = useEscStore(s => s.snapshot);
  const info = useEscStore(s => s.info);
  const telemActive = useEscStore(s => s.telemActive);
  const lastMs = useEscStore(s => s.lastSnapshotMs);
  const histLen = useEscStore(s => s.history.length);
  const [now, setNow] = useState(Date.now());
  const [active, setActive] = useState<Set<string>>(new Set(CHANS.filter(c => c.defaultOn).map(c => c.key)));
  const [cfg, setCfg] = useState<Record<string, ChanCfg>>(() => Object.fromEntries(CHANS.map(c => [c.key, defaultCfg(c)])));
  const [frozen, setFrozen] = useState(false);
  const [timebase, setTimebase] = useState(20);
  const [zcLink, setZcLink] = useState(false);
  const [data, setData] = useState<any[]>([]);
  const prevRej = useRef<{ rej: number; tot: number }>({ rej: 0, tot: 0 });
  const winRaw = useRef<Record<string, number[]>>({});  // last window of raw values per channel (for autoscale)

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const pwmHz = info?.pwmFrequency ?? 45000;
  const stale = !telemActive || (lastMs > 0 && now - lastMs > 2000);

  const rawOf = (s: any) => ({
    eRPM: Math.round(deriveErpm(s, pwmHz)),
    ia: +(s.iaPkMagA ?? 0).toFixed(2),
    ibus: +(s.ibusAvgA ?? 0).toFixed(2),
    rej: 0,
    vbus: +(s.vbusRaw * 3.3 / 4096 * 19.8).toFixed(2),
    bemf: s.bemfRaw, zcthr: s.zcThreshold, duty: s.dutyPct, throttle: s.throttle,
    cpu: +(s.cpuLoadPct ?? 0).toFixed(1),
  });

  // 10 Hz throttled scope builder → division-space points. Honours freeze + timebase.
  useEffect(() => {
    const id = setInterval(() => {
      if (frozen) return;
      const hist = useEscStore.getState().history;
      const want = Math.min(hist.length, timebase * 50);       // ~50 Hz telemetry
      const windowed = hist.slice(hist.length - want);
      const step = Math.max(1, Math.ceil(windowed.length / 300));
      const eff: Record<string, ChanCfg> = { ...cfg };
      if (zcLink && cfg.bemf) eff.zcthr = cfg.bemf;             // gang ZC thr to BEMF
      const pts: any[] = [];
      const acc: Record<string, number[]> = {};
      for (let i = 0; i < windowed.length; i += step) {
        const raw = rawOf(windowed[i]);
        const pt: any = { t: +((i - windowed.length) * 0.02 * step).toFixed(2) };
        for (const c of CHANS) {
          const v = (raw as any)[c.key] ?? 0;
          pt[c.key] = v;
          const cc = eff[c.key] ?? defaultCfg(c);
          pt[`${c.key}__d`] = v / (cc.div || 1) + cc.pos;
          (acc[c.key] ||= []).push(v);
        }
        pts.push(pt);
      }
      winRaw.current = acc;
      setData(pts);
    }, 100);
    return () => clearInterval(id);
  }, [pwmHz, cfg, frozen, timebase, zcLink]);

  // live readouts (full snapshot rate, cheap)
  const live = snapshot ? rawOf(snapshot) : null;
  let rejPct = 0;
  if (snapshot) {
    const rej = snapshot.hwzcReject ?? 0;
    const tot = (snapshot.hwzcTotalZcCount ?? 0) + (snapshot.hwzcTotalMissCount ?? 0) + rej;
    const dRej = rej - prevRej.current.rej, dTot = tot - prevRej.current.tot;
    if (dTot > 0) rejPct = Math.max(0, Math.min(100, (dRej / dTot) * 100));
    prevRej.current = { rej, tot };
  }

  const toggle = (k: string) => setActive(p => { const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const setChan = (k: string, patch: Partial<ChanCfg>) => setCfg(p => ({ ...p, [k]: { ...p[k], ...patch } }));
  const autoscale = (k: string) => {
    const vals = winRaw.current[k]; if (!vals || !vals.length) return;
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const c = CH(k);
    const span = Math.max(1e-6, hi - lo);
    const div = span / (DIVS * 0.8);
    const pos = DIVS / 2 - ((lo + hi) / 2) / div;             // center the trace
    setChan(k, { div: c.bipolar ? Math.max(div, Math.abs(hi) / (DIVS / 2)) : div, pos });
  };
  const autoAll = () => active.forEach(autoscale);

  const card: React.CSSProperties = { background: 'var(--bg-card)', borderRadius: 'var(--radius)', padding: 14, border: '1px solid var(--border)' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={card}><StateBar /></div>

      {/* readout tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${READOUTS.length}, 1fr)`, gap: 10 }}>
        {READOUTS.map(k => {
          const c = CH(k);
          const v = k === 'rej' ? rejPct : (live ? (live as any)[k] : 0);
          return (
            <div key={k} style={{ ...card, padding: '10px 8px', textAlign: 'center', opacity: stale ? 0.45 : 1 }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{c.label}</div>
              <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', color: stale ? 'var(--text-muted)' : c.color, lineHeight: 1.2 }}>
                {live ? c.fmt(v) : '—'}
              </div>
            </div>
          );
        })}
      </div>

      {/* scope */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>Oscilloscope</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => setFrozen(f => !f)} style={ctlBtn(frozen)}>{frozen ? '▶ Run' : '⏸ Freeze'}</button>
            <button onClick={autoAll} style={ctlBtn(false)}>Autoscale all</button>
            <label style={{ fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={zcLink} onChange={e => setZcLink(e.target.checked)} /> 🔗 ZC↔BEMF
            </label>
            <select value={timebase} onChange={e => setTimebase(+e.target.value)}
              style={{ padding: '3px 6px', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 11 }}>
              {TIMEBASES.map(s => <option key={s} value={s}>{s}s</option>)}
            </select>
            {telemActive && !stale && <span style={{ fontSize: 10, color: 'var(--accent-green)', fontWeight: 600 }}>● LIVE</span>}
            {stale && <span style={{ fontSize: 10, color: 'var(--accent-yellow)', fontWeight: 600 }}>{telemActive ? 'NO DATA' : 'IDLE'}</span>}
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{histLen} pts</span>
          </div>
        </div>

        {/* channel toggles */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
          {CHANS.map(c => {
            const on = active.has(c.key);
            return (
              <button key={c.key} onClick={() => toggle(c.key)} style={{
                padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 500, cursor: 'pointer',
                border: `1px solid ${on ? c.color : 'var(--border)'}`,
                background: on ? `${c.color}22` : 'transparent', color: on ? c.color : 'var(--text-muted)',
              }}>{c.label}</button>
            );
          })}
        </div>

        <OscChart data={data} active={active} zcLink={zcLink} />

        {/* per-channel units/div + position controls (active channels only) */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {CHANS.filter(c => active.has(c.key)).map(c => {
            const cc = cfg[c.key];
            const linked = c.key === 'zcthr' && zcLink;
            return (
              <div key={c.key} style={{
                display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px', borderRadius: 4,
                border: `1px solid ${c.color}55`, background: `${c.color}11`, fontSize: 10, opacity: linked ? 0.5 : 1,
              }}>
                <span style={{ color: c.color, fontWeight: 600, minWidth: 44 }}>{c.label}</span>
                <span style={{ color: 'var(--text-muted)' }}>/div</span>
                <input type="number" value={+cc.div.toPrecision(4)} disabled={linked}
                  onChange={e => setChan(c.key, { div: +e.target.value || cc.div })}
                  style={{ width: 64, fontSize: 10, padding: '1px 3px', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 3 }} />
                <span style={{ color: 'var(--text-muted)' }}>pos</span>
                <input type="number" step={0.5} value={+cc.pos.toFixed(2)} disabled={linked}
                  onChange={e => setChan(c.key, { pos: +e.target.value })}
                  style={{ width: 44, fontSize: 10, padding: '1px 3px', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 3 }} />
                <button onClick={() => autoscale(c.key)} disabled={linked} title="autoscale this channel"
                  style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer' }}>⤢</button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ctlBtn(active: boolean): React.CSSProperties {
  return {
    padding: '3px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer',
    border: `1px solid ${active ? 'var(--accent-cyan)' : 'var(--border)'}`,
    background: active ? 'var(--accent-blue-dim)' : 'transparent',
    color: active ? 'var(--accent-cyan)' : 'var(--text-secondary)',
  };
}
