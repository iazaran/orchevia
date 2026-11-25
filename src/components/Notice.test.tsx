import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Notice, useNoticeMessage } from './Notice';
import { Modal } from './Modal';
import { useAppStore } from '../store';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

it('floats messages above dialogs without reserving space and expires information after five seconds', async () => {
  const source = render(
    <Modal label="Setup">
      <Notice>Saved</Notice>
    </Modal>,
  );
  const stack = screen.getByRole('region', { name: 'Messages' });
  expect(stack.parentElement).toBe(document.body);
  expect(within(screen.getByRole('dialog')).queryByText('Saved')).toBeNull();
  expect(within(stack).getByText('Saved')).toBeInTheDocument();
  source.unmount();
  await act(() => vi.advanceTimersByTime(4999));
  expect(screen.getByText('Saved')).toBeInTheDocument();
  await act(() => vi.advanceTimersByTime(1));
  expect(screen.getByText('Saved').closest('.notice')).toHaveClass('notice-exiting');
  await act(() => vi.advanceTimersByTime(200));
  expect(screen.queryByText('Saved')).toBeNull();
});

it('stacks persistent warnings and errors with independent user dismissal', async () => {
  const source = render(
    <>
      <Notice variant="warn">Needs setup</Notice>
      <Notice variant="error">Failed to save</Notice>
    </>,
  );
  source.unmount();
  await act(() => vi.advanceTimersByTime(10000));
  const stack = screen.getByRole('region', { name: 'Messages' });
  expect(within(stack).getByText('Needs setup')).toBeInTheDocument();
  expect(within(stack).getByText('Failed to save')).toBeInTheDocument();
  fireEvent.click(
    within(screen.getByText('Needs setup').closest('.notice') as HTMLElement).getByRole(
      'button',
      { name: 'Dismiss message' },
    ),
  );
  await act(() => vi.advanceTimersByTime(200));
  expect(screen.queryByText('Needs setup')).toBeNull();
  expect(screen.getByText('Failed to save')).toBeInTheDocument();
});

it('does not replay or restart a notification on unrelated rerenders', async () => {
  const source = render(
    <Notice>
      <span>Imported template</span>
    </Notice>,
  );
  await act(() => vi.advanceTimersByTime(3000));
  source.rerender(
    <Notice>
      <span>Imported template</span>
    </Notice>,
  );
  expect(screen.getAllByText('Imported template')).toHaveLength(1);
  await act(() => vi.advanceTimersByTime(2000));
  await act(() => vi.advanceTimersByTime(200));
  expect(screen.queryByText('Imported template')).toBeNull();
  source.rerender(
    <Notice>
      <span>Imported template</span>
    </Notice>,
  );
  expect(screen.queryByText('Imported template')).toBeNull();
  source.rerender(
    <Notice>
      <span>New message</span>
    </Notice>,
  );
  expect(screen.getByText('New message')).toBeInTheDocument();
});

