import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { UsageView } from './UsageView';
import { __setMockBackendForTests } from '../lib/backend';
import { createDefaultProfile } from '../lib/agents';
import { createEmptyWorkflow } from '../lib/workflow';
import { useAppStore } from '../store';

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
