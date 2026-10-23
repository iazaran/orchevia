import { readFileSync } from 'node:fs';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { RunTimeline } from './components/RunTimeline';
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
