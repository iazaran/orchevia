import { describe, expect, it } from 'vitest';
import {
  reportedSpend,
  timelineEntries,
  validateRunOptions,
  replayGraph,
} from './run-controls';
import type { StoredNodeResult, StoredRun, Workflow } from './workflow';

const workflow: Workflow = {
  schemaVersion: 6,
  id: 'w',
  name: 'Test',
  nodes: [
    { id: 's', type: 'start', position: { x: 0, y: 0 }, config: {} },
    {
      id: 'a',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { agentProfileId: 'missing', prompt: 'Test' },
    },
    {
      id: 'b',
      type: 'command',
      position: { x: 0, y: 0 },
      config: { executable: 'forbidden' },
    },
    { id: 'e', type: 'end', position: { x: 0, y: 0 }, config: {} },
  ],
  edges: [
    { id: 'sa', source: 's', target: 'a' },
    { id: 'sb', source: 's', target: 'b' },
    { id: 'ae', source: 'a', target: 'e' },
    { id: 'be', source: 'b', target: 'e' },
  ],
};
const row = (id: number, nodeId: string, status = 'succeeded'): StoredNodeResult => ({
  id,
  runId: 'r',
  nodeId,
  status,
  stdout: '',
  stderr: '',
  startedAt: '2026-10-08T00:00:00Z',
  finishedAt: '2026-10-08T00:00:05Z',
  durationMs: 5000,
});

describe('run controls', () => {
  it('treats optional JSON nulls as absent, matching the native contract', () => {
    expect(() =>
      validateRunOptions(workflow, {
        dryRun: true,
        spendLimitUsd: null,
        fixtures: { a: [{ status: 'succeeded', exitCode: null, structured: null }] },
      }),
    ).not.toThrow();
  });
  it('retains legacy measured duration without claiming an unknown placement', () => {
    const run: StoredRun = {
      id: 'r',
      workflowId: 'w',
      status: 'succeeded',
      startedAt: '2026-10-08T00:00:00Z',
    };
    const legacy = { ...row(1, 'b'), startedAt: '2026-10-08T00:00:05Z' };
    const entry = timelineEntries(run, [legacy])[0];
    expect(entry?.durationMs).toBe(5000);
    expect(entry?.offsetMs).toBeNull();
  });
  it('rejects fixtures outside dry-run and reserved metadata', () => {
    expect(() =>
      validateRunOptions(workflow, { fixtures: { a: [{ status: 'succeeded' }] } }),
    ).toThrow();
    expect(() =>
      validateRunOptions(workflow, {
        dryRun: true,
        fixtures: {
          a: [
            { status: 'succeeded', structured: { agentUsage: { reported_cost_usd: 1 } } },
          ],
        },
      }),
    ).toThrow();
    expect(() => validateRunOptions(workflow, { spendLimitUsd: 0 })).toThrow();
  });
  it('counts only actual newly executed reported USD and marks unknown attempts', () => {
    const cost = (id: number, metadata: unknown): StoredNodeResult => ({
      ...row(id, 'a'),
      structuredJson: JSON.stringify(metadata),
    });
    expect(
      reportedSpend(workflow, [
        cost(1, { agentUsage: { reported_cost_usd: 2 } }),
        cost(2, {}),
        cost(3, { simulated: true, agentUsage: { reported_cost_usd: 100 } }),
        cost(4, { reusedFrom: { runId: 'old' }, agentUsage: { reported_cost_usd: 100 } }),
      ]),
    ).toEqual({ reportedUsd: 2, reportedAttempts: 1, unknownAttempts: 1 });
  });
  it('places parallel attempts on the same time axis and measures approval wait', () => {
    const run: StoredRun = {
      id: 'r',
      workflowId: 'w',
      status: 'succeeded',
      startedAt: '2026-10-08T00:00:00Z',
      finishedAt: '2026-10-08T00:00:10Z',
    };
    const entries = timelineEntries(
      run,
      [
        row(1, 'a'),
        row(2, 'b'),
        { ...row(3, 'gate', 'paused'), startedAt: '2026-10-08T00:00:05Z' },
        { ...row(4, 'gate', 'approved'), startedAt: '2026-10-08T00:00:09Z' },
      ],
      Date.parse('2026-10-08T00:00:10Z'),
    );
    expect(entries[0]?.offsetMs).toBe(0);
    expect(entries[1]?.offsetMs).toBe(0);
    expect(entries.find((e) => e.id === 3)?.durationMs).toBe(4000);
  });
  it('waits for both branches at a join', () => {
    expect(replayGraph(workflow, [row(1, 's'), row(2, 'a')]).ready).toEqual(['b']);
    expect(replayGraph(workflow, [row(1, 's'), row(2, 'a'), row(3, 'b')]).ready).toEqual([
      'e',
    ]);
  });
});
