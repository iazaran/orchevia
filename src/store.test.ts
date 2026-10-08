import { afterEach, expect, it, vi } from 'vitest';
import { __setMockBackendForTests } from './lib/backend';
import { createEmptyWorkflow } from './lib/workflow';
import type { StoredNodeResult, StoredWorkflow, ValidationIssue } from './lib/workflow';
import { sameNodeResults, useAppStore } from './store';
afterEach(() => vi.restoreAllMocks());

it('keeps edits made while an older save is pending', async () => {
  const backend = __setMockBackendForTests();
  const wf = createEmptyWorkflow('Before save');
  const stored = await backend.saveWorkflow(wf);
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: wf.id,
    overlayRunId: null,
    validation: [],
  });
  let finish: (value: StoredWorkflow) => void = () => {};
  const save = vi.spyOn(backend, 'saveWorkflow').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const saving = useAppStore.getState().saveActiveWorkflow();
  await vi.waitFor(() => expect(save).toHaveBeenCalled());
  useAppStore.getState().updateActiveWorkflow({ ...wf, name: 'New draft' });
  finish(stored);
  await saving;
  expect(useAppStore.getState().workflows[0]?.definition.name).toBe('New draft');
});

it('does not apply saved validation after selecting another workflow', async () => {
  const backend = __setMockBackendForTests();
  const first = await backend.saveWorkflow(createEmptyWorkflow('First'));
  const second = await backend.saveWorkflow(createEmptyWorkflow('Second'));
  useAppStore.setState({
    workflows: [first, second],
    activeWorkflowId: first.id,
    overlayRunId: null,
    validation: [],
  });
  let finish: (value: ValidationIssue[]) => void = () => {};
  const validate = vi.spyOn(backend, 'validateWorkflow').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const saving = useAppStore.getState().saveActiveWorkflow();
  await vi.waitFor(() => expect(validate).toHaveBeenCalled());
  useAppStore.getState().selectWorkflow(second.id);
  finish([{ code: 'old-error', severity: 'error', message: 'First workflow only' }]);
  await saving;
  expect(useAppStore.getState().activeWorkflowId).toBe(second.id);
  expect(useAppStore.getState().validation).toEqual([]);
});

it('persists overlapping saves in request order', async () => {
  const backend = __setMockBackendForTests();
  const wf = createEmptyWorkflow('Before saves');
  const stored = await backend.saveWorkflow(wf);
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: wf.id,
    overlayRunId: null,
    validation: [],
  });
  const save = backend.saveWorkflow.bind(backend);
  let release: () => void = () => {};
  let started: () => void = () => {};
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.spyOn(backend, 'saveWorkflow').mockImplementationOnce(async (workflow) => {
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return save(workflow);
  });
  useAppStore.getState().updateActiveWorkflow({ ...wf, name: 'First edit' });
  const first = useAppStore.getState().saveActiveWorkflow();
  await firstStarted;
  useAppStore.getState().updateActiveWorkflow({ ...wf, name: 'Latest edit' });
  const second = useAppStore.getState().saveActiveWorkflow();
  await Promise.resolve();
  release();
  await Promise.all([first, second]);
  expect((await backend.getWorkflow(wf.id))?.name).toBe('Latest edit');
  expect(useAppStore.getState().workflows[0]?.name).toBe('Latest edit');
});

