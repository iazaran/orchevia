import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __setMockBackendForTests } from '../lib/backend';
import { createDefaultProfile } from '../lib/agents';
import type { Workflow } from '../lib/workflow';
import { RunFilesPanel } from './RunFiles';

afterEach(() => {
  vi.restoreAllMocks();
});

async function runWritingFiles(): Promise<{ runId: string }> {
  const backend = __setMockBackendForTests();
  const profile = await backend.saveAgentProfile(createDefaultProfile('claude'));
  const workflow: Workflow = {
    schemaVersion: 6,
    id: 'wf-files',
    name: 'Launch kit',
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'write',
        type: 'agent',
        label: 'Write the kit',
        position: { x: 0, y: 100 },
        config: {
          agentProfileId: profile.id,
          prompt: 'Write post.md and draw cover.png, then social.csv.',
        },
      },
      { id: 'end', type: 'end', position: { x: 0, y: 200 }, config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'write' },
      { id: 'e2', source: 'write', target: 'end' },
    ],
  };
  await backend.saveWorkflow(workflow);
  const { runId } = await backend.runWorkflow('wf-files');
  await waitFor(
    async () => {
      expect((await backend.getRun(runId))?.status).toBe('succeeded');
    },
    { timeout: 5000 },
  );
  return { runId };
}

it('lists what a run made and previews documents and images', async () => {
  const { runId } = await runWritingFiles();
  const { getBackend } = await import('../lib/backend');
  const run = await getBackend().getRun(runId);
  if (run === null) throw new Error('run missing');
  render(<RunFilesPanel key={run.id} run={run} refreshKey="1" />);
  const panel = await screen.findByRole('region', { name: 'Run files' });
  expect(within(panel).getByText('3')).toBeInTheDocument();
  expect(
    within(panel).getByText(/~\/Documents\/Orchevia\/Launch kit/),
  ).toBeInTheDocument();
  // The image tile gets a thumbnail.
  await waitFor(() => {
    expect(panel.querySelector('img')).not.toBeNull();
  });
  const user = userEvent.setup();
  await user.click(within(panel).getByRole('button', { name: 'Preview post.md' }));
  const dialog = await screen.findByRole('dialog', { name: 'File post.md' });
  expect(await within(dialog).findByText(/placeholder text/)).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Open' })).toBeInTheDocument();
  // Opening needs the desktop app; the reason is shown, not thrown away.
  await user.click(within(dialog).getByRole('button', { name: 'Show in folder' }));
  expect(
    await within(dialog).findByText('Opening files is available in the desktop app.'),
  ).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Close' }));
  await user.click(within(panel).getByRole('button', { name: 'Preview cover.png' }));
  const image = await screen.findByRole('dialog', { name: 'File cover.png' });
  await waitFor(() => {
    expect(within(image).getByRole('img')).toHaveAttribute(
      'src',
      expect.stringMatching(/^data:image\/svg\+xml;base64,/),
    );
  });
});

it('shows nothing for a run that made no files, and refuses other paths', async () => {
  const backend = __setMockBackendForTests();
  const workflow: Workflow = {
    schemaVersion: 6,
    id: 'wf-none',
    name: 'Nothing',
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      { id: 'end', type: 'end', position: { x: 0, y: 100 }, config: {} },
    ],
    edges: [{ id: 'e1', source: 'start', target: 'end' }],
  };
  await backend.saveWorkflow(workflow);
  const { runId } = await backend.runWorkflow('wf-none');
  // A finished run that made nothing shows nothing.
  await waitFor(
    async () => {
      expect((await backend.getRun(runId))?.status).toBe('succeeded');
    },
    { timeout: 5000 },
  );
  const run = await backend.getRun(runId);
  if (run === null) throw new Error('run missing');
  const { container } = render(<RunFilesPanel key={run.id} run={run} refreshKey="0" />);
  await waitFor(async () => {
    expect((await backend.listRunFiles(runId)).files).toEqual([]);
  });
  expect(container).toBeEmptyDOMElement();
  await expect(backend.readRunFile(runId, '/etc/passwd')).rejects.toThrow(
    "Only files in this run's folders can be opened.",
  );
  await expect(backend.listRunFiles('missing')).rejects.toThrow('Run not found.');
});

it('keeps one open run per workspace folder and same-named files apart', async () => {
  const backend = __setMockBackendForTests();
  const profile = await backend.saveAgentProfile(createDefaultProfile('claude'));
  const workflow: Workflow = {
    schemaVersion: 6,
    id: 'wf-gate',
    name: 'Gate',
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'a',
        type: 'agent',
        position: { x: 0, y: 100 },
        config: { agentProfileId: profile.id, prompt: 'Write report.md' },
      },
      {
        id: 'b',
        type: 'agent',
        position: { x: 0, y: 200 },
        config: {
          agentProfileId: profile.id,
          prompt: 'Write report.md here too',
          workingDir: '/tmp/elsewhere',
        },
      },
      { id: 'wait', type: 'approval', position: { x: 0, y: 300 }, config: {} },
      { id: 'end', type: 'end', position: { x: 0, y: 400 }, config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'a' },
      { id: 'e2', source: 'a', target: 'b' },
      { id: 'e3', source: 'b', target: 'wait' },
      { id: 'e4', source: 'wait', target: 'end' },
    ],
  };
  await backend.saveWorkflow(workflow);
  const { runId } = await backend.runWorkflow('wf-gate');
  await waitFor(
    async () => {
      expect((await backend.getRun(runId))?.status).toBe('paused');
    },
    { timeout: 5000 },
  );
  expect((await backend.getRun(runId))?.execution?.workspace).toBe(
    '~/Documents/Orchevia/Gate (wfgate)',
  );
  await expect(backend.runWorkflow('wf-gate')).rejects.toThrow(
    "'Gate' already has a run open in its workspace folder.",
  );
  // A dry run touches no folder.
  await expect(
    backend.runWorkflow('wf-gate', {}, { dryRun: true, fixtures: {} }),
  ).resolves.toBeDefined();
  const listed = await backend.listRunFiles(runId);
  expect(listed.files.map((f) => f.path).sort()).toEqual([
    '/tmp/elsewhere/report.md',
    '~/Documents/Orchevia/Gate (wfgate)/report.md',
  ]);
  expect(listed.folders).toEqual([
    '/tmp/elsewhere',
    '~/Documents/Orchevia/Gate (wfgate)',
  ]);
});

