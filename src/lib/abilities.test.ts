import { describe, expect, it } from 'vitest';
import {
  abilityAccess,
  missingConnectors,
  mockHostAbilities,
  NO_ABILITIES,
  parseAbilitiesSetting,
  serializeAbilities,
  storedAbilities,
  withAllowedRules,
  type HostConnector,
} from './abilities';
import {
  resolveForRun,
  browserArgs,
  usesBrowser,
  validateProfile,
  type AgentProfile,
} from './agents';

const claude: AgentProfile = {
  id: 'p1',
  name: 'Claude',
  adapter: 'claude',
  model: 'opus',
  extraArgs: [],
  workingDirMode: 'inherit',
  defaultTimeoutSecs: 3600,
  permissionLevel: 'cliSettings',
};
const following: AgentProfile = { ...claude, permissionLevel: 'appDefault' };

describe('the app-wide abilities setting (mirror of abilities.rs)', () => {
  it('parses, rejects and serializes like Rust', () => {
    expect(
      parseAbilitiesSetting(
        '{"browser":true,"allowedTools":["mcp__claude_ai_Slack","WebFetch"]}',
      ),
    ).toEqual({ browser: true, allowedTools: ['mcp__claude_ai_Slack', 'WebFetch'] });
    expect(() => parseAbilitiesSetting('{"allowedTools":["Bash(rm -rf /"]}')).toThrow();
    expect(() => parseAbilitiesSetting('[]')).toThrow(
      'Agent abilities must be a JSON object.',
    );
    expect(() => parseAbilitiesSetting('{"browser":"yes"}')).toThrow();
    expect(storedAbilities('{oops')).toEqual(NO_ABILITIES);
    expect(storedAbilities(null)).toEqual(NO_ABILITIES);
    expect(serializeAbilities(NO_ABILITIES)).toBe('{"browser":false}');
  });

  it('adds and removes allowed rules without duplicates', () => {
    const once = withAllowedRules(NO_ABILITIES, ['WebSearch', 'WebFetch'], true);
    expect(withAllowedRules(once, ['WebFetch'], true)).toEqual(once);
    expect(withAllowedRules(once, ['WebSearch', 'WebFetch'], false)).toEqual({
      browser: false,
    });
  });
});

describe('profiles as runs use them (mirror of AgentProfile::for_run)', () => {
  it('adds the browser and its rule below full access', () => {
    const run = resolveForRun(following, 'cliSettings', { browser: true });
    expect(run).toMatchObject({
      browser: true,
      permissionLevel: 'allowedTools',
      allowedTools: ['mcp__claude-in-chrome'],
    });
    expect(browserArgs(run)).toEqual(['--chrome']);
    const full = resolveForRun(following, 'fullAccess', {
      browser: true,
      allowedTools: ['WebFetch'],
    });
    expect(full.permissionLevel).toBe('fullAccess');
    expect(full.allowedTools).toBeUndefined();
    expect(browserArgs(full)).toEqual(['--chrome']);
  });

  it('lets a profile choice and its own flags win', () => {
    const on = { browser: true };
    expect(
      resolveForRun({ ...following, browser: false }, 'cliSettings', on).browser,
    ).toBe(false);
    expect(
      usesBrowser(resolveForRun({ ...following, browser: true }, null, NO_ABILITIES)),
    ).toBe(true);
    const flagged = resolveForRun({ ...following, extraArgs: ['--no-chrome'] }, null, on);
    expect(flagged.browser).toBe(false);
    expect(browserArgs(flagged)).toEqual([]);
    expect(
      usesBrowser(
        resolveForRun({ ...claude, extraArgs: ['--chrome'] }, null, NO_ABILITIES),
      ),
    ).toBe(true);
  });

  it('gives allowed abilities only to profiles following the app default', () => {
    const abilities = {
      browser: false,
      allowedTools: ['mcp__claude_ai_Atlassian_Rovo', 'WebFetch'],
    };
    expect(resolveForRun(following, 'cliSettings', abilities)).toMatchObject({
      permissionLevel: 'allowedTools',
      allowedTools: ['mcp__claude_ai_Atlassian_Rovo', 'WebFetch'],
    });
    expect(resolveForRun(claude, 'cliSettings', abilities).permissionLevel).toBe(
      'cliSettings',
    );
    const listed: AgentProfile = {
      ...claude,
      permissionLevel: 'allowedTools',
      allowedTools: ['Edit'],
    };
    expect(resolveForRun(listed, null, abilities).allowedTools).toEqual(['Edit']);
    expect(resolveForRun(listed, null, { browser: true }).allowedTools).toEqual([
      'Edit',
      'mcp__claude-in-chrome',
    ]);
    const flags = resolveForRun(
      { ...following, extraArgs: ['--permission-mode', 'acceptEdits'] },
      'cliSettings',
      abilities,
    );
    expect(flags.permissionLevel).toBe('cliSettings');
  });

  it('gives other CLIs no browser and no rules', () => {
    const codex = resolveForRun({ ...following, adapter: 'codex', browser: true }, null, {
      browser: true,
      allowedTools: ['WebFetch'],
    });
    expect('browser' in codex).toBe(false);
    expect(codex.permissionLevel).toBe('cliSettings');
    expect(usesBrowser(codex)).toBe(false);
  });

  it('validates browser choices like Rust', () => {
    expect(validateProfile({ ...claude, adapter: 'codex', browser: true })).toContain(
      'Browser use applies only to Claude Code profiles.',
    );
    expect(
      validateProfile({ ...claude, browser: true, extraArgs: ['--no-chrome'] }).some(
        (e) => e.includes("'--no-chrome'"),
      ),
    ).toBe(true);
    expect(validateProfile({ ...claude, browser: false })).toEqual([]);
  });
});