it('reports cancelled same-run navigation even when its previous overlay remains', async () => {
  const backend = __setMockBackendForTests();
  const wf = createEmptyWorkflow('Cancelled');
  await backend.saveWorkflow(wf);
  const { runId } = await backend.runWorkflow(wf.id);
  await useAppStore.getState().openRunOnCanvas(runId);
  const getRun = backend.getRun.bind(backend);
  let release: () => void = () => {};
  vi.spyOn(backend, 'getRun').mockImplementation(
    (id) =>
      new Promise((resolve) => {
        release = () => {
          void getRun(id).then(resolve);
        };
      }),
  );
  const request = useAppStore.getState().openRunOnCanvas(runId);
  useAppStore.getState().setView('automations');
  release();
  expect(await request).toBe(false);
  expect(useAppStore.getState().view).toBe('automations');
  expect(useAppStore.getState().overlayRunId).toBe(runId);
});
it('opens the immutable snapshot and rejects missing runs without replacing it', async () => {
  const backend = __setMockBackendForTests();
  const wf = createEmptyWorkflow('Original');
  await backend.saveWorkflow(wf);
  const { runId } = await backend.runWorkflow(wf.id);
  await backend.saveWorkflow({ ...wf, name: 'Changed', nodes: [] });
  await useAppStore.getState().openRunOnCanvas(runId);
  expect(useAppStore.getState().overlayWorkflow?.name).toBe('Original');
  expect(useAppStore.getState().view).toBe('workflows');
  await expect(useAppStore.getState().openRunOnCanvas('missing')).rejects.toThrow(
    'Unknown run',
  );
  expect(useAppStore.getState().overlayRunId).toBe(runId);
  useAppStore.getState().selectWorkflow(wf.id);
  expect(useAppStore.getState().overlayWorkflow).toBeNull();
});
it('does not let a slow old navigation overwrite the latest run', async () => {
  const backend = __setMockBackendForTests();
  const wf = createEmptyWorkflow('Concurrent');
  await backend.saveWorkflow(wf);
  const a = await backend.runWorkflow(wf.id);
  const b = await backend.runWorkflow(wf.id);
  const getRun = backend.getRun.bind(backend);
  const original = (id: string): ReturnType<typeof backend.getRun> => getRun(id);
  let release: () => void = () => {};
  vi.spyOn(backend, 'getRun').mockImplementation((id) =>
    id === a.runId
      ? new Promise((resolve) => {
          release = () => {
            void original(id).then(resolve);
          };
        })
      : original(id),
  );
  const first = useAppStore.getState().openRunOnCanvas(a.runId);
  await useAppStore.getState().openRunOnCanvas(b.runId);
  release();
  await first;
  expect(useAppStore.getState().overlayRunId).toBe(b.runId);
});

it('prevents edits and saves of snapshot definitions and ignores stale refreshes', async () => {
  const backend = __setMockBackendForTests();
  const wf = createEmptyWorkflow('Saved');
  await backend.saveWorkflow(wf);
  const stored = await backend.getWorkflow(wf.id);
  useAppStore.setState({
    workflows: stored === null ? [] : [stored],
    activeWorkflowId: wf.id,
  });
  const { runId } = await backend.runWorkflow(wf.id);
  await useAppStore.getState().openRunOnCanvas(runId);
  const save = vi.spyOn(backend, 'saveWorkflow');
  useAppStore.getState().updateActiveWorkflow({ ...wf, name: 'Wrong' });
  await useAppStore.getState().saveActiveWorkflow();
  expect(save).not.toHaveBeenCalled();
  expect(useAppStore.getState().workflows[0]?.name).toBe('Saved');
  let resolve: (value: []) => void = () => {};
  vi.spyOn(backend, 'getRunResults').mockImplementation(
    () =>
      new Promise<[]>((r) => {
        resolve = r;
      }),
  );
  const refresh = useAppStore.getState().refreshRunOverlay();
  useAppStore.getState().selectWorkflow(wf.id);
  resolve([]);
  await refresh;
  expect(useAppStore.getState().overlayRunId).toBeNull();
});

it('observes only concrete command changes after successful saves', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const wf = createEmptyWorkflow('Observed');
  wf.defaults = { repoDir: '/project' };
  wf.nodes.push({
    id: 'test',
    type: 'command',
    label: 'Tests',
    position: { x: 0, y: 0 },
    config: { executable: 'sh', args: ['-c', 'make old'] },
  });
  const stored = await backend.saveWorkflow(wf);
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: wf.id,
    overlayRunId: null,
  });
  const updated = structuredClone(wf);
  const n = updated.nodes.find((n) => n.id === 'test');
  if (!n) throw new Error('fixture');
  n.config.args = ['-c', 'make test'];
  const observe = vi.spyOn(backend, 'observeEdits');
  useAppStore.getState().updateActiveWorkflow(updated);
  await useAppStore.getState().saveActiveWorkflow();
  expect(observe).toHaveBeenCalledWith([
    { scope: 'repo:/project', field: 'testCommand', from: 'make old', to: 'make test' },
  ]);
  observe.mockClear();
  await useAppStore.getState().saveActiveWorkflow();
  expect(observe).not.toHaveBeenCalled();
});

