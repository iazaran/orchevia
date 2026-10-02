import { act, render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryView } from './MemoryView';
import { useAppStore } from '../store';
import { __setMockBackendForTests } from '../lib/backend';
import { createDefaultProfile } from '../lib/agents';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('edits a project command with evidence and a reusable template reference', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  useAppStore.setState({
    preferences: [],
    generations: [],
    userTemplates: [],
    profiles: [],
  });
  render(<MemoryView />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Playbook repository'), '/project');
  await user.type(screen.getByLabelText('Test command'), 'make test');
  await user.type(screen.getByLabelText('Evidence note'), 'Team instructions');
  await user.click(screen.getByRole('button', { name: 'Save Test command' }));
  await waitFor(() => expect(screen.getByText(/Saved Test command/)).toBeInTheDocument());
  expect((await backend.getProjectMemoryContext('/project')).text).toContain(
    'Team instructions',
  );
  await user.clear(screen.getByLabelText('Test command'));
  await user.type(screen.getByLabelText('Test command'), 'make check');
  await user.click(screen.getByRole('button', { name: 'Save Test command' }));
  await waitFor(async () =>
    expect((await backend.getProjectMemoryContext('/project')).text).toContain(
      'make check',
    ),
  );
  const t = (await backend.listTemplates()).builtin[0];
  if (!t) throw new Error('fixture');
  const saved = await backend.saveUserTemplate({
    ...t,
    id: 'pattern',
    name: 'Reusable pattern',
  });
  act(() => useAppStore.setState({ userTemplates: [saved] }));
  await user.selectOptions(
    screen.getByLabelText('Reusable workflow template'),
    'pattern',
  );
  await user.click(
    screen.getByRole('button', { name: 'Save Reusable workflow template' }),
  );
  await waitFor(async () =>
    expect((await backend.getProjectMemoryContext('/project')).text).toContain('pattern'),
  );
});
it('sets an explicit global reviewer default and rejects a suggestion', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const profile = {
    ...createDefaultProfile('codex'),
    role: 'deepReview',
    name: 'Codex review',
  };
  await backend.saveAgentProfile(profile);
  const suggestion = {
    key: 'custom.*.test',
    scope: '*',
    value: 'make test',
    source: 'suggested' as const,
    enabled: true,
    note: 'Three saved edits',
  };
  await backend.savePreference(suggestion);
  useAppStore.setState({
    preferences: [suggestion],
    profiles: [profile],
    generations: [],
    userTemplates: [],
  });
  render(<MemoryView />);
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('Default deep reviewer'), profile.id);
  await waitFor(async () =>
    expect((await backend.roleMapDefault()).deepReview).toBe(profile.id),
  );
  await user.click(screen.getByRole('button', { name: 'Reject' }));
  await waitFor(async () =>
    expect(
      (await backend.listPreferences()).find((p) => p.key === suggestion.key)?.source,
    ).toBe('rejected'),
  );
});

it('accepts, edits, disables and deletes inspectable preferences', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const p = {
    key: 'custom.*.command',
    scope: '*',
    value: 'make test',
    source: 'suggested' as const,
    enabled: true,
    note: 'Three saved edits',
  };
  await backend.savePreference(p);
  useAppStore.setState({
    preferences: [p],
    profiles: [],
    generations: [],
    userTemplates: [],
  });
  const { ConfirmHost } = await import('./ConfirmDialog');
  render(
    <>
      <MemoryView />
      <ConfirmHost />
    </>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Accept' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument(),
  );
  await user.click(screen.getByRole('button', { name: 'Edit' }));
  await user.clear(screen.getByLabelText('Value'));
  await user.type(screen.getByLabelText('Value'), 'make check');
  await user.click(screen.getByRole('button', { name: 'Save preference' }));
  await waitFor(async () =>
    expect((await backend.listPreferences())[0]?.value).toBe('make check'),
  );
  await user.click(screen.getByRole('button', { name: 'Disable' }));
  await waitFor(async () =>
    expect((await backend.listPreferences())[0]?.enabled).toBe(false),
  );
  await user.click(screen.getByRole('button', { name: 'Delete' }));
  const dialog = screen.getByRole('alertdialog');
  const { within } = await import('@testing-library/react');
  await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(async () => expect(await backend.listPreferences()).toEqual([]));
});
it('ignores a playbook load that completes after the repository changes', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  await backend.saveProjectPreference('/a', 'testCommand', 'make a', 'User instructions');
  const real = backend.getProjectMemoryContext.bind(backend);
  let release: () => void = () => {};
  vi.spyOn(backend, 'getProjectMemoryContext').mockImplementation(
    (dir) =>
      new Promise((resolve) => {
        release = () => {
          void real(dir).then(resolve);
        };
      }),
  );
  useAppStore.setState({
    preferences: [],
    profiles: [],
    generations: [],
    userTemplates: [],
  });
  render(<MemoryView />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Playbook repository'), '/a');
  await user.click(screen.getByRole('button', { name: 'Load playbook' }));
  await user.clear(screen.getByLabelText('Playbook repository'));
  await user.type(screen.getByLabelText('Playbook repository'), '/b');
  await act(async () => {
    release();
    await Promise.resolve();
  });
  expect(screen.getByLabelText('Test command')).toHaveValue('');
});
