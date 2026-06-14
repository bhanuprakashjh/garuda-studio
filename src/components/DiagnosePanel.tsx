import { useState, useCallback } from 'react';
import { useEscStore } from '../store/useEscStore';
import { PARAM_NAMES } from '../protocol/types';
import { localDiagnose } from '../sim/diagnose';
import type { DiagnosisResult, ParamsMap, Severity } from '../sim/diagnose';

/* Diagnosis — Tier-1 LOCAL rule-based diagnosis card (web mirror of the desktop
 * garuda_gui Diagnose tab).  Runs src/sim/diagnose.ts over the live history and
 * renders the overall severity + per-finding rows.  Style matches MonitorPanel /
 * SectorBarsPanel (card + CSS-var conventions). */

const card: React.CSSProperties = {
  background: 'var(--bg-card)', borderRadius: 'var(--radius)', padding: 14, border: '1px solid var(--border)',
};

/* finding severity ('info'|'warn'|'error') → accent colour */
const sevColor = (s: Severity): string =>
  s === 'error' ? 'var(--accent-red)' : s === 'warn' ? 'var(--accent-orange)' : 'var(--accent-green)';

/* overall result severity ('ok'|'warning'|'critical') → colour + label */
const overall: Record<DiagnosisResult['severity'], { color: string; label: string }> = {
  ok: { color: 'var(--accent-green)', label: 'OK' },
  warning: { color: 'var(--accent-orange)', label: 'WARNING' },
  critical: { color: 'var(--accent-red)', label: 'CRITICAL' },
};

/* Convert the store's Map<id,{descriptor,value}> into the ParamsMap the rule
 * engine wants: name-keyed { value, min, max } so the descriptor-range rule
 * and the `current:` fix values both populate.  Unknown ids fall back to hex. */
function buildParamsMap(params: Map<number, { descriptor: { id: number; min: number; max: number }; value: number }>): ParamsMap {
  const out: ParamsMap = {};
  for (const { descriptor, value } of params.values()) {
    const raw = PARAM_NAMES[descriptor.id] ?? `0x${descriptor.id.toString(16)}`;
    // PARAM_NAMES are "Human Label [firmwareName]" — the rules key on the
    // firmware identifier inside the brackets, so prefer that when present.
    const m = raw.match(/\[([^\]]+)\]/);
    const key = m ? m[1] : raw;
    out[key] = { value, min: descriptor.min, max: descriptor.max };
  }
  return out;
}

export function DiagnosePanel() {
  const [result, setResult] = useState<DiagnosisResult | null>(null);
  const [tooShort, setTooShort] = useState(false);

  const run = useCallback(() => {
    const { history, info, params } = useEscStore.getState();
    if (history.length < 5) {
      setTooShort(true);
      setResult(null);
      return;
    }
    setTooShort(false);
    const ctx = { info: info ?? undefined, params: buildParamsMap(params) };
    setResult(localDiagnose(history, ctx));
  }, []);

  const raw = result?.raw;
  // headline stats from summarize() (already inside result.raw, but recompute
  // is cheap and keeps the headline available even before findings exist).
  const stats = raw && !raw.empty ? raw : null;
  const erpmRange = (() => {
    if (!stats?.per_state) return null;
    const peaks = Object.values(stats.per_state).map(s => s.peak_eRPM).filter(v => v > 0);
    if (!peaks.length) return null;
    return { lo: Math.min(...peaks), hi: Math.max(...peaks) };
  })();

  const ov = result ? overall[result.severity] : null;

  return (
    <div style={{ ...card, marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>Diagnosis</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {ov && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 12px', borderRadius: 14,
              fontSize: 12, fontWeight: 700, fontFamily: 'var(--font-mono)', letterSpacing: '0.5px',
              color: ov.color, border: `1px solid ${ov.color}`, background: `${ov.color}1a`,
            }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: ov.color }} />
              {ov.label}
            </span>
          )}
          <button onClick={run} style={{
            padding: '5px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
            border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff',
          }}>🔍 Diagnose</button>
        </div>
      </div>

      {tooShort && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          Not enough telemetry yet — let it run a few seconds, then diagnose.
        </div>
      )}

      {!tooShort && !result && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          Click Diagnose to analyze the captured telemetry history with the local rule engine.
        </div>
      )}

      {result && (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', marginBottom: 10 }}>
            {result.summary}
          </div>

          {/* headline stats from summarize() */}
          {stats && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              <Stat label="Peak Ia" value={`${(stats.peak_Ia_A ?? 0).toFixed(1)} A`} />
              <Stat label="Peak Ibus" value={`${(stats.peak_Ibus_A ?? 0).toFixed(1)} A`} />
              <Stat label="Peak eRPM" value={(stats.peak_eRPM ?? 0).toLocaleString('en-US')} />
              {erpmRange && erpmRange.hi !== erpmRange.lo && (
                <Stat label="eRPM range" value={`${erpmRange.lo.toLocaleString('en-US')}–${erpmRange.hi.toLocaleString('en-US')}`} />
              )}
              <Stat label="HWZC reject" value={`${(stats.hwzc_reject_pct ?? 0).toFixed(0)} %`} />
              <Stat
                label="Faults"
                value={stats.faults && stats.faults.length ? stats.faults.map(f => f.fault).join(', ') : 'none'}
                warn={!!(stats.faults && stats.faults.length)}
              />
            </div>
          )}

          {/* findings */}
          {result.findings.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--accent-green)', fontWeight: 600 }}>
              No issues detected by the rule engine.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {result.findings.map((f, i) => {
                const col = sevColor(f.severity);
                return (
                  <div key={i} style={{
                    display: 'flex', gap: 10, padding: '8px 10px', borderRadius: 6,
                    border: `1px solid ${col}55`, background: `${col}11`,
                  }}>
                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: col, marginTop: 4, flex: '0 0 auto' }} />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                        {f.title}
                        <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 600, color: col, textTransform: 'uppercase' }}>
                          {f.severity} · {f.confidence}
                        </span>
                      </div>
                      {f.cause && f.cause !== f.title && (
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{f.cause}</div>
                      )}
                      {f.fix && (
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>
                          <span style={{ color: 'var(--text-muted)' }}>fix: </span>{f.fix}
                        </div>
                      )}
                      {f.evidence && (
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: 3 }}>
                          {f.evidence}
                        </div>
                      )}
                      {f.fixes.length > 0 && (
                        <div style={{ marginTop: 5, display: 'flex', flexDirection: 'column', gap: 3 }}>
                          {f.fixes.map((fx, j) => (
                            <div key={j} style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                              <span style={{ color: col, fontWeight: 600 }}>{fx.param}</span>
                              {`  ${fx.current} → ${fx.suggested}`}
                              <span style={{ color: 'var(--text-muted)' }}>{`  (${fx.why})`}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div style={{
      padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-secondary)',
      minWidth: 84,
    }}>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
      <div style={{
        fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono)',
        color: warn ? 'var(--accent-red)' : 'var(--text-primary)',
      }}>{value}</div>
    </div>
  );
}

export default DiagnosePanel;
