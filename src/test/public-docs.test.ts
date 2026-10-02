import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = new DOMParser().parseFromString(
  readFileSync('docs/index.html', 'utf8'),
  'text/html',
);
const readme = readFileSync('README.md', 'utf8');
const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string })
  .version;
// Source versions advance on feature branches before release assets are published.
const publishedInstallerVersion = '0.1.5';

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

  it('keeps private download links and API polling out of the entire public page', () => {
    expect(page.querySelector('a[href*="/releases/"]')).toBeNull();
    expect(page.documentElement.innerHTML).not.toContain('api.github.com');
  });

  it('keeps published installation guidance separate from the source version', () => {
    expect(readme).toContain(`Install v${publishedInstallerVersion}`);
    expect(readme).toContain(`source version ${version}`);
    expect(readme).not.toMatch(/pending|being prepared|planned.*files|processing/i);
    expect(readme).not.toContain('/releases/latest/download/');
    const linkedVersions = Array.from(
      readme.matchAll(/\/releases\/download\/v([^/]+)\//g),
      (match) => match[1],
    );
    expect(linkedVersions).toHaveLength(5);
    expect(
      linkedVersions.every(
        (linkedVersion) => linkedVersion === publishedInstallerVersion,
      ),
    ).toBe(true);
    expect(readme).not.toContain('actions/workflows/ci.yml/badge.svg');
  });

  it('links each architecture and checksums directly to the published installer version', () => {
    for (const asset of [
      'Orchevia-macos-arm64.dmg',
      'Orchevia-macos-x86_64.dmg',
      'Orchevia-linux-x86_64.AppImage',
      'Orchevia-linux-x86_64.deb',
      'SHA256SUMS',
    ]) {
      expect(readme).toContain(
        `/releases/download/v${publishedInstallerVersion}/${asset}`,
      );
    }
    expect(readme).toMatch(/account that has repository access/i);
    expect(readme).toContain('sha256sum -c SHA256SUMS --ignore-missing');
    expect(readme).toContain('shasum -a 256 -c SHA256SUMS --ignore-missing');
  });
});
