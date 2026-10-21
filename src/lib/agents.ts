/**
 * Agent Profiles + prompt composition (TypeScript mirror of `orchevia-core`
 * `agents.rs` / `prompt.rs`).
 *
 * Keep the adapter contract in sync with the Rust backend: the engine builds
 * the actual argv; this module mirrors validation, previews, and prompt
 * templating for a responsive UI.
 */
import { MAX_TIMEOUT_SECS, type StoredNodeResult } from './workflow';
import { validateToolRules } from './permissions';

export type AdapterKind = 'claude' | 'codex' | 'custom';
export type WorkingDirMode = 'node' | 'profile' | 'inherit';

export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh';

export const EFFORT_LEVELS: AgentEffort[] = ['low', 'medium', 'high', 'xhigh'];

/**
 * What a profile's CLI may do without asking (Rust `PermissionLevel`). Passed
 * only as CLI flags; Orchevia never writes Claude Code or Codex settings files.
 * Absent means `appDefault`: the app-wide agent permission setting, which is
 * the CLI's own settings until the user chooses (see `withAppDefault`).
 */
export type PermissionLevel =
  'appDefault' | 'cliSettings' | 'allowedTools' | 'fullAccess';

/** The levels that can apply to every profile (Rust `parse_permission_default`). */
export type AppPermissionDefault = 'cliSettings' | 'fullAccess';

/** Settings key of the app-wide level (Rust `PERMISSION_DEFAULT_SETTING`). */
export const PERMISSION_DEFAULT_SETTING = 'agents.permissionDefault';

/** Mirror of Rust `parse_permission_default`. */
export function parsePermissionDefault(value: string): AppPermissionDefault {
  if (value === 'cliSettings' || value === 'fullAccess') return value;
  throw new Error('Agent permissions must be cliSettings or fullAccess.');
}

/** A stored app-wide level, or `null` while the user has not chosen one. */
export function readPermissionDefault(value: string | null): AppPermissionDefault | null {
  return value === 'cliSettings' || value === 'fullAccess' ? value : null;
}

/** Levels each adapter can express: Codex has no tool allow-list. */
export function permissionLevels(adapter: AdapterKind): PermissionLevel[] {
  if (adapter === 'claude')
    return ['appDefault', 'cliSettings', 'allowedTools', 'fullAccess'];
  if (adapter === 'codex') return ['appDefault', 'cliSettings', 'fullAccess'];
  return ['appDefault'];
}

/** Label of the app-wide level, `null` meaning not chosen yet. */
export function permissionDefaultLabel(appDefault: AppPermissionDefault | null): string {
  if (appDefault === 'fullAccess') return 'Full access';
  return appDefault === null ? 'CLI settings, not chosen yet' : 'CLI settings';
}

export function permissionLevelLabel(
  adapter: AdapterKind,
  level: PermissionLevel | undefined,
  appDefault: AppPermissionDefault | null = null,
): string {
  switch (level ?? 'appDefault') {
    case 'appDefault':
      return `App default (${permissionDefaultLabel(appDefault)})`;
    case 'allowedTools':
      return 'Allowed tools';
    case 'fullAccess':
      return 'Full access';
    default:
      return adapter === 'codex' ? 'Use Codex settings' : 'Use Claude Code settings';
  }
}

/** Mirror of Rust `permission_flags`: extra arguments that set permissions. */
function permissionFlags(adapter: AdapterKind): string[] {
  if (adapter === 'claude')
    return [
      '--permission-mode',
      '--allowedTools',
      '--allowed-tools',
      '--dangerously-skip-permissions',
      '--allow-dangerously-skip-permissions',
    ];
  if (adapter === 'codex')
    return [
      '--sandbox',
      '-s',
      '--dangerously-bypass-approvals-and-sandbox',
      '--yolo',
      '--full-auto',
      '--approve-for-me',
    ];
  return [];
}

/** The profile's first extra argument that sets permissions itself, if any. */
export function permissionArgument(profile: AgentProfile): string | null {
  const flags = permissionFlags(profile.adapter);
  return (
    profile.extraArgs.find((arg) =>
      flags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
    ) ?? null
  );
}

/**
 * Mirror of Rust `AgentProfile::with_app_default`: the profile as a run uses
 * it, with `appDefault` replaced by the app-wide level. A Custom CLI, or a
 * profile whose extra arguments set permissions themselves, keeps its own
 * behaviour (CLI settings: no flag added).
 */
