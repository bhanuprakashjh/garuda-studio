import { useMemo, useState } from 'react';
import { computeProfile, renderProfileC, report, type MotorSpec } from '../sim/wizard';
import { useEscStore } from '../store/useEscStore';

type FieldKey = 'name' | 'kv' | 'rPpOhm' | 'poles' | 'weightG' | 'maxCurrentA' | 'vbusNom' | 'inductanceUh' | 'profileId' | 'enumName';

const FIELDS: { key: FieldKey; label: string; unit?: string; num: boolean; step?: number }[] = [
  { key: 'name', label: 'Motor name', num: false },
  { key: 'kv', label: 'KV', unit: 'RPM/V', num: true, step: 1 },
  { key: 'rPpOhm', label: 'Resistance (ph-ph)', unit: 'Ω', num: true, step: 0.001 },
  { key: 'poles', label: 'Magnet poles', num: true, step: 1 },
  { key: 'weightG', label: 'Weight', unit: 'g', num: true, step: 1 },
  { key: 'maxCurrentA', label: 'Max continuous', unit: 'A', num: true, step: 1 },
  { key: 'vbusNom', label: 'Bus voltage', unit: 'V', num: true, step: 1 },
  { key: 'inductanceUh', label: 'Inductance (0=auto)', unit: 'µH', num: true, step: 1 },
  { key: 'profileId', label: 'Profile slot', num: true, step: 1 },
  { key: 'enumName', label: 'Enum suffix', num: false },
];

export function WizardPanel() {
  const addToast = useEscStore(s => s.addToast);
  const snapshot = useEscStore(s => s.snapshot);
  const liveVbus = snapshot ? Math.round(snapshot.vbusRaw * 3.3 / 4096 * 19.8) : 24;
  const [f, setF] = useState<Record<FieldKey, string>>({
    name: 'MyMotor', kv: '1000', rPpOhm: '0.050', poles: '14', weightG: '100',
    maxCurrentA: '20', vbusNom: String(liveVbus), inductanceUh: '0', profileId: '6', enumName: 'CUSTOM',
  });

  const { code, rep, warnings, err } = useMemo(() => {
    try {
      const spec: MotorSpec = {
        name: f.name || 'Motor', kv: +f.kv, rPpOhm: +f.rPpOhm, poles: +f.poles | 0,
        weightG: +f.weightG, maxCurrentA: +f.maxCurrentA, vbusNom: +f.vbusNom,
        inductanceUh: +f.inductanceUh > 0 ? +f.inductanceUh : null,
        profileId: +f.profileId | 0, enumName: (f.enumName || 'CUSTOM').toUpperCase().replace(/[^A-Z0-9_]/g, ''),
      };
      if (!(spec.kv > 0 && spec.rPpOhm > 0 && spec.poles >= 2 && spec.maxCurrentA > 0 && spec.vbusNom > 0))
        return { code: '', rep: '', warnings: [], err: 'Enter valid positive KV, resistance, poles, current, voltage.' };
      const p = computeProfile(spec);
      return { code: renderProfileC(p), rep: report(p), warnings: p.warnings, err: '' };
    } catch (e: any) {
      return { code: '', rep: '', warnings: [], err: String(e?.message || e) };
    }
  }, [f]);

  const set = (k: FieldKey, v: string) => setF(prev => ({ ...prev, [k]: v }));

  const copy = () => { navigator.clipboard?.writeText(code).then(() => addToast('Profile copied', 'success')); };
  const download = () => {
    const blob = new Blob([code], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `garuda_profile_${(f.name || 'motor').replace(/\s+/g, '_')}.c`;
    a.click(); URL.revokeObjectURL(a.href);
    addToast('Profile .c downloaded', 'success');
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 14 }}>
      {/* Inputs */}
      <div className="glass" style={{ padding: 16, alignSelf: 'start' }}>
        <h3 style={{ fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 4 }}>Motor Wizard</h3>
        <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 14 }}>
          Datasheet numbers → a current-safe Garuda profile. Heuristics calibrated to the proven 2810.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {FIELDS.map(fl => (
            <label key={fl.key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span className="hud-label">{fl.label}{fl.unit ? ` · ${fl.unit}` : ''}</span>
              <input type={fl.num ? 'number' : 'text'} step={fl.step} value={f[fl.key]}
                onChange={e => set(fl.key, e.target.value)}
                style={{ fontSize: 13, fontFamily: fl.num ? 'var(--font-mono)' : 'inherit' }} />
            </label>
          ))}
        </div>
      </div>

      {/* Output */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
        <div className="glass" style={{ padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span className="hud-label">Summary</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={copy} disabled={!code} className="glass glass-hover" style={{ padding: '5px 12px', fontSize: 12, color: 'var(--accent-cyan)' }}>Copy</button>
              <button onClick={download} disabled={!code} className="glass glass-hover" style={{ padding: '5px 12px', fontSize: 12, color: 'var(--accent-cyan)' }}>Download .c</button>
            </div>
          </div>
          {err
            ? <div style={{ color: 'var(--accent-red)', fontSize: 12 }}>{err}</div>
            : <pre className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', margin: 0 }}>{rep}</pre>}
          {warnings.length > 0 && (
            <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: 'var(--accent-yellow)' + '18', border: '1px solid ' + 'var(--accent-yellow)' }}>
              {warnings.map((w, i) => (
                <div key={i} style={{ fontSize: 11, color: 'var(--accent-yellow)' }}>⚠ {w}</div>
              ))}
            </div>
          )}
        </div>

        <div className="glass" style={{ padding: 14, flex: 1, minHeight: 0 }}>
          <div className="hud-label" style={{ marginBottom: 8 }}>gsp_params.c profile block</div>
          <pre className="mono" style={{
            fontSize: 11, color: 'var(--accent-green)', whiteSpace: 'pre', overflow: 'auto',
            margin: 0, maxHeight: 460, background: 'rgba(0,0,0,0.3)', padding: 12, borderRadius: 8,
          }}>{code || '—'}</pre>
        </div>
      </div>
    </div>
  );
}
