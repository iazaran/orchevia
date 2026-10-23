import { fireEvent, render, screen } from '@testing-library/react';
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
  const details = screen.getByText('CLI usage details').closest('details');
  expect(details).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText('CLI usage details'));
  expect(details).toHaveTextContent('API value: USD 2.0000');
  expect(details).toHaveTextContent('On a monthly plan you pay the plan fee instead');
  expect(details).toHaveTextContent("Remaining quota is on your provider's usage page");
  expect(screen.getByLabelText('Run timeline')).toHaveTextContent(
    '1 attempt without a USD report',
  );
  expect(screen.getAllByRole('link')).toHaveLength(2);
});

it('hides empty dollar summaries while preserving the timeline', () => {
  const workflow: Workflow = {
    schemaVersion: 6,
    id: 'w',
    name: 'W',
    nodes: [],
    edges: [],
  };
  const run: StoredRun = {
    id: 'r',
    workflowId: 'w',
    status: 'running',
    startedAt: '2026-10-09T00:00:00Z',
  };
  render(
    <RunTimeline
      run={run}
      workflow={workflow}
      results={[]}
      now={Date.parse(run.startedAt)}
    />,
  );
  expect(screen.getByLabelText('Run timeline')).toHaveTextContent('No step timing yet');
  expect(screen.queryByText('CLI usage details')).toBeNull();
  expect(screen.getByLabelText('Run timeline')).not.toHaveTextContent('USD unknown');
});
