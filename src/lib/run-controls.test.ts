import { describe, expect, it } from 'vitest';
import {
  reportedSpend,
  timelineEntries,
  validateRunOptions,
  replayGraph,
} from './run-controls';
import type { StoredNodeResult, StoredRun, Workflow, WorkflowNode } from './workflow';

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
  it('routes every failure label the engine accepts, including "on error"', () => {
    const recovery: Workflow = {
      ...workflow,
      edges: [
        { id: 'sb', source: 's', target: 'b' },
        { id: 'ba', source: 'b', target: 'a', label: 'On Error' },
        { id: 'be', source: 'b', target: 'e' },
        { id: 'ae', source: 'a', target: 'e' },
      ],
    };
    const graph = replayGraph(recovery, [row(1, 's'), row(2, 'b', 'failed')]);
    expect(graph.ready).toEqual(['a']);
  });
  it('waits for both branches at a join', () => {
    expect(replayGraph(workflow, [row(1, 's'), row(2, 'a')]).ready).toEqual(['b']);
    expect(replayGraph(workflow, [row(1, 's'), row(2, 'a'), row(3, 'b')]).ready).toEqual([
      'e',
    ]);
  });
});

describe('loop exits in the browser replay (parity with the engine)', () => {
  const node = (
    id: string,
    type: WorkflowNode['type'],
    maxVisits?: number,
  ): WorkflowNode => ({
    id,
    type,
    position: { x: 0, y: 0 },
    config: {
      ...(type === 'command' ? { executable: 'echo' } : {}),
      ...(maxVisits === undefined ? {} : { maxVisits }),
    },
  });
  const loop: Workflow = {
    schemaVersion: 6,
    id: 'loop',
    name: 'Loop back',
    nodes: [
      node('s', 'start'),
      node('work', 'command', 3),
      node('gate', 'condition', 3),
      node('fix', 'command', 2),
      node('after', 'command'),
      node('rescue', 'command'),
      node('e', 'end'),
    ],
    edges: [
      { id: 'e0', source: 's', target: 'work' },
      { id: 'e1', source: 'work', target: 'gate' },
      { id: 'e2', source: 'gate', target: 'fix', label: 'true' },
      { id: 'e3', source: 'gate', target: 'after', label: 'false' },
      { id: 'e4', source: 'fix', target: 'work' },
      { id: 'e5', source: 'fix', target: 'rescue', label: 'failure' },
      { id: 'e6', source: 'after', target: 'e' },
      { id: 'e7', source: 'rescue', target: 'e' },
    ],
  };
  const step = (
    id: number,
    nodeId: string,
    status = 'succeeded',
    stdout = '',
  ): StoredNodeResult => ({
    ...row(id, nodeId, status),
    stdout,
  });

  it('keeps the exit waiting while the fix loops back, then runs it', () => {
    const first = [step(1, 's'), step(2, 'work'), step(3, 'gate', 'succeeded', 'true')];
    expect(replayGraph(loop, first).ready).toEqual(['fix']);
    expect(replayGraph(loop, first).skipped).not.toContain('after');
    const exit = [
      ...first,
      step(4, 'fix'),
      step(5, 'work'),
      step(6, 'gate', 'succeeded', 'false'),
    ];
    expect(replayGraph(loop, exit).ready).toEqual(['after']);
    expect(replayGraph(loop, exit).skipped).toEqual(['fix', 'rescue']);
  });

  it('ends with the loop limit when the fix step has used its visits', () => {
    const rows = [step(1, 's'), step(2, 'work'), step(3, 'gate', 'succeeded', 'true')];
    for (const round of [0, 1]) {
      const id = 4 + round * 3;
      rows.push(
        step(id, 'fix'),
        step(id + 1, 'work'),
        step(id + 2, 'gate', 'succeeded', 'true'),
      );
    }
    expect(replayGraph(loop, rows).error).toBe(
      "Loop limit exceeded at 'fix' (max 2 visits).",
    );
  });

  it('releases the waiting exit when the loop ends by a failure route', () => {
    const rows = [
      step(1, 's'),
      step(2, 'work'),
      step(3, 'gate', 'succeeded', 'true'),
      step(4, 'fix', 'failed'),
      step(5, 'rescue'),
    ];
    const graph = replayGraph(loop, rows);
    expect(graph.error).toBeNull();
    expect(graph.ready).toEqual(['e']);
    expect(graph.skipped).toContain('after');
  });
});
