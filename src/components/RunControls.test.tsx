import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { RunOptionsDialog } from './RunControls';
import { createEmptyWorkflow } from '../lib/workflow';

it('submits dry-run fixtures and declared inputs without actual spend controls', async () => {
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
    <RunOptionsDialog
      workflow={workflow}
      dryRun
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
  expect(screen.queryByLabelText('Spend limit USD')).not.toBeInTheDocument();
});

it('rejects malformed fixture JSON before submission', async () => {
  const start = vi.fn();
  render(
    <RunOptionsDialog
      workflow={createEmptyWorkflow('Bad')}
      dryRun
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
