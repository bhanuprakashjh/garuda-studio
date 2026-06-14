import { useEffect, useState } from 'react';
import { useEscStore } from '../store/useEscStore';
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ZAxis,
} from 'recharts';

/* OperatingMapPanel — Ia-pk vs eRPM scatter (port of the desktop garuda_gui
 * "operating map").  Each point is a telemetry sample; the cloud shows where the
 * motor spends time and how phase-current peak climbs with speed. */

function deriveErpm(s: any, pwmHz: number): number {
  if (s.hwzcEnabled && s.hwzcStepPeriodHR > 0) return 1_000_000_000 / s.hwzcStepPeriodHR;
  if (s.stepPeriod > 0) return (pwmHz * 10) / s.stepPeriod;
  return 0;
}

export function OperatingMapPanel() {
  const info = useEscStore(s => s.info);
  const [pts, setPts] = useState<{ x: number; y: number }[]>([]);

  useEffect(() => {
    const pwmHz = info?.pwmFrequency ?? 45000;
    const id = setInterval(() => {
      const hist = useEscStore.getState().history;
      const step = Math.max(1, Math.ceil(hist.length / 600));   // cap at ~600 dots
      const out: { x: number; y: number }[] = [];
      for (let i = 0; i < hist.length; i += step) {
        const s: any = hist[i];
        const e = Math.round(deriveErpm(s, pwmHz));
        if (e > 0) out.push({ x: e, y: +(s.iaPkMagA ?? 0).toFixed(2) });
      }
      setPts(out);
    }, 400);
    return () => clearInterval(id);
  }, [info]);

  const card: React.CSSProperties = {
    background: 'var(--bg-card)', borderRadius: 'var(--radius)', padding: 14, border: '1px solid var(--border)',
  };

  return (
    <div style={card}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8 }}>
        Operating map — Ia&nbsp;pk vs eRPM <span style={{ fontFamily: 'var(--font-mono)' }}>({pts.length} pts)</span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <ScatterChart margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
          <XAxis type="number" dataKey="x" name="eRPM" tick={{ fill: 'var(--text-muted)', fontSize: 9 }}
            tickFormatter={v => `${Math.round(v / 1000)}k`} domain={[0, 'dataMax']} />
          <YAxis type="number" dataKey="y" name="Ia pk" unit="A" tick={{ fill: 'var(--text-muted)', fontSize: 9 }} width={40} domain={[0, 'dataMax']} />
          <ZAxis range={[14, 14]} />
          <Tooltip cursor={{ strokeDasharray: '3 3' }}
            contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 10, fontFamily: 'var(--font-mono)' }} />
          <Scatter data={pts} fill="#ffa726" fillOpacity={0.5} isAnimationActive={false} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
