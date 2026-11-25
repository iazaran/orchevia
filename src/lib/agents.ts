/**
 * Agent Profiles + prompt composition (TypeScript mirror of `orchevia-core`
 * `agents.rs` / `prompt.rs`).
 *
 * Keep the adapter contract in sync with the Rust backend: the engine builds
 * the actual argv; this module mirrors validation, previews, and prompt
 * templating for a responsive UI.
 */
import { MAX_TIMEOUT_SECS, type StoredNodeResult, type Workflow } from './workflow';
import { validateToolRules } from './permissions';
import {
  BROWSER_FLAG,
  BROWSER_TOOL_RULE,
  NO_BROWSER_FLAG,
  type AppAbilities,
} from './abilities';

export const ADAPTERS = {
  claude: {
    name: 'Claude Code',
    executable: 'claude',
    notes: 'Streams tokens and reported USD through Claude Code. Prompt on stdin.',
  },
  codex: {
    name: 'Codex',
    executable: 'codex',
    notes: 'Streams tokens through Codex. Prompt on stdin.',
  },
  muse: {
    name: 'Muse Code',
    executable: 'muse',
    notes: "Runs muse exec with Muse Code's permission settings.",
  },
  antigravity: {
    name: 'Google Antigravity CLI',
    executable: 'agy',
    notes: 'Runs agy in print mode using your Google sign-in and CLI settings.',
  },
  gemini: {
    name: 'Gemini CLI',
    executable: 'gemini',
    notes:
      'Runs Gemini CLI headlessly. Requires a supported enterprise or API-key setup.',
  },
  opencode: {
    name: 'OpenCode',
    executable: 'opencode',
    notes: 'Runs opencode run with your connected provider and CLI settings.',
  },
  custom: {
    name: 'Custom CLI',
    executable: '',
    notes: 'Your own coding CLI. Set the full binary path; prompt goes last.',
  },
} as const;

export type AdapterKind = keyof typeof ADAPTERS;
export const ADAPTER_KINDS = Object.keys(ADAPTERS) as AdapterKind[];
export const BUILTIN_ADAPTERS = ADAPTER_KINDS.filter((id) => id !== 'custom');

export function supportsProfileControls(adapter: AdapterKind): boolean {
  return adapter === 'claude' || adapter === 'codex';
}

/** Mirror of use_supported_sessions. Call on a newly created workflow. */
export function applySupportedSessions(
  workflow: Workflow,
  profiles: AgentProfile[],
): string[] {
  const changed: string[] = [];
  for (const node of workflow.nodes) {
    if (node.type !== 'agent' || node.config.sessionGroup === undefined) continue;
    const profile = profiles.find((item) => item.id === node.config.agentProfileId);
    if (profile === undefined || supportsProfileControls(profile.adapter)) continue;
    delete node.config.sessionGroup;
    delete node.config.sessionMaxTurns;
    changed.push(node.label ?? node.id);
  }
  return changed;
}
export function supportsEffort(adapter: AdapterKind): boolean {
  return supportsProfileControls(adapter) || adapter === 'antigravity';
}

export const AGENT_SETUP_GUIDE =
  'https://github.com/iazaran/orchevia/blob/main/docs/agents.md#supported-clis';

export const AGENT_SIGN_IN: Record<Exclude<AdapterKind, 'custom'>, string> = {
  claude: 'Open `claude` and complete sign-in.',
  codex: 'Run `codex login` in a terminal.',
  muse: 'Open `muse` and complete Meta sign-in.',
  antigravity: 'Open `agy` and complete Google sign-in for Gemini.',
  gemini:
    'Use a supported enterprise or API-key setup, and trust the repository folder in gemini once (headless runs stop in untrusted folders). For individual Google sign-in, use Antigravity CLI.',
  opencode: 'Open `opencode` and use `/connect` to configure a model provider.',
};
/** How to install each built-in CLI (checked against vendor docs, Nov 2026). */
export const AGENT_INSTALL: Record<Exclude<AdapterKind, 'custom'>, string> = {
  claude: 'curl -fsSL https://claude.ai/install.sh | bash',
  codex: 'npm install -g @openai/codex',
  muse: 'curl -fsSL https://dev.meta.ai/install.sh | bash',
  antigravity: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  gemini: 'npm install -g @google/gemini-cli',
  opencode: 'npm install -g opencode-ai',
};

/**
 * More coding CLIs that run through the Custom CLI contract (extra arguments,
 * then the prompt as the last argument). Each one prefills a Custom profile
 * the user reviews before saving.
 */
export interface CustomCliPreset {
  id: string;
  name: string;
  executable: string;
  extraArgs: string[];
  install: string;
  /** What the preset does and anything to know before the first run. */
  notes: string;
}

