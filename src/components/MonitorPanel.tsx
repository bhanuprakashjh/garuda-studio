import { useEffect, useMemo, useRef, useState } from 'react';
import { useEscStore } from '../store/useEscStore';
import { ESC_STATES, FAULT_CODES } from '../protocol/types';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

/* State pills shown in the StateBar (mirrors the desktop garuda_gui top bar). */
const STATE_PILLS = ['IDLE', 'ARMED', 'ALIGN', 'OL_RAMP', 'MORPH', 'CLOSED_LOOP', 'FAULT'];

/* Live channels + colors, lifted verbatim from the desktop PLOTS table. */
interface Chan {
  key: string; label: string; color: string; fmt: (v: number) => string; defaultOn: boolean;
}
const CHANS: Chan[] = [
  { key: 'eRPM', label: 'eRPM', color: '#42a5f5', fmt: v => `${Math.round(v).toLocaleString()}`, defaultOn: true },
  { key: 'ia', label: 'Ia pk', color: '#ffa726', fmt: v => `${v.toFixed(1)} A`, defaultOn: true },
  { key: 'ibus', label: 'Ibus', color: '#ef5350', fmt: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} A`, defaultOn: true },
  { key: 'rej', label: 'HWZC rej', color: '#ab47bc', fmt: v => `${v.toFixed(0)} %`, defaultOn: true },
  { key: 'vbus', label: 'Vbus', color: '#66bb6a', fmt: v => `${v.toFixed(1)} V`, defaultOn: false },
  { key: 'bemf', label: 'BEMF', color: '#90caf9', fmt: v => `${Math.round(v)}`, defaultOn: false },
  { key: 'zcthr', label: 'ZC thr', color: '#bdbdbd', fmt: v => `${Math.round(v)}`, defaultOn: false },
  { key: 'duty', label: 'Duty', color: '#26c6da', fmt: v => `${Math.round(v)} %`, defaultOn: false },
  { key: 'throttle', label: 'Throttle', color: '#ffee58', fmt: v => `${Math.round(v)}`, defaultOn: false },
  { key: 'cpu', label: 'CPU', color: '#f06292', fmt: v => `${v.toFixed(0)} %`, defaultOn: false },
];

const READOUTS = ['eRPM', 'ia', 'ibus', 'vbus', 'duty', 'cpu'];

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
            padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 700,
            fontFamily: 'var(--font-mono)',
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

/** eRPM from the snapshot (HWZC HR period, else SW step period) — like GaugePanel. */
function deriveErpm(s: any, pwmHz: number): number {
  if (s.hwzcEnabled && s.hwzcStepPeriodHR > 0) return 1_000_000_000 / s.hwzcStepPeriodHR;
  if (s.stepPeriod > 0) return (pwmHz * 10) / s.stepPeriod;
  return 0;
}

export function MonitorPanel() {
  const snapshot = useEscStore(s => s.snapshot);
  const history = useEscStore(s => s.history);
  const info = useEscStore(s => s.info);
  const telemActive = useEscStore(s => s.telemActive);
  const lastMs = useEscStore(s => s.lastSnapshotMs);
  const [now, setNow] = useState(Date.now());
  const [active, setActive] = useState<Set<string>>(new Set(CHANS.filter(c => c.defaultOn).map(c => c.key)));
  const prevRej = useRef<{ rej: number; tot: number }>({ rej: 0, tot: 0 });

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const pwmHz = info?.pwmFrequency ?? 45000;
  const stale = !telemActive || (lastMs > 0 && now - lastMs > 2000);

  // map a raw snapshot -> channel values
  const mapPoint = (s: any, i: number) => {
    const vbus = s.vbusRaw * 3.3 / 4096 * 19.8;
    return {
      t: +(i * 0.033).toFixed(2),
      eRPM: Math.round(deriveErpm(s, pwmHz)),
      ia: +(s.iaPkMagA ?? 0).toFixed(2),
      ibus: +(s.ibusAvgA ?? 0).toFixed(2),
      rej: 0, // filled from cumulative deltas below for the live readout only
      vbus: +vbus.toFixed(2),
      bemf: s.bemfRaw,
      zcthr: s.zcThreshold,
      duty: s.dutyPct,
      throttle: s.throttle,
      cpu: +(s.cpuLoadPct ?? 0).toFixed(1),
    };
  };

  const data = useMemo(() => history.map(mapPoint), [history, pwmHz]);

  // live readout values from the latest snapshot
  const live = snapshot ? mapPoint(snapshot, 0) : null;
  // HWZC reject rate from cumulative deltas (accept vs reject this window)
  let rejPct = 0;
  if (snapshot) {
    const rej = snapshot.hwzcReject ?? 0;
    const tot = (snapshot.hwzcTotalZcCount ?? 0) + (snapshot.hwzcTotalMissCount ?? 0) + rej;
    const dRej = rej - prevRej.current.rej;
    const dTot = tot - prevRej.current.tot;
    if (dTot > 0) rejPct = Math.max(0, Math.min(100, (dRej / dTot) * 100));
    prevRej.current = { rej, tot };
  }

  const toggle = (k: string) => setActive(p => {
    const n = new Set(p); n.has(k) ? n.delete(k) : n.add(k); return n;
  });

  const card: React.CSSProperties = {
    background: 'var(--bg-card)', borderRadius: 'var(--radius)', padding: 14, border: '1px solid var(--border)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={card}><StateBar /></div>

      {/* Readout row */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${READOUTS.length}, 1fr)`, gap: 10 }}>
        {READOUTS.map(k => {
          const c = CHANS.find(x => x.key === k)!;
          const v = k === 'rej' ? rejPct : (live ? (live as any)[k] : 0);
          return (
            <div key={k} style={{ ...card, padding: '10px 8px', textAlign: 'center', opacity: stale ? 0.45 : 1 }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{c.label}</div>
              <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono)', color: stale ? 'var(--text-muted)' : c.color, lineHeight: 1.2 }}>
                {live ? c.fmt(v) : '—'}
              </div>
            </div>
          );
        })}
      </div>

      {/* Live chart */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>Live Telemetry</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {telemActive && !stale && (
              <span style={{ fontSize: 10, color: 'var(--accent-green)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-green)', animation: 'pulse 1.5s infinite' }} />LIVE
              </span>
            )}
            {stale && <span style={{ fontSize: 10, color: 'var(--accent-yellow)', fontWeight: 600 }}>{telemActive ? 'NO DATA' : 'IDLE'}</span>}
            <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{history.length} pts</span>
          </div>
        </div>

        {/* channel toggles */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
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

        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
            <XAxis dataKey="t" tick={{ fill: 'var(--text-muted)', fontSize: 9 }} />
            <YAxis yAxisId="big" tick={{ fill: 'var(--text-muted)', fontSize: 9 }} width={52} />
            <YAxis yAxisId="small" orientation="right" tick={{ fill: 'var(--text-muted)', fontSize: 9 }} width={40} />
            <Tooltip contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 10, fontFamily: 'var(--font-mono)' }} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            {CHANS.filter(c => active.has(c.key)).map(c => (
              <Line key={c.key} yAxisId={c.key === 'eRPM' || c.key === 'bemf' || c.key === 'zcthr' || c.key === 'throttle' ? 'big' : 'small'}
                type="monotone" dataKey={c.key} name={c.label} stroke={c.color}
                strokeWidth={1.5} dot={false} isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
