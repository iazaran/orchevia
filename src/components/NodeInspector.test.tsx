import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NodeInspector } from './NodeInspector';
import { useAppStore } from '../store';
import { __setMockBackendForTests } from '../lib/backend';
import { createEmptyWorkflow } from '../lib/workflow';
import { createDefaultProfile } from '../lib/agents';

afterEach(() => vi.restoreAllMocks());

it('persists node fields without blur and has no redundant Save node action', async () => {
  const backend = __setMockBackendForTests();
  const workflow = createEmptyWorkflow('Inspector autosave');
  workflow.nodes.push({
    id: 'command',
    type: 'command',
    position: { x: 0, y: 0 },
    config: { executable: 'echo' },
  });
  const stored = await backend.saveWorkflow(workflow);
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    selectedNodeId: 'command',
    selectedEdgeId: null,
    overlayRunId: null,
  });
  render(<NodeInspector />);
  fireEvent.change(screen.getByLabelText('Executable'), { target: { value: 'git' } });
  await waitFor(async () =>
    expect(
      (await backend.getWorkflow(stored.id))?.definition.nodes.find(
        (n) => n.id === 'command',
      )?.config.executable,
    ).toBe('git'),
  );
  expect(screen.queryByRole('button', { name: 'Save node' })).not.toBeInTheDocument();
});

it('persists valid advanced condition edits before focus leaves the field', async () => {
  const backend = __setMockBackendForTests();
  const workflow = createEmptyWorkflow('Condition autosave');
  workflow.nodes.push({
    id: 'condition',
    type: 'condition',
    position: { x: 0, y: 0 },
    config: {
      condition: {
        logic: 'or',
        clauses: [{ left: 'input.review', op: 'contains', right: 'P0' }],
      },
    },
  });
  const stored = await backend.saveWorkflow(workflow);
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    selectedNodeId: 'condition',
    selectedEdgeId: null,
    overlayRunId: null,
  });
  render(<NodeInspector />);
  const text = screen.getByLabelText('Text form (advanced)');
  fireEvent.change(text, { target: { value: 'input.review contains "P1"' } });
  await waitFor(async () =>
    expect(
      (await backend.getWorkflow(stored.id))?.definition.nodes.find(
        (n) => n.id === 'condition',
      )?.config.condition?.clauses[0]?.right,
    ).toBe('P1'),
  );
  expect(text).toBe(screen.getByLabelText('Text form (advanced)'));
});

it('preserves edits made while detecting a workflow branch', async () => {
  const backend = __setMockBackendForTests();
  const workflow = createEmptyWorkflow('Branch detection');
  workflow.defaults = { repoDir: '/repo' };
  const stored = await backend.saveWorkflow(workflow);
  let release: (branch: string) => void = () => {};
  vi.spyOn(backend, 'gitCurrentBranch').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    selectedNodeId: null,
    selectedEdgeId: null,
    overlayRunId: null,
  });
  render(<NodeInspector />);
  fireEvent.click(screen.getByRole('button', { name: 'Detect current' }));
  fireEvent.change(screen.getByLabelText('Name'), {
    target: { value: 'New name while detecting' },
  });
  release('feature');
  await waitFor(() =>
    expect(useAppStore.getState().workflows[0]?.definition.defaults?.branch).toBe(
      'feature',
    ),
  );
  expect(useAppStore.getState().workflows[0]?.definition.name).toBe(
    'New name while detecting',
  );
  await useAppStore.getState().saveActiveWorkflow();
});

