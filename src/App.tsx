import { Component, type ReactNode } from 'react';
import { ConnectionBar } from './components/ConnectionBar';
import { StatusPanel } from './components/StatusPanel';
import { GaugePanel } from './components/GaugePanel';
import { ScopePanel } from './components/ScopePanel';
import BurstScopePanel from './components/BurstScopePanel';
import { ControlPanel } from './components/ControlPanel';
import { ThrottleSlider } from './components/ThrottleSlider';
import { ProfileSelector } from './components/ProfileSelector';
import { ParamPanel } from './components/ParamPanel';
import { ParamModal } from './components/ParamModal';
import { FallingZcSimPanel } from './components/FallingZcSimPanel';
import { HelpPanel } from './components/HelpPanel';
import { MonitorPanel } from './components/MonitorPanel';
import { WizardPanel } from './components/WizardPanel';
import { ConsolePanel } from './components/ConsolePanel';
import { useEscStore, type TabId } from './store/useEscStore';
import { ESC_STATES, FAULT_CODES, BOARD_NAMES } from './protocol/types';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) { return { error: e.message }; }
  render() {
    if (this.state.error) return (
      <div style={{ padding: 24, color: 'var(--accent-red)' }}>
        <h2>Something went wrong</h2>
        <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{this.state.error}</pre>
        <button onClick={() => this.setState({ error: null })} className="glass"
          style={{ marginTop: 12, padding: '8px 16px', color: 'var(--accent-cyan)' }}>Try Again</button>
      </div>
    );
    return this.props.children;
  }
}

const toastColors = {
  success: { bg: 'var(--accent-green-dim)', border: 'var(--accent-green)' },
  error: { bg: 'var(--accent-red-dim)', border: 'var(--accent-red)' },
  info: { bg: 'var(--accent-blue-dim)', border: 'var(--accent-blue)' },
};

const NAV: { id: TabId; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Mission Control', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z' },
  { id: 'scope', label: 'Scope', icon: 'M2 12h4l3-9 4 18 3-9h4' },
  { id: 'sim', label: 'ZC Sim', icon: 'M3 3v18h18M7 14l3-4 3 3 4-6' },
  { id: 'wizard', label: 'Motor Wizard', icon: 'M5 3l1.5 4L11 8.5 6.5 10 5 14l-1.5-4L-1 8.5M5 3M14 7l1 3 3 1-3 1-1 3-1-3-3-1 3-1z' },
  { id: 'params', label: 'Parameters', icon: 'M12 3v18M3 12h18M7.5 7.5l9 9M16.5 7.5l-9 9' },
  { id: 'console', label: 'Console', icon: 'M4 5h16v14H4zM7 9l3 3-3 3M13 15h4' },
  { id: 'help', label: 'Help', icon: 'M12 2a10 10 0 100 20 10 10 0 000-20zm0 14v-2m0-4a2 2 0 114 0c0 1.5-2 2-2 3' },
];

function GarudaMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none"
      style={{ filter: 'drop-shadow(0 0 8px rgba(34,224,224,0.6))' }}>
      <path d="M16 2L8 10L4 18L8 16L12 20L16 14L20 20L24 16L28 18L24 10L16 2Z" fill="var(--accent-cyan)" opacity="0.95" />
      <path d="M16 14L12 20L10 28L16 22L22 28L20 20L16 14Z" fill="var(--accent-blue)" opacity="0.8" />
      <circle cx="16" cy="9" r="2" fill="#fff" opacity="0.95" />
    </svg>
  );
}

function NavRail() {
  const activeTab = useEscStore(s => s.activeTab);
  const setActiveTab = useEscStore(s => s.setActiveTab);
  return (
    <div className="glass" style={{
      width: 66, display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '14px 0', gap: 8, borderRadius: 0,
      borderTop: 'none', position: 'relative', zIndex: 5,
    }}>
      <div style={{ marginBottom: 10 }}><GarudaMark /></div>
      {NAV.map(n => {
        const active = activeTab === n.id;
        return (
          <button key={n.id} onClick={() => setActiveTab(n.id)} title={n.label}
            style={{
              width: 46, height: 46, borderRadius: 12, position: 'relative',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: active ? 'var(--accent-blue-dim)' : 'transparent',
              border: active ? '1px solid rgba(56,189,248,0.4)' : '1px solid transparent',
              boxShadow: active ? 'var(--glow) rgba(34,224,224,0.35)' : 'none',
              color: active ? 'var(--accent-cyan)' : 'var(--text-muted)',
            }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
              <path d={n.icon} />
            </svg>
            {active && <span style={{
              position: 'absolute', left: -14, top: '50%', transform: 'translateY(-50%)',
              width: 3, height: 22, borderRadius: 2, background: 'var(--accent-cyan)',
              boxShadow: 'var(--glow) var(--accent-cyan)',
            }} />}
          </button>
        );
      })}
    </div>
  );
}

function StatePill() {
  const snapshot = useEscStore(s => s.snapshot);
  const telemActive = useEscStore(s => s.telemActive);
  const state = snapshot ? (ESC_STATES[snapshot.state] ?? `?${snapshot.state}`) : 'OFFLINE';
  const faulted = (snapshot?.faultCode ?? 0) !== 0;
  const running = snapshot && snapshot.state >= 3 && !faulted;
  const color = faulted ? 'var(--accent-red)' : running ? 'var(--accent-green)' : telemActive ? 'var(--accent-cyan)' : 'var(--text-muted)';
  const label = faulted ? (FAULT_CODES[snapshot!.faultCode] ?? 'FAULT') : state;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 14px', borderRadius: 20,
      background: 'rgba(0,0,0,0.25)', border: `1px solid ${color}`, boxShadow: `var(--glow) ${color}33` }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color,
        boxShadow: `var(--glow) ${color}`, animation: running || telemActive ? 'pulse 1.6s infinite' : 'none' }} />
      <span className="mono" style={{ fontSize: 12, fontWeight: 700, letterSpacing: '1px', color }}>{label}</span>
    </div>
  );
}

