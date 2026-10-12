import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { __setMockBackendForTests } from '../lib/backend';
import { useAppStore } from '../store';
import { AgentsView } from './AgentsView';
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
