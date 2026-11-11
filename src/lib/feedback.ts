// Feedback a person sends about a step while its run is going. Mirrors
// `crates/core/src/feedback.rs`: the stored item, who handles it, the
// decision block of a check and which steps a correction reruns. The shared
// fixture `src/test/feedback-parity.json` pins the two sides together.
import { downstreamClosure, dependencyPairs } from './run-controls';
import { isPublicationStep, type Workflow, type WorkflowNode } from './workflow';

export const MAX_FEEDBACK_CHARS = 4000;
export const MAX_FEEDBACK_PER_RUN = 50;
export const ROUND_NODE = '__feedback';
export const GUARD_NODE = '__feedback_guard';
export const DEFAULT_CORRECTION_ROUNDS = 2;

export type FeedbackStatus =
  | 'pending'
  | 'checking'
  | 'satisfied'
  | 'correcting'
  | 'addressed'
  | 'needs-attention'
  | 'late'
  | 'not-processed';

/** Statuses that keep a run from publishing or finishing. */
export const OPEN_STATUSES: readonly string[] = ['pending', 'checking', 'correcting'];

/** Mirrors `RunFeedback`. */
export interface RunFeedback {
  id: number;
  runId: string;
  nodeId: string;
  resultId?: number;
  text: string;
  status: FeedbackStatus;
  decision: string;
  targetNodeId?: string;
  checkResultId?: number;
  correctionResultIds: number[];
  round?: number;
  carriedFrom?: number;
  acknowledged: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublicationStart {
  nodeId: string;
  label: string;
  at: string;
}
export interface FeedbackPause {
  id: number;
  reason: string;
}
/** Mirrors `FeedbackState` (kept in a run's execution). */
export interface FeedbackState {
  publicationStarted?: PublicationStart;
  rounds?: number;
  pause?: FeedbackPause;
  closed?: boolean;
}

/** Words for each status, as the run page shows them. */
export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  pending: 'Waiting',
  checking: 'Being checked',
  satisfied: 'Already satisfied',
  correcting: 'Being addressed',
  addressed: 'Addressed',
  'needs-attention': 'Needs your attention',
  late: 'Arrived after publishing',
  'not-processed': 'Not processed',
};

/** Trimmed text, or why it cannot be sent. Mirrors `validate_text`. */
export function validateFeedbackText(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error('Write the feedback first.');
  if (Array.from(trimmed).length > MAX_FEEDBACK_CHARS)
    throw new Error(`Feedback can be at most ${String(MAX_FEEDBACK_CHARS)} characters.`);
  if (trimmed.includes('\0')) throw new Error('Feedback cannot contain a NUL character.');
  return trimmed;
}

/** Loop-back edges, the engine's way (back edges of a walk from Start). */
function loopEdges(workflow: Workflow): Set<string> {
  const loops = new Set<string>();
  const start = workflow.nodes.find((n) => n.type === 'start');
  if (!start) return loops;
  const onPath = new Set<string>();
  const seen = new Set([start.id]);
  const visit = (id: string): void => {
    onPath.add(id);
    for (const edge of workflow.edges.filter((e) => e.source === id)) {
      if (onPath.has(edge.target)) loops.add(edge.id);
      else if (!seen.has(edge.target)) {
        seen.add(edge.target);
        visit(edge.target);
      }
    }
    onPath.delete(id);
  };
  visit(start.id);
  return loops;
}

/**
 * The AI step that handles feedback on `nodeId`: itself when it is one,
 * otherwise the nearest AI step whose work it uses (edges and data
 * references first, loop-back edges last; ties go to the later step).
 * Mirrors `feedback_target`.
 */
