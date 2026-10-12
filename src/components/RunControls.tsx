import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Notice } from './Notice';
import { errorMessage } from '../lib/errors';
import { getBackend } from '../lib/backend';
import {
  adapterCapabilities,
  isEffectful,
  resolveLimits,
  validateRunOptions,
  type FixtureResult,
  type RunOptions,
  type RecoveryChoice,
  type RecoveryPlan,
  type SpendPause,
  type UsagePause,
} from '../lib/run-controls';
import {
  validateWorkflowLimits,
  type Workflow,
  type WorkflowLimits,
} from '../lib/workflow';

/**
 * One floating start-run form for live and dry runs (v0.1.14). Inputs and
 * ordinary run options share a single explicit Start/Cancel flow, so every
 * run — with or without declared inputs — reviews the same effective limits
 * before starting. Overrides here apply to this run only; saved workflow
 * limits change through the Usage limits dialog instead.
 */
export function StartRunDialog({
  workflow,
  initialDryRun,
  initialInputs,
  onInputsChange,
  onStart,
  onClose,
}: {
  workflow: Workflow;
  initialDryRun: boolean;
  initialInputs?: Record<string, string>;
  onInputsChange?: (values: Record<string, string>) => void;
  onStart: (inputs: Record<string, string>, options: RunOptions) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [inputs, setInputs] = useState<Record<string, string>>(() => {
    // Declared defaults first, then previously entered values for this
    // workflow on top — switching workflows never leaks values across.
    const seeded = Object.fromEntries(
      (workflow.inputs ?? []).map((i) => [i.name, i.default ?? '']),
    );
    return { ...seeded, ...(initialInputs ?? {}) };
  });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dryRun, setDryRun] = useState(initialDryRun);
  const [fixtures, setFixtures] = useState(() =>
    JSON.stringify(
      Object.fromEntries(
        workflow.nodes
          .filter((n) => isEffectful(n.type) || n.type === 'approval')
          .map((n) => [
            n.id,
            [{ status: n.type === 'approval' ? 'paused' : 'succeeded', stdout: '' }],
          ]),
      ),
      null,
      2,
    ),
  );
  const [attempts, setAttempts] = useState('');
  const [tools, setTools] = useState('');
  const [subagents, setSubagents] = useState('');
  const [spend, setSpend] = useState('');
  const [ignoreSaved, setIgnoreSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saved = resolveLimits(workflow.limits, {});
  const setInput = (name: string, value: string): void => {
    setInputs((current) => {
      const next = { ...current, [name]: value };
      onInputsChange?.(next);
      return next;
    });
  };
  const submit = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      for (const input of workflow.inputs ?? [])
        if (input.required && !inputs[input.name]?.trim())
          throw new Error(`Input '${input.name}' is required.`);
      let options: RunOptions;
      if (dryRun) {
        const value: unknown = JSON.parse(fixtures);
        if (typeof value !== 'object' || value === null || Array.isArray(value))
          throw new Error('Fixture document must be an object keyed by node id.');
        options = { dryRun: true, fixtures: value as Record<string, FixtureResult[]> };
      } else {
        const overrides: RunOptions = {};
        if (attempts.trim() !== '') overrides.maxAgentAttempts = Number(attempts);
        if (tools.trim() !== '') overrides.maxToolCalls = Number(tools);
        if (subagents.trim() !== '') overrides.maxSubagents = Number(subagents);
        if (spend.trim() !== '') overrides.spendLimitUsd = Number(spend);
        if (ignoreSaved) overrides.ignoreSavedLimits = true;
        options = overrides;
      }
      validateRunOptions(workflow, options);
      await onStart(inputs, options);
      onClose();
    })()
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const limitHint = (label: string, value: number | undefined): string =>
    value === undefined ? `${label}: no saved limit` : `${label}: saved ${String(value)}`;
  return (
    <Modal
      label={dryRun ? 'Dry run workflow' : 'Start run'}
      onClose={onClose}
      onBackdrop={() => {
        if (!busy) onClose();
      }}
    >
      <h2>{dryRun ? 'Dry run workflow' : 'Start run'}</h2>
      <label className="field-hint" style={{ display: 'block', marginBottom: 12 }}>
        <input
          type="checkbox"
          checked={dryRun}
          disabled={busy}
          onChange={(e) => setDryRun(e.target.checked)}
        />{' '}
        Dry run (simulated fixtures; never measures real usage)
      </label>
      {dryRun && (
        <p className="field-hint">
          Test conditions, loops, joins and retries with supplied results. No developer
          CLI or integration runs. Every reached effectful attempt needs its own fixture;
          missing fixtures fail. This tests your scenario, not the real tools.
        </p>
      )}
      {(workflow.inputs ?? []).map((input) => {
        const value = inputs[input.name] ?? input.default ?? '';
        const isExpanded = expanded[input.name] === true || value.length > 80;
        return (
          <div className="field" key={input.name}>
            <label className="field-label" htmlFor={`start-run-input-${input.name}`}>
              {input.label ?? input.name}
              {input.required ? ' (required)' : ''}
            </label>
            {isExpanded ? (
              <textarea
                id={`start-run-input-${input.name}`}
                className="textarea"
                rows={4}
                value={value}
                placeholder={input.default ?? ''}
                disabled={busy}
                onChange={(e) => setInput(input.name, e.target.value)}
              />
            ) : (
              <input
                id={`start-run-input-${input.name}`}
                className="input"
                value={value}
                placeholder={input.default ?? ''}
                disabled={busy}
                onChange={(e) => setInput(input.name, e.target.value)}
              />
            )}
            <button
              className="btn btn-ghost"
              style={{ alignSelf: 'flex-start', padding: '2px 8px', fontSize: 12 }}
              aria-expanded={isExpanded}
              disabled={busy}
              title={isExpanded ? 'Collapse to a single line' : 'Expand for long text'}
              onClick={() => {
                setExpanded((current) => ({ ...current, [input.name]: !isExpanded }));
              }}
            >
              {isExpanded ? 'Collapse ▲' : 'Expand ▼'}
            </button>
          </div>
        );
      })}
      {dryRun ? (
        <div className="field">
          <label className="field-label" htmlFor="run-fixtures">
            Fixture results JSON
          </label>
          <textarea
            id="run-fixtures"
            className="fixture-editor"
            value={fixtures}
            disabled={busy}
            onChange={(e) => setFixtures(e.target.value)}
            spellCheck={false}
          />
          <p className="field-hint">
            Each node has an ordered array for successive visits/attempts. Tool statuses:
            succeeded or failed. Approval statuses: approved, rejected or paused. Optional
            fields: stdout, stderr, exitCode, structured (for example severity or ticket
            fields).
          </p>
        </div>
      ) : (
        <details className="field" open={(workflow.inputs ?? []).length === 0}>
          <summary className="field-label">
            Limits for this run (optional override)
          </summary>
          <p className="field-hint">
            Effective values come from the workflow's saved Usage limits. An override
            below replaces the saved value for this run only; blank inherits it. Only the
            Agent-attempt budget is enforced — tool and subagent allowances are advisory
            guidance for the CLI. Dry-run fixtures never measure real usage.
          </p>
          <div className="field">
            <label className="field-label" htmlFor="run-override-attempts">
              Agent attempts (enforced)
            </label>
            <input
              id="run-override-attempts"
              className="input"
              type="number"
              min={1}
              max={10000}
              step={1}
              value={attempts}
              disabled={busy}
              onChange={(e) => setAttempts(e.target.value)}
              placeholder={
                saved.maxAgentAttempts === undefined
                  ? 'Inherit: none'
                  : `Inherit: ${String(saved.maxAgentAttempts)}`
              }
              title={limitHint('Saved attempt budget', saved.maxAgentAttempts)}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="run-override-tools">
              Tool calls (advisory)
            </label>
            <input
              id="run-override-tools"
              className="input"
              type="number"
              min={1}
              max={100000}
              step={1}
              value={tools}
              disabled={busy}
              onChange={(e) => setTools(e.target.value)}
              placeholder={
                saved.maxToolCalls === undefined
                  ? 'Inherit: none'
                  : `Inherit: ${String(saved.maxToolCalls)}`
              }
              title={limitHint('Saved tool-call allowance', saved.maxToolCalls)}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="run-override-subagents">
              Nested subagents (advisory)
            </label>
            <input
              id="run-override-subagents"
              className="input"
              type="number"
              min={1}
              max={1000}
              step={1}
              value={subagents}
              disabled={busy}
              onChange={(e) => setSubagents(e.target.value)}
              placeholder={
                saved.maxSubagents === undefined
                  ? 'Inherit: none'
                  : `Inherit: ${String(saved.maxSubagents)}`
              }
              title={limitHint('Saved subagent allowance', saved.maxSubagents)}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="run-override-spend">
              Spend limit USD (CLI-estimated API value)
            </label>
            <input
              id="run-override-spend"
              className="input"
              type="number"
              min={0.000001}
              step="any"
              value={spend}
              disabled={busy}
              onChange={(e) => setSpend(e.target.value)}
              placeholder={
                saved.spendLimitUsd === undefined
                  ? 'Inherit: none'
                  : `Inherit: ${String(saved.spendLimitUsd)}`
              }
              title={limitHint('Saved spend target', saved.spendLimitUsd)}
            />
            <p className="field-hint">
              Pauses future tool dispatch at the CLI-estimated API value. Missing cost
              reports cannot stop work; in-flight calls can overshoot. This is not a
              subscription charge, billing cap or quota meter.
            </p>
          </div>
          <label className="field-hint" style={{ display: 'block' }}>
            <input
              type="checkbox"
              checked={ignoreSaved}
              disabled={busy}
              onChange={(e) => setIgnoreSaved(e.target.checked)}
            />{' '}
            Run without saved limits (explicitly clears them for this run; overrides above
            still apply)
          </label>
        </details>
      )}
      {error && (
        <Notice variant="error" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Starting…' : dryRun ? 'Start dry run' : 'Start run'}
        </button>
      </div>
    </Modal>
  );
}

/**
 * Edits the selected workflow's saved usage limits. Saved values become the
 * effective defaults for future runs (snapshotted per run, so later edits
 * never change an existing run). Empty clears a limit to ordinary execution.
 */
export function UsageLimitsDialog({
  workflow,
  onClose,
  onSave,
}: {
  workflow: Workflow;
  onClose: () => void;
  onSave: (limits: WorkflowLimits | undefined) => Promise<void>;
}): React.JSX.Element {
  const text = (value: number | undefined): string =>
    value === undefined ? '' : String(value);
  const [attempts, setAttempts] = useState(text(workflow.limits?.maxAgentAttempts));
  const [tools, setTools] = useState(text(workflow.limits?.maxToolCalls));
  const [subagents, setSubagents] = useState(text(workflow.limits?.maxSubagents));
  const [spend, setSpend] = useState(text(workflow.limits?.spendLimitUsd));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      const limits: WorkflowLimits = {};
      if (attempts.trim() !== '') limits.maxAgentAttempts = Number(attempts);
      if (tools.trim() !== '') limits.maxToolCalls = Number(tools);
      if (subagents.trim() !== '') limits.maxSubagents = Number(subagents);
      if (spend.trim() !== '') limits.spendLimitUsd = Number(spend);
      const invalid = validateWorkflowLimits(limits);
      if (invalid !== null) throw new Error(invalid);
      const backend = getBackend();
      const issues = await backend.validateWorkflow({ ...workflow, limits });
      const blocking = issues.filter(
        (issue) => issue.severity === 'error' && issue.code.includes('limit'),
      );
      if (blocking.length > 0) throw new Error(blocking[0]?.message ?? 'Invalid limits.');
      await onSave(Object.keys(limits).length === 0 ? undefined : limits);
      onClose();
    })()
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const capabilities = [
    adapterCapabilities('claude'),
    adapterCapabilities('codex'),
    adapterCapabilities('custom'),
  ];
  return (
    <Modal
      label="Usage limits"
      onClose={onClose}
      onBackdrop={() => {
        if (!busy) onClose();
      }}
    >
      <h2>Usage limits</h2>
      <p className="field-hint">
        Saved defaults for future runs of this workflow. Empty clears a limit back to
        ordinary execution. Every run snapshots the effective values at start, so later
        edits never change an existing run.
      </p>
      <div className="field">
        <label className="field-label" htmlFor="limits-attempts">
          Agent attempts per run (enforced)
        </label>
        <input
          id="limits-attempts"
          className="input"
          type="number"
          min={1}
          max={10000}
          step={1}
          value={attempts}
          disabled={busy}
          onChange={(e) => setAttempts(e.target.value)}
          placeholder="Optional"
        />
        <p className="field-hint">
          Total dispatched Agent attempts, counting retries and loop visits. Parallel
          siblings reserve capacity before dispatch. Exhaustion pauses the run durably;
          extend or cancel explicitly. Reused and simulated results are never charged.
        </p>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="limits-tools">
          Tool calls per run (advisory)
        </label>
        <input
          id="limits-tools"
          className="input"
          type="number"
          min={1}
          max={100000}
          step={1}
          value={tools}
          disabled={busy}
          onChange={(e) => setTools(e.target.value)}
          placeholder="Optional"
        />
      </div>
      <div className="field">
        <label className="field-label" htmlFor="limits-subagents">
          Nested subagents per run (advisory)
        </label>
        <input
          id="limits-subagents"
          className="input"
          type="number"
          min={1}
          max={1000}
          step={1}
          value={subagents}
          disabled={busy}
          onChange={(e) => setSubagents(e.target.value)}
          placeholder="Optional"
        />
        <p className="field-hint">
          Tool and subagent allowances travel as guidance inside each Agent prompt and are
          observed where the CLI reports them. The CLI owns its tool loop, so these never
          hard-stop work the way the attempt budget does.
        </p>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="limits-spend">
          Spend target USD (API-equivalent, not a subscription cap)
        </label>
        <input
          id="limits-spend"
          className="input"
          type="number"
          min={0.000001}
          step="any"
          value={spend}
          disabled={busy}
          onChange={(e) => setSpend(e.target.value)}
          placeholder="Optional"
        />
        <p className="field-hint">
          CLI-estimated API value that pauses future dispatch. Missing reports cannot stop
          work and in-flight calls can overshoot. Never a subscription charge, billing cap
          or quota meter.
        </p>
      </div>
      <details className="field">
        <summary className="field-label">Control coverage by provider</summary>
        <ul className="field-hint" style={{ margin: '8px 0', paddingLeft: 18 }}>
          {capabilities.map((caps) => (
            <li key={caps.adapter}>
              <strong>{caps.adapter}</strong>: attempts {caps.agentAttempts}; turns{' '}
              {caps.agentTurns}; tools {caps.toolCalls}; subagents {caps.subagents}; spend{' '}
              {caps.spendEstimate}. {caps.note}
            </li>
          ))}
        </ul>
      </details>
      {error && (
        <Notice variant="error" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Saving…' : 'Save limits'}
        </button>
      </div>
    </Modal>
  );
}

export function UsageContinueDialog({
  runId,
  pause,
  onContinued,
  onClose,
}: {
  runId: string;
  pause: UsagePause;
  onContinued: () => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [extension, setExtension] = useState(
    String(Math.max(pause.consumedAttempts + 1, pause.limitAttempts * 2)),
  );
  const [withoutGuard, setWithoutGuard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void getBackend()
      .continueUsageRun(runId, pause.id, withoutGuard ? undefined : Number(extension))
      .then(async () => {
        await onContinued();
        onClose();
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Modal
      label="Continue after usage pause"
      onClose={onClose}
      onBackdrop={() => {
        if (!busy) onClose();
      }}
    >
      <h2>Continue after usage pause</h2>
      <p className="field-hint">
        Agent attempt budget exhausted: {String(pause.consumedAttempts)} of{' '}
        {String(pause.limitAttempts)} attempts dispatched. Partial output is preserved;
        unfinished scope stays unfinished until the required work actually runs. This is
        an Orchevia attempt count, not a subscription balance.
      </p>
      <div className="field">
        <label className="field-label" htmlFor="usage-extension">
          New attempt budget
        </label>
        <input
          id="usage-extension"
          type="number"
          step={1}
          min={pause.consumedAttempts + 1}
          disabled={withoutGuard}
          value={extension}
          onChange={(e) => setExtension(e.target.value)}
        />
      </div>
      <label className="field-hint">
        <input
          type="checkbox"
          checked={withoutGuard}
          onChange={(e) => setWithoutGuard(e.target.checked)}
        />{' '}
        Continue without the attempt guard
      </label>
      {error && (
        <Notice variant="error" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose} disabled={busy}>
          Back
        </button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Continuing…' : 'Continue run'}
        </button>
      </div>
    </Modal>
  );
}

export function RecoveryDialog({
  runId,
  onRecovered,
  onClose,
}: {
  runId: string;
  onRecovered: (runId: string) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [plan, setPlan] = useState<RecoveryPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<Record<string, RecoveryChoice>>({});
  const [requestId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let active = true;
    void getBackend()
      .previewRecovery(runId)
      .then((p) => {
        if (active) setPlan(p);
      })
      .catch((e: unknown) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, [runId]);
  const submit = (): void => {
    if (!plan || busy) return;
    setBusy(true);
    setError(null);
    void getBackend()
      .recoverRun(runId, choices, plan.fingerprint, requestId)
      .then(async (result) => {
        await onRecovered(result.runId);
        onClose();
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Modal
      label="Recover failed run"
      onClose={onClose}
      onBackdrop={() => {
        if (!busy) onClose();
      }}
    >
      <h2>Recover failed run</h2>
      <p className="field-hint">
        Uses this run's original workflow and inputs in a new linked run. Choose
        deliberately for every tool step. Failed or cancelled tools may already have
        written files, commits, pushes or remote changes. Replaying executes again;
        skipping supplies no successful output. Reused agent output starts no provider
        session.
      </p>
      {!plan && !error && <p>Loading recovery plan…</p>}
      {plan && (
        <div className="recovery-steps">
          {plan.nodes.map((node) => (
            <div className="field recovery-step" key={node.nodeId}>
              <label className="field-label" htmlFor={`recovery-${node.nodeId}`}>
                {node.label} · {node.previousStatus ?? 'not attempted'}
                {node.affected ? ' · affected' : ''}
              </label>
              <select
                id={`recovery-${node.nodeId}`}
                value={choices[node.nodeId] ?? ''}
                onChange={(e) =>
                  setChoices({
                    ...choices,
                    [node.nodeId]: e.target.value as RecoveryChoice,
                  })
                }
              >
                <option value="" disabled>
                  Choose what this step should do
                </option>
                {node.choices.map((choice) => (
                  <option key={choice} value={choice}>
                    {choice === 'reuse'
                      ? 'Reuse successful output'
                      : choice === 'replay'
                        ? 'Execute again'
                        : 'Skip this step'}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
      {error && (
        <Notice variant="error" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          disabled={
            busy || !plan || plan.nodes.some((n) => choices[n.nodeId] === undefined)
          }
          onClick={submit}
        >
          {busy ? 'Starting…' : 'Start recovery'}
        </button>
      </div>
    </Modal>
  );
}

export function SpendContinueDialog({
  runId,
  pause,
  onContinued,
  onClose,
}: {
  runId: string;
  pause: SpendPause;
  onContinued: () => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [limit, setLimit] = useState(String(Math.max(0.01, pause.reportedUsd * 2)));
  const [withoutGuard, setWithoutGuard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void getBackend()
      .continueSpendRun(runId, pause.id, withoutGuard ? undefined : Number(limit))
      .then(async () => {
        await onContinued();
        onClose();
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Modal
      label="Continue after spend pause"
      onClose={onClose}
      onBackdrop={() => {
        if (!busy) onClose();
      }}
    >
      <h2>Continue after spend pause</h2>
      <p className="field-hint">
        CLI-estimated API value: USD {pause.reportedUsd.toFixed(4)}. This is not your
        subscription bill or remaining quota. Estimates may be incomplete and concurrent
        calls can overshoot the threshold.
      </p>
      <div className="field">
        <label className="field-label" htmlFor="replacement-limit">
          New spend limit USD
        </label>
        <input
          id="replacement-limit"
          type="number"
          step="any"
          disabled={withoutGuard}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
        />
      </div>
      <label className="field-hint">
        <input
          type="checkbox"
          checked={withoutGuard}
          onChange={(e) => setWithoutGuard(e.target.checked)}
        />{' '}
        Continue without the spend guard
      </label>
      {error && (
        <Notice variant="error" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose} disabled={busy}>
          Back
        </button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Continuing…' : 'Continue run'}
        </button>
      </div>
    </Modal>
  );
}
