import { afterEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    agentPermissionDefault: 'cliSettings',
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
  useAppStore.setState({ agentPermissionDefault: null });
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
    agentPermissionDefault: null,
    mcpServers: [jira],
    knownFolders: [],
    view: 'templates',
  });
  render(<TemplatesView />);
  const user = userEvent.setup();
  const card = screen
    .getByRole('heading', { name: 'Ticket to Draft PR' })
    .closest<HTMLElement>('.template-card');
  if (!card) throw new Error('template card');
  await user.click(within(card).getByRole('button', { name: 'Use template' }));
  const dialog = await screen.findByRole('dialog', {
    name: 'Use template Ticket to Draft PR',
  });
  const create = within(dialog).getByRole('button', { name: 'Create workflow' });
  expect(create).toBeDisabled();
  expect(within(dialog).getByRole('combobox', { name: 'MCP server' })).toHaveValue(
    'jira',
  );
  expect(dialog).toHaveTextContent('Expects the Jira & Confluence or Shortcut setup');
  expect(dialog).toHaveTextContent('Jira ticket key or URL');
  // The one-time agent permissions question comes with the first template.
  expect(dialog).toHaveTextContent('Let AI agents work without asking?');
  await user.click(
    within(dialog).getByRole('button', { name: 'Let agents work without asking' }),
  );
  await waitFor(() =>
    expect(dialog).not.toHaveTextContent('Let AI agents work without asking?'),
  );
  expect(await backend.getSetting('agents.permissionDefault')).toBe('fullAccess');
  // Full access covers the template's declared tools: nothing left to grant.
  expect(dialog).not.toHaveTextContent('declares tools');
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
  useAppStore.setState({ agentPermissionDefault: null });
});

it('keeps a saved template’s repository and default branch when it is used', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const saved = await backend.saveUserTemplate({
    id: 'user-defaults',
    version: 1,
    name: 'Saved defaults',
    description: 'Runs one command.',
    category: 'general',
    workflow: {
      schemaVersion: 6,
      id: 'tpl-saved',
      name: 'Saved defaults',
      defaults: { repoDir: '/saved/repo', branch: 'develop' },
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'say',
          type: 'command',
          position: { x: 0, y: 100 },
          config: { executable: 'echo', args: ['hi'] },
        },
        { id: 'end', type: 'end', position: { x: 0, y: 200 }, config: {} },
      ],
      edges: [
        { id: 'a', source: 'start', target: 'say' },
        { id: 'b', source: 'say', target: 'end' },
      ],
    },
  });
  useAppStore.setState({
    builtinTemplates: [],
    userTemplates: [saved],
    activeWorkflowId: null,
    profiles: [],
    mcpServers: [],
    knownFolders: ['/elsewhere'],
    view: 'templates',
  });
  render(<TemplatesView />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Use template' }));
  const dialog = await screen.findByRole('dialog', {
    name: 'Use template Saved defaults',
  });
  expect(
    within(dialog).getByRole('textbox', { name: 'Repository folder (required)' }),
  ).toHaveValue('/saved/repo');
  await user.click(within(dialog).getByRole('button', { name: 'Create workflow' }));
  await waitFor(() => expect(useAppStore.getState().view).toBe('workflows'));
  const created = (await backend.listWorkflows()).find(
    (w) => w.name === 'Saved defaults',
  );
  expect(created?.definition.defaults).toEqual({
    repoDir: '/saved/repo',
    branch: 'develop',
  });
});

it('creates an MCP research workflow without asking for a repository', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  for (const profile of recommendedProfiles([])) await backend.saveAgentProfile(profile);
  const fetch = {
    id: 'fetch',
    name: 'Fetch',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    enabled: true,
  };
  await backend.saveMcpServer(fetch);
  const { builtin } = await backend.listTemplates();
  useAppStore.setState({
    builtinTemplates: builtin,
    userTemplates: [],
    activeWorkflowId: null,
    profiles: await backend.listAgentProfiles(),
    agentPermissionDefault: 'cliSettings',
    mcpServers: [fetch],
    knownFolders: ['/somewhere'],
    view: 'templates',
  });
  render(<TemplatesView />);
  const user = userEvent.setup();
  const card = screen
    .getByRole('heading', { name: 'Summarize a Web Page' })
    .closest<HTMLElement>('.template-card');
  if (!card) throw new Error('template card');
  expect(within(card).getByText('MCP')).toBeInTheDocument();
  await user.click(within(card).getByRole('button', { name: 'Use template' }));
  const dialog = await screen.findByRole('dialog', {
    name: 'Use template Summarize a Web Page',
  });
  expect(within(dialog).queryByLabelText(/Repository folder/)).toBeNull();
  // Agent steps may still use a folder: offered, not required.
  expect(within(dialog).getByLabelText('Project folder (optional)')).toHaveValue('');
  expect(dialog).toHaveTextContent('Expects the Fetch web pages setup');
  await user.click(within(dialog).getByRole('button', { name: 'Create workflow' }));
  await waitFor(async () => {
    const created = (await backend.listWorkflows()).find(
      (w) => w.name === 'Summarize a Web Page',
    );
    expect(
      created?.definition.nodes.find((n) => n.type === 'mcp')?.config.mcpServerId,
    ).toBe('fetch');
    expect(created?.definition.defaults?.repoDir).toBeUndefined();
  });
});

it('filters templates by kind and search, and content needs no repository', async () => {
  __setMockBackendForTests();
  const { builtinTemplates } = await import('../lib/templates');
  useAppStore.setState({
    builtinTemplates: builtinTemplates(),
    userTemplates: [],
    templateDomain: 'all',
    workspaceRoot: '/home/me/Documents/Orchevia',
    knownFolders: ['/home/me/code/app'],
    tools: [{ id: 'ffmpeg', displayName: 'FFmpeg', installed: false }],
  });
  render(<TemplatesView />);
  // Grouped by kind with nothing filtered.
  expect(
    screen.getByRole('heading', { level: 3, name: 'Content & marketing' }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^Media & design/ }));
  expect(useAppStore.getState().templateDomain).toBe('media');
  expect(screen.getByRole('heading', { name: 'Social Video Cuts' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Implement a Task' })).toBeNull();
  // FFmpeg is missing on this machine.
  expect(screen.getByTitle(/FFmpeg was not found/)).toHaveTextContent('✕ FFmpeg');
  fireEvent.click(screen.getByRole('button', { name: /^All/ }));
  fireEvent.change(screen.getByLabelText('Search templates'), {
    target: { value: 'launch email' },
  });
  expect(screen.getByRole('heading', { name: 'Product Launch Kit' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Blog Post from a Brief' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Search templates'), {
    target: { value: 'nothing-matches-this' },
  });
  expect(screen.getByText('No templates match.')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Search templates'), {
    target: { value: 'blog' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Use template' }));
  const dialog = screen.getByRole('dialog', { name: /Use template Blog Post/ });
  // A content template never borrows a code repository.
  const folder = within(dialog).getByLabelText('Project folder (optional)');
  expect(folder).toHaveValue('');
  expect(folder).toHaveAttribute(
    'placeholder',
    'Blank: a new folder in /home/me/Documents/Orchevia',
  );
});
