import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeDocument } from '../lib/workflow-document';
import { validateWorkflowLocal } from '../lib/workflow';

const html = readFileSync('docs/index.html', 'utf8');
const page = new DOMParser().parseFromString(html, 'text/html');
const readme = readFileSync('README.md', 'utf8');
const latest = 'https://github.com/iazaran/orchevia/releases/latest/download/';
const installers = [
  'Orchevia-macos-arm64.dmg',
  'Orchevia-macos-x86_64.dmg',
  'Orchevia-linux-x86_64.AppImage',
  'Orchevia-linux-x86_64.deb',
];

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Missing ${what}`);
  return value;
}

describe('public documentation', () => {
  it('offers every installer and the checksums from the latest release', () => {
    const install = required(page.querySelector('#install'), '#install');
    for (const asset of [...installers, 'SHA256SUMS']) {
      expect(install.querySelector(`a[href="${latest}${asset}"]`), asset).not.toBeNull();
      expect(readme).toContain(`${latest}${asset}`);
    }
    // Links survive every release: no version-pinned download URLs to go stale.
    expect(html).not.toMatch(/\/releases\/download\/v/);
    expect(readme).not.toMatch(/\/releases\/download\/v/);
    expect(readme).toContain('sha256sum -c SHA256SUMS --ignore-missing');
    expect(readme).toContain('shasum -a 256 -c SHA256SUMS --ignore-missing');
  });

  it('no longer describes the repository or downloads as private', () => {
    for (const text of [page.body.textContent, readme]) {
      expect(text).not.toMatch(/private for now|public soon|repository access/i);
    }
  });

  it('never polls the GitHub API from the public page', () => {
    expect(html).not.toContain('api.github.com');
  });

  it('points the hero download action at the install section', () => {
    expect(page.querySelector('.hero a[href="#install"]')).not.toBeNull();
  });

  it('offers working in-page navigation and a first-run guide', () => {
    for (const link of page.querySelectorAll('a[href^="#"]')) {
      const id = link.getAttribute('href')?.slice(1);
      expect(
        page.getElementById(id ?? ''),
        `Missing section ${String(id)}`,
      ).not.toBeNull();
    }
    for (const id of ['demo', 'generate', 'tour', 'workflows', 'authoring', 'install'])
      expect(page.getElementById(id), id).not.toBeNull();
    expect(page.querySelector('#faq details summary')).not.toBeNull();
    expect(page.querySelector('a[href$="/docs/getting-started.md"]')).not.toBeNull();
  });

  it('describes every image and ships every local image it references', () => {
    const images = Array.from(page.querySelectorAll('img'));
    expect(images.length).toBeGreaterThan(4);
    for (const image of images) {
      const src = image.getAttribute('src') ?? '';
      expect(image.getAttribute('alt')?.trim(), src).toBeTruthy();
      if (!/^https?:/.test(src)) expect(existsSync(`docs/${src}`), src).toBe(true);
    }
    for (const match of readme.matchAll(/src="\.\/(docs\/[^"]+)"/g))
      expect(existsSync(match[1] ?? ''), match[1]).toBe(true);
    const social = page
      .querySelector('meta[property="og:image"]')
      ?.getAttribute('content');
    expect(social).toBe('https://iazaran.github.io/orchevia/images/social-preview.jpg');
    expect(existsSync('docs/images/social-preview.jpg')).toBe(true);
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

describe('public page scripts', () => {
  const platform = Object.getOwnPropertyDescriptor(navigator, 'platform');

  function load(): void {
    document.documentElement.innerHTML = page.documentElement.innerHTML;
    for (const script of page.querySelectorAll('script:not([type])')) {
      // The page's own inline script, evaluated against the copied document.
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const run = new Function(script.textContent) as () => void;
      run();
    }
  }
  const el = (selector: string): HTMLElement =>
    required(document.querySelector<HTMLElement>(selector), selector);
  const state = (node: string): string | undefined =>
    el(`[data-node="${node}"]`).dataset.state;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    if (platform) Object.defineProperty(navigator, 'platform', platform);
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  it('recommends the installers for the visitor operating system', () => {
    Object.defineProperty(navigator, 'platform', {
      value: 'MacIntel',
      configurable: true,
    });
    load();
    expect(el('[data-download-cta]').textContent).toBe('Download for macOS');
    const recommended = Array.from(document.querySelectorAll('.download.recommended'));
    expect(recommended.map((card) => card.getAttribute('data-os'))).toEqual([
      'mac',
      'mac',
    ]);
  });

  it('shows one tour panel at a time and follows arrow keys', () => {
    load();
    expect(el('#panel-editor').hidden).toBe(false);
    expect(el('#panel-runs').hidden).toBe(true);
    el('#tab-runs').click();
    expect(el('#panel-runs').hidden).toBe(false);
    expect(el('#panel-editor').hidden).toBe(true);
    el('#tab-runs').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(el('#tab-usage').getAttribute('aria-selected')).toBe('true');
    expect(el('#panel-usage').hidden).toBe(false);
    // Tab moves from the tab list into the visible panel.
    for (const panel of document.querySelectorAll<HTMLElement>('[role="tabpanel"]'))
      expect(panel.tabIndex, panel.id).toBe(0);
  });

  it('replays the run, waits for approval, loops once and opens the draft PR', async () => {
    load();
    el('[data-demo-run]').click();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state('plan')).toBe('succeeded');
    expect(state('approve')).toBe('paused');
    expect(state('implement')).toBe('idle');
    expect(el('[data-demo-approve]').hasAttribute('disabled')).toBe(false);

    el('[data-demo-approve]').click();
    await vi.advanceTimersByTimeAsync(30_000);
    for (const node of ['implement', 'tests', 'codex-review', 'fix', 'gate', 'pr', 'end'])
      expect(state(node), node).toBe('succeeded');
    expect(el('[data-node="codex-review"] .visits').textContent).toBe('×2');
    expect(el('[data-demo-stats]').textContent).toMatch(
      /^Succeeded · .* 7 agent attempts$/,
    );
    expect(el('[data-demo-log]').textContent).toContain('Draft PR #214 opened');
  });

  it('reset abandons a paused run without resuming it', async () => {
    load();
    el('[data-demo-run]').click();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state('approve')).toBe('paused');
    el('[data-demo-reset]').click();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state('approve')).toBe('idle');
    expect(state('implement')).toBe('idle');
    expect(el('[data-demo-approve]').hasAttribute('disabled')).toBe(true);
    expect(el('[data-demo-stats]').textContent).toBe('Ready');
  });
});
