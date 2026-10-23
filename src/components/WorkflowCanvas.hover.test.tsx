import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createEmptyWorkflow } from '../lib/workflow';
import { useAppStore } from '../store';
import { WorkflowCanvas } from './WorkflowCanvas';
import type { Edge, Node } from '@xyflow/react';

const { flow } = vi.hoisted(() => ({
  flow: {
    current: null as null | {
      nodes: Node[];
      edges: Edge[];
      onNodeMouseEnter?: (event: unknown, node: { id: string }) => void;
      onNodeMouseLeave?: () => void;
      onDelete?: (deleted: { nodes: { id: string }[]; edges: { id: string }[] }) => void;
      onBeforeDelete?: (doomed: {
        nodes: { id: string }[];
        edges: { id: string; source: string; target: string; selected?: boolean }[];
      }) => Promise<boolean | { nodes: { id: string }[]; edges: { id: string }[] }>;
    },
  },
}));

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  function Flow(props: {
    nodes: Node[];
    edges: Edge[];
    onNodeMouseEnter?: (event: unknown, node: { id: string }) => void;
    onNodeMouseLeave?: () => void;
    onDelete?: (deleted: { nodes: { id: string }[]; edges: { id: string }[] }) => void;
    onBeforeDelete?: (doomed: {
      nodes: { id: string }[];
      edges: { id: string; source: string; target: string; selected?: boolean }[];
    }) => Promise<boolean | { nodes: { id: string }[]; edges: { id: string }[] }>;
  }): React.JSX.Element {
    flow.current = props;
    // React Flow puts keyboard focus on a wrapper outside the custom node.
    return (
      <div>
        {props.nodes.map((node) => (
          <div key={node.id} className="react-flow__node" data-id={node.id} tabIndex={0}>
            <div className="orchevia-node">{node.id}</div>
          </div>
        ))}
      </div>
    );
  }
  return { ...actual, ReactFlow: Flow };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function hoverWorkflow(): ReturnType<typeof createEmptyWorkflow> {
  const wf = createEmptyWorkflow('Hover');
  const start = wf.nodes[0]?.id ?? '';
  const end = wf.nodes[1]?.id ?? '';
  wf.nodes.push({
    id: 'middle',
    type: 'command',
    label: 'Middle',
    position: { x: 200, y: 200 },
    config: { executable: 'echo' },
  });
  wf.edges = [
    { id: 'e-start', source: start, target: 'middle' },
    { id: 'e-end', source: 'middle', target: end },
  ];
  return wf;
}

function edges(): Edge[] {
  const props = flow.current;
  if (!props) throw new Error('canvas props missing');
  return props.edges;
}

it('highlights incoming and outgoing edges on hover and restores on exit', () => {
  useAppStore.setState({
    selectedNodeId: null,
    selectedEdgeId: null,
    validation: [],
    overlayResults: [],
    profiles: [],
    updateActiveWorkflow: vi.fn(),
  });
  render(<WorkflowCanvas workflow={hoverWorkflow()} />);
  expect(edges().filter((e) => e.className === 'edge-connected')).toHaveLength(0);
  act(() => flow.current?.onNodeMouseEnter?.({}, { id: 'middle' }));
  const highlighted = edges().filter((e) => e.className === 'edge-connected');
  expect(highlighted.map((e) => e.id).sort()).toEqual(['e-end', 'e-start']);
  act(() => flow.current?.onNodeMouseLeave?.());
  expect(edges().filter((e) => e.className === 'edge-connected')).toHaveLength(0);
});

it('composes the highlight with selection instead of overwriting it', () => {
  const wf = hoverWorkflow();
  useAppStore.setState({
    selectedNodeId: 'middle',
    selectedEdgeId: 'e-start',
    validation: [],
    overlayResults: [],
    profiles: [],
    updateActiveWorkflow: vi.fn(),
  });
  render(<WorkflowCanvas workflow={wf} />);
  act(() => flow.current?.onNodeMouseEnter?.({}, { id: 'middle' }));
  const start = edges().find((e) => e.id === 'e-start');
  expect(start?.selected).toBe(true);
  expect(start?.className).toBe('edge-connected');
  // The unrelated edge keeps its label and gains no highlight.
  const end = edges().find((e) => e.id === 'e-end');
  expect(end?.label).toBeUndefined();
  expect(end?.className).toBe('edge-connected');
  act(() => flow.current?.onNodeMouseLeave?.());
  expect(edges().find((e) => e.id === 'e-start')?.selected).toBe(true);
  expect(edges().find((e) => e.id === 'e-start')?.className).toBeUndefined();
});

