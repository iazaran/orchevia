import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { getBackend } from '../lib/backend';
import { renderCondition } from '../lib/conditions';
import {
  NODE_KIND_META,
  arrangeWorkflowPositions,
  bypassedEdgeIds,
  newId,
  nextBranchLabel,
  type NodeKind,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
} from '../lib/workflow';
import { useAppStore } from '../store';
import { OrcheviaFlowNode, type CanvasNodeData } from './FlowNode';

const nodeTypes = { orchevia: OrcheviaFlowNode };

function nodeDetail(n: WorkflowNode): string {
  if (n.type === 'command') {
    const exe = n.config.executable ?? '';
    const args = (n.config.args ?? []).join(' ');
    return `${exe} ${args}`.trim();
  }
  if (n.type === 'approval') return n.config.message ?? 'Approval required';
  if (n.type === 'agent') {
    const prompt = (n.config.prompt ?? '').split('\n')[0] ?? '';
    return prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
  }
  if (n.type === 'condition' && n.config.condition !== undefined) {
    try {
      return renderCondition(n.config.condition);
    } catch {
      return 'Invalid condition';
    }
  }
  if (n.type === 'git') return describeGitOp(n.config.gitOp);
  if (n.type === 'github') return describeGitHubOp(n.config.githubOp);
  if (n.type === 'ticket') return (n.config.ticketKey ?? '').split('\n')[0] ?? '';
  if (n.type === 'mcp') return (n.config.mcpTool ?? '').split('\n')[0] ?? '';
  return '';
}

function describeGitOp(op: WorkflowNode['config']['gitOp']): string {
  if (op === undefined) return 'No operation';
  switch (op.op) {
    case 'status':
      return 'git status';
    case 'diffSummary':
      return 'git diff summary';
    case 'branchCreate':
      return `branch ${op.name}`;
    case 'checkout':
      return `checkout ${op.name}`;
    case 'stage':
      return `stage ${(op.paths ?? []).join(' ')}`;
    case 'commit':
      return 'commit staged';
    case 'worktreeAdd':
      return `worktree ${op.path}`;
    case 'worktreeRemove':
      return `remove worktree`;
    case 'worktreeList':
      return 'list worktrees';
    case 'remotes':
      return 'list remotes';
  }
}

function describeGitHubOp(op: WorkflowNode['config']['githubOp']): string {
  if (op === undefined) return 'No operation';
  switch (op.op) {
    case 'prStatus':
      return 'PR for branch';
    case 'listPrs':
      return `list PRs (${op.state ?? 'open'})`;
    case 'prDetails':
      return `PR #${String(op.number)}`;
    case 'prFiles':
      return `PR #${String(op.number)} files`;
    case 'prChecks':
      return `PR #${String(op.number)} checks`;
    case 'createPr':
      return `${op.draft === true ? 'draft ' : ''}PR ${op.head} → ${op.base}`;
    case 'postComment':
      return `comment on #${String(op.number)}`;
  }
}

function toFlowNodes(
  wf: Workflow,
  selectedId: string | null,
  overlay: Record<string, string>,
  issues: Record<string, 'error' | 'warning'>,
): Node<CanvasNodeData>[] {
  return wf.nodes.map((n: WorkflowNode) => ({
    id: n.id,
    type: 'orchevia',
    position: n.position,
    data: {
      label: n.label ?? NODE_KIND_META[n.type].label,
      kind: n.type,
      detail: nodeDetail(n),
      selected: n.id === selectedId,
      runStatus: overlay[n.id],
      issueSeverity: issues[n.id],
    },
  }));
}

function toFlowEdges(wf: Workflow, selectedEdgeId: string | null): Edge[] {
  return wf.edges.map((e: WorkflowEdge) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    selected: e.id === selectedEdgeId,
  }));
}

const ADDABLE: NodeKind[] = [
  'command',
  'agent',
  'condition',
  'git',
  'github',
  'ticket',
  'mcp',
  'approval',
];

