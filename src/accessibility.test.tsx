import { useState } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { AgentsView } from './components/AgentsView';
import { AutomationsView } from './components/AutomationsView';
import { ConfirmHost, confirmDialog } from './components/ConfirmDialog';
import { EnvironmentView } from './components/EnvironmentView';
import { InboxView } from './components/InboxView';
import { MemoryView } from './components/MemoryView';
import { Modal } from './components/Modal';
import { NoticeHost } from './components/Notice';
import { RunsView } from './components/RunsView';
import { TemplatesView } from './components/TemplatesView';
import { UsageView } from './components/UsageView';
import { WorkflowsView } from './components/WorkflowsView';
import { createDefaultProfile } from './lib/agents';
import { __setMockBackendForTests } from './lib/backend';
import type { Notification } from './lib/scheduler';
import { emptyUsageCoverage, emptyUsageSummary, type UsageSummary } from './lib/usage';
import { createEmptyWorkflow, type RunStatus, type Workflow } from './lib/workflow';
import { useAppStore } from './store';
import { expectNoAxeViolations } from './test/axe';

type MockBackend = ReturnType<typeof __setMockBackendForTests>;
type User = ReturnType<typeof userEvent.setup>;

const pristine = useAppStore.getState();

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState(pristine, true);
  // React Flow measures the canvas, and jsdom has no ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Lets mount effects and mock backend promises settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** Renders a view the way App does: inside <main>, beside the message and confirmation hosts. */
async function renderView(view: React.JSX.Element): Promise<User> {
  const user = userEvent.setup();
  render(
    <main>
      {view}
      <NoticeHost />
      <ConfirmHost />
    </main>,
  );
  await settle();
  return user;
}

/** A fresh backend holding none of the user's own data. */
async function emptyBackend(): Promise<MockBackend> {
  const backend = __setMockBackendForTests();
  for (const workflow of await backend.listWorkflows()) {
    await backend.deleteWorkflow(workflow.id);
  }
  await useAppStore.getState().refreshAll();
  return backend;
}

