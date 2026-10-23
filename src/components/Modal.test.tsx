import { describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Notice } from './Notice';
import { Modal } from './Modal';
import { ConfirmHost, confirmDialog } from './ConfirmDialog';

describe('notice banner', () => {
  it('renders variants with dismiss', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <Notice inline variant="error" onDismiss={onDismiss}>
        <span>broken</span>
      </Notice>,
    );
    const banner = screen.getByRole('alert');
    expect(banner.className).toContain('notice');
    expect(banner.className).toContain('error');
    expect(banner.className).toContain('has-dismiss');
    await user.click(screen.getByRole('button', { name: 'Dismiss message' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    rerender(
      <Notice inline>
        <span>plain</span>
      </Notice>,
    );
    expect(screen.getByRole('status').className).not.toContain('has-dismiss');
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('modal shell', () => {
  it('keeps keyboard focus inside, closes on Escape, and restores the opener', async () => {
    const user = userEvent.setup();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const { unmount } = render(
      <Modal label="Keyboard demo" onClose={onClose}>
        <input aria-label="Name" />
        <button>Save</button>
      </Modal>,
    );
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Save' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('does not dismiss a busy dialog on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal label="Busy" closeDisabled onClose={onClose}>
        <input />
      </Modal>,
    );
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
  it('closes via ✕ and backdrop independently', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onBackdrop = vi.fn();
    render(
      <Modal
        label="Demo"
        onClose={onClose}
        onBackdrop={onBackdrop}
        closeLabel="Close demo"
      >
        <span>body</span>
      </Modal>,
    );
    expect(screen.getByRole('dialog', { name: 'Demo' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Close demo' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onBackdrop).not.toHaveBeenCalled();
  });

  it('omits the ✕ when no onClose is given', () => {
    render(
      <Modal label="Forced">
        <span>body</span>
      </Modal>,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});

it('allows keyboard access to message dismiss buttons above a modal', async () => {
  const user = userEvent.setup();
  render(
    <>
      <Modal label="Notification access">
        <input aria-label="Name" />
        <Notice variant="warn">Needs setup</Notice>
      </Modal>
      <button>Background action</button>
    </>,
  );
  expect(screen.getByLabelText('Name')).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Dismiss message' })).toHaveFocus();
  await user.tab();
  expect(screen.getByLabelText('Name')).toHaveFocus();
});

describe('dismissing and confirming', () => {
  it('closes on a backdrop click but not when a drag ends outside the card', async () => {
    const user = userEvent.setup();
    const onBackdrop = vi.fn();
    render(
      <Modal label="Editor" onBackdrop={onBackdrop}>
        <input aria-label="Name" defaultValue="Nightly checks" />
      </Modal>,
    );
    const backdrop = screen.getByRole('dialog', { name: 'Editor' });
    // Select text in the field and let go outside the card.
    await user.pointer([
      { keys: '[MouseLeft>]', target: screen.getByLabelText('Name') },
      { target: backdrop },
      { keys: '[/MouseLeft]' },
    ]);
    expect(onBackdrop).not.toHaveBeenCalled();
    await user.click(backdrop);
    expect(onBackdrop).toHaveBeenCalledTimes(1);
  });

  it('returns focus to the button that asked for a confirmation', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button
          onClick={() => void confirmDialog({ title: 'Delete it?', message: 'Sure?' })}
        >
          Delete
        </button>
        <ConfirmHost />
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('alertdialog')).toContainElement(
      document.activeElement instanceof HTMLElement ? document.activeElement : null,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveFocus();
  });

  it('cancels an open confirmation that a newer one replaces', async () => {
    render(<ConfirmHost />);
    let first: Promise<boolean> = Promise.resolve(true);
    act(() => {
      first = confirmDialog({ title: 'First?', message: '' });
      void confirmDialog({ title: 'Second?', message: '' });
    });
    await expect(first).resolves.toBe(false);
    expect(screen.getByRole('alertdialog', { name: 'Second?' })).toBeInTheDocument();
  });
});
