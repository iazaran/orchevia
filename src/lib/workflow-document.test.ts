import { expect, it } from 'vitest';
import { createEmptyWorkflow } from './workflow';
import { encodeDocument, decodeDocument } from './workflow-document';
import { remapConfigReferences } from './workflow-document';

it('keeps cost controls portable and remaps their node references', () => {
  const config = {
    sessionGroup: 'item-{{ node.old.output }}',
    sessionMaxTurns: 3,
    contextRefs: ['old'],
    contextMaxChars: 1000,
  };
  expect(remapConfigReferences(config, { old: 'fresh' })).toEqual({
    ...config,
    sessionGroup: 'item-{{ node.fresh.output }}',
    contextRefs: ['fresh'],
  });
  const wf = createEmptyWorkflow('Context');
  wf.nodes[1]!.config = {
    ...config,
    contextRefs: [wf.nodes[0]!.id],
    sessionGroup: 'work',
  };
  const encoded = encodeDocument(wf, []);
  expect(decodeDocument(encoded.json, [], {}, wf, encoded.nodeIds)).toEqual(wf);
});

it('keeps condition right operands literal as required by the runtime evaluator', () => {
  const condition = {
    logic: 'and' as const,
    clauses: [
      { left: 'node.old.output', op: 'equals' as const, right: 'node.old.output' },
      {
        left: 'node.old.output',
        op: 'equals' as const,
        right: '{{ node.missing.output }}',
      },
    ],
  };
  const mapped = remapConfigReferences({ condition }, { old: 'fresh' });
  expect(mapped.condition?.clauses.map((c) => c.left)).toEqual([
    'node.fresh.output',
    'node.fresh.output',
  ]);
  expect(mapped.condition?.clauses.map((c) => c.right)).toEqual(
    condition.clauses.map((c) => c.right),
  );
});

it('remaps spaced references and overlapping IDs while preserving escapes and literals', () => {
  const config = {
    prompt:
      '{{ node.old.output }} {{node.old-long.output}} \\{{ node.old.output }} {{not-a-reference}}',
    condition: {
      logic: 'and' as const,
      clauses: [{ left: 'node.old.output', op: 'equals' as const, right: 'literal' }],
    },
  };
  const mapped = remapConfigReferences(config, { old: 'fresh', 'old-long': 'longer' });
  expect(mapped.prompt).toBe(
    '{{ node.fresh.output }} {{node.longer.output}} \\{{ node.old.output }} {{not-a-reference}}',
  );
  expect(mapped.condition?.clauses[0]?.left).toBe('node.fresh.output');
  expect(() =>
    remapConfigReferences({ prompt: '{{ node.missing.output }}' }, { old: 'fresh' }),
  ).toThrow('Unknown node reference');
});

it('preserves MCP keys resembling typed workflow fields on export and clone', () => {
  const config = {
    mcpArgs: {
      left: 'node.old.output',
      right: 'literal',
      inputRefs: 'literal',
      templated: '{{node.old.output}}',
    },
    inputRefs: ['old'],
  };
  expect(remapConfigReferences(config, { old: 'fresh' })).toEqual({
    ...config,
    inputRefs: ['fresh'],
    mcpArgs: { ...config.mcpArgs, templated: '{{node.fresh.output}}' },
  });
  const wf = createEmptyWorkflow('MCP');
  wf.nodes[1]!.config = { mcpArgs: { inputRefs: 'literal', left: 'node.old.output' } };
  const session = encodeDocument(wf, []);
  expect(decodeDocument(session.json, [], {}, wf, session.nodeIds)).toEqual(wf);
});
it('round trips opaque IDs, positions, references and literal text', () => {
  const wf = createEmptyWorkflow('Round trip');
  const start = wf.nodes[0]!;
  const end = wf.nodes[1]!;
  end.config = {
    message: `Use {{node.${start.id}.output}}; literal node.${start.id}.output`,
    inputRefs: [start.id],
    retry: { maxAttempts: 3, delayMs: 12, backoff: true },
    extendOnOutput: true,
  };
  const session = encodeDocument(wf, []);
  expect(session.json).not.toContain('position');
  expect((JSON.parse(session.json) as { nodes: { key: string }[] }).nodes[0]?.key).toBe(
    'start',
  );
  // Literal text intentionally stays untouched, including its original ID.
  const doc = JSON.parse(session.json) as { nodes: { config: { message?: string } }[] };
  expect(doc.nodes[1]?.config.message).toContain(`literal node.${start.id}.output`);
  expect(decodeDocument(session.json, [], {}, wf, session.nodeIds)).toEqual(wf);
});
it('rejects duplicate keys, malformed config and dangling references', () => {
  const doc = {
    version: 1,
    name: 'test',
    nodes: [
      {
        key: 'a',
        type: 'command',
        config: { executable: 'echo', args: ['{{node.missing.output}}'] },
      },
    ],
    edges: [],
  };
  expect(() => decodeDocument(JSON.stringify(doc), [], {})).toThrow(
    'Unknown node reference',
  );
  doc.nodes[0]!.config.args = [];
  doc.nodes.push(doc.nodes[0]!);
  expect(() => decodeDocument(JSON.stringify(doc), [], {})).toThrow('Duplicate');
  expect(() =>
    decodeDocument(
      JSON.stringify({
        ...doc,
        nodes: [{ key: 'a', type: 'start', config: { mystery: true } }],
      }),
      [],
      {},
    ),
  ).toThrow('Unknown config');
});
it('imports legacy JSON without changing its definition', () => {
  const wf = createEmptyWorkflow('Old');
  expect(decodeDocument(JSON.stringify(wf), [], {})).toEqual(wf);
});

