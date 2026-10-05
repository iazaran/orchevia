import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Notice, useNoticeMessage } from './Notice';
import { Modal } from './Modal';

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
  expect(screen.getByText('Pick a repository')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  expect(screen.getAllByText('Pick a repository')).toHaveLength(2);
});
