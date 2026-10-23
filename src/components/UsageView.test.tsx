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

function plannedDaySummary(): UsageSummary {
  const summary = emptyUsageSummary();
  summary.runsScanned = 1;
  summary.totals.runs = 1;
  summary.totals.agentAttempts = 14;
  summary.totals.reportedUsd = 62.88;
  summary.totals.reportedUsdAttempts = 13;
  summary.totals.unknownUsdAttempts = 1;
  summary.days = [
    {
      day: '2026-10-23',
      runs: 1,
      agentAttempts: 14,
      reportedUsd: 62.88,
      inputTokens: 0,
      outputTokens: 0,
    },
  ];
  summary.providerDays = [
    {
      day: '2026-10-23',
      adapter: 'claude',
      agentAttempts: 13,
      durationMs: 2_000_000,
      reportedUsd: 62.88,
      reportedUsdAttempts: 13,
      allAgentAttempts: 13,
      allDurationMs: 2_000_000,
    },
    {
      day: '2026-10-23',
      adapter: 'codex',
      agentAttempts: 1,
      durationMs: 160_000,
      reportedUsd: 0,
      reportedUsdAttempts: 0,
      allAgentAttempts: 1,
      allDurationMs: 160_000,
    },
  ];
  return summary;
}

it('asks for plans instead of passing API value off as the cost', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(plannedDaySummary());
  useAppStore.setState({ workflows: [] });
  render(<UsageView />);
  const card = (await screen.findByText('Estimated cost')).closest('.usage-card');
  expect(card).toHaveTextContent('Not set');
  expect(card).toHaveTextContent('Enter your plans to see it');
  expect(await screen.findByText(/not your bill/)).toBeInTheDocument();
  const value = screen.getByText('API value', { selector: '.usage-card-label' });
  expect(value.closest('.usage-card')).toHaveTextContent('USD 62.88');
});

it('shows a heavy day at its plan cost, beside the API value it bought', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(plannedDaySummary());
  useAppStore.setState({ workflows: [] });
  render(<UsageView />);
  const user = userEvent.setup();
  await user.selectOptions(await screen.findByLabelText('Claude Code'), 'subscription');
  await user.type(screen.getAllByLabelText('Plan name (optional)')[0]!, 'Max 5×');
  await user.type(screen.getAllByLabelText('You pay per month (USD)')[0]!, '124');
  await user.selectOptions(screen.getByLabelText('Codex'), 'subscription');
  await user.type(screen.getAllByLabelText('You pay per month (USD)')[1]!, '24.8');
  expect(screen.getByText('Unsaved changes.')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save plans' }));
  await waitFor(() => expect(screen.getByText('Plans saved.')).toBeInTheDocument());
  // USD 124/31 days + USD 24.8/31 days for the one day both ran.
  const card = screen.getByText('Estimated cost', { selector: '.usage-card-label' });
  expect(card.closest('.usage-card')).toHaveTextContent('USD 4.80');
  expect(card.closest('.usage-card')).toHaveTextContent('On your plans');
  // Codex reported no dollar figure, so the API value is partial: no "N×".
  expect(
    screen
      .getByText('API value', { selector: '.usage-card-label' })
      .closest('.usage-card'),
  ).not.toHaveTextContent('your estimated cost');
  const providers = screen.getByRole('region', { name: 'Cost by provider' });
  const claude = within(providers).getByRole('row', { name: /Claude Code/ });
  expect(claude).toHaveTextContent('Max 5× · USD 124.00/month');
  expect(claude).toHaveTextContent('USD 4.00');
  expect(claude).toHaveTextContent('USD 62.88');
  expect(within(providers).getByRole('row', { name: /Codex/ })).toHaveTextContent(
    'Not reported',
  );
  expect(await backend.getSetting('usage.plans')).toBe(
    JSON.stringify({
      claude: { billing: 'subscription', monthlyUsd: 124, name: 'Max 5×' },
      codex: { billing: 'subscription', monthlyUsd: 24.8 },
    }),
  );
});

it('compares API value with the cost only when both are complete', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  await backend.setSetting(
    'usage.plans',
    '{"claude":{"billing":"subscription","monthlyUsd":124}}',
  );
  const summary = plannedDaySummary();
  summary.totals.agentAttempts = 13;
  summary.totals.unknownUsdAttempts = 0;
  summary.providerDays = summary.providerDays.filter((day) => day.adapter === 'claude');
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(summary);
  useAppStore.setState({ workflows: [] });
  render(<UsageView />);
  // USD 62.88 of API value on USD 124/31 = USD 4.00 of plan.
  await waitFor(() =>
    expect(
      screen
        .getByText('API value', { selector: '.usage-card-label' })
        .closest('.usage-card'),
    ).toHaveTextContent('16× your estimated cost'),
  );
});

