import { useMemo, useState } from 'react';
import { useEscStore } from '../store/useEscStore';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts';
import { fallingWalk, feedforwardTest, FALLING_CAP_ERPM } from '../sim/fallingZc';

function linspace(lo: number, hi: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.round(lo + (hi - lo) * (i / (n - 1))));
  return out;
}

export function FallingZcSimPanel() {
  const info = useEscStore(s => s.info);
  const snapshot = useEscStore(s => s.snapshot);
  const vbus = snapshot ? Math.max(6, snapshot.vbusRaw * 3.3 / 4096 * 19.8) : 24.0;
  const maxErpm = info?.maxErpm ?? 235000;
  const [nPhase, setNPhase] = useState(12);

  const { data, verdict } = useMemo(() => {
    const erpms = linspace(15000, maxErpm, 34);
    const rows = fallingWalk(erpms, { vbus, nPhase });
    const ff = feedforwardTest(rows);
    const ffMap = new Map(ff?.rows.map(r => [r.erpm, r]) ?? []);
    const data = rows.map(r => {
      const f = ffMap.get(r.erpm);
      return {
        erpm: r.erpm,
        truePm: +r.truePm.toFixed(1),
        detPm: r.detPm !== null ? +r.detPm.toFixed(1) : null,
        detHi: r.detPm !== null ? +(r.detPm + r.detStd).toFixed(1) : null,
        detLo: r.detPm !== null ? +(r.detPm - r.detStd).toFixed(1) : null,
        timerErr: f ? +Math.abs(f.timerErr).toFixed(1) : 0,
        measErr: f && f.rawErr !== null ? +f.rawErr.toFixed(1) : null,
      };
    });
    const hi = rows.filter(r => r.erpm >= FALLING_CAP_ERPM);
    const maxTimer = ff ? Math.max(...ff.rows.filter(r => r.erpm >= FALLING_CAP_ERPM).map(r => Math.abs(r.timerErr))) : 0;
    const maxJit = Math.max(...hi.map(r => r.detStd));
    const maxMiss = Math.max(...hi.map(r => r.missPct));
    const trueMin = Math.min(...rows.map(r => r.truePm));
    const trueMax = Math.max(...rows.map(r => r.truePm));
    return {
      data,
      verdict: {
        trueMin, trueMax, maxTimer, maxJit, maxMiss, learnedUs: ff?.learnedUs ?? 0,
      },
    };
  }, [vbus, maxErpm, nPhase]);

  const card: React.CSSProperties = {
    background: 'var(--bg-card)', borderRadius: 'var(--radius)',
    padding: 16, border: '1px solid var(--border)',
  };
  const tooltipStyle = {
    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)', fontSize: 10, fontFamily: 'var(--font-mono)',
  };
  const fmtK = (v: number) => v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', margin: 0 }}>
            Falling-ZC sweep
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-muted)' }}>
            <span>Vbus {vbus.toFixed(1)}V · grid {nPhase}</span>
            <select value={nPhase} onChange={e => setNPhase(+e.target.value)} style={{
              background: 'var(--bg-secondary)', color: 'var(--text-secondary)',
              border: '1px solid var(--border)', borderRadius: 4, fontSize: 11, padding: '2px 4px',
            }}>
              <option value={8}>fast (8)</option>
              <option value={12}>12</option>
              <option value={24}>fine (24)</option>
            </select>
          </div>
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
          Analytic model (no hardware needed): where the falling sector's zero-cross
          truly sits vs where the RC-filtered OFF-center sampler measures it, across eRPM.
          The true ZC stays mid-sector; the measured walk is RC-lag + PWM quantization —
          which is why falling detection is capped at {fmtK(FALLING_CAP_ERPM)} and the timer
          extrapolation above it stays unbiased.
        </p>

        {/* Plot 1: ZC position */}
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
          Falling ZC position (permille of 60° sector)
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={data} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
            <XAxis dataKey="erpm" tickFormatter={fmtK} tick={{ fill: 'var(--text-muted)', fontSize: 9 }}
              label={{ value: 'eRPM', position: 'insideBottomRight', offset: -2, fill: 'var(--text-muted)', fontSize: 9 }} />
            <YAxis domain={[400, 1000]} tick={{ fill: 'var(--text-muted)', fontSize: 9 }} width={36} />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={(v) => `${fmtK(+v)} eRPM`} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <ReferenceLine x={FALLING_CAP_ERPM} stroke="#ef5350" strokeDasharray="4 4"
              label={{ value: '70k cap', fill: '#ef5350', fontSize: 9, position: 'top' }} />
            <Line type="monotone" dataKey="detHi" name="" stroke="#ffa726" strokeWidth={1}
              strokeOpacity={0.35} dot={false} isAnimationActive={false} legendType="none" />
            <Line type="monotone" dataKey="detLo" name="" stroke="#ffa726" strokeWidth={1}
              strokeOpacity={0.35} dot={false} isAnimationActive={false} legendType="none" />
            <Line type="monotone" dataKey="detPm" name="measured (OFF-center) ± jitter" stroke="#ffa726"
              strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
            <Line type="monotone" dataKey="truePm" name="true ZC (mid-sector)" stroke="#66bb6a"
              strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div style={card}>
        {/* Plot 2: commutation timing error */}
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
          Commutation timing error (permille): timer extrapolation (used &gt;70k) vs falling measurement (rejected)
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
            <XAxis dataKey="erpm" tickFormatter={fmtK} tick={{ fill: 'var(--text-muted)', fontSize: 9 }}
              label={{ value: 'eRPM', position: 'insideBottomRight', offset: -2, fill: 'var(--text-muted)', fontSize: 9 }} />
            <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 9 }} width={36} />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={(v) => `${fmtK(+v)} eRPM`} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            <ReferenceLine x={FALLING_CAP_ERPM} stroke="#ef5350" strokeDasharray="4 4" />
            <Line type="monotone" dataKey="measErr" name="if PI fed falling measurement" stroke="#ffa726"
              strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
            <Line type="monotone" dataKey="timerErr" name="timer extrapolation (firmware uses)" stroke="#42a5f5"
              strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>

        <div style={{
          marginTop: 12, padding: 10, borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-secondary)', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.6,
        }}>
          <strong style={{ color: 'var(--text-primary)' }}>Verdict.</strong>{' '}
          True falling ZC stays at {verdict.trueMin.toFixed(0)}–{verdict.trueMax.toFixed(0)} permille
          (mid-sector) across the whole range — the walk is pure RC-lag + PWM-quantization
          measurement error, not a rotor asymmetry. Above the {fmtK(FALLING_CAP_ERPM)} cap the
          timer-extrapolation error is ≤ {verdict.maxTimer.toFixed(0)} permille
          (≤ {(verdict.maxTimer / 10).toFixed(1)}% of a sector) = <em>unbiased</em>, while re-using
          the falling measurement would inject up to ±{verdict.maxJit.toFixed(0)} permille jitter and
          miss up to {verdict.maxMiss.toFixed(0)}% of sectors (a learned {verdict.learnedUs.toFixed(1)}µs
          feed-forward can't fix a measurement that noisy) — exactly the bench cap-raise failure.
          ⇒ &gt;70k roughness is <em>not</em> falling timing; look at comp-amp (bemfDevPeak)
          saturation ~125k.
        </div>
      </div>
    </div>
  );
}