it('rejects malformed typed config, operations, inputs, defaults and graph labels', () => {
  const base = {
    version: 1,
    name: 'Shape',
    nodes: [{ key: 'a', type: 'command', config: {} }],
    edges: [],
  };
  const malformed = [
    ...[
      { args: 42 },
      { executable: 42 },
      { args: [42] },
      { retry: { maxAttempts: '3' } },
      { condition: { logic: 'and', clauses: [{ left: 1, op: 'equals', right: '' }] } },
      { gitOp: { op: 'checkout', name: 42 } },
      { githubOp: { op: 'prFiles', number: '2' } },
      { mcpArgs: { query: 42 } },
      { timeoutSecs: -1 },
    ].map((config) => ({ ...base, nodes: [{ key: 'a', type: 'command', config }] })),
    { ...base, nodes: [{ key: 'a', type: 'command', label: 2, config: {} }] },
    { ...base, nodes: [{ key: 'a', type: 'agent', profileName: 2, config: {} }] },
    { ...base, defaults: { repoDir: 2 } },
    { ...base, inputs: [{ name: 'testCommand', required: 'yes' }] },
    { ...base, inputs: {} },
    {
      ...base,
      nodes: [
        {
          key: 'a',
          type: 'condition',
          config: { condition: { logic: ['and'], clauses: [] } },
        },
      ],
    },
    { ...base, edges: [{ from: 'a', to: 'a', label: 2 }] },
  ];
  for (const doc of malformed)
    expect(() => decodeDocument(JSON.stringify(doc), [], {})).toThrow();
  const raw = createEmptyWorkflow('Bad raw');
  for (const fields of [{ config: null }, { position: null }, { type: ['start'] }]) {
    expect(() =>
      decodeDocument(
        JSON.stringify({ ...raw, nodes: [{ ...raw.nodes[0], ...fields }] }),
        [],
        {},
      ),
    ).toThrow();
  }
});

it('normalizes legacy GitHub spelling for developer and raw imports', () => {
  const doc = {
    version: 1,
    name: 'Alias',
    nodes: [{ key: 'a', type: 'gitHub', config: { githubOp: { op: 'prStatus' } } }],
    edges: [],
  };
  expect(decodeDocument(JSON.stringify(doc), [], {}).nodes[0]?.type).toBe('github');
  const raw = createEmptyWorkflow('Raw alias');
  const json = JSON.stringify(raw).replace('"type":"start"', '"type":"gitHub"');
  expect(decodeDocument(json, [], {}).nodes[0]?.type).toBe('github');
});

it('resolves exact reviewers and preserves all configurable fields', () => {
  const wf = createEmptyWorkflow('Profiles');
  const profile = {
    id: 'p',
    name: 'Reviewer',
    adapter: 'codex' as const,
    extraArgs: [],
    workingDirMode: 'node' as const,
    defaultTimeoutSecs: 3600,
    role: 'deepReview',
  };
  wf.nodes[1]!.type = 'agent';
  wf.nodes[1]!.config = {
    agentProfileId: 'p',
    prompt: 'Review',
    gitOp: { op: 'checkout', name: 'branch', allowDirty: true },
    githubOp: {
      op: 'createPr',
      title: 'Title',
      base: 'main',
      head: 'branch',
      draft: true,
    },
    mcpArgs: { query: 'value' },
    timeoutSecs: 3600,
    maxVisits: 2,
  };
  const session = encodeDocument(wf, [profile]);
  expect(decodeDocument(session.json, [profile], {}, wf, session.nodeIds)).toEqual(wf);
  expect(() => decodeDocument(session.json, [], {}, wf, session.nodeIds)).toThrow(
    'No Agent Profile',
  );
  expect(() =>
    decodeDocument(
      session.json,
      [profile, { ...profile, id: 'other' }],
      {},
      wf,
      session.nodeIds,
    ),
  ).toThrow('ambiguous');
});
