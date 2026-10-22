import { projectScope } from './memory';
import { hasFullAccess, referencedVariables } from './agents';
import type { AgentProfile } from './agents';
import type { Workflow } from './workflow';
import { formatTime } from './time';
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
  /** A due slot held back by the run limit; it still runs when capacity frees. */
  deferredSlot?: string | undefined;
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
  | 'readOnly'
  | 'localWrite'
  | 'repositoryMutation'
  | 'remoteWrite'
  | 'externalTool'
  | 'fullAccessAgent';

export const RISK_LABELS: Record<RiskCategory, string> = {
  readOnly: 'Read repository',
  localWrite: 'Modify local files',
  repositoryMutation: 'Create commits / branches',
  remoteWrite: 'Push / create or comment on PRs',
  externalTool: 'Invoke external tools (AI CLI / MCP)',
  fullAccessAgent: 'Run AI CLI with full access (permission checks bypassed)',
};

const RISK_ORDER: RiskCategory[] = [
  'readOnly',
  'localWrite',
  'repositoryMutation',
  'remoteWrite',
  'externalTool',
  'fullAccessAgent',
];

/**
 * Mirror of Rust `trust::workflow_risks_with_profiles`: the node mix plus
 * Agent nodes whose profile bypasses every permission check (a role-only
 * node counts every profile with that role).
 */
export function workflowRisks(
  workflow: Workflow,
  profiles: AgentProfile[],
): RiskCategory[] {
  const risks = new Set<RiskCategory>(['readOnly']);
  for (const node of workflow.nodes) {
    const config = node.config;
    switch (node.type) {
      case 'command':
        risks.add('localWrite');
        if (config.executable === 'git' && config.args?.[0] === 'push')
          risks.add('remoteWrite');
        break;
      case 'agent': {
        risks.add('localWrite');
        risks.add('externalTool');
        const id = (config.agentProfileId ?? '').trim();
        const candidates = profiles.filter((p) =>
          id !== ''
            ? p.id === id
            : config.agentRole !== undefined && p.role === config.agentRole,
        );
        if (candidates.some(hasFullAccess)) risks.add('fullAccessAgent');
        break;
      }
      case 'mcp':
      case 'ticket':
        risks.add('externalTool');
        break;
      case 'git':
        if (
          [
            'branchCreate',
            'checkout',
            'stage',
            'commit',
            'worktreeAdd',
            'worktreeRemove',
          ].includes(config.gitOp?.op ?? '')
        )
          risks.add('repositoryMutation');
        break;
      case 'github':
        if (['createPr', 'postComment'].includes(config.githubOp?.op ?? ''))
          risks.add('remoteWrite');
        break;
      default:
        break;
    }
  }
  return RISK_ORDER.filter((risk) => risks.has(risk));
}

/** Mirror of Rust `trust::may_enable_schedule`: the message, or `null` when allowed. */
export function scheduleTrustError(
  workflow: Workflow,
  profiles: AgentProfile[],
  trusted: boolean,
): string | null {
  const labels = workflowRisks(workflow, profiles)
    .filter((risk) => risk !== 'readOnly')
    .map((risk) => RISK_LABELS[risk]);
  if (labels.length === 0 || trusted) return null;
  return `Schedule needs explicit trust for: ${labels.join(', ')}. Review the workflow, then opt in.`;
}

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
      return `once at ${formatTime(kind.at)}`;
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

