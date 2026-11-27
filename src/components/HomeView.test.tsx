import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { __setMockBackendForTests } from '../lib/backend';
import { builtinTemplates } from '../lib/templates';
import { createEmptyWorkflow } from '../lib/workflow';
import { localDayStart } from '../lib/dashboard';
import { daysInMonth, emptyUsageSummary, formatUsd } from '../lib/usage';
import { useAppStore } from '../store';
import { HomeView } from './HomeView';
import { CommandPalette, paletteMatches } from './CommandPalette';

afterEach(() => {
  vi.restoreAllMocks();
});

function seed(): void {
  __setMockBackendForTests();
  const workflow = createEmptyWorkflow('Weekly report');
  const now = new Date().toISOString();
  useAppStore.setState({
    view: 'home',
    workflows: [
      {
        id: workflow.id,
        name: workflow.name,
        definition: workflow,
        createdAt: now,
        updatedAt: now,
      },
    ],
    runs: [
      { id: 'r-wait', workflowId: workflow.id, status: 'paused', startedAt: now },
      {
        id: 'r-fail',
        workflowId: workflow.id,
        status: 'failed',
        startedAt: now,
        finishedAt: now,
      },
    ],
    profiles: [],
    schedules: [],
    watchers: [],
    notifications: [],
    activeRuns: [],
    builtinTemplates: builtinTemplates(),
    userTemplates: [],
    pendingIntent: null,
    templateDomain: 'all',
    templateQuery: '',
  });
}

it('drafts a typed goal in the generator and starts from a kind of work', () => {
  seed();
  render(<HomeView />);
  const goal = screen.getByLabelText('Describe what you want done');
  const draft = screen.getByRole('button', { name: /Draft a workflow/ });
  expect(draft).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: /Turn meeting notes/ }));
  expect(goal).toHaveValue('Turn meeting notes into action items and a follow-up email');
  fireEvent.click(draft);
  expect(useAppStore.getState().pendingIntent).toEqual({
    kind: 'generate',
    goal: 'Turn meeting notes into action items and a follow-up email',
  });
  expect(useAppStore.getState().view).toBe('workflows');

  useAppStore.setState({ view: 'home' });
  fireEvent.click(screen.getByRole('button', { name: /Media & design/ }));
  expect(useAppStore.getState().templateDomain).toBe('media');
  expect(useAppStore.getState().view).toBe('templates');
});

it('lists what needs you, the setup left and recent work', () => {
  seed();
  render(<HomeView />);
  const attention = screen.getByRole('region', { name: 'Needs you' });
  expect(within(attention).getByText('Waiting')).toBeInTheDocument();
  expect(within(attention).getByText('Failed')).toBeInTheDocument();
  const setup = screen.getByRole('region', { name: /Get set up · 1 of 3/ });
  const done = within(setup).getByText('Run your first workflow').closest('li');
  expect(done).toHaveClass('done');
  expect(done).toHaveTextContent('(done)');
  fireEvent.click(within(setup).getAllByRole('button', { name: 'Start' })[0]!);
  expect(useAppStore.getState().view).toBe('agents');
  useAppStore.setState({ view: 'home' });
  const workflows = screen.getByRole('region', { name: 'Your workflows' });
  fireEvent.click(within(workflows).getByRole('button', { name: 'Run Weekly report' }));
  expect(useAppStore.getState().pendingIntent).toEqual({ kind: 'run' });
  expect(useAppStore.getState().view).toBe('workflows');
});

