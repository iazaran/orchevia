import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EnvironmentView } from './EnvironmentView';
import { useAppStore } from '../store';
import { __setMockBackendForTests } from '../lib/backend';

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
