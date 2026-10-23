import { RunTimeline } from './RunTimeline';
import { RecoveryDialog, SpendContinueDialog, UsageContinueDialog } from './RunControls';
import { resultMetadata, type SpendPause, type UsagePause } from '../lib/run-controls';
import { successfulCommand } from '../lib/memory';
import type { Workflow } from '../lib/workflow';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getBackend } from '../lib/backend';
import type { GroupedFinding } from '../lib/scheduler';
import { isMarkdown } from '../lib/markdown';
import { formatTime } from '../lib/time';
import {
  agentContextDetails,
  CLI_COST_EXPLANATION,
  estimatePlanCost,
  extractUsageHints,
  formatDurationMs,
  formatUsd,
  formatUsdExact,
  parsePlanShare,
  parsePlans,
  planCostGap,
  type PlanCost,
} from '../lib/usage';
import { reportFields, reportResult, stepCounts, stepLabel } from '../lib/run-report';
import { useAppStore } from '../store';
import { MarkdownText } from './Markdown';
import { Modal } from './Modal';
import { confirmDialog } from './ConfirmDialog';
import { CloseButton } from './CloseButton';
import { Notice, useNoticeMessage } from './Notice';
import { PermissionDenials } from './PermissionDenials';
import { permissionDeniedFrom } from '../lib/permissions';
import { errorMessage } from '../lib/errors';
import { countAgentAttempts, reportedSpend } from '../lib/run-controls';
import type { StoredNodeResult, StoredRun } from '../lib/workflow';

/** The UTC day a timestamp falls on, or '' when it does not parse. */
function utcDay(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : '';
}

