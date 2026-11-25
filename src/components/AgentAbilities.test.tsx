import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __setMockBackendForTests } from '../lib/backend';
import { useAppStore } from '../store';
import { AgentAbilitiesPanel } from './AgentAbilities';
import { mockHostAbilities } from '../lib/abilities';
import { ConfirmHost } from './ConfirmDialog';
import type { ToolStatus } from '../lib/workflow';

const installed = (id: string): ToolStatus => ({
  id,
  displayName: id,
  installed: true,
});

function reset(): void {
  useAppStore.setState({
    tools: [installed('claude'), installed('codex')],
    workflows: [],
    agentPermissionDefault: 'cliSettings',
    agentAbilities: { browser: false },
    hostAbilities: {},
  });
}

describe('agent abilities', () => {
  it('lists what each CLI brings only when asked, and never sends a prompt', async () => {
    const backend = __setMockBackendForTests();
    const detect = vi.spyOn(backend, 'detectAgentAbilities');
    const setup = vi.spyOn(backend, 'checkAgentSetup');
    reset();
    const user = userEvent.setup();
    render(<AgentAbilitiesPanel />);
    expect(detect).not.toHaveBeenCalled();
    expect(screen.getAllByText('Not checked yet')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Find what my agents can use' }));
    expect(detect.mock.calls.map(([adapter]) => adapter)).toEqual(['claude', 'codex']);
    expect(setup).not.toHaveBeenCalled();
    const claude = await screen.findByRole('list', { name: 'Claude Code connectors' });
    expect(within(claude).getByText('Atlassian Rovo')).toBeInTheDocument();
    // Allowed in the user's own Claude settings (the demo data allows Atlassian).
    expect(within(claude).getByText('Allowed in settings')).toBeInTheDocument();
    expect(screen.getByText(/3 would be refused in a step/)).toBeInTheDocument();
    const codex = screen.getByRole('list', { name: 'Codex MCP servers' });
    expect(within(codex).getByText('aws-mcp')).toBeInTheDocument();
    expect(screen.getByText(/Plugins on: chrome, gmail/)).toBeInTheDocument();
  });

  it('saves the connectors steps may use and the web tools', async () => {
    const backend = __setMockBackendForTests();
    const save = vi.spyOn(backend, 'setSetting');
    reset();
    const user = userEvent.setup();
    render(<AgentAbilitiesPanel />);
    await user.click(screen.getByRole('button', { name: 'Find what my agents can use' }));
    await user.click(
      await screen.findByRole('switch', {
        name: 'Let workflow steps use claude.ai Gmail',
      }),
    );
    await waitFor(() => {
      expect(save).toHaveBeenLastCalledWith(
        'agents.abilities',
        '{"browser":false,"allowedTools":["mcp__claude_ai_Gmail"]}',
      );
    });
    await user.click(
      screen.getByRole('switch', { name: 'Let workflow steps search and read the web' }),
    );
    await waitFor(() => {
      expect(useAppStore.getState().agentAbilities.allowedTools).toEqual([
        'mcp__claude_ai_Gmail',
        'WebSearch',
        'WebFetch',
      ]);
    });
    await user.click(screen.getByRole('button', { name: 'Allow all 2' }));
    await waitFor(() => {
      expect(useAppStore.getState().agentAbilities.allowedTools).toContain(
        'mcp__aws-mcp',
      );
    });
    expect(await backend.getSetting('agents.abilities')).toContain(
      'mcp__claude_ai_Sentry',
    );
  });

  it('confirms before steps use the browser, and says full access needs no grants', async () => {
    __setMockBackendForTests();
    reset();
    useAppStore.setState({ agentPermissionDefault: 'fullAccess' });
    const user = userEvent.setup();
    render(
      <>
        <AgentAbilitiesPanel />
        <ConfirmHost />
      </>,
    );
    const browser = screen.getByRole('switch', {
      name: 'Let workflow steps use my browser',
    });
    await user.click(browser);
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('Let workflow steps use your browser?');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(useAppStore.getState().agentAbilities.browser).toBe(false);
    await user.click(browser);
    await user.click(await screen.findByRole('button', { name: 'Use my browser' }));
    await waitFor(() => {
      expect(useAppStore.getState().agentAbilities.browser).toBe(true);
    });
    expect(screen.getByText(/Steps run Claude Code with/)).toHaveTextContent('--chrome');
    await user.click(screen.getByRole('button', { name: 'Find what my agents can use' }));
    expect(
      await screen.findByText('Full access: steps can use all of them without asking.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: 'Let workflow steps use claude.ai Gmail' }),
    ).toBeNull();
  });

  it('warns about connectors a workflow names that Claude Code no longer lists', async () => {
    __setMockBackendForTests();
    reset();
    useAppStore.setState({
      workflows: [
        {
          id: 'w',
          name: 'Ticket to PR',
          createdAt: '',
          updatedAt: '',
          definition: {
            schemaVersion: 6,
            id: 'w',
            name: 'Ticket to PR',
            nodes: [
              {
                id: 'a',
                type: 'agent',
                position: { x: 0, y: 0 },
                config: { requiredTools: ['mcp__claude_ai_Atlassian_Rovo_2'] },
              },
            ],
            edges: [],
          },
        },
      ],
    });
    const user = userEvent.setup();
    render(<AgentAbilitiesPanel />);
    await user.click(screen.getByRole('button', { name: 'Find what my agents can use' }));
    const warning = await screen.findByText(
      'Workflows ask for MCP servers Claude Code does not list.',
    );
    expect(warning.parentElement).toHaveTextContent(
      'mcp__claude_ai_Atlassian_Rovo_2 in Ticket to PR — probably mcp__claude_ai_Atlassian_Rovo now.',
    );
  });

  it('shows why a detection failed', async () => {
    const backend = __setMockBackendForTests();
    vi.spyOn(backend, 'detectAgentAbilities').mockRejectedValue(
      new Error('spawn claude ENOENT'),
    );
    reset();
    useAppStore.setState({ tools: [installed('claude')] });
    const user = userEvent.setup();
    render(<AgentAbilitiesPanel />);
    await user.click(screen.getByRole('button', { name: 'Find what my agents can use' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('spawn claude ENOENT');
    expect(screen.getByText('Could not check')).toBeInTheDocument();
  });

  it('shows and removes stored grants even before Find, and warns only after a listing ran', async () => {
    const backend = __setMockBackendForTests();
    reset();
    const flow = {
      id: 'w',
      name: 'Ticket to PR',
      createdAt: '',
      updatedAt: '',
      definition: {
        schemaVersion: 6,
        id: 'w',
        name: 'Ticket to PR',
        nodes: [
          {
            id: 'a',
            type: 'agent' as const,
            position: { x: 0, y: 0 },
            config: { requiredTools: ['mcp__claude_ai_Atlassian_Rovo_2'] },
          },
        ],
        edges: [],
      },
    };
    useAppStore.setState({
      workflows: [flow],
      agentAbilities: {
        browser: false,
        allowedTools: ['mcp__claude_ai_Slack', 'WebSearch'],
      },
    });
    vi.spyOn(backend, 'detectAgentAbilities').mockResolvedValue({
      ...mockHostAbilities('claude'),
      connectors: [],
      connectorsListed: false,
      connectorsNote: '`claude mcp list` did not finish within 60 s.',
    });
    const user = userEvent.setup();
    render(<AgentAbilitiesPanel />);
    // Nothing detected yet: the stored grants are still listed.
    const stored = screen.getByRole('list', { name: 'Other allowed abilities' });
    expect(within(stored).getByText('mcp__claude_ai_Slack')).toBeInTheDocument();
    // Half of the web pair is not the web switch: it is listed too.
    expect(within(stored).getByText('WebSearch')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Stop allowing mcp__claude_ai_Slack' }),
    );
    await waitFor(() => {
      expect(useAppStore.getState().agentAbilities).toEqual({
        browser: false,
        allowedTools: ['WebSearch'],
      });
    });
    // A listing that failed says nothing about what is gone.
    await user.click(screen.getByRole('button', { name: 'Find what my agents can use' }));
    expect(
      (await screen.findAllByText(/did not finish within 60 s/)).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByText('Workflows ask for MCP servers Claude Code does not list.'),
    ).toBeNull();
  });

  it('names the enabled automations that would start using the browser', async () => {
    __setMockBackendForTests();
    reset();
    const profile = {
      id: 'p',
      name: 'Claude',
      adapter: 'claude' as const,
      extraArgs: [],
      workingDirMode: 'node' as const,
      defaultTimeoutSecs: 60,
    };
    const workflow = {
      id: 'w',
      name: 'Nightly',
      createdAt: '',
      updatedAt: '',
      definition: {
        schemaVersion: 6,
        id: 'w',
        name: 'Nightly',
        nodes: [
          {
            id: 'a',
            type: 'agent' as const,
            position: { x: 0, y: 0 },
            config: { agentProfileId: 'p' },
          },
        ],
        edges: [],
      },
    };
    const schedule = (
      name: string,
      enabled: boolean,
    ): { id: string; name: string; workflowId: string; enabled: boolean } => ({
      id: name,
      name,
      workflowId: 'w',
      enabled,
    });
    useAppStore.setState({
      profiles: [profile, { ...profile, id: 'off', browser: false }],
      workflows: [workflow],
      schedules: [
        schedule('Nightly review', true),
        schedule('Paused one', false),
      ] as never,
      watchers: [],
    });
    const user = userEvent.setup();
    render(
      <>
        <AgentAbilitiesPanel />
        <ConfirmHost />
      </>,
    );
    await user.click(
      screen.getByRole('switch', { name: 'Let workflow steps use my browser' }),
    );
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent(
      'These enabled automations will use it too, unattended: Nightly review.',
    );
    expect(confirm).not.toHaveTextContent('Paused one');
  });

  it('keeps a stored grant removable when its row only says Allowed', async () => {
    __setMockBackendForTests();
    reset();
    useAppStore.setState({
      agentPermissionDefault: 'fullAccess',
      agentAbilities: {
        browser: false,
        allowedTools: ['mcp__claude_ai_Gmail', 'WebFetch'],
      },
    });
    const user = userEvent.setup();
    render(<AgentAbilitiesPanel />);
    await user.click(screen.getByRole('button', { name: 'Find what my agents can use' }));
    await screen.findByRole('list', { name: 'Claude Code connectors' });
    // Full access shows no switches, so the stored rules are listed to remove.
    const stored = screen.getByRole('list', { name: 'Other allowed abilities' });
    expect(within(stored).getByText('mcp__claude_ai_Gmail')).toBeInTheDocument();
    expect(within(stored).getByText('WebFetch')).toBeInTheDocument();
  });
});