export function withAppDefault(
  profile: AgentProfile,
  appDefault: AppPermissionDefault | null,
): AgentProfile {
  if ((profile.permissionLevel ?? 'appDefault') !== 'appDefault') return profile;
  const full =
    appDefault === 'fullAccess' &&
    profile.adapter !== 'custom' &&
    permissionArgument(profile) === null;
  return { ...profile, permissionLevel: full ? 'fullAccess' : 'cliSettings' };
}

/**
 * Mirror of Rust `push_permissions`: the argv for the profile's level. Pass a
 * profile resolved with `withAppDefault`; an unresolved app default adds no
 * flag.
 */
export function permissionArgs(profile: AgentProfile): string[] {
  const level = profile.permissionLevel ?? 'appDefault';
  if (profile.adapter === 'claude' && level === 'allowedTools')
    return ['--allowedTools', (profile.allowedTools ?? []).join(',')];
  if (profile.adapter === 'claude' && level === 'fullAccess')
    return ['--permission-mode', 'bypassPermissions'];
  if (profile.adapter === 'codex' && level === 'fullAccess')
    return ['--dangerously-bypass-approvals-and-sandbox'];
  return [];
}

/**
 * Mirror of Rust `AgentProfile::has_full_access`. Pass a profile resolved with
 * `withAppDefault`.
 */
export function hasFullAccess(profile: AgentProfile): boolean {
  if (profile.permissionLevel === 'fullAccess') return true;
  const args = profile.extraArgs;
  return args.some((arg, index) => {
    const next = args[index + 1];
    if (profile.adapter === 'claude')
      return (
        arg === '--dangerously-skip-permissions' ||
        arg === '--permission-mode=bypassPermissions' ||
        (arg === '--permission-mode' && next === 'bypassPermissions')
      );
    if (profile.adapter === 'codex')
      return (
        [
          '--dangerously-bypass-approvals-and-sandbox',
          '--yolo',
          '--sandbox=danger-full-access',
          '-sdanger-full-access',
        ].includes(arg) ||
        ((arg === '--sandbox' || arg === '-s') && next === 'danger-full-access')
      );
    return false;
  });
}

/**
 * Model name suggestions per adapter. These are conveniences for a free-form
 * field — model names evolve faster than releases, so anything the CLI itself
 * accepts can be typed (aliases like `opus` keep working; pinned versions
 * select an exact model). Only list names verified against a real CLI;
 * anything else belongs in the free-form field, not here. When in doubt check
 * the CLI itself (`claude --help`, `codex --help`).
 */
export const MODEL_PRESETS: Record<AdapterKind, string[]> = {
  claude: ['opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5-5', 'claude-fable-5-1'],
  codex: ['gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5-mini', 'gpt-6-astra'],
  custom: [],
};

/**
 * Suggestion list for the model field: built-in presets first, then
 * user-taught names not already covered (case-insensitive dedup).
 */
export function mergeModelSuggestions(presets: string[], custom: string[]): string[] {
  const seen = new Set(presets.map((p) => p.toLowerCase()));
  const out = [...presets];
  for (const name of custom) {
    const trimmed = name.trim();
    if (trimmed !== '' && !seen.has(trimmed.toLowerCase())) {
      seen.add(trimmed.toLowerCase());
      out.push(trimmed);
    }
  }
  return out;
}

export const ADAPTER_LABELS: Record<AdapterKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  custom: 'Custom CLI',
};

export interface AgentProfile {
  id: string;
  name: string;
  adapter: AdapterKind;
  executable?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  extraArgs: string[];
  skills?: string[];
  workingDirMode: WorkingDirMode;
  workingDir?: string | undefined;
  defaultTimeoutSecs: number;
  role?: string | undefined;
  /** Absent reads as `appDefault` (the app-wide agent permission setting). */
  permissionLevel?: PermissionLevel | undefined;
  /** Claude Code allow rules, used at the `allowedTools` level. */
  allowedTools?: string[] | undefined;
}

export interface AdapterInfo {
  id: AdapterKind;
  displayName: string;
  defaultExecutable: string;
  supportsModelFlag: boolean;
  supportsSessionResume: boolean;
  notes: string;
}

export interface AgentSkillInfo {
  name: string;
  description: string;
  source: string;
}

/** Invoke selected skills using the syntax understood by the chosen CLI. */
export function composeSkillPrompt(profile: AgentProfile, prompt: string): string {
  const skills = profile.skills ?? [];
  if (skills.length === 0) return prompt;
  const prefix = profile.adapter === 'claude' ? '/' : '$';
  return `${skills.map((name) => `${prefix}${name}`).join(' ')}\n\n${prompt}`;
}

