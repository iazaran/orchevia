import type { RunExecution } from './run-controls';
/**
 * Workflow domain model (TypeScript mirror of `orchevia-core`).
 *
 * The persisted workflow definition is the source of truth and is shared
 * verbatim with the Rust backend. Keep these types in sync with
 * `crates/core/src/workflow.rs`.
 */

import { referencedVariables, WELL_KNOWN_ROLES } from './agents';
import { validateToolRules } from './permissions';

export const CURRENT_SCHEMA_VERSION = 6;

/** Upper bound for any node/profile timeout (12 h). Mirrors Rust MAX_TIMEOUT_SECS. */
export const MAX_TIMEOUT_SECS = 43200;

export type NodeKind =
  | 'start'
  | 'command'
  | 'approval'
  | 'agent'
  | 'condition'
  | 'git'
  | 'github'
  | 'ticket'
  | 'mcp'
  | 'end';

export interface Position {
  x: number;
  y: number;
}

export type ConditionLogic = 'and' | 'or';
export type ConditionOp =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'greater'
  | 'less'
  | 'greaterOrEqual'
  | 'lessOrEqual';

export interface ConditionClause {
  left: string;
  op: ConditionOp;
  right: string;
}

export interface ConditionConfig {
  logic: ConditionLogic;
  clauses: ConditionClause[];
}

export interface RetryPolicy {
  maxAttempts: number;
  delayMs?: number;
  backoff?: boolean;
}

export type GitOp =
  | { op: 'status' }
  | { op: 'diffSummary' }
  | { op: 'branchCreate'; name: string }
  | { op: 'checkout'; name: string; allowDirty?: boolean | undefined }
  | { op: 'stage'; paths?: string[] | undefined }
  | { op: 'commit'; message: string }
  | { op: 'worktreeAdd'; path: string; branch?: string | undefined }
  | { op: 'worktreeRemove'; path: string }
  | { op: 'worktreeList' }
  | { op: 'remotes' };

export type GitHubOp =
  | { op: 'prStatus' }
  | { op: 'listPrs'; state?: string | undefined }
  | { op: 'prDetails'; number: number }
  | { op: 'prFiles'; number: number }
  | { op: 'prChecks'; number: number }
  | {
      op: 'createPr';
      title: string;
      body?: string | undefined;
      base: string;
      head: string;
      draft?: boolean | undefined;
    }
  | { op: 'postComment'; number: number; body: string };

export interface WorkflowInput {
  name: string;
  label?: string | undefined;
  default?: string | undefined;
  required?: boolean | undefined;
}

export interface NodeConfig {
  executable?: string;
  args?: string[];
  workingDir?: string;
  message?: string;
  agentProfileId?: string;
  agentRole?: string;
  prompt?: string;
  inputRefs?: string[];
  sessionGroup?: string;
  sessionMaxTurns?: number;
  contextRefs?: string[];
  contextMaxChars?: number;
  /** Advisory per-node tool-call allowance (observed, never enforced). */
  maxToolCalls?: number;
  /** Advisory per-node nested-subagent allowance. */
  maxSubagents?: number;
  /**
   * Claude Code allow rules this Agent node needs, declared by the workflow
   * or template author. Import and run start show which ones the chosen
   * profile does not grant and offer to add them; nothing is granted implicitly.
   */
  requiredTools?: string[];
  timeoutSecs?: number;
  extendOnOutput?: boolean;
  retry?: RetryPolicy;
  maxVisits?: number;
  condition?: ConditionConfig;
  gitOp?: GitOp;
  githubOp?: GitHubOp;
  ticketKey?: string;
  mcpServerId?: string;
  mcpTool?: string;
  mcpArgs?: Record<string, string>;
}

