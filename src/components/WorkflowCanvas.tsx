import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import { readLocal, writeLocal } from '../lib/storage';
import {
  NODE_KIND_META,
  arrangeWorkflowPositions,
  bypassedEdgeIds,
  newId,
  nextBranchLabel,
  removeFromWorkflow,
  sparedAnchors,
  type NodeKind,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode,
} from '../lib/workflow';
import { useAppStore } from '../store';
import { SetupStatus } from './SetupStatus';
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
  const count = (kind: NodeKind): number =>
    wf.nodes.filter((n) => n.type === kind).length;
  const starts = count('start');
  const ends = count('end');
  return wf.nodes.map((n: WorkflowNode) => ({
    id: n.id,
    type: 'orchevia',
    position: n.position,
    // The toolbar cannot add Start or End, so the only one stays.
    deletable: !(
      (n.type === 'start' && starts === 1) ||
      (n.type === 'end' && ends === 1)
    ),
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

function toFlowEdges(
  wf: Workflow,
  selectedEdgeId: string | null,
  connected: ReadonlySet<string> | null,
): Edge[] {
  return wf.edges.map((e: WorkflowEdge) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    selected: e.id === selectedEdgeId,
    // Highlight directly connected edges on node hover/focus. Only the
    // stroke width and glow change: selection, edge labels, node accents
    // and run-status styling keep their own colors.
    ...(connected !== null && connected.has(e.id) ? { className: 'edge-connected' } : {}),
  }));
}

/** Per-workflow canvas viewport persistence (guarded localStorage map). */
const VIEWPORT_STORAGE_KEY = 'orchevia.canvasViewport.v1';
const VIEWPORT_MIN_ZOOM = 0.01;
const VIEWPORT_MAX_ZOOM = 2;

export interface SavedViewport {
  x: number;
  y: number;
  zoom: number;
}

function isValidViewport(value: unknown): value is SavedViewport {
  if (typeof value !== 'object' || value === null) return false;
  const viewport = value as Record<string, unknown>;
  return (
    typeof viewport.x === 'number' &&
    Number.isFinite(viewport.x) &&
    typeof viewport.y === 'number' &&
    Number.isFinite(viewport.y) &&
    typeof viewport.zoom === 'number' &&
    Number.isFinite(viewport.zoom) &&
    viewport.zoom >= VIEWPORT_MIN_ZOOM &&
    viewport.zoom <= VIEWPORT_MAX_ZOOM
  );
}

export function readWorkflowViewport(workflowId: string): SavedViewport | null {
  try {
    const raw = readLocal(VIEWPORT_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return null;
    const entry = (parsed as Record<string, unknown>)[workflowId];
    return isValidViewport(entry) ? entry : null;
  } catch {
    // Missing/corrupt/unavailable storage falls back to centered fit.
    return null;
  }
}

function writeWorkflowViewport(workflowId: string, viewport: SavedViewport): void {
  if (!isValidViewport(viewport)) return;
  const raw = readLocal(VIEWPORT_STORAGE_KEY);
  let map: Record<string, unknown> = {};
  try {
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
        map = parsed as Record<string, unknown>;
    }
  } catch {
    // Replace a corrupt map so future viewport changes can persist again.
  }
  map[workflowId] = viewport;
  writeLocal(VIEWPORT_STORAGE_KEY, JSON.stringify(map));
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
  const toolbarRef = useRef<HTMLFieldSetElement | null>(null);
  const [toolbarHeight, setToolbarHeight] = useState(0);
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

  // Connection highlighting: hovering or keyboard-focusing a node lights up
  // its directly incoming and outgoing edges. Cleared on exit, deletion and
  // workflow switch (remount); composed with selection and run-status styles.
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const highlightedNodeId = hoveredNodeId ?? focusedNodeId;
  const connectedEdgeIds = useMemo(() => {
    if (highlightedNodeId === null) return null;
    if (!workflow.nodes.some((n) => n.id === highlightedNodeId)) return null;
    const ids = new Set<string>();
    for (const edge of workflow.edges) {
      if (edge.source === highlightedNodeId || edge.target === highlightedNodeId)
        ids.add(edge.id);
    }
    return ids;
  }, [highlightedNodeId, workflow.nodes, workflow.edges]);

  // React Flow instance + wrapper size for viewport-aware placement
  // (new nodes land in the center of the current view, not at a fixed spot).
  const flowInstance = useRef<ReactFlowInstance<Node<CanvasNodeData>> | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const measure = (): void => setToolbarHeight(toolbar.getBoundingClientRect().height);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    return () => observer.disconnect();
  }, []);
  const fitPadding = useMemo(
    () =>
      toolbarHeight > 0
        ? {
            top: `${String(toolbarHeight + 32)}px` as `${number}px`,
            right: '32px' as const,
            bottom: '32px' as const,
            left: '32px' as const,
          }
        : 0.15,
    [toolbarHeight],
  );

  // Restored viewport for this editable workflow, read synchronously so the
  // first paint already sits where the user left it. Snapshots (readOnly run
  // overlays) never restore or overwrite the editor viewport.
  const savedViewport = useMemo(
    () => (readOnly ? null : readWorkflowViewport(workflow.id)),
    [readOnly, workflow.id],
  );

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
    toFlowEdges(workflow, selectedEdgeId, connectedEdgeIds),
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
    setEdges(toFlowEdges(workflow, selectedEdgeId, connectedEdgeIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workflow.nodes,
    workflow.edges,
    selectedNodeId,
    selectedEdgeId,
    overlayResults,
    validation,
    appliedDirection,
    connectedEdgeIds,
    readOnly,
  ]);

  const revalidate = useCallback(
    (updated: Workflow) => {
      void getBackend()
        .validateWorkflow(updated)
        .then((issues) => {
          const state = useAppStore.getState();
          if (
            state.activeWorkflowId === updated.id &&
            state.overlayRunId === null &&
            state.workflows.find((w) => w.id === updated.id)?.definition === updated
          )
            setValidation(issues);
        })
        .catch(() => {});
    },
    [setValidation],
  );

  // Open with the current setup status (shown quietly in the toolbar); edits
  // revalidate as they happen.
  const validatedOnOpen = useRef<string | null>(null);
  useEffect(() => {
    if (readOnly || validatedOnOpen.current === workflow.id) return;
    validatedOnOpen.current = workflow.id;
    revalidate(workflow);
  }, [readOnly, revalidate, workflow]);

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
  // Centered-fit fallback: fit the whole graph into the available view once
  // nodes are measured. This replaces the old first-six-nodes opening
  // heuristic and applies to large graphs too; the user's explicit
  // Arrange/Fit controls and toolbar clearance are unchanged.
  useEffect(() => {
    if (!needsFit.current) return;
    if (fitFrame.current !== null) cancelAnimationFrame(fitFrame.current);
    fitFrame.current = requestAnimationFrame(() => {
      fitFrame.current = null;
      if (nodes.length === 0) {
        needsFit.current = false;
        return;
      }
      void flowInstance.current
        ?.fitView({ padding: fitPadding, maxZoom: 1, duration: 200 })
        .then((fitted) => {
          if (fitted) needsFit.current = false;
        });
    });
  }, [nodes, fitPadding]);
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
    <div
      className="canvas-wrap"
      ref={wrapRef}
      onFocusCapture={(event) => {
        // React Flow focuses its outer node wrapper, outside our custom node.
        const node = event.target.closest<HTMLElement>('.react-flow__node');
        setFocusedNodeId(node?.dataset.id ?? null);
      }}
      onBlurCapture={(event) => {
        const next = event.relatedTarget;
        const node =
          next instanceof Element && event.currentTarget.contains(next)
            ? next.closest<HTMLElement>('.react-flow__node')
            : null;
        setFocusedNodeId(node?.dataset.id ?? null);
      }}
    >
      <fieldset
        disabled={readOnly}
        className="canvas-toolbar"
        ref={toolbarRef}
        style={{ border: 0, margin: 0 }}
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
        {!readOnly && <SetupStatus workflow={workflow} issues={validation} />}
        <span className="field-hint" style={{ alignSelf: 'center' }}>
          {nodes.length > 12 && (
            <>Large graph: pan or use the minimap to follow later steps. </>
          )}
          Drag from the output dot to connect · condition branches auto-label true/false ·
          click an edge to relabel · Del removes selection
        </span>
      </fieldset>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onInit={(instance) => {
          flowInstance.current = instance;
        }}
        onMoveEnd={(_, viewport) => {
          // Remember this editable workflow's pan/zoom under its own stable
          // id. Snapshots never persist, and the closure id can never leak
          // one workflow's viewport into another.
          if (!readOnly) writeWorkflowViewport(workflow.id, { ...viewport });
        }}
        onNodeMouseEnter={(_, node) => {
          setHoveredNodeId(node.id);
        }}
        onNodeMouseLeave={() => {
          setHoveredNodeId(null);
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
        // Selecting every End (or Start) at once keeps one, with its edges
        // unless they were selected too.
        onBeforeDelete={({ nodes: doomed, edges: doomedEdges }) => {
          const spared = sparedAnchors(workflow, new Set(doomed.map((n) => n.id)));
          if (spared.size === 0) return Promise.resolve(true);
          return Promise.resolve({
            nodes: doomed.filter((n) => !spared.has(n.id)),
            edges: doomedEdges.filter(
              (e) =>
                e.selected === true || (!spared.has(e.source) && !spared.has(e.target)),
            ),
          });
        }}
        // One handler for steps and edges deleted together, so neither
        // update overwrites the other.
        onDelete={({ nodes: deletedNodes, edges: deletedEdges }) => {
          if (readOnly) return;
          const ids = new Set(deletedNodes.map((d) => d.id));
          const updated = removeFromWorkflow(
            workflow,
            ids,
            new Set(deletedEdges.map((d) => d.id)),
          );
          updateActiveWorkflow(updated);
          revalidate(updated);
          if (selectedNodeId !== null && ids.has(selectedNodeId)) selectNode(null);
          // Never leave a highlight pointing at a deleted node.
          setHoveredNodeId((current) =>
            current !== null && ids.has(current) ? null : current,
          );
          setFocusedNodeId((current) =>
            current !== null && ids.has(current) ? null : current,
          );
        }}
        onNodeDragStop={(_, node, movedNodes) => {
          if (readOnly) return;
          const positions = new Map(
            (movedNodes.length ? movedNodes : [node]).map((moved) => [
              moved.id,
              moved.position,
            ]),
          );
          updateActiveWorkflow({
            ...workflow,
            nodes: workflow.nodes.map((n) => {
              const position = positions.get(n.id);
              return position ? { ...n, position: { ...position } } : n;
            }),
          });
        }}
        nodeTypes={nodeTypes}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        edgesReconnectable={!readOnly}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        defaultEdgeOptions={{ interactionWidth: 32 }}
        connectionRadius={32}
        // Restored viewports arrive synchronously; otherwise the graph opens
        // with a measurement-aware centered fit (empty graphs stay put).
        fitView={savedViewport === null && workflow.nodes.length > 0}
        {...(savedViewport === null ? {} : { defaultViewport: savedViewport })}
        fitViewOptions={{ padding: fitPadding, maxZoom: 1, duration: 0 }}
        minZoom={VIEWPORT_MIN_ZOOM}
        colorMode="system"
        attributionPosition="bottom-right"
      >
        <Background />
        <Controls fitViewOptions={{ padding: fitPadding, maxZoom: 1 }} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