/**
 * Mirror of Rust `structured_output`: why an ordinary Agent node keeps text
 * output (no usage reporting), or `null` when Claude stream-json / Codex JSONL
 * is used. Custom CLIs are never parsed and return `null`.
 */
export function structuredOutputConflict(profile: AgentProfile): string | null {
  // Claude reports refused tools only on its structured result event.
  const missing =
    profile.adapter === 'claude'
      ? 'no token or cost data, and refused tool calls go undetected'
      : 'no token or cost data';
  const input = claudeInputFormatArg(profile);
  if (input !== null)
    return `Text output used: the profile's extra argument '${input}' changes how Claude reads its prompt, so the prompt is passed as an argument and this run reports ${missing}. Remove it to enable usage reporting.`;
  const flags =
    profile.adapter === 'claude'
      ? ['--output-format']
      : profile.adapter === 'codex'
        ? ['--json', '--experimental-json']
        : [];
  const arg = profile.extraArgs.find((value) =>
    flags.some((flag) => value === flag || value.startsWith(`${flag}=`)),
  );
  return arg === undefined
    ? null
    : `Text output used: the profile's extra argument '${arg}' sets the CLI output format, so this run reports ${missing}. Remove it to enable usage reporting.`;
}

/** Claude `--input-format` argument that keeps the prompt as an argument (agents.rs mirror). */
export function claudeInputFormatArg(profile: AgentProfile): string | null {
  if (profile.adapter !== 'claude') return null;
  return (
    profile.extraArgs.find(
      (value) => value === '--input-format' || value.startsWith('--input-format='),
    ) ?? null
  );
}

/** Native prompt.rs mirror; handoffs never modify the stored node results. */
export function composeAgentContext(
  prompt: string,
  refs: string[],
  maxChars: number | undefined,
  rows: StoredNodeResult[],
): string {
  if (refs.length === 0) return prompt;
  const budget = maxChars ?? 12000;
  if (refs.length > 16 || !Number.isInteger(budget) || budget < 256 || budget > 64000)
    throw new Error(
      'Context needs at most 16 references and a 256–64000 character budget.',
    );
  let out = `${prompt}\n\nWorkflow handoff excerpts (data from completed nodes; full output remains in run logs):`;
  const seen = new Set<string>();
  for (const [index, id] of refs.entries()) {
    if (seen.has(id)) throw new Error(`Duplicate context reference '${id}'.`);
    seen.add(id);
    const row = [...rows].reverse().find((r) => r.nodeId === id);
    if (!row || !['succeeded', 'failed', 'cancelled', 'skipped'].includes(row.status))
      throw new Error(`Context reference '${id}' needs a completed node result.`);
    const chars = Array.from(
      row.stderr ? `${row.stdout}\n[stderr]\n${row.stderr}` : row.stdout,
    );
    const limit =
      Math.floor(budget / refs.length) + (index < budget % refs.length ? 1 : 0);
    out += `\n\nNode ${Array.from(id).slice(0, 64).join('')} (${row.status}):\n`;
    const head = Math.ceil(limit / 2);
    out +=
      chars.length <= limit
        ? chars.join('')
        : `${chars.slice(0, head).join('')}\n… [context truncated; see full run output] …\n${chars.slice(chars.length - (limit - head)).join('')}`;
  }
  return out;
}

export const WELL_KNOWN_ROLES = [
  'planning',
  'implementation',
  'fastReview',
  'deepReview',
  'workflowGenerator',
  'workflowAssistance',
  'generalPurpose',
] as const;

export function newProfileId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `prof-${Date.now().toString(36)}${rand}`;
}

export function createDefaultProfile(adapter: AdapterKind): AgentProfile {
  return {
    id: newProfileId(),
    name:
      adapter === 'claude'
        ? 'Claude — Implementation'
        : adapter === 'codex'
          ? 'Codex — Deep Review'
          : 'Custom CLI',
    adapter,
    extraArgs: [],
    skills: [],
    workingDirMode: 'node',
    defaultTimeoutSecs: 3600,
    role:
      adapter === 'claude'
        ? 'implementation'
        : adapter === 'codex'
          ? 'deepReview'
          : undefined,
  };
}

