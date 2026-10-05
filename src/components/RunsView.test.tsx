import { afterEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __setMockBackendForTests } from '../lib/backend';
import { useAppStore } from '../store';
import { RunsView } from './RunsView';

const originalShowRunOverlay = useAppStore.getState().showRunOverlay;

afterEach(() => {
  useAppStore.setState({ showRunOverlay: originalShowRunOverlay });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('opens finished runs on the canvas through exact snapshot navigation', async () => {
  const backend = __setMockBackendForTests();
  vi.spyOn(backend, 'listRuns').mockImplementation(() =>
    Promise.resolve(useAppStore.getState().runs),
  );
  const showRunOverlay = vi.fn().mockResolvedValue(undefined);
  useAppStore.setState({
    runs: [
      {
        id: 'finished-run',
        workflowId: 'wf',
        status: 'succeeded',
        startedAt: new Date().toISOString(),
      },
    ],
    activeRunId: 'finished-run',
    runResults: { 'finished-run': [] },
    workflows: [],
    profiles: [],
    showRunOverlay,
  });
  render(<RunsView />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Show on canvas' }));
  expect(showRunOverlay).toHaveBeenCalledWith('finished-run');
  expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
});

it('disables duplicate decisions and displays approval failures', async () => {
  const backend = __setMockBackendForTests();
  vi.spyOn(backend, 'listRuns').mockImplementation(() =>
    Promise.resolve(useAppStore.getState().runs),
  );
  vi.spyOn(backend, 'getRunResults').mockImplementation((id) =>
    Promise.resolve(useAppStore.getState().runResults[id] ?? []),
  );
  let rejectRequest: (reason: Error) => void = () => {};
  const approve = vi.spyOn(backend, 'approveRun').mockImplementation(
    () =>
      new Promise<void>((_, reject) => {
        rejectRequest = reject;
      }),
  );
  useAppStore.setState({
    runs: [
      {
        id: 'paused-run',
        workflowId: 'wf',
        status: 'paused',
        startedAt: new Date().toISOString(),
      },
    ],
    activeRunId: 'paused-run',
    runResults: {
      'paused-run': [
        {
          id: 7,
          runId: 'paused-run',
          nodeId: 'gate',
          status: 'paused',
          stdout: '',
          stderr: '',
          startedAt: new Date().toISOString(),
        },
      ],
    },
    workflows: [],
    profiles: [],
  });
  render(<RunsView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Approve & continue' }));
  expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel run' })).toBeDisabled();
  expect(approve).toHaveBeenCalledTimes(1);
  expect(approve).toHaveBeenCalledWith('paused-run', true, undefined, 7);
  const cancel = vi.spyOn(backend, 'cancelRun').mockResolvedValue(true);
  act(() => {
    useAppStore.setState({
      runs: useAppStore.getState().runs.map((run) => ({ ...run, status: 'running' })),
    });
  });
  expect(screen.getByRole('button', { name: 'Cancel run' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Cancel run' }));
  expect(cancel).toHaveBeenCalledTimes(1);
  rejectRequest(new Error('Run is no longer paused.'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Run is no longer paused.');
});

it('promotes the successful snapshot command with run evidence only', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const workflow = (await backend.listWorkflows())[0]?.definition;
  if (!workflow) throw new Error('fixture');
  workflow.defaults = { repoDir: '/project' };
  workflow.nodes.push({
    id: 'verified-command',
    type: 'command',
    label: 'Tests',
    position: { x: 0, y: 0 },
    config: { executable: 'sh', args: ['-c', 'make test'] },
  });
  const run = {
    id: 'verified-run',
    workflowId: workflow.id,
    status: 'succeeded' as const,
    startedAt: new Date().toISOString(),
    inputs: {},
  };
  const result = {
    id: 1,
    runId: run.id,
    nodeId: 'verified-command',
    status: 'succeeded',
    stdout: 'private log',
    stderr: '',
    startedAt: run.startedAt,
  };
  vi.spyOn(backend, 'listRuns').mockResolvedValue([run]);
  vi.spyOn(backend, 'getRun').mockResolvedValue(run);
  vi.spyOn(backend, 'getRunWorkflow').mockResolvedValue(workflow);
  vi.spyOn(backend, 'getRunResults').mockResolvedValue([result]);
  useAppStore.setState({
    runs: [run],
    activeRunId: run.id,
    runResults: { [run.id]: [result] },
    workflows: [],
    profiles: [],
  });
  render(<RunsView />);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', { name: 'Save command to playbook' }),
  );
  expect(await screen.findByText(/Saved verified command/)).toBeInTheDocument();
  const context = await backend.getProjectMemoryContext('/project');
  expect(context.text).toContain('make test');
  expect(context.text).toContain('verified-run');
  expect(context.text).not.toContain('private log');
  act(() => useAppStore.setState({ runs: [{ ...run, status: 'failed' }] }));
  expect(screen.queryByRole('button', { name: 'Save command to playbook' })).toBeNull();
});

it('refreshes on every Runs entry and preserves the selected run with current results', async () => {
  const backend = __setMockBackendForTests();
  const oldRun = {
    id: 'selected',
    workflowId: 'wf',
    status: 'succeeded' as const,
    startedAt: '2026-10-05T13:00:00Z',
  };
  const nextRun = { ...oldRun, id: 'new-run' };
  const list = vi.spyOn(backend, 'listRuns').mockResolvedValue([oldRun]);
  const recorded = vi.spyOn(backend, 'getRunResults').mockResolvedValue([]);
  useAppStore.setState({
    runs: [],
    activeRunId: oldRun.id,
    runResults: {},
    workflows: [],
    profiles: [],
  });
  const first = render(<RunsView />);
  await waitFor(() => expect(useAppStore.getState().runs).toEqual([oldRun]));
  await waitFor(() => expect(recorded).toHaveBeenCalledWith(oldRun.id));
  first.unmount();
  list.mockResolvedValue([nextRun, oldRun]);
  render(<RunsView />);
  await waitFor(() => expect(useAppStore.getState().runs).toEqual([nextRun, oldRun]));
  expect(list).toHaveBeenCalledTimes(2);
  expect(useAppStore.getState().activeRunId).toBe(oldRun.id);
});

it('reports a failed entry refresh without discarding cached runs', async () => {
  const backend = __setMockBackendForTests();
  vi.spyOn(backend, 'listRuns').mockRejectedValue(new Error('Cannot load current runs'));
  const cached = {
    id: 'cached',
    workflowId: 'wf',
    status: 'succeeded' as const,
    startedAt: '2026-10-05T13:00:00Z',
  };
  useAppStore.setState({
    runs: [cached],
    activeRunId: null,
    runResults: {},
    workflows: [],
    profiles: [],
  });
  render(<RunsView />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Cannot load current runs');
  expect(useAppStore.getState().runs).toEqual([cached]);
});

it('keeps one polling request in flight while an entry refresh is pending', async () => {
  vi.useFakeTimers();
  const backend = __setMockBackendForTests();
  const running = {
    id: 'live',
    workflowId: 'wf',
    status: 'running' as const,
    startedAt: '2026-10-05T13:00:00Z',
  };
  let finish: (runs: (typeof running)[]) => void = () => {};
  const list = vi.spyOn(backend, 'listRuns').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  useAppStore.setState({
    runs: [running],
    activeRunId: null,
    runResults: {},
    workflows: [],
    profiles: [],
  });
  const view = render(<RunsView />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4500);
  });
  expect(list).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish([running]);
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(list).toHaveBeenCalledTimes(2);
  view.unmount();
  await act(async () => {
    finish([running]);
    await Promise.resolve();
  });
});
