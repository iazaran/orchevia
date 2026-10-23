import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { SetupStatus } from './SetupStatus';
import { useAppStore } from '../store';
import { createEmptyWorkflow, type ValidationIssue } from '../lib/workflow';

const workflow = createEmptyWorkflow('Setup');
workflow.nodes.push({
  id: 'cmd',
  type: 'command',
  label: 'Run tests',
  position: { x: 0, y: 0 },
  config: {},
});

it('renders nothing when the workflow needs nothing', () => {
  const { container } = render(<SetupStatus workflow={workflow} issues={[]} />);
  expect(container).toBeEmptyDOMElement();
});

it('keeps needs behind a quiet count and selects a step from the list', async () => {
  useAppStore.setState({ selectedNodeId: null });
  const issues: ValidationIssue[] = [
    {
      code: 'command-executable',
      message: 'Command node requires an executable.',
      severity: 'error',
      nodeId: 'cmd',
    },
    { code: 'unreachable', message: 'Nothing reaches End.', severity: 'warning' },
  ];
  const user = userEvent.setup();
  render(<SetupStatus workflow={workflow} issues={issues} />);
  // No alert: the count waits in the toolbar until the user opens it.
  expect(screen.queryByRole('alert')).toBeNull();
  const summary = screen.getByText('1 to finish');
  const list = screen.getByRole('list', { name: 'Workflow setup', hidden: true });
  expect(list).not.toBeVisible();
  await user.click(summary);
  expect(list).toBeVisible();
  expect(list).toHaveTextContent('Nothing reaches End.');
  await user.click(screen.getByRole('button', { name: /Run tests/ }));
  expect(useAppStore.getState().selectedNodeId).toBe('cmd');
  expect(list).not.toBeVisible();
  // Clicking elsewhere closes an open list too.
  await user.click(summary);
  expect(list).toBeVisible();
  await user.click(document.body);
  expect(list).not.toBeVisible();
});

it('calls warnings notes when nothing blocks a run', () => {
  render(
    <SetupStatus
      workflow={workflow}
      issues={[{ code: 'w', message: 'Consider a timeout.', severity: 'warning' }]}
    />,
  );
  expect(screen.getByText('1 note')).toBeInTheDocument();
});
