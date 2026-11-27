import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { Icon, type IconName } from './Icon';
import { formatRelative, formatTime } from '../lib/time';
import {
  TEMPLATE_DOMAINS,
  templateDomain,
  type TemplateDomain,
} from '../lib/template-domains';
import { getBackend } from '../lib/backend';
import { errorMessage } from '../lib/errors';
import { runProgress, type RunProgress } from '../lib/run-report';
import {
  activityByDay,
  attentionItems,
  DASHBOARD_DAYS,
  formatSpan,
  localDayStart,
  mergeActiveRuns,
  monthToDateFilter,
  upcomingAutomations,
  weekDelta,
  weekStats,
  type ActivityDay,
  type AttentionItem,
  type RunStamp,
} from '../lib/dashboard';
import {
  estimatePlanCost,
  formatUsd,
  parsePlanShare,
  parsePlans,
  type PlanCost,
  type UsageSummary,
} from '../lib/usage';
import type { StoredRun, Workflow } from '../lib/workflow';

/** Goals a first-time visitor can start from with one click. */
export const EXAMPLE_GOALS = [
  'Write a blog post about our new feature from my notes, then draft social posts',
  'Review my current branch with two different agents and list what to fix',
  'Research the best open-source CRMs for a 10-person team, with sources',
  'Turn meeting notes into action items and a follow-up email',
] as const;

const DOMAIN_ICON: Record<TemplateDomain, IconName> = {
  software: 'code',
  content: 'file',
  research: 'search',
  media: 'image',
  data: 'gauge',
  start: 'play',
  other: 'templates',
};

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return 'Working late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** At most this many live runs get a progress card. */
const LIVE_LIMIT = 3;