async function waitForRun(
  backend: MockBackend,
  runId: string,
  status: RunStatus,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await backend.getRun(runId))?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Run ${runId} never reached ${status}.`);
}

function approvalWorkflow(): Workflow {
  const workflow = createEmptyWorkflow('Needs a human');
  const [start, end] = workflow.nodes;
  if (start === undefined || end === undefined) throw new Error('fixture');
  return {
    ...workflow,
    nodes: [
      start,
      {
        id: 'gate',
        type: 'approval',
        label: 'Check the plan',
        position: { x: 80, y: 200 },
        config: { message: 'Check the plan before tests run.' },
      },
      end,
    ],
    edges: [
      { id: 'to-gate', source: start.id, target: 'gate' },
      { id: 'to-end', source: 'gate', target: end.id },
    ],
  };
}

interface Populated {
  backend: MockBackend;
  workflowId: string;
}

/** A backend holding a bit of everything: profiles, automations, memory, templates. */
async function populatedBackend(): Promise<Populated> {
  const backend = __setMockBackendForTests();
  await backend.saveAgentProfile({
    ...createDefaultProfile('claude'),
    id: 'reviewer',
    name: 'Reviewer',
  });
  await backend.saveAgentProfile({
    ...createDefaultProfile('codex'),
    id: 'builder',
    name: 'Builder',
    role: 'implementation',
  });
  const sample = (await backend.listWorkflows())[0];
  if (sample === undefined) throw new Error('fixture');
  await backend.saveSchedule({
    id: 'nightly',
    name: 'Nightly check',
    workflowId: sample.id,
    kind: { kind: 'daily', hour: 2, minute: 0 },
    timezone: 'local',
    enabled: false,
    trusted: false,
    missedPolicy: 'skip',
  });
  await backend.saveWatcher({
    id: 'reviews',
    name: 'Review requests',
    workflowId: sample.id,
    kind: 'reviewRequested',
    repoDir: '/repo',
    enabled: false,
    checkIntervalSecs: 900,
  });
  await backend.savePreference({
    key: 'custom.*.test',
    scope: '*',
    value: 'make test',
    source: 'suggested',
    enabled: true,
    note: 'Three saved edits',
  });
  await backend.savePreference({
    key: 'custom.*.lint',
    scope: '*',
    value: 'make lint',
    source: 'manual',
    enabled: true,
    note: '',
  });
  await backend.saveMcpServer({
    id: 'files',
    name: 'Files',
    command: 'npx',
    args: ['files-server'],
    enabled: true,
  });
  const builtin = (await backend.listTemplates()).builtin[0];
  if (builtin === undefined) throw new Error('fixture');
  await backend.saveUserTemplate({ ...builtin, id: 'mine', name: 'My review' });
  await useAppStore.getState().refreshAll();
  act(() => {
    useAppStore.getState().selectWorkflow(sample.id);
  });
  return { backend, workflowId: sample.id };
}

/**
 * Runs the sample to the end and a second workflow up to its approval. The
 * mock backend plays runs out in real time, so only the Runs tests pay for it.
 */
async function seedRuns(
  backend: MockBackend,
  workflowId: string,
): Promise<{ finishedRunId: string; pausedRunId: string }> {
  const finished = await backend.runWorkflow(workflowId);
  await waitForRun(backend, finished.runId, 'succeeded');
  const gated = await backend.saveWorkflow(approvalWorkflow());
  const paused = await backend.runWorkflow(gated.id);
  await waitForRun(backend, paused.runId, 'paused');
  await act(async () => {
    await useAppStore.getState().refreshAll();
  });
  return { finishedRunId: finished.runId, pausedRunId: paused.runId };
}

/** For tests that make many axe passes or wait for mock runs to play out. */
const SLOW = 30_000;

function inside(container: HTMLElement): boolean {
  const active = document.activeElement;
  return (
    active instanceof HTMLElement &&
    (container.contains(active) || active.closest('.notice-stack') !== null)
  );
}

/**
 * Opens a dialog from its button, checks it, then checks that Tab and
 * Shift+Tab stay inside it and that Escape hands focus back to the button
 * that opened it.
 */
async function checkDialog(
  user: User,
  opener: HTMLElement,
  name: string | RegExp,
): Promise<HTMLElement> {
  await user.click(opener);
  const dialog = await screen.findByRole('dialog', { name });
  await settle();
  await expectNoAxeViolations();
  expect(inside(dialog)).toBe(true);
  const stops = dialog.querySelectorAll(
    'button, input, select, textarea, a[href]',
  ).length;
  for (let i = 0; i <= stops; i++) {
    await user.tab();
    expect(inside(dialog)).toBe(true);
  }
  await user.tab({ shift: true });
  expect(inside(dialog)).toBe(true);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
  expect(opener).toHaveFocus();
  return dialog;
}

describe('app shell', () => {
  it('names its landmarks, navigation and the unread count', async () => {
    const backend = __setMockBackendForTests();
    await backend.setSetting('onboarding.completed', '1');
    const unread: Notification = {
      id: 1,
      kind: 'failure',
      title: 'Run failed',
      body: 'Details',
      read: false,
      createdAt: new Date().toISOString(),
    };
    vi.spyOn(backend, 'listNotifications').mockResolvedValue([unread]);
    render(<App />);
    await settle();
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Inbox, 1 unread' }),
    ).toBeInTheDocument();
    await expectNoAxeViolations();
  });
});

describe('shared dialogs', () => {
  it('names a modal after its label and keeps its fields labelled', async () => {
    function Rename(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      const close = (): void => {
        setOpen(false);
      };
      return (
        <main>
          <button onClick={() => setOpen(true)}>Rename</button>
          {open && (
            <Modal label="Rename workflow" onClose={close} onBackdrop={close}>
              <h2>Rename workflow</h2>
              <label>
                Name
                <input defaultValue="Nightly checks" />
              </label>
              <button onClick={close}>Save</button>
            </Modal>
          )}
        </main>
      );
    }
    const user = userEvent.setup();
    render(<Rename />);
    const dialog = await checkDialog(
      user,
      screen.getByRole('button', { name: 'Rename' }),
      'Rename workflow',
    );
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: 'Rename' })).toHaveFocus();
  });

  it.each([false, true])(
    'keeps a confirmation (danger %s) valid, trapped and returning focus',
    async (danger) => {
      const user = userEvent.setup();
      render(
        <main>
          <button
            onClick={() =>
              void confirmDialog({
                title: 'Delete run?',
                message: 'Its results go too.',
                confirmLabel: 'Delete',
                danger,
              })
            }
          >
            Delete run
          </button>
          <ConfirmHost />
        </main>,
      );
      const opener = screen.getByRole('button', { name: 'Delete run' });
      await user.click(opener);
      const dialog = screen.getByRole('alertdialog', { name: 'Delete run?' });
      await expectNoAxeViolations();
      const first = document.activeElement;
      const [cancel, confirm] = within(dialog).getAllByRole('button');
      if (cancel === undefined || confirm === undefined) throw new Error('fixture');
      expect([cancel, confirm]).toContain(first);
      const other = first === cancel ? confirm : cancel;
      await user.tab();
      expect(other).toHaveFocus();
      await user.tab();
      expect(first).toHaveFocus();
      await user.tab({ shift: true });
      expect(other).toHaveFocus();
      await user.click(cancel);
      expect(dialog).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
    },
  );
});

describe('Workflows view', () => {
  it('is accessible with no workflows', async () => {
    await emptyBackend();
    await renderView(<WorkflowsView />);
    expect(screen.getByRole('heading', { level: 1, name: 'Workflows' })).toBeVisible();
    await expectNoAxeViolations();
  });

  it(
    'marks the open workflow and labels every node inspector',
    async () => {
      const { workflowId } = await populatedBackend();
      const user = await renderView(<WorkflowsView />);
      const card = screen
        .getByText('Sample: Environment Check', { selector: '.wf-card-name' })
        .closest('button');
      expect(card).toHaveAttribute('aria-current', 'true');
      await expectNoAxeViolations();

      const adders = within(screen.getByRole('group', { name: 'Add nodes' }))
        .getAllByRole('button')
        .filter((button) => button.textContent.startsWith('+ '));
      expect(adders.length).toBeGreaterThan(5);
      for (const adder of adders) await user.click(adder);
      await settle();
      const definition = useAppStore
        .getState()
        .workflows.find((w) => w.id === workflowId)?.definition;
      if (definition === undefined) throw new Error('fixture');
      for (const node of definition.nodes) {
        act(() => {
          useAppStore.getState().selectNode(node.id);
        });
        await settle();
        expect(
          screen.getByRole('complementary', { name: 'Node inspector' }),
        ).toBeVisible();
        if (node.type === 'git' || node.type === 'github') {
          const operation = screen.getByRole('combobox', { name: 'Operation' });
          const ops = within(operation)
            .getAllByRole<HTMLOptionElement>('option')
            .map((option) => option.value);
          for (const op of ops) {
            await user.selectOptions(
              screen.getByRole('combobox', { name: 'Operation' }),
              op,
            );
            await expectNoAxeViolations();
          }
        } else {
          await expectNoAxeViolations();
        }
      }
      const edge = definition.edges[0];
      if (edge === undefined) throw new Error('fixture');
      act(() => {
        useAppStore.getState().selectEdge(edge.id);
      });
      await settle();
      expect(screen.getByRole('complementary', { name: 'Edge inspector' })).toBeVisible();
      await expectNoAxeViolations();
    },
    SLOW,
  );

  it('ties visible field labels to their inputs', async () => {
    const { workflowId } = await populatedBackend();
    const user = await renderView(<WorkflowsView />);
    const group = screen.getByRole('group', { name: 'Add nodes' });
    await user.click(within(group).getByRole('button', { name: '+ Git' }));
    await user.click(within(group).getByRole('button', { name: '+ MCP Tool' }));
    const nodes =
      useAppStore.getState().workflows.find((w) => w.id === workflowId)?.definition
        .nodes ?? [];
    const git = nodes.find((n) => n.type === 'git');
    const mcp = nodes.find((n) => n.type === 'mcp');
    if (git === undefined || mcp === undefined) throw new Error('fixture');
    act(() => {
      useAppStore.getState().selectNode(git.id);
    });
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Operation' }),
      'stage',
    );
    expect(
      screen.getByRole('textbox', { name: 'Paths (one per line, explicit)' }),
    ).toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Operation' }),
      'branchCreate',
    );
    expect(
      screen.getByRole('textbox', { name: 'Branch name (blank = workflow default)' }),
    ).toBeInTheDocument();
    act(() => {
      useAppStore.getState().selectNode(mcp.id);
    });
    expect(screen.getByRole('textbox', { name: 'Tool name' })).toBeInTheDocument();
    expect(
      screen.getByRole('textbox', { name: /^Arguments \(one KEY=value per line/ }),
    ).toBeInTheDocument();
  });

  it(
    'keeps each dialog named, valid and returning focus',
    async () => {
      await populatedBackend();
      const user = await renderView(<WorkflowsView />);
      const button = (name: string | RegExp): HTMLElement =>
        screen.getByRole('button', { name });
      await checkDialog(user, button('Samples…'), 'Sample workflows');
      await checkDialog(user, button('✦ Generate'), 'Generate workflow');
      await checkDialog(user, button('✦ Assist'), 'Assist workflow');
      await checkDialog(user, button('Save as template'), 'Save workflow as template');
      await checkDialog(user, button(/JSON/), 'Edit workflow as JSON');
      await checkDialog(user, button('Usage limits'), 'Usage limits');
      await checkDialog(user, button('Dry run'), 'Dry run workflow');
      await checkDialog(user, button('▶ Run'), 'Start run');
    },
    SLOW,
  );
});

describe('Agents view', () => {
  it('is accessible with no profiles and in the new-profile dialog', async () => {
    await emptyBackend();
    const user = await renderView(<AgentsView />);
    await expectNoAxeViolations();
    const opener = screen.getByRole('button', { name: '+ New profile' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'New agent profile' });
    expect(within(dialog).getByRole('heading', { name: 'New profile' })).toBeVisible();
    await user.keyboard('{Escape}');
    await checkDialog(user, opener, 'New agent profile');
  });

  it('is accessible with profiles and in the edit-profile dialog', async () => {
    await populatedBackend();
    const user = await renderView(<AgentsView />);
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
    await expectNoAxeViolations();
    const edit = screen.getAllByRole('button', { name: 'Edit' })[0];
    if (edit === undefined) throw new Error('fixture');
    await checkDialog(user, edit, 'Edit agent profile');
  });
});

describe('Setup check and in-place updates', () => {
  it('is accessible with setup check results and the install button', async () => {
    const { backend } = await populatedBackend();
    backend.checkAgentSetup = (id) =>
      Promise.resolve({
        profileId: id,
        profileName: 'Checked',
        status: 'warning',
        durationMs: 1,
        items: [
          {
            id: 'installed',
            label: 'CLI installed',
            status: 'passed',
            detail: '/bin/claude',
          },
          {
            id: 'editFile',
            label: 'Edits files without asking',
            status: 'warning',
            detail: 'Refused tools: Write.',
            hint: 'Give this profile `Full access`.',
          },
        ],
      });
    backend.desktopInfo = () =>
      Promise.resolve({
        platform: 'linux',
        arch: 'x86_64',
        installKind: 'appimage',
        inPlaceUpdates: true,
      });
    useAppStore.setState({
      updateCheck: {
        current: '0.1.24',
        latest: {
          version: '0.2.0',
          url: 'https://github.com/iazaran/orchevia/releases/tag/v0.2.0',
          assets: [],
        },
        updateAvailable: true,
        checkedAt: '2026-11-01T10:00:00Z',
      },
    });
    const user = await renderView(<EnvironmentView />);
    await user.click(screen.getByRole('button', { name: 'Check every profile' }));
    expect(await screen.findAllByText('Works, with limits')).not.toHaveLength(0);
    expect(
      await screen.findByRole('button', { name: 'Install and restart' }),
    ).toBeVisible();
    await expectNoAxeViolations();
  });

  it('is accessible with a profile check in Agents', async () => {
    await populatedBackend();
    const user = await renderView(<AgentsView />);
    const check = screen.getAllByRole('button', { name: 'Check setup' })[0];
    if (check === undefined) throw new Error('fixture');
    await user.click(check);
    expect(await screen.findAllByText('Needs attention')).not.toHaveLength(0);
    await expectNoAxeViolations();
  });
});

describe('Templates view', () => {
  it('is accessible with built-in and saved templates and in its dialogs', async () => {
    await populatedBackend();
    const user = await renderView(<TemplatesView />);
    expect(await screen.findByText('My review')).toBeInTheDocument();
    await expectNoAxeViolations();
    const use = screen.getAllByRole('button', { name: 'Use template' })[0];
    const exportJson = screen.getAllByRole('button', { name: 'Export JSON' })[0];
    if (use === undefined || exportJson === undefined) throw new Error('fixture');
    await checkDialog(user, use, /^Use template /);
    await checkDialog(
      user,
      screen.getByRole('button', { name: 'Import JSON…' }),
      'Import template JSON',
    );
    await checkDialog(user, exportJson, 'Export template JSON');
  });
});

describe('Automations view', () => {
  it('is accessible with nothing scheduled', async () => {
    await emptyBackend();
    await renderView(<AutomationsView />);
    expect(screen.getByRole('heading', { name: 'No schedules yet' })).toBeVisible();
    await expectNoAxeViolations();
  });

  it(
    'is accessible with a schedule and a watcher, and in both editors',
    async () => {
      await populatedBackend();
      const user = await renderView(<AutomationsView />);
      expect(await screen.findByText('Nightly check')).toBeInTheDocument();
      await expectNoAxeViolations();
      await user.click(screen.getByRole('button', { name: '+ New schedule' }));
      const editor = screen.getByRole('dialog', { name: 'Schedule editor' });
      for (const cadence of ['oneTime', 'interval', 'daily', 'weekly', 'cron']) {
        const chip = within(editor).getByRole('button', { name: cadence });
        await user.click(chip);
        expect(chip).toHaveAttribute('aria-pressed', 'true');
        await expectNoAxeViolations();
      }
      await user.keyboard('{Escape}');
      await checkDialog(
        user,
        screen.getByRole('button', { name: '+ New schedule' }),
        'Schedule editor',
      );
      await checkDialog(
        user,
        screen.getByRole('button', { name: '+ New watcher' }),
        'Watcher editor',
      );
    },
    SLOW,
  );
});

describe('Memory view', () => {
  it('is accessible with no memory', async () => {
    await emptyBackend();
    await renderView(<MemoryView />);
    expect(screen.getByRole('textbox', { name: 'Preferences JSON' })).toBeInTheDocument();
    await expectNoAxeViolations();
  });

  it('is accessible with a preference and in the edit dialog', async () => {
    await populatedBackend();
    const user = await renderView(<MemoryView />);
    expect(screen.getByText('custom.*.lint')).toBeInTheDocument();
    await expectNoAxeViolations();
    const edit = screen.getAllByRole('button', { name: 'Edit' })[0];
    if (edit === undefined) throw new Error('fixture');
    await checkDialog(user, edit, 'Edit preference');
  });
});

describe('Runs view', () => {
  it('is accessible with no runs', async () => {
    await emptyBackend();
    await renderView(<RunsView />);
    await expectNoAxeViolations();
  });

  it(
    'marks the open run and is accessible with its report dialog',
    async () => {
      const { backend, workflowId } = await populatedBackend();
      const { finishedRunId } = await seedRuns(backend, workflowId);
      await act(async () => {
        await useAppStore.getState().selectRun(finishedRunId);
      });
      const user = await renderView(<RunsView />);
      const row = screen.getByTitle(finishedRunId);
      expect(row).toHaveAttribute('aria-current', 'true');
      await expectNoAxeViolations();
      await checkDialog(
        user,
        await screen.findByRole('button', { name: 'Open full report' }),
        'Run report',
      );
    },
    SLOW,
  );

  it(
    'is accessible while a run waits for approval',
    async () => {
      const { backend, workflowId } = await populatedBackend();
      const { pausedRunId } = await seedRuns(backend, workflowId);
      await act(async () => {
        await useAppStore.getState().selectRun(pausedRunId);
      });
      await renderView(<RunsView />);
      expect(
        (await screen.findAllByText('Check the plan before tests run.')).length,
      ).toBeGreaterThan(0);
      await expectNoAxeViolations();
    },
    SLOW,
  );

  it(
    'is accessible after a rejection and in the recovery dialog',
    async () => {
      const { backend, workflowId } = await populatedBackend();
      const { pausedRunId } = await seedRuns(backend, workflowId);
      await backend.approveRun(pausedRunId, false, 'Not this plan');
      await waitForRun(backend, pausedRunId, 'failed');
      await act(async () => {
        await useAppStore.getState().refreshRuns();
        await useAppStore.getState().selectRun(pausedRunId);
      });
      const user = await renderView(<RunsView />);
      await expectNoAxeViolations();
      await checkDialog(
        user,
        screen.getByRole('button', { name: 'Recover failed run' }),
        'Recover failed run',
      );
    },
    SLOW,
  );
});

describe('Environment view', () => {
  it('is accessible with an MCP server and in its dialogs', async () => {
    await populatedBackend();
    const user = await renderView(<EnvironmentView />);
    expect(await screen.findByText('Files')).toBeInTheDocument();
    await expectNoAxeViolations();
    await checkDialog(
      user,
      screen.getByRole('button', { name: '+ New MCP server' }),
      'MCP server editor',
    );
    await checkDialog(
      user,
      screen.getByRole('button', { name: 'Export diagnostics bundle' }),
      'Diagnostics bundle',
    );
  });
});

function usageSummary(): UsageSummary {
  const summary = emptyUsageSummary();
  summary.runsScanned = 2;
  summary.totals.runs = 2;
  summary.totals.agentAttempts = 3;
  summary.totals.reportedUsd = 1.25;
  summary.totals.reportedUsdAttempts = 2;
  summary.totals.unknownUsdAttempts = 1;
  summary.totals.inputTokens = 1200;
  summary.totals.outputTokens = 300;
  summary.days = [
    {
      day: '2026-10-23',
      runs: 2,
      agentAttempts: 3,
      reportedUsd: 1.25,
      inputTokens: 1200,
      outputTokens: 300,
    },
  ];
  summary.byWorkflow = [
    {
      workflowId: 'wf',
      workflowName: 'Nightly review',
      runs: 2,
      agentAttempts: 3,
      reportedUsd: 1.25,
      unknownUsdAttempts: 1,
    },
  ];
  summary.byModel = [
    {
      adapter: 'claude',
      model: 'opus',
      agentAttempts: 3,
      inputTokens: 1200,
      outputTokens: 300,
      reportedUsd: 1.25,
      reportedUsdAttempts: 2,
      unknownUsdAttempts: 1,
      observedToolCalls: 4,
      observedSubagents: 0,
      cachedInputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      coverage: emptyUsageCoverage(),
    },
  ];
  summary.byProfile = [
    {
      profileId: 'reviewer',
      runs: 2,
      agentAttempts: 3,
      totalDurationMs: 90_000,
      lastRunAt: '2026-10-23T10:00:00.000Z',
      reportedUsd: 1.25,
      reportedUsdAttempts: 2,
      unknownUsdAttempts: 1,
    },
  ];
  summary.providerDays = [
    {
      day: '2026-10-23',
      adapter: 'claude',
      agentAttempts: 3,
      durationMs: 90_000,
      reportedUsd: 1.25,
      reportedUsdAttempts: 2,
      allAgentAttempts: 3,
      allDurationMs: 90_000,
    },
  ];
  return summary;
}

describe('Usage view', () => {
  it('is accessible with no usage yet', async () => {
    await emptyBackend();
    await renderView(<UsageView />);
    await expectNoAxeViolations();
  });

  it(
    'is accessible with usage on every breakdown tab',
    async () => {
      const { backend } = await populatedBackend();
      vi.spyOn(backend, 'usageSummary').mockResolvedValue(usageSummary());
      const user = await renderView(<UsageView />);
      const tabs = await screen.findAllByRole('tab');
      expect(tabs.length).toBeGreaterThan(1);
      for (const tab of tabs) {
        await user.click(tab);
        expect(tab).toHaveAttribute('aria-selected', 'true');
        await expectNoAxeViolations();
      }
    },
    SLOW,
  );
});

describe('Inbox view', () => {
  it('is accessible with no notifications', async () => {
    await emptyBackend();
    await renderView(<InboxView />);
    await expectNoAxeViolations();
  });

  it('is accessible with read and unread notifications', async () => {
    const { backend } = await populatedBackend();
    const notifications: Notification[] = [
      {
        id: 2,
        kind: 'approval',
        title: 'Approval needed',
        body: 'Check the plan',
        read: false,
        createdAt: new Date().toISOString(),
      },
      {
        id: 1,
        kind: 'failure',
        title: 'Run failed',
        body: 'Details',
        read: true,
        runId: 'run-1',
        createdAt: new Date().toISOString(),
      },
    ];
    vi.spyOn(backend, 'listNotifications').mockResolvedValue(notifications);
    useAppStore.setState({ notifications });
    const user = await renderView(<InboxView />);
    expect(screen.getByText('Approval needed')).toBeInTheDocument();
    await expectNoAxeViolations();
    // The label says what the button does next, so it is not also a toggle.
    const history = screen.getByRole('button', { name: 'Show read history' });
    expect(history).not.toHaveAttribute('aria-pressed');
    await user.click(history);
    expect(screen.getByText('Run failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show unread' })).not.toHaveAttribute(
      'aria-pressed',
    );
    await expectNoAxeViolations();
  });
});
