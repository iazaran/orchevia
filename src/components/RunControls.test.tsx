import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { StartRunDialog, UsageContinueDialog, UsageLimitsDialog } from './RunControls';
import { __setMockBackendForTests } from '../lib/backend';
import { createEmptyWorkflow } from '../lib/workflow';
import { createDefaultProfile } from '../lib/agents';
import { useAppStore } from '../store';
import { ConfirmHost } from './ConfirmDialog';

it('submits dry-run fixtures and declared inputs without spend or attempt controls', async () => {
  const workflow = createEmptyWorkflow('Fixture test');
  workflow.inputs = [{ name: 'item', required: true, default: 'example' }];
  workflow.nodes.splice(1, 0, {
    id: 'a',
    type: 'command',
    position: { x: 0, y: 0 },
    config: { executable: 'forbidden' },
  });
  const start = vi.fn().mockResolvedValue(undefined);
  render(
    <StartRunDialog
      workflow={workflow}
      initialDryRun
      onStart={start}
      onClose={() => undefined}
    />,
  );
  fireEvent.change(screen.getByLabelText('Fixture results JSON'), {
    target: { value: '{"a":[{"status":"succeeded","stdout":"done"}]}' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start dry run' }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith(
      { item: 'example' },
      { dryRun: true, fixtures: { a: [{ status: 'succeeded', stdout: 'done' }] } },
    ),
  );
  expect(screen.queryByLabelText('Agent attempts (enforced)')).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/Spend limit USD/)).not.toBeInTheDocument();
});

