import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { StartRunDialog, UsageLimitsDialog } from './RunControls';
import { createEmptyWorkflow } from '../lib/workflow';

it('submits dry-run fixtures and declared inputs without spend or attempt controls', async () => {
  const workflow = createEmptyWorkflow('Fixture test');
  workflow.inputs = [{ name: 'item', required: true, default: 'example' }];
  workflow.nodes.splice(1, 0, {
    id: 'a',
    type: 'command',
    position: { x: 0, y: 0 },
    config: { executable: 'forbidden' },
  });
  const start = vi.fn().mockResolvedValue(undefined);
  render(
    <StartRunDialog
      workflow={workflow}
      initialDryRun
      onStart={start}
      onClose={() => undefined}
    />,
  );
  fireEvent.change(screen.getByLabelText('Fixture results JSON'), {
    target: { value: '{"a":[{"status":"succeeded","stdout":"done"}]}' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start dry run' }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith(
      { item: 'example' },
      { dryRun: true, fixtures: { a: [{ status: 'succeeded', stdout: 'done' }] } },
    ),
  );
  expect(screen.queryByLabelText('Agent attempts (enforced)')).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/Spend limit USD/)).not.toBeInTheDocument();
});

it('rejects malformed fixture JSON before submission', async () => {
  const start = vi.fn();
  render(
    <StartRunDialog
      workflow={createEmptyWorkflow('Bad')}
      initialDryRun
      onStart={start}
      onClose={() => undefined}
    />,
  );
  fireEvent.change(screen.getByLabelText('Fixture results JSON'), {
    target: { value: '[]' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start dry run' }));
  await waitFor(() =>
    expect(
      screen.getByText('Fixture document must be an object keyed by node id.'),
    ).toBeInTheDocument(),
  );
  expect(start).not.toHaveBeenCalled();
});

it('requires declared inputs and reports the saved attempt budget as the default', async () => {
  const workflow = createEmptyWorkflow('Live limits');
  workflow.inputs = [{ name: 'ticket', required: true }];
  workflow.limits = { maxAgentAttempts: 7 };
  const start = vi.fn().mockResolvedValue(undefined);
  render(
    <StartRunDialog
      workflow={workflow}
      initialDryRun={false}
      onStart={start}
      onClose={() => undefined}
    />,
  );
  // Required input blocks the start.
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
  await waitFor(() =>
    expect(screen.getByText("Input 'ticket' is required.")).toBeInTheDocument(),
  );
  expect(start).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('ticket (required)'), {
    target: { value: 'DEV-1' },
  });
  // The saved budget is visible as the inherited placeholder.
  expect(screen.getByLabelText('Agent attempts (enforced)')).toHaveAttribute(
    'placeholder',
    'Inherit: 7',
  );
  // Blank inherits: no override is sent.
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
  await waitFor(() => expect(start).toHaveBeenCalledWith({ ticket: 'DEV-1' }, {}));
});

it('sends explicit limit overrides and can clear saved limits for one run', async () => {
  const workflow = createEmptyWorkflow('Override');
  workflow.limits = { maxAgentAttempts: 7, spendLimitUsd: 5 };
  const start = vi.fn().mockResolvedValue(undefined);
  render(
    <StartRunDialog
      workflow={workflow}
      initialDryRun={false}
      onStart={start}
      onClose={() => undefined}
    />,
  );
  fireEvent.change(screen.getByLabelText('Agent attempts (enforced)'), {
    target: { value: '3' },
  });
  fireEvent.click(screen.getByText(/Run without saved limits/));
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith(
      {},
      { maxAgentAttempts: 3, ignoreSavedLimits: true },
    ),
  );
});

it('prevents duplicate starts while the first start is still busy', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start = vi.fn().mockImplementation(() => pending);
  const close = vi.fn();
  render(
    <StartRunDialog
      workflow={createEmptyWorkflow('Duplicate')}
      initialDryRun={false}
      onStart={start}
      onClose={close}
    />,
  );
  const button = screen.getByRole('button', { name: 'Start run' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(start).toHaveBeenCalledTimes(1);
  expect(button).toBeDisabled();
  release();
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(start).toHaveBeenCalledTimes(1);
});

it('rejects negative and non-numeric overrides without starting', async () => {
  const start = vi.fn();
  render(
    <StartRunDialog
      workflow={createEmptyWorkflow('Negative')}
      initialDryRun={false}
      onStart={start}
      onClose={() => undefined}
    />,
  );
  fireEvent.change(screen.getByLabelText('Nested subagents (advisory)'), {
    target: { value: '-4' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
  await waitFor(() =>
    expect(
      screen.getByText('Subagent allowance must be a whole number of at least 1.'),
    ).toBeInTheDocument(),
  );
  expect(start).not.toHaveBeenCalled();
});

it('rejects out-of-range overrides without starting', async () => {
  const start = vi.fn();
  render(
    <StartRunDialog
      workflow={createEmptyWorkflow('Range')}
      initialDryRun={false}
      onStart={start}
      onClose={() => undefined}
    />,
  );
  fireEvent.change(screen.getByLabelText('Agent attempts (enforced)'), {
    target: { value: '0' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
  await waitFor(() =>
    expect(
      screen.getByText('Agent attempt limit must be a whole number of at least 1.'),
    ).toBeInTheDocument(),
  );
  expect(start).not.toHaveBeenCalled();
});

it('cancel closes the form without starting or saving overrides', () => {
  const start = vi.fn();
  const close = vi.fn();
  render(
    <StartRunDialog
      workflow={createEmptyWorkflow('Cancel')}
      initialDryRun={false}
      onStart={start}
      onClose={close}
    />,
  );
  fireEvent.change(screen.getByLabelText('Agent attempts (enforced)'), {
    target: { value: '9' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(close).toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

it('saves workflow limits and clears them when every field is empty', async () => {
  const workflow = createEmptyWorkflow('Saved limits');
  const save = vi.fn().mockResolvedValue(undefined);
  const { rerender } = render(
    <UsageLimitsDialog workflow={workflow} onClose={() => undefined} onSave={save} />,
  );
  fireEvent.change(screen.getByLabelText('Agent attempts per run (enforced)'), {
    target: { value: '12' },
  });
  fireEvent.change(screen.getByLabelText(/Spend target USD/), {
    target: { value: '2.5' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({ maxAgentAttempts: 12, spendLimitUsd: 2.5 }),
  );
  rerender(
    <UsageLimitsDialog
      workflow={{ ...workflow, limits: { maxAgentAttempts: 12 } }}
      onClose={() => undefined}
      onSave={save}
    />,
  );
  fireEvent.change(screen.getByLabelText('Agent attempts per run (enforced)'), {
    target: { value: '' },
  });
  fireEvent.change(screen.getByLabelText(/Spend target USD/), {
    target: { value: '' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(undefined));
});
