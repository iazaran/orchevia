import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { UsageView } from './UsageView';
import { __setMockBackendForTests } from '../lib/backend';
import { createDefaultProfile } from '../lib/agents';
import { createEmptyWorkflow } from '../lib/workflow';
import { useAppStore } from '../store';
import { emptyUsageSummary, type UsageSummary } from '../lib/usage';

it('shows profile usage with current names, saved IDs and explicit unknown USD coverage', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  useAppStore.setState({
    workflows: [],
    profiles: [{ ...createDefaultProfile('claude'), id: 'p1', name: 'Renamed profile' }],
  });
  const summary = {
    ...emptyUsageSummary(),
    runsScanned: 2,
    byProfile: [
      {
        profileId: 'p1',
        runs: 2,
        agentAttempts: 3,
        totalDurationMs: 1500,
        lastRunAt: '2026-10-01T00:00:00.000Z',
        reportedUsd: 1.25,
        reportedUsdAttempts: 2,
        unknownUsdAttempts: 1,
      },
      {
        profileId: 'deleted-profile',
        runs: 1,
        agentAttempts: 1,
        totalDurationMs: 120000,
        reportedUsd: 0,
        reportedUsdAttempts: 1,
        unknownUsdAttempts: 0,
      },
      {
        profileId: null,
        runs: 1,
        agentAttempts: 1,
        totalDurationMs: 0,
        reportedUsd: 0,
        reportedUsdAttempts: 0,
        unknownUsdAttempts: 1,
      },
    ],
  };
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(summary);
  render(<UsageView />);
  const tab = await screen.findByRole('tab', { name: 'AI profile' });
  await userEvent.setup().click(tab);
  const section = await screen.findByRole('tabpanel', { name: 'By AI profile' });
  const current = within(section).getByRole('row', { name: /Renamed profile/ });
  expect(current).toHaveTextContent('current name');
  expect(current).toHaveTextContent('USD 1.25');
  expect(current).toHaveTextContent('2/3 reports');
  expect(current).toHaveTextContent('1 unknown');
  expect(current).toHaveTextContent('2s');
  expect(within(current).getByTitle('2026-10-01T00:00:00.000Z')).toBeInTheDocument();
  const deleted = within(section).getByRole('row', { name: /deleted-profile/ });
  expect(deleted).toHaveTextContent('USD 0.00');
  expect(deleted).toHaveTextContent('1/1 reports');
  expect(deleted).toHaveTextContent('2m');
  const unknown = within(section).getByRole('row', { name: /^Unknown/ });
  expect(unknown).toHaveTextContent('0/1 reports');
  expect(unknown).toHaveTextContent('1 unknown');
  expect(unknown).not.toHaveTextContent('USD 0.00');
  expect(within(section).getByText(/saved run snapshot/)).toBeInTheDocument();
});

it('keeps the newest usage response after filters change', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  useAppStore.setState({ workflows: [] });
  const requests: ((summary: UsageSummary) => void)[] = [];
  vi.spyOn(backend, 'usageSummary').mockImplementation(
    () => new Promise((resolve) => requests.push(resolve)),
  );
  render(<UsageView />);
  await waitFor(() => expect(requests).toHaveLength(1));
  await userEvent.selectOptions(screen.getByLabelText('Provider'), 'codex');
  await waitFor(() => expect(requests).toHaveLength(2));
  const latest = emptyUsageSummary();
  latest.runsScanned = 1;
  latest.totals.runs = 7;
  await act(async () => {
    requests[1]?.(latest);
    await Promise.resolve();
  });
  expect(screen.getByText('7')).toBeInTheDocument();
  const stale = emptyUsageSummary();
  stale.runsScanned = 1;
  stale.totals.runs = 99;
  await act(async () => {
    requests[0]?.(stale);
    await Promise.resolve();
  });
  expect(screen.queryByText('99')).not.toBeInTheDocument();
  expect(screen.getByText('7')).toBeInTheDocument();
});

