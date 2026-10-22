import userEvent from '@testing-library/user-event';
import { createEmptyWorkflow } from '../lib/workflow';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { __setMockBackendForTests } from '../lib/backend';
import { useAppStore } from '../store';
import { AutomationsView } from './AutomationsView';
import { ConfirmHost } from './ConfirmDialog';
import type { Schedule } from '../lib/scheduler';

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
    const toggle = await screen.findByRole('switch', { name: "Run watcher 'Requested'" });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    const header = toggle.closest('.automation-head-actions');
    expect(header).not.toBeNull();
    expect(
      within(header as HTMLElement).getByRole('button', {
        name: "Delete watcher 'Requested'",
      }),
    ).toBeInTheDocument();
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

it('keeps automation reference guidance in the view rather than expiring it', async () => {
  localStorage.clear();
  __setMockBackendForTests();
  useAppStore.setState({
    workflows: [],
    schedules: [],
    watchers: [],
    notifications: [],
    notificationPrefs: null,
  });
  const rendered = render(<AutomationsView />);
  await screen.findByRole('switch', { name: 'Keep running when the window closes' });
  expect(rendered.container).toHaveTextContent('Orchevia must be running');
  expect(localStorage.getItem('orchevia.automationsHint.v1')).toBeNull();
});

function readOnlySchedule(enabled: boolean): Schedule {
  return {
    id: 'sched',
    name: 'Review PRs',
    workflowId: 'wf',
    kind: { kind: 'interval', everySecs: 300 },
    timezone: 'local',
    enabled,
    trusted: false,
    missedPolicy: 'skip',
  };
}

async function storedReadOnlyWorkflow(): Promise<void> {
  const workflow = createEmptyWorkflow('Review');
  workflow.id = 'wf';
  const stored = await (
    await import('../lib/backend')
  )
    .getBackend()
    .saveWorkflow(workflow);
  useAppStore.setState({ workflows: [stored] });
}

it('pauses and resumes a schedule from its card', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  await storedReadOnlyWorkflow();
  const saved = await backend.saveSchedule(readOnlySchedule(true));
  useAppStore.setState({
    schedules: [saved],
    watchers: [],
    notifications: [],
    notificationPrefs: null,
  });
  const user = userEvent.setup();
  render(<AutomationsView />);
  const toggle = screen.getByRole('switch', { name: "Run schedule 'Review PRs'" });
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  await user.click(toggle);
  await waitFor(async () => {
    expect((await backend.listSchedules())[0]?.enabled).toBe(false);
  });
  await waitFor(() =>
    expect(
      screen.getByRole('switch', { name: "Run schedule 'Review PRs'" }),
    ).toHaveAttribute('aria-checked', 'false'),
  );
  expect(screen.getByText('Paused', { selector: 'dd' })).toBeInTheDocument();
  await user.click(screen.getByRole('switch', { name: "Run schedule 'Review PRs'" }));
  await waitFor(async () => {
    expect((await backend.listSchedules())[0]?.enabled).toBe(true);
  });
});

it('explains a refused resume instead of flipping the switch', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const workflow = createEmptyWorkflow('Writes');
  workflow.id = 'wf';
  workflow.nodes.push({
    id: 'cmd',
    type: 'command',
    position: { x: 0, y: 0 },
    config: { executable: 'echo' },
  });
  const stored = await backend.saveWorkflow(workflow);
  const saved = await backend.saveSchedule(readOnlySchedule(false));
  useAppStore.setState({
    workflows: [stored],
    schedules: [saved],
    watchers: [],
    notifications: [],
    notificationPrefs: null,
  });
  const user = userEvent.setup();
  render(<AutomationsView />);
  await user.click(screen.getByRole('switch', { name: "Run schedule 'Review PRs'" }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/trust/i);
  expect((await backend.listSchedules())[0]?.enabled).toBe(false);
  expect(
    screen.getByRole('switch', { name: "Run schedule 'Review PRs'" }),
  ).toHaveAttribute('aria-checked', 'false');
});

it('offers an in-app quit for desktops without a tray', async () => {
  localStorage.clear();
  __setMockBackendForTests();
  useAppStore.setState({
    workflows: [],
    schedules: [],
    watchers: [],
    notifications: [],
    notificationPrefs: null,
    backgroundMode: true,
  });
  const user = userEvent.setup();
  render(
    <>
      <ConfirmHost />
      <AutomationsView />
    </>,
  );
  expect(
    screen.getByRole('switch', { name: 'Keep running when the window closes' }),
  ).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByText(/keeps Orchevia running/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Quit Orchevia' }));
  await user.click(await screen.findByRole('button', { name: 'Quit' }));
  // The browser mock cannot quit; the desktop app exits here.
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Quit is available in the desktop app.',
  );
});

it('shows and edits a one-time schedule in local time', async () => {
  localStorage.clear();
  __setMockBackendForTests();
  await storedReadOnlyWorkflow();
  const at = new Date(2030, 0, 2, 9, 30).toISOString();
  useAppStore.setState({
    schedules: [{ ...readOnlySchedule(false), kind: { kind: 'oneTime', at } }],
    watchers: [],
    notifications: [],
    notificationPrefs: null,
  });
  const user = userEvent.setup();
  render(<AutomationsView />);
  await user.click(screen.getByRole('button', { name: 'Edit' }));
  expect(screen.getByLabelText('Run once at (local time)')).toHaveValue(
    '2030-01-02T09:30',
  );
});
