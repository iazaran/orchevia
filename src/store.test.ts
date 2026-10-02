import { afterEach, expect, it, vi } from 'vitest';
import { __setMockBackendForTests } from './lib/backend';
import { createEmptyWorkflow } from './lib/workflow';
import { useAppStore } from './store';
afterEach(() => vi.restoreAllMocks());

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
