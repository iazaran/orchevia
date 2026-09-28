import { describe, expect, it } from 'vitest';
import { aggregateProfileUsage, extractUsageHints, formatDurationMs } from './usage';
import { createDefaultProfile } from './agents';

describe('usage helpers', () => {
  it('extracts CLI usage hints and ignores noise', () => {
    const hints = extractUsageHints('done\ninput tokens: 1200, output tokens: 300', '');
    expect(hints.length).toBeGreaterThan(0);
    expect(extractUsageHints('hello world', '')).toHaveLength(0);
  });

  it('aggregates per-profile runs and durations', () => {
    const profile = { ...createDefaultProfile('claude'), id: 'p1', name: 'Claude' };
    const workflows = [
      {
        id: 'wf1',
        definition: {
          nodes: [{ id: 'n1', type: 'agent', config: { agentProfileId: 'p1' } }],
        },
      },
    ];
    const runs = [
      {
        id: 'r1',
        workflowId: 'wf1',
        status: 'succeeded' as const,
        startedAt: '2026-01-01T00:00:00Z',
      },
    ];
    const runResults = {
      r1: [
        {
          id: 1,
          runId: 'r1',
          nodeId: 'n1',
          status: 'succeeded' as const,
          stdout: 'ok',
          stderr: '',
          startedAt: '2026-01-01T00:00:00Z',
          durationMs: 1500,
        },
      ],
    };
    const usage = aggregateProfileUsage([profile], runs, runResults, workflows);
    expect(usage[0]?.runs).toBe(1);
    expect(usage[0]?.totalDurationMs).toBe(1500);
  });

  it('formats durations', () => {
    expect(formatDurationMs(0)).toBe('—');
    expect(formatDurationMs(1500)).toBe('2s');
    expect(formatDurationMs(120000)).toBe('2m');
  });
});
