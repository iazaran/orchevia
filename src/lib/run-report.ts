import type { StoredNodeResult, Workflow } from './workflow';

/** Kinds whose output is a routing decision ("true", an approval), never a report. */
const ROUTING = new Set(['start', 'end', 'condition', 'approval']);

/**
 * The step whose output is the run's report. A workflow's last word is the
 * step that leads to an End node (a "Summary" command, a final review),
 * looking past conditions and approvals on the way, since their output is only
 * a branch taken. Without one that printed anything, the last agent output,
 * then the last output of any working step.
 */
export function reportResult(
  workflow: Workflow | null,
  results: StoredNodeResult[],
): StoredNodeResult | undefined {
  const nodes = new Map((workflow?.nodes ?? []).map((node) => [node.id, node]));
  const edges = workflow?.edges ?? [];
  const finals = new Set<string>();
  const queue = (workflow?.nodes ?? [])
    .filter((node) => node.type === 'end')
    .map((node) => node.id);
  const seen = new Set(queue);
  for (let target = queue.pop(); target !== undefined; target = queue.pop()) {
    for (const edge of edges) {
      const source = nodes.get(edge.source);
      if (edge.target !== target || source === undefined || seen.has(source.id)) continue;
      seen.add(source.id);
      if (ROUTING.has(source.type)) queue.push(source.id);
      else finals.add(source.id);
    }
  }
  const withOutput = results
    .filter(
      (row) =>
        row.stdout.trim() !== '' &&
        row.status !== 'skipped' &&
        !isBookkeeping(row) &&
        !ROUTING.has(nodes.get(row.nodeId)?.type ?? ''),
    )
    .reverse();
  return (
    withOutput.find((row) => finals.has(row.nodeId)) ??
    withOutput.find((row) => nodes.get(row.nodeId)?.type === 'agent') ??
    withOutput[0]
  );
}

export interface ReportField {
  key: string;
  value: string;
}

const LABELLED = /^([A-Za-z][\w .()/&+-]{0,39}?):(?:\s+(.*))?$/;
const ASSIGNED = /^([A-Z][A-Z0-9_]{1,39})=(.*)$/;

/**
 * Leading `Key: value` (or `KEY=value`) lines, as summaries and status
 * steps print them, so they can be shown as a two-column list. Indented
 * lines under a key continue its value (a list of commits under
 * `Commits:`). Everything from the first other line on stays as text. Fewer
 * than two fields is ordinary prose and is left alone.
 */
export function reportFields(text: string): { fields: ReportField[]; rest: string } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const fields: ReportField[] = [];
  let index = 0;
  while (index < lines.length && (lines[index] ?? '').trim() === '') index++;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    // A key is followed by whitespace or the line end, so "https://…" is not one.
    const match = /^\s/.test(line) ? null : (LABELLED.exec(line) ?? ASSIGNED.exec(line));
    if (match === null) break;
    const continued: string[] = [];
    index++;
    while (index < lines.length && /^\s+\S/.test(lines[index] ?? '')) {
      continued.push((lines[index] ?? '').trim());
      index++;
    }
    const value = [(match[2] ?? '').trim(), ...continued]
      .filter((part, at) => part !== '' || at > 0)
      .join('\n');
    fields.push({ key: (match[1] ?? '').trim(), value });
  }
  if (fields.length < 2) return { fields: [], rest: text };
  return { fields, rest: lines.slice(index).join('\n').trim() };
}

/**
 * Rows the engine writes about a step rather than as one: guard pauses,
 * feedback rounds (`__feedback`) and feedback checks (`checked`).
 */
export function isBookkeeping(row: StoredNodeResult): boolean {
  return row.nodeId.startsWith('__') || row.status === 'checked';
}

/**
 * How many recorded rows ended in each outcome. The run header uses
 * `runProgress` instead whenever the run's workflow is known, so it counts the
 * same steps as the progress bar; this is the fallback without one.
 */
