import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __setMockBackendForTests } from './backend';
import { createDefaultProfile } from './agents';
import { createEmptyWorkflow } from './workflow';
import { builtinTemplates, instantiateTemplateLocal } from './templates';
import type { StoredNodeResult, StoredRun } from './workflow';

function analyticsBackend(
  rows: Partial<StoredNodeResult>[],
  startedAt = '2026-10-01T00:00:00.000Z',
): ReturnType<typeof __setMockBackendForTests> {
  localStorage.clear();
  const definition = createEmptyWorkflow('Recorded name');
  definition.nodes.push({ id: 'a', type: 'agent', position: { x: 0, y: 0 }, config: {} });
  const run: StoredRun = {
    id: 'analytics',
    workflowId: definition.id,
    status: 'succeeded',
    startedAt,
  };
  localStorage.setItem(
    'orchevia.mock-backend.v1',
    JSON.stringify({
      workflows: [
        {
          id: definition.id,
          name: definition.name,
          definition,
          createdAt: startedAt,
          updatedAt: startedAt,
        },
      ],
      runs: [run],
      runWorkflows: [[run.id, definition]],
      results: [
        [
          run.id,
          rows.map((row, i) => ({
            id: i + 1,
            runId: run.id,
            nodeId: 'a',
            status: 'succeeded',
            attempt: 1,
            stdout: '',
            stderr: '',
            startedAt,
            ...row,
          })),
        ],
      ],
    }),
  );
  return __setMockBackendForTests();
}

it('usage analytics counts loop visits while excluding undispatched Agent rows', async () => {
  const usage = JSON.stringify({
    agentUsage: { adapter: 'claude', model: 'm', reported_cost_usd: 2 },
  });
  const backend = analyticsBackend([
    { structuredJson: usage },
    { structuredJson: usage },
    { status: 'skipped' },
    { status: 'guardPaused' },
  ]);
  const summary = await backend.usageSummary();
  expect(summary.totals.agentAttempts).toBe(2);
  expect(summary.totals.reportedUsd).toBe(4);
  expect(summary.totals.unknownUsdAttempts).toBe(0);
});

it('attributes profile usage to saved run nodes, including deleted and unknown profiles', async () => {
  localStorage.clear();
  const snapshot = createEmptyWorkflow('Recorded workflow');
  snapshot.nodes.push(
    {
      id: 'a',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { agentProfileId: 'p1' },
    },
    {
      id: 'b',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { agentProfileId: 'deleted-profile' },
    },
    { id: 'legacy', type: 'agent', position: { x: 0, y: 0 }, config: {} },
  );
  const current = structuredClone(snapshot);
  current.name = 'Renamed workflow';
  const currentAgent = current.nodes.find((node) => node.id === 'a');
  if (currentAgent) currentAgent.config.agentProfileId = 'deleted-profile';
  const first = '2026-10-01T00:00:00.000Z';
  const last = '2026-10-02T00:00:00.000Z';
  const runs: StoredRun[] = [
    { id: 'r1', workflowId: snapshot.id, startedAt: first, status: 'succeeded' },
    { id: 'r2', workflowId: snapshot.id, startedAt: last, status: 'succeeded' },
    { id: 'old', workflowId: snapshot.id, startedAt: first, status: 'succeeded' },
  ];
  const envelope = (cost?: number): string =>
    JSON.stringify({
      agentUsage: {
        adapter: 'claude',
        model: 'shared',
        ...(cost !== undefined ? { reported_cost_usd: cost } : {}),
      },
    });
  const row = (
    id: number,
    runId: string,
    nodeId: string,
    durationMs: number,
    structuredJson: string,
    status: StoredNodeResult['status'] = 'succeeded',
  ): StoredNodeResult => ({
    id,
    runId,
    nodeId,
    durationMs,
    structuredJson,
    status,
    attempt: 1,
    startedAt: first,
    stdout: '',
    stderr: '',
  });
  localStorage.setItem(
    'orchevia.mock-backend.v1',
    JSON.stringify({
      workflows: [
        {
          id: current.id,
          name: current.name,
          definition: current,
          createdAt: first,
          updatedAt: last,
        },
      ],
      profiles: [
        { ...createDefaultProfile('claude'), id: 'p1', name: 'Current renamed profile' },
      ],
      runs,
      runWorkflows: [
        ['r1', snapshot],
        ['r2', snapshot],
      ],
      results: [
        [
          'r1',
          [
            row(1, 'r1', 'a', 100, envelope(1)),
            row(2, 'r1', 'a', 200, envelope(), 'retrying'),
            row(3, 'r1', 'a', 300, envelope(0)),
            row(4, 'r1', 'b', 400, envelope(2)),
            row(
              5,
              'r1',
              'legacy',
              500,
              JSON.stringify({ agentUsage: { adapter: 'custom', model: 'text' } }),
              'failed',
            ),
            row(6, 'r1', 'a', 900, JSON.stringify({ reusedFrom: 'previous' })),
            row(7, 'r1', 'a', 900, JSON.stringify({ simulated: true })),
            row(8, 'r1', 'a', 900, '{}', 'guardPaused'),
            row(9, 'r1', 'a', 900, JSON.stringify({ notDispatched: true }), 'failed'),
          ],
        ],
        ['r2', [row(10, 'r2', 'a', 600, envelope(3))]],
        // Missing historical snapshot: today's assignment is not evidence.
        ['old', [row(11, 'old', 'a', 700, envelope())]],
      ],
    }),
  );
  const backend = __setMockBackendForTests();
  const summary = await backend.usageSummary();
  expect(summary).toHaveProperty('byProfile');
  expect(summary.byProfile).toEqual([
    {
      profileId: 'p1',
      runs: 2,
      agentAttempts: 4,
      totalDurationMs: 1200,
      lastRunAt: last,
      reportedUsd: 4,
      reportedUsdAttempts: 3,
      unknownUsdAttempts: 1,
    },
    {
      profileId: null,
      runs: 2,
      agentAttempts: 2,
      totalDurationMs: 1200,
      lastRunAt: first,
      reportedUsd: 0,
      reportedUsdAttempts: 0,
      unknownUsdAttempts: 2,
    },
    {
      profileId: 'deleted-profile',
      runs: 1,
      agentAttempts: 1,
      totalDurationMs: 400,
      lastRunAt: first,
      reportedUsd: 2,
      reportedUsdAttempts: 1,
      unknownUsdAttempts: 0,
    },
  ]);
  expect(summary.totals.agentAttempts).toBe(7);
  expect(summary.totals.reportedUsd).toBe(6);
  expect(summary.byModel).toHaveLength(2);
  for (const filter of [
    { adapters: ['codex'] },
    { models: ['other'] },
    { workflowIds: ['other'] },
    { to: first },
    { from: '2026-10-03T00:00:00.000Z' },
  ])
    expect((await backend.usageSummary(filter)).byProfile).toEqual([]);
  const filtered = await backend.usageSummary({
    workflowIds: [snapshot.id],
    adapters: ['claude'],
    models: ['shared'],
    from: last,
  });
  expect(filtered.byProfile).toEqual([
    {
      profileId: 'p1',
      runs: 1,
      agentAttempts: 1,
      totalDurationMs: 600,
      lastRunAt: last,
      reportedUsd: 3,
      reportedUsdAttempts: 1,
      unknownUsdAttempts: 0,
    },
  ]);
});