it('publishes repeated action errors after dismissal and while a prior one is visible', async () => {
  function Action(): React.JSX.Element {
    const [message, setMessage, variant, eventId] = useNoticeMessage('error');
    return (
      <>
        <button onClick={() => setMessage('Pick a repository')}>Create</button>
        {message !== null && (
          <Notice variant={variant} eventId={eventId}>
            {message}
          </Notice>
        )}
      </>
    );
  }
  render(<Action />);
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss message' }));
  await act(() => vi.advanceTimersByTime(200));
  expect(screen.queryByText('Pick a repository')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  const dismiss = screen.getByRole('button', { name: 'Dismiss message' });
  const text = screen.getByText('Pick a repository');
  dismiss.focus();
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  // Only the text is replaced, so the live region announces it again.
  expect(screen.getByText('Pick a repository')).not.toBe(text);
  expect(screen.getByText('Pick a repository')).toHaveClass('notice-repeated');
  // The repeat updates the visible message in place (v0.3.2): one copy, and a
  // focused Dismiss button keeps its focus while a failing action repeats.
  expect(screen.getAllByText('Pick a repository')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Dismiss message' })).toBe(dismiss);
  expect(dismiss).toHaveFocus();
});

it('restarts the lifetime of a repeated message pushed as plain text', async () => {
  // Direct publishers (a failed save, an agent preview error) pass a string.
  act(() => useAppStore.getState().pushUiNotice({ content: 'Saved' }));
  await act(() => vi.advanceTimersByTime(4000));
  act(() => useAppStore.getState().pushUiNotice({ content: 'Saved' }));
  expect(screen.getAllByText('Saved')).toHaveLength(1);
  expect(useAppStore.getState().uiNotices.map((n) => n.revision ?? 0)).toEqual([1]);
  await act(() => vi.advanceTimersByTime(4000));
  expect(screen.getAllByText('Saved')).toHaveLength(1);
  // Five seconds after the repeat it leaves, then slides out.
  await act(() => vi.advanceTimersByTime(1000));
  await act(() => vi.advanceTimersByTime(250));
  expect(screen.queryByText('Saved')).toBeNull();
});

it('keeps different messages stacked while replacing an identical one', () => {
  const source = render(
    <>
      <Notice variant="warn" eventId={1}>
        No saved project knowledge yet.
      </Notice>
      <Notice variant="error">Failed to save</Notice>
    </>,
  );
  source.rerender(
    <>
      <Notice variant="warn" eventId={2}>
        No saved project knowledge yet.
      </Notice>
      <Notice variant="error">Failed to save</Notice>
    </>,
  );
  const stack = screen.getByRole('region', { name: 'Messages' });
  expect(within(stack).getAllByText('No saved project knowledge yet.')).toHaveLength(1);
  expect(within(stack).getByText('Failed to save')).toBeInTheDocument();
  // The same text as a different severity is a different message.
  source.rerender(
    <>
      <Notice variant="error" eventId={3}>
        No saved project knowledge yet.
      </Notice>
      <Notice variant="error">Failed to save</Notice>
    </>,
  );
  expect(within(stack).getAllByText('No saved project knowledge yet.')).toHaveLength(2);
});

it('removes an exiting notice when its slide finishes and dismisses only once', async () => {
  const dismiss = vi.fn();
  render(<Notice onDismiss={dismiss}>Saved once</Notice>);
  await act(() => vi.advanceTimersByTime(5000));
  const notice = screen.getByText('Saved once').closest('.notice') as HTMLElement;
  // React detects the prefixed animation event in jsdom; exercise both surfaces.
  for (const type of ['animationend', 'webkitAnimationEnd']) {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, 'animationName', { value: 'notice-exit' });
    fireEvent(notice, event);
  }
  expect(screen.queryByText('Saved once')).toBeNull();
  expect(dismiss).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTime(1000));
  expect(dismiss).toHaveBeenCalledTimes(1);
});

it("keeps an owner's message when the same message comes back after a remount", () => {
  // fail → clear → fail again: the second <Notice> instance updates the visible
  // message, and the first, unmounted instance must not clear the owner.
  function Owner(): React.JSX.Element {
    const [error, setError] = useState<string | null>(null);
    return (
      <>
        <button onClick={() => setError('Boom')}>Fail</button>
        <button onClick={() => setError(null)}>Clear</button>
        <span data-testid="owner">{error ?? 'none'}</span>
        {error !== null && (
          <Notice variant="error" onDismiss={() => setError(null)}>
            {error}
          </Notice>
        )}
      </>
    );
  }
  render(<Owner />);
  fireEvent.click(screen.getByRole('button', { name: 'Fail' }));
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fail' }));
  expect(screen.getByTestId('owner')).toHaveTextContent('Boom');
  const stack = screen.getByRole('region', { name: 'Messages' });
  expect(within(stack).getAllByText('Boom')).toHaveLength(1);
});
