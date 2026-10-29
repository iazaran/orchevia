import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { __setMockBackendForTests } from '../lib/backend';
import { useAppStore } from '../store';
import { UpdateBanner, UpdatesSection } from './Updates';
import { ConfirmHost } from './ConfirmDialog';

const newer = {
  current: '0.1.20',
  latest: {
    version: '0.2.0',
    url: 'https://github.com/iazaran/orchevia/releases/tag/v0.2.0',
    assets: [] as { name: string; url: string }[],
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

it('installs in place only after confirmation and shows why it could not', async () => {
  const backend = __setMockBackendForTests();
  backend.desktopInfo = () =>
    Promise.resolve({
      platform: 'linux',
      arch: 'x86_64',
      installKind: 'appimage',
      inPlaceUpdates: true,
    });
  const installs: string[] = [];
  backend.installUpdate = (version) => {
    installs.push(version);
    return Promise.reject(
      new Error(
        'Finish or cancel the 1 running workflow first: restarting would stop it.',
      ),
    );
  };
  const manifest = {
    name: 'latest.json',
    url: 'https://github.com/iazaran/orchevia/releases/download/v0.2.0/latest.json',
  };
  useAppStore.setState({
    updateCheck: { ...newer, latest: { ...newer.latest, assets: [manifest] } },
  });
  const user = userEvent.setup();
  render(
    <>
      <UpdatesSection />
      <ConfirmHost />
    </>,
  );
  const button = await screen.findByRole('button', { name: 'Install and restart' });
  expect(
    screen.getByText(/Install and restart downloads the signed update/),
  ).toBeVisible();
  await user.click(button);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(installs).toEqual([]);
  await user.click(button);
  const dialog = await screen.findByRole('alertdialog', {
    name: 'Install Orchevia 0.2.0?',
  });
  await user.click(within(dialog).getByRole('button', { name: 'Install and restart' }));
  expect(await screen.findByText(/running workflow first/)).toBeInTheDocument();
  expect(installs).toEqual(['0.2.0']);
  expect(screen.getByRole('button', { name: 'Install and restart' })).toBeEnabled();
});

it('keeps the download path for copies that cannot update themselves', async () => {
  __setMockBackendForTests();
  useAppStore.setState({ updateCheck: newer });
  render(<UpdatesSection />);
  await screen.findByText(/Orchevia 0.2.0 is available/);
  expect(screen.queryByRole('button', { name: 'Install and restart' })).toBeNull();
});

it('offers no in-place install for a release without a signed manifest', async () => {
  const backend = __setMockBackendForTests();
  backend.desktopInfo = () =>
    Promise.resolve({
      platform: 'macos',
      arch: 'arm64',
      installKind: 'app',
      inPlaceUpdates: true,
    });
  useAppStore.setState({ updateCheck: newer });
  render(<UpdatesSection />);
  // The copy could update itself, but this release has nothing signed to install.
  expect(await screen.findByText(/Quit Orchevia, open/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Install and restart' })).toBeNull();
});