export const CUSTOM_CLI_PRESETS: CustomCliPreset[] = [
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    executable: 'copilot',
    extraArgs: ['-s', '-p'],
    install: 'npm install -g @github/copilot',
    notes:
      'Runs copilot -p and prints only the answer. Sign in with copilot first. Add --allow-all-tools to let it edit and run commands without asking.',
  },
  {
    id: 'cursor',
    name: 'Cursor CLI',
    executable: 'agent',
    extraArgs: ['-p', '--output-format', 'text'],
    install: 'curl https://cursor.com/install -fsS | bash',
    notes:
      'Runs the Cursor agent in print mode, which can edit files. Sign in with agent login first. Older installs name the program cursor-agent.',
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    executable: 'qwen',
    extraArgs: ['-p'],
    install: 'npm install -g @qwen-code/qwen-code',
    notes:
      'Runs qwen -p headlessly. Sign in or set a provider key in Qwen Code first. Add --approval-mode yolo to let it act without asking.',
  },
  {
    id: 'amp',
    name: 'Amp',
    executable: 'amp',
    extraArgs: ['-x'],
    install: 'curl -fsSL https://ampcode.com/install.sh | bash',
    notes: 'Runs amp in execute mode. Sign in with amp login first.',
  },
  {
    id: 'aider',
    name: 'Aider',
    executable: 'aider',
    extraArgs: ['--no-auto-commits', '--yes-always', '--message'],
    install: 'python -m pip install aider-chat',
    notes:
      'Runs one aider message and leaves commits to the workflow. It answers yes to its own questions, so use it in repositories you trust.',
  },
  {
    id: 'goose',
    name: 'Goose',
    executable: 'goose',
    extraArgs: ['run', '--no-session', '-t'],
    install:
      'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash',
    notes:
      'Runs goose run with your configured provider. Leave Model empty and choose it with goose configure: the model flag would come before run.',
  },
  {
    id: 'kiro',
    name: 'Kiro CLI',
    executable: 'kiro-cli',
    extraArgs: ['chat', '--no-interactive'],
    install: 'curl -fsSL https://cli.kiro.dev/install | bash',
    notes:
      'Runs kiro-cli chat without prompts; tools it would ask about are refused unless you add --trust-all-tools. Leave Model empty: the model flag would come before chat.',
  },
];

/** A Custom CLI profile prefilled from a preset, for the user to review. */
export function profileFromPreset(preset: CustomCliPreset): AgentProfile {
  return {
    ...createDefaultProfile('custom'),
    name: preset.name,
    executable: preset.executable,
    extraArgs: [...preset.extraArgs],
  };
}

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
  if (adapter === 'custom') return ['appDefault'];
  return ['cliSettings'];
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
      return `Use ${ADAPTERS[adapter].name} settings`;
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
    supportsProfileControls(profile.adapter) &&
    permissionArgument(profile) === null;
  return { ...profile, permissionLevel: full ? 'fullAccess' : 'cliSettings' };
}

/** Mirror of Rust `browser_argument`: an extra argument that sets Claude in Chrome. */
export function browserArgument(profile: AgentProfile): string | null {
  if (profile.adapter !== 'claude') return null;
  return (
    profile.extraArgs.find((arg) => arg === BROWSER_FLAG || arg === NO_BROWSER_FLAG) ??
    null
  );
}

/**
 * Mirror of Rust `AgentProfile::for_run`: the app-wide permission level
 * (`withAppDefault`), then the abilities. A Claude Code profile gets
 * `browser: true|false`; below full access, the browser's tools and (for a
 * profile following the app default) the abilities allowed in Environment
 * become `--allowedTools` rules, on top of what the profile's own Allowed
 * tools level lists. Other CLIs get neither.
 */
export function resolveForRun(
  profile: AgentProfile,
  appDefault: AppPermissionDefault | null,
  abilities: AppAbilities,
): AgentProfile {
  const followsApp = (profile.permissionLevel ?? 'appDefault') === 'appDefault';
  const resolved = withAppDefault(profile, appDefault);
  if (resolved.adapter !== 'claude') {
    const { browser: _dropped, ...rest } = resolved;
    return rest;
  }
  const browser =
    (resolved.browser ?? abilities.browser) && browserArgument(resolved) === null;
  const withBrowser: AgentProfile = { ...resolved, browser };
  if (hasFullAccess(withBrowser) || permissionArgument(withBrowser) !== null)
    return withBrowser;
  const grants = [
    ...(followsApp ? (abilities.allowedTools ?? []) : []),
    ...(browser ? [BROWSER_TOOL_RULE] : []),
  ];
  if (grants.length === 0) return withBrowser;
  const level = withBrowser.permissionLevel ?? 'appDefault';
  if (level !== 'cliSettings' && level !== 'allowedTools') return withBrowser;
  const rules = level === 'allowedTools' ? [...(withBrowser.allowedTools ?? [])] : [];
  for (const rule of grants) if (!rules.includes(rule)) rules.push(rule);
  return { ...withBrowser, permissionLevel: 'allowedTools', allowedTools: rules };
}