export interface WorkflowNode {
  id: string;
  type: NodeKind;
  position: Position;
  config: NodeConfig;
  label?: string;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface Workflow {
  schemaVersion: number;
  id: string;
  name: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  inputs?: WorkflowInput[];
  defaults?: WorkflowDefaults;
  /** Saved, optional workflow-wide usage controls (v0.1.14). */
  limits?: WorkflowLimits;
}

/** Saved workflow-wide usage controls. Absent preserves ordinary execution. */
export interface WorkflowLimits {
  maxAgentAttempts?: number;
  maxToolCalls?: number;
  maxSubagents?: number;
  spendLimitUsd?: number;
}

/** Hard bounds mirror Rust MAX_*_LIMIT. */
export const MAX_ATTEMPTS_LIMIT = 10_000;
export const MAX_TOOL_CALL_LIMIT = 100_000;
export const MAX_SUBAGENT_LIMIT = 1_000;

export function validateLimitValue(
  name: string,
  value: number,
  max: number,
): string | null {
  if (!Number.isInteger(value) || value < 1)
    return `${name} must be a whole number of at least 1.`;
  if (value > max) return `${name} must not exceed ${String(max)}.`;
  return null;
}

export function validateWorkflowLimits(limits: WorkflowLimits): string | null {
  if (limits.maxAgentAttempts !== undefined) {
    const error = validateLimitValue(
      'Agent attempt limit',
      limits.maxAgentAttempts,
      MAX_ATTEMPTS_LIMIT,
    );
    if (error) return error;
  }
  if (limits.maxToolCalls !== undefined) {
    const error = validateLimitValue(
      'Tool-call allowance',
      limits.maxToolCalls,
      MAX_TOOL_CALL_LIMIT,
    );
    if (error) return error;
  }
  if (limits.maxSubagents !== undefined) {
    const error = validateLimitValue(
      'Subagent allowance',
      limits.maxSubagents,
      MAX_SUBAGENT_LIMIT,
    );
    if (error) return error;
  }
  if (
    limits.spendLimitUsd !== undefined &&
    (!Number.isFinite(limits.spendLimitUsd) || limits.spendLimitUsd <= 0)
  )
    return 'Spend limit must be a positive finite USD amount.';
  return null;
}

/** Repository/branch defaults shared by a workflow's Git/GitHub nodes. */
export interface WorkflowDefaults {
  repoDir?: string;
  branch?: string;
}

export type ValidationSeverity = 'error' | 'warning';

export interface ValidationIssue {
  code: string;
  message: string;
  severity: ValidationSeverity;
  nodeId?: string;
  /** The connection an issue is about (unknown endpoints, labels, loops). */
  edgeId?: string;
}

export type RunStatus =
  'pending' | 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled';

export interface StoredWorkflow {
  id: string;
  name: string;
  definition: Workflow;
  createdAt: string;
  updatedAt: string;
}

export interface StoredRun {
  execution?: RunExecution;
  id: string;
  workflowId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  inputs?: Record<string, string>;
}

export interface StoredNodeResult {
  id: number;
  runId: string;
  nodeId: string;
  status: string;
  exitCode?: number;
  stdout: string;
  stderr: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  attempt?: number;
  durationMs?: number;
  structuredJson?: string;
}

export interface ToolStatus {
  id: string;
  displayName: string;
  installed: boolean;
  version?: string;
  path?: string;
}

export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}${rand}`;
}

/**
 * Set workflow-level repo/branch defaults. Blank values clear the field; when
 * both are blank the whole `defaults` block is removed (kept absent rather
 * than empty, matching the Rust `skip_serializing_if` contract).
 */
export interface LayoutOptions {
  direction?: 'vertical' | 'horizontal';
  sizes?: Record<string, { width: number; height: number }>;
}
/** Rank strongly connected components; keep loops together and branch lanes stable. */
export function arrangeWorkflowPositions(
  nodes: Pick<WorkflowNode, 'id'>[],
  edges: Pick<WorkflowEdge, 'source' | 'target'>[],
  options: LayoutOptions = {},
): Record<string, Position> {
  const horizontal = options.direction === 'horizontal';
  const ids = new Set(nodes.map((n) => n.id));
  const outgoing = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const n of nodes) {
    outgoing.set(n.id, []);
    reverse.set(n.id, []);
  }
  for (const e of edges)
    if (ids.has(e.source) && ids.has(e.target)) {
      outgoing.get(e.source)?.push(e.target);
      reverse.get(e.target)?.push(e.source);
    }
  const visited = new Set<string>();
  const finish: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const next of outgoing.get(id) ?? []) visit(next);
    finish.push(id);
  };
  for (const n of nodes) visit(n.id);
  const groups: string[][] = [];
  const groupOf = new Map<string, number>();
  const collect = (id: string, index: number): void => {
    if (groupOf.has(id)) return;
    groupOf.set(id, index);
    groups[index]?.push(id);
    for (const prev of reverse.get(id) ?? []) collect(prev, index);
  };
  for (const id of finish.reverse())
    if (!groupOf.has(id)) {
      groups.push([]);
      collect(id, groups.length - 1);
    }
  const order = new Map(nodes.map((n, i) => [n.id, i]));
  for (const group of groups) {
    group.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    if (group.length < 2) continue;
    const members = new Set(group);
    const sequence: string[] = [];
    const seen = new Set<string>();
    const follow = (id: string): void => {
      if (!members.has(id) || seen.has(id)) return;
      seen.add(id);
      sequence.push(id);
      for (const child of outgoing.get(id) ?? []) follow(child);
    };
    // Enter a review cycle through its actual incoming edge before following the loop.
    for (const id of group)
      if ((reverse.get(id) ?? []).some((parent) => !members.has(parent))) follow(id);
    for (const id of group) follow(id);
    group.splice(0, group.length, ...sequence);
  }
  const next = groups.map(() => new Set<number>());
  const prev = groups.map(() => new Set<number>());
  for (const e of edges) {
    const a = groupOf.get(e.source);
    const b = groupOf.get(e.target);
    if (a !== undefined && b !== undefined && a !== b) {
      next[a]?.add(b);
      prev[b]?.add(a);
    }
  }
  const rank = groups.map(() => 0);
  const degree = prev.map((p) => p.size);
  const queue = groups.map((_, i) => i).filter((i) => degree[i] === 0);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const to of next[current] ?? []) {
      rank[to] = Math.max(rank[to] ?? 0, (rank[current] ?? 0) + 1);
      degree[to] = (degree[to] ?? 1) - 1;
      if (degree[to] === 0) queue.push(to);
    }
  }
  const dimension = (id: string): { major: number; cross: number } => {
    const size = options.sizes?.[id];
    const width = Math.max(240, size?.width ?? 240);
    const height = Math.max(100, size?.height ?? 100);
    return horizontal ? { major: width, cross: height } : { major: height, cross: width };
  };
  const bounds = groups.map((group) => ({
    major: group.reduce((sum, id) => sum + dimension(id).major + 80, 0) - 80,
    cross:
      Math.max(0, ...group.map((id) => dimension(id).cross)) +
      (group.length > 1 ? 80 : 0),
  }));
  const crossCenter = new Map<number, number>();
  const positions: Record<string, Position> = {};
  const isolated = groups
    .map((_, i) => i)
    .filter((i) => !prev[i]?.size && !next[i]?.size);
  const isolatedSet = new Set(isolated);
  const layers = Array.from({ length: Math.max(-1, ...rank) + 1 }, (_, r) =>
    groups.map((_, i) => i).filter((i) => rank[i] === r && !isolatedSet.has(i)),
  );
  const average = (neighbors: Set<number> | undefined): number | undefined => {
    const values = [...(neighbors ?? [])].flatMap((id) => {
      const center = crossCenter.get(id);
      return center === undefined ? [] : [center];
    });
    return values.length
      ? values.reduce((sum, n) => sum + n, 0) / values.length
      : undefined;
  };
  const sweep = (layer: number[], backwards: boolean): void => {
    const desired = (g: number): number =>
      average(backwards ? next[g] : prev[g]) ?? crossCenter.get(g) ?? 0;
    layer.sort(
      (a, b) =>
        desired(a) - desired(b) ||
        (order.get(groups[a]?.[0] ?? '') ?? 0) - (order.get(groups[b]?.[0] ?? '') ?? 0),
    );
    let cursor = -Infinity;
    const centers = new Map<number, number>();
    for (const g of layer) {
      const half = (bounds[g]?.cross ?? 0) / 2;
      const center = Math.max(desired(g), cursor + half);
      centers.set(g, center);
      cursor = center + half + 100;
    }
    // Packing pushes a fork's children apart; shift the layer so their mean stays
    // on the parents' center line instead of drifting a lane at every branch.
    const offset = layer.length
      ? layer.reduce((sum, g) => sum + (centers.get(g) ?? 0) - desired(g), 0) /
        layer.length
      : 0;
    for (const g of layer) crossCenter.set(g, (centers.get(g) ?? 0) - offset);
  };
  for (const layer of layers) sweep(layer, false);
  // A backward pass centers forks on their children and keeps joins near both
  // incoming branches. Alternating sweeps also reduce crossed parallel paths.
  for (let pass = 0; pass < 4; pass++) {
    for (const layer of [...layers].reverse()) sweep(layer, true);
    for (const layer of layers) sweep(layer, false);
  }
  const minimumCross = Math.min(
    0,
    ...layers.flatMap((layer) =>
      layer.map((g) => (crossCenter.get(g) ?? 0) - (bounds[g]?.cross ?? 0) / 2),
    ),
  );
  let majorCursor = 60;
  for (const layer of layers) {
    let layerMajor = 0;
    for (const g of layer) {
      const bound = bounds[g];
      if (!bound) continue;
      const center = (crossCenter.get(g) ?? 0) - minimumCross + 80;
      let cursor = majorCursor;
      for (const id of groups[g] ?? []) {
        const cross = center - dimension(id).cross / 2;
        positions[id] = horizontal ? { x: cursor, y: cross } : { x: cross, y: cursor };
        cursor += dimension(id).major + 80;
      }
      layerMajor = Math.max(layerMajor, bound.major);
    }
    majorCursor += layerMajor + 100;
  }
  // Only islands wrap into a compact grid; connected branches share their rank.
  // Keep them beyond the connected graph so large measured boxes cannot overlap.
  const islandMajor = Math.max(0, ...isolated.map((g) => bounds[g]?.major ?? 0)) + 100;
  let islandCross = 80;
  for (const [index, g] of isolated.entries()) {
    if (index % 5 === 0) islandCross = 80;
    const center = islandCross + (bounds[g]?.cross ?? 0) / 2;
    let cursor =
      (layers.some((layer) => layer.length) ? majorCursor : 60) +
      Math.floor(index / 5) * islandMajor;
    for (const id of groups[g] ?? []) {
      const cross = center - dimension(id).cross / 2;
      positions[id] = horizontal ? { x: cursor, y: cross } : { x: cross, y: cursor };
      cursor += dimension(id).major + 80;
    }
    islandCross += (bounds[g]?.cross ?? 0) + 100;
  }
  return positions;
}

export function setWorkflowDefaults(
  workflow: Workflow,
  repoDir: string,
  branch: string,
): Workflow {
  const repo = repoDir.trim();
  const br = branch.trim();
  if (repo === '' && br === '') {
    const next: Workflow = { ...workflow };
    delete next.defaults;
    return next;
  }
  return {
    ...workflow,
    defaults: {
      ...(repo === '' ? {} : { repoDir: repo }),
      ...(br === '' ? {} : { branch: br }),
    },
  };
}

/**
 * Parse workflow JSON (for the JSON editor / imports). Validates shape and
 * schema version; semantic validation stays with validateWorkflowLocal and
 * the backend.
 */
export function parseWorkflowJson(text: string): Workflow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Workflow JSON must be an object.');
  }
  const wf = parsed as Record<string, unknown>;
  const schemaVersion: unknown = wf['schemaVersion'];
  if (typeof schemaVersion !== 'number') {
    throw new Error('Workflow JSON needs a numeric schemaVersion.');
  }
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported schema version ${String(schemaVersion)} (this app reads up to ${String(CURRENT_SCHEMA_VERSION)}).`,
    );
  }
  if (!Array.isArray(wf['nodes']) || !Array.isArray(wf['edges'])) {
    throw new Error('Workflow JSON needs nodes[] and edges[] arrays.');
  }
  if (typeof wf['id'] !== 'string' || typeof wf['name'] !== 'string') {
    throw new Error('Workflow JSON needs string id and name.');
  }
  return parsed as Workflow;
}

