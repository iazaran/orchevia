import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InboxView } from './InboxView';
import { __setMockBackendForTests } from '../lib/backend';
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
afterEach(() => vi.restoreAllMocks());
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
it('opens the specific graph before marking read and displays navigation errors', async () => {
  const backend = __setMockBackendForTests();
  useAppStore.setState({ notifications: [notification] });
  const open = vi
    .spyOn(useAppStore.getState(), 'openRunOnCanvas')
    .mockRejectedValue(new Error('Unknown run'));
  const mark = vi.spyOn(backend, 'markNotificationRead').mockResolvedValue(undefined);
  render(<InboxView />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Open run' }));
  expect(open).toHaveBeenCalledWith('run-1');
  expect(mark).not.toHaveBeenCalled();
  expect(await screen.findByRole('alert')).toHaveTextContent('Unknown run');
});
