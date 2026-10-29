import definitions from './builtin-templates.json';
import type { InstantiationPreview, WorkflowTemplate } from './generation';
import type { AgentProfile } from './agents';
import { newId, SETUP_ISSUE_CODES, validateWorkflowLocal } from './workflow';
import { decodeDocument, remapConfigReferences } from './workflow-document';

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
/** Import a template envelope or a plain workflow without saving a workflow first. */
export function importTemplateDocument(
  json: string,
  profiles: AgentProfile[],
): WorkflowTemplate {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Template or workflow JSON must be an object.');
  const value = parsed as Record<string, unknown>;
  const envelope = Object.hasOwn(value, 'workflow');
  const workflow = decodeDocument(
    JSON.stringify(envelope ? value.workflow : value),
    profiles,
    {},
  );
  // Foreign runtime IDs cannot be exported portably; a declared role is a safe fallback.
  for (const node of workflow.nodes) {
    if (node.type !== 'agent' || !node.config.agentProfileId) continue;
    if (profiles.some((p) => p.id === node.config.agentProfileId)) continue;
    if (node.config.agentRole?.trim()) delete node.config.agentProfileId;
    else
      throw new Error(
        `Agent Profile '${node.config.agentProfileId}' is missing. Set a portable agentRole or configure the profile in Agents.`,
      );
  }
  if (!workflow.nodes.length) throw new Error('Template workflow has no nodes.');
  const blocking = validateWorkflowLocal(workflow).filter(
    (issue) => issue.severity === 'error' && !SETUP_ISSUE_CODES.includes(issue.code),
  );
  if (blocking.length) throw new Error(blocking.map((issue) => issue.message).join('; '));
  const metadata = (key: string, fallback: string): string => {
    if (!envelope || value[key] === undefined) return fallback;
    if (typeof value[key] !== 'string')
      throw new Error(`Invalid template ${key}: expected a string.`);
    return value[key];
  };
  const version = envelope ? (value.version ?? 1) : 1;
  if (
    typeof version !== 'number' ||
    !Number.isSafeInteger(version) ||
    version < 0 ||
    version > 4294967295
  )
    throw new Error('Invalid template version: expected an unsigned integer.');
  const template: WorkflowTemplate = {
    id: metadata('id', newId('user')),
    version,
    name: metadata('name', workflow.name),
    description: metadata('description', ''),
    category: metadata('category', 'general'),
    workflow,
  };
  validateTemplate(template);
  return template;
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
  const ids = Object.fromEntries(workflow.nodes.map((n) => [n.id, newId('node')]));
  for (const node of workflow.nodes) {
    node.config = remapConfigReferences(node.config, ids);
    node.id = ids[node.id] ?? node.id;
  }
  workflow.id = newId('wf');
  for (const edge of workflow.edges) {
    edge.id = newId('edge');
    edge.source = ids[edge.source] ?? edge.source;
    edge.target = ids[edge.target] ?? edge.target;
  }
  const errors = validateWorkflowLocal(workflow).filter((i) => i.severity === 'error');
  const blocking = errors.filter((i) => !SETUP_ISSUE_CODES.includes(i.code));
  if (blocking.length) throw new Error(blocking.map((i) => i.message).join('; '));
  return {
    workflow,
    setupNeeded: errors
      .filter((i) => SETUP_ISSUE_CODES.includes(i.code))
      .map((i) => i.message),
  };
}
