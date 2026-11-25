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
    // New profiles follow the app default, which is the Claude Code settings
    // until the user chooses: no flag, nothing widened.
    expect(level).toHaveValue('appDefault');
    expect(screen.getByText(/Follows Environment → Agent permissions/)).toHaveTextContent(
      'now CLI settings, not chosen yet',
    );
    await user.selectOptions(level, 'allowedTools');
    // Nothing complains before the first Save; that Save names the missing list.
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Allowed tools needs at least one tool.',
    );
    expect(await backend.listAgentProfiles()).toEqual([]);
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
    expect(options).toEqual([
      'App default (CLI settings, not chosen yet)',
      'Use Codex settings',
      'Full access',
    ]);
  });

  it('shows what a profile at the app default runs with', async () => {
    __setMockBackendForTests();
    const profile = { ...createDefaultProfile('claude'), name: 'Follows default' };
    useAppStore.setState({
      profiles: [profile],
      agentPermissionDefault: 'fullAccess',
      adapters: [],
      tools: [],
      knownFolders: [],
    });
    const user = userEvent.setup();
    render(<AgentsView />);
    const fact = screen.getByText('App default · Full access');
    expect(fact).toHaveClass('profile-fact-risk');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(
      within(screen.getByLabelText('Permissions')).getByRole('option', {
        name: 'App default (Full access)',
      }),
    ).toBeInTheDocument();
    useAppStore.setState({ agentPermissionDefault: null });
  });
});

describe('agent setup check', () => {
  it('runs one profile check on request and shows each item with its hint', async () => {
    localStorage.clear();
    const backend = __setMockBackendForTests();
    const profile = await backend.saveAgentProfile({
      ...createDefaultProfile('claude'),
      name: 'Implementer',
    });
    let calls = 0;
    backend.checkAgentSetup = (id) => {
      calls += 1;
      return Promise.resolve({
        profileId: id,
        profileName: 'Implementer',
        status: 'warning',
        durationMs: 4200,
        items: [
          {
            id: 'installed',
            label: 'CLI installed',
            status: 'passed',
            detail: '/bin/claude',
          },
          {
            id: 'answered',
            label: 'Signed in and answering',
            status: 'passed',
            detail: 'Answered in 4s.',
          },
          {
            id: 'readFile',
            label: 'Reads files in its working folder',
            status: 'passed',
            detail: 'Read it.',
          },
          {
            id: 'editFile',
            label: 'Edits files without asking',
            status: 'warning',
            detail:
              'Under your Claude Code settings, steps that edit files will be refused.',
            hint: 'Give this profile `Full access` in Agents.',
          },
        ],
      });
    };
    useAppStore.setState({
      profiles: [profile],
      adapters: [],
      tools: [],
      knownFolders: [],
    });
    const user = userEvent.setup();
    render(<AgentsView />);

    expect(calls).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Check setup' }));
    const list = await screen.findByRole('list', { name: 'Setup check for Implementer' });
    expect(calls).toBe(1);
    expect(screen.getByText('Works, with limits')).toBeInTheDocument();
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[3]).toHaveTextContent('Limited');
    expect(within(items[3]!).getByText('Full access').tagName).toBe('CODE');
  });
});

