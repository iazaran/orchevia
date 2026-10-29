import type {
  NodeKind,
  StoredNodeResult,
  StoredRun,
  Workflow,
  WorkflowEdge,
} from './workflow';
import {
  classifyEdgeLabel,
  MAX_ATTEMPTS_LIMIT,
  MAX_SUBAGENT_LIMIT,
  MAX_TOOL_CALL_LIMIT,
  validateLimitValue,
  type WorkflowLimits,
} from './workflow';

export interface FixtureResult {
  status: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  structured?: Record<string, unknown> | null;
}
export interface RunOptions {
  dryRun?: boolean;
  fixtures?: Record<string, FixtureResult[]>;
  spendLimitUsd?: number | null;
  /** Per-run override for the saved Agent-attempt budget (None inherits). */
  maxAgentAttempts?: number | null;
  /** Per-run override for the advisory tool-call allowance. */
  maxToolCalls?: number | null;
  /** Per-run override for the advisory nested-subagent allowance. */
  maxSubagents?: number | null;
  /** Explicitly ignore saved workflow limits for this run. */
  ignoreSavedLimits?: boolean;
}
export type RecoveryChoice = 'reuse' | 'replay' | 'skip';
export interface SpendPause {
  id: number;
  reportedUsd: number;
}
/** Durable pause when the enforced Agent-attempt budget is exhausted. */
export interface UsagePause {
  id: number;
  consumedAttempts: number;
  limitAttempts: number;
}
/** Effective per-run limits snapshotted at start (saved + overrides). */
export interface ResolvedLimits {
  maxAgentAttempts?: number;
  maxToolCalls?: number;
  maxSubagents?: number;
  spendLimitUsd?: number;
}
export interface RunExecution {
  options: RunOptions;
  recoveredFrom?: string;
  recoveryChoices?: Record<string, RecoveryChoice>;
  spendPause?: SpendPause;
  resolvedLimits?: ResolvedLimits;
  consumedAgentAttempts?: number;
  usagePause?: UsagePause;
}
export interface RecoveryNode {
  nodeId: string;
  label: string;
  kind: NodeKind;
  affected: boolean;
  previousStatus: string | null;
  choices: RecoveryChoice[];
}
export interface RecoveryPlan {
  sourceRunId: string;
  fingerprint: string;
  nodes: RecoveryNode[];
}
export const isEffectful = (kind: NodeKind): boolean =>
  ['command', 'agent', 'git', 'github', 'ticket', 'mcp'].includes(kind);

