import { useMemo, useRef, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts';
import { MOTORS, captureModel, simulate, defaultDuty, type MotorSpec } from '../sim/zcsim';
import { MLP, extractExamples, evaluate, type ZcWindow, type EvalResult } from '../sim/zcml';
import { RotorSvg } from './RotorSvg';

/* ZcLabPanel — live model of sensorless ZC detection (port of the desktop
 * garuda_gui "ZC Lab" tab).  Motor picker + speed slider drive: the capture-%
 * vs eRPM curves, the animated rotor wheel, the floating-phase waveform through
 * a zero-crossing, and an in-browser ML collect/train pipeline (zcml MLP).
 *
 * NOTE: the desktop SPICE "deep-dive" engine needs a Python subprocess and is
 * not available in the browser — only the lumped (analytic) engine is ported. */

const card: React.CSSProperties = {
  background: 'var(--bg-card)', borderRadius: 'var(--radius)', padding: 14, border: '1px solid var(--border)',
};
const hdr: React.CSSProperties = {
  fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8,
};

export function ZcLabPanel() {
  const motorKeys = Object.keys(MOTORS);
  const [motorKey, setMotorKey] = useState(motorKeys.find(k => k.startsWith('2810')) ?? motorKeys[0]);
  const motor: MotorSpec = MOTORS[motorKey];
  const [erpm, setErpm] = useState(Math.round(motor.erpmMax * 0.3));
  const [sectorMode, setSectorMode] = useState<'rising' | 'falling'>('falling');

  // ── capture-% vs eRPM sweep curve ──
  const curve = useMemo(() => {
    const pts: { erpm: number; measured: number; falling: number }[] = [];
    for (let e = 1500; e <= motor.erpmMax; e += Math.max(500, Math.round(motor.erpmMax / 80))) {
      const c = captureModel(e, motor);
      pts.push({ erpm: e, measured: +(c.measured * 100).toFixed(1), falling: +(c.falling * 100).toFixed(1) });
    }
    return pts;
  }, [motor]);

  // ── floating-phase waveform through a ZC at the current speed ──
  const wave = useMemo(() => {
    const sectorIdx = sectorMode === 'falling' ? 1 : 0;
    const sim = simulate(Math.max(1500, erpm), defaultDuty(erpm), sectorIdx, { vbus: motor.vbus });
    const data = sim.tUs.map((t, i) => ({
      t: +t.toFixed(1), vNode: +sim.vNode[i].toFixed(1), vSense: +sim.vSense[i].toFixed(1), thr: sim.thrAdc,
    }));
    return { data, thr: sim.thrAdc, comp: sim.compFiredUs, offc: sim.offcFiredUs };
  }, [erpm, sectorMode, motor]);

  const cap = captureModel(Math.max(1500, erpm), motor);

  // ── ML pipeline (in-browser) ──
  const windows = useRef<ZcWindow[]>([]);
  const modelRef = useRef<MLP | null>(null);
  const [mlMsg, setMlMsg] = useState('dataset: empty');
  const [evalRes, setEvalRes] = useState<EvalResult | null>(null);
  const [busy, setBusy] = useState(false);

  // Collect: synthesise burst windows from the lumped model across the speed
  // band (the desktop records REAL burst-scope captures; with no Python backend
  // the analytic engine is the in-browser data source).
  const collect = () => {
    const added: ZcWindow[] = [];
    for (let n = 0; n < 60; n++) {
      const e = 4000 + Math.random() * (motor.erpmMax - 4000);
      const sectorIdx = Math.random() < 0.5 ? 0 : 1;            // rising / falling
      const sim = simulate(e, defaultDuty(e), sectorIdx, { vbus: motor.vbus, spikeAmp: 0.15 + Math.random() * 0.2 });
      added.push({
        bemf: sim.vNode, zcthr: sim.vNode.map(() => sim.thrAdc),
        sector: sim.vNode.map(() => (sectorIdx === 0 ? 0 : 1)), erpm: e, duty: defaultDuty(e),
      });
    }
    windows.current.push(...added);
    setMlMsg(`dataset: ${windows.current.length} windows  (motor: ${motorKey})`);
    setEvalRes(null);
  };

  const train = async () => {
    if (windows.current.length < 10) { setMlMsg('need ≥10 windows — press Collect first'); return; }
    setBusy(true); setMlMsg('extracting examples…');
    await new Promise(r => setTimeout(r, 10));
    const ex = extractExamples(windows.current);
    if (ex.length < 8) { setMlMsg(`only ${ex.length} usable examples — collect more`); setBusy(false); return; }
    // train/test split
    const shuf = ex.slice().sort(() => Math.random() - 0.5);
    const cut = Math.floor(shuf.length * 0.75);
    const tr = shuf.slice(0, cut), te = shuf.slice(cut);
    setMlMsg(`training on ${tr.length} examples…`);
    await new Promise(r => setTimeout(r, 10));
    const model = new MLP(ex[0].features.length, 24, 1);
    model.train(tr, { epochs: 800, lr: 0.08 });
    modelRef.current = model;
    const res = evaluate(model, te);
    setEvalRes(res);
    const overall = res.errDeg.length ? res.errDeg.reduce((a, b) => a + b, 0) / res.errDeg.length : 0;
    setMlMsg(`trained · test MAE ${overall.toFixed(2)}° over ${te.length} examples`);
    setBusy(false);
  };

  const resetMl = () => { windows.current = []; modelRef.current = null; setEvalRes(null); setMlMsg('dataset: empty'); };

  const btn = (active = false): React.CSSProperties => ({
    padding: '6px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
    border: `1px solid ${active ? 'var(--accent-cyan)' : 'var(--border)'}`,
    background: active ? 'var(--accent-blue-dim)' : 'transparent',
    color: active ? 'var(--accent-cyan)' : 'var(--text-secondary)',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* control bar */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span style={hdr}>ZC Lab</span>
        <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>Motor</label>
        <select value={motorKey} onChange={e => { setMotorKey(e.target.value); setErpm(Math.round(MOTORS[e.target.value].erpmMax * 0.3)); }}
          style={{ padding: '5px 8px', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12 }}>
          {motorKeys.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          KV {motor.kv} · {motor.polesPp}pp · {motor.vbus}V · max {motor.erpmMax.toLocaleString()} eRPM
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={() => setSectorMode('rising')} style={btn(sectorMode === 'rising')}>rising</button>
        <button onClick={() => setSectorMode('falling')} style={btn(sectorMode === 'falling')}>falling</button>
      </div>

      {/* speed slider */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Speed</span>
        <input type="range" min={0} max={motor.erpmMax} value={erpm} onChange={e => setErpm(+e.target.value)} style={{ flex: 1 }} />
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, minWidth: 170, textAlign: 'right' }}>
          {erpm.toLocaleString()} eRPM <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(duty {Math.round(defaultDuty(erpm) * 100)}%)</span>
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* capture-% curve */}
          <div style={card}>
            <div style={hdr}>ZC capture % vs eRPM</div>
            <ResponsiveContainer width="100%" height={210}>
              <LineChart data={curve} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                <XAxis dataKey="erpm" tick={{ fill: 'var(--text-muted)', fontSize: 9 }} tickFormatter={v => `${Math.round(v / 1000)}k`} />
                <YAxis domain={[0, 100]} tick={{ fill: 'var(--text-muted)', fontSize: 9 }} width={32} />
                <Tooltip contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 10 }} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <ReferenceLine x={erpm} stroke="var(--accent-cyan)" strokeDasharray="4 3" />
                <Line type="monotone" dataKey="measured" name="measured %" stroke="#42a5f5" strokeWidth={1.6} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="falling" name="falling %" stroke="#ffa726" strokeWidth={1.6} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* floating-phase waveform */}
          <div style={card}>
            <div style={hdr}>Floating-phase BEMF through ZC — {sectorMode} sector (lumped)</div>
            <ResponsiveContainer width="100%" height={210}>
              <LineChart data={wave.data} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border-light)" />
                <XAxis dataKey="t" tick={{ fill: 'var(--text-muted)', fontSize: 9 }} tickFormatter={v => `${v}µs`} />
                <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 9 }} width={42} />
                <Tooltip contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 10 }} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Line type="monotone" dataKey="vNode" name="v_node (raw)" stroke="#42a5f5" strokeWidth={1.4} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="vSense" name="v_sense (RC)" stroke="#66bb6a" strokeWidth={1.4} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="thr" name="threshold" stroke="#bdbdbd" strokeWidth={1} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 4 }}>
              comparator {wave.comp != null ? `DETECT @ ${wave.comp.toFixed(1)}µs` : 'MISS'} · OFF-center {wave.offc != null ? `DETECT @ ${wave.offc.toFixed(1)}µs` : 'MISS'}
            </div>
          </div>
        </div>

        {/* rotor wheel */}
        <div style={{ ...card, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ ...hdr, alignSelf: 'flex-start' }}>Commutation wheel</div>
          <RotorSvg perSector={cap.perSector} erpm={Math.max(0, erpm)} erpmMax={motor.erpmMax} />
        </div>
      </div>

      {/* ML pipeline */}
      <div style={card}>
        <div style={hdr}>ML zero-cross estimator (in-browser MLP)</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={collect} disabled={busy} style={btn()}>⏺ Collect (sim windows)</button>
          <button onClick={train} disabled={busy} style={btn()}>🧠 Train / Eval</button>
          <button onClick={resetMl} disabled={busy} style={btn()}>Reset</button>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{mlMsg}</span>
        </div>

        {evalRes && (
          <div style={{ marginTop: 12, overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)' }}>
                  <th style={{ textAlign: 'left', padding: '3px 10px' }}>eRPM band</th>
                  <th style={{ padding: '3px 10px' }}>n</th>
                  <th style={{ padding: '3px 10px' }}>rising MAE° (vs floor)</th>
                  <th style={{ padding: '3px 10px' }}>falling MAE° (vs floor)</th>
                </tr>
              </thead>
              <tbody>
                {evalRes.bands.map(b => {
                  const fmt = (c: { mae: number; floor: number; win: number } | null) =>
                    c ? `${c.mae.toFixed(2)} (${c.floor.toFixed(2)}, ${c.win >= 0 ? '+' : ''}${c.win.toFixed(2)})` : '—';
                  return (
                    <tr key={b.label} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '3px 10px', color: 'var(--text-secondary)' }}>{b.label}</td>
                      <td style={{ padding: '3px 10px', textAlign: 'center', color: 'var(--text-muted)' }}>{b.n}</td>
                      <td style={{ padding: '3px 10px', textAlign: 'center', color: b.rise && b.rise.win > 0 ? 'var(--accent-green)' : 'var(--text-secondary)' }}>{fmt(b.rise)}</td>
                      <td style={{ padding: '3px 10px', textAlign: 'center', color: b.fall && b.fall.win > 0 ? 'var(--accent-green)' : 'var(--text-secondary)' }}>{fmt(b.fall)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
              MAE = model error · floor = best-constant (mid-sector) baseline · win = floor − MAE (green = model beats baseline)
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