it('autosaves every edit after leaving the workflow and reports persistence state', async () => {
  const backend = __setMockBackendForTests();
  const stored = await backend.saveWorkflow(createEmptyWorkflow('Autosave'));
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    overlayRunId: null,
  });
  useAppStore
    .getState()
    .updateActiveWorkflow({ ...stored.definition, name: 'Edited without blur' });
  expect(useAppStore.getState().workflowSaveStates[stored.id]?.status).toBe('saving');
  useAppStore.getState().selectWorkflow(null);
  await vi.waitFor(async () =>
    expect((await backend.getWorkflow(stored.id))?.name).toBe('Edited without blur'),
  );
  expect(useAppStore.getState().workflowSaveStates[stored.id]?.status).toBe('saved');
});

it('retains failed autosave drafts across refresh and retries their latest edits', async () => {
  const backend = __setMockBackendForTests();
  const stored = await backend.saveWorkflow(createEmptyWorkflow('Retry'));
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    overlayRunId: null,
  });
  vi.spyOn(backend, 'saveWorkflow').mockRejectedValueOnce(new Error('Disk busy'));
  useAppStore
    .getState()
    .updateActiveWorkflow({ ...stored.definition, name: 'Unsaved draft' });
  await vi.waitFor(() =>
    expect(useAppStore.getState().workflowSaveStates[stored.id]?.status).toBe('error'),
  );
  expect(useAppStore.getState().workflowSaveStates[stored.id]?.error).toContain(
    'Disk busy',
  );
  await useAppStore.getState().refreshWorkflows();
  expect(useAppStore.getState().workflows.find((w) => w.id === stored.id)?.name).toBe(
    'Unsaved draft',
  );
  await useAppStore.getState().retryWorkflowSave(stored.id);
  expect((await backend.getWorkflow(stored.id))?.name).toBe('Unsaved draft');
  expect(useAppStore.getState().workflowSaveStates[stored.id]?.status).toBe('saved');
});

it('preserves a newer draft when a workflow list request returns stale data', async () => {
  const backend = __setMockBackendForTests();
  const stored = await backend.saveWorkflow(createEmptyWorkflow('Refresh race'));
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    overlayRunId: null,
  });
  let release: (value: StoredWorkflow[]) => void = () => {};
  vi.spyOn(backend, 'listWorkflows').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const refresh = useAppStore.getState().refreshWorkflows();
  useAppStore
    .getState()
    .updateActiveWorkflow({ ...stored.definition, name: 'Latest draft' });
  await useAppStore.getState().saveActiveWorkflow();
  release([stored]);
  await refresh;
  expect(useAppStore.getState().workflows.find((w) => w.id === stored.id)?.name).toBe(
    'Latest draft',
  );
});

it('keeps the newest Runs refresh when older list requests finish last', async () => {
  const backend = __setMockBackendForTests();
  const stored = await backend.saveWorkflow(createEmptyWorkflow('Run refresh'));
  const first = await backend.runWorkflow(stored.id);
  const older = await backend.listRuns(100);
  const second = await backend.runWorkflow(stored.id);
  const latest = await backend.listRuns(100);
  let release: (value: typeof older) => void = () => {};
  vi.spyOn(backend, 'listRuns').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  useAppStore.setState({ activeRunId: first.runId });
  const request = useAppStore.getState().refreshRuns();
  await useAppStore.getState().refreshRuns();
  release(older);
  await request;
  expect(useAppStore.getState().runs.map((r) => r.id)).toEqual(latest.map((r) => r.id));
  expect(useAppStore.getState().runs.some((r) => r.id === second.runId)).toBe(true);
  expect(useAppStore.getState().activeRunId).toBe(first.runId);
});

it('deletes a workflow after its pending autosave and prevents draft resurrection', async () => {
  const backend = __setMockBackendForTests();
  const stored = await backend.saveWorkflow(createEmptyWorkflow('Delete pending'));
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    overlayRunId: null,
    selectedNodeId: stored.definition.nodes[0]?.id ?? null,
  });
  const save = backend.saveWorkflow.bind(backend);
  let release: () => void = () => {};
  let started: () => void = () => {};
  const startedSaving = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.spyOn(backend, 'saveWorkflow').mockImplementationOnce(async (definition) => {
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return save(definition);
  });
  useAppStore
    .getState()
    .updateActiveWorkflow({ ...stored.definition, name: 'Pending before delete' });
  const saving = useAppStore.getState().saveActiveWorkflow();
  await startedSaving;
  const deleting = useAppStore.getState().deleteWorkflow(stored.id);
  useAppStore
    .getState()
    .updateActiveWorkflow({ ...stored.definition, name: 'Late edit during deletion' });
  release();
  await saving;
  expect(await deleting).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await useAppStore.getState().refreshWorkflows();
  expect(await backend.getWorkflow(stored.id)).toBeNull();
  expect(useAppStore.getState().workflows.some((w) => w.id === stored.id)).toBe(false);
  expect(useAppStore.getState().workflowSaveStates[stored.id]).toBeUndefined();
  expect(useAppStore.getState().selectedNodeId).toBeNull();
});

