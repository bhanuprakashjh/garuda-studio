import { useState, useCallback } from 'react';
import { useEscStore } from '../store/useEscStore';
import { serial } from './ConnectionBar';
import { buildPacket, CMD } from '../protocol/gsp';
import { PARAM_NAMES, PARAM_UNITS, PARAM_TOOLTIPS, PARAM_GROUPS, isFocEnabled } from '../protocol/types';

const GROUP_ICONS: Record<number, string> = {
  0: '\uD83D\uDE80', // Startup & Ramp
  1: '\uD83D\uDD04', // Closed-Loop
  2: '\u26A1',       // Current Protection
  3: '\uD83C\uDFAF', // ZC Detection
  4: '\u2197',       // Duty Slew
  5: '\uD83D\uDD0B', // Voltage Protection
  6: '\u21BB',       // Recovery
  7: '\u2699',       // Motor Hardware
  8: '\uD83D\uDCA0', // FOC Motor Model
  9: '\uD83D\uDD27', // FOC Tuning
  10: '\u23F1',      // FOC Startup
};

const GROUP_COLORS: Record<number, string> = {
  0: '#f97316',
  1: '#3b82f6',
  2: '#ef4444',
  3: '#a78bfa',
  4: '#22d3ee',
  5: '#22c55e',
  6: '#eab308',
  7: '#94a3b8',
  8: '#06b6d4',  // FOC Motor Model - teal
  9: '#8b5cf6',  // FOC Tuning - violet
  10: '#f472b6', // FOC Startup - pink
};

/** Startup amplitude/duty params whose value implies a peak current (match by
 * variable name — mirrors the Python AMPLITUDE_PARAMS / DUTY_PARAMS sets). */
const AMPLITUDE_PARAMS = new Set(['sineAlignModPct', 'sineRampModPct']); // peak = pct/200
const DUTY_PARAMS = new Set(['rampDutyPct', 'alignDutyPct', 'clIdleDutyPct']); // = pct/100

/** Find a param value by its variable name (from "Display [variable]"). */
function paramValueByVar(
  params: Map<number, { descriptor: { id: number; min: number; max: number; group: number }; value: number }>,
  wanted: string,
): number | null {
  for (const [id, pv] of params) {
    const m = PARAM_NAMES[id]?.match(/\[([^\]]+)\]/);
    if (m && m[1] === wanted) return pv.value;
  }
  return null;
}

/** Estimated peak current (A) a startup amplitude/duty value implies, else null.
 * peak ≈ frac × Vbus / R_pp ; R_pp ≈ 2 × focRsMilliOhm/1000. Mirrors Python _est_current. */
function estCurrent(
  varName: string,
  val: number,
  params: Map<number, { descriptor: { id: number; min: number; max: number; group: number }; value: number }>,
  vbus: number | null,
): number | null {
  if (!Number.isFinite(val)) return null;
  const rs = paramValueByVar(params, 'focRsMilliOhm');
  if (!rs) return null;
  const rpp = (2.0 * rs) / 1000.0;
  if (rpp <= 0) return null;
  const vb = vbus && vbus > 0 ? vbus : 24.0;
  let frac: number;
  if (AMPLITUDE_PARAMS.has(varName)) frac = val / 200.0;
  else if (DUTY_PARAMS.has(varName)) frac = val / 100.0;
  else return null;
  return (frac * vb) / rpp;
}

/** Groups that apply to both FOC and 6-step */
const COMMON_GROUPS = new Set([2, 5, 7]); // Current Protection, Voltage Protection, Motor Hardware
/** Groups that only apply to 6-step */
const SIXSTEP_ONLY_GROUPS = new Set([0, 1, 3, 4, 6]); // Startup, Closed-Loop, ZC, Duty Slew, Recovery
/** Groups that only apply to FOC */
const FOC_ONLY_GROUPS = new Set([8, 9, 10]); // FOC Motor Model, FOC Tuning, FOC Startup

