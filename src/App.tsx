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
import { UsageView } from './components/UsageView';
import { WorkflowsView } from './components/WorkflowsView';
import { HomeView } from './components/HomeView';
import { CommandPalette } from './components/CommandPalette';
import { useAppStore, type View } from './store';
import { mergeActiveRuns } from './lib/dashboard';
import { errorMessage } from './lib/errors';
import { readLocal, writeLocal } from './lib/storage';
import { getBackend } from './lib/backend';
import { version } from '../package.json';
import { UpdateBanner, useAutomaticUpdateChecks } from './components/Updates';
import { BrandMark, Icon, type IconName } from './components/Icon';

const NAV: { id: View; label: string; icon: IconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'workflows', label: 'Workflows', icon: 'workflows' },
  { id: 'agents', label: 'Agents', icon: 'agents' },
  { id: 'templates', label: 'Templates', icon: 'templates' },
  { id: 'automations', label: 'Automations', icon: 'automations' },
  { id: 'memory', label: 'Playbooks', icon: 'playbooks' },
  { id: 'runs', label: 'Runs', icon: 'runs' },
  { id: 'environment', label: 'Environment', icon: 'environment' },
  { id: 'usage', label: 'Usage & costs', icon: 'usage' },
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
  const runningCount = useAppStore(
    (s) =>
      mergeActiveRuns(s.runs, s.activeRuns).filter((run) => run.status === 'running')
        .length,
  );
  const { theme, setTheme } = useTheme();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  useAutomaticUpdateChecks();
  // Ctrl/⌘ + K finds a view, workflow, template, run or action. Another open
  // dialog keeps the keys: the palette never opens over it.
  useEffect(() => {
    // On macOS Ctrl+K deletes to the end of a line in text fields: only ⌘K.
    const mac = /mac/i.test(navigator.platform);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'k' || !(mac ? event.metaKey : event.ctrlKey))
        return;
      if (event.altKey || event.shiftKey) return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      event.preventDefault();
      setPaletteOpen(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);
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
    void useAppStore
      .getState()
      .refreshActiveRuns()
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const state = useAppStore.getState();
      void state.refreshNotifications();
      // Scheduled and watcher runs start on their own: keep the sidebar's
      // running count true on every page while the window is in view.
      if (document.visibilityState === 'visible') {
        void state.refreshRuns().catch(() => undefined);
        void state.refreshActiveRuns().catch(() => undefined);
      }
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
              <BrandMark />
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
        <button
          className="nav-search"
          onClick={() => {
            setPaletteOpen(true);
          }}
          title="Find a view, workflow, template or action (Ctrl/⌘ + K)"
          aria-label="Search (Ctrl or Command + K)"
          aria-keyshortcuts="Control+K Meta+K"
        >
          <span className="nav-icon" aria-hidden="true">
            <Icon name="search" />
          </span>
          <span className="nav-btn-label">Search</span>
          <kbd className="nav-kbd" aria-hidden="true">
            {/mac/i.test(navigator.platform) ? '⌘K' : 'Ctrl K'}
          </kbd>
        </button>
        {NAV.map((item) => {
          const live = item.id === 'runs' && runningCount > 0;
          return (
            <button
              key={item.id}
              className={`nav-btn${view === item.id ? ' active' : ''}`}
              onClick={() => {
                setView(item.id);
              }}
              // The button's own label hides its content, so the count goes in it.
              aria-label={
                live ? `${item.label}, ${String(runningCount)} running` : item.label
              }
              title={
                collapsed
                  ? live
                    ? `${item.label}, ${String(runningCount)} running`
                    : item.label
                  : undefined
              }
              aria-current={view === item.id ? 'page' : undefined}
            >
              <span className="nav-icon" aria-hidden="true">
                <Icon name={item.icon} />
              </span>
              <span className="nav-btn-label">{item.label}</span>
              {live && (
                <span className="nav-live" aria-hidden="true">
                  <span className="live-dot" />
                  {runningCount}
                </span>
              )}
            </button>
          );
        })}
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
          // The button's own label hides its content, so the count goes in it.
          aria-label={unread > 0 ? `Inbox, ${String(unread)} unread` : 'Inbox'}
          aria-current={view === 'inbox' ? 'page' : undefined}
        >
          <span className="nav-icon" aria-hidden="true">
            <Icon name="inbox" />
          </span>
          <span className="nav-btn-label">Inbox</span>
          {unread > 0 && (
            <span className="nav-badge" aria-hidden="true">
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
        <UpdateBanner />
        <NoticeHost />
        {wizardOpen && (
          <OnboardingWizard
            onClose={() => {
              setWizardOpen(false);
            }}
          />
        )}
        {paletteOpen && (
          <CommandPalette
            onClose={() => {
              setPaletteOpen(false);
            }}
            onOpenWizard={() => {
              setWizardOpen(true);
            }}
          />
        )}
        <ViewErrorBoundary key={view}>
          {view === 'home' && <HomeView />}
          {view === 'workflows' && <WorkflowsView />}
          {view === 'agents' && <AgentsView />}
          {view === 'templates' && <TemplatesView />}
          {view === 'automations' && <AutomationsView />}
          {view === 'inbox' && <InboxView />}
          {view === 'memory' && <MemoryView />}
          {view === 'runs' && <RunsView />}
          {view === 'environment' && <EnvironmentView />}
          {view === 'usage' && <UsageView />}
        </ViewErrorBoundary>
        {/* Last, so a confirmation asked for by an open dialog is the top dialog. */}
        <ConfirmHost />
      </main>
    </div>
  );
}
