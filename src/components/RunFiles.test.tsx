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