describe('what a step may use', () => {
  it('reads full access, the user settings and Orchevia grants', () => {
    expect(abilityAccess('mcp__claude_ai_Slack', 'fullAccess', NO_ABILITIES, [])).toBe(
      'fullAccess',
    );
    expect(
      abilityAccess('mcp__claude_ai_Slack', 'cliSettings', NO_ABILITIES, [
        'mcp__claude_ai_Slack',
      ]),
    ).toBe('settings');
    // A single tool rule does not cover the whole server.
    expect(
      abilityAccess('mcp__claude_ai_Slack', null, NO_ABILITIES, [
        'mcp__claude_ai_Slack__search',
      ]),
    ).toBe('needed');
    expect(
      abilityAccess(
        'mcp__claude_ai_Slack',
        null,
        { browser: false, allowedTools: ['mcp__claude_ai_Slack'] },
        [],
      ),
    ).toBe('orchevia');
  });

  it('finds connectors workflows still name after Claude Code renamed them', () => {
    const detected: HostConnector[] = [
      {
        name: 'claude.ai Atlassian Rovo',
        rule: 'mcp__claude_ai_Atlassian_Rovo',
        status: 'connected',
        scope: 'account',
        target: '',
      },
      {
        name: 'claude.ai Slack',
        rule: 'mcp__claude_ai_Slack',
        status: 'connected',
        scope: 'account',
        target: '',
      },
    ];
    const agent = (
      requiredTools: string[],
    ): { type: string; config: { requiredTools: string[] } } => ({
      type: 'agent',
      config: { requiredTools },
    });
    expect(
      missingConnectors(
        [
          {
            name: 'Ticket to PR',
            nodes: [agent(['mcp__claude_ai_Atlassian_Rovo_2', 'Edit'])],
          },
          {
            name: 'RFC',
            nodes: [agent(['mcp__claude_ai_Atlassian_Rovo_2__getJiraIssue'])],
          },
          {
            name: 'Browse',
            nodes: [agent(['mcp__claude-in-chrome', 'mcp__claude_ai_Slack'])],
          },
          { name: 'Old', nodes: [agent(['mcp__retired_server'])] },
          {
            name: 'Cmd',
            nodes: [{ type: 'command', config: { requiredTools: ['mcp__x'] } }],
          },
        ],
        detected,
      ),
    ).toEqual([
      {
        server: 'claude_ai_Atlassian_Rovo_2',
        workflows: ['RFC', 'Ticket to PR'],
        suggestion: 'claude_ai_Atlassian_Rovo',
      },
      { server: 'retired_server', workflows: ['Old'] },
    ]);
  });

  it('labels its browser preview data as a demo', () => {
    expect(mockHostAbilities('claude').connectorsNote).toMatch(/Demo data/);
    expect(mockHostAbilities('codex').browser.switchable).toBe(false);
  });
});
