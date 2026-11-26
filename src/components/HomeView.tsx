import { useMemo, useState } from 'react';
import { useAppStore } from '../store';
import { Icon, type IconName } from './Icon';
import { formatTime } from '../lib/time';
import {
  TEMPLATE_DOMAINS,
  templateDomain,
  type TemplateDomain,
} from '../lib/template-domains';
import type { StoredRun } from '../lib/workflow';

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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Home (v0.4.0): describe what you want done, start from a kind of work,
 * pick up what needs you, and get back to recent runs and workflows.
 */
export function HomeView(): React.JSX.Element {
  const workflows = useAppStore((s) => s.workflows);
  const runs = useAppStore((s) => s.runs);
  const profiles = useAppStore((s) => s.profiles);
  const schedules = useAppStore((s) => s.schedules);
  const watchers = useAppStore((s) => s.watchers);
  const builtinTemplates = useAppStore((s) => s.builtinTemplates);
  const setView = useAppStore((s) => s.setView);
  const selectWorkflow = useAppStore((s) => s.selectWorkflow);
  const openRunInRuns = useAppStore((s) => s.openRunInRuns);
  const setTemplateDomain = useAppStore((s) => s.setTemplateDomain);
  const setTemplateQuery = useAppStore((s) => s.setTemplateQuery);
  const setPendingIntent = useAppStore((s) => s.setPendingIntent);
  const [goal, setGoal] = useState('');
  const [now] = useState(() => Date.now());

  const nameOf = useMemo(() => {
    const names = new Map(workflows.map((w) => [w.id, w.name]));
    return (run: StoredRun): string => names.get(run.workflowId) ?? run.workflowId;
  }, [workflows]);
  const waiting = runs.filter((r) => r.status === 'paused');
  const failedToday = runs.filter(
    (r) =>
      r.status === 'failed' && now - Date.parse(r.finishedAt ?? r.startedAt) < DAY_MS,
  );
  const week = runs.filter((r) => now - Date.parse(r.startedAt) < 7 * DAY_MS);
  const finishedWeek = week.filter(
    (r) => r.status === 'succeeded' || r.status === 'failed',
  );
  const successRate =
    finishedWeek.length === 0
      ? null
      : Math.round(
          (100 * finishedWeek.filter((r) => r.status === 'succeeded').length) /
            finishedWeek.length,
        );
  const recentWorkflows = [...workflows]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 5);
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

  const draft = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed === '') return;
    setPendingIntent({ kind: 'generate', goal: trimmed });
    setView('workflows');
  };
  const openWorkflow = (id: string, run: boolean): void => {
    selectWorkflow(id);
    if (run) setPendingIntent({ kind: 'run' });
    setView('workflows');
  };

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
          <h2 id="home-goal-title">{greeting(new Date(now))}. What do you want done?</h2>
          <p className="field-hint">
            Describe the work in your own words. Your own AI CLI drafts a workflow you
            review before anything runs.
          </p>
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
              rows={3}
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
                Ctrl/⌘ + Enter drafts · Ctrl/⌘ + K finds anything
              </span>
            </div>
          </form>
          <div className="home-examples" aria-label="Example goals">
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

        {(waiting.length > 0 || failedToday.length > 0) && (
          <section
            className="tool-card home-attention"
            aria-labelledby="home-attention-title"
          >
            <h2 id="home-attention-title" className="section-title">
              Needs you
            </h2>
            <ul className="home-list">
              {waiting.map((run) => (
                <li key={run.id}>
                  <span className="status-pill status-paused">Waiting</span>
                  <span className="home-list-name">{nameOf(run)}</span>
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      void openRunInRuns(run.id);
                    }}
                  >
                    Review
                  </button>
                </li>
              ))}
              {failedToday.map((run) => (
                <li key={run.id}>
                  <span className="status-pill status-failed">Failed</span>
                  <span className="home-list-name">{nameOf(run)}</span>
                  <span className="field-hint" title={run.finishedAt ?? run.startedAt}>
                    {formatTime(run.finishedAt ?? run.startedAt)}
                  </span>
                  <button
                    className="btn"
                    onClick={() => {
                      void openRunInRuns(run.id);
                    }}
                  >
                    Open
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {setupLeft > 0 && (
          <section className="tool-card home-setup" aria-labelledby="home-setup-title">
            <h2 id="home-setup-title" className="section-title">
              Get set up · {String(steps.length - setupLeft)} of {String(steps.length)}
            </h2>
            <ol className="home-steps">
              {steps.map((step) => (
                <li key={step.label} className={step.done ? 'done' : undefined}>
                  <span className="home-step-mark" aria-hidden="true">
                    {step.done ? '✓' : ''}
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
                  className="home-kind"
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

        <div className="home-columns">
          <section className="tool-card" aria-labelledby="home-runs-title">
            <div className="home-card-head">
              <h2 id="home-runs-title" className="section-title">
                Recent runs
              </h2>
              {week.length > 0 && (
                <span className="field-hint">
                  {String(week.length)} this week
                  {successRate === null ? '' : ` · ${String(successRate)}% succeeded`}
                </span>
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
                      {run.status}
                    </span>
                    <button
                      type="button"
                      className="home-list-name home-link"
                      onClick={() => {
                        void openRunInRuns(run.id);
                      }}
                    >
                      {nameOf(run)}
                    </button>
                    <span className="field-hint" title={run.startedAt}>
                      {formatTime(run.startedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="tool-card" aria-labelledby="home-workflows-title">
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
              <ul className="home-list">
                {recentWorkflows.map((workflow) => (
                  <li key={workflow.id}>
                    <button
                      type="button"
                      className="home-list-name home-link"
                      onClick={() => {
                        openWorkflow(workflow.id, false);
                      }}
                    >
                      {workflow.name}
                    </button>
                    <span className="field-hint">
                      {String(
                        workflow.definition.nodes.filter(
                          (n) => n.type !== 'start' && n.type !== 'end',
                        ).length,
                      )}{' '}
                      steps
                    </span>
                    <button
                      type="button"
                      className="btn"
                      aria-label={`Run ${workflow.name}`}
                      onClick={() => {
                        openWorkflow(workflow.id, true);
                      }}
                    >
                      <Icon name="play" size={14} /> Run
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