/** Each running run's progress, read again while it runs. */
function useLiveProgress(runIds: string[]): Record<string, RunProgress> {
  const [progress, setProgress] = useState<Record<string, RunProgress>>({});
  // A run's workflow snapshot never changes: read it once per run.
  const snapshots = useRef(new Map<string, Workflow>());
  const key = runIds.join('|');
  useEffect(() => {
    // Nothing runs: keep the last reading; the cards look up only live runs.
    if (key === '') return;
    let alive = true;
    let busy = false;
    const ids = key.split('|');
    const load = async (): Promise<void> => {
      // One reading at a time, and none while the window is out of view.
      if (busy || document.visibilityState === 'hidden') return;
      busy = true;
      const backend = getBackend();
      const entries = await Promise.all(
        ids.map(async (id) => {
          try {
            const [workflow, results] = await Promise.all([
              snapshots.current.get(id) ??
                backend.getRunWorkflow(id).then((snapshot) => {
                  if (snapshot !== null) snapshots.current.set(id, snapshot);
                  return snapshot;
                }),
              backend.getRunResults(id),
            ]);
            return workflow === null
              ? null
              : ([id, runProgress(workflow, results)] as const);
          } catch {
            return null;
          }
        }),
      );
      busy = false;
      if (!alive) return;
      const next: Record<string, RunProgress> = {};
      for (const entry of entries) if (entry !== null) next[entry[0]] = entry[1];
      setProgress(next);
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [key]);
  return progress;
}

/**
 * Every run of the last two weeks (status and times only), read again when
 * the recent list changes: the figures count the whole window, not the
 * store's capped list. Null until the first answer; 'error' if it failed.
 */
function useRunStamps(refreshKey: string): RunStamp[] | 'error' | null {
  const [stamps, setStamps] = useState<RunStamp[] | 'error' | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        // The chart's first day starts at local midnight; count from there
        // (a fixed 14 × 24 h can start an hour late across a DST change).
        const since = new Date(localDayStart(Date.now(), DASHBOARD_DAYS - 1));
        const result = await getBackend().runStamps(since.toISOString());
        if (alive) setStamps(result);
      } catch {
        if (alive) setStamps('error');
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [refreshKey]);
  return stamps;
}

interface MonthUsage {
  summary: UsageSummary;
  cost: PlanCost;
  /** True when a plan is entered for at least one provider. */
  hasPlans: boolean;
}

/** This UTC month's agent work and its estimated cost on the user's plans. */
function useMonthUsage(refreshKey: string): MonthUsage | 'error' | null {
  const [state, setState] = useState<MonthUsage | 'error' | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const backend = getBackend();
        const [summary, plansRaw, shareRaw] = await Promise.all([
          backend.usageSummary({
            ...monthToDateFilter(Date.now()),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
          backend.getSetting('usage.plans').catch(() => null),
          backend.getSetting('usage.planShare').catch(() => null),
        ]);
        const plans = parsePlans(plansRaw);
        if (!alive) return;
        setState({
          summary,
          cost: estimatePlanCost(summary.providerDays, plans, parsePlanShare(shareRaw)),
          hasPlans: Object.keys(plans).length > 0,
        });
      } catch {
        if (alive) setState('error');
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, [refreshKey]);
  return state;
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value);
}

function runDuration(run: StoredRun, now: number): string | null {
  const started = Date.parse(run.startedAt);
  const ended = run.finishedAt === undefined ? now : Date.parse(run.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;
  return formatSpan(Math.max(0, ended - started));
}

const STATUS_LABEL: Record<string, string> = {
  running: 'Running',
  paused: 'Waiting',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  pending: 'Pending',
};

/** Seven tiny bars: runs per day this week. */
function Sparkline({ days }: { days: ActivityDay[] }): React.JSX.Element {
  const totals = days.map((d) => d.succeeded + d.failed + d.other);
  const max = Math.max(1, ...totals);
  return (
    <span className="home-spark" aria-hidden="true">
      {totals.map((total, index) => (
        <span
          key={days[index]?.day ?? index}
          style={{ height: `${String(Math.max(8, (100 * total) / max))}%` }}
          className={total === 0 ? 'empty' : undefined}
        />
      ))}
    </span>
  );
}

function Ring({ percent }: { percent: number }): React.JSX.Element {
  const radius = 15.5;
  const length = 2 * Math.PI * radius;
  return (
    <svg className="home-ring" viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r={radius} className="home-ring-track" />
      <circle
        cx="20"
        cy="20"
        r={radius}
        className="home-ring-value"
        strokeDasharray={`${String((length * percent) / 100)} ${String(length)}`}
      />
    </svg>
  );
}

function ActivityChart({ days }: { days: ActivityDay[] }): React.JSX.Element {
  const max = Math.max(1, ...days.map((d) => d.succeeded + d.failed + d.other));
  const sum = (key: 'succeeded' | 'failed' | 'other'): number =>
    days.reduce((total, day) => total + day[key], 0);
  const succeeded = sum('succeeded');
  const failed = sum('failed');
  const other = sum('other');
  const lastIndex = days.length - 1;
  return (
    <>
      <div
        className="home-chart"
        role="img"
        aria-label={`Runs per day over the last ${String(days.length)} days: ${String(succeeded)} succeeded, ${String(failed)} failed, ${String(other)} other.`}
      >
        {days.map((day, index) => {
          const total = day.succeeded + day.failed + day.other;
          const date = new Date(`${day.day}T12:00:00`);
          const label =
            index === lastIndex
              ? 'Today'
              : date.toLocaleDateString([], { weekday: 'narrow' });
          return (
            <div
              key={day.day}
              className={`home-chart-col${index === lastIndex ? ' today' : ''}`}
              title={`${date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}: ${String(total)} run${total === 1 ? '' : 's'} (${String(day.succeeded)} succeeded, ${String(day.failed)} failed${day.other > 0 ? `, ${String(day.other)} other` : ''})`}
            >
              <div
                className="home-chart-bar"
                style={{ height: `${String((100 * total) / max)}%` }}
              >
                {day.failed > 0 && (
                  <span className="seg failed" style={{ flexGrow: day.failed }} />
                )}
                {day.other > 0 && (
                  <span className="seg other" style={{ flexGrow: day.other }} />
                )}
                {day.succeeded > 0 && (
                  <span className="seg succeeded" style={{ flexGrow: day.succeeded }} />
                )}
              </div>
              <span className="home-chart-label" aria-hidden="true">
                {label}
              </span>
            </div>
          );
        })}
      </div>
      <table className="sr-only">
        <caption>Runs per day over the last {days.length} days</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Succeeded</th>
            <th scope="col">Failed</th>
            <th scope="col">Other</th>
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.day}>
              <th scope="row">
                {new Date(`${day.day}T12:00:00`).toLocaleDateString([], {
                  weekday: 'long',
                  month: 'short',
                  day: 'numeric',
                })}
              </th>
              <td>{day.succeeded}</td>
              <td>{day.failed}</td>
              <td>{day.other}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul className="home-legend" aria-hidden="true">
        <li>
          <span className="dot succeeded" /> {succeeded} succeeded
        </li>
        <li>
          <span className="dot failed" /> {failed} failed
        </li>
        {other > 0 && (
          <li>
            <span className="dot other" /> {other} other
          </li>
        )}
      </ul>
    </>
  );
}

/**
 * Home: describe what you want done, see what is running and what needs you,
 * this week's activity and this month's usage, then start from a kind of work
 * or get back to your workflows.
 */
export function HomeView(): React.JSX.Element {
  const workflows = useAppStore((s) => s.workflows);
  const runs = useAppStore((s) => s.runs);
  const activeRuns = useAppStore((s) => s.activeRuns);
  const profiles = useAppStore((s) => s.profiles);
  const schedules = useAppStore((s) => s.schedules);
  const watchers = useAppStore((s) => s.watchers);
  const notifications = useAppStore((s) => s.notifications);
  const builtinTemplates = useAppStore((s) => s.builtinTemplates);
  const setView = useAppStore((s) => s.setView);
  const selectWorkflow = useAppStore((s) => s.selectWorkflow);
  const openRunInRuns = useAppStore((s) => s.openRunInRuns);
  const pushUiNotice = useAppStore((s) => s.pushUiNotice);
  const setTemplateDomain = useAppStore((s) => s.setTemplateDomain);
  const setTemplateQuery = useAppStore((s) => s.setTemplateQuery);
  const setPendingIntent = useAppStore((s) => s.setPendingIntent);
  const [goal, setGoal] = useState('');
  const [now, setNow] = useState(() => Date.now());
  // The recent list plus older runs that still work or wait.
  const current = useMemo(() => mergeActiveRuns(runs, activeRuns), [runs, activeRuns]);
  const running = current.filter((r) => r.status === 'running');
  const live = running.length > 0;
  // The app refreshes runs every 5 s; this clock decides "today" and "the
  // last 7 days", and ticks every second while something runs so its elapsed
  // time moves.
  useEffect(() => {
    const tick = setInterval(
      () => {
        setNow(Date.now());
      },
      live ? 1000 : 10_000,
    );
    return () => {
      clearInterval(tick);
    };
  }, [live]);
  // Schedules move their next slot once it runs: read them again while Home
  // is in view, so Up next never shows a spent slot for long.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void useAppStore
        .getState()
        .refreshAutomations()
        .catch(() => undefined);
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const nameOf = useMemo(() => {
    const names = new Map(workflows.map((w) => [w.id, w.name]));
    return (run: StoredRun): string => names.get(run.workflowId) ?? run.workflowId;
  }, [workflows]);
  const liveRuns = running.slice(0, LIVE_LIMIT);
  const progress = useLiveProgress(liveRuns.map((r) => r.id));
  const waiting = current.filter((r) => r.status === 'paused');
  const attention = attentionItems(current, notifications, now, 4);
  const moreNotices = attention.rest.filter((item) => item.kind === 'notice').length;
  const moreRuns = attention.rest.length - moreNotices;
  // A run starting, pausing or finishing changes this key, and so does a new
  // UTC month: the figures and this month's usage are read again then.
  const runsKey = current.map((run) => `${run.id}:${run.status}`).join('|');
  const monthKey = new Date(now).toISOString().slice(0, 7);
  const stamps = useRunStamps(runsKey);
  // Until the window arrives (or if it cannot be read) count what is listed.
  const counted = Array.isArray(stamps) ? stamps : runs;
  const stats = weekStats(counted, now);
  const delta = weekDelta(stats);
  const activity = useMemo(
    () => activityByDay(counted, now, DASHBOARD_DAYS),
    [counted, now],
  );
  const upcoming = upcomingAutomations(schedules, watchers, workflows);
  // Agent steps record usage while their run still runs: read it again each
  // minute then.
  const liveMinute = live ? String(Math.floor(now / 60_000)) : '';
  const usage = useMonthUsage(`${runsKey}#${monthKey}#${liveMinute}`);
  const lastRunOf = useMemo(() => {
    const last = new Map<string, StoredRun>();
    for (const run of runs) {
      const seen = last.get(run.workflowId);
      if (seen === undefined || run.startedAt > seen.startedAt)
        last.set(run.workflowId, run);
    }
    return last;
  }, [runs]);
  const recentWorkflows = [...workflows]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);
  const steps = [
    {
      done: profiles.length > 0,
      label: 'Connect an AI agent',
      hint: 'Claude Code, Codex, Gemini or another CLI you are signed in to.',
      action: () => {
        setView('agents');
      },
    },
    {
      done: runs.length > 0,
      label: 'Run your first workflow',
      hint: 'Start from a template; the first one needs no setup.',
      action: () => {
        setTemplateQuery('');
        setTemplateDomain('start');
        setView('templates');
      },
    },
    {
      done: schedules.length + watchers.length > 0,
      label: 'Automate something',
      hint: 'Run a workflow on a schedule or when a pull request changes.',
      action: () => {
        setView('automations');
      },
    },
  ];
  const setupLeft = steps.filter((s) => !s.done).length;
  const setupDone = steps.length - setupLeft;

  const draft = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    setPendingIntent({ kind: 'generate', goal: trimmed });
    setView('workflows');
  };
  /**
   * Show a run in Runs. An Inbox entry it came from is marked read once the
   * run is open (as the Inbox does); a run that is gone says so.
   */
  const openRun = (runId: string, notificationId?: number): void => {
    void (async () => {
      try {
        const opened = await openRunInRuns(runId);
        if (opened && notificationId !== undefined) {
          await getBackend().markNotificationRead(notificationId);
          await useAppStore.getState().refreshNotifications();
        }
      } catch (err) {
        const message = errorMessage(err);
        pushUiNotice({ content: message, text: message, variant: 'error' });
      }
    })();
  };
  const openWorkflow = (id: string, run: boolean): void => {
    selectWorkflow(id);
    if (run) setPendingIntent({ kind: 'run' });
    setView('workflows');
  };
  const today = new Date(now);
  const next = upcoming[0];

  const pulse: { key: string; tone: string; text: string }[] = [];
  if (running.length > 0)
    pulse.push({
      key: 'running',
      tone: 'running',
      text: `${String(running.length)} running`,
    });
  if (waiting.length > 0)
    pulse.push({
      key: 'waiting',
      tone: 'paused',
      text: `${String(waiting.length)} waiting for you`,
    });
  if (next !== undefined)
    pulse.push({
      key: 'next',
      tone: 'idle',
      text: `${next.kind === 'schedule' ? 'Next run' : 'Next check'}: ${next.name}, ${formatRelative(next.at, now)}`,
    });
  if (pulse.length === 0)
    pulse.push({ key: 'quiet', tone: 'idle', text: 'Nothing running right now' });

  const attentionRow = (item: AttentionItem): React.JSX.Element => {
    if (item.kind === 'waiting')
      return (
        <li key={`w-${item.run.id}`} className="home-feed-item tone-paused">
          <span className="home-feed-icon" aria-hidden="true">
            <Icon name="clock" size={16} />
          </span>
          <span className="home-feed-text">
            <span className="status-pill status-paused">Waiting</span>
            <strong>{nameOf(item.run)}</strong>
            <span className="field-hint">Needs your decision to continue.</span>
          </span>
          <button
            className="btn btn-primary"
            onClick={() => {
              openRun(item.run.id);
            }}
          >
            Review
          </button>
        </li>
      );
    if (item.kind === 'failed')
      return (
        <li key={`f-${item.run.id}`} className="home-feed-item tone-failed">
          <span className="home-feed-icon" aria-hidden="true">
            <Icon name="alert" size={16} />
          </span>
          <span className="home-feed-text">
            <span className="status-pill status-failed">Failed</span>
            <strong>{nameOf(item.run)}</strong>
            <span
              className="field-hint"
              title={formatTime(item.run.finishedAt ?? item.run.startedAt)}
            >
              {formatRelative(item.run.finishedAt ?? item.run.startedAt, now)}
            </span>
          </span>
          <button
            className="btn"
            onClick={() => {
              openRun(item.run.id);
            }}
          >
            Open
          </button>
        </li>
      );
    const { notification } = item;
    const tone =
      notification.kind === 'approval' || notification.kind.startsWith('feedback')
        ? 'paused'
        : notification.kind === 'failure' ||
            notification.kind.endsWith('-failed') ||
            notification.kind.endsWith('-error') ||
            notification.kind.endsWith('-blocked')
          ? 'failed'
          : 'info';
    const runId = notification.runId;
    return (
      <li key={`n-${String(notification.id)}`} className={`home-feed-item tone-${tone}`}>
        <span className="home-feed-icon" aria-hidden="true">
          <Icon name={tone === 'failed' ? 'alert' : 'inbox'} size={16} />
        </span>
        <span className="home-feed-text">
          <strong>{notification.title}</strong>
          <span className="field-hint home-feed-body" title={notification.body}>
            {notification.body}
          </span>
          <span className="field-hint" title={formatTime(notification.createdAt)}>
            {formatRelative(notification.createdAt, now)}
          </span>
        </span>
        <button
          className="btn"
          onClick={() => {
            if (runId !== undefined) openRun(runId, notification.id);
            else setView('inbox');
          }}
        >
          {runId !== undefined ? 'Open run' : 'Inbox'}
        </button>
      </li>
    );
  };

  const costTile = ((): { value: string; hint: string } => {
    if (usage === null) return { value: '…', hint: 'Reading usage' };
    if (usage === 'error') return { value: '—', hint: 'Usage could not be read' };
    if (usage.hasPlans && usage.cost.totalUsd !== null)
      return {
        value: formatUsd(usage.cost.totalUsd),
        hint: usage.cost.complete
          ? 'Estimated on your plans'
          : 'Estimated on your plans, partly known',
      };
    // The API value is what pay-as-you-go would charge, not money spent: it
    // never stands in for a cost.
    return {
      value: '—',
      hint: usage.hasPlans
        ? 'Not known yet for your plans'
        : 'Enter your plans in Usage for an estimate',
    };
  })();

  return (
    <>
      <div className="topbar">
        <h1>Home</h1>
        <span className="topbar-sub">
          Your AI agents as reviewable workflows, on your machine.
        </span>
      </div>
      <div className="view home-view">
        <section className="home-hero" aria-labelledby="home-goal-title">
          <div className="home-hero-head">
            <div>
              <p className="home-date">
                {today.toLocaleDateString([], {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                })}
              </p>
              <h2 id="home-goal-title">{greeting(today)}. What do you want done?</h2>
            </div>
            <ul className="home-pulse" aria-label="Right now">
              {pulse.map((item) => (
                <li key={item.key} className={`home-pulse-item tone-${item.tone}`}>
                  <span className="home-pulse-dot" aria-hidden="true" />
                  {item.text}
                </li>
              ))}
            </ul>
          </div>
          <form
            className="home-goal"
            onSubmit={(event) => {
              event.preventDefault();
              draft(goal);
            }}
          >
            <label className="sr-only" htmlFor="home-goal">
              Describe what you want done
            </label>
            <textarea
              id="home-goal"
              className="textarea"
              rows={2}
              value={goal}
              placeholder="e.g. Every Monday, summarize our #releases Slack channel and draft a changelog post for the blog"
              onChange={(e) => {
                setGoal(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  draft(goal);
                }
              }}
            />
            <div className="home-goal-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={goal.trim() === ''}
              >
                <Icon name="sparkle" size={15} /> Draft a workflow
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setTemplateQuery('');
                  setTemplateDomain('all');
                  setView('templates');
                }}
              >
                Browse templates
              </button>
              <span className="field-hint home-shortcut">
                Your own AI CLI drafts it; you review before anything runs. Ctrl/⌘ + Enter
                drafts.
              </span>
            </div>
          </form>
          <div className="home-examples" role="group" aria-label="Example goals">
            {EXAMPLE_GOALS.map((example) => (
              <button
                key={example}
                type="button"
                className="filter-chip"
                onClick={() => {
                  setGoal(example);
                }}
              >
                {example}
              </button>
            ))}
          </div>
        </section>

        {setupLeft > 0 && (
          <section className="home-card home-setup" aria-labelledby="home-setup-title">
            <div className="home-card-head">
              <h2 id="home-setup-title" className="section-title">
                Get set up · {String(setupDone)} of {String(steps.length)}
              </h2>
              <span
                className="home-meter"
                role="progressbar"
                aria-label="Setup progress"
                aria-valuemin={0}
                aria-valuemax={steps.length}
                aria-valuenow={setupDone}
              >
                <span style={{ width: `${String((100 * setupDone) / steps.length)}%` }} />
              </span>
            </div>
            <ol className="home-steps">
              {steps.map((step, index) => (
                <li key={step.label} className={step.done ? 'done' : undefined}>
                  <span className="home-step-mark" aria-hidden="true">
                    {step.done ? <Icon name="check" size={13} /> : String(index + 1)}
                  </span>
                  <span>
                    <strong>{step.label}</strong>
                    {step.done && <span className="sr-only"> (done)</span>}
                    <span className="field-hint"> {step.hint}</span>
                  </span>
                  {!step.done && (
                    <button className="btn" onClick={step.action}>
                      Start
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </section>
        )}

        {runs.length > 0 && (
          <section className="home-stats" aria-label="The last 7 days at a glance">
            <button
              type="button"
              className="home-stat"
              onClick={() => {
                setView('runs');
              }}
            >
              <span className="home-stat-label">Runs, last 7 days</span>
              <span className="home-stat-row">
                <span className="home-stat-value">{stats.runs}</span>
                <Sparkline days={activity.slice(-7)} />
              </span>
              <span
                className={`home-stat-hint${delta === null ? '' : ` trend-${delta.trend}`}`}
              >
                {delta?.text ?? 'No runs in the last 14 days'}
              </span>
            </button>
            <button
              type="button"
              className="home-stat"
              onClick={() => {
                setView('runs');
              }}
            >
              <span className="home-stat-label">Success rate</span>
              <span className="home-stat-row">
                <span className="home-stat-value">
                  {stats.successRate === null ? '—' : `${String(stats.successRate)}%`}
                </span>
                {stats.successRate !== null && <Ring percent={stats.successRate} />}
              </span>
              <span className="home-stat-hint">
                {stats.finished === 0
                  ? 'No finished runs in 7 days'
                  : `${String(stats.succeeded)} of ${String(stats.finished)} finished runs`}
              </span>
            </button>
            <button
              type="button"
              className="home-stat"
              onClick={() => {
                setView('runs');
              }}
            >
              <span className="home-stat-label">Run time, last 7 days</span>
              <span className="home-stat-row">
                <span className="home-stat-value">{formatSpan(stats.runTimeMs)}</span>
                <span className="home-stat-icon" aria-hidden="true">
                  <Icon name="clock" size={20} />
                </span>
              </span>
              <span className="home-stat-hint">Start to finish, waits included</span>
            </button>
            <button
              type="button"
              className="home-stat"
              onClick={() => {
                setView('usage');
              }}
            >
              <span className="home-stat-label">Cost this month</span>
              <span className="home-stat-row">
                <span className="home-stat-value">{costTile.value}</span>
                <span className="home-stat-icon" aria-hidden="true">
                  <Icon name="usage" size={20} />
                </span>
              </span>
              <span className="home-stat-hint">{costTile.hint}</span>
            </button>
          </section>
        )}

        <div className="home-grid">
          <div className="home-col">
            <section className="home-card" aria-labelledby="home-live-title">
              <div className="home-card-head">
                <h2 id="home-live-title" className="section-title">
                  Running now
                </h2>
                {live && (
                  <span className="live-badge">
                    <span className="live-dot" aria-hidden="true" /> Live
                  </span>
                )}
              </div>
              {liveRuns.length === 0 ? (
                <div className="home-idle">
                  <span className="home-idle-icon" aria-hidden="true">
                    <Icon name="pulse" size={22} />
                  </span>
                  <div>
                    <strong>Nothing is running.</strong>
                    <p className="field-hint">
                      {next === undefined
                        ? 'Start a workflow below, or schedule one to run on its own.'
                        : next.kind === 'schedule'
                          ? `${next.name} starts ${formatRelative(next.at, now)}.`
                          : `${next.name} checks GitHub ${formatRelative(next.at, now)}.`}
                    </p>
                  </div>
                </div>
              ) : (
                <ul className="home-live">
                  {liveRuns.map((run) => {
                    const p = progress[run.id];
                    const finished =
                      p === undefined
                        ? 0
                        : p.done + p.failed + p.rejected + p.cancelled + p.skipped;
                    const percent =
                      p === undefined || p.total === 0 ? 0 : (100 * finished) / p.total;
                    const current = p?.running.join(', ') ?? '';
                    return (
                      <li key={run.id} className="home-live-item">
                        <div className="home-live-top">
                          <span className="home-live-spinner" aria-hidden="true" />
                          <button
                            type="button"
                            className="home-link home-live-name"
                            onClick={() => {
                              openRun(run.id);
                            }}
                          >
                            {nameOf(run)}
                          </button>
                          <span className="field-hint" title={formatTime(run.startedAt)}>
                            {runDuration(run, now) ?? ''}
                          </span>
                        </div>
                        {/* Without a reading yet the bar has no value (indeterminate). */}
                        <div
                          className="home-progress"
                          role="progressbar"
                          aria-label={`${nameOf(run)} progress`}
                          {...(p === undefined
                            ? {}
                            : {
                                'aria-valuemin': 0,
                                'aria-valuemax': p.total,
                                'aria-valuenow': finished,
                                'aria-valuetext': `${String(finished)} of ${String(p.total)} steps done`,
                              })}
                        >
                          <span style={{ width: `${String(Math.max(4, percent))}%` }} />
                        </div>
                        <span className="field-hint">
                          {p === undefined
                            ? 'Starting…'
                            : `${String(finished)} of ${String(p.total)} steps done${current === '' ? '' : ` · ${current}`}`}
                        </span>
                      </li>
                    );
                  })}
                  {running.length > LIVE_LIMIT && (
                    <li>
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={() => {
                          setView('runs');
                        }}
                      >
                        {String(running.length - LIVE_LIMIT)} more running →
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </section>

            <section className="home-card" aria-labelledby="home-next-title">
              <div className="home-card-head">
                <h2 id="home-next-title" className="section-title">
                  Up next
                </h2>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setView('automations');
                  }}
                >
                  Automations <Icon name="arrowRight" size={14} />
                </button>
              </div>
              {upcoming.length === 0 ? (
                <p className="field-hint">
                  Nothing scheduled. Run a workflow every morning, or whenever a pull
                  request changes.
                </p>
              ) : (
                <ul className="home-upcoming">
                  {upcoming.map((item) => (
                    <li key={`${item.kind}-${item.id}`}>
                      <span className="home-upcoming-icon" aria-hidden="true">
                        <Icon
                          name={item.kind === 'schedule' ? 'clock' : 'eye'}
                          size={16}
                        />
                      </span>
                      <span className="home-upcoming-text">
                        <strong>{item.name}</strong>
                        <span className="field-hint">
                          {item.kind === 'schedule' ? 'Runs' : 'Watches for'}{' '}
                          {item.workflowName}
                        </span>
                      </span>
                      <span className="home-upcoming-when" title={formatTime(item.at)}>
                        {Date.parse(item.at) <= now
                          ? 'due now'
                          : `${item.kind === 'watcher' ? 'checks ' : ''}${formatRelative(item.at, now)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {runs.length > 0 && (
              <section className="home-card" aria-labelledby="home-activity-title">
                <div className="home-card-head">
                  <h2 id="home-activity-title" className="section-title">
                    Activity · last 14 days
                  </h2>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      setView('runs');
                    }}
                  >
                    Runs <Icon name="arrowRight" size={14} />
                  </button>
                </div>
                <ActivityChart days={activity} />
              </section>
            )}

            <section className="home-card" aria-labelledby="home-runs-title">
              <div className="home-card-head">
                <h2 id="home-runs-title" className="section-title">
                  Recent runs
                </h2>
                {runs.length > 0 && (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      setView('runs');
                    }}
                  >
                    All runs <Icon name="arrowRight" size={14} />
                  </button>
                )}
              </div>
              {runs.length === 0 ? (
                <p className="field-hint">
                  No runs yet. Runs show each step’s output, the files it made and what it
                  cost.
                </p>
              ) : (
                <ul className="home-list">
                  {runs.slice(0, 6).map((run) => (
                    <li key={run.id}>
                      <span className={`status-pill status-${run.status}`}>
                        {STATUS_LABEL[run.status] ?? run.status}
                      </span>
                      <button
                        type="button"
                        className="home-list-name home-link"
                        onClick={() => {
                          openRun(run.id);
                        }}
                      >
                        {nameOf(run)}
                      </button>
                      <span className="field-hint home-list-meta">
                        {runDuration(run, now) ?? ''}
                      </span>
                      <span
                        className="field-hint home-list-when"
                        title={formatTime(run.startedAt)}
                      >
                        {formatRelative(run.startedAt, now)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="home-col">
            <section
              className={`home-card${attention.total > 0 ? ' home-attention' : ''}`}
              aria-labelledby="home-attention-title"
            >
              <div className="home-card-head">
                <h2 id="home-attention-title" className="section-title">
                  Needs you
                </h2>
                {attention.total > 0 && (
                  <span className="home-count">{attention.total}</span>
                )}
              </div>
              {attention.total === 0 ? (
                <div className="home-idle">
                  <span className="home-idle-icon ok" aria-hidden="true">
                    <Icon name="checkCircle" size={22} />
                  </span>
                  <div>
                    <strong>All clear.</strong>
                    <p className="field-hint">
                      Approvals, failures and findings land here and in the Inbox.
                    </p>
                  </div>
                </div>
              ) : (
                <ul className="home-feed">{attention.items.map(attentionRow)}</ul>
              )}
              {(moreNotices > 0 || moreRuns > 0) && (
                <div className="home-more">
                  {moreNotices > 0 && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setView('inbox');
                      }}
                    >
                      {String(moreNotices)} more in the Inbox{' '}
                      <Icon name="arrowRight" size={14} />
                    </button>
                  )}
                  {moreRuns > 0 && (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        setView('runs');
                      }}
                    >
                      {String(moreRuns)} more in Runs <Icon name="arrowRight" size={14} />
                    </button>
                  )}
                </div>
              )}
            </section>

            <section className="home-card" aria-labelledby="home-usage-title">
              <div className="home-card-head">
                <h2 id="home-usage-title" className="section-title">
                  Usage this month
                </h2>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setView('usage');
                  }}
                >
                  Details <Icon name="arrowRight" size={14} />
                </button>
              </div>
              <HomeUsage usage={usage} />
            </section>
          </div>
        </div>

        <section aria-labelledby="home-kinds-title">
          <h2 id="home-kinds-title" className="section-title">
            Start from a kind of work
          </h2>
          <div className="home-kinds">
            {TEMPLATE_DOMAINS.filter((d) => d.id !== 'start').map((domain) => {
              const count = builtinTemplates.filter(
                (t) => templateDomain(t.category) === domain.id,
              ).length;
              return (
                <button
                  key={domain.id}
                  type="button"
                  className={`home-kind kind-${domain.id}`}
                  onClick={() => {
                    setTemplateQuery('');
                    setTemplateDomain(domain.id);
                    setView('templates');
                  }}
                >
                  <span className="home-kind-icon" aria-hidden="true">
                    <Icon name={DOMAIN_ICON[domain.id]} size={20} />
                  </span>
                  <span className="home-kind-label">{domain.label}</span>
                  <span className="home-kind-blurb">{domain.blurb}</span>
                  <span className="home-kind-count">
                    {String(count)} template{count === 1 ? '' : 's'} →
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section aria-labelledby="home-workflows-title">
          <div className="home-card-head">
            <h2 id="home-workflows-title" className="section-title">
              Your workflows
            </h2>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setPendingIntent({ kind: 'new' });
                setView('workflows');
              }}
            >
              <Icon name="plus" size={14} /> New
            </button>
          </div>
          {recentWorkflows.length === 0 ? (
            <p className="field-hint">
              No workflows yet: draft one above or use a template.
            </p>
          ) : (
            <ul className="home-workflows">
              {recentWorkflows.map((workflow) => {
                const last = lastRunOf.get(workflow.id);
                const stepCount = workflow.definition.nodes.filter(
                  (n) => n.type !== 'start' && n.type !== 'end',
                ).length;
                return (
                  <li key={workflow.id} className="home-workflow">
                    <button
                      type="button"
                      className="home-link home-workflow-name"
                      onClick={() => {
                        openWorkflow(workflow.id, false);
                      }}
                    >
                      {workflow.name}
                    </button>
                    <span className="field-hint">
                      {String(stepCount)} step{stepCount === 1 ? '' : 's'}
                      {last === undefined ? ' · never run' : ''}
                    </span>
                    {last !== undefined && (
                      <span className="home-workflow-last">
                        <span
                          className={`home-dot status-${last.status}`}
                          aria-hidden="true"
                        />
                        <span className="field-hint" title={formatTime(last.startedAt)}>
                          {STATUS_LABEL[last.status] ?? last.status}{' '}
                          {formatRelative(last.startedAt, now)}
                        </span>
                      </span>
                    )}
                    <button
                      type="button"
                      className="btn home-workflow-run"
                      aria-label={`Run ${workflow.name}`}
                      onClick={() => {
                        openWorkflow(workflow.id, true);
                      }}
                    >
                      <Icon name="play" size={14} /> Run
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

/** Month-to-date usage: the cost estimate, the work behind it, top workflows. */
function HomeUsage({ usage }: { usage: MonthUsage | 'error' | null }): React.JSX.Element {
  if (usage === null) return <p className="field-hint">Reading usage…</p>;
  if (usage === 'error')
    return <p className="field-hint">Usage could not be read. Open Usage & costs.</p>;
  const { summary, cost, hasPlans } = usage;
  const totals = summary.totals;
  if (totals.agentAttempts === 0)
    return (
      <p className="field-hint">
        No agent work this month yet. Each agent step’s tokens and reported cost add up
        here.
      </p>
    );
  const top = [...summary.byWorkflow]
    .sort((a, b) => b.agentAttempts - a.agentAttempts)
    .slice(0, 3);
  const most = Math.max(1, ...top.map((row) => row.agentAttempts));
  // Attempts that reported any token count (missing counts are never zeros).
  const tokenReports = Math.max(
    totals.coverage.inputTokens,
    totals.coverage.outputTokens,
  );
  return (
    <div className="home-usage">
      <div className="home-usage-figures">
        <div>
          <span className="home-usage-value">
            {hasPlans && cost.totalUsd !== null ? formatUsd(cost.totalUsd) : '—'}
          </span>
          <span className="field-hint">
            {hasPlans
              ? cost.complete
                ? 'Estimated on your plans'
                : 'Estimated, partly known'
              : 'Enter your plans for an estimate'}
          </span>
        </div>
        <div>
          <span className="home-usage-value">
            {totals.reportedUsdAttempts > 0 ? formatUsd(totals.reportedUsd) : '—'}
          </span>
          <span className="field-hint">
            {totals.reportedUsdAttempts === 0
              ? 'API value not reported'
              : totals.reportedUsdAttempts < totals.agentAttempts
                ? `API value, ${String(totals.reportedUsdAttempts)} of ${String(totals.agentAttempts)} reported`
                : 'API value reported'}
          </span>
        </div>
        <div>
          <span className="home-usage-value">{formatCompact(totals.agentAttempts)}</span>
          <span className="field-hint">Agent attempts</span>
        </div>
        <div>
          <span className="home-usage-value">
            {tokenReports === 0
              ? '—'
              : formatCompact(totals.inputTokens + totals.outputTokens)}
          </span>
          <span className="field-hint">
            {tokenReports === 0
              ? 'Tokens not reported'
              : tokenReports < totals.agentAttempts
                ? 'Tokens, partly reported'
                : 'Tokens'}
          </span>
        </div>
      </div>
      {top.length > 0 && (
        <ul className="home-bars" aria-label="Workflows with the most agent attempts">
          {top.map((row) => (
            <li key={row.workflowId}>
              <span className="home-bars-name" title={row.workflowName}>
                {row.workflowName}
              </span>
              <span className="home-bars-track" aria-hidden="true">
                <span style={{ width: `${String((100 * row.agentAttempts) / most)}%` }} />
              </span>
              <span className="home-bars-value">{row.agentAttempts}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="field-hint home-usage-note">
        The UTC month so far, as on Usage & costs. Orchevia cannot see your remaining
        quota; this is what ran here.
      </p>
    </div>
  );
}
