import { useState } from 'react';
import { ConsolePanel } from './ConsolePanel';
import { useEscStore } from '../store/useEscStore';

/* ConsoleDock — persistent console pinned to the bottom of the shell, visible on
 * every tab (mirrors the desktop garuda_gui bottom Console dock).  Collapsible
 * and height-togglable so it never steals the whole screen. */

const SMALL = 200, LARGE = 460;

export function ConsoleDock() {
  const [open, setOpen] = useState(true);
  const [big, setBig] = useState(false);
  const telemActive = useEscStore(s => s.telemActive);
  const h = big ? LARGE : SMALL;

  return (
    <div style={{
      borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)',
      display: 'flex', flexDirection: 'column', flexShrink: 0, zIndex: 6,
    }}>
      {/* grab / toggle strip */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, height: 26, padding: '0 12px',
        cursor: 'pointer', userSelect: 'none', background: 'rgba(0,0,0,0.25)',
      }} onClick={() => setOpen(o => !o)}>
        <span style={{
          fontSize: 11, transition: 'transform 0.15s', transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
          color: 'var(--text-muted)',
        }}>▸</span>
        <span className="hud-label" style={{ letterSpacing: '1px' }}>Console</span>
        <span style={{
          width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
          background: telemActive ? 'var(--accent-green)' : 'var(--text-muted)',
          boxShadow: telemActive ? 'var(--glow) var(--accent-green)' : 'none',
          animation: telemActive ? 'pulse 1.6s infinite' : 'none',
        }} />
        <span style={{ flex: 1 }} />
        {open && (
          <span onClick={e => { e.stopPropagation(); setBig(b => !b); }}
            style={{ fontSize: 11, color: 'var(--text-muted)', padding: '2px 8px', borderRadius: 4 }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            title={big ? 'Shrink' : 'Expand'}>{big ? '▽ shrink' : '△ expand'}</span>
        )}
      </div>

      {open && (
        <div style={{ height: h }}>
          <ConsolePanel fill />
        </div>
      )}
    </div>
  );
}
