import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { confirmDialog } from './components/ConfirmDialog';
import { __setMockBackendForTests } from './lib/backend';
import { useAppStore } from './store';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('opens a confirmation above a dialog that is already open', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  __setMockBackendForTests();
  useAppStore.setState({ view: 'runs' });
  render(<App />);
  // A first run opens the setup wizard, a dialog.
  await screen.findByRole('dialog');
  act(() => {
    void confirmDialog({ title: 'Give full access?', message: 'Sure?' });
  });
  const confirm = await screen.findByRole('alertdialog', { name: 'Give full access?' });
  // The top dialog (last in the document) is the one that handles keys.
  const dialogs = document.querySelectorAll('[aria-modal="true"]');
  expect(dialogs[dialogs.length - 1]).toBe(confirm);
});

it('opens the command palette with Ctrl+K, never over another dialog', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  const backend = __setMockBackendForTests();
  await backend.setSetting('onboarding.completed', '1');
  useAppStore.setState({ view: 'home' });
  render(<App />);
  await screen.findByRole('heading', { name: /What do you want done/ });
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
  });
  const palette = await screen.findByRole('dialog', { name: 'Command palette' });
  expect(palette).toBeInTheDocument();
  // A second press while a dialog is open does nothing more.
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
  });
  expect(screen.getAllByRole('dialog', { name: 'Command palette' })).toHaveLength(1);
});

it('shows how many runs are running next to Runs in the sidebar', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  const backend = __setMockBackendForTests();
  await backend.setSetting('onboarding.completed', '1');
  useAppStore.setState({ view: 'home' });
  render(<App />);
  await screen.findByRole('heading', { name: /What do you want done/ });
  expect(screen.getByRole('button', { name: 'Runs' })).toBeInTheDocument();
  const startedAt = new Date().toISOString();
  act(() => {
    useAppStore.setState({
      runs: [
        { id: 'a', workflowId: 'w', status: 'running', startedAt },
        { id: 'b', workflowId: 'w', status: 'running', startedAt },
        { id: 'c', workflowId: 'w', status: 'paused', startedAt },
      ],
    });
  });
  const runs = screen.getByRole('button', { name: 'Runs, 2 running' });
  expect(runs.querySelector('.nav-live')).toHaveTextContent('2');
});
