import { describe, expect, it } from 'vitest';
import {
  fromN8n,
  isN8nWorkflow,
  shellQuote,
  shellWords,
  toN8n,
  type N8nNode,
} from './n8n';
import { decodeDocument, type DeveloperNode } from './workflow-document';
import { validateWorkflowLocal, type Workflow, type WorkflowNode } from './workflow';
import type { AgentProfile } from './agents';

const codex: AgentProfile = {
  id: 'p-codex',
  name: 'Codex reviewer',
  adapter: 'codex',
  model: 'gpt-5.5',
  extraArgs: [],
  workingDirMode: 'node',
  defaultTimeoutSecs: 600,
  role: 'deepReview',
};

const workflow: Workflow = {
  schemaVersion: 6,
  id: 'wf-demo',
  name: 'Fix and review',
  inputs: [{ name: 'task', label: 'Task', required: true }],
  defaults: { repoDir: '/repo' },
  nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
    {
      id: 'impl',
      type: 'agent',
      label: 'Implement',
      position: { x: 0, y: 120 },
      config: { agentRole: 'implementation', prompt: "Do {{input.task}}. Don't commit." },
    },
    {
      id: 'tests',
      type: 'command',
      label: 'Run tests',
      position: { x: 0, y: 240 },
      config: { executable: 'sh', args: ['-c', 'npm test'] },
    },
    {
      id: 'gate',
      type: 'condition',
      label: 'Tests passed?',
      position: { x: 0, y: 360 },
      config: {
        condition: {
          logic: 'and',
          clauses: [{ left: 'node.tests.exitCode', op: 'equals', right: '0' }],
        },
      },
    },
    {
      id: 'review',
      type: 'agent',
      label: 'Review',
      position: { x: 0, y: 480 },
      config: {
        agentProfileId: 'p-codex',
        prompt: 'Review the diff.',
        contextRefs: ['tests'],
      },
    },
    {
      id: 'ok',
      type: 'approval',
      label: 'Approve',
      position: { x: 0, y: 600 },
      config: { message: 'Commit now?' },
    },
    {
      id: 'commit',
      type: 'git',
      label: 'Commit',
      position: { x: 0, y: 720 },
      config: { gitOp: { op: 'commit', message: 'feat: {{input.task}}' } },
    },
    {
      id: 'notify',
      type: 'mcp',
      label: 'Post to Slack',
      position: { x: 200, y: 720 },
      config: { mcpServerId: 'm1', mcpTool: 'post', mcpArgs: { text: 'done' } },
    },
    { id: 'end', type: 'end', position: { x: 0, y: 840 }, config: {} },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'impl' },
    { id: 'e2', source: 'impl', target: 'tests' },
    { id: 'e3', source: 'tests', target: 'gate' },
    { id: 'e4', source: 'gate', target: 'review', label: 'true' },
    { id: 'e5', source: 'gate', target: 'end', label: 'false' },
    { id: 'e6', source: 'review', target: 'ok' },
    { id: 'e7', source: 'ok', target: 'commit' },
    { id: 'e8', source: 'commit', target: 'notify' },
    { id: 'e9', source: 'notify', target: 'end' },
    { id: 'e10', source: 'tests', target: 'end', label: 'failure' },
  ],
};

/**
 * What n8n does with an exported command: evaluate each `{{ }}` against item
 * data, then the shell splits the text into words.
 */
function runAsN8n(
  command: unknown,
  data: Record<string, Record<string, unknown>>,
): string[] | null {
  const text = String(command).replace(/^=/, '');
  const evaluated = text.replace(/\{\{\s*([\s\S]+?)\s*\}\}/g, (_whole, code: string) => {
    const $ = (name: string): { item: { json: Record<string, unknown> } } => ({
      item: { json: data[name] ?? {} },
    });
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const run = new Function('$', `return (${code});`) as (select: typeof $) => unknown;
    return String(run($));
  });
  return shellWords(evaluated);
}

