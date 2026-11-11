import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setMockBackendForTests, type Backend } from './backend';
import { createDefaultProfile } from './agents';
import { CURRENT_SCHEMA_VERSION, type StoredNodeResult, type Workflow } from './workflow';

// The mock backend handles feedback like the engine; each case mirrors one in
// crates/core/src/feedback_engine_tests.rs (dry runs with fixtures).

const at = { x: 0, y: 0 };

function decisionText(decision: 'change' | 'satisfied' | 'unclear'): string {
  if (decision === 'unclear') return 'I am not sure.';
  return (
    'Checked.\n```orchevia-feedback\n' +
    JSON.stringify(
      decision === 'change'
        ? {
            decision: 'change',
            explanation: 'Old keys are ignored.',
            change: 'Read the old config keys as a fallback.',
          }
        : { decision: 'satisfied', explanation: 'Old config keys are still read.' },
    ) +
    '\n```'
  );
}

/** start → impl (AI) → tests → approve → push (publishes) → end */
function approvalWorkflow(maxCorrectionRounds?: number): Workflow {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'wf-feedback',
    name: 'Feedback',
    ...(maxCorrectionRounds === undefined ? {} : { limits: { maxCorrectionRounds } }),
    nodes: [
      { id: 'start', type: 'start', position: at, config: {} },
      {
        id: 'impl',
        type: 'agent',
        label: 'Implement',
        position: at,
        config: { agentProfileId: 'fake', prompt: 'Change it.' },
      },
      {
        id: 'tests',
        type: 'command',
        position: at,
        config: { executable: 'never-runs' },
      },
      { id: 'approve', type: 'approval', position: at, config: {} },
      {
        id: 'push',
        type: 'command',
        label: 'Push branch',
        position: at,
        config: { executable: 'never-runs', publishes: true },
      },
      { id: 'end', type: 'end', position: at, config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'impl' },
      { id: 'e2', source: 'impl', target: 'tests' },
      { id: 'e3', source: 'tests', target: 'approve' },
      { id: 'e4', source: 'approve', target: 'push' },
      { id: 'e5', source: 'push', target: 'end' },
    ],
  };
}

function fixtures(
  checks: ('change' | 'satisfied' | 'unclear')[],
): Record<string, unknown> {
  return {
    impl: [
      { status: 'succeeded', stdout: 'v1' },
      { status: 'succeeded', stdout: 'v2' },
    ],
    tests: [
      { status: 'succeeded', stdout: 'ok 1' },
      { status: 'succeeded', stdout: 'ok 2' },
    ],
    push: [{ status: 'succeeded', stdout: 'pushed' }],
    'feedback:impl': checks.map((c) => ({
      status: 'succeeded',
      stdout: decisionText(c),
    })),
  };
}

let backend: Backend;

async function start(
  wf: Workflow,
  checks: ('change' | 'satisfied' | 'unclear')[] = ['change', 'change'],
): Promise<string> {
  backend = __setMockBackendForTests();
  await backend.saveAgentProfile({ ...createDefaultProfile('claude'), id: 'fake' });
  await backend.saveWorkflow(wf);
  const { runId } = await backend.runWorkflow(
    wf.id,
    {},
    { dryRun: true, fixtures: fixtures(checks) as never },
  );
  await vi.runAllTimersAsync();
  return runId;
}

async function approve(runId: string): Promise<void> {
  await backend.approveRun(runId, true);
  await vi.runAllTimersAsync();
}

