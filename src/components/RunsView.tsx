import { RunTimeline } from './RunTimeline';
import { RecoveryDialog, SpendContinueDialog } from './RunControls';
import { resultMetadata, type SpendPause } from '../lib/run-controls';
import { successfulCommand } from '../lib/memory';
import type { Workflow } from '../lib/workflow';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getBackend } from '../lib/backend';
import type { GroupedFinding } from '../lib/scheduler';
import { isMarkdown } from '../lib/markdown';
import { formatTime } from '../lib/time';
import { agentContextDetails, extractUsageHints, formatDurationMs } from '../lib/usage';
import { useAppStore } from '../store';
import { MarkdownText } from './Markdown';
import { Modal } from './Modal';
import { confirmDialog } from './ConfirmDialog';
import { CloseButton } from './CloseButton';
import { Notice, useNoticeMessage } from './Notice';
import { errorMessage } from '../lib/errors';

/** Step output that collapses long logs behind an expand toggle.
 * Agent stdout renders formatted when it carries markdown (`rich`). */
function OutputBlock({
  text,
  label,
  defaultOpen,
  expanded,
  onToggle,
  rich,
}: {
  text: string;
  label: string;
  defaultOpen: boolean;
  expanded: boolean | undefined;
  onToggle: () => void;
  rich?: boolean;
}): React.JSX.Element | null {
  if (text === '') return null;
  const lines = text.split('\n');
  const open = expanded ?? defaultOpen;
  const PREVIEW_LINES = 8;
  const COLLAPSE_AFTER = 12;
  if (rich === true && isMarkdown(text)) {
    if (lines.length <= COLLAPSE_AFTER) {
      return <MarkdownText text={text} />;
    }
    return (
      <div>
        {open ? (
          <MarkdownText text={text} />
        ) : (
          <MarkdownText
            text={lines.slice(0, PREVIEW_LINES).join('\n') + '\n…'}
            allowRaw={false}
          />
        )}
        <button
          className="btn btn-ghost output-toggle"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${label} (${String(lines.length)} lines)`}
          onClick={onToggle}
        >
          {open ? 'Collapse ▲' : `Show all ${String(lines.length)} lines ▼`}
        </button>
      </div>
    );
  }
  if (lines.length <= COLLAPSE_AFTER) {
    return <div className="log-block">{text}</div>;
  }
  return (
    <div>
      <div className="log-block">
        {open ? text : lines.slice(0, PREVIEW_LINES).join('\n')}
        {!open && lines.length > PREVIEW_LINES ? '\n…' : ''}
      </div>
      <button
        className="btn btn-ghost output-toggle"
        aria-expanded={open}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${label} (${String(lines.length)} lines)`}
        onClick={onToggle}
      >
        {open ? 'Collapse ▲' : `Show all ${String(lines.length)} lines ▼`}
      </button>
    </div>
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
  const [memoryMessage, setMemoryMessage, , memoryMessageEvent] =
    useNoticeMessage('info');
  const [memoryFields, setMemoryFields] = useState<Record<string, string>>({});
  const [actionError, setActionError, , actionErrorEvent] = useNoticeMessage('error');
  const [now, setNow] = useState(0);
  const workflows = useAppStore((s) => s.workflows);

  const activeRun = runs.find((r) => r.id === activeRunId) ?? null;
  const results = activeRunId !== null ? (runResults[activeRunId] ?? []) : [];
  const pendingApproval = [...results].reverse().find((r) => r.status === 'paused');
  const workflowName =
    workflows.find((w) => w.id === activeRun?.workflowId)?.name ??
    activeRun?.workflowId ??
    '';
  const runWorkflow = snapshot?.runId === activeRunId ? snapshot.workflow : null;
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
    const field = memoryFields[nodeId] ?? 'testCommand';
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
  const hasActiveRuns = runs.some((r) => r.status === 'running' || r.status === 'paused');
  useEffect(() => {
    if (!hasActiveRuns) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void refreshRunData({ poll: true });
    }, 1500);
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
      await selectRun(runId);
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

  const [note, setNote] = useState('');
  const [expandedOutputState, setExpandedOutputState] = useState<{
    runId: string | null;
    values: Record<string, boolean>;
  }>({ runId: null, values: {} });
  const expandedOutputs =
    expandedOutputState.runId === activeRunId ? expandedOutputState.values : {};
  const [reportOpen, setReportOpen] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);
  const showRunOverlay = useAppStore((s) => s.showRunOverlay);
  const [findingsState, setFindingsState] = useState<{
    runId: string;
    findings: GroupedFinding[];
  } | null>(null);
  const findings = findingsState?.runId === activeRunId ? findingsState.findings : [];

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
      setNote('');
    });
  };

  const [message, setMessage, messageVariant, messageEvent] = useNoticeMessage();

  const runWorkflowName = (workflowId: string): string =>
    workflows.find((w) => w.id === workflowId)?.name ?? workflowId;

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
      <div className="topbar">
        <h1>Runs</h1>
        <span className="topbar-sub">History of explicit workflow executions.</span>
        <div className="topbar-actions">
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
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(280px, 380px) 1fr',
            gap: 20,
          }}
        >
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
                    <div style={{ fontWeight: 600 }}>
                      {runWorkflowName(run.workflowId)}
                    </div>
                    <div
                      className="wf-card-meta run-row-meta"
                      title={
                        run.finishedAt !== undefined
                          ? `${formatTime(run.startedAt)} → ${formatTime(run.finishedAt)}`
                          : `${formatTime(run.startedAt)} · ${elapsedSince(run.startedAt)} so far`
                      }
                    >
                      {formatTime(run.startedAt)}
                      {run.finishedAt !== undefined
                        ? ` → ${formatTime(run.finishedAt)}`
                        : ` · ${elapsedSince(run.startedAt)} so far`}
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
          <div>
            {activeRun === null && runs.length > 0 && (
              <p className="field-hint">Select a run to inspect node results.</p>
            )}
            {activeRun !== null && (
              <section aria-label="Run details">
                <h2 style={{ marginTop: 0 }}>{workflowName}</h2>
                <p className="field-hint">
                  {activeRun.id} · started {formatTime(activeRun.startedAt)}
                </p>
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
                <div
                  style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}
                >
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
                  {activeRun.status === 'paused' &&
                    activeRun.execution?.spendPause === undefined && (
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
                {runWorkflow && (
                  <RunTimeline
                    run={activeRun}
                    workflow={runWorkflow}
                    results={results}
                    now={now}
                  />
                )}
                {activeRun.status === 'paused' &&
                  activeRun.execution?.spendPause === undefined && (
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
                          setNote(e.target.value);
                        }}
                      />
                    </div>
                  )}
                {results.length === 0 && (
                  <p className="field-hint">No node results yet.</p>
                )}
                {(() => {
                  const finished =
                    activeRun.status !== 'running' && activeRun.status !== 'paused';
                  const withOutput = [...results].reverse().find((r) => r.stdout !== '');
                  const agentOutput =
                    [...results]
                      .reverse()
                      .find(
                        (r) => r.stdout !== '' && nodeFor(r.nodeId)?.type === 'agent',
                      ) ?? withOutput;
                  if (!finished || agentOutput === undefined) return null;
                  const reportNode = nodeFor(agentOutput.nodeId);
                  const setAllOutputs = (open: boolean): void => {
                    const next: Record<string, boolean> = {};
                    for (const r of results) {
                      next[`${String(r.id)}:out`] = open;
                      next[`${String(r.id)}:err`] = open;
                    }
                    setExpandedOutputState({ runId: activeRunId, values: next });
                  };
                  const copyReport = (): void => {
                    try {
                      void navigator.clipboard
                        .writeText(agentOutput.stdout)
                        .then(() => {
                          setCopiedReport(true);
                        })
                        .catch(() => {
                          setCopiedReport(false);
                        });
                    } catch {
                      setCopiedReport(false);
                    }
                  };
                  const downloadReport = (): void => {
                    const blob = new Blob([agentOutput.stdout], {
                      type: 'text/markdown',
                    });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = `${activeRun.workflowId}-${agentOutput.nodeId}-report.md`;
                    document.body.appendChild(link);
                    link.click();
                    link.remove();
                    URL.revokeObjectURL(url);
                  };
                  return (
                    <>
                      <section
                        aria-label="Run report"
                        className="tool-card"
                        style={{ marginBottom: 16 }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            flexWrap: 'wrap',
                          }}
                        >
                          <h3 style={{ margin: 0 }}>
                            Report — {reportNode?.label ?? agentOutput.nodeId}
                          </h3>
                          <span className={`status-pill status-${agentOutput.status}`}>
                            {agentOutput.status}
                          </span>
                        </div>
                        <div className="report-preview" style={{ marginTop: 10 }}>
                          {isMarkdown(agentOutput.stdout) ? (
                            <MarkdownText text={agentOutput.stdout} />
                          ) : (
                            <div className="log-block">{agentOutput.stdout}</div>
                          )}
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            gap: 8,
                            marginTop: 10,
                            flexWrap: 'wrap',
                          }}
                        >
                          <button
                            className="btn"
                            onClick={() => {
                              setCopiedReport(false);
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
                      {reportOpen && (
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
                              Report — {reportNode?.label ?? agentOutput.nodeId}
                            </h3>
                            <div className="report-full">
                              {isMarkdown(agentOutput.stdout) ? (
                                <MarkdownText text={agentOutput.stdout} />
                              ) : (
                                <div className="log-block">{agentOutput.stdout}</div>
                              )}
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
                {findings.length > 0 && (
                  <section aria-label="Review findings" style={{ marginBottom: 16 }}>
                    <h3 style={{ fontSize: 14 }}>
                      Findings ({findings.length}, deduped across agents)
                    </h3>
                    {findings.map((g) => (
                      <div
                        key={g.finding.fingerprint}
                        className="tool-card"
                        style={{ marginBottom: 8 }}
                      >
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <span className="status-pill status-paused">
                            {g.finding.severity}
                          </span>
                          <strong>{g.finding.title.replace(/^#{1,4}\s*/, '')}</strong>
                        </div>
                        <div className="tool-version">
                          {g.finding.file ?? ''}
                          {g.finding.lineStart !== undefined
                            ? `:${String(g.finding.lineStart)}`
                            : ''}{' '}
                          · via {g.sources.join(', ')}
                        </div>
                        {g.finding.explanation !== '' &&
                          (isMarkdown(g.finding.explanation) ? (
                            <MarkdownText text={g.finding.explanation} />
                          ) : (
                            <p className="field-hint">{g.finding.explanation}</p>
                          ))}
                        {g.finding.suggestedFix !== undefined &&
                          g.finding.suggestedFix !== '' &&
                          (isMarkdown(g.finding.suggestedFix) ? (
                            <MarkdownText
                              text={`Suggested fix: ${g.finding.suggestedFix}`}
                            />
                          ) : (
                            <p className="field-hint">
                              Suggested fix: {g.finding.suggestedFix}
                            </p>
                          ))}
                      </div>
                    ))}
                  </section>
                )}
                {results.map((r, index) => {
                  const node = nodeFor(r.nodeId);
                  const context = agentContextDetails(r.structuredJson);
                  // The last step (usually the report) opens expanded; the rest
                  // collapse long logs behind a toggle.
                  const isLast = index === results.length - 1;
                  const toggleOutput = (stream: string): void => {
                    const key = `${String(r.id)}:${stream}`;
                    setExpandedOutputState((prev) => {
                      const values = prev.runId === activeRunId ? prev.values : {};
                      return {
                        runId: activeRunId,
                        values: { ...values, [key]: !(values[key] ?? isLast) },
                      };
                    });
                  };
                  return (
                    <div
                      id={`run-result-${String(r.id)}`}
                      key={r.id}
                      className="run-step"
                    >
                      <div className="run-step-head">
                        <span className="step-index" aria-hidden="true">
                          {index + 1}
                        </span>
                        <span className={`status-pill status-${r.status}`}>
                          {r.status}
                        </span>
                        <strong>{node?.label ?? r.nodeId}</strong>
                        {activeRun.status === 'succeeded' &&
                          node?.type === 'command' &&
                          r.status === 'succeeded' &&
                          !activeRun.execution?.options.dryRun &&
                          resultMetadata(r).reusedFrom === undefined &&
                          [...results]
                            .reverse()
                            .find((result) => result.nodeId === r.nodeId)?.id ===
                            r.id && (
                            <>
                              <select
                                className="select"
                                aria-label={'Playbook field for ' + r.nodeId}
                                value={memoryFields[r.nodeId] ?? 'testCommand'}
                                onChange={(e) =>
                                  setMemoryFields({
                                    ...memoryFields,
                                    [r.nodeId]: e.target.value,
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
                            </>
                          )}
                        {node !== null && (
                          <span className="status-pill status-cancelled">
                            {node.type}
                          </span>
                        )}
                        {node !== null && node.label !== r.nodeId && (
                          <span className="wf-card-meta" title={r.nodeId}>
                            {r.nodeId}
                          </span>
                        )}
                        {profileForNode(r.nodeId) !== null && (
                          <span className="field-hint">
                            via {profileForNode(r.nodeId) as string}
                          </span>
                        )}
                        {r.exitCode !== undefined && (
                          <span className="field-hint">exit {r.exitCode}</span>
                        )}
                        {(r.attempt ?? 1) > 1 && (
                          <span className="field-hint">attempt {r.attempt}</span>
                        )}
                        {(r.durationMs ?? 0) > 0 && (
                          <span className="field-hint">
                            {formatDurationMs(r.durationMs ?? 0)}
                          </span>
                        )}
                        {context?.sessionLabel && (
                          <span className="field-hint" title={context.group}>
                            {context.sessionLabel}
                          </span>
                        )}
                        {(context?.usageHints.length ?? 0) > 0 && (
                          <span className="field-hint">
                            CLI usage: {context?.usageHints.join(' · ')}
                          </span>
                        )}
                        {extractUsageHints(r.stdout, r.stderr).length > 0 && (
                          <span className="field-hint">
                            usage: {extractUsageHints(r.stdout, r.stderr).join(' · ')}
                          </span>
                        )}
                      </div>
                      {r.error !== undefined && r.error !== '' && (
                        <Notice inline variant="error">
                          {r.error}
                        </Notice>
                      )}
                      {context?.outputNote && (
                        <p className="field-hint">{context.outputNote}</p>
                      )}
                      <OutputBlock
                        text={r.stdout}
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
                          <div style={{ marginTop: 6 }}>
                            <OutputBlock
                              text={context.activity}
                              label="Agent activity"
                              defaultOpen={false}
                              expanded={expandedOutputs[`${String(r.id)}:activity`]}
                              onToggle={() => {
                                toggleOutput('activity');
                              }}
                            />
                          </div>
                        )}
                      <div style={{ marginTop: 6 }}>
                        <OutputBlock
                          text={r.stderr}
                          label="stderr"
                          defaultOpen={isLast}
                          expanded={expandedOutputs[`${String(r.id)}:err`]}
                          onToggle={() => {
                            toggleOutput('err');
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </section>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
