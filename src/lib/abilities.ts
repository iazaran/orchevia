/**
 * What Claude Code and Codex bring from the user's own setup (TypeScript
 * mirror of `orchevia-core` `abilities`). Headless steps already load each
 * CLI's MCP servers, connectors, skills and personal instructions; Claude in
 * Chrome needs `--chrome`, and below full access the tools a step may call
 * follow the permission settings. The app-wide choice lives in the
 * `agents.abilities` setting.
 */

import { ruleCovers, validateToolRules } from './permissions';
import type { AppPermissionDefault } from './agents';

/** Settings key of the app-wide abilities (Rust `ABILITIES_SETTING`). */
export const ABILITIES_SETTING = 'agents.abilities';
/** Turns on Claude in Chrome for one Claude Code run. */
export const BROWSER_FLAG = '--chrome';
export const NO_BROWSER_FLAG = '--no-chrome';
/** The MCP server `--chrome` adds; allowing it lets steps use the browser. */
export const BROWSER_TOOL_RULE = 'mcp__claude-in-chrome';
/** Claude Code's built-in web tools, offered as one ability. */
export const WEB_TOOL_RULES = ['WebSearch', 'WebFetch'];

/** The user's app-wide choice. Mirrors Rust `AppAbilities`. */
export interface AppAbilities {
  browser: boolean;
  allowedTools?: string[];
}

export const NO_ABILITIES: AppAbilities = { browser: false };

