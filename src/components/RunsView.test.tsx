import { afterEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __setMockBackendForTests, type Backend } from '../lib/backend';
import { createDefaultProfile } from '../lib/agents';
import { useAppStore } from '../store';
import type { GroupedFinding } from '../lib/scheduler';
import type { RunStatus, StoredNodeResult, StoredRun } from '../lib/workflow';
import { RunsView } from './RunsView';

const originalShowRunOverlay = useAppStore.getState().showRunOverlay;

afterEach(() => {
  useAppStore.setState({ showRunOverlay: originalShowRunOverlay });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('opens finished runs on the canvas through exact snapshot navigation', async () => {
  const backend = __setMockBackendForTests();
  vi.spyOn(backend, 'listRuns').mockImplementation(() =>
    Promise.resolve(useAppStore.getState().runs),
  );
  const showRunOverlay = vi.fn().mockResolvedValue(undefined);
  useAppStore.setState({
    runs: [
      {
        id: 'finished-run',
        workflowId: 'wf',
        status: 'succeeded',
        startedAt: new Date().toISOString(),
      },
    ],
    activeRunId: 'finished-run',
    runResults: { 'finished-run': [] },
    workflows: [],
    profiles: [],
    showRunOverlay,
  });
  render(<RunsView />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Show on canvas' }));
  expect(showRunOverlay).toHaveBeenCalledWith('finished-run');
  expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull();
});

it('disables duplicate decisions and displays approval failures', async () => {
  const backend = __setMockBackendForTests();
  vi.spyOn(backend, 'listRuns').mockImplementation(() =>
    Promise.resolve(useAppStore.getState().runs),
  );
  vi.spyOn(backend, 'getRunResults').mockImplementation((id) =>
    Promise.resolve(useAppStore.getState().runResults[id] ?? []),
  );
  let rejectRequest: (reason: Error) => void = () => {};
  const approve = vi.spyOn(backend, 'approveRun').mockImplementation(
    () =>
      new Promise<void>((_, reject) => {
        rejectRequest = reject;
      }),
  );
  useAppStore.setState({
    runs: [
      {
        id: 'paused-run',
        workflowId: 'wf',
        status: 'paused',
        startedAt: new Date().toISOString(),
      },
    ],
    activeRunId: 'paused-run',
    runResults: {
      'paused-run': [
        {
          id: 7,
          runId: 'paused-run',
          nodeId: 'gate',
          status: 'paused',
          stdout: '',
          stderr: '',
          startedAt: new Date().toISOString(),
        },
      ],
    },
    workflows: [],
    profiles: [],
  });
  render(<RunsView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Approve & continue' }));
  expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel run' })).toBeDisabled();
  expect(approve).toHaveBeenCalledTimes(1);
  expect(approve).toHaveBeenCalledWith('paused-run', true, undefined, 7);
  const cancel = vi.spyOn(backend, 'cancelRun').mockResolvedValue(true);
  act(() => {
    useAppStore.setState({
      runs: useAppStore.getState().runs.map((run) => ({ ...run, status: 'running' })),
    });
  });
  expect(screen.getByRole('button', { name: 'Cancel run' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Cancel run' }));
  expect(cancel).toHaveBeenCalledTimes(1);
  rejectRequest(new Error('Run is no longer paused.'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Run is no longer paused.');
});

it('promotes the successful snapshot command with run evidence only', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const workflow = (await backend.listWorkflows())[0]?.definition;
  if (!workflow) throw new Error('fixture');
  workflow.defaults = { repoDir: '/project' };
  workflow.nodes.push({
    id: 'verified-command',
    type: 'command',
    label: 'Tests',
    position: { x: 0, y: 0 },
    config: { executable: 'sh', args: ['-c', 'make test'] },
  });
  const run = {
    id: 'verified-run',
    workflowId: workflow.id,
    status: 'succeeded' as const,
    startedAt: new Date().toISOString(),
    inputs: {},
  };
  const result = {
    id: 1,
    runId: run.id,
    nodeId: 'verified-command',
    status: 'succeeded',
    stdout: 'private log',
    stderr: '',
    startedAt: run.startedAt,
  };
  vi.spyOn(backend, 'listRuns').mockResolvedValue([run]);
  vi.spyOn(backend, 'getRun').mockResolvedValue(run);
  vi.spyOn(backend, 'getRunWorkflow').mockResolvedValue(workflow);
  vi.spyOn(backend, 'getRunResults').mockResolvedValue([result]);
  useAppStore.setState({
    runs: [run],
    activeRunId: run.id,
    runResults: { [run.id]: [result] },
    workflows: [],
    profiles: [],
  });
  render(<RunsView />);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', { name: 'Save command to playbook' }),
  );
  expect(await screen.findByText(/Saved verified command/)).toBeInTheDocument();
  const context = await backend.getProjectMemoryContext('/project');
  expect(context.text).toContain('make test');
  expect(context.text).toContain('verified-run');
  expect(context.text).not.toContain('private log');
  act(() => useAppStore.setState({ runs: [{ ...run, status: 'failed' }] }));
  expect(screen.queryByRole('button', { name: 'Save command to playbook' })).toBeNull();
});

it('refreshes on every Runs entry and preserves the selected run with current results', async () => {
  const backend = __setMockBackendForTests();
  const oldRun = {
    id: 'selected',
    workflowId: 'wf',
    status: 'succeeded' as const,
    startedAt: '2026-10-05T13:00:00Z',
  };
  const nextRun = { ...oldRun, id: 'new-run' };
  const list = vi.spyOn(backend, 'listRuns').mockResolvedValue([oldRun]);
  const recorded = vi.spyOn(backend, 'getRunResults').mockResolvedValue([]);
  useAppStore.setState({
    runs: [],
    activeRunId: oldRun.id,
    runResults: {},
    workflows: [],
    profiles: [],
  });
  const first = render(<RunsView />);
  await waitFor(() => expect(useAppStore.getState().runs).toEqual([oldRun]));
  await waitFor(() => expect(recorded).toHaveBeenCalledWith(oldRun.id));
  first.unmount();
  list.mockResolvedValue([nextRun, oldRun]);
  render(<RunsView />);
  await waitFor(() => expect(useAppStore.getState().runs).toEqual([nextRun, oldRun]));
  expect(list).toHaveBeenCalledTimes(2);
  expect(useAppStore.getState().activeRunId).toBe(oldRun.id);
});

it('reports a failed entry refresh without discarding cached runs', async () => {
  const backend = __setMockBackendForTests();
  vi.spyOn(backend, 'listRuns').mockRejectedValue(new Error('Cannot load current runs'));
  const cached = {
    id: 'cached',
    workflowId: 'wf',
    status: 'succeeded' as const,
    startedAt: '2026-10-05T13:00:00Z',
  };
  useAppStore.setState({
    runs: [cached],
    activeRunId: null,
    runResults: {},
    workflows: [],
    profiles: [],
  });
  render(<RunsView />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Cannot load current runs');
  expect(useAppStore.getState().runs).toEqual([cached]);
});

it('keeps one polling request in flight while an entry refresh is pending', async () => {
  vi.useFakeTimers();
  const backend = __setMockBackendForTests();
  const running = {
    id: 'live',
    workflowId: 'wf',
    status: 'running' as const,
    startedAt: '2026-10-05T13:00:00Z',
  };
  let finish: (runs: (typeof running)[]) => void = () => {};
  const list = vi.spyOn(backend, 'listRuns').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  useAppStore.setState({
    runs: [running],
    activeRunId: null,
    runResults: {},
    workflows: [],
    profiles: [],
  });
  const view = render(<RunsView />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4500);
  });
  expect(list).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish([running]);
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(list).toHaveBeenCalledTimes(2);
  view.unmount();
  await act(async () => {
    finish([running]);
    await Promise.resolve();
  });
});

function liveRun(id: string, status: RunStatus): StoredRun {
  return { id, workflowId: 'wf', status, startedAt: '2026-10-08T10:00:00Z' };
}

function resultRow(runId: string, id: number, status = 'succeeded'): StoredNodeResult {
  return {
    id,
    runId,
    nodeId: `step-${String(id)}`,
    status,
    stdout: `output ${String(id)}`,
    stderr: '',
    startedAt: '2026-10-08T10:00:00Z',
    attempt: 1,
  };
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

it('does not reload a finished selected run while another run stays active', async () => {
  vi.useFakeTimers();
  const backend = __setMockBackendForTests();
  const runs = [liveRun('finished', 'succeeded'), liveRun('other', 'running')];
  const list = vi
    .spyOn(backend, 'listRuns')
    .mockImplementation(() => Promise.resolve(runs));
  const results = vi
    .spyOn(backend, 'getRunResults')
    .mockImplementation((id) => Promise.resolve([resultRow(id, 1)]));
  const findings = vi.spyOn(backend, 'getRunFindings').mockResolvedValue([]);
  vi.spyOn(backend, 'getRunWorkflow').mockResolvedValue(null);
  useAppStore.setState({
    runs,
    activeRunId: 'finished',
    runResults: {},
    runResultStatus: {},
    workflows: [],
    profiles: [],
  });
  const view = render(<RunsView />);
  await advance(6000);
  // Entry refresh plus four polls of the run list; the finished run loads once.
  expect(list).toHaveBeenCalledTimes(5);
  expect(results).toHaveBeenCalledTimes(1);
  expect(findings).toHaveBeenCalledTimes(1);
  // Other runs' cache updates do not refetch the selected run's findings.
  for (let i = 2; i < 7; i++) {
    act(() => {
      useAppStore.setState({
        runResults: {
          ...useAppStore.getState().runResults,
          other: [resultRow('other', i)],
        },
      });
    });
  }
  await advance(0);
  expect(findings).toHaveBeenCalledTimes(1);
  // An explicit refresh still reloads the selected run.
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await advance(0);
  expect(results).toHaveBeenCalledTimes(2);
  view.unmount();
  await advance(6000);
  expect(list).toHaveBeenCalledTimes(6);
});

it('fetches final results and findings on a terminal transition, then stops polling', async () => {
  vi.useFakeTimers();
  const backend = __setMockBackendForTests();
  let runs = [liveRun('live', 'running')];
  let rows = [resultRow('live', 1, 'running')];
  const list = vi
    .spyOn(backend, 'listRuns')
    .mockImplementation(() => Promise.resolve(runs));
  const results = vi
    .spyOn(backend, 'getRunResults')
    .mockImplementation(() => Promise.resolve(rows));
  const findings = vi.spyOn(backend, 'getRunFindings').mockResolvedValue([]);
  vi.spyOn(backend, 'getRunWorkflow').mockResolvedValue(null);
  useAppStore.setState({
    runs,
    activeRunId: 'live',
    runResults: {},
    runResultStatus: {},
    workflows: [],
    profiles: [],
  });
  render(<RunsView />);
  await advance(1500);
  expect(results).toHaveBeenCalledTimes(2);
  // Unchanged live results keep their identity: no findings refetch per tick.
  expect(findings).toHaveBeenCalledTimes(1);
  runs = [liveRun('live', 'succeeded')];
  rows = [{ ...resultRow('live', 1), stdout: 'final report' }];
  await advance(1500);
  expect(results).toHaveBeenCalledTimes(3);
  expect(findings).toHaveBeenCalledTimes(2);
  expect(useAppStore.getState().runResults.live?.[0]?.stdout).toBe('final report');
  expect(screen.getAllByText('final report').length).toBeGreaterThan(0);
  const calls = list.mock.calls.length;
  await advance(6000);
  expect(list).toHaveBeenCalledTimes(calls);
  expect(results).toHaveBeenCalledTimes(3);
});

it('keeps paused runs and spend pauses current without refetching unchanged findings', async () => {
  vi.useFakeTimers();
  const backend = __setMockBackendForTests();
  const paused = {
    ...liveRun('paused', 'paused'),
    execution: { options: {}, spendPause: { id: 3, reportedUsd: 2 } },
  };
  let rows = [resultRow('paused', 1)];
  vi.spyOn(backend, 'listRuns').mockImplementation(() => Promise.resolve([paused]));
  const results = vi
    .spyOn(backend, 'getRunResults')
    .mockImplementation(() => Promise.resolve(rows));
  const findings = vi.spyOn(backend, 'getRunFindings').mockResolvedValue([]);
  vi.spyOn(backend, 'getRunWorkflow').mockResolvedValue(null);
  useAppStore.setState({
    runs: [paused],
    activeRunId: 'paused',
    runResults: {},
    runResultStatus: {},
    workflows: [],
    profiles: [],
  });
  render(<RunsView />);
  await advance(4500);
  expect(results).toHaveBeenCalledTimes(4);
  expect(findings).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Review spend pause' })).toBeInTheDocument();
  rows = [...rows, resultRow('paused', 2)];
  await advance(1500);
  expect(findings).toHaveBeenCalledTimes(2);
  expect(screen.getAllByText('output 2').length).toBeGreaterThan(0);
});

it('keeps cached results and reports a failed poll', async () => {
  vi.useFakeTimers();
  const backend = __setMockBackendForTests();
  const runs = [liveRun('live', 'running')];
  vi.spyOn(backend, 'listRuns').mockImplementation(() => Promise.resolve(runs));
  const results = vi
    .spyOn(backend, 'getRunResults')
    .mockResolvedValueOnce([resultRow('live', 1, 'running')])
    .mockRejectedValue(new Error('Results unavailable'));
  vi.spyOn(backend, 'getRunFindings').mockResolvedValue([]);
  vi.spyOn(backend, 'getRunWorkflow').mockResolvedValue(null);
  useAppStore.setState({
    runs,
    activeRunId: 'live',
    runResults: {},
    runResultStatus: {},
    workflows: [],
    profiles: [],
  });
  render(<RunsView />);
  await advance(1500);
  expect(results).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('alert')).toHaveTextContent('Results unavailable');
  expect(useAppStore.getState().runResults.live?.[0]?.stdout).toBe('output 1');
});

it("never shows a previous run's late findings after switching runs", async () => {
  const backend = __setMockBackendForTests();
  const runs = [liveRun('first', 'succeeded'), liveRun('second', 'succeeded')];
  vi.spyOn(backend, 'listRuns').mockResolvedValue(runs);
  vi.spyOn(backend, 'getRunResults').mockImplementation((id) =>
    Promise.resolve([resultRow(id, id === 'first' ? 1 : 2)]),
  );
  vi.spyOn(backend, 'getRunWorkflow').mockResolvedValue(null);
  const pending = new Map<string, (value: GroupedFinding[]) => void>();
  vi.spyOn(backend as Backend, 'getRunFindings').mockImplementation(
    (id: string) =>
      new Promise<GroupedFinding[]>((resolve) => {
        pending.set(id, resolve);
      }),
  );
  useAppStore.setState({
    runs,
    activeRunId: 'first',
    runResults: {},
    runResultStatus: {},
    workflows: [],
    profiles: [],
  });
  render(<RunsView />);
  await waitFor(() => expect(pending.has('first')).toBe(true));
  await act(async () => {
    await useAppStore.getState().selectRun('second');
  });
  await waitFor(() => expect(pending.has('second')).toBe(true));
  const finding = (title: string): GroupedFinding => ({
    finding: {
      fingerprint: title,
      severity: 'P1',
      category: 'bug',
      title,
      explanation: 'details',
      source: 'review',
    },
    sources: ['review'],
  });
  await act(async () => {
    pending.get('second')?.([finding('Second finding')]);
    pending.get('first')?.([finding('First finding')]);
    await Promise.resolve();
  });
  expect(await screen.findByText(/Second finding/)).toBeInTheDocument();
  expect(screen.queryByText(/First finding/)).toBeNull();
});

async function renderLiveOutput(
  text: string,
  structuredJson?: string,
): Promise<StoredNodeResult> {
  const backend = __setMockBackendForTests();
  const run: StoredRun = {
    id: 'live-output',
    workflowId: 'output-wf',
    status: 'running',
    startedAt: new Date().toISOString(),
  };
  const result: StoredNodeResult = {
    id: 501,
    runId: run.id,
    nodeId: 'writer',
    status: 'running',
    stdout: text,
    stderr: '',
    startedAt: run.startedAt,
    ...(structuredJson ? { structuredJson } : {}),
  };
  vi.spyOn(backend, 'listRuns').mockImplementation(() =>
    Promise.resolve(useAppStore.getState().runs),
  );
  vi.spyOn(backend, 'getRunResults').mockImplementation((id) =>
    Promise.resolve(useAppStore.getState().runResults[id] ?? []),
  );
  vi.spyOn(backend, 'getRunWorkflow').mockResolvedValue({
    schemaVersion: 6,
    id: 'output-wf',
    name: 'Output',
    edges: [],
    nodes: [
      {
        id: 'writer',
        type: 'agent',
        label: 'Writer',
        position: { x: 0, y: 0 },
        config: {},
      },
    ],
  });
  vi.spyOn(backend, 'getRunFindings').mockResolvedValue([]);
  useAppStore.setState({
    runs: [run],
    activeRunId: run.id,
    runResults: { [run.id]: [result] },
    workflows: [],
    profiles: [],
  });
  render(<RunsView />);
  await screen.findByText('Writer');
  return result;
}

it('expands full live output without claiming a count of visual lines', async () => {
  const text = Array.from(
    { length: 30 },
    (_, i) => `Line ${String(i)} ${'long wrapped text '.repeat(30)}`,
  ).join('\n');
  await renderLiveOutput(text);
  fireEvent.click(screen.getByRole('button', { name: 'Collapse stdout' }));
  const expand = screen.getByRole('button', { name: 'Expand stdout' });
  expect(expand).toHaveTextContent('Show full output');
  expect(expand).not.toHaveTextContent('lines');
  fireEvent.click(expand);
  expect(screen.getByRole('region', { name: 'stdout output' })).toHaveTextContent(
    'Line 29',
  );
});

it('follows new live output, pauses on scroll-up and resumes explicitly', async () => {
  const result = await renderLiveOutput(
    Array.from({ length: 20 }, (_, i) => `line ${String(i)}`).join('\n'),
  );
  const output = screen.getByRole('region', { name: 'stdout output' });
  Object.defineProperties(output, {
    scrollHeight: { value: 1000, configurable: true },
    clientHeight: { value: 200, configurable: true },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Collapse stdout' }));
  fireEvent.click(screen.getByRole('button', { name: 'Expand stdout' }));
  expect(output.scrollTop).toBe(1000);
  output.scrollTop = 100;
  fireEvent.scroll(output);
  act(() =>
    useAppStore.setState({
      runResults: {
        [result.runId]: [{ ...result, stdout: result.stdout + '\nnewest line' }],
      },
    }),
  );
  expect(output.scrollTop).toBe(100);
  fireEvent.click(screen.getByRole('button', { name: 'Follow latest stdout' }));
  expect(output.scrollTop).toBe(1000);
  Object.defineProperty(output, 'scrollHeight', { value: 1400 });
  act(() =>
    useAppStore.setState({
      runResults: {
        [result.runId]: [
          { ...result, stdout: result.stdout + '\nnewest line\nlast line' },
        ],
      },
    }),
  );
  expect(output.scrollTop).toBe(1400);
});

it('follows expanded agent activity as it streams', async () => {
  const activity = 'tool update\n'.repeat(30);
  const result = await renderLiveOutput('', JSON.stringify({ agentActivity: activity }));
  const output = screen.getByRole('region', { name: 'Agent activity output' });
  Object.defineProperty(output, 'scrollHeight', { value: 900, configurable: true });
  fireEvent.click(screen.getByRole('button', { name: 'Expand Agent activity' }));
  expect(output.scrollTop).toBe(900);
  Object.defineProperty(output, 'scrollHeight', { value: 1200 });
  act(() =>
    useAppStore.setState({
      runResults: {
        [result.runId]: [
          {
            ...result,
            structuredJson: JSON.stringify({
              agentActivity: activity + 'last tool result',
            }),
          },
        ],
      },
    }),
  );
  expect(output.scrollTop).toBe(1200);
});

it('places deduplicated findings at their source steps and keeps unknown sources visible', async () => {
  const backend = __setMockBackendForTests();
  const run: StoredRun = {
    id: 'findings-run',
    workflowId: 'wf',
    status: 'running',
    startedAt: new Date().toISOString(),
  };
  const results: StoredNodeResult[] = ['review', 'review', 'review-2'].map(
    (nodeId, i) => ({
      id: 610 + i,
      runId: run.id,
      nodeId,
      status: 'succeeded',
      stdout: '',
      stderr: '',
      startedAt: run.startedAt,
    }),
  );
  const finding = (title: string, sources: string[]): GroupedFinding => ({
    finding: {
      fingerprint: title,
      severity: 'P1',
      category: 'bug',
      title,
      explanation: 'details',
      source: sources[0] ?? '',
      suggestedFix: 'x'.repeat(500),
    },
    sources,
  });
  vi.spyOn(backend, 'listRuns').mockResolvedValue([run]);
  vi.spyOn(backend, 'getRunResults').mockResolvedValue(results);
  vi.spyOn(backend, 'getRunWorkflow').mockResolvedValue({
    schemaVersion: 6,
    id: 'wf',
    name: 'W',
    edges: [],
    nodes: ['review', 'review-2'].map((id) => ({
      id,
      type: 'agent',
      label: id,
      position: { x: 0, y: 0 },
      config: {},
    })),
  });
  vi.spyOn(backend, 'getRunFindings').mockResolvedValue([
    finding('Shared finding', ['review (Claude)', 'review-2 (Codex)']),
    finding('Unknown origin', ['deleted-node']),
  ]);
  useAppStore.setState({
    runs: [run],
    activeRunId: run.id,
    runResults: { [run.id]: results },
    workflows: [],
    profiles: [],
  });
  render(<RunsView />);
  await screen.findByText('Unknown origin');
  const first = document.getElementById('run-result-610') as HTMLElement;
  const latest = document.getElementById('run-result-611') as HTMLElement;
  const other = document.getElementById('run-result-612') as HTMLElement;
  expect(within(first).queryByText('Shared finding')).toBeNull();
  expect(within(latest).getByText('Shared finding')).toBeInTheDocument();
  expect(within(other).getByText('Shared finding')).toBeInTheDocument();
  expect(screen.getByText('Unknown origin').closest('.run-step')).toBeNull();
});

it('follows the final output update when a running step finishes', async () => {
  const result = await renderLiveOutput('running output\n'.repeat(20));
  const output = screen.getByRole('region', { name: 'stdout output' });
  Object.defineProperty(output, 'scrollHeight', { value: 1800 });
  act(() =>
    useAppStore.setState({
      runResults: {
        [result.runId]: [
          { ...result, status: 'succeeded', stdout: 'final response\n'.repeat(100) },
        ],
      },
    }),
  );
  expect(output.scrollTop).toBe(1800);
});

it('keeps a paused reader in place when the final output arrives', async () => {
  const result = await renderLiveOutput('running output\n'.repeat(20));
  const output = screen.getByRole('region', { name: 'stdout output' });
  Object.defineProperties(output, {
    scrollHeight: { value: 1800 },
    clientHeight: { value: 200 },
  });
  output.scrollTop = 100;
  fireEvent.scroll(output);
  act(() =>
    useAppStore.setState({
      runResults: {
        [result.runId]: [
          { ...result, status: 'failed', stdout: 'partial final response\n'.repeat(100) },
        ],
      },
    }),
  );
  expect(output.scrollTop).toBe(100);
});

it('keeps unverified plain-text dollar hints inside collapsed usage details', async () => {
  await renderLiveOutput('cost: $36.7953');
  const hint = screen.getByText(/cost: \$36\.7953/, { selector: '.field-hint' });
  const details = hint.closest('details');
  expect(details).not.toBeNull();
  expect(details).not.toHaveAttribute('open');
  expect(details).toHaveTextContent('Unverified text hints');
  expect(details).toHaveTextContent('On a monthly plan you pay the plan fee instead');
});

it('shows refused tool calls and adds the suggested rules to the profile', async () => {
  const backend = __setMockBackendForTests();
  const profile = {
    ...createDefaultProfile('claude'),
    id: 'prof-jira',
    name: 'Ticket reader',
  };
  await backend.saveAgentProfile(profile);
  const run: StoredRun = {
    id: 'refused-run',
    workflowId: 'refused-wf',
    status: 'failed',
    startedAt: new Date().toISOString(),
  };
  const result: StoredNodeResult = {
    id: 801,
    runId: run.id,
    nodeId: 'fetch',
    status: 'failed',
    stdout: 'TICKET_STATUS=none',
    stderr: '',
    error: 'Claude refused 2 tool calls under this profile’s permissions.',
    startedAt: run.startedAt,
    structuredJson: JSON.stringify({
      failureKind: 'permissionDenied',
      permissionDenied: {
        profileId: 'prof-jira',
        denials: [
          {
            toolName: 'mcp__claude_ai_Atlassian_Rovo_2__getJiraIssue',
            toolUseId: 'toolu_1',
            rules: ['mcp__claude_ai_Atlassian_Rovo_2'],
          },
          {
            toolName: 'Bash',
            toolUseId: 'toolu_2',
            detail: 'git status',
            rules: ['Bash(git status *)'],
          },
        ],
        rules: ['mcp__claude_ai_Atlassian_Rovo_2', 'Bash(git status *)'],
      },
    }),
  };
  vi.spyOn(backend, 'listRuns').mockImplementation(() =>
    Promise.resolve(useAppStore.getState().runs),
  );
  vi.spyOn(backend, 'getRunResults').mockImplementation((id) =>
    Promise.resolve(useAppStore.getState().runResults[id] ?? []),
  );
  vi.spyOn(backend, 'getRunWorkflow').mockResolvedValue({
    schemaVersion: 6,
    id: 'refused-wf',
    name: 'Jira ticket to reviewed PR',
    edges: [],
    nodes: [
      {
        id: 'fetch',
        type: 'agent',
        label: 'Fetch ticket',
        position: { x: 0, y: 0 },
        config: { agentProfileId: 'prof-jira' },
      },
    ],
  });
  vi.spyOn(backend, 'getRunFindings').mockResolvedValue([]);
  useAppStore.setState({
    runs: [run],
    activeRunId: run.id,
    runResults: { [run.id]: [result] },
    workflows: [],
    profiles: [profile],
  });
  const { ConfirmHost } = await import('./ConfirmDialog');
  render(
    <>
      <RunsView />
      <ConfirmHost />
    </>,
  );
  const panel = await screen.findByRole('region', { name: 'Refused tool calls' });
  expect(panel).toHaveTextContent('mcp__claude_ai_Atlassian_Rovo_2__getJiraIssue');
  expect(panel).toHaveTextContent('git status');
  expect(screen.getByText('tools refused')).toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(
    within(panel).getByRole('button', { name: 'Add 2 rules to Ticket reader' }),
  );
  await user.click(await screen.findByRole('button', { name: 'Add to allowed tools' }));
  await waitFor(async () => {
    const saved = (await backend.listAgentProfiles()).find((p) => p.id === 'prof-jira');
    expect(saved?.permissionLevel).toBe('allowedTools');
    expect(saved?.allowedTools).toEqual([
      'mcp__claude_ai_Atlassian_Rovo_2',
      'Bash(git status *)',
    ]);
  });
  expect(
    await within(panel).findByText(/Ticket reader now allows these tools/),
  ).toBeInTheDocument();
});
