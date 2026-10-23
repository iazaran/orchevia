import { describe, expect, it } from 'vitest';
import { reportFields, reportResult, stepCounts } from './run-report';
import { createEmptyWorkflow, type StoredNodeResult, type Workflow } from './workflow';

function row(
  id: number,
  nodeId: string,
  stdout: string,
  status = 'succeeded',
): StoredNodeResult {
  return {
    id,
    runId: 'r',
    nodeId,
    status,
    stdout,
    stderr: '',
    startedAt: '2026-10-23T19:44:26Z',
  };
}

function ticketWorkflow(): Workflow {
  const workflow = createEmptyWorkflow('Ticket');
  const end = workflow.nodes.find((node) => node.type === 'end')?.id ?? 'end';
  workflow.nodes.push(
    { id: 'review', type: 'agent', position: { x: 0, y: 0 }, config: {} },
    { id: 'coderabbit', type: 'agent', position: { x: 0, y: 0 }, config: {} },
    { id: 'summary', type: 'command', position: { x: 0, y: 0 }, config: {} },
  );
  workflow.edges = [
    { id: 'e1', source: 'review', target: 'coderabbit' },
    { id: 'e2', source: 'coderabbit', target: 'summary' },
    { id: 'e3', source: 'summary', target: end },
  ];
  return workflow;
}

describe('run report', () => {
  it('reports the step that leads to End, not the last agent check', () => {
    const results = [
      row(1, 'review', 'Review text'),
      row(2, 'coderabbit', 'No new review arrived.'),
      row(3, 'summary', 'Ticket: DEV-6195\nPR: https://example.test/pull/3081'),
    ];
    expect(reportResult(ticketWorkflow(), results)?.id).toBe(3);
  });

  it('falls back to the last agent output, then to any output', () => {
    const workflow = ticketWorkflow();
    const quietSummary = [row(1, 'review', 'Review text'), row(2, 'summary', '  \n')];
    expect(reportResult(workflow, quietSummary)?.nodeId).toBe('review');
    expect(reportResult(null, [row(1, 'x', 'only output'), row(2, 'y', '')])?.id).toBe(1);
    expect(reportResult(workflow, [row(1, 'summary', 'skipped', 'skipped')])).toBe(
      undefined,
    );
  });

  it('looks past a condition before End to the step that did the work', () => {
    // Address Review Feedback ends "Re-review → P0/P1 found? → End (false)".
    const workflow = createEmptyWorkflow('Feedback');
    const end = workflow.nodes.find((node) => node.type === 'end')?.id ?? 'end';
    workflow.nodes.push(
      { id: 'fix', type: 'agent', position: { x: 0, y: 0 }, config: {} },
      { id: 'rereview', type: 'agent', position: { x: 0, y: 0 }, config: {} },
      { id: 'gate', type: 'condition', position: { x: 0, y: 0 }, config: {} },
    );
    workflow.edges = [
      { id: 'a', source: 'fix', target: 'rereview' },
      { id: 'b', source: 'rereview', target: 'gate' },
      { id: 'c', source: 'gate', target: end, label: 'false' },
      { id: 'd', source: 'gate', target: 'fix', label: 'true' },
    ];
    const results = [
      row(1, 'fix', 'Fixed P1.'),
      row(2, 'rereview', 'No blocking findings.'),
      row(3, 'gate', 'false'),
    ];
    expect(reportResult(workflow, results)?.id).toBe(2);
    // A branch decision is never the report, even as the last output.
    expect(
      reportResult(workflow, [row(1, 'other', 'Real output'), row(2, 'gate', 'true')])
        ?.id,
    ).toBe(1);
  });

  it('turns leading key-value lines into fields and keeps the rest as text', () => {
    const text = [
      'Ticket:     DEV-6195',
      'PR:         https://github.com/o/r/pull/3081',
      'Jira start: JIRA_STARTED=yes STATUS=In Progress',
      'Commits:',
      '  9ab46e8cf Test the import',
      '  b8d4a7ded Skip hotels without an id',
      '',
      'Review findings and what was done:',
      '| # | From |',
      '|---|---|',
    ].join('\n');
    const { fields, rest } = reportFields(text);
    expect(fields).toEqual([
      { key: 'Ticket', value: 'DEV-6195' },
      { key: 'PR', value: 'https://github.com/o/r/pull/3081' },
      { key: 'Jira start', value: 'JIRA_STARTED=yes STATUS=In Progress' },
      {
        key: 'Commits',
        value: '9ab46e8cf Test the import\nb8d4a7ded Skip hotels without an id',
      },
    ]);
    expect(rest).toBe('Review findings and what was done:\n| # | From |\n|---|---|');
  });

  it('reads KEY=value status lines and leaves prose alone', () => {
    expect(reportFields('TICKET_STATUS=selected\nJIRA_KEY=DEV-6195').fields).toEqual([
      { key: 'TICKET_STATUS', value: 'selected' },
      { key: 'JIRA_KEY', value: 'DEV-6195' },
    ]);
    const prose = 'Note: one remark only.\nThe rest is a paragraph.';
    expect(reportFields(prose)).toEqual({ fields: [], rest: prose });
    const link = 'https://example.test/a\nhttps://example.test/b';
    expect(reportFields(link).fields).toEqual([]);
    expect(reportFields('## Heading\nA: b\nC: d').fields).toEqual([]);
  });

  it('counts skipped and failed steps', () => {
    expect(
      stepCounts([
        row(1, 'a', ''),
        row(2, 'b', '', 'skipped'),
        row(3, 'c', '', 'failed'),
        row(4, 'd', '', 'rejected'),
      ]),
    ).toEqual({ total: 4, skipped: 1, failed: 1, rejected: 1 });
  });
});
