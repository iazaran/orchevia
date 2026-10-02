import definitions from './builtin-templates.json';
import type { InstantiationPreview, WorkflowTemplate } from './generation';
import { validateWorkflowLocal } from './workflow';
import { remapConfigReferences } from './workflow-document';

/** The core constructors are authoritative; a Rust test pins this browser data. */
export function builtinTemplates(): WorkflowTemplate[] {
  return structuredClone(definitions) as WorkflowTemplate[];
}
export function validateTemplate(template: WorkflowTemplate): void {
  if (!template.id.trim() || !template.name.trim())
    throw new Error('Template id and name must not be empty.');
  if (template.version > 1)
    throw new Error('Template schema is newer than supported v1.');
  const flat = JSON.stringify(template.workflow).toLowerCase();
  for (const marker of ['api-key', 'apikey', 'bearer', 'password']) {
    if (flat.includes(marker))
      throw new Error(`Template contains credential-like text ('${marker}'); refused.`);
  }
}
export function instantiateTemplateLocal(
  template: WorkflowTemplate,
  roleMap: Record<string, string>,
): InstantiationPreview {
  validateTemplate(template);
  const workflow = structuredClone(template.workflow);
  const missing = new Set<string>();
  for (const node of workflow.nodes) {
    if (node.type !== 'agent') continue;
    if (node.config.agentProfileId?.trim()) {
      delete node.config.agentRole;
      continue;
    }
    const role = node.config.agentRole;
    if (!role || !Object.hasOwn(roleMap, role) || !roleMap[role]) {
      missing.add(role ?? 'unknown');
      continue;
    }
    node.config.agentProfileId = roleMap[role] ?? '';
    delete node.config.agentRole;
  }
  if (missing.size)
    throw new Error(
      `Template needs role mappings for: ${[...missing].sort().join(', ')}.`,
    );
  const ids = Object.fromEntries(workflow.nodes.map((n) => [n.id, n.id + '-inst']));
  for (const node of workflow.nodes) {
    node.config = remapConfigReferences(node.config, ids);
    node.id = ids[node.id] ?? node.id;
  }
  workflow.id += '-inst';
  for (const edge of workflow.edges) {
    edge.id += '-inst';
    edge.source = ids[edge.source] ?? edge.source;
    edge.target = ids[edge.target] ?? edge.target;
  }
  const errors = validateWorkflowLocal(workflow).filter((i) => i.severity === 'error');
  const setupCodes = [
    'git-dir-required',
    'ticket-server-required',
    'mcp-server-required',
  ];
  const blocking = errors.filter((i) => !setupCodes.includes(i.code));
  if (blocking.length) throw new Error(blocking.map((i) => i.message).join('; '));
  return {
    workflow,
    setupNeeded: errors.filter((i) => setupCodes.includes(i.code)).map((i) => i.message),
  };
}