it('keeps subscription allocation independent of filtered execution counts', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  await backend.setSetting(
    'usage.subscriptionFees',
    JSON.stringify([
      { label: 'Claude', amountUsd: 120, period: '2026-10-01/2026-11-01' },
    ]),
  );
  await backend.setSetting('usage.allocationShare', '50');
  const summary = emptyUsageSummary();
  summary.runsScanned = 1;
  summary.totals.runs = 1;
  summary.totals.agentAttempts = 2;
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(summary);
  useAppStore.setState({ workflows: [] });
  render(<UsageView />);
  await waitFor(() =>
    expect(screen.getByText(/Allocated to Orchevia-tracked work/)).toBeInTheDocument(),
  );
  expect(screen.queryByText(/per tracked attempt/)).not.toBeInTheDocument();
  expect(screen.queryByText(/per tracked run/)).not.toBeInTheDocument();
  expect(
    screen.getByText(/independent of the current history filters/),
  ).toBeInTheDocument();
});

it('allocates full overlapping billing periods while retaining outside and legacy fees', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  await backend.setSetting(
    'usage.subscriptionFees',
    JSON.stringify([
      { label: 'Current', amountUsd: 120, period: '2026-10-01/2026-11-01' },
      { label: 'Past', amountUsd: 120, period: '2026-09-01/2026-10-01' },
      { label: 'Legacy', amountUsd: 50, period: 'monthly' },
    ]),
  );
  await backend.setSetting('usage.allocationShare', '50');
  useAppStore.setState({ workflows: [] });
  render(<UsageView />);
  fireEvent.change(screen.getByLabelText('From (inclusive)'), {
    target: { value: '2026-10-10' },
  });
  fireEvent.change(screen.getByLabelText('To (inclusive)'), {
    target: { value: '2026-10-15' },
  });
  await waitFor(() =>
    expect(screen.getByText(/Allocated to Orchevia-tracked work/)).toHaveTextContent(
      'USD 60.00',
    ),
  );
  const past = screen.getByRole('row', { name: /Past/ });
  expect(past).toHaveTextContent('USD 120.00');
  expect(past).toHaveTextContent('outside allocation');
  const legacy = screen.getByRole('row', { name: /Legacy/ });
  expect(legacy).toHaveTextContent('USD 50.00');
  expect(legacy).toHaveTextContent('outside allocation');
});

function workflowWithAgent(name: string): ReturnType<typeof createEmptyWorkflow> {
  const wf = createEmptyWorkflow(name);
  wf.nodes.splice(1, 0, {
    id: 'agent1',
    type: 'agent',
    position: { x: 80, y: 120 },
    config: { agentProfileId: 'p1', prompt: 'Do it' },
    label: 'Agent',
  });
  wf.edges.push({ id: 'e-agent', source: wf.nodes[0]?.id ?? 's', target: 'agent1' });
  return wf;
}

it('aggregates mock history with honest unknown coverage and separate money lanes', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const profile = await backend.saveAgentProfile({
    ...createDefaultProfile('claude'),
    name: 'Usage profile',
  });
  const wf = workflowWithAgent('Usage wf');
  const agent = wf.nodes.find((n) => n.type === 'agent');
  if (agent) agent.config.agentProfileId = profile.id;
  const stored = await backend.saveWorkflow(wf);
  useAppStore.setState({ workflows: [stored], activeWorkflowId: stored.id });
  const { runId } = await backend.runWorkflow(stored.id, {});
  await waitFor(
    async () => {
      const run = await backend.getRun(runId);
      expect(run?.status).toBe('succeeded');
    },
    { timeout: 5000 },
  );
  render(<UsageView />);
  await waitFor(() => expect(screen.getByText('Workflow runs')).toBeInTheDocument());
  // Mock agent rows carry no CLI usage envelope: attempts exist, USD unknown.
  // The label appears on the overview card and the daily table header.
  expect(screen.getAllByText('Agent attempts', { exact: true })).toHaveLength(2);
  expect(screen.getByText('Estimated API value', { exact: true })).toBeInTheDocument();
  expect(screen.getByText(/legacy unknown/)).toBeInTheDocument();
  // Money lanes stay visibly separate.
  expect(screen.getByText(/Subscription & allocation settings/)).toBeInTheDocument();
  expect(screen.getByText(/API-equivalent target/)).toBeInTheDocument();
  // Thin history offers no fabricated rates.
  expect(screen.getByText(/Insufficient history/)).toBeInTheDocument();
});

