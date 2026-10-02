import { expect, it } from 'vitest';
import { builtinTemplates, instantiateTemplateLocal } from './templates';
import { __setMockBackendForTests } from './backend';
import { createDefaultProfile } from './agents';

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