export function createEmptyWorkflow(name: string): Workflow {
  const startId = newId('node');
  const endId = newId('node');
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: newId('wf'),
    name,
    nodes: [
      {
        id: startId,
        type: 'start',
        position: { x: 80, y: 80 },
        config: {},
        label: 'Start',
      },
      { id: endId, type: 'end', position: { x: 80, y: 320 }, config: {}, label: 'End' },
    ],
    edges: [{ id: newId('edge'), source: startId, target: endId }],
  };
}

/** The sample vertical-slice workflow: Start → Inspect Environment → Run Command → End. */
export function createSampleWorkflow(): Workflow {
  const ids = {
    start: newId('node'),
    env: newId('node'),
    cmd: newId('node'),
    end: newId('node'),
  };
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: newId('wf'),
    name: 'Sample: Environment Check',
    nodes: [
      {
        id: ids.start,
        type: 'start',
        position: { x: 80, y: 60 },
        config: {},
        label: 'Start',
      },
      {
        id: ids.env,
        type: 'command',
        position: { x: 80, y: 180 },
        config: { executable: 'uname', args: ['-a'] },
        label: 'Inspect Environment',
      },
      {
        id: ids.cmd,
        type: 'command',
        position: { x: 80, y: 300 },
        config: { executable: 'echo', args: ['Hello from Orchevia'] },
        label: 'Run Command',
      },
      { id: ids.end, type: 'end', position: { x: 80, y: 420 }, config: {}, label: 'End' },
    ],
    edges: [
      { id: newId('edge'), source: ids.start, target: ids.env },
      { id: newId('edge'), source: ids.env, target: ids.cmd },
      { id: newId('edge'), source: ids.cmd, target: ids.end },
    ],
  };
}

/** Deterministic execution order: walk from Start following first edges. */
export function planExecutionOrder(wf: Workflow): string[] {
  const start = wf.nodes.find((n) => n.type === 'start');
  if (start === undefined) throw new Error('Workflow has no Start node.');
  const order: string[] = [];
  const visited = new Set<string>();
  let current: string | undefined = start.id;
  while (current !== undefined) {
    if (visited.has(current)) throw new Error(`Cycle detected at node '${current}'.`);
    visited.add(current);
    order.push(current);
    const node = wf.nodes.find((n) => n.id === current);
    if (node?.type === 'end') break;
    current = wf.edges.find((e) => e.source === current)?.target;
  }
  return order;
}

/** The step an issue belongs to, by its label (or id); null for workflow-wide issues. */
export function issueNodeLabel(wf: Workflow, issue: ValidationIssue): string | null {
  if (issue.nodeId === undefined) return null;
  const node = wf.nodes.find((n) => n.id === issue.nodeId);
  if (node === undefined) return null;
  return node.label?.trim() || node.id;
}

/**
 * Every code `validateWorkflowLocal` can report — the same list as Rust
 * `VALIDATION_CODES`. The shared fixture `src/test/validation-parity.json`
 * holds cases both validators must answer identically.
 */
export const VALIDATION_CODES = [
  'schema-too-new',
  'name-required',
  'single-start',
  'end-required',
  'edge-unknown-source',
  'edge-unknown-target',
  'edge-self-loop',
  'command-executable-required',
  'command-executable-suspicious',
  'command-timeout-invalid',
  'agent-session-group-invalid',
  'agent-session-variable-invalid',
  'agent-session-turns-invalid',
  'agent-context-limit-invalid',
  'agent-context-ref-invalid',
  'agent-profile-required',
  'agent-role-unknown',
  'agent-prompt-required',
  'agent-timeout-invalid',
  'agent-input-unknown',
  'agent-tool-allowance-invalid',
  'agent-subagent-allowance-invalid',
  'agent-required-tools-invalid',
  'agent-allowance-misplaced',
  'agent-required-tools-misplaced',
  'prompt-unknown-variable',
  'condition-required',
  'condition-unknown-ref',
  'condition-branches-required',
  'git-op-required',
  'git-dir-required',
  'git-branch-required',
  'git-branch-invalid',
  'git-paths-required',
  'git-message-required',
  'git-path-required',
  'github-op-required',
  'github-title-required',
  'github-branches-required',
  'github-body-required',
  'ticket-key-required',
  'ticket-server-required',
  'mcp-server-required',
  'mcp-tool-required',
  'retry-unbounded',
  'retry-delay-invalid',
  'loop-limit-invalid',
  'input-name-invalid',
  'input-duplicate',
  'workflow-limits-invalid',
  'edge-label-unknown',
  'edge-label-misplaced',
  'cycle-needs-condition',
  'cycle-unbounded',
  'cycle-into-end',
  'unreachable-node',
  'dead-end-node',
] as const;

export type ValidationCode = (typeof VALIDATION_CODES)[number];

/**
 * Error codes that mean "this machine still needs configuring" rather than a
 * broken graph (mirrors Rust `SETUP_ISSUE_CODES`): templates and drafts carry
 * them into the editor as setup items instead of being refused.
 */
export const SETUP_ISSUE_CODES: readonly string[] = [
  'git-dir-required',
  'ticket-server-required',
  'mcp-server-required',
];

/** Routing meaning of an edge label; unknown labels route like success. */
export type EdgeKind = 'success' | 'failure' | 'true' | 'false' | 'unknown';

/** Classify an edge label (trimmed, ASCII case-insensitive). Mirrors Rust `classify_edge_label`. */
export function classifyEdgeLabel(label?: string): EdgeKind {
  const value = (label ?? '').trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (['', 'success', 'ok', 'on success', 'default'].includes(value)) return 'success';
  if (['failure', 'fail', 'error', 'on failure', 'on error'].includes(value))
    return 'failure';
  if (['true', 'yes', 'on true'].includes(value)) return 'true';
  if (['false', 'no', 'on false'].includes(value)) return 'false';
  return 'unknown';
}

/**
 * Loop-back edges: edges whose target is still on the depth-first path from
 * Start. Mirrors Rust `find_loop_edges` step for step (same visiting order).
 */
export function findLoopEdges(wf: Workflow): Set<string> {
  const loops = new Set<string>();
  const start = wf.nodes.find((n) => n.type === 'start');
  if (start === undefined) return loops;
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const edge of wf.edges) {
    const list = outgoing.get(edge.source) ?? [];
    list.push(edge);
    outgoing.set(edge.source, list);
  }
  const visited = new Set<string>();
  const onStack = new Set<string>([start.id]);
  const stack: [string, number][] = [[start.id, 0]];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const [nodeId, index] = top;
    const edge = outgoing.get(nodeId)?.[index];
    if (edge === undefined) {
      onStack.delete(nodeId);
      continue;
    }
    stack.push([nodeId, index + 1]);
    if (onStack.has(edge.target)) {
      loops.add(edge.id);
    } else if (!visited.has(edge.target)) {
      visited.add(edge.target);
      onStack.add(edge.target);
      stack.push([edge.target, 0]);
    }
  }
  return loops;
}

/** Node ids reachable from `from` along edges, including `from`. */
function reachableFrom(wf: Workflow, from: string): Set<string> {
  const seen = new Set<string>();
  const pending = [from];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of wf.edges) if (edge.source === current) pending.push(edge.target);
  }
  return seen;
}

