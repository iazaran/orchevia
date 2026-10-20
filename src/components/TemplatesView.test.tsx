import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __setMockBackendForTests } from '../lib/backend';
import { useAppStore } from '../store';
import { createDefaultProfile, recommendedProfiles } from '../lib/agents';
import { TemplatesView } from './TemplatesView';

afterEach(() => vi.restoreAllMocks());

it('creates a template from pasted workflow JSON with no selected workflow', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  useAppStore.setState({
    builtinTemplates: [],
    userTemplates: [],
    activeWorkflowId: null,
  });
  const before = await backend.listWorkflows();
  render(<TemplatesView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Import JSON…' }));
  const text = JSON.stringify({
    version: 1,
    name: 'Direct template',
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [{ from: 'start', to: 'end' }],
  });
  await user.click(screen.getByRole('textbox', { name: 'Workflow or template JSON' }));
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: 'Import into my library' }));
  expect(
    await screen.findByText("Imported template 'Direct template'."),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Direct template' })).toBeInTheDocument(),
  );
  expect(useAppStore.getState().activeWorkflowId).toBeNull();
  expect(await backend.listWorkflows()).toEqual(before);
});

it('leaves invalid pasted JSON editable with a clear validation error', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  useAppStore.setState({
    builtinTemplates: [],
    userTemplates: [],
    activeWorkflowId: null,
  });
  render(<TemplatesView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Import JSON…' }));
  const input = screen.getByRole('textbox', { name: 'Workflow or template JSON' });
  await user.click(input);
  const text = JSON.stringify({ version: 1, name: 'Broken', nodes: [], edges: [] });
  await user.paste(text);
  await user.click(screen.getByRole('button', { name: 'Import into my library' }));
  expect(await screen.findByText('Template workflow has no nodes.')).toBeInTheDocument();
  expect(input).toHaveValue(text);
  expect((await backend.listTemplates()).user).toHaveLength(0);
});

it('lists declared tools the mapped profile lacks right after import', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const reviewer = {
    ...createDefaultProfile('claude'),
    id: 'prof-review',
    name: 'Reviewer',
    role: 'deepReview',
  };
  await backend.saveAgentProfile(reviewer);
  useAppStore.setState({
    builtinTemplates: [],
    userTemplates: [],
    activeWorkflowId: null,
    profiles: [reviewer],
  });
  render(<TemplatesView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Import JSON…' }));
  await user.click(screen.getByRole('textbox', { name: 'Workflow or template JSON' }));
  await user.paste(
    JSON.stringify({
      version: 1,
      name: 'Ticket review',
      workflow: {
        version: 1,
        name: 'Ticket review',
        nodes: [
          { key: 'start', type: 'start', config: {} },
          {
            key: 'review',
            type: 'agent',
            role: 'deepReview',
            config: { prompt: 'Review', requiredTools: ['mcp__jira'] },
          },
          { key: 'end', type: 'end', config: {} },
        ],
        edges: [
          { from: 'start', to: 'review' },
          { from: 'review', to: 'end' },
        ],
      },
    }),
  );
  await user.click(screen.getByRole('button', { name: 'Import into my library' }));
  const list = await screen.findByRole('list', { name: 'Tools not granted' });
  expect(list).toHaveTextContent('Reviewer');
  expect(list).toHaveTextContent('mcp__jira');
  expect(
    screen.getByRole('button', { name: 'Add to allowed tools' }),
  ).toBeInTheDocument();
});

it('asks for the repository before creating a workflow from a template', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  for (const profile of recommendedProfiles([])) await backend.saveAgentProfile(profile);
  const jira = { id: 'jira', name: 'Jira', command: 'uvx', args: [], enabled: true };
  await backend.saveMcpServer(jira);
  const { builtin } = await backend.listTemplates();
  useAppStore.setState({
    builtinTemplates: builtin,
    userTemplates: [],
    activeWorkflowId: null,
    profiles: await backend.listAgentProfiles(),
    mcpServers: [jira],
    knownFolders: [],
    view: 'templates',
  });
  render(<TemplatesView />);
  const user = userEvent.setup();
  const card = screen.getByRole('heading', { name: 'Ticket to Draft PR' }).parentElement;
  if (!card) throw new Error('template card');
  await user.click(within(card).getByRole('button', { name: 'Use template' }));
  const dialog = await screen.findByRole('dialog', {
    name: 'Use template Ticket to Draft PR',
  });
  const create = within(dialog).getByRole('button', { name: 'Create workflow' });
  expect(create).toBeDisabled();
  expect(within(dialog).getByRole('combobox', { name: 'Jira / MCP server' })).toHaveValue(
    'jira',
  );
  expect(dialog).toHaveTextContent('Jira ticket key or URL');
  await user.type(
    within(dialog).getByRole('textbox', { name: 'Repository folder (required)' }),
    '/work/shop',
  );
  await user.click(create);
  await waitFor(() => expect(useAppStore.getState().view).toBe('workflows'));
  const created = (await backend.listWorkflows()).find(
    (w) => w.name === 'Ticket to Draft PR',
  );
  expect(created?.definition.defaults?.repoDir).toBe('/work/shop');
  for (const node of created?.definition.nodes.filter((n) => n.type === 'ticket') ?? [])
    expect(node.config.mcpServerId).toBe('jira');
  expect(useAppStore.getState().activeWorkflowId).toBe(created?.id);
});
