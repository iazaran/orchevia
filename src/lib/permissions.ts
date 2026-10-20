/**
 * Agent tool permissions (TypeScript mirror of `orchevia-core`
 * `permissions.rs`): allow-rule validation, refused tool calls recorded on a
 * node result, and helpers that add rules to a Claude Code profile.
 */
import type { AgentProfile } from './agents';
import type { Workflow } from './workflow';

/** At most this many allow rules per profile or node declaration. */
export const MAX_TOOL_RULES = 64;
const MAX_RULE_CHARS = 256;

/** One refused tool call, as recorded in a node's structured result. */
export interface PermissionDenial {
  toolName: string;
  toolUseId?: string;
  detail?: string;
  rules: string[];
}

/** `permissionDenied` metadata written by the engine for a refused node. */
export interface PermissionDenied {
  profileId?: string;
  denials: PermissionDenial[];
  rules: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Read the refused tool calls from a node result's structured JSON. */
export function permissionDeniedFrom(structuredJson?: string): PermissionDenied | null {
  if (structuredJson === undefined || structuredJson === '') return null;
  let data: unknown;
  try {
    data = JSON.parse(structuredJson);
  } catch {
    return null;
  }
  if (!isRecord(data) || !isRecord(data.permissionDenied)) return null;
  const record = data.permissionDenied;
  const denials: PermissionDenial[] = [];
  for (const item of Array.isArray(record.denials) ? (record.denials as unknown[]) : []) {
    if (!isRecord(item) || typeof item.toolName !== 'string') continue;
    const denial: PermissionDenial = {
      toolName: item.toolName,
      rules: strings(item.rules),
    };
    if (typeof item.toolUseId === 'string') denial.toolUseId = item.toolUseId;
    if (typeof item.detail === 'string') denial.detail = item.detail;
    denials.push(denial);
  }
  const rules = strings(record.rules);
  if (denials.length === 0 && rules.length === 0) return null;
  const result: PermissionDenied = { denials, rules };
  if (typeof record.profileId === 'string') result.profileId = record.profileId;
  return result;
}

/**
 * Mirror of Rust `validate_tool_rule`: a tool name (`Edit`, `mcp__server`,
 * `mcp__server__tool`) with an optional `(specifier)`, e.g. `Bash(git *)`.
 * Returns the error message, or `null` when valid.
 */
export function validateToolRule(rule: string): string | null {
  const invalid = `Invalid allowed tool '${rule}'. Use a tool name such as Edit, mcp__server, or Bash(git *).`;
  if (rule === '' || rule.trim() !== rule || Array.from(rule).length > MAX_RULE_CHARS)
    return invalid;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(rule)) return invalid;
  const lower = rule.toLowerCase();
  for (const marker of [
    'api-key',
    'apikey',
    'auth-token',
    'access-token',
    'bearer',
    'password',
    'secret',
  ]) {
    if (lower.includes(marker))
      return `Allowed tool '${rule}' looks like it carries a credential and is not allowed.`;
  }
  const open = rule.indexOf('(');
  let name = rule;
  if (open !== -1) {
    name = rule.slice(0, open);
    const rest = rule.slice(open + 1);
    if (!rest.endsWith(')')) return invalid;
    const inner = rest.slice(0, -1);
    if (inner.trim() === '' || /[,()]/.test(inner)) return invalid;
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) return invalid;
  return null;
}

/** Mirror of Rust `validate_tool_rules`: count, each rule, duplicates. */
export function validateToolRules(rules: string[], what: string): string[] {
  const errors: string[] = [];
  if (rules.length > MAX_TOOL_RULES)
    errors.push(`${what} can list at most ${String(MAX_TOOL_RULES)} tools.`);
  const seen = new Set<string>();
  for (const rule of rules) {
    const error = validateToolRule(rule);
    if (error !== null) errors.push(error);
    else if (seen.has(rule)) errors.push(`Duplicate allowed tool '${rule}'.`);
    else seen.add(rule);
  }
  return errors;
}