it('shows a running run’s progress, what needs you, this month’s usage and what is next', async () => {
  seed();
  const backend = __setMockBackendForTests();
  const workflow = useAppStore.getState().workflows[0]!.definition;
  workflow.nodes.push(
    { id: 'draft', type: 'agent', label: 'Draft', position: { x: 0, y: 0 }, config: {} },
    { id: 'edit', type: 'agent', label: 'Edit', position: { x: 0, y: 0 }, config: {} },
  );
  const now = new Date().toISOString();
  const soon = new Date(Date.now() + 30 * 60_000).toISOString();
  useAppStore.setState({
    runs: [
      { id: 'r-live', workflowId: workflow.id, status: 'running', startedAt: now },
      ...useAppStore.getState().runs,
    ],
    notifications: [
      // About the waiting run, which is already listed: shown once.
      {
        id: 2,
        kind: 'approval',
        title: 'Approval needed',
        body: 'Weekly report waits.',
        runId: 'r-wait',
        createdAt: now,
        read: false,
      },
      {
        id: 1,
        kind: 'findings',
        title: '3 findings to fix',
        body: 'Two reviewers agreed.',
        createdAt: now,
        read: false,
      },
    ],
    schedules: [
      {
        id: 's',
        name: 'Morning digest',
        workflowId: workflow.id,
        kind: { kind: 'daily', hour: 9, minute: 0 },
        timezone: 'UTC',
        enabled: true,
        trusted: true,
        missedPolicy: 'skip',
        nextRunAt: soon,
      },
    ],
  });
  vi.spyOn(backend, 'getRunWorkflow').mockResolvedValue(workflow);
  vi.spyOn(backend, 'getRunResults').mockResolvedValue([
    {
      id: 1,
      runId: 'r-live',
      nodeId: 'draft',
      status: 'succeeded',
      stdout: '',
      stderr: '',
      startedAt: now,
    },
    {
      id: 2,
      runId: 'r-live',
      nodeId: 'edit',
      status: 'running',
      stdout: '',
      stderr: '',
      startedAt: now,
    },
  ]);
  const summary = emptyUsageSummary();
  summary.totals.agentAttempts = 12;
  summary.totals.inputTokens = 1_500_000;
  summary.totals.coverage.inputTokens = 12;
  summary.totals.coverage.outputTokens = 12;
  summary.totals.reportedUsd = 4.5;
  summary.totals.reportedUsdAttempts = 12;
  summary.byWorkflow = [
    {
      workflowId: workflow.id,
      workflowName: 'Weekly report',
      runs: 3,
      agentAttempts: 12,
      reportedUsd: 4.5,
      unknownUsdAttempts: 0,
    },
  ];
  summary.providerDays = [
    {
      day: now.slice(0, 10),
      adapter: 'claude',
      agentAttempts: 12,
      durationMs: 1000,
      reportedUsd: 4.5,
      reportedUsdAttempts: 12,
      allAgentAttempts: 12,
      allDurationMs: 1000,
    },
  ];
  const usage = vi.spyOn(backend, 'usageSummary').mockResolvedValue(summary);
  vi.spyOn(backend, 'getSetting').mockImplementation((key) =>
    Promise.resolve(
      key === 'usage.plans'
        ? JSON.stringify({ claude: { billing: 'subscription', monthlyUsd: 300 } })
        : null,
    ),
  );
  render(<HomeView />);

  const live = screen.getByRole('region', { name: /Running now/ });
  expect(await within(live).findByText('1 of 2 steps done · Edit')).toBeInTheDocument();
  expect(
    within(live).getByRole('progressbar', { name: 'Weekly report progress' }),
  ).toHaveAttribute('aria-valuenow', '1');
  expect(screen.getByRole('list', { name: 'Right now' })).toHaveTextContent('1 running');

  const attention = screen.getByRole('region', { name: /Needs you/ });
  expect(within(attention).queryByText('Approval needed')).toBeNull();
  expect(within(attention).getByText('3 findings to fix')).toBeInTheDocument();
  fireEvent.click(within(attention).getByRole('button', { name: 'Inbox' }));
  expect(useAppStore.getState().view).toBe('inbox');

  const month = screen.getByRole('region', { name: /Usage this month/ });
  await waitFor(() => {
    expect(within(month).getByText('API value reported').parentElement).toHaveTextContent(
      'USD 4.50',
    );
  });
  expect(within(month).getByText('1.5M')).toBeInTheDocument();
  expect(
    within(month).getByRole('list', { name: /most agent attempts/ }),
  ).toHaveTextContent('Weekly report12');
  // The month so far, in whole UTC days.
  // A monthly plan's fee for the one day it was used, never the API value.
  const day = now.slice(0, 10);
  const estimate = formatUsd(300 / daysInMonth(day));
  expect(
    within(month).getByText('Estimated on your plans').parentElement,
  ).toHaveTextContent(estimate);
  const tile = screen.getByRole('button', { name: /Cost this month/ });
  expect(tile).toHaveTextContent(estimate);
  expect(tile).not.toHaveTextContent('USD 4.50');
  // The UTC month so far, in whole days.
  const filter = usage.mock.calls[0]?.[0];
  expect(filter?.from).toBe(`${now.slice(0, 7)}-01T00:00:00.000Z`);
  expect(Date.parse(filter?.to ?? '')).toBe(
    Date.parse(`${day}T00:00:00.000Z`) + 86_400_000,
  );

  const next = screen.getByRole('region', { name: /Up next/ });
  expect(within(next).getByText('Morning digest')).toBeInTheDocument();
  expect(within(next).getByText(/^in (29|30) min$/)).toBeInTheDocument();
});