/** This run's part of its day on the user's plans, once the run has finished. */
function useRunPlanCost(
  run: StoredRun,
): { cost: PlanCost; plansEntered: boolean } | null {
  const finished = run.status !== 'running' && run.status !== 'paused';
  const dry = run.execution?.options.dryRun === true;
  // Other runs started the same UTC day share its fee, so a run starting or
  // finishing that day changes this run's part.
  const day = utcDay(run.startedAt);
  const sameDay = useAppStore((s) =>
    s.runs
      .filter((other) => utcDay(other.startedAt) === day)
      .map((other) => `${other.id}:${other.status}`)
      .sort()
      .join(','),
  );
  const key = `${run.id}:${run.status}:${sameDay}`;
  const [state, setState] = useState<{
    runId: string;
    cost: PlanCost;
    plansEntered: boolean;
  } | null>(null);
  useEffect(() => {
    const started = new Date(run.startedAt);
    if (!finished || dry || Number.isNaN(started.getTime())) return;
    // A plan's daily fee is split with everything else that ran that UTC day.
    const day = started.toISOString().slice(0, 10);
    const next = new Date(`${day}T00:00:00.000Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    let alive = true;
    const backend = getBackend();
    void Promise.all([
      backend.getSetting('usage.plans'),
      backend.getSetting('usage.planShare'),
      backend.usageSummary({
        from: `${day}T00:00:00.000Z`,
        to: next.toISOString(),
        runIds: [run.id],
      }),
    ])
      .then(([plansRaw, shareRaw, summary]) => {
        if (!alive) return;
        const plans = parsePlans(plansRaw);
        setState({
          runId: run.id,
          cost: estimatePlanCost(summary.providerDays, plans, parsePlanShare(shareRaw)),
          plansEntered: Object.keys(plans).length > 0,
        });
      })
      .catch(() => {
        // The API value still shows; the plan figure is an extra.
      });
    return () => {
      alive = false;
    };
  }, [key, finished, dry, run.id, run.startedAt]);
  // While a newer figure loads, keep showing this run's last one.
  return state?.runId === run.id ? state : null;
}

/** Elapsed wall time of a run, live while it runs. */
function runElapsed(run: StoredRun, now: number): string {
  const start = Date.parse(run.startedAt);
  const live = run.status === 'running' || run.status === 'paused';
  const end = live ? now : Date.parse(run.finishedAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  return end === start ? '0s' : formatDurationMs(end - start);
}

/** The run at a glance: when, how long, how many steps, and what it cost. */
function RunFacts({
  run,
  results,
  workflow,
  now,
}: {
  run: StoredRun;
  results: StoredNodeResult[];
  workflow: Workflow | null;
  now: number;
}): React.JSX.Element {
  const setView = useAppStore((s) => s.setView);
  const dry = run.execution?.options.dryRun === true;
  const live = run.status === 'running' || run.status === 'paused';
  const limit = run.execution?.resolvedLimits?.maxAgentAttempts;
  const consumed =
    run.execution?.consumedAgentAttempts ??
    (workflow ? countAgentAttempts(workflow, results) : 0);
  const spend = workflow ? reportedSpend(workflow, results, dry) : null;
  const planCost = useRunPlanCost(run);
  const counts = stepCounts(results);
  const elapsed = runElapsed(run, now);
  const costUsd = planCost?.plansEntered === true ? planCost.cost.totalUsd : null;
  return (
    <dl className="run-facts">
      <div>
        <dt>Started</dt>
        <dd title={run.startedAt}>{formatTime(run.startedAt)}</dd>
      </div>
      {elapsed !== '' && (
        <div>
          <dt>{live ? 'Running for' : 'Took'}</dt>
          <dd>{elapsed}</dd>
        </div>
      )}
      <div>
        <dt>Steps</dt>
        <dd>
          {String(counts.total)}
          {counts.skipped > 0 && <> · {String(counts.skipped)} skipped</>}
          {counts.failed > 0 && <> · {String(counts.failed)} failed</>}
          {counts.rejected > 0 && <> · {String(counts.rejected)} rejected</>}
        </dd>
      </div>
      <div>
        <dt>Agent attempts</dt>
        <dd>
          {limit === undefined
            ? String(consumed)
            : `${String(consumed)} of ${String(limit)}`}
          {run.execution?.usagePause !== undefined && ' · paused at budget'}
        </dd>
      </div>
      {dry ? (
        <div>
          <dt>Cost</dt>
          <dd>Simulated, no real usage</dd>
        </div>
      ) : (
        <>
          {costUsd !== null && planCost !== null && (
            <div>
              <dt>Cost on your plans</dt>
              <dd
                title={`${formatUsdExact(costUsd)}: this run's part of each plan's daily fee, split by agent time with everything else that ran that day.${planCost.cost.complete ? '' : ` Partial: ${planCostGap(planCost.cost) ?? ''}.`}`}
              >
                ≈ {formatUsd(costUsd)}
                {!planCost.cost.complete && (
                  <span className="coverage-flag"> partial</span>
                )}
              </dd>
            </div>
          )}
          {spend !== null && spend.reportedAttempts + spend.unknownAttempts > 0 && (
            <div>
              <dt>API value</dt>
              <dd
                title={
                  spend.reportedAttempts > 0
                    ? formatUsdExact(spend.reportedUsd)
                    : undefined
                }
              >
                {spend.reportedAttempts > 0
                  ? formatUsd(spend.reportedUsd)
                  : 'Not reported'}
                {spend.unknownAttempts > 0 && spend.reportedAttempts > 0 && (
                  <> · {String(spend.unknownAttempts)} unreported</>
                )}
                {costUsd === null && planCost?.plansEntered === true && (
                  <span className="fact-note">
                    {planCostGap(planCost.cost) ?? 'No plan applies to this run.'}
                  </span>
                )}
                {costUsd === null && planCost !== null && !planCost.plansEntered && (
                  <span className="fact-note">
                    Pay-as-you-go price, not your bill on a plan.{' '}
                    <button
                      className="btn btn-ghost btn-inline"
                      onClick={() => setView('usage')}
                    >
                      Set your plans
                    </button>
                  </span>
                )}
              </dd>
            </div>
          )}
        </>
      )}
    </dl>
  );
}

/** A report: leading `Key: value` lines as a list, the rest as formatted text. */
function ReportBody({ text }: { text: string }): React.JSX.Element {
  const { fields, rest } = reportFields(text);
  return (
    <>
      {fields.length > 0 && (
        <dl className="report-fields">
          {fields.map((field, index) => (
            <div key={`${field.key}-${String(index)}`}>
              <dt>{field.key}</dt>
              <dd
                className={field.value.includes('\n') ? 'report-field-lines' : undefined}
              >
                {field.value === '' ? '—' : field.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {rest !== '' &&
        (isMarkdown(rest) ? (
          <MarkdownText text={rest} />
        ) : (
          <div className="log-block">{rest}</div>
        ))}
    </>
  );
}

/** A bounded output viewport follows live text until the reader scrolls up. */
function OutputBlock({
  text,
  label,
  defaultOpen,
  expanded,
  onToggle,
  rich,
  live = false,
}: {
  text: string;
  label: string;
  defaultOpen: boolean;
  expanded: boolean | undefined;
  onToggle: () => void;
  rich?: boolean;
  live?: boolean;
}): React.JSX.Element | null {
  const viewport = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const wasLive = useRef(live);
  const [following, setFollowing] = useState(true);
  const lines = text.split('\n');
  const collapsible = lines.length > 12 || text.length > 1200;
  const open = !collapsible || (expanded ?? defaultOpen);
  useLayoutEffect(() => {
    const justOpened = open && !wasOpen.current;
    const streamUpdated = live || wasLive.current;
    wasOpen.current = open;
    wasLive.current = live;
    if (!open || !viewport.current) return;
    if (justOpened || (streamUpdated && following)) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
      if (justOpened) setFollowing(true);
    }
  }, [text, open, live, following]);
  if (text === '') return null;
  const shown = open ? text : lines.slice(0, 8).join('\n').slice(0, 1200) + '\n…';
  return (
    <div className="run-output">
      <div
        ref={viewport}
        className="run-output-scroll"
        role="region"
        aria-label={`${label} output`}
        tabIndex={0}
        onScroll={(event) => {
          if (!open) return;
          const el = event.currentTarget;
          setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 32);
        }}
      >
        {rich === true && isMarkdown(text) ? (
          <MarkdownText text={shown} allowRaw={open} />
        ) : (
          <div className="log-block">{shown}</div>
        )}
      </div>
      {collapsible && (
        <button
          className="btn btn-ghost output-toggle"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
          onClick={onToggle}
        >
          {open ? 'Collapse ▲' : 'Show full output ▼'}
        </button>
      )}
      {open && !following && (
        <button
          className="btn btn-ghost output-toggle"
          aria-label={`${live ? 'Follow' : 'Jump to'} latest ${label}`}
          onClick={() => {
            setFollowing(true);
            if (viewport.current)
              viewport.current.scrollTop = viewport.current.scrollHeight;
          }}
        >
          {live ? 'Follow latest ↓' : 'Jump to latest ↓'}
        </button>
      )}
    </div>
  );
}

function ReviewFindings({
  findings,
}: {
  findings: GroupedFinding[];
}): React.JSX.Element | null {
  if (findings.length === 0) return null;
  return (
    <details className="run-findings" aria-label="Review findings" open>
      <summary>Findings ({findings.length})</summary>
      {findings.map((g) => (
        <article key={g.finding.fingerprint} className="tool-card finding-card">
          <div className="finding-head">
            <span className="status-pill status-paused">{g.finding.severity}</span>
            <strong>{g.finding.title.replace(/^#{1,4}\s*/, '')}</strong>
          </div>
          <p className="finding-source field-hint">
            {g.finding.file && (
              <span>
                {g.finding.file}
                {g.finding.lineStart !== undefined
                  ? `:${String(g.finding.lineStart)}`
                  : ''}{' '}
                ·{' '}
              </span>
            )}
            Reported by {g.sources.join(', ')}
          </p>
          {g.finding.explanation !== '' && (
            <MarkdownText text={g.finding.explanation} allowRaw={false} />
          )}
          {g.finding.suggestedFix && (
            <div className="finding-fix">
              <strong>Suggested fix</strong>
              <MarkdownText text={g.finding.suggestedFix} allowRaw={false} />
            </div>
          )}
        </article>
      ))}
    </details>
  );
}

export function RunsView(): React.JSX.Element {
  const runs = useAppStore((s) => s.runs);
  const activeRunId = useAppStore((s) => s.activeRunId);
  const selectRun = useAppStore((s) => s.selectRun);
  const runResults = useAppStore((s) => s.runResults);
  const refreshRuns = useAppStore((s) => s.refreshRuns);
  const pending = useRef(new Set<string>());
  const refreshBusy = useRef(false);
  const mounted = useRef(false);
  const [pendingRuns, setPendingRuns] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<{
    runId: string;
    workflow: Workflow | null;
  } | null>(null);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [recoveryId, setRecoveryId] = useState<string | null>(null);
  const [spendDecision, setSpendDecision] = useState<{
    runId: string;
    pause: SpendPause;
  } | null>(null);
  const [usageDecision, setUsageDecision] = useState<{
    runId: string;
    pause: UsagePause;
  } | null>(null);
  const [memoryMessage, setMemoryMessage, , memoryMessageEvent] =
    useNoticeMessage('info');
  // Keyed by run and node, so a choice made in one run is not preselected in another.
  const [memoryFields, setMemoryFields] = useState<Record<string, string>>({});
  const memoryKey = (runId: string, nodeId: string): string => `${runId}\u0000${nodeId}`;
  const [actionError, setActionError, , actionErrorEvent] = useNoticeMessage('error');
  const [now, setNow] = useState(() => Date.now());
  const workflows = useAppStore((s) => s.workflows);

  const activeRun = runs.find((r) => r.id === activeRunId) ?? null;
  const results = activeRunId !== null ? (runResults[activeRunId] ?? []) : [];
  const pendingApproval = [...results].reverse().find((r) => r.status === 'paused');
  const stepNumber = new Map(results.map((r, index) => [r.id, index + 1]));
  const runWorkflow = snapshot?.runId === activeRunId ? snapshot.workflow : null;
  // A deleted workflow keeps the name saved with its run.
  const workflowName =
    workflows.find((w) => w.id === activeRun?.workflowId)?.name ??
    runWorkflow?.name ??
    activeRun?.workflowId ??
    '';
  const profiles = useAppStore((s) => s.profiles);

  const profileForNode = (nodeId: string): string | null => {
    const node = runWorkflow?.nodes.find((n) => n.id === nodeId);
    if (node?.type !== 'agent') return null;
    const profileId = node.config.agentProfileId ?? '';
    const profile = profiles.find((p) => p.id === profileId);
    if (profile !== undefined) return `${profile.name} (${profile.adapter})`;
    if (profileId !== '') return `Unknown profile '${profileId}'`;
    return 'No profile';
  };

  const nodeFor = (nodeId: string): { label: string; type: string } | null => {
    const node = runWorkflow?.nodes.find((n) => n.id === nodeId);
    if (node === undefined) return null;
    return { label: node.label ?? nodeId, type: node.type };
  };

  useEffect(() => {
    if (!activeRunId) return;
    let cancelled = false;
    void getBackend()
      .getRunWorkflow(activeRunId)
      .then((workflow) => {
        if (!cancelled) setSnapshot({ runId: activeRunId, workflow });
      })
      .catch((error: unknown) => {
        if (!cancelled) setActionError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [activeRunId, setActionError]);
  const promoteCommand = (runId: string, nodeId: string): void => {
    setMemoryBusy(true);
    setMemoryMessage(null);
    const field = memoryFields[memoryKey(runId, nodeId)] ?? 'testCommand';
    void (async () => {
      const backend = getBackend();
      const [run, workflow, recorded] = await Promise.all([
        backend.getRun(runId),
        backend.getRunWorkflow(runId),
        backend.getRunResults(runId),
      ]);
      if (!workflow || run?.status !== 'succeeded' || run.execution?.options.dryRun)
        throw new Error('Only commands from a successful run can be promoted.');
      const result = [...recorded].reverse().find((r) => r.nodeId === nodeId);
      if (result && resultMetadata(result).reusedFrom !== undefined)
        throw new Error('Reused output cannot be promoted as a newly verified command.');
      const node = workflow.nodes.find((n) => n.id === nodeId);
      const repoDir = workflow.defaults?.repoDir || node?.config.workingDir;
      if (!repoDir)
        throw new Error(
          'Set a repository directory in this run workflow before saving project knowledge.',
        );
      const command = successfulCommand(
        workflow,
        nodeId,
        result?.status ?? '',
        run.inputs ?? {},
      );
      await backend.saveProjectPreference(
        repoDir,
        field,
        command,
        `Verified by successful run ${runId}, Command ${nodeId}. Saved explicitly by the user.`,
      );
      await useAppStore.getState().refreshLibrary();
      setMemoryMessage('Saved verified command to the project playbook.');
    })()
      .catch((error: unknown) => setActionError(errorMessage(error)))
      .finally(() => setMemoryBusy(false));
  };

  /** Reload the run list and the selected run's results. Polling skips a
   * finished selected run whose final results are already cached, so other
   * active runs do not make it reload; its terminal transition still fetches
   * the final results once (the cached status no longer matches). */
  const refreshRunData = useCallback(
    async (options?: { poll?: boolean }): Promise<void> => {
      if (refreshBusy.current) return;
      refreshBusy.current = true;
      try {
        await refreshRuns();
        if (!mounted.current) return;
        const state = useAppStore.getState();
        const selected = state.activeRunId;
        if (selected === null) return;
        const status = state.runs.find((r) => r.id === selected)?.status;
        const settled =
          status !== undefined &&
          status !== 'running' &&
          status !== 'paused' &&
          state.runResultStatus[selected] === status &&
          state.runResults[selected] !== undefined;
        if (options?.poll === true && settled) return;
        await selectRun(selected);
      } catch (error: unknown) {
        if (mounted.current) setActionError(errorMessage(error));
      } finally {
        refreshBusy.current = false;
      }
    },
    [refreshRuns, selectRun, setActionError],
  );

  // Each navigation mounts this view again, including a return after a prior visit.
  useEffect(() => {
    mounted.current = true;
    void refreshRunData();
    return () => {
      mounted.current = false;
    };
  }, [refreshRunData]);

  // Keep one timer, independent of changes to result/list object identities.
  // While nothing runs it still checks now and then, so a run a schedule or
  // watcher starts appears without pressing Refresh.
  const hasActiveRuns = runs.some((r) => r.status === 'running' || r.status === 'paused');
  useEffect(() => {
    const timer = setInterval(
      () => {
        setNow(Date.now());
        void refreshRunData({ poll: true });
      },
      hasActiveRuns ? 1500 : 10_000,
    );
    return () => clearInterval(timer);
  }, [hasActiveRuns, refreshRunData]);

  const actOnRun = async (
    runId: string,
    kind: 'decision' | 'cancel',
    action: () => Promise<unknown>,
  ): Promise<void> => {
    const key = `${kind}:${runId}`;
    if (pending.current.has(key)) return;
    pending.current.add(key);
    setPendingRuns([...pending.current]);
    setActionError(null);
    try {
      await action();
      await refreshRuns();
      // Reload the run's steps, unless the reader has moved to another run.
      if (useAppStore.getState().activeRunId === runId) await selectRun(runId);
    } catch (error: unknown) {
      setActionError(errorMessage(error));
    } finally {
      pending.current.delete(key);
      setPendingRuns([...pending.current]);
    }
  };

  const cancel = (runId: string): void => {
    void actOnRun(runId, 'cancel', () => getBackend().cancelRun(runId));
  };

  // The approval note belongs to the run it was typed for.
  const [noteDraft, setNoteDraft] = useState<{ runId: string | null; text: string }>({
    runId: null,
    text: '',
  });
  const note = noteDraft.runId === activeRunId ? noteDraft.text : '';
  const [expandedOutputState, setExpandedOutputState] = useState<{
    runId: string | null;
    values: Record<string, boolean>;
  }>({ runId: null, values: {} });
  const expandedOutputs =
    expandedOutputState.runId === activeRunId ? expandedOutputState.values : {};
  const [reportOpen, setReportOpen] = useState(false);
  // The run whose report was just copied.
  const [copiedReportRun, setCopiedReportRun] = useState<string | null>(null);
  const copiedReport = copiedReportRun !== null && copiedReportRun === activeRunId;
  const showRunOverlay = useAppStore((s) => s.showRunOverlay);
  const setView = useAppStore((s) => s.setView);
  const [findingsState, setFindingsState] = useState<{
    runId: string;
    findings: GroupedFinding[];
  } | null>(null);
  const findings = findingsState?.runId === activeRunId ? findingsState.findings : [];
  const findingsByResult = new Map<number, GroupedFinding[]>();
  const unassignedFindings: GroupedFinding[] = [];
  for (const finding of findings) {
    const sourceRows = new Set<number>();
    for (const source of finding.sources) {
      const row = [...results]
        .reverse()
        .find(
          (r) =>
            r.status === 'succeeded' &&
            (source === r.nodeId || source.startsWith(`${r.nodeId} (`)),
        );
      if (row) sourceRows.add(row.id);
    }
    if (sourceRows.size === 0) unassignedFindings.push(finding);
    for (const id of sourceRows) {
      findingsByResult.set(id, [...(findingsByResult.get(id) ?? []), finding]);
    }
  }

  // Findings follow the selected run's own results; other runs' cache updates
  // and unchanged polls keep the same array and do not refetch.
  const selectedResults = activeRunId !== null ? runResults[activeRunId] : undefined;
  useEffect(() => {
    if (activeRunId === null || selectedResults === undefined) return;
    let current = true;
    void getBackend()
      .getRunFindings(activeRunId)
      .then((next) => {
        if (current) setFindingsState({ runId: activeRunId, findings: next });
      })
      .catch(() => {
        // Keep findings already shown for this run; never show another run's.
        if (current)
          setFindingsState((previous) =>
            previous?.runId === activeRunId
              ? previous
              : { runId: activeRunId, findings: [] },
          );
      });
    return () => {
      current = false;
    };
  }, [activeRunId, selectedResults]);

  const approve = (runId: string, approved: boolean): void => {
    if (pendingApproval === undefined) return;
    void actOnRun(runId, 'decision', async () => {
      await getBackend().approveRun(
        runId,
        approved,
        note === '' ? undefined : note,
        pendingApproval.id,
      );
      setNoteDraft((draft) => (draft.runId === runId ? { runId, text: '' } : draft));
    });
  };

  const [message, setMessage, messageVariant, messageEvent] = useNoticeMessage();

  const runWorkflowName = (run: StoredRun): string =>
    workflows.find((w) => w.id === run.workflowId)?.name ??
    (run.id === activeRunId ? runWorkflow?.name : undefined) ??
    run.workflowId;

  const elapsedSince = (iso: string): string => {
    const ms = now - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${String(s)}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${String(m)}m ${String(s % 60)}s`;
    const h = Math.floor(m / 60);
    return `${String(h)}h ${String(m % 60)}m`;
  };

  const removeRun = (runId: string): void => {
    void confirmDialog({
      title: 'Delete this run?',
      message: 'Its history and node results are removed. The workflow is kept.',
      confirmLabel: 'Delete',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      return getBackend()
        .deleteRun(runId)
        .then(() => {
          setMessage(null);
          if (runId === activeRunId) void selectRun(null);
          return refreshRuns();
        })
        .catch((err: unknown) => {
          setMessage(errorMessage(err), 'error');
        });
    });
  };

  const clearFinished = (): void => {
    const activeStatus = runs.find((r) => r.id === activeRunId)?.status;
    const activeIsKept = activeStatus === 'running' || activeStatus === 'paused';
    void confirmDialog({
      title: 'Clear finished runs?',
      message:
        'Every finished run and its node results are removed. Running or paused runs are kept.',
      confirmLabel: 'Clear finished',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      return getBackend()
        .clearFinishedRuns()
        .then(({ removed, kept }) => {
          setMessage(
            removed === 0
              ? 'Nothing to clear — no finished runs.'
              : `Cleared ${String(removed)} finished run${removed === 1 ? '' : 's'}${
                  kept > 0 ? ` (${String(kept)} still running kept)` : ''
                }.`,
          );
          if (!activeIsKept && activeRunId !== null) void selectRun(null);
          return refreshRuns();
        })
        .catch((err: unknown) => {
          setMessage(errorMessage(err), 'error');
        });
    });
  };

  return (
    <>
      {recoveryId !== null && (
        <RecoveryDialog
          key={recoveryId}
          runId={recoveryId}
          onClose={() => setRecoveryId(null)}
          onRecovered={async (runId) => {
            await refreshRuns();
            await selectRun(runId);
          }}
        />
      )}
      {spendDecision !== null && (
        <SpendContinueDialog
          key={`${spendDecision.runId}-${String(spendDecision.pause.id)}`}
          runId={spendDecision.runId}
          pause={spendDecision.pause}
          onClose={() => setSpendDecision(null)}
          onContinued={() => refreshRunData()}
        />
      )}
      {usageDecision !== null && (
        <UsageContinueDialog
          key={`${usageDecision.runId}-${String(usageDecision.pause.id)}`}
          runId={usageDecision.runId}
          pause={usageDecision.pause}
          onClose={() => setUsageDecision(null)}
          onContinued={() => refreshRunData()}
        />
      )}
      <div className="topbar">
        <h1>Runs</h1>
        <span className="topbar-sub">History of explicit workflow executions.</span>
        <div className="topbar-actions">
          <button
            className="btn btn-ghost"
            title="Aggregated usage, your plans and estimated cost"
            onClick={() => setView('usage')}
          >
            Usage & costs
          </button>
          <button className="btn" onClick={() => void refreshRunData()}>
            Refresh
          </button>
          <button
            className="btn btn-ghost"
            disabled={runs.length === 0}
            title="Delete every finished run (running or paused runs are kept)"
            onClick={clearFinished}
          >
            Clear finished
          </button>
        </div>
      </div>
      <div className="view">
        {memoryMessage && (
          <Notice eventId={memoryMessageEvent} onDismiss={() => setMemoryMessage(null)}>
            {memoryMessage}
          </Notice>
        )}
        {actionError !== null && (
          <Notice
            variant="error"
            eventId={actionErrorEvent}
            onDismiss={() => {
              setActionError(null);
            }}
          >
            {actionError}
          </Notice>
        )}
        {message !== null && (
          <Notice
            variant={messageVariant}
            eventId={messageEvent}
            style={{ marginBottom: 12 }}
            onDismiss={() => {
              setMessage(null);
            }}
          >
            <span>{message}</span>{' '}
          </Notice>
        )}
        {runs.length === 0 && (
          <div className="empty-state">
            <h2>No runs yet</h2>
            <p>Run a workflow from the Workflows tab to see history here.</p>
          </div>
        )}
        <div className="runs-layout">
          <div className="run-list">
            {runs.map((run) => (
              <div key={run.id} className="run-row-wrap" style={{ position: 'relative' }}>
                <button
                  className={`run-row${run.id === activeRunId ? ' selected' : ''}`}
                  style={{ paddingRight: 44 }}
                  onClick={() => void selectRun(run.id)}
                  title={run.id}
                >
                  <span className={`status-pill status-${run.status}`}>{run.status}</span>
                  {run.execution?.options.dryRun && (
                    <span className="status-pill status-paused">DRY RUN</span>
                  )}
                  {(run.status === 'running' || run.status === 'paused') && (
                    <span className="live-badge" aria-label="Live run">
                      <span className="live-dot" aria-hidden="true" />
                      LIVE
                    </span>
                  )}
                  <span style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{runWorkflowName(run)}</div>
                    <div
                      className="wf-card-meta run-row-meta"
                      title={
                        // A paused run has a finishedAt (when it paused) but has
                        // not finished.
                        run.status !== 'running' &&
                        run.status !== 'paused' &&
                        run.finishedAt !== undefined
                          ? `${formatTime(run.startedAt)} → ${formatTime(run.finishedAt)}`
                          : `${formatTime(run.startedAt)} · ${elapsedSince(run.startedAt)} so far`
                      }
                    >
                      {formatTime(run.startedAt)}
                      {run.status === 'running' || run.status === 'paused'
                        ? ` · ${elapsedSince(run.startedAt)} so far`
                        : runElapsed(run, now) === ''
                          ? ''
                          : ` · took ${runElapsed(run, now)}`}
                    </div>
                  </span>
                </button>
                <CloseButton
                  variant="card"
                  label={`Delete run '${run.id}'`}
                  title={
                    run.status === 'running' || run.status === 'paused'
                      ? `Cannot delete while ${run.status} — cancel first`
                      : `Delete run '${run.id}'`
                  }
                  onClose={() => removeRun(run.id)}
                />
              </div>
            ))}
          </div>
          <div style={{ minWidth: 0 }}>
            {activeRun === null && runs.length > 0 && (
              <p className="field-hint">Select a run to inspect node results.</p>
            )}
            {activeRun !== null && (
              <section aria-label="Run details" className="run-detail">
                <header className="run-header">
                  <div className="run-header-title">
                    <h2>{workflowName}</h2>
                    <span className={`status-pill status-${activeRun.status}`}>
                      {activeRun.status}
                    </span>
                    {activeRun.execution?.options.dryRun && (
                      <span className="status-pill status-paused">DRY RUN</span>
                    )}
                  </div>
                  <RunFacts
                    run={activeRun}
                    results={results}
                    workflow={runWorkflow}
                    now={now}
                  />
                  <p className="field-hint run-header-id">{activeRun.id}</p>
                  {activeRun.execution?.options.dryRun && (
                    <p className="field-hint">
                      Simulated test — developer CLIs and integrations were not executed.
                    </p>
                  )}
                  {activeRun.execution?.recoveredFrom && (
                    <p className="field-hint">
                      Recovered from {activeRun.execution.recoveredFrom}; reused outputs
                      remain historical.
                    </p>
                  )}
                </header>
                <div className="run-actions">
                  {(activeRun.status === 'running' || activeRun.status === 'paused') && (
                    <button
                      className="btn"
                      disabled={
                        pendingRuns.includes(`cancel:${activeRun.id}`) ||
                        (activeRun.status === 'paused' &&
                          pendingRuns.includes(`decision:${activeRun.id}`))
                      }
                      onClick={() => void cancel(activeRun.id)}
                    >
                      Cancel run
                    </button>
                  )}
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      void showRunOverlay(activeRun.id).catch((err: unknown) =>
                        setActionError(errorMessage(err)),
                      );
                    }}
                  >
                    Show on canvas
                  </button>
                  {activeRun.status === 'failed' && (
                    <button className="btn" onClick={() => setRecoveryId(activeRun.id)}>
                      Recover failed run
                    </button>
                  )}
                  {activeRun.status === 'paused' && activeRun.execution?.spendPause && (
                    <button
                      className="btn btn-primary"
                      onClick={() => {
                        const pause = activeRun.execution?.spendPause;
                        if (pause) setSpendDecision({ runId: activeRun.id, pause });
                      }}
                    >
                      Review spend pause
                    </button>
                  )}
                  {activeRun.status === 'paused' && activeRun.execution?.usagePause && (
                    <button
                      className="btn btn-primary"
                      onClick={() => {
                        const pause = activeRun.execution?.usagePause;
                        if (pause) setUsageDecision({ runId: activeRun.id, pause });
                      }}
                    >
                      Review usage pause
                    </button>
                  )}
                  {activeRun.status === 'paused' &&
                    activeRun.execution?.spendPause === undefined &&
                    activeRun.execution?.usagePause === undefined && (
                      <>
                        <button
                          className="btn btn-primary"
                          disabled={
                            pendingApproval === undefined ||
                            pendingRuns.includes(`decision:${activeRun.id}`)
                          }
                          onClick={() => void approve(activeRun.id, true)}
                        >
                          Approve & continue
                        </button>
                        <button
                          className="btn btn-danger"
                          disabled={
                            pendingApproval === undefined ||
                            pendingRuns.includes(`decision:${activeRun.id}`)
                          }
                          onClick={() => void approve(activeRun.id, false)}
                        >
                          Reject
                        </button>
                      </>
                    )}
                </div>
                {activeRun.status === 'paused' &&
                  activeRun.execution?.spendPause === undefined &&
                  activeRun.execution?.usagePause === undefined && (
                    <div className="field" style={{ maxWidth: 560 }}>
                      <label className="field-label" htmlFor="approve-note">
                        Note (optional, stored with the decision)
                      </label>
                      <textarea
                        id="approve-note"
                        className="textarea"
                        rows={2}
                        placeholder="e.g. Plan looks good, proceed with tests after."
                        value={note}
                        onChange={(e) => {
                          setNoteDraft({ runId: activeRunId, text: e.target.value });
                        }}
                      />
                    </div>
                  )}
                {(() => {
                  const finished =
                    activeRun.status !== 'running' && activeRun.status !== 'paused';
                  const report = reportResult(runWorkflow, results);
                  // A rejected approval stops a run as surely as a failed step.
                  const failedRow =
                    activeRun.status === 'failed'
                      ? [...results]
                          .reverse()
                          .find((r) => r.status === 'failed' || r.status === 'rejected')
                      : undefined;
                  // Wait for the run's workflow: without it a branch decision
                  // cannot be told apart from a real report.
                  if (
                    !finished ||
                    snapshot?.runId !== activeRunId ||
                    (report === undefined && failedRow === undefined)
                  )
                    return null;
                  const reportNode = report ? nodeFor(report.nodeId) : null;
                  const setAllOutputs = (open: boolean): void => {
                    const next: Record<string, boolean> = {};
                    for (const r of results) {
                      next[`${String(r.id)}:out`] = open;
                      next[`${String(r.id)}:err`] = open;
                    }
                    setExpandedOutputState({ runId: activeRunId, values: next });
                  };
                  const copyReport = (): void => {
                    if (report === undefined) return;
                    const runId = activeRun.id;
                    try {
                      void navigator.clipboard
                        .writeText(report.stdout)
                        .then(() => {
                          setCopiedReportRun(runId);
                        })
                        .catch(() => {
                          setCopiedReportRun(null);
                        });
                    } catch {
                      setCopiedReportRun(null);
                    }
                  };
                  const downloadReport = (): void => {
                    if (report === undefined) return;
                    const blob = new Blob([report.stdout], {
                      type: 'text/markdown',
                    });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = `${activeRun.workflowId}-${report.nodeId}-report.md`;
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                    URL.revokeObjectURL(url);
                  };
                  return (
                    <>
                      <section aria-label="Run report" className="tool-card run-report">
                        <div className="run-report-head">
                          <h3>Report</h3>
                          {report !== undefined && (
                            <a
                              className="run-report-source"
                              href={`#run-result-${String(report.id)}`}
                            >
                              from step {String(stepNumber.get(report.id) ?? '?')} ·{' '}
                              {reportNode?.label ?? report.nodeId}
                            </a>
                          )}
                        </div>
                        {failedRow !== undefined && (
                          <Notice inline variant="error" className="run-report-failure">
                            <a href={`#run-result-${String(failedRow.id)}`}>
                              Stopped at step{' '}
                              {String(stepNumber.get(failedRow.id) ?? '?')} ·{' '}
                              {nodeFor(failedRow.nodeId)?.label ?? failedRow.nodeId}
                            </a>
                            {failedRow.status === 'rejected' && <> (rejected)</>}
                            {failedRow.error !== undefined && failedRow.error !== '' && (
                              <>: {failedRow.error}</>
                            )}
                          </Notice>
                        )}
                        {report !== undefined && (
                          <div className="report-preview">
                            <ReportBody text={report.stdout} />
                          </div>
                        )}
                        <div className="run-report-actions">
                          {report !== undefined && (
                            <>
                              <button
                                className="btn"
                                onClick={() => {
                                  setCopiedReportRun(null);
                                  setReportOpen(true);
                                }}
                              >
                                Open full report
                              </button>
                              <button className="btn btn-ghost" onClick={copyReport}>
                                {copiedReport ? 'Copied ✓' : 'Copy'}
                              </button>
                              <button className="btn btn-ghost" onClick={downloadReport}>
                                Download .md
                              </button>
                            </>
                          )}
                          <button
                            className="btn btn-ghost"
                            onClick={() => {
                              setAllOutputs(false);
                            }}
                            title="Collapse every step below; the report stays visible"
                          >
                            Collapse all steps
                          </button>
                          <button
                            className="btn btn-ghost"
                            onClick={() => {
                              setAllOutputs(true);
                            }}
                          >
                            Expand all steps
                          </button>
                        </div>
                      </section>
                      {reportOpen && report !== undefined && (
                        <Modal
                          label="Run report"
                          onClose={() => {
                            setReportOpen(false);
                          }}
                          closeLabel="Close report"
                          onBackdrop={() => {
                            setReportOpen(false);
                          }}
                          maxWidth={860}
                        >
                          <div>
                            <h3 style={{ marginTop: 0 }}>
                              Report — {reportNode?.label ?? report.nodeId}
                            </h3>
                            <div className="report-full">
                              <ReportBody text={report.stdout} />
                            </div>
                            <div
                              style={{
                                display: 'flex',
                                gap: 8,
                                marginTop: 12,
                                flexWrap: 'wrap',
                              }}
                            >
                              <button className="btn btn-primary" onClick={copyReport}>
                                {copiedReport ? 'Copied ✓' : 'Copy'}
                              </button>
                              <button className="btn" onClick={downloadReport}>
                                Download .md
                              </button>
                              <button
                                className="btn btn-ghost"
                                onClick={() => {
                                  setReportOpen(false);
                                }}
                              >
                                Close
                              </button>
                            </div>
                          </div>
                        </Modal>
                      )}
                    </>
                  );
                })()}
                {runWorkflow && (
                  <RunTimeline
                    run={activeRun}
                    workflow={runWorkflow}
                    results={results}
                    now={now}
                  />
                )}
                {results.length === 0 && (
                  <p className="field-hint">No node results yet.</p>
                )}
                <ReviewFindings findings={unassignedFindings} />
                <ol className="run-steps" role="list" aria-label="Steps">
                  {results.map((r, index) => {
                    const node = nodeFor(r.nodeId);
                    const context = agentContextDetails(r.structuredJson);
                    const denied = permissionDeniedFrom(r.structuredJson);
                    const textUsageHints = extractUsageHints(r.stdout, r.stderr);
                    const profile = profileForNode(r.nodeId);
                    // The last step (usually the report) opens expanded; the rest
                    // collapse long logs behind a toggle.
                    const isLast = index === results.length - 1;
                    const toggleOutput = (stream: string): void => {
                      const key = `${String(r.id)}:${stream}`;
                      setExpandedOutputState((prev) => {
                        const values = prev.runId === activeRunId ? prev.values : {};
                        return {
                          runId: activeRunId,
                          values: {
                            ...values,
                            [key]: !(
                              values[key] ?? (stream === 'activity' ? false : isLast)
                            ),
                          },
                        };
                      });
                    };
                    const playbook =
                      activeRun.status === 'succeeded' &&
                      node?.type === 'command' &&
                      r.status === 'succeeded' &&
                      !activeRun.execution?.options.dryRun &&
                      resultMetadata(r).reusedFrom === undefined &&
                      [...results].reverse().find((result) => result.nodeId === r.nodeId)
                        ?.id === r.id;
                    // A paused approval row stays in the history after its
                    // decision (a later row for the same step).
                    const decided =
                      r.status === 'paused' &&
                      results.slice(index + 1).some((later) => later.nodeId === r.nodeId);
                    const shownStatus = decided ? 'waited' : r.status;
                    const meta = [
                      profile !== null ? `via ${profile}` : null,
                      r.exitCode !== undefined ? `exit ${String(r.exitCode)}` : null,
                      (r.attempt ?? 1) > 1 ? `attempt ${String(r.attempt)}` : null,
                      context?.sessionLabel ?? null,
                    ].filter((item): item is string => item !== null && item !== '');
                    return (
                      <li
                        id={`run-result-${String(r.id)}`}
                        key={r.id}
                        className={`run-step step-${shownStatus}`}
                      >
                        <div className="run-step-head">
                          <span
                            className="step-index"
                            title={`Step ${String(index + 1)}`}
                          >
                            {index + 1}
                          </span>
                          <strong className="run-step-title" title={r.nodeId}>
                            {stepLabel(r.nodeId, node?.label)}
                          </strong>
                          <span
                            className={`status-pill status-${decided ? 'cancelled' : r.status}`}
                            title={
                              decided
                                ? 'Waited for a decision; the next step shows it.'
                                : undefined
                            }
                          >
                            {shownStatus}
                          </span>
                          {denied !== null && (
                            <span
                              className="status-pill status-failed"
                              title="Claude refused tool calls under this profile's permissions"
                            >
                              tools refused
                            </span>
                          )}
                          {node !== null && (
                            <span className="step-kind">{node.type}</span>
                          )}
                          {(r.durationMs ?? 0) > 0 && (
                            <span className="run-step-duration">
                              {formatDurationMs(r.durationMs ?? 0)}
                            </span>
                          )}
                        </div>
                        {meta.length > 0 && (
                          <div className="run-step-meta" title={context?.group}>
                            {meta.join(' · ')}
                          </div>
                        )}
                        <div className="run-step-body">
                          {r.error !== undefined &&
                            r.error !== '' &&
                            (r.status === 'paused' ? (
                              // An approval's prompt, not an error.
                              <p className="field-hint">{r.error}</p>
                            ) : (
                              <Notice inline variant="error">
                                {r.error}
                              </Notice>
                            ))}
                          {denied !== null && (
                            <PermissionDenials
                              denied={denied}
                              profileId={
                                runWorkflow?.nodes.find((n) => n.id === r.nodeId)?.config
                                  .agentProfileId
                              }
                            />
                          )}
                          <ReviewFindings findings={findingsByResult.get(r.id) ?? []} />
                          {((context?.usageHints.length ?? 0) > 0 ||
                            textUsageHints.length > 0) && (
                            <details className="cli-usage-details">
                              <summary>CLI usage</summary>
                              {(context?.usageHints.length ?? 0) > 0 && (
                                <p className="field-hint">
                                  {context?.usageHints.join(' · ')}
                                </p>
                              )}
                              {textUsageHints.length > 0 && (
                                <p className="field-hint">
                                  Unverified text hints: {textUsageHints.join(' · ')}
                                </p>
                              )}
                              <p className="field-hint">{CLI_COST_EXPLANATION}</p>
                            </details>
                          )}
                          {context?.outputNote && (
                            <p className="field-hint">{context.outputNote}</p>
                          )}
                          <OutputBlock
                            text={r.stdout}
                            live={r.status === 'running'}
                            label="stdout"
                            rich={node?.type === 'agent'}
                            defaultOpen={isLast}
                            expanded={expandedOutputs[`${String(r.id)}:out`]}
                            onToggle={() => {
                              toggleOutput('out');
                            }}
                          />
                          {context?.activity &&
                            context.activity.trim() !== r.stdout.trim() && (
                              <OutputBlock
                                text={context.activity}
                                live={r.status === 'running'}
                                label="Agent activity"
                                defaultOpen={false}
                                expanded={expandedOutputs[`${String(r.id)}:activity`]}
                                onToggle={() => {
                                  toggleOutput('activity');
                                }}
                              />
                            )}
                          <OutputBlock
                            text={r.stderr}
                            live={r.status === 'running'}
                            label="stderr"
                            defaultOpen={isLast}
                            expanded={expandedOutputs[`${String(r.id)}:err`]}
                            onToggle={() => {
                              toggleOutput('err');
                            }}
                          />
                        </div>
                        {playbook && (
                          <details className="run-step-playbook">
                            <summary>Save this command to the project playbook…</summary>
                            <div className="run-step-playbook-form">
                              <label htmlFor={`playbook-field-${String(r.id)}`}>
                                Save it as the project&apos;s
                              </label>
                              <select
                                id={`playbook-field-${String(r.id)}`}
                                className="select"
                                aria-label={'Playbook field for ' + r.nodeId}
                                value={
                                  memoryFields[memoryKey(activeRun.id, r.nodeId)] ??
                                  'testCommand'
                                }
                                onChange={(e) =>
                                  setMemoryFields({
                                    ...memoryFields,
                                    [memoryKey(activeRun.id, r.nodeId)]: e.target.value,
                                  })
                                }
                              >
                                <option value="testCommand">Test command</option>
                                <option value="lintCommand">Lint command</option>
                                <option value="buildCommand">Build command</option>
                              </select>
                              <button
                                className="btn btn-ghost"
                                disabled={memoryBusy}
                                onClick={() => promoteCommand(activeRun.id, r.nodeId)}
                              >
                                Save command to playbook
                              </button>
                            </div>
                          </details>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </section>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
