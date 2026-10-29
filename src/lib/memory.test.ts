import { expect, it } from 'vitest';
import {
  projectScope,
  projectKey,
  projectContext,
  validatePreference,
  successfulCommand,
  commandEdits,
} from './memory';
import { __setMockBackendForTests } from './backend';
import { createDefaultProfile } from './agents';
import { createEmptyWorkflow } from './workflow';
import type { Preference } from './generation';

it('preserves node directory overrides in observed project commands', () => {
  const previous = createEmptyWorkflow('Directories');
  previous.defaults = { repoDir: '/repo' };
  previous.nodes.push({
    id: 'tests',
    type: 'command',
    label: 'Tests',
    position: { x: 0, y: 0 },
    config: { executable: 'npm', args: ['run', 'old'], workingDir: '/repo/frontend' },
  });
  const current = structuredClone(previous);
  current.nodes.at(-1)!.config.args = ['test'];
  expect(commandEdits(previous, current, 'repo:/repo')).toEqual([
    {
      scope: 'repo:/repo',
      field: 'testCommand',
      from: "cd '/repo/frontend' && npm run old",
      to: "cd '/repo/frontend' && npm test",
    },
  ]);
  current.nodes.at(-1)!.config.workingDir = '/external/repo';
  expect(commandEdits(previous, current, 'repo:/repo')[0]?.to).toBe(
    "cd '/external/repo' && npm test",
  );
});