it('waits for Save before naming a missing plan amount', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  useAppStore.setState({ workflows: [] });
  render(<UsageView />);
  const user = userEvent.setup();
  await user.selectOptions(await screen.findByLabelText('Claude Code'), 'subscription');
  expect(screen.queryByRole('alert')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Save plans' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Enter what you pay each month for Claude Code',
  );
  expect(await backend.getSetting('usage.plans')).toBeNull();
});

it('says why an estimate is partial', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  await backend.setSetting(
    'usage.plans',
    '{"claude":{"billing":"subscription","monthlyUsd":124},"codex":{"billing":"api"}}',
  );
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(plannedDaySummary());
  useAppStore.setState({ workflows: [] });
  render(<UsageView />);
  const card = (
    await screen.findByText('Estimated cost', { selector: '.usage-card-label' })
  ).closest('.usage-card');
  await waitFor(() => expect(card).toHaveTextContent('USD 4.00 partial'));
  expect(card).toHaveTextContent('1 pay-per-use attempt reported no dollar figure');
  // No "N× your estimated cost" against a partial estimate.
  expect(
    screen
      .getByText('API value', { selector: '.usage-card-label' })
      .closest('.usage-card'),
  ).not.toHaveTextContent('your estimated cost');
  // The day's own estimate says it is partial too.
  await userEvent.setup().click(screen.getByText(/Daily table/));
  expect(screen.getByRole('row', { name: /2026-10-23/ })).toHaveTextContent(
    'USD 4.00 partial',
  );
});

