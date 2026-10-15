import { afterEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InboxView } from './InboxView';
import { RunsView } from './RunsView';
import { __setMockBackendForTests } from '../lib/backend';
import { createEmptyWorkflow, type StoredRun } from '../lib/workflow';
import { useAppStore } from '../store';
const notification = {
  id: 1,
  kind: 'failure',
  title: 'Run failed',
  body: 'Details',
  read: false,
  runId: 'run-1',
  createdAt: new Date().toISOString(),
};
// Spying on a store method then calling setState bakes the mock into the next
// state object (zustand merges by spread), which restoreAllMocks cannot reach.
// Reseed the pristine implementations after every test.
const pristineStoreMethods = {
  openRunInRuns: useAppStore.getState().openRunInRuns,
  refreshNotifications: useAppStore.getState().refreshNotifications,
};
afterEach(() => {
  vi.restoreAllMocks();
  useAppStore.setState({ ...pristineStoreMethods });
});

it('does not mark read when a repeated navigation is cancelled with the same old overlay', async () => {
  const backend = __setMockBackendForTests();
  useAppStore.setState({ notifications: [notification], overlayRunId: 'run-1' });
  let resolve: (committed: boolean) => void = () => {};
  vi.spyOn(useAppStore.getState(), 'openRunInRuns').mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const mark = vi.spyOn(backend, 'markNotificationRead').mockResolvedValue(undefined);
  render(<InboxView />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Open run' }));
  useAppStore.getState().setView('automations');
  await act(async () => {
    resolve(false);
    await Promise.resolve();
  });
  expect(mark).not.toHaveBeenCalled();
});
it('shows unread items, retains history and hides successfully read items', async () => {
  const backend = __setMockBackendForTests();
  useAppStore.setState({
    notifications: [
      notification,
      { ...notification, id: 2, title: 'Read already', read: true },
    ],
  });
  vi.spyOn(backend, 'markNotificationRead').mockResolvedValue(undefined);
  vi.spyOn(useAppStore.getState(), 'refreshNotifications').mockImplementation(() => {
    useAppStore.setState({ notifications: [{ ...notification, read: true }] });
    return Promise.resolve();
  });
  render(<InboxView />);
  const user = userEvent.setup();
  expect(screen.queryByText('Read already')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Mark read' }));
  await waitFor(() => expect(screen.queryByText('Run failed')).toBeNull());
  await user.click(screen.getByRole('button', { name: 'Show read history' }));
  expect(screen.getByText('Run failed')).toBeInTheDocument();
});
it('opens the exact run in Runs before marking read and displays navigation errors', async () => {
  const backend = __setMockBackendForTests();
  useAppStore.setState({ notifications: [notification] });
  const open = vi
    .spyOn(useAppStore.getState(), 'openRunInRuns')
    .mockRejectedValue(new Error('Unknown run'));
  const mark = vi.spyOn(backend, 'markNotificationRead').mockResolvedValue(undefined);
  render(<InboxView />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Open run' }));
  expect(open).toHaveBeenCalledWith('run-1');
  expect(mark).not.toHaveBeenCalled();
  expect(await screen.findByRole('alert')).toHaveTextContent('Unknown run');
});

it('navigates to Runs and selects the exact run, then marks read', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const stored = await backend.saveWorkflow(createEmptyWorkflow('Inbox target'));
  const { runId } = await backend.runWorkflow(stored.id);
  const note = { ...notification, runId };
  useAppStore.setState({ notifications: [note], view: 'inbox', runs: [] });
  const mark = vi.spyOn(backend, 'markNotificationRead').mockResolvedValue(undefined);
  vi.spyOn(backend, 'listNotifications').mockResolvedValue([{ ...note, read: true }]);
  render(<InboxView />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Open run' }));
  await waitFor(() => expect(useAppStore.getState().view).toBe('runs'));
  expect(useAppStore.getState().activeRunId).toBe(runId);
  expect(mark).toHaveBeenCalledWith(note.id);
});

it('opens an older run outside the recent list and a run with a deleted workflow', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const stored = await backend.saveWorkflow(createEmptyWorkflow('Inbox old'));
  const first = await backend.runWorkflow(stored.id);
  const second = await backend.runWorkflow(stored.id);
  const latest = await backend.getRun(second.runId);
  // Simulate a capped recent list holding only the newest run.
  useAppStore.setState({
    notifications: [{ ...notification, runId: first.runId }],
    view: 'inbox',
    runs: latest === null ? [] : [latest],
  });
  vi.spyOn(backend, 'markNotificationRead').mockResolvedValue(undefined);
  // The mock backend stores no notifications; keep the store list stable
  // across the refresh that follows each successful navigation.
  vi.spyOn(backend, 'listNotifications').mockImplementation(() =>
    Promise.resolve(useAppStore.getState().notifications),
  );
  render(<InboxView />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Open run' }));
  await waitFor(() => expect(useAppStore.getState().activeRunId).toBe(first.runId));
  expect(useAppStore.getState().runs.some((run) => run.id === first.runId)).toBe(true);
  // A run whose workflow record is gone still opens: only the run row is read.
  const orphan = {
    id: 'orphan-run',
    workflowId: 'deleted-workflow',
    status: 'succeeded',
    startedAt: new Date().toISOString(),
  } as const;
  vi.spyOn(backend, 'getRun').mockResolvedValue({ ...orphan });
  vi.spyOn(backend, 'getRunResults').mockResolvedValue([]);
  useAppStore.setState({
    notifications: [
      { ...notification, id: 9, runId: 'orphan-run', title: 'Old failure' },
    ],
  });
  // Wait for the re-render: clicking the stale row would hit the previous
  // notification's still-pending guard instead of the orphan.
  await screen.findByText('Old failure');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Open run' }));
  await waitFor(() => expect(useAppStore.getState().activeRunId).toBe('orphan-run'));
});

it('leaves the notification unread when the run is missing', async () => {
  const backend = __setMockBackendForTests();
  useAppStore.setState({ notifications: [notification], view: 'inbox' });
  vi.spyOn(backend, 'getRun').mockResolvedValue(null);
  const mark = vi.spyOn(backend, 'markNotificationRead').mockResolvedValue(undefined);
  render(<InboxView />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Open run' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Unknown run');
  expect(mark).not.toHaveBeenCalled();
  expect(useAppStore.getState().view).toBe('inbox');
  expect(useAppStore.getState().notifications[0]?.read).toBe(false);
});

it('ignores duplicate Open run clicks while navigation is pending', async () => {
  const backend = __setMockBackendForTests();
  useAppStore.setState({ notifications: [notification], view: 'inbox' });
  let release!: (run: StoredRun | null) => void;
  const gate = new Promise<StoredRun | null>((resolve) => {
    release = resolve;
  });
  const getRun = vi.spyOn(backend, 'getRun').mockReturnValue(gate);
  const mark = vi.spyOn(backend, 'markNotificationRead').mockResolvedValue(undefined);
  render(<InboxView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Open run' }));
  await user.click(screen.getByRole('button', { name: 'Opening…' }));
  expect(getRun).toHaveBeenCalledTimes(1);
  await act(async () => {
    release({
      id: 'run-1',
      workflowId: 'wf-1',
      status: 'succeeded',
      startedAt: new Date().toISOString(),
    });
    await Promise.resolve();
  });
  await waitFor(() => expect(mark).toHaveBeenCalledTimes(1));
});

it('marks read when Runs mounts and refreshes the directly opened run', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const run: StoredRun = {
    id: 'inbox-run',
    workflowId: 'wf',
    status: 'succeeded',
    startedAt: '2026-10-15T10:00:00Z',
  };
  let finish: (rows: []) => void = () => {};
  vi.spyOn(backend, 'getRun').mockResolvedValue(run);
  vi.spyOn(backend, 'getRunWorkflow').mockResolvedValue(null);
  vi.spyOn(backend, 'listRuns').mockResolvedValue([run]);
  const results = vi
    .spyOn(backend, 'getRunResults')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue([]);
  const mark = vi.spyOn(backend, 'markNotificationRead').mockResolvedValue(undefined);
  useAppStore.setState({
    view: 'inbox',
    notifications: [{ ...notification, runId: run.id }],
    runs: [],
    activeRunId: null,
    runResults: {},
    runResultStatus: {},
  });
  function NavigationHarness(): React.JSX.Element {
    const view = useAppStore((state) => state.view);
    return view === 'runs' ? <RunsView /> : <InboxView />;
  }
  render(<NavigationHarness />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Open run' }));
  await waitFor(() => expect(results).toHaveBeenCalledTimes(1));
  await act(async () => {
    finish([]);
    await Promise.resolve();
  });
  await waitFor(() => expect(mark).toHaveBeenCalledWith(notification.id));
  expect(useAppStore.getState().view).toBe('runs');
  expect(useAppStore.getState().activeRunId).toBe(run.id);
});
