import { getBackend } from '../lib/backend';
import { formatDate, formatTime } from '../lib/time';
import { useAppStore } from '../store';

export function InboxView(): React.JSX.Element {
  const notifications = useAppStore((s) => s.notifications);
  const refreshNotifications = useAppStore((s) => s.refreshNotifications);
  const setView = useAppStore((s) => s.setView);
  const selectRun = useAppStore((s) => s.selectRun);
  const unread = notifications.filter((n) => !n.read).length;

  const markAllRead = (): void => {
    void getBackend()
      .markAllNotificationsRead()
      .then(() => refreshNotifications())
      .catch(() => {});
  };

  return (
    <>
      <div className="topbar">
        <h1>Inbox</h1>
        <span className="topbar-sub">
          {unread} unread · approvals, failures, findings, feedback.
        </span>
        <div className="topbar-actions">
          <button className="btn" onClick={markAllRead}>
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
        {notifications.length === 0 && (
          <div className="empty-state">
            <h2>All caught up</h2>
            <p>
              Runs that pause for approval, fail, or surface P0/P1 findings will notify
              you here. Schedules and watchers live under Automations.
            </p>
          </div>
        )}
        {notifications.slice(0, 100).map((n) => (
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
                onClick={() => {
                  void selectRun(n.runId as string).then(() => {
                    setView('runs');
                  });
                }}
              >
                Open run
              </button>
            )}
            {!n.read && (
              <button
                className="btn btn-ghost"
                onClick={() => {
                  void getBackend()
                    .markNotificationRead(n.id)
                    .then(() => refreshNotifications())
                    .catch(() => {});
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
