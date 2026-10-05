import { useEffect, useState } from 'react';
import { ViewErrorBoundary } from './components/ErrorBoundary';
import { Notice, NoticeHost } from './components/Notice';
import { AgentsView } from './components/AgentsView';
import { ConfirmHost } from './components/ConfirmDialog';
import { InboxView } from './components/InboxView';
import { OnboardingWizard } from './components/OnboardingWizard';
import { ThemeToggle, useTheme } from './components/ThemeToggle';
import { AutomationsView } from './components/AutomationsView';
import { EnvironmentView } from './components/EnvironmentView';
import { MemoryView } from './components/MemoryView';
import { RunsView } from './components/RunsView';
import { TemplatesView } from './components/TemplatesView';
import { WorkflowsView } from './components/WorkflowsView';
import { useAppStore, type View } from './store';
import { errorMessage } from './lib/errors';
import { readLocal, writeLocal } from './lib/storage';
import { getBackend } from './lib/backend';
import { version } from '../package.json';

const NAV: { id: View; label: string; icon: string }[] = [
  { id: 'workflows', label: 'Workflows', icon: '◈' },
  { id: 'agents', label: 'Agents', icon: '✦' },
  { id: 'templates', label: 'Templates', icon: '▤' },
  { id: 'automations', label: 'Automations', icon: '⏰' },
  { id: 'memory', label: 'Memory', icon: '🧠' },
  { id: 'runs', label: 'Runs', icon: '▶' },
  { id: 'environment', label: 'Environment', icon: '◍' },
];

export function App(): React.JSX.Element {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const refreshAll = useAppStore((s) => s.refreshAll);
  const loading = useAppStore((s) => s.loading);
  const error = useAppStore((s) => s.error);
  const setError = useAppStore((s) => s.setError);
  const notifications = useAppStore((s) => s.notifications);
  const unread = notifications.filter((n) => !n.read).length;
  const { theme, setTheme } = useTheme();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(
    () => readLocal('orchevia.sidebar.v1') === 'collapsed',
  );
  const toggleSidebar = (): void => {
    setCollapsed((c) => {
      const next = !c;
      writeLocal('orchevia.sidebar.v1', next ? 'collapsed' : 'open');
      return next;
    });
  };
  useEffect(() => {
    let alive = true;
    const check = async (): Promise<void> => {
      try {
        const done = await getBackend().getSetting('onboarding.completed');
        if (alive && done !== '1') setWizardOpen(true);
      } catch {
        if (alive) setWizardOpen(false);
      }
    };
    void check();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    void refreshAll().catch((err: unknown) => {
      setError(errorMessage(err));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      void useAppStore.getState().refreshNotifications();
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className={`app-shell${collapsed ? ' sidebar-collapsed' : ''}`}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Primary">
        <div className="sidebar-header">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              O
            </div>
            <div className="brand-copy">
              <div className="brand-name">Orchevia</div>
              <div className="brand-sub">v{version} · local-first</div>
            </div>
          </div>
          <button
            className="sidebar-toggle"
            onClick={toggleSidebar}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
          >
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <rect x="2.5" y="3" width="15" height="14" rx="2" />
              <path d="M7.5 3v14" />
              <path d={collapsed ? 'm11 8 2 2-2 2' : 'm13 8-2 2 2 2'} />
            </svg>
          </button>
        </div>
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`nav-btn${view === item.id ? ' active' : ''}`}
            onClick={() => {
              setView(item.id);
            }}
            aria-label={item.label}
            title={collapsed ? item.label : undefined}
            aria-current={view === item.id ? 'page' : undefined}
          >
            <span className="nav-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span className="nav-btn-label">{item.label}</span>
          </button>
        ))}
        <div className="sidebar-foot">
          {loading ? 'Loading…' : 'No accounts · no telemetry'}
        </div>
        <div className="sidebar-extra">
          <ThemeToggle theme={theme} setTheme={setTheme} />
          <button
            className="btn btn-ghost"
            onClick={() => {
              setWizardOpen(true);
            }}
          >
            Setup wizard
          </button>
        </div>
        <button
          className={`nav-btn${view === 'inbox' ? ' active' : ''}`}
          onClick={() => {
            setView('inbox');
          }}
          title="Notifications"
          aria-label="Inbox"
          aria-current={view === 'inbox' ? 'page' : undefined}
        >
          <span className="nav-icon" aria-hidden="true">
            🔔
          </span>
          <span className="nav-btn-label">Inbox</span>
          {unread > 0 && (
            <span className="nav-badge" aria-label={`${String(unread)} unread`}>
              {unread}
            </span>
          )}
        </button>
      </nav>
      <main className="main" id="main-content" tabIndex={-1} aria-busy={loading}>
        {error !== null && (
          <Notice
            variant="error"
            onDismiss={() => {
              setError(null);
            }}
            dismissLabel="Dismiss error"
          >
            {error}
          </Notice>
        )}
        <NoticeHost />
        <ConfirmHost />
        {wizardOpen && (
          <OnboardingWizard
            onClose={() => {
              setWizardOpen(false);
            }}
          />
        )}
        <ViewErrorBoundary key={view}>
          {view === 'workflows' && <WorkflowsView />}
          {view === 'agents' && <AgentsView />}
          {view === 'templates' && <TemplatesView />}
          {view === 'automations' && <AutomationsView />}
          {view === 'inbox' && <InboxView />}
          {view === 'memory' && <MemoryView />}
          {view === 'runs' && <RunsView />}
          {view === 'environment' && <EnvironmentView />}
        </ViewErrorBoundary>
      </main>
    </div>
  );
}