it('recovers in the failed run’s folder once no other run is open there', async () => {
  const backend = __setMockBackendForTests();
  const workflow: Workflow = {
    schemaVersion: 6,
    id: 'wf-recover',
    name: 'Recover',
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'cmd',
        type: 'command',
        position: { x: 0, y: 100 },
        config: { executable: 'echo', args: ['notes.md'] },
      },
      { id: 'gate', type: 'approval', position: { x: 0, y: 200 }, config: {} },
      { id: 'end', type: 'end', position: { x: 0, y: 300 }, config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'cmd' },
      { id: 'e2', source: 'cmd', target: 'gate' },
      { id: 'e3', source: 'gate', target: 'end' },
    ],
  };
  await backend.saveWorkflow(workflow);
  const paused = async (id: string): Promise<void> => {
    await waitFor(
      async () => {
        expect((await backend.getRun(id))?.status).toBe('paused');
      },
      { timeout: 5000 },
    );
  };
  const { runId: first } = await backend.runWorkflow('wf-recover');
  await paused(first);
  await backend.approveRun(first, false);
  expect((await backend.getRun(first))?.status).toBe('failed');
  const { runId: second } = await backend.runWorkflow('wf-recover');
  await paused(second);
  const plan = await backend.previewRecovery(first);
  const choices = Object.fromEntries(
    plan.nodes.map((n) => [n.nodeId, n.choices.includes('reuse') ? 'reuse' : 'replay']),
  ) as Record<string, 'reuse' | 'replay'>;
  await expect(
    backend.recoverRun(first, choices, plan.fingerprint, 'req-ws-1'),
  ).rejects.toThrow("'Recover' already has a run open in its workspace folder.");
  await backend.cancelRun(second);
  const { runId: recovered } = await backend.recoverRun(
    first,
    choices,
    plan.fingerprint,
    'req-ws-2',
  );
  expect((await backend.getRun(recovered))?.execution?.workspace).toBe(
    (await backend.getRun(first))?.execution?.workspace,
  );
});

it('keeps Refresh on a waiting run with no files yet, and stores choices trimmed', async () => {
  const backend = __setMockBackendForTests();
  const workflow: Workflow = {
    schemaVersion: 6,
    id: 'wf-wait',
    name: 'Wait',
    inputs: [{ name: 'tone', options: ['Friendly', 'Formal'] }],
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      { id: 'gate', type: 'approval', position: { x: 0, y: 100 }, config: {} },
      { id: 'end', type: 'end', position: { x: 0, y: 200 }, config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'gate' },
      { id: 'e2', source: 'gate', target: 'end' },
    ],
  };
  await backend.saveWorkflow(workflow);
  const { runId } = await backend.runWorkflow('wf-wait', { tone: ' Formal ' });
  await waitFor(
    async () => {
      expect((await backend.getRun(runId))?.status).toBe('paused');
    },
    { timeout: 5000 },
  );
  const run = await backend.getRun(runId);
  if (run === null) throw new Error('run missing');
  expect(run.inputs?.tone).toBe('Formal');
  const list = vi.spyOn(backend, 'listRunFiles');
  render(<RunFilesPanel key={run.id} run={run} refreshKey="0" />);
  const panel = await screen.findByRole('region', { name: 'Run files' });
  expect(
    within(panel).getByText('Nothing written in this run’s folders yet.'),
  ).toBeInTheDocument();
  const calls = list.mock.calls.length;
  await userEvent
    .setup()
    .click(within(panel).getByRole('button', { name: 'Refresh files' }));
  await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(calls));
});

it('fills ticket variables from a GitHub issue in the browser preview', async () => {
  const backend = __setMockBackendForTests();
  const profile = await backend.saveAgentProfile(createDefaultProfile('claude'));
  const workflow: Workflow = {
    schemaVersion: 6,
    id: 'wf-issue',
    name: 'Issue',
    defaults: { repoDir: '/repo' },
    inputs: [{ name: 'issueNumber', required: true }],
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'issue',
        type: 'github',
        position: { x: 0, y: 100 },
        config: { githubOp: { op: 'issueDetails', number: 0 } },
      },
      {
        id: 'impl',
        type: 'agent',
        position: { x: 0, y: 200 },
        config: {
          agentProfileId: profile.id,
          prompt: 'Implement {{ticket.key}}: {{ticket.title}}',
        },
      },
      { id: 'end', type: 'end', position: { x: 0, y: 300 }, config: {} },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'issue' },
      { id: 'e2', source: 'issue', target: 'impl' },
      { id: 'e3', source: 'impl', target: 'end' },
    ],
  };
  await backend.saveWorkflow(workflow);
  const { runId } = await backend.runWorkflow('wf-issue', { issueNumber: '#42' });
  await waitFor(
    async () => {
      expect((await backend.getRun(runId))?.status).toBe('succeeded');
    },
    { timeout: 5000 },
  );
  const rows = await backend.getRunResults(runId);
  expect(rows.find((r) => r.nodeId === 'impl')?.stdout).toContain(
    'Implement #42: Mock issue 42',
  );
});
