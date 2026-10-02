import { useState } from 'react';
import { Notice } from './Notice';
import { errorMessage } from '../lib/errors';
import { getBackend } from '../lib/backend';
import { formatDate, formatTime } from '../lib/time';
import { useAppStore } from '../store';

export function InboxView(): React.JSX.Element {
  const notifications = useAppStore((s) => s.notifications);
  const refreshNotifications = useAppStore((s) => s.refreshNotifications);
  const setView = useAppStore((s) => s.setView);
  const openRun = useAppStore((s) => s.openRunOnCanvas);
  const [showRead, setShowRead] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const visible = notifications.filter((n) => showRead || !n.read);
  const act = async (action: () => Promise<unknown>): Promise<void> => {
    if (pending) return;
    setPending(true);
    setMessage(null);
    try {
      await action();
      await refreshNotifications();
    } catch (err) {
      setMessage(errorMessage(err));
      if (useAppStore.getState().view !== 'inbox')
        useAppStore.getState().setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };
  const unread = notifications.filter((n) => !n.read).length;

  const markAllRead = (): void => {
    void act(() => getBackend().markAllNotificationsRead());
  };

  return (
    <>
      <div className="topbar">
        <h1>Inbox</h1>
        <span className="topbar-sub">
          {unread} unread · approvals, failures, findings, feedback.
        </span>
        <div className="topbar-actions">
          <button
            className="btn"
            aria-pressed={showRead}
            onClick={() => setShowRead(!showRead)}
          >
            {showRead ? 'Show unread' : 'Show read history'}
          </button>
          <button
            className="btn"
            disabled={pending || unread === 0}
            onClick={markAllRead}
          >
            Mark all read
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setView('automations');
            }}
          >
            Automations →
          </button>
        </div>
      </div>
      <div className="view">
        {message !== null && <Notice variant="error">{message}</Notice>}
        {visible.length === 0 && (
          <div className="empty-state">
            <h2>All caught up</h2>
            <p>
              Runs that pause for approval, fail, or surface P0/P1 findings will notify
              you here. Schedules and watchers live under Automations.
            </p>
          </div>
        )}
        {visible.slice(0, 100).map((n) => (
          <div key={n.id} className="run-row" style={{ opacity: n.read ? 0.65 : 1 }}>
            <span className={`status-pill ${notificationPill(n.kind)}`}>{n.kind}</span>
            <span style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{n.title}</div>
              <div className="wf-card-meta">{n.body}</div>
              <div className="wf-card-meta" title={formatTime(n.createdAt)}>
                {formatDate(n.createdAt)}
              </div>
            </span>
            {n.runId !== undefined && n.runId !== '' && (
              <button
                className="btn"
                disabled={pending}
                onClick={() => {
                  const runId = n.runId;
                  if (runId === undefined) return;
                  void act(async () => {
                    await openRun(runId);
                    if (useAppStore.getState().overlayRunId === runId)
                      await getBackend().markNotificationRead(n.id);
                  });
                }}
              >
                Open run
              </button>
            )}
            {!n.read && (
              <button
                className="btn btn-ghost"
                disabled={pending}
                onClick={() => {
                  void act(() => getBackend().markNotificationRead(n.id));
                }}
              >
                Mark read
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function notificationPill(kind: string): string {
  switch (kind) {
    case 'failure':
      return 'status-failed';
    case 'success':
      return 'status-succeeded';
    case 'approval':
    case 'feedback':
      return 'status-paused';
    default:
      return 'status-cancelled';
  }
}