function outputs(rows: StoredNodeResult[], node: string): string[] {
  return rows
    .filter((r) => r.nodeId === node && r.status === 'succeeded')
    .map((r) => r.stdout);
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('mock feedback during a run', () => {
  it('corrects the step, reruns what uses it and asks the approval again', async () => {
    const runId = await start(approvalWorkflow());
    expect((await backend.getRun(runId))?.status).toBe('paused');
    const item = await backend.submitStepFeedback(runId, 'impl', '  Keep old keys.  ');
    expect(item).toMatchObject({ status: 'pending', text: 'Keep old keys.' });
    await approve(runId);
    // Asked again, after the feedback was addressed.
    expect((await backend.getRun(runId))?.status).toBe('paused');
    const [handled] = await backend.listRunFeedback(runId);
    expect(handled).toMatchObject({
      status: 'addressed',
      targetNodeId: 'impl',
      round: 1,
    });
    let rows = await backend.getRunResults(runId);
    expect(outputs(rows, 'impl')).toEqual(['v1', 'v2']);
    expect(outputs(rows, 'tests')).toEqual(['ok 1', 'ok 2']);
    expect(outputs(rows, 'push')).toEqual([]);
    const correction = rows.find((r) => r.stdout === 'v2');
    expect(JSON.parse(correction?.structuredJson ?? '{}')).toMatchObject({
      correction: { feedbackIds: [item.id], round: 1 },
      simulated: true,
    });
    const check = rows.find((r) => r.status === 'checked');
    expect(handled?.checkResultId).toBe(check?.id);
    expect(JSON.parse(check?.structuredJson ?? '{}')).toMatchObject({
      feedbackCheck: {
        decision: 'change',
        change: 'Read the old config keys as a fallback.',
      },
    });
    expect(rows.some((r) => r.nodeId === '__feedback' && r.status === 'correcting')).toBe(
      true,
    );
    await approve(runId);
    rows = await backend.getRunResults(runId);
    expect((await backend.getRun(runId))?.status).toBe('succeeded');
    expect(outputs(rows, 'push')).toEqual(['pushed']);
    expect((await backend.getRun(runId))?.execution?.feedback).toMatchObject({
      rounds: 1,
      publicationStarted: { nodeId: 'push', label: 'Push branch' },
      closed: true,
    });
  });

  it('records satisfied feedback without rerunning anything', async () => {
    const runId = await start(approvalWorkflow(), ['satisfied']);
    await backend.submitStepFeedback(runId, 'tests', 'Is the old config kept?');
    await approve(runId);
    expect((await backend.getRun(runId))?.status).toBe('succeeded');
    const [item] = await backend.listRunFeedback(runId);
    expect(item).toMatchObject({
      status: 'satisfied',
      targetNodeId: 'impl',
      decision: 'Old config keys are still read.',
    });
    expect(outputs(await backend.getRunResults(runId), 'impl')).toEqual(['v1']);
  });

  it('pauses at the round limit and continues as it is', async () => {
    const runId = await start(approvalWorkflow(1));
    await backend.submitStepFeedback(runId, 'impl', 'First.');
    await approve(runId);
    const second = await backend.submitStepFeedback(runId, 'impl', 'Second.');
    await approve(runId);
    const run = await backend.getRun(runId);
    expect(run?.status).toBe('paused');
    const items = await backend.listRunFeedback(runId);
    expect(items.find((i) => i.id === second.id)).toMatchObject({
      status: 'needs-attention',
      acknowledged: false,
    });
    expect(items.find((i) => i.id === second.id)?.decision).toContain(
      '1 correction round',
    );
    const pause = run?.execution?.feedback?.pause;
    if (pause === undefined) throw new Error('feedback pause expected');
    // An approval cannot clear a feedback pause.
    await expect(backend.approveRun(runId, true)).rejects.toThrow('not paused');
    await expect(backend.continueFeedbackRun(runId, pause.id + 1)).rejects.toThrow();
    await backend.continueFeedbackRun(runId, pause.id);
    await vi.runAllTimersAsync();
    expect((await backend.getRun(runId))?.status).toBe('succeeded');
    expect(
      (await backend.listRunFeedback(runId)).find((i) => i.id === second.id)
        ?.acknowledged,
    ).toBe(true);
    expect(outputs(await backend.getRunResults(runId), 'impl')).toEqual(['v1', 'v2']);
  });

  it('pauses when a check cannot decide', async () => {
    const runId = await start(approvalWorkflow(), ['unclear']);
    await backend.submitStepFeedback(runId, 'impl', 'x');
    await approve(runId);
    expect((await backend.getRun(runId))?.status).toBe('paused');
    const [item] = await backend.listRunFeedback(runId);
    expect(item?.status).toBe('needs-attention');
    expect(item?.decision).toContain('decision block');
  });

  it('records feedback after publishing started as late', async () => {
    const wf = approvalWorkflow();
    // push before the approval: the run pauses after publishing.
    wf.edges = [
      { id: 'e1', source: 'start', target: 'impl' },
      { id: 'e2', source: 'impl', target: 'tests' },
      { id: 'e3', source: 'tests', target: 'push' },
      { id: 'e4', source: 'push', target: 'approve' },
      { id: 'e5', source: 'approve', target: 'end' },
    ];
    const runId = await start(wf);
    const late = await backend.submitStepFeedback(runId, 'impl', 'Too late?');
    expect(late.status).toBe('late');
    expect(late.decision).toContain('"Push branch" started publishing');
    await approve(runId);
    expect((await backend.getRun(runId))?.status).toBe('succeeded');
    expect(outputs(await backend.getRunResults(runId), 'impl')).toEqual(['v1']);
  });

  it('refuses feedback the core refuses', async () => {
    const runId = await start(approvalWorkflow());
    await expect(backend.submitStepFeedback(runId, 'push', 'x')).rejects.toThrow(
      'once it has started',
    );
    await expect(backend.submitStepFeedback(runId, 'impl', '  ')).rejects.toThrow(
      'Write the feedback first.',
    );
    await expect(backend.submitStepFeedback(runId, 'impl', 'x', 9999)).rejects.toThrow(
      'does not belong',
    );
    await expect(backend.submitStepFeedback('missing', 'impl', 'x')).rejects.toThrow();
    for (let n = 0; n < 50; n++)
      await backend.submitStepFeedback(runId, 'impl', `n${String(n)}`);
    await expect(backend.submitStepFeedback(runId, 'impl', 'one more')).rejects.toThrow(
      'at most 50',
    );
    await backend.cancelRun(runId);
    expect(
      (await backend.listRunFeedback(runId)).every((i) => i.status === 'not-processed'),
    ).toBe(true);
    await expect(backend.submitStepFeedback(runId, 'impl', 'x')).rejects.toThrow(
      'finished',
    );
  });
});

describe('mock feedback in loops and across restarts', () => {
  it('gives a fix loop fresh passes after a correction, like the engine', async () => {
    const wf: Workflow = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: 'wf-loop',
      name: 'Loop',
      nodes: [
        { id: 'start', type: 'start', position: at, config: {} },
        {
          id: 'impl',
          type: 'agent',
          position: at,
          config: { agentProfileId: 'fake', prompt: 'Change it.' },
        },
        {
          id: 'tests',
          type: 'command',
          position: at,
          config: { executable: 'never-runs', maxVisits: 2 },
        },
        {
          id: 'gate',
          type: 'condition',
          position: at,
          config: {
            maxVisits: 2,
            condition: {
              logic: 'and',
              clauses: [{ left: 'node.tests.output', op: 'contains', right: 'FAIL' }],
            },
          },
        },
        {
          id: 'fix',
          type: 'agent',
          position: at,
          config: { agentProfileId: 'fake', prompt: 'Fix it.', maxVisits: 2 },
        },
        { id: 'approve', type: 'approval', position: at, config: {} },
        {
          id: 'push',
          type: 'command',
          position: at,
          config: { executable: 'never-runs', publishes: true },
        },
        { id: 'end', type: 'end', position: at, config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'impl' },
        { id: 'e2', source: 'impl', target: 'tests' },
        { id: 'e3', source: 'tests', target: 'gate' },
        { id: 'e4', source: 'gate', target: 'fix', label: 'true' },
        { id: 'e5', source: 'fix', target: 'tests' },
        { id: 'e6', source: 'gate', target: 'approve', label: 'false' },
        { id: 'e7', source: 'approve', target: 'push' },
        { id: 'e8', source: 'push', target: 'end' },
      ],
    };
    backend = __setMockBackendForTests();
    await backend.saveAgentProfile({ ...createDefaultProfile('claude'), id: 'fake' });
    await backend.saveWorkflow(wf);
    const ok = (stdout: string): { status: string; stdout: string } => ({
      status: 'succeeded',
      stdout,
    });
    const { runId } = await backend.runWorkflow(
      wf.id,
      {},
      {
        dryRun: true,
        fixtures: {
          impl: [ok('v1'), ok('v2')],
          tests: [ok('FAIL'), ok('ok'), ok('FAIL'), ok('ok')],
          fix: [ok('fixed 1'), ok('fixed 2')],
          push: [ok('pushed')],
          'feedback:impl': [ok(decisionText('change'))],
        },
      },
    );
    await vi.runAllTimersAsync();
    await backend.submitStepFeedback(runId, 'impl', 'Keep old keys.');
    await approve(runId);
    expect((await backend.getRun(runId))?.status).toBe('paused');
    let rows = await backend.getRunResults(runId);
    expect(outputs(rows, 'tests')).toEqual(['FAIL', 'ok', 'FAIL', 'ok']);
    expect(outputs(rows, 'fix')).toEqual(['fixed 1', 'fixed 2']);
    await approve(runId);
    rows = await backend.getRunResults(runId);
    expect((await backend.getRun(runId))?.status).toBe('succeeded');
    expect(outputs(rows, 'push')).toEqual(['pushed']);
  });

  it('leaves open feedback not processed after a restart and carries it on recovery', async () => {
    const runId = await start(approvalWorkflow());
    await backend.submitStepFeedback(runId, 'impl', 'Keep old keys.');
    // Simulate a restart: the stored run says running.
    const stored = JSON.parse(
      localStorage.getItem('orchevia.mock-backend.v1') ?? '{}',
    ) as {
      runs: { id: string; status: string }[];
    };
    const run = stored.runs.find((r) => r.id === runId);
    if (run) run.status = 'running';
    localStorage.setItem('orchevia.mock-backend.v1', JSON.stringify(stored));
    backend = __setMockBackendForTests();
    expect((await backend.getRun(runId))?.status).toBe('failed');
    const [item] = await backend.listRunFeedback(runId);
    expect(item?.status).toBe('not-processed');
    expect(item?.decision).toContain('restarted');
  });
});

