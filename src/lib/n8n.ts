/**
 * Convert workflows to and from n8n's workflow JSON.
 *
 * Export keeps Orchevia's local-first model: commands, Git, GitHub and AI
 * agent steps become n8n Execute Command nodes that call the same local
 * tools (`git`, `gh`, `claude -p`, …), conditions become If nodes, approvals
 * become Wait nodes and Ticket steps become Jira nodes. Import maps the n8n
 * nodes that have an Orchevia equivalent and lists everything it could not
 * convert, so nothing disappears silently. Both directions are pure: the
 * result is checked by the normal workflow validation before it is saved.
 */
import type { AdapterKind, AgentProfile } from './agents';
import type { DeveloperNode, DeveloperWorkflow } from './workflow-document';
import {
  arrangeWorkflowPositions,
  type ConditionClause,
  type ConditionOp,
  type GitHubOp,
  type GitOp,
  type NodeConfig,
  type Workflow,
  type WorkflowNode,
} from './workflow';

export interface N8nConnection {
  node: string;
  type: string;
  index: number;
}

export interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  notes?: string;
  notesInFlow?: boolean;
  onError?: string;
  disabled?: boolean;
}

export interface N8nWorkflow {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, Record<string, (N8nConnection[] | null)[]>>;
  settings: Record<string, unknown>;
  pinData: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export interface N8nExport {
  workflow: N8nWorkflow;
  /** What changed in translation, in plain words. */
  notes: string[];
}

export interface N8nImport {
  document: DeveloperWorkflow;
  /** Steps that were mapped loosely or left out, in plain words. */
  notes: string[];
}

const INPUTS_NODE = 'Workflow inputs';

/** POSIX single-quote quoting; bare words stay bare. */
export function shellQuote(arg: string): string {
  if (arg !== '' && /^[\w@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** Deterministic UUID-shaped id, so the same workflow exports the same JSON. */
function stableUuid(seed: string): string {
  const hex: string[] = [];
  let hash = 0x811c9dc5;
  for (let round = 0; round < 4; round++) {
    for (const ch of `${seed}#${String(round)}`) {
      hash ^= ch.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hex.push(hash.toString(16).padStart(8, '0'));
  }
  const h = hex.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const KIND_LABEL: Record<WorkflowNode['type'], string> = {
  start: 'Start',
  command: 'Command',
  approval: 'Approval',
  agent: 'AI agent',
  condition: 'Condition',
  git: 'Git',
  github: 'GitHub',
  ticket: 'Ticket',
  mcp: 'MCP tool',
  end: 'End',
};

const CLI_PROMPT: Record<AdapterKind, (prompt: string, model?: string) => string> = {
  claude: (p, m) => `claude -p ${m ? `--model ${shellQuote(m)} ` : ''}${shellQuote(p)}`,
  codex: (p, m) => `codex exec ${m ? `--model ${shellQuote(m)} ` : ''}${shellQuote(p)}`,
  muse: (p, m) => `muse exec ${m ? `--model ${shellQuote(m)} ` : ''}-- ${shellQuote(p)}`,
  gemini: (p, m) =>
    `gemini ${m ? `--model ${shellQuote(m)} ` : ''}--prompt ${shellQuote(p)}`,
  antigravity: (p, m) =>
    `agy ${m ? `--model ${shellQuote(m)} ` : ''}--print ${shellQuote(p)}`,
  opencode: (p, m) =>
    `opencode run ${m ? `--model ${shellQuote(m)} ` : ''}-- ${shellQuote(p)}`,
  custom: (p) => `your-cli ${shellQuote(p)}`,
};

function gitCommand(op: GitOp): string {
  switch (op.op) {
    case 'status':
      return 'git status --short --branch';
    case 'diffSummary':
      return 'git diff --stat';
    case 'branchCreate':
      return `git switch -c ${shellQuote(op.name)}`;
    case 'checkout':
      return `git switch ${shellQuote(op.name)}`;
    case 'stage':
      return `git add -- ${(op.paths ?? ['.']).map(shellQuote).join(' ') || '.'}`;
    case 'commit':
      return `git commit -m ${shellQuote(op.message)}`;
    case 'worktreeAdd':
      return `git worktree add ${op.branch ? `-b ${shellQuote(op.branch)} ` : ''}${shellQuote(op.path)}`;
    case 'worktreeRemove':
      return `git worktree remove ${shellQuote(op.path)}`;
    case 'worktreeList':
      return 'git worktree list';
    case 'remotes':
      return 'git remote -v';
  }
}

function githubCommand(op: GitHubOp): string {
  switch (op.op) {
    case 'prStatus':
      return 'gh pr status';
    case 'listPrs':
      return `gh pr list${op.state ? ` --state ${shellQuote(op.state)}` : ''}`;
    case 'prDetails':
      return `gh pr view ${String(op.number)}`;
    case 'prFiles':
      return `gh pr diff ${String(op.number)} --name-only`;
    case 'prChecks':
      return `gh pr checks ${String(op.number)}`;
    case 'createPr':
      return [
        'gh pr create',
        `--title ${shellQuote(op.title)}`,
        `--body ${shellQuote(op.body ?? '')}`,
        `--base ${shellQuote(op.base)}`,
        `--head ${shellQuote(op.head)}`,
        op.draft === true ? '--draft' : '',
      ]
        .filter(Boolean)
        .join(' ');
    case 'postComment':
      return `gh pr comment ${String(op.number)} --body ${shellQuote(op.body)}`;
  }
}

const OP_TO_N8N: Record<ConditionOp, { type: string; operation: string }> = {
  equals: { type: 'string', operation: 'equals' },
  notEquals: { type: 'string', operation: 'notEquals' },
  contains: { type: 'string', operation: 'contains' },
  notContains: { type: 'string', operation: 'notContains' },
  greater: { type: 'number', operation: 'gt' },
  less: { type: 'number', operation: 'lt' },
  greaterOrEqual: { type: 'number', operation: 'gte' },
  lessOrEqual: { type: 'number', operation: 'lte' },
};

/**
 * Convert a workflow to n8n JSON. `profiles` decides which local CLI an
 * agent step calls; steps without a resolvable profile call Claude Code.
 */
export function toN8n(workflow: Workflow, profiles: AgentProfile[] = []): N8nExport {
  const notes = new Set<string>();
  const names = new Map<string, string>();
  const taken = new Set<string>([INPUTS_NODE]);
  for (const node of workflow.nodes) {
    const base = (node.label ?? '').trim() || KIND_LABEL[node.type];
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} ${String(n)}`;
    taken.add(name);
    names.set(node.id, name);
  }
  const inputs = workflow.inputs ?? [];
  const startIds = new Set(
    workflow.nodes.filter((n) => n.type === 'start').map((n) => n.id),
  );
  const kindOf = new Map(workflow.nodes.map((n) => [n.id, n.type]));

  /** Orchevia `{{…}}` references → n8n expressions. */
  const expr = (text: string): string => {
    const state = { changed: false };
    const out = text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, ref: string) => {
      const input = /^input\.([\w-]+)$/.exec(ref);
      if (input !== null) {
        state.changed = true;
        return `{{ $(${JSON.stringify(INPUTS_NODE)}).item.json[${JSON.stringify(input[1])}] }}`;
      }
      const node = /^node\.([\w-]+)(?:\.(output|exitCode|stdout|stderr|severity))?$/.exec(
        ref,
      );
      if (node !== null) {
        const target = names.get(node[1] ?? '');
        if (target === undefined) return whole;
        state.changed = true;
        const field =
          node[2] === 'exitCode'
            ? 'exitCode'
            : node[2] === 'stderr'
              ? 'stderr'
              : 'stdout';
        if (node[2] === 'severity')
          notes.add(
            'Review severity has no n8n field; the reviewer output is used instead.',
          );
        return `{{ $(${JSON.stringify(target)}).item.json.${field} }}`;
      }
      const ticket = /^ticket\.(key|title|description|acceptanceCriteria)$/.exec(ref);
      if (ticket !== null) {
        const ticketNode = workflow.nodes.find((n) => n.type === 'ticket');
        const target = ticketNode === undefined ? undefined : names.get(ticketNode.id);
        if (target === undefined) return whole;
        state.changed = true;
        const path =
          ticket[1] === 'key'
            ? 'key'
            : ticket[1] === 'title'
              ? 'fields.summary'
              : 'fields.description';
        return `{{ $(${JSON.stringify(target)}).item.json.${path} }}`;
      }
      notes.add(`The reference {{${ref}}} has no n8n equivalent and was kept as text.`);
      return whole;
    });
    return state.changed ? `=${out}` : out;
  };

  const cdPrefix = (config: NodeConfig): string => {
    const dir = (config.workingDir ?? workflow.defaults?.repoDir ?? '').trim();
    return dir === '' ? '' : `cd ${shellQuote(dir)} && `;
  };

  const layout = arrangeWorkflowPositions(workflow.nodes, workflow.edges, {
    direction: 'horizontal',
  });
  const position = (node: WorkflowNode): [number, number] => {
    const p = layout[node.id] ?? node.position;
    return [Math.round(p.x * 1.1), Math.round(p.y * 0.9)];
  };

  const failureSources = new Set(
    workflow.edges
      .filter((e) =>
        /^(failure|fail|error|on failure|on error)$/i.test((e.label ?? '').trim()),
      )
      .map((e) => e.source),
  );

  const nodes: N8nNode[] = [];
  const execute = (node: WorkflowNode, command: string, note?: string): N8nNode => ({
    id: stableUuid(`${workflow.id}:${node.id}`),
    name: names.get(node.id) ?? node.id,
    type: 'n8n-nodes-base.executeCommand',
    typeVersion: 1,
    position: position(node),
    parameters: { command: expr(command) },
    ...(note === undefined ? {} : { notes: note, notesInFlow: true }),
    ...(failureSources.has(node.id) ? { onError: 'continueErrorOutput' } : {}),
  });

  for (const node of workflow.nodes) {
    const name = names.get(node.id) ?? node.id;
    const id = stableUuid(`${workflow.id}:${node.id}`);
    const c = node.config;
    switch (node.type) {
      case 'start':
        nodes.push({
          id,
          name,
          type: 'n8n-nodes-base.manualTrigger',
          typeVersion: 1,
          position: position(node),
          parameters: {},
        });
        break;
      case 'end':
        nodes.push({
          id,
          name,
          type: 'n8n-nodes-base.noOp',
          typeVersion: 1,
          position: position(node),
          parameters: {},
        });
        break;
      case 'command': {
        const args = c.args ?? [];
        const exe = (c.executable ?? '').trim();
        let command: string;
        if (c.scriptFile !== undefined)
          command = [exe || 'bash', c.scriptFile, ...args].map(shellQuote).join(' ');
        else if (
          ['sh', 'bash', 'zsh'].includes(exe) &&
          args[0] === '-c' &&
          args.length >= 2
        )
          command = args[1] ?? '';
        else command = [exe, ...args].map(shellQuote).join(' ');
        nodes.push(execute(node, cdPrefix(c) + command));
        break;
      }
      case 'agent': {
        const profile = profiles.find((p) => p.id === c.agentProfileId);
        const adapter: AdapterKind = profile?.adapter ?? 'claude';
        const context = (c.contextRefs ?? [])
          .filter((ref) => names.has(ref))
          .map(
            (ref) => `\n\nOutput of "${names.get(ref) ?? ref}":\n{{node.${ref}.output}}`,
          )
          .join('');
        const prompt = (c.prompt ?? '') + context;
        nodes.push(
          execute(
            node,
            cdPrefix(c) + CLI_PROMPT[adapter](prompt, profile?.model),
            `AI agent step (${profile?.name ?? c.agentRole ?? 'default profile'}). Runs the local CLI; n8n must run where it is installed and signed in.`,
          ),
        );
        notes.add(
          'AI agent steps call your local CLI through Execute Command nodes, so n8n must run on a machine where that CLI is installed and signed in.',
        );
        if (profile?.adapter === 'custom')
          notes.add(
            'Custom CLI steps use "your-cli" as a placeholder command; edit it in n8n.',
          );
        break;
      }
      case 'git':
        if (c.gitOp !== undefined)
          nodes.push(execute(node, cdPrefix(c) + gitCommand(c.gitOp)));
        break;
      case 'github':
        if (c.githubOp !== undefined)
          nodes.push(execute(node, cdPrefix(c) + githubCommand(c.githubOp)));
        break;
      case 'approval':
        nodes.push({
          id,
          name,
          type: 'n8n-nodes-base.wait',
          typeVersion: 1.1,
          position: position(node),
          parameters: { resume: 'webhook', options: {} },
          notes: c.message ?? 'Approve to continue.',
          notesInFlow: true,
        });
        notes.add(
          'Approvals become Wait nodes that resume on their webhook URL. Swap in a "Send and wait for response" node (Slack, Gmail, Telegram) to approve from chat.',
        );
        break;
      case 'condition': {
        const clauses: ConditionClause[] = c.condition?.clauses ?? [];
        nodes.push({
          id,
          name,
          type: 'n8n-nodes-base.if',
          typeVersion: 2.2,
          position: position(node),
          parameters: {
            conditions: {
              options: {
                caseSensitive: true,
                leftValue: '',
                typeValidation: 'loose',
                version: 2,
              },
              conditions: clauses.map((clause, index) => ({
                id: stableUuid(`${workflow.id}:${node.id}:${String(index)}`),
                leftValue: expr(`{{${clause.left}}}`),
                rightValue: clause.right,
                operator: OP_TO_N8N[clause.op],
              })),
              combinator: c.condition?.logic ?? 'and',
            },
            looseTypeValidation: true,
            options: {},
          },
        });
        break;
      }
      case 'ticket':
        nodes.push({
          id,
          name,
          type: 'n8n-nodes-base.jira',
          typeVersion: 1,
          position: position(node),
          parameters: {
            resource: 'issue',
            operation: 'get',
            issueKey: expr(c.ticketKey ?? ''),
            additionalFields: {},
          },
        });
        notes.add(
          'Ticket steps become Jira nodes; connect your Jira credentials in n8n.',
        );
        break;
      case 'mcp':
        nodes.push({
          id,
          name,
          type: 'n8n-nodes-base.noOp',
          typeVersion: 1,
          position: position(node),
          parameters: {},
          notes: `MCP tool "${c.mcpTool ?? ''}"${
            c.mcpArgs !== undefined && Object.keys(c.mcpArgs).length > 0
              ? ` with ${JSON.stringify(c.mcpArgs)}`
              : ''
          }. Replace with an AI Agent that has the MCP Client tool.`,
          notesInFlow: true,
        });
        notes.add(
          'n8n calls MCP tools only from an AI Agent (MCP Client tool), so MCP steps become placeholders with the tool name and arguments in their notes.',
        );
        break;
    }
  }

  if (inputs.length > 0) {
    const start = workflow.nodes.find((n) => n.type === 'start');
    const [sx, sy] = start === undefined ? [0, 0] : position(start);
    nodes.push({
      id: stableUuid(`${workflow.id}:__inputs`),
      name: INPUTS_NODE,
      type: 'n8n-nodes-base.set',
      typeVersion: 3.4,
      position: [sx + 110, sy + 160],
      parameters: {
        assignments: {
          assignments: inputs.map((input) => ({
            id: stableUuid(`${workflow.id}:input:${input.name}`),
            name: input.name,
            value: input.default ?? '',
            type: 'string',
          })),
        },
        options: {},
      },
      notes: 'Fill in the run inputs here before executing.',
      notesInFlow: true,
    });
    notes.add(
      `Run inputs (${inputs.map((i) => i.name).join(', ')}) become fields on a "${INPUTS_NODE}" node after the trigger.`,
    );
  }

  const connections: N8nWorkflow['connections'] = {};
  const link = (from: string, output: number, to: string): void => {
    const main = (connections[from] ??= { main: [] }).main ?? [];
    while (main.length <= output) main.push([]);
    (main[output] ??= []).push({ node: to, type: 'main', index: 0 });
    connections[from] = { main };
  };
  for (const id of startIds) {
    if (inputs.length > 0) link(names.get(id) ?? id, 0, INPUTS_NODE);
  }
  for (const edge of workflow.edges) {
    const from = names.get(edge.source);
    const to = names.get(edge.target);
    if (from === undefined || to === undefined) continue;
    const label = (edge.label ?? '').trim().toLowerCase();
    const kind = kindOf.get(edge.source);
    let output = 0;
    if (kind === 'condition')
      output = ['false', 'no', 'on false'].includes(label) ? 1 : 0;
    else if (/^(failure|fail|error|on failure|on error)$/.test(label)) output = 1;
    const source = startIds.has(edge.source) && inputs.length > 0 ? INPUTS_NODE : from;
    link(source, output, to);
  }

  return {
    workflow: {
      name: workflow.name,
      nodes,
      connections,
      settings: { executionOrder: 'v1' },
      pinData: {},
      meta: { generatedBy: 'Orchevia' },
    },
    notes: [...notes],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True for n8n workflow JSON: `nodes` with n8n types and a `connections` map. */
export function isN8nWorkflow(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !isRecord(value.connections))
    return false;
  return value.nodes.some(
    (node) =>
      isRecord(node) &&
      typeof node.type === 'string' &&
      /^(@n8n\/)?n8n-nodes-/.test(node.type),
  );
}

const TRIGGER = /trigger$/i;
const PASS_THROUGH = new Set([
  'n8n-nodes-base.noOp',
  'n8n-nodes-base.set',
  'n8n-nodes-base.merge',
  'n8n-nodes-base.splitInBatches',
  'n8n-nodes-base.itemLists',
  'n8n-nodes-base.splitOut',
  'n8n-nodes-base.aggregate',
  'n8n-nodes-base.filter',
  'n8n-nodes-base.sort',
  'n8n-nodes-base.limit',
  'n8n-nodes-base.removeDuplicates',
]);
const AI_SUBNODE =
  /^@n8n\/n8n-nodes-langchain\.(lmChat|lm|embeddings|memory|tool|outputParser|vectorStore|retriever|textSplitter|document|mcpClientTool)/;
const AI_PROMPT_NODES = new Set([
  '@n8n/n8n-nodes-langchain.agent',
  '@n8n/n8n-nodes-langchain.chainLlm',
  '@n8n/n8n-nodes-langchain.chainSummarization',
  '@n8n/n8n-nodes-langchain.openAi',
  '@n8n/n8n-nodes-langchain.anthropic',
  '@n8n/n8n-nodes-langchain.googleGemini',
  '@n8n/n8n-nodes-langchain.informationExtractor',
  '@n8n/n8n-nodes-langchain.textClassifier',
  '@n8n/n8n-nodes-langchain.sentimentAnalysis',
]);

const N8N_OP: Record<string, ConditionOp | undefined> = {
  equals: 'equals',
  equal: 'equals',
  notEquals: 'notEquals',
  notEqual: 'notEquals',
  contains: 'contains',
  notContains: 'notContains',
  gt: 'greater',
  larger: 'greater',
  lt: 'less',
  smaller: 'less',
  gte: 'greaterOrEqual',
  largerEqual: 'greaterOrEqual',
  lte: 'lessOrEqual',
  smallerEqual: 'lessOrEqual',
};

function stringParam(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Convert n8n workflow JSON to an Orchevia Simple JSON document. Throws when
 * the value is not an n8n workflow.
 */
export function fromN8n(value: unknown): N8nImport {
  if (!isN8nWorkflow(value) || !isRecord(value))
    throw new Error('This is not n8n workflow JSON: expected "nodes" and "connections".');
  const raw = value as {
    name?: unknown;
    nodes: unknown[];
    connections: Record<string, unknown>;
  };
  const notes: string[] = [];
  const note = (text: string): void => {
    if (!notes.includes(text)) notes.push(text);
  };
  const n8nNodes = raw.nodes.filter(isRecord).map((n) => ({
    name: stringParam(n.name),
    type: stringParam(n.type),
    parameters: isRecord(n.parameters) ? n.parameters : {},
    disabled: n.disabled === true,
    onError: stringParam(n.onError),
    notes: stringParam(n.notes),
    position: Array.isArray(n.position) ? (n.position as unknown[]) : [],
  }));
  const byName = new Map(n8nNodes.map((n) => [n.name, n]));

  // Keys: readable, unique, valid (`^[a-zA-Z_][\w-]{0,63}$`).
  const keys = new Map<string, string>();
  const usedKeys = new Set<string>(['start', 'end']);
  const keyFor = (name: string): string => {
    const existing = keys.get(name);
    if (existing !== undefined) return existing;
    let base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);
    if (!/^[a-z_]/.test(base)) base = `step_${base}`;
    if (base === '' || base === 'step_') base = 'step';
    let key = base;
    for (let n = 2; usedKeys.has(key); n++) key = `${base}_${String(n)}`;
    usedKeys.add(key);
    keys.set(name, key);
    return key;
  };

  const triggers = new Set<string>();
  const kept = new Map<string, DeveloperNode>();
  const inputs = new Set<string>();
  const outputIsCondition = new Set<string>();

  // Values a Set node assigns become run input defaults when steps read them.
  const setValues = new Map<string, Map<string, string>>();
  for (const n of n8nNodes) {
    if (n.type !== 'n8n-nodes-base.set') continue;
    const outer = n.parameters.assignments;
    const list = isRecord(outer) ? outer.assignments : undefined;
    const values = new Map<string, string>();
    if (Array.isArray(list))
      for (const item of list as unknown[]) {
        if (!isRecord(item)) continue;
        const value = stringParam(item.value);
        values.set(stringParam(item.name), value.startsWith('=') ? '' : value);
      }
    setValues.set(n.name, values);
  }
  const inputDefaults = new Map<string, string>();

  /** n8n expression text → Orchevia template text (best effort). */
  const translate = (
    text: string,
    previous: string | undefined,
    where: string,
  ): string => {
    const body = text.startsWith('=') ? text.slice(1) : text;
    return body.replace(/\{\{\s*([\s\S]+?)\s*\}\}/g, (whole, inner: string) => {
      const ref = inner.trim();
      const named =
        /^\$\(\s*['"](.+?)['"]\s*\)\.(?:item|first\(\)|last\(\))\.json(?:\.([\w.]+)|\[\s*['"](.+?)['"]\s*\])$/.exec(
          ref,
        );
      const direct =
        /^\$(?:json|input\.(?:item|first\(\)|last\(\))\.json)(?:\.([\w.]+)|\[\s*['"](.+?)['"]\s*\])$/.exec(
          ref,
        );
      const source = named !== null ? named[1] : direct !== null ? previous : undefined;
      const field =
        named !== null ? (named[2] ?? named[3]) : (direct?.[1] ?? direct?.[2]);
      if (field !== undefined && source !== undefined) {
        const sourceNode = byName.get(source);
        if (triggers.has(source) || sourceNode?.type === 'n8n-nodes-base.set') {
          const name = field.replace(/[^\w-]/g, '_');
          inputs.add(name);
          const preset = setValues.get(source)?.get(field);
          if (preset !== undefined && preset !== '' && !inputDefaults.has(name))
            inputDefaults.set(name, preset);
          return `{{input.${name}}}`;
        }
        if (sourceNode !== undefined && keys.has(source)) {
          const key = keys.get(source) ?? '';
          if (field === 'exitCode') return `{{node.${key}.exitCode}}`;
          if (field === 'key' && sourceNode.type === 'n8n-nodes-base.jira')
            return '{{ticket.key}}';
          if (field === 'fields.summary') return '{{ticket.title}}';
          if (field === 'fields.description') return '{{ticket.description}}';
          return `{{node.${key}.output}}`;
        }
      }
      note(
        `"${where}" uses the n8n expression ${whole}, which was kept as plain text. Replace it with an Orchevia reference such as {{input.name}} or {{node.step.output}}.`,
      );
      return whole.replaceAll('{{', '[[').replaceAll('}}', ']]');
    });
  };

  // Incoming connection per node (first predecessor) for `$json` lookups.
  const predecessors = new Map<string, string[]>();
  for (const [from, outputs] of Object.entries(raw.connections)) {
    if (!isRecord(outputs) || !Array.isArray(outputs.main)) continue;
    for (const list of outputs.main as unknown[]) {
      if (!Array.isArray(list)) continue;
      for (const target of list as unknown[]) {
        if (!isRecord(target)) continue;
        const to = stringParam(target.node);
        predecessors.set(to, [...(predecessors.get(to) ?? []), from]);
      }
    }
  }

  // First pass: classify and assign keys in n8n order.
  for (const n of n8nNodes) {
    if (n.type === 'n8n-nodes-base.stickyNote') continue;
    if (n.disabled) {
      note(`Disabled node "${n.name}" was left out.`);
      continue;
    }
    if (
      TRIGGER.test(n.type) ||
      n.type === 'n8n-nodes-base.webhook' ||
      n.type === 'n8n-nodes-base.cron'
    ) {
      triggers.add(n.name);
      continue;
    }
    if (AI_SUBNODE.test(n.type)) continue;
    keyFor(n.name);
  }

  for (const n of n8nNodes) {
    if (!keys.has(n.name)) continue;
    const key = keys.get(n.name) ?? '';
    const previous = predecessors.get(n.name)?.[0];
    const p = n.parameters;
    const t = (text: string): string => translate(text, previous, n.name);
    let node: DeveloperNode | null = null;
    if (n.type === 'n8n-nodes-base.executeCommand') {
      node = commandNode(key, n.name, t(stringParam(p.command)));
    } else if (n.type === 'n8n-nodes-base.httpRequest') {
      const method = stringParam(p.method) || stringParam(p.requestMethod) || 'GET';
      node = {
        key,
        type: 'command',
        label: n.name,
        config: {
          executable: 'curl',
          args: ['-sS', '-X', method.toUpperCase(), t(stringParam(p.url))],
        },
      };
      if (p.sendHeaders === true || p.sendBody === true || p.authentication !== undefined)
        note(
          `"${n.name}" became a curl command without its headers, body or credentials; add what it needs.`,
        );
    } else if (n.type === 'n8n-nodes-base.if') {
      node = {
        key,
        type: 'condition',
        label: n.name,
        config: { condition: ifCondition(p, t, n.name, note) },
      };
      outputIsCondition.add(n.name);
    } else if (
      n.type === 'n8n-nodes-base.wait' ||
      n.type === 'n8n-nodes-base.form' ||
      stringParam(p.operation) === 'sendAndWait'
    ) {
      const message = t(stringParam(p.message) || n.notes || 'Approve to continue.');
      node = { key, type: 'approval', label: n.name, config: { message } };
      if (
        n.type === 'n8n-nodes-base.wait' &&
        stringParam(p.resume) !== 'webhook' &&
        stringParam(p.resume) !== 'form'
      )
        note(
          `Wait node "${n.name}" paused for a fixed time in n8n; in Orchevia it asks for approval instead.`,
        );
    } else if (
      n.type === 'n8n-nodes-base.jira' &&
      (stringParam(p.operation) || 'get') === 'get'
    ) {
      node = {
        key,
        type: 'ticket',
        label: n.name,
        config: { ticketKey: t(stringParam(p.issueKey)) },
      };
      note('Jira steps became Ticket steps; choose your Jira MCP server on each one.');
    } else if (AI_PROMPT_NODES.has(n.type)) {
      const prompt =
        stringParam(p.text) ||
        stringParam(p.prompt) ||
        messagesText(p) ||
        stringParam(isRecord(p.options) ? p.options.systemMessage : undefined);
      node = {
        key,
        type: 'agent',
        label: n.name,
        role: 'implementation',
        config: { prompt: t(prompt || `Do the task described as "${n.name}".`) },
      };
      note(
        'AI nodes became Agent steps for your Implementation profile; their model and tool sub-nodes were not converted. Give the CLI tools through its own MCP settings.',
      );
    } else if (n.type === 'n8n-nodes-base.code') {
      note(
        `Code node "${n.name}" was left out: n8n JavaScript does not run outside n8n. Add a Command step if you need it.`,
      );
    } else if (PASS_THROUGH.has(n.type)) {
      if (n.type === 'n8n-nodes-base.noOp') {
        if (n.notes.trim() !== '')
          note(`Placeholder "${n.name}" was left out: ${n.notes.trim()}`);
      } else if (n.type !== 'n8n-nodes-base.set')
        note(
          `"${n.name}" (${shortType(n.type)}) only reshapes n8n data and was left out.`,
        );
    } else {
      note(
        `"${n.name}" (${shortType(n.type)}) has no Orchevia equivalent and was left out.`,
      );
    }
    if (node !== null) kept.set(n.name, node);
  }
  if (triggers.size > 0) {
    for (const name of triggers) {
      const type = byName.get(name)?.type ?? '';
      if (/schedule|cron|interval/i.test(type))
        note(`Schedule trigger "${name}": set the same schedule in Automations.`);
      else if (/webhook|chatTrigger|formTrigger/i.test(type))
        note(
          `Trigger "${name}" starts runs from outside n8n; in Orchevia, run the workflow yourself or from Automations.`,
        );
    }
  }

  // Edges between kept nodes; dropped nodes pass their connections through.
  type Link = { to: string; label?: string };
  const out = new Map<string, Link[]>();
  for (const [from, outputs] of Object.entries(raw.connections)) {
    if (!isRecord(outputs) || !Array.isArray(outputs.main)) continue;
    const source = byName.get(from);
    (outputs.main as unknown[]).forEach((list, index) => {
      if (!Array.isArray(list)) return;
      for (const target of list as unknown[]) {
        if (!isRecord(target)) continue;
        let label: string | undefined;
        if (outputIsCondition.has(from)) label = index === 0 ? 'true' : 'false';
        else if (index === 1 && source?.onError === 'continueErrorOutput')
          label = 'failure';
        out.set(from, [
          ...(out.get(from) ?? []),
          { to: stringParam(target.node), ...(label === undefined ? {} : { label }) },
        ]);
      }
    });
  }
  // A path that ends in a dropped node (End, a Code step) ends the workflow.
  const END = '\u0000end';
  const resolve = (name: string, seen: Set<string>): string[] => {
    if (kept.has(name)) return [name];
    if (seen.has(name)) return [];
    seen.add(name);
    const next = out.get(name) ?? [];
    if (next.length === 0) return [END];
    return next.flatMap((link) => resolve(link.to, seen));
  };
  const edges: DeveloperWorkflow['edges'] = [];
  const addEdge = (from: string, to: string, label?: string): void => {
    if (edges.some((e) => e.from === from && e.to === to && e.label === label)) return;
    edges.push({ from, to, ...(label === undefined ? {} : { label }) });
  };
  const sources = [...triggers, ...kept.keys()];
  for (const from of sources) {
    const fromKey = triggers.has(from) ? 'start' : (keys.get(from) ?? '');
    for (const link of out.get(from) ?? []) {
      for (const to of resolve(link.to, new Set([from]))) {
        if (to === END && fromKey === 'start') continue;
        addEdge(fromKey, to === END ? 'end' : (keys.get(to) ?? ''), link.label);
      }
    }
  }

  const steps = [...kept.values()];
  const withIncoming = new Set(edges.map((e) => e.to));
  for (const step of steps) if (!withIncoming.has(step.key)) addEdge('start', step.key);
  const withOutgoing = new Set(edges.map((e) => e.from));
  for (const step of steps) {
    if (withOutgoing.has(step.key)) continue;
    if (step.type === 'condition') {
      const labels = edges.filter((e) => e.from === step.key).map((e) => e.label);
      if (!labels.includes('true')) addEdge(step.key, 'end', 'true');
      if (!labels.includes('false')) addEdge(step.key, 'end', 'false');
    } else addEdge(step.key, 'end');
  }
  for (const step of steps.filter((s) => s.type === 'condition')) {
    const labels = edges.filter((e) => e.from === step.key).map((e) => e.label);
    if (!labels.includes('true')) addEdge(step.key, 'end', 'true');
    if (!labels.includes('false')) addEdge(step.key, 'end', 'false');
  }
  if (steps.length === 0) addEdge('start', 'end');

  const document: DeveloperWorkflow = {
    version: 1,
    name: stringParam(raw.name).trim() || 'Imported from n8n',
    nodes: [
      { key: 'start', type: 'start', label: 'Start', config: {} },
      ...steps,
      { key: 'end', type: 'end', label: 'End', config: {} },
    ],
    edges,
    ...(inputs.size > 0
      ? {
          inputs: [...inputs].map((name) => {
            const preset = inputDefaults.get(name);
            return preset === undefined
              ? { name, label: name, required: true }
              : { name, label: name, default: preset };
          }),
        }
      : {}),
  };
  if (steps.some((s) => s.type === 'command'))
    note(
      'Command steps run on this computer. Review each one before the first live run.',
    );
  return { document, notes };
}

function shortType(type: string): string {
  return type.replace(/^(@n8n\/)?n8n-nodes-(base|langchain)\./, '');
}

function messagesText(p: Record<string, unknown>): string {
  const messages = isRecord(p.messages) ? p.messages.values : undefined;
  if (!Array.isArray(messages)) return '';
  return messages
    .filter(isRecord)
    .map((m) => stringParam(m.content))
    .filter(Boolean)
    .join('\n\n');
}

function ifCondition(
  p: Record<string, unknown>,
  t: (text: string) => string,
  name: string,
  note: (text: string) => void,
): NonNullable<NodeConfig['condition']> {
  const clauses: ConditionClause[] = [];
  const leftRef = (text: string): string => {
    const translated = t(text).trim();
    const ref = /^\{\{\s*(node\.[\w-]+\.(?:output|exitCode)|input\.[\w-]+)\s*\}\}$/.exec(
      translated,
    );
    if (ref?.[1] !== undefined) return ref[1];
    note(
      `Condition "${name}" compares a value Orchevia cannot read (${text}); pick the step output to test.`,
    );
    return translated.replace(/^\{\{\s*|\s*\}\}$/g, '');
  };
  let logic: 'and' | 'or' = 'and';
  const v2 = isRecord(p.conditions) ? p.conditions : undefined;
  if (v2 !== undefined && Array.isArray(v2.conditions)) {
    logic = v2.combinator === 'or' ? 'or' : 'and';
    for (const raw of v2.conditions as unknown[]) {
      if (!isRecord(raw)) continue;
      const operation = isRecord(raw.operator) ? stringParam(raw.operator.operation) : '';
      const op = N8N_OP[operation];
      if (op === undefined) {
        note(
          `Condition "${name}" uses the n8n operator "${operation}", which has no Orchevia equivalent; it was left out.`,
        );
        continue;
      }
      clauses.push({
        left: leftRef(stringParam(raw.leftValue)),
        op,
        right: stringParam(raw.rightValue),
      });
    }
  } else if (v2 !== undefined) {
    // If node v1: { string: [{ value1, operation, value2 }], number: […], boolean: […] }
    logic = p.combineOperation === 'any' ? 'or' : 'and';
    for (const group of ['string', 'number', 'boolean', 'dateTime']) {
      const list = v2[group];
      if (!Array.isArray(list)) continue;
      for (const raw of list as unknown[]) {
        if (!isRecord(raw)) continue;
        const op = N8N_OP[stringParam(raw.operation) || 'equal'];
        if (op === undefined) {
          note(
            `Condition "${name}" uses the n8n operator "${stringParam(raw.operation)}", which has no Orchevia equivalent; it was left out.`,
          );
          continue;
        }
        clauses.push({
          left: leftRef(stringParam(raw.value1)),
          op,
          right: stringParam(raw.value2),
        });
      }
    }
  }
  if (clauses.length === 0)
    note(
      `Condition "${name}" has no clauses Orchevia could convert; add one before running.`,
    );
  return { logic, clauses };
}

/** Split a POSIX shell command into words (quotes and backslashes). */
export function shellWords(command: string): string[] | null {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  for (let i = 0; i < command.length; i++) {
    const c = command.charAt(i);
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      current += command.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < command.length && command.charAt(j) !== '"'; j++) {
        if (command.charAt(j) === '\\' && j + 1 < command.length) {
          j += 1;
          current += command.charAt(j);
        } else current += command.charAt(j);
      }
      if (j >= command.length) return null;
      inWord = true;
      i = j;
    } else if (c === '\\' && i + 1 < command.length) {
      current += command.charAt(i + 1);
      inWord = true;
      i += 1;
    } else if (c === ' ' || c === '\t' || c === '\n') {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
    } else {
      current += c;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return words;
}

const AGENT_CLIS: { words: string[]; promptFlag?: string }[] = [
  { words: ['claude', '-p'] },
  { words: ['codex', 'exec'] },
  { words: ['gemini'], promptFlag: '--prompt' },
  { words: ['agy'], promptFlag: '--print' },
  { words: ['opencode', 'run'] },
  { words: ['muse', 'exec'] },
];

/**
 * An Execute Command node: a local agent CLI call becomes an Agent step,
 * anything else a `sh -c` Command step. A leading `cd <dir> &&` becomes the
 * step's working folder.
 */
function commandNode(key: string, label: string, command: string): DeveloperNode {
  let rest = command.trim();
  let workingDir: string | undefined;
  const cd = /^cd\s+('[^']*'|"[^"]*"|[^\s&;]+)\s*&&\s*/.exec(rest);
  if (cd?.[1] !== undefined) {
    const dir = shellWords(cd[1])?.[0];
    if (dir !== undefined && !dir.includes('{{')) {
      workingDir = dir;
      rest = rest.slice(cd[0].length);
    }
  }
  const words = /[;&|<>`$()]/.test(rest.replace(/'[^']*'/g, "''"))
    ? null
    : shellWords(rest);
  if (words !== null) {
    for (const cli of AGENT_CLIS) {
      if (!cli.words.every((w, i) => words[i] === w)) continue;
      const args = words.slice(cli.words.length);
      let prompt: string | undefined;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? '';
        if (arg === '--model') i += 1;
        else if (arg === '--') prompt = args.slice(i + 1).join(' ');
        else if (cli.promptFlag !== undefined && arg === cli.promptFlag)
          prompt = args[i + 1];
        else if (cli.promptFlag === undefined && !arg.startsWith('-')) prompt = arg;
        if (prompt !== undefined) break;
      }
      if (prompt !== undefined && prompt.trim() !== '')
        return {
          key,
          type: 'agent',
          label,
          role: 'implementation',
          config: { prompt, ...(workingDir === undefined ? {} : { workingDir }) },
        };
    }
  }
  return {
    key,
    type: 'command',
    label,
    config: {
      executable: 'sh',
      args: ['-c', rest],
      ...(workingDir === undefined ? {} : { workingDir }),
    },
  };
}

/**
 * Pasted import text, ready for Orchevia's own parsers: n8n workflow JSON is
 * converted to a Simple JSON document (with notes); anything else is
 * returned unchanged for the normal import to check.
 */
export function prepareImportText(text: string): {
  json: string;
  notes: string[];
  source: 'n8n' | 'orchevia';
} {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { json: text, notes: [], source: 'orchevia' };
  }
  if (!isN8nWorkflow(value)) return { json: text, notes: [], source: 'orchevia' };
  const { document, notes } = fromN8n(value);
  return { json: JSON.stringify(document, null, 2), notes, source: 'n8n' };
}
