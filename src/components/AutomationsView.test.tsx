import userEvent from '@testing-library/user-event';
import { createEmptyWorkflow } from '../lib/workflow';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { __setMockBackendForTests } from '../lib/backend';
import { useAppStore } from '../store';
import { AutomationsView } from './AutomationsView';

describe('watcher status', () => {
  it('shows the next poll and quiet result while reserving the dismiss area', async () => {
    __setMockBackendForTests();
    useAppStore.setState({
      workflows: [],
      schedules: [],
      notifications: [],
      notificationPrefs: null,
      watchers: [
        {
          id: 'watch',
          name: 'Requested',
          workflowId: 'wf',
          kind: 'reviewRequested',
          repoDir: '/repo',
          enabled: true,
          checkIntervalSecs: 900,
          lastCheckedAt: '2026-10-05T13:21:24Z',
          lastResult: 'quiet: no new requested revisions',
        },
      ],
    });
    render(<AutomationsView />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save interval' }).hasAttribute('disabled'),
      ).toBe(false),
    );
    expect(screen.getByText('Next check')).toBeDefined();
    expect(screen.getByTitle('2026-10-05T13:36:24.000Z')).toBeDefined();
    expect(screen.getByText('quiet: no new requested revisions')).toBeDefined();
    expect(
      screen
        .getByRole('button', { name: "Delete watcher 'Requested'" })
        .closest('.tool-card')
        ?.classList.contains('has-dismiss'),
    ).toBe(true);
  });
});

it('shows repository validation before allowing an enabled watcher save', async () => {
  const backend = __setMockBackendForTests();
  const workflow = createEmptyWorkflow('Review');
  workflow.id = 'wf';
  workflow.nodes.push({
    id: 'pr',
    type: 'github',
    position: { x: 0, y: 0 },
    config: { workingDir: '/other', githubOp: { op: 'prDetails', number: 0 } },
  });
  const stored = await backend.saveWorkflow(workflow);
  const saved = await backend.saveWatcher({
    id: 'watch',
    name: 'Requested',
    workflowId: 'wf',
    kind: 'reviewRequested',
    repoDir: '/repo',
    enabled: false,
    checkIntervalSecs: 900,
  });
  useAppStore.setState({
    workflows: [stored],
    schedules: [],
    watchers: [saved],
    notifications: [],
    notificationPrefs: null,
  });
  const user = userEvent.setup();
  render(<AutomationsView />);
  await user.click(screen.getByRole('button', { name: 'Edit' }));
  await user.click(screen.getByRole('checkbox', { name: /Enabled/ }));
  await waitFor(() =>
    expect(
      screen.getByText(/Watcher repository does not match workflow node/),
    ).toBeDefined(),
  );
  expect(
    screen.getByRole('button', { name: 'Save watcher' }).hasAttribute('disabled'),
  ).toBe(true);
});
