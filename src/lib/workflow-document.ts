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
function rewrite(value: unknown, map: Record<string, string>, bare = false): unknown {
  if (typeof value === 'string') {
    if (bare && value.startsWith('node.')) return reference(value, map);
    return value.replace(
      /(?<!\\)\{\{([^{}]+)\}\}/g,
      (_, token: string) => `{{${reference(token, map)}}}`,
    );
  }
  if (Array.isArray(value)) return value.map((v: unknown) => rewrite(v, map, bare));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, v]: [string, unknown]) => {
        if (key === 'inputRefs') {
          if (!Array.isArray(v)) throw new Error('inputRefs must be an array.');
          return [
            key,
            v.map((id: unknown) => {
              if (typeof id !== 'string' || !Object.hasOwn(map, id))
                throw new Error(`Unknown inputRefs node '${String(id)}'.`);
              return map[id];
            }),
          ];
        }
        return [key, rewrite(v, map, key === 'left' || key === 'right')];
      }),
    );
  return value;
}
export function remapConfigReferences(
  config: NodeConfig,
  map: Record<string, string>,
): NodeConfig {
  return rewrite(config, map) as NodeConfig;
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
      config: rewrite(config, aliases) as DeveloperNode['config'],
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
  if ('schemaVersion' in value) return parseWorkflowJson(json);
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
    const config = rewrite(n.config, ids) as NodeConfig;
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
      type: n.type,
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
