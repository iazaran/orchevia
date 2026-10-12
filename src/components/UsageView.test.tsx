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
  const section = await screen.findByRole('region', { name: 'By AI profile' });
  const current = within(section).getByRole('row', { name: /Renamed profile/ });
  expect(current).toHaveTextContent('current name');
  expect(current).toHaveTextContent('1.2500');
  expect(current).toHaveTextContent('2/3 reports');
  expect(current).toHaveTextContent('1 unknown');
  expect(current).toHaveTextContent('2s');
  expect(within(current).getByTitle('2026-10-01T00:00:00.000Z')).toBeInTheDocument();
  const deleted = within(section).getByRole('row', { name: /deleted-profile/ });
  expect(deleted).toHaveTextContent('0.0000');
  expect(deleted).toHaveTextContent('1/1 reports');
  expect(deleted).toHaveTextContent('2m');
  const unknown = within(section).getByRole('row', { name: /^Unknown/ });
  expect(unknown).toHaveTextContent('0/1 reports');
  expect(unknown).toHaveTextContent('1 unknown');
  expect(unknown).not.toHaveTextContent('0.0000');
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
  expect(screen.getByText(/Past · USD 120.00/)).toHaveTextContent('outside allocation');
  expect(screen.getByText(/Legacy · USD 50.00/)).toHaveTextContent('outside allocation');
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
  expect(screen.getByText(/Agent attempts/)).toBeInTheDocument();
  expect(screen.getByText(/Estimated API value/)).toBeInTheDocument();
  expect(screen.getByText(/legacy unknown/)).toBeInTheDocument();
  // Money lanes stay visibly separate.
  expect(screen.getByText(/Subscription fees \(you enter these\)/)).toBeInTheDocument();
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
  await user.type(screen.getByLabelText('Fee amount USD'), '120');
  await user.type(screen.getByLabelText('Billing period'), '2026-10-01/2026-11-01');
  await user.click(screen.getByRole('button', { name: 'Add fee' }));
  await user.type(screen.getByLabelText('Orchevia share %'), '50');
  await user.click(screen.getByRole('button', { name: 'Save subscription settings' }));
  await waitFor(() =>
    expect(screen.getByText(/Allocated to Orchevia-tracked work/)).toBeInTheDocument(),
  );
  expect(screen.getByText(/Outside or untracked usage is excluded/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Save subscription settings' }));
  const backend = __setMockBackendForTests();
  // Settings persist through the backend contract (mock twin included).
  await waitFor(async () =>
    expect(await backend.getSetting('usage.subscriptionFees')).toContain('Claude'),
  );
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
