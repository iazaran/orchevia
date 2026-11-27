import { describe, expect, it } from 'vitest';
import {
  activityByDay,
  attentionItems,
  formatSpan,
  localDay,
  mergeActiveRuns,
  monthToDateFilter,
  upcomingAutomations,
  weekDelta,
  weekStats,
} from './dashboard';
import type { Notification, Schedule, Watcher } from './scheduler';
import { createEmptyWorkflow, type StoredRun, type StoredWorkflow } from './workflow';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Midday local time, so "today" and "yesterday" never straddle midnight.
const NOW = new Date(2026, 10, 27, 12, 0, 0).getTime();

function run(
  id: string,
  status: StoredRun['status'],
  startedAgo: number,
  tookMs?: number,
  workflowId = `wf-${id}`,
): StoredRun {
  const started = NOW - startedAgo;
  return {
    id,
    workflowId,
    status,
    startedAt: new Date(started).toISOString(),
    ...(tookMs === undefined
      ? {}
      : { finishedAt: new Date(started + tookMs).toISOString() }),
  };
}

function stored(id: string, name: string): StoredWorkflow {
  const definition = createEmptyWorkflow(name);
  return { id, name, definition, createdAt: '', updatedAt: '' };
}

describe('activityByDay', () => {
  it('keeps every day of the window, today last, and sorts runs by outcome', () => {
    const days = activityByDay(
      [
        run('a', 'succeeded', HOUR, 1000),
        run('b', 'failed', 2 * HOUR, 1000),
        run('c', 'cancelled', DAY, 1000),
        run('d', 'paused', DAY),
        run('old', 'succeeded', 20 * DAY, 1000),
      ],
      NOW,
      14,
    );
    expect(days).toHaveLength(14);
    expect(days[13]).toEqual({ day: localDay(NOW), succeeded: 1, failed: 1, other: 0 });
    expect(days[12]).toEqual({
      day: localDay(NOW - DAY),
      succeeded: 0,
      failed: 0,
      other: 2,
    });
    // The 20-day-old run is outside the window; empty days stay as zeros.
    expect(days.slice(0, 12).every((d) => d.succeeded + d.failed + d.other === 0)).toBe(
      true,
    );
    expect(new Set(days.map((d) => d.day)).size).toBe(14);
  });

  it('ignores runs with an unreadable start', () => {
    const broken = { ...run('x', 'succeeded', HOUR), startedAt: 'soon' };
    expect(activityByDay([broken], NOW, 3).every((d) => d.succeeded === 0)).toBe(true);
  });
});

describe('weekStats', () => {
  it('counts this week against last week and rates finished runs only', () => {
    const stats = weekStats(
      [
        run('a', 'succeeded', HOUR, 10 * 60_000),
        run('b', 'succeeded', 2 * DAY, 5 * 60_000),
        run('c', 'failed', 3 * DAY, 60_000),
        run('d', 'cancelled', 4 * DAY, 60_000),
        run('e', 'running', 10 * 60_000),
        run('last-week', 'succeeded', 8 * DAY, 60_000),
        run('too-old', 'succeeded', 15 * DAY, 60_000),
      ],
      NOW,
    );
    expect(stats.runs).toBe(5);
    expect(stats.previousRuns).toBe(1);
    expect(stats.finished).toBe(3);
    expect(stats.succeeded).toBe(2);
    expect(stats.successRate).toBe(67);
    // Finished runs only: 10 + 5 + 1 + 1 minutes; the running one has no end.
    expect(stats.runTimeMs).toBe(17 * 60_000);
  });

  it('counts the same 7 calendar days as the chart’s last seven bars', () => {
    // Early on the 7th day back counts; late on the 8th day back does not,
    // though both are less than 7 × 24 h before a late-evening "now".
    const evening = new Date(2026, 10, 27, 23, 0, 0).getTime();
    const sixDaysBackMorning = new Date(2026, 10, 21, 1, 0, 0).toISOString();
    const sevenDaysBackNight = new Date(2026, 10, 20, 23, 30, 0).toISOString();
    const stats = weekStats(
      [
        { status: 'succeeded', startedAt: sixDaysBackMorning },
        { status: 'succeeded', startedAt: sevenDaysBackNight },
      ],
      evening,
    );
    expect(stats.runs).toBe(1);
    expect(stats.previousRuns).toBe(1);
    const chart = activityByDay(
      [{ status: 'succeeded', startedAt: sixDaysBackMorning }],
      evening,
    ).slice(-7);
    expect(chart.reduce((sum, day) => sum + day.succeeded, 0)).toBe(stats.runs);
  });

  it('has no success rate without a finished run', () => {
    expect(weekStats([run('a', 'running', HOUR)], NOW).successRate).toBeNull();
  });

  it('describes the change against last week', () => {
    const base = weekStats([], NOW);
    expect(weekDelta(base)).toBeNull();
    expect(weekDelta({ ...base, runs: 5, previousRuns: 2 })).toEqual({
      text: '+3 vs the 7 days before',
      trend: 'up',
    });
    expect(weekDelta({ ...base, runs: 1, previousRuns: 4 })).toEqual({
      text: '−3 vs the 7 days before',
      trend: 'down',
    });
    expect(weekDelta({ ...base, runs: 2, previousRuns: 2 })?.trend).toBe('flat');
  });
});

