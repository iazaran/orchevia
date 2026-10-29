import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setMockBackendForTests } from './backend';
import { CURRENT_SCHEMA_VERSION } from './workflow';
import type { StoredNodeResult, Workflow, WorkflowEdge, WorkflowNode } from './workflow';

// The mock backend's runs route loops like the engine. Each case mirrors an
// engine test in crates/core/src/engine.rs and expects the same steps, in the
// same order and number, the same skip rows and the same final status.
//
// Commands run dry with one fixture per visit: a line reading `fail` fails
// that visit, any other line is its output. The mock runs one ready step at a
// time, in definition order, while the engine runs ready steps together. Where
// that matters the node order makes the mock finish steps in the order the
// engine's timing does, or the case says what differs.

const at = { x: 0, y: 0 };
const marker = (id: string, type: 'start' | 'end'): WorkflowNode => ({
  id,
  type,
  position: at,
  config: {},
});
const step = (id: string, maxVisits?: number): WorkflowNode => ({
  id,
  type: 'command',
  position: at,
  config: { executable: 'echo', ...(maxVisits === undefined ? {} : { maxVisits }) },
});
const approval = (id: string, maxVisits: number): WorkflowNode => ({
  id,
  type: 'approval',
  position: at,
  config: { maxVisits },
});
/** True while `node.<source>.output` contains `needle`. */
const gate = (
  id: string,
  source: string,
  needle: string,
  maxVisits: number,
): WorkflowNode => ({
  id,
  type: 'condition',
  position: at,
  config: {
    maxVisits,
    condition: {
      logic: 'and',
      clauses: [{ left: `node.${source}.output`, op: 'contains', right: needle }],
    },
  },
});
const edge = (
  id: string,
  source: string,
  target: string,
  label?: 'true' | 'false' | 'failure',
): WorkflowEdge =>
  label === undefined ? { id, source, target } : { id, source, target, label };
const workflow = (
  id: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): Workflow => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  id,
  name: id,
  nodes,
  edges,
});

/** The steps that ran, in order; a condition shows its branch, a failure is marked. */
function ran(rows: StoredNodeResult[]): string[] {
  return rows
    .filter(
      (r) =>
        r.nodeId !== 'run' &&
        ['succeeded', 'failed', 'approved', 'rejected'].includes(r.status),
    )
    .map((r) => {
      const data = JSON.parse(r.structuredJson ?? '{}') as { branch?: string };
      if (data.branch !== undefined) return `${r.nodeId}:${data.branch}`;
      return ['failed', 'rejected'].includes(r.status)
        ? `${r.nodeId}:${r.status}`
        : r.nodeId;
    });
}

interface DryRun {
  status: string | undefined;
  pauses: number;
  ran: string[];
  skipped: string[];
  error: string | undefined;
}

