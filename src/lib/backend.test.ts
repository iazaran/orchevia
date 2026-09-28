import { beforeEach, describe, expect, it } from 'vitest';
import { __setMockBackendForTests } from './backend';
import { createDefaultProfile } from './agents';
import { createEmptyWorkflow } from './workflow';

describe('mock backend (browser dev)', () => {
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
    expect(preview.args).toEqual([
      'exec',
      '--model',
      'my-model',
      '-c',
      'model_reasoning_effort="high"',
      '$review\n\n{{input.task}}',
      '--json',
    ]);
    expect(preview.referencedVariables).toEqual(['input.task']);
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
    expect(preview.args).toContain('$code-review\n\nReview this');
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
