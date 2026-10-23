import { describe, expect, it } from 'vitest';
import {
  extractUsageHints,
  formatDurationMs,
  agentContextDetails,
  daysInMonth,
  estimatePlanCost,
  measuredUsage,
  parsePlans,
  parsePlanShare,
  planCostGap,
  validatePlans,
  type UsageProviderDay,
} from './usage';

describe('usage helpers', () => {
  it('preserves measured zeroes', () => {
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

function providerDay(partial: Partial<UsageProviderDay>): UsageProviderDay {
  return {
    day: '2026-10-23',
    adapter: 'claude',
    agentAttempts: 1,
    durationMs: 1000,
    reportedUsd: 0,
    reportedUsdAttempts: 0,
    allAgentAttempts: 1,
    allDurationMs: 1000,
    ...partial,
  };
}

describe('plan cost', () => {
  const plans = {
    claude: { billing: 'subscription', monthlyUsd: 124, name: 'Max 5×' },
    codex: { billing: 'subscription', monthlyUsd: 24.8 },
  } as const;

  it('charges a day of each plan used, not the API value', () => {
    // A heavy day: USD 62.88 of API value on a USD 124/month Claude plan.
    const cost = estimatePlanCost(
      [
        providerDay({ agentAttempts: 13, reportedUsd: 62.88, reportedUsdAttempts: 13 }),
        providerDay({ adapter: 'codex', agentAttempts: 1 }),
      ],
      plans,
    );
    expect(cost.lines.map((line) => [line.adapter, line.usd])).toEqual([
      ['claude', 4],
      ['codex', 0.8],
    ]);
    expect(cost.totalUsd).toBeCloseTo(4.8);
    expect(cost.complete).toBe(true);
    expect(cost.byDay['2026-10-23']).toBeCloseTo(4.8);
    expect(cost.partialDays).toEqual([]);
    expect(cost.lines[0]?.reportedUsd).toBe(62.88);
  });

  it('splits a filtered day by agent time and applies the Orchevia share', () => {
    const cost = estimatePlanCost(
      [
        providerDay({ durationMs: 3000, allDurationMs: 4000 }),
        providerDay({
          day: '2026-10-24',
          durationMs: 0,
          allDurationMs: 0,
          allAgentAttempts: 2,
        }),
      ],
      plans,
      50,
    );
    // 124/31 × 3/4 × 50% on the 23rd, then 124/31 × 1/2 × 50% on the 24th.
    expect(cost.byDay['2026-10-23']).toBeCloseTo(1.5);
    expect(cost.byDay['2026-10-24']).toBeCloseTo(1);
    expect(cost.lines[0]?.activeDays).toBe(2);
  });

  it('costs pay-per-use at the reported value and leaves unknown providers unknown', () => {
    const cost = estimatePlanCost(
      [
        providerDay({ agentAttempts: 2, reportedUsd: 1.25, reportedUsdAttempts: 1 }),
        providerDay({ adapter: 'codex' }),
        providerDay({ adapter: 'custom' }),
      ],
      { claude: { billing: 'api' }, codex: { billing: 'subscription', monthlyUsd: 31 } },
    );
    expect(cost.lines.map((line) => [line.adapter, line.usd])).toEqual([
      ['claude', 1.25],
      ['codex', 1],
      ['custom', null],
    ]);
    expect(cost.totalUsd).toBeCloseTo(2.25);
    expect(cost.complete).toBe(false);
    expect(planCostGap(cost)).toBe('No plan entered for custom');
    // Pay per use with no dollar report is unknown, never USD 0.
    const codex = estimatePlanCost([providerDay({ adapter: 'codex' })], {
      codex: { billing: 'api' },
    });
    expect(codex.lines[0]?.usd).toBeNull();
    expect(codex.totalUsd).toBeNull();
    expect(codex.byDay).toEqual({});
    expect(codex.partialDays).toEqual(['2026-10-23']);
    expect(planCostGap(codex)).toBe('1 pay-per-use attempt reported no dollar figure');
    expect(estimatePlanCost([], {}).totalUsd).toBeNull();
    expect(estimatePlanCost([providerDay({})], {}).totalUsd).toBeNull();
  });

  it('validates plans like the core and reads damaged settings as none', () => {
    expect(() =>
      validatePlans(
        '{"claude":{"billing":"subscription","monthlyUsd":120,"name":"Max"}}',
      ),
    ).not.toThrow();
    for (const [value, message] of [
      ['[]', 'JSON object'],
      ['{"gemini":{"billing":"api"}}', 'Unknown plan provider'],
      ['{"claude":"max"}', 'must be an object'],
      ['{"claude":{"billing":"monthly"}}', 'billing must be'],
      ['{"claude":{"billing":"subscription"}}', 'monthly USD amount'],
      ['{"claude":{"billing":"subscription","monthlyUsd":100001}}', 'monthly USD amount'],
      ['{"codex":{"billing":"api","monthlyUsd":0}}', 'no monthly amount'],
      ['{"codex":{"billing":"api","seats":2}}', 'only billing, monthlyUsd and name'],
      ['{"codex":{"billing":"api","name":7}}', 'at most 80 bytes'],
    ] as const)
      expect(() => validatePlans(value)).toThrow(message);
    // Both sides name the first problem in sorted provider order.
    expect(() =>
      validatePlans(
        '{"codex":{"billing":"subscription"},"claude":{"billing":"api","monthlyUsd":0}}',
      ),
    ).toThrow('Pay-per-use billing has no monthly amount.');
    expect(parsePlans('{"claude":{"billing":"api"}}')).toEqual({
      claude: { billing: 'api' },
    });
    expect(parsePlans('{"claude":{"billing":"monthly"}}')).toEqual({});
    expect(parsePlans(null)).toEqual({});
    expect(parsePlanShare('')).toBe(100);
    expect(parsePlanShare('62.5')).toBe(62.5);
    expect(parsePlanShare('1e2')).toBe(100);
    expect(daysInMonth('2028-02-10')).toBe(29);
    expect(daysInMonth('2026-10-23')).toBe(31);
  });
});
