import { expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkflowsView } from './WorkflowsView';
import { __setMockBackendForTests } from '../lib/backend';
import {
  createEmptyWorkflow,
  SETUP_ISSUE_CODES,
  type ValidationIssue,
  type WorkflowNode,
} from '../lib/workflow';
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
  await user.clear(screen.getByLabelText('branch (required)'));
  await user.type(screen.getByLabelText('branch (required)'), 'first-user-value');
  await user.type(screen.getByLabelText('firstOnly'), 'first-secret');
  // Switching workflows remounts the floating form: no leaked values.
  await user.click(screen.getByRole('button', { name: /Second inputs/ }));
  expect(await backend.listRuns()).toEqual([]);
  expect(screen.getByLabelText('branch (required)')).toHaveValue('second-default');
  await user.click(screen.getByRole('button', { name: 'Start run' }));
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
  await user.click(screen.getByRole('button', { name: 'Dismiss message' }));
  await waitFor(() => expect(screen.queryByText(/Invalid args/)).toBeNull());
  await user.click(screen.getByRole('button', { name: 'Save JSON' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid args');
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

it('reviews local CLI assistance before replacing the current workflow and never runs it', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const original = createEmptyWorkflow('Existing workflow');
  original.defaults = { repoDir: '/project', branch: 'feature/current' };
  const stored = await backend.saveWorkflow(original);
  const profile = await backend.saveAgentProfile({
    ...createDefaultProfile('codex'),
    role: 'workflowAssistance',
  });
  await backend.setSetting('workflow.assistanceProfileId', profile.id);
  const initialWorkflowCount = (await backend.listWorkflows()).length;
  const proposed = { ...structuredClone(original), name: 'Reviewed improvement' };
  const generate = vi.spyOn(backend, 'generateWorkflow').mockResolvedValue({
    generationId: 'assistance',
    proposalName: proposed.name,
    explanation: 'Improve labels.',
    workflow: proposed,
    issues: [],
    unavailable: [],
    riskLabels: [],
    riskyNodes: [],
    blocking: [],
    repairs: [],
    setupNeeded: [],
    unmappedRoles: [],
  });
  const run = vi.spyOn(backend, 'runWorkflow');
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    profiles: [profile],
    overlayRunId: null,
    overlayWorkflow: null,
    validation: [],
  });
  render(<WorkflowsView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '✦ Assist' }));
  await user.type(
    screen.getByLabelText('Developer instructions (optional)'),
    'Keep approvals and simplify labels',
  );
  await user.click(screen.getByRole('button', { name: 'Preview improvements' }));
  await screen.findByText('Proposed: Reviewed improvement');
  expect((await backend.getWorkflow(stored.id))?.name).toBe('Existing workflow');
  expect(generate).toHaveBeenCalledWith(
    profile.id,
    'Keep approvals and simplify labels',
    { dir: '/project', branch: 'feature/current' },
    { workflowId: stored.id, mode: 'optimize' },
  );
  act(() =>
    useAppStore.setState({
      workflows: [
        {
          ...stored,
          definition: { ...stored.definition, name: 'New edit while drafting' },
        },
      ],
    }),
  );
  await user.click(screen.getByRole('button', { name: 'Apply reviewed changes' }));
  expect(await screen.findAllByText(/changed since this proposal/)).not.toHaveLength(0);
  expect((await backend.getWorkflow(stored.id))?.name).toBe('Existing workflow');
  act(() => useAppStore.setState({ workflows: [stored] }));
  await user.click(screen.getByRole('button', { name: 'Apply reviewed changes' }));
  await waitFor(async () =>
    expect((await backend.getWorkflow(stored.id))?.name).toBe('Reviewed improvement'),
  );
  expect(await backend.listWorkflows()).toHaveLength(initialWorkflowCount);
  expect(run).not.toHaveBeenCalled();
});

it('rechecks the assistance base after delayed missing-profile creation', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const original = createEmptyWorkflow('Original for delayed profile');
  const stored = await backend.saveWorkflow(original);
  const assistant = await backend.saveAgentProfile({
    ...createDefaultProfile('claude'),
    role: 'workflowAssistance',
  });
  const proposed = structuredClone(original);
  proposed.nodes.push({
    id: 'plan',
    type: 'agent',
    label: 'Plan',
    position: { x: 0, y: 0 },
    config: { agentRole: 'planning', prompt: 'Plan' },
  });
  vi.spyOn(backend, 'generateWorkflow').mockResolvedValue({
    generationId: 'delayed',
    proposalName: proposed.name,
    explanation: '',
    workflow: proposed,
    issues: [],
    unavailable: [],
    riskLabels: [],
    riskyNodes: [],
    blocking: ["Role 'planning' has no Agent Profile mapping."],
    repairs: [],
    setupNeeded: [],
    unmappedRoles: ['planning'],
  });
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    profiles: [assistant],
    overlayRunId: null,
    overlayWorkflow: null,
    validation: [],
  });
  render(<WorkflowsView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '✦ Assist' }));
  await user.click(screen.getByRole('button', { name: 'Preview improvements' }));
  await screen.findByRole('button', { name: 'Create 1 profile & accept' });
  const saveProfile = backend.saveAgentProfile.bind(backend);
  let completeProfile: (() => Promise<void>) | undefined;
  const delayed = vi.spyOn(backend, 'saveAgentProfile').mockImplementationOnce(
    (profile) =>
      new Promise((resolve) => {
        completeProfile = async () => resolve(await saveProfile(profile));
      }),
  );
  await user.click(screen.getByRole('button', { name: 'Create 1 profile & accept' }));
  await waitFor(() => expect(delayed).toHaveBeenCalledOnce());
  const edited = {
    ...stored,
    definition: { ...stored.definition, name: 'Changed during profile setup' },
  };
  act(() => useAppStore.setState({ workflows: [edited] }));
  await act(async () => {
    await completeProfile?.();
  });
  expect(await screen.findAllByText(/changed since this proposal/)).not.toHaveLength(0);
  expect((await backend.getWorkflow(stored.id))?.definition.nodes).toHaveLength(
    original.nodes.length,
  );
  expect(
    useAppStore.getState().workflows.find((w) => w.id === stored.id)?.definition.name,
  ).toBe('Changed during profile setup');
});