it('usage analytics normalizes cache tokens by adapter and preserves missing coverage', async () => {
  const backend = analyticsBackend([
    {
      structuredJson: JSON.stringify({
        agentUsage: {
          adapter: 'codex',
          model: 'c',
          input_tokens: 23,
          cached_input_tokens: 20,
          output_tokens: 3,
        },
      }),
    },
    {
      status: 'failed',
      structuredJson: JSON.stringify({
        agentUsage: {
          adapter: 'claude',
          model: 'm',
          input_tokens: 10,
          cache_read_input_tokens: 30,
          cache_creation_input_tokens: 20,
          output_tokens: 5,
        },
      }),
    },
    {
      status: 'cancelled',
      structuredJson: JSON.stringify({
        agentUsage: { adapter: 'custom', model: 'text' },
      }),
    },
  ]);
  const summary = await backend.usageSummary();
  expect(summary.totals.inputTokens).toBe(83);
  expect(summary.totals.outputTokens).toBe(8);
  expect(summary.totals.coverage.inputTokens).toBe(2);
  expect(summary.totals.coverage.toolCalls).toBe(0);
  expect(summary.totals.coverage.subagents).toBe(0);
});

it('usage provider filters exclude unmatched runs and apply RFC3339 instants', async () => {
  const backend = analyticsBackend([
    { structuredJson: JSON.stringify({ agentUsage: { adapter: 'claude', model: 'm' } }) },
  ]);
  expect((await backend.usageSummary({ adapters: ['codex'] })).totals.runs).toBe(0);
  expect(
    (
      await backend.usageSummary({
        from: '2026-10-01T04:00:00+04:00',
        to: '2026-10-01T04:00:01+04:00',
      })
    ).totals.runs,
  ).toBe(1);
  expect(
    (await backend.usageSummary({ to: '2026-10-01T04:00:00+04:00' })).totals.runs,
  ).toBe(0);
  await expect(backend.usageSummary({ from: '2026-10-01' })).rejects.toThrow('RFC 3339');
});

it('rejects ordinary live mock starts with structural validation errors', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const wf = createEmptyWorkflow('Invalid');
  wf.edges.push({ id: 'dangling', source: 'missing', target: wf.nodes[1]!.id });
  await backend.saveWorkflow(wf);
  await expect(backend.runWorkflow(wf.id, {})).rejects.toThrow();
  expect(await backend.listRuns()).toHaveLength(0);
});

it('rejects invalid usage settings without overwriting saved values', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  await backend.setSetting('usage.planShare', '50');
  for (const value of ['101', '-1', 'NaN', 'Infinity']) {
    await expect(backend.setSetting('usage.planShare', value)).rejects.toThrow();
  }
  expect(await backend.getSetting('usage.planShare')).toBe('50');
  const plans = '{"claude":{"billing":"subscription","monthlyUsd":120,"name":"Max"}}';
  await backend.setSetting('usage.plans', plans);
  for (const value of [
    'not json',
    '{"gemini":{"billing":"api"}}',
    '{"claude":{"billing":"subscription"}}',
    '{"codex":{"billing":"api","monthlyUsd":20}}',
  ])
    await expect(backend.setSetting('usage.plans', value)).rejects.toThrow();
  expect(await backend.getSetting('usage.plans')).toBe(plans);
  // The billing-period fee lists the plans replaced are no longer settings.
  await expect(backend.setSetting('usage.subscriptionFees', '[]')).rejects.toThrow(
    'not user-configurable',
  );
});

it('keeps each provider-day whole when a run or workflow filter narrows the summary', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const first = await backend.saveWorkflow(createEmptyWorkflow('First'));
  const second = await backend.saveWorkflow(createEmptyWorkflow('Second'));
  const one = await backend.runWorkflow(first.id, {});
  const two = await backend.runWorkflow(second.id, {});
  for (const { runId } of [one, two])
    await vi.waitFor(async () =>
      expect((await backend.getRun(runId))?.status).toBe('succeeded'),
    );
  const internals = backend as unknown as {
    results: Map<string, StoredNodeResult[]>;
  };
  const agentRow = (runId: string, id: number, durationMs: number): StoredNodeResult => ({
    id,
    runId,
    nodeId: 'agent',
    status: 'succeeded',
    stdout: '',
    stderr: '',
    startedAt: new Date().toISOString(),
    attempt: 1,
    durationMs,
    structuredJson: JSON.stringify({
      agentUsage: { adapter: 'claude', model: 'm', reported_cost_usd: 1 },
    }),
  });
  internals.results.set(one.runId, [agentRow(one.runId, 9001, 3000)]);
  internals.results.set(two.runId, [agentRow(two.runId, 9002, 1000)]);
  const run = await backend.usageSummary({ runIds: [one.runId] });
  expect(run.totals.runs).toBe(1);
  expect(run.providerDays).toHaveLength(1);
  expect(run.providerDays[0]).toMatchObject({
    adapter: 'claude',
    agentAttempts: 1,
    durationMs: 3000,
    reportedUsd: 1,
    allAgentAttempts: 2,
    allDurationMs: 4000,
  });
  const workflow = await backend.usageSummary({ workflowIds: [second.id] });
  expect(workflow.providerDays[0]).toMatchObject({
    durationMs: 1000,
    allDurationMs: 4000,
  });
});

it('counts a reused dry-run command once, as reuse, like the core', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const workflow = await backend.saveWorkflow(createEmptyWorkflow('Markers'));
  const { runId } = await backend.runWorkflow(workflow.id, {});
  await vi.waitFor(async () =>
    expect((await backend.getRun(runId))?.status).toBe('succeeded'),
  );
  const internals = backend as unknown as { results: Map<string, StoredNodeResult[]> };
  internals.results.set(runId, [
    {
      id: 9100,
      runId,
      nodeId: 'cmd',
      status: 'succeeded',
      stdout: '',
      stderr: '',
      startedAt: new Date().toISOString(),
      structuredJson: JSON.stringify({ reusedFrom: 'old-run', simulated: true }),
    },
  ]);
  const summary = await backend.usageSummary({});
  expect(summary.totals.reusedResults).toBe(1);
  expect(summary.totals.simulatedResults).toBe(0);
});

