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
