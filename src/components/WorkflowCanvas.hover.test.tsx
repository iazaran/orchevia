import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createEmptyWorkflow } from '../lib/workflow';
import { useAppStore } from '../store';
import { OrcheviaFlowNode } from './FlowNode';
import { WorkflowCanvas } from './WorkflowCanvas';
import type { Edge, Node } from '@xyflow/react';
import { ReactFlowProvider } from '@xyflow/react';

const { flow } = vi.hoisted(() => ({
  flow: {
    current: null as null | {
      nodes: Node[];
      edges: Edge[];
      onNodeMouseEnter?: (event: unknown, node: { id: string }) => void;
      onNodeMouseLeave?: () => void;
      onNodesDelete?: (deleted: { id: string }[]) => void;
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
    onNodesDelete?: (deleted: { id: string }[]) => void;
  }): React.JSX.Element {
    flow.current = props;
    return <div />;
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
  act(() => flow.current?.onNodesDelete?.([{ id: 'middle' }]));
  expect(edges().filter((e) => e.className === 'edge-connected')).toHaveLength(0);
});

it('reports keyboard focus and blur through the node for the same highlight', () => {
  const onHover = vi.fn();
  const { container } = render(
    <ReactFlowProvider>
      <OrcheviaFlowNode
        id="middle"
        data={{
          label: 'Middle',
          kind: 'command',
          detail: 'echo',
          selected: false,
          onHover,
        }}
        type="orchevia"
        selected={false}
        isConnectable={false}
        zIndex={0}
        dragging={false}
        selectable={false}
        deletable={false}
        draggable={false}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
      ,
    </ReactFlowProvider>,
  );
  const inner = container.firstElementChild;
  if (!inner) throw new Error('node missing');
  fireEvent.focus(inner);
  expect(onHover).toHaveBeenLastCalledWith('middle');
  fireEvent.blur(inner);
  expect(onHover).toHaveBeenLastCalledWith(null);
});
