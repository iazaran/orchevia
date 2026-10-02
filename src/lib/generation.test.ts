import { describe, expect, it } from 'vitest';
import {
  describeGeneratedStep,
  parseInputDeclarations,
  resolveGeneratorProfile,
  summarizeGenerationExplanation,
} from './generation';

describe('resolveGeneratorProfile', () => {
  it('prefers the workflowGenerator role on the requested adapter', () => {
    const profiles = [
      { id: 'a', adapter: 'claude', role: 'implementation' },
      { id: 'b', adapter: 'claude', role: 'workflowGenerator' },
      { id: 'c', adapter: 'codex', role: 'workflowGenerator' },
    ];
    expect(resolveGeneratorProfile(profiles, 'claude')).toBe('b');
    expect(resolveGeneratorProfile(profiles, 'codex')).toBe('c');
  });

  it('falls back to any profile on the adapter, else null', () => {
    const profiles = [{ id: 'a', adapter: 'claude', role: 'implementation' }];
    expect(resolveGeneratorProfile(profiles, 'claude')).toBe('a');
    expect(resolveGeneratorProfile(profiles, 'codex')).toBeNull();
    expect(resolveGeneratorProfile([], 'claude')).toBeNull();
  });
});

describe('parseInputDeclarations', () => {
  it('parses NAME and NAME=default lines, skips blanks and comments', () => {
    const { inputs, problems } = parseInputDeclarations(
      'KEY\nbranch=feature/x\n# comment\n\nbad name\nKEY=dup',
    );
    expect(inputs).toEqual([
      { name: 'KEY', default: undefined, required: true },
      { name: 'branch', default: 'feature/x', required: false },
    ]);
    expect(problems).toHaveLength(2);
  });
});

describe('describeGeneratedStep', () => {
  it('shows the actual native operation and its target', () => {
    expect(
      describeGeneratedStep({
        id: 'branch',
        type: 'git',
        position: { x: 0, y: 0 },
        config: { gitOp: { op: 'branchCreate', name: 'feature/x' } },
      }),
    ).toBe('branchCreate: feature/x');
    expect(
      describeGeneratedStep({
        id: 'pr',
        type: 'github',
        position: { x: 0, y: 0 },
        config: {
          githubOp: {
            op: 'createPr',
            title: 'Feature x',
            base: 'main',
            head: 'feature/x',
            draft: true,
          },
        },
      }),
    ).toBe('createPr draft: Feature x (feature/x → main)');
    expect(
      describeGeneratedStep({
        id: 'stage',
        type: 'git',
        position: { x: 0, y: 0 },
        config: { gitOp: { op: 'stage', paths: ['src/a.ts', 'src/b.ts'] } },
      }),
    ).toBe('stage: src/a.ts, src/b.ts');
    expect(
      describeGeneratedStep({
        id: 'stage-empty',
        type: 'git',
        position: { x: 0, y: 0 },
        config: { gitOp: { op: 'stage' } },
      }),
    ).toBe('stage: paths missing');
    expect(
      describeGeneratedStep({
        id: 'missing',
        type: 'git',
        position: { x: 0, y: 0 },
        config: {},
      }),
    ).toBe('Operation missing');
  });

  it('identifies ticket, MCP, Agent, and CLI steps', () => {
    expect(
      describeGeneratedStep({
        id: 'ticket',
        type: 'ticket',
        position: { x: 0, y: 0 },
        config: { ticketKey: '{{input.ticket}}' },
      }),
    ).toBe('Ticket: {{input.ticket}}');
    expect(
      describeGeneratedStep({
        id: 'tool',
        type: 'mcp',
        position: { x: 0, y: 0 },
        config: { mcpTool: 'searchJiraIssuesUsingJql' },
      }),
    ).toBe('MCP tool: searchJiraIssuesUsingJql');
    expect(
      describeGeneratedStep({
        id: 'query',
        type: 'mcp',
        position: { x: 0, y: 0 },
        config: {
          mcpTool: 'searchJiraIssuesUsingJql',
          mcpArgs: { jql: 'project = VAC' },
        },
      }),
    ).toBe('MCP tool: searchJiraIssuesUsingJql · jql: project = VAC');
    expect(
      describeGeneratedStep({
        id: 'agent',
        type: 'agent',
        position: { x: 0, y: 0 },
        config: { agentRole: 'implementation', prompt: 'Implement' },
      }),
    ).toBe('Agent role: implementation');
    expect(
      describeGeneratedStep({
        id: 'cmd',
        type: 'command',
        position: { x: 0, y: 0 },
        config: { executable: 'cargo', args: ['test'] },
      }),
    ).toBe('CLI: cargo test');
  });
});

describe('summarizeGenerationExplanation', () => {
  it('shows a short useful preview while preserving the full explanation separately', () => {
    const long =
      'Use the configured Jira MCP tool. ' + 'Detailed setup and caveats. '.repeat(25);
    expect(summarizeGenerationExplanation(long)).toBe(
      'Use the configured Jira MCP tool.…',
    );
    expect(summarizeGenerationExplanation('Simple plan.')).toBe('Simple plan.');
  });
});

it('describes each resolved exact reviewer and project command in preview', () => {
  const profiles = [
    {
      id: 'claude',
      name: 'Claude deep review',
      adapter: 'claude' as const,
      model: 'fable',
    },
    {
      id: 'codex',
      name: 'Codex deep review',
      adapter: 'codex' as const,
      model: 'gpt-6.1-sol',
    },
  ];
  for (const profile of profiles) {
    const description = describeGeneratedStep(
      {
        id: profile.id,
        type: 'agent',
        position: { x: 0, y: 0 },
        config: { agentProfileId: profile.id, prompt: 'Review' },
      },
      profiles,
    );
    expect(description).toContain(profile.name);
    expect(description).toContain(profile.model);
  }
  expect(
    describeGeneratedStep({
      id: 'tests',
      type: 'command',
      position: { x: 0, y: 0 },
      config: { executable: 'sh', args: ['-c', '{{input.testCommand}}'] },
    }),
  ).toContain('{{input.testCommand}}');
});