it('clears a stale hover after the hovered node is deleted', () => {
  const select = vi.fn();
  useAppStore.setState({
    selectedNodeId: null,
    selectedEdgeId: null,
    validation: [],
    overlayResults: [],
    profiles: [],
    updateActiveWorkflow: vi.fn(),
    selectNode: select,
  });
  const wf = hoverWorkflow();
  render(<WorkflowCanvas workflow={wf} />);
  act(() => flow.current?.onNodeMouseEnter?.({}, { id: 'middle' }));
  expect(edges().filter((e) => e.className === 'edge-connected')).toHaveLength(2);
  act(() => flow.current?.onDelete?.({ nodes: [{ id: 'middle' }], edges: [] }));
  expect(edges().filter((e) => e.className === 'edge-connected')).toHaveLength(0);
});

it.each([false, true])(
  'highlights the focused node wrapper in readOnly=%s',
  (readOnly) => {
    useAppStore.setState({
      selectedNodeId: null,
      selectedEdgeId: null,
      validation: [],
      overlayResults: [],
      profiles: [],
      updateActiveWorkflow: vi.fn(),
    });
    const { container } = render(
      <WorkflowCanvas workflow={hoverWorkflow()} readOnly={readOnly} />,
    );
    const wrapper = container.querySelector('.react-flow__node[data-id="middle"]');
    if (!wrapper) throw new Error('node wrapper missing');
    fireEvent.focus(wrapper);
    expect(
      edges()
        .filter((e) => e.className === 'edge-connected')
        .map((e) => e.id)
        .sort(),
    ).toEqual(['e-end', 'e-start']);
    // Pointer exit does not discard a keyboard-focused node's highlight.
    act(() => flow.current?.onNodeMouseLeave?.());
    expect(edges().filter((e) => e.className === 'edge-connected')).toHaveLength(2);
    fireEvent.blur(wrapper);
    expect(edges().filter((e) => e.className === 'edge-connected')).toHaveLength(0);
  },
);

it('keeps the only Start and End and deletes a step with an edge in one update', () => {
  const update = vi.fn();
  useAppStore.setState({
    selectedNodeId: null,
    selectedEdgeId: null,
    validation: [],
    overlayResults: [],
    profiles: [],
    updateActiveWorkflow: update,
  });
  const wf = hoverWorkflow();
  wf.nodes.push({
    id: 'review',
    type: 'agent',
    label: 'Review',
    position: { x: 200, y: 300 },
    config: { prompt: 'Review', contextRefs: ['middle'], contextMaxChars: 4000 },
  });
  wf.edges.push({ id: 'e-review', source: wf.nodes[0]?.id ?? '', target: 'review' });
  render(<WorkflowCanvas workflow={wf} />);
  const deletable = Object.fromEntries(
    (flow.current?.nodes ?? []).map((node) => [node.id, node.deletable]),
  );
  const [start, end] = wf.nodes;
  expect(deletable[start?.id ?? '']).toBe(false);
  expect(deletable[end?.id ?? '']).toBe(false);
  expect(deletable.middle).toBe(true);
  // A step and an unrelated edge selected together both go, and the step
  // that read the deleted one's context forgets it.
  act(() =>
    flow.current?.onDelete?.({ nodes: [{ id: 'middle' }], edges: [{ id: 'e-review' }] }),
  );
  expect(update).toHaveBeenCalledTimes(1);
  const saved = update.mock.calls[0]?.[0] as typeof wf;
  expect(saved.nodes.map((n) => n.id)).not.toContain('middle');
  expect(saved.edges).toEqual([]);
  const review = saved.nodes.find((n) => n.id === 'review');
  expect(review?.config.contextRefs).toBeUndefined();
  expect(review?.config.contextMaxChars).toBeUndefined();
});

it('keeps one End when both Ends are selected for deletion', async () => {
  useAppStore.setState({
    selectedNodeId: null,
    selectedEdgeId: null,
    validation: [],
    overlayResults: [],
    profiles: [],
    updateActiveWorkflow: vi.fn(),
  });
  const wf = hoverWorkflow();
  const end = wf.nodes[1];
  if (end === undefined) throw new Error('missing end');
  wf.nodes.push({ ...end, id: 'end-2' });
  render(<WorkflowCanvas workflow={wf} />);
  const kept = await flow.current?.onBeforeDelete?.({
    nodes: [{ id: end.id }, { id: 'end-2' }],
    edges: [{ id: 'e-end', source: 'middle', target: end.id }],
  });
  expect(kept).toEqual({ nodes: [{ id: 'end-2' }], edges: [] });
});
