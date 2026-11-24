import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkflowTransfer } from './WorkflowTransfer';
import { useAppStore } from '../store';
import { __setMockBackendForTests } from '../lib/backend';
import { createEmptyWorkflow, type Workflow } from '../lib/workflow';

afterEach(cleanup);

it('exports the open workflow as n8n JSON with notes', async () => {
  __setMockBackendForTests();
  useAppStore.setState({ profiles: [] });
  const wf = createEmptyWorkflow('Hello');
  wf.nodes.splice(1, 0, {
    id: 'ok',
    type: 'approval',
    label: 'Approve',
    position: { x: 0, y: 100 },
    config: { message: 'Go?' },
  });
  render(<WorkflowTransfer workflow={wf} onClose={vi.fn()} onImport={vi.fn()} />);
  expect(screen.getByRole('radio', { name: 'Export' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'n8n workflow' })).toBeChecked();
  expect(document.querySelector('.transfer-output')?.textContent).toContain(
    'n8n-nodes-base.manualTrigger',
  );
  expect(screen.getByText(/Approvals become Wait nodes/)).toBeVisible();
  await userEvent
    .setup()
    .click(screen.getByRole('radio', { name: 'Orchevia Simple JSON' }));
  await waitFor(() =>
    expect(document.querySelector('.transfer-output')?.textContent).toContain(
      '"version": 1',
    ),
  );
});

it('imports n8n JSON as a new, arranged workflow', async () => {
  __setMockBackendForTests();
  useAppStore.setState({ profiles: [] });
  const onImport = vi.fn<(wf: Workflow, notes: string[]) => Promise<void>>(() =>
    Promise.resolve(),
  );
  render(<WorkflowTransfer workflow={null} onClose={vi.fn()} onImport={onImport} />);
  expect(screen.getByRole('radio', { name: 'Import' })).toBeChecked();
  const n8n = {
    name: 'From n8n',
    nodes: [
      { name: 'Go', type: 'n8n-nodes-base.manualTrigger', parameters: {} },
      {
        name: 'List files',
        type: 'n8n-nodes-base.executeCommand',
        parameters: { command: 'ls -la' },
      },
    ],
    connections: { Go: { main: [[{ node: 'List files', type: 'main', index: 0 }]] } },
  };
  const user = userEvent.setup();
  const input = screen.getByLabelText('Workflow JSON');
  await user.click(input);
  await user.paste(JSON.stringify(n8n));
  expect(screen.getByText('n8n workflow')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Create workflow' }));
  await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
  const [created, notes] = onImport.mock.calls[0] ?? [];
  expect(created?.name).toBe('From n8n');
  expect(created?.nodes.map((n) => n.type)).toEqual(['start', 'command', 'end']);
  expect(created?.nodes.find((n) => n.type === 'command')?.config.args).toEqual([
    '-c',
    'ls -la',
  ]);
  // Arranged top to bottom rather than stacked at one point.
  const ys = created?.nodes.map((n) => n.position.y) ?? [];
  expect(new Set(ys).size).toBe(3);
  expect(notes?.join(' ')).toMatch(/Command steps run on this computer/);
});

it('shows a syntax error instead of importing broken JSON', async () => {
  __setMockBackendForTests();
  useAppStore.setState({ profiles: [] });
  const onImport = vi.fn(() => Promise.resolve());
  render(<WorkflowTransfer workflow={null} onClose={vi.fn()} onImport={onImport} />);
  const user = userEvent.setup();
  await user.click(screen.getByLabelText('Workflow JSON'));
  await user.paste('{"nodes": [}');
  expect(screen.getByText(/Line 1, column 12: Expected a value/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Create workflow' })).toBeDisabled();
  expect(onImport).not.toHaveBeenCalled();
});
