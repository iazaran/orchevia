import type { RunExecution } from './run-controls';
/**
 * Workflow domain model (TypeScript mirror of `orchevia-core`).
 *
 * The persisted workflow definition is the source of truth and is shared
 * verbatim with the Rust backend. Keep these types in sync with
 * `crates/core/src/workflow.rs`.
 */

import { referencedVariables } from './agents';
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

/** Lightweight client-side validation (backend re-validates authoritatively). */
export function validateWorkflowLocal(wf: Workflow): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (wf.name.trim() === '') {
    issues.push({
      code: 'name-required',
      message: 'Workflow name must not be empty.',
      severity: 'error',
    });
  }
  const starts = wf.nodes.filter((n) => n.type === 'start');
  if (starts.length !== 1) {
    issues.push({
      code: 'single-start',
      message: `Workflow must have exactly one Start node, found ${String(starts.length)}.`,
      severity: 'error',
    });
  }
  if (!wf.nodes.some((n) => n.type === 'end')) {
    issues.push({
      code: 'end-required',
      message: 'Workflow must have at least one End node.',
      severity: 'error',
    });
  }
  const ids = new Set(wf.nodes.map((n) => n.id));
  for (const edge of wf.edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      issues.push({
        code: 'edge-unknown-node',
        message: `Edge '${edge.id}' references an unknown node.`,
        severity: 'error',
      });
    }
  }
  for (const node of wf.nodes) {
    if (node.type === 'command' && (node.config.executable ?? '').trim() === '') {
      issues.push({
        code: 'command-executable-required',
        message: 'Command node requires an executable.',
        severity: 'error',
        nodeId: node.id,
      });
    }
    if (node.type === 'command' && (node.config.executable ?? '').trim() === 'compose') {
      issues.push({
        code: 'command-executable-suspicious',
        message:
          '`compose` is not a standalone tool here — use executable `docker` with args starting `compose` (or the `docker-compose` binary).',
        severity: 'warning',
        nodeId: node.id,
      });
    }
    if (node.type === 'agent') {
      const invalid = (code: string, message: string): void => {
        issues.push({ code, message, severity: 'error', nodeId: node.id });
      };
      const group = node.config.sessionGroup;
      if (group !== undefined) {
        if (!group.trim() || Array.from(group).length > 256 || /[\0\n\r]/.test(group))
          invalid(
            'agent-session-group-invalid',
            'Session group must be 1–256 characters with no line breaks.',
          );
        for (const name of referencedVariables(group.replace(/\\\{\{/g, ''))) {
          const [kind, id, field] = name.split('.');
          const known =
            (kind === 'workflow' && ['id', 'name'].includes(id ?? '')) ||
            (kind === 'input' && (wf.inputs ?? []).some((i) => i.name === id)) ||
            (kind === 'ticket' &&
              [
                'key',
                'title',
                'description',
                'acceptanceCriteria',
                'status',
                'url',
              ].includes(id ?? '')) ||
            (kind === 'node' &&
              ids.has(id ?? '') &&
              (field === undefined ||
                ['output', 'status', 'exitCode', 'severity', 'visits'].includes(field)));
          if (!known)
            invalid(
              'agent-session-variable-invalid',
              `Session group references unknown variable '${name}'. Use workflow.*, input.*, ticket.* or node.<id>.output namespaces.`,
            );
        }
      }
      const turns = node.config.sessionMaxTurns;
      if (
        turns !== undefined &&
        (!Number.isInteger(turns) || turns < 1 || turns > 20 || group === undefined)
      )
        invalid(
          'agent-session-turns-invalid',
          'Session max turns must be 1–20 and requires a session group.',
        );
      const contextRefs = node.config.contextRefs ?? [];
      const chars = node.config.contextMaxChars;
      if (
        chars !== undefined &&
        (!Number.isInteger(chars) ||
          chars < 256 ||
          chars > 64000 ||
          contextRefs.length === 0)
      )
        invalid(
          'agent-context-limit-invalid',
          'Context budget must be 256–64000 characters and requires context references.',
        );
      const seen = new Set<string>();
      if (contextRefs.length > 16)
        invalid('agent-context-ref-invalid', 'Select at most 16 context references.');
      for (const id of contextRefs) {
        if (id === node.id || !ids.has(id) || seen.has(id))
          invalid(
            'agent-context-ref-invalid',
            `Context reference '${id}' must be a unique, existing, different node.`,
          );
        seen.add(id);
      }
      const hasProfile = (node.config.agentProfileId ?? '').trim() !== '';
      const hasRole = (node.config.agentRole ?? '').trim() !== '';
      if (!hasProfile && !hasRole) {
        issues.push({
          code: 'agent-profile-required',
          message: 'AI Agent node requires an Agent Profile (or a role for templates).',
          severity: 'error',
          nodeId: node.id,
        });
      }
      if ((node.config.prompt ?? '').trim() === '') {
        issues.push({
          code: 'agent-prompt-required',
          message: 'AI Agent node requires a prompt/instruction.',
          severity: 'error',
          nodeId: node.id,
        });
      }
      const timeout = node.config.timeoutSecs;
      if (
        timeout !== undefined &&
        (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECS)
      ) {
        issues.push({
          code: 'agent-timeout-invalid',
          message: `AI Agent timeout must be between 1 second and 12 hours (${String(MAX_TIMEOUT_SECS)}).`,
          severity: 'error',
          nodeId: node.id,
        });
      }
      if (node.config.maxToolCalls !== undefined) {
        const error = validateLimitValue(
          'Node tool-call allowance',
          node.config.maxToolCalls,
          MAX_TOOL_CALL_LIMIT,
        );
        if (error !== null) {
          issues.push({
            code: 'agent-tool-allowance-invalid',
            message: error,
            severity: 'error',
            nodeId: node.id,
          });
        }
      }
      if (node.config.maxSubagents !== undefined) {
        const error = validateLimitValue(
          'Node subagent allowance',
          node.config.maxSubagents,
          MAX_SUBAGENT_LIMIT,
        );
        if (error !== null) {
          issues.push({
            code: 'agent-subagent-allowance-invalid',
            message: error,
            severity: 'error',
            nodeId: node.id,
          });
        }
      }
      for (const message of validateToolRules(
        node.config.requiredTools ?? [],
        'Required tools',
      )) {
        issues.push({
          code: 'agent-required-tools-invalid',
          message,
          severity: 'error',
          nodeId: node.id,
        });
      }
    }
    if (
      node.type !== 'agent' &&
      (node.config.maxToolCalls !== undefined || node.config.maxSubagents !== undefined)
    ) {
      issues.push({
        code: 'agent-allowance-misplaced',
        message: 'Tool-call and subagent allowances only apply to AI Agent nodes.',
        severity: 'error',
        nodeId: node.id,
      });
    }
    if (node.type !== 'agent' && (node.config.requiredTools ?? []).length > 0) {
      issues.push({
        code: 'agent-required-tools-misplaced',
        message: 'Required tools only apply to AI Agent nodes.',
        severity: 'error',
        nodeId: node.id,
      });
    }
    if (node.type === 'command') {
      const timeout = node.config.timeoutSecs;
      if (
        timeout !== undefined &&
        (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECS)
      ) {
        issues.push({
          code: 'command-timeout-invalid',
          message: `Command timeout must be between 1 second and 12 hours (${String(MAX_TIMEOUT_SECS)}).`,
          severity: 'error',
          nodeId: node.id,
        });
      }
    }
    const retry = node.config.retry;
    if (retry !== undefined) {
      if (
        !Number.isInteger(retry.maxAttempts) ||
        retry.maxAttempts < 1 ||
        retry.maxAttempts > 10
      ) {
        issues.push({
          code: 'retry-unbounded',
          message: 'Retry max attempts must be between 1 and 10.',
          severity: 'error',
          nodeId: node.id,
        });
      }
      if (retry.delayMs !== undefined && (retry.delayMs < 0 || retry.delayMs > 60000)) {
        issues.push({
          code: 'retry-delay-invalid',
          message: 'Retry delay must not exceed 60 seconds.',
          severity: 'error',
          nodeId: node.id,
        });
      }
    }
    const maxVisits = node.config.maxVisits;
    if (
      maxVisits !== undefined &&
      (!Number.isInteger(maxVisits) || maxVisits < 1 || maxVisits > 100)
    ) {
      issues.push({
        code: 'loop-limit-invalid',
        message: 'Node max visits must be between 1 and 100.',
        severity: 'error',
        nodeId: node.id,
      });
    }
    if (node.type === 'condition') {
      const condition = node.config.condition;
      if (condition === undefined || condition.clauses.length === 0) {
        issues.push({
          code: 'condition-required',
          message: 'Condition node requires a condition expression.',
          severity: 'error',
          nodeId: node.id,
        });
      } else {
        const outs = wf.edges.filter((e) => e.source === node.id);
        const norm = (label?: string): string => (label ?? '').trim().toLowerCase();
        const hasTrue = outs.some((e) =>
          ['true', 'yes', 'on true'].includes(norm(e.label)),
        );
        const hasFalse = outs.some((e) =>
          ['false', 'no', 'on false'].includes(norm(e.label)),
        );
        if (!hasTrue || !hasFalse) {
          issues.push({
            code: 'condition-branches-required',
            message:
              "Condition node needs one 'true' and one 'false' outgoing edge (labels).",
            severity: 'error',
            nodeId: node.id,
          });
        }
      }
    }
    if (node.type === 'git') {
      if (node.config.gitOp === undefined) {
        issues.push({
          code: 'git-op-required',
          message: 'Git node requires an operation.',
          severity: 'error',
          nodeId: node.id,
        });
      }
      if (
        (node.config.workingDir ?? '').trim() === '' &&
        (wf.defaults?.repoDir ?? '').trim() === ''
      ) {
        issues.push({
          code: 'git-dir-required',
          message:
            'Git node requires a working directory: set it on the node or set a workflow default (select the canvas background to edit Workflow settings).',
          severity: 'error',
          nodeId: node.id,
        });
      }
    }
    if (node.type === 'github') {
      if (node.config.githubOp === undefined) {
        issues.push({
          code: 'github-op-required',
          message: 'GitHub node requires an operation.',
          severity: 'error',
          nodeId: node.id,
        });
      }
      if (
        (node.config.workingDir ?? '').trim() === '' &&
        (wf.defaults?.repoDir ?? '').trim() === ''
      ) {
        issues.push({
          code: 'git-dir-required',
          message:
            'GitHub node requires a working directory: set it on the node or set a workflow default (select the canvas background to edit Workflow settings).',
          severity: 'error',
          nodeId: node.id,
        });
      }
    }
    if (node.type === 'ticket') {
      if ((node.config.ticketKey ?? '').trim() === '') {
        issues.push({
          code: 'ticket-key-required',
          message: 'Ticket node requires a ticket key.',
          severity: 'error',
          nodeId: node.id,
        });
      }
      if ((node.config.mcpServerId ?? '').trim() === '') {
        issues.push({
          code: 'ticket-server-required',
          message: 'Ticket node requires an MCP server.',
          severity: 'error',
          nodeId: node.id,
        });
      }
    }
    if (node.type === 'mcp') {
      if ((node.config.mcpServerId ?? '').trim() === '') {
        issues.push({
          code: 'mcp-server-required',
          message: 'MCP node requires a server.',
          severity: 'error',
          nodeId: node.id,
        });
      }
      if ((node.config.mcpTool ?? '').trim() === '') {
        issues.push({
          code: 'mcp-tool-required',
          message: 'MCP node requires a tool name.',
          severity: 'error',
          nodeId: node.id,
        });
      }
    }
  }
  if (wf.limits !== undefined) {
    const error = validateWorkflowLimits(wf.limits);
    if (error !== null) {
      issues.push({
        code: 'workflow-limits-invalid',
        message: error,
        severity: 'error',
      });
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
  const norm = (l?: string): string => (l ?? '').trim().toLowerCase();
  const hasTrue = existing.some((l) => ['true', 'yes', 'on true'].includes(norm(l)));
  return hasTrue ? 'false' : 'true';
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
