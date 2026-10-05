import { projectScope } from './memory';
import { referencedVariables } from './agents';
import type { AgentProfile } from './agents';
import type { Workflow } from './workflow';
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

/** Next eligible check; the scheduler may run it on its next wake/tick. */
export function watcherNextCheck(watcher: Watcher): string | undefined {
  if (!watcher.enabled || watcher.lastCheckedAt === undefined) return undefined;
  const last = Date.parse(watcher.lastCheckedAt);
  if (!Number.isFinite(last)) return undefined;
  return new Date(last + Math.max(300, watcher.checkIntervalSecs) * 1000).toISOString();
}

export function validateWatcher(watcher: Watcher): string[] {
  const errors: string[] = [];
  if (watcher.id.trim() === '') errors.push('Watcher id must not be empty.');
  if (watcher.name.trim() === '') errors.push('Watcher name must not be empty.');
  if (watcher.workflowId.trim() === '') errors.push('Watcher needs a workflow.');
  if (watcher.repoDir.trim() === '') errors.push('Watcher needs a repository directory.');
  if (
    !Number.isInteger(watcher.checkIntervalSecs) ||
    watcher.checkIntervalSecs < 300 ||
    watcher.checkIntervalSecs > 2592000
  )
    errors.push('Watcher interval must be 300 s to 30 days (be kind to the API).');
  if (
    watcher.prNumber !== undefined &&
    (!Number.isInteger(watcher.prNumber) || watcher.prNumber <= 0)
  )
    errors.push('PR number must be above 0.');
  if (
    (watcher.kind === 'prUpdated' || watcher.kind === 'feedback') &&
    watcher.prNumber === undefined
  )
    errors.push('PR-scoped watchers need a PR number.');
  return errors;
}

export function prepareWatcherSave(watcher: Watcher, previous?: Watcher): Watcher {
  const next = { ...watcher };
  if (previous !== undefined) {
    if (
      watcher.repoDir === previous.repoDir &&
      watcher.workflowId === previous.workflowId &&
      watcher.kind === previous.kind &&
      watcher.prNumber === previous.prNumber
    ) {
      next.lastHeadSha = previous.lastHeadSha;
      next.lastCheckedAt = previous.lastCheckedAt;
      next.lastResult = previous.lastResult;
      if (watcher.enabled && !previous.enabled) {
        delete next.lastCheckedAt;
        next.lastResult = 'waiting: first check after enabling';
      }
    } else {
      delete next.lastHeadSha;
      delete next.lastCheckedAt;
      delete next.lastResult;
    }
  }
  return next;
}

function consumesPrTemplate(value: unknown): boolean {
  if (typeof value === 'string')
    return referencedVariables(value).includes('input.prNumber');
  if (Array.isArray(value)) return value.some(consumesPrTemplate);
  if (typeof value === 'object' && value !== null)
    return Object.values(value).some(consumesPrTemplate);
  return false;
}

export function workflowConsumesPrNumber(workflow: Workflow): boolean {
  const start = workflow.nodes.find((node) => node.type === 'start');
  const pending = start === undefined ? [] : [start.id];
  const reachable = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || reachable.has(current)) continue;
    reachable.add(current);
    for (const edge of workflow.edges)
      if (edge.source === current) pending.push(edge.target);
  }
  return workflow.nodes.some((node) => {
    if (!reachable.has(node.id)) return false;
    const config = node.config;
    const op = config.githubOp;
    if (node.type === 'github' && op !== undefined && 'number' in op && op.number === 0)
      return true;
    switch (node.type) {
      case 'condition':
        return (
          config.condition?.clauses.some((clause) => clause.left === 'input.prNumber') ===
          true
        );
      case 'command':
        return consumesPrTemplate(config.args);
      case 'agent':
        return consumesPrTemplate(config.prompt);
      case 'mcp':
        return consumesPrTemplate(config.mcpArgs);
      case 'ticket':
        return consumesPrTemplate(config.ticketKey);
      case 'git':
        return config.gitOp?.op !== 'stage' && consumesPrTemplate(config.gitOp);
      case 'github':
        return op?.op !== 'listPrs' && consumesPrTemplate(op);
      default:
        return false;
    }
  });
}

/** Browser mock mirrors declared directory checks; native resolves Git roots and symlinks. */
export function validateWatcherScope(
  workflow: Workflow,
  watcher: Watcher,
  profiles: AgentProfile[],
): string[] {
  const expected = projectScope(watcher.repoDir);
  for (const node of workflow.nodes) {
    const explicit = node.config.workingDir?.trim() || undefined;
    const fallback = workflow.defaults?.repoDir?.trim() || undefined;
    let directory: string | undefined;
    if (node.type === 'git' || node.type === 'github' || node.type === 'command')
      directory = explicit ?? fallback;
    else if (node.type === 'agent') {
      const profile = profiles.find(
        (profile) => profile.id === node.config.agentProfileId,
      );
      if (profile?.workingDirMode === 'node') directory = explicit;
      else if (profile?.workingDirMode === 'profile') directory = profile.workingDir;
    }
    if (directory !== undefined && projectScope(directory) !== expected)
      return [
        `Watcher repository does not match workflow node '${node.id}'. Set its working directory (or applicable workflow/profile default) to the watched repository.`,
      ];
    if (directory === undefined && (node.type === 'git' || node.type === 'github'))
      return [
        `Workflow node '${node.id}' needs a repository directory matching the watcher; input.repoDir does not override directories.`,
      ];
  }
  return [];
}