export function feedbackTarget(workflow: Workflow, nodeId: string): string | null {
  const kind = (id: string): string | undefined =>
    workflow.nodes.find((n) => n.id === id)?.type;
  if (kind(nodeId) === 'agent') return nodeId;
  const order = (id: string): number => workflow.nodes.findIndex((n) => n.id === id);
  const loops = loopEdges(workflow);
  const ordinary: [string, string][] = [
    ...workflow.edges
      .filter((e) => !loops.has(e.id))
      .map((e): [string, string] => [e.source, e.target]),
    ...dependencyPairs(workflow).filter(
      ([s, t]) => !workflow.edges.some((e) => e.source === s && e.target === t),
    ),
  ];
  const looping = workflow.edges
    .filter((e) => loops.has(e.id))
    .map((e): [string, string] => [e.source, e.target]);
  for (const pairs of [ordinary, [...ordinary, ...looping]]) {
    const seen = new Set([nodeId]);
    let frontier = [nodeId];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier)
        for (const [source, target] of pairs)
          if (target === id && !seen.has(source)) {
            seen.add(source);
            next.push(source);
          }
      const agents = next.filter((id) => kind(id) === 'agent');
      if (agents.length > 0)
        return agents.reduce((best, id) => (order(id) > order(best) ? id : best));
      frontier = next;
    }
  }
  return null;
}

export type Decision =
  | { kind: 'satisfied'; explanation: string }
  | { kind: 'change'; explanation: string; change: string }
  | { kind: 'unclear'; reason: string };

/** Read a check's decision block. Mirrors `parse_decision`. */
export function parseDecision(text: string): Decision {
  const marker = '```orchevia-feedback';
  let candidate: string | undefined;
  if (text.includes(marker))
    candidate = text.split(marker).pop()?.split('```')[0]?.trim();
  candidate ??= text
    .split('\n')
    .reverse()
    .map((line) => line.trim())
    .find((line) => line.startsWith('{') && line.includes('"decision"'));
  let value: unknown;
  try {
    value = candidate === undefined ? undefined : JSON.parse(candidate);
  } catch {
    value = undefined;
  }
  if (typeof value !== 'object' || value === null)
    return { kind: 'unclear', reason: 'The check did not end with the decision block.' };
  const record = value as Record<string, unknown>;
  const field = (key: string): string => {
    const raw = record[key];
    return typeof raw === 'string' ? Array.from(raw.trim()).slice(0, 1000).join('') : '';
  };
  const decision = typeof record.decision === 'string' ? record.decision.trim() : '';
  if (decision === 'satisfied')
    return { kind: 'satisfied', explanation: field('explanation') };
  if (decision === 'change' && (field('change') !== '' || field('explanation') !== ''))
    return { kind: 'change', explanation: field('explanation'), change: field('change') };
  return {
    kind: 'unclear',
    reason: 'The check\'s decision was neither "satisfied" nor "change".',
  };
}

/**
 * Which corrected steps run first and which steps a correction reruns.
 * Mirrors `correction_plan`.
 */
export function correctionPlan(
  workflow: Workflow,
  targets: string[],
): { roots: string[]; affected: string[] } {
  const order = (id: string): number => workflow.nodes.findIndex((n) => n.id === id);
  let roots = targets.filter(
    (target) =>
      !downstreamClosure(workflow, new Set(targets.filter((t) => t !== target))).has(
        target,
      ),
  );
  if (roots.length === 0) {
    const first = [...targets].sort((a, b) => order(a) - order(b))[0];
    roots = first === undefined ? [] : [first];
  }
  const affected = [
    ...new Set([...downstreamClosure(workflow, new Set(targets)), ...targets]),
  ].filter((id) => !roots.includes(id));
  affected.sort((a, b) => order(a) - order(b));
  roots.sort((a, b) => order(a) - order(b));
  return { roots, affected };
}

/** A step feedback is handled before: a publishing step, an approval or End. */
export function isCheckpoint(node: WorkflowNode | undefined): boolean {
  return (
    node !== undefined &&
    (node.type === 'end' || node.type === 'approval' || isPublicationStep(node))
  );
}

/**
 * When feedback sent now will be handled, in words: before the run's first
 * publishing step (or the end, when it has none). Null once publishing
 * started.
 */
export function feedbackTiming(
  workflow: Workflow,
  state: FeedbackState | undefined,
): string {
  if (state?.publicationStarted !== undefined)
    return `"${state.publicationStarted.label}" already started publishing, so new feedback is recorded but not applied in this run.`;
  const publishing = workflow.nodes.filter(isPublicationStep);
  const first = publishing[0];
  if (first === undefined)
    return 'It is checked before the run finishes, or before its next approval.';
  return `It is checked before "${first.label ?? first.id}" publishes, or before the next approval if one comes first.`;
}
