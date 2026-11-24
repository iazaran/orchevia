import { expect, it } from 'vitest';
import fixture from '../test/review-rounds.json';
import { groupedReviewFindings, runReviewFindings } from './review';
import type { StoredNodeResult, Workflow } from './workflow';

it('matches the desktop review comparison across completed visits', () => {
  const groups = groupedReviewFindings(
    fixture.visits.map((visit) => ({ ...visit, source: visit.nodeId })),
  );
  const actual = groups
    .flatMap((g) => g.history ?? [])
    .map(({ occurrences, state, previousSeverity }) => ({
      title: occurrences.at(-1)?.finding.title,
      state,
      resultIds: occurrences.map((o) => o.resultId),
      ...(previousSeverity === undefined ? {} : { previousSeverity }),
    }))
    .sort((a, b) => (String(a.title) < String(b.title) ? -1 : 1));
  expect(actual).toEqual(
    [...fixture.expected].sort((a, b) => (a.title < b.title ? -1 : 1)),
  );
  expect(groups.find((g) => g.finding.title === 'Missing lock')?.sources).toEqual([
    'review-a',
    'review-b',
  ]);
});

it('compares only successful visits from the current workflow run', () => {
  const workflow: Workflow = {
    id: 'w',
    name: 'Review',
    schemaVersion: 6,
    edges: [],
    nodes: [{ id: 'review-a', type: 'agent', position: { x: 0, y: 0 }, config: {} }],
  };
  const result: StoredNodeResult = {
    id: 1,
    runId: 'run',
    nodeId: 'review-a',
    status: 'succeeded',
    stdout: fixture.visits[0]?.stdout ?? '',
    stderr: '',
    startedAt: '2026-11-24T12:00:00Z',
  };
  const rows = [
    result,
    { ...result, id: 2, stdout: '', status: 'failed' },
    { ...result, id: 3, stdout: '', structuredJson: '{"feedbackCheck":{}}' },
    { ...result, id: 4, stdout: '', structuredJson: '{"reusedFrom":{}}' },
    { ...result, id: 5, stdout: '', structuredJson: '{"simulated":true}' },
  ];
  const before = runReviewFindings(workflow, rows, () => undefined);
  expect(before).toHaveLength(3);
  expect(
    before.every((group) => group.resultIds?.[0] === 1 && group.history === undefined),
  ).toBe(true);
  const after = runReviewFindings(
    workflow,
    [...rows, { ...result, id: 6, stdout: 'Clean review.' }],
    () => undefined,
  );
  expect(after).toHaveLength(3);
  expect(
    after.every(
      (group) => group.sources.length === 0 && group.history?.[0]?.state === 'fixed',
    ),
  ).toBe(true);
});
