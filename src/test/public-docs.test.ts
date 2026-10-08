import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeDocument } from '../lib/workflow-document';
import { validateWorkflowLocal } from '../lib/workflow';

const page = new DOMParser().parseFromString(
  readFileSync('docs/index.html', 'utf8'),
  'text/html',
);
const readme = readFileSync('README.md', 'utf8');
const version = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string })
  .version;
// Release preparation targets source-version assets without claiming publication.
const installerVersion = version;

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

  it('targets prepared installers without claiming they are already published', () => {
    expect(readme).toContain(`Release v${installerVersion} is being prepared`);
    expect(readme).toContain(`source version ${version}`);
    expect(readme).toContain(
      "become available after the matching tag's release workflow succeeds",
    );
    expect(readme).toContain('/releases/tag/v0.1.10');
    expect(readme).not.toContain('/releases/latest/download/');
    const linkedVersions = Array.from(
      readme.matchAll(/\/releases\/download\/v([^/]+)\//g),
      (match) => match[1],
    );
    expect(linkedVersions).toHaveLength(5);
    expect(
      linkedVersions.every((linkedVersion) => linkedVersion === installerVersion),
    ).toBe(true);
    expect(readme).not.toContain('actions/workflows/ci.yml/badge.svg');
  });

  it('links each architecture and checksums directly to the prepared installer version', () => {
    for (const asset of [
      'Orchevia-macos-arm64.dmg',
      'Orchevia-macos-x86_64.dmg',
      'Orchevia-linux-x86_64.AppImage',
      'Orchevia-linux-x86_64.deb',
      'SHA256SUMS',
    ]) {
      expect(readme).toContain(`/releases/download/v${installerVersion}/${asset}`);
    }
    expect(readme).toMatch(/account that has repository access/i);
    expect(readme).toContain('sha256sum -c SHA256SUMS --ignore-missing');
    expect(readme).toContain('shasum -a 256 -c SHA256SUMS --ignore-missing');
  });

  it('offers working in-page navigation and a first-run guide', () => {
    for (const link of page.querySelectorAll('a[href^="#"]')) {
      const id = link.getAttribute('href')?.slice(1);
      expect(
        page.getElementById(id ?? ''),
        `Missing section ${String(id)}`,
      ).not.toBeNull();
    }
    expect(page.querySelector('#workflows')).not.toBeNull();
    expect(page.querySelector('#authoring')).not.toBeNull();
    expect(page.querySelector('#faq details summary')).not.toBeNull();
    expect(page.querySelector('a[href$="/docs/getting-started.md"]')).not.toBeNull();
  });

  it('imports the documented first workflow with a valid command and connected graph', () => {
    const workflow = decodeDocument(
      readFileSync('docs/examples/hello-workflow.json', 'utf8'),
      [],
      {},
    );
    expect(
      validateWorkflowLocal(workflow).filter((issue) => issue.severity === 'error'),
    ).toEqual([]);
    const command = workflow.nodes.find((node) => node.type === 'command');
    expect(command?.config.executable).toBe('echo');
    expect(command?.config.args).toEqual(['Hello from Orchevia']);
    expect(workflow.edges).toHaveLength(2);
    expect(workflow.nodes).toHaveLength(3);
  });
});
