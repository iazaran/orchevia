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