it("saves only what a provider's billing shows", async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  useAppStore.setState({ workflows: [] });
  render(<UsageView />);
  const user = userEvent.setup();
  const claude = await screen.findByLabelText('Claude Code');
  await user.selectOptions(claude, 'subscription');
  await user.type(screen.getByLabelText('Plan name (optional)'), 'x'.repeat(81));
  // Switching away hides the name; it no longer blocks saving or gets saved.
  await user.selectOptions(claude, 'api');
  await user.click(screen.getByRole('button', { name: 'Save plans' }));
  await waitFor(async () =>
    expect(await backend.getSetting('usage.plans')).toBe('{"claude":{"billing":"api"}}'),
  );
  await user.selectOptions(claude, '');
  await user.click(screen.getByRole('button', { name: 'Save plans' }));
  await waitFor(async () => expect(await backend.getSetting('usage.plans')).toBe('{}'));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('reads saved plans and share back into the form', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  await backend.setSetting('usage.plans', '{"codex":{"billing":"api"}}');
  await backend.setSetting('usage.planShare', '60');
  useAppStore.setState({ workflows: [] });
  render(<UsageView />);
  await waitFor(() => expect(screen.getByLabelText('Codex')).toHaveValue('api'));
  expect(screen.getByLabelText('Claude Code')).toHaveValue('');
  expect(screen.getByLabelText(/Orchevia's share/)).toHaveValue(60);
  expect(screen.getByText(/does not report a dollar figure/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save plans' })).toBeDisabled();
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
  expect(screen.getByText('API value', { selector: '.usage-card-label' })).toBeVisible();
  expect(screen.getByText(/legacy unknown/)).toBeInTheDocument();
  // What you pay and what the CLI reports stay visibly separate.
  expect(screen.getByRole('heading', { name: 'Your plans' })).toBeInTheDocument();
  expect(screen.getByText(/API-equivalent target/)).toBeInTheDocument();
  // Thin history offers no fabricated rates.
  expect(screen.getByText(/Insufficient history/)).toBeInTheDocument();
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
    name: /reported API value per UTC day/i,
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
  // The default range is the last 30 days, shown as the selected preset.
  expect(screen.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await user.click(screen.getByRole('button', { name: 'Last 7 days' }));
  const weekAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  await waitFor(() =>
    expect(screen.getByLabelText('From (inclusive)')).toHaveValue(weekAgo),
  );
  expect(screen.getByRole('button', { name: 'Last 7 days' })).toHaveClass('active-tab');
  expect(screen.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await user.selectOptions(screen.getByLabelText('Provider'), 'codex');
  await user.type(screen.getByLabelText('Model'), 'gpt-x');
  await user.click(screen.getByRole('button', { name: 'Reset filters' }));
  expect(screen.getByLabelText('Provider')).toHaveValue('');
  expect(screen.getByLabelText('Model')).toHaveValue('');
});

it('keeps plan drafts and reports failure without claiming success', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  useAppStore.setState({ workflows: [] });
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(emptyUsageSummary());
  vi.spyOn(backend, 'setSetting').mockRejectedValueOnce(new Error('disk full'));
  render(<UsageView />);
  const user = userEvent.setup();
  await screen.findByText(/No runs in this range/);
  await user.selectOptions(screen.getByLabelText('Claude Code'), 'subscription');
  await user.type(screen.getByLabelText('You pay per month (USD)'), '120');
  await user.type(screen.getByLabelText(/Orchevia's share/), '50');
  await user.click(screen.getByRole('button', { name: 'Save plans' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('disk full');
  expect(screen.queryByText('Plans saved.')).not.toBeInTheDocument();
  // The draft survives the failure and still needs saving.
  expect(screen.getByLabelText('You pay per month (USD)')).toHaveValue(120);
  expect(screen.getByText('Unsaved changes.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save plans' })).toBeEnabled();
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

it('distinguishes unknown overview counters from measured zero and no attempts', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const summary = emptyUsageSummary();
  summary.runsScanned = 1;
  summary.totals.agentAttempts = 2;
  summary.totals.coverage.subagents = 2;
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(summary);
  render(<UsageView />);
  const overview = await screen.findByRole('region', { name: 'Overview' });
  const tools = within(overview).getByText('Observed tool calls').closest('.usage-card');
  const subs = within(overview).getByText('Observed subagents').closest('.usage-card');
  expect(tools?.querySelector('.usage-card-value')).toHaveTextContent('Unknown');
  expect(subs?.querySelector('.usage-card-value')).toHaveTextContent('0');
});

it('keeps a year-long chart coordinate width bounded so its axes remain readable', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(usageSummaryWithDays());
  render(<UsageView />);
  fireEvent.change(screen.getByLabelText('From (inclusive)'), {
    target: { value: '2026-01-01' },
  });
  fireEvent.change(screen.getByLabelText('To (inclusive)'), {
    target: { value: '2026-12-31' },
  });
  const chart = await screen.findByRole('img', { name: /from 2026-01-01 to 2026-12-31/ });
  const width = Number(chart.getAttribute('viewBox')?.split(' ')[2]);
  expect(width).toBeLessThanOrEqual(800);
  expect(within(chart).getByText('0')).toBeInTheDocument();
});

it('retries failed plan loading before allowing edits and saves', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(emptyUsageSummary());
  vi.spyOn(backend, 'getSetting').mockRejectedValueOnce(new Error('read failed'));
  render(<UsageView />);
  expect(await screen.findByRole('alert')).toHaveTextContent('read failed');
  expect(screen.getByLabelText('Claude Code')).toBeDisabled();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Retry loading your plans' }));
  await waitFor(() => expect(screen.getByLabelText(/Orchevia's share/)).toBeEnabled());
  await user.type(screen.getByLabelText(/Orchevia's share/), '50');
  await user.click(screen.getByRole('button', { name: 'Save plans' }));
  expect(await screen.findByText('Plans saved.')).toBeInTheDocument();
});

it('locks plan drafts during loading and saving', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(emptyUsageSummary());
  let finishLoad: (value: string | null) => void = () => {};
  vi.spyOn(backend, 'getSetting').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLoad = resolve;
      }),
  );
  render(<UsageView />);
  expect(screen.getByLabelText('Claude Code')).toBeDisabled();
  await act(async () => {
    finishLoad(null);
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByLabelText('Claude Code')).toBeEnabled());
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/Orchevia's share/), '50');
  let finishSave: () => void = () => {};
  vi.spyOn(backend, 'setSetting').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSave = resolve;
      }),
  );
  await user.click(screen.getByRole('button', { name: 'Save plans' }));
  expect(screen.getByLabelText(/Orchevia's share/)).toBeDisabled();
  expect(screen.getByLabelText('Claude Code')).toBeDisabled();
  await act(async () => {
    finishSave();
    await Promise.resolve();
  });
  expect(await screen.findByText('Plans saved.')).toBeInTheDocument();
});

it('supports keyboard navigation between breakdown tabs', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(modelSummary());
  render(<UsageView />);
  const workflow = await screen.findByRole('tab', { name: 'Workflow' });
  workflow.focus();
  await userEvent.setup().keyboard('{ArrowRight}');
  const profile = screen.getByRole('tab', { name: 'AI profile' });
  expect(profile).toHaveFocus();
  expect(profile).toHaveAttribute('aria-selected', 'true');
  expect(workflow).toHaveAttribute('tabindex', '-1');
  expect(screen.getByRole('tabpanel', { name: 'By AI profile' })).toHaveAttribute(
    'id',
    profile.getAttribute('aria-controls'),
  );
});

it('keeps later active dates available in the daily table when the chart span is capped', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const summary = usageSummaryWithDays();
  summary.days.push({
    day: '2027-10-02',
    runs: 1,
    agentAttempts: 2,
    reportedUsd: 0.000001,
    inputTokens: 0,
    outputTokens: 0,
  });
  vi.spyOn(backend, 'usageSummary').mockResolvedValue(summary);
  render(<UsageView />);
  fireEvent.change(screen.getByLabelText('From (inclusive)'), {
    target: { value: '2026-10-01' },
  });
  fireEvent.change(screen.getByLabelText('To (inclusive)'), {
    target: { value: '2027-10-02' },
  });
  await screen.findByRole('img');
  await userEvent.setup().click(screen.getByText(/Daily table \(/));
  const row = screen.getByRole('row', { name: /2027-10-02/ });
  expect(row).toHaveTextContent('2');
  expect(within(row).getByTitle('USD 0.000001')).toBeInTheDocument();
});
