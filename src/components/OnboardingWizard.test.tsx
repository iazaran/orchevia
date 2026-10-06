import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OnboardingWizard } from './OnboardingWizard';
import { __setMockBackendForTests } from '../lib/backend';
import { useAppStore } from '../store';
import { createDefaultProfile } from '../lib/agents';

afterEach(() => vi.restoreAllMocks());
it('creates both reviewers even when their CLIs are unavailable', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const save = vi.spyOn(backend, 'saveAgentProfile');
  useAppStore.setState({ profiles: [], tools: [], githubState: null });
  vi.spyOn(useAppStore.getState(), 'refreshAll').mockResolvedValue(undefined);
  render(<OnboardingWizard onClose={() => {}} />);
  const user = userEvent.setup();
  for (let i = 0; i < 3; i++)
    await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Create recommended profiles' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(8));
  expect(save.mock.calls.map(([profile]) => profile)).toContainEqual(
    expect.objectContaining({
      name: 'Claude — General purpose',
      adapter: 'claude',
      model: 'opus',
      effort: 'medium',
    }),
  );
  expect(
    save.mock.calls
      .filter(([profile]) => profile.role === 'deepReview')
      .map(([profile]) => profile.adapter),
  ).toEqual(['claude', 'codex']);
});

it('sets a configurable assistance profile', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  useAppStore.setState({ profiles: [], tools: [], githubState: null });
  vi.spyOn(useAppStore.getState(), 'refreshAll').mockResolvedValue(undefined);
  render(<OnboardingWizard onClose={() => {}} />);
  const user = userEvent.setup();
  for (let i = 0; i < 3; i++)
    await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.selectOptions(screen.getByLabelText('Assistance CLI'), 'codex');
  await user.clear(screen.getByLabelText('Assistance model'));
  await user.type(screen.getByLabelText('Assistance model'), 'my-model');
  await user.click(screen.getByRole('button', { name: 'Create recommended profiles' }));
  await waitFor(async () =>
    expect(await backend.getSetting('workflow.assistanceProfileId')).toBeTruthy(),
  );
  const assistant = (await backend.listAgentProfiles()).find(
    (p) => p.role === 'workflowAssistance',
  );
  expect(assistant).toMatchObject({
    adapter: 'codex',
    model: 'my-model',
    effort: 'high',
  });
});

it('can choose an existing assistance profile and preserves all its settings', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const existing = await backend.saveAgentProfile({
    ...createDefaultProfile('claude'),
    name: 'My existing assistant',
    role: 'workflowAssistance',
    model: 'custom-model',
    effort: 'low',
    extraArgs: ['--verbose'],
  });
  useAppStore.setState({ profiles: [existing], tools: [], githubState: null });
  vi.spyOn(useAppStore.getState(), 'refreshAll').mockResolvedValue(undefined);
  render(<OnboardingWizard onClose={() => {}} />);
  const user = userEvent.setup();
  for (let i = 0; i < 3; i++)
    await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.selectOptions(
    screen.getByLabelText('Default workflow assistance profile'),
    existing.id,
  );
  await user.click(screen.getByRole('button', { name: 'Create recommended profiles' }));
  await waitFor(async () =>
    expect(await backend.getSetting('workflow.assistanceProfileId')).toBe(existing.id),
  );
  expect((await backend.listAgentProfiles()).find((p) => p.id === existing.id)).toEqual(
    existing,
  );
  expect(
    (await backend.listAgentProfiles()).filter((p) => p.role === 'workflowAssistance'),
  ).toHaveLength(1);
});
