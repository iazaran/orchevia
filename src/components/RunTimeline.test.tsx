import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { RunTimeline } from './RunTimeline';
import type { StoredNodeResult, StoredRun, Workflow } from '../lib/workflow';

it('shows overlapping execution separately from wall time and unknown cost coverage', () => {
  const workflow: Workflow = {
    schemaVersion: 6,
    id: 'w',
    name: 'W',
    edges: [],
    nodes: ['a', 'b'].map((id) => ({
      id,
      type: 'agent',
      label: id,
      position: { x: 0, y: 0 },
      config: {},
    })),
  };
  const run: StoredRun = {
    id: 'r',
    workflowId: 'w',
    status: 'succeeded',
    startedAt: '2026-10-08T00:00:00Z',
    finishedAt: '2026-10-08T00:00:05Z',
  };
  const results: StoredNodeResult[] = ['a', 'b'].map((nodeId, index) => ({
    id: index + 1,
    runId: 'r',
    nodeId,
    status: 'succeeded',
    stdout: '',
    stderr: '',
    startedAt: run.startedAt,
    finishedAt: run.finishedAt!,
    durationMs: 5000,
    ...(index === 0 ? { structuredJson: '{"agentUsage":{"reported_cost_usd":2}}' } : {}),
  }));
  render(<RunTimeline run={run} workflow={workflow} results={results} />);
  expect(screen.getByLabelText('Run timeline')).toHaveTextContent('Elapsed: 5s');
  expect(screen.getByLabelText('Run timeline')).toHaveTextContent('USD 2.0000');
  expect(screen.getByLabelText('Run timeline')).toHaveTextContent(
    '1 attempt without a USD report',
  );
  expect(screen.getAllByRole('link')).toHaveLength(2);
});