describe('toN8n', () => {
  const { workflow: out, notes } = toN8n(workflow, [codex]);
  const node = (name: string): N8nNode | undefined =>
    out.nodes.find((n) => n.name === name);

  it('maps each step to the closest n8n node', () => {
    expect(node('Start')?.type).toBe('n8n-nodes-base.manualTrigger');
    expect(node('Workflow inputs')?.type).toBe('n8n-nodes-base.set');
    // A value with quotes and shell syntax stays one argument in n8n too.
    const hostile = "x'; rm -rf ~; echo '";
    expect(
      runAsN8n(node('Implement')?.parameters.command, {
        'Workflow inputs': { task: hostile },
      }),
    ).toEqual(['cd', '/repo', '&&', 'claude', '-p', `Do ${hostile}. Don't commit.`]);
    expect(node('Run tests')).toMatchObject({
      type: 'n8n-nodes-base.executeCommand',
      parameters: { command: 'cd /repo && npm test' },
      onError: 'continueErrorOutput',
    });
    expect(String(node('Review')?.parameters.command)).toContain(
      "codex exec --model gpt-5.5 'Review the diff.",
    );
    expect(String(node('Review')?.parameters.command)).toContain(
      '$("Run tests").item.json.stdout',
    );
    expect(node('Approve')).toMatchObject({
      type: 'n8n-nodes-base.wait',
      notes: 'Commit now?',
    });
    expect(
      runAsN8n(node('Commit')?.parameters.command, {
        'Workflow inputs': { task: "it's $(done)" },
      }),
    ).toEqual(['cd', '/repo', '&&', 'git', 'commit', '-m', "feat: it's $(done)"]);
    expect(node('Post to Slack')?.type).toBe('n8n-nodes-base.noOp');
    const gate = node('Tests passed?');
    expect(gate?.type).toBe('n8n-nodes-base.if');
    expect(JSON.stringify(gate?.parameters)).toContain(
      '"leftValue":"={{ $(\\"Run tests\\").item.json.exitCode }}"',
    );
  });

  it('wires true/false and failure outputs and routes Start through the inputs', () => {
    expect(out.connections.Start?.main).toEqual([
      [{ node: 'Workflow inputs', type: 'main', index: 0 }],
    ]);
    expect(out.connections['Workflow inputs']?.main?.[0]?.[0]?.node).toBe('Implement');
    expect(out.connections['Tests passed?']?.main).toEqual([
      [{ node: 'Review', type: 'main', index: 0 }],
      [{ node: 'End', type: 'main', index: 0 }],
    ]);
    expect(out.connections['Run tests']?.main?.[1]).toEqual([
      { node: 'End', type: 'main', index: 0 },
    ]);
  });

  it('is deterministic and explains what changed', () => {
    expect(toN8n(workflow, [codex])).toEqual(toN8n(workflow, [codex]));
    expect(new Set(out.nodes.map((n) => n.id)).size).toBe(out.nodes.length);
    expect(notes.join(' ')).toMatch(/Execute Command/);
    expect(notes.join(' ')).toMatch(/Wait nodes/);
    expect(notes.join(' ')).toMatch(/MCP/);
  });

  const single = (step: WorkflowNode): Workflow => ({
    ...workflow,
    inputs: [{ name: 'prNumber' }, { name: 'u' }],
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      step,
      { id: 'end', type: 'end', position: { x: 0, y: 2 }, config: {} },
    ],
    edges: [
      { id: '1', source: 'start', target: step.id },
      { id: '2', source: step.id, target: 'end' },
    ],
  });

  it('exports bash scripts with their interpreter and PR number 0 as the run input', () => {
    const script = '[[ -n "$BASH_VERSION" ]] && echo {{input.u}}';
    const bash = toN8n(
      single({
        id: 's',
        type: 'command',
        label: 'Bash',
        position: { x: 0, y: 1 },
        config: { executable: 'bash', args: ['-c', script] },
      }),
    ).workflow.nodes.find((n) => n.name === 'Bash');
    expect(
      runAsN8n(bash?.parameters.command, { 'Workflow inputs': { u: 'hi' } }),
    ).toEqual(['cd', '/repo', '&&', 'bash', '-c', '[[ -n "$BASH_VERSION" ]] && echo hi']);
    const view = toN8n(
      single({
        id: 'v',
        type: 'github',
        label: 'View PR',
        position: { x: 0, y: 1 },
        config: { githubOp: { op: 'prDetails', number: 0 } },
      }),
    ).workflow.nodes.find((n) => n.name === 'View PR');
    expect(
      runAsN8n(view?.parameters.command, { 'Workflow inputs': { prNumber: '42' } }),
    ).toEqual(['cd', '/repo', '&&', 'gh', 'pr', 'view', '42']);
  });

  it('keeps references to steps whose names contain braces or quotes', () => {
    const label = 'Say "hi" }} {{';
    const wf: Workflow = {
      ...workflow,
      inputs: [],
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'a',
          type: 'command',
          label,
          position: { x: 0, y: 1 },
          config: { executable: 'date' },
        },
        {
          id: 'b',
          type: 'command',
          label: 'Echo',
          position: { x: 0, y: 2 },
          config: { executable: 'echo', args: ['{{node.a.output}}'] },
        },
        { id: 'end', type: 'end', position: { x: 0, y: 3 }, config: {} },
      ],
      edges: [
        { id: '1', source: 'start', target: 'a' },
        { id: '2', source: 'a', target: 'b' },
        { id: '3', source: 'b', target: 'end' },
      ],
    };
    const exported = toN8n(wf).workflow;
    const echo = exported.nodes.find((n) => n.name === 'Echo');
    expect(runAsN8n(echo?.parameters.command, { [label]: { stdout: 'Monday' } })).toEqual(
      ['cd', '/repo', '&&', 'echo', 'Monday'],
    );
    const back = fromN8n(JSON.parse(JSON.stringify(exported))).document;
    expect(back.nodes.find((n) => n.label === 'Echo')?.config.args).toEqual([
      '{{node.say_hi.output}}',
    ]);
  });

  it('keeps steps named like object built-ins connected', () => {
    const named: Workflow = {
      ...workflow,
      inputs: [],
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'p',
          type: 'command',
          label: '__proto__',
          position: { x: 0, y: 1 },
          config: { executable: 'ls' },
        },
        { id: 'end', type: 'end', position: { x: 0, y: 2 }, config: {} },
      ],
      edges: [
        { id: '1', source: 'start', target: 'p' },
        { id: '2', source: 'p', target: 'end' },
      ],
    };
    const json = JSON.parse(JSON.stringify(toN8n(named).workflow)) as {
      connections: Record<string, unknown>;
    };
    expect(Object.keys(json.connections)).toEqual(['Start', '__proto__']);
  });

  it('keeps node names unique', () => {
    const twin: Workflow = {
      ...workflow,
      inputs: [],
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'a',
          type: 'command',
          label: 'Step',
          position: { x: 0, y: 1 },
          config: { executable: 'ls' },
        },
        {
          id: 'b',
          type: 'command',
          label: 'Step',
          position: { x: 0, y: 2 },
          config: { executable: 'pwd' },
        },
        { id: 'end', type: 'end', position: { x: 0, y: 3 }, config: {} },
      ],
      edges: [
        { id: '1', source: 'start', target: 'a' },
        { id: '2', source: 'a', target: 'b' },
        { id: '3', source: 'b', target: 'end' },
      ],
    };
    const names = toN8n(twin).workflow.nodes.map((n) => n.name);
    expect(names).toEqual(['Start', 'Step', 'Step 2', 'End']);
  });
});