describe('mock feedback and recovery', () => {
  it('reuses the corrected result when recovering a run that failed after a correction', async () => {
    const runId = await start(approvalWorkflow());
    await backend.submitStepFeedback(runId, 'impl', 'Keep old keys.');
    await approve(runId);
    await backend.approveRun(runId, false);
    await vi.runAllTimersAsync();
    expect((await backend.getRun(runId))?.status).toBe('failed');
    const plan = await backend.previewRecovery(runId);
    const choices = Object.fromEntries(
      plan.nodes.map((n) => [n.nodeId, n.choices.includes('reuse') ? 'reuse' : 'replay']),
    ) as Record<string, 'reuse' | 'replay'>;
    const { runId: recovered } = await backend.recoverRun(
      runId,
      choices,
      plan.fingerprint,
      'req-1',
    );
    await vi.runAllTimersAsync();
    const rows = await backend.getRunResults(recovered);
    expect(outputs(rows, 'impl')[0]).toBe('v2');
    expect(outputs(rows, 'tests')[0]).toBe('ok 2');
  });

  it('refuses feedback on a skipped step', async () => {
    const wf = approvalWorkflow();
    wf.nodes.push({
      id: 'island',
      type: 'command',
      position: at,
      config: { executable: 'x' },
    });
    const runId = await start(wf);
    expect((await backend.getRunResults(runId)).some((r) => r.nodeId === 'island')).toBe(
      true,
    );
    await expect(backend.submitStepFeedback(runId, 'island', 'x')).rejects.toThrow(
      'once it has started',
    );
  });
});