it('saves subscription fees and shows an explicitly labeled allocation', async () => {
  localStorage.clear();
  __setMockBackendForTests();
  useAppStore.setState({ workflows: [] });
  render(<UsageView />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Fee label'), 'Claude');
  await user.type(screen.getByLabelText('Fee amount (USD)'), '120');
  await user.type(
    screen.getByLabelText('Billing period (UTC range)'),
    '2026-10-01/2026-11-01',
  );
  await user.click(screen.getByRole('button', { name: 'Add fee' }));
  expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument();
  await user.type(screen.getByLabelText('Orchevia share %'), '50');
  await user.click(screen.getByRole('button', { name: 'Save subscription settings' }));
  await waitFor(() =>
    expect(screen.getByText(/Allocated to Orchevia-tracked work/)).toBeInTheDocument(),
  );
  expect(screen.getByText(/Outside or untracked usage is excluded/)).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Save subscription settings' }),
  ).toBeDisabled();
  const backend = __setMockBackendForTests();
  // Settings persist through the backend contract (mock twin included).
  await waitFor(async () =>
    expect(await backend.getSetting('usage.subscriptionFees')).toContain('Claude'),
  );
});

function usageSummaryWithDays(): UsageSummary {
  const summary = emptyUsageSummary();
  summary.runsScanned = 2;
  summary.totals.runs = 2;
  summary.totals.agentAttempts = 4;
  summary.days = [
    {
      day: '2026-10-01',
      runs: 1,
      agentAttempts: 3,
      reportedUsd: 1.5,
      inputTokens: 100,
      outputTokens: 50,
    },
    {
      day: '2026-10-05',
      runs: 1,
      agentAttempts: 1,
      reportedUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
  ];
  return summary;
}

it('fills sparse days with explicit zeroes, draws no bar for zero, and tables exact values', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  useAppStore.setState({ workflows: [] });
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(usageSummaryWithDays());
  const { container } = render(<UsageView />);
  fireEvent.change(screen.getByLabelText('From (inclusive)'), {
    target: { value: '2026-10-01' },
  });
  fireEvent.change(screen.getByLabelText('To (inclusive)'), {
    target: { value: '2026-10-05' },
  });
  const chart = await screen.findByRole('img', {
    name: /Agent attempts per UTC day from 2026-10-01 to 2026-10-05/,
  });
  // Only nonzero days produce a bar; zero days have no positive-looking rect.
  const bars = container.querySelectorAll('rect.usage-bar');
  expect(bars).toHaveLength(2);
  const titles = [...bars].map((bar) => bar.querySelector('title')?.textContent ?? '');
  expect(titles.some((t) => t.includes('2026-10-01'))).toBe(true);
  expect(titles.some((t) => t.includes('2026-10-03'))).toBe(false);
  // Visible axes: zero baseline tick plus horizontal date labels.
  expect(within(chart).getByText('0')).toBeInTheDocument();
  expect(
    screen.getByText(/Metric: agent attempts per UTC calendar day/),
  ).toBeInTheDocument();
  // The gap day is labeled on the axis and tabulated with exact values.
  expect(within(chart).getByText('10-03')).toBeInTheDocument();
  const tableToggle = screen.getByText(/Daily table \(5 days, UTC\)/);
  await userEvent.setup().click(tableToggle);
  const table = screen.getByRole('table', {
    name: /reported USD subtotal per UTC day/i,
  });
  const gapRow = within(table).getByRole('row', { name: /2026-10-03/ });
  expect(gapRow).toHaveTextContent('0');
  expect(within(table).getByRole('row', { name: /2026-10-01/ })).toHaveTextContent(
    'USD 1.50',
  );
  expect(screen.getAllByText(/missing reports excluded/)).toHaveLength(2);
});