export function WorkflowCanvas({
  workflow,
  readOnly = false,
}: {
  workflow: Workflow;
  readOnly?: boolean;
}): React.JSX.Element {
  const [layoutDirection, setLayoutDirection] = useState<'vertical' | 'horizontal'>(
    'vertical',
  );
  const [appliedDirection, setAppliedDirection] = useState<'vertical' | 'horizontal'>(
    'vertical',
  );
  const needsFit = useRef(false);
  const fitFrame = useRef<number | null>(null);
  const selectedNodeId = useAppStore((s) => s.selectedNodeId);
  const selectNode = useAppStore((s) => s.selectNode);
  const selectedEdgeId = useAppStore((s) => s.selectedEdgeId);
  const selectEdge = useAppStore((s) => s.selectEdge);
  const updateActiveWorkflow = useAppStore((s) => s.updateActiveWorkflow);
  const setValidation = useAppStore((s) => s.setValidation);
  const validation = useAppStore((s) => s.validation);
  const overlayResults = useAppStore((s) => s.overlayResults);
  const profiles = useAppStore((s) => s.profiles);

  // React Flow instance + wrapper size for viewport-aware placement
  // (new nodes land in the center of the current view, not at a fixed spot).
  const flowInstance = useRef<ReactFlowInstance<Node<CanvasNodeData>> | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const firstNode =
    workflow.nodes.find((node) => node.type === 'start') ?? workflow.nodes[0];
  const initialZoom = 0.85;
  const largeGraphViewport = {
    x: 24 - (firstNode?.position.x ?? 0) * initialZoom,
    y: 110 - (firstNode?.position.y ?? 0) * initialZoom,
    zoom: initialZoom,
  };

  const overlay: Record<string, string> = {};
  for (const r of overlayResults) {
    // Latest row per node wins (retries/loops record multiple rows).
    overlay[r.nodeId] = r.status;
  }
  const issues: Record<string, 'error' | 'warning'> = {};
  for (const issue of validation) {
    if (issue.nodeId !== undefined && issues[issue.nodeId] !== 'error') {
      issues[issue.nodeId] = issue.severity;
    }
  }

  // NOTE: parent remounts this component per workflow (`key={workflow.id}`),
  // so initializing canvas state from the workflow is safe here.
  const [nodes, setNodes, onNodesChange] = useNodesState(
    toFlowNodes(workflow, selectedNodeId, overlay, issues),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(
    toFlowEdges(workflow, selectedEdgeId),
  );

  const previousDefinition = useRef(workflow.nodes);

  // Reconcile external JSON/inspector edits while retaining transient drag positions.
  useEffect(() => {
    const prior = previousDefinition.current;
    previousDefinition.current = workflow.nodes;
    setNodes((current) => {
      const known = new Map(current.map((n) => [n.id, n]));
      return workflow.nodes.map((def) => {
        const existing = known.get(def.id);
        const oldDefinition = prior.find((n) => n.id === def.id);
        const moved =
          oldDefinition?.position.x !== def.position.x ||
          oldDefinition.position.y !== def.position.y;
        return {
          ...existing,
          id: def.id,
          type: 'orchevia',
          position: moved ? def.position : (existing?.position ?? def.position),
          data: {
            direction: appliedDirection,
            label: def.label ?? NODE_KIND_META[def.type].label,
            kind: def.type,
            detail: nodeDetail(def),
            selected: def.id === selectedNodeId,
            runStatus: overlay[def.id],
            issueSeverity: issues[def.id],
          },
        };
      });
    });
    setEdges(toFlowEdges(workflow, selectedEdgeId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workflow.nodes,
    workflow.edges,
    selectedNodeId,
    selectedEdgeId,
    overlayResults,
    validation,
    appliedDirection,
  ]);

  const revalidate = useCallback(
    (updated: Workflow) => {
      void getBackend()
        .validateWorkflow(updated)
        .then(setValidation)
        .catch(() => {});
    },
    [setValidation],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (readOnly) return;
      const source = connection.source;
      const target = connection.target;
      if (source === '' || target === '') return;
      // Drop duplicates and lines the new connection bypasses (inserting a
      // node between two linked nodes removes the old direct line).
      const smart = bypassedEdgeIds(workflow.edges, source, target);
      if (smart.dropNew) return;
      // Condition outputs need true/false labels: auto-assign them so a fresh
      // branch validates immediately (first edge → true, second → false).
      // Click the edge afterwards to swap or clear the label.
      let label: string | undefined;
      const sourceNode = workflow.nodes.find((n) => n.id === source);
      if (sourceNode?.type === 'condition') {
        const outs = workflow.edges.filter((e) => e.source === source);
        label = nextBranchLabel(outs.map((e) => e.label));
      }
      const edge: Edge = {
        id: newId('edge'),
        source,
        target,
        ...(label === undefined ? {} : { label }),
      };
      const removed = new Set(smart.removeIds);
      setEdges((current) => [...current.filter((e) => !removed.has(e.id)), edge]);
      const updated: Workflow = {
        ...workflow,
        edges: [
          ...workflow.edges.filter((e) => !removed.has(e.id)),
          {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            ...(label === undefined ? {} : { label }),
          },
        ],
      };
      updateActiveWorkflow(updated);
      revalidate(updated);
    },
    [workflow, updateActiveWorkflow, setEdges, revalidate, readOnly],
  );

  const defaultAgentProfile = useCallback((): string | null => {
    const impl = profiles.find((p) => p.role === 'implementation');
    return impl?.id ?? profiles[0]?.id ?? null;
  }, [profiles]);

  const addNode = useCallback(
    (kind: NodeKind) => {
      const id = newId('node');
      // New boxes appear in the center of the current view (pan/zoom aware),
      // with a small cascade so rapid adds don't stack exactly.
      const rect = wrapRef.current?.getBoundingClientRect();
      const cascade = (nodes.length % 5) * 24;
      const center = (() => {
        if (flowInstance.current !== null && rect !== undefined) {
          return flowInstance.current.screenToFlowPosition({
            x: rect.width / 2 + cascade,
            y: rect.height / 2 + cascade,
          });
        }
        return { x: 260 + cascade, y: 120 + cascade };
      })();
      const detailDefault =
        kind === 'command'
          ? 'echo hello'
          : kind === 'agent'
            ? 'AI Agent prompt'
            : kind === 'condition'
              ? 'Condition branches'
              : NODE_KIND_META[kind].label;
      const flowNode: Node<CanvasNodeData> = {
        id,
        type: 'orchevia',
        position: center,
        data: {
          label: NODE_KIND_META[kind].label,
          kind,
          detail: detailDefault,
          selected: true,
        },
      };
      const wfNode: WorkflowNode = {
        id,
        type: kind,
        position: { ...flowNode.position },
        config:
          kind === 'command'
            ? { executable: 'echo', args: ['hello'] }
            : kind === 'agent'
              ? {
                  // Pre-select a profile so a fresh node does not error: prefer
                  // the implementation role, else the first profile. With no
                  // profiles at all the (correct) error remains.
                  ...(defaultAgentProfile() === null
                    ? {}
                    : { agentProfileId: defaultAgentProfile() as string }),
                  prompt:
                    'Describe the task for the local AI agent. Use {{workflow.name}} and {{node.<id>.output}} variables.',
                }
              : kind === 'condition'
                ? {
                    condition: {
                      logic: 'or',
                      clauses: [{ left: '', op: 'contains', right: 'P0' }],
                    },
                  }
                : kind === 'git'
                  ? { gitOp: { op: 'status' } }
                  : kind === 'github'
                    ? { githubOp: { op: 'prStatus' } }
                    : kind === 'ticket'
                      ? { ticketKey: '{{input.ticket}}' }
                      : kind === 'mcp'
                        ? { mcpTool: '' }
                        : {},
        label: NODE_KIND_META[kind].label,
      };
      const updated: Workflow = { ...workflow, nodes: [...workflow.nodes, wfNode] };
      setNodes((current) => [...current, flowNode]);
      updateActiveWorkflow(updated);
      selectNode(id);
      revalidate(updated);
    },
    [
      nodes.length,
      workflow,
      updateActiveWorkflow,
      setNodes,
      selectNode,
      revalidate,
      defaultAgentProfile,
    ],
  );

  const arrangeNodes = useCallback(() => {
    const positions = arrangeWorkflowPositions(workflow.nodes, workflow.edges, {
      direction: layoutDirection,
      sizes: Object.fromEntries(
        nodes.map((n) => [
          n.id,
          { width: n.measured?.width ?? 240, height: n.measured?.height ?? 100 },
        ]),
      ),
    });
    needsFit.current = true;
    setAppliedDirection(layoutDirection);
    setNodes((current) =>
      current.map((n) => ({
        ...n,
        position: positions[n.id] ?? n.position,
        data: { ...n.data, direction: layoutDirection },
      })),
    );
    updateActiveWorkflow({
      ...workflow,
      nodes: workflow.nodes.map((n) => ({
        ...n,
        position: positions[n.id] ?? { ...n.position },
      })),
    });
    // Positions don't affect validation, but re-fit so the result is visible.
  }, [workflow, nodes, layoutDirection, setNodes, updateActiveWorkflow]);
  useEffect(() => {
    if (!needsFit.current) return;
    if (fitFrame.current !== null) cancelAnimationFrame(fitFrame.current);
    fitFrame.current = requestAnimationFrame(() => {
      fitFrame.current = null;
      void flowInstance.current
        ?.fitView({
          padding: 0.15,
          maxZoom: 1,
          duration: 200,
          ...(nodes.length > 12
            ? {
                minZoom: 0.65,
                nodes: [...nodes]
                  .sort((a, b) =>
                    appliedDirection === 'vertical'
                      ? a.position.y - b.position.y || a.position.x - b.position.x
                      : a.position.x - b.position.x || a.position.y - b.position.y,
                  )
                  .slice(0, 6)
                  .map((n) => ({ id: n.id })),
              }
            : {}),
        })
        .then((fitted) => {
          if (fitted) needsFit.current = false;
        });
    });
  }, [nodes, appliedDirection]);
  useEffect(
    () => () => {
      if (fitFrame.current !== null) cancelAnimationFrame(fitFrame.current);
    },
    [],
  );

  const duplicateSelected = useCallback(() => {
    const def = workflow.nodes.find((n) => n.id === selectedNodeId);
    if (def === undefined) return;
    const id = newId('node');
    const copy: WorkflowNode = {
      ...def,
      id,
      position: { x: def.position.x + 40, y: def.position.y + 40 },
      label: `${def.label ?? NODE_KIND_META[def.type].label} copy`,
      config: JSON.parse(JSON.stringify(def.config)) as WorkflowNode['config'],
    };
    const updated: Workflow = { ...workflow, nodes: [...workflow.nodes, copy] };
    setNodes((current) => [
      ...current,
      {
        id,
        type: 'orchevia',
        position: { ...copy.position },
        data: {
          label: copy.label ?? '',
          kind: copy.type,
          detail: nodeDetail(copy),
          selected: true,
        },
      },
    ]);
    updateActiveWorkflow(updated);
    selectNode(id);
    revalidate(updated);
  }, [workflow, selectedNodeId, setNodes, updateActiveWorkflow, selectNode, revalidate]);

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <fieldset
        disabled={readOnly}
        className="canvas-toolbar"
        style={{ border: 0, margin: 0 }}
        role="toolbar"
        aria-label="Add nodes"
      >
        {ADDABLE.map((kind) => (
          <button key={kind} className="tool-chip" onClick={() => void addNode(kind)}>
            + {NODE_KIND_META[kind].label}
          </button>
        ))}
        <button
          className="tool-chip"
          onClick={duplicateSelected}
          disabled={selectedNodeId === null}
          title="Duplicate the selected node"
        >
          ⧉ Duplicate
        </button>
        <select
          aria-label="Arrange direction"
          className="select"
          style={{ width: 'auto' }}
          value={layoutDirection}
          onChange={(e) =>
            setLayoutDirection(
              e.target.value === 'horizontal' ? 'horizontal' : 'vertical',
            )
          }
        >
          <option value="vertical">Top to bottom</option>
          <option value="horizontal">Left to right</option>
        </select>
        <button
          className="tool-chip"
          onClick={arrangeNodes}
          disabled={workflow.nodes.length === 0}
          title="Auto-arrange: layered layout following the connections"
        >
          ⤢ Arrange
        </button>
        <span className="field-hint" style={{ alignSelf: 'center' }}>
          {nodes.length > 12 && (
            <>Large graph: pan or use the minimap to follow later steps. </>
          )}
          Drag from the bottom dot to connect · condition branches auto-label true/false ·
          click an edge to relabel · Del removes selection
        </span>
      </fieldset>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onInit={(instance) => {
          flowInstance.current = instance;
        }}
        onNodesChange={(changes) =>
          onNodesChange(
            readOnly
              ? changes.filter((c) => c.type === 'dimensions' || c.type === 'select')
              : changes,
          )
        }
        onEdgesChange={(changes) =>
          onEdgesChange(readOnly ? changes.filter((c) => c.type === 'select') : changes)
        }
        onConnect={onConnect}
        onNodeClick={(_, node) => {
          selectNode(node.id);
        }}
        onEdgeClick={(_, edge) => {
          selectEdge(edge.id);
        }}
        onPaneClick={() => {
          selectNode(null);
        }}
        onNodesDelete={(deleted) => {
          if (readOnly) return;
          const ids = new Set(deleted.map((d) => d.id));
          const updated: Workflow = {
            ...workflow,
            nodes: workflow.nodes.filter((n) => !ids.has(n.id)),
            edges: workflow.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
          };
          updateActiveWorkflow(updated);
          revalidate(updated);
          if (selectedNodeId !== null && ids.has(selectedNodeId)) selectNode(null);
        }}
        onEdgesDelete={(deleted) => {
          if (readOnly) return;
          const ids = new Set(deleted.map((d) => d.id));
          const updated: Workflow = {
            ...workflow,
            edges: workflow.edges.filter((e) => !ids.has(e.id)),
          };
          updateActiveWorkflow(updated);
          revalidate(updated);
        }}
        onNodeDragStop={(_, node) => {
          if (readOnly) return;
          updateActiveWorkflow({
            ...workflow,
            nodes: workflow.nodes.map((n) =>
              n.id === node.id
                ? { ...n, position: { x: node.position.x, y: node.position.y } }
                : n,
            ),
          });
        }}
        nodeTypes={nodeTypes}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        edgesReconnectable={!readOnly}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        defaultEdgeOptions={{ interactionWidth: 32 }}
        connectionRadius={32}
        fitView={workflow.nodes.length <= 10}
        defaultViewport={largeGraphViewport}
        fitViewOptions={{ padding: 0.15, maxZoom: 1, duration: 0 }}
        minZoom={0.3}
        colorMode="system"
        attributionPosition="bottom-right"
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
