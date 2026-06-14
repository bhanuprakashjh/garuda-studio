import { useEffect, useRef, useState } from 'react';

/* RotorSvg — animated rotor + 6-sector commutation wheel (port of the desktop
 * garuda_gui RotorWidget).  Sectors are colored by per-sector ZC capture
 * probability (green = detected, red = guessed); the rotor bar spins at a scaled
 * visual rate and a pointer marks the live electrical angle.
 *
 * Owns its own animation loop so the parent's charts don't re-render at 30 Hz. */

const PHASE_NAME = ['A', 'B', 'C'];
// firmware commutationTable: (floating phase, zc polarity) per 60deg sector
const SECTORS: Array<[number, number]> = [[2, 1], [0, -1], [1, 1], [2, -1], [0, 1], [1, -1]];

function lerpColor(frac: number): string {
  // red (guessed, 0) -> amber -> green (captured, 1)
  const f = Math.max(0, Math.min(1, frac));
  const r = f < 0.5 ? 239 : Math.round(239 - (f - 0.5) * 2 * (239 - 102));
  const g = f < 0.5 ? Math.round(83 + f * 2 * (167 - 83)) : Math.round(167 + (f - 0.5) * 2 * (187 - 167));
  const b = f < 0.5 ? 80 : Math.round(80 + (f - 0.5) * 2 * (106 - 80));
  return `rgb(${r},${g},${b})`;
}

function wedgePath(cx: number, cy: number, rIn: number, rOut: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [x0, y0] = p(rOut, a0), [x1, y1] = p(rOut, a1);
  const [x2, y2] = p(rIn, a1), [x3, y3] = p(rIn, a0);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${x0},${y0} A${rOut},${rOut} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${rIn},${rIn} 0 ${large} 0 ${x3},${y3} Z`;
}

export function RotorSvg({ perSector, erpm, erpmMax }: {
  perSector: number[]; erpm: number; erpmMax: number;
}) {
  const [angle, setAngle] = useState(0);        // electrical angle, radians
  const [tally, setTally] = useState({ cap: 0, guess: 0 });
  const raf = useRef<number>(0);
  const last = useRef<number>(0);
  const prevSector = useRef<number>(-1);
  const perSectorRef = useRef(perSector);
  perSectorRef.current = perSector;

  useEffect(() => {
    // visual revs/sec scaled to eRPM (0.2 .. 2.3), like the desktop widget
    const step = (ts: number) => {
      if (!last.current) last.current = ts;
      const dt = Math.min(0.05, (ts - last.current) / 1000);
      last.current = ts;
      const revsPerSec = erpm <= 1500 ? 0 : 0.2 + (Math.min(erpm, erpmMax) / erpmMax) * 2.1;
      setAngle(a => {
        const na = (a + revsPerSec * 2 * Math.PI * dt) % (2 * Math.PI);
        const sec = Math.floor((na / (2 * Math.PI)) * 6) % 6;
        if (sec !== prevSector.current) {
          if (prevSector.current >= 0 && erpm > 1500) {
            const captured = Math.random() < (perSectorRef.current[sec] ?? 0);
            setTally(t => captured ? { ...t, cap: t.cap + 1 } : { ...t, guess: t.guess + 1 });
          }
          prevSector.current = sec;
        }
        return na;
      });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [erpm, erpmMax]);

  const S = 260, cx = S / 2, cy = S / 2;
  const rOut = 120, rIn = 78, rHub = 64;
  // which sector is the rotor in (electrical angle -> 0..5)
  const sectorIdx = Math.floor((angle / (2 * Math.PI)) * 6) % 6;
  const [fphase, polarity] = SECTORS[sectorIdx];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <svg width={S} height={S}>
        {/* sector wedges */}
        {Array.from({ length: 6 }, (_, i) => {
          // SVG y is down; offset so sector 0 starts at top-left like the desktop
          const a0 = (i / 6) * 2 * Math.PI - Math.PI / 2;
          const a1 = ((i + 1) / 6) * 2 * Math.PI - Math.PI / 2;
          const mid = (a0 + a1) / 2;
          const lbl = SECTORS[i][1] > 0 ? 'R' : 'F';
          const active = i === sectorIdx;
          return (
            <g key={i}>
              <path d={wedgePath(cx, cy, rIn, rOut, a0, a1)} fill={lerpColor(perSector[i] ?? 0)}
                opacity={active ? 1 : 0.55} stroke="var(--bg-primary)" strokeWidth={2} />
              <text x={cx + (rIn + rOut) / 2 * Math.cos(mid)} y={cy + (rIn + rOut) / 2 * Math.sin(mid) + 4}
                fill="#0b0e14" fontSize={13} fontWeight={700} textAnchor="middle">{lbl}</text>
            </g>
          );
        })}
        {/* hub */}
        <circle cx={cx} cy={cy} r={rHub} fill="var(--bg-card)" stroke="var(--border)" strokeWidth={2} />
        {/* rotor bar (N red / S blue) */}
        <g transform={`rotate(${(angle * 180) / Math.PI} ${cx} ${cy})`}>
          <rect x={cx - 7} y={cy - rHub + 6} width={14} height={rHub - 6} rx={5} fill="#ef5350" />
          <rect x={cx - 7} y={cy} width={14} height={rHub - 6} rx={5} fill="#42a5f5" />
        </g>
        {/* angle pointer */}
        <line x1={cx} y1={cy} x2={cx + rOut * Math.cos(angle - Math.PI / 2)} y2={cy + rOut * Math.sin(angle - Math.PI / 2)}
          stroke="var(--accent-cyan)" strokeWidth={2} opacity={0.5} />
      </svg>
      <div style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        <div style={{ color: polarity > 0 ? 'var(--accent-green)' : 'var(--accent-orange)' }}>
          {polarity > 0 ? 'rising' : 'falling'} sector · float {PHASE_NAME[fphase]} · {Math.round(erpm).toLocaleString()} eRPM
        </div>
        <div style={{ color: 'var(--text-muted)' }}>captured {tally.cap} / guessed {tally.guess}</div>
      </div>
    </div>
  );
}
