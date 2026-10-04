import { expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkflowsView } from './WorkflowsView';
import { __setMockBackendForTests } from '../lib/backend';
import { createEmptyWorkflow } from '../lib/workflow';
import { createDefaultProfile } from '../lib/agents';
import { useAppStore } from '../store';
vi.mock('./WorkflowCanvas', () => ({ WorkflowCanvas: () => null }));
vi.mock('./NodeInspector', () => ({ NodeInspector: () => null }));

it('binds newly created role profiles before accepting a generated workflow', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const generator = await backend.saveAgentProfile({
    ...createDefaultProfile('claude'),
    role: 'workflowGenerator',
  });
  const workflow = createEmptyWorkflow('Generated with new role');
  workflow.nodes.push({
    id: 'implement',
    type: 'agent',
    position: { x: 0, y: 100 },
    config: { agentRole: 'implementation', prompt: 'Implement the goal' },
  });
  vi.spyOn(backend, 'generateWorkflow').mockResolvedValue({
    generationId: 'generation-new-role',
    proposalName: workflow.name,
    explanation: '',
    workflow,
    issues: [],
    unavailable: [],
    riskLabels: [],
    riskyNodes: [],
    blocking: ["Role 'implementation' has no Agent Profile mapping."],
    repairs: [],
    setupNeeded: [],
    unmappedRoles: ['implementation'],
  });
  useAppStore.setState({
    workflows: [],
    activeWorkflowId: null,
    profiles: [generator],
    overlayRunId: null,
    overlayWorkflow: null,
    validation: [],
  });
  render(<WorkflowsView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Generate/ }));
  await user.type(
    screen.getByLabelText('Describe what you want to do'),
    'Implement a feature',
  );
  await user.click(
    within(screen.getByRole('dialog', { name: 'Generate workflow' })).getByRole(
      'button',
      { name: '✦ Generate' },
    ),
  );
  await user.click(
    await screen.findByRole('button', { name: 'Create 1 profile & accept' }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Generate workflow' })).toBeNull(),
  );
  const accepted = await backend.getWorkflow(workflow.id);
  const node = accepted?.definition.nodes.find((n) => n.id === 'implement');
  const profile = (await backend.listAgentProfiles()).find(
    (p) => p.role === 'implementation',
  );
  expect(profile).toBeDefined();
  expect(node?.config.agentProfileId).toBe(profile?.id);
  expect(node?.config.agentRole).toBeUndefined();
  expect(workflow.nodes.find((n) => n.id === 'implement')?.config.agentRole).toBe(
    'implementation',
  );
});

it('reviews each workflow inputs and never carries another workflow values into a run', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const firstWorkflow = createEmptyWorkflow('First inputs');
  firstWorkflow.inputs = [
    { name: 'branch', required: true, default: 'first-default' },
    { name: 'firstOnly', required: false },
  ];
  const secondWorkflow = createEmptyWorkflow('Second inputs');
  secondWorkflow.inputs = [{ name: 'branch', required: true, default: 'second-default' }];
  const first = await backend.saveWorkflow(firstWorkflow);
  const second = await backend.saveWorkflow(secondWorkflow);
  useAppStore.setState({
    workflows: [first, second],
    activeWorkflowId: first.id,
    profiles: [],
    overlayRunId: null,
    overlayWorkflow: null,
    validation: [],
  });
  render(<WorkflowsView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '▶ Run' }));
  await user.clear(screen.getByLabelText('branch *'));
  await user.type(screen.getByLabelText('branch *'), 'first-user-value');
  await user.type(screen.getByLabelText('firstOnly'), 'first-secret');
  await user.click(screen.getByRole('button', { name: /Second inputs/ }));
  await user.click(screen.getByRole('button', { name: '▶ Run' }));
  expect(await backend.listRuns()).toEqual([]);
  expect(screen.getByLabelText('branch *')).toHaveValue('second-default');
  await user.click(screen.getByRole('button', { name: '▶ Run with inputs' }));
  await waitFor(async () =>
    expect((await backend.listRuns())[0]?.workflowId).toBe(second.id),
  );
  expect((await backend.listRuns())[0]?.inputs).toEqual({ branch: 'second-default' });
});