it('normalizes browser scope and shares the core namespace vector', () => {
  expect(projectScope('/projects/./alpha/')).toBe('repo:/projects/alpha');
  expect(projectKey('repo:/projects/alpha', 'testCommand')).toBe(
    'project.a4116f52f11d44d7.testCommand',
  );
  expect(() => projectScope('relative')).toThrow();
  expect(() => projectKey('repo:/a', 'unknown')).toThrow();
});
it('context excludes other repos, disabled, rejected and suggested values', () => {
  const a = {
    key: projectKey('repo:/a', 'testCommand'),
    scope: 'repo:/a',
    value: 'make test',
    source: 'manual',
    enabled: true,
    note: '',
  } as Preference;
  const all = [
    a,
    { ...a, scope: 'repo:/b', key: projectKey('repo:/b', 'testCommand') },
    { ...a, source: 'suggested' as const },
    { ...a, source: 'rejected' as const },
    { ...a, enabled: false },
  ];
  expect(projectContext(all, 'repo:/a').preferences).toEqual([a]);
  expect(() => validatePreference({ ...a, value: 'password=x' })).toThrow();
  expect(() => validatePreference({ ...a, note: 'x'.repeat(4001) })).toThrow();
});
it('mock persists playbooks, observations and atomic import and reset', async () => {
  localStorage.clear();
  let backend = __setMockBackendForTests();
  await backend.saveProjectPreference(
    '/a',
    'conventions',
    'Follow repository instructions',
    'User supplied',
  );
  const edit = { scope: 'repo:/a', field: 'testCommand', from: 'old', to: 'make test' };
  expect(await backend.observeEdits([edit, edit])).toEqual([]);
  backend = __setMockBackendForTests();
  const suggestions = await backend.observeEdits([edit]);
  expect(suggestions).toHaveLength(1);
  expect(suggestions[0]?.source).toBe('suggested');
  expect((await backend.getProjectMemoryContext('/a')).text).not.toContain('make test');
  const suggestion = suggestions[0];
  if (!suggestion) throw new Error('fixture');
  await backend.savePreference({ ...suggestion, source: 'rejected', enabled: false });
  expect(await backend.observeEdits([edit, edit, edit])).toEqual([]);
  expect((await backend.getProjectMemoryContext('/b')).preferences).toEqual([]);
  const json = await backend.exportMemory();
  await expect(
    backend.importMemory(
      JSON.stringify([
        { ...suggestion, key: 'safe', scope: '*', value: 'ok' },
        { ...suggestion, key: 'bad', scope: '*', value: 'bearer credential' },
      ]),
    ),
  ).rejects.toThrow();
  expect(await backend.exportMemory()).toBe(json);
  await backend.resetMemory();
  expect(await backend.listPreferences()).toEqual([]);
  expect(await backend.importMemory(json)).toBe(2);
  await backend.savePreference({
    key: 'learning.enabled',
    scope: '*',
    value: false,
    source: 'manual',
    enabled: true,
    note: '',
  });
  expect(
    await backend.observeEdits([
      { ...edit, scope: 'repo:/c' },
      { ...edit, scope: 'repo:/c' },
      { ...edit, scope: 'repo:/c' },
    ]),
  ).toEqual([]);
});
it('accepted reviewer defaults beat fallback, stale references are ignored', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const a = {
    ...createDefaultProfile('claude'),
    role: 'deepReview',
    name: 'Claude review',
  };
  const b = {
    ...createDefaultProfile('codex'),
    role: 'deepReview',
    name: 'Codex review',
  };
  await backend.saveAgentProfile(a);
  await backend.saveAgentProfile(b);
  const preference: Preference = {
    key: 'role.deepReview.profile',
    scope: '*',
    value: b.id,
    source: 'accepted',
    enabled: true,
    note: '',
  };
  await backend.savePreference(preference);
  expect((await backend.roleMapDefault()).deepReview).toBe(b.id);
  await backend.savePreference({ ...preference, value: 'gone' });
  expect((await backend.roleMapDefault()).deepReview).toBe(a.id);
});
it('promotes only successful saved commands and observes concrete edits', () => {
  const workflow = createEmptyWorkflow('Commands');
  workflow.defaults = { repoDir: '/a' };
  const node = {
    id: 'test',
    type: 'command' as const,
    label: 'Tests',
    position: { x: 0, y: 100 },
    config: { executable: 'sh', args: ['-c', 'make test'] },
  };
  workflow.nodes.push(node);
  expect(successfulCommand(workflow, 'test', 'succeeded', {})).toBe('make test');
  expect(() => successfulCommand(workflow, 'test', 'failed', {})).toThrow();
  const newer = structuredClone(workflow);
  const changed = newer.nodes.find((n) => n.id === 'test');
  if (!changed) throw new Error('fixture');
  changed.config.args = ['-c', 'make check'];
  expect(commandEdits(workflow, newer, 'repo:/a')).toEqual([
    { scope: 'repo:/a', field: 'testCommand', from: 'make test', to: 'make check' },
  ]);
});
it('promotes a script-file step as the command that runs it', () => {
  const workflow = createEmptyWorkflow('Scripts');
  workflow.defaults = { repoDir: '/a' };
  workflow.inputs = [{ name: 'suite', default: 'unit' }];
  workflow.nodes.push({
    id: 'test',
    type: 'command',
    label: 'Tests',
    position: { x: 0, y: 100 },
    config: { scriptFile: 'scripts/test all.sh', args: ['--suite', '{{input.suite}}'] },
  });
  // Relative to the repository, with the interpreter it really runs under.
  expect(successfulCommand(workflow, 'test', 'succeeded', { suite: 'e2e' })).toBe(
    "bash 'scripts/test all.sh' --suite e2e",
  );
  const node = workflow.nodes.at(-1);
  if (!node) throw new Error('fixture');
  node.config = { executable: 'python3', scriptFile: '~/bin/check.py', workingDir: '/b' };
  expect(successfulCommand(workflow, 'test', 'succeeded', {})).toBe(
    "cd '/b' && python3 ~/bin/check.py",
  );
});

it('new concrete project check commands become reviewable observations', () => {
  const previous = createEmptyWorkflow('Project checks');
  previous.defaults = { repoDir: '/repo' };
  const current = structuredClone(previous);
  current.nodes.push({
    id: 'test',
    type: 'command',
    label: 'Tests',
    position: { x: 0, y: 0 },
    config: { executable: 'cargo', args: ['test'] },
  });
  expect(commandEdits(previous, current, 'repo:/repo')).toEqual([
    { scope: 'repo:/repo', field: 'testCommand', from: '', to: 'cargo test' },
  ]);
});
