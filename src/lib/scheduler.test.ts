import { describe, expect, it } from 'vitest';
import { __setMockBackendForTests } from './backend';
import { workflowConsumesPrNumber, type Watcher } from './scheduler';
import { createEmptyWorkflow } from './workflow';

const watcher: Watcher = {
  id: 'watch',
  name: 'Requested',
  workflowId: 'wf',
  kind: 'reviewRequested',
  repoDir: '/repo',
  enabled: false,
  checkIntervalSecs: 900,
};

describe('mock watcher saves', () => {
  it('rejects invalid intervals and missing enabled workflows like the desktop', async () => {
    const backend = __setMockBackendForTests();
    await expect(
      backend.saveWatcher({ ...watcher, checkIntervalSecs: 10 }),
    ).rejects.toThrow('interval');
    await expect(backend.saveWatcher({ ...watcher, enabled: true })).rejects.toThrow(
      'Unknown workflow',
    );
  });

  it('preserves checked revisions on an edit but resets the check when re-enabled', async () => {
    const backend = __setMockBackendForTests();
    const workflow = createEmptyWorkflow('Watcher');
    workflow.id = 'wf';
    await backend.saveWorkflow(workflow);
    await backend.saveWatcher({
      ...watcher,
      enabled: true,
      lastCheckedAt: '2026-10-05T13:21:24Z',
      lastHeadSha: 'a',
      lastResult: 'quiet',
    });
    const edited = await backend.saveWatcher({
      ...watcher,
      enabled: true,
      name: 'Renamed',
    });
    expect(edited.lastHeadSha).toBe('a');
    expect(edited.lastCheckedAt).toBe('2026-10-05T13:21:24Z');
    await backend.saveWatcher({ ...edited, enabled: false });
    const enabled = await backend.saveWatcher({ ...edited, enabled: true });
    expect(enabled.lastCheckedAt).toBeUndefined();
    expect(enabled.lastHeadSha).toBe('a');
  });

  it('resets old scope state when the watched repository changes', async () => {
    const backend = __setMockBackendForTests();
    const initial = await backend.saveWatcher({
      ...watcher,
      lastCheckedAt: '2026-10-05T13:21:24Z',
      lastHeadSha: 'a',
    });
    const changed = await backend.saveWatcher({ ...initial, repoDir: '/other' });
    expect(changed.lastHeadSha).toBeUndefined();
    expect(changed.lastCheckedAt).toBeUndefined();
  });
});

describe('watcher dispatch scope', () => {
  it('uses consumed PR inputs rather than declarations or escaped text', () => {
    const workflow = createEmptyWorkflow('Scanner');
    workflow.inputs = [{ name: 'prNumber' }];
    expect(workflowConsumesPrNumber(workflow)).toBe(false);
    workflow.nodes.push({
      id: 'consumer',
      type: 'mcp',
      position: { x: 0, y: 0 },
      config: { mcpArgs: { pr: String.raw`\{{input.prNumber}}` } },
    });
    expect(workflowConsumesPrNumber(workflow)).toBe(false);
    workflow.nodes.at(-1)!.config.mcpArgs = { pr: '{{input.prNumber}}' };
    expect(workflowConsumesPrNumber(workflow)).toBe(false);
    workflow.edges.push({
      id: 'consume',
      source: workflow.nodes[0]!.id,
      target: 'consumer',
    });
    expect(workflowConsumesPrNumber(workflow)).toBe(true);
  });
});

it('does not treat a literal condition right operand as a PR input', () => {
  const workflow = createEmptyWorkflow('Scanner');
  workflow.nodes.push({
    id: 'condition',
    type: 'condition',
    position: { x: 0, y: 0 },
    config: {},
  });
  workflow.edges.push({
    id: 'to-condition',
    source: workflow.nodes[0]!.id,
    target: 'condition',
  });
  workflow.nodes.at(-1)!.config.condition = {
    logic: 'and',
    clauses: [{ left: 'workflow.name', op: 'equals', right: 'input.prNumber' }],
  };
  expect(workflowConsumesPrNumber(workflow)).toBe(false);
  workflow.nodes.at(-1)!.config.condition!.clauses[0]!.right = '{{input.prNumber}}';
  expect(workflowConsumesPrNumber(workflow)).toBe(false);
});

it('rejects a watcher targeting a different repository from its native PR nodes', async () => {
  const backend = __setMockBackendForTests();
  const workflow = createEmptyWorkflow('Review');
  workflow.id = 'wf';
  workflow.nodes.push({
    id: 'pr',
    type: 'github',
    position: { x: 0, y: 0 },
    config: { workingDir: '/different', githubOp: { op: 'prDetails', number: 0 } },
  });
  await backend.saveWorkflow(workflow);
  await expect(backend.saveWatcher({ ...watcher, enabled: true })).rejects.toThrow(
    'repository',
  );
});
