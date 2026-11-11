import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EnvironmentView } from './EnvironmentView';
import { useAppStore } from '../store';
import { __setMockBackendForTests } from '../lib/backend';

afterEach(() => vi.restoreAllMocks());

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
