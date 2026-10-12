import { useEffect } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { createEmptyWorkflow } from '../lib/workflow';
import { useAppStore } from '../store';
import { WorkflowCanvas } from './WorkflowCanvas';
import type { Node, NodeChange } from '@xyflow/react';
const { fit, viewport, flow } = vi.hoisted(() => ({
  fit: vi.fn().mockResolvedValue(true),
  viewport: vi.fn().mockResolvedValue(true),
  flow: {
    current: null as null | {
      nodes: Node[];
      onNodesChange: (changes: NodeChange[]) => void;
      onNodeDragStop: (event: unknown, node: Node, nodes: Node[]) => void;
    },
  },
}));
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  function Flow({
    onInit,
    ...props
  }: {
    onInit: (instance: { fitView: typeof fit; setViewport: typeof viewport }) => void;
    nodes: Node[];
    onNodesChange: (changes: NodeChange[]) => void;
    onNodeDragStop: (event: unknown, node: Node, nodes: Node[]) => void;
  }): React.JSX.Element {
    flow.current = props;
    useEffect(() => onInit({ fitView: fit, setViewport: viewport }), [onInit]);
    return <div />;
  }
  return { ...actual, ReactFlow: Flow };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.restoreAllMocks();
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

it('arranging a large workflow fits the whole graph instead of the first steps', async () => {
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
    expect.objectContaining({ padding: 0.15, maxZoom: 1 }),
  );
  // The whole graph fits: no six-node subset restricts the view.
  const options = fit.mock.calls.at(-1)?.[0] as { nodes?: { id: string }[] };
  expect(options.nodes).toBeUndefined();
});

it('persists positions for every node in a group drag', () => {
  const workflow = createEmptyWorkflow('Group drag');
  const update = vi.fn();
  useAppStore.setState({ updateActiveWorkflow: update });
  render(<WorkflowCanvas workflow={workflow} />);
  const props = flow.current;
  if (!props) throw new Error('fixture');
  const moved = props.nodes.map((node, i) => ({
    ...node,
    position: { x: 400 + i * 40, y: 500 + i * 40 },
  }));
  const first = moved[0];
  if (!first) throw new Error('fixture');
  act(() => props.onNodeDragStop(null, first, moved));
  const changed = update.mock.calls[0]?.[0] as typeof workflow;
  expect(changed.nodes.map((node) => node.position)).toEqual(
    moved.map((node) => node.position),
  );
});

it('uses measured node bounds when arranging and preserves configuration', async () => {
  const workflow = createEmptyWorkflow('Measured arrangement');
  const update = vi.fn();
  useAppStore.setState({ updateActiveWorkflow: update });
  render(<WorkflowCanvas workflow={workflow} />);
  const props = flow.current;
  if (!props) throw new Error('fixture');
  act(() =>
    props.onNodesChange(
      props.nodes.map((node) => ({
        type: 'dimensions' as const,
        id: node.id,
        dimensions: { width: 600, height: 350 },
      })),
    ),
  );
  await userEvent.setup().click(screen.getByRole('button', { name: '⤢ Arrange' }));
  const changed = update.mock.calls[0]?.[0] as typeof workflow;
  expect(
    changed.nodes[1]!.position.y - changed.nodes[0]!.position.y,
  ).toBeGreaterThanOrEqual(450);
  expect(changed.nodes.map((node) => node.config)).toEqual(
    workflow.nodes.map((node) => node.config),
  );
});

it('opens workflows without a saved viewport with a centered fit', async () => {
  const rectangle = new DOMRect(0, 0, 1000, 140);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('canvas-toolbar')
      ? rectangle
      : new DOMRect(0, 0, 1000, 800);
  });
  const workflow = createEmptyWorkflow('Toolbar clearance');
  workflow.nodes.push(
    ...Array.from({ length: 13 }, (_, i) => ({
      id: 'node-' + String(i),
      type: 'command' as const,
      position: { x: 80, y: 100 + i * 180 },
      config: { executable: 'echo' },
    })),
  );
  useAppStore.setState({ updateActiveWorkflow: vi.fn() });
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  render(<WorkflowCanvas workflow={workflow} />);
  // No saved viewport: centered fit (also for large graphs), never a stale offset.
  const props = flow.current as unknown as {
    fitView: boolean;
    defaultViewport?: unknown;
  };
  expect(props.fitView).toBe(true);
  expect(props.defaultViewport).toBeUndefined();
  expect(viewport).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole('button', { name: '⤢ Arrange' }));
  await act(async () => {
    for (const callback of callbacks) callback(0);
    await Promise.resolve();
  });
  const arranged = fit.mock.calls.at(-1)?.[0] as { padding: { top: string } };
  expect(arranged.padding.top).toBe('172px');
});

