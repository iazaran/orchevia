import { describe, expect, it } from 'vitest';
import { createDefaultProfile } from './agents';
import { createEmptyWorkflow, type NodeConfig, type WorkflowNode } from './workflow';
import {
  missingToolGrants,
  permissionDeniedFrom,
  profileGrants,
  ruleCovers,
  validateToolRule,
  validateToolRules,
  withAllowedTools,
} from './permissions';

describe('tool permissions', () => {
  it('reads refused tool calls recorded by the engine', () => {
    const json = JSON.stringify({
      failureKind: 'permissionDenied',
      permissionDenied: {
        profileId: 'prof-1',
        denials: [
          {
            toolName: 'Bash',
            toolUseId: 'toolu_1',
            detail: 'git status',
            rules: ['Bash(git status *)'],
          },
          { toolName: 42 },
        ],
        rules: ['Bash(git status *)'],
      },
    });
    expect(permissionDeniedFrom(json)).toEqual({
      profileId: 'prof-1',
      denials: [
        {
          toolName: 'Bash',
          toolUseId: 'toolu_1',
          detail: 'git status',
          rules: ['Bash(git status *)'],
        },
      ],
      rules: ['Bash(git status *)'],
    });
    expect(permissionDeniedFrom('{}')).toBeNull();
    expect(permissionDeniedFrom('not json')).toBeNull();
    expect(permissionDeniedFrom(undefined)).toBeNull();
  });

  it('validates allow rules like the core', () => {
    for (const rule of [
      'Edit',
      'mcp__claude_ai_Atlassian_Rovo_2',
      'Bash(git status *)',
      'Bash(pnpm test:*)',
      'Read(./src/**)',
      'WebFetch(domain:example.com)',
    ])
      expect(validateToolRule(rule)).toBeNull();
    for (const rule of [
      '',
      ' Edit',
      '-p',
      'Bash(',
      'Bash()',
      'Bash(a, b)',
      'Edit Write',
      'Edit\nWrite',
    ])
      expect(validateToolRule(rule)).toContain('Invalid allowed tool');
    expect(validateToolRule("Bash(curl -H 'Authorization: Bearer x' *)")).toContain(
      'credential',
    );
    const many = Array.from({ length: 65 }, (_, i) => `T${String(i)}`);
    expect(validateToolRules(many, 'Allowed tools')[0]).toBe(
      'Allowed tools can list at most 64 tools.',
    );
  });

  it('knows which rules admit which calls', () => {
    expect(ruleCovers('Bash', 'Bash(git status *)')).toBe(true);
    expect(ruleCovers('mcp__jira', 'mcp__jira__getIssue')).toBe(true);
    expect(ruleCovers('mcp__jira', 'mcp__jira')).toBe(true);
    expect(ruleCovers('mcp__jira', 'mcp__jiraX__getIssue')).toBe(false);
    expect(ruleCovers('Bash(git *)', 'Bash(git status *)')).toBe(true);
    expect(ruleCovers('Bash(git:*)', 'Bash(git status *)')).toBe(true);
    expect(ruleCovers('Bash(git *)', 'Bash(gitk *)')).toBe(false);
    expect(ruleCovers('Bash(git status *)', 'Bash(git *)')).toBe(false);
    expect(ruleCovers('Edit', 'Write')).toBe(false);
  });

  it('adds rules by switching a settings profile to allowed tools', () => {
    const claude = createDefaultProfile('claude');
    const widened = withAllowedTools(claude, ['mcp__jira', 'Bash(git status *)']);
    expect(widened?.permissionLevel).toBe('allowedTools');
    expect(widened?.allowedTools).toEqual(['mcp__jira', 'Bash(git status *)']);
    if (widened === null) throw new Error('expected a widened profile');
    expect(profileGrants(widened, 'mcp__jira')).toBe(true);
    // Already admitted rules are not added twice.
    expect(withAllowedTools(widened, ['mcp__jira'])).toBeNull();
    const broader = withAllowedTools(widened, ['Bash(git status *)', 'Write']);
    expect(broader?.allowedTools).toEqual(['mcp__jira', 'Bash(git status *)', 'Write']);
    // Full access already admits everything; Codex has no allow list.
    expect(
      withAllowedTools({ ...claude, permissionLevel: 'fullAccess' }, ['Write']),
    ).toBeNull();
    expect(withAllowedTools(createDefaultProfile('codex'), ['Write'])).toBeNull();
    // At the settings level the profile itself grants nothing.
    expect(profileGrants({ ...claude, allowedTools: ['Write'] }, 'Write')).toBe(false);
  });

  it('lists declared tools each chosen Claude profile does not grant', () => {
    const settings = {
      ...createDefaultProfile('claude'),
      id: 'p-settings',
      name: 'Impl',
    };
    const full = {
      ...createDefaultProfile('claude'),
      id: 'p-full',
      name: 'Full',
      permissionLevel: 'fullAccess' as const,
    };
    const codex = { ...createDefaultProfile('codex'), id: 'p-codex', name: 'Codex' };
    const workflow = createEmptyWorkflow('Declared');
    const agent = (id: string, config: NodeConfig): WorkflowNode => ({
      id,
      type: 'agent',
      position: { x: 0, y: 0 },
      label: id,
      config: { prompt: 'Work', ...config },
    });
    workflow.nodes.push(
      agent('fetch', { agentProfileId: 'p-settings', requiredTools: ['mcp__jira'] }),
      agent('impl', {
        agentRole: 'implementation',
        requiredTools: ['mcp__jira', 'Bash(git status *)'],
      }),
      agent('free', { agentProfileId: 'p-full', requiredTools: ['Write'] }),
      agent('codex', { agentProfileId: 'p-codex', requiredTools: ['Write'] }),
      agent('none', { agentProfileId: 'p-settings' }),
    );
    const grants = missingToolGrants(workflow, [settings, full, codex], {
      implementation: 'p-settings',
    });
    expect(grants).toHaveLength(1);
    expect(grants[0]?.rules).toEqual(['mcp__jira', 'Bash(git status *)']);
    expect(grants[0]?.nodes).toEqual(['fetch', 'impl']);
    const granted = withAllowedTools(settings, grants[0]?.rules ?? []);
    if (granted === null) throw new Error('expected a widened profile');
    expect(missingToolGrants(workflow, [granted, full, codex], {})).toEqual([]);
  });
});