it('renders a bounded single-day chart without giant blocks', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  useAppStore.setState({ workflows: [] });
  const summary = emptyUsageSummary();
  summary.runsScanned = 1;
  summary.totals.runs = 1;
  summary.totals.agentAttempts = 2;
  summary.days = [
    {
      day: '2026-10-07',
      runs: 1,
      agentAttempts: 2,
      reportedUsd: 0.4,
      inputTokens: 10,
      outputTokens: 5,
    },
  ];
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(summary);
  const { container } = render(<UsageView />);
  fireEvent.change(screen.getByLabelText('From (inclusive)'), {
    target: { value: '2026-10-07' },
  });
  fireEvent.change(screen.getByLabelText('To (inclusive)'), {
    target: { value: '2026-10-07' },
  });
  await screen.findByRole('img', {
    name: /Agent attempts per UTC day from 2026-10-07 to 2026-10-07/,
  });
  const bars = container.querySelectorAll('rect.usage-bar');
  expect(bars).toHaveLength(1);
  const svg = container.querySelector('svg.usage-chart');
  expect(svg?.getAttribute('style')).toContain('height: 240');
  // A two-attempt day uses integer ticks only — never fractional steps.
  const ticks = [...(svg?.querySelectorAll('text') ?? [])].map((t) => t.textContent);
  expect(ticks).toContain('0');
  expect(ticks).toContain('2');
  expect(ticks.every((t) => /^\d+$/.test(t) || /^\d{2}-\d{2}$/.test(t))).toBe(true);
});

it('rejects reversed dates with inline validation before requesting', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  useAppStore.setState({ workflows: [] });
  const usage = vi.spyOn(backend, 'usageSummary').mockResolvedValue(emptyUsageSummary());
  render(<UsageView />);
  await waitFor(() => expect(usage).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText('From (inclusive)'), {
    target: { value: '2026-10-10' },
  });
  await waitFor(() => expect(usage).toHaveBeenCalledTimes(2));
  fireEvent.change(screen.getByLabelText('To (inclusive)'), {
    target: { value: '2026-10-05' },
  });
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Start date must be on or before the end date.',
  );
  expect(usage).toHaveBeenCalledTimes(2);
  fireEvent.change(screen.getByLabelText('To (inclusive)'), {
    target: { value: '2026-10-12' },
  });
  await waitFor(() => expect(usage).toHaveBeenCalledTimes(3));
});

it('applies date presets and resets every filter', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  useAppStore.setState({ workflows: [] });
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(emptyUsageSummary());
  render(<UsageView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Last 7 days' }));
  const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  await waitFor(() =>
    expect(screen.getByLabelText('From (inclusive)')).toHaveValue(weekAgo),
  );
  await user.selectOptions(screen.getByLabelText('Provider'), 'codex');
  await user.type(screen.getByLabelText('Model'), 'gpt-x');
  await user.click(screen.getByRole('button', { name: 'Reset filters' }));
  expect(screen.getByLabelText('Provider')).toHaveValue('');
  expect(screen.getByLabelText('Model')).toHaveValue('');
});