describe('CLI setup help', () => {
  it('shows install commands for missing CLIs and creates a profile from a card', async () => {
    localStorage.clear();
    const backend = __setMockBackendForTests();
    useAppStore.setState({
      profiles: [],
      adapters: [
        {
          id: 'gemini',
          displayName: 'Gemini CLI',
          defaultExecutable: 'gemini',
          supportsModelFlag: true,
          supportsSessionResume: false,
          notes: 'Runs Gemini CLI headlessly.',
        },
        {
          id: 'codex',
          displayName: 'Codex',
          defaultExecutable: 'codex',
          supportsModelFlag: true,
          supportsSessionResume: true,
          notes: 'Streams tokens through Codex.',
        },
      ],
      tools: [{ id: 'codex', displayName: 'Codex', installed: true, version: '0.170.0' }],
      knownFolders: [],
    });
    const user = userEvent.setup();
    render(<AgentsView />);
    const clis = screen.getByRole('region', { name: 'Detected adapters' });
    expect(within(clis).getByText('npm install -g @google/gemini-cli')).toBeVisible();
    expect(within(clis).getByText('0.170.0')).toBeVisible();
    const buttons = within(clis).getAllByRole('button', { name: 'Create profile' });
    await user.click(buttons[1] ?? buttons[0] ?? clis);
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(async () =>
      expect((await backend.listAgentProfiles())[0]?.adapter).toBe('codex'),
    );
  });

  it('prefills a Custom CLI profile from a preset', async () => {
    localStorage.clear();
    const backend = __setMockBackendForTests();
    useAppStore.setState({ profiles: [], adapters: [], tools: [], knownFolders: [] });
    const user = userEvent.setup();
    render(<AgentsView />);
    await user.click(screen.getByRole('button', { name: 'Set up GitHub Copilot CLI' }));
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(async () =>
      expect((await backend.listAgentProfiles())[0]).toMatchObject({
        adapter: 'custom',
        name: 'GitHub Copilot CLI',
        executable: 'copilot',
        extraArgs: ['-s', '-p'],
      }),
    );
  });
});

describe('agent profile browser', () => {
  it('follows the app default, and confirms before a profile uses the browser', async () => {
    localStorage.clear();
    const backend = __setMockBackendForTests();
    useAppStore.setState({
      profiles: [],
      adapters: [],
      tools: [],
      knownFolders: [],
      agentAbilities: { browser: false },
    });
    const user = userEvent.setup();
    render(
      <>
        <AgentsView />
        <ConfirmHost />
      </>,
    );
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    const browser = screen.getByLabelText('Browser');
    expect(browser).toHaveValue('app');
    expect(
      screen.getByRole('option', { name: 'App default (Claude Code settings decide)' }),
    ).toBeInTheDocument();
    await user.selectOptions(browser, 'on');
    expect(screen.getByText(/run Claude Code with --chrome/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent("Let 'Claude — Implementation' use your browser?");
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(await backend.listAgentProfiles()).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await user.click(await screen.findByRole('button', { name: 'Use my browser' }));
    await waitFor(async () => {
      expect((await backend.listAgentProfiles())[0]?.browser).toBe(true);
    });
    const facts = await screen.findByText('Browser');
    expect(facts.nextElementSibling).toHaveTextContent('On');
  });

  it('asks before --chrome in the extra arguments turns the browser on', async () => {
    localStorage.clear();
    const backend = __setMockBackendForTests();
    useAppStore.setState({
      profiles: [],
      adapters: [],
      tools: [],
      knownFolders: [],
      agentAbilities: { browser: false },
    });
    const user = userEvent.setup();
    render(
      <>
        <AgentsView />
        <ConfirmHost />
      </>,
    );
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.type(screen.getByLabelText(/Additional arguments/), '--chrome');
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('use your browser?');
    await user.click(within(confirm).getByRole('button', { name: 'Use my browser' }));
    await waitFor(async () => {
      expect((await backend.listAgentProfiles())[0]?.extraArgs).toEqual(['--chrome']);
    });
    const facts = await screen.findByText('Browser');
    expect(facts.nextElementSibling).toHaveTextContent('On (extra argument)');
  });

  it('offers no browser choice for other CLIs and drops it when the CLI changes', async () => {
    __setMockBackendForTests();
    useAppStore.setState({ profiles: [], adapters: [], tools: [], knownFolders: [] });
    const user = userEvent.setup();
    render(<AgentsView />);
    await user.click(screen.getByRole('button', { name: '+ New profile' }));
    await user.selectOptions(screen.getByLabelText('Browser'), 'on');
    await user.selectOptions(screen.getByLabelText('Provider / CLI'), 'codex');
    expect(screen.queryByLabelText('Browser')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Provider / CLI'), 'claude');
    expect(screen.getByLabelText('Browser')).toHaveValue('app');
  });
});
