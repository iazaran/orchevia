import { describe, expect, it } from 'vitest';
import {
  arrangeWorkflowPositions,
  parseWorkflowJson,
  createAgentDemoWorkflow,
  createCommitPrWorkflow,
  createEmptyWorkflow,
  createReviewLoopDemoWorkflow,
  createSampleWorkflow,
  CURRENT_SCHEMA_VERSION,
  bypassedEdgeIds,
  nextBranchLabel,
  planExecutionOrder,
  setWorkflowDefaults,
  validateWorkflowLocal,
  type Workflow,
  type WorkflowNode,
} from './workflow';

describe('workflow domain', () => {
  it('stamps the current schema version (parity with Rust CURRENT_SCHEMA_VERSION)', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(6);
  });

  it('creates an empty workflow with start and end', () => {
    const wf = createEmptyWorkflow('Test');
    expect(wf.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(wf.nodes.filter((n) => n.type === 'start')).toHaveLength(1);
    expect(wf.nodes.filter((n) => n.type === 'end')).toHaveLength(1);
    expect(validateWorkflowLocal(wf)).toHaveLength(0);
  });

  it('sample workflow is valid and serializable', () => {
    const wf = createSampleWorkflow();
    expect(validateWorkflowLocal(wf)).toHaveLength(0);
    const parsed = JSON.parse(JSON.stringify(wf)) as Workflow;
    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.nodes.length).toBeGreaterThanOrEqual(4);
  });

  it('plans execution order from start to end', () => {
    const wf = createSampleWorkflow();
    const order = planExecutionOrder(wf);
    expect(order[0]).toBe(wf.nodes.find((n) => n.type === 'start')?.id);
    expect(order[order.length - 1]).toBe(wf.nodes.find((n) => n.type === 'end')?.id);
    expect(order).toHaveLength(wf.nodes.length);
  });

  it('rejects workflows without a command executable', () => {
    const wf = createEmptyWorkflow('Test');
    const start = wf.nodes.find((n) => n.type === 'start');
    const end = wf.nodes.find((n) => n.type === 'end');
    if (start === undefined || end === undefined) throw new Error('fixture broken');
    wf.nodes.push({
      id: 'node-cmd',
      type: 'command',
      position: { x: 0, y: 0 },
      config: {},
    });
    wf.edges = [
      { id: 'e1', source: start.id, target: 'node-cmd' },
      { id: 'e2', source: 'node-cmd', target: end.id },
    ];
    const issues = validateWorkflowLocal(wf);
    expect(issues.some((i) => i.code === 'command-executable-required')).toBe(true);
  });

  it('demo workflows reference agent roles without profiles', () => {
    const demo = createAgentDemoWorkflow({
      plan: 'missing-claude-profile',
      implement: 'missing-claude-profile',
      review: 'missing-codex-profile',
    });
    expect(demo.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const loop = createReviewLoopDemoWorkflow({
      implement: 'x',
      reviewA: 'y',
      reviewB: 'z',
    });
    expect(loop.nodes.length).toBeGreaterThan(demo.nodes.length);
  });

  it('labels condition branches true first, then false', () => {
    expect(nextBranchLabel([])).toBe('true');
    expect(nextBranchLabel(['true'])).toBe('false');
    expect(nextBranchLabel(['yes'])).toBe('false');
  });
});