/** Mirror of Rust `push_browser`: `--chrome` for a resolved profile that uses the browser. */
export function browserArgs(profile: AgentProfile): string[] {
  return profile.adapter === 'claude' && profile.browser === true ? [BROWSER_FLAG] : [];
}

/** Mirror of Rust `AgentProfile::uses_browser`. Pass a profile resolved with `resolveForRun`. */
export function usesBrowser(profile: AgentProfile): boolean {
  return (
    profile.adapter === 'claude' &&
    (profile.browser === true || profile.extraArgs.includes(BROWSER_FLAG))
  );
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
    if (profile.adapter === 'muse')
      return ['--yolo', '--disable-approval', '--disable-sandbox'].includes(arg);
    if (profile.adapter === 'gemini')
      return (
        ['--yolo', '-y', '--approval-mode=yolo'].includes(arg) ||
        (arg === '--approval-mode' && next === 'yolo')
      );
    if (profile.adapter === 'antigravity')
      return [
        '--dangerously-skip-permissions',
        '--dangerously-skip-permissions=true',
      ].includes(arg);
    if (profile.adapter === 'opencode') return arg === '--auto' || arg === '--auto=true';
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
  muse: [],
  antigravity: [],
  gemini: [],
  opencode: [],
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

export const ADAPTER_LABELS = Object.fromEntries(
  ADAPTER_KINDS.map((id) => [id, ADAPTERS[id].name]),
) as Record<AdapterKind, string>;

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
  /**
   * Claude Code only: run with Claude in Chrome (`--chrome`). Absent follows
   * the app-wide abilities (`agents.abilities`).
   */
  browser?: boolean | undefined;
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

/** Mirrors `setup_check::CheckStatus`; the order is worst-last. */
export type SetupCheckStatus = 'skipped' | 'passed' | 'warning' | 'failed';

export interface SetupCheckItem {
  id: 'installed' | 'answered' | 'readFile' | 'editFile';
  label: string;
  status: SetupCheckStatus;
  detail: string;
  hint?: string;
}

/** One profile's setup check: a short real prompt, run only on request. */
export interface SetupCheckReport {
  profileId: string;
  profileName: string;
  status: SetupCheckStatus;
  items: SetupCheckItem[];
  durationMs: number;
}

export const SETUP_CHECK_LABELS: Record<SetupCheckItem['id'], string> = {
  installed: 'CLI installed',
  answered: 'Signed in and answering',
  readFile: 'Reads files in its working folder',
  editFile: 'Edits files without asking',
};

/** What the report means for running workflows, in a few words. */
export function setupCheckSummary(status: SetupCheckStatus): string {
  switch (status) {
    case 'passed':
      return 'Ready';
    case 'warning':
      return 'Works, with limits';
    case 'failed':
      return 'Needs attention';
    case 'skipped':
      return 'Not checked';
  }
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
    // A feedback check is not one of the step's results.
    const row = [...rows]
      .reverse()
      .find((r) => r.nodeId === id && r.status !== 'checked');
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
          : ADAPTERS[adapter].name,
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
  if (!supportsProfileControls(profile.adapter) && skills.length > 0)
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
  if (profile.browser === true) {
    const conflict = browserArgument(profile);
    if (profile.adapter !== 'claude')
      errors.push('Browser use applies only to Claude Code profiles.');
    else if (conflict !== null)
      errors.push(
        `Extra argument '${conflict}' conflicts with the profile's browser setting. Remove it or follow the app default.`,
      );
  }
  const level = profile.permissionLevel ?? 'appDefault';
  if (level !== 'cliSettings' && level !== 'appDefault') {
    if (!supportsProfileControls(profile.adapter))
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
  return ADAPTERS[profile.adapter].executable;
}

// -- Prompt templating --------------------------------------------------------

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g;
const ESCAPED_OPEN = /\\\{\{/g;

const VARIABLE_NAME = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

/**
 * Placeholder names a template references, sorted and unique. Scans exactly
 * like Rust `referenced_variables`: `\{{` is literal text, each `{{` closes at
 * the first `}}`, and only valid dotted names (≤128 chars) count.
 */
export function referencedVariables(template: string): string[] {
  const chars = Array.from(template);
  const names = new Set<string>();
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === '\\' && chars[i + 1] === '{' && chars[i + 2] === '{') {
      i += 3;
      continue;
    }
    if (chars[i] === '{' && chars[i + 1] === '{') {
      let end = i + 2;
      while (end + 1 < chars.length && !(chars[end] === '}' && chars[end + 1] === '}'))
        end++;
      if (end + 1 < chars.length) {
        const name = chars
          .slice(i + 2, end)
          .join('')
          .trim();
        if (name.length <= 128 && VARIABLE_NAME.test(name)) names.add(name);
        i = end + 2;
        continue;
      }
    }
    i++;
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
  if (!supportsProfileControls(profile.adapter))
    return [`${ADAPTERS[profile.adapter].name} profiles do not support session groups.`];
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
