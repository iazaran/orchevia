import type { EditObservation, Preference, ProjectMemoryContext } from './generation';
import { commandArgv, type Workflow, type WorkflowNode } from './workflow';
import { renderPromptStrict } from './agents';

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((c) => {
    const code = c.charCodeAt(0);
    return code <= 31 || (code >= 127 && code <= 159);
  });
}
export const PROJECT_FIELDS = [
  'testCommand',
  'lintCommand',
  'buildCommand',
  'conventions',
  'fastReviewProfile',
  'deepReviewProfile',
  'templateId',
] as const;
export function projectScope(directory: string): string {
  const path = directory.trim().replaceAll('\\', '/');
  const prefix = /^[A-Za-z]:\//.test(path)
    ? path.slice(0, 3)
    : path.startsWith('/')
      ? '/'
      : '';
  if (!prefix || hasControlCharacters(path))
    throw new Error('Repository directory must be an absolute path.');
  const parts: string[] = [];
  for (const part of path.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  const scope = 'repo:' + prefix + parts.join('/');
  if (Array.from(scope).length > 600)
    throw new Error('Repository scope is too long (max 600 characters).');
  return scope;
}
export function projectKey(scope: string, field: string): string {
  if (
    !/^repo:(\/|[A-Za-z]:[\\/])/.test(scope) ||
    hasControlCharacters(scope) ||
    Array.from(scope).length > 600
  )
    throw new Error('Invalid project scope.');
  if (!(PROJECT_FIELDS as readonly string[]).includes(field))
    throw new Error(`Unknown project field '${field}'.`);
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(scope))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `project.${hash.toString(16).padStart(16, '0')}.${field}`;
}
export function validatePreference(preference: Preference): void {
  const p: unknown = preference;
  if (p === null || typeof p !== 'object' || Array.isArray(p))
    throw new Error('Preference must be an object.');
  if (
    typeof preference.key !== 'string' ||
    !preference.key.trim() ||
    Array.from(preference.key).length > 120 ||
    hasControlCharacters(preference.key)
  )
    throw new Error('Preference key invalid.');
  if (
    typeof preference.scope !== 'string' ||
    !preference.scope.trim() ||
    Array.from(preference.scope).length > 600 ||
    hasControlCharacters(preference.scope)
  )
    throw new Error('Preference scope invalid.');
  if (
    !['accepted', 'manual', 'suggested', 'rejected'].includes(preference.source) ||
    typeof preference.enabled !== 'boolean' ||
    typeof preference.note !== 'string'
  )
    throw new Error('Invalid preference metadata.');
  if (
    preference.value !== null &&
    !['string', 'boolean', 'number'].includes(typeof preference.value)
  )
    throw new Error('Preference value must be a scalar.');
  if (typeof preference.value === 'number' && !Number.isFinite(preference.value))
    throw new Error('Preference value must be finite.');
  if (
    Array.from(preference.note).length > 4000 ||
    (typeof preference.value === 'string' && Array.from(preference.value).length > 4000)
  )
    throw new Error('Preference value and note must each be at most 4000 characters.');
  if (preference.scope.startsWith('repo:') || preference.key.startsWith('project.')) {
    if (
      preference.key !==
      projectKey(preference.scope, preference.key.split('.').at(-1) ?? '')
    )
      throw new Error('Project key does not match repository scope.');
    if (typeof preference.value !== 'string')
      throw new Error('Project fields must be strings.');
  }
  const flat = `${JSON.stringify(preference.value)} ${preference.note}`.toLowerCase();
  if (
    ['api-key', 'apikey', 'bearer', 'password', 'secret', 'token'].some((marker) =>
      flat.includes(marker),
    )
  )
    throw new Error('Preference looks credential-like; refused.');
}
export function projectContext(
  preferences: Preference[],
  scope?: string,
): ProjectMemoryContext {
  const included = preferences
    .filter(
      (p) =>
        p.enabled &&
        ['manual', 'accepted'].includes(p.source) &&
        (p.scope === '*' || p.scope === scope),
    )
    .filter((p) => {
      try {
        validatePreference(p);
        return true;
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  return {
    scope: scope ?? '*',
    preferences: included,
    text: Array.from(
      included
        .map(
          (p) =>
            `${p.key.startsWith('project.') ? (p.key.split('.').at(-1) ?? p.key) : p.key} = ${JSON.stringify(p.value)} (evidence: ${p.note})`,
        )
        .join('\n'),
    )
      .slice(0, 16000)
      .join(''),
  };
}
const OBSERVED_FIELDS: Record<string, string> = {
  planningProfile: 'role.planning.profile',
  implementationProfile: 'role.implementation.profile',
  fastReviewProfile: 'role.fastReview.profile',
  deepReviewProfile: 'role.deepReview.profile',
  generatorProfile: 'role.workflowGenerator.profile',
  draftPr: 'pr.startAsDraft',
  commitAfterTests: 'tests.commitOnlyAfterPass',
  fixLoopOnP0P1: 'review.fixLoopOnP0P1',
  maxReviewCycles: 'review.maxCycles',
  preferWorktrees: 'git.preferWorktrees',
};
export function observationKey(observation: EditObservation): string {
  return observation.scope.startsWith('repo:')
    ? projectKey(observation.scope, observation.field)
    : (OBSERVED_FIELDS[observation.field] ??
        `custom.${observation.scope}.${observation.field}`);
}
export function validateObservation(observation: EditObservation): void {
  if (
    typeof observation.from !== 'string' ||
    typeof observation.to !== 'string' ||
    observation.from === observation.to ||
    Array.from(observation.from).length > 4000
  )
    throw new Error('Observation must describe a changed bounded value.');
  validatePreference({
    key: observationKey(observation),
    scope: observation.scope,
    value: observation.to,
    source: 'suggested',
    enabled: true,
    note: observation.from,
  });
}
export function observeEdit(
  counts: Map<string, number>,
  preferences: Preference[],
  observation: EditObservation,
): Preference | null {
  validateObservation(observation);
  if (preferences.find((p) => p.key === 'learning.enabled')?.value === false) return null;
  const key = observationKey(observation);
  if (preferences.some((p) => p.key === key)) return null;
  const counter = [observation.scope, observation.field, observation.to]
    .map((v) => `${String(new TextEncoder().encode(v).length)}:${v}`)
    .join('');
  const count = (counts.get(counter) ?? 0) + 1;
  counts.set(counter, count);
  return count < 3
    ? null
    : {
        key,
        scope: observation.scope,
        value: observation.to,
        source: 'suggested',
        enabled: true,
        note: `Suggested after ${String(count)} saved edits to ${observation.field}. Previous value: ${Array.from(observation.from).slice(0, 80).join('')}.`,
      };
}
function commandText(node: WorkflowNode, repoDir?: string): string {
  const args = node.config.args ?? [];
  const quote = (s: string): string =>
    /^[A-Za-z0-9_./:-]+$/.test(s) ? s : "'" + s.replaceAll("'", "'\"'\"'") + "'";
  // A script path stays as written (relative to the folder below); a leading
  // `~/` stays unquoted so the shell still expands it.
  const scriptPath = (s: string): string =>
    s.startsWith('~/') ? '~/' + quote(s.slice(2)) : quote(s);
  const argv = commandArgv(node.config);
  const command =
    node.config.scriptFile === undefined &&
    node.config.executable === 'sh' &&
    args.length === 2 &&
    args[0] === '-c'
      ? (args[1] ?? '')
      : argv
          .map((arg, i) =>
            i === 1 && node.config.scriptFile !== undefined
              ? scriptPath(arg)
              : quote(arg),
          )
          .join(' ');
  const directory = node.config.workingDir?.trim();
  if (directory && repoDir?.trim() && directory !== repoDir.trim()) {
    const quoted = "'" + directory.replaceAll("'", "'\"'\"'") + "'";
    return `cd ${quoted} && ${command}`;
  }
  return command;
}
export function successfulCommand(
  workflow: Workflow,
  nodeId: string,
  status: string,
  inputs: Record<string, string>,
): string {
  const node = workflow.nodes.find((n) => n.id === nodeId);
  if (status !== 'succeeded' || node?.type !== 'command')
    throw new Error('Only a successful Command step can be promoted.');
  const values: Record<string, string> = {
    'workflow.id': workflow.id,
    'workflow.name': workflow.name,
  };
  for (const input of workflow.inputs ?? [])
    if (input.default !== undefined) values['input.' + input.name] = input.default;
  for (const [key, value] of Object.entries(inputs)) values['input.' + key] = value;
  const args = (node.config.args ?? []).map((arg) => {
    const rendered = renderPromptStrict(arg, values);
    if ('error' in rendered)
      throw new Error('Cannot promote a command with unresolved run variables.');
    return rendered.rendered;
  });
  return commandText(
    { ...node, config: { ...node.config, args } },
    workflow.defaults?.repoDir,
  );
}
/** The playbook field a Command step's label (or id) names: test, lint or
 * build. Other steps (setup scripts, worktree creation) are not offered. */
export function playbookField(
  node: Pick<WorkflowNode, 'id' | 'label'>,
): 'testCommand' | 'lintCommand' | 'buildCommand' | null {
  const label = node.label ?? node.id;
  return /test/i.test(label)
    ? 'testCommand'
    : /lint/i.test(label)
      ? 'lintCommand'
      : /build/i.test(label)
        ? 'buildCommand'
        : null;
}
export function commandEdits(
  previous: Workflow,
  current: Workflow,
  scope: string,
): EditObservation[] {
  if (previous.defaults?.repoDir !== current.defaults?.repoDir) return [];
  return current.nodes.flatMap((node) => {
    const old = previous.nodes.find((n) => n.id === node.id);
    if (node.type !== 'command' || (old !== undefined && old.type !== 'command'))
      return [];
    const field = playbookField(node);
    if (!field) return [];
    const from = old ? commandText(old, previous.defaults?.repoDir) : '',
      to = commandText(node, current.defaults?.repoDir);
    if (from === to || !to.trim()) return [];
    return [{ scope, field, from, to }];
  });
}
