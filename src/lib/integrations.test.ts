import { describe, expect, it } from 'vitest';
import {
  MCP_PRESETS,
  matchMcpPreset,
  mcpEnvSnippet,
  mcpSetupUpdate,
  presetsInUse,
  validateMcpServer,
} from './integrations';

describe('mcp servers', () => {
  it('rejects blank command', () => {
    expect(
      validateMcpServer({ id: 'a', name: 'A', command: '', args: [], enabled: true }),
    ).not.toHaveLength(0);
  });

  it('accepts a valid server', () => {
    expect(
      validateMcpServer({
        id: 'a',
        name: 'A',
        command: 'npx',
        args: ['-y', 'x'],
        enabled: true,
      }),
    ).toHaveLength(0);
  });
});

describe('MCP presets', () => {
  it('are unique, valid servers that keep secrets out of their arguments', () => {
    const ids = MCP_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of MCP_PRESETS) {
      expect(
        validateMcpServer({
          id: preset.id,
          name: preset.name,
          command: preset.command,
          args: preset.args,
          enabled: true,
        }),
        preset.id,
      ).toEqual([]);
      for (const name of [...preset.env, ...(preset.envOptional ?? [])])
        expect(name, preset.id).toMatch(/^[A-Z][A-Z0-9_]*$/);
      if (preset.placeholder !== undefined)
        expect(preset.args.some((a) => a.includes(preset.placeholder ?? ''))).toBe(true);
      // Only `${NAME}` references: mcp-remote expands them from the shell.
      for (const arg of preset.args)
        expect(arg.replace(/\$\{[A-Z0-9_]+\}/g, ''), preset.id).not.toMatch(
          /(xox[bp]-|ghp_|sk_live|secret_)/,
        );
      expect(preset.tools.length).toBeGreaterThan(0);
      expect(preset.source).toMatch(/^https:\/\//);
    }
  });

  it('combines Google services in one server and finds presets for saved servers', () => {
    expect(MCP_PRESETS.filter((p) => /Gmail|Google Docs/.test(p.name))).toEqual([]);
    const google = MCP_PRESETS.find((p) => p.id === 'google-workspace');
    expect(google?.args).toEqual([
      'workspace-mcp',
      '--tools',
      'gmail',
      'drive',
      'calendar',
      'docs',
      'sheets',
      '--read-only',
    ]);
    expect(matchMcpPreset({ command: 'uvx', args: ['mcp-atlassian'] })?.id).toBe('jira');
    expect(
      matchMcpPreset({ command: 'npx', args: ['-y', '@sentry/mcp-server@1.2.0'] })?.id,
    ).toBe('sentry');
    expect(
      matchMcpPreset({
        command: 'npx',
        args: ['-y', 'mcp-remote', 'https://mcp.linear.app/mcp/readonly'],
      })?.id,
    ).toBe('linear');
    expect(matchMcpPreset({ command: 'my-server', args: [] })).toBeUndefined();
    expect(
      matchMcpPreset({
        command: 'uvx',
        args: ['fastmcp', 'run', 'https://internal.example/mcp'],
      }),
    ).toBeUndefined();
    expect(
      matchMcpPreset({
        command: 'uvx',
        args: ['fastmcp', 'run', 'https://knowledge-mcp.global.api.aws'],
      })?.id,
    ).toBe('aws-knowledge');
  });

  it('writes export lines with names only', () => {
    const slack = MCP_PRESETS.find((p) => p.id === 'slack');
    if (slack === undefined) throw new Error('fixture');
    expect(mcpEnvSnippet(slack)).toContain('# Set one of these:');
    expect(mcpEnvSnippet(slack)).toContain('export SLACK_MCP_XOXB_TOKEN="…"');
    const fetch = MCP_PRESETS.find((p) => p.id === 'fetch');
    if (fetch === undefined) throw new Error('fixture');
    expect(mcpEnvSnippet(fetch)).toBe('');
  });

  it('recognizes servers saved from the setups earlier versions offered', () => {
    // v0.3.0 called the Jira setup "Jira" and ran Slack's binary directly.
    expect(
      matchMcpPreset({
        command: 'slack-mcp-server',
        args: [
          '--transport',
          'stdio',
          '--enabled-tools',
          'channels_list,conversations_history,conversations_replies',
        ],
      })?.id,
    ).toBe('slack');
    // The v0.3.0 Gmail and Google Docs setups ran another server (gws) with
    // fewer services: Google Workspace is not their update, so they stay the
    // user's own servers.
    expect(
      matchMcpPreset({
        command: 'gws-mcp-server',
        args: ['--read-only', '--services', 'gmail'],
      }),
    ).toBeUndefined();
    const used = presetsInUse([
      { id: 'a', name: 'Jira', command: 'uvx', args: ['mcp-atlassian'], enabled: true },
      { id: 'b', name: 'Mine', command: 'my-server', args: [], enabled: true },
      {
        id: 'c',
        name: 'Work Jira',
        command: 'uvx',
        args: ['mcp-atlassian', '--read-only'],
        enabled: false,
      },
    ]);
    expect([...used.entries()]).toEqual([['jira', ['Jira', 'Work Jira']]]);
  });

  it('updates only what an older setup left unchanged', () => {
    const old = {
      id: 'j',
      name: 'Jira',
      command: 'uvx',
      args: ['mcp-atlassian'],
      enabled: true,
    };
    const update = mcpSetupUpdate(old);
    expect(update?.preset.id).toBe('jira');
    expect(update?.updated).toEqual({
      id: 'j',
      name: 'Jira & Confluence',
      command: 'uvx',
      args: ['mcp-atlassian', '--read-only'],
      enabled: true,
    });
    expect(update?.changes).toEqual([
      { what: 'name', from: 'Jira', to: 'Jira & Confluence' },
      { what: 'command', from: 'uvx mcp-atlassian', to: 'uvx mcp-atlassian --read-only' },
    ]);
    // Renamed by the user: only the arguments are offered.
    expect(mcpSetupUpdate({ ...old, name: 'Work Jira' })?.updated.name).toBe('Work Jira');
    // Changed arguments: only the old name is offered.
    const changed = mcpSetupUpdate({
      ...old,
      args: ['mcp-atlassian', '--enabled-tools', 'x'],
    });
    expect(changed?.updated.args).toEqual(['mcp-atlassian', '--enabled-tools', 'x']);
    expect(changed?.changes).toEqual([
      { what: 'name', from: 'Jira', to: 'Jira & Confluence' },
    ]);
    // Current setups and custom servers need nothing.
    expect(
      mcpSetupUpdate({
        ...old,
        name: 'Jira & Confluence',
        args: ['mcp-atlassian', '--read-only'],
      }),
    ).toBeNull();
    expect(
      mcpSetupUpdate({
        ...old,
        name: 'Work Jira',
        args: ['mcp-atlassian', '--read-only'],
      }),
    ).toBeNull();
    expect(mcpSetupUpdate({ ...old, command: 'my-jira', args: [] })).toBeNull();
  });

  it('keeps every legacy setup unique and pointing at a real preset command', () => {
    const seen = new Set<string>();
    for (const preset of MCP_PRESETS)
      for (const old of preset.legacy ?? []) {
        const key = [old.command, ...old.args].join(' ');
        expect(seen.has(key), key).toBe(false);
        seen.add(key);
        expect(matchMcpPreset(old)?.id).toBe(preset.id);
      }
  });
});