/** Valid input (and developer node key) name. Mirrors Rust `is_valid_input_name`. */
export function isValidInputName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name);
}

/** Why a branch name is unusable, or null. Mirrors Rust `git::validate_branch_name`. */
export function branchNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Branch name must not be empty.';
  // Rust counts UTF-8 bytes, not characters.
  if (new TextEncoder().encode(trimmed).length > 200) return 'Branch name is too long.';
  for (const bad of [' ', '~', '^', ':', '?', '*', '[', '\\', "'", '"', '\n']) {
    if (trimmed.includes(bad)) return `Branch name contains invalid character '${bad}'.`;
  }
  if (trimmed.startsWith('-') || trimmed.includes('..') || trimmed.endsWith('/'))
    return 'Branch name is not a valid git ref.';
  return null;
}

const KIND_NAMES: Record<NodeKind, string> = {
  start: 'Start',
  command: 'Command',
  approval: 'Approval',
  agent: 'Agent',
  condition: 'Condition',
  git: 'Git',
  github: 'GitHub',
  ticket: 'Ticket',
  mcp: 'Mcp',
  end: 'End',
};

function nodeLabel(node: WorkflowNode): string {
  const label = node.label ?? '';
  return label.trim() === '' ? `${KIND_NAMES[node.type]} (${node.id})` : label;
}

const TICKET_FIELDS = [
  'key',
  'title',
  'description',
  'acceptanceCriteria',
  'status',
  'url',
];
const NODE_FIELDS = ['output', 'status', 'exitCode', 'severity', 'visits'];

/**
 * Check a `dotted.path` variable against workflow inputs, node ids and the
 * `workflow.*`/`ticket.*` namespaces. Mirrors Rust `check_variable_ref`.
 */
function variableRefProblem(
  wf: Workflow,
  name: string,
  nodeIds: ReadonlySet<string>,
): string | null {
  const [head = '', second, third] = name.split('.');
  switch (head) {
    case 'workflow':
      return second === 'name' || second === 'id'
        ? null
        : `'${name}': workflow has no field '${second ?? ''}'.`;
    case 'input':
      if (second === undefined) return `'${name}': expected input.<name>.`;
      return (wf.inputs ?? []).some((i) => i.name === second)
        ? null
        : `'${name}': no workflow input '${second}'.`;
    case 'ticket':
      if (second === undefined) return `'${name}': expected ticket.<field>.`;
      return TICKET_FIELDS.includes(second)
        ? null
        : `'${name}': ticket has no field '${second}'.`;
    case 'node':
      if (second === undefined) return `'${name}': expected node.<id>[.field].`;
      if (!nodeIds.has(second)) return `'${name}': no node '${second}'.`;
      return third === undefined || NODE_FIELDS.includes(third)
        ? null
        : `'${name}': node has no field '${third}'.`;
    default:
      // Bare single-segment names are legacy shorthand for node outputs.
      if (!name.includes('.'))
        return nodeIds.has(head)
          ? null
          : `'${name}': no node, input, or workflow field matches.`;
      return `'${name}': must start with workflow., input., or node..`;
  }
}

function validTimeout(seconds: number | undefined): boolean {
  return (
    seconds === undefined ||
    (Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_TIMEOUT_SECS)
  );
}

type GitIssue = [ValidationCode, string];

/** Per-operation Git fields. Mirrors Rust `validate_git_op`. */
function gitOpIssues(op: GitOp, defaultBranch: string | undefined): GitIssue[] {
  const blank = (s: string): boolean => s.trim() === '';
  switch (op.op) {
    case 'status':
    case 'diffSummary':
    case 'worktreeList':
    case 'remotes':
      return [];
    case 'branchCreate':
    case 'checkout': {
      const name = blank(op.name) ? (defaultBranch ?? '') : op.name;
      if (blank(name))
        return [
          [
            'git-branch-required',
            'Git branch operation needs a name: set it on the step or set a workflow default branch.',
          ],
        ];
      const problem = branchNameProblem(name);
      return problem === null ? [] : [['git-branch-invalid', problem]];
    }
    case 'stage':
      return (op.paths ?? []).every(blank)
        ? [
            [
              'git-paths-required',
              'Stage needs at least one explicit path (no implicit -A).',
            ],
          ]
        : [];
    case 'commit':
      return blank(op.message)
        ? [['git-message-required', 'Commit needs an explicit message.']]
        : [];
    case 'worktreeAdd': {
      const found: GitIssue[] = [];
      if (blank(op.path))
        found.push(['git-path-required', 'Worktree needs an explicit path.']);
      if (op.branch !== undefined && !blank(op.branch)) {
        const problem = branchNameProblem(op.branch);
        if (problem !== null) found.push(['git-branch-invalid', problem]);
      }
      return found;
    }
    case 'worktreeRemove':
      return blank(op.path)
        ? [['git-path-required', 'Worktree removal needs an explicit path.']]
        : [];
    default:
      // Unknown operations cannot load in the backend; nothing to check here.
      return [];
  }
}

/** Per-operation GitHub fields. Mirrors Rust `validate_github_op`. */
function githubOpIssues(op: GitHubOp, defaultBranch: string | undefined): GitIssue[] {
  if (op.op === 'createPr') {
    const found: GitIssue[] = [];
    if (op.title.trim() === '')
      found.push(['github-title-required', 'PR creation needs an explicit title.']);
    if (op.base.trim() === '' || (op.head.trim() === '' && defaultBranch === undefined))
      found.push([
        'github-branches-required',
        'PR creation needs base and head branches (a blank head uses the workflow default branch).',
      ]);
    return found;
  }
  if (op.op === 'postComment' && op.body.trim() === '')
    return [['github-body-required', 'Comments need an explicit body.']];
  return [];
}

/**
 * Client-side validation for instant feedback and the browser mock. The
 * backend re-validates authoritatively; both report the same codes for the
 * same workflow (pinned by the shared parity fixture).
 */