it('counts the whole window from the backend, not the capped recent list', async () => {
  seed();
  const backend = __setMockBackendForTests();
  const startedAt = new Date().toISOString();
  const stamps = Array.from({ length: 150 }, () => ({
    status: 'succeeded' as const,
    startedAt,
    finishedAt: startedAt,
  }));
  const window = vi.spyOn(backend, 'runStamps').mockResolvedValue(stamps);
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(emptyUsageSummary());
  render(<HomeView />);
  const runs = screen.getByRole('button', { name: /Runs, last 7 days/ });
  await waitFor(() => {
    expect(runs).toHaveTextContent('150');
  });
  // From local midnight of the chart's first day.
  const since = Date.parse(window.mock.calls[0]?.[0] ?? '');
  expect(since).toBe(localDayStart(Date.now(), 13));
  // No plans: the cost tile says so instead of showing the API value.
  expect(screen.getByRole('button', { name: /Cost this month/ })).toHaveTextContent(
    'Enter your plans in Usage for an estimate',
  );
});

it('says where the items that did not fit are', () => {
  seed();
  const startedAt = new Date().toISOString();
  useAppStore.setState({
    runs: Array.from({ length: 5 }, (_, i) => ({
      id: `w${String(i)}`,
      workflowId: `wf${String(i)}`,
      status: 'paused' as const,
      startedAt,
    })),
    notifications: [
      {
        id: 1,
        kind: 'findings',
        title: 'Findings',
        body: '',
        createdAt: startedAt,
        read: false,
      },
      {
        id: 2,
        kind: 'success',
        title: 'Done',
        body: '',
        createdAt: startedAt,
        read: false,
      },
    ],
  });
  render(<HomeView />);
  const attention = screen.getByRole('region', { name: /Needs you/ });
  fireEvent.click(within(attention).getByRole('button', { name: /1 more in Runs/ }));
  expect(useAppStore.getState().view).toBe('runs');
  fireEvent.click(within(attention).getByRole('button', { name: /1 more in the Inbox/ }));
  expect(useAppStore.getState().view).toBe('inbox');
  expect(within(attention).queryByText('Done')).toBeNull();
});

