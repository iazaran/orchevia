import { act, render, screen, waitFor, cleanup, within } from '@testing-library/react';
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

it('loads disabled knowledge and makes re-enabling it explicit', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  await backend.saveProjectPreference('/project', 'testCommand', 'make test', 'Verified');
  const preference = (await backend.listPreferences())[0];
  if (!preference) throw new Error('fixture');
  await backend.savePreference({ ...preference, enabled: false });
  useAppStore.setState({
    workflows: [],
    preferences: await backend.listPreferences(),
    generations: [],
    userTemplates: [],
    profiles: [],
  });
  render(<MemoryView />);
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('Saved repositories'), '/project');
  expect(await screen.findByLabelText('Test command')).toHaveValue('make test');
  // Loading a disabled value is not a change; enabling it is explicit.
  await waitFor(() =>
    expect(screen.getByLabelText('Test command')).toHaveValue('make test'),
  );
  expect(screen.getByRole('button', { name: 'Save playbook' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Enable again' }));
  await waitFor(async () =>
    expect((await backend.listPreferences())[0]?.enabled).toBe(true),
  );
});

it('opens a saved repository playbook and keeps suggested values out of its editor', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  await backend.saveProjectPreference(
    '/project',
    'testCommand',
    'make test',
    'Verified run',
  );
  const preference = (await backend.listPreferences())[0];
  if (!preference) throw new Error('fixture');
  await backend.savePreference({
    ...preference,
    source: 'suggested',
    value: 'make unsafe',
  });
  useAppStore.setState({
    workflows: [],
    preferences: await backend.listPreferences(),
    generations: [],
    userTemplates: [],
    profiles: [],
  });
  render(<MemoryView />);
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('Saved repositories'), '/project');
  await screen.findByText(/No saved project knowledge/);
  expect(screen.getByLabelText('Playbook repository')).toHaveValue('/project');
  expect(screen.getByLabelText('Test command')).toHaveValue('');
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
  await user.click(screen.getByRole('button', { name: 'Save playbook' }));
  await waitFor(() => expect(screen.getByText(/Saved Test command/)).toBeInTheDocument());
  expect((await backend.getProjectMemoryContext('/project')).text).toContain(
    'Team instructions',
  );
  await user.clear(screen.getByLabelText('Test command'));
  await user.type(screen.getByLabelText('Test command'), 'make check');
  await user.click(screen.getByRole('button', { name: 'Save playbook' }));
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
  await user.click(screen.getByRole('button', { name: 'Save playbook' }));
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
  await user.click(screen.getByText(/^Saved preferences/));
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

it('fills empty fields from detected commands and saves them with their source', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  vi.spyOn(backend, 'detectProjectCommands').mockResolvedValue([
    {
      field: 'testCommand',
      value: 'pnpm test',
      source: 'package.json script "test" (pnpm)',
    },
    {
      field: 'lintCommand',
      value: 'pnpm run lint',
      source: 'package.json script "lint" (pnpm)',
    },
  ]);
  useAppStore.setState({
    workflows: [],
    preferences: [],
    generations: [],
    userTemplates: [],
    profiles: [],
  });
  render(<MemoryView />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Playbook repository'), '/project');
  await user.type(screen.getByLabelText('Lint command'), 'make lint');
  await user.click(screen.getByRole('button', { name: '✦ Detect commands' }));
  await screen.findByText(/Found 2 suggestions in package.json/);
  // Empty fields are filled; a typed value stays, with the suggestion offered.
  expect(screen.getByLabelText('Test command')).toHaveValue('pnpm test');
  expect(screen.getByLabelText('Lint command')).toHaveValue('make lint');
  expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Use it' }));
  expect(screen.getByLabelText('Lint command')).toHaveValue('pnpm run lint');
  await user.click(screen.getByRole('button', { name: 'Save playbook' }));
  await waitFor(async () =>
    expect((await backend.getProjectMemoryContext('/project')).text).toContain(
      'testCommand = "pnpm test" (evidence: Detected from package.json script "test" (pnpm); reviewed in Playbooks.)',
    ),
  );
  expect(screen.queryByText('Unsaved changes')).toBeNull();
  expect(screen.getByRole('button', { name: 'Save playbook' })).toBeDisabled();
});

it('clears a saved command when its field is emptied', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  await backend.saveProjectPreference('/project', 'buildCommand', 'make', 'Verified');
  useAppStore.setState({
    workflows: [],
    preferences: await backend.listPreferences(),
    generations: [],
    userTemplates: [],
    profiles: [],
  });
  const { ConfirmHost } = await import('./ConfirmDialog');
  render(
    <>
      <MemoryView />
      <ConfirmHost />
    </>,
  );
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('Saved repositories'), '/project');
  await waitFor(() => expect(screen.getByLabelText('Build command')).toHaveValue('make'));
  await user.clear(screen.getByLabelText('Build command'));
  await user.click(screen.getByRole('button', { name: 'Save playbook' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent('Clear 1 saved value?');
  await user.click(within(dialog).getByRole('button', { name: 'Clear and save' }));
  await screen.findByText('Cleared Build command.');
  expect(await backend.listPreferences()).toEqual([]);
});

it('mock detection refuses relative paths and suggests nothing in the browser', async () => {
  const backend = __setMockBackendForTests();
  await expect(backend.detectProjectCommands('repo')).rejects.toThrow(/full path/);
  await expect(backend.detectProjectCommands('/repo')).resolves.toEqual([]);
});

it('loads the saved playbook before detecting, so detection never overwrites it', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  await backend.saveProjectPreference('/project', 'testCommand', 'pnpm test:ci', 'Team');
  vi.spyOn(backend, 'detectProjectCommands').mockResolvedValue([
    {
      field: 'testCommand',
      value: 'pnpm test',
      source: 'package.json script "test" (pnpm)',
    },
    {
      field: 'buildCommand',
      value: 'pnpm run build',
      source: 'package.json script "build" (pnpm)',
    },
  ]);
  useAppStore.setState({
    workflows: [],
    preferences: await backend.listPreferences(),
    generations: [],
    userTemplates: [],
    profiles: [],
  });
  render(<MemoryView />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Playbook repository'), '/project');
  await user.click(screen.getByRole('button', { name: '✦ Detect commands' }));
  await screen.findByText(/Found 2 suggestions/);
  expect(screen.getByLabelText('Test command')).toHaveValue('pnpm test:ci');
  expect(screen.getByLabelText('Build command')).toHaveValue('pnpm run build');
  expect(screen.getByRole('button', { name: 'Use it' })).toBeInTheDocument();
});

it('keeps a disabled value disabled when another field is saved', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  await backend.saveProjectPreference('/project', 'testCommand', 'make test', 'Team');
  const preference = (await backend.listPreferences())[0];
  if (!preference) throw new Error('fixture');
  await backend.savePreference({ ...preference, enabled: false });
  useAppStore.setState({
    workflows: [],
    preferences: await backend.listPreferences(),
    generations: [],
    userTemplates: [],
    profiles: [],
  });
  render(<MemoryView />);
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText('Saved repositories'), '/project');
  await screen.findByRole('button', { name: 'Enable again' });
  await user.type(screen.getByLabelText('Lint command'), 'make lint');
  await user.click(screen.getByRole('button', { name: 'Save playbook' }));
  await screen.findByText('Saved Lint command.');
  expect(screen.getByRole('button', { name: 'Enable again' })).toBeInTheDocument();
  const test = (await backend.listPreferences()).find((p) =>
    p.key.endsWith('testCommand'),
  );
  expect(test?.enabled).toBe(false);
});
