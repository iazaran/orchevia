import { useEffect, useState } from 'react';
import { getBackend } from '../lib/backend';
import {
  RISK_LABELS,
  WEEKDAYS,
  describeScheduleKind,
  fromLocalInputValue,
  oneTimeCompleted,
  oneTimeSpent,
  newScheduleId,
  toLocalInputValue,
  validateWatcher,
  watcherNextCheck,
  workflowConsumesPrNumber,
  type NotificationPrefs,
  type RiskCategory,
  type Schedule,
  type ScheduleKind,
  type Watcher,
  type WeekdayDto,
} from '../lib/scheduler';
import { formatTime } from '../lib/time';
import { DirPicker } from './DirPicker';
import { confirmDialog } from './ConfirmDialog';
import { useAppStore } from '../store';
import { CloseButton } from './CloseButton';
import { Modal } from './Modal';
import { Notice, useNoticeMessage } from './Notice';
import { readLocal, writeLocal } from '../lib/storage';
import { errorMessage } from '../lib/errors';
import type { DesktopInfo } from '../lib/updates';
import { Switch } from './Switch';

function emptySchedule(workflowId: string): Schedule {
  return {
    id: newScheduleId('sched'),
    name: 'Nightly review',
    workflowId,
    kind: { kind: 'daily', hour: 2, minute: 0 },
    timezone: 'local',
    enabled: false,
    trusted: false,
    missedPolicy: 'skip',
  };
}

function emptyWatcher(workflowId: string): Watcher {
  return {
    id: newScheduleId('watch'),
    name: 'Review requests',
    workflowId,
    kind: 'reviewRequested',
    repoDir: '',
    enabled: false,
    checkIntervalSecs: 900,
  };
}

function workflowName(
  workflows: { id: string; name: string }[],
  workflowId: string,
): string {
  return workflows.find((w) => w.id === workflowId)?.name ?? workflowId;
}

function oneHourFromNow(): string {
  return new Date(Date.now() + 3600000).toISOString();
}

/** What closing the window does, given background mode and the tray. */
function backgroundHint(on: boolean, desktop: DesktopInfo | null): string {
  if (!on)
    return 'Closing the window quits Orchevia, so schedules and watchers stop until you open it again.';
  if (desktop?.trayAvailable === true)
    return 'Closing the window keeps Orchevia running in the tray. Use the tray icon to show or quit it.';
  if (desktop?.trayAvailable === false)
    return 'Closing the window keeps Orchevia running without a window. Open Orchevia from your app menu to bring it back; it never starts a second copy.';
  return 'Closing the window keeps Orchevia running. Bring it back from the tray icon or by opening Orchevia again from your app menu.';
}

/** A slot in the past that has not run yet: held back, or waiting for the next check. */
function overdueNote(schedule: Schedule): string | null {
  if (!schedule.enabled || schedule.nextRunAt === undefined) return null;
  if (Date.parse(schedule.nextRunAt) > Date.now()) return null;
  return schedule.deferredSlot !== undefined
    ? 'Waiting for a free run slot; it runs as soon as one frees.'
    : 'Due now; it starts on the next check.';
}