export function validateWorkflowLocal(wf: Workflow): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (
    severity: ValidationSeverity,
    code: ValidationCode,
    message: string,
    nodeId?: string,
    edgeId?: string,
  ): void => {
    issues.push({
      code,
      message,
      severity,
      ...(nodeId === undefined ? {} : { nodeId }),
      ...(edgeId === undefined ? {} : { edgeId }),
    });
  };
  const error = (
    code: ValidationCode,
    message: string,
    nodeId?: string,
    edgeId?: string,
  ): void => {
    push('error', code, message, nodeId, edgeId);
  };
  const warning = (code: ValidationCode, message: string, nodeId?: string): void => {
    push('warning', code, message, nodeId);
  };

  if (wf.schemaVersion > CURRENT_SCHEMA_VERSION) {
    error(
      'schema-too-new',
      `Workflow schema v${String(wf.schemaVersion)} is newer than supported v${String(CURRENT_SCHEMA_VERSION)}. Please update Orchevia.`,
    );
    return issues;
  }
  if (wf.name.trim() === '') error('name-required', 'Workflow name must not be empty.');
  const starts = wf.nodes.filter((n) => n.type === 'start');
  if (starts.length !== 1)
    error(
      'single-start',
      `Workflow must have exactly one Start node, found ${String(starts.length)}.`,
    );
  if (!wf.nodes.some((n) => n.type === 'end'))
    error('end-required', 'Workflow must have at least one End node.');

  const nodeIds = new Set(wf.nodes.map((n) => n.id));
  for (const edge of wf.edges) {
    if (!nodeIds.has(edge.source))
      error(
        'edge-unknown-source',
        `Edge '${edge.id}' references unknown source node '${edge.source}'.`,
        undefined,
        edge.id,
      );
    if (!nodeIds.has(edge.target))
      error(
        'edge-unknown-target',
        `Edge '${edge.id}' references unknown target node '${edge.target}'.`,
        undefined,
        edge.id,
      );
    if (edge.source === edge.target)
      error(
        'edge-self-loop',
        `Edge '${edge.id}' connects a node to itself.`,
        edge.source,
        edge.id,
      );
  }

  const defaultBranch = (wf.defaults?.branch ?? '').trim() || undefined;
  const hasDefaultDir = (wf.defaults?.repoDir ?? '').trim() !== '';
  const needsDir = (node: WorkflowNode): boolean =>
    (node.config.workingDir ?? '').trim() === '' && !hasDefaultDir;

  for (const node of wf.nodes) {
    const config = node.config;
    const at = node.id;
    const retry = (): void => {
      if (config.retry === undefined) return;
      const { maxAttempts, delayMs } = config.retry;
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)
        error('retry-unbounded', 'Retry max attempts must be between 1 and 10.', at);
      if (delayMs !== undefined && (delayMs < 0 || delayMs > 60000))
        error('retry-delay-invalid', 'Retry delay must not exceed 60 seconds.', at);
    };
    const maxVisits = config.maxVisits;
    if (
      maxVisits !== undefined &&
      (!Number.isInteger(maxVisits) || maxVisits < 1 || maxVisits > 100)
    )
      error('loop-limit-invalid', 'Node max visits must be between 1 and 100.', at);

    switch (node.type) {
      case 'command': {
        const exe = (config.executable ?? '').trim();
        if (exe === '')
          error(
            'command-executable-required',
            'Command node requires an executable.',
            at,
          );
        else if (exe === 'compose')
          warning(
            'command-executable-suspicious',
            '`compose` is not a standalone tool here — use executable `docker` with args starting `compose` (or the `docker-compose` binary).',
            at,
          );
        if (!validTimeout(config.timeoutSecs))
          error(
            'command-timeout-invalid',
            `Command timeout must be between 1 second and 12 hours (${String(MAX_TIMEOUT_SECS)}).`,
            at,
          );
        retry();
        break;
      }
      case 'agent': {
        const group = config.sessionGroup;
        if (group !== undefined) {
          if (
            group.trim() === '' ||
            Array.from(group).length > 256 ||
            /[\0\n\r]/.test(group)
          )
            error(
              'agent-session-group-invalid',
              'Session group must be 1–256 characters with no line breaks.',
              at,
            );
          for (const name of referencedVariables(group)) {
            const problem = name.includes('.')
              ? variableRefProblem(wf, name, nodeIds)
              : `Session variable '${name}' needs a namespace; use node.${name}.output for a node output.`;
            if (problem !== null) error('agent-session-variable-invalid', problem, at);
          }
        }
        const turns = config.sessionMaxTurns;
        if (
          turns !== undefined &&
          (!Number.isInteger(turns) || turns < 1 || turns > 20 || group === undefined)
        )
          error(
            'agent-session-turns-invalid',
            'Session max turns must be 1–20 and requires a session group.',
            at,
          );
        const contextRefs = config.contextRefs ?? [];
        const chars = config.contextMaxChars;
        if (
          chars !== undefined &&
          (!Number.isInteger(chars) ||
            chars < 256 ||
            chars > 64000 ||
            contextRefs.length === 0)
        )
          error(
            'agent-context-limit-invalid',
            'Context budget must be 256–64000 characters and requires context references.',
            at,
          );
        if (contextRefs.length > 16)
          error('agent-context-ref-invalid', 'Select at most 16 context references.', at);
        const seen = new Set<string>();
        for (const id of contextRefs) {
          if (id === node.id || !nodeIds.has(id) || seen.has(id))
            error(
              'agent-context-ref-invalid',
              `Context reference '${id}' must be a unique, existing, different node.`,
              at,
            );
          seen.add(id);
        }
        const profile = (config.agentProfileId ?? '').trim();
        const role = (config.agentRole ?? '').trim();
        if (profile === '' && role === '')
          error(
            'agent-profile-required',
            'AI Agent node requires an Agent Profile (or a role for templates/proposals).',
            at,
          );
        if (role !== '' && !(WELL_KNOWN_ROLES as readonly string[]).includes(role))
          warning(
            'agent-role-unknown',
            `Agent role '${role}' is not a well-known role; resolve it before running.`,
            at,
          );
        if ((config.prompt ?? '').trim() === '')
          error(
            'agent-prompt-required',
            'AI Agent node requires a prompt/instruction.',
            at,
          );
        if (!validTimeout(config.timeoutSecs))
          error(
            'agent-timeout-invalid',
            `AI Agent timeout must be between 1 second and 12 hours (${String(MAX_TIMEOUT_SECS)}).`,
            at,
          );
        for (const input of config.inputRefs ?? []) {
          if (!nodeIds.has(input))
            error(
              'agent-input-unknown',
              `AI Agent node references unknown node '${input}'.`,
              at,
            );
        }
        if (config.maxToolCalls !== undefined) {
          const problem = validateLimitValue(
            'Node tool-call allowance',
            config.maxToolCalls,
            MAX_TOOL_CALL_LIMIT,
          );
          if (problem !== null) error('agent-tool-allowance-invalid', problem, at);
        }
        if (config.maxSubagents !== undefined) {
          const problem = validateLimitValue(
            'Node subagent allowance',
            config.maxSubagents,
            MAX_SUBAGENT_LIMIT,
          );
          if (problem !== null) error('agent-subagent-allowance-invalid', problem, at);
        }
        for (const message of validateToolRules(
          config.requiredTools ?? [],
          'Required tools',
        ))
          error('agent-required-tools-invalid', message, at);
        retry();
        if (config.prompt !== undefined)
          for (const name of referencedVariables(config.prompt)) {
            const problem = variableRefProblem(wf, name, nodeIds);
            if (problem !== null)
              error(
                'prompt-unknown-variable',
                `Prompt references unknown variable: ${problem}`,
                at,
              );
          }
        break;
      }
      case 'condition': {
        const condition = config.condition;
        if (condition === undefined) {
          error(
            'condition-required',
            'Condition node requires a condition expression.',
            at,
          );
          break;
        }
        if (condition.clauses.length === 0)
          error('condition-required', 'Condition node requires at least one clause.', at);
        for (const clause of condition.clauses) {
          const problem = variableRefProblem(wf, clause.left, nodeIds);
          if (problem !== null)
            error(
              'condition-unknown-ref',
              `Condition references unknown variable: ${problem}`,
              at,
            );
        }
        const outs = wf.edges.filter((e) => e.source === node.id);
        const hasTrue = outs.some((e) => classifyEdgeLabel(e.label) === 'true');
        const hasFalse = outs.some((e) => classifyEdgeLabel(e.label) === 'false');
        if (!hasTrue || !hasFalse)
          error(
            'condition-branches-required',
            "Condition node needs one 'true' and one 'false' outgoing edge (labels).",
            at,
          );
        break;
      }
      case 'git':
        if (config.gitOp === undefined)
          error('git-op-required', 'Git node requires an operation.', at);
        else
          for (const [code, message] of gitOpIssues(config.gitOp, defaultBranch))
            error(code, message, at);
        if (needsDir(node))
          error(
            'git-dir-required',
            'Git node requires a working directory: set it on the node or set a workflow default (select the canvas background to edit Workflow settings).',
            at,
          );
        break;
      case 'github':
        if (config.githubOp === undefined)
          error('github-op-required', 'GitHub node requires an operation.', at);
        else
          for (const [code, message] of githubOpIssues(config.githubOp, defaultBranch))
            error(code, message, at);
        if (needsDir(node))
          error(
            'git-dir-required',
            'GitHub node requires a working directory: set it on the node or set a workflow default (select the canvas background to edit Workflow settings).',
            at,
          );
        break;
      case 'ticket':
        if ((config.ticketKey ?? '').trim() === '')
          error(
            'ticket-key-required',
            'Ticket node requires a ticket key ({{…}} templates allowed).',
            at,
          );
        if ((config.mcpServerId ?? '').trim() === '')
          error(
            'ticket-server-required',
            'Ticket node requires an MCP server (Jira source).',
            at,
          );
        break;
      case 'mcp':
        if ((config.mcpServerId ?? '').trim() === '')
          error('mcp-server-required', 'MCP node requires a server.', at);
        if ((config.mcpTool ?? '').trim() === '')
          error('mcp-tool-required', 'MCP node requires a tool name.', at);
        break;
      case 'start':
      case 'end':
      case 'approval':
        break;
    }
    // Agent-only settings anywhere else would be silently ignored: refuse them.
    if (
      node.type !== 'agent' &&
      (config.maxToolCalls !== undefined || config.maxSubagents !== undefined)
    )
      error(
        'agent-allowance-misplaced',
        'Tool-call and subagent allowances only apply to AI Agent nodes.',
        at,
      );
    if (node.type !== 'agent' && (config.requiredTools ?? []).length > 0)
      error(
        'agent-required-tools-misplaced',
        'Required tools only apply to AI Agent nodes.',
        at,
      );
  }

  const seenInputs = new Set<string>();
  for (const input of wf.inputs ?? []) {
    if (!isValidInputName(input.name))
      error(
        'input-name-invalid',
        `Input name '${input.name}' must start with a letter/underscore and hold letters, digits, '_' or '-'.`,
      );
    if (seenInputs.has(input.name))
      error('input-duplicate', `Duplicate workflow input '${input.name}'.`);
    seenInputs.add(input.name);
  }

  if (wf.limits !== undefined) {
    const problem = validateWorkflowLimits(wf.limits);
    if (problem !== null) error('workflow-limits-invalid', problem);
  }

  const byId = new Map(wf.nodes.map((n) => [n.id, n]));
  for (const edge of wf.edges) {
    const kind = classifyEdgeLabel(edge.label);
    if (kind === 'unknown') {
      push(
        'warning',
        'edge-label-unknown',
        `Edge '${edge.id}' has an unrecognized label '${edge.label ?? ''}'; it will behave as a success edge.`,
        undefined,
        edge.id,
      );
    } else if (
      (kind === 'true' || kind === 'false') &&
      byId.get(edge.source)?.type !== 'condition'
    ) {
      error(
        'edge-label-misplaced',
        `Edge '${edge.id}' uses a true/false label but its source is not a Condition node.`,
        undefined,
        edge.id,
      );
    }
  }

  // Every loop needs a Condition to leave it and an explicit bound on each step.
  const loopEdges = findLoopEdges(wf);
  const loops = wf.edges.filter((e) => loopEdges.has(e.id));
  const unbounded = new Set<string>();
  for (const edge of loops) {
    const fromTarget = reachableFrom(wf, edge.target);
    const cycle = wf.nodes.filter(
      (n) => fromTarget.has(n.id) && reachableFrom(wf, n.id).has(edge.source),
    );
    if (!cycle.some((n) => n.type === 'condition'))
      error(
        'cycle-needs-condition',
        `Cycle through edge '${edge.id}' has no Condition node to guard it; loops must branch on a Condition.`,
        edge.source,
        edge.id,
      );
    for (const node of cycle) {
      if ((node.config.maxVisits ?? 1) >= 2 || unbounded.has(node.id)) continue;
      unbounded.add(node.id);
      error(
        'cycle-unbounded',
        `Node '${nodeLabel(node)}' is on a cycle but has no explicit loop bound (set max visits >= 2).`,
        node.id,
      );
    }
  }
  for (const edge of loops) {
    if (byId.get(edge.target)?.type === 'end')
      error(
        'cycle-into-end',
        `Loop edge '${edge.id}' targets an End node, which terminates the run.`,
        edge.target,
        edge.id,
      );
  }

  const start = starts.length === 1 ? starts[0] : undefined;
  if (start !== undefined) {
    const reachable = reachableFrom(wf, start.id);
    for (const node of wf.nodes) {
      if (!reachable.has(node.id))
        warning(
          'unreachable-node',
          `Node '${nodeLabel(node)}' is unreachable from Start and will not execute.`,
          node.id,
        );
    }
    for (const node of wf.nodes) {
      if (node.type === 'end' || wf.edges.some((e) => e.source === node.id)) continue;
      warning(
        'dead-end-node',
        `Node '${nodeLabel(node)}' has no outgoing connection; the run will stop there.`,
        node.id,
      );
    }
  }
  return issues;
}

