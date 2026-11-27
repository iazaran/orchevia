/**
 * What Home's dashboard shows. Pure functions, so the numbers on Home are
 * tested without rendering it. Counts over a window take `RunStamp`s from
 * `Backend.runStamps` (every run in the window), never the store's capped
 * recent list.
 */
import type { Notification, Schedule, Watcher } from './scheduler';
import { watcherNextCheck } from './scheduler';
import type { RunStatus, StoredRun, StoredWorkflow } from './workflow';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A run's outcome and times (Rust `db::RunStamp`); a `StoredRun` is one too. */
export interface RunStamp {
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
}

/** Days Home's figures and chart look back over (two weeks of local days). */
export const DASHBOARD_DAYS = 14;

/** Local midnight `days` calendar days before the day of `now`. */
export function localDayStart(now: number, daysBack: number): number {
  const date = new Date(now);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - daysBack,
  ).getTime();
}

/** The local calendar day of a time, as `YYYY-MM-DD`. */
export function localDay(time: number): string {
  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear())}-${month}-${day}`;
}

export interface ActivityDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  succeeded: number;
  failed: number;
  /** Cancelled, running or waiting runs started that day. */
  other: number;
}

/**
 * Runs started on each of the last `days` local days (today last), by
 * outcome. Days without runs are kept, so the chart has no gaps.
 */
export function activityByDay(
  runs: RunStamp[],
  now: number,
  days = DASHBOARD_DAYS,
): ActivityDay[] {
  const out: ActivityDay[] = [];
  const index = new Map<string, ActivityDay>();
  const today = new Date(now);
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    // Step by calendar day, not 24 h, so a daylight-saving change never
    // repeats or skips a day.
    const date = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - offset,
    );
    const entry = { day: localDay(date.getTime()), succeeded: 0, failed: 0, other: 0 };
    out.push(entry);
    index.set(entry.day, entry);
  }
  for (const run of runs) {
    const started = Date.parse(run.startedAt);
    if (!Number.isFinite(started)) continue;
    const entry = index.get(localDay(started));
    if (entry === undefined) continue;
    if (run.status === 'succeeded') entry.succeeded += 1;
    else if (run.status === 'failed') entry.failed += 1;
    else entry.other += 1;
  }
  return out;
}

export interface WeekStats {
  /** Runs started over the last 7 local calendar days, today included. */
  runs: number;
  /** Runs started over the 7 calendar days before those. */
  previousRuns: number;
  /** Of this week's runs, those that finished (succeeded or failed). */
  finished: number;
  succeeded: number;
  /** Percent of finished runs that succeeded; null when none finished. */
  successRate: number | null;
  /** Wall-clock time of this week's finished runs, waits for approval included. */
  runTimeMs: number;
}

/**
 * The last 7 local calendar days (today and the 6 before, the same days as
 * the chart's last seven bars) against the 7 before them.
 */
export function weekStats(runs: RunStamp[], now: number): WeekStats {
  const weekStart = localDayStart(now, 6);
  const previousStart = localDayStart(now, 13);
  const stats: WeekStats = {
    runs: 0,
    previousRuns: 0,
    finished: 0,
    succeeded: 0,
    successRate: null,
    runTimeMs: 0,
  };
  for (const run of runs) {
    const started = Date.parse(run.startedAt);
    if (!Number.isFinite(started) || started > now || started < previousStart) continue;
    if (started < weekStart) {
      stats.previousRuns += 1;
      continue;
    }
    stats.runs += 1;
    if (run.status === 'succeeded' || run.status === 'failed') {
      stats.finished += 1;
      if (run.status === 'succeeded') stats.succeeded += 1;
    }
    const finished = run.finishedAt === undefined ? NaN : Date.parse(run.finishedAt);
    if (Number.isFinite(finished) && finished >= started)
      stats.runTimeMs += finished - started;
  }
  if (stats.finished > 0)
    stats.successRate = Math.round((100 * stats.succeeded) / stats.finished);
  return stats;
}

/** "+3 vs the 7 days before" style change; null when there is nothing to compare. */
export function weekDelta(
  stats: WeekStats,
): { text: string; trend: 'up' | 'down' | 'flat' } | null {
  if (stats.runs === 0 && stats.previousRuns === 0) return null;
  const diff = stats.runs - stats.previousRuns;
  if (diff === 0) return { text: 'Same as the 7 days before', trend: 'flat' };
  return {
    text: `${diff > 0 ? '+' : '−'}${String(Math.abs(diff))} vs the 7 days before`,
    trend: diff > 0 ? 'up' : 'down',
  };
}

export interface UpcomingItem {
  kind: 'schedule' | 'watcher';
  id: string;
  name: string;
  workflowName: string;
  /** When it next starts (schedule) or checks GitHub (watcher). */
  at: string;
}

/** Enabled schedules and watchers, soonest first. */
export function upcomingAutomations(
  schedules: Schedule[],
  watchers: Watcher[],
  workflows: StoredWorkflow[],
  limit = 4,
): UpcomingItem[] {
  const names = new Map(workflows.map((w) => [w.id, w.name]));
  const items: UpcomingItem[] = [];
  for (const schedule of schedules) {
    if (!schedule.enabled || schedule.nextRunAt === undefined) continue;
    if (!Number.isFinite(Date.parse(schedule.nextRunAt))) continue;
    items.push({
      kind: 'schedule',
      id: schedule.id,
      name: schedule.name,
      workflowName: names.get(schedule.workflowId) ?? schedule.workflowId,
      at: schedule.nextRunAt,
    });
  }
  for (const watcher of watchers) {
    if (!watcher.enabled) continue;
    const at = watcherNextCheck(watcher);
    if (at === undefined || !Number.isFinite(Date.parse(at))) continue;
    items.push({
      kind: 'watcher',
      id: watcher.id,
      name: watcher.name,
      workflowName: names.get(watcher.workflowId) ?? watcher.workflowId,
      at,
    });
  }
  return items
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * The recent list plus active runs it no longer reaches. A run in both keeps
 * its recent-list row: the two are read together, and the recent row is the
 * one Runs shows.
 */
export function mergeActiveRuns(runs: StoredRun[], activeRuns: StoredRun[]): StoredRun[] {
  const listed = new Set(runs.map((run) => run.id));
  const older = activeRuns.filter((run) => !listed.has(run.id));
  return older.length === 0 ? runs : [...runs, ...older];
}

export type AttentionItem =
  | { kind: 'waiting'; run: StoredRun }
  | { kind: 'failed'; run: StoredRun }
  | { kind: 'notice'; notification: Notification };

/** Inbox kinds that only inform: they never need the user on Home. */
const INFORMATIONAL_KINDS = new Set(['success', 'schedule-started', 'update']);

/**
 * What needs the user, most urgent first: runs waiting for a decision, then
 * unread Inbox entries that ask for something, then failures from the last
 * 24 hours the Inbox does not already list and no newer run of the same
 * workflow has followed. Each run is listed once. `rest` holds what did not
 * fit in `limit`.
 */
export function attentionItems(
  runs: StoredRun[],
  notifications: Notification[],
  now: number,
  limit = 5,
): { items: AttentionItem[]; rest: AttentionItem[]; total: number } {
  const items: AttentionItem[] = [];
  const listedRuns = new Set<string>();
  for (const run of runs)
    if (run.status === 'paused') {
      items.push({ kind: 'waiting', run });
      listedRuns.add(run.id);
    }
  const unread = notifications
    .filter((n) => !n.read && !INFORMATIONAL_KINDS.has(n.kind))
    .sort((a, b) => b.id - a.id);
  for (const notification of unread) {
    if (notification.runId !== undefined) {
      if (listedRuns.has(notification.runId)) continue;
      listedRuns.add(notification.runId);
    }
    items.push({ kind: 'notice', notification });
  }
  for (const run of runs) {
    if (run.status !== 'failed' || listedRuns.has(run.id)) continue;
    const at = Date.parse(run.finishedAt ?? run.startedAt);
    if (!Number.isFinite(at) || now - at >= DAY_MS) continue;
    // Run again since (retried, recovered or simply rerun): already handled.
    if (
      runs.some(
        (other) =>
          other.workflowId === run.workflowId &&
          Date.parse(other.startedAt) > Date.parse(run.startedAt),
      )
    )
      continue;
    items.push({ kind: 'failed', run });
    listedRuns.add(run.id);
  }
  return { items: items.slice(0, limit), rest: items.slice(limit), total: items.length };
}

/** The UTC month so far as a usage filter (plan costs are counted per UTC day). */
export function monthToDateFilter(now: number): { from: string; to: string } {
  const date = new Date(now);
  const from = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const to = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1),
  );
  return { from: from.toISOString(), to: to.toISOString() };
}

/** "3h 12m", "45m", "40s": a compact length of time. */
export function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const minutes = Math.floor(ms / 60_000);
  if (minutes === 0) return `${String(Math.max(1, Math.round(ms / 1000)))}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${String(minutes)}m`;
  const rest = minutes % 60;
  return rest === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(rest)}m`;
}