describe('mock correction inside a fix loop', () => {
  it('reruns what follows the corrected review in order, like the engine', async () => {
    const wf: Workflow = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: 'wf-review-loop',
      name: 'Review loop',
      nodes: [
        { id: 'start', type: 'start', position: at, config: {} },
        {
          id: 'impl',
          type: 'agent',
          position: at,
          config: { agentProfileId: 'fake', prompt: 'x' },
        },
        {
          id: 'tests',
          type: 'command',
          position: at,
          config: { executable: 'x', maxVisits: 3 },
        },
        {
          id: 'review',
          type: 'agent',
          position: at,
          config: { agentProfileId: 'fake', prompt: 'Review it.', maxVisits: 3 },
        },
        {
          id: 'gate',
          type: 'condition',
          position: at,
          config: {
            maxVisits: 3,
            condition: {
              logic: 'and',
              clauses: [{ left: 'node.review.output', op: 'contains', right: 'CHANGES' }],
            },
          },
        },
        {
          id: 'fix',
          type: 'agent',
          position: at,
          config: { agentProfileId: 'fake', prompt: 'Fix it.', maxVisits: 3 },
        },
        { id: 'approve', type: 'approval', position: at, config: {} },
        {
          id: 'push',
          type: 'command',
          position: at,
          config: { executable: 'x', publishes: true },
        },
        { id: 'end', type: 'end', position: at, config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'impl' },
        { id: 'e2', source: 'impl', target: 'tests' },
        { id: 'e3', source: 'tests', target: 'review' },
        { id: 'e4', source: 'review', target: 'gate' },
        { id: 'e5', source: 'gate', target: 'fix', label: 'true' },
        { id: 'e6', source: 'fix', target: 'tests' },
        { id: 'e7', source: 'gate', target: 'approve', label: 'false' },
        { id: 'e8', source: 'approve', target: 'push' },
        { id: 'e9', source: 'push', target: 'end' },
      ],
    };
    backend = __setMockBackendForTests();
    await backend.saveAgentProfile({ ...createDefaultProfile('claude'), id: 'fake' });
    await backend.saveWorkflow(wf);
    const ok = (stdout: string): { status: string; stdout: string } => ({
      status: 'succeeded',
      stdout,
    });
    const { runId } = await backend.runWorkflow(
      wf.id,
      {},
      {
        dryRun: true,
        fixtures: {
          impl: [ok('v1')],
          tests: [ok('ok 1'), ok('ok 2')],
          review: [ok('clean 1'), ok('CHANGES needed'), ok('clean 2')],
          fix: [ok('fixed')],
          push: [ok('pushed')],
          'feedback:review': [ok(decisionText('change'))],
        },
      },
    );
    await vi.runAllTimersAsync();
    await backend.submitStepFeedback(runId, 'review', 'Check the old config path too.');
    await approve(runId);
    const rows = await backend.getRunResults(runId);
    const marker = rows.find((r) => r.nodeId === '__feedback');
    expect(JSON.parse(marker?.structuredJson ?? '{}')).toMatchObject({
      feedbackRound: { refreshed: ['tests'] },
    });
    const after = rows
      .filter(
        (r) => r.id > (marker?.id ?? 0) && ['succeeded', 'approved'].includes(r.status),
      )
      .map((r) =>
        r.stdout === 'true' || r.stdout === 'false'
          ? `${r.nodeId}:${r.stdout}`
          : r.nodeId,
      );
    expect(after).toEqual([
      'review',
      'gate:true',
      'fix',
      'tests',
      'review',
      'gate:false',
    ]);
    await approve(runId);
    expect((await backend.getRun(runId))?.status).toBe('succeeded');
  });
});

