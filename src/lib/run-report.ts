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

/** How many recorded steps ended in each outcome, for the run header. */
export function stepCounts(results: StoredNodeResult[]): {
  total: number;
  skipped: number;
  failed: number;
  rejected: number;
} {
  return {
    total: results.length,
    skipped: results.filter((row) => row.status === 'skipped').length,
    failed: results.filter((row) => row.status === 'failed').length,
    rejected: results.filter((row) => row.status === 'rejected').length,
  };
}

/** Readable names for the rows the engine records for its own guards. */
const GUARD_LABELS: Record<string, string> = {
  __spend_guard: 'Spend guard',
  __usage_guard: 'Usage guard',
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
      return 'paused';
    case 'skipped':
      return 'cancelled';
    default:
      return status;
  }
}