export function ParamPanel() {
  const { connected, snapshot, params, info } = useEscStore();
  const [editValues, setEditValues] = useState<Record<number, string>>({});
  const [hoveredParam, setHoveredParam] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const isIdle = !snapshot || snapshot.state === 0;
  const editable = connected && isIdle;
  const focMode = info ? isFocEnabled(info.featureFlags) : false;

  // Live Vbus (V) from the snapshot + OC soft limit (A) for the est-current annotation.
  const vbusV = snapshot ? (snapshot.vbusRaw * 3.3 / 4096) * 19.8 : null;
  const ocSwMa = paramValueByVar(params, 'ocSwLimitMa');
  const ocLimitA = ocSwMa ? ocSwMa / 1000.0 : null;

  // Filter predicate — treat input as a regex (case-insensitive), fall back to
  // substring if the regex is invalid. Matches display name OR variable name.
  const filterMatch = (() => {
    const q = filter.trim();
    if (!q) return (_display: string, _varName: string) => true;
    let re: RegExp | null = null;
    try { re = new RegExp(q, 'i'); } catch { re = null; }
    const lq = q.toLowerCase();
    return (display: string, varName: string) => {
      if (re) return re.test(display) || re.test(varName);
      return display.toLowerCase().includes(lq) || varName.toLowerCase().includes(lq);
    };
  })();

  const setParam = useCallback(async (id: number, value: number) => {
    const buf = new Uint8Array(6);
    const v = new DataView(buf.buffer);
    v.setUint16(0, id, true);
    v.setUint32(2, value, true);
    await serial.write(buildPacket(CMD.SET_PARAM, buf));
  }, []);

  const saveConfig = useCallback(async () => {
    await serial.write(buildPacket(CMD.SAVE_CONFIG));
  }, []);

  const loadDefaults = useCallback(async () => {
    await serial.write(buildPacket(CMD.LOAD_DEFAULTS));
  }, []);

  const groups = new Map<number, Array<[number, { descriptor: { id: number; min: number; max: number; group: number }; value: number }]>>();
  for (const [id, pv] of params) {
    const g = pv.descriptor.group;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push([id, pv]);
  }
  const sortedGroups = [...groups.entries()].sort((a, b) => a[0] - b[0]);

  const parseName = (id: number) => {
    const full = PARAM_NAMES[id] ?? `0x${id.toString(16)}`;
    const match = full.match(/^(.+?)\s*\[(.+)\]$/);
    if (match) return { display: match[1], varName: match[2] };
    return { display: full, varName: '' };
  };

  if (params.size === 0) {
    return (
      <div style={{
        background: 'var(--bg-card)', borderRadius: 'var(--radius)',
        padding: 24, marginTop: 16, border: '1px solid var(--border)',
        textAlign: 'center', color: 'var(--text-muted)', fontSize: 13,
      }}>
        Connect to ESC to view and edit parameters
      </div>
    );
  }

  return (
    <div style={{ marginTop: 16 }}>
      {/* Mode indicator */}
      <div style={{
        background: focMode ? 'rgba(34,211,238,0.08)' : 'rgba(249,115,22,0.08)',
        border: `1px solid ${focMode ? 'rgba(34,211,238,0.2)' : 'rgba(249,115,22,0.2)'}`,
        borderRadius: 'var(--radius)', padding: '8px 14px', marginBottom: 12,
        color: focMode ? 'var(--accent-cyan)' : 'var(--accent-orange)', fontSize: 11,
      }}>
        {focMode
          ? 'FOC mode active. FOC motor model and startup params can be tuned per-profile. 6-Step groups are dimmed.'
          : '6-Step mode active. FOC parameters are dimmed.'}
      </div>
      {/* Header bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 12,
      }}>
        <div>
          <span style={{
            fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase',
            letterSpacing: '1px',
          }}>
            Parameters
          </span>
          <span style={{
            fontSize: 11, color: 'var(--text-muted)', marginLeft: 8,
            fontFamily: 'var(--font-mono)',
          }}>
            ({params.size} total)
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={loadDefaults} disabled={!editable}
            style={{
              padding: '6px 14px', borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              background: editable ? 'transparent' : 'var(--bg-input)',
              color: editable ? 'var(--accent-yellow)' : 'var(--text-muted)',
              fontWeight: 600, fontSize: 12,
            }}>
            Restore Defaults
          </button>
          <button onClick={saveConfig} disabled={!editable}
            style={{
              padding: '6px 14px', borderRadius: 'var(--radius-sm)', border: 'none',
              background: editable ? 'var(--accent-green)' : 'var(--bg-input)',
              color: editable ? '#000' : 'var(--text-muted)',
              fontWeight: 600, fontSize: 12,
            }}>
            Save to EEPROM
          </button>
        </div>
      </div>

      {/* Filter box — mirrors the desktop Tune-tab filter (regex or substring,
          matches display name or variable name, case-insensitive) */}
      <div style={{ marginBottom: 12, position: 'relative' }}>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter parameters by name or variable (regex)…"
          style={{
            width: '100%', boxSizing: 'border-box', padding: '7px 30px 7px 12px',
            borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)',
            background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 12,
            fontFamily: 'var(--font-mono)',
          }}
        />
        {filter && (
          <button
            onClick={() => setFilter('')}
            style={{
              position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
              width: 20, height: 20, borderRadius: 'var(--radius-sm)', border: 'none',
              background: 'transparent', color: 'var(--text-muted)', fontSize: 14,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            title="Clear filter"
          >
            {'×'}
          </button>
        )}
      </div>

      {!isIdle && connected && (
        <div style={{
          color: 'var(--accent-yellow)', marginBottom: 10, fontSize: 12,
          padding: '6px 12px', background: 'rgba(234,179,8,0.08)',
          border: '1px solid rgba(234,179,8,0.2)',
          borderRadius: 'var(--radius-sm)',
        }}>
          Parameters are read-only while motor is running
        </div>
      )}

      {/* Parameter grid — Common groups first, then 6-step only */}
      {(() => {
        const commonGroups = sortedGroups.filter(([g]) => COMMON_GROUPS.has(g));
        const sixStepGroups = sortedGroups.filter(([g]) => SIXSTEP_ONLY_GROUPS.has(g));
        const focGroups = sortedGroups.filter(([g]) => FOC_ONLY_GROUPS.has(g));
        const sections = [
          ...(focMode ? [{ label: 'FOC Parameters', desc: 'Motor model, tuning, and startup for FOC mode', groups: focGroups, dimmed: false }] : []),
          { label: 'Common Parameters', desc: 'Apply to both FOC and 6-Step modes', groups: commonGroups, dimmed: false },
          { label: '6-Step Parameters', desc: focMode ? 'Inactive in FOC mode' : 'Active in 6-Step mode', groups: sixStepGroups, dimmed: focMode },
          ...(!focMode ? [{ label: 'FOC Parameters', desc: 'Inactive in 6-Step mode', groups: focGroups, dimmed: true }] : []),
        ];
        const sectionMatchCount = (sec: { groups: typeof sortedGroups }) =>
          sec.groups.reduce((acc, [, items]) =>
            acc + items.filter(([id]) => {
              const { display, varName } = parseName(id);
              return filterMatch(display, varName);
            }).length, 0);
        return sections.map(section => sectionMatchCount(section) > 0 && (
          <div key={section.label} style={{ marginBottom: 16 }}>
            <div style={{
              display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8,
            }}>
              <span style={{
                fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '1px', color: section.dimmed ? 'var(--text-muted)' : 'var(--text-secondary)',
              }}>
                {section.label}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                {section.desc}
              </span>
            </div>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12,
              opacity: section.dimmed ? 0.5 : 1, transition: 'opacity 0.3s',
            }}>
        {section.groups.map(([group, allItems]) => {
          const groupColor = GROUP_COLORS[group] ?? 'var(--accent-blue)';
          const items = allItems.filter(([id]) => {
            const { display, varName } = parseName(id);
            return filterMatch(display, varName);
          });
          if (items.length === 0) return null;
          return (
            <div key={group} style={{
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', overflow: 'hidden',
            }}>
              {/* Group header */}
              <div style={{
                padding: '10px 14px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--bg-secondary)',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span style={{ fontSize: 14 }}>{GROUP_ICONS[group] ?? '\u2022'}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: groupColor }}>
                  {PARAM_GROUPS[group] ?? `Group ${group}`}
                </span>
                {section.dimmed && (
                  <span style={{ fontSize: 9, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                    6-Step Only
                  </span>
                )}
                <span style={{
                  fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {items.length}
                </span>
              </div>

              {/* Params */}
              <div style={{ padding: '8px 14px 14px' }}>
                {items.map(([id, pv]) => {
                  const editVal = editValues[id];
                  const displayVal = editVal !== undefined ? editVal : String(pv.value);
                  const { display, varName } = parseName(id);
                  const unit = PARAM_UNITS[id] ?? '';
                  const tooltip = PARAM_TOOLTIPS[id];
                  const isHovered = hoveredParam === id;

                  // Estimated peak current for startup amplitude/duty params.
                  const isCurrentParam = AMPLITUDE_PARAMS.has(varName) || DUTY_PARAMS.has(varName);
                  const estA = isCurrentParam
                    ? estCurrent(varName, Number(displayVal), params, vbusV)
                    : null;
                  const overOc = estA !== null && ocLimitA !== null && estA > ocLimitA;

                  return (
                    <div key={id} style={{
                      padding: '8px 0', position: 'relative',
                      borderBottom: '1px solid var(--border-light)',
                    }}
                      onMouseEnter={() => setHoveredParam(id)}
                      onMouseLeave={() => setHoveredParam(null)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            fontSize: 12, color: 'var(--text-primary)',
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          }}>
                            {display}
                          </div>
                          {varName && (
                            <div style={{
                              fontSize: 10, color: 'var(--text-muted)',
                              fontFamily: 'var(--font-mono)',
                            }}>
                              {varName}
                            </div>
                          )}
                        </div>
                        <input type="number" value={displayVal}
                          min={pv.descriptor.min} max={pv.descriptor.max}
                          disabled={!editable}
                          style={{
                            width: 72, textAlign: 'right', padding: '3px 6px',
                            borderRadius: 'var(--radius-sm)',
                            border: `1px solid ${isHovered ? 'var(--accent-blue)' : 'var(--border)'}`,
                            background: editable ? 'var(--bg-input)' : 'var(--bg-secondary)',
                            color: 'var(--text-primary)', fontSize: 12,
                            fontFamily: 'var(--font-mono)',
                            transition: 'border-color 0.15s',
                          }}
                          onChange={(e) => setEditValues(prev => ({ ...prev, [id]: e.target.value }))}
                          onBlur={async () => {
                            const v = Number(displayVal);
                            if (!isNaN(v) && v >= pv.descriptor.min && v <= pv.descriptor.max) {
                              await setParam(id, v);
                            }
                            setEditValues(prev => { const n = { ...prev }; delete n[id]; return n; });
                          }}
                          onKeyDown={async (e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          }}
                        />
                        <span style={{
                          fontSize: 10, color: 'var(--text-muted)',
                          width: 36, textAlign: 'left',
                          fontFamily: 'var(--font-mono)',
                        }}>
                          {unit}
                        </span>
                      </div>
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        fontSize: 10, color: 'var(--text-muted)',
                        marginTop: 2, fontFamily: 'var(--font-mono)',
                      }}>
                        <span>{pv.descriptor.min} \u2013 {pv.descriptor.max}</span>
                        {estA !== null && (
                          <span style={{
                            marginLeft: 'auto',
                            color: overOc ? 'var(--accent-red)' : 'var(--accent-cyan)',
                            fontWeight: overOc ? 700 : 400,
                          }}>
                            {'\u2248'} {estA.toFixed(1)} A
                          </span>
                        )}
                      </div>
                      {overOc && estA !== null && ocLimitA !== null && (
                        <div style={{
                          marginTop: 4, padding: '3px 7px', borderRadius: 'var(--radius-sm)',
                          background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)',
                          color: 'var(--accent-red)', fontSize: 10, lineHeight: 1.4,
                        }}>
                          {'\u26a0'} {'\u2248'}{estA.toFixed(0)}A peak {'>'} OC soft limit {ocLimitA.toFixed(0)}A {'\u2014'} likely to trip OC_SW
                        </div>
                      )}

                      {/* Tooltip */}
                      {isHovered && tooltip && (
                        <div style={{
                          position: 'absolute', bottom: '100%', left: 0, right: 0,
                          marginBottom: 4, zIndex: 20,
                          background: 'var(--bg-secondary)',
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--radius-sm)',
                          padding: '8px 10px', fontSize: 11,
                          color: 'var(--text-secondary)', lineHeight: 1.5,
                          boxShadow: 'var(--shadow-lg)',
                          animation: 'fadeIn 0.15s ease',
                        }}>
                          {tooltip}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
            </div>
          </div>
        ));
      })()}
    </div>
  );
}