describe('fromN8n', () => {
  it('round-trips an exported workflow into a valid Orchevia workflow', () => {
    const exported = toN8n(workflow, [codex]).workflow;
    expect(isN8nWorkflow(exported)).toBe(true);
    const { document, notes } = fromN8n(JSON.parse(JSON.stringify(exported)));
    const byLabel = (label: string): DeveloperNode | undefined =>
      document.nodes.find((n) => n.label === label);
    expect(byLabel('Implement')).toMatchObject({
      type: 'agent',
      role: 'implementation',
      config: { prompt: "Do {{input.task}}. Don't commit.", workingDir: '/repo' },
    });
    expect(byLabel('Run tests')).toMatchObject({
      type: 'command',
      config: { executable: 'npm', args: ['test'], workingDir: '/repo' },
    });
    // Quoted values come back as one argument, not shell text.
    expect(byLabel('Commit')).toMatchObject({
      type: 'command',
      config: {
        executable: 'git',
        args: ['commit', '-m', 'feat: {{input.task}}'],
        workingDir: '/repo',
      },
    });
    expect(byLabel('Tests passed?')?.config.condition).toEqual({
      logic: 'and',
      clauses: [{ left: 'node.run_tests.exitCode', op: 'equals', right: '0' }],
    });
    expect(byLabel('Approve')).toMatchObject({
      type: 'approval',
      config: { message: 'Commit now?' },
    });
    expect(document.inputs).toEqual([{ name: 'task', label: 'task', required: true }]);
    const edges = document.edges.map(
      (e) => `${e.from}>${e.to}${e.label ? `:${e.label}` : ''}`,
    );
    expect(edges).toContain('start>implement');
    expect(edges).toContain('tests_passed>review:true');
    expect(edges).toContain('tests_passed>end:false');
    expect(edges).toContain('run_tests>end:failure');
    // The MCP placeholder is dropped and its neighbours are joined.
    expect(edges).toContain('commit>end');
    expect(notes.join(' ')).toMatch(/Placeholder "Post to Slack"/);
    const decoded = decodeDocument(JSON.stringify(document), [], {
      implementation: 'p-claude',
    });
    const errors = validateWorkflowLocal(decoded).filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });

  it('maps common n8n nodes and reports the rest', () => {
    const n8n = {
      name: 'Webhook triage',
      nodes: [
        { name: 'Webhook', type: 'n8n-nodes-base.webhook', parameters: {} },
        {
          name: 'Defaults',
          type: 'n8n-nodes-base.set',
          parameters: {
            assignments: { assignments: [{ name: 'url', value: 'https://example.com' }] },
          },
        },
        {
          name: 'Fetch page',
          type: 'n8n-nodes-base.httpRequest',
          parameters: { method: 'POST', url: '={{ $json.url }}' },
        },
        {
          name: 'AI Agent',
          type: '@n8n/n8n-nodes-langchain.agent',
          parameters: { text: '=Summarize {{ $json.data }}' },
        },
        {
          name: 'OpenAI Chat Model',
          type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
          parameters: {},
        },
        {
          name: 'Is urgent?',
          type: 'n8n-nodes-base.if',
          parameters: {
            conditions: {
              string: [
                {
                  value1: '={{ $json.output }}',
                  operation: 'contains',
                  value2: 'urgent',
                },
              ],
            },
          },
        },
        {
          name: 'Shape',
          type: 'n8n-nodes-base.code',
          parameters: { jsCode: 'return items' },
        },
        {
          name: 'Ask',
          type: 'n8n-nodes-base.slack',
          parameters: { operation: 'sendAndWait', message: 'Escalate?' },
        },
        { name: 'Sticky', type: 'n8n-nodes-base.stickyNote', parameters: {} },
      ],
      connections: {
        Webhook: { main: [[{ node: 'Defaults', type: 'main', index: 0 }]] },
        Defaults: { main: [[{ node: 'Fetch page', type: 'main', index: 0 }]] },
        'Fetch page': { main: [[{ node: 'AI Agent', type: 'main', index: 0 }]] },
        'AI Agent': { main: [[{ node: 'Is urgent?', type: 'main', index: 0 }]] },
        'Is urgent?': {
          main: [
            [{ node: 'Ask', type: 'main', index: 0 }],
            [{ node: 'Shape', type: 'main', index: 0 }],
          ],
        },
      },
    };
    const { document, notes } = fromN8n(n8n);
    expect(document.name).toBe('Webhook triage');
    expect(document.nodes.map((n) => `${n.key}:${n.type}`)).toEqual([
      'start:start',
      'fetch_page:command',
      'ai_agent:agent',
      'is_urgent:condition',
      'shape:command',
      'ask:approval',
      'end:end',
    ]);
    // An unconverted node stops the run instead of disappearing.
    expect(document.nodes[4]?.config.args?.[1]).toMatch(/Replace this step.*exit 1$/);
    expect(document.nodes[1]?.config).toEqual({
      executable: 'curl',
      args: ['-sS', '-X', 'POST', '{{input.url}}'],
    });
    expect(document.nodes[2]?.config.prompt).toBe('Summarize {{node.fetch_page.output}}');
    expect(document.nodes[3]?.config.condition).toEqual({
      logic: 'and',
      clauses: [{ left: 'node.ai_agent.output', op: 'contains', right: 'urgent' }],
    });
    expect(document.inputs).toEqual([
      { name: 'url', label: 'url', default: 'https://example.com' },
    ]);
    const edges = document.edges.map(
      (e) => `${e.from}>${e.to}${e.label ? `:${e.label}` : ''}`,
    );
    expect(edges).toEqual([
      'start>fetch_page',
      'fetch_page>ai_agent',
      'ai_agent>is_urgent',
      'is_urgent>ask:true',
      'is_urgent>shape:false',
      'shape>end',
      'ask>end',
    ]);
    const text = notes.join('\n');
    expect(text).toMatch(/Code node "Shape" became a step that stops the run/);
    expect(text).toMatch(/Trigger "Webhook"/);
    expect(text).toMatch(/AI nodes became Agent steps/);
    const decoded = decodeDocument(JSON.stringify(document), [], {
      implementation: 'p1',
    });
    expect(validateWorkflowLocal(decoded).filter((i) => i.severity === 'error')).toEqual(
      [],
    );
  });

  it('keeps unknown expressions visible instead of guessing', () => {
    const { document, notes } = fromN8n({
      nodes: [
        { name: 'Go', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
        {
          name: 'Ask',
          type: 'n8n-nodes-base.wait',
          parameters: { resume: 'webhook', message: '=Approve by {{ $now.toISO() }}' },
        },
      ],
      connections: { Go: { main: [[{ node: 'Ask', type: 'main', index: 0 }]] } },
    });
    expect(document.nodes[1]?.config.message).toBe('Approve by [[ $now.toISO() ]]');
    expect(notes.join(' ')).toMatch(/kept as plain text/);
  });

  const n8nNode = (
    name: string,
    kind: string,
    parameters: Record<string, unknown> = {},
  ): Record<string, unknown> => ({ name, type: `n8n-nodes-base.${kind}`, parameters });
  const links = (...targets: string[][]): Record<string, unknown> => ({
    main: targets.map((list) => list.map((node) => ({ node, type: 'main', index: 0 }))),
  });
  const importCommand = (command: string): DeveloperNode | undefined =>
    fromN8n({
      nodes: [
        n8nNode('Go', 'manualTrigger'),
        n8nNode('Run', 'executeCommand', { command }),
      ],
      connections: { Go: links(['Run']) },
    }).document.nodes[1];

  it('turns a command into an agent step only when every flag is understood', () => {
    expect(importCommand("claude -p --model opus 'Fix it'")).toMatchObject({
      type: 'agent',
      config: { prompt: 'Fix it' },
    });
    expect(importCommand("gemini --prompt 'Review it'")?.type).toBe('agent');
    // A flag's value is never taken for the prompt.
    expect(importCommand("claude -p --allowedTools Bash 'do thing'")).toMatchObject({
      type: 'command',
      config: {
        executable: 'claude',
        args: ['-p', '--allowedTools', 'Bash', 'do thing'],
      },
    });
    expect(importCommand("codex exec --sandbox workspace-write 'fix it'")?.type).toBe(
      'command',
    );
    // Globs, operators and unquoted values keep their shell.
    expect(importCommand('claude -p fix *.ts')?.config.args).toEqual([
      '-c',
      'claude -p fix *.ts',
    ]);
    expect(importCommand('npm test && npm run lint')?.config.executable).toBe('sh');
  });

  it('keeps a shell for multi-line commands, env prefixes and builtins', () => {
    for (const command of [
      'npm run build\nnpm test',
      'FOO=bar npm test',
      'exit 0',
      'source ./env.sh && make',
      '. ./env.sh',
      'time npm test',
    ])
      expect(importCommand(command)?.config, command).toEqual({
        executable: 'sh',
        args: ['-c', command],
      });
    // A line continuation is one command.
    expect(importCommand('npm run \\\nbuild')?.config).toEqual({
      executable: 'npm',
      args: ['run', 'build'],
    });
  });

  it('stops instead of running a command whose expression was not converted', () => {
    const step = importCommand('=echo {{ $json.a > 5 ? "x" : "y" }}');
    expect(step?.config.args?.[1]).toMatch(/^printf .*Replace this step.*exit 1$/);
  });

  it('round-trips prompts with apostrophes and shell characters', () => {
    const prompt = "Don't stop (see notes); check $HOME & `ls`.";
    const wf: Workflow = {
      ...workflow,
      inputs: [],
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'a',
          type: 'agent',
          label: 'Agent',
          position: { x: 0, y: 1 },
          config: { agentRole: 'implementation', prompt },
        },
        { id: 'end', type: 'end', position: { x: 0, y: 2 }, config: {} },
      ],
      edges: [
        { id: '1', source: 'start', target: 'a' },
        { id: '2', source: 'a', target: 'end' },
      ],
    };
    const back = fromN8n(JSON.parse(JSON.stringify(toN8n(wf).workflow)));
    expect(back.document.nodes[1]).toMatchObject({ type: 'agent', config: { prompt } });
  });

  it('maps filters to conditions and leaves out nodes n8n never ran', () => {
    const { document, notes } = fromN8n({
      nodes: [
        n8nNode('Go', 'manualTrigger'),
        n8nNode('Check', 'filter', {
          conditions: {
            conditions: [
              {
                leftValue: '={{ $json.ok }}',
                rightValue: 'yes',
                operator: { operation: 'equals' },
              },
            ],
          },
        }),
        n8nNode('Print', 'executeCommand', { command: 'echo hello' }),
        n8nNode('Orphan', 'executeCommand', { command: 'rm -rf build' }),
      ],
      connections: { Go: links(['Check']), Check: links(['Print']) },
    });
    expect(document.nodes.map((n) => n.key)).toEqual(['start', 'check', 'print', 'end']);
    const edges = document.edges.map(
      (e) => `${e.from}>${e.to}${e.label ? `:${e.label}` : ''}`,
    );
    expect(edges).toContain('check>print:true');
    expect(edges).toContain('check>end:false');
    expect(notes.join(' ')).toMatch(/"Orphan" had no input in n8n/);
  });

  it('does not loop a step onto itself through a dropped loop node', () => {
    const { document, notes } = fromN8n({
      nodes: [
        n8nNode('Go', 'manualTrigger'),
        n8nNode('Items', 'splitInBatches'),
        n8nNode('Work', 'executeCommand', { command: 'echo work' }),
      ],
      connections: {
        Go: links(['Items']),
        Items: links(['Work']),
        Work: links(['Items']),
      },
    });
    expect(document.edges.some((e) => e.from === e.to)).toBe(false);
    expect(notes.join(' ')).toMatch(/loop through "Work" was not converted/);
    const decoded = decodeDocument(JSON.stringify(document), [], {});
    expect(validateWorkflowLocal(decoded).filter((i) => i.severity === 'error')).toEqual(
      [],
    );
  });

  it('notes values Orchevia cannot carry over', () => {
    const { document, notes } = fromN8n({
      nodes: [
        n8nNode('Go', 'manualTrigger'),
        n8nNode('Cfg', 'set', {
          assignments: { assignments: [{ name: 'when', value: '={{ $now }}' }] },
        }),
        n8nNode('Is it?', 'if', {
          conditions: {
            conditions: [
              {
                leftValue: '={{ $json.when }}',
                rightValue: '={{ $("Cfg").item.json.when }}',
                operator: { operation: 'equals' },
              },
            ],
          },
        }),
      ],
      connections: { Go: links(['Cfg']), Cfg: links(['Is it?']) },
    });
    expect(document.inputs).toEqual([{ name: 'when', label: 'when', required: true }]);
    const text = notes.join(' ');
    expect(text).toMatch(/"Cfg" computes when with an n8n expression/);
    expect(text).toMatch(/compares with the n8n expression/);
  });

  it('refuses JSON that is not an n8n workflow', () => {
    expect(isN8nWorkflow({ version: 1, name: 'x', nodes: [], edges: [] })).toBe(false);
    expect(() => fromN8n({ nodes: [] })).toThrow(/not n8n workflow JSON/);
  });
});

it('quotes and splits shell words symmetrically', () => {
  const args = ['plain', 'two words', "it's", '', 'a"b', '$HOME'];
  expect(shellWords(args.map(shellQuote).join(' '))).toEqual(args);
  expect(shellWords(`echo "a \\"b\\"" c\\ d`)).toEqual(['echo', 'a "b"', 'c d']);
  expect(shellWords("echo 'open")).toBeNull();
});