/** User-editable recommendations; existing adapter/role choices are never replaced. */
export function recommendedProfiles(existing: AgentProfile[]): AgentProfile[] {
  const recommendations: {
    adapter: AdapterKind;
    role: string;
    label: string;
    model: string;
    effort?: string;
    name?: string;
  }[] = [
    { adapter: 'claude', role: 'implementation', label: 'Implementation', model: 'opus' },
    { adapter: 'claude', role: 'fastReview', label: 'Fast review', model: 'opus' },
    { adapter: 'claude', role: 'planning', label: 'Planning', model: 'fable' },
    {
      adapter: 'claude',
      role: 'workflowGenerator',
      label: 'Workflow generator',
      model: 'fable',
    },
    { adapter: 'claude', role: 'deepReview', label: 'Deep review', model: 'fable' },
    {
      adapter: 'claude',
      role: 'workflowAssistance',
      label: 'Workflow assistance',
      model: 'fable',
    },
    { adapter: 'codex', role: 'deepReview', label: 'Deep review', model: 'gpt-6.1-sol' },
    {
      adapter: 'claude',
      role: 'generalPurpose',
      label: 'General purpose',
      name: 'Claude — General purpose',
      model: 'opus',
      effort: 'medium',
    },
  ];
  return recommendations
    .filter(
      (r) =>
        !existing.some(
          (p) =>
            (p.adapter === r.adapter && p.role === r.role) ||
            (r.name !== undefined && p.name === r.name),
        ),
    )
    .map((r) => ({
      ...createDefaultProfile(r.adapter),
      name: r.name ?? `${ADAPTER_LABELS[r.adapter]} — ${r.label}`,
      role: r.role,
      model: r.model,
      effort: r.effort ?? 'high',
    }));
}

/** Mirror of the Rust profile validation. Returns error strings. */
export function validateProfile(profile: AgentProfile): string[] {
  const errors: string[] = [];
  if (profile.name.trim() === '') errors.push('Profile name must not be empty.');
  if (profile.id.trim() === '') errors.push('Profile id must not be empty.');
  if (
    !Number.isInteger(profile.defaultTimeoutSecs) ||
    profile.defaultTimeoutSecs < 1 ||
    profile.defaultTimeoutSecs > MAX_TIMEOUT_SECS
  ) {
    errors.push(
      `Default timeout must be between 1 second and 12 hours (${String(MAX_TIMEOUT_SECS)}).`,
    );
  }
  for (const arg of profile.extraArgs) {
    const lower = arg.toLowerCase();
    for (const forbidden of [
      'api-key',
      'apikey',
      'auth-token',
      'access-token',
      'bearer',
      'password',
      'secret',
    ]) {
      if (lower.includes(forbidden)) {
        errors.push(
          `Extra argument '${arg}' looks like a credential flag and is not allowed.`,
        );
        break;
      }
    }
    if (arg.includes('\0') || arg.includes('\n')) {
      errors.push(`Extra argument '${arg}' contains invalid characters.`);
    }
  }
  const skills = profile.skills ?? [];
  if (profile.adapter === 'custom' && skills.length > 0)
    errors.push('Skills are supported only for Claude Code and Codex profiles.');
  if (skills.length > 8) errors.push('Select at most 8 skills per profile.');
  const seenSkills = new Set<string>();
  for (const skill of skills) {
    if (skill.length > 100 || !/^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*$/.test(skill)) {
      errors.push(
        `Invalid skill name '${skill}'. Use letters, numbers, - or _, with optional namespace:name.`,
      );
    } else if (seenSkills.has(skill.toLowerCase())) {
      errors.push(`Duplicate skill name '${skill}'.`);
    } else {
      seenSkills.add(skill.toLowerCase());
    }
  }
  if (profile.adapter === 'custom' && (profile.executable ?? '').trim() === '') {
    errors.push('Custom CLI profiles need an explicit executable path.');
  }
  if (profile.workingDirMode === 'profile' && (profile.workingDir ?? '').trim() === '') {
    errors.push('Profile working directory mode requires a directory.');
  }
  if (profile.model !== undefined) {
    if (profile.model.trim() === '') errors.push('Model must not be blank when set.');
    if (profile.model.length > 120)
      errors.push('Model value is too long (max 120 chars).');
  }
  const allowedTools = profile.allowedTools ?? [];
  if (profile.adapter !== 'claude' && allowedTools.length > 0)
    errors.push('Allowed tools apply only to Claude Code profiles.');
  errors.push(...validateToolRules(allowedTools, 'Allowed tools'));
  const level = profile.permissionLevel ?? 'appDefault';
  if (level !== 'cliSettings' && level !== 'appDefault') {
    if (profile.adapter === 'custom')
      errors.push('Permission levels apply only to Claude Code and Codex profiles.');
    else if (profile.adapter === 'codex' && level === 'allowedTools')
      errors.push('Codex has no tool allow-list. Use Codex settings or Full access.');
    else if (level === 'allowedTools' && allowedTools.length === 0)
      errors.push('Allowed tools needs at least one tool.');
    const conflict = permissionArgument(profile);
    if (conflict !== null)
      errors.push(
        `Extra argument '${conflict}' conflicts with the profile's permission setting. Remove it or use the CLI settings level.`,
      );
  }
  if (profile.effort !== undefined) {
    const trimmed = profile.effort.trim().toLowerCase();
    if (trimmed === '') errors.push('Effort must not be blank when set.');
    else if (!EFFORT_LEVELS.includes(trimmed as AgentEffort))
      errors.push('Effort must be one of: low, medium, high, xhigh.');
  }
  return errors;
}