/** Mirror of Rust `parse_abilities_setting`. */
export function parseAbilitiesSetting(value: string): AppAbilities {
  if (new TextEncoder().encode(value).length > 8000)
    throw new Error('Setting value too long.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Agent abilities must be a JSON object.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('Agent abilities must be a JSON object.');
  const record = parsed as Record<string, unknown>;
  const browser = record.browser ?? false;
  const tools = record.allowedTools ?? [];
  if (
    typeof browser !== 'boolean' ||
    !Array.isArray(tools) ||
    !tools.every((t): t is string => typeof t === 'string')
  )
    throw new Error('Agent abilities must be a JSON object.');
  const errors = validateToolRules(tools, 'Allowed abilities');
  if (errors[0] !== undefined) throw new Error(errors[0]);
  return tools.length > 0 ? { browser, allowedTools: tools } : { browser };
}

/** Mirror of Rust `stored_abilities`: anything unreadable grants nothing. */
export function storedAbilities(value: string | null): AppAbilities {
  if (value === null) return NO_ABILITIES;
  try {
    return parseAbilitiesSetting(value);
  } catch {
    return NO_ABILITIES;
  }
}

export function serializeAbilities(abilities: AppAbilities): string {
  const tools = abilities.allowedTools ?? [];
  return JSON.stringify(
    tools.length > 0
      ? { browser: abilities.browser, allowedTools: tools }
      : { browser: abilities.browser },
  );
}

/** One MCP server or connector the CLI loads itself. Mirrors `HostConnector`. */
export interface HostConnector {
  name: string;
  /** Claude Code's allow rule for the whole server. */
  rule?: string;
  status:
    'connected' | 'needsAuth' | 'pending' | 'failed' | 'enabled' | 'disabled' | 'unknown';
  scope: 'account' | 'plugin' | 'local';
  target: string;
}

export interface HostBrowser {
  available: boolean;
  /** Orchevia can turn it on for a run (Claude Code only). */
  switchable: boolean;
  detail: string;
}

/** What one CLI brings from the user's setup. Mirrors `HostAbilities`. */
export interface HostAbilities {
  adapter: 'claude' | 'codex';
  installed: boolean;
  connectors: HostConnector[];
  connectorsNote?: string;
  browser: HostBrowser;
  skills: string[];
  plugins: string[];
  instructions: string[];
  allowedInSettings: string[];
  detectedAt: string;
}

/** Where a step's permission to use a tool comes from, if anywhere. */
export type AbilityAccess = 'fullAccess' | 'settings' | 'orchevia' | 'needed';

/**
 * Whether Claude Code steps of profiles following the app default may call
 * `rule` without asking: full access allows everything; otherwise the user's
 * own Claude Code settings or the abilities allowed in Orchevia must cover it.
 */
export function abilityAccess(
  rule: string,
  appDefault: AppPermissionDefault | null,
  abilities: AppAbilities,
  allowedInSettings: string[],
): AbilityAccess {
  if (appDefault === 'fullAccess') return 'fullAccess';
  if (allowedInSettings.some((granted) => ruleCovers(granted, rule))) return 'settings';
  if ((abilities.allowedTools ?? []).some((granted) => ruleCovers(granted, rule)))
    return 'orchevia';
  return 'needed';
}

/** `abilities` with `rules` allowed (`on`) or no longer allowed. */
export function withAllowedRules(
  abilities: AppAbilities,
  rules: string[],
  on: boolean,
): AppAbilities {
  const current = abilities.allowedTools ?? [];
  const next = on
    ? [...current, ...rules.filter((rule) => !current.includes(rule))]
    : current.filter((rule) => !rules.includes(rule));
  return next.length > 0
    ? { browser: abilities.browser, allowedTools: next }
    : { browser: abilities.browser };
}

/** The server part of an MCP rule: `mcp__a__tool` → `a`. */
function mcpServer(rule: string): string | null {
  if (!rule.startsWith('mcp__')) return null;
  const rest = rule.slice('mcp__'.length);
  const end = rest.indexOf('__');
  const server = end === -1 ? rest : rest.slice(0, end);
  return server === '' ? null : server;
}

/** A workflow step asking for an MCP server Claude Code no longer has. */
export interface MissingConnector {
  /** The server key the steps name, e.g. `claude_ai_Atlassian_Rovo_3`. */
  server: string;
  /** Workflows naming it. */
  workflows: string[];
  /** A detected server it was most likely renamed to. */
  suggestion?: string;
}

function similarity(a: string, b: string): number {
  const strip = (s: string): string => s.replace(/_?\d+$/, '').toLowerCase();
  if (strip(a) === strip(b)) return 3;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  let common = 0;
  while (common < x.length && common < y.length && x[common] === y[common]) common++;
  return common >= 8 ? 2 : 0;
}

/**
 * MCP servers that Agent steps declare in `requiredTools` but Claude Code
 * does not list any more, with the detected server each most likely became
 * (connectors renamed when reconnected, such as "Atlassian Rovo (2)").
 * `claude-in-chrome` is left out: it is there only with `--chrome`.
 */
export function missingConnectors(
  workflows: {
    name: string;
    nodes: { type: string; config: { requiredTools?: string[] } }[];
  }[],
  detected: HostConnector[],
): MissingConnector[] {
  const known = new Set(
    detected.flatMap((c) => (c.rule === undefined ? [] : [mcpServer(c.rule) ?? ''])),
  );
  const found = new Map<string, Set<string>>();
  for (const workflow of workflows)
    for (const node of workflow.nodes) {
      if (node.type !== 'agent') continue;
      for (const rule of node.config.requiredTools ?? []) {
        const server = mcpServer(rule);
        if (server === null || known.has(server) || server === 'claude-in-chrome')
          continue;
        found.set(server, (found.get(server) ?? new Set()).add(workflow.name));
      }
    }
  return [...found.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([server, names]) => {
      const best = [...known]
        .map((candidate) => ({ candidate, score: similarity(server, candidate) }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))[0];
      return {
        server,
        workflows: [...names].sort(),
        ...(best === undefined ? {} : { suggestion: best.candidate }),
      };
    });
}

/** Demo data for the browser mock (`pnpm dev`), shaped like a real detection. */
export function mockHostAbilities(adapter: 'claude' | 'codex'): HostAbilities {
  const detectedAt = new Date().toISOString();
  if (adapter === 'claude')
    return {
      adapter,
      installed: true,
      connectors: [
        {
          name: 'claude.ai Atlassian Rovo',
          rule: 'mcp__claude_ai_Atlassian_Rovo',
          status: 'connected',
          scope: 'account',
          target: 'https://mcp.atlassian.com/v1/mcp',
        },
        {
          name: 'claude.ai Gmail',
          rule: 'mcp__claude_ai_Gmail',
          status: 'connected',
          scope: 'account',
          target: 'https://gmailmcp.googleapis.com/mcp/v1',
        },
        {
          name: 'claude.ai Sentry',
          rule: 'mcp__claude_ai_Sentry',
          status: 'needsAuth',
          scope: 'account',
          target: 'https://mcp.sentry.dev/mcp',
        },
        {
          name: 'aws-mcp',
          rule: 'mcp__aws-mcp',
          status: 'connected',
          scope: 'local',
          target: 'uvx mcp-proxy-for-aws@latest https://aws-mcp.us-east-1.api.aws/mcp',
        },
      ],
      connectorsNote: 'Demo data: the browser preview cannot run claude mcp list.',
      browser: {
        available: true,
        switchable: true,
        detail: 'Claude in Chrome is set up for Google Chrome.',
      },
      skills: ['code-review', 'deep-research'],
      plugins: [],
      instructions: ['~/.claude/CLAUDE.md'],
      allowedInSettings: ['mcp__claude_ai_Atlassian_Rovo'],
      detectedAt,
    };
  return {
    adapter,
    installed: true,
    connectors: [
      {
        name: 'aws-mcp',
        status: 'enabled',
        scope: 'local',
        target: 'uvx mcp-proxy-for-aws@latest https://aws-mcp.us-east-1.api.aws/mcp',
      },
    ],
    connectorsNote: 'Demo data: the browser preview cannot run codex mcp list.',
    browser: {
      available: true,
      switchable: false,
      detail: 'Codex’s chrome plugin is on; Codex decides when to use it.',
    },
    skills: [],
    plugins: ['chrome', 'gmail'],
    instructions: ['~/.codex/AGENTS.md'],
    allowedInSettings: [],
    detectedAt,
  };
}
