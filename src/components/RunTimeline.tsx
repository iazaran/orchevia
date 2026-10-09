import type { StoredNodeResult, StoredRun, Workflow } from '../lib/workflow';
import { reportedSpend, timelineEntries } from '../lib/run-controls';
import { CLI_COST_EXPLANATION, formatDurationMs } from '../lib/usage';

export function RunTimeline({
  run,
  workflow,
  results,
  now,
}: {
  run: StoredRun;
  workflow: Workflow;
  results: StoredNodeResult[];
  now?: number;
}): React.JSX.Element {
  const current =
    now ?? Date.parse(run.finishedAt ?? results.at(-1)?.finishedAt ?? run.startedAt);
  const start = Date.parse(run.startedAt);
  const end = ['running', 'paused'].includes(run.status)
    ? current
    : Date.parse(run.finishedAt ?? '');
  const elapsed =
    Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
  const entries = timelineEntries(run, results, current);
  const extent = Math.max(
    1,
    elapsed ?? 0,
    ...entries.map((e) => (e.offsetMs ?? 0) + (e.durationMs ?? 0)),
  );
  const spend = reportedSpend(workflow, results, run.execution?.options.dryRun);
  return (
    <section className="tool-card run-timeline" aria-label="Run timeline">
      <h3>Timeline</h3>
      <p className="field-hint">
        Elapsed:{' '}
        {elapsed === null ? 'unknown' : elapsed === 0 ? '0ms' : formatDurationMs(elapsed)}{' '}
        · Parallel bars share one time axis.
      </p>
      {run.execution?.options.dryRun ? (
        <p className="field-hint">Simulated test — no actual spend.</p>
      ) : spend.reportedAttempts + spend.unknownAttempts > 0 ? (
        <details className="cli-usage-details">
          <summary>CLI usage details</summary>
          <p className="field-hint">{CLI_COST_EXPLANATION}</p>
          <p className="field-hint">
            {spend.reportedAttempts > 0
              ? `Estimated API value: USD ${spend.reportedUsd.toFixed(4)}`
              : 'No dollar estimate reported'}{' '}
            · {spend.reportedAttempts} reported attempt
            {spend.reportedAttempts === 1 ? '' : 's'} · {spend.unknownAttempts} attempt
            {spend.unknownAttempts === 1 ? '' : 's'} without a USD report.{' '}
            {spend.unknownAttempts > 0 ? 'Estimate is partial.' : ''}
          </p>
        </details>
      ) : null}
      {entries.length === 0 ? (
        <p className="field-hint">No step timing yet.</p>
      ) : (
        <div className="timeline-rows">
          {entries.map((entry) => {
            const row = results.find((r) => r.id === entry.id);
            const label =
              workflow.nodes.find((n) => n.id === entry.nodeId)?.label ??
              (entry.nodeId === '__spend_guard' ? 'Spend guard' : entry.nodeId);
            return (
              <div className="timeline-row" key={entry.id}>
                <a
                  href={`#run-result-${String(entry.id)}`}
                  title={
                    row
                      ? `${row.startedAt}${row.finishedAt ? ` → ${row.finishedAt}` : ''}`
                      : ''
                  }
                >
                  {label} · attempt {entry.attempt}
                </a>
                <div className="timeline-track" aria-hidden="true">
                  {entry.offsetMs !== null && entry.durationMs !== null && (
                    <span
                      className={`timeline-bar status-${entry.status === 'approved' ? 'succeeded' : entry.status === 'guardPaused' ? 'paused' : entry.status}`}
                      style={{
                        left: `${String((entry.offsetMs / extent) * 100)}%`,
                        width: `${String(Math.max(0.5, (entry.durationMs / extent) * 100))}%`,
                      }}
                    />
                  )}
                </div>
                <span className="field-hint">
                  {entry.reused
                    ? 'Reused output'
                    : entry.durationMs === null
                      ? 'Timing unknown'
                      : entry.durationMs === 0
                        ? '0ms'
                        : `${formatDurationMs(entry.durationMs)}${entry.offsetMs === null ? ' (position unknown)' : ''}`}{' '}
                  · {entry.status}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