it('restores each workflow viewport and falls back to fit on corrupt storage', () => {
  const key = 'orchevia.canvasViewport.v1';
  localStorage.removeItem(key);
  const first = createEmptyWorkflow('Viewport A');
  const second = createEmptyWorkflow('Viewport B');
  useAppStore.setState({ updateActiveWorkflow: vi.fn() });
  const firstRender = render(<WorkflowCanvas workflow={first} />);
  // Pan/zoom persists under the workflow's own id.
  const props = flow.current as unknown as {
    onMoveEnd?: (
      event: unknown,
      viewport: { x: number; y: number; zoom: number },
    ) => void;
  };
  act(() => props.onMoveEnd?.({}, { x: 111, y: 222, zoom: 1.2 }));
  const stored = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
  expect(stored[first.id]).toEqual({ x: 111, y: 222, zoom: 1.2 });
  // Workflow B starts centered; A's viewport never leaks into it.
  const secondRender = render(<WorkflowCanvas workflow={second} />);
  const secondProps = flow.current as unknown as {
    fitView: boolean;
    defaultViewport?: unknown;
  };
  expect(secondProps.fitView).toBe(true);
  expect(secondProps.defaultViewport).toBeUndefined();
  // Returning to A restores its viewport instead of fitting.
  firstRender.unmount();
  secondRender.unmount();
  render(<WorkflowCanvas workflow={first} />);
  const restored = flow.current as unknown as {
    fitView: boolean;
    defaultViewport?: { x: number; y: number; zoom: number };
  };
  expect(restored.fitView).toBe(false);
  expect(restored.defaultViewport).toEqual({ x: 111, y: 222, zoom: 1.2 });
  // Corrupt, out-of-range and non-finite viewports fall back safely.
  for (const corrupt of [
    'not-json{',
    JSON.stringify({ [first.id]: { x: 1, y: 2, zoom: 99 } }),
    JSON.stringify({ [first.id]: { x: Number.NaN, y: 0, zoom: 1 } }),
    JSON.stringify({ [first.id]: null }),
  ]) {
    localStorage.setItem(key, corrupt);
    const { unmount } = render(<WorkflowCanvas workflow={first} />);
    const fallback = flow.current as unknown as { fitView: boolean };
    expect(fallback.fitView).toBe(true);
    unmount();
  }
  localStorage.removeItem(key);
});

it('keeps run snapshots out of the editor viewport and fits empty graphs safely', () => {
  const key = 'orchevia.canvasViewport.v1';
  localStorage.removeItem(key);
  const workflow = createEmptyWorkflow('Snapshot isolation');
  useAppStore.setState({ updateActiveWorkflow: vi.fn() });
  render(<WorkflowCanvas workflow={workflow} readOnly />);
  const props = flow.current as unknown as {
    fitView: boolean;
    defaultViewport?: unknown;
    onMoveEnd?: (
      event: unknown,
      viewport: { x: number; y: number; zoom: number },
    ) => void;
  };
  // Snapshots always open centered and never persist back.
  expect(props.fitView).toBe(true);
  expect(props.defaultViewport).toBeUndefined();
  act(() => props.onMoveEnd?.({}, { x: 5, y: 5, zoom: 1 }));
  expect(localStorage.getItem(key)).toBeNull();
  // Empty graphs mount without fitting or crashing.
  const empty = createEmptyWorkflow('Empty');
  empty.nodes = [];
  empty.edges = [];
  render(<WorkflowCanvas workflow={empty} />);
  const emptyProps = flow.current as unknown as { fitView: boolean };
  expect(emptyProps.fitView).toBe(false);
  localStorage.removeItem(key);
});