function MiniReadout({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ textAlign: 'right', minWidth: 64 }}>
      <div className="hud-label">{label}</div>
      <div className="mono" style={{ fontSize: 15, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

function TopHud() {
  const info = useEscStore(s => s.info);
  const connected = useEscStore(s => s.connected);
  const snapshot = useEscStore(s => s.snapshot);
  const erpm = (() => {
    if (!snapshot) return '—';
    if (snapshot.hwzcEnabled && snapshot.hwzcStepPeriodHR > 0) return Math.round(1e9 / snapshot.hwzcStepPeriodHR).toLocaleString();
    if (snapshot.stepPeriod > 0) return Math.round((info?.pwmFrequency ?? 45000) * 10 / snapshot.stepPeriod).toLocaleString();
    return '0';
  })();
  const vbus = snapshot ? (snapshot.vbusRaw * 3.3 / 4096 * 19.8).toFixed(1) : '—';
  return (
    <div className="glass" style={{
      display: 'flex', alignItems: 'center', gap: 16, height: 56, padding: '0 18px',
      borderRadius: 0, borderLeft: 'none', borderTop: 'none', position: 'relative', zIndex: 5,
    }}>
      <div style={{ lineHeight: 1.1 }}>
        <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-0.2px' }}>
          GARUDA <span style={{ color: 'var(--accent-cyan)' }}>STUDIO</span>
        </div>
        <div className="hud-label">Mission Control</div>
      </div>
      <StatePill />
      <div style={{ flex: 1 }} />
      <MiniReadout label="eRPM" value={erpm} color="var(--accent-blue)" />
      <MiniReadout label="Vbus" value={connected ? `${vbus} V` : '—'} color="var(--accent-green)" />
      {info && connected && (
        <div style={{ textAlign: 'right', borderLeft: '1px solid var(--border)', paddingLeft: 14 }}>
          <div className="hud-label">{BOARD_NAMES[info.boardId] || 'dsPIC33AK'}</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            fw {info.fwMajor}.{info.fwMinor}.{info.fwPatch} · GSP v{info.protocolVersion}
          </div>
        </div>
      )}
      <div style={{ width: 1, height: 26, background: 'var(--border)' }} />
      <ConnectionBar />
    </div>
  );
}

function DashboardTab() {
  return (
    <>
      <MonitorPanel />
      <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 14, marginTop: 14 }}>
        <StatusPanel />
        <GaugePanel />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
        <ControlPanel />
        <ThrottleSlider />
      </div>
      <ProfileSelector />
    </>
  );
}

function ScopeTab() { return (<><ScopePanel /><BurstScopePanel /></>); }
function SimTab() { return <FallingZcSimPanel />; }
function WizardTab() { return <WizardPanel />; }
function ConsoleTab() { return <ConsolePanel />; }
function ParamsTab() { return <ParamPanel />; }
function HelpTab() { return <HelpPanel alwaysExpanded />; }

export default function App() {
  const toasts = useEscStore(s => s.toasts);
  const removeToast = useEscStore(s => s.removeToast);
  const activeTab = useEscStore(s => s.activeTab);

  const renderTab = () => {
    switch (activeTab) {
      case 'dashboard': return <DashboardTab />;
      case 'scope': return <ScopeTab />;
      case 'sim': return <SimTab />;
      case 'wizard': return <WizardTab />;
      case 'params': return <ParamsTab />;
      case 'console': return <ConsoleTab />;
      case 'help': return <HelpTab />;
      default: return <DashboardTab />;
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', position: 'relative', zIndex: 1 }}>
      <NavRail />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <TopHud />
        <main style={{ flex: 1, overflow: 'auto', padding: '18px 22px' }}>
          <div style={{ maxWidth: 1320, margin: '0 auto', animation: 'fadeIn 0.25s ease-out' }} key={activeTab}>
            <ErrorBoundary>{renderTab()}</ErrorBoundary>
          </div>
        </main>
      </div>

      <ParamModal />

      <div style={{ position: 'fixed', bottom: 20, right: 20, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 1000 }}>
        {toasts.map(t => (
          <div key={t.id} onClick={() => removeToast(t.id)} className="glass" style={{
            padding: '10px 16px', cursor: 'pointer',
            background: toastColors[t.type].bg, borderLeft: `3px solid ${toastColors[t.type].border}`,
            color: 'var(--text-primary)', fontSize: 13, fontWeight: 500, animation: 'fadeIn 0.2s ease-out',
          }}>{t.message}</div>
        ))}
      </div>
    </div>
  );
}
