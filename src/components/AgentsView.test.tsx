import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __setMockBackendForTests } from '../lib/backend';
import { useAppStore } from '../store';
import { AgentsView } from './AgentsView';
import { ConfirmHost } from './ConfirmDialog';
import { createDefaultProfile } from '../lib/agents';

describe('agent profile skills', () => {
  it('keeps usage reporting in Usage & costs rather than duplicating it in Agents', async () => {
    __setMockBackendForTests();
    useAppStore.setState({
      profiles: [{ ...createDefaultProfile('claude'), name: 'Configured profile' }],
      adapters: [],
      tools: [],
      knownFolders: [],
    });
    await act(async () => {
      render(<AgentsView />);
      await Promise.resolve();
    });
    expect(screen.getByText('Configured profile')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Agent usage' })).not.toBeInTheDocument();
  });

  it('saves a manually selected skill from the profile editor', async () => {
    const backend = __setMockBackendForTests();
    useAppStore.setState({ profiles: [], adapters: [], tools: [], knownFolders: [] });
    const user = userEvent.setup();
    render(<AgentsView />);

    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.type(screen.getByLabelText('Skills (optional)'), 'code-review');
    await user.click(screen.getByRole('button', { name: 'Add skill' }));
    expect(screen.getByRole('button', { name: 'code-review · Remove' })).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(async () => {
      const profiles = await backend.listAgentProfiles();
      expect(profiles[0]?.skills).toEqual(['code-review']);
    });
  });
});

describe('agent profile permissions', () => {
  it('saves allowed tools and confirms before granting full access', async () => {
    localStorage.clear();
    const backend = __setMockBackendForTests();
    useAppStore.setState({ profiles: [], adapters: [], tools: [], knownFolders: [] });
    const user = userEvent.setup();
    render(
      <>
        <AgentsView />
        <ConfirmHost />
      </>,
    );

    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    const level = screen.getByLabelText('Permissions');
    // New profiles keep the Claude Code settings: no flag, nothing widened.
    expect(level).toHaveValue('cliSettings');
    await user.selectOptions(level, 'allowedTools');
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeDisabled();
    await user.type(
      screen.getByLabelText('Allowed tools (one per line)'),
      'mcp__jira{Enter}Bash(git status *)',
    );
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(async () => {
      const [saved] = await backend.listAgentProfiles();
      expect(saved?.permissionLevel).toBe('allowedTools');
      expect(saved?.allowedTools).toEqual(['mcp__jira', 'Bash(git status *)']);
    });
    expect(await screen.findByText('Allowed tools (2)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.selectOptions(screen.getByLabelText('Permissions'), 'fullAccess');
    expect(screen.getByText(/skips every permission check/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    // Cancelling the confirmation keeps the narrower setting.
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent("Give 'Claude — Implementation' full access?");
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect((await backend.listAgentProfiles())[0]?.permissionLevel).toBe('allowedTools');
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await user.click(await screen.findByRole('button', { name: 'Allow full access' }));
    await waitFor(async () => {
      expect((await backend.listAgentProfiles())[0]?.permissionLevel).toBe('fullAccess');
    });
  });

  it('offers Codex only the levels its CLI can express', async () => {
    __setMockBackendForTests();
    useAppStore.setState({ profiles: [], adapters: [], tools: [], knownFolders: [] });
    const user = userEvent.setup();
    render(<AgentsView />);
    await user.selectOptions(screen.getByLabelText('Adapter for new profile'), 'codex');
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    const options = Array.from(
      screen.getByLabelText<HTMLSelectElement>('Permissions').options,
    ).map((option) => option.textContent);
    expect(options).toEqual(['Use Codex settings', 'Full access']);
  });
});
