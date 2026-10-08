import { describe, expect, it } from 'vitest';
import {
  aggregateProfileUsage,
  extractUsageHints,
  formatDurationMs,
  agentContextDetails,
} from './usage';
import { createDefaultProfile } from './agents';

describe('usage helpers', () => {
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
