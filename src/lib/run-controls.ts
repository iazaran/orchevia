import type { NodeKind, StoredNodeResult, StoredRun, Workflow } from './workflow';

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
}
export type RecoveryChoice = 'reuse' | 'replay' | 'skip';
export interface SpendPause {
  id: number;
  reportedUsd: number;
}
export interface RunExecution {
  options: RunOptions;
  recoveredFrom?: string;
  recoveryChoices?: Record<string, RecoveryChoice>;
  spendPause?: SpendPause;
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
      (key) => !['dryRun', 'fixtures', 'spendLimitUsd'].includes(key),
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

function edgeKind(label?: string): string {
  const value = (label ?? '').trim().toLowerCase();
  if (['true', 'yes', 'on true'].includes(value)) return 'true';
  if (['false', 'no', 'on false'].includes(value)) return 'false';
  if (['failure', 'fail', 'error', 'on failure'].includes(value)) return 'failure';
  return 'success';
}
/** Browser-only replay of the core routing contract; it never proves native concurrency. */
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
  const outgoing = (id: string): Workflow['edges'] =>
    workflow.edges.filter((e) => e.source === id);
  const loopEdges = new Set<string>();
  const color = new Map<string, number>();
  const dfs = (id: string): void => {
    color.set(id, 1);
    for (const edge of outgoing(id)) {
      if (color.get(edge.target) === 1) loopEdges.add(edge.id);
      else if (!color.has(edge.target)) dfs(edge.target);
    }
    color.set(id, 2);
  };
  const start = workflow.nodes.find((n) => n.type === 'start');
  if (start) dfs(start.id);
  workflow.nodes.forEach((n) => {
    if (!color.has(n.id)) dfs(n.id);
  });
  const pending = new Map(
    workflow.nodes.map((n) => [
      n.id,
      workflow.edges.filter((e) => e.target === n.id && !loopEdges.has(e.id)).length,
    ]),
  );
  const taken = new Set(start ? [start.id] : []);
  const terminal = new Map<string, string>();
  const visits = new Map<string, number>();
  let error: string | null = null;
  const skipped = new Set<string>();
  const reach = (from: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const id = stack.pop();
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      outgoing(id).forEach((e) => stack.push(e.target));
    }
    return seen;
  };
  const resolve = (target: string, isTaken: boolean): void => {
    pending.set(target, Math.max(0, (pending.get(target) ?? 0) - 1));
    if (isTaken) taken.add(target);
    if (pending.get(target) === 0 && !taken.has(target)) skip(target);
  };
  const skip = (id: string): void => {
    if (terminal.has(id)) return;
    terminal.set(id, 'skipped');
    skipped.add(id);
    outgoing(id)
      .filter((e) => !loopEdges.has(e.id))
      .forEach((e) => resolve(e.target, false));
  };
  const apply = (row: StoredNodeResult): void => {
    if (
      !nodes.has(row.nodeId) ||
      !['succeeded', 'failed', 'skipped', 'approved', 'rejected', 'cancelled'].includes(
        row.status,
      )
    )
      return;
    if (row.status === 'skipped' && terminal.get(row.nodeId) === 'skipped') return;
    const success = ['succeeded', 'approved'].includes(row.status);
    const failed = ['failed', 'rejected'].includes(row.status);
    if (success || failed) visits.set(row.nodeId, (visits.get(row.nodeId) ?? 0) + 1);
    terminal.set(row.nodeId, row.status);
    if (row.status === 'cancelled') {
      error = 'Run cancelled.';
      return;
    }
    const edges = outgoing(row.nodeId);
    const isTaken = (label?: string): boolean =>
      success
        ? nodes.get(row.nodeId)?.type === 'condition'
          ? edgeKind(label) === row.stdout.trim()
          : edgeKind(label) === 'success'
        : failed && edgeKind(label) === 'failure';
    const loops = edges.filter((e) => loopEdges.has(e.id) && isTaken(e.label));
    for (const edge of loops) {
      if (
        (visits.get(edge.target) ?? 0) >= (nodes.get(edge.target)?.config.maxVisits ?? 1)
      ) {
        error = `Loop limit exceeded at '${edge.target}'.`;
        return;
      }
      const cycle = [...reach(edge.target)].filter((id) => reach(id).has(row.nodeId));
      cycle.push(row.nodeId);
      cycle.forEach((id) => terminal.delete(id));
      cycle.forEach((id) => {
        pending.set(
          id,
          workflow.edges.filter(
            (e) => e.target === id && !loopEdges.has(e.id) && !terminal.has(e.source),
          ).length,
        );
        taken.delete(id);
      });
      resolve(edge.target, true);
    }
    edges
      .filter((e) => !loopEdges.has(e.id) && isTaken(e.label))
      .forEach((e) => {
        if (!terminal.has(e.target)) resolve(e.target, true);
      });
    if (!loops.length)
      edges
        .filter((e) => !loopEdges.has(e.id) && !isTaken(e.label))
        .forEach((e) => {
          if (!terminal.has(e.target)) resolve(e.target, false);
        });
    if (failed && !edges.some((e) => isTaken(e.label)))
      error = `Node '${row.nodeId}' failed with no failure route.`;
  };
  rows.forEach(apply);
  if (start) {
    const reachable = reach(start.id);
    workflow.nodes.filter((n) => !reachable.has(n.id)).forEach((n) => skip(n.id));
  }
  return {
    ready: workflow.nodes
      .filter(
        (n) =>
          !terminal.has(n.id) &&
          (pending.get(n.id) ?? 0) === 0 &&
          taken.has(n.id) &&
          (visits.get(n.id) ?? 0) < (n.config.maxVisits ?? 1),
      )
      .map((n) => n.id),
    skipped: [...skipped].filter(
      (id) => !rows.some((r) => r.nodeId === id && r.status === 'skipped'),
    ),
    visits,
    error,
  };
}
