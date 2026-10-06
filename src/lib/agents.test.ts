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
