import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = new DOMParser().parseFromString(
  readFileSync('docs/index.html', 'utf8'),
  'text/html',
);

describe('public documentation before launch', () => {
  it('announces upcoming public access without offering private downloads', () => {
    const installation = page.querySelector('#install');
    expect(installation?.textContent).toMatch(/repository.*private/i);
    expect(installation?.textContent).toMatch(/public soon/i);
    expect(installation?.querySelector('a[href*="/releases/"]')).toBeNull();
    expect(installation?.querySelector('[data-asset]')).toBeNull();
  });

  it('shows installation information without polling private release assets', () => {
    const action = page.querySelector('.hero a[href="#install"]');
    expect(action?.textContent.trim()).toBe('Installation');
    const scripts = Array.from(page.scripts).map((script) => script.textContent);
    expect(scripts.join('\n')).not.toContain('api.github.com');
  });

  it('limits source-build instructions to contributors with repository access', () => {
    expect(page.querySelector('#install')?.textContent).toMatch(
      /contributors with repository access can build/i,
    );
  });
});