/**
 * Next auto-label for an edge drawn out of a Condition node.
 * First branch → 'true', second → 'false' (extra edges default to 'false'
 * and the user relabels by clicking the edge).
 */
export function nextBranchLabel(existing: (string | undefined)[]): 'true' | 'false' {
  return existing.some((l) => classifyEdgeLabel(l) === 'true') ? 'false' : 'true';
}

/**
 * Delete steps and edges together: a step's edges go with it, and the steps
 * that remain stop referring to it (handoff context and input refs), so no
 * stale id is left that the inspector cannot show or clear.
 */
export function removeFromWorkflow(
  workflow: Workflow,
  nodeIds: ReadonlySet<string>,
  edgeIds: ReadonlySet<string>,
): Workflow {
  if (nodeIds.size === 0 && edgeIds.size === 0) return workflow;
  const keep = (id: string): boolean => !nodeIds.has(id);
  return {
    ...workflow,
    nodes: workflow.nodes
      .filter((n) => keep(n.id))
      .map((n) => {
        const contextRefs = n.config.contextRefs;
        const inputRefs = n.config.inputRefs;
        const staleContext = contextRefs?.some((id) => !keep(id)) === true;
        const staleInputs = inputRefs?.some((id) => !keep(id)) === true;
        if (!staleContext && !staleInputs) return n;
        const config = { ...n.config };
        if (staleContext) {
          const kept = contextRefs.filter(keep);
          if (kept.length > 0) {
            config.contextRefs = kept;
          } else {
            delete config.contextRefs;
            delete config.contextMaxChars;
          }
        }
        if (staleInputs) {
          const kept = inputRefs.filter(keep);
          if (kept.length > 0) config.inputRefs = kept;
          else delete config.inputRefs;
        }
        return { ...n, config };
      }),
    edges: workflow.edges.filter(
      (e) => !edgeIds.has(e.id) && keep(e.source) && keep(e.target),
    ),
  };
}

/**
 * Start and End steps a deletion must spare: the toolbar cannot add either
 * back, so deleting every Start (or every End) at once keeps the first.
 */
export function sparedAnchors(
  workflow: Workflow,
  doomed: ReadonlySet<string>,
): Set<string> {
  const spared = new Set<string>();
  for (const kind of ['start', 'end'] as const) {
    const all = workflow.nodes.filter((n) => n.type === kind);
    const first = all[0];
    if (first !== undefined && all.every((n) => doomed.has(n.id))) spared.add(first.id);
  }
  return spared;
}

/**
 * Smart-connect: when the user draws S → T, drop edges the new connection
 * makes redundant — an exact duplicate, or a direct P → T line that is now
 * bypassed via P ⇝ S → T (e.g. inserting a node between two linked nodes).
 * Labeled edges (true/false/failure) are never touched, and P ⇝ S must use
 * unlabeled edges only: a path through a branch is conditional, so drawing a
 * loop-back (fix → review) never removes the review's way in.
 */
