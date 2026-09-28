import { useEffect, useState } from 'react';
import { getBackend } from '../lib/backend';
import {
  RISK_LABELS,
  WEEKDAYS,
  describeScheduleKind,
  newScheduleId,
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
import { Notice } from './Notice';
import { readLocal, writeLocal } from '../lib/storage';
import { errorMessage } from '../lib/errors';

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

/**
 * Background scheduler poll interval. The setting existed (backend validates
 * 30–3600 s and the loop re-reads it live) but had no UI — this wires it up.
 */
function SchedulerInterval({
  onMessage,
}: {
  onMessage: (message: string | null) => void;
}): React.JSX.Element {
  const [value, setValue] = useState('60');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void getBackend()
      .getSetting('scheduler.intervalSecs')
      .then((stored) => {
        if (stored !== null) setValue(stored);
      })
      .catch(() => {})
      .finally(() => {
        setLoaded(true);
      });
  }, []);
  const save = (): void => {
    const trimmed = value.trim();
    void getBackend()
      .setSetting('scheduler.intervalSecs', trimmed)
      .then(() => {
        onMessage(`Scheduler checks every ${trimmed} s from now on.`);
      })
      .catch((err: unknown) => {
        onMessage(errorMessage(err));
      });
  };
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-end',
        marginTop: 10,
        flexWrap: 'wrap',
      }}
    >
      <div className="field" style={{ marginBottom: 0 }}>
        <label className="field-label" htmlFor="sched-interval">
          Scheduler checks every (seconds, 30–3600)
        </label>
        <input
          id="sched-interval"
          className="input"
          style={{ width: 140 }}
          type="number"
          min={30}
          max={3600}
          disabled={!loaded}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
          }}
        />
      </div>
      <button className="btn" disabled={!loaded} onClick={save}>
        Save interval
      </button>
    </div>
  );
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
  const [message, setMessage] = useState<string | null>(null);
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

  const defaultWorkflow = workflows[0]?.id ?? '';

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
        setMessage(errorMessage(err));
      });
  };

  const saveWatcher = (watcher: Watcher): void => {
    void getBackend()
      .saveWatcher(watcher)
      .then(() => {
        setEditingWatcher(null);
        setMessage(`Saved watcher '${watcher.name}'.`);
        reload();
      })
      .catch((err: unknown) => {
        setMessage(errorMessage(err));
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
        setMessage(errorMessage(err));
      });
  };

  const toggleBackground = (on: boolean): void => {
    void getBackend()
      .setSetting('background.mode', on ? '1' : '0')
      .then(() => refreshAutomations())
      .catch((err: unknown) => {
        setMessage(errorMessage(err));
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
            style={{ marginBottom: 12 }}
            onDismiss={() => {
              setMessage(null);
            }}
          >
            <span>{message}</span>{' '}
          </Notice>
        )}
        {!hintDismissed && (
          <Notice style={{ marginBottom: 16 }} onDismiss={dismissHint}>
            <span>
              Orchevia must be running for schedules and watchers to fire (background mode
              keeps it in the tray when windows close). New automations start{' '}
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
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <h3 style={{ margin: 0 }}>Background mode</h3>
            {backgroundMode && (
              <span className="status-pill status-running">background on</span>
            )}
          </div>
          <label
            className="field-hint"
            style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}
          >
            <input
              type="checkbox"
              checked={backgroundMode}
              onChange={(e) => {
                toggleBackground(e.target.checked);
              }}
            />
            Run in background when windows close (tray icon stays; Quit from tray)
          </label>
          <SchedulerInterval onMessage={setMessage} />
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
              className="tool-card profile-card"
              style={{ position: 'relative' }}
            >
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
                        setMessage(errorMessage(err));
                      });
                  });
                }}
              />
              <div className="profile-head">
                <div style={{ minWidth: 0 }}>
                  <h3 style={{ margin: 0 }}>{s.name}</h3>
                  <div className="profile-sub">
                    {workflowName(workflows, s.workflowId)}
                  </div>
                </div>
                <span
                  className={`status-pill ${s.enabled ? 'status-succeeded' : 'status-paused'}`}
                >
                  {s.enabled ? 'Enabled' : 'Disabled'}
                </span>
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
                    {s.nextRunAt !== undefined ? formatTime(s.nextRunAt) : '—'}
                  </dd>
                </div>
                <div>
                  <dt>Last run</dt>
                  <dd title={s.lastStatus ?? 'never'}>{s.lastStatus ?? 'never'}</dd>
                </div>
              </dl>
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
              className="tool-card profile-card"
              style={{ position: 'relative' }}
            >
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
                        setMessage(errorMessage(err));
                      });
                  });
                }}
              />
              <div className="profile-head">
                <div style={{ minWidth: 0 }}>
                  <h3 style={{ margin: 0 }}>{w.name}</h3>
                  <div className="profile-sub">
                    {workflowName(workflows, w.workflowId)}
                  </div>
                </div>
                <span
                  className={`status-pill ${w.enabled ? 'status-succeeded' : 'status-paused'}`}
                >
                  {w.enabled ? 'Enabled' : 'Disabled'}
                </span>
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
                  <dt>Last check</dt>
                  <dd title={w.lastCheckedAt ?? undefined}>
                    {w.lastCheckedAt !== undefined
                      ? formatTime(w.lastCheckedAt)
                      : 'never'}
                  </dd>
                </div>
              </dl>
              <div className="watcher-result" title={w.lastResult ?? 'never checked'}>
                <span className="field-label">Last result</span>
                <span>{w.lastResult ?? 'never checked'}</span>
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
          <Notice style={{ marginTop: 12 }}>
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
          prefs={notificationPrefs}
          unreadCount={unreadCount}
          onOpenInbox={() => {
            setView('inbox');
          }}
          onSaved={() => {
            void refreshAutomations();
          }}
        />
      </div>
    </>
  );
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
            <option value="local">local (system)</option>
            <option value="utc">utc</option>
            <option value="+01:00">+01:00</option>
            <option value="+02:00">+02:00</option>
            <option value="-05:00">-05:00</option>
            <option value="-08:00">-08:00</option>
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
        onChange({ kind: 'oneTime', at: new Date(Date.now() + 3600000).toISOString() });
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
          value={kind.at.slice(0, 16)}
          onChange={(e) =>
            onChange({ kind: 'oneTime', at: new Date(e.target.value).toISOString() })
          }
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
  if (!Number.isFinite(form.checkIntervalSecs) || form.checkIntervalSecs < 300)
    return ['Check interval must be at least 300 s (be kind to the API).'];
  if (
    (form.kind === 'prUpdated' || form.kind === 'feedback') &&
    !(form.prNumber !== undefined && form.prNumber > 0)
  )
    return ['PR-scoped watchers need a PR number above 0.'];
  return [];
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

