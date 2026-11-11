// Feedback on a run step: the composer, each step's feedback history, the
// run-level summary and the feedback pause dialog. Feedback waits for the
// run's next checkpoint; nothing here reaches a CLI that is already running.
import { useId, useState } from 'react';
import { getBackend } from '../lib/backend';
import { errorMessage } from '../lib/errors';
import {
  FEEDBACK_STATUS_LABELS,
  MAX_FEEDBACK_CHARS,
  feedbackTiming,
  type FeedbackPause,
  type FeedbackState,
  type RunFeedback,
} from '../lib/feedback';
import type { Workflow } from '../lib/workflow';
import { Modal } from './Modal';
import { Notice } from './Notice';

const STATUS_PILL: Record<RunFeedback['status'], string> = {
  pending: 'status-paused',
  checking: 'status-running',
  satisfied: 'status-succeeded',
  correcting: 'status-running',
  addressed: 'status-succeeded',
  'needs-attention': 'status-failed',
  late: 'status-cancelled',
  'not-processed': 'status-cancelled',
};

/** Write feedback on one step of a running or paused run. */
export function FeedbackComposer({
  runId,
  nodeId,
  resultId,
  stepName,
  step,
  workflow,
  state,
  onSent,
  onClose,
}: {
  runId: string;
  nodeId: string;
  resultId: number;
  stepName: string;
  step: number;
  workflow: Workflow;
  state: FeedbackState | undefined;
  onSent: (item: RunFeedback) => void;
  onClose: () => void;
}): React.JSX.Element {
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void getBackend()
      .submitStepFeedback(runId, nodeId, text, resultId)
      .then((item) => {
        setText('');
        onSent(item);
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="feedback-composer">
      <label className="field-label" htmlFor={`${id}-text`}>
        Feedback on {stepName}
        <span className="sr-only">{`, step ${String(step)}`}</span>
      </label>
      <textarea
        id={`${id}-text`}
        className="textarea"
        // Opened by its button to type into at once.
        autoFocus
        rows={3}
        maxLength={MAX_FEEDBACK_CHARS}
        placeholder="e.g. Keep compatibility with the old configuration."
        value={text}
        aria-describedby={`${id}-timing`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
          if (e.key === 'Escape') onClose();
        }}
      />
      <p id={`${id}-timing`} className="field-hint">
        {feedbackTiming(workflow, state)} The step that is running now finishes first;
        nothing is sent to it.
      </p>
      {error !== null && (
        <Notice inline variant="error">
          {error}
        </Notice>
      )}
      <div className="feedback-composer-actions">
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          onClick={send}
          disabled={busy || text.trim() === ''}
        >
          {busy ? 'Sending…' : 'Send feedback'}
        </button>
      </div>
    </div>
  );
}

/** A step's feedback, what became of it and where it was handled. */
export function FeedbackList({
  items,
  stepNumber,
  labelOf,
}: {
  items: RunFeedback[];
  /** The step number of a result row, for links to checks and corrections. */
  stepNumber: (resultId: number) => number | undefined;
  labelOf: (nodeId: string) => string;
}): React.JSX.Element | null {
  if (items.length === 0) return null;
  const link = (resultId: number, text: string): React.JSX.Element => (
    <a href={`#run-result-${String(resultId)}`}>
      {text}
      {stepNumber(resultId) !== undefined
        ? ` (step ${String(stepNumber(resultId))})`
        : ''}
    </a>
  );
  return (
    <ul className="feedback-list" aria-label="Feedback on this step">
      {items.map((item) => (
        <li key={item.id} className="feedback-item">
          <div className="feedback-item-head">
            <span className={`status-pill ${STATUS_PILL[item.status]}`}>
              {FEEDBACK_STATUS_LABELS[item.status]}
            </span>
            <span className="field-hint">
              Feedback #{item.id}
              {item.carriedFrom !== undefined && ' · carried over from the failed run'}
            </span>
          </div>
          <blockquote className="feedback-text">{item.text}</blockquote>
          {item.decision !== '' && <p className="feedback-decision">{item.decision}</p>}
          {(item.targetNodeId !== undefined && item.targetNodeId !== item.nodeId) ||
          item.checkResultId !== undefined ||
          item.correctionResultIds.length > 0 ? (
            <p className="field-hint feedback-links">
              {item.targetNodeId !== undefined && item.targetNodeId !== item.nodeId && (
                <>Handled by {labelOf(item.targetNodeId)}. </>
              )}
              {item.checkResultId !== undefined && link(item.checkResultId, 'Check')}
              {item.correctionResultIds.map((id) => (
                <span key={id}> · {link(id, 'Correction')}</span>
              ))}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** The run's feedback at a glance, for the run header. */
export function FeedbackSummary({
  items,
  workflow,
  state,
  live,
}: {
  items: RunFeedback[];
  workflow: Workflow | null;
  state: FeedbackState | undefined;
  live: boolean;
}): React.JSX.Element | null {
  if (items.length === 0) return null;
  const counts = new Map<RunFeedback['status'], number>();
  for (const item of items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const parts = [...counts].map(
    ([status, n]) => `${String(n)} ${FEEDBACK_STATUS_LABELS[status].toLowerCase()}`,
  );
  const waiting = (counts.get('pending') ?? 0) + (counts.get('checking') ?? 0);
  return (
    <p className="run-feedback-summary">
      <strong>Feedback:</strong> {parts.join(' · ')}
      {live && waiting > 0 && workflow !== null && (
        <> — {feedbackTiming(workflow, state)}</>
      )}
    </p>
  );
}

/** Continue a run paused for feedback as it is, or leave it paused. */
export function FeedbackPauseDialog({
  runId,
  pause,
  items,
  onContinued,
  onClose,
}: {
  runId: string;
  pause: FeedbackPause;
  items: RunFeedback[];
  onContinued: () => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attention = items.filter(
    (i) => i.status === 'needs-attention' && !i.acknowledged,
  );
  const submit = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void getBackend()
      .continueFeedbackRun(runId, pause.id)
      .then(async () => {
        await onContinued();
        onClose();
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <Modal
      label="Feedback needs your attention"
      onClose={onClose}
      onBackdrop={() => {
        if (!busy) onClose();
      }}
    >
      <h2>Feedback needs your attention</h2>
      <p className="field-hint">{pause.reason}</p>
      <ul className="feedback-list">
        {attention.map((item) => (
          <li key={item.id} className="feedback-item">
            <blockquote className="feedback-text">{item.text}</blockquote>
            <p className="feedback-decision">{item.decision}</p>
          </li>
        ))}
      </ul>
      <p className="field-hint">
        Continuing runs the rest of the workflow as it is, including its publishing steps.
        To change the work instead, cancel the run and start it again.
      </p>
      {error !== null && (
        <Notice variant="error" onDismiss={() => setError(null)}>
          {error}
        </Notice>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose} disabled={busy}>
          Back
        </button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Continuing…' : 'Continue as it is'}
        </button>
      </div>
    </Modal>
  );
}
