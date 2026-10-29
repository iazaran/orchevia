import { useRef, useState } from 'react';
import { Notice } from './Notice';
import { errorMessage } from '../lib/errors';
import { getBackend } from '../lib/backend';
import { formatDate, formatTime } from '../lib/time';
import { useAppStore } from '../store';

export function InboxView(): React.JSX.Element {
  const notifications = useAppStore((s) => s.notifications);
  const refreshNotifications = useAppStore((s) => s.refreshNotifications);
  const setView = useAppStore((s) => s.setView);
  const openRunInRuns = useAppStore((s) => s.openRunInRuns);
  const [showRead, setShowRead] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [markingAll, setMarkingAll] = useState(false);
  // Synchronous guard: duplicate clicks in the same tick must not both fire.
  const busyRef = useRef(new Set<number>());
  const visible = notifications.filter((n) => showRead || !n.read);

  const track = (id: number, busy: boolean): void => {
    if (busy) busyRef.current.add(id);
    else busyRef.current.delete(id);
    setPendingIds(new Set(busyRef.current));
  };

  const openRun = (notificationId: number, runId: string): void => {
    if (busyRef.current.has(notificationId)) return;
    track(notificationId, true);
    setMessage(null);
    void (async () => {
      try {
        // Mark read only after successful committed navigation; a late or
        // failed request leaves the notification unread.
        if (await openRunInRuns(runId)) {
          await getBackend().markNotificationRead(notificationId);
          await refreshNotifications();
        }
      } catch (err) {
        setMessage(errorMessage(err));
        if (useAppStore.getState().view !== 'inbox')
          useAppStore.getState().setError(errorMessage(err));
      } finally {
        track(notificationId, false);
      }
    })();
  };

  const markRead = (notificationId: number): void => {
    if (busyRef.current.has(notificationId)) return;
    track(notificationId, true);
    setMessage(null);
    void (async () => {
      try {
        await getBackend().markNotificationRead(notificationId);
        await refreshNotifications();
      } catch (err) {
        setMessage(errorMessage(err));
        if (useAppStore.getState().view !== 'inbox')
          useAppStore.getState().setError(errorMessage(err));
      } finally {
        track(notificationId, false);
      }
    })();
  };

  const unread = notifications.filter((n) => !n.read).length;

  const markAllRead = (): void => {
    if (markingAll) return;
    setMarkingAll(true);
    setMessage(null);
    void (async () => {
      try {
        await getBackend().markAllNotificationsRead();
        await refreshNotifications();
      } catch (err) {
        setMessage(errorMessage(err));
      } finally {
        setMarkingAll(false);
      }
    })();
  };

  return (
    <>
      <div className="topbar">
        <h1>Inbox</h1>
        <span className="topbar-sub">
          {unread} unread · approvals, failures, findings, feedback.
        </span>
        <div className="topbar-actions">
          <button className="btn" onClick={() => setShowRead(!showRead)}>
            {showRead ? 'Show unread' : 'Show read history'}
          </button>
          <button
            className="btn"
            disabled={markingAll || unread === 0}
            onClick={markAllRead}
          >
            {markingAll ? 'Marking…' : 'Mark all read'}
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
        <div className="inbox-list">
          {visible.slice(0, 100).map((n) => {
            const busy = pendingIds.has(n.id);
            const hasRun = n.runId !== undefined && n.runId !== '';
            return (
              <article
                key={n.id}
                className={`inbox-card${n.read ? ' is-read' : ''}`}
                aria-label={`${n.kind} notification: ${n.title}`}
              >
                <span className="inbox-kind">
                  <span className={`status-pill ${notificationPill(n.kind)}`}>
                    {n.kind}
                  </span>
                  {!n.read && (
                    <span className="inbox-unread" aria-label="Unread">
                      Unread
                    </span>
                  )}
                </span>
                <span className="inbox-content">
                  <div className="inbox-title">{n.title}</div>
                  <div className="wf-card-meta inbox-body">{n.body}</div>
                  {hasRun && (
                    <div className="wf-card-meta inbox-run-id" title={n.runId}>
                      Run {n.runId}
                    </div>
                  )}
                  <div className="wf-card-meta" title={formatTime(n.createdAt)}>
                    {formatDate(n.createdAt)}
                  </div>
                </span>
                <span className="inbox-actions">
                  {hasRun && (
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => {
                        const runId = n.runId;
                        if (runId === undefined || runId === '') return;
                        openRun(n.id, runId);
                      }}
                    >
                      {busy ? 'Opening…' : 'Open run'}
                    </button>
                  )}
                  {!n.read && (
                    <button
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() => markRead(n.id)}
                    >
                      Mark read
                    </button>
                  )}
                </span>
              </article>
            );
          })}
        </div>
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
