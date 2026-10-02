/**
 * Generation, template, and memory types (mirror of `orchevia-core`
 * generation/templates/memory).
 */

import type { AgentProfile } from './agents';
import type { ValidationIssue, Workflow, WorkflowNode } from './workflow';

export interface GenerationPreview {
  generationId: string;
  proposalName: string;
  explanation: string;
  workflow: Workflow;
  issues: ValidationIssue[];
  unavailable: string[];
  riskLabels: string[];
  riskyNodes: string[];
  blocking: string[];
  repairs: string[];
  setupNeeded: string[];
  unmappedRoles: string[];
}

/** Keep the first useful sentence visible; the complete explanation stays expandable. */
export function summarizeGenerationExplanation(explanation: string): string {
  const clean = explanation.replace(/\s+/g, ' ').trim();
  if (clean.length <= 220) return clean;
  const firstSentence = clean.match(/^.{1,220}?[.!?](?=\s|$)/)?.[0];
  const short = firstSentence ?? clean.slice(0, 200).trimEnd();
  return short.length < clean.length ? `${short}…` : short;
}

/** One `NAME` or `NAME=default value` per line (workflow inputs). */
export interface DeclaredInput {
  name: string;
  label?: string | undefined;
  default?: string | undefined;
  required: boolean;
}

export function isValidInputName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name);
}

/** Parse the generator inputs box. Returns inputs + per-line problems. */
export function parseInputDeclarations(text: string): {
  inputs: DeclaredInput[];
  problems: string[];
} {
  const inputs: DeclaredInput[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const name = (eq < 0 ? line : line.slice(0, eq)).trim();
    const def = eq < 0 ? undefined : line.slice(eq + 1).trim();
    if (!isValidInputName(name)) {
      problems.push(
        `'${name}': use 1-64 chars of letters/digits/_/-, starting with a letter or underscore.`,
      );
      continue;
    }
    if (seen.has(name)) {
      problems.push(`'${name}' declared twice — keeping the first.`);
      continue;
    }
    seen.add(name);
    inputs.push({
      name,
      default: def === undefined || def === '' ? undefined : def,
      required: def === undefined || def === '',
    });
  }
  return { inputs, problems };
}

export interface WorkflowTemplate {
  id: string;
  version: number;
  name: string;
  description: string;
  category: string;
  workflow: Workflow;
}

export interface InstantiationPreview {
  workflow: Workflow;
  setupNeeded: string[];
}

export interface Preference {
  key: string;
  scope: string;
  value: string | boolean | number | null;
  source: 'accepted' | 'manual' | 'suggested' | 'rejected';
  enabled: boolean;
  note: string;
}

export interface ProjectMemoryContext {
  scope: string;
  preferences: Preference[];
  text: string;
}

export interface EditObservation {
  scope: string;
  field: string;
  from: string;
  to: string;
}

export interface StoredGeneration {
  id: string;
  goal: string;
  generatorProfile: string;
  proposalJson: string;
  status: string;
  createdAt: string;
}

export const WELL_KNOWN_ROLES = [
  'planning',
  'implementation',
  'fastReview',
  'deepReview',
  'workflowGenerator',
] as const;

/**
 * Resolve which profile drafts a workflow for `adapter` without asking the
 * user to set anything up: prefer an explicit `workflowGenerator` profile for
 * that adapter, else any profile on the adapter, else `null` (caller creates
 * one).
 */
export function resolveGeneratorProfile(
  profiles: { id: string; adapter: string; role?: string | undefined }[],
  adapter: string,
): string | null {
  const byRole = profiles.find(
    (p) => p.adapter === adapter && p.role === 'workflowGenerator',
  );
  if (byRole !== undefined) return byRole.id;
  return profiles.find((p) => p.adapter === adapter)?.id ?? null;
}

export function isPendingSuggestion(p: Preference): boolean {
  return p.source === 'suggested' && p.enabled;
}

/** Describe the executable part of a proposed node for human preview. */
export function describeGeneratedStep(
  node: WorkflowNode,
  profiles: Pick<AgentProfile, 'id' | 'name' | 'adapter' | 'model'>[] = [],
): string {
  if (node.type === 'git') {
    const op = node.config.gitOp;
    if (op === undefined) return 'Operation missing';
    if (op.op === 'branchCreate' || op.op === 'checkout') return op.op + ': ' + op.name;
    if (op.op === 'commit') return 'commit: ' + op.message;
    if (op.op === 'stage') return 'stage: ' + (op.paths?.join(', ') || 'paths missing');
    if (op.op === 'worktreeAdd' || op.op === 'worktreeRemove')
      return op.op + ': ' + op.path;
    return op.op;
  }
  if (node.type === 'github') {
    const op = node.config.githubOp;
    if (op === undefined) return 'Operation missing';
    if (op.op === 'createPr') {
      return `createPr${op.draft === true ? ' draft' : ''}: ${op.title} (${op.head} → ${op.base})`;
    }
    if (
      op.op === 'postComment' ||
      op.op === 'prDetails' ||
      op.op === 'prFiles' ||
      op.op === 'prChecks'
    ) {
      return op.op + ': #' + String(op.number);
    }
    return op.op;
  }
  if (node.type === 'agent') {
    if (node.config.agentProfileId) {
      const profile = profiles.find((p) => p.id === node.config.agentProfileId);
      return profile
        ? `Agent: ${profile.name} (${profile.adapter}, ${profile.model ?? 'CLI default'})`
        : 'Agent Profile unavailable — check Agents.';
    }
    return 'Agent role: ' + (node.config.agentRole ?? 'missing');
  }
  if (node.type === 'ticket') return 'Ticket: ' + (node.config.ticketKey ?? 'missing');
  if (node.type === 'mcp') {
    const args = Object.entries(node.config.mcpArgs ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => `${name}: ${value}`);
    return (
      'MCP tool: ' +
      (node.config.mcpTool ?? 'missing') +
      (args.length > 0 ? ' · ' + args.join(' · ') : '')
    );
  }
  if (node.type === 'command')
    return (
      'CLI: ' +
      [
        node.config.executable ?? 'missing',
        ...(node.config.args ?? []).map((arg) =>
          /\s|["']/.test(arg) || !arg ? JSON.stringify(arg) : arg,
        ),
      ].join(' ')
    );
  if (node.type === 'approval') return 'Human approval';
  if (node.type === 'condition') return 'True / false decision';
  return '';
}