it('keeps an incomplete advanced expression visible while its prior valid edit finishes saving', async () => {
  const backend = __setMockBackendForTests();
  const workflow = createEmptyWorkflow('Incomplete expression');
  workflow.nodes.push({
    id: 'condition',
    type: 'condition',
    position: { x: 0, y: 0 },
    config: {
      condition: {
        logic: 'or',
        clauses: [{ left: 'input.review', op: 'contains', right: 'P0' }],
      },
    },
  });
  const stored = await backend.saveWorkflow(workflow);
  const save = backend.saveWorkflow.bind(backend);
  // A native Tauri response is a fresh JSON object.
  vi.spyOn(backend, 'saveWorkflow').mockImplementation(async (definition) =>
    structuredClone(await save(definition)),
  );
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    selectedNodeId: 'condition',
    selectedEdgeId: null,
    overlayRunId: null,
  });
  render(<NodeInspector />);
  const text = screen.getByLabelText('Text form (advanced)');
  fireEvent.change(text, { target: { value: 'input.review contains "P1"' } });
  fireEvent.change(text, { target: { value: 'input.review contains "unfinished' } });
  await waitFor(() =>
    expect(useAppStore.getState().workflowSaveStates[stored.id]?.status).toBe('saved'),
  );
  expect(screen.getByLabelText('Text form (advanced)')).toHaveValue(
    'input.review contains "unfinished',
  );
  // A half-typed expression stays quiet until the field is left.
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.blur(text);
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(text).toHaveAttribute('aria-invalid', 'true');
  fireEvent.change(text, { target: { value: 'input.review contains "P2"' } });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(
    (await backend.getWorkflow(stored.id))?.definition.nodes.find(
      (n) => n.id === 'condition',
    )?.config.condition?.clauses[0]?.right,
  ).toBe('P1');
});

it('explains an unresolved imported role and removes it when a profile is selected', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const profile = await backend.saveAgentProfile({
    ...createDefaultProfile('codex'),
    name: 'My implementer',
    model: 'chosen-model',
    effort: 'high',
    role: 'implementation',
  });
  const workflow = createEmptyWorkflow('Imported');
  workflow.nodes.push({
    id: 'agent',
    type: 'agent',
    position: { x: 0, y: 0 },
    config: { agentRole: 'implementation', prompt: 'Implement' },
  });
  const stored = await backend.saveWorkflow(workflow);
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    selectedNodeId: 'agent',
    selectedEdgeId: null,
    overlayRunId: null,
    profiles: [profile],
  });
  render(<NodeInspector />);
  expect(screen.getByText(/Role 'implementation' is unresolved/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Agent Profile'), {
    target: { value: profile.id },
  });
  expect(
    screen.getByText(/My implementer.*Codex.*chosen-model.*high/),
  ).toBeInTheDocument();
  await waitFor(async () => {
    const config = (await backend.getWorkflow(stored.id))?.definition.nodes.find(
      (n) => n.id === 'agent',
    )?.config;
    expect(config?.agentProfileId).toBe(profile.id);
    expect(config?.agentRole).toBeUndefined();
    expect(
      (
        await backend.validateWorkflow((await backend.getWorkflow(stored.id))!.definition)
      ).some((i) => i.code === 'agent-role-unresolved'),
    ).toBe(false);
  });
});

it('shows the profile chosen from a template role default', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  await backend.saveAgentProfile({
    ...createDefaultProfile('codex'),
    name: 'Z reviewer',
    role: 'deepReview',
  });
  const expected = await backend.saveAgentProfile({
    ...createDefaultProfile('claude'),
    name: 'A reviewer',
    model: 'chosen-model',
    role: 'deepReview',
  });
  const template = await backend.importTemplate(
    JSON.stringify({
      version: 1,
      name: 'Portable review',
      nodes: [
        { key: 'start', type: 'start', config: {} },
        {
          key: 'review',
          type: 'agent',
          role: 'deepReview',
          config: { prompt: 'Review' },
        },
        { key: 'end', type: 'end', config: {} },
      ],
      edges: [
        { from: 'start', to: 'review' },
        { from: 'review', to: 'end' },
      ],
    }),
  );
  const preview = await backend.instantiateTemplate(template.id, false);
  const node = preview.workflow.nodes.find((n) => n.type === 'agent');
  expect(node?.config.agentProfileId).toBe(expected.id);
  const stored = await backend.saveWorkflow(preview.workflow);
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    selectedNodeId: node?.id ?? null,
    selectedEdgeId: null,
    overlayRunId: null,
    profiles: await backend.listAgentProfiles(),
  });
  render(<NodeInspector />);
  expect(screen.getByLabelText('Agent Profile')).toHaveValue(expected.id);
  expect(
    screen.getByText(/Uses A reviewer.*Claude Code.*chosen-model/),
  ).toBeInTheDocument();
});