describe('validation coverage', () => {
  function linearWith(node: Partial<WorkflowNode> & { id: string }): Workflow {
    const wf = createEmptyWorkflow('Coverage flow');
    const start = wf.nodes.find((n) => n.type === 'start');
    const end = wf.nodes.find((n) => n.type === 'end');
    if (start === undefined || end === undefined) throw new Error('fixture broken');
    wf.nodes.push({
      type: 'command',
      position: { x: 0, y: 0 },
      config: { executable: 'echo', args: [] },
      ...node,
    });
    wf.edges = [
      { id: 'e1', source: start.id, target: 'node-x' },
      { id: 'e2', source: 'node-x', target: end.id },
    ];
    return wf;
  }

  it('requires agent profile and prompt', () => {
    const wf = linearWith({
      id: 'node-x',
      type: 'agent',
      config: {},
    });
    const codes = validateWorkflowLocal(wf).map((i) => i.code);
    expect(codes).toContain('agent-profile-required');
    expect(codes).toContain('agent-prompt-required');
  });

  it('requires condition expressions and labeled branches', () => {
    const wf = linearWith({
      id: 'node-x',
      type: 'condition',
      config: {},
    });
    const codes = validateWorkflowLocal(wf).map((i) => i.code);
    expect(codes).toContain('condition-required');
  });

  it('requires ticket key and server', () => {
    const wf = linearWith({
      id: 'node-x',
      type: 'ticket',
      config: {},
    });
    const codes = validateWorkflowLocal(wf).map((i) => i.code);
    expect(codes).toContain('ticket-key-required');
    expect(codes).toContain('ticket-server-required');
  });

  it('requires mcp server and tool', () => {
    const wf = linearWith({
      id: 'node-x',
      type: 'mcp',
      config: {},
    });
    const codes = validateWorkflowLocal(wf).map((i) => i.code);
    expect(codes).toContain('mcp-server-required');
    expect(codes).toContain('mcp-tool-required');
  });

  it('requires a single start and an end', () => {
    const wf = createEmptyWorkflow('Ends');
    wf.nodes = wf.nodes.filter((n) => n.type !== 'start');
    expect(
      validateWorkflowLocal(wf)
        .map((i) => i.code)
        .some((c) => c === 'single-start' || c === 'start-required'),
    ).toBe(true);
  });

  it('rejects edges to unknown nodes', () => {
    const wf = createEmptyWorkflow('Edges');
    wf.edges = [{ id: 'e9', source: 'nope', target: 'missing' }];
    expect(validateWorkflowLocal(wf).map((i) => i.code)).toContain('edge-unknown-node');
  });
});

describe('command executable guidance', () => {
  it('warns on bare compose', () => {
    const wf = createEmptyWorkflow('Compose flow');
    const start = wf.nodes.find((n) => n.type === 'start');
    const end = wf.nodes.find((n) => n.type === 'end');
    if (start === undefined || end === undefined) throw new Error('fixture broken');
    wf.nodes.push({
      id: 'node-cmd',
      type: 'command',
      position: { x: 0, y: 0 },
      config: { executable: 'compose', args: ['up', '-d'] },
    });
    wf.edges = [
      { id: 'e1', source: start.id, target: 'node-cmd' },
      { id: 'e2', source: 'node-cmd', target: end.id },
    ];
    expect(validateWorkflowLocal(wf).map((i) => i.code)).toContain(
      'command-executable-suspicious',
    );
  });
});

describe('workflow JSON', () => {
  it('round-trips a workflow', () => {
    const wf = createEmptyWorkflow('JSON flow');
    const parsed = parseWorkflowJson(JSON.stringify(wf));
    expect(parsed.name).toBe('JSON flow');
    expect(validateWorkflowLocal(parsed)).toHaveLength(0);
  });

  it('rejects bad JSON with clear messages', () => {
    expect(() => parseWorkflowJson('{nope')).toThrow(/valid JSON/);
    expect(() => parseWorkflowJson('42')).toThrow(/object/);
    expect(() =>
      parseWorkflowJson(
        '{"schemaVersion":999,"id":"a","name":"b","nodes":[],"edges":[]}',
      ),
    ).toThrow(/Unsupported schema/);
    expect(() => parseWorkflowJson('{"schemaVersion":6,"id":"a","name":"b"}')).toThrow(
      /nodes\[\]/,
    );
  });
});