it('replaces redundant editor Save with autosave feedback and a working retry', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const stored = await backend.saveWorkflow(createEmptyWorkflow('Autosaved header'));
  const actualSave = backend.saveWorkflow.bind(backend);
  const save = vi
    .spyOn(backend, 'saveWorkflow')
    .mockRejectedValue(new Error('Disk temporarily unavailable'));
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    profiles: [],
    overlayRunId: null,
    overlayWorkflow: null,
    validation: [],
    workflowSaveStates: {},
  });
  render(<WorkflowsView />);
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  act(() =>
    useAppStore
      .getState()
      .updateActiveWorkflow({ ...stored.definition, name: 'Retained draft' }),
  );
  expect(document.querySelector('.workflow-topbar')?.textContent).not.toContain('Saved');
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('Disk temporarily unavailable'),
  );
  save.mockImplementation(actualSave);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry save' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));
  expect((await backend.getWorkflow(stored.id))?.name).toBe('Retained draft');
});

it('flushes an editor draft before saving it as a template', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const stored = await backend.saveWorkflow(createEmptyWorkflow('Old saved name'));
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    profiles: [],
    overlayRunId: null,
    overlayWorkflow: null,
    validation: [],
    workflowSaveStates: {},
  });
  render(<WorkflowsView />);
  act(() =>
    useAppStore
      .getState()
      .updateActiveWorkflow({ ...stored.definition, name: 'Current edited name' }),
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Save as template' }));
  await user.click(screen.getByRole('button', { name: 'Save template' }));
  await waitFor(async () => expect((await backend.listTemplates()).user).toHaveLength(1));
  expect((await backend.listTemplates()).user[0]?.workflow.name).toBe(
    'Current edited name',
  );
});

async function saveAsTemplateWith(node: WorkflowNode): Promise<{
  backend: ReturnType<typeof __setMockBackendForTests>;
  user: ReturnType<typeof userEvent.setup>;
  issues: ValidationIssue[];
}> {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const workflow = createEmptyWorkflow('Template source');
  // Put the step between Start and End so it is the only thing unfinished.
  const [start, end] = [
    workflow.nodes.find((n) => n.type === 'start'),
    workflow.nodes.find((n) => n.type === 'end'),
  ];
  if (start === undefined || end === undefined) throw new Error('fixture');
  workflow.nodes.push(node);
  workflow.edges = [
    { id: 'in', source: start.id, target: node.id },
    { id: 'out', source: node.id, target: end.id },
  ];
  const stored = await backend.saveWorkflow(workflow);
  useAppStore.setState({
    workflows: [stored],
    activeWorkflowId: stored.id,
    profiles: [],
    overlayRunId: null,
    overlayWorkflow: null,
    validation: [],
    workflowSaveStates: {},
  });
  render(<WorkflowsView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Save as template' }));
  const issues = (await backend.validateWorkflow(workflow)).filter(
    (i) => i.severity === 'error',
  );
  return { backend, user, issues };
}

it('lists the setup a saved template will ask for, without blocking the save', async () => {
  const { backend, user, issues } = await saveAsTemplateWith({
    id: 'commit',
    type: 'git',
    label: 'Commit',
    position: { x: 0, y: 0 },
    config: { gitOp: { op: 'commit', message: 'x' } },
  });
  expect(issues.map((i) => i.code)).toEqual(['git-dir-required']);
  const list = await screen.findByRole('list', { name: 'Setup the template needs' });
  expect(list).toHaveTextContent(issues[0]?.message ?? 'missing');
  expect(
    screen.queryByRole('list', {
      name: 'Problems to fix before the template can be used',
    }),
  ).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Save template' }));
  await waitFor(async () => expect((await backend.listTemplates()).user).toHaveLength(1));
  expect(
    await screen.findByText(/Using it will first ask for 1 setup item\./),
  ).toBeInTheDocument();
});

it('says which problems Use template will refuse, apart from setup', async () => {
  const { backend, user, issues } = await saveAsTemplateWith({
    id: 'blank',
    type: 'command',
    label: 'Blank',
    position: { x: 0, y: 0 },
    config: {},
  });
  expect(issues.every((i) => !SETUP_ISSUE_CODES.includes(i.code))).toBe(true);
  const list = await screen.findByRole('list', {
    name: 'Problems to fix before the template can be used',
  });
  for (const issue of issues) expect(list).toHaveTextContent(issue.message);
  expect(screen.queryByRole('list', { name: 'Setup the template needs' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Save template' }));
  await waitFor(async () => expect((await backend.listTemplates()).user).toHaveLength(1));
  expect(
    await screen.findByText(/Use template refuses it until 1 problem is fixed/),
  ).toBeInTheDocument();
});