it('keeps a failed deletion draft available for saving and retry', async () => {
  const backend = __setMockBackendForTests();
  const stored = await backend.saveWorkflow(createEmptyWorkflow('Failed deletion'));
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    overlayRunId: null,
  });
  useAppStore
    .getState()
    .updateActiveWorkflow({ ...stored.definition, name: 'Retained draft' });
  vi.spyOn(backend, 'deleteWorkflow').mockRejectedValueOnce(new Error('Disk busy'));
  await expect(useAppStore.getState().deleteWorkflow(stored.id)).rejects.toThrow(
    'Disk busy',
  );
  expect(useAppStore.getState().workflows.find((w) => w.id === stored.id)?.name).toBe(
    'Retained draft',
  );
  expect(useAppStore.getState().workflowSaveStates[stored.id]?.status).toBe('error');
  await useAppStore.getState().retryWorkflowSave(stored.id);
  expect((await backend.getWorkflow(stored.id))?.name).toBe('Retained draft');
});

it('ignores a workflow list captured before a successful deletion', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const stored = await backend.saveWorkflow(
    createEmptyWorkflow('Deleted during refresh'),
  );
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    overlayRunId: null,
    workflowSaveStates: {},
  });
  let finish: (rows: StoredWorkflow[]) => void = () => {};
  vi.spyOn(backend, 'listWorkflows').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const loading = useAppStore.getState().refreshWorkflows();
  await useAppStore.getState().deleteWorkflow(stored.id);
  finish([stored]);
  await loading;
  expect(useAppStore.getState().workflows).toEqual([]);
  expect(useAppStore.getState().activeWorkflowId).toBeNull();
  expect(await backend.getWorkflow(stored.id)).toBeNull();
});

it('ignores an older result response for the same selected run', async () => {
  const backend = __setMockBackendForTests();
  const row = {
    id: 1,
    runId: 'selected-run',
    nodeId: 'step',
    status: 'succeeded',
    stdout: 'current',
    stderr: '',
    startedAt: new Date().toISOString(),
  };
  let finish: (rows: (typeof row)[]) => void = () => {};
  vi.spyOn(backend, 'getRunResults')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue([row]);
  const oldRequest = useAppStore.getState().selectRun('selected-run');
  await useAppStore.getState().selectRun('selected-run');
  finish([{ ...row, stdout: 'stale' }]);
  await oldRequest;
  expect(useAppStore.getState().runResults['selected-run']).toEqual([row]);
});

it('does not save a different workflow when a supplied draft no longer matches selection', async () => {
  const backend = __setMockBackendForTests();
  const source = await backend.saveWorkflow(createEmptyWorkflow('Source'));
  const selected = await backend.saveWorkflow(createEmptyWorkflow('Selected'));
  useAppStore.setState({
    workflows: [source, selected],
    activeWorkflowId: selected.id,
    overlayRunId: null,
  });
  const save = vi.spyOn(backend, 'saveWorkflow');
  expect(
    await useAppStore
      .getState()
      .saveActiveWorkflow({ ...source.definition, name: 'Late source edit' }),
  ).toBeUndefined();
  expect(save).not.toHaveBeenCalled();
  expect((await backend.getWorkflow(selected.id))?.name).toBe('Selected');
});