describe('mock backend (browser dev)', () => {
  it('dry-runs all branches without profiles and recovers with explicit choices', async () => {
    const backend = __setMockBackendForTests();
    const workflow = createEmptyWorkflow('Dry');
    const start = workflow.nodes[0]!;
    const end = workflow.nodes[1]!;
    workflow.nodes.splice(
      1,
      0,
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
        config: { executable: 'must-never-run' },
      },
    );
    workflow.edges = [
      { id: 'sa', source: start.id, target: 'a' },
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'be', source: 'b', target: end.id },
    ];
    await backend.saveWorkflow(workflow);
    const { runId } = await backend.runWorkflow(
      workflow.id,
      {},
      {
        dryRun: true,
        fixtures: {
          a: [{ status: 'succeeded', stdout: 'kept' }],
          b: [{ status: 'failed' }],
        },
      },
    );
    await vi.waitFor(async () =>
      expect((await backend.getRun(runId))?.status).toBe('failed'),
    );
    const plan = await backend.previewRecovery(runId);
    await expect(
      backend.recoverRun(runId, {}, plan.fingerprint, 'bad'),
    ).rejects.toThrow();
    const child = await backend.recoverRun(
      runId,
      { a: 'reuse', b: 'skip' },
      plan.fingerprint,
      'recovery',
    );
    await vi.waitFor(async () =>
      expect((await backend.getRun(child.runId))?.status).toBe('succeeded'),
    );
    expect(
      (await backend.getRunResults(child.runId)).find((r) => r.nodeId === 'a')?.stdout,
    ).toBe('kept');
    expect(
      await backend.recoverRun(
        runId,
        { a: 'reuse', b: 'skip' },
        plan.fingerprint,
        'recovery',
      ),
    ).toEqual(child);
    await backend.deleteRun(child.runId);
    const reopened = __setMockBackendForTests();
    expect(await reopened.getRun(child.runId)).toBeNull();
    const replacement = await reopened.recoverRun(
      runId,
      { a: 'reuse', b: 'skip' },
      plan.fingerprint,
      'recovery',
    );
    expect(replacement.runId).not.toBe(child.runId);
    await vi.waitFor(async () =>
      expect((await reopened.getRun(replacement.runId))?.status).toBe('succeeded'),
    );
  });
  it('closes interrupted attempt rows when browser history reopens', async () => {
    const backend = __setMockBackendForTests();
    const workflows = await backend.listWorkflows();
    localStorage.setItem(
      'orchevia.mock-backend.v1',
      JSON.stringify({
        workflows,
        runs: [
          {
            id: 'interrupted',
            workflowId: workflows[0]?.id,
            status: 'running',
            startedAt: '2026-10-08T00:00:00Z',
          },
        ],
        results: [
          [
            'interrupted',
            [
              {
                id: 1,
                runId: 'interrupted',
                nodeId: 'a',
                status: 'running',
                stdout: 'partial output',
                stderr: '',
                startedAt: '2026-10-08T00:00:00Z',
              },
            ],
          ],
        ],
      }),
    );
    const reopened = __setMockBackendForTests();
    const row = (await reopened.getRunResults('interrupted'))[0];
    expect(row?.status).toBe('failed');
    expect(row?.stdout).toBe('partial output');
    expect(row?.finishedAt).toBeDefined();
    expect((await reopened.getRun('interrupted'))?.status).toBe('failed');
  });
  it('simulates grouped sessions across approval, rotates and bounds handoffs', async () => {
    const backend = __setMockBackendForTests();
    const profile = createDefaultProfile('claude');
    await backend.saveAgentProfile(profile);
    const workflow = createEmptyWorkflow('Context');
    workflow.inputs = [{ name: 'item', required: true }];
    const start = workflow.nodes[0]!;
    const end = workflow.nodes[1]!;
    workflow.nodes.splice(
      1,
      0,
      ...['a', 'gate', 'b', 'c'].map((id) => ({
        id,
        type: id === 'gate' ? ('approval' as const) : ('agent' as const),
        position: { x: 0, y: 0 },
        config:
          id === 'gate'
            ? {}
            : {
                agentProfileId: profile.id,
                prompt:
                  id === 'b'
                    ? 'Handle {{input.item}}; prior visits {{node.a.visits}}, severity {{node.a.severity}}'
                    : 'Handle {{input.item}} P2',
                sessionGroup: 'dev-{{input.item}}',
                sessionMaxTurns: 2,
                ...(id === 'b' ? { contextRefs: ['a'], contextMaxChars: 256 } : {}),
              },
      })),
    );
    const ids = [start.id, 'a', 'gate', 'b', 'c', end.id];
    workflow.edges = ids
      .slice(1)
      .map((id, i) => ({ id: `e${String(i)}`, source: ids[i]!, target: id }));
    await backend.saveWorkflow(workflow);
    const { runId } = await backend.runWorkflow(workflow.id, { item: 'X' });
    await vi.waitFor(
      async () => expect((await backend.getRun(runId))?.status).toBe('paused'),
      { timeout: 2000 },
    );
    await backend.approveRun(runId, true);
    await vi.waitFor(
      async () => expect((await backend.getRun(runId))?.status).toBe('succeeded'),
      { timeout: 3000 },
    );
    const rows = (await backend.getRunResults(runId)).filter((row) =>
      ['a', 'b', 'c'].includes(row.nodeId),
    );
    const metadata = rows.map(
      (row) =>
        JSON.parse(row.structuredJson ?? '{}') as {
          simulated: boolean;
          agentSession: { id: string; turn: number; reused: boolean };
          agentUsage?: unknown;
        },
    );
    expect(metadata.map((m) => m.agentSession.reused)).toEqual([false, true, false]);
    expect(metadata[0]?.agentSession.id).toBe(metadata[1]?.agentSession.id);
    expect(metadata[2]?.agentSession.id).not.toBe(metadata[0]?.agentSession.id);
    expect(metadata.every((m) => m.simulated && m.agentUsage === undefined)).toBe(true);
    expect(rows[1]?.stdout).toContain('Workflow handoff excerpts');
    expect(rows[1]?.stdout).toContain('Handle X');
    expect(rows[1]?.stdout).toContain('prior visits 1, severity P2');
    const custom = {
      ...profile,
      adapter: 'custom' as const,
      executable: '/usr/bin/custom',
    };
    await backend.saveAgentProfile(custom);
    await expect(backend.runWorkflow(workflow.id, { item: 'X' })).rejects.toThrow(
      'Custom CLI',
    );
  });

  it('records unreachable skips once, including after approval replay', async () => {
    const backend = __setMockBackendForTests();
    const workflow = createEmptyWorkflow('Unreachable nodes');
    const start = workflow.nodes.find((node) => node.type === 'start');
    const end = workflow.nodes.find((node) => node.type === 'end');
    if (!start || !end) throw new Error('fixture');
    workflow.nodes.push(
      { id: 'gate', type: 'approval', position: { x: 0, y: 0 }, config: {} },
      ...['orphan', 'orphan-child', 'isolated'].map((id) => ({
        id,
        type: 'command' as const,
        position: { x: 0, y: 0 },
        config: { executable: 'false' },
      })),
    );
    workflow.edges = [
      { id: 'to-gate', source: start.id, target: 'gate' },
      { id: 'to-end', source: 'gate', target: end.id },
      { id: 'orphan-chain', source: 'orphan', target: 'orphan-child' },
      { id: 'orphan-join', source: 'orphan-child', target: end.id },
    ];
    await backend.saveWorkflow(workflow);
    const { runId } = await backend.runWorkflow(workflow.id);
    await vi.waitFor(async () =>
      expect((await backend.getRun(runId))?.status).toBe('paused'),
    );
    for (const id of ['orphan', 'orphan-child', 'isolated']) {
      expect(
        (await backend.getRunResults(runId))
          .filter((row) => row.nodeId === id)
          .map((row) => row.status),
      ).toEqual(['skipped']);
    }
    await backend.approveRun(runId, true);
    await vi.waitFor(async () =>
      expect((await backend.getRun(runId))?.status).toBe('succeeded'),
    );
    for (const id of ['orphan', 'orphan-child', 'isolated']) {
      expect(
        (await backend.getRunResults(runId))
          .filter((row) => row.nodeId === id)
          .map((row) => row.status),
      ).toEqual(['skipped']);
    }
  });

  it('pauses at every approval gate after resuming', async () => {
    const backend = __setMockBackendForTests();
    const wf = createEmptyWorkflow('Two gates');
    const start = wf.nodes.find((n) => n.type === 'start');
    const end = wf.nodes.find((n) => n.type === 'end');
    if (start === undefined || end === undefined) throw new Error('fixture broken');
    wf.nodes.push(
      ...['gate1', 'gate2'].map((id) => ({
        id,
        type: 'approval' as const,
        position: { x: 0, y: 0 },
        config: {},
      })),
    );
    wf.edges = [
      { id: 'e1', source: start.id, target: 'gate1' },
      { id: 'e2', source: 'gate1', target: 'gate2' },
      { id: 'e3', source: 'gate2', target: end.id },
    ];
    await backend.saveWorkflow(wf);
    const { runId } = await backend.runWorkflow(wf.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await backend.approveRun(runId, true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await backend.listRuns()).find((run) => run.id === runId)?.status).toBe(
      'paused',
    );
    expect(
      (await backend.getRunResults(runId)).find((result) => result.nodeId === 'gate2')
        ?.status,
    ).toBe('paused');
    await expect(backend.approveRun(runId, true, undefined, 2)).rejects.toThrow(
      'Approval changed',
    );
    await backend.cancelRun(runId);
  });

  it('evaluates conditions with the supplied run inputs', async () => {
    const backend = __setMockBackendForTests();
    const wf = createEmptyWorkflow('Input condition');
    const start = wf.nodes.find((n) => n.type === 'start');
    const end = wf.nodes.find((n) => n.type === 'end');
    if (start === undefined || end === undefined) throw new Error('fixture broken');
    wf.inputs = [{ name: 'count', default: '0', required: false }];
    wf.nodes.push({
      id: 'condition',
      type: 'condition',
      position: { x: 0, y: 0 },
      config: {
        condition: {
          logic: 'and',
          clauses: [{ left: 'input.count', op: 'greater', right: '1' }],
        },
      },
    });
    wf.nodes.push({ id: 'yes', type: 'end', position: { x: 0, y: 0 }, config: {} });
    wf.edges = [
      { id: 'e1', source: start.id, target: 'condition' },
      { id: 'e2', source: 'condition', target: 'yes', label: 'true' },
      { id: 'e3', source: 'condition', target: end.id, label: 'false' },
    ];
    await backend.saveWorkflow(wf);
    const { runId } = await backend.runWorkflow(wf.id, { count: '3' });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(
      (await backend.getRunResults(runId)).some((result) => result.nodeId === 'yes'),
    ).toBe(true);
    const falseRun = await backend.runWorkflow(wf.id, { count: '0' });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(
      (await backend.getRunResults(falseRun.runId)).find(
        (result) => result.nodeId === 'condition',
      )?.stdout,
    ).toBe('false');
  });
  it('previews custom CLI flags before the final prompt', async () => {
    const backend = __setMockBackendForTests();
    const profile = {
      ...createDefaultProfile('custom'),
      executable: 'aichat',
      model: 'local-model',
      extraArgs: ['--no-stream'],
    };
    await backend.saveAgentProfile(profile);
    const preview = await backend.previewAgentCommand(profile.id, 'implement this');
    expect(preview.args).toEqual([
      '--model',
      'local-model',
      '--no-stream',
      'implement this',
    ]);
  });

  it('previews Codex model, effort, skills, and referenced variables', async () => {
    const backend = __setMockBackendForTests();
    const profile = {
      ...createDefaultProfile('codex'),
      model: 'my-model',
      effort: 'high',
      skills: ['review'],
      extraArgs: ['--json'],
    };
    await backend.saveAgentProfile(profile);
    const preview = await backend.previewAgentCommand(profile.id, '{{input.task}}');
    // The profile's own --json keeps the text invocation; the prompt is stdin.
    expect(preview.args).toEqual([
      'exec',
      '--model',
      'my-model',
      '-c',
      'model_reasoning_effort="high"',
      '-',
      '--json',
    ]);
    expect(preview.preview).toContain('<prompt via stdin, 23 chars>');
    expect(preview.preview).not.toContain('{{input.task}}');
    expect(preview.referencedVariables).toEqual(['input.task']);
  });

  it('previews structured Claude and Codex invocations with the prompt on stdin', async () => {
    const backend = __setMockBackendForTests();
    const claude = { ...createDefaultProfile('claude'), model: 'haiku' };
    const codex = {
      ...createDefaultProfile('codex'),
      extraArgs: ['--sandbox', 'read-only'],
    };
    await backend.saveAgentProfile(claude);
    await backend.saveAgentProfile(codex);
    const claudePreview = await backend.previewAgentCommand(claude.id, 'Review 🙂');
    expect(claudePreview.args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'haiku',
    ]);
    expect(claudePreview.preview).toMatch(/<prompt via stdin, 8 chars>$/);
    const codexPreview = await backend.previewAgentCommand(codex.id, 'Review');
    expect(codexPreview.args).toEqual(['exec', '--json', '--sandbox', 'read-only', '-']);
    const ownInput = { ...claude, extraArgs: ['--input-format', 'stream-json'] };
    await backend.saveAgentProfile(ownInput);
    const legacy = await backend.previewAgentCommand(ownInput.id, 'Review');
    expect(legacy.args).toEqual([
      '-p',
      'Review',
      '--output-format',
      'text',
      '--model',
      'haiku',
      '--input-format',
      'stream-json',
    ]);
    expect(legacy.preview).not.toContain('stdin');
    // Permission flags follow model/effort, before extra arguments (agents.rs).
    const allowed = {
      ...claude,
      id: 'prof-allowed',
      permissionLevel: 'allowedTools' as const,
      allowedTools: ['mcp__jira', 'Bash(git status *)'],
    };
    await backend.saveAgentProfile(allowed);
    expect((await backend.previewAgentCommand(allowed.id, 'Review')).args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'haiku',
      '--allowedTools',
      'mcp__jira,Bash(git status *)',
    ]);
    const full = {
      ...createDefaultProfile('codex'),
      permissionLevel: 'fullAccess' as const,
    };
    await backend.saveAgentProfile(full);
    expect((await backend.previewAgentCommand(full.id, 'Review')).args).toEqual([
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '-',
    ]);
    await expect(
      backend.saveAgentProfile({ ...full, extraArgs: ['--sandbox', 'read-only'] }),
    ).rejects.toThrow('conflicts with the profile');
    // A profile at the app default previews what a run would use.
    const follows = { ...createDefaultProfile('codex'), id: 'prof-follows' };
    await backend.saveAgentProfile(follows);
    expect((await backend.previewAgentCommand(follows.id, 'Review')).args).toEqual([
      'exec',
      '--json',
      '-',
    ]);
    await backend.setSetting('agents.permissionDefault', 'fullAccess');
    expect((await backend.previewAgentCommand(follows.id, 'Review')).args).toEqual([
      'exec',
      '--json',
      '--dangerously-bypass-approvals-and-sandbox',
      '-',
    ]);
  });

  it('mirrors the app-wide agent permission setting and its trust risk', async () => {
    const backend = __setMockBackendForTests();
    expect(await backend.getSetting('agents.permissionDefault')).toBeNull();
    for (const value of ['allowedTools', 'appDefault', ''])
      await expect(backend.setSetting('agents.permissionDefault', value)).rejects.toThrow(
        'Agent permissions must be cliSettings or fullAccess.',
      );
    const profile = { ...createDefaultProfile('claude'), id: 'prof-risk' };
    await backend.saveAgentProfile(profile);
    const workflow = createEmptyWorkflow('Agent');
    workflow.nodes.splice(1, 0, {
      id: 'agent',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { agentProfileId: profile.id, prompt: 'Work' },
    });
    expect(await backend.workflowRisks(workflow)).not.toContain('fullAccessAgent');
    await backend.setSetting('agents.permissionDefault', 'fullAccess');
    expect(await backend.workflowRisks(workflow)).toContain('fullAccessAgent');
    await backend.setSetting('agents.permissionDefault', 'cliSettings');
    expect(await backend.workflowRisks(workflow)).not.toContain('fullAccessAgent');
  });
  beforeEach(() => {
    localStorage.clear();
    __setMockBackendForTests();
  });

  it('seeds a sample workflow and round-trips saves', async () => {
    const backend = __setMockBackendForTests();
    const initial = await backend.listWorkflows();
    expect(initial.length).toBeGreaterThanOrEqual(1);

    const wf = createEmptyWorkflow('My Flow');
    const stored = await backend.saveWorkflow(wf);
    expect(stored.name).toBe('My Flow');
    const fetched = await backend.getWorkflow(wf.id);
    expect(fetched?.definition.name).toBe('My Flow');
    expect(await backend.deleteWorkflow(wf.id)).toBe(true);
    expect(await backend.getWorkflow(wf.id)).toBeNull();
  });

  it('simulates a run to success with node results', async () => {
    const backend = __setMockBackendForTests();
    const [first] = await backend.listWorkflows();
    if (first === undefined) throw new Error('expected seeded workflow');
    const { runId } = await backend.runWorkflow(first.id);
    // Wait for the simulated execution to finish.
    for (let i = 0; i < 40; i++) {
      const [run] = (await backend.listRuns()).filter((r) => r.id === runId);
      if (run?.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const [run] = (await backend.listRuns()).filter((r) => r.id === runId);
    expect(run?.status).toBe('succeeded');
    const results = await backend.getRunResults(runId);
    expect(results.length).toBeGreaterThan(0);
  });

  it('shows a running command result before it finishes and updates the same row', async () => {
    const backend = __setMockBackendForTests();
    const wf = createEmptyWorkflow('Live command');
    const start = wf.nodes.find((n) => n.type === 'start');
    const end = wf.nodes.find((n) => n.type === 'end');
    if (start === undefined || end === undefined) throw new Error('fixture broken');
    wf.nodes.push({
      id: 'cmd',
      type: 'command',
      position: { x: 0, y: 0 },
      config: { executable: 'echo', args: ['hello'] },
    });
    wf.edges = [
      { id: 'e1', source: start.id, target: 'cmd' },
      { id: 'e2', source: 'cmd', target: end.id },
    ];
    await backend.saveWorkflow(wf);
    const { runId } = await backend.runWorkflow(wf.id);
    let live = (await backend.getRunResults(runId)).find((r) => r.nodeId === 'cmd');
    for (let i = 0; i < 25 && live === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      live = (await backend.getRunResults(runId)).find((r) => r.nodeId === 'cmd');
    }
    expect(live?.status).toBe('running');
    expect(live?.stdout).toContain('mock$ echo hello');
    expect(live?.finishedAt).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 450));
    const final = (await backend.getRunResults(runId)).find((r) => r.nodeId === 'cmd');
    expect(final?.id).toBe(live?.id);
    expect(final?.status).toBe('succeeded');
    expect(final?.stdout).toContain('Hello from Orchevia');
  });

  it('pauses at approval nodes and resumes on approve', async () => {
    const backend = __setMockBackendForTests();
    const wf = createEmptyWorkflow('Approval flow');
    const start = wf.nodes.find((n) => n.type === 'start');
    const end = wf.nodes.find((n) => n.type === 'end');
    if (start === undefined || end === undefined) throw new Error('fixture broken');
    const gateId = 'node-gate';
    wf.nodes.push({ id: gateId, type: 'approval', position: { x: 0, y: 0 }, config: {} });
    wf.nodes.push({
      id: 'after-approval',
      type: 'command',
      position: { x: 0, y: 0 },
      config: { executable: 'echo', args: ['approved'] },
    });
    wf.edges = [
      { id: 'e1', source: start.id, target: gateId },
      { id: 'e2', source: gateId, target: 'after-approval' },
      { id: 'e3', source: 'after-approval', target: end.id },
    ];
    await backend.saveWorkflow(wf);
    const { runId } = await backend.runWorkflow(wf.id);
    for (let i = 0; i < 40; i++) {
      const [run] = (await backend.listRuns()).filter((r) => r.id === runId);
      if (run?.status === 'paused') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let [run] = (await backend.listRuns()).filter((r) => r.id === runId);
    expect(run?.status).toBe('paused');
    await expect(backend.deleteWorkflow(wf.id)).rejects.toThrow('running or paused');
    const afterNode = wf.nodes.find((node) => node.id === 'after-approval');
    if (afterNode === undefined) throw new Error('fixture broken');
    afterNode.config.args = ['edited after pause'];
    await backend.saveWorkflow(wf);
    await backend.approveRun(runId, true);
    const afterApproval = (await backend.getRunResults(runId)).find(
      (r) => r.nodeId === 'after-approval',
    );
    expect(afterApproval?.status).toBe('running');
    for (let i = 0; i < 40; i++) {
      [run] = (await backend.listRuns()).filter((r) => r.id === runId);
      if (run?.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(run?.status).toBe('succeeded');
    expect(
      (await backend.getRunResults(runId)).find((r) => r.nodeId === 'after-approval')
        ?.stdout,
    ).toContain('approved');
    expect(
      (await backend.getRunResults(runId)).find((r) => r.nodeId === 'after-approval')
        ?.stdout,
    ).not.toContain('edited after pause');
    await expect(backend.approveRun(runId, true)).rejects.toThrow('not paused');
    await backend.deleteWorkflow(wf.id);
    expect((await backend.listRuns()).some((r) => r.id === runId)).toBe(false);
  });

  it('round-trips agent profiles and fails agent runs without one', async () => {
    const backend = __setMockBackendForTests();
    const profile = createDefaultProfile('claude');
    await backend.saveAgentProfile(profile);
    expect(await backend.listAgentProfiles()).toHaveLength(1);

    // Agent node referencing the saved profile succeeds in the mock.
    const wf = createEmptyWorkflow('Agent flow');
    const start = wf.nodes.find((n) => n.type === 'start');
    const end = wf.nodes.find((n) => n.type === 'end');
    if (start === undefined || end === undefined) throw new Error('fixture broken');
    const agentId = 'node-agent';
    wf.nodes.push({
      id: agentId,
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { agentProfileId: profile.id, prompt: 'Do it' },
    });
    wf.edges = [
      { id: 'e1', source: start.id, target: agentId },
      { id: 'e2', source: agentId, target: end.id },
    ];
    await backend.saveWorkflow(wf);
    const { runId } = await backend.runWorkflow(wf.id);
    for (let i = 0; i < 40; i++) {
      const [run] = (await backend.listRuns()).filter((r) => r.id === runId);
      if (run?.status === 'succeeded' || run?.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const [run] = (await backend.listRuns()).filter((r) => r.id === runId);
    expect(run?.status).toBe('succeeded');

    // Unknown profile fails the run with a recorded failure.
    const wf2 = createEmptyWorkflow('Agent missing');
    const s2 = wf2.nodes.find((n) => n.type === 'start');
    const e2 = wf2.nodes.find((n) => n.type === 'end');
    if (s2 === undefined || e2 === undefined) throw new Error('fixture broken');
    wf2.nodes.push({
      id: 'node-agent-x',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { agentProfileId: 'nope', prompt: 'Do it' },
    });
    wf2.edges = [
      { id: 'e1', source: s2.id, target: 'node-agent-x' },
      { id: 'e2', source: 'node-agent-x', target: e2.id },
    ];
    await backend.saveWorkflow(wf2);
    const second = await backend.runWorkflow(wf2.id);
    for (let i = 0; i < 40; i++) {
      const [r] = (await backend.listRuns()).filter((x) => x.id === second.runId);
      if (r?.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const [failed] = (await backend.listRuns()).filter((x) => x.id === second.runId);
    expect(failed?.status).toBe('failed');

    expect(await backend.deleteAgentProfile(profile.id)).toBe(true);
  });

  it('keeps skill discovery and command previews available in the mock backend', async () => {
    const backend = __setMockBackendForTests();
    expect(await backend.listAgentSkills('custom')).toEqual([]);
    const profile = createDefaultProfile('codex');
    profile.skills = ['code-review'];
    await backend.saveAgentProfile(profile);
    const preview = await backend.previewAgentCommand(profile.id, 'Review this');
    expect(preview.preview).toContain(
      `<prompt via stdin, ${String('$code-review\n\nReview this'.length)} chars>`,
    );
    await expect(
      backend.saveAgentProfile({
        ...createDefaultProfile('custom'),
        executable: '/bin/echo',
        skills: ['code-review'],
      }),
    ).rejects.toThrow('Skills');
  });

  it('deletes single runs and clears finished ones, refusing active runs', async () => {
    const backend = __setMockBackendForTests();
    const wf = createEmptyWorkflow('Deletable flow');
    await backend.saveWorkflow(wf);
    const first = await backend.runWorkflow(wf.id);
    // Finish it by waiting for the mock simulation.
    for (let i = 0; i < 40; i++) {
      const [run] = (await backend.listRuns()).filter((r) => r.id === first.runId);
      if (run?.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await backend.deleteRun(first.runId)).toBe(true);
    expect(await backend.deleteRun(first.runId)).toBe(false);
    expect(await backend.getRunResults(first.runId)).toHaveLength(0);

    // Active runs are refused until cancelled.
    const second = await backend.runWorkflow(wf.id);
    await expect(backend.deleteRun(second.runId)).rejects.toThrow(/cancel/i);
    await backend.cancelRun(second.runId);
    expect(await backend.deleteRun(second.runId)).toBe(true);

    // Clear keeps running runs, removes finished ones.
    const third = await backend.runWorkflow(wf.id);
    for (let i = 0; i < 40; i++) {
      const [run] = (await backend.listRuns()).filter((r) => r.id === third.runId);
      if (run?.status === 'succeeded') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const fourth = await backend.runWorkflow(wf.id);
    const cleared = await backend.clearFinishedRuns();
    expect(cleared.removed).toBe(1);
    expect(cleared.kept).toBe(1);
    expect((await backend.listRuns()).map((r) => r.id)).toEqual([fourth.runId]);
  });
});

describe('custom model registry (mock)', () => {
  it('round-trips per-adapter lists with cleaning', async () => {
    const backend = __setMockBackendForTests();
    expect(await backend.listCustomModels('codex')).toEqual([]);
    const saved = await backend.saveCustomModels('codex', [
      ' gpt-6-astra ',
      '',
      'gpt-6-astra',
    ]);
    expect(saved).toEqual(['gpt-6-astra']);
    expect(await backend.listCustomModels('codex')).toEqual(['gpt-6-astra']);
    expect(await backend.listCustomModels('claude')).toEqual([]);
  });
});

it('mock rejects blank required project commands before creating a run', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const workflow = createEmptyWorkflow('Required command');
  workflow.inputs = [{ name: 'testCommand', required: true }];
  await backend.saveWorkflow(workflow);
  await expect(backend.runWorkflow(workflow.id, { testCommand: '  ' })).rejects.toThrow(
    /required/,
  );
  expect(await backend.listRuns()).toEqual([]);
  workflow.inputs[0]!.default = 'printf REAL_TEST';
  await backend.saveWorkflow(workflow);
  await expect(backend.runWorkflow(workflow.id, { testCommand: '  ' })).rejects.toThrow(
    /required/,
  );
  expect(await backend.listRuns()).toEqual([]);
});

it('mirrors desktop settings access and validation', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  expect(await backend.getSetting('workflow.assistanceProfileId')).toBeNull();
  await backend.setSetting('workflow.assistanceProfileId', 'assistant');
  expect(await backend.getSetting('workflow.assistanceProfileId')).toBe('assistant');
  expect(
    await __setMockBackendForTests().getSetting('workflow.assistanceProfileId'),
  ).toBe('assistant');
  await expect(backend.getSetting('private.setting')).rejects.toThrow(
    'not user-configurable',
  );
  await expect(backend.setSetting('private.setting', 'x')).rejects.toThrow(
    'not user-configurable',
  );
  // The poll interval is fixed now; the old key is no longer a setting.
  await expect(backend.setSetting('scheduler.intervalSecs', '60')).rejects.toThrow(
    'not user-configurable',
  );
  await expect(backend.setSetting('updates.check', 'maybe')).rejects.toThrow(
    "on ('1') or off ('0')",
  );
  await expect(backend.setSetting('updates.dismissedVersion', 'soon')).rejects.toThrow(
    'not a release version',
  );
  await backend.setSetting('updates.check', '0');
  await backend.setSetting('updates.dismissedVersion', '9.9.9');
  expect(await backend.getSetting('updates.check')).toBe('0');
});

it('mirrors schedule save bookkeeping and validation', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const workflow = createEmptyWorkflow('Read only');
  workflow.id = 'wf';
  await backend.saveWorkflow(workflow);
  const base = {
    id: 's',
    name: 'Review PRs',
    workflowId: 'wf',
    kind: { kind: 'interval' as const, everySecs: 3600 },
    timezone: 'local',
    enabled: true,
    trusted: true,
    missedPolicy: 'skip' as const,
  };
  await backend.saveSchedule(base);
  // A stale editor copy cannot overwrite scheduler bookkeeping.
  const resaved = await backend.saveSchedule({
    ...base,
    name: 'Renamed',
    lastStatus: 'edited in the form',
    nextRunAt: '2000-01-01T00:00:00Z',
  });
  expect(resaved.name).toBe('Renamed');
  expect(resaved.lastStatus).toBeUndefined();
  expect(resaved.nextRunAt).toBeUndefined();
  await expect(
    backend.saveSchedule({ ...base, kind: { kind: 'cron', expr: '0 9 * * mon' } }),
  ).rejects.toThrow("Invalid schedule: Invalid cron: Bad value 'mon' in 'mon'.");
  await expect(
    backend.saveSchedule({ ...base, kind: { kind: 'cron', expr: '0 0 31 2 *' } }),
  ).rejects.toThrow('Cron never matches');
  await expect(
    backend.saveSchedule({ ...base, timezone: 'Mars/Olympus' }),
  ).rejects.toThrow("Timezone must be 'utc', 'local', or '±HH:MM'.");
});

it('mirrors desktop integration commands', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  expect(await backend.desktopInfo()).toEqual({
    platform: 'browser',
    arch: 'unknown',
    installKind: 'unknown',
  });
  await expect(backend.quitApp()).rejects.toThrow('desktop app');
  await expect(backend.openExternalUrl('https://example.com/')).rejects.toThrow(
    "Only Orchevia's own GitHub pages",
  );
  await expect(backend.recordUpdateNotice('soon')).rejects.toThrow(
    'not a release version',
  );
  expect(await backend.recordUpdateNotice('0.0.1')).toBe(false);
  expect(await backend.recordUpdateNotice('999.0.0')).toBe(true);
  expect(await backend.recordUpdateNotice('v999.0.0')).toBe(false);
  expect(await backend.recordUpdateNotice('999.0.1')).toBe(true);
});

it('resolves same-role profiles in native binary name order', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  await backend.saveAgentProfile({
    ...createDefaultProfile('claude'),
    name: 'a reviewer',
    role: 'fastReview',
  });
  const nativeFirst = await backend.saveAgentProfile({
    ...createDefaultProfile('codex'),
    name: 'Z reviewer',
    role: 'fastReview',
  });
  expect((await backend.roleMapDefault()).fastReview).toBe(nativeFirst.id);
});

it('runs the built-in ticket implementation with simulated ticket aliases', async () => {
  const backend = __setMockBackendForTests();
  const profile = createDefaultProfile('claude');
  await backend.saveAgentProfile(profile);
  const template = builtinTemplates().find((t) => t.id === 'ticket-to-pr')!;
  const workflow = instantiateTemplateLocal(template, {
    implementation: profile.id,
    fastReview: profile.id,
    deepReview: profile.id,
  }).workflow;
  workflow.defaults = { repoDir: '/mock/repository' };
  const ticket = workflow.nodes.find((node) => node.type === 'ticket');
  if (ticket) ticket.config.mcpServerId = 'mock-tickets';
  // Stop after implementation to exercise the real built-in prompt without review-loop simulation.
  const implement = workflow.nodes.find((n) => n.label === 'Implement')!;
  const end = workflow.nodes.find((n) => n.type === 'end')!;
  workflow.edges = workflow.edges.filter((e) => e.source !== implement.id);
  workflow.edges.push({ id: 'stop-after-impl', source: implement.id, target: end.id });
  await backend.saveWorkflow(workflow);
  const { runId } = await backend.runWorkflow(workflow.id, {
    ticket: 'DEV-1',
    branch: 'fix/dev-1',
    testCommand: 'true',
  });
  await vi.waitFor(
    async () => expect((await backend.getRun(runId))?.status).toBe('succeeded'),
    { timeout: 3500 },
  );
  const result = (await backend.getRunResults(runId)).find(
    (row) => row.nodeId === implement.id,
  )!;
  expect(result.stdout).toContain('Implement DEV-1:');
  expect(result.stdout).toContain('Mock ticket DEV-1');
});

it('enforces the mock attempt budget and continues only with an explicit extension', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const profile = createDefaultProfile('claude');
  await backend.saveAgentProfile(profile);
  const workflow = createEmptyWorkflow('Mock budget');
  const agent = (id: string): (typeof workflow.nodes)[number] => ({
    id,
    type: 'agent',
    position: { x: 0, y: 0 },
    config: { agentProfileId: profile.id, prompt: 'Work' },
  });
  workflow.nodes.splice(1, 0, agent('a1'), agent('a2'));
  workflow.edges = [
    { id: 'e0', source: workflow.nodes[0]!.id, target: 'a1' },
    { id: 'e1', source: 'a1', target: 'a2' },
    { id: 'e2', source: 'a2', target: workflow.nodes.at(-1)!.id },
  ];
  const stored = await backend.saveWorkflow(workflow);
  const { runId } = await backend.runWorkflow(stored.id, {}, { maxAgentAttempts: 1 });
  await vi.waitFor(
    async () => {
      const run = await backend.getRun(runId);
      expect(run?.status).toBe('paused');
    },
    { timeout: 8000 },
  );
  const paused = await backend.getRun(runId);
  expect(paused?.execution?.usagePause?.consumedAttempts).toBe(1);
  expect(paused?.execution?.resolvedLimits?.maxAgentAttempts).toBe(1);
  // Ordinary approval cannot clear a usage pause.
  await expect(backend.approveRun(runId, true)).rejects.toThrow('not paused');
  // Stale pause ids and non-extending budgets are rejected.
  await expect(backend.continueUsageRun(runId, 9999, 2)).rejects.toThrow('not paused');
  await expect(
    backend.continueUsageRun(runId, paused?.execution?.usagePause?.id ?? 0, 1),
  ).rejects.toThrow('exceeding');
  await expect(
    backend.continueUsageRun(runId, paused?.execution?.usagePause?.id ?? 0, 10_001),
  ).rejects.toThrow();
  await backend.continueUsageRun(runId, paused?.execution?.usagePause?.id ?? 0, 2);
  await vi.waitFor(
    async () => {
      const run = await backend.getRun(runId);
      expect(run?.status).toBe('succeeded');
    },
    { timeout: 8000 },
  );
  const done = await backend.getRun(runId);
  expect(done?.execution?.consumedAgentAttempts).toBe(2);
});

it('aggregates usage over more than fifty runs with date boundaries', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const workflow = createEmptyWorkflow('Bulk history');
  const stored = await backend.saveWorkflow(workflow);
  // Runs start synchronously; background simulation finishes on its own.
  // Analytics must scan all of them, not a capped recent list.
  for (let n = 0; n < 55; n++) await backend.runWorkflow(stored.id, {});
  await vi.waitFor(
    async () => {
      const summary = await backend.usageSummary();
      expect(summary.runsScanned).toBe(55);
      expect(summary.totals.runs).toBe(55);
    },
    { timeout: 15000 },
  );
  const summary = await backend.usageSummary();
  // Command-only history: no agent attempts, no fabricated USD.
  expect(summary.totals.agentAttempts).toBe(0);
  expect(summary.totals.reportedUsd).toBe(0);
  expect(summary.byWorkflow).toHaveLength(1);
  const future = await backend.usageSummary({ from: '2999-01-01T00:00:00.000Z' });
  expect(future.totals.runs).toBe(0);
  await expect(backend.usageSummary({ from: 'not-a-date' })).rejects.toThrow(
    "Invalid 'from' date",
  );
}, 20000);