describe('mock carried feedback after a rejection', () => {
  it('closes feedback on rejection and corrects a step the recovery reused', async () => {
    const runId = await start(approvalWorkflow());
    await backend.submitStepFeedback(runId, 'impl', 'Keep old keys.');
    await backend.approveRun(runId, false);
    await vi.runAllTimersAsync();
    const [closed] = await backend.listRunFeedback(runId);
    expect(closed?.status).toBe('not-processed');
    expect(closed?.decision).toContain('rejected');
    const plan = await backend.previewRecovery(runId);
    const choices = Object.fromEntries(
      plan.nodes.map((n) => [n.nodeId, n.choices.includes('reuse') ? 'reuse' : 'replay']),
    ) as Record<string, 'reuse' | 'replay'>;
    const { runId: recovered } = await backend.recoverRun(
      runId,
      choices,
      plan.fingerprint,
      'req-carry',
    );
    await vi.runAllTimersAsync();
    const [carried] = await backend.listRunFeedback(recovered);
    expect(carried?.status).toBe('addressed');
    expect(outputs(await backend.getRunResults(recovered), 'impl')).toEqual(['v1', 'v2']);
  });
});

describe('mock corrections across approvals and skipped publishing', () => {
  const two = (): Workflow => ({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'wf-two',
    name: 'Two approvals',
    nodes: [
      { id: 'start', type: 'start', position: at, config: {} },
      {
        id: 'a',
        type: 'agent',
        position: at,
        config: { agentProfileId: 'fake', prompt: 'A' },
      },
      { id: 'first', type: 'approval', position: at, config: {} },
      {
        id: 'b',
        type: 'agent',
        position: at,
        config: { agentProfileId: 'fake', prompt: 'B' },
      },
      { id: 'second', type: 'approval', position: at, config: {} },
      {
        id: 'push',
        type: 'command',
        position: at,
        config: { executable: 'x', publishes: true },
      },
      { id: 'end', type: 'end', position: at, config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'a' },
      { id: 'e2', source: 'a', target: 'first' },
      { id: 'e3', source: 'first', target: 'b' },
      { id: 'e4', source: 'b', target: 'second' },
      { id: 'e5', source: 'second', target: 'push' },
      { id: 'e6', source: 'push', target: 'end' },
    ],
  });

  it('keeps a later correction open across an approval it must wait for', async () => {
    backend = __setMockBackendForTests();
    await backend.saveAgentProfile({ ...createDefaultProfile('claude'), id: 'fake' });
    const wf = two();
    await backend.saveWorkflow(wf);
    const ok = (stdout: string): { status: string; stdout: string } => ({
      status: 'succeeded',
      stdout,
    });
    const { runId } = await backend.runWorkflow(
      wf.id,
      {},
      {
        dryRun: true,
        fixtures: {
          a: [ok('a1'), ok('a2')],
          b: [ok('b1'), ok('b2')],
          push: [ok('pushed')],
          'feedback:a': [ok(decisionText('change'))],
          'feedback:b': [ok(decisionText('change'))],
        },
      },
    );
    await vi.runAllTimersAsync();
    await approve(runId);
    const onA = await backend.submitStepFeedback(runId, 'a', 'Fix A.');
    const onB = await backend.submitStepFeedback(runId, 'b', 'Fix B.');
    await approve(runId);
    const status = async (id: number): Promise<string | undefined> =>
      (await backend.listRunFeedback(runId)).find((i) => i.id === id)?.status;
    expect(await status(onA.id)).toBe('addressed');
    expect(await status(onB.id)).toBe('correcting');
    await approve(runId);
    expect(await status(onB.id)).toBe('addressed');
    await approve(runId);
    expect((await backend.getRun(runId))?.status).toBe('succeeded');
    expect(outputs(await backend.getRunResults(runId), 'push')).toEqual(['pushed']);
  });
});