export function bypassedEdgeIds(
  edges: Pick<WorkflowEdge, 'id' | 'source' | 'target' | 'label'>[],
  source: string,
  target: string,
): { dropNew: boolean; removeIds: string[] } {
  const blank = (label?: string): boolean => (label ?? '').trim() === '';
  if (edges.some((e) => e.source === source && e.target === target && blank(e.label))) {
    return { dropNew: true, removeIds: [] };
  }
  const reachable = (from: string, avoidId: string): boolean => {
    const seen = new Set<string>([from]);
    const queue: string[] = [from];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (current === source) return true;
      for (const e of edges) {
        if (e.id === avoidId || !blank(e.label)) continue;
        if (e.source === current && !seen.has(e.target)) {
          seen.add(e.target);
          queue.push(e.target);
        }
      }
    }
    return false;
  };
  const removeIds: string[] = [];
  for (const e of edges) {
    if (e.target !== target || e.source === source || !blank(e.label)) continue;
    if (reachable(e.source, e.id)) removeIds.push(e.id);
  }
  return { dropNew: false, removeIds };
}

export const NODE_KIND_META: Record<
  NodeKind,
  { label: string; description: string; accent: string }
> = {
  start: {
    label: 'Start',
    description: 'Entry point of the workflow.',
    accent: '#34d399',
  },
  command: {
    label: 'CLI / Command',
    description: 'Run a local executable with arguments.',
    accent: '#60a5fa',
  },
  approval: {
    label: 'Human Approval',
    description: 'Pause until a person approves or rejects.',
    accent: '#fbbf24',
  },
  agent: {
    label: 'AI Agent',
    description: 'Run a local AI CLI via an Agent Profile.',
    accent: '#f472b6',
  },
  condition: {
    label: 'Condition',
    description: 'Branch on a constrained expression (no scripting).',
    accent: '#22d3ee',
  },
  git: {
    label: 'Git',
    description: 'Inspect or safely mutate a local repository.',
    accent: '#f97316',
  },
  github: {
    label: 'GitHub',
    description: 'PRs, checks, and comments via your gh CLI.',
    accent: '#a78bfa',
  },
  ticket: {
    label: 'Ticket',
    description: 'Load a Jira ticket via MCP into prompt variables.',
    accent: '#a3e635',
  },
  mcp: {
    label: 'MCP Tool',
    description: 'Invoke one tool on a configured MCP server.',
    accent: '#2dd4bf',
  },
  end: {
    label: 'End',
    description: 'Terminal node of a flow.',
    accent: '#94a3b8',
  },
};

/**
 * Demo multi-agent workflow (Milestone 2):
 * Start → Claude Plan → Approval → Claude Implement → Codex Review → End.
 * Profile ids are placeholders resolved by name at import/creation time;
 * validation reports missing profiles until the user maps them.
 */
export function createAgentDemoWorkflow(profileIds: {
  plan: string;
  implement: string;
  review: string;
}): Workflow {
  const ids = {
    start: newId('node'),
    plan: newId('node'),
    gate: newId('node'),
    impl: newId('node'),
    review: newId('node'),
    end: newId('node'),
  };
  const agentNode = (
    id: string,
    y: number,
    label: string,
    profileId: string,
    prompt: string,
  ): WorkflowNode => ({
    id,
    type: 'agent',
    position: { x: 80, y },
    config: { agentProfileId: profileId, prompt },
    label,
  });
  const nodes: WorkflowNode[] = [
    {
      id: ids.start,
      type: 'start',
      position: { x: 80, y: 60 },
      config: {},
      label: 'Start',
    },
    agentNode(
      ids.plan,
      180,
      'Claude — Plan',
      profileIds.plan,
      'Create a concise implementation plan for {{workflow.name}}. List files to touch and risks.',
    ),
    {
      id: ids.gate,
      type: 'approval',
      position: { x: 80, y: 300 },
      config: { message: 'Review the plan before implementation runs.' },
      label: 'Approve Plan',
    },
    agentNode(
      ids.impl,
      420,
      'Claude — Implement',
      profileIds.implement,
      'Implement the approved plan supplied in the handoff. Verify details in the repository and run tests.',
    ),
    agentNode(
      ids.review,
      540,
      'Codex — Review',
      profileIds.review,
      'Review the current implementation diff for correctness and regressions. Use the handoff as orientation and inspect the full diff.',
    ),
    { id: ids.end, type: 'end', position: { x: 80, y: 660 }, config: {}, label: 'End' },
  ];
  for (const node of nodes) {
    if (node.id === ids.impl) {
      node.config.contextRefs = [ids.plan];
      node.config.contextMaxChars = 12000;
    }
    if (node.id === ids.review) {
      node.config.contextRefs = [ids.impl];
      node.config.contextMaxChars = 12000;
    }
  }
  const chain = [ids.start, ids.plan, ids.gate, ids.impl, ids.review, ids.end];
  const edges: WorkflowEdge[] = chain.slice(0, -1).map((source, i) => {
    const target = chain[i + 1];
    if (target === undefined) throw new Error('demo workflow chain broken');
    return { id: newId('edge'), source, target };
  });
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: newId('wf'),
    name: 'Demo: Plan → Implement → Review',
    nodes,
    edges,
  };
}

/** True when any reviewer reported a P0 or P1 finding (`node.<id>.severity`). */
function blockingFindings(reviewers: string[]): ConditionClause[] {
  return reviewers.flatMap((id) =>
    (['P0', 'P1'] as const).map((level) => ({
      left: `node.${id}.severity`,
      op: 'contains' as const,
      right: level,
    })),
  );
}

/**
 * PR review template (Milestone 5):
 * Start → PR details + files → Parallel(Claude Review, Codex Review) →
 * Condition(actionable P0/P1?) → true: approve, then post a note / false: mark checked.
 * PR numbers resolve from `{{input.prNumber}}` at runtime (watchers inject it);
 * number 0 means "from inputs".
 */
export function createReviewWorkflow(profileIds: {
  fastReview: string;
  deepReview: string;
}): Workflow {
  const ids = {
    start: newId('node'),
    details: newId('node'),
    files: newId('node'),
    revA: newId('node'),
    revB: newId('node'),
    cond: newId('node'),
    approve: newId('node'),
    comment: newId('node'),
    checked: newId('node'),
    end: newId('node'),
  };
  const at = (y: number): { x: number; y: number } => ({ x: 80, y });
  const nodes: WorkflowNode[] = [
    { id: ids.start, type: 'start', position: at(60), config: {}, label: 'Start' },
    {
      id: ids.details,
      type: 'github',
      position: at(180),
      config: { githubOp: { op: 'prDetails', number: 0 }, workingDir: '' },
      label: 'Load PR',
    },
    {
      id: ids.files,
      type: 'github',
      position: at(300),
      config: { githubOp: { op: 'prFiles', number: 0 }, workingDir: '' },
      label: 'Changed files',
    },
    {
      id: ids.revA,
      type: 'agent',
      position: { x: 40, y: 420 },
      config: {
        agentProfileId: profileIds.fastReview,
        prompt:
          'Fast review of the current PR diff: report findings as ```finding blocks with severity/file/line/title/explanation/fix. Tag severe issues P0/P1. Inspect the full diff; the handoff is an excerpt.',
        contextRefs: [ids.details, ids.files],
        contextMaxChars: 12000,
      },
      label: 'Claude Review',
    },
    {
      id: ids.revB,
      type: 'agent',
      position: { x: 260, y: 420 },
      config: {
        agentProfileId: profileIds.deepReview,
        prompt:
          'Deep review of the current PR diff: report findings as ```finding blocks with severity/file/line/title/explanation/fix. Tag severe issues P0/P1. Inspect the full diff; the handoff is an excerpt.',
        contextRefs: [ids.details, ids.files],
        contextMaxChars: 12000,
      },
      label: 'Codex Review',
    },
    {
      id: ids.cond,
      type: 'condition',
      position: at(540),
      config: {
        condition: {
          logic: 'or',
          clauses: blockingFindings([ids.revA, ids.revB]),
        },
      },
      label: 'Actionable?',
    },
    {
      id: ids.approve,
      type: 'approval',
      position: { x: 40, y: 660 },
      config: {
        message:
          'The reviews found P0/P1 problems. Approve to post a note on the PR; reject to stop without posting.',
      },
      label: 'Post findings?',
    },
    {
      id: ids.comment,
      type: 'github',
      position: { x: 40, y: 780 },
      config: {
        githubOp: {
          op: 'postComment',
          number: 0,
          body: 'Automated review found P0/P1 items — see run findings.\n\n<sub>posted by Orchevia</sub>',
        },
        workingDir: '',
      },
      label: 'Post draft note',
    },
    {
      id: ids.checked,
      type: 'command',
      position: { x: 260, y: 660 },
      config: { executable: 'echo', args: ['no actionable findings'] },
      label: 'Mark checked',
    },
    { id: ids.end, type: 'end', position: at(900), config: {}, label: 'End' },
  ];
  const link = (source: string, target: string, label?: string): WorkflowEdge => ({
    id: newId('edge'),
    source,
    target,
    ...(label === undefined ? {} : { label }),
  });
  const edges: WorkflowEdge[] = [
    link(ids.start, ids.details),
    link(ids.details, ids.files),
    link(ids.files, ids.revA),
    link(ids.files, ids.revB),
    link(ids.revA, ids.cond),
    link(ids.revB, ids.cond),
    link(ids.cond, ids.approve, 'true'),
    link(ids.approve, ids.comment),
    link(ids.cond, ids.checked, 'false'),
    link(ids.comment, ids.end),
    link(ids.checked, ids.end),
  ];
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: newId('wf'),
    name: 'Demo: Review Pull Request',
    inputs: [{ name: 'prNumber', label: 'PR number', required: true }],
    nodes,
    edges,
  };
}

