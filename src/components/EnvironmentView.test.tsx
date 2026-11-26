import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EnvironmentView } from './EnvironmentView';
import { useAppStore } from '../store';
import { __setMockBackendForTests } from '../lib/backend';
import { MCP_PRESETS } from '../lib/integrations';

afterEach(() => vi.restoreAllMocks());

it('checks only the presence of the Slack token variables', async () => {
  const backend = __setMockBackendForTests();
  const check = vi.spyOn(backend, 'mcpEnvPresent');
  useAppStore.setState({ mcpServers: [], tools: [], adapters: [], profiles: [] });
  render(<EnvironmentView />);
  fireEvent.click(screen.getByRole('button', { name: '+ New MCP server' }));
  fireEvent.click(screen.getByRole('button', { name: 'Set up Slack' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check what Orchevia sees' }));
  expect(check).toHaveBeenCalledWith(['SLACK_MCP_XOXP_TOKEN', 'SLACK_MCP_XOXB_TOKEN']);
  expect(await screen.findByText(/✕ SLACK_MCP_XOXB_TOKEN/)).toBeInTheDocument();
});

it('prefills Google Workspace in the server form and waits for Save and an explicit check', async () => {
  const backend = __setMockBackendForTests();
  const save = vi.spyOn(backend, 'saveMcpServer');
  const check = vi.spyOn(backend, 'mcpCheckServer');
  useAppStore.setState({ mcpServers: [], tools: [], adapters: [], profiles: [] });
  render(<EnvironmentView />);
  // Setups live in the server form, not as cards on the page.
  expect(screen.queryByRole('button', { name: 'Set up Google Workspace' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '+ New MCP server' }));
  const editor = screen.getByRole('dialog', { name: 'MCP server editor' });
  fireEvent.change(within(editor).getByLabelText('Search MCP setups'), {
    target: { value: 'gmail' },
  });
  fireEvent.click(
    within(editor).getByRole('button', { name: 'Set up Google Workspace' }),
  );
  expect(within(editor).getByLabelText('Command')).toHaveValue('uvx');
  expect(within(editor).getByLabelText(/Arguments/)).toHaveValue(
    'workspace-mcp\n--tools\ngmail\ndrive\ncalendar\ndocs\nsheets\n--read-only',
  );
  expect(within(editor).getByText(/export GOOGLE_OAUTH_CLIENT_ID=/)).toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(within(editor).getByRole('button', { name: 'Save server' }));
  await screen.findByText("Saved MCP server 'Google Workspace'.");
  expect(save).toHaveBeenCalledTimes(1);
  expect(check).not.toHaveBeenCalled();
});

it('refuses to save a setup until its placeholder is replaced', async () => {
  const backend = __setMockBackendForTests();
  const save = vi.spyOn(backend, 'saveMcpServer');
  useAppStore.setState({ mcpServers: [], tools: [], adapters: [], profiles: [] });
  render(<EnvironmentView />);
  fireEvent.click(screen.getByRole('button', { name: '+ New MCP server' }));
  fireEvent.click(screen.getByRole('button', { name: 'Set up Filesystem' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save server' }));
  expect(
    await screen.findByText(/Replace \/path\/to\/folder in the arguments/),
  ).toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
});

it('shows the setup guide again when editing a server made from a preset', () => {
  __setMockBackendForTests();
  const server = {
    id: 'm1',
    name: 'Docs',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    enabled: true,
  };
  useAppStore.setState({ mcpServers: [server], tools: [], adapters: [], profiles: [] });
  render(<EnvironmentView />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  const editor = screen.getByRole('dialog', { name: 'MCP server editor' });
  expect(within(editor).getByText('Fetch web pages')).toBeInTheDocument();
  expect(within(editor).getByLabelText('Name')).toHaveValue('Docs');
});

it('checks an MCP server only when asked and shows what to do next', async () => {
  const backend = __setMockBackendForTests();
  const server = {
    id: 'jira',
    name: 'Jira MCP',
    command: 'uvx',
    args: ['mcp-atlassian'],
    enabled: true,
  };
  await backend.saveMcpServer(server);
  const check = vi.spyOn(backend, 'mcpCheckServer');
  useAppStore.setState({ mcpServers: [server], tools: [], adapters: [], profiles: [] });
  render(<EnvironmentView />);
  expect(check).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Check server' }));
  const list = await screen.findByRole('list', { name: 'Server check for Jira MCP' });
  expect(check).toHaveBeenCalledWith('jira');
  expect(within(list).getByText('Program found')).toBeInTheDocument();
  expect(
    within(list).getByText('Run the desktop app to check this server.'),
  ).toBeInTheDocument();
  expect(within(list).getAllByText('Skipped')).toHaveLength(3);
});

it('puts every section action in a row under its explanation', () => {
  // v0.3.1 pushed + New MCP server and the setup guide to the far right of the
  // window, and ran Manage profiles into the sentence before it. Since v0.3.3
  // + New MCP server sits at the top of the page.
  __setMockBackendForTests();
  useAppStore.setState({
    mcpServers: [],
    tools: [],
    adapters: [
      {
        id: 'claude',
        displayName: 'Claude Code',
        defaultExecutable: 'claude',
        supportsModelFlag: true,
        supportsSessionResume: true,
        notes: '',
      },
    ],
    profiles: [],
  });
  render(<EnvironmentView />);
  const newServer = screen.getByRole('button', { name: '+ New MCP server' });
  expect(newServer.parentElement).toHaveClass('topbar-actions');
  for (const name of ['MCP setup guide', 'Agents', 'Export diagnostics bundle']) {
    const row = screen.getByRole('button', { name }).parentElement as HTMLElement;
    expect(row, name).toHaveClass('section-actions');
    expect(row.previousElementSibling, name).toHaveClass('section-hint');
  }
  // The arrow is decoration: the button is announced as "Agents".
  expect(screen.getByRole('button', { name: 'Agents' })).toHaveTextContent('Agents →');
});

it('names the server when listing its tools fails', async () => {
  const backend = __setMockBackendForTests();
  vi.spyOn(backend, 'mcpListTools').mockRejectedValue(new Error('spawn uvx ENOENT'));
  useAppStore.setState({
    mcpServers: [{ id: 'jira', name: 'Jira', command: 'uvx', args: [], enabled: true }],
    tools: [],
    adapters: [],
    profiles: [],
  });
  render(<EnvironmentView />);
  fireEvent.click(screen.getByRole('button', { name: 'List tools' }));
  expect(
    await screen.findByText(/Listing tools for Jira failed: .*spawn uvx ENOENT/),
  ).toBeInTheDocument();
});

it('orders the page Agents, MCP servers, local tools, then maintenance, with a jump bar', () => {
  __setMockBackendForTests();
  useAppStore.setState({ mcpServers: [], tools: [], adapters: [], profiles: [] });
  render(<EnvironmentView />);
  const titles = screen
    .getAllByRole('heading', { level: 2 })
    .map((heading) => heading.textContent);
  expect(titles).toEqual([
    'Agents',
    'MCP servers (0)',
    'Local tools',
    'Workspace',
    'Updates',
    'Diagnostics',
  ]);
  const jump = screen.getByRole('navigation', { name: 'Environment sections' });
  expect(
    within(jump)
      .getAllByRole('link')
      .map((b) => b.textContent),
  ).toEqual([
    'Agents',
    'MCP servers',
    'Local tools',
    'Workspace',
    'Updates',
    'Diagnostics',
  ]);
  const agents = screen.getByRole('region', { name: 'Agents' });
  expect(
    within(agents)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent),
  ).toEqual(['Permissions', 'Abilities from your own setup', 'Setup check']);
});

it('leaves setups already connected out of the new server list, even under an old name', () => {
  __setMockBackendForTests();
  // The v0.3.0 "Jira" setup: no --read-only, and the old name.
  const jira = {
    id: 'mcp-old',
    name: 'Jira',
    command: 'uvx',
    args: ['mcp-atlassian'],
    enabled: true,
  };
  useAppStore.setState({ mcpServers: [jira], tools: [], adapters: [], profiles: [] });
  render(<EnvironmentView />);
  fireEvent.click(screen.getByRole('button', { name: '+ New MCP server' }));
  const editor = screen.getByRole('dialog', { name: 'MCP server editor' });
  expect(
    within(editor).queryByRole('button', { name: 'Set up Jira & Confluence' }),
  ).toBeNull();
  expect(
    within(editor).getByRole('button', { name: 'Set up Slack' }),
  ).toBeInTheDocument();
  expect(
    within(editor).getByText(/Hidden because you already set them up/),
  ).toHaveTextContent('Jira & Confluence (as “Jira”)');
  fireEvent.click(within(editor).getByRole('button', { name: 'Add another one' }));
  expect(
    within(editor).getByRole('button', { name: 'Set up Jira & Confluence' }),
  ).toHaveTextContent('Set up');
});

it('offers to update a server saved from an older setup, and saves it under the same id', async () => {
  const backend = __setMockBackendForTests();
  const save = vi.spyOn(backend, 'saveMcpServer');
  const jira = {
    id: 'mcp-old',
    name: 'Jira',
    command: 'uvx',
    args: ['mcp-atlassian'],
    enabled: true,
  };
  useAppStore.setState({ mcpServers: [jira], tools: [], adapters: [], profiles: [] });
  render(<EnvironmentView />);
  expect(screen.getByText('From the Jira & Confluence setup')).toBeInTheDocument();
  const changes = screen.getByRole('list', { name: 'Changes to Jira' });
  expect(changes).toHaveTextContent('Name: “Jira” → becomes “Jira & Confluence”');
  expect(changes).toHaveTextContent(
    'Command: uvx mcp-atlassian → becomes uvx mcp-atlassian --read-only',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Review the update' }));
  const editor = screen.getByRole('dialog', { name: 'MCP server editor' });
  expect(within(editor).getByLabelText('Name')).toHaveValue('Jira & Confluence');
  expect(within(editor).getByLabelText(/Arguments/)).toHaveValue(
    'mcp-atlassian\n--read-only',
  );
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(within(editor).getByRole('button', { name: 'Save server' }));
  await screen.findByText("Saved MCP server 'Jira & Confluence'.");
  expect(save).toHaveBeenCalledWith({
    id: 'mcp-old',
    name: 'Jira & Confluence',
    command: 'uvx',
    args: ['mcp-atlassian', '--read-only'],
    enabled: true,
  });
});

it('keeps an older server as it is once the update is dismissed', () => {
  __setMockBackendForTests();
  localStorage.clear();
  const jira = {
    id: 'j',
    name: 'Jira',
    command: 'uvx',
    args: ['mcp-atlassian'],
    enabled: true,
  };
  useAppStore.setState({ mcpServers: [jira], tools: [], adapters: [], profiles: [] });
  const { unmount } = render(<EnvironmentView />);
  fireEvent.click(screen.getByRole('button', { name: "Keep 'Jira' as it is" }));
  expect(screen.queryByRole('button', { name: 'Review the update' })).toBeNull();
  unmount();
  render(<EnvironmentView />);
  expect(screen.queryByRole('button', { name: 'Review the update' })).toBeNull();
  localStorage.clear();
});

it('hides a listed tool list and a check result again with the same button', async () => {
  const backend = __setMockBackendForTests();
  vi.spyOn(backend, 'mcpListTools').mockResolvedValue([
    { name: 'jira_get_issue', description: 'Get a Jira issue' },
  ]);
  const server = { id: 'jira', name: 'Jira', command: 'uvx', args: [], enabled: true };
  await backend.saveMcpServer(server);
  useAppStore.setState({ mcpServers: [server], tools: [], adapters: [], profiles: [] });
  render(<EnvironmentView />);
  fireEvent.click(screen.getByRole('button', { name: 'List tools' }));
  expect(await screen.findByText('jira_get_issue')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Hide tools' }));
  expect(screen.queryByText('jira_get_issue')).toBeNull();
  expect(screen.getByRole('button', { name: 'List tools' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Check server' }));
  await screen.findByRole('list', { name: 'Server check for Jira' });
  fireEvent.click(screen.getByRole('button', { name: 'Hide check' }));
  expect(screen.queryByRole('list', { name: 'Server check for Jira' })).toBeNull();
});

it('moves keyboard focus to the section a jump link names', () => {
  __setMockBackendForTests();
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  useAppStore.setState({ mcpServers: [], tools: [], adapters: [], profiles: [] });
  render(<EnvironmentView />);
  fireEvent.click(screen.getByRole('link', { name: 'Diagnostics' }));
  expect(scroll).toHaveBeenCalled();
  expect(document.activeElement).toBe(document.getElementById('env-diagnostics'));
});

it('shows a new offer for a server after an earlier one was dismissed', () => {
  __setMockBackendForTests();
  localStorage.clear();
  const jira = {
    id: 'j',
    name: 'Jira',
    command: 'uvx',
    args: ['mcp-atlassian'],
    enabled: true,
  };
  useAppStore.setState({ mcpServers: [jira], tools: [], adapters: [], profiles: [] });
  render(<EnvironmentView />);
  fireEvent.click(screen.getByRole('button', { name: "Keep 'Jira' as it is" }));
  expect(screen.queryByRole('button', { name: 'Review the update' })).toBeNull();
  // The user adds --read-only themselves: only the old name is left to offer.
  act(() => {
    useAppStore.setState({
      mcpServers: [{ ...jira, args: ['mcp-atlassian', '--read-only'] }],
    });
  });
  expect(screen.getByRole('list', { name: 'Changes to Jira' })).toHaveTextContent(
    'Name: “Jira” → becomes “Jira & Confluence”',
  );
  localStorage.clear();
});

it('says so when every setup of a category is already set up', () => {
  __setMockBackendForTests();
  const servers = MCP_PRESETS.filter(
    (preset) => preset.category === 'Code & tickets',
  ).map((preset) => ({
    id: preset.id,
    name: preset.name,
    command: preset.command,
    args: [...preset.args],
    enabled: true,
  }));
  useAppStore.setState({ mcpServers: servers, tools: [], adapters: [], profiles: [] });
  render(<EnvironmentView />);
  fireEvent.click(screen.getByRole('button', { name: '+ New MCP server' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Code & tickets' }));
  expect(screen.getByText(/You already set up every setup here/)).toBeInTheDocument();
  expect(screen.queryByText(/No setup matches/)).toBeNull();
});

it('chooses where folderless steps run and lists media tools apart', async () => {
  const backend = __setMockBackendForTests();
  useAppStore.setState({
    mcpServers: [],
    adapters: [],
    profiles: [],
    workspaceRoot: '~/Documents/Orchevia',
    tools: [
      { id: 'git', displayName: 'Git', installed: true },
      { id: 'ffmpeg', displayName: 'FFmpeg', installed: false },
    ],
  });
  render(<EnvironmentView />);
  const media = screen.getByRole('heading', { name: 'Media and documents' });
  expect(media).toBeInTheDocument();
  expect(
    screen.getByText('sudo apt install ffmpeg · brew install ffmpeg'),
  ).toBeInTheDocument();
  const workspace = screen.getByRole('region', { name: 'Workspace' });
  const field = within(workspace).getByLabelText(/Workspace folder/);
  fireEvent.change(field, { target: { value: 'relative/folder' } });
  fireEvent.click(within(workspace).getByRole('button', { name: 'Save folder' }));
  await waitFor(() => {
    expect(noticeTexts()).toContain('The workspace folder must be an absolute path.');
  });
  expect(await backend.getSetting('workspace.root')).toBeNull();
  fireEvent.change(field, { target: { value: '/data/orchevia' } });
  fireEvent.click(within(workspace).getByRole('button', { name: 'Save folder' }));
  await waitFor(() => {
    expect(noticeTexts()).toContain('Workspace folder saved. New runs use it.');
  });
  expect(await backend.getSetting('workspace.root')).toBe('/data/orchevia');
  expect(useAppStore.getState().workspaceRoot).toBe('/data/orchevia');
  fireEvent.click(within(workspace).getByRole('button', { name: 'Use the default' }));
  await waitFor(() => {
    expect(noticeTexts()).toContain('Workspace folder set back to the default.');
  });
  expect(useAppStore.getState().workspaceRoot).toBe('~/Documents/Orchevia');
});

function noticeTexts(): string[] {
  return useAppStore.getState().uiNotices.map((n) => n.text ?? '');
}