function NotificationPrefsEditor({
  prefs,
  unreadCount,
  onOpenInbox,
  onSaved,
}: {
  prefs: NotificationPrefs | null;
  unreadCount: number;
  onOpenInbox: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const [form, setForm] = useState({
    onApproval: prefs?.onApproval ?? true,
    onFailure: prefs?.onFailure ?? true,
    onActionableFindings: prefs?.onActionableFindings ?? true,
    onScheduledSuccess: prefs?.onScheduledSuccess ?? false,
    onFeedbackNeedsAction: prefs?.onFeedbackNeedsAction ?? true,
  });
  const [osEnabled, setOsEnabled] = useState(false);
  const toggle = (key: keyof typeof form): void => {
    setForm((f) => ({ ...f, [key]: !f[key] }));
  };
  return (
    <section
      aria-label="Notification preferences"
      className="tool-card"
      style={{ marginTop: 20, maxWidth: 680 }}
    >
      <h3 style={{ marginTop: 0 }}>Notification preferences</h3>
      <p className="field-hint" style={{ marginTop: 0 }}>
        {unreadCount} unread — approvals, failures, and findings live in the{' '}
        <button className="btn btn-ghost" onClick={onOpenInbox}>
          Inbox →
        </button>
      </p>
      {(
        [
          ['onApproval', 'Approval needed'],
          ['onFailure', 'Workflow failed'],
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
      <label className="field-hint" style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <input
          type="checkbox"
          checked={osEnabled}
          onChange={(e) => {
            const on = e.target.checked;
            setOsEnabled(on);
            void getBackend()
              .setSetting('notifications.os', on ? '1' : '0')
              .catch(() => {});
          }}
        />
        Also send system desktop notifications (notify-send / Notification Center)
      </label>
      <button
        className="btn"
        style={{ marginTop: 8 }}
        onClick={() => {
          void getBackend()
            .setNotificationPrefs(form)
            .then(() => onSaved())
            .catch(() => {});
        }}
      >
        Save preferences
      </button>
    </section>
  );
}