/**
 * Review/fix loop demo (Milestone 3):
 * Start → Implement → Parallel(Claude Review, Codex Review) → Join →
 * Condition(P0/P1?) → true: Fix → back to reviews (max 2 cycles) / false: End.
 */
export function createReviewLoopDemoWorkflow(profileIds: {
  implement: string;
  reviewA: string;
  reviewB: string;
}): Workflow {
  const ids = {
    start: newId('node'),
    impl: newId('node'),
    revA: newId('node'),
    revB: newId('node'),
    join: newId('node'),
    cond: newId('node'),
    fix: newId('node'),
    end: newId('node'),
  };
  const at = (y: number): { x: number; y: number } => ({ x: 80, y });
  const nodes: WorkflowNode[] = [
    { id: ids.start, type: 'start', position: at(60), config: {}, label: 'Start' },
    {
      id: ids.impl,
      type: 'agent',
      position: at(180),
      config: {
        agentProfileId: profileIds.implement,
        prompt: 'Implement {{workflow.name}} with tests.',
        sessionGroup: 'implementation',
        sessionMaxTurns: 4,
        maxVisits: 2,
      },
      label: 'Implement',
    },
    {
      id: ids.revA,
      type: 'agent',
      position: { x: 40, y: 300 },
      config: {
        agentProfileId: profileIds.reviewA,
        prompt:
          'Review the current diff for P0/P1 defects independently. Tag severe findings with P0/P1. Inspect full source; the handoff is an excerpt.',
        contextRefs: [ids.impl],
        contextMaxChars: 12000,
        maxVisits: 2,
      },
      label: 'Claude Review',
    },
    {
      id: ids.revB,
      type: 'agent',
      position: { x: 260, y: 300 },
      config: {
        agentProfileId: profileIds.reviewB,
        prompt:
          'Review the current diff for P0/P1 defects independently. Tag severe findings with P0/P1. Inspect full source; the handoff is an excerpt.',
        contextRefs: [ids.impl],
        contextMaxChars: 12000,
        maxVisits: 2,
      },
      label: 'Codex Review',
    },
    {
      id: ids.join,
      type: 'command',
      position: at(420),
      config: { executable: 'echo', args: ['reviews complete'], maxVisits: 2 },
      label: 'Combine',
    },
    {
      id: ids.cond,
      type: 'condition',
      position: at(540),
      config: {
        condition: {
          logic: 'or',
          clauses: blockingFindings([ids.revA, ids.revB]),
        },
        maxVisits: 2,
      },
      label: 'P0/P1 found?',
    },
    {
      id: ids.fix,
      type: 'agent',
      position: at(660),
      config: {
        agentProfileId: profileIds.implement,
        prompt:
          'Fix the current P0/P1 findings supplied in the handoff, then run relevant tests. Verify findings against the current code.',
        sessionGroup: 'implementation',
        sessionMaxTurns: 4,
        contextRefs: [ids.revA, ids.revB],
        contextMaxChars: 12000,
        maxVisits: 2,
      },
      label: 'Fix',
    },
    { id: ids.end, type: 'end', position: at(780), config: {}, label: 'End' },
  ];
  const link = (source: string, target: string, label?: string): WorkflowEdge => ({
    id: newId('edge'),
    source,
    target,
    ...(label === undefined ? {} : { label }),
  });
  const edges: WorkflowEdge[] = [
    link(ids.start, ids.impl),
    link(ids.impl, ids.revA),
    link(ids.impl, ids.revB),
    link(ids.revA, ids.join),
    link(ids.revB, ids.join),
    link(ids.join, ids.cond),
    link(ids.cond, ids.fix, 'true'),
    link(ids.cond, ids.end, 'false'),
    link(ids.fix, ids.revA),
    link(ids.fix, ids.revB),
  ];
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: newId('wf'),
    name: 'Demo: Review Loop (max 2 cycles)',
    nodes,
    edges,
  };
}

/**
 * Native commit/PR quick flow: Start → Git status → Git commit → GitHub
 * createPr → End.
 *
 * Previously lived in the removed Changes view; now a first-class workflow
 * builder reachable from the Workflows Samples dialog. Values arrive via
 * workflow inputs (native run-input form), then commit/PR run through
 * Git/GitHub nodes — no AI needed for the commit itself. Git ops render
 * `{{input.*}}` templates (see engine `render_git_op`).
 */
export function createCommitPrWorkflow(repoDir: string, branch: string): Workflow {
  const ids = {
    start: newId('node'),
    status: newId('node'),
    commit: newId('node'),
    pr: newId('node'),
    end: newId('node'),
  };
  const at = (y: number): { x: number; y: number } => ({ x: 80, y });
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: newId('wf'),
    name: `Commit + PR (${branch || 'branch'})`,
    inputs: [
      { name: 'commitMessage', label: 'Commit message', required: true },
      { name: 'prTitle', label: 'PR title', required: true },
    ],
    nodes: [
      { id: ids.start, type: 'start', position: at(60), config: {}, label: 'Start' },
      {
        id: ids.status,
        type: 'git',
        position: at(180),
        config: { gitOp: { op: 'status' }, workingDir: repoDir },
        label: 'Check status',
      },
      {
        id: ids.commit,
        type: 'git',
        position: at(300),
        config: {
          gitOp: { op: 'commit', message: '{{input.commitMessage}}' },
          workingDir: repoDir,
        },
        label: 'Commit staged',
      },
      {
        id: ids.pr,
        type: 'github',
        position: at(420),
        config: {
          githubOp: {
            op: 'createPr',
            title: '{{input.prTitle}}',
            body: 'Created from Orchevia.',
            base: 'main',
            head: branch || '',
            draft: true,
          },
          workingDir: repoDir,
        },
        label: 'Open draft PR',
      },
      { id: ids.end, type: 'end', position: at(540), config: {}, label: 'End' },
    ],
    edges: [
      { id: newId('edge'), source: ids.start, target: ids.status },
      { id: newId('edge'), source: ids.status, target: ids.commit },
      { id: newId('edge'), source: ids.commit, target: ids.pr },
      { id: newId('edge'), source: ids.pr, target: ids.end },
    ],
  };
}