describe('smart connect', () => {
  const e = (
    id: string,
    source: string,
    target: string,
    label?: string,
  ): Parameters<typeof bypassedEdgeIds>[0][number] => ({
    id,
    source,
    target,
    ...(label === undefined ? {} : { label }),
  });

  it('drops exact duplicates', () => {
    const r = bypassedEdgeIds([e('e1', 'a', 'b')], 'a', 'b');
    expect(r.dropNew).toBe(true);
    expect(r.removeIds).toHaveLength(0);
  });

  it('removes the bypassed direct line when inserting a node', () => {
    // a → b exists; user draws a → n then n → b.
    const afterFirst = bypassedEdgeIds([e('e1', 'a', 'b')], 'a', 'n');
    expect(afterFirst.dropNew).toBe(false);
    expect(afterFirst.removeIds).toHaveLength(0);
    const withNew = [e('e1', 'a', 'b'), e('e2', 'a', 'n')];
    const r = bypassedEdgeIds(withNew, 'n', 'b');
    expect(r.dropNew).toBe(false);
    expect(r.removeIds).toEqual(['e1']);
  });

  it('never touches labeled edges', () => {
    const withNew = [e('e1', 'a', 'b', 'true'), e('e2', 'a', 'n')];
    const r = bypassedEdgeIds(withNew, 'n', 'b');
    expect(r.removeIds).toHaveLength(0);
  });

  it('keeps unrelated edges into the same target', () => {
    // x → b exists but x cannot reach n: drawing n → b keeps it.
    const r = bypassedEdgeIds([e('e1', 'x', 'b')], 'n', 'b');
    expect(r.removeIds).toHaveLength(0);
  });
});

describe('commit/PR quick flow', () => {
  it('builds a native commit/PR workflow with input templates', () => {
    const wf = createCommitPrWorkflow('/repo', 'feature/x');
    expect(wf.inputs?.map((i) => i.name)).toContain('commitMessage');
    expect(wf.inputs?.map((i) => i.name)).toContain('prTitle');
    const commit = wf.nodes.find((n) => n.label === 'Commit staged');
    expect(JSON.stringify(commit?.config.gitOp)).toContain('{{input.commitMessage}}');
    const pr = wf.nodes.find((n) => n.label === 'Open draft PR');
    expect(JSON.stringify(pr?.config.githubOp)).toContain('{{input.prTitle}}');
    expect(validateWorkflowLocal(wf)).toHaveLength(0);
  });

  it('falls back to a generic name without a branch', () => {
    const wf = createCommitPrWorkflow('/repo', '');
    expect(wf.name).toContain('branch');
    expect(validateWorkflowLocal(wf)).toHaveLength(0);
  });
});

describe('workflow defaults', () => {
  it('accepts workflow repo defaults for git/github nodes', () => {
    const wf = createEmptyWorkflow('Defaults flow');
    const start = wf.nodes.find((n) => n.type === 'start');
    const end = wf.nodes.find((n) => n.type === 'end');
    if (start === undefined || end === undefined) throw new Error('fixture broken');
    wf.nodes.push({
      id: 'node-git',
      type: 'git',
      position: { x: 0, y: 0 },
      config: { gitOp: { op: 'status' } },
    });
    wf.edges = [
      { id: 'e1', source: start.id, target: 'node-git' },
      { id: 'e2', source: 'node-git', target: end.id },
    ];
    expect(
      validateWorkflowLocal(wf).filter((i) => i.code === 'git-dir-required'),
    ).toHaveLength(1);
    wf.defaults = { repoDir: '/repo', branch: 'feature/x' };
    expect(
      validateWorkflowLocal(wf).filter((i) => i.code === 'git-dir-required'),
    ).toHaveLength(0);
  });

  it('sets and clears workflow defaults without empty blocks', () => {
    const wf = createEmptyWorkflow('Defaults helper');
    const set = setWorkflowDefaults(wf, '  /repo ', 'feature/x');
    expect(set.defaults).toEqual({ repoDir: '/repo', branch: 'feature/x' });
    const cleared = setWorkflowDefaults(set, '', '');
    expect('defaults' in cleared).toBe(false);
    expect(JSON.stringify(cleared)).not.toContain('defaults');
  });
});

