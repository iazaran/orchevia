import { expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkflowsView } from './WorkflowsView';
import { __setMockBackendForTests } from '../lib/backend';
import { createEmptyWorkflow } from '../lib/workflow';
import { useAppStore } from '../store';
vi.mock('./WorkflowCanvas', () => ({ WorkflowCanvas: () => null }));
vi.mock('./NodeInspector', () => ({ NodeInspector: () => null }));

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