it('shows new inbox notifications once with their severity and preserves inbox history', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const old = {
    id: 1,
    kind: 'success',
    title: 'Old result',
    body: 'Done',
    createdAt: '2026-10-05T12:00:00Z',
    read: false,
  };
  const failure = { ...old, id: 2, kind: 'failure', title: 'Run failed' };
  const success = { ...old, id: 3, title: 'New result' };
  const list = vi.spyOn(backend, 'listNotifications').mockResolvedValue([old]);
  useAppStore.setState({
    notifications: [],
    notificationSnapshotLoaded: false,
    seenNotificationIds: [],
    uiNotices: [],
  });
  await useAppStore.getState().refreshNotifications();
  expect(useAppStore.getState().uiNotices).toEqual([]);
  list.mockResolvedValue([success, failure, old]);
  await useAppStore.getState().refreshNotifications();
  const notices = useAppStore.getState().uiNotices;
  expect(notices.map((n) => [n.content, n.variant])).toEqual([
    ['Run failed: Done', 'error'],
    ['New result: Done', 'info'],
  ]);
  for (const notice of notices) useAppStore.getState().removeUiNotice(notice.id);
  await useAppStore.getState().refreshNotifications();
  expect(useAppStore.getState().uiNotices).toEqual([]);
  expect(useAppStore.getState().notifications).toEqual([success, failure, old]);
});

function resultRow(
  runId: string,
  overrides: Partial<StoredNodeResult> = {},
): StoredNodeResult {
  return {
    id: 1,
    runId,
    nodeId: 'review',
    status: 'succeeded',
    stdout: 'same output',
    stderr: '',
    startedAt: '2026-10-08T10:00:00Z',
    attempt: 1,
    durationMs: 40,
    structuredJson: '{"agentUsage":{"input_tokens":3}}',
    ...overrides,
  };
}

it('compares every result field, never just output length', () => {
  const row = resultRow('r');
  expect(sameNodeResults([row], [{ ...row }])).toBe(true);
  for (const change of [
    { stdout: 'same outpuT' },
    { attempt: 2 },
    { durationMs: 41 },
    { structuredJson: '{"agentUsage":{"input_tokens":4}}' },
    { finishedAt: '2026-10-08T10:01:00Z' },
    { status: 'failed' },
  ]) {
    expect(sameNodeResults([row], [{ ...row, ...change }])).toBe(false);
  }
  expect(sameNodeResults([row], [row, { ...row, id: 2 }])).toBe(false);
});

it('keeps identical results, records the fetched status and replaces changed metadata', async () => {
  const backend = __setMockBackendForTests();
  const first = resultRow('kept');
  const results = vi.spyOn(backend, 'getRunResults').mockResolvedValue([{ ...first }]);
  useAppStore.setState({
    runs: [
      { id: 'kept', workflowId: 'wf', status: 'running', startedAt: first.startedAt },
    ],
    activeRunId: null,
    runResults: {},
    runResultStatus: {},
  });
  await useAppStore.getState().selectRun('kept');
  const cached = useAppStore.getState().runResults.kept;
  expect(useAppStore.getState().runResultStatus.kept).toBe('running');
  await useAppStore.getState().selectRun('kept');
  expect(useAppStore.getState().runResults.kept).toBe(cached);
  useAppStore.setState({
    runs: [
      { id: 'kept', workflowId: 'wf', status: 'succeeded', startedAt: first.startedAt },
    ],
  });
  results.mockResolvedValue([{ ...first, attempt: 2 }]);
  await useAppStore.getState().selectRun('kept');
  expect(useAppStore.getState().runResults.kept).not.toBe(cached);
  expect(useAppStore.getState().runResults.kept?.[0]?.attempt).toBe(2);
  expect(useAppStore.getState().runResultStatus.kept).toBe('succeeded');
});

it('rapid run selection keeps the newest selection and ignores late responses', async () => {
  const backend = __setMockBackendForTests();
  const pending = new Map<string, (rows: ReturnType<typeof resultRow>[]) => void>();
  vi.spyOn(backend, 'getRunResults').mockImplementation(
    (id) =>
      new Promise((resolve) => {
        pending.set(id, resolve);
      }),
  );
  useAppStore.setState({
    runs: [],
    activeRunId: null,
    runResults: {},
    runResultStatus: {},
  });
  const first = useAppStore.getState().selectRun('first');
  const second = useAppStore.getState().selectRun('second');
  pending.get('second')?.([resultRow('second')]);
  await second;
  pending.get('first')?.([resultRow('first')]);
  await first;
  expect(useAppStore.getState().activeRunId).toBe('second');
  expect(useAppStore.getState().runResults.first).toBeUndefined();
  expect(useAppStore.getState().runResults.second?.[0]?.runId).toBe('second');
});