describe('auto arrange', () => {
  it('arranges nodes in layers following edges', () => {
    const positions = arrangeWorkflowPositions(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
        { source: 'b', target: 'd' },
        { source: 'c', target: 'd' },
      ],
      { direction: 'horizontal' },
    );
    expect(positions['a']?.x).toBeLessThan(positions['b']?.x ?? 0);
    expect(positions['b']?.x).toBe(positions['c']?.x);
    expect(positions['b']?.y).not.toBe(positions['c']?.y);
    expect(positions['d']?.x).toBeGreaterThan(positions['b']?.x ?? 0);
  });

  it('wraps tall columns into a compact grid', () => {
    const nodes = Array.from({ length: 7 }, (_, i) => ({ id: `n${String(i)}` }));
    const positions = arrangeWorkflowPositions(nodes, [], { direction: 'horizontal' });
    const xs = new Set(Object.values(positions).map((p) => p.x));
    // 7 unconnected nodes: 5 in the first column, 2 wrapped into a second.
    expect(xs.size).toBe(2);
    const keys = Object.values(positions).map((p) => `${String(p.x)},${String(p.y)}`);
    expect(new Set(keys).size).toBe(7);
  });

  it('orders parallel branches by their successors', () => {
    // Definition order crosses the branches (b listed before a); the sweep
    // should still place each branch near its own successor chain.
    const positions = arrangeWorkflowPositions(
      [{ id: 'start' }, { id: 'b' }, { id: 'a' }, { id: 'endB' }, { id: 'endA' }],
      [
        { source: 'start', target: 'b' },
        { source: 'start', target: 'a' },
        { source: 'b', target: 'endB' },
        { source: 'a', target: 'endA' },
      ],
    );
    const yb = positions['b']?.y ?? 0;
    const ya = positions['a']?.y ?? 0;
    const yEndB = positions['endB']?.y ?? 0;
    const yEndA = positions['endA']?.y ?? 0;
    // Each end sits on its own branch's row (no crossing).
    expect(Math.abs(yb - yEndB)).toBeLessThanOrEqual(Math.abs(yb - yEndA));
    expect(Math.abs(ya - yEndA)).toBeLessThanOrEqual(Math.abs(ya - yEndB));
  });

  it('arranges cycles and islands without overlap', () => {
    const positions = arrangeWorkflowPositions(
      [{ id: 'a' }, { id: 'b' }, { id: 'solo' }],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
      ],
    );
    const values = Object.values(positions);
    expect(values).toHaveLength(3);
    const keys = values.map((p) => `${String(p.x)},${String(p.y)}`);
    expect(new Set(keys).size).toBe(3);
  });
});

describe('dependency layout', () => {
  it('arranges a long chain vertically and permits horizontal layout', () => {
    const nodes = Array.from({ length: 26 }, (_, i) => ({ id: `n${String(i)}` }));
    const edges = nodes
      .slice(1)
      .map((n, i) => ({ source: nodes[i]?.id ?? '', target: n.id }));
    const vertical = arrangeWorkflowPositions(nodes, edges);
    expect(vertical['n25']?.y).toBeGreaterThan(vertical['n0']?.y ?? 0);
    expect(vertical['n25']?.x).toBe(vertical['n0']?.x);
    const horizontal = arrangeWorkflowPositions(nodes, edges, {
      direction: 'horizontal',
    });
    expect(horizontal['n25']?.x).toBeGreaterThan(horizontal['n0']?.x ?? 0);
    expect(horizontal['n25']?.y).toBe(horizontal['n0']?.y);
  });
  it('separates large cyclic components, branches and islands deterministically', () => {
    const nodes = ['start', 'a', 'b', 'merge', 'island'].map((id) => ({ id }));
    const edges = [
      { source: 'start', target: 'a' },
      { source: 'start', target: 'b' },
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
      { source: 'b', target: 'merge' },
      { source: 'missing', target: 'merge' },
    ];
    const sizes = Object.fromEntries(
      nodes.map((n) => [n.id, { width: 400, height: 300 }]),
    );
    const positions = arrangeWorkflowPositions(nodes, edges, { sizes });
    expect(arrangeWorkflowPositions(nodes, edges, { sizes })).toEqual(positions);
    for (const [i, a] of nodes.entries())
      for (const b of nodes.slice(i + 1)) {
        const pa = positions[a.id]!;
        const pb = positions[b.id]!;
        expect(Math.abs(pa.x - pb.x) >= 400 || Math.abs(pa.y - pb.y) >= 300).toBe(true);
      }
    expect(positions['merge']?.y).toBeGreaterThan(positions['b']?.y ?? 0);
  });
});