export function stepCounts(
  results: StoredNodeResult[],
  /** Node ids to leave out, such as Start and End. */
  exclude: ReadonlySet<string> = new Set(),
): {
  total: number;
  skipped: number;
  failed: number;
  rejected: number;
  cancelled: number;
} {
  // Each step once, by its latest row: a loop or a retry is not a new step.
  const latest = new Map<string, string>();
  for (const row of results)
    if (!isBookkeeping(row) && !exclude.has(row.nodeId))
      latest.set(row.nodeId, row.status);
  const count = (status: string): number =>
    [...latest.values()].filter((value) => value === status).length;
  return {
    total: latest.size,
    skipped: count('skipped'),
    failed: count('failed'),
    rejected: count('rejected'),
    cancelled: count('cancelled'),
  };
}

/** Readable names for the rows the engine records for its own guards. */
const GUARD_LABELS: Record<string, string> = {
  __spend_guard: 'Spend guard',
  __usage_guard: 'Usage guard',
  __feedback: 'Feedback round',
  __feedback_guard: 'Feedback pause',
};

/** A step's display name: its label, a guard's name, or the node id. */
export function stepLabel(nodeId: string, label: string | undefined): string {
  return label ?? GUARD_LABELS[nodeId] ?? nodeId;
}

/** The timeline bar colour for a step status (one of the status-* pills). */
export function timelineBarStatus(status: string): string {
  switch (status) {
    case 'approved':
    case 'guardContinued':
      return 'succeeded';
    case 'rejected':
      return 'failed';
    case 'guardPaused':
    case 'retrying':
    case 'correcting':
      return 'paused';
    case 'skipped':
    case 'checked':
      return 'cancelled';
    default:
      return status;
  }
}

export interface RunProgress {
  /** Working steps in the workflow (every step but Start and End). */
  total: number;
  done: number;
  failed: number;
  /** Turned down at an approval. */
  rejected: number;
  /** Stopped by a cancel while running. */
  cancelled: number;
  skipped: number;
  /** Labels of the steps running now; more than one means parallel work. */
  running: string[];
  /** Labels of the steps waiting for a decision. */
  waiting: string[];
  /** Steps that have not finished yet and are not running. */
  toGo: number;
}

/**
 * Where a run stands, from each step's latest result. A step a loop or a
 * correction runs again counts once, by its latest result.
 */
export function runProgress(
  workflow: Workflow,
  results: StoredNodeResult[],
): RunProgress {
  const work = new Map(
    workflow.nodes
      .filter((node) => node.type !== 'start' && node.type !== 'end')
      .map((node) => [node.id, node.label ?? node.id]),
  );
  const latest = new Map<string, string>();
  const running: string[] = [];
  for (const row of results) {
    // A correction round reruns its steps: their earlier results no longer
    // count as done.
    if (row.nodeId === '__feedback' && row.status === 'correcting') {
      try {
        const data: unknown = JSON.parse(row.structuredJson ?? '{}');
        const round =
          typeof data === 'object' && data !== null
            ? (data as { feedbackRound?: { roots?: unknown; affected?: unknown } })
                .feedbackRound
            : undefined;
        // A skipped step stays skipped unless its route changes, and then the
        // engine records it again (feedback_engine_tests: "stays skipped").
        // Until that new row arrives it counts as finished: the marker does
        // not say which skips the round will reopen.
        for (const ids of [round?.roots, round?.affected])
          if (Array.isArray(ids))
            for (const id of ids)
              if (typeof id === 'string' && latest.get(id) !== 'skipped')
                latest.delete(id);
      } catch {
        // A malformed marker changes nothing.
      }
      continue;
    }
    if (!work.has(row.nodeId) || isBookkeeping(row)) continue;
    latest.set(row.nodeId, row.status);
  }
  const count = (statuses: string[]): number =>
    [...latest.values()].filter((status) => statuses.includes(status)).length;
  for (const [id, status] of latest) {
    if (status === 'running' || status === 'retrying') running.push(work.get(id) ?? id);
  }
  const waiting = [...latest]
    .filter(([, status]) => status === 'paused')
    .map(([id]) => work.get(id) ?? id);
  const done = count(['succeeded', 'approved']);
  const failed = count(['failed']);
  const rejected = count(['rejected']);
  const cancelled = count(['cancelled']);
  const skipped = count(['skipped']);
  return {
    total: work.size,
    done,
    failed,
    rejected,
    cancelled,
    skipped,
    running,
    waiting,
    toGo: Math.max(
      0,
      work.size -
        done -
        failed -
        rejected -
        cancelled -
        skipped -
        running.length -
        waiting.length,
    ),
  };
}
