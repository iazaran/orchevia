/**
 * Agent Profiles + prompt composition (TypeScript mirror of `orchevia-core`
 * `agents.rs` / `prompt.rs`).
 *
 * Keep the adapter contract in sync with the Rust backend: the engine builds
 * the actual argv; this module mirrors validation, previews, and prompt
 * templating for a responsive UI.
 */
import { MAX_TIMEOUT_SECS } from './workflow';

export type AdapterKind = 'claude' | 'codex' | 'custom';
export type WorkingDirMode = 'node' | 'profile' | 'inherit';

export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh';

export const EFFORT_LEVELS: AgentEffort[] = ['low', 'medium', 'high', 'xhigh'];

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

export const WELL_KNOWN_ROLES = [
  'planning',
  'implementation',
  'fastReview',
  'deepReview',
  'workflowGenerator',
  'workflowAssistance',
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
  ];
  return recommendations
    .filter((r) => !existing.some((p) => p.adapter === r.adapter && p.role === r.role))
    .map((r) => ({
      ...createDefaultProfile(r.adapter),
      name: `${ADAPTER_LABELS[r.adapter]} — ${r.label}`,
      role: r.role,
      model: r.model,
      effort: 'high',
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
