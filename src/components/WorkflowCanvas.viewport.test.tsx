import { useEffect } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { createEmptyWorkflow } from '../lib/workflow';
import { useAppStore } from '../store';
import { WorkflowCanvas } from './WorkflowCanvas';
const { fit } = vi.hoisted(() => ({ fit: vi.fn().mockResolvedValue(true) }));
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  function Flow({
    onInit,
  }: {
    onInit: (instance: { fitView: typeof fit }) => void;
  }): React.JSX.Element {
    useEffect(() => onInit({ fitView: fit }), [onInit]);
    return <div />;
  }
  return { ...actual, ReactFlow: Flow };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it('fits after the final canvas synchronization instead of cancelling the pending fit', async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = next++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const workflow = createEmptyWorkflow('Fit');
  let changed = workflow;
  useAppStore.setState({
    updateActiveWorkflow: (wf) => {
      changed = wf;
    },
  });
  const { rerender } = render(<WorkflowCanvas workflow={workflow} />);
  await userEvent.setup().click(screen.getByRole('button', { name: '⤢ Arrange' }));
  rerender(<WorkflowCanvas workflow={changed} />);
  expect(fit).not.toHaveBeenCalled();
  await act(async () => {
    for (const callback of frames.values()) callback(0);
    await Promise.resolve();
  });
  expect(fit).toHaveBeenCalledWith(
    expect.objectContaining({ padding: 0.15, maxZoom: 1 }),
  );
});

it('opens a long arranged workflow at a readable zoom around its first steps', async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = next++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const wf = createEmptyWorkflow('Long fit');
  const start = wf.nodes[0];
  const end = wf.nodes[1];
  if (!start || !end) throw new Error('fixture');
  const steps = Array.from({ length: 24 }, (_, i) => ({
    id: 'step-' + String(i),
    type: 'command' as const,
    label: 'Step',
    position: { x: 0, y: 0 },
    config: { executable: 'echo' },
  }));
  wf.nodes.push(...steps);
  const order = [start, ...steps, end];
  wf.edges = order.slice(1).map((node, i) => ({
    id: 'edge-' + String(i),
    source: order[i]?.id ?? '',
    target: node.id,
  }));
  let changed = wf;
  useAppStore.setState({
    updateActiveWorkflow: (workflow) => {
      changed = workflow;
    },
  });
  const { rerender } = render(<WorkflowCanvas workflow={wf} />);
  await userEvent.setup().click(screen.getByRole('button', { name: '⤢ Arrange' }));
  rerender(<WorkflowCanvas workflow={changed} />);
  await act(async () => {
    for (const cb of frames.values()) cb(0);
    await Promise.resolve();
  });
  expect(fit).toHaveBeenCalledWith(
    expect.objectContaining({
      minZoom: 0.65,
    }),
  );
  const options = fit.mock.calls.at(-1)?.[0] as { nodes: { id: string }[] };
  expect(options.nodes).toEqual(
    expect.arrayContaining([{ id: start.id }, { id: 'step-0' }]),
  );
  expect(options.nodes).toHaveLength(6);
  expect(options.nodes).not.toContainEqual({ id: end.id });
});
