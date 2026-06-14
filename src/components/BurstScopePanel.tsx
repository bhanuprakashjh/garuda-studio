import { useState, useCallback, useRef, useEffect } from 'react';
import { useEscStore } from '../store/useEscStore';
import { serial } from './ConnectionBar';
import { isBurstScopeEnabled, SCOPE_TRIG_MODES, SCOPE_STATES, SCOPE_CHANNELS } from '../protocol/types';
import type { ScopeArmConfig, ScopeSample } from '../protocol/types';
import { CMD, buildPacket, buildScopeArmPayload } from '../protocol/gsp';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
         ResponsiveContainer, Legend, ReferenceLine, Scatter } from 'recharts';

const DT_US = 1e6 / 24000;  // 41.67 µs per sample

/* ── ZC Explainer ───────────────────────────────────────────────────────────
 * Web mirror of the desktop garuda_gui "ZC Explainer": after a capture, detect
 * sign-change zero-crossings on the most BEMF-like captured channel (the phase
 * currents ia/ib are the only sinusoidal back-EMF-correlated traces in the FOC
 * burst), then report signal-integrity checks.
 *
 * A crossing = where the trace crosses its own mean (DC-removed sign change);
 * the linearly-interpolated sub-sample time gives the marker x-position. */
interface ZcAnalysis {
  channel: string;
  mean: number;
  bemfLike: boolean;          // true for ia/ib, false when analysing a non-BEMF trigger ch
  crossings: { t_us: number }[];
  halfMin: number;            // µs — shortest interval between adjacent crossings
  halfMax: number;            // µs — longest
  symmetryPct: number;        // 100·(max-min)/max — 0 = perfectly symmetric half-periods
  dcOffsetNote: string;
  pkpk: number;               // peak-to-peak amplitude of the trace
}

type ZcChannelKey = 'ia' | 'ib';