export function validateRunOptions(workflow: Workflow, options: RunOptions): void {
  const raw: unknown = options;
  if (!isRecord(raw)) throw new Error('Run options must be an object.');
  if (raw.dryRun !== undefined && typeof raw.dryRun !== 'boolean')
    throw new Error('dryRun must be a boolean.');
  if (raw.fixtures !== undefined && !isRecord(raw.fixtures))
    throw new Error('Fixtures must be an object keyed by node id.');
  if (
    options.spendLimitUsd !== undefined &&
    options.spendLimitUsd !== null &&
    (!Number.isFinite(options.spendLimitUsd) || options.spendLimitUsd <= 0)
  )
    throw new Error('Spend limit must be a positive finite USD amount.');
  for (const [key, value, max, label] of [
    [
      'maxAgentAttempts',
      options.maxAgentAttempts,
      MAX_ATTEMPTS_LIMIT,
      'Agent attempt limit',
    ],
    ['maxToolCalls', options.maxToolCalls, MAX_TOOL_CALL_LIMIT, 'Tool-call allowance'],
    ['maxSubagents', options.maxSubagents, MAX_SUBAGENT_LIMIT, 'Subagent allowance'],
  ] as const) {
    if (value === undefined || value === null) continue;
    const error = validateLimitValue(label, value, max);
    if (error !== null) throw new Error(error);
    void key;
  }
  if (
    options.ignoreSavedLimits !== undefined &&
    typeof options.ignoreSavedLimits !== 'boolean'
  )
    throw new Error('ignoreSavedLimits must be a boolean.');
  if (!options.dryRun && Object.keys(options.fixtures ?? {}).length)
    throw new Error('Fixtures require Dry run.');
  if (
    options.dryRun &&
    options.spendLimitUsd !== undefined &&
    options.spendLimitUsd !== null
  )
    throw new Error('Dry-run fixtures do not measure actual spend.');
  if (
    Object.keys(options).some(
      (key) =>
        ![
          'dryRun',
          'fixtures',
          'spendLimitUsd',
          'maxAgentAttempts',
          'maxToolCalls',
          'maxSubagents',
          'ignoreSavedLimits',
        ].includes(key),
    )
  )
    throw new Error('Unknown run option.');
  for (const [id, fixtures] of Object.entries(options.fixtures ?? {})) {
    const node = workflow.nodes.find((n) => n.id === id);
    if (!node || (!isEffectful(node.type) && node.type !== 'approval'))
      throw new Error(`Node '${id}' does not accept fixtures.`);
    if (!Array.isArray(fixtures) || fixtures.length > 1000)
      throw new Error('At most 1000 fixture attempts per node.');
    for (const fixture of fixtures) {
      if (!isRecord(fixture) || typeof fixture.status !== 'string')
        throw new Error('Each fixture needs a status.');
      if (
        Object.keys(fixture).some(
          (key) =>
            !['status', 'stdout', 'stderr', 'exitCode', 'structured'].includes(key),
        )
      )
        throw new Error('Unknown fixture field.');
      const allowed =
        node.type === 'approval'
          ? ['approved', 'rejected', 'paused']
          : ['succeeded', 'failed'];
      if (!allowed.includes(fixture.status))
        throw new Error(`Invalid fixture status for '${id}'.`);
      if (
        (fixture.stdout !== undefined && typeof fixture.stdout !== 'string') ||
        (fixture.stderr !== undefined && typeof fixture.stderr !== 'string')
      )
        throw new Error('Fixture output must be text.');
      if (
        fixture.exitCode !== undefined &&
        fixture.exitCode !== null &&
        (!Number.isInteger(fixture.exitCode) ||
          fixture.exitCode < -2147483648 ||
          fixture.exitCode > 2147483647)
      )
        throw new Error('Fixture exitCode must be a 32-bit integer.');
      if (
        new TextEncoder().encode(
          (fixture.stdout ?? '') +
            (fixture.stderr ?? '') +
            JSON.stringify(fixture.structured ?? null),
        ).length > 800000
      )
        throw new Error('Fixture output exceeds 800000 bytes.');
      if (
        fixture.structured !== undefined &&
        fixture.structured !== null &&
        !isRecord(fixture.structured)
      )
        throw new Error('Fixture structured output must be an object.');
      if (
        Object.keys(fixture.structured ?? {}).some((key) =>
          [
            'agentSession',
            'agentUsage',
            'agentActivity',
            'simulated',
            'reusedFrom',
          ].includes(key),
        )
      )
        throw new Error('Fixture contains reserved execution metadata.');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge saved workflow limits with per-run overrides (mirrors Rust
 * `resolve_limits`). `ignoreSavedLimits` clears every saved value while
 * explicit overrides still apply on top.
 */
export function resolveLimits(
  saved: WorkflowLimits | undefined,
  options: RunOptions,
): ResolvedLimits {
  const base = options.ignoreSavedLimits === true ? undefined : saved;
  const resolved: ResolvedLimits = {};
  const attempts = options.maxAgentAttempts ?? base?.maxAgentAttempts;
  if (attempts !== undefined) resolved.maxAgentAttempts = attempts;
  const tools = options.maxToolCalls ?? base?.maxToolCalls;
  if (tools !== undefined) resolved.maxToolCalls = tools;
  const subagents = options.maxSubagents ?? base?.maxSubagents;
  if (subagents !== undefined) resolved.maxSubagents = subagents;
  const spend = options.spendLimitUsd ?? base?.spendLimitUsd;
  if (spend !== undefined) resolved.spendLimitUsd = spend;
  return resolved;
}

export function remainingAttempts(
  limits: ResolvedLimits | undefined,
  consumed: number,
): number | undefined {
  if (limits?.maxAgentAttempts === undefined) return undefined;
  return Math.max(0, limits.maxAgentAttempts - consumed);
}

/** Agent attempts actually dispatched: new executions of Agent nodes only. */
export function countAgentAttempts(workflow: Workflow, rows: StoredNodeResult[]): number {
  const agentIds = new Set(
    workflow.nodes.filter((n) => n.type === 'agent').map((n) => n.id),
  );
  return rows.filter((row) => agentIds.has(row.nodeId) && isNewExecution(row)).length;
}

function isNewExecution(row: StoredNodeResult): boolean {
  const data = resultMetadata(row);
  return data.reusedFrom === undefined && data.simulated !== true;
}

export type Capability = 'enforced' | 'observed' | 'advisory' | 'unsupported';

export interface AdapterCapabilities {
  adapter: string;
  agentAttempts: Capability;
  agentTurns: Capability;
  toolCalls: Capability;
  subagents: Capability;
  spendEstimate: Capability;
  note: string;
}

/**
 * Honest per-adapter control coverage (mirrors Rust `adapter_capabilities`).
 * Only the run attempt budget is Orchevia-enforced; everything inside a
 * CLI's tool loop is advisory guidance plus observed stream counts.
 */
export function adapterCapabilities(adapter: string): AdapterCapabilities {
  if (adapter === 'codex')
    return {
      adapter,
      agentAttempts: 'enforced',
      agentTurns: 'advisory',
      toolCalls: 'observed',
      subagents: 'advisory',
      spendEstimate: 'unsupported',
      note: 'Attempts enforced per run by Orchevia. No verified Codex turn/spend flags: turns and subagents are advisory guidance; tool-completion events are observed where the CLI reports them. Codex runs report no USD.',
    };
  if (adapter === 'custom')
    return {
      adapter,
      agentAttempts: 'enforced',
      agentTurns: 'unsupported',
      toolCalls: 'unsupported',
      subagents: 'unsupported',
      spendEstimate: 'unsupported',
      note: 'Custom/text adapters report no usage: only the Orchevia attempt gate applies; turns, tools, subagents and spend are uncovered.',
    };
  return {
    adapter: 'claude',
    agentAttempts: 'enforced',
    agentTurns: 'advisory',
    toolCalls: 'advisory',
    subagents: 'advisory',
    spendEstimate: 'enforced',
    note: 'Attempts enforced per run by Orchevia. Turns/tools/subagents are advisory guidance plus observed stream counts: Claude --max-turns counts agentic turns, not tools, and --max-budget-usd is a client-side estimate that can overshoot; Orchevia passes neither flag itself.',
  };
}

/**
 * Suggest an API-equivalent target range from comparable measured history.
 * `undefined` means Insufficient history — never a fabricated rate.
 */
export function estimateRangeUsd(
  samplesUsd: number[],
  minSamples: number,
): { low: number; high: number; samples: number } | undefined {
  const valid = samplesUsd
    .filter((n) => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  if (valid.length < minSamples) return undefined;
  const low = valid[Math.floor(valid.length / 4)] ?? 0;
  const high = valid[Math.floor((valid.length * 3) / 4)] ?? low;
  return { low, high: Math.max(high, low), samples: valid.length };
}
export function resultMetadata(row: StoredNodeResult): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(row.structuredJson ?? '{}');
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}
export function reportedSpend(
  workflow: Workflow,
  rows: StoredNodeResult[],
  dryRun = false,
): { reportedUsd: number; reportedAttempts: number; unknownAttempts: number } {
  const result = { reportedUsd: 0, reportedAttempts: 0, unknownAttempts: 0 };
  if (dryRun) return result;
  for (const row of rows) {
    if (
      !workflow.nodes.some((n) => n.id === row.nodeId && n.type === 'agent') ||
      ['running', 'paused', 'skipped'].includes(row.status)
    )
      continue;
    const data = resultMetadata(row);
    if (data.reusedFrom !== undefined || data.simulated === true) continue;
    const cost = isRecord(data.agentUsage)
      ? data.agentUsage.reported_cost_usd
      : undefined;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
      result.reportedUsd += cost;
      result.reportedAttempts++;
    } else {
      result.unknownAttempts++;
    }
  }
  return result;
}

export function recoveryPlan(
  run: StoredRun,
  workflow: Workflow,
  rows: StoredNodeResult[],
  changed: string[] = [],
): RecoveryPlan {
  const latest = new Map<string, StoredNodeResult>();
  for (const row of rows)
    if (
      ['succeeded', 'failed', 'cancelled', 'approved', 'rejected', 'skipped'].includes(
        row.status,
      )
    )
      latest.set(row.nodeId, row);
  const affected = recoveryInvalidated(workflow, rows, changed);
  return {
    sourceRunId: run.id,
    fingerprint: `${run.id}:${String(rows.length)}:${String(rows.at(-1)?.id ?? 0)}`,
    nodes: workflow.nodes
      .filter((n) => isEffectful(n.type))
      .map((n) => {
        const prior = latest.get(n.id);
        return {
          nodeId: n.id,
          label: n.label ?? n.id,
          kind: n.type,
          affected: affected.has(n.id),
          previousStatus: prior?.status ?? null,
          choices:
            !affected.has(n.id) && prior?.status === 'succeeded'
              ? ['reuse', 'replay', 'skip']
              : ['replay', 'skip'],
        };
      }),
  };
}

export function recoveryInvalidated(
  workflow: Workflow,
  rows: StoredNodeResult[],
  changed: string[] = [],
): Set<string> {
  const latest = new Map<string, StoredNodeResult>();
  for (const row of rows)
    if (
      ['succeeded', 'failed', 'cancelled', 'approved', 'rejected', 'skipped'].includes(
        row.status,
      )
    )
      latest.set(row.nodeId, row);
  const affected = new Set(
    [...latest.values()]
      .filter((r) => ['failed', 'cancelled', 'rejected'].includes(r.status))
      .map((r) => r.nodeId),
  );
  changed.forEach((id) => affected.add(id));
  const dependencies = workflow.edges.map((e) => [e.source, e.target] as const);
  for (const node of workflow.nodes) {
    const text = JSON.stringify(node.config);
    for (const source of workflow.nodes)
      if (
        node.id !== source.id &&
        (node.config.contextRefs?.includes(source.id) ||
          node.config.inputRefs?.includes(source.id) ||
          (source.type === 'ticket' && text.includes('ticket.')) ||
          text.includes(`node.${source.id}.`) ||
          text.includes(`node.${source.id}"`) ||
          text.includes(`node.${source.id}}}`))
      )
        dependencies.push([source.id, node.id]);
  }
  for (;;) {
    let updated = false;
    for (const [source, target] of dependencies)
      if (affected.has(source) && !affected.has(target)) {
        affected.add(target);
        updated = true;
      }
    if (!updated) break;
  }
  return affected;
}

export interface TimelineEntry {
  id: number;
  nodeId: string;
  status: string;
  attempt: number;
  offsetMs: number | null;
  durationMs: number | null;
  reused: boolean;
}
export function timelineEntries(
  run: StoredRun,
  rows: StoredNodeResult[],
  now = Date.now(),
): TimelineEntry[] {
  const origin = Date.parse(run.startedAt);
  return rows.map((row, index) => {
    const start = Date.parse(row.startedAt);
    let end =
      row.finishedAt === undefined
        ? ['running', 'paused'].includes(run.status)
          ? now
          : Date.parse(run.finishedAt ?? '')
        : Date.parse(row.finishedAt);
    if (row.status === 'paused' || row.status === 'guardPaused') {
      const decision = rows
        .slice(index + 1)
        .find(
          (r) =>
            r.nodeId === row.nodeId &&
            ['approved', 'rejected', 'guardContinued'].includes(r.status),
        );
      end = decision
        ? Date.parse(decision.startedAt)
        : ['running', 'paused'].includes(run.status)
          ? now
          : Date.parse(run.finishedAt ?? '');
    }
    const reused = resultMetadata(row).reusedFrom !== undefined;
    // Older integration rows retained measured elapsed time but no start timestamp.
    // Preserve the measurement without inventing its position on the common axis.
    const legacyMeasured = !reused && start === end && (row.durationMs ?? 0) > 0;
    return {
      id: row.id,
      nodeId: row.nodeId,
      status: row.status,
      attempt: row.attempt ?? 1,
      offsetMs:
        !legacyMeasured && Number.isFinite(origin) && Number.isFinite(start)
          ? Math.max(0, start - origin)
          : null,
      durationMs: reused
        ? 0
        : legacyMeasured
          ? (row.durationMs ?? null)
          : Number.isFinite(start) && Number.isFinite(end) && end >= start
            ? end - start
            : null,
      reused,
    };
  });
}

type EdgeKind = 'success' | 'failure' | 'true' | 'false';

/** Mirrors `classify_edge_label`; unknown labels behave as success edges. */
function edgeKind(label?: string): EdgeKind {
  const kind = classifyEdgeLabel(label);
  return kind === 'unknown' ? 'success' : kind;
}

type Outcome = 'succeeded' | 'failed' | 'skipped' | 'cancelled';

const TERMINAL_STATUSES: Record<string, Outcome> = {
  succeeded: 'succeeded',
  approved: 'succeeded',
  failed: 'failed',
  rejected: 'failed',
  skipped: 'skipped',
  cancelled: 'cancelled',
};

/** The branch a condition row took: its structured `branch`, else its output. */
function branchOf(row: StoredNodeResult): boolean | null {
  try {
    const data: unknown = JSON.parse(row.structuredJson ?? '{}');
    if (isRecord(data) && typeof data.branch === 'string') return data.branch === 'true';
  } catch {
    // Older mock rows carry the branch only as their output.
  }
  const text = row.stdout.trim();
  return text === 'true' ? true : text === 'false' ? false : null;
}

/**
 * Browser-only replay of the engine's routing (`crates/core/src/engine.rs`):
 * the same loop-back edges and loop bodies, one arrival per edge per pass,
 * re-armed passes, held loop exits and released waits. History rows replay in
 * order; steps here run one at a time, so it never proves native concurrency.
 *
 * `skipped` lists the steps this replay skipped that have no skip row yet, in
 * the order the engine would record them.
 */
export function replayGraph(
  workflow: Workflow,
  rows: StoredNodeResult[],
): {
  ready: string[];
  skipped: string[];
  visits: Map<string, number>;
  error: string | null;
} {
  const nodes = new Map(workflow.nodes.map((n) => [n.id, n]));
  const edgesById = new Map(
    workflow.edges.map((edge, index) => [edge.id, { edge, index }]),
  );
  const outgoing = new Map<string, WorkflowEdge[]>();
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const edge of workflow.edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
  }
  const out = (id: string): WorkflowEdge[] => outgoing.get(id) ?? [];
  const into = (id: string): WorkflowEdge[] => incoming.get(id) ?? [];
  const reach = (from: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [from];
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      if (seen.has(id)) continue;
      seen.add(id);
      out(id).forEach((e) => stack.push(e.target));
    }
    return seen;
  };
  const maxVisits = (id: string): number =>
    Math.min(100, Math.max(1, nodes.get(id)?.config.maxVisits ?? 1));

  // Loop-back edges: edges into a step on the depth-first path from Start.
  const loopEdges = new Set<string>();
  const start = workflow.nodes.find((n) => n.type === 'start');
  if (start) {
    const onPath = new Set<string>();
    const seen = new Set([start.id]);
    const dfs = (id: string): void => {
      onPath.add(id);
      for (const edge of out(id)) {
        if (onPath.has(edge.target)) loopEdges.add(edge.id);
        else if (!seen.has(edge.target)) {
          seen.add(edge.target);
          dfs(edge.target);
        }
      }
      onPath.delete(id);
    };
    dfs(start.id);
  }

  // The steps each loop repeats: the natural loop of its loop-back edge, plus
  // the loops nested in it (whose condition branches out all land in it).
  const naturalLoop = (edge: WorkflowEdge): Set<string> => {
    const fromTarget = reach(edge.target);
    const body = new Set([edge.target]);
    const stack = [edge.source];
    for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
      if (!fromTarget.has(id) || body.has(id)) continue;
      body.add(id);
      into(id).forEach((e) => stack.push(e.source));
    }
    return body;
  };
  const branchesOut = (id: string, body: Set<string>): string[] =>
    nodes.get(id)?.type === 'condition'
      ? out(id)
          .filter((e) => ['true', 'false'].includes(edgeKind(e.label)))
          .filter((e) => !body.has(e.target))
          .map((e) => e.target)
      : [];
  const natural = workflow.edges
    .filter((edge) => loopEdges.has(edge.id))
    .map((edge) => ({ edge, body: naturalLoop(edge) }));
  const bodies = natural.map(({ body }) => new Set(body));
  // Bodies only grow, so this settles.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [inner, { edge, body }] of natural.entries()) {
      const innerBody = bodies[inner];
      if (innerBody === undefined) continue;
      for (const [outer, outerBody] of bodies.entries()) {
        if (
          inner === outer ||
          !outerBody.has(edge.target) ||
          [...innerBody].every((id) => outerBody.has(id))
        )
          continue;
        const nested = [...body].every((id) =>
          branchesOut(id, body).every((target) => outerBody.has(target)),
        );
        if (!nested) continue;
        innerBody.forEach((id) => outerBody.add(id));
        changed = true;
      }
    }
  }
  const loops = natural.map(({ edge }, i) => ({
    edgeId: edge.id,
    body: bodies[i] ?? new Set<string>(),
  }));

  const terminal = new Map<string, Outcome>();
  const visits = new Map<string, number>();
  const pending = new Map(
    workflow.nodes.map((n) => [
      n.id,
      into(n.id).filter((e) => !loopEdges.has(e.id)).length,
    ]),
  );
  const taken = new Set(start ? [start.id] : []);
  // Non-loop edges resolved this pass, and whether each was taken.
  const resolved = new Map<string, boolean>();
  // Untaken exits of loops that may still go round.
  const held = new Set<string>();
  // Skips this replay made that no row records yet.
  const unrecorded = new Set<string>();
  let error: string | null = null;

  const exitWaits = (source: string, target: string): boolean =>
    loops.some(
      ({ body }) =>
        body.has(source) &&
        !body.has(target) &&
        [...body].some((id) => !terminal.has(id)),
    );
  const markSkipped = (id: string): void => {
    if (terminal.has(id)) return;
    unrecorded.delete(id);
    unrecorded.add(id);
    terminal.set(id, 'skipped');
    out(id)
      .filter((e) => !loopEdges.has(e.id))
      .forEach((e) => resolveEdge(e.target, e.id, false));
  };
  // `resolveEdge` without holding loop exits.
  const settleEdge = (target: string, edgeId: string | null, isTaken: boolean): void => {
    if (edgeId !== null) held.delete(edgeId);
    if (terminal.has(target)) return;
    if (edgeId !== null) {
      const again = resolved.has(edgeId);
      resolved.set(edgeId, isTaken);
      if (again) return;
    }
    pending.set(target, Math.max(0, (pending.get(target) ?? 0) - 1));
    if (isTaken) taken.add(target);
    if ((pending.get(target) ?? 0) === 0 && !taken.has(target)) markSkipped(target);
  };
  function resolveEdge(target: string, edgeId: string | null, isTaken: boolean): void {
    if (terminal.has(target)) return;
    if (edgeId !== null) {
      // One arrival per edge per pass.
      if (resolved.has(edgeId)) {
        resolved.set(edgeId, isTaken);
        return;
      }
      const edge = edgesById.get(edgeId)?.edge;
      if (!isTaken && edge !== undefined && exitWaits(edge.source, target)) {
        held.add(edgeId);
        return;
      }
    }
    settleEdge(target, edgeId, isTaken);
  }
  const releaseSettledExits = (): void => {
    for (;;) {
      const settled = [...held]
        .map((id) => edgesById.get(id))
        .filter((entry) => entry !== undefined)
        .filter(({ edge }) => !exitWaits(edge.source, edge.target))
        .sort((a, b) => a.index - b.index);
      for (const id of held) if (!edgesById.has(id)) held.delete(id);
      if (settled.length === 0) return;
      settled.forEach(({ edge }) => settleEdge(edge.target, edge.id, false));
    }
  };
  const resetCycle = (loopEdge: WorkflowEdge): void => {
    const fromTarget = reach(loopEdge.target);
    const rearmed = new Set(loops.find((l) => l.edgeId === loopEdge.id)?.body ?? []);
    rearmed.add(loopEdge.source);
    rearmed.add(loopEdge.target);
    for (;;) {
      const more = [...fromTarget].filter(
        (id) =>
          !rearmed.has(id) &&
          terminal.get(id) === 'skipped' &&
          into(id).some((e) => !loopEdges.has(e.id) && rearmed.has(e.source)),
      );
      if (more.length === 0) break;
      more.forEach((id) => rearmed.add(id));
    }
    rearmed.forEach((id) => {
      terminal.delete(id);
      unrecorded.delete(id);
    });
    // A re-armed step arrives again at steps still waiting off the loop.
    rearmed.forEach((id) => {
      for (const edge of out(id)) {
        const waiting =
          !rearmed.has(edge.target) &&
          !terminal.has(edge.target) &&
          (pending.get(edge.target) ?? 0) > 0;
        if (loopEdges.has(edge.id) || !waiting || !resolved.delete(edge.id)) continue;
        pending.set(edge.target, (pending.get(edge.target) ?? 0) + 1);
        if (into(edge.target).some((e) => resolved.get(e.id) === true))
          taken.add(edge.target);
        else taken.delete(edge.target);
      }
    });
    rearmed.forEach((id) => {
      let count = 0;
      for (const edge of into(id)) {
        held.delete(edge.id);
        if (loopEdges.has(edge.id) || terminal.has(edge.source)) continue;
        resolved.delete(edge.id);
        count += 1;
      }
      pending.set(id, count);
      taken.delete(id);
    });
  };
  const loopLimit = (id: string): string =>
    `Loop limit exceeded at '${id}' (max ${String(maxVisits(id))} visits).`;
  /** Route a finished step; returns the run's failure, if this ends it. */
  const applyCompletion = (
    nodeId: string,
    outcome: Outcome,
    branch: boolean | null,
  ): string | null => {
    const node = nodes.get(nodeId);
    const isCondition = node?.type === 'condition';
    const takenLoop: WorkflowEdge[] = [];
    const takenNormal: WorkflowEdge[] = [];
    const untakenNormal: WorkflowEdge[] = [];
    for (const edge of out(nodeId)) {
      const kind = edgeKind(edge.label);
      const isTaken =
        outcome === 'succeeded'
          ? isCondition
            ? (branch === true && kind === 'true') ||
              (branch === false && kind === 'false')
            : kind === 'success'
          : outcome === 'failed' && kind === 'failure';
      if (loopEdges.has(edge.id)) {
        if (isTaken) takenLoop.push(edge);
      } else (isTaken ? takenNormal : untakenNormal).push(edge);
    }
    let failure: string | null = null;
    for (const edge of takenLoop) {
      if ((visits.get(edge.target) ?? 0) < maxVisits(edge.target)) {
        resetCycle(edge);
        resolveEdge(edge.target, null, true);
      } else failure = loopLimit(edge.target);
    }
    if (failure !== null) return failure;
    let routed = false;
    for (const edge of takenNormal) {
      if (terminal.has(edge.target)) continue;
      const used = visits.get(edge.target) ?? 0;
      if (used > 0 && used >= maxVisits(edge.target)) return loopLimit(edge.target);
      routed = true;
      resolveEdge(edge.target, edge.id, true);
    }
    for (const edge of untakenNormal) {
      if (terminal.has(edge.target)) continue;
      if (takenLoop.length === 0) resolveEdge(edge.target, edge.id, false);
      else if (exitWaits(nodeId, edge.target)) held.add(edge.id);
    }
    if (outcome === 'failed' && !routed && takenLoop.length === 0) {
      const label = node?.label ?? nodeId;
      failure =
        takenNormal.length === 0
          ? `Node '${label}' failed with no failure route.`
          : `Node '${label}' failed and its failure route already ran.`;
    }
    releaseSettledExits();
    return failure;
  };

  for (const row of rows) {
    const outcome = TERMINAL_STATUSES[row.status];
    if (!nodes.has(row.nodeId) || outcome === undefined) continue;
    // A skip this replay already made is the one this row records.
    if (outcome === 'skipped' && terminal.get(row.nodeId) === 'skipped') {
      unrecorded.delete(row.nodeId);
      continue;
    }
    if (outcome === 'succeeded' || outcome === 'failed')
      visits.set(row.nodeId, (visits.get(row.nodeId) ?? 0) + 1);
    terminal.set(row.nodeId, outcome);
    if (outcome === 'cancelled') {
      error ??= 'Run cancelled.';
      continue;
    }
    // Like the engine, keep replaying after a failure; the first one ends the run.
    error ??= applyCompletion(row.nodeId, outcome, branchOf(row));
  }
  if (start) {
    const reachable = reach(start.id);
    workflow.nodes.filter((n) => !reachable.has(n.id)).forEach((n) => markSkipped(n.id));
  }
  const readyNodes = (): string[] =>
    workflow.nodes
      .filter(
        (n) =>
          !terminal.has(n.id) &&
          (pending.get(n.id) ?? 0) === 0 &&
          taken.has(n.id) &&
          (visits.get(n.id) ?? 0) < maxVisits(n.id),
      )
      .map((n) => n.id);
  // When nothing can run, release the waits no step can end any more (exits a
  // loop left waiting when it ended another way); a run still stuck fails.
  let ready = readyNodes();
  while (
    error === null &&
    ready.length === 0 &&
    workflow.nodes.some((n) => !terminal.has(n.id))
  ) {
    const waiting = workflow.nodes
      .filter((n) => !terminal.has(n.id))
      .flatMap((n) => {
        const edges = into(n.id);
        const settled =
          edges.length > 0 &&
          edges.every((e) => loopEdges.has(e.id) || terminal.has(e.source));
        return settled && (pending.get(n.id) ?? 0) > 0
          ? [
              {
                id: n.id,
                unresolved: edges
                  .filter((e) => !loopEdges.has(e.id) && !resolved.has(e.id))
                  .map((e) => e.id),
              },
            ]
          : [];
      });
    if (waiting.length === 0) {
      const stuck = workflow.nodes.filter((n) => !terminal.has(n.id)).map((n) => n.id);
      error = `Scheduler deadlock: nodes never became ready: ${stuck.join(', ')}.`;
      break;
    }
    for (const { id, unresolved } of waiting) {
      unresolved.forEach((edgeId) => settleEdge(id, edgeId, false));
      while (!terminal.has(id) && (pending.get(id) ?? 0) > 0) settleEdge(id, null, false);
    }
    releaseSettledExits();
    ready = readyNodes();
  }
  return { ready, skipped: [...unrecorded], visits, error };
}
