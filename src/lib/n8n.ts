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

/** Quotes one shell word; values inside it are escaped for the quotes. */
type Quote = (arg: string) => string;

const CLI_PROMPT: Record<
  AdapterKind,
  (prompt: string, model: string | undefined, q: Quote) => string
> = {
  claude: (p, m, q) => `claude -p ${m ? `--model ${q(m)} ` : ''}${q(p)}`,
  codex: (p, m, q) => `codex exec ${m ? `--model ${q(m)} ` : ''}${q(p)}`,
  muse: (p, m, q) => `muse exec ${m ? `--model ${q(m)} ` : ''}-- ${q(p)}`,
  gemini: (p, m, q) => `gemini ${m ? `--model ${q(m)} ` : ''}--prompt ${q(p)}`,
  antigravity: (p, m, q) => `agy ${m ? `--model ${q(m)} ` : ''}--print ${q(p)}`,
  opencode: (p, m, q) => `opencode run ${m ? `--model ${q(m)} ` : ''}-- ${q(p)}`,
  custom: (p, _m, q) => `your-cli ${q(p)}`,
};

function gitCommand(op: GitOp, q: Quote): string {
  switch (op.op) {
    case 'status':
      return 'git status --short --branch';
    case 'diffSummary':
      return 'git diff --stat';
    case 'branchCreate':
      return `git switch -c ${q(op.name)}`;
    case 'checkout':
      return `git switch ${q(op.name)}`;
    case 'stage':
      return `git add -- ${(op.paths ?? ['.']).map(q).join(' ') || '.'}`;
    case 'commit':
      return `git commit -m ${q(op.message)}`;
    case 'worktreeAdd':
      return `git worktree add ${op.branch ? `-b ${q(op.branch)} ` : ''}${q(op.path)}`;
    case 'worktreeRemove':
      return `git worktree remove ${q(op.path)}`;
    case 'worktreeList':
      return 'git worktree list';
    case 'remotes':
      return 'git remote -v';
  }
}

function githubCommand(op: GitHubOp, q: Quote): string {
  switch (op.op) {
    case 'prStatus':
      return 'gh pr status';
    case 'listPrs':
      return `gh pr list${op.state ? ` --state ${q(op.state)}` : ''}`;
    case 'prDetails':
      return `gh pr view ${String(op.number)}`;
    case 'prFiles':
      return `gh pr diff ${String(op.number)} --name-only`;
    case 'prChecks':
      return `gh pr checks ${String(op.number)}`;
    case 'createPr':
      return [
        'gh pr create',
        `--title ${q(op.title)}`,
        `--body ${q(op.body ?? '')}`,
        `--base ${q(op.base)}`,
        `--head ${q(op.head)}`,
        op.draft === true ? '--draft' : '',
      ]
        .filter(Boolean)
        .join(' ');
    case 'postComment':
      return `gh pr comment ${String(op.number)} --body ${q(op.body)}`;
  }
}

const REF = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * An n8n expression that yields `path` as text with every single quote
 * written as `'\''`, so the value stays one word inside single quotes. No
 * literal quote appears in the expression itself.
 */