/** Value for an `<input type="datetime-local">`: the instant in local time. */
export function toLocalInputValue(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Parse a `datetime-local` value as local time; `null` when empty or invalid. */
export function fromLocalInputValue(value: string): string | null {
  if (value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** `utc`, `local`, or `±HH:MM` (hours 0–23); mirrors `parse_tz_offset`. */
export function validTimezone(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (lower === 'utc' || lower === 'local') return true;
  const match = /^[+-]?(\d+):(\d+)$/.exec(lower);
  if (match === null) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours <= 23 && minutes <= 59;
}

interface CronSpec {
  days: number[];
  months: number[];
  daysAny: boolean;
  weekdaysAny: boolean;
}

function parseCronField(text: string, min: number, max: number): number[] {
  const values: number[] = [];
  for (const raw of text.split(',')) {
    const part = raw.trim();
    const slash = part.indexOf('/');
    const range = slash === -1 ? part : part.slice(0, slash);
    let step = 1;
    if (slash !== -1) {
      const stepText = part.slice(slash + 1);
      if (!/^\d+$/.test(stepText))
        throw new Error(`Bad step '${stepText}' in '${text}'.`);
      step = Number(stepText);
      if (step === 0) throw new Error(`Step must be >= 1 in '${text}'.`);
    }
    let low: number;
    let high: number;
    const number = (value: string): number => {
      if (!/^\d+$/.test(value)) throw new Error(`Bad value '${value}' in '${text}'.`);
      return Number(value);
    };
    if (range === '*' || range === '') {
      [low, high] = [min, max];
    } else if (range.includes('-')) {
      const dash = range.indexOf('-');
      [low, high] = [number(range.slice(0, dash)), number(range.slice(dash + 1))];
      if (low > high) throw new Error(`Reversed range '${range}' in '${text}'.`);
    } else {
      low = high = number(range);
    }
    if (low < min || high > max)
      throw new Error(`Value out of range ${String(min)}-${String(max)} in '${text}'.`);
    for (let value = low; value <= high; value += step) values.push(value);
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

function parseCron(expr: string): CronSpec {
  const fields = expr.split(/\s+/).filter((field) => field !== '');
  const [minute, hour, day, month, weekday] = fields;
  if (
    fields.length !== 5 ||
    minute === undefined ||
    hour === undefined ||
    day === undefined ||
    month === undefined ||
    weekday === undefined
  )
    throw new Error('Cron needs 5 fields: minute hour day month weekday.');
  parseCronField(minute, 0, 59);
  parseCronField(hour, 0, 23);
  const spec = {
    days: parseCronField(day, 1, 31),
    months: parseCronField(month, 1, 12),
    daysAny: day.startsWith('*'),
    weekdaysAny: weekday.startsWith('*'),
  };
  parseCronField(weekday, 0, 7);
  return spec;
}

/** Mirrors `CronSpec::never_matches`: only day-of-month is restricted and no
 * chosen month has any of its days (`0 0 31 2 *`). */
function cronNeverMatches(spec: CronSpec): boolean {
  const longest = (month: number): number =>
    month === 2 ? 29 : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return (
    !spec.daysAny &&
    spec.weekdaysAny &&
    spec.months.every((month) => spec.days.every((day) => day > longest(month)))
  );
}

function validClock(hour: number, minute: number): boolean {
  return (
    Number.isInteger(hour) &&
    Number.isInteger(minute) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59
  );
}

/** Mirrors `Schedule::validate` (same messages), so the browser mock refuses
 * what the desktop app refuses. */
export function validateSchedule(schedule: Schedule): string[] {
  const errors: string[] = [];
  if (schedule.id.trim() === '') errors.push('Schedule id must not be empty.');
  if (schedule.name.trim() === '') errors.push('Schedule name must not be empty.');
  if (schedule.workflowId.trim() === '') errors.push('Schedule needs a workflow.');
  if (!validTimezone(schedule.timezone))
    errors.push("Timezone must be 'utc', 'local', or '±HH:MM'.");
  const kind = schedule.kind;
  switch (kind.kind) {
    case 'oneTime':
      break;
    case 'interval':
      if (
        !Number.isInteger(kind.everySecs) ||
        kind.everySecs < 60 ||
        kind.everySecs > 2592000
      )
        errors.push('Interval must be 60 s – 30 days.');
      break;
    case 'daily':
      if (!validClock(kind.hour, kind.minute))
        errors.push('Daily time must be a valid HH:MM.');
      break;
    case 'weekly':
      if (!validClock(kind.hour, kind.minute))
        errors.push('Weekly time must be a valid HH:MM.');
      break;
    case 'cron':
      try {
        if (cronNeverMatches(parseCron(kind.expr)))
          throw new Error('Cron never matches: no chosen month has that day.');
      } catch (err) {
        errors.push(`Invalid cron: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
  }
  return errors;
}

function sameKind(a: ScheduleKind, b: ScheduleKind): boolean {
  switch (a.kind) {
    case 'oneTime':
      return b.kind === 'oneTime' && Date.parse(a.at) === Date.parse(b.at);
    case 'interval':
      return b.kind === 'interval' && a.everySecs === b.everySecs;
    case 'daily':
      return b.kind === 'daily' && a.hour === b.hour && a.minute === b.minute;
    case 'weekly':
      return (
        b.kind === 'weekly' &&
        a.weekday === b.weekday &&
        a.hour === b.hour &&
        a.minute === b.minute
      );
    case 'cron':
      return b.kind === 'cron' && a.expr === b.expr;
  }
}

/** Mirrors `Schedule::prepare_save`: run bookkeeping comes from the stored
 * copy; the slot is kept only while the schedule stays enabled with the same
 * timing. The desktop app then computes a fresh slot; the browser mock
 * computes none, so it leaves `nextRunAt` empty. */
export function prepareScheduleSave(schedule: Schedule, previous?: Schedule): Schedule {
  const next: Schedule = { ...schedule };
  delete next.nextRunAt;
  delete next.deferredSlot;
  if (previous !== undefined) {
    delete next.lastRunAt;
    delete next.lastStatus;
    if (previous.lastRunAt !== undefined) next.lastRunAt = previous.lastRunAt;
    if (previous.lastStatus !== undefined) next.lastStatus = previous.lastStatus;
    const keep =
      schedule.enabled &&
      previous.enabled &&
      schedule.timezone === previous.timezone &&
      sameKind(schedule.kind, previous.kind);
    if (keep && previous.nextRunAt !== undefined) next.nextRunAt = previous.nextRunAt;
    if (keep && previous.deferredSlot !== undefined)
      next.deferredSlot = previous.deferredSlot;
  }
  return next;
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
