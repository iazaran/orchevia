import { afterEach, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __setMockBackendForTests } from '../lib/backend';
import { useAppStore } from '../store';
import { RunsView } from './RunsView';

afterEach(() => {
  vi.restoreAllMocks();
});

it('disables duplicate decisions and displays approval failures', async () => {
  const backend = __setMockBackendForTests();
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