it('keeps older waiting runs, says when opening fails, and marks overdue slots due', async () => {
  seed();
  const backend = __setMockBackendForTests();
  const long = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const past = new Date(Date.now() - 5 * 60_000).toISOString();
  const workflow = useAppStore.getState().workflows[0]!;
  useAppStore.setState({
    runs: [],
    // Out of the recent list, still waiting.
    activeRuns: [
      { id: 'old-wait', workflowId: workflow.id, status: 'paused', startedAt: long },
    ],
    schedules: [
      {
        id: 's',
        name: 'Nightly',
        workflowId: workflow.id,
        kind: { kind: 'daily', hour: 9, minute: 0 },
        timezone: 'UTC',
        enabled: true,
        trusted: true,
        missedPolicy: 'skip',
        nextRunAt: past,
      },
    ],
    uiNotices: [],
  });
  vi.spyOn(backend, 'getRun').mockResolvedValue(null);
  const summary = emptyUsageSummary();
  summary.totals.agentAttempts = 3;
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(summary);
  render(<HomeView />);
  const attention = screen.getByRole('region', { name: /Needs you/ });
  expect(within(attention).getByText('Weekly report')).toBeInTheDocument();
  fireEvent.click(within(attention).getByRole('button', { name: 'Review' }));
  await waitFor(() => {
    expect(useAppStore.getState().uiNotices.map((n) => n.text)).toContain(
      "Unknown run 'old-wait'.",
    );
  });
  const next = screen.getByRole('region', { name: /Up next/ });
  expect(within(next).getByText('due now')).toBeInTheDocument();
  // A CLI that reports no tokens shows unknown, never a measured zero.
  const month = screen.getByRole('region', { name: /Usage this month/ });
  expect(await within(month).findByText('Tokens not reported')).toBeInTheDocument();
  expect(within(month).getByText('API value not reported')).toBeInTheDocument();
});

it('keeps the figures and the chart out of a fresh install', () => {
  seed();
  useAppStore.setState({ runs: [] });
  render(<HomeView />);
  expect(
    screen.queryByRole('region', { name: 'The last 7 days at a glance' }),
  ).toBeNull();
  expect(screen.queryByRole('region', { name: /Activity/ })).toBeNull();
  expect(screen.getByText('Nothing is running.')).toBeInTheDocument();
  expect(screen.getByText('All clear.')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: /Get set up · 0 of 3/ })).toBeInTheDocument();
});

it('finds views, workflows, templates and drafts from a long query', () => {
  seed();
  const onClose = vi.fn();
  render(<CommandPalette onClose={onClose} onOpenWizard={() => undefined} />);
  const box = screen.getByRole('combobox', {
    name: 'Search views, workflows, templates and actions',
  });
  expect(box).toHaveFocus();
  fireEvent.change(box, { target: { value: 'run weekly' } });
  expect(screen.getByRole('option', { name: /Run Weekly report/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(onClose).toHaveBeenCalled();
  expect(useAppStore.getState().pendingIntent).toEqual({ kind: 'run' });

  fireEvent.change(box, { target: { value: 'video cuts' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(useAppStore.getState().view).toBe('templates');
  expect(useAppStore.getState().templateQuery).toBe('Social Video Cuts');

  fireEvent.change(box, { target: { value: 'summarize my inbox every morning' } });
  const draft = screen.getByRole('option', { name: /Draft a workflow/ });
  fireEvent.click(draft);
  expect(useAppStore.getState().pendingIntent).toEqual({
    kind: 'generate',
    goal: 'summarize my inbox every morning',
  });
  expect(
    paletteMatches(
      {
        id: 'x',
        label: 'Usage & costs',
        group: 'Go to',
        icon: 'usage',
        run: () => undefined,
      },
      'GO usage',
    ),
  ).toBe(true);
});

it('moves through results with the arrow keys', () => {
  seed();
  render(<CommandPalette onClose={() => undefined} onOpenWizard={() => undefined} />);
  const box = screen.getByRole('combobox');
  const options = screen.getAllByRole('option');
  expect(options[0]).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(box, { key: 'ArrowDown' });
  expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(box, { key: 'ArrowUp' });
  fireEvent.keyDown(box, { key: 'ArrowUp' });
  const all = screen.getAllByRole('option');
  expect(all[all.length - 1]).toHaveAttribute('aria-selected', 'true');
  expect(box).toHaveAttribute('aria-activedescendant', all[all.length - 1]?.id);
});

it('reads schedules again every 30 seconds so Up next moves on', () => {
  vi.useFakeTimers();
  try {
    seed();
    const original = useAppStore.getState().refreshAutomations;
    const refresh = vi.fn().mockResolvedValue(undefined);
    useAppStore.setState({ refreshAutomations: refresh });
    const { unmount } = render(<HomeView />);
    vi.advanceTimersByTime(29_000);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    unmount();
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    useAppStore.setState({ refreshAutomations: original });
  } finally {
    vi.useRealTimers();
  }
});
