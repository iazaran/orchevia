/**
 * Template domains (v0.4.0): the kinds of work templates do, for the
 * Templates filter, the Home use-case tiles and what a template needs.
 */
import type { WorkflowTemplate } from './generation';
import type { ToolStatus } from './workflow';

export type TemplateDomain =
  'software' | 'content' | 'research' | 'media' | 'data' | 'start' | 'other';

export interface DomainInfo {
  id: TemplateDomain;
  label: string;
  /** One line for the Home tiles. */
  blurb: string;
  categories: readonly string[];
}

export const TEMPLATE_DOMAINS: readonly DomainInfo[] = [
  {
    id: 'software',
    label: 'Software',
    blurb: 'Plan, implement, test and cross-review code, then open the pull request.',
    categories: ['feature', 'bugfix', 'review', 'refactor', 'maintenance'],
  },
  {
    id: 'content',
    label: 'Content & marketing',
    blurb:
      'Posts, launch kits and translations, edited and fact-checked before you approve.',
    categories: ['content', 'marketing'],
  },
  {
    id: 'research',
    label: 'Research',
    blurb: 'Reports with sources, page briefs and answers checked by a second agent.',
    categories: ['research', 'integration'],
  },
  {
    id: 'media',
    label: 'Media & design',
    blurb: 'Images from a brief and social video cuts, made on your machine.',
    categories: ['media', 'design'],
  },
  {
    id: 'data',
    label: 'Data & operations',
    blurb: 'Spreadsheet insights with charts, meeting notes turned into actions.',
    categories: ['data', 'operations'],
  },
  {
    id: 'start',
    label: 'Getting started',
    blurb: 'A first run with a command and an approval, no setup needed.',
    categories: ['getting-started'],
  },
];

/** The domain a template's category belongs to. */
export function templateDomain(category: string): TemplateDomain {
  const key = category.trim().toLowerCase();
  return TEMPLATE_DOMAINS.find((d) => d.categories.includes(key))?.id ?? 'other';
}

export function domainLabel(domain: TemplateDomain): string {
  return TEMPLATE_DOMAINS.find((d) => d.id === domain)?.label ?? 'Other';
}

/** Case-insensitive match on name, description, category and input labels. */
export function matchesTemplateSearch(
  template: WorkflowTemplate,
  query: string,
): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [
    template.name,
    template.description,
    template.category,
    domainLabel(templateDomain(template.category)),
    ...(template.workflow.inputs ?? []).flatMap((i) => [i.name, i.label ?? '']),
  ]
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export interface TemplateNeed {
  label: string;
  /** `true` found, `false` missing, `null` not checkable here. */
  ready: boolean | null;
  hint: string;
}

/** Local tools a template's Command steps call, by the tool id Environment detects. */
const COMMAND_TOOLS: Record<string, { id: string; label: string }> = {
  ffmpeg: { id: 'ffmpeg', label: 'FFmpeg' },
  magick: { id: 'imagemagick', label: 'ImageMagick' },
  convert: { id: 'imagemagick', label: 'ImageMagick' },
  pandoc: { id: 'pandoc', label: 'Pandoc' },
  python3: { id: 'python', label: 'Python' },
};

/**
 * What a template needs beyond an agent profile: local tools its commands
 * call (checked against detection), MCP servers, web access and a repository.
 */
export function templateNeeds(
  template: WorkflowTemplate,
  tools: readonly ToolStatus[],
): TemplateNeed[] {
  const needs: TemplateNeed[] = [];
  const seen = new Set<string>();
  for (const node of template.workflow.nodes) {
    if (node.type !== 'command') continue;
    const text = [node.config.executable ?? '', ...(node.config.args ?? [])].join(' ');
    for (const [word, tool] of Object.entries(COMMAND_TOOLS)) {
      if (seen.has(tool.id) || !new RegExp(`(^|[\\s;&|(])${word}\\s`).test(text))
        continue;
      seen.add(tool.id);
      const status = tools.find((t) => t.id === tool.id);
      needs.push({
        label: tool.label,
        ready: status === undefined ? null : status.installed,
        hint:
          status === undefined
            ? `Runs ${tool.label} on your machine.`
            : status.installed
              ? `${tool.label} is installed.`
              : `${tool.label} was not found: install it, then Re-detect in Environment.`,
      });
    }
  }
  const rules = new Set(
    template.workflow.nodes.flatMap((n) =>
      n.type === 'agent' ? (n.config.requiredTools ?? []) : [],
    ),
  );
  if (!seen.has('python') && [...rules].some((rule) => rule.startsWith('Bash(python3'))) {
    const status = tools.find((t) => t.id === 'python');
    needs.push({
      label: 'Python',
      ready: status === undefined ? null : status.installed,
      hint:
        status === undefined
          ? 'Agents compute with python3 on your machine.'
          : status.installed
            ? 'Python is installed.'
            : 'Python was not found: install python3, then Re-detect in Environment.',
    });
  }
  if (rules.has('WebSearch') || rules.has('WebFetch'))
    needs.push({
      label: 'Web search',
      ready: null,
      hint: "Uses your agent's web search and page reading.",
    });
  if (template.workflow.nodes.some((n) => n.type === 'mcp' || n.type === 'ticket'))
    needs.push({
      label: 'MCP server',
      ready: null,
      hint: 'Connect the server in Environment → MCP servers.',
    });
  if (template.workflow.nodes.some((n) => n.type === 'git' || n.type === 'github'))
    needs.push({
      label: 'Git repository',
      ready: null,
      hint: 'Works in a repository you choose when you use it.',
    });
  return needs;
}
