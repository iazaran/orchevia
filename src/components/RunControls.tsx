import { useEffect, useState } from 'react';
import { Modal } from './Modal';
import { Notice } from './Notice';
import { errorMessage } from '../lib/errors';
import { getBackend } from '../lib/backend';
import {
  isEffectful,
  validateRunOptions,
  type FixtureResult,
  type RunOptions,
  type RecoveryChoice,
  type RecoveryPlan,
  type SpendPause,
} from '../lib/run-controls';
import type { Workflow } from '../lib/workflow';

export function RunOptionsDialog({
  workflow,
  dryRun,
  onStart,
  onClose,
}: {
  workflow: Workflow;
  dryRun: boolean;
  onStart: (inputs: Record<string, string>, options: RunOptions) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [inputs, setInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries((workflow.inputs ?? []).map((i) => [i.name, i.default ?? ''])),
  );
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
  const [limit, setLimit] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void (async () => {
      for (const input of workflow.inputs ?? [])
        if (input.required && !inputs[input.name]?.trim())
          throw new Error(`Input '${input.name}' is required.`);
      let options: RunOptions = {};
      if (dryRun) {
        const value: unknown = JSON.parse(fixtures);
        if (typeof value !== 'object' || value === null || Array.isArray(value))
          throw new Error('Fixture document must be an object keyed by node id.');
        options = { dryRun: true, fixtures: value as Record<string, FixtureResult[]> };
      } else if (limit.trim()) {
        options = { spendLimitUsd: Number(limit) };
      }
      validateRunOptions(workflow, options);
      await onStart(inputs, options);
      onClose();
    })()
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Modal
      label={dryRun ? 'Dry run workflow' : 'Run options'}
      onClose={onClose}
      onBackdrop={() => {
        if (!busy) onClose();
      }}
    >
      <h2>{dryRun ? 'Dry run workflow' : 'Run options'}</h2>
      {dryRun && (
        <p className="field-hint">
          Test conditions, loops, joins and retries with supplied results. No developer
          CLI or integration runs. Every reached effectful attempt needs its own fixture;
          missing fixtures fail. This tests your scenario, not the real tools.
        </p>
      )}
      {(workflow.inputs ?? []).map((input) => (
        <div className="field" key={input.name}>
          <label className="field-label" htmlFor={`run-option-input-${input.name}`}>
            {input.label ?? input.name}
            {input.required ? ' (required)' : ''}
          </label>
          <input
            id={`run-option-input-${input.name}`}
            value={inputs[input.name] ?? ''}
            onChange={(e) => setInputs({ ...inputs, [input.name]: e.target.value })}
          />
        </div>
      ))}
      {dryRun ? (
        <div className="field">
          <label className="field-label" htmlFor="run-fixtures">
            Fixture results JSON
          </label>
          <textarea
            id="run-fixtures"
            className="fixture-editor"
            value={fixtures}
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
        <div className="field">
          <label className="field-label" htmlFor="spend-limit">
            Spend limit USD
          </label>
          <input
            id="spend-limit"
            type="number"
            min="0.000001"
            step="any"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            placeholder="Optional"
          />
          <p className="field-hint">
            Pauses future tool dispatch at the CLI-estimated API value. Missing cost
            reports cannot stop work; in-flight calls can overshoot. Claude managed
            streams may report USD; Codex, custom and plain-text calls may not. This is
            not a subscription charge, billing cap or quota meter.
          </p>
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
        <button className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Starting…' : dryRun ? 'Start dry run' : 'Start run'}
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
