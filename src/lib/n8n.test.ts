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
import { validateWorkflowLocal, type Workflow } from './workflow';
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

describe('toN8n', () => {
  const { workflow: out, notes } = toN8n(workflow, [codex]);
  const node = (name: string): N8nNode | undefined =>
    out.nodes.find((n) => n.name === name);

  it('maps each step to the closest n8n node', () => {
    expect(node('Start')?.type).toBe('n8n-nodes-base.manualTrigger');
    expect(node('Workflow inputs')?.type).toBe('n8n-nodes-base.set');
    expect(node('Implement')?.parameters.command).toBe(
      `=cd /repo && claude -p 'Do {{ $("Workflow inputs").item.json["task"] }}. Don'\\''t commit.'`,
    );
    expect(node('Run tests')).toMatchObject({
      type: 'n8n-nodes-base.executeCommand',
      parameters: { command: 'cd /repo && npm test' },
      onError: 'continueErrorOutput',
    });
    expect(String(node('Review')?.parameters.command)).toContain(
      "codex exec --model gpt-5.5 'Review the diff.",
    );
    expect(String(node('Review')?.parameters.command)).toContain(
      '{{ $("Run tests").item.json.stdout }}',
    );
    expect(node('Approve')).toMatchObject({
      type: 'n8n-nodes-base.wait',
      notes: 'Commit now?',
    });
    expect(node('Commit')?.parameters.command).toBe(
      `=cd /repo && git commit -m 'feat: {{ $("Workflow inputs").item.json["task"] }}'`,
    );
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
      config: { executable: 'sh', args: ['-c', 'npm test'], workingDir: '/repo' },
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
      'ask:approval',
      'end:end',
    ]);
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
      'is_urgent>end:false',
      'ask>end',
    ]);
    const text = notes.join('\n');
    expect(text).toMatch(/Code node "Shape" was left out/);
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
          name: 'Run',
          type: 'n8n-nodes-base.executeCommand',
          parameters: { command: '=echo {{ $now.toISO() }}' },
        },
      ],
      connections: { Go: { main: [[{ node: 'Run', type: 'main', index: 0 }]] } },
    });
    expect(document.nodes[1]?.config.args).toEqual(['-c', 'echo [[ $now.toISO() ]]']);
    expect(notes.join(' ')).toMatch(/kept as plain text/);
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
