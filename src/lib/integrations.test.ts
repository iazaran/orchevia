import { describe, expect, it } from 'vitest';
import {
  MCP_PRESETS,
  matchMcpPreset,
  mcpEnvSnippet,
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
});