it('edits optional session and bounded context settings without blur', async () => {
  const backend = __setMockBackendForTests();
  const workflow = createEmptyWorkflow('Context inspector');
  workflow.nodes.push({
    id: 'agent',
    type: 'agent',
    position: { x: 0, y: 0 },
    config: { prompt: 'Task' },
  });
  const stored = await backend.saveWorkflow(workflow);
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    selectedNodeId: 'agent',
    selectedEdgeId: null,
    overlayRunId: null,
    profiles: [],
  });
  render(<NodeInspector />);
  fireEvent.change(screen.getByLabelText('Session group'), { target: { value: 'dev' } });
  fireEvent.change(screen.getByLabelText('Maximum turns per session'), {
    target: { value: '3' },
  });
  fireEvent.click(
    screen.getByLabelText(
      `Context from ${workflow.nodes[0]!.label ?? workflow.nodes[0]!.id}`,
    ),
  );
  fireEvent.change(screen.getByLabelText('Context character budget'), {
    target: { value: '512' },
  });
  await waitFor(async () =>
    expect(
      (await backend.getWorkflow(stored.id))?.definition.nodes.find(
        (n) => n.id === 'agent',
      )?.config,
    ).toMatchObject({
      sessionGroup: 'dev',
      sessionMaxTurns: 3,
      contextRefs: [workflow.nodes[0]!.id],
      contextMaxChars: 512,
    }),
  );
  fireEvent.change(screen.getByLabelText('Session group'), { target: { value: '' } });
  await waitFor(async () =>
    expect(
      (await backend.getWorkflow(stored.id))?.definition.nodes.find(
        (n) => n.id === 'agent',
      )?.config.sessionMaxTurns,
    ).toBeUndefined(),
  );
});

it("lists only the selected step's own needs, inline", async () => {
  const backend = __setMockBackendForTests();
  const workflow = createEmptyWorkflow('Setup');
  workflow.nodes.push(
    { id: 'cmd', type: 'command', position: { x: 0, y: 0 }, config: {} },
    {
      id: 'other',
      type: 'command',
      label: 'Other',
      position: { x: 0, y: 0 },
      config: {},
    },
  );
  const stored = await backend.saveWorkflow(workflow);
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    selectedNodeId: 'cmd',
    selectedEdgeId: null,
    overlayRunId: null,
    validation: [
      {
        code: 'command-executable',
        message: 'Command node requires an executable.',
        severity: 'error',
        nodeId: 'cmd',
      },
      {
        code: 'command-executable',
        message: 'Other step message.',
        severity: 'error',
        nodeId: 'other',
      },
      { code: 'name', message: 'Workflow-wide.', severity: 'error' },
    ],
  });
  render(<NodeInspector />);
  const status = screen.getByText('To finish this step').closest('.notice');
  expect(status).toHaveTextContent('Command node requires an executable.');
  expect(status).not.toHaveTextContent('Other step message.');
  expect(status).not.toHaveTextContent('Workflow-wide.');
  // Inline guidance, never an alert while the step is being filled in.
  expect(screen.queryByRole('alert')).toBeNull();
});

it("keeps one condition's text error off another condition", () => {
  __setMockBackendForTests();
  const workflow = createEmptyWorkflow('Two conditions');
  for (const id of ['first', 'second'])
    workflow.nodes.push({
      id,
      type: 'condition',
      position: { x: 0, y: 0 },
      config: {
        condition: {
          logic: 'or',
          clauses: [{ left: 'input.review', op: 'contains', right: 'P1' }],
        },
      },
    });
  useAppStore.setState({
    workflows: [
      {
        id: workflow.id,
        name: workflow.name,
        definition: workflow,
        createdAt: '2026-10-23T00:00:00Z',
        updatedAt: '2026-10-23T00:00:00Z',
      },
    ],
    activeWorkflowId: workflow.id,
    selectedNodeId: 'first',
    selectedEdgeId: null,
    overlayRunId: null,
    validation: [],
  });
  render(<NodeInspector />);
  const text = screen.getByLabelText('Text form (advanced)');
  fireEvent.change(text, { target: { value: 'input.review contains "unfinished' } });
  fireEvent.blur(text);
  expect(screen.getByRole('alert')).toBeInTheDocument();
  act(() => useAppStore.setState({ selectedNodeId: 'second' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByLabelText('Text form (advanced)')).not.toHaveAttribute(
    'aria-invalid',
    'true',
  );
});
