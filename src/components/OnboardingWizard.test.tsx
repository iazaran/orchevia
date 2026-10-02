import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OnboardingWizard } from './OnboardingWizard';
import { __setMockBackendForTests } from '../lib/backend';
import { useAppStore } from '../store';

afterEach(() => vi.restoreAllMocks());
it('creates both reviewers even when their CLIs are unavailable', async () => {
  const backend = __setMockBackendForTests();
  const save = vi.spyOn(backend, 'saveAgentProfile');
  useAppStore.setState({ profiles: [], tools: [], githubState: null });
  vi.spyOn(useAppStore.getState(), 'refreshAll').mockResolvedValue(undefined);
  render(<OnboardingWizard onClose={() => {}} />);
  const user = userEvent.setup();
  for (let i = 0; i < 3; i++)
    await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Create recommended profiles' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(6));
  expect(
    save.mock.calls
      .filter(([profile]) => profile.role === 'deepReview')
      .map(([profile]) => profile.adapter),
  ).toEqual(['claude', 'codex']);
});