function inQuotes(path: string): string {
  // `'` is a single quote inside the n8n expression's JS strings.
  const quote = '\\u0027';
  return `String(${path} ?? "").replaceAll("${quote}", "${quote}\\\\${quote}${quote}")`;
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

  /** The n8n expression path for an Orchevia reference, or null. */
  const pathOf = (ref: string): string | null => {
    const input = /^input\.([\w-]+)$/.exec(ref);
    if (input !== null)
      return `$(${JSON.stringify(INPUTS_NODE)}).item.json[${JSON.stringify(input[1])}]`;
    const node = /^node\.([\w-]+)(?:\.(output|exitCode|stdout|stderr|severity))?$/.exec(
      ref,
    );
    if (node !== null) {
      const target = names.get(node[1] ?? '');
      if (target === undefined) return null;
      if (node[2] === 'severity')
        notes.add(
          'Review severity has no n8n field; the reviewer output is used instead.',
        );
      const field =
        node[2] === 'exitCode' ? 'exitCode' : node[2] === 'stderr' ? 'stderr' : 'stdout';
      return `$(${JSON.stringify(target)}).item.json.${field}`;
    }
    const ticket = /^ticket\.(key|title|description|acceptanceCriteria)$/.exec(ref);
    if (ticket !== null) {
      const ticketNode = workflow.nodes.find((n) => n.type === 'ticket');
      const target = ticketNode === undefined ? undefined : names.get(ticketNode.id);
      if (target === undefined) return null;
      const path =
        ticket[1] === 'key'
          ? 'key'
          : ticket[1] === 'title'
            ? 'fields.summary'
            : 'fields.description';
      return `$(${JSON.stringify(target)}).item.json.${path}`;
    }
    return null;
  };
  const unknownRef = (ref: string): string => {
    notes.add(
      `The reference {{${ref}}} has no n8n equivalent and was kept as the text [[${ref}]].`,
    );
    return `[[${ref}]]`;
  };

  /**
   * One n8n parameter. `q` quotes a shell word and escapes values inside it;
   * `raw` inserts values as they are (a shell script, a field); `done` adds
   * the `=` that turns on n8n expressions when a value was inserted.
   */
  const param = (): {
    q: Quote;
    raw: (text: string) => string;
    done: (text: string) => string;
  } => {
    let expression = false;
    const q: Quote = (arg) => {
      if (!arg.includes('{{')) return shellQuote(arg);
      let out = '';
      let last = 0;
      for (const match of arg.matchAll(REF)) {
        out += arg.slice(last, match.index).replaceAll("'", `'\\''`);
        const ref = (match[1] ?? '').trim();
        const path = pathOf(ref);
        if (path === null) out += unknownRef(ref).replaceAll("'", `'\\''`);
        else {
          expression = true;
          out += `{{ ${inQuotes(path)} }}`;
        }
        last = match.index + match[0].length;
      }
      out += arg.slice(last).replaceAll("'", `'\\''`);
      return `'${out}'`;
    };
    const raw = (text: string): string =>
      text.replace(REF, (_whole, inner: string) => {
        const ref = inner.trim();
        const path = pathOf(ref);
        if (path === null) return unknownRef(ref);
        expression = true;
        return `{{ ${path} }}`;
      });
    return { q, raw, done: (text) => (expression ? `=${text}` : text) };
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
    parameters: { command },
    ...(note === undefined ? {} : { notes: note, notesInFlow: true }),
  });
  const placeholder = (node: WorkflowNode, note: string): N8nNode => ({
    id: stableUuid(`${workflow.id}:${node.id}`),
    name: names.get(node.id) ?? node.id,
    type: 'n8n-nodes-base.noOp',
    typeVersion: 1,
    position: position(node),
    parameters: {},
    notes: note,
    notesInFlow: true,
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
        const p = param();
        let command: string;
        if (c.scriptFile !== undefined)
          command = [exe || 'bash', c.scriptFile, ...args].map(p.q).join(' ');
        else if (
          ['sh', 'bash', 'zsh'].includes(exe) &&
          args[0] === '-c' &&
          args.length === 2
        )
          // The step's own shell script: values go in as they do in Orchevia.
          command = p.raw(args[1] ?? '');
        else command = [exe, ...args].map(p.q).join(' ');
        nodes.push(execute(node, p.done(cdPrefix(c) + command)));
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
        const p = param();
        nodes.push(
          execute(
            node,
            p.done(cdPrefix(c) + CLI_PROMPT[adapter](prompt, profile?.model, p.q)),
            `AI agent step (${profile?.name ?? c.agentRole ?? 'default profile'}). Runs the local CLI; n8n must run where it is installed and signed in.`,
          ),
        );
        notes.add(
          'AI agent steps call your local CLI through Execute Command nodes, so n8n must run on a machine where that CLI is installed and signed in. Permission levels and sessions stay with the CLI’s own settings.',
        );
        if (profile?.adapter === 'custom')
          notes.add(
            'Custom CLI steps use "your-cli" as a placeholder command; edit it in n8n.',
          );
        break;
      }
      case 'git': {
        const p = param();
        nodes.push(
          c.gitOp === undefined
            ? placeholder(node, 'Git step without an operation.')
            : execute(node, p.done(cdPrefix(c) + gitCommand(c.gitOp, p.q))),
        );
        break;
      }
      case 'github': {
        const p = param();
        nodes.push(
          c.githubOp === undefined
            ? placeholder(node, 'GitHub step without an operation.')
            : execute(node, p.done(cdPrefix(c) + githubCommand(c.githubOp, p.q))),
        );
        break;
      }
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
              conditions: clauses.map((clause, index) => {
                const p = param();
                return {
                  id: stableUuid(`${workflow.id}:${node.id}:${String(index)}`),
                  leftValue: p.done(p.raw(`{{${clause.left}}}`)),
                  rightValue: clause.right,
                  operator: OP_TO_N8N[clause.op],
                };
              }),
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
            issueKey: ((p) => p.done(p.raw(c.ticketKey ?? '')))(param()),
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

  for (const id of failureSources) {
    const failing = nodes.find((n) => n.name === names.get(id));
    if (failing !== undefined) failing.onError = 'continueErrorOutput';
  }
  if (
    workflow.nodes.some(
      (n) =>
        n.config.timeoutSecs !== undefined ||
        n.config.retry !== undefined ||
        (n.config.maxVisits ?? 1) > 1,
    ) ||
    workflow.limits !== undefined
  )
    notes.add(
      'Timeouts, retries, loop limits and usage limits are not exported; set the ones you need on the n8n nodes.',
    );

  // No prototype: a step may be named "__proto__" or "constructor".
  const connections = Object.create(null) as N8nWorkflow['connections'];
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
/** Nodes that only reshape n8n items: left out, their neighbours joined. */
const PASS_THROUGH = new Set([
  'n8n-nodes-base.noOp',
  'n8n-nodes-base.set',
  'n8n-nodes-base.merge',
  'n8n-nodes-base.splitInBatches',
  'n8n-nodes-base.itemLists',
  'n8n-nodes-base.splitOut',
  'n8n-nodes-base.aggregate',
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
  }));
  const byName = new Map(n8nNodes.map((n) => [n.name, n]));

  // Main connections, in output order.
  type Link = { to: string; output: number };
  const out = new Map<string, Link[]>();
  for (const [from, outputs] of Object.entries(raw.connections)) {
    if (!isRecord(outputs) || !Array.isArray(outputs.main)) continue;
    (outputs.main as unknown[]).forEach((list, output) => {
      if (!Array.isArray(list)) return;
      for (const target of list as unknown[])
        if (isRecord(target))
          out.set(from, [
            ...(out.get(from) ?? []),
            { to: stringParam(target.node), output },
          ]);
    });
  }
  const predecessors = new Map<string, string[]>();
  for (const [from, links] of out)
    for (const link of links)
      predecessors.set(link.to, [...(predecessors.get(link.to) ?? []), from]);

  // What each node becomes: the Start step, a step, a pass-through, or nothing.
  type Role = 'trigger' | 'step' | 'pass' | 'skip';
  const roles = new Map<string, Role>();
  for (const n of n8nNodes) {
    let role: Role = 'step';
    if (n.type === 'n8n-nodes-base.stickyNote' || AI_SUBNODE.test(n.type)) role = 'skip';
    else if (n.disabled) {
      // n8n passes items through a disabled node unchanged.
      role = 'pass';
      note(`Disabled node "${n.name}" was left out.`);
    } else if (
      TRIGGER.test(n.type) ||
      n.type === 'n8n-nodes-base.webhook' ||
      n.type === 'n8n-nodes-base.cron'
    )
      role = 'trigger';
    else if (PASS_THROUGH.has(n.type)) role = 'pass';
    roles.set(n.name, role);
  }
  const triggers = new Set(
    n8nNodes.filter((n) => roles.get(n.name) === 'trigger').map((n) => n.name),
  );
  // n8n never runs a node no trigger reaches; neither should the import.
  if (triggers.size > 0) {
    const reached = new Set<string>(triggers);
    const queue = [...triggers];
    for (let next = queue.shift(); next !== undefined; next = queue.shift())
      for (const link of out.get(next) ?? [])
        if (!reached.has(link.to)) {
          reached.add(link.to);
          queue.push(link.to);
        }
    for (const n of n8nNodes)
      if (roles.get(n.name) === 'step' && !reached.has(n.name)) {
        roles.set(n.name, 'skip');
        note(`"${n.name}" had no input in n8n, so it never ran there; it was left out.`);
      }
  }

  // Keys: readable, unique, valid (`^[a-zA-Z_][\w-]{0,63}$`).
  const keys = new Map<string, string>();
  const usedKeys = new Set<string>(['start', 'end']);
  for (const n of n8nNodes) {
    if (roles.get(n.name) !== 'step' || keys.has(n.name)) continue;
    let base = n.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);
    if (!/^[a-z_]/.test(base)) base = `step_${base}`;
    if (base === '' || base === 'step_') base = 'step';
    let key = base;
    for (let i = 2; usedKeys.has(key); i++) key = `${base}_${String(i)}`;
    usedKeys.add(key);
    keys.set(n.name, key);
  }

  // Values a Set node assigns become run input defaults when steps read them.
  const setValues = new Map<string, Map<string, string>>();
  for (const n of n8nNodes) {
    if (n.type !== 'n8n-nodes-base.set') continue;
    const outer = n.parameters.assignments;
    const list = isRecord(outer) ? outer.assignments : undefined;
    const values = new Map<string, string>();
    if (Array.isArray(list))
      for (const item of list as unknown[])
        if (isRecord(item)) values.set(stringParam(item.name), stringParam(item.value));
    setValues.set(n.name, values);
  }
  const inputs = new Set<string>();
  const inputDefaults = new Map<string, string>();

  /** n8n expression text → Orchevia template text (best effort). */
  const translate = (
    text: string,
    previous: string | undefined,
    where: string,
  ): string => {
    const body = text.startsWith('=') ? text.slice(1) : text;
    return body.replace(/\{\{\s*([\s\S]+?)\s*\}\}/g, (whole, inner: string) => {
      // Orchevia's own export wraps values: String(<path> ?? "").replaceAll(…).
      const ref =
        /^String\((.+?)\s*\?\?\s*""\)(?:\.replaceAll\(.*\))?$/.exec(inner.trim())?.[1] ??
        inner.trim();
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
          if (preset !== undefined && preset.startsWith('='))
            note(
              `"${source}" computes ${field} with an n8n expression; it became a run input you fill in.`,
            );
          else if (preset !== undefined && preset !== '' && !inputDefaults.has(name))
            inputDefaults.set(name, preset);
          return `{{input.${name}}}`;
        }
        const key = keys.get(source);
        if (sourceNode !== undefined && key !== undefined) {
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

  const steps: DeveloperNode[] = [];
  const conditions = new Set<string>();
  for (const n of n8nNodes) {
    const key = keys.get(n.name);
    if (key === undefined) continue;
    const previous = predecessors.get(n.name)?.[0];
    const p = n.parameters;
    const t = (text: string): string => translate(text, previous, n.name);
    let node: DeveloperNode;
    if (n.type === 'n8n-nodes-base.executeCommand') {
      node = commandNode(key, n.name, t(stringParam(p.command)), note);
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
    } else if (n.type === 'n8n-nodes-base.if' || n.type === 'n8n-nodes-base.filter') {
      node = {
        key,
        type: 'condition',
        label: n.name,
        config: { condition: ifCondition(p, t, n.name, note) },
      };
      conditions.add(n.name);
      if (n.type === 'n8n-nodes-base.filter')
        note(
          `Filter "${n.name}" became a condition: the steps after it run only when it matches, otherwise the run ends.`,
        );
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
    } else {
      // Kept as a visible step that stops the run, so nothing after it runs
      // by accident and references to it still resolve.
      node = {
        key,
        type: 'command',
        label: n.name,
        config: {
          executable: 'sh',
          args: [
            '-c',
            `printf '%s\\n' ${shellQuote(
              `Replace this step: the n8n node "${n.name}" (${shortType(n.type)}) was not converted.`,
            )} >&2; exit 1`,
          ],
        },
      };
      note(
        n.type === 'n8n-nodes-base.code'
          ? `Code node "${n.name}" became a step that stops the run: n8n JavaScript does not run outside n8n. Replace it with a Command step.`
          : `"${n.name}" (${shortType(n.type)}) has no Orchevia equivalent; it became a step that stops the run until you replace it.`,
      );
    }
    steps.push(node);
  }
  for (const n of n8nNodes)
    if (roles.get(n.name) === 'pass') {
      if (n.type === 'n8n-nodes-base.noOp') {
        if (n.notes.trim() !== '')
          note(`Placeholder "${n.name}" was left out: ${n.notes.trim()}`);
      } else if (n.type === 'n8n-nodes-base.splitInBatches')
        note(`Loop "${n.name}" was left out: the steps in it run once.`);
      else if (n.type !== 'n8n-nodes-base.set')
        note(
          `"${n.name}" (${shortType(n.type)}) only reshapes n8n data and was left out.`,
        );
    }
  for (const name of triggers) {
    const type = byName.get(name)?.type ?? '';
    if (/schedule|cron|interval/i.test(type))
      note(`Schedule trigger "${name}": set the same schedule in Automations.`);
    else if (/webhook|chatTrigger|formTrigger/i.test(type))
      note(
        `Trigger "${name}" starts runs from outside n8n; in Orchevia, run the workflow yourself or from Automations.`,
      );
  }

  // Edges between steps; a pass-through node joins its neighbours, and a
  // path that ends in one ends the workflow.
  const END = '\u0000end';
  const resolve = (name: string, seen: Set<string>): string[] => {
    const role = roles.get(name);
    if (keys.has(name)) return [name];
    if (role !== 'pass' || seen.has(name)) return role === 'pass' ? [] : [END];
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
  for (const from of [...triggers, ...keys.keys()]) {
    const fromKey = triggers.has(from) ? 'start' : (keys.get(from) ?? '');
    const source = byName.get(from);
    for (const link of out.get(from) ?? []) {
      const label = conditions.has(from)
        ? link.output === 0
          ? 'true'
          : 'false'
        : link.output === 1 && source?.onError === 'continueErrorOutput'
          ? 'failure'
          : undefined;
      for (const to of resolve(link.to, new Set([from]))) {
        if (to === END && fromKey === 'start') continue;
        const toKey = to === END ? 'end' : (keys.get(to) ?? '');
        if (toKey === fromKey) {
          note(`The n8n loop through "${from}" was not converted: the step runs once.`);
          continue;
        }
        addEdge(fromKey, toKey, label);
      }
    }
  }

  const withIncoming = new Set(edges.map((e) => e.to));
  for (const step of steps) if (!withIncoming.has(step.key)) addEdge('start', step.key);
  for (const step of steps) {
    const labels = edges.filter((e) => e.from === step.key).map((e) => e.label);
    if (step.type === 'condition') {
      if (!labels.includes('true')) addEdge(step.key, 'end', 'true');
      if (!labels.includes('false')) addEdge(step.key, 'end', 'false');
    } else if (labels.every((label) => label === 'failure')) addEdge(step.key, 'end');
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
  // Orchevia compares with fixed text: an n8n expression cannot be kept.
  const literal = (text: string): string => {
    if (!text.startsWith('=') && !text.includes('{{')) return text;
    note(
      `Condition "${name}" compares with the n8n expression ${text}; Orchevia compares with fixed text, so set the value to test.`,
    );
    return text.replace(/^=/, '').replaceAll('{{', '[[').replaceAll('}}', ']]');
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
        right: literal(stringParam(raw.rightValue)),
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
          right: literal(stringParam(raw.value2)),
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

/**
 * Words of a shell command, and whether it needs a shell: an operator,
 * expansion, glob or comment outside quotes, an expansion inside double
 * quotes, or an inserted value (`{{…}}`) outside single quotes. Null when a
 * quote is never closed.
 */
export function shellTokens(command: string): { words: string[]; shell: boolean } | null {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let shell = false;
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
        const d = command.charAt(j);
        if (d === '\\' && '$`"\\'.includes(command.charAt(j + 1))) {
          j += 1;
          current += command.charAt(j);
          continue;
        }
        if (d === '$' || d === '`' || (d === '{' && command.charAt(j + 1) === '{'))
          shell = true;
        current += d;
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
      if (';&|<>()$`*?[~#!'.includes(c) || (c === '{' && command.charAt(i + 1) === '{'))
        shell = true;
      current += c;
      inWord = true;
    }
  }
  if (inWord) words.push(current);
  return { words, shell };
}

/** Split a POSIX shell command into words (quotes and backslashes). */
export function shellWords(command: string): string[] | null {
  return shellTokens(command)?.words ?? null;
}

/**
 * Local agent CLI calls Orchevia itself exports. Only these flags are
 * understood: anything else keeps the command as it is.
 */
const AGENT_CLIS: {
  cmd: string[];
  /** Flags that take a value (the model is recorded). */
  valued: string[];
  /** Flags without a value; one of `required` must appear. */
  bare?: string[];
  required?: string[];
  /** Flags whose value is the prompt; otherwise the prompt is positional. */
  promptFlags?: string[];
}[] = [
  {
    cmd: ['claude'],
    valued: ['--model', '--output-format'],
    bare: ['-p', '--print'],
    required: ['-p', '--print'],
  },
  { cmd: ['codex', 'exec'], valued: ['--model', '-m'] },
  {
    cmd: ['gemini'],
    valued: ['--model', '-m', '--output-format'],
    promptFlags: ['--prompt', '-p'],
  },
  {
    cmd: ['agy'],
    valued: ['--model', '--output-format'],
    promptFlags: ['--print', '-p', '--prompt'],
  },
  { cmd: ['opencode', 'run'], valued: ['--model', '-m'] },
  { cmd: ['muse', 'exec'], valued: ['--model'] },
];

/** The prompt (and model) of an agent CLI call, or null when any word is not understood. */
function agentCall(words: string[]): { prompt: string; model?: string } | null {
  for (const cli of AGENT_CLIS) {
    if (!cli.cmd.every((w, i) => words[i] === w)) continue;
    const args = words.slice(cli.cmd.length);
    let prompt: string | undefined;
    let model: string | undefined;
    let required = cli.required === undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? '';
      if (arg === '--') {
        if (prompt !== undefined || args.length !== i + 2) return null;
        prompt = args[i + 1];
        break;
      }
      if (cli.promptFlags?.includes(arg) === true) {
        if (prompt !== undefined || i + 1 >= args.length) return null;
        prompt = args[++i];
      } else if (cli.valued.includes(arg)) {
        if (i + 1 >= args.length) return null;
        const flagValue = args[++i];
        if (arg === '--model' || arg === '-m') model = flagValue;
      } else if (cli.bare?.includes(arg) === true) {
        if (cli.required?.includes(arg) === true) required = true;
      } else if (
        arg.startsWith('-') ||
        prompt !== undefined ||
        cli.promptFlags !== undefined
      )
        return null;
      else prompt = arg;
    }
    if (!required || prompt === undefined || prompt.trim() === '') return null;
    return model === undefined ? { prompt } : { prompt, model };
  }
  return null;
}

/**
 * An Execute Command node. A call to a known agent CLI becomes an Agent
 * step, a plain command becomes an argv Command step, and anything that
 * needs a shell stays `sh -c`. A leading `cd <dir> &&` becomes the step's
 * working folder.
 */
function commandNode(
  key: string,
  label: string,
  command: string,
  note: (text: string) => void,
): DeveloperNode {
  let rest = command.trim();
  let workingDir: string | undefined;
  const cd = /^cd\s+('[^']*'|"[^"]*"|[^\s&;|]+)\s*&&\s*/.exec(rest);
  if (cd?.[1] !== undefined) {
    const dir = shellTokens(cd[1]);
    if (dir !== null && !dir.shell && dir.words.length === 1 && !cd[1].includes('{{')) {
      workingDir = dir.words[0];
      rest = rest.slice(cd[0].length);
    }
  }
  const folder = workingDir === undefined ? {} : { workingDir };
  const tokens = shellTokens(rest);
  if (tokens !== null && !tokens.shell && tokens.words.length > 0) {
    const agent = agentCall(tokens.words);
    if (agent !== null) {
      if (agent.model !== undefined)
        note(
          `"${label}" asked for the model ${agent.model}; pick a profile that uses it.`,
        );
      return {
        key,
        type: 'agent',
        label,
        role: 'implementation',
        config: { prompt: agent.prompt, ...folder },
      };
    }
    return {
      key,
      type: 'command',
      label,
      config: {
        executable: tokens.words[0] ?? '',
        args: tokens.words.slice(1),
        ...folder,
      },
    };
  }
  if (rest.includes('{{'))
    note(
      `"${label}" runs a shell command with values inserted into its text, as in n8n; check them before running.`,
    );
  return {
    key,
    type: 'command',
    label,
    config: { executable: 'sh', args: ['-c', rest], ...folder },
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