/** Field name of the channel we analyse, and whether it is BEMF-like. */
function analysisChannel(samples: ScopeSample[]): { key: ZcChannelKey; label: string; bemfLike: boolean } {
  // ia is the primary BEMF-like phase current; fall back to ib if ia is flat.
  const span = (k: ZcChannelKey) => {
    let lo = Infinity, hi = -Infinity;
    for (const s of samples) { const v = s[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
    return hi - lo;
  };
  if (span('ia') >= span('ib')) return { key: 'ia', label: 'Ia', bemfLike: true };
  return { key: 'ib', label: 'Ib', bemfLike: true };
}

function analyzeZc(samples: ScopeSample[], prePct: number): ZcAnalysis | null {
  if (samples.length < 4) return null;
  const ch = analysisChannel(samples);
  const vals = samples.map(s => s[ch.key]);
  const n = vals.length;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const pkpk = hi - lo;
  const preLen = Math.floor(n * prePct / 100);

  const crossings: { t_us: number }[] = [];
  for (let i = 1; i < n; i++) {
    const a = vals[i - 1] - mean, b = vals[i] - mean;
    if (a === 0) continue;            // exact-on-mean handled by the previous step's interp
    if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) {
      // linear interpolation of the sub-sample crossing index
      const frac = a / (a - b);       // 0..1 between i-1 and i
      const idx = (i - 1) + frac;
      crossings.push({ t_us: +((idx - preLen) * DT_US).toFixed(2) });
    }
  }

  // half-period symmetry: intervals between adjacent crossings
  let halfMin = 0, halfMax = 0, symmetryPct = 0;
  if (crossings.length >= 2) {
    const ints: number[] = [];
    for (let i = 1; i < crossings.length; i++) ints.push(Math.abs(crossings[i].t_us - crossings[i - 1].t_us));
    halfMin = Math.min(...ints);
    halfMax = Math.max(...ints);
    symmetryPct = halfMax > 0 ? (100 * (halfMax - halfMin)) / halfMax : 0;
  }

  // DC-offset note: mean relative to peak-to-peak amplitude
  const offFrac = pkpk > 1e-6 ? Math.abs(mean) / pkpk : 0;
  const dcOffsetNote = pkpk < 1e-6
    ? 'flat trace (no signal)'
    : offFrac > 0.15
      ? `large DC bias (${(offFrac * 100).toFixed(0)}% of pk-pk) — current-offset/regen, not centered`
      : `centered (mean ${mean.toFixed(2)}, ${(offFrac * 100).toFixed(0)}% of pk-pk)`;

  return {
    channel: ch.label, mean, bemfLike: ch.bemfLike,
    crossings, halfMin, halfMax, symmetryPct, dcOffsetNote, pkpk,
  };
}

export default function BurstScopePanel() {
  const info = useEscStore(s => s.info);
  const scopeStatus = useEscStore(s => s.scopeStatus);
  const samples = useEscStore(s => s.scopeSamples);
  const scopeReading = useEscStore(s => s.scopeReading);
  const clearScopeSamples = useEscStore(s => s.clearScopeSamples);

  const [trigMode, setTrigMode] = useState(1); // fault
  const [prePct, setPrePct] = useState(50);
  const [trigCh, setTrigCh] = useState(3); // iq
  const [trigEdge, setTrigEdge] = useState(0); // rising
  const [threshold, setThreshold] = useState(1000);
  const [polling, setPolling] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clean up polling on unmount
  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  // Stop polling when scope becomes READY
  useEffect(() => {
    if (scopeStatus?.state === 3 && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      setPolling(false);
    }
  }, [scopeStatus?.state]);

  if (!info || !isBurstScopeEnabled(info.featureFlags)) {
    return (
      <div style={{ padding: 16, color: 'var(--text-muted)', fontStyle: 'italic' }}>
        Burst scope not available (FEATURE_BURST_SCOPE not enabled in firmware)
      </div>
    );
  }

  const handleArm = useCallback(async () => {
    clearScopeSamples();
    const cfg: ScopeArmConfig = { trigMode, preTrigPct: prePct, trigChannel: trigCh, trigEdge, threshold };
    await serial.write(buildPacket(CMD.SCOPE_ARM, buildScopeArmPayload(cfg)));

    // Start polling status at 5Hz
    setPolling(true);
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      serial.write(buildPacket(CMD.SCOPE_STATUS));
    }, 200);

    // Timeout after 60s
    setTimeout(() => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        setPolling(false);
      }
    }, 60000);
  }, [trigMode, prePct, trigCh, trigEdge, threshold, clearScopeSamples]);

  const stateLabel = scopeStatus ? (SCOPE_STATES[scopeStatus.state] || '?') : 'N/A';

  // ZC Explainer: sign-change crossing detection + integrity readout on the
  // most BEMF-like captured channel (ia/ib).  Recomputed only when samples change.
  const zc = samples.length >= 4 ? analyzeZc(samples, prePct) : null;
  const zcMeanY = zc ? zc.mean : 0;

  // Build chart data with time axis relative to trigger.  zcMarker carries a
  // y-value (the channel mean) at the chart x nearest each crossing so the
  // Scatter overlay drops a dot exactly on the trace's mean line at the ZC.
  const crossingXs = zc ? zc.crossings.map(c => c.t_us) : [];
  const chartData = samples.map((s, i) => {
    const t_us = +((i - Math.floor(samples.length * prePct / 100)) * DT_US).toFixed(1);
    // mark this point if a crossing's interpolated time rounds to within half a
    // sample of this x (so every crossing gets exactly one nearby marker).
    const hit = crossingXs.some(cx => Math.abs(cx - t_us) <= DT_US / 2);
    return {
      t_us,
      ia: s.ia, ib: s.ib, id: s.id, iq: s.iq,
      vd: s.vd, vq: s.vq,
      theta: s.theta, omega: s.omega,
      modIndex: s.modIndex, obsX1: s.obsX1, obsX2: s.obsX2,
      zcMarker: hit ? zcMeanY : null,
    };
  });

  return (
    <div style={{ padding: 16 }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>
        Burst Scope (128 samples @ 24kHz = 5.33ms window)
      </h3>

      {/* Controls */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16,
        padding: 12, background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)',
      }}>
        <label style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 2 }}>
          Trigger
          <select value={trigMode} onChange={e => setTrigMode(+e.target.value)}
                  style={{ fontSize: 11, padding: '2px 4px' }}>
            {SCOPE_TRIG_MODES.map((name, i) => <option key={i} value={i}>{name}</option>)}
          </select>
        </label>

        <label style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 2 }}>
          Pre-trigger %
          <input type="number" min={0} max={100} value={prePct}
                 onChange={e => setPrePct(+e.target.value)}
                 style={{ width: 50, fontSize: 11, padding: '2px 4px' }} />
        </label>

        {trigMode === 3 && <>
          <label style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 2 }}>
            Channel
            <select value={trigCh} onChange={e => setTrigCh(+e.target.value)}
                    style={{ fontSize: 11, padding: '2px 4px' }}>
              {SCOPE_CHANNELS.map((name, i) => name ? <option key={i} value={i}>{name}</option> : null)}
            </select>
          </label>

          <label style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 2 }}>
            Edge
            <select value={trigEdge} onChange={e => setTrigEdge(+e.target.value)}
                    style={{ fontSize: 11, padding: '2px 4px' }}>
              <option value={0}>Rising</option>
              <option value={1}>Falling</option>
            </select>
          </label>

          <label style={{ fontSize: 11, display: 'flex', flexDirection: 'column', gap: 2 }}>
            Threshold (scaled)
            <input type="number" value={threshold}
                   onChange={e => setThreshold(+e.target.value)}
                   style={{ width: 70, fontSize: 11, padding: '2px 4px' }} />
          </label>
        </>}

        <button onClick={handleArm} disabled={polling || scopeReading}
                style={{
                  alignSelf: 'flex-end', padding: '4px 16px', fontSize: 11,
                  fontWeight: 600, cursor: polling ? 'wait' : 'pointer',
                  background: (polling || scopeReading) ? 'var(--bg-tertiary)' : 'var(--accent)',
                  color: 'white', border: 'none', borderRadius: 4,
                }}>
          {polling ? `Waiting... (${stateLabel})` : scopeReading ? 'Reading...' : 'Arm & Capture'}
        </button>

        <div style={{ alignSelf: 'flex-end', fontSize: 10, color: 'var(--text-muted)' }}>
          Status: {stateLabel}
          {scopeStatus && ` | ${scopeStatus.sampleCount} samples`}
          {samples.length > 0 && ` | ${samples.length} read`}
        </div>
      </div>

      {/* Charts */}
      {samples.length > 0 && (
        <>
          <div style={{ height: 200, marginBottom: 8 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 30, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="t_us" fontSize={9} label={{ value: 'µs', position: 'insideBottomRight', offset: -5, fontSize: 9 }} />
                <YAxis yAxisId="current" fontSize={9} label={{ value: 'A', angle: -90, position: 'insideLeft', fontSize: 9 }} />
                <Tooltip contentStyle={{ fontSize: 10, background: 'var(--bg-primary)', border: '1px solid var(--border)' }} />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
                <ReferenceLine x={0} yAxisId="current" stroke="red" strokeDasharray="3 3" label="trigger" />
                {zc && <ReferenceLine yAxisId="current" y={zc.mean} stroke="#94a3b8" strokeDasharray="2 4"
                  label={{ value: `${zc.channel} mean`, position: 'insideTopLeft', fontSize: 8, fill: '#94a3b8' }} />}
                <Line yAxisId="current" type="monotone" dataKey="id" name="Id" stroke="#22c55e" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <Line yAxisId="current" type="monotone" dataKey="iq" name="Iq" stroke="#eab308" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <Line yAxisId="current" type="monotone" dataKey="ia" name="Ia" stroke="#a78bfa" strokeWidth={1} dot={false} isAnimationActive={false} />
                <Line yAxisId="current" type="monotone" dataKey="ib" name="Ib" stroke="#c084fc" strokeWidth={1} dot={false} isAnimationActive={false} />
                <Scatter yAxisId="current" dataKey="zcMarker" name="ZC" fill="#f43f5e" isAnimationActive={false}
                  shape="circle" legendType="none" />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* ZC Explainer integrity readout */}
          {zc && (
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8,
              padding: '8px 10px', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)',
              fontSize: 11, fontFamily: 'var(--font-mono)',
            }}>
              <span style={{ fontWeight: 700, color: '#f43f5e' }}>ZC Explainer</span>
              <span style={{ color: 'var(--text-muted)' }}>
                {zc.bemfLike ? `${zc.channel} (BEMF-like phase current)` : `${zc.channel} (trigger ch — no BEMF trace)`}
              </span>
              <span style={{ color: 'var(--text-muted)' }}>|</span>
              <span><b style={{ color: 'var(--text-primary)' }}>{zc.crossings.length}</b> crossings</span>
              {zc.crossings.length >= 2 && (
                <>
                  <span style={{ color: 'var(--text-muted)' }}>|</span>
                  <span>
                    half-period {zc.halfMin.toFixed(0)}–{zc.halfMax.toFixed(0)}µs, symmetry{' '}
                    <b style={{ color: zc.symmetryPct > 25 ? 'var(--accent-orange)' : 'var(--accent-green)' }}>
                      {zc.symmetryPct.toFixed(0)}%
                    </b>
                  </span>
                </>
              )}
              <span style={{ color: 'var(--text-muted)' }}>|</span>
              <span style={{ color: /DC bias|no signal/.test(zc.dcOffsetNote) ? 'var(--accent-orange)' : 'var(--text-muted)' }}>
                DC: {zc.dcOffsetNote}
              </span>
            </div>
          )}

          <div style={{ height: 160, marginBottom: 8 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 30, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="t_us" fontSize={9} />
                <YAxis yAxisId="voltage" fontSize={9} label={{ value: 'V', angle: -90, position: 'insideLeft', fontSize: 9 }} />
                <YAxis yAxisId="mod" orientation="right" fontSize={9} domain={[0, 1]} />
                <Tooltip contentStyle={{ fontSize: 10, background: 'var(--bg-primary)', border: '1px solid var(--border)' }} />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
                <ReferenceLine x={0} yAxisId="voltage" stroke="red" strokeDasharray="3 3" />
                <Line yAxisId="voltage" type="monotone" dataKey="vd" name="Vd" stroke="#f97316" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <Line yAxisId="voltage" type="monotone" dataKey="vq" name="Vq" stroke="#06b6d4" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <Line yAxisId="mod" type="monotone" dataKey="modIndex" name="ModIdx" stroke="#ef4444" strokeWidth={1.5} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div style={{ height: 140 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 30, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="t_us" fontSize={9} label={{ value: 'µs', position: 'insideBottomRight', offset: -5, fontSize: 9 }} />
                <YAxis yAxisId="speed" fontSize={9} label={{ value: 'rad/s', angle: -90, position: 'insideLeft', fontSize: 9 }} />
                <YAxis yAxisId="flux" orientation="right" fontSize={9} />
                <Tooltip contentStyle={{ fontSize: 10, background: 'var(--bg-primary)', border: '1px solid var(--border)' }} />
                <Legend iconSize={8} wrapperStyle={{ fontSize: 10 }} />
                <ReferenceLine x={0} yAxisId="speed" stroke="red" strokeDasharray="3 3" />
                <Line yAxisId="speed" type="monotone" dataKey="omega" name="omega" stroke="#8b5cf6" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <Line yAxisId="flux" type="monotone" dataKey="obsX1" name="FluxA" stroke="#10b981" strokeWidth={1} dot={false} isAnimationActive={false} />
                <Line yAxisId="flux" type="monotone" dataKey="obsX2" name="FluxB" stroke="#f59e0b" strokeWidth={1} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