it('keeps malformed JSON in the editor without saving a crashing shape', async () => {
  const backend = __setMockBackendForTests();
  const wf = createEmptyWorkflow('Invalid shape');
  const stored = await backend.saveWorkflow(wf);
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: wf.id,
    profiles: [],
    validation: [],
    overlayRunId: null,
  });
  const save = vi.spyOn(backend, 'saveWorkflow');
  render(<WorkflowsView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'JSON' }));
  const editor = screen.getByLabelText<HTMLTextAreaElement>('Workflow JSON');
  await waitFor(() => expect(editor.value).toContain('"version": 1'));
  await user.clear(editor);
  await user.paste(
    JSON.stringify({
      version: 1,
      name: 'Bad',
      nodes: [{ key: 'a', type: 'command', config: { executable: 'echo', args: 42 } }],
      edges: [],
    }),
  );
  await user.click(screen.getByRole('button', { name: 'Save JSON' }));
  expect(await screen.findByText(/Invalid args/)).toBeInTheDocument();
  expect(screen.getByLabelText('Workflow JSON')).toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
});

it('observes concrete command edits saved through the JSON editor', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const wf = createEmptyWorkflow('JSON memory');
  wf.defaults = { repoDir: '/project' };
  wf.nodes.push({
    id: 'tests',
    type: 'command',
    label: 'Tests',
    position: { x: 0, y: 100 },
    config: { executable: 'sh', args: ['-c', 'make old'] },
  });
  wf.edges = [
    { id: 'e1', source: wf.nodes[0]!.id, target: 'tests' },
    { id: 'e2', source: 'tests', target: wf.nodes[1]!.id },
  ];
  const stored = await backend.saveWorkflow(wf);
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: wf.id,
    profiles: [],
    validation: [],
    overlayRunId: null,
  });
  const observe = vi.spyOn(backend, 'observeEdits');
  render(<WorkflowsView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'JSON' }));
  const editor = screen.getByLabelText<HTMLTextAreaElement>('Workflow JSON');
  await waitFor(() => expect(editor.value).toContain('make old'));
  const text = editor.value.replace('make old', 'make test');
  await user.clear(editor);
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: 'Save JSON' }));
  await waitFor(() => expect(screen.queryByLabelText('Workflow JSON')).toBeNull());
  expect(observe).toHaveBeenCalledWith([
    { scope: 'repo:/project', field: 'testCommand', from: 'make old', to: 'make test' },
  ]);
});
it('opens simple JSON and preserves the definition through advanced conversion', async () => {
  const backend = __setMockBackendForTests();
  const wf = createEmptyWorkflow('Editable');
  const stored = await backend.saveWorkflow(wf);
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: wf.id,
    profiles: [],
    validation: [],
    overlayRunId: null,
  });
  render(<WorkflowsView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'JSON' }));
  const editor = screen.getByLabelText<HTMLTextAreaElement>('Workflow JSON');
  await waitFor(() => expect(editor.value).toContain('"version": 1'));
  expect(editor.value).not.toContain('position');
  await user.click(screen.getByRole('button', { name: 'Advanced JSON' }));
  await waitFor(() => expect(editor.value).toContain('"position"'));
  await user.click(screen.getByRole('button', { name: 'Save JSON' }));
  await waitFor(() =>
    expect(screen.queryByLabelText('Workflow JSON')).not.toBeInTheDocument(),
  );
  expect((await backend.getWorkflow(wf.id))?.definition).toEqual(wf);
});

it('shows only applicable accepted project memory before generation', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  await backend.saveProjectPreference(
    '/project',
    'testCommand',
    'make current',
    'User instructions',
  );
  await backend.saveProjectPreference(
    '/other',
    'testCommand',
    'make other',
    'Other repo',
  );
  const wf = createEmptyWorkflow('Context');
  const stored = await backend.saveWorkflow(wf);
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: wf.id,
    profiles: [],
    overlayRunId: null,
    overlayWorkflow: null,
    validation: [],
  });
  render(<WorkflowsView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Generate/ }));
  await user.type(screen.getByLabelText('Repository directory'), '/project');
  await waitFor(() => expect(screen.getByText(/make current/)).toBeInTheDocument());
  expect(screen.queryByText(/make other/)).toBeNull();
});