export function effortLabel(profile: Pick<AgentProfile, 'effort'>): string {
  const trimmed = (profile.effort ?? '').trim().toLowerCase();
  return trimmed === '' ? 'default' : trimmed;
}

export function effectiveExecutable(profile: AgentProfile): string {
  const explicit = (profile.executable ?? '').trim();
  if (explicit !== '') return explicit;
  return profile.adapter === 'claude' ? 'claude' : 'codex';
}

// -- Prompt templating --------------------------------------------------------

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g;
const ESCAPED_OPEN = /\\\{\{/g;

export function referencedVariables(template: string): string[] {
  const names = new Set<string>();
  // Strip escaped openers so `\{{x}}` is not collected.
  const scrubbed = template.replace(ESCAPED_OPEN, '');
  for (const match of scrubbed.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return [...names].sort();
}

export function renderPromptLenient(
  template: string,
  vars: Record<string, string>,
): string {
  const { rendered } = renderPrompt(template, vars);
  return rendered;
}

export function renderPromptStrict(
  template: string,
  vars: Record<string, string>,
): { rendered: string } | { error: string; missing: string[] } {
  const { rendered, missing } = renderPrompt(template, vars);
  if (missing.length > 0) {
    return { error: `Missing variables: ${missing.join(', ')}`, missing };
  }
  return { rendered };
}

function renderPrompt(
  template: string,
  vars: Record<string, string>,
): { rendered: string; missing: string[] } {
  const missing = new Set<string>();
  // Protect escaped openers with a sentinel.
  const SENTINEL = '\u0000ORCHEVIA_ESCAPED_OPEN\u0000';
  const protectedStr = template.replace(ESCAPED_OPEN, SENTINEL);
  const rendered = protectedStr.replace(PLACEHOLDER, (full, name: string) => {
    if (Object.hasOwn(vars, name)) return vars[name] ?? '';
    missing.add(name);
    return full;
  });
  return {
    rendered: rendered.replaceAll(SENTINEL, '{{'),
    missing: [...missing].sort(),
  };
}

/** Managed nodes own these arguments; mirror the core adapter restrictions. */
export function validateSessionProfile(profile: AgentProfile): string[] {
  if (profile.adapter === 'custom')
    return ['Custom CLI profiles do not support session groups.'];
  const flags =
    profile.adapter === 'claude'
      ? [
          '--from-pr',
          '--teleport',
          '--resume',
          '-r',
          '--continue',
          '-c',
          '--session-id',
          '--fork-session',
          '--no-session-persistence',
          '--output-format',
          '--input-format',
          '--include-partial-messages',
          '--forward-subagent-text',
          '--worktree',
          '-w',
          '--cloud',
          '--remote',
        ]
      : [
          'resume',
          'fork',
          'review',
          '--last',
          '--ephemeral',
          '--json',
          '--experimental-json',
          '--output-last-message',
          '-o',
          '--output-schema',
          '--cd',
          '-C',
          '--worktree',
        ];
  return profile.extraArgs
    .filter((arg) =>
      flags.some(
        (flag) =>
          arg === flag ||
          arg.startsWith(`${flag}=`) ||
          (flag.length === 2 && flag.startsWith('-') && arg.startsWith(flag)),
      ),
    )
    .map(
      (arg) =>
        `Extra argument '${arg}' conflicts with managed session groups. Remove it or use a fresh-session node.`,
    );
}
