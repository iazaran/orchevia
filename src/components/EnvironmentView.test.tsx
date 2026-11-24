import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EnvironmentView } from './EnvironmentView';
import { useAppStore } from '../store';
import { __setMockBackendForTests } from '../lib/backend';

afterEach(() => vi.restoreAllMocks());

it('checks only the presence of the Slack bot variable', async () => {
  const backend = __setMockBackendForTests();
  const check = vi.spyOn(backend, 'mcpEnvPresent');
  useAppStore.setState({ mcpServers: [], tools: [], adapters: [], profiles: [] });
  render(<EnvironmentView />);
  fireEvent.click(screen.getByRole('button', { name: 'Set up Slack' }));
  fireEvent.click(screen.getByRole('button', { name: 'Check what Orchevia sees' }));
  expect(check).toHaveBeenCalledWith(['SLACK_MCP_XOXB_TOKEN']);
  expect(await screen.findByText(/✕ SLACK_MCP_XOXB_TOKEN/)).toBeInTheDocument();
});

it('prefills a Gmail connection and waits for Save and an explicit check', async () => {
  const backend = __setMockBackendForTests();
  const save = vi.spyOn(backend, 'saveMcpServer');
  const check = vi.spyOn(backend, 'mcpCheckServer');
  useAppStore.setState({ mcpServers: [], tools: [], adapters: [], profiles: [] });
  render(<EnvironmentView />);
  fireEvent.click(screen.getByRole('button', { name: 'Set up Gmail' }));
  const editor = screen.getByRole('dialog', { name: 'MCP server editor' });
  expect(within(editor).getByLabelText('Command')).toHaveValue('gws-mcp-server');
  expect(within(editor).getByLabelText(/Arguments/)).toHaveValue(
    '--read-only\n--services\ngmail',
  );
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(within(editor).getByRole('button', { name: 'Save server' }));
  await screen.findByText("Saved MCP server 'Gmail'.");
  expect(save).toHaveBeenCalledTimes(1);
  expect(check).not.toHaveBeenCalled();
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
