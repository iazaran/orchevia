import { readdirSync, readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { RunTimeline } from './components/RunTimeline';
import { ThemeToggle } from './components/ThemeToggle';
import type { StoredNodeResult, StoredRun, Workflow } from './lib/workflow';

// Vitest blanks CSS imports, so read the real stylesheet.
const css = readFileSync('src/styles.css', 'utf8');

let sheet: HTMLStyleElement;

beforeEach(() => {
  sheet = document.createElement('style');
  sheet.textContent = css;
  document.head.append(sheet);
});

afterEach(() => {
  sheet.remove();
});

/** The closest ancestor that absolutely positioned children are placed against. */
function containingBlock(element: Element): Element | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    if (getComputedStyle(node).position !== 'static') return node;
  }
  return null;
}

it('never lets the window itself scroll', () => {
  expect(getComputedStyle(document.documentElement).overflow).toBe('hidden');
  expect(getComputedStyle(document.body).overflow).toBe('hidden');
});

it('keeps hidden timeline labels inside the timeline on a long run', () => {
  // v0.1.22: each "Step N:" label had no positioned ancestor, so on a long
  // run the last ones sat far below the app and the window scrolled into
  // blank space after the End step.
  const ids = Array.from({ length: 33 }, (_, index) => `n${String(index + 1)}`);
  const workflow: Workflow = {
    schemaVersion: 6,
    id: 'w',
    name: 'W',
    edges: [],
    nodes: ids.map((id) => ({
      id,
      type: 'command',
      label: id,
      position: { x: 0, y: 0 },
      config: {},
    })),
  };
  const run: StoredRun = {
    id: 'r',
    workflowId: 'w',
    status: 'succeeded',
    startedAt: '2026-10-23T00:00:00Z',
    finishedAt: '2026-10-23T00:00:33Z',
  };
  const results: StoredNodeResult[] = ids.map((nodeId, index) => ({
    id: index + 1,
    runId: 'r',
    nodeId,
    status: 'succeeded',
    stdout: '',
    stderr: '',
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? run.startedAt,
    durationMs: 1000,
  }));
  const { container } = render(
    <div className="view">
      <RunTimeline run={run} workflow={workflow} results={results} />
    </div>,
  );
  const view = container.querySelector('.view');
  expect(view).not.toBeNull();
  if (view === null) return;
  expect(getComputedStyle(view).position).toBe('relative');
  const labels = container.querySelectorAll('.sr-only');
  expect(labels).toHaveLength(33);
  for (const label of labels) {
    expect(getComputedStyle(label).position).toBe('absolute');
    expect(containingBlock(label)).toBe(container.querySelector('.timeline-rows'));
  }
});

it('stacks a confirmation above the dialog that asked for it', () => {
  const { container } = render(
    <>
      <div className="modal-backdrop" role="dialog" />
      <div className="modal-backdrop" role="alertdialog" />
    </>,
  );
  const [dialog, confirm] = container.querySelectorAll('.modal-backdrop');
  expect(dialog).toBeDefined();
  expect(confirm).toBeDefined();
  if (dialog === undefined || confirm === undefined) return;
  expect(Number(getComputedStyle(confirm).zIndex)).toBeGreaterThan(
    Number(getComputedStyle(dialog).zIndex),
  );
});

/** The declarations of the first top-level rule for exactly this selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(css);
  if (match?.[1] === undefined) throw new Error(`No rule for ${selector}`);
  return match[1];
}

it('fills the sidebar theme switch with three equal options', () => {
  render(<ThemeToggle theme="dark" setTheme={() => {}} />);
  const group = screen.getByRole('radiogroup', { name: 'Theme' });
  expect(group).toHaveClass('segmented-fill');
  expect(getComputedStyle(group).width).toBe('100%');
  const options = screen.getAllByRole('radio');
  expect(options).toHaveLength(3);
  for (const option of options) {
    expect(getComputedStyle(option).flexGrow).toBe('1');
    // A zero basis is what makes them equal: "auto" sizes each by its label.
    expect(['0', '0px', '0%']).toContain(getComputedStyle(option).flexBasis);
  }
});

it('lines every page title and body up in one column, full width up to the page cap', () => {
  // v0.4.0 capped some panels at 760, 980 or 1100 px and left others full
  // width, so pages looked left-aligned on one screen and stretched on the next.
  const { container } = render(
    <div className="view playbooks-view">
      <p className="section-hint">Why</p>
      <div className="section-actions" />
      <div className="empty-state" />
    </div>,
  );
  const view = container.firstElementChild as HTMLElement;
  // The title bar and the view use the same gutter, worked out once on .main:
  // 24 px, or whatever centres a --page-max column on a wide window.
  expect(rule('.main')).toContain(
    '--page-gutter: max(24px, calc((100% - var(--page-max)) / 2))',
  );
  expect(rule('.view')).toMatch(/padding: 24px var\(--page-gutter\) 32px/);
  expect(rule('.topbar')).toMatch(/padding: 12px var\(--page-gutter\)/);
  expect(rule('.update-banner')).toContain('var(--page-gutter)');
  // No view centres itself with inline padding of its own.
  expect(css).not.toMatch(/\.[a-z-]*view[^{]*\{[^}]*padding-inline/);
  const actions = view.querySelector('.section-actions') as HTMLElement;
  expect(['normal', 'flex-start', 'start', '']).toContain(
    getComputedStyle(actions).justifyContent,
  );
  expect(rule('.section-actions')).not.toMatch(/margin-left|margin-inline|auto/);
  const empty = view.querySelector('.empty-state') as HTMLElement;
  expect(getComputedStyle(empty).marginLeft).toBe('0px');
  // Only running text keeps a reading width; boxes use the whole column.
  expect(
    getComputedStyle(view.querySelector('.section-hint') as HTMLElement).maxWidth,
  ).toBe('var(--measure)');
  for (const selector of [
    '.empty-state',
    '.notice',
    '.run-list',
    '.inbox-list',
    '.usage-chart-panel',
    '.home-view',
    '.setup-check-profiles',
  ])
    expect(rule(selector), selector).not.toMatch(/max-width/);
  expect(css).not.toMatch(/\.section-panel\b/);
  expect(css).not.toMatch(/\.ability-cli \{[^}]*max-width/);
});

it('styles section headings in one place instead of per view', () => {
  for (const file of readdirSync('src/components')) {
    if (!file.endsWith('.tsx') || file.includes('.test.')) continue;
    const source = readFileSync(`src/components/${file}`, 'utf8');
    expect(source, file).not.toMatch(/<h2[^>]*style=\{\{[^}]*fontSize: 14/);
    expect(source, file).not.toMatch(/className="section-row"/);
  }
});

it('draws skipped steps as finished work, never as the empty track', () => {
  // v0.3.1 painted skipped steps the grey of the empty bar, so a finished run
  // read "100%" over a bar that looked a third empty.
  expect(rule('.seg-skipped')).toContain('var(--success)');
  expect(rule('.run-progress-bar')).toContain('background: var(--bg-3)');
});