/** Run `wf` dry with per-visit fixtures, approving every pause. */
async function runDry(wf: Workflow, plans: Record<string, string[]>): Promise<DryRun> {
  const backend = __setMockBackendForTests();
  await backend.saveWorkflow(wf);
  const fixtures = Object.fromEntries(
    Object.entries(plans).map(([id, lines]) => [
      id,
      lines.map((line) => ({
        status: line === 'fail' ? 'failed' : 'succeeded',
        stdout: line,
      })),
    ]),
  );
  const { runId } = await backend.runWorkflow(wf.id, {}, { dryRun: true, fixtures });
  await vi.runAllTimersAsync();
  let pauses = 0;
  while ((await backend.getRun(runId))?.status === 'paused' && pauses < 10) {
    pauses += 1;
    await backend.approveRun(runId, true);
    await vi.runAllTimersAsync();
  }
  const rows = await backend.getRunResults(runId);
  const failure = rows.find((r) => r.nodeId === 'run');
  return {
    status: (await backend.getRun(runId))?.status,
    pauses,
    ran: ran(rows),
    skipped: rows.filter((r) => r.status === 'skipped').map((r) => r.nodeId),
    error: failure?.error ?? failure?.stdout,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * start → implement → test → gate -true-> fix → test        (inner loop)
 *                            gate -false-> review → outer
 *         outer -true-> implement                           (outer loop)
 *         outer -false-> publish → end
 */
function nestedLoops(
  id: string,
  bounds: { implement: number; test: number; fix: number; review: number },
): Workflow {
  return workflow(
    id,
    [
      marker('start', 'start'),
      step('implement', bounds.implement),
      step('test', bounds.test),
      gate('gate', 'test', 'red', bounds.test),
      step('fix', bounds.fix),
      step('review', bounds.review),
      gate('outer', 'review', 'changes', bounds.review),
      step('publish'),
      marker('end', 'end'),
    ],
    [
      edge('e0', 'start', 'implement'),
      edge('e1', 'implement', 'test'),
      edge('e2', 'test', 'gate'),
      edge('e3', 'gate', 'fix', 'true'),
      edge('e4', 'fix', 'test'),
      edge('e5', 'gate', 'review', 'false'),
      edge('e6', 'review', 'outer'),
      edge('e7', 'outer', 'implement', 'true'),
      edge('e8', 'outer', 'publish', 'false'),
      edge('e9', 'publish', 'end'),
    ],
  );
}

/**
 * start → test (-failure-> fix) → gate -true-> fix → test   (inner loop)
 *                                 gate -false-> review → outer
 *         outer -true-> test                                (outer loop)
 *         outer -false-> report ← lint ← start; report → end
 */
function nestedLoopsWithJoin(id: string, gateOn: string, lintFirst: boolean): Workflow {
  const lint = step('lint');
  const loop = [
    step('test', 6),
    gate('gate', 'test', gateOn, 6),
    step('fix', 3),
    step('review', 2),
    gate('outer', 'review', 'changes', 2),
  ];
  return workflow(
    id,
    [
      marker('start', 'start'),
      // A lint defined first finishes before the loops (the engine's fast
      // lint); defined after them, it runs once they are done (a slow lint).
      ...(lintFirst ? [lint, ...loop] : [...loop, lint]),
      step('report'),
      marker('end', 'end'),
    ],
    [
      edge('e0', 'start', 'test'),
      edge('e1', 'start', 'lint'),
      edge('e2', 'test', 'gate'),
      edge('e3', 'test', 'fix', 'failure'),
      edge('e4', 'gate', 'fix', 'true'),
      edge('e5', 'fix', 'test'),
      edge('e6', 'gate', 'review', 'false'),
      edge('e7', 'review', 'outer'),
      edge('e8', 'outer', 'test', 'true'),
      edge('e9', 'outer', 'report', 'false'),
      edge('e10', 'lint', 'report'),
      edge('e11', 'report', 'end'),
    ],
  );
}

describe('nested loops in mock runs (parity with the engine)', () => {
  it('waits to review until the inner fix loop passes (outer loop restarts at the tests)', async () => {
    const wf = workflow(
      'nested-shared',
      [
        marker('start', 'start'),
        step('test', 5),
        gate('gate', 'test', 'red', 5),
        step('fix', 3),
        step('review', 2),
        gate('outer', 'review', 'changes', 2),
        step('publish'),
        marker('end', 'end'),
      ],
      [
        edge('e0', 'start', 'test'),
        edge('e1', 'test', 'gate'),
        edge('e2', 'gate', 'fix', 'true'),
        edge('e3', 'fix', 'test'),
        edge('e4', 'gate', 'review', 'false'),
        edge('e5', 'review', 'outer'),
        edge('e6', 'outer', 'test', 'true'),
        edge('e7', 'outer', 'publish', 'false'),
        edge('e8', 'publish', 'end'),
      ],
    );
    const result = await runDry(wf, {
      test: ['red', 'red', 'green', 'red', 'green'],
      fix: ['f1', 'f2', 'f3'],
      review: ['changes', 'ok'],
      publish: ['publish'],
    });
    expect(result.status).toBe('succeeded');
    expect(result.ran).toEqual([
      'start',
      'test',
      'gate:true',
      'fix',
      'test',
      'gate:true',
      'fix',
      'test',
      'gate:false',
      'review',
      'outer:true',
      'test',
      'gate:true',
      'fix',
      'test',
      'gate:false',
      'review',
      'outer:false',
      'publish',
      'end',
    ]);
    expect(result.skipped).toEqual(['fix', 'fix']);
  });

  it('finishes when the inner exit is the outer condition, which restarts before the inner loop', async () => {
    const wf = workflow(
      'nested-exit',
      [
        marker('start', 'start'),
        step('plan', 2),
        step('test', 4),
        gate('gate', 'test', 'red', 4),
        step('fix', 2),
        gate('outer', 'plan', 'again', 2),
        step('publish'),
        marker('end', 'end'),
      ],
      [
        edge('e0', 'start', 'plan'),
        edge('e1', 'plan', 'test'),
        edge('e2', 'test', 'gate'),
        edge('e3', 'gate', 'fix', 'true'),
        edge('e4', 'fix', 'test'),
        edge('e5', 'gate', 'outer', 'false'),
        edge('e6', 'outer', 'plan', 'true'),
        edge('e7', 'outer', 'publish', 'false'),
        edge('e8', 'publish', 'end'),
      ],
    );
    const result = await runDry(wf, {
      plan: ['again', 'done'],
      test: ['red', 'green', 'red', 'green'],
      fix: ['f1', 'f2'],
      publish: ['publish'],
    });
    expect(result.status).toBe('succeeded');
    expect(result.ran).toEqual([
      'start',
      'plan',
      'test',
      'gate:true',
      'fix',
      'test',
      'gate:false',
      'outer:true',
      'plan',
      'test',
      'gate:true',
      'fix',
      'test',
      'gate:false',
      'outer:false',
      'publish',
      'end',
    ]);
    expect(result.skipped).toEqual(['fix', 'fix']);
  });

  it('goes round both loops as often as their conditions say', async () => {
    const result = await runDry(
      nestedLoops('nested-counts', { implement: 3, test: 6, fix: 3, review: 3 }),
      {
        implement: ['i1', 'i2', 'i3'],
        test: ['red', 'red', 'green', 'green', 'red', 'green'],
        fix: ['f1', 'f2', 'f3'],
        review: ['changes', 'changes', 'ok'],
        publish: ['publish'],
      },
    );
    expect(result.status).toBe('succeeded');
    expect(result.ran).toEqual([
      'start',
      'implement',
      'test',
      'gate:true',
      'fix',
      'test',
      'gate:true',
      'fix',
      'test',
      'gate:false',
      'review',
      'outer:true',
      'implement',
      'test',
      'gate:false',
      'review',
      'outer:true',
      'implement',
      'test',
      'gate:true',
      'fix',
      'test',
      'gate:false',
      'review',
      'outer:false',
      'publish',
      'end',
    ]);
    const count = (id: string): number => result.ran.filter((s) => s === id).length;
    expect([count('implement'), count('test'), count('fix'), count('review')]).toEqual([
      3, 6, 3, 3,
    ]);
    expect(result.skipped).toEqual(['fix', 'fix', 'fix']);
  });

  it('counts an inner bound across outer passes', async () => {
    const result = await runDry(
      nestedLoops('nested-inner-bound', { implement: 2, test: 5, fix: 2, review: 2 }),
      {
        implement: ['i1', 'i2'],
        test: ['red', 'green', 'red', 'red', 'red'],
        fix: ['f1', 'f2', 'f3'],
        review: ['changes', 'ok'],
        publish: ['publish'],
      },
    );
    expect(result.status).toBe('failed');
    expect(result.error).toBe("Loop limit exceeded at 'fix' (max 2 visits).");
    expect(result.ran).toEqual([
      'start',
      'implement',
      'test',
      'gate:true',
      'fix',
      'test',
      'gate:false',
      'review',
      'outer:true',
      'implement',
      'test',
      'gate:true',
      'fix',
      'test',
      'gate:true',
    ]);
  });

  it('stops an outer loop that keeps asking for changes at its bound', async () => {
    const result = await runDry(
      nestedLoops('nested-outer-bound', { implement: 2, test: 4, fix: 2, review: 2 }),
      {
        implement: ['i1', 'i2', 'i3'],
        test: ['red', 'green', 'red', 'green'],
        fix: ['f1', 'f2'],
        review: ['changes', 'changes'],
        publish: ['publish'],
      },
    );
    expect(result.status).toBe('failed');
    expect(result.error).toBe("Loop limit exceeded at 'implement' (max 2 visits).");
    expect(result.ran).toEqual([
      'start',
      'implement',
      'test',
      'gate:true',
      'fix',
      'test',
      'gate:false',
      'review',
      'outer:true',
      'implement',
      'test',
      'gate:true',
      'fix',
      'test',
      'gate:false',
      'review',
      'outer:true',
    ]);
  });

  it('routes a failing test into the fix and keeps the join waiting for the loops', async () => {
    const result = await runDry(nestedLoopsWithJoin('nested-failure', 'warn', true), {
      lint: ['lint-done'],
      test: ['fail', 'ok', 'fail', 'ok'],
      fix: ['f1', 'f2', 'f3'],
      review: ['changes', 'ok'],
      report: ['report'],
    });
    expect(result.status).toBe('succeeded');
    expect(result.ran).toEqual([
      'start',
      'lint',
      'test:failed',
      'fix',
      'test',
      'gate:false',
      'review',
      'outer:true',
      'test:failed',
      'fix',
      'test',
      'gate:false',
      'review',
      'outer:false',
      'report',
      'end',
    ]);
    expect(result.skipped).toEqual(['gate', 'fix', 'gate', 'fix']);
  });

  it('runs a join after nested loops once, after both its branches', async () => {
    const loops = [
      'test',
      'gate:true',
      'fix',
      'test',
      'gate:false',
      'review',
      'outer:true',
      'test',
      'gate:true',
      'fix',
      'test',
      'gate:false',
      'review',
      'outer:false',
    ];
    const plans = {
      lint: ['lint-done'],
      test: ['red', 'green', 'red', 'green'],
      fix: ['f1', 'f2', 'f3'],
      review: ['changes', 'ok'],
      report: ['report'],
    };
    const fast = await runDry(
      nestedLoopsWithJoin('nested-join-fast', 'red', true),
      plans,
    );
    expect(fast.status).toBe('succeeded');
    expect(fast.ran).toEqual(['start', 'lint', ...loops, 'report', 'end']);
    expect(fast.skipped).toEqual(['fix', 'fix']);
    const slow = await runDry(
      nestedLoopsWithJoin('nested-join-slow', 'red', false),
      plans,
    );
    expect(slow.status).toBe('succeeded');
    expect(slow.ran).toEqual(['start', ...loops, 'lint', 'report', 'end']);
    expect(slow.skipped).toEqual(['fix', 'fix']);
  });

  it('ends both loops through a failure route out of the inner loop', async () => {
    const wf = nestedLoops('nested-rescue', { implement: 2, test: 3, fix: 2, review: 2 });
    wf.nodes.push(step('rescue'));
    wf.edges.push(edge('e10', 'fix', 'rescue', 'failure'), edge('e11', 'rescue', 'end'));
    const result = await runDry(wf, {
      implement: ['i1', 'i2'],
      test: ['red', 'green', 'red'],
      fix: ['f1', 'fail'],
      review: ['changes'],
      publish: ['publish'],
      rescue: ['rescue'],
    });
    expect(result.status).toBe('succeeded');
    expect(result.ran).toEqual([
      'start',
      'implement',
      'test',
      'gate:true',
      'fix',
      'test',
      'gate:false',
      'review',
      'outer:true',
      'implement',
      'test',
      'gate:true',
      'fix:failed',
      'rescue',
      'end',
    ]);
    expect(result.skipped).toEqual(['fix', 'review', 'outer', 'publish']);
  });

  it('resumes approvals inside nested loops to the same result', async () => {
    const wf = nestedLoops('nested-approval', {
      implement: 2,
      test: 5,
      fix: 3,
      review: 2,
    });
    wf.nodes.push(approval('confirm', 3));
    wf.edges = wf.edges.filter((e) => e.id !== 'e3');
    wf.edges.push(edge('e3', 'gate', 'confirm', 'true'), edge('e10', 'confirm', 'fix'));
    const result = await runDry(wf, {
      implement: ['i1', 'i2'],
      test: ['red', 'red', 'green', 'red', 'green'],
      fix: ['f1', 'f2', 'f3'],
      review: ['changes', 'ok'],
      publish: ['publish'],
    });
    expect(result.pauses).toBe(3);
    expect(result.status).toBe('succeeded');
    expect(result.ran).toEqual([
      'start',
      'implement',
      'test',
      'gate:true',
      'confirm',
      'fix',
      'test',
      'gate:true',
      'confirm',
      'fix',
      'test',
      'gate:false',
      'review',
      'outer:true',
      'implement',
      'test',
      'gate:true',
      'confirm',
      'fix',
      'test',
      'gate:false',
      'review',
      'outer:false',
      'publish',
      'end',
    ]);
    expect(result.skipped).toEqual(['confirm', 'fix', 'confirm', 'fix']);
  });
});

describe('single loops in mock runs (parity with the engine)', () => {
  /** start → work → gate -true-> fix → work; gate -false-> after → end. */
  const fixLoop = (id: string): Workflow =>
    workflow(
      id,
      [
        marker('start', 'start'),
        step('work', 3),
        gate('gate', 'work', 'again', 3),
        step('fix', 2),
        step('after'),
        marker('end', 'end'),
      ],
      [
        edge('e0', 'start', 'work'),
        edge('e1', 'work', 'gate'),
        edge('e2', 'gate', 'fix', 'true'),
        edge('e3', 'gate', 'after', 'false'),
        edge('e4', 'fix', 'work'),
        edge('e5', 'after', 'end'),
      ],
    );

  it('runs the exit when the fix loops back through another step', async () => {
    const result = await runDry(fixLoop('loop-back'), {
      work: ['again', 'done'],
      fix: ['f1'],
      after: ['after'],
    });
    expect(result.status).toBe('succeeded');
    expect(result.ran).toEqual([
      'start',
      'work',
      'gate:true',
      'fix',
      'work',
      'gate:false',
      'after',
      'end',
    ]);
    expect(result.skipped).toEqual(['fix']);
  });

  it('goes round a loop-back taken straight from the condition', async () => {
    const wf = workflow(
      'direct-loop',
      [
        marker('start', 'start'),
        step('fix', 3),
        gate('cond', 'fix', 'again', 3),
        marker('end', 'end'),
      ],
      [
        edge('e0', 'start', 'fix'),
        edge('e1', 'fix', 'cond'),
        edge('e2', 'cond', 'fix', 'true'),
        edge('e3', 'cond', 'end', 'false'),
      ],
    );
    const result = await runDry(wf, { fix: ['again', 'done'] });
    expect(result.status).toBe('succeeded');
    expect(result.ran).toEqual(['start', 'fix', 'cond:true', 'fix', 'cond:false', 'end']);
    expect(result.skipped).toEqual([]);
  });

  it('releases the exit when the loop ends through a failure route', async () => {
    const wf = fixLoop('loop-rescue');
    wf.nodes.push(step('rescue'));
    wf.edges.push(edge('e6', 'fix', 'rescue', 'failure'), edge('e7', 'rescue', 'end'));
    const result = await runDry(wf, {
      work: ['again'],
      fix: ['fail'],
      rescue: ['rescue'],
    });
    expect(result.status).toBe('succeeded');
    expect(result.ran).toEqual([
      'start',
      'work',
      'gate:true',
      'fix:failed',
      'rescue',
      'end',
    ]);
    expect(result.skipped).toEqual(['after']);
  });

  it('still reaches the steps after the loop when the first pass failed into the fix', async () => {
    const wf = workflow(
      'fail-into-fix',
      [
        marker('start', 'start'),
        step('tests', 3),
        gate('gate', 'tests', 'warn', 3),
        step('fix', 2),
        step('publish'),
        marker('end', 'end'),
      ],
      [
        edge('e0', 'start', 'tests'),
        edge('e1', 'tests', 'gate'),
        edge('e2', 'tests', 'fix', 'failure'),
        edge('e3', 'gate', 'fix', 'true'),
        edge('e4', 'fix', 'tests'),
        edge('e5', 'gate', 'publish', 'false'),
        edge('e6', 'publish', 'end'),
      ],
    );
    const result = await runDry(wf, {
      tests: ['fail', 'ok'],
      fix: ['f1'],
      publish: ['publish'],
    });
    expect(result.status).toBe('succeeded');
    expect(result.ran).toEqual([
      'start',
      'tests:failed',
      'fix',
      'tests',
      'gate:false',
      'publish',
      'end',
    ]);
    expect(result.skipped).toEqual(['gate', 'fix']);
  });

  /** fixLoop plus work -failure-> rescue → end (or → approve → end). */
  const lateFailure = (id: string, withApproval: boolean): Workflow => {
    const wf = fixLoop(id);
    wf.nodes.push(step('rescue'));
    wf.edges.push(edge('e6', 'work', 'rescue', 'failure'));
    if (withApproval) {
      wf.nodes.push(approval('approve', 1));
      wf.edges.push(edge('e7', 'rescue', 'approve'), edge('e8', 'approve', 'end'));
    } else wf.edges.push(edge('e7', 'rescue', 'end'));
    return wf;
  };

  it('takes a failure route on a later pass that an earlier pass did not take', async () => {
    const plans = { work: ['again', 'fail'], fix: ['f1'], rescue: ['rescue'] };
    const result = await runDry(lateFailure('late-failure', false), plans);
    expect(result.status).toBe('succeeded');
    expect(result.ran).toEqual([
      'start',
      'work',
      'gate:true',
      'fix',
      'work:failed',
      'rescue',
      'end',
    ]);
    expect(result.skipped).toEqual(['gate', 'fix', 'after']);
    // Pausing after the failure route replays the history to the same end.
    const paused = await runDry(lateFailure('late-failure-approval', true), plans);
    expect(paused.pauses).toBe(1);
    expect(paused.status).toBe('succeeded');
    expect(paused.ran).toEqual([
      'start',
      'work',
      'gate:true',
      'fix',
      'work:failed',
      'rescue',
      'approve',
      'end',
    ]);
    expect(paused.skipped).toEqual(['gate', 'fix', 'after']);
  });

  it('waits at a join after a loop for its other branch', async () => {
    // lint is defined after the loop, so it runs once the loop is done, as
    // the engine's slow lint does.
    const wf = workflow(
      'join-after-loop',
      [
        marker('start', 'start'),
        step('work', 3),
        gate('gate', 'work', 'again', 3),
        step('fix', 2),
        step('lint'),
        step('report'),
        marker('end', 'end'),
      ],
      [
        edge('e0', 'start', 'work'),
        edge('e1', 'start', 'lint'),
        edge('e2', 'work', 'gate'),
        edge('e3', 'gate', 'fix', 'true'),
        edge('e4', 'fix', 'work'),
        edge('e5', 'gate', 'end', 'false'),
        edge('e6', 'work', 'report'),
        edge('e7', 'lint', 'report'),
        edge('e8', 'report', 'end'),
      ],
    );
    const result = await runDry(wf, {
      work: ['again', 'done'],
      fix: ['f1'],
      lint: ['lint-done'],
      report: ['report'],
    });
    expect(result.status).toBe('succeeded');
    expect(result.ran).toEqual([
      'start',
      'work',
      'gate:true',
      'fix',
      'work',
      'gate:false',
      'lint',
      'report',
      'end',
    ]);
    expect(result.skipped).toEqual(['fix']);
  });

  it('fails a step whose failure route already ran on an earlier pass', async () => {
    // head → work and check (both into gate); gate -true-> fix → head.
    // work fails on both passes; its route, rescue, ran on the first. The
    // engine runs check and rescue alongside work, so its trace interleaves
    // them differently; status, error and rescue's single run match.
    const wf = workflow(
      'route-already-ran',
      [
        marker('start', 'start'),
        step('head', 3),
        step('work', 3),
        step('rescue'),
        step('check', 3),
        gate('gate', 'check', 'again', 3),
        step('fix', 2),
        marker('end', 'end'),
      ],
      [
        edge('e0', 'start', 'head'),
        edge('e1', 'head', 'work'),
        edge('e2', 'head', 'check'),
        edge('e3', 'work', 'gate'),
        edge('e4', 'check', 'gate'),
        edge('e5', 'gate', 'fix', 'true'),
        edge('e6', 'fix', 'head'),
        edge('e7', 'gate', 'end', 'false'),
        edge('e8', 'work', 'rescue', 'failure'),
        edge('e9', 'rescue', 'end'),
      ],
    );
    const result = await runDry(wf, {
      head: ['h1', 'h2'],
      work: ['fail', 'fail'],
      rescue: ['rescue'],
      check: ['again', 'again'],
      fix: ['f1'],
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBe("Node 'work' failed and its failure route already ran.");
    expect(result.ran).toEqual([
      'start',
      'head',
      'work:failed',
      'rescue',
      'check',
      'gate:true',
      'fix',
      'head',
      'work:failed',
    ]);
  });

  // The engine's resume_replays_steps_in_the_order_they_finished guards rows
  // that finish out of dispatch order. Mock steps finish in the order they
  // start, so that ordering cannot arise here.
});