it('keeps subscription drafts and reports failure without claiming success', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  useAppStore.setState({ workflows: [] });
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(emptyUsageSummary());
  vi.spyOn(backend, 'setSetting').mockRejectedValueOnce(new Error('disk full'));
  render(<UsageView />);
  const user = userEvent.setup();
  await screen.findByText(/No runs in this range/);
  await user.type(screen.getByLabelText('Fee label'), 'Claude');
  await user.type(screen.getByLabelText('Fee amount (USD)'), '120');
  await user.type(
    screen.getByLabelText('Billing period (UTC range)'),
    '2026-10-01/2026-11-01',
  );
  await user.click(screen.getByRole('button', { name: 'Add fee' }));
  await user.type(screen.getByLabelText('Orchevia share %'), '50');
  await user.click(screen.getByRole('button', { name: 'Save subscription settings' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
  expect(screen.queryByText(/Subscription settings saved/)).not.toBeInTheDocument();
  // The draft survives the failure and still needs saving.
  expect(screen.getByRole('row', { name: /Claude/ })).toHaveTextContent('USD 120.00');
  expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Save subscription settings' }),
  ).toBeEnabled();
});

function modelSummary(): UsageSummary {
  const summary = emptyUsageSummary();
  summary.runsScanned = 3;
  summary.totals.runs = 3;
  summary.totals.agentAttempts = 9;
  const coverage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    toolCalls: 0,
    subagents: 0,
  };
  summary.byModel = [
    {
      adapter: 'claude',
      model: 'opus-full',
      agentAttempts: 4,
      inputTokens: 1000,
      outputTokens: 500,
      reportedUsd: 2,
      reportedUsdAttempts: 4,
      unknownUsdAttempts: 0,
      observedToolCalls: 8,
      observedSubagents: 0,
      cachedInputTokens: 0,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 100,
      reasoningOutputTokens: 50,
      coverage: {
        ...coverage,
        inputTokens: 4,
        outputTokens: 4,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 4,
        reasoningOutputTokens: 2,
        toolCalls: 4,
        subagents: 4,
      },
    },
    {
      adapter: 'codex',
      model: 'gpt-partial',
      agentAttempts: 4,
      inputTokens: 300,
      outputTokens: 0,
      reportedUsd: 0,
      reportedUsdAttempts: 0,
      unknownUsdAttempts: 4,
      observedToolCalls: 0,
      observedSubagents: 0,
      cachedInputTokens: 120,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      coverage: { ...coverage, inputTokens: 2, cachedInputTokens: 2 },
    },
    {
      adapter: 'custom',
      model: 'tiny',
      agentAttempts: 1,
      inputTokens: 10,
      outputTokens: 5,
      reportedUsd: 0.001,
      reportedUsdAttempts: 1,
      unknownUsdAttempts: 0,
      observedToolCalls: 0,
      observedSubagents: 0,
      cachedInputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      coverage: { ...coverage, inputTokens: 1, outputTokens: 1 },
    },
  ];
  return summary;
}

it('separates partial, unknown and measured-zero provider figures without inventing support', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  useAppStore.setState({ workflows: [] });
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(modelSummary());
  render(<UsageView />);
  await userEvent
    .setup()
    .click(await screen.findByRole('tab', { name: 'Provider & model' }));
  const section = await screen.findByRole('tabpanel', {
    name: 'By provider and model',
  });
  const full = within(section).getByRole('row', { name: /opus-full/ });
  // Thousands separators and full-report values render plainly.
  expect(full).toHaveTextContent('1,000');
  expect(full).toHaveTextContent('USD 2.00');
  // Reasoning reported 2/4 is genuinely partial; fully-reported subagents with
  // value 0 render as measured zero, not Unknown.
  expect(full).toHaveTextContent('partial');
  expect(full).toHaveTextContent('Observed subagents0');
  const partial = within(section).getByRole('row', { name: /gpt-partial/ });
  // Partial input coverage is flagged; missing USD is unknown, not zero.
  expect(partial).toHaveTextContent('partial');
  expect(partial).toHaveTextContent('Unknown');
  expect(partial).not.toHaveTextContent('unsupported');
  expect(partial).not.toHaveTextContent('not applicable');
  const tiny = within(section).getByRole('row', { name: /tiny/ });
  // A small positive amount never reads as measured zero; exact in tooltip.
  expect(tiny).toHaveTextContent('< USD 0.01');
  expect(tiny.innerHTML).toContain('USD 0.0010');
});

it('shows an empty state when no runs exist in range', async () => {
  localStorage.clear();
  __setMockBackendForTests();
  useAppStore.setState({ workflows: [] });
  render(<UsageView />);
  await waitFor(() =>
    expect(screen.getByText(/No runs in this range/)).toBeInTheDocument(),
  );
});