describe('mock parity with the desktop backend', () => {
  it('keeps schedules, notification choices and custom models across a reload', async () => {
    localStorage.clear();
    const backend = __setMockBackendForTests();
    const workflow = createEmptyWorkflow('Nightly');
    workflow.id = 'wf';
    await backend.saveWorkflow(workflow);
    await backend.saveSchedule({
      id: 's',
      name: 'Nightly',
      workflowId: 'wf',
      kind: { kind: 'interval', everySecs: 3600 },
      timezone: 'local',
      enabled: true,
      trusted: true,
      missedPolicy: 'skip',
    });
    const prefs = { ...(await backend.getNotificationPrefs()), onFailure: false };
    await backend.setNotificationPrefs(prefs);
    await backend.saveCustomModels('claude', [' opus ', 'opus', '', 'sonnet']);
    const reopened = __setMockBackendForTests();
    expect((await reopened.listSchedules()).map((s) => s.name)).toEqual(['Nightly']);
    expect(await reopened.getNotificationPrefs()).toEqual(prefs);
    expect(await reopened.listCustomModels('claude')).toEqual(['opus', 'sonnet']);
  });

  it('rejects what the desktop backend rejects', async () => {
    localStorage.clear();
    const backend = __setMockBackendForTests();
    await expect(backend.saveCustomModels('gemini', ['x'])).rejects.toThrow(
      'Unknown adapter.',
    );
    await expect(
      backend.saveCustomModels(
        'codex',
        Array.from({ length: 51 }, (_, i) => `m${String(i)}`),
      ),
    ).rejects.toThrow('At most 50 custom models per adapter.');
    await expect(backend.saveCustomModels('codex', ['x'.repeat(121)])).rejects.toThrow(
      'at most 120 characters',
    );
    await expect(
      backend.saveMcpServer({
        id: 'm',
        name: 'M',
        command: ' ',
        args: [],
        enabled: true,
      }),
    ).rejects.toThrow('Invalid MCP server');
  });

  it('previews an agent command before its prompt is written', async () => {
    localStorage.clear();
    const backend = __setMockBackendForTests();
    const profile = await backend.saveAgentProfile(createDefaultProfile('claude'));
    const preview = await backend.previewAgentCommand(profile.id, '');
    expect(preview.executable).not.toBe('');
  });
});