/**
 * Whether an allow rule admits another: equal rules; a bare tool name admits
 * any specifier of that tool (`Bash` admits `Bash(git *)`); an MCP server rule
 * admits its tools (`mcp__jira` admits `mcp__jira__getIssue`); a prefix rule
 * admits narrower prefixes (`Bash(git *)` admits `Bash(git status *)`).
 */
export function ruleCovers(granted: string, required: string): boolean {
  if (granted === required) return true;
  const grantedOpen = granted.indexOf('(');
  const requiredOpen = required.indexOf('(');
  const requiredName = requiredOpen === -1 ? required : required.slice(0, requiredOpen);
  if (grantedOpen === -1) {
    if (granted === requiredName) return true;
    return granted.startsWith('mcp__') && requiredName.startsWith(`${granted}__`);
  }
  if (requiredOpen === -1 || granted.slice(0, grantedOpen) !== requiredName) return false;
  const spec = granted.slice(grantedOpen + 1, -1);
  const wanted = required.slice(requiredOpen + 1, -1);
  const prefix = spec.endsWith(' *')
    ? spec.slice(0, -2)
    : spec.endsWith(':*')
      ? spec.slice(0, -2)
      : null;
  if (prefix === null) return false;
  const rest = wanted.slice(prefix.length);
  return (
    wanted.startsWith(prefix) &&
    (rest === '' || rest.startsWith(' ') || rest.startsWith(':'))
  );
}

/** Whether a profile already admits a rule through its own permission setting. */
export function profileGrants(profile: AgentProfile, rule: string): boolean {
  const level = profile.permissionLevel ?? 'cliSettings';
  if (level === 'fullAccess') return true;
  if (level !== 'allowedTools') return false;
  return (profile.allowedTools ?? []).some((granted) => ruleCovers(granted, rule));
}

/**
 * The profile with `rules` added to its allowed tools, switching a profile
 * that uses the Claude Code settings to the Allowed tools level (those
 * settings still apply on top). Returns `null` when nothing would change or
 * the profile cannot take an allow list (Codex, custom CLIs).
 */
export function withAllowedTools(
  profile: AgentProfile,
  rules: string[],
): AgentProfile | null {
  if (profile.adapter !== 'claude') return null;
  const missing = [...new Set(rules)].filter((rule) => !profileGrants(profile, rule));
  if (missing.length === 0) return null;
  const existing = profile.allowedTools ?? [];
  return {
    ...profile,
    permissionLevel: 'allowedTools',
    allowedTools: [...existing, ...missing.filter((rule) => !existing.includes(rule))],
  };
}

/** Declared tools one profile does not grant, and the nodes that need them. */
export interface MissingToolGrant {
  profile: AgentProfile;
  rules: string[];
  nodes: string[];
}

/**
 * The tools a workflow's Agent nodes declare (`requiredTools`) that their
 * chosen Claude Code profile does not grant itself. A node naming only a role
 * uses `roleMap` (role → profile id), as template instantiation does. Codex
 * and custom profiles have no allow list and are not checked. A profile at
 * the Claude Code settings level may still allow a listed tool through those
 * settings, which Orchevia does not read.
 */
export function missingToolGrants(
  workflow: Workflow,
  profiles: AgentProfile[],
  roleMap: Record<string, string> = {},
): MissingToolGrant[] {
  const grants = new Map<string, MissingToolGrant>();
  for (const node of workflow.nodes) {
    const required = node.config.requiredTools ?? [];
    if (node.type !== 'agent' || required.length === 0) continue;
    const explicit = (node.config.agentProfileId ?? '').trim();
    const role = node.config.agentRole;
    const id =
      explicit !== ''
        ? explicit
        : role !== undefined && Object.hasOwn(roleMap, role)
          ? roleMap[role]
          : undefined;
    const profile = profiles.find((p) => p.id === id);
    if (profile?.adapter !== 'claude') continue;
    const missing = required.filter((rule) => !profileGrants(profile, rule));
    if (missing.length === 0) continue;
    const grant = grants.get(profile.id) ?? { profile, rules: [], nodes: [] };
    for (const rule of missing) if (!grant.rules.includes(rule)) grant.rules.push(rule);
    grant.nodes.push(node.label ?? node.id);
    grants.set(profile.id, grant);
  }
  return [...grants.values()];
}
