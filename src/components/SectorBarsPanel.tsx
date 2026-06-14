import { useEffect, useRef, useState } from 'react';
import { useEscStore } from '../store/useEscStore';

/* SectorBarsPanel — per-sector ACCEPTED vs GUESSED commutations, plus a
 * composite stacked bar of the aggregate split.  Faithful port of the desktop
 * garuda_gui SectorAcceptGuessBar.
 *
 * The board only sends per-sector GUESS counters (missBySector[6]) and the
 * aggregate accept/guess totals (hwzcTotalZcCount / hwzcTotalMissCount).  The 6
 * commutation sectors are visited uniformly each electrical rev, so per-sector
 * accepted is recovered as:   accept[i] ≈ (Δacc + Δmiss)/6 − guess[i]
 * Bars read events/second (delta over dt). */

const GREEN = '#66bb6a';
const BLUE = '#42a5f5';

interface Bars {
  accept: number[];   // events/s, per sector (green)
  guess: number[];    // events/s, per sector (blue)
  accPct: number;     // aggregate accepted %
  gssPct: number;     // aggregate guessed %
  peak: number;       // max bar value for normalisation
}

function headerColor(pct: number): string {
  return pct >= 90 ? 'var(--accent-green)' : pct >= 70 ? 'var(--accent-orange)' : 'var(--accent-red)';
}

export function SectorBarsPanel() {
  const snapshot = useEscStore(s => s.snapshot);
  const lastMs = useEscStore(s => s.lastSnapshotMs);
  const telemActive = useEscStore(s => s.telemActive);
  const prev = useRef<{ acc: number; miss: number; sect: number[]; t: number } | null>(null);
  const [bars, setBars] = useState<Bars | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const s = snapshot;
    if (!s || !s.missBySector || s.missBySector.length < 6) return;
    const acc = s.hwzcTotalZcCount ?? 0;
    const miss = s.hwzcTotalMissCount ?? 0;
    const sect = s.missBySector;
    const t = lastMs || Date.now();
    const p = prev.current;
    if (p) {
      const dAcc = Math.max(0, acc - p.acc);
      const dMiss = Math.max(0, miss - p.miss);
      const dt = Math.max(0.001, (t - p.t) / 1000);
      const guess = sect.map((c, i) => Math.max(0, (c - p.sect[i]) & 0xffff));
      const total = dAcc + dMiss;
      const perSector = total / 6;
      const acceptRate = guess.map(g => Math.max(0, perSector - g) / dt);
      const guessRate = guess.map(g => g / dt);
      const peak = Math.max(1, ...acceptRate, ...guessRate);
      let accPct = 0, gssPct = 0;
      if (total > 0) { accPct = (100 * dAcc) / total; gssPct = 100 - accPct; }
      setBars({ accept: acceptRate, guess: guessRate, accPct, gssPct, peak });
    }
    prev.current = { acc, miss, sect: [...sect], t };
  }, [snapshot, lastMs]);

  // dismiss the context menu on any outside click
  useEffect(() => {
    if (!menu) return;
    const h = () => setMenu(null);
    window.addEventListener('click', h);
    return () => window.removeEventListener('click', h);
  }, [menu]);

  const card: React.CSSProperties = {
    background: 'var(--bg-card)', borderRadius: 'var(--radius)', padding: 14,
    border: '1px solid var(--border)', position: 'relative',
  };

  const accPct = bars?.accPct ?? 0;
  const gssPct = bars?.gssPct ?? 0;
  const hdrCol = bars ? headerColor(accPct) : 'var(--text-muted)';
  const stale = !telemActive || !bars;

  // ── geometry ──
  const W = 360, H = 132, padL = 28, padB = 18, padT = 8;
  const plotH = H - padB - padT, plotW = W - padL - 8;
  const slot = plotW / 6;
  const barW = slot * 0.34;

  const copyPct = () => {
    navigator.clipboard?.writeText(`accepted ${accPct.toFixed(0)}% / guessed ${gssPct.toFixed(0)}%`);
    setMenu(null);
  };
  const reset = () => { prev.current = null; setBars(null); setMenu(null); };

  return (
    <div
      style={card}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>
          Per-sector accepted vs guessed
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'var(--font-mono)', color: hdrCol }}>
          {bars ? `🟩 ${accPct.toFixed(0)}%  🟦 ${gssPct.toFixed(0)}%` : '—'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', opacity: stale ? 0.45 : 1 }}>
        {/* per-sector grouped bars */}
        <svg width={W} height={H} style={{ flexShrink: 0 }}>
          {/* y grid */}
          {[0, 0.5, 1].map(f => {
            const y = padT + plotH * (1 - f);
            return <line key={f} x1={padL} y1={y} x2={W - 8} y2={y} stroke="var(--border-light)" strokeWidth={1} />;
          })}
          {Array.from({ length: 6 }, (_, i) => {
            const cx = padL + slot * i + slot / 2;
            const aH = bars ? (bars.accept[i] / bars.peak) * plotH : 0;
            const gH = bars ? (bars.guess[i] / bars.peak) * plotH : 0;
            return (
              <g key={i}>
                <rect x={cx - barW - 1} y={padT + plotH - aH} width={barW} height={aH} fill={GREEN} rx={1} />
                <rect x={cx + 1} y={padT + plotH - gH} width={barW} height={gH} fill={BLUE} rx={1} />
                <text x={cx} y={H - 5} fill="var(--text-muted)" fontSize={10} textAnchor="middle" fontFamily="var(--font-mono)">S{i}</text>
              </g>
            );
          })}
          <text x={4} y={padT + 8} fill="var(--text-muted)" fontSize={9}>ev/s</text>
        </svg>

        {/* composite stacked bar: accepted% over guessed% */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 46, height: 104, borderRadius: 4, overflow: 'hidden', display: 'flex', flexDirection: 'column', border: '1px solid var(--border)' }}>
            <div style={{ height: `${gssPct}%`, background: BLUE, transition: 'height 0.2s' }} />
            <div style={{ height: `${accPct}%`, background: GREEN, transition: 'height 0.2s' }} />
          </div>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>ALL</span>
        </div>
      </div>

      {menu && (
        <div className="glass" style={{
          position: 'fixed', left: menu.x, top: menu.y, zIndex: 2000, padding: 4,
          borderRadius: 6, minWidth: 150, fontSize: 12,
        }}>
          {[
            { label: 'Copy accepted/guessed %', fn: copyPct },
            { label: 'Reset accumulator', fn: reset },
          ].map(it => (
            <div key={it.label} onClick={it.fn} style={{
              padding: '6px 10px', borderRadius: 4, cursor: 'pointer', color: 'var(--text-secondary)',
            }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >{it.label}</div>
          ))}
        </div>
      )}
    </div>
  );
}
