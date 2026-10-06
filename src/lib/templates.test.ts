import { expect, it } from 'vitest';
import { builtinTemplates, instantiateTemplateLocal } from './templates';
import { __setMockBackendForTests } from './backend';
import { createDefaultProfile } from './agents';
import type { NodeConfig } from './workflow';

it('creates independent workflow clones on repeated template use', () => {
  const template = builtinTemplates()[0];
  if (!template) throw new Error('fixture');
  const roles = {
    planning: 'plan',
    implementation: 'impl',
    fastReview: 'fast',
    deepReview: 'deep',
  };
  const first = instantiateTemplateLocal(template, roles).workflow;
  const second = instantiateTemplateLocal(template, roles).workflow;
  expect(first.id).not.toBe(second.id);
  expect(first.nodes.map((n) => n.id)).not.toEqual(second.nodes.map((n) => n.id));
});

it('mirrors nine portable templates, required commands and role setup', () => {
  const templates = builtinTemplates();
  expect(templates).toHaveLength(9);
  for (const template of templates) {
    const roles = Object.fromEntries(
      template.workflow.nodes.flatMap((n) =>
        n.config.agentRole ? [[n.config.agentRole, 'profile-' + n.config.agentRole]] : [],
      ),
    );
    const preview = instantiateTemplateLocal(template, roles);
    expect(preview.workflow.nodes).toHaveLength(template.workflow.nodes.length);
    expect(preview.workflow.nodes.filter((n) => n.type === 'approval')).toHaveLength(
      template.workflow.nodes.filter((n) => n.type === 'approval').length,
    );
    for (const node of template.workflow.nodes.filter(
      (n) => n.type === 'command' && /test/i.test(n.label ?? ''),
    )) {
      expect(node.config.executable).toBe('sh');
      expect(node.config.args).toEqual(['-c', '{{input.testCommand}}']);
      expect(template.workflow.inputs).toContainEqual(
        expect.objectContaining({ name: 'testCommand', required: true }),
      );
    }
    if (Object.keys(roles).length)
      expect(() => instantiateTemplateLocal(template, {})).toThrow(/role mapping/i);
  }
  const repoTemplate = templates.find((t) => t.id === 'ticket-to-pr');
  if (!repoTemplate) throw new Error('fixture');
  expect(
    instantiateTemplateLocal(repoTemplate, {
      implementation: 'impl',
      fastReview: 'fast',
      deepReview: 'deep',
    }).setupNeeded.length,
  ).toBeGreaterThan(0);
});

it('persists user templates and uses simple portable documents', async () => {
  localStorage.clear();
  let backend = __setMockBackendForTests();
  const profiles = ['planning', 'implementation', 'fastReview', 'deepReview'].map(
    (role) => ({ ...createDefaultProfile('claude'), role, name: role }),
  );
  for (const p of profiles) await backend.saveAgentProfile(p);
  const t = (await backend.listTemplates()).builtin[0];
  if (!t) throw new Error('fixture');
  const preview = await backend.instantiateTemplate(t.id, true);
  await backend.saveWorkflow(preview.workflow);
  const saved = await backend.saveWorkflowAsTemplate(
    preview.workflow.id,
    'My pattern',
    'feature',
  );
  const json = await backend.exportTemplate(saved.id, false);
  expect(json).not.toContain('position');
  backend = __setMockBackendForTests();
  expect((await backend.listTemplates()).user).toHaveLength(1);
  const imported = await backend.importTemplate(json);
  expect(imported.name).toBe('My pattern');
  expect(await backend.deleteUserTemplate(saved.id)).toBe(true);
  await expect(
    backend.importTemplate(
      json.replace('Read the repository', 'password Read the repository'),
    ),
  ).rejects.toThrow(/credential/i);
});

