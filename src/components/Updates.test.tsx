import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { __setMockBackendForTests } from '../lib/backend';
import { useAppStore } from '../store';
import { UpdateBanner, UpdatesSection } from './Updates';

const newer = {
  current: '0.1.20',
  latest: {
    version: '0.2.0',
    url: 'https://github.com/iazaran/orchevia/releases/tag/v0.2.0',
    assets: [],
  },
  updateAvailable: true,
  checkedAt: '2026-11-01T10:00:00Z',
};

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ updateCheck: null, updateError: null, updateChecking: false });
});

it('shows a newer release until the user hides that version', async () => {
  const backend = __setMockBackendForTests();
  useAppStore.setState({ updateCheck: newer });
  const user = userEvent.setup();
  const { unmount } = render(<UpdateBanner />);
  expect(await screen.findByText('Orchevia 0.2.0 is ready.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Hide this update notice' }));
  expect(screen.queryByText('Orchevia 0.2.0 is ready.')).toBeNull();
  await waitFor(async () => {
    expect(await backend.getSetting('updates.dismissedVersion')).toBe('0.2.0');
  });
  unmount();
  render(<UpdateBanner />);
  // Still hidden after a restart; a later release would show again.
  await waitFor(() => expect(screen.queryByText(/is ready/)).toBeNull());
});

it('stays quiet when up to date', async () => {
  __setMockBackendForTests();
  useAppStore.setState({ updateCheck: { ...newer, updateAvailable: false } });
  render(<UpdateBanner />);
  await waitFor(() => expect(screen.queryByText(/is ready/)).toBeNull());
});

it('lets the user turn automatic checks off and see the result', async () => {
  const backend = __setMockBackendForTests();
  useAppStore.setState({ updateCheck: newer });
  const user = userEvent.setup();
  render(<UpdatesSection />);
  const toggle = screen.getByRole('switch', { name: 'Check for updates automatically' });
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
  await user.click(toggle);
  await waitFor(async () => {
    expect(await backend.getSetting('updates.check')).toBe('0');
  });
  expect(screen.getByRole('status')).toHaveTextContent('Orchevia 0.2.0 is available');
  expect(screen.getByRole('button', { name: "What's new" })).toBeInTheDocument();
});
