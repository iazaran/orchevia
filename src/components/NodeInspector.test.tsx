import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NodeInspector } from './NodeInspector';
import { useAppStore } from '../store';
import { __setMockBackendForTests } from '../lib/backend';
import { createEmptyWorkflow } from '../lib/workflow';

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
  expect(
    (await backend.getWorkflow(stored.id))?.definition.nodes.find(
      (n) => n.id === 'condition',
    )?.config.condition?.clauses[0]?.right,
  ).toBe('P1');
});