it('imports plain Simple JSON directly into a template with portable roles and configuration', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const plain = JSON.stringify({
    version: 1,
    name: 'Imported review',
    defaults: { repoDir: '/project' },
    inputs: [{ name: 'prNumber', required: true }],
    nodes: [
      { key: 'start', type: 'start', config: {} },
      {
        key: 'review',
        type: 'agent',
        role: 'deepReview',
        config: { prompt: 'Review {{input.prNumber}}', timeoutSecs: 300 },
      },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { from: 'start', to: 'review' },
      { from: 'review', to: 'end' },
    ],
  });
  const before = await backend.listWorkflows();
  const imported = await backend.importTemplate(plain);
  expect(imported.name).toBe('Imported review');
  expect(imported.category).toBe('general');
  expect(imported.workflow.defaults?.repoDir).toBe('/project');
  expect(imported.workflow.nodes[1]?.config).toMatchObject({
    agentRole: 'deepReview',
    timeoutSecs: 300,
  });
  expect(await backend.listWorkflows()).toEqual(before);
  expect(await backend.exportTemplate(imported.id, false)).toContain(
    '"role": "deepReview"',
  );
});

it('imports runtime workflow JSON and refuses invalid structure without persisting a template', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const workflow = (await backend.listWorkflows())[0]?.definition;
  if (!workflow) throw new Error('fixture');
  expect((await backend.importTemplate(JSON.stringify(workflow))).name).toBe(
    workflow.name,
  );
  const count = (await backend.listTemplates()).user.length;
  for (const value of [
    null,
    [],
    {},
    { version: 1, name: 'Broken', nodes: [], edges: [] },
    {
      version: 1,
      name: 'Broken',
      nodes: [{ key: 'start', type: 'start', config: {} }],
      edges: [{ from: 'start', to: 'missing' }],
    },
  ]) {
    await expect(backend.importTemplate(JSON.stringify(value))).rejects.toThrow();
  }
  expect((await backend.listTemplates()).user).toHaveLength(count);
});

it('refuses machine-only profile bindings while allowing a portable role fallback', async () => {
  localStorage.clear();
  const backend = __setMockBackendForTests();
  const workflow = (await backend.listWorkflows())[0]?.definition;
  if (!workflow) throw new Error('fixture');
  workflow.nodes.push({
    id: 'review',
    type: 'agent',
    position: { x: 0, y: 0 },
    config: { agentProfileId: 'foreign-profile', prompt: 'Review' },
  });
  await expect(backend.importTemplate(JSON.stringify(workflow))).rejects.toThrow(
    /profile.*missing/i,
  );
  const reviewer = workflow.nodes.at(-1);
  if (!reviewer) throw new Error('fixture');
  reviewer.config.agentRole = 'deepReview';
  const imported = await backend.importTemplate(JSON.stringify(workflow));
  expect(imported.workflow.nodes.at(-1)?.config.agentProfileId).toBeUndefined();
  expect(imported.workflow.nodes.at(-1)?.config.agentRole).toBe('deepReview');
  expect(await backend.exportTemplate(imported.id, false)).toContain(
    '"role": "deepReview"',
  );
});

it('ships bounded handoffs and implementation sessions in portable built-ins', () => {
  const templates = builtinTemplates();
  const ticket = templates.find((t) => t.id === 'ticket-to-pr')!;
  const config = (id: string): NodeConfig =>
    ticket.workflow.nodes.find((n) => n.id === id)!.config;
  expect(config('impl').sessionGroup).toBe('implementation-{{input.ticket}}');
  expect(config('fix').sessionGroup).toBe(config('impl').sessionGroup);
  expect(config('fix').contextRefs).toEqual(['rev_fast', 'rev_deep']);
  expect(config('rev_fast').sessionGroup).toBeUndefined();
  const preview = instantiateTemplateLocal(ticket, {
    implementation: 'impl-profile',
    fastReview: 'fast-profile',
    deepReview: 'deep-profile',
  });
  const fix = preview.workflow.nodes.find((n) => n.label === 'Fix findings')!;
  expect(fix.config.contextRefs).toEqual(
    preview.workflow.nodes
      .filter((n) => ['Claude Review', 'Codex Review'].includes(n.label ?? ''))
      .map((n) => n.id),
  );
  for (const template of templates) {
    for (const node of template.workflow.nodes.filter(
      (n) => n.config.contextRefs?.length,
    ))
      expect(node.config.contextMaxChars).toBe(12000);
  }
});
