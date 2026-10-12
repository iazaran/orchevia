import { describe, expect, it } from 'vitest';
import {
  extractUsageHints,
  formatDurationMs,
  agentContextDetails,
  billingPeriod,
  measuredUsage,
} from './usage';

describe('usage helpers', () => {
  it('preserves measured zeroes and validates explicit billing-period boundaries', () => {
    const known = measuredUsage(
      {
        input_tokens: 0,
        output_tokens: 0,
        observed_tool_calls: 0,
        reasoning_output_tokens: 2,
      },
      'codex',
    );
    expect(known.coverage.inputTokens).toBe(1);
    expect(known.coverage.toolCalls).toBe(1);
    expect(known.coverage.subagents).toBe(0);
    expect(known.reasoningOutputTokens).toBe(2);
    expect(
      measuredUsage({ input_tokens: 1.5, observed_tool_calls: -1 }, 'codex').coverage
        .inputTokens,
    ).toBe(0);
    expect(billingPeriod('2026-02-01/2026-03-01')).toEqual({
      from: '2026-02-01',
      to: '2026-03-01',
    });
    expect(billingPeriod('2026-02-30/2026-03-01')).toBeNull();
    expect(billingPeriod('2026-03-01/2026-03-01')).toBeNull();
    expect(billingPeriod('monthly')).toBeNull();
  });
  it('shows explicit session reuse and provider counts without invented usage', () => {
    const details = agentContextDetails(
      JSON.stringify({
        agentSession: { group: 'dev', turn: 2, reused: true },
        agentUsage: { input_tokens: 12, cached_input_tokens: 8, output_tokens: 3 },
        agentActivity: 'Tool activity',
      }),
    );
    expect(details?.sessionLabel).toBe('Resumed context · turn 2');
    expect(details?.usageHints).toEqual(['input: 12', 'cached input: 8', 'output: 3']);
    expect(details?.activity).toBe('Tool activity');
    expect(agentContextDetails('{}')).toBeNull();
    expect(agentContextDetails('bad JSON')).toBeNull();
    expect(
      agentContextDetails(
        JSON.stringify({ agentUsage: { input_tokens: -1, output_tokens: 'oops' } }),
      )?.usageHints,
    ).toEqual([]);
  });
  it('surfaces why an Agent node ran in text mode without usage', () => {
    const details = agentContextDetails(
      JSON.stringify({ agentOutputNote: 'Text output used: --json.' }),
    );
    expect(details?.outputNote).toBe('Text output used: --json.');
    expect(details?.usageHints).toEqual([]);
    expect(
      agentContextDetails(JSON.stringify({ agentUsage: { input_tokens: 1 } }))
        ?.outputNote,
    ).toBe('');
  });

  it('extracts CLI usage hints and ignores noise', () => {
    const hints = extractUsageHints('done\ninput tokens: 1200, output tokens: 300', '');
    expect(hints.length).toBeGreaterThan(0);
    expect(extractUsageHints('hello world', '')).toHaveLength(0);
  });

  it('formats durations', () => {
    expect(formatDurationMs(0)).toBe('—');
    expect(formatDurationMs(1500)).toBe('2s');
    expect(formatDurationMs(120000)).toBe('2m');
  });
});
