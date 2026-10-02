import { expect, it } from 'vitest';
import { createEmptyWorkflow } from './workflow';
import { encodeDocument, decodeDocument } from './workflow-document';
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
