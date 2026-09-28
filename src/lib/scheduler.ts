/**
 * Automation types (TypeScript mirror of `orchevia-core` schedule/notify/trust).
 */

export type MissedPolicy = 'skip' | 'runOnce';

export type ScheduleKind =
  | { kind: 'oneTime'; at: string }
  | { kind: 'interval'; everySecs: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: WeekdayDto; hour: number; minute: number }
  | { kind: 'cron'; expr: string };

export type WeekdayDto = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export const WEEKDAYS: WeekdayDto[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export interface Schedule {
  id: string;
  name: string;
  workflowId: string;
  kind: ScheduleKind;
  timezone: string;
  enabled: boolean;
  trusted: boolean;
  missedPolicy: MissedPolicy;
  lastRunAt?: string | undefined;
  nextRunAt?: string | undefined;
  lastStatus?: string | undefined;
}

export type WatcherKind = 'reviewRequested' | 'prUpdated' | 'feedback';

export interface Watcher {
  id: string;
  name: string;
  workflowId: string;
  kind: WatcherKind;
  repoDir: string;
  prNumber?: number | undefined;
  enabled: boolean;
  checkIntervalSecs: number;
  lastHeadSha?: string | undefined;
  lastCheckedAt?: string | undefined;
  lastResult?: string | undefined;
}

export interface Notification {
  id: number;
  kind: string;
  title: string;
  body: string;
  runId?: string | undefined;
  createdAt: string;
  read: boolean;
}

export interface NotificationPrefs {
  onApproval: boolean;
  onFailure: boolean;
  onActionableFindings: boolean;
  onScheduledSuccess: boolean;
  onFeedbackNeedsAction: boolean;
}

export type RiskCategory =
  'readOnly' | 'localWrite' | 'repositoryMutation' | 'remoteWrite' | 'externalTool';

export const RISK_LABELS: Record<RiskCategory, string> = {
  readOnly: 'Read repository',
  localWrite: 'Modify local files',
  repositoryMutation: 'Create commits / branches',
  remoteWrite: 'Push / create or comment on PRs',
  externalTool: 'Invoke external tools (AI CLI / MCP)',
};

export interface GroupedFinding {
  finding: {
    severity: string;
    category: string;
    title: string;
    explanation: string;
    file?: string | undefined;
    lineStart?: number | undefined;
    lineEnd?: number | undefined;
    confidence?: string | undefined;
    source: string;
    suggestedFix?: string | undefined;
    fingerprint: string;
  };
  sources: string[];
}

export function newScheduleId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}${rand}`;
}

export function describeScheduleKind(kind: ScheduleKind): string {
  switch (kind.kind) {
    case 'oneTime':
      return `once at ${kind.at}`;
    case 'interval':
      return `every ${String(kind.everySecs)}s`;
    case 'daily':
      return `daily ${String(kind.hour).padStart(2, '0')}:${String(kind.minute).padStart(2, '0')}`;
    case 'weekly':
      return `${kind.weekday} ${String(kind.hour).padStart(2, '0')}:${String(kind.minute).padStart(2, '0')}`;
    case 'cron':
      return `cron ${kind.expr}`;
  }
}
