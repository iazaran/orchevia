import type { AgentProfile } from './agents';
import {
  CURRENT_SCHEMA_VERSION,
  newId,
  parseWorkflowJson,
  type NodeConfig,
  type NodeKind,
  type Workflow,
  type WorkflowNode,
} from './workflow';
export interface DocumentSession {
  json: string;
  nodeIds: Record<string, string>;
}
export interface DeveloperNode {
  key: string;
  type: NodeKind;
  label?: string;
  role?: string;
  profileName?: string;
  config: Omit<NodeConfig, 'agentProfileId' | 'agentRole'>;
}
export interface DeveloperWorkflow {
  version: 1;
  name: string;
  nodes: DeveloperNode[];
  edges: { from: string; to: string; label?: string }[];
  inputs?: Workflow['inputs'];
  defaults?: Workflow['defaults'];
}
const configKeys = [
  'executable',
  'args',
  'workingDir',
  'message',
  'prompt',
  'inputRefs',
  'timeoutSecs',
  'extendOnOutput',
  'retry',
  'maxVisits',
  'condition',
  'gitOp',
  'githubOp',
  'ticketKey',
  'mcpServerId',
  'mcpTool',
  'mcpArgs',
];
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function objectShape(value: unknown, field: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`Invalid ${field}: expected an object.`);
  return value;
}
function stringField(
  value: Record<string, unknown>,
  field: string,
  required = false,
): void {
  if (!required && value[field] === null) Reflect.deleteProperty(value, field);
  if (value[field] === undefined && !required) return;
  if (typeof value[field] !== 'string')
    throw new Error(`Invalid ${field}: expected a string.`);
}
function boolField(value: Record<string, unknown>, field: string): void {
  if (value[field] !== undefined && typeof value[field] !== 'boolean')
    throw new Error(`Invalid ${field}: expected a boolean.`);
}
function uintField(
  value: Record<string, unknown>,
  field: string,
  required = false,
  max = Number.MAX_SAFE_INTEGER,
): void {
  if (!required && value[field] === null) Reflect.deleteProperty(value, field);
  const n = value[field];
  if (n === undefined && !required) return;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > max)
    throw new Error(`Invalid ${field}: expected an unsigned integer.`);
}
function stringsField(value: Record<string, unknown>, field: string): void {
  if (value[field] === undefined) return;
  const items = value[field];
  if (!Array.isArray(items) || items.some((v: unknown) => typeof v !== 'string'))
    throw new Error(`Invalid ${field}: expected strings[].`);
}
function configShape(value: unknown, raw = false): void {
  const config = objectShape(value, 'config');
  for (const key of Object.keys(config))
    if (![...configKeys, ...(raw ? ['agentProfileId', 'agentRole'] : [])].includes(key))
      throw new Error(`Unknown config field '${key}'.`);
  for (const key of [
    'executable',
    'workingDir',
    'message',
    'prompt',
    'ticketKey',
    'mcpServerId',
    'mcpTool',
    'agentProfileId',
    'agentRole',
  ])
    stringField(config, key);
  stringsField(config, 'args');
  stringsField(config, 'inputRefs');
  uintField(config, 'timeoutSecs');
  uintField(config, 'maxVisits', false, 4294967295);
  boolField(config, 'extendOnOutput');
  for (const key of ['retry', 'condition', 'gitOp', 'githubOp', 'mcpArgs'])
    if (config[key] === null) Reflect.deleteProperty(config, key);
  if (config.retry !== undefined) {
    const retry = objectShape(config.retry, 'retry');
    uintField(retry, 'maxAttempts', true, 4294967295);
    if (retry.delayMs === null)
      throw new Error('Invalid delayMs: expected an unsigned integer.');
    uintField(retry, 'delayMs');
    boolField(retry, 'backoff');
  }
  if (config.condition !== undefined) {
    const condition = objectShape(config.condition, 'condition');
    stringField(condition, 'logic', true);
    if (!['and', 'or'].includes(String(condition.logic)))
      throw new Error('Invalid condition logic.');
    if (condition.clauses === undefined) condition.clauses = [];
    if (!Array.isArray(condition.clauses)) throw new Error('Invalid condition clauses.');
    for (const value of condition.clauses as unknown[]) {
      const clause = objectShape(value, 'clause');
      stringField(clause, 'left', true);
      stringField(clause, 'right', true);
      stringField(clause, 'op', true);
      const aliases: Record<string, string> = {
        not_equals: 'notEquals',
        not_contains: 'notContains',
        greater_or_equal: 'greaterOrEqual',
        less_or_equal: 'lessOrEqual',
      };
      const op = String(clause.op);
      clause.op = Object.hasOwn(aliases, op) ? aliases[op] : op;
      if (
        ![
          'equals',
          'notEquals',
          'contains',
          'notContains',
          'greater',
          'less',
          'greaterOrEqual',
          'lessOrEqual',
        ].includes(String(clause.op))
      )
        throw new Error('Invalid condition operator.');
    }
  }
  if (config.gitOp !== undefined) {
    const op = objectShape(config.gitOp, 'gitOp');
    stringField(op, 'op', true);
    if (
      ![
        'status',
        'diffSummary',
        'branchCreate',
        'checkout',
        'stage',
        'commit',
        'worktreeAdd',
        'worktreeRemove',
        'worktreeList',
        'remotes',
      ].includes(String(op.op))
    )
      throw new Error('Invalid Git operation.');
    if (op.op === 'branchCreate' || op.op === 'checkout') stringField(op, 'name', true);
    if (op.op === 'commit') stringField(op, 'message', true);
    if (op.op === 'worktreeAdd' || op.op === 'worktreeRemove')
      stringField(op, 'path', true);
    stringField(op, 'branch');
    boolField(op, 'allowDirty');
    stringsField(op, 'paths');
  }
  if (config.githubOp !== undefined) {
    const op = objectShape(config.githubOp, 'githubOp');
    stringField(op, 'op', true);
    if (
      ![
        'prStatus',
        'listPrs',
        'prDetails',
        'prFiles',
        'prChecks',
        'createPr',
        'postComment',
      ].includes(String(op.op))
    )
      throw new Error('Invalid GitHub operation.');
    if (['prDetails', 'prFiles', 'prChecks', 'postComment'].includes(String(op.op)))
      uintField(op, 'number', true);
    if (op.op === 'createPr')
      for (const key of ['title', 'base', 'head']) stringField(op, key, true);
    stringField(op, 'state');
    if (op.body === null) throw new Error('Invalid body: expected a string.');
    stringField(op, 'body', op.op === 'postComment');
    boolField(op, 'draft');
  }
  if (config.mcpArgs !== undefined)
    for (const arg of Object.values(objectShape(config.mcpArgs, 'mcpArgs')))
      if (typeof arg !== 'string')
        throw new Error('Invalid MCP argument: expected a string.');
}
function workflowFieldsShape(value: Record<string, unknown>): void {
  if (value.defaults === null) delete value.defaults;
  if (value.defaults !== undefined) {
    const defaults = objectShape(value.defaults, 'defaults');
    stringField(defaults, 'repoDir');
    stringField(defaults, 'branch');
  }
  if (value.inputs !== undefined) {
    if (!Array.isArray(value.inputs))
      throw new Error('Invalid inputs: expected an array.');
    for (const input of value.inputs as unknown[]) {
      const item = objectShape(input, 'input');
      stringField(item, 'name', true);
      stringField(item, 'label');
      stringField(item, 'default');
      boolField(item, 'required');
    }
  }
}
function reference(text: string, map: Record<string, string>): string {
  if (!text.startsWith('node.')) return text;
  const rest = text.slice(5);
  const key = Object.keys(map)
    .sort((a, b) => b.length - a.length)
    .find((k) => rest === k || rest.startsWith(`${k}.`));
  if (key === undefined)
    throw new Error(
      `Unknown node reference '${text}'. Update references when renaming keys.`,
    );
  return `node.${map[key] ?? ''}${rest.slice(key.length)}`;
}
function rewrite(value: unknown, map: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/(?<!\\)\{\{([^{}]+)\}\}/g, (_, token: string) => {
      const trimmed = token.trim();
      if (!trimmed) return `{{${token}}}`;
      const leading = token.slice(0, token.length - token.trimStart().length);
      const trailing = token.slice(token.trimEnd().length);
      return `{{${leading}${reference(trimmed, map)}${trailing}}}`;
    });
  }
  if (Array.isArray(value)) return value.map((v: unknown) => rewrite(v, map));
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, rewrite(v, map)]),
    );
  return value;
}
export function remapConfigReferences(
  config: NodeConfig,
  map: Record<string, string>,
): NodeConfig {
  const { inputRefs, condition, ...ordinary } = config;
  const mapped = rewrite(ordinary, map) as NodeConfig;
  if (inputRefs !== undefined) {
    if (!Array.isArray(inputRefs)) throw new Error('inputRefs must be an array.');
    mapped.inputRefs = inputRefs.map((id: unknown) => {
      if (typeof id !== 'string' || !Object.hasOwn(map, id))
        throw new Error(`Unknown inputRefs node '${String(id)}'.`);
      return map[id] ?? '';
    });
  }
  if (condition !== undefined) {
    mapped.condition = structuredClone(condition);
    // Runtime conditions resolve only the left side; right operands are literals.
    for (const clause of mapped.condition.clauses) {
      if (clause.left.startsWith('node.')) clause.left = reference(clause.left, map);
    }
  }
  return mapped;
}
function resolveName(name: string, profiles: AgentProfile[]): string {
  const matches = profiles.filter((p) => p.name === name.trim());
  if (matches.length !== 1)
    throw new Error(
      matches.length === 0
        ? `No Agent Profile named '${name}'. Configure it in Agents.`
        : `Agent Profile name '${name}' is ambiguous. Rename duplicate profiles.`,
    );
  return matches[0]?.id ?? '';
}
export function encodeDocument(
  workflow: Workflow,
  profiles: AgentProfile[],
): DocumentSession {
  const aliases = Object.create(null) as Record<string, string>;
  const used = new Set<string>();
  for (const node of workflow.nodes) {
    const slug =
      (node.label ?? 'step')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 55) || 'step';
    const base =
      !node.id.startsWith('node-') && /^[a-zA-Z_][\w-]{0,63}$/.test(node.id)
        ? node.id
        : /^[a-z]/.test(slug)
          ? slug
          : `step-${slug}`;
    let key = base;
    let n = 2;
    while (used.has(key)) key = `${base}-${String(n++)}`;
    used.add(key);
    aliases[node.id] = key;
  }
  const nodes = workflow.nodes.map((node) => {
    const { agentProfileId, agentRole, ...config } = node.config;
    const profile =
      agentProfileId === undefined
        ? undefined
        : profiles.find((p) => p.id === agentProfileId);
    if (agentProfileId !== undefined && profile === undefined)
      throw new Error(
        `Agent Profile '${agentProfileId}' is missing. Use Advanced JSON or configure it in Agents.`,
      );
    const role = agentRole ?? profile?.role;
    return {
      key: aliases[node.id] ?? node.id,
      type: node.type,
      ...(node.label === undefined ? {} : { label: node.label }),
      ...(role === undefined ? {} : { role }),
      ...(profile === undefined ? {} : { profileName: profile.name }),
      config: remapConfigReferences(config, aliases),
    };
  });
  const doc: DeveloperWorkflow = {
    version: 1,
    name: workflow.name,
    nodes,
    edges: workflow.edges.map((e) => {
      const from = aliases[e.source];
      const to = aliases[e.target];
      if (from === undefined || to === undefined)
        throw new Error('Edge endpoint is missing.');
      return { from, to, ...(e.label === undefined ? {} : { label: e.label }) };
    }),
    ...(workflow.inputs === undefined ? {} : { inputs: workflow.inputs }),
    ...(workflow.defaults === undefined ? {} : { defaults: workflow.defaults }),
  };
  return {
    json: JSON.stringify(doc, null, 2),
    nodeIds: Object.fromEntries(Object.entries(aliases).map(([id, key]) => [key, id])),
  };
}
export function decodeDocument(
  json: string,
  profiles: AgentProfile[],
  roles: Record<string, string>,
  base?: Workflow,
  nodeIds: Record<string, string> = {},
): Workflow {
  const value: unknown = JSON.parse(json);
  if (value === null || typeof value !== 'object')
    throw new Error('Workflow must be an object.');
  if ('schemaVersion' in value) {
    const raw = parseWorkflowJson(json);
    workflowFieldsShape(objectShape(raw, 'workflow'));
    uintField(objectShape(raw, 'workflow'), 'schemaVersion', true, 4294967295);
    for (const node of raw.nodes) {
      const shape = objectShape(node, 'node');
      stringField(shape, 'id', true);
      stringField(shape, 'label');
      stringField(shape, 'type', true);
      if (shape.type === 'gitHub') shape.type = 'github';
      if (
        ![
          'start',
          'end',
          'command',
          'agent',
          'approval',
          'condition',
          'git',
          'github',
          'ticket',
          'mcp',
        ].includes(String(shape.type))
      )
        throw new Error('Unknown node type.');
      configShape(shape.config === undefined ? {} : shape.config, true);
      if (shape.config === undefined) shape.config = {};
      const position = objectShape(
        shape.position === undefined ? { x: 0, y: 0 } : shape.position,
        'position',
      );
      if (
        typeof position.x !== 'number' ||
        typeof position.y !== 'number' ||
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.y)
      )
        throw new Error('Invalid position.');
      if (shape.position === undefined) shape.position = position;
    }
    for (const edge of raw.edges) {
      const shape = objectShape(edge, 'edge');
      stringField(shape, 'id', true);
      stringField(shape, 'source', true);
      stringField(shape, 'target', true);
      stringField(shape, 'label');
    }
    return raw;
  }
  const doc = value as Omit<DeveloperWorkflow, 'version'> & { version: number };
  if (
    doc.version !== 1 ||
    typeof doc.name !== 'string' ||
    !Array.isArray(doc.nodes) ||
    !Array.isArray(doc.edges)
  )
    throw new Error(
      'Invalid developer workflow: expected version 1, name, nodes and edges.',
    );
  for (const key of Object.keys(doc))
    if (!['version', 'name', 'nodes', 'edges', 'inputs', 'defaults'].includes(key))
      throw new Error(`Unknown document field '${key}'.`);
  const ids = Object.create(null) as Record<string, string>;
  const unique = new Set<string>();
  for (const node of doc.nodes) {
    if (typeof node.key !== 'string' || !/^[a-zA-Z_][\w-]{0,63}$/.test(node.key))
      throw new Error('Invalid node key.');
    if (Object.hasOwn(ids, node.key))
      throw new Error(`Duplicate node key '${node.key}'.`);
    const old = Object.hasOwn(nodeIds, node.key) ? nodeIds[node.key] : undefined;
    const id =
      old !== undefined && base?.nodes.some((n) => n.id === old) === true
        ? old
        : node.key;
    if (unique.has(id)) throw new Error('Node keys resolve to duplicate IDs.');
    unique.add(id);
    ids[node.key] = id;
  }
  workflowFieldsShape(objectShape(doc, 'workflow'));
  let added = 0;
  const maxY =
    base === undefined ? -100 : Math.max(0, ...base.nodes.map((n) => n.position.y));
  const nodes: WorkflowNode[] = doc.nodes.map((n) => {
    if (
      ![
        'start',
        'end',
        'command',
        'agent',
        'approval',
        'condition',
        'git',
        'github',
        'gitHub',
        'ticket',
        'mcp',
      ].includes(n.type)
    )
      throw new Error('Unknown node type.');
    for (const key of Object.keys(n))
      if (!['key', 'type', 'label', 'role', 'profileName', 'config'].includes(key))
        throw new Error(`Unknown node field '${key}'.`);
    if (!isObject(n.config)) throw new Error('Node config must be an object.');
    for (const key of Object.keys(n.config))
      if (!configKeys.includes(key)) throw new Error(`Unknown config field '${key}'.`);
    const shape = objectShape(n, 'node');
    stringField(shape, 'label');
    stringField(shape, 'role');
    stringField(shape, 'profileName');
    configShape(n.config);
    const config = remapConfigReferences(n.config, ids);
    if (n.type !== 'agent' && (n.role !== undefined || n.profileName !== undefined))
      throw new Error('Profile/role selection is only valid on Agent nodes.');
    if (n.profileName !== undefined)
      config.agentProfileId = resolveName(n.profileName, profiles);
    else if (n.role !== undefined) {
      if (
        ![
          'planning',
          'implementation',
          'fastReview',
          'deepReview',
          'workflowGenerator',
        ].includes(n.role)
      )
        throw new Error(`Unknown agent role '${n.role}'.`);
      const profile = roles[n.role];
      if (profile !== undefined) config.agentProfileId = profile;
      else config.agentRole = n.role;
    }
    const id = ids[n.key] ?? n.key;
    const old = base?.nodes.find((n) => n.id === id);
    return {
      id,
      type: shape.type === 'gitHub' ? 'github' : n.type,
      position:
        old === undefined ? { x: 80, y: maxY + ++added * 180 } : { ...old.position },
      config,
      ...(n.label === undefined ? {} : { label: n.label }),
    };
  });
  const used = new Set<string>();
  const edges = doc.edges.map((e) => {
    for (const key of Object.keys(e))
      if (!['from', 'to', 'label'].includes(key))
        throw new Error(`Unknown edge field '${key}'.`);
    const shape = objectShape(e, 'edge');
    stringField(shape, 'from', true);
    stringField(shape, 'to', true);
    stringField(shape, 'label');
    const source = ids[e.from];
    const target = ids[e.to];
    if (source === undefined || target === undefined)
      throw new Error('Unknown edge endpoint.');
    const old = base?.edges.find(
      (old) =>
        old.source === source &&
        old.target === target &&
        old.label === e.label &&
        !used.has(old.id),
    );
    const id = old?.id ?? newId('edge');
    used.add(id);
    return { id, source, target, ...(e.label === undefined ? {} : { label: e.label }) };
  });
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: base?.id ?? newId('wf'),
    name: doc.name,
    nodes,
    edges,
    ...(doc.inputs === undefined ? {} : { inputs: doc.inputs }),
    ...(doc.defaults === undefined ? {} : { defaults: doc.defaults }),
  };
}
