import { describe, expect, it } from 'vitest';
import {
  createDefaultProfile,
  recommendedProfiles,
  effectiveExecutable,
  MODEL_PRESETS,
  referencedVariables,
  renderPromptLenient,
  renderPromptStrict,
  validateProfile,
  validateSessionProfile,
  type AgentProfile,
  mergeModelSuggestions,
  composeAgentContext,
  structuredOutputConflict,
  hasFullAccess,
  parsePermissionDefault,
  permissionArgs,
  permissionLevelLabel,
  permissionLevels,
  readPermissionDefault,
  withAppDefault,
  type AdapterKind,
} from './agents';

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    ...createDefaultProfile('claude'),
    ...overrides,
  };
}

describe('agent profiles', () => {
  it('creates sensible claude/codex defaults', () => {
    expect(createDefaultProfile('claude').adapter).toBe('claude');
    expect(createDefaultProfile('codex').adapter).toBe('codex');
    expect(effectiveExecutable(createDefaultProfile('claude'))).toBe('claude');
  });

  it('uses explicit executable overrides', () => {
    expect(effectiveExecutable(profile({ executable: '/usr/local/bin/claude' }))).toBe(
      '/usr/local/bin/claude',
    );
  });

  it('rejects credential-like extra args', () => {
    const errors = validateProfile(profile({ extraArgs: ['--api-key=abc'] }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects out-of-range timeouts', () => {
    expect(validateProfile(profile({ defaultTimeoutSecs: 0 })).length).toBeGreaterThan(0);
    expect(
      validateProfile(profile({ defaultTimeoutSecs: 99999 })).length,
    ).toBeGreaterThan(0);
  });

  it('requires a directory in profile-dir mode', () => {
    const errors = validateProfile(profile({ workingDirMode: 'profile' }));
    expect(errors.some((e) => e.includes('directory'))).toBe(true);
  });

  it('accepts a valid profile', () => {
    expect(validateProfile(profile())).toHaveLength(0);
  });

  it('requires an explicit executable for custom CLIs', () => {
    expect(
      validateProfile(profile({ adapter: 'custom', executable: undefined })).length,
    ).toBeGreaterThan(0);
    expect(
      validateProfile(
        profile({ adapter: 'custom', executable: '/home/user/.local/bin/aichat' }),
      ),
    ).toHaveLength(0);
  });

  it('accepts valid effort levels and rejects unknown ones', () => {
    expect(validateProfile(profile({ effort: 'high' }))).toHaveLength(0);
    expect(validateProfile(profile({ effort: 'xhigh' }))).toHaveLength(0);
    expect(validateProfile(profile({ effort: 'ultra' })).length).toBeGreaterThan(0);
    expect(validateProfile(profile({ effort: '  ' })).length).toBeGreaterThan(0);
  });

  it('validates selected CLI skills before saving', () => {
    expect(
      validateProfile(profile({ skills: ['code-review', 'team:style'] })),
    ).toHaveLength(0);
    expect(
      validateProfile(profile({ skills: ['../unsafe'] })).some((e) =>
        e.includes('skill'),
      ),
    ).toBe(true);
    expect(
      validateProfile(profile({ skills: ['review', 'REVIEW'] })).some((e) =>
        e.includes('skill'),
      ),
    ).toBe(true);
    expect(
      validateProfile(
        profile({ adapter: 'custom', skills: ['review'], executable: '/bin/echo' }),
      ).some((e) => e.includes('Skills')),
    ).toBe(true);
  });
});

describe('prompt composition', () => {
  it('bounds Unicode handoffs without changing stored output and refuses incomplete context', () => {
    const stdout = `START${'🙂'.repeat(1000)}END`;
    const rows = [
      {
        id: 1,
        runId: 'r',
        nodeId: 'n',
        status: 'succeeded',
        stdout,
        stderr: '',
        startedAt: '',
      },
    ];
    const text = composeAgentContext('Work', ['n'], 256, rows);
    expect(text).toContain('START');
    expect(text.endsWith('END')).toBe(true);
    expect(text).toContain('context truncated');
    expect(Array.from(text).length).toBeLessThan(420);
    expect(rows[0]!.stdout).toBe(stdout);
    expect(() =>
      composeAgentContext('Work', ['n'], 256, [{ ...rows[0]!, status: 'running' }]),
    ).toThrow('completed');
  });
  it('substitutes workflow and node variables', () => {
    const out = renderPromptLenient('Implement {{ticket.key}} for {{workflow.name}}', {
      'ticket.key': 'DEV-1',
      'workflow.name': 'Shop',
    });
    expect(out).toBe('Implement DEV-1 for Shop');
  });

  it('leaves missing variables in place (lenient)', () => {
    expect(renderPromptLenient('Hi {{name}}', {})).toBe('Hi {{name}}');
  });

  it('errors on missing variables (strict)', () => {
    const result = renderPromptStrict('Hi {{name}}', {});
    expect('error' in result).toBe(true);
  });

  it('supports escaping with backslash', () => {
    expect(renderPromptLenient('\\{{literal}}', {})).toBe('{{literal}}');
  });

  it('lists referenced variables sorted', () => {
    expect(referencedVariables('{{b}} {{a}} {{b}}')).toEqual(['a', 'b']);
  });

  it('does not collect escaped placeholders', () => {
    expect(referencedVariables('\\{{a}} {{b}}')).toEqual(['b']);
  });

  it('scans placeholders exactly like the core renderer', () => {
    // Each `{{` closes at the first `}}`; malformed names are skipped whole.
    expect(referencedVariables('{{{{x}}}} {{ a b }} {{ node.a.output }}')).toEqual([
      'node.a.output',
    ]);
    expect(referencedVariables(`{{${'a'.repeat(129)}}} {{open`)).toEqual([]);
  });

  it('merges presets with user-taught models without duplicates', () => {
    expect(mergeModelSuggestions(['opus', 'fable'], ['FABLE', 'my-model', ''])).toEqual([
      'opus',
      'fable',
      'my-model',
    ]);
  });

  it('offers model suggestions for every adapter (field stays free-form)', () => {
    for (const adapter of ['claude', 'codex', 'custom'] as AdapterKind[]) {
      expect(Array.isArray(MODEL_PRESETS[adapter])).toBe(true);
    }
    expect(MODEL_PRESETS.claude.length).toBeGreaterThan(0);
    expect(MODEL_PRESETS.codex.length).toBeGreaterThan(0);
  });
});

describe('recommendations', () => {
  it('matches the eight configured models and preserves custom profiles', () => {
    const profiles = recommendedProfiles([]);
    expect(profiles.map((p) => p.model)).toEqual([
      'opus',
      'opus',
      'fable',
      'fable',
      'fable',
      'fable',
      'gpt-6.1-sol',
      'opus',
    ]);
    expect(profiles.filter((p) => p.role === 'deepReview')).toHaveLength(2);
    expect(
      profiles.every(
        (p) =>
          p.effort === (p.role === 'generalPurpose' ? 'medium' : 'high') &&
          p.defaultTimeoutSecs === 3600 &&
          p.workingDirMode === 'node' &&
          p.skills?.length === 0,
      ),
    ).toBe(true);
    expect(profiles.find((p) => p.role === 'generalPurpose')).toMatchObject({
      name: 'Claude — General purpose',
      model: 'opus',
      effort: 'medium',
    });
    expect(
      recommendedProfiles([
        {
          ...createDefaultProfile('claude'),
          name: 'Claude — General purpose',
          role: undefined,
        },
      ]).some((p) => p.role === 'generalPurpose'),
    ).toBe(false);
    expect(recommendedProfiles(profiles)).toEqual([]);
    const custom = {
      ...createDefaultProfile('claude'),
      role: 'planning',
      model: 'custom',
    };
    expect(recommendedProfiles([custom]).some((p) => p.role === 'planning')).toBe(false);
    expect(custom.model).toBe('custom');
    expect(
      recommendedProfiles([profiles[4]!]).filter((p) => p.role === 'deepReview'),
    ).toHaveLength(1);
  });
});

it('rejects alternative Claude session selectors on managed nodes', () => {
  for (const flag of ['--from-pr', '--from-pr=123', '--teleport', '--teleport=other'])
    expect(validateSessionProfile(profile({ extraArgs: [flag] }))).toHaveLength(1);
});

it('mirrors native structured-output conflicts for ordinary Agent nodes', () => {
  const claude = createDefaultProfile('claude');
  expect(structuredOutputConflict(claude)).toBeNull();
  expect(
    structuredOutputConflict({ ...claude, extraArgs: ['--output-format', 'json'] }),
  ).toContain("'--output-format'");
  expect(
    structuredOutputConflict({ ...claude, extraArgs: ['--output-format=text'] }),
  ).toContain('no token or cost data, and refused tool calls go undetected');
  const codex = createDefaultProfile('codex');
  expect(
    structuredOutputConflict({ ...codex, extraArgs: ['--sandbox', 'read-only'] }),
  ).toBeNull();
  expect(structuredOutputConflict({ ...codex, extraArgs: ['--json'] })).not.toBeNull();
  expect(structuredOutputConflict({ ...codex, extraArgs: ['--json'] })).not.toContain(
    'refused',
  );
  expect(
    structuredOutputConflict({
      ...createDefaultProfile('custom'),
      extraArgs: ['--json'],
    }),
  ).toBeNull();
  expect(
    structuredOutputConflict({ ...claude, extraArgs: ['--input-format', 'stream-json'] }),
  ).toContain('passed as an argument');
});

describe('profile permissions', () => {
  it('reads a missing setting as the app default, the CLI settings until chosen', () => {
    const legacy = createDefaultProfile('claude');
    expect(legacy.permissionLevel).toBeUndefined();
    expect(permissionArgs(legacy)).toEqual([]);
    expect(validateProfile(legacy)).toEqual([]);
    expect(hasFullAccess(legacy)).toBe(false);
    for (const appDefault of [null, 'cliSettings'] as const) {
      const resolved = withAppDefault(legacy, appDefault);
      expect(resolved.permissionLevel).toBe('cliSettings');
      expect(permissionArgs(resolved)).toEqual([]);
    }
    expect(permissionLevelLabel('claude', undefined)).toBe(
      'App default (CLI settings, not chosen yet)',
    );
    expect(permissionLevelLabel('codex', 'appDefault', 'fullAccess')).toBe(
      'App default (Full access)',
    );
  });

  it('resolves the app default like the core (with_app_default)', () => {
    const full = (p: AgentProfile): AgentProfile => withAppDefault(p, 'fullAccess');
    const claude = createDefaultProfile('claude');
    expect(permissionArgs(full(claude))).toEqual([
      '--permission-mode',
      'bypassPermissions',
    ]);
    expect(hasFullAccess(full(claude))).toBe(true);
    expect(permissionArgs(full(createDefaultProfile('codex')))).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
    // Explicit levels are the profile's own choice.
    for (const level of ['cliSettings', 'allowedTools', 'fullAccess'] as const)
      expect(full({ ...claude, permissionLevel: level }).permissionLevel).toBe(level);
    // Own permission arguments and Custom CLIs keep their own behaviour.
    const ownFlags = { ...claude, extraArgs: ['--permission-mode', 'acceptEdits'] };
    expect(validateProfile(ownFlags)).toEqual([]);
    expect(full(ownFlags).permissionLevel).toBe('cliSettings');
    const custom = { ...createDefaultProfile('custom'), executable: '/usr/bin/aichat' };
    expect(validateProfile(custom)).toEqual([]);
    expect(full(custom).permissionLevel).toBe('cliSettings');
    // Only the two app-wide levels parse (Rust parse_permission_default).
    expect(parsePermissionDefault('fullAccess')).toBe('fullAccess');
    expect(parsePermissionDefault('cliSettings')).toBe('cliSettings');
    for (const value of ['allowedTools', 'appDefault', '', 'FullAccess']) {
      expect(() => parsePermissionDefault(value)).toThrow(
        'Agent permissions must be cliSettings or fullAccess.',
      );
      expect(readPermissionDefault(value)).toBeNull();
    }
    expect(readPermissionDefault(null)).toBeNull();
  });

  it('maps each level to the same flags as the core adapter', () => {
    const claude = profile({
      permissionLevel: 'allowedTools',
      allowedTools: ['mcp__claude_ai_Atlassian_Rovo_2', 'Bash(git status *)', 'Edit'],
    });
    expect(validateProfile(claude)).toEqual([]);
    expect(permissionArgs(claude)).toEqual([
      '--allowedTools',
      'mcp__claude_ai_Atlassian_Rovo_2,Bash(git status *),Edit',
    ]);
    expect(permissionArgs({ ...claude, permissionLevel: 'fullAccess' })).toEqual([
      '--permission-mode',
      'bypassPermissions',
    ]);
    const codex = {
      ...createDefaultProfile('codex'),
      permissionLevel: 'fullAccess' as const,
    };
    expect(permissionArgs(codex)).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
    expect(permissionLevels('codex')).toEqual([
      'appDefault',
      'cliSettings',
      'fullAccess',
    ]);
    expect(permissionLevels('custom')).toEqual(['appDefault']);
  });

  it('mirrors the core permission validation messages', () => {
    expect(validateProfile(profile({ permissionLevel: 'allowedTools' }))).toEqual([
      'Allowed tools needs at least one tool.',
    ]);
    expect(
      validateProfile(
        profile({
          permissionLevel: 'allowedTools',
          allowedTools: ['Edit', 'Edit', '--dangerously-skip-permissions'],
        }),
      ),
    ).toEqual([
      "Duplicate allowed tool 'Edit'.",
      "Invalid allowed tool '--dangerously-skip-permissions'. Use a tool name such as Edit, mcp__server, or Bash(git *).",
    ]);
    expect(
      validateProfile(
        profile({
          permissionLevel: 'fullAccess',
          extraArgs: ['--permission-mode', 'acceptEdits'],
        }),
      ),
    ).toEqual([
      "Extra argument '--permission-mode' conflicts with the profile's permission setting. Remove it or use the CLI settings level.",
    ]);
    // At the default level the user's own permission flags stay allowed.
    expect(
      validateProfile(profile({ extraArgs: ['--permission-mode', 'acceptEdits'] })),
    ).toEqual([]);
    const codex = createDefaultProfile('codex');
    expect(
      validateProfile({
        ...codex,
        permissionLevel: 'allowedTools',
        allowedTools: ['Edit'],
      }),
    ).toEqual([
      'Allowed tools apply only to Claude Code profiles.',
      'Codex has no tool allow-list. Use Codex settings or Full access.',
    ]);
    expect(
      validateProfile({
        ...createDefaultProfile('custom'),
        executable: '/usr/local/bin/aichat',
        permissionLevel: 'fullAccess',
      }),
    ).toEqual(['Permission levels apply only to Claude Code and Codex profiles.']);
  });

  it('recognises full access set through extra arguments', () => {
    expect(
      hasFullAccess(profile({ extraArgs: ['--dangerously-skip-permissions'] })),
    ).toBe(true);
    expect(
      hasFullAccess(profile({ extraArgs: ['--permission-mode', 'bypassPermissions'] })),
    ).toBe(true);
    const codex = createDefaultProfile('codex');
    expect(
      hasFullAccess({ ...codex, extraArgs: ['--sandbox', 'danger-full-access'] }),
    ).toBe(true);
    expect(hasFullAccess({ ...codex, extraArgs: ['--sandbox', 'workspace-write'] })).toBe(
      false,
    );
  });
});