export function AutomationsView(): React.JSX.Element {
  const schedules = useAppStore((s) => s.schedules);
  const watchers = useAppStore((s) => s.watchers);
  const workflows = useAppStore((s) => s.workflows);
  const notifications = useAppStore((s) => s.notifications);
  const unreadCount = notifications.filter((n) => !n.read).length;
  const setView = useAppStore((s) => s.setView);
  const notificationPrefs = useAppStore((s) => s.notificationPrefs);
  const backgroundMode = useAppStore((s) => s.backgroundMode);
  const refreshAutomations = useAppStore((s) => s.refreshAutomations);
  const refreshNotifications = useAppStore((s) => s.refreshNotifications);

  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [editingWatcher, setEditingWatcher] = useState<Watcher | null>(null);
  const [message, setMessage, messageVariant, messageEvent] = useNoticeMessage();
  const [hintDismissed, setHintDismissed] = useState<boolean>(
    () => readLocal('orchevia.automationsHint.v1') === 'dismissed',
  );
  const dismissHint = (): void => {
    setHintDismissed(true);
    writeLocal('orchevia.automationsHint.v1', 'dismissed');
  };
  const [risks, setRisks] = useState<{ workflow: string; risks: RiskCategory[] } | null>(
    null,
  );
  const [desktop, setDesktop] = useState<DesktopInfo | null>(null);
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const markSaving = (id: string, busy: boolean): void => {
    setSaving((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const activeRuns = useAppStore(
    (s) => s.runs.filter((r) => r.status === 'running' || r.status === 'pending').length,
  );

  useEffect(() => {
    let alive = true;
    void getBackend()
      .desktopInfo()
      .then((info) => {
        if (alive) setDesktop(info);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const defaultWorkflow = workflows[0]?.id ?? '';

  useEffect(() => {
    // The scheduler runs independently; refresh visible status while this
    // view is open, including quiet checks that create no run or notification.
    const timer = setInterval(() => {
      void refreshAutomations();
    }, 5000);
    return () => clearInterval(timer);
  }, [refreshAutomations]);

  const reload = (): void => {
    void Promise.all([refreshAutomations(), refreshNotifications()]);
  };

  const saveSchedule = (schedule: Schedule): void => {
    void getBackend()
      .saveSchedule(schedule)
      .then(() => {
        setEditingSchedule(null);
        setMessage(`Saved schedule '${schedule.name}'.`);
        reload();
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err), 'error');
      });
  };

  const saveWatcher = (watcher: Watcher): void => {
    void getBackend()
      .saveWatcher(watcher)
      .then(() => {
        setEditingWatcher(null);
        setMessage(
          watcher.enabled
            ? `Saved watcher '${watcher.name}'. An eligible check is queued now; unchanged revisions stay quiet.`
            : `Saved watcher '${watcher.name}' (disabled).`,
        );
        reload();
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err), 'error');
      });
  };

  const showRisks = (workflowId: string): void => {
    const wf = workflows.find((w) => w.id === workflowId)?.definition;
    if (wf === undefined) return;
    void getBackend()
      .workflowRisks(wf)
      .then((r) => {
        setRisks({ workflow: workflowId, risks: r });
      })
      .catch(() => {
        setRisks(null);
      });
  };

  const fireNow = (id: string): void => {
    void getBackend()
      .fireScheduleNow(id)
      .then(() => {
        setMessage('Run started.');
        reload();
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err), 'error');
      });
  };

  const setScheduleEnabled = (schedule: Schedule, enabled: boolean): void => {
    markSaving(schedule.id, true);
    void getBackend()
      .saveSchedule({ ...schedule, enabled })
      .then(() => {
        setMessage(
          enabled
            ? `Resumed schedule '${schedule.name}'.`
            : `Paused schedule '${schedule.name}'. It won't run until you resume it.`,
        );
        reload();
      })
      .catch((err: unknown) => {
        const text = errorMessage(err);
        setMessage(
          enabled && /trust/i.test(text)
            ? `${text} Use Edit → Trusted to allow it.`
            : text,
          'error',
        );
      })
      .finally(() => {
        markSaving(schedule.id, false);
      });
  };

  const setWatcherEnabled = (watcher: Watcher, enabled: boolean): void => {
    markSaving(watcher.id, true);
    void getBackend()
      .saveWatcher({ ...watcher, enabled })
      .then(() => {
        setMessage(
          enabled
            ? `Resumed watcher '${watcher.name}'. An eligible check is queued now.`
            : `Paused watcher '${watcher.name}'. It won't check GitHub until you resume it.`,
        );
        reload();
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err), 'error');
      })
      .finally(() => {
        markSaving(watcher.id, false);
      });
  };

  const quit = (): void => {
    void confirmDialog({
      title: 'Quit Orchevia?',
      message:
        activeRuns > 0
          ? `${String(activeRuns)} active run(s) will be stopped. Schedules and watchers pause until you open Orchevia again.`
          : 'Schedules and watchers pause until you open Orchevia again.',
      confirmLabel: 'Quit',
      danger: activeRuns > 0,
    }).then((ok) => {
      if (!ok) return;
      return getBackend()
        .quitApp()
        .catch((err: unknown) => {
          setMessage(errorMessage(err), 'error');
        });
    });
  };

  const toggleBackground = (on: boolean): void => {
    void getBackend()
      .setSetting('background.mode', on ? '1' : '0')
      .then(() => refreshAutomations())
      .catch((err: unknown) => {
        setMessage(errorMessage(err), 'error');
      });
  };

  return (
    <>
      <div className="topbar">
        <h1>Automations</h1>
        <span className="topbar-sub">
          Schedules, watchers, and notifications — all local.
        </span>
        <div className="topbar-actions">
          <button
            className="btn btn-primary"
            disabled={defaultWorkflow === ''}
            onClick={() => {
              setEditingSchedule(emptySchedule(defaultWorkflow));
            }}
          >
            + New schedule
          </button>
          <button
            className="btn"
            disabled={defaultWorkflow === ''}
            onClick={() => {
              setEditingWatcher(emptyWatcher(defaultWorkflow));
            }}
          >
            + New watcher
          </button>
          <button className="btn" onClick={reload}>
            Refresh
          </button>
        </div>
      </div>
      <div className="view">
        {message !== null && (
          <Notice
            variant={messageVariant}
            eventId={messageEvent}
            style={{ marginBottom: 12 }}
            onDismiss={() => {
              setMessage(null);
            }}
          >
            <span>{message}</span>{' '}
          </Notice>
        )}
        {!hintDismissed && (
          <Notice inline style={{ marginBottom: 16 }} onDismiss={dismissHint}>
            <span>
              Orchevia must be running for schedules and watchers to fire (background mode
              keeps it running when the window closes). New automations start{' '}
              <strong>disabled</strong>; enabling anything above read-only needs an
              explicit trust opt-in. Missed windows never storm: at most one catch-up per
              policy.
            </span>{' '}
          </Notice>
        )}

        <section
          aria-label="Background mode"
          className="tool-card"
          style={{ marginBottom: 16, maxWidth: 680 }}
        >
          <div className="background-card-head">
            <h3 style={{ margin: 0 }}>Background mode</h3>
            <Switch
              checked={backgroundMode}
              onChange={toggleBackground}
              label="Keep running when the window closes"
              onText="Keep running when closed"
              offText="Quit when closed"
            />
          </div>
          <p className="field-hint" style={{ margin: '8px 0 0' }}>
            {backgroundHint(backgroundMode, desktop)}
          </p>
          {backgroundMode && desktop?.trayAvailable === false && (
            <Notice inline style={{ marginTop: 10 }}>
              <span>
                Your desktop shows no tray icons. On GNOME, install the AppIndicator
                extension (
                <code>sudo apt install gnome-shell-extension-appindicator</code>
                ), then log out and back in to get Orchevia&apos;s tray icon.
              </span>
            </Notice>
          )}
          <div className="background-card-actions">
            <button className="btn btn-ghost danger-hover" onClick={quit}>
              Quit Orchevia
            </button>
            <span className="field-hint">
              Schedules start on time while Orchevia runs; it checks again at least every
              minute.
            </span>
          </div>
        </section>

        <h2 style={{ fontSize: 14 }}>Schedules ({schedules.length})</h2>
        {schedules.length === 0 && (
          <div className="empty-state" style={{ margin: '12px 0', padding: '28px 20px' }}>
            <h2>No schedules yet</h2>
            <p>
              Run a workflow nightly, weekly, or on a cron — disabled until you trust it.
            </p>
            <button
              className="btn btn-primary"
              disabled={defaultWorkflow === ''}
              title={
                defaultWorkflow === ''
                  ? 'Create a workflow first — schedules need something to run'
                  : undefined
              }
              onClick={() => {
                setEditingSchedule(emptySchedule(defaultWorkflow));
              }}
            >
              + New schedule
            </button>
          </div>
        )}
        <div className="tool-grid">
          {schedules.map((s) => (
            <div
              key={s.id}
              className="tool-card profile-card has-dismiss automation-card"
              style={{ position: 'relative' }}
            >
              <div className="profile-head">
                <div style={{ minWidth: 0 }}>
                  <h3 style={{ margin: 0 }}>{s.name}</h3>
                  <div className="profile-sub">
                    {workflowName(workflows, s.workflowId)}
                  </div>
                </div>
                <div className="automation-head-actions">
                  {!s.enabled && oneTimeSpent(s) !== null ? (
                    // A spent one-time schedule needs a new time, not a switch.
                    <span
                      className="status-pill status-cancelled"
                      title={oneTimeSpent(s) ?? undefined}
                    >
                      {oneTimeCompleted(s) ? 'Done' : 'Expired'}
                    </span>
                  ) : (
                    <Switch
                      checked={s.enabled}
                      onChange={(on) => {
                        setScheduleEnabled(s, on);
                      }}
                      label={`Run schedule '${s.name}'`}
                      title={s.enabled ? 'Pause this schedule' : 'Resume this schedule'}
                      onText="On"
                      offText="Paused"
                      busy={saving.has(s.id)}
                    />
                  )}
                  <CloseButton
                    variant="card"
                    label={`Delete schedule '${s.name}'`}
                    title={`Delete schedule '${s.name}'`}
                    onClose={() => {
                      void confirmDialog({
                        title: `Delete schedule '${s.name}'?`,
                        message: 'The workflow is kept; only this schedule is removed.',
                        confirmLabel: 'Delete',
                        danger: true,
                      }).then((ok) => {
                        if (!ok) return;
                        return getBackend()
                          .deleteSchedule(s.id)
                          .then(() => refreshAutomations())
                          .catch((err: unknown) => {
                            setMessage(errorMessage(err), 'error');
                          });
                      });
                    }}
                  />
                </div>
              </div>
              {s.trusted && (
                <div>
                  <span className="status-pill status-running">trusted</span>
                </div>
              )}
              <dl className="profile-facts">
                <div>
                  <dt>Schedule</dt>
                  <dd title={`${describeScheduleKind(s.kind)} (${s.timezone})`}>
                    {describeScheduleKind(s.kind)} ({s.timezone})
                  </dd>
                </div>
                <div>
                  <dt>Next run</dt>
                  <dd title={s.nextRunAt ?? undefined}>
                    {!s.enabled && oneTimeSpent(s) !== null
                      ? '—'
                      : !s.enabled
                        ? 'Paused'
                        : s.nextRunAt !== undefined
                          ? formatTime(s.nextRunAt)
                          : '—'}
                    {overdueNote(s) !== null && (
                      <span className="fact-note">{overdueNote(s)}</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Last run</dt>
                  <dd title={s.lastRunAt ?? 'never'}>
                    {s.lastRunAt !== undefined ? formatTime(s.lastRunAt) : 'never'}
                  </dd>
                </div>
              </dl>
              {s.lastStatus !== undefined && (
                <div className="watcher-result" title={s.lastStatus}>
                  <span className="field-label">Last result</span>
                  <span>{s.lastStatus}</span>
                </div>
              )}
              <div className="profile-actions">
                <button className="btn" onClick={() => setEditingSchedule({ ...s })}>
                  Edit
                </button>
                <button className="btn btn-ghost" onClick={() => fireNow(s.id)}>
                  Run now
                </button>
                <button className="btn btn-ghost" onClick={() => showRisks(s.workflowId)}>
                  Risks
                </button>
              </div>
            </div>
          ))}
        </div>

        <h2 style={{ fontSize: 14, marginTop: 20 }}>Watchers ({watchers.length})</h2>
        {watchers.length === 0 && (
          <div className="empty-state" style={{ margin: '12px 0', padding: '28px 20px' }}>
            <h2>No watchers yet</h2>
            <p>
              Watchers poll GitHub for review requests, PR updates, or feedback — and run
              a workflow only for new revisions (SHA-tracked, own comments ignored).
            </p>
            <button
              className="btn btn-primary"
              disabled={defaultWorkflow === ''}
              title={
                defaultWorkflow === ''
                  ? 'Create a workflow first — watchers need something to run'
                  : undefined
              }
              onClick={() => {
                setEditingWatcher(emptyWatcher(defaultWorkflow));
              }}
            >
              + New watcher
            </button>
          </div>
        )}
        {watchers.length > 0 && (
          <p className="field-hint" style={{ maxWidth: 720 }}>
            Watchers poll GitHub for review requests, PR updates, or feedback — and run a
            workflow only for new revisions (SHA-tracked, own comments ignored).
          </p>
        )}
        <div className="tool-grid">
          {watchers.map((w) => (
            <div
              key={w.id}
              className="tool-card profile-card has-dismiss automation-card"
              style={{ position: 'relative' }}
            >
              <div className="profile-head">
                <div style={{ minWidth: 0 }}>
                  <h3 style={{ margin: 0 }}>{w.name}</h3>
                  <div className="profile-sub">
                    {workflowName(workflows, w.workflowId)}
                  </div>
                </div>
                <div className="automation-head-actions">
                  <Switch
                    checked={w.enabled}
                    onChange={(on) => {
                      setWatcherEnabled(w, on);
                    }}
                    label={`Run watcher '${w.name}'`}
                    title={w.enabled ? 'Pause this watcher' : 'Resume this watcher'}
                    onText="On"
                    offText="Paused"
                    busy={saving.has(w.id)}
                  />
                  <CloseButton
                    variant="card"
                    label={`Delete watcher '${w.name}'`}
                    title={`Delete watcher '${w.name}'`}
                    onClose={() => {
                      void confirmDialog({
                        title: `Delete watcher '${w.name}'?`,
                        message: 'The workflow is kept; only this watcher is removed.',
                        confirmLabel: 'Delete',
                        danger: true,
                      }).then((ok) => {
                        if (!ok) return;
                        return getBackend()
                          .deleteWatcher(w.id)
                          .then(() => refreshAutomations())
                          .catch((err: unknown) => {
                            setMessage(errorMessage(err), 'error');
                          });
                      });
                    }}
                  />
                </div>
              </div>
              <dl className="profile-facts">
                <div>
                  <dt>Kind</dt>
                  <dd>{w.kind}</dd>
                </div>
                <div>
                  <dt>Poll every</dt>
                  <dd>{Math.round(w.checkIntervalSecs / 60)} min</dd>
                </div>
                <div>
                  <dt>Repo</dt>
                  <dd title={w.repoDir}>
                    {w.repoDir}
                    {w.prNumber !== undefined ? ` #${String(w.prNumber)}` : ''}
                  </dd>
                </div>
                <div>
                  <dt>Next check</dt>
                  <dd title={watcherNextCheck(w)}>
                    {!w.enabled
                      ? 'Paused'
                      : watcherNextCheck(w) !== undefined
                        ? formatTime(watcherNextCheck(w) ?? '')
                        : 'Queued for first check'}
                  </dd>
                </div>
                <div>
                  <dt>Last check</dt>
                  <dd title={w.lastCheckedAt ?? undefined}>
                    {w.lastCheckedAt !== undefined
                      ? formatTime(w.lastCheckedAt)
                      : 'never'}
                  </dd>
                </div>
              </dl>
              <div
                className="watcher-result"
                title={
                  w.lastResult ??
                  (w.enabled ? 'Waiting for first check' : 'never checked')
                }
              >
                <span className="field-label">Last result</span>
                <span>
                  {w.lastResult ??
                    (w.enabled ? 'Waiting for first check' : 'never checked')}
                </span>
              </div>
              <div className="profile-actions">
                <button className="btn" onClick={() => setEditingWatcher({ ...w })}>
                  Edit
                </button>
              </div>
            </div>
          ))}
        </div>

        {risks !== null && (
          <Notice inline style={{ marginTop: 12 }}>
            <strong>Risk summary:</strong>{' '}
            {risks.risks.map((r) => RISK_LABELS[r]).join(' · ') || 'none'}
          </Notice>
        )}

        {editingSchedule !== null && (
          <Modal
            label="Schedule editor"
            onClose={() => setEditingSchedule(null)}
            closeLabel="Close schedule editor"
            onBackdrop={() => setEditingSchedule(null)}
          >
            <div>
              <ScheduleEditor
                initial={editingSchedule}
                onCancel={() => setEditingSchedule(null)}
                onSave={saveSchedule}
              />
            </div>
          </Modal>
        )}
        {editingWatcher !== null && (
          <Modal
            label="Watcher editor"
            onClose={() => setEditingWatcher(null)}
            closeLabel="Close watcher editor"
            onBackdrop={() => setEditingWatcher(null)}
          >
            <div>
              <WatcherEditor
                initial={editingWatcher}
                onCancel={() => setEditingWatcher(null)}
                onSave={saveWatcher}
              />
            </div>
          </Modal>
        )}

        <h2 style={{ fontSize: 14, marginTop: 24 }}>Notifications</h2>

        <NotificationPrefsEditor
          // Remount once stored preferences arrive; later refreshes keep edits.
          key={notificationPrefs === null ? 'pending' : 'loaded'}
          prefs={notificationPrefs}
          unreadCount={unreadCount}
          onOpenInbox={() => {
            setView('inbox');
          }}
          onSaved={() => {
            void refreshAutomations();
          }}
          onMessage={setMessage}
        />
      </div>
    </>
  );
}

const TIMEZONES = ['local', 'utc', '+01:00', '+02:00', '+04:00', '-05:00', '-08:00'];

/** Offered zones, plus a stored offset that is not in the short list. */
function timezoneOptions(current: string): string[] {
  return TIMEZONES.includes(current) ? TIMEZONES : [...TIMEZONES, current];
}

function ScheduleEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: Schedule;
  onCancel: () => void;
  onSave: (s: Schedule) => void;
}): React.JSX.Element {
  const workflows = useAppStore((s) => s.workflows);
  const [form, setForm] = useState<Schedule>({ ...initial });
  const [preview, setPreview] = useState<string | null>(null);
  const errors = validateScheduleForm(form);
  const set = (patch: Partial<Schedule>): void => {
    setForm((f) => ({ ...f, ...patch }));
  };

  const updateKind = (kind: ScheduleKind): void => {
    set({ kind });
    setPreview(null);
  };

  const showPreview = (): void => {
    void getBackend()
      .schedulePreview(form.kind, form.timezone, 3)
      .then((slots) => {
        setPreview(slots.length === 0 ? 'No upcoming slots.' : slots.join('\n'));
      })
      .catch((err: unknown) => {
        setPreview(errorMessage(err));
      });
  };

  return (
    <>
      <h3 style={{ marginTop: 0 }}>Schedule</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="field">
          <label className="field-label" htmlFor="sched-name">
            Name
          </label>
          <input
            id="sched-name"
            className="input"
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="sched-wf">
            Workflow
          </label>
          <select
            id="sched-wf"
            className="input"
            value={form.workflowId}
            onChange={(e) => set({ workflowId: e.target.value })}
          >
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <KindEditor kind={form.kind} onChange={updateKind} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <div className="field">
          <label className="field-label" htmlFor="sched-tz">
            Timezone
          </label>
          <select
            id="sched-tz"
            className="input"
            value={form.timezone}
            onChange={(e) => set({ timezone: e.target.value })}
          >
            {timezoneOptions(form.timezone).map((zone) => (
              <option key={zone} value={zone}>
                {zone === 'local' ? 'local (system time)' : zone}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="sched-missed">
            If a run is missed
          </label>
          <select
            id="sched-missed"
            className="input"
            value={form.missedPolicy}
            onChange={(e) =>
              set({ missedPolicy: e.target.value === 'runOnce' ? 'runOnce' : 'skip' })
            }
          >
            <option value="skip">Skip (no catch-up storm)</option>
            <option value="runOnce">Run once, then continue</option>
          </select>
        </div>
        <div className="field">
          <span className="field-label">State</span>
          <label className="field-hint" style={{ display: 'flex', gap: 6 }}>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set({ enabled: e.target.checked })}
            />
            Enabled
          </label>
          <label className="field-hint" style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <input
              type="checkbox"
              checked={form.trusted}
              onChange={(e) => set({ trusted: e.target.checked })}
            />
            Trusted (required for write-capable workflows)
          </label>
        </div>
      </div>
      <div className="field">
        <button className="btn btn-ghost" onClick={showPreview}>
          Preview next runs
        </button>
        {preview !== null && (
          <div className="log-block" style={{ marginTop: 8 }}>
            {preview}
          </div>
        )}
      </div>
      {errors.length > 0 && (
        <Notice variant="error" style={{ marginBottom: 12 }}>
          {errors[0]}
        </Notice>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn btn-primary"
          disabled={errors.length > 0}
          onClick={() => onSave(form)}
        >
          Save schedule
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

function KindEditor({
  kind,
  onChange,
}: {
  kind: ScheduleKind;
  onChange: (k: ScheduleKind) => void;
}): React.JSX.Element {
  const [tab, setTab] = useState(kind.kind);
  const switchTab = (next: ScheduleKind['kind']): void => {
    setTab(next);
    switch (next) {
      case 'oneTime':
        onChange({ kind: 'oneTime', at: oneHourFromNow() });
        break;
      case 'interval':
        onChange({ kind: 'interval', everySecs: 3600 });
        break;
      case 'daily':
        onChange({ kind: 'daily', hour: 2, minute: 0 });
        break;
      case 'weekly':
        onChange({ kind: 'weekly', weekday: 'mon', hour: 2, minute: 0 });
        break;
      case 'cron':
        onChange({ kind: 'cron', expr: '0 2 * * *' });
        break;
    }
  };
  return (
    <div className="field">
      <span className="field-label">Cadence</span>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        {(['oneTime', 'interval', 'daily', 'weekly', 'cron'] as const).map((t) => (
          <button
            key={t}
            className={`tool-chip${tab === t ? ' selected' : ''}`}
            onClick={() => switchTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      {kind.kind === 'oneTime' && (
        <input
          className="input"
          type="datetime-local"
          aria-label="Run once at (local time)"
          value={toLocalInputValue(kind.at)}
          onChange={(e) => {
            const at = fromLocalInputValue(e.target.value);
            // Keep the last valid time while the field is being cleared.
            if (at !== null) onChange({ kind: 'oneTime', at });
          }}
        />
      )}
      {kind.kind === 'interval' && (
        <label className="field-hint">
          Every (seconds, 60 – 2592000)
          <input
            className="input"
            type="number"
            min={60}
            max={2592000}
            value={kind.everySecs}
            onChange={(e) =>
              onChange({ kind: 'interval', everySecs: Number(e.target.value) })
            }
          />
        </label>
      )}
      {kind.kind === 'daily' && (
        <TimeFields
          hour={kind.hour}
          minute={kind.minute}
          onChange={(hour, minute) => onChange({ kind: 'daily', hour, minute })}
        />
      )}
      {kind.kind === 'weekly' && (
        <>
          <select
            className="input"
            value={kind.weekday}
            aria-label="Weekday"
            onChange={(e) => {
              onChange({
                kind: 'weekly',
                weekday: e.target.value as WeekdayDto,
                hour: kind.hour,
                minute: kind.minute,
              });
            }}
            style={{ marginBottom: 8 }}
          >
            {WEEKDAYS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <TimeFields
            hour={kind.hour}
            minute={kind.minute}
            onChange={(hour, minute) =>
              onChange({ kind: 'weekly', weekday: kind.weekday, hour, minute })
            }
          />
        </>
      )}
      {kind.kind === 'cron' && (
        <label className="field-hint">
          Cron (minute hour day month weekday)
          <input
            className="input"
            value={kind.expr}
            placeholder="0 2 * * *"
            onChange={(e) => onChange({ kind: 'cron', expr: e.target.value })}
          />
        </label>
      )}
    </div>
  );
}

function TimeFields({
  hour,
  minute,
  onChange,
}: {
  hour: number;
  minute: number;
  onChange: (h: number, m: number) => void;
}): React.JSX.Element {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      <label className="field-hint">
        Hour
        <input
          className="input"
          type="number"
          min={0}
          max={23}
          value={hour}
          onChange={(e) => onChange(Number(e.target.value), minute)}
        />
      </label>
      <label className="field-hint">
        Minute
        <input
          className="input"
          type="number"
          min={0}
          max={59}
          value={minute}
          onChange={(e) => onChange(hour, Number(e.target.value))}
        />
      </label>
    </div>
  );
}

function WatcherEditor({
  initial,
  onCancel,
  onSave,
}: {
  initial: Watcher;
  onCancel: () => void;
  onSave: (w: Watcher) => void;
}): React.JSX.Element {
  const workflows = useAppStore((s) => s.workflows);
  const [form, setForm] = useState<Watcher>({ ...initial });
  const set = (patch: Partial<Watcher>): void => {
    setForm((f) => ({ ...f, ...patch }));
  };
  const errors = validateWatcherForm(form, workflows.length > 0);
  const scopeKey =
    form.enabled && form.repoDir.trim() !== '' && form.workflowId.trim() !== ''
      ? JSON.stringify({
          watcher: form,
          definition: workflows.find((workflow) => workflow.id === form.workflowId)
            ?.definition,
        })
      : null;
  const [scopeResult, setScopeResult] = useState<{
    key: string;
    issues: string[];
  } | null>(null);
  const checkingScope = scopeKey !== null && scopeResult?.key !== scopeKey;
  useEffect(() => {
    if (scopeKey === null) return;
    let active = true;
    const timer = setTimeout(() => {
      void getBackend()
        .watcherScopeIssues(form)
        .then((issues) => {
          if (active) setScopeResult({ key: scopeKey, issues });
        })
        .catch((err: unknown) => {
          if (active) setScopeResult({ key: scopeKey, issues: [errorMessage(err)] });
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [form, scopeKey]);
  const saveErrors = [
    ...errors,
    ...(scopeResult?.key === scopeKey ? scopeResult.issues : []),
  ];
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Watcher</h3>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="field">
          <label className="field-label" htmlFor="watch-name">
            Name
          </label>
          <input
            id="watch-name"
            className="input"
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="watch-wf">
            Workflow
          </label>
          <select
            id="watch-wf"
            className="input"
            value={form.workflowId}
            onChange={(e) => set({ workflowId: e.target.value })}
          >
            {workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="field">
          <label className="field-label" htmlFor="watch-kind">
            Trigger
          </label>
          <select
            id="watch-kind"
            className="input"
            value={form.kind}
            onChange={(e) => set({ kind: e.target.value as Watcher['kind'] })}
          >
            <option value="reviewRequested">GitHub review requested</option>
            <option value="prUpdated">GitHub PR updated</option>
            <option value="feedback">Check / review feedback</option>
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="watch-pr">
            PR number (for PR scopes)
          </label>
          <input
            id="watch-pr"
            className="input"
            type="number"
            placeholder="blank = all requested reviews"
            value={form.prNumber ?? ''}
            onChange={(e) => {
              set({
                prNumber: e.target.value === '' ? undefined : Number(e.target.value),
              });
            }}
          />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <DirPicker
          id="watch-dir"
          label="Repository directory"
          value={form.repoDir}
          onChange={(repoDir) => set({ repoDir })}
        />
        <div className="field">
          <label className="field-label" htmlFor="watch-interval">
            Check every (seconds, ≥300)
          </label>
          <input
            id="watch-interval"
            className="input"
            type="number"
            min={300}
            max={2592000}
            value={form.checkIntervalSecs}
            onChange={(e) => set({ checkIntervalSecs: Number(e.target.value) })}
          />
        </div>
      </div>
      <label className="field-hint" style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        Enabled (enabling runs the workflow for new revisions — review write actions
        first)
      </label>
      <p className="field-hint">
        {workflowConsumesPrNumber(
          workflows.find((workflow) => workflow.id === form.workflowId)?.definition ?? {
            schemaVersion: 6,
            id: '',
            name: '',
            nodes: [],
            edges: [],
          },
        )
          ? 'Each eligible PR revision starts a distinct run, within the shared two-run limit.'
          : 'This workflow does not consume prNumber: requested reviews start one repository scan for the batch.'}{' '}
        Enabling queues a check immediately. Later checks use the interval after the last
        check, including quiet checks; they do not align to wall-clock quarter-hours.
      </p>
      {saveErrors.length > 0 && (
        <Notice variant="error" style={{ marginBottom: 12 }}>
          {saveErrors[0]}
        </Notice>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn btn-primary"
          disabled={saveErrors.length > 0 || checkingScope}
          onClick={() => onSave(form)}
        >
          Save watcher
        </button>
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}

function validateWatcherForm(form: Watcher, hasWorkflows: boolean): string[] {
  if (form.name.trim() === '') return ['Watcher name must not be empty.'];
  if (!hasWorkflows || form.workflowId.trim() === '')
    return ['Pick the workflow this watcher runs.'];
  if (form.repoDir.trim() === '')
    return ['Repository directory is required (Browse… or type it).'];
  return validateWatcher(form);
}

function validateScheduleForm(form: Schedule): string[] {
  if (form.name.trim() === '') return ['Schedule name must not be empty.'];
  if (form.workflowId.trim() === '') return ['Pick the workflow this schedule runs.'];
  const kind = form.kind;
  if (kind.kind === 'oneTime') {
    if (Number.isNaN(Date.parse(kind.at)))
      return ['One-time schedules need a valid date.'];
  } else if (kind.kind === 'interval') {
    if (
      !Number.isFinite(kind.everySecs) ||
      kind.everySecs < 60 ||
      kind.everySecs > 2592000
    )
      return ['Interval must be between 60 s and 30 days.'];
  } else if (kind.kind === 'daily' || kind.kind === 'weekly') {
    if (kind.hour < 0 || kind.hour > 23 || kind.minute < 0 || kind.minute > 59)
      return ['Hour must be 0–23 and minute 0–59.'];
  } else if (kind.expr.trim() === '') {
    return ['Cron expression must not be empty (e.g. “0 2 * * *”).'];
  }
  return [];
}

function fromPrefs(stored: NotificationPrefs | null): NotificationPrefs {
  return {
    onApproval: stored?.onApproval ?? true,
    onFailure: stored?.onFailure ?? true,
    onActionableFindings: stored?.onActionableFindings ?? true,
    onScheduledSuccess: stored?.onScheduledSuccess ?? false,
    onFeedbackNeedsAction: stored?.onFeedbackNeedsAction ?? true,
  };
}

function NotificationPrefsEditor({
  prefs,
  unreadCount,
  onOpenInbox,
  onSaved,
  onMessage,
}: {
  prefs: NotificationPrefs | null;
  unreadCount: number;
  onOpenInbox: () => void;
  onSaved: () => void;
  onMessage: (message: string | null, variant?: 'info' | 'warn' | 'error') => void;
}): React.JSX.Element {
  const [form, setForm] = useState<NotificationPrefs>(() => fromPrefs(prefs));
  const [osEnabled, setOsEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void getBackend()
      .getSetting('notifications.os')
      .then((value) => {
        if (alive) setOsEnabled(value === '1');
      })
      .catch(() => {
        if (alive) setOsEnabled(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  const toggle = (key: keyof NotificationPrefs): void => {
    setForm((f) => ({ ...f, [key]: !f[key] }));
  };
  const setOs = (on: boolean): void => {
    setOsEnabled(on);
    void getBackend()
      .setSetting('notifications.os', on ? '1' : '0')
      .catch((err: unknown) => {
        setOsEnabled(!on);
        onMessage(errorMessage(err), 'error');
      });
  };
  return (
    <section
      aria-label="Notification preferences"
      className="tool-card"
      style={{ marginTop: 20, maxWidth: 680 }}
    >
      <div className="background-card-head">
        <h3 style={{ margin: 0 }}>Notification preferences</h3>
        <Switch
          checked={osEnabled === true}
          onChange={setOs}
          label="Also send system desktop notifications"
          onText="Desktop notifications on"
          offText="Desktop notifications off"
          disabled={osEnabled === null}
        />
      </div>
      <p className="field-hint">
        {unreadCount} unread — approvals, failures, and findings live in the{' '}
        <button className="btn btn-ghost" onClick={onOpenInbox}>
          Inbox →
        </button>
      </p>
      {(
        [
          ['onApproval', 'Approval needed'],
          ['onFailure', 'Failures (workflows, blocked schedules, watcher errors)'],
          ['onActionableFindings', 'Actionable P0/P1 findings'],
          ['onScheduledSuccess', 'Scheduled success (off by default — no spam)'],
          ['onFeedbackNeedsAction', 'Feedback needs action'],
        ] as const
      ).map(([key, label]) => (
        <label key={key} className="field-hint" style={{ display: 'flex', gap: 6 }}>
          <input type="checkbox" checked={form[key]} onChange={() => toggle(key)} />
          {label}
        </label>
      ))}
      <button
        className="btn"
        style={{ marginTop: 8 }}
        onClick={() => {
          void getBackend()
            .setNotificationPrefs(form)
            .then(() => {
              onMessage('Saved notification preferences.');
              onSaved();
            })
            .catch((err: unknown) => {
              onMessage(errorMessage(err), 'error');
            });
        }}
      >
        Save preferences
      </button>
    </section>
  );
}