it('rejects malformed fixture JSON before submission', async () => {
  const start = vi.fn();
  render(
    <StartRunDialog
      workflow={createEmptyWorkflow('Bad')}
      initialDryRun
      onStart={start}
      onClose={() => undefined}
    />,
  );
  fireEvent.change(screen.getByLabelText('Fixture results JSON'), {
    target: { value: '[]' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start dry run' }));
  await waitFor(() =>
    expect(
      screen.getByText('Fixture document must be an object keyed by node id.'),
    ).toBeInTheDocument(),
  );
  expect(start).not.toHaveBeenCalled();
});

it('requires declared inputs and reports the saved attempt budget as the default', async () => {
  const workflow = createEmptyWorkflow('Live limits');
  workflow.inputs = [{ name: 'ticket', required: true }];
  workflow.limits = { maxAgentAttempts: 7 };
  const start = vi.fn().mockResolvedValue(undefined);
  render(
    <StartRunDialog
      workflow={workflow}
      initialDryRun={false}
      onStart={start}
      onClose={() => undefined}
    />,
  );
  // Required input blocks the start.
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
  await waitFor(() =>
    expect(screen.getByText("Input 'ticket' is required.")).toBeInTheDocument(),
  );
  expect(start).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('ticket (required)'), {
    target: { value: 'DEV-1' },
  });
  // The saved budget is visible as the inherited placeholder.
  expect(screen.getByLabelText('Agent attempts (enforced)')).toHaveAttribute(
    'placeholder',
    'Inherit: 7',
  );
  // Blank inherits: no override is sent.
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
  await waitFor(() => expect(start).toHaveBeenCalledWith({ ticket: 'DEV-1' }, {}));
});

it('sends explicit limit overrides and can clear saved limits for one run', async () => {
  const workflow = createEmptyWorkflow('Override');
  workflow.limits = { maxAgentAttempts: 7, spendLimitUsd: 5 };
  const start = vi.fn().mockResolvedValue(undefined);
  render(
    <StartRunDialog
      workflow={workflow}
      initialDryRun={false}
      onStart={start}
      onClose={() => undefined}
    />,
  );
  fireEvent.change(screen.getByLabelText('Agent attempts (enforced)'), {
    target: { value: '3' },
  });
  fireEvent.click(screen.getByText(/Run without saved limits/));
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith(
      {},
      { maxAgentAttempts: 3, ignoreSavedLimits: true },
    ),
  );
});

it('prevents duplicate starts while the first start is still busy', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start = vi.fn().mockImplementation(() => pending);
  const close = vi.fn();
  render(
    <StartRunDialog
      workflow={createEmptyWorkflow('Duplicate')}
      initialDryRun={false}
      onStart={start}
      onClose={close}
    />,
  );
  const button = screen.getByRole('button', { name: 'Start run' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(start).toHaveBeenCalledTimes(1);
  expect(button).toBeDisabled();
  release();
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(start).toHaveBeenCalledTimes(1);
});

it.each(['start', 'save', 'continue'] as const)(
  'keeps the %s dialog open when X or Escape is used during a pending mutation',
  async (action) => {
    const backend = __setMockBackendForTests();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutate = vi.fn().mockImplementation(() => pending);
    const close = vi.fn();
    const workflow = createEmptyWorkflow('Busy');
    if (action === 'start') {
      render(
        <StartRunDialog
          workflow={workflow}
          initialDryRun={false}
          onStart={mutate}
          onClose={close}
        />,
      );
    } else if (action === 'save') {
      render(<UsageLimitsDialog workflow={workflow} onSave={mutate} onClose={close} />);
    } else {
      vi.spyOn(backend, 'continueUsageRun').mockImplementation(mutate);
      render(
        <UsageContinueDialog
          runId="run-busy"
          pause={{ id: 1, consumedAttempts: 1, limitAttempts: 1 }}
          onContinued={() => Promise.resolve()}
          onClose={close}
        />,
      );
    }
    fireEvent.click(
      screen.getByRole('button', {
        name:
          action === 'start'
            ? 'Start run'
            : action === 'save'
              ? 'Save limits'
              : 'Continue run',
      }),
    );
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    const dismiss = screen.getByRole('button', { name: 'Close' });
    fireEvent.click(dismiss);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    expect(dismiss).toBeDisabled();
    release();
    await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  },
);

it('rejects negative and non-numeric overrides without starting', async () => {
  const start = vi.fn();
  render(
    <StartRunDialog
      workflow={createEmptyWorkflow('Negative')}
      initialDryRun={false}
      onStart={start}
      onClose={() => undefined}
    />,
  );
  fireEvent.change(screen.getByLabelText('Nested subagents (advisory)'), {
    target: { value: '-4' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
  await waitFor(() =>
    expect(
      screen.getByText('Subagent allowance must be a whole number of at least 1.'),
    ).toBeInTheDocument(),
  );
  expect(start).not.toHaveBeenCalled();
});

it('rejects out-of-range overrides without starting', async () => {
  const start = vi.fn();
  render(
    <StartRunDialog
      workflow={createEmptyWorkflow('Range')}
      initialDryRun={false}
      onStart={start}
      onClose={() => undefined}
    />,
  );
  fireEvent.change(screen.getByLabelText('Agent attempts (enforced)'), {
    target: { value: '0' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
  await waitFor(() =>
    expect(
      screen.getByText('Agent attempt limit must be a whole number of at least 1.'),
    ).toBeInTheDocument(),
  );
  expect(start).not.toHaveBeenCalled();
});

it('cancel closes the form without starting or saving overrides', () => {
  const start = vi.fn();
  const close = vi.fn();
  render(
    <StartRunDialog
      workflow={createEmptyWorkflow('Cancel')}
      initialDryRun={false}
      onStart={start}
      onClose={close}
    />,
  );
  fireEvent.change(screen.getByLabelText('Agent attempts (enforced)'), {
    target: { value: '9' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(close).toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
});

it('saves workflow limits and clears them when every field is empty', async () => {
  const workflow = createEmptyWorkflow('Saved limits');
  const save = vi.fn().mockResolvedValue(undefined);
  const { rerender } = render(
    <UsageLimitsDialog workflow={workflow} onClose={() => undefined} onSave={save} />,
  );
  fireEvent.change(screen.getByLabelText('Agent attempts per run (enforced)'), {
    target: { value: '12' },
  });
  fireEvent.change(screen.getByLabelText(/Spend target USD/), {
    target: { value: '2.5' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({ maxAgentAttempts: 12, spendLimitUsd: 2.5 }),
  );
  rerender(
    <UsageLimitsDialog
      workflow={{ ...workflow, limits: { maxAgentAttempts: 12 } }}
      onClose={() => undefined}
      onSave={save}
    />,
  );
  fireEvent.change(screen.getByLabelText('Agent attempts per run (enforced)'), {
    target: { value: '' },
  });
  fireEvent.change(screen.getByLabelText(/Spend target USD/), {
    target: { value: '' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(undefined));
});

it('shows declared tools the profile lacks before a live run and adds them', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const profile = {
    ...createDefaultProfile('claude'),
    id: 'prof-impl',
    name: 'Implementer',
  };
  await backend.saveAgentProfile(profile);
  await backend.setSetting('agents.permissionDefault', 'cliSettings');
  useAppStore.setState({ profiles: [profile], agentPermissionDefault: 'cliSettings' });
  const workflow = createEmptyWorkflow('Declared tools');
  workflow.nodes.splice(1, 0, {
    id: 'impl',
    type: 'agent',
    label: 'Implement',
    position: { x: 0, y: 0 },
    config: {
      agentProfileId: 'prof-impl',
      prompt: 'Work',
      requiredTools: ['mcp__jira', 'Bash(gh pr *)'],
    },
  });
  render(
    <>
      <StartRunDialog
        workflow={workflow}
        initialDryRun={false}
        onStart={vi.fn()}
        onClose={() => undefined}
      />
      <ConfirmHost />
    </>,
  );
  const notice = screen.getByText(
    'This workflow declares tools its Agent Profiles do not grant.',
  ).parentElement as HTMLElement;
  expect(notice).toHaveTextContent('Implementer');
  expect(notice).toHaveTextContent('Bash(gh pr *)');
  fireEvent.click(screen.getByRole('button', { name: 'Add to allowed tools' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add tools' }));
  await waitFor(() =>
    expect(
      screen.queryByText('This workflow declares tools its Agent Profiles do not grant.'),
    ).not.toBeInTheDocument(),
  );
  const [saved] = await backend.listAgentProfiles();
  expect(saved?.allowedTools).toEqual(['mcp__jira', 'Bash(gh pr *)']);
  // Dry runs never call the CLI, so they show no permission notice.
  fireEvent.click(screen.getByLabelText(/Dry run/));
  expect(screen.queryByText(/declares tools/)).not.toBeInTheDocument();
  useAppStore.setState({ agentPermissionDefault: null });
});

it('asks once whether agents work without asking, then never again', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const follows = { ...createDefaultProfile('claude'), id: 'prof-a', name: 'Reviewer' };
  const own = {
    ...createDefaultProfile('claude'),
    id: 'prof-b',
    name: 'Implementer',
    permissionLevel: 'allowedTools' as const,
    allowedTools: ['Edit'],
  };
  await backend.saveAgentProfile(follows);
  await backend.saveAgentProfile(own);
  useAppStore.setState({ profiles: [follows, own], agentPermissionDefault: null });
  const workflow = createEmptyWorkflow('Agents');
  workflow.nodes.splice(1, 0, {
    id: 'impl',
    type: 'agent',
    label: 'Implement',
    position: { x: 0, y: 0 },
    config: { agentProfileId: 'prof-b', prompt: 'Work', requiredTools: ['Write'] },
  });
  const dialog = (): React.JSX.Element => (
    <StartRunDialog
      workflow={workflow}
      initialDryRun={false}
      onStart={vi.fn()}
      onClose={() => undefined}
    />
  );
  const { unmount } = render(dialog());
  expect(screen.getByText('Let AI agents work without asking?')).toBeInTheDocument();
  // One question covers every declared tool: no separate grant list yet.
  expect(screen.queryByText(/declares tools/)).not.toBeInTheDocument();
  expect(
    screen.getByLabelText(/also switch Implementer \(Allowed tools\) to the app default/),
  ).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Let agents work without asking' }));
  await waitFor(() =>
    expect(
      screen.queryByText('Let AI agents work without asking?'),
    ).not.toBeInTheDocument(),
  );
  expect(await backend.getSetting('agents.permissionDefault')).toBe('fullAccess');
  const saved = await backend.listAgentProfiles();
  expect(saved.find((p) => p.id === 'prof-b')?.permissionLevel).toBe('appDefault');
  // The saved list stays, unused, if the profile gets its own level again.
  expect(saved.find((p) => p.id === 'prof-b')?.allowedTools).toEqual(['Edit']);
  expect(useAppStore.getState().agentPermissionDefault).toBe('fullAccess');
  // Full access grants every declared tool, so nothing is shown next time.
  unmount();
  render(dialog());
  expect(screen.queryByText(/without asking/)).not.toBeInTheDocument();
  expect(screen.queryByText(/declares tools/)).not.toBeInTheDocument();
  useAppStore.setState({ agentPermissionDefault: null });
});

it('keeps the CLI settings when chosen and then lists the missing tools', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const profile = { ...createDefaultProfile('claude'), id: 'prof-a', name: 'Reviewer' };
  await backend.saveAgentProfile(profile);
  useAppStore.setState({ profiles: [profile], agentPermissionDefault: null });
  const workflow = createEmptyWorkflow('Agents');
  workflow.nodes.splice(1, 0, {
    id: 'review',
    type: 'agent',
    position: { x: 0, y: 0 },
    config: { agentProfileId: 'prof-a', prompt: 'Review', requiredTools: ['mcp__jira'] },
  });
  render(
    <StartRunDialog
      workflow={workflow}
      initialDryRun={false}
      onStart={vi.fn()}
      onClose={() => undefined}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Keep each CLI’s settings' }));
  expect(
    await screen.findByText(
      'This workflow declares tools its Agent Profiles do not grant.',
    ),
  ).toBeInTheDocument();
  expect(await backend.getSetting('agents.permissionDefault')).toBe('cliSettings');
  expect((await backend.listAgentProfiles())[0]?.permissionLevel).toBeUndefined();
  // The grant list still offers the one-step alternative.
  expect(
    screen.getByRole('button', { name: 'Let agents work without asking' }),
  ).toBeInTheDocument();
  useAppStore.setState({ agentPermissionDefault: null });
});

it('keeps the question and its error when a profile cannot be switched', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const own = {
    ...createDefaultProfile('claude'),
    id: 'prof-b',
    name: 'Implementer',
    permissionLevel: 'allowedTools' as const,
    allowedTools: ['Edit'],
  };
  await backend.saveAgentProfile(own);
  useAppStore.setState({ profiles: [own], agentPermissionDefault: null });
  vi.spyOn(backend, 'saveAgentProfile').mockRejectedValueOnce(new Error('Disk is full.'));
  const workflow = createEmptyWorkflow('Agents');
  workflow.nodes.splice(1, 0, {
    id: 'impl',
    type: 'agent',
    position: { x: 0, y: 0 },
    config: { agentProfileId: 'prof-b', prompt: 'Work' },
  });
  render(
    <StartRunDialog
      workflow={workflow}
      initialDryRun={false}
      onStart={vi.fn()}
      onClose={() => undefined}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Let agents work without asking' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Disk is full.');
  // Nothing was granted: the choice stays unmade and on screen.
  expect(screen.getByText('Let AI agents work without asking?')).toBeInTheDocument();
  expect(await backend.getSetting('agents.permissionDefault')).toBeNull();
  expect(useAppStore.getState().agentPermissionDefault).toBeNull();
  expect((await backend.listAgentProfiles())[0]?.permissionLevel).toBe('allowedTools');
  vi.restoreAllMocks();
});