it('does not close the feedback window for a publishing step recovery skips', async () => {
  const wf = approvalWorkflow();
  wf.nodes.push({
    id: 'lint',
    type: 'command',
    position: at,
    config: { executable: 'x' },
  });
  wf.edges = [
    { id: 'e1', source: 'start', target: 'impl' },
    { id: 'e2', source: 'impl', target: 'tests' },
    { id: 'e3', source: 'tests', target: 'push' },
    { id: 'e4', source: 'push', target: 'approve' },
    { id: 'e5', source: 'approve', target: 'end' },
    { id: 'e6', source: 'start', target: 'lint' },
    { id: 'e7', source: 'lint', target: 'approve' },
  ];
  backend = __setMockBackendForTests();
  await backend.saveAgentProfile({ ...createDefaultProfile('claude'), id: 'fake' });
  await backend.saveWorkflow(wf);
  const { runId } = await backend.runWorkflow(
    wf.id,
    {},
    {
      dryRun: true,
      fixtures: {
        ...(fixtures(['change']) as Record<string, { status: string; stdout: string }[]>),
        lint: [{ status: 'succeeded', stdout: 'lint ok' }],
      },
    },
  );
  await vi.runAllTimersAsync();
  await backend.approveRun(runId, false);
  const plan = await backend.previewRecovery(runId);
  const choices = Object.fromEntries(
    plan.nodes.map((n) => [
      n.nodeId,
      n.nodeId === 'push' ? 'skip' : n.choices.includes('reuse') ? 'reuse' : 'replay',
    ]),
  ) as Record<string, 'reuse' | 'replay' | 'skip'>;
  const { runId: recovered } = await backend.recoverRun(
    runId,
    choices,
    plan.fingerprint,
    'req-skip',
  );
  await vi.runAllTimersAsync();
  expect((await backend.getRun(recovered))?.status).toBe('paused');
  expect((await backend.getRun(recovered))?.execution?.feedback?.publicationStarted).toBe(
    undefined,
  );
  const item = await backend.submitStepFeedback(recovered, 'impl', 'Still in time.');
  expect(item.status).toBe('pending');
});
