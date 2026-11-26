import { expect, it } from 'vitest';
import { builtinTemplates } from './templates';
import type { WorkflowTemplate } from './generation';
import {
  matchesTemplateSearch,
  TEMPLATE_DOMAINS,
  templateDomain,
  templateNeeds,
} from './template-domains';

it('puts every built-in in a domain shown on Home and Templates', () => {
  const byDomain = new Map<string, string[]>();
  for (const template of builtinTemplates()) {
    const domain = templateDomain(template.category);
    expect(domain, template.id).not.toBe('other');
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), template.id]);
  }
  for (const domain of TEMPLATE_DOMAINS)
    expect(byDomain.get(domain.id)?.length ?? 0, domain.id).toBeGreaterThan(0);
  expect(byDomain.get('content')).toEqual([
    'blog-post',
    'launch-kit',
    'translate-document',
  ]);
  expect(byDomain.get('media')).toEqual(['image-set', 'social-video-cuts']);
  expect(templateDomain('General')).toBe('other');
  expect(templateDomain(' Feature ')).toBe('software');
});

it('searches names, descriptions, kinds and inputs with every word', () => {
  const blog = builtinTemplates().find((t) => t.id === 'blog-post');
  if (blog === undefined) throw new Error('fixture');
  expect(matchesTemplateSearch(blog, '')).toBe(true);
  expect(matchesTemplateSearch(blog, 'BLOG social')).toBe(true);
  expect(matchesTemplateSearch(blog, 'marketing')).toBe(true);
  expect(matchesTemplateSearch(blog, 'tone')).toBe(true);
  expect(matchesTemplateSearch(blog, 'blog ffmpeg')).toBe(false);
});

it('names what a template needs and checks local tools against detection', () => {
  const find = (id: string): WorkflowTemplate => {
    const template = builtinTemplates().find((t) => t.id === id);
    if (template === undefined) throw new Error(id);
    return template;
  };
  const video = find('social-video-cuts');
  expect(templateNeeds(video, [])).toEqual([
    expect.objectContaining({ label: 'FFmpeg', ready: null }),
  ]);
  expect(
    templateNeeds(video, [{ id: 'ffmpeg', displayName: 'FFmpeg', installed: false }]),
  ).toEqual([expect.objectContaining({ label: 'FFmpeg', ready: false })]);
  expect(templateNeeds(find('research-report'), []).map((n) => n.label)).toEqual([
    'Web search',
  ]);
  expect(templateNeeds(find('web-page-brief'), []).map((n) => n.label)).toEqual([
    'MCP server',
  ]);
  expect(templateNeeds(find('create-draft-pr'), []).map((n) => n.label)).toContain(
    'Git repository',
  );
  expect(templateNeeds(find('blog-post'), [])).toEqual([]);
});