describe('upcomingAutomations', () => {
  const schedule = (id: string, at: string | undefined, enabled = true): Schedule => ({
    id,
    name: `Schedule ${id}`,
    workflowId: 'wf',
    kind: { kind: 'daily', hour: 9, minute: 0 },
    timezone: 'UTC',
    enabled,
    trusted: true,
    missedPolicy: 'skip',
    ...(at === undefined ? {} : { nextRunAt: at }),
  });
  const watcher: Watcher = {
    id: 'w',
    name: 'PR watcher',
    workflowId: 'missing',
    kind: 'prUpdated',
    repoDir: '/repo',
    enabled: true,
    checkIntervalSecs: 300,
    lastCheckedAt: new Date(NOW - 60_000).toISOString(),
  };

  it('lists enabled schedules and watchers, soonest first, with workflow names', () => {
    const items = upcomingAutomations(
      [
        schedule('late', new Date(NOW + 5 * HOUR).toISOString()),
        schedule('soon', new Date(NOW + HOUR).toISOString()),
        schedule('off', new Date(NOW + 10 * 60_000).toISOString(), false),
        schedule('never', undefined),
      ],
      [watcher, { ...watcher, id: 'unchecked', lastCheckedAt: undefined }],
      [stored('wf', 'Daily digest')],
    );
    expect(items.map((i) => i.id)).toEqual(['w', 'soon', 'late']);
    expect(items[0]).toMatchObject({ kind: 'watcher', workflowName: 'missing' });
    expect(items[1]).toMatchObject({ kind: 'schedule', workflowName: 'Daily digest' });
  });

  it('keeps only the first few', () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      schedule(String(i), new Date(NOW + (i + 1) * HOUR).toISOString()),
    );
    expect(upcomingAutomations(many, [], [], 3)).toHaveLength(3);
  });
});

describe('attentionItems', () => {
  const note = (
    id: number,
    kind: string,
    runId?: string,
    read = false,
  ): Notification => ({
    id,
    kind,
    title: kind,
    body: '',
    createdAt: new Date(NOW - id * 60_000).toISOString(),
    read,
    ...(runId === undefined ? {} : { runId }),
  });

  it('leaves out entries that only inform and failures already run again', () => {
    const runs = [
      run('retried-ok', 'succeeded', HOUR, 1000, 'digest'),
      run('retried', 'failed', 2 * HOUR, 1000, 'digest'),
      run('alone', 'failed', 3 * HOUR, 1000, 'report'),
    ];
    const { items } = attentionItems(
      runs,
      [note(1, 'success'), note(2, 'schedule-started'), note(3, 'feedback')],
      NOW,
    );
    expect(
      items.map((i) =>
        i.kind === 'notice' ? `notice:${i.notification.kind}` : `${i.kind}:${i.run.id}`,
      ),
    ).toEqual(['notice:feedback', 'failed:alone']);
  });

  it('puts waiting runs first and never lists one run twice', () => {
    const runs = [
      run('wait', 'paused', HOUR),
      run('fail-noted', 'failed', 2 * HOUR, 1000),
      run('fail-today', 'failed', 3 * HOUR, 1000),
      run('fail-old', 'failed', 3 * DAY, 1000),
    ];
    const { items, total } = attentionItems(
      runs,
      [
        note(1, 'approval', 'wait'),
        note(2, 'failure', 'fail-noted'),
        note(3, 'findings'),
        note(4, 'success', undefined, true),
        note(5, 'update'),
      ],
      NOW,
    );
    expect(
      items.map((i) =>
        i.kind === 'notice'
          ? `notice:${String(i.notification.id)}`
          : `${i.kind}:${i.run.id}`,
      ),
    ).toEqual(['waiting:wait', 'notice:3', 'notice:2', 'failed:fail-today']);
    expect(total).toBe(4);
  });

  it('hands back what did not fit, so Home can say where it is', () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      run(`w${String(i)}`, 'paused', HOUR),
    );
    const { items, rest, total } = attentionItems(
      runs,
      [note(1, 'findings'), note(2, 'watcher-error')],
      NOW,
      4,
    );
    expect(items).toHaveLength(4);
    expect(total).toBe(7);
    expect(rest.map((i) => i.kind)).toEqual(['waiting', 'notice', 'notice']);
  });
});

describe('mergeActiveRuns', () => {
  it('adds active runs the recent list misses and keeps the recent row of a run in both', () => {
    const recent = [run('a', 'succeeded', HOUR, 1000), run('b', 'running', 2 * HOUR)];
    const active = [run('b', 'paused', 2 * HOUR), run('old', 'paused', 3 * DAY)];
    const merged = mergeActiveRuns(recent, active);
    expect(merged.map((r) => `${r.id}:${r.status}`)).toEqual([
      'a:succeeded',
      'b:running',
      'old:paused',
    ]);
    expect(mergeActiveRuns(recent, [])).toBe(recent);
  });
});

describe('helpers', () => {
  it('asks for the UTC month so far, through the end of today', () => {
    const now = Date.UTC(2026, 10, 27, 15, 30);
    expect(monthToDateFilter(now)).toEqual({
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-28T00:00:00.000Z',
    });
    expect(monthToDateFilter(Date.UTC(2026, 11, 31, 23, 0)).to).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('formats spans compactly', () => {
    expect(formatSpan(0)).toBe('0m');
    expect(formatSpan(40_000)).toBe('40s');
    expect(formatSpan(45 * 60_000)).toBe('45m');
    expect(formatSpan(2 * HOUR)).toBe('2h');
    expect(formatSpan(2 * HOUR + 16 * 60_000)).toBe('2h 16m');
    expect(formatSpan(Number.NaN)).toBe('0m');
  });
});
