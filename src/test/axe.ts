import axe from 'axe-core';
import { vi } from 'vitest';

const OPTIONS: axe.RunOptions = {
  rules: {
    // jsdom does no layout or painting, so axe cannot work out the colours a
    // user actually sees. Contrast is covered by the light and dark theme
    // variables in styles.css instead.
    'color-contrast': { enabled: false },
  },
};

function describeViolation(violation: axe.Result): string {
  const nodes = violation.nodes.map((node) => {
    const summary = (node.failureSummary ?? '').replaceAll('\n', '\n      ');
    return `  - ${node.target.join(' ')}\n    ${node.html}\n      ${summary}`;
  });
  return [
    `[${violation.impact ?? 'unknown'}] ${violation.id}: ${violation.help}`,
    `  ${violation.helpUrl}`,
    ...nodes,
  ].join('\n');
}

/**
 * Runs axe-core on everything rendered so far (the whole body by default, so
 * portalled notices count too) and fails with one readable entry per broken
 * rule: the rule, the elements it flagged, and how to fix them.
 */
export async function expectNoAxeViolations(
  context: Element = document.body,
): Promise<void> {
  // axe draws text on a canvas to spot icon-font ligatures. jsdom has no
  // canvas and answers null either way; this only stops it printing
  // "not implemented" on every run.
  const canvas = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(null);
  let violations: axe.Result[];
  try {
    ({ violations } = await axe.run(context, OPTIONS));
  } finally {
    canvas.mockRestore();
  }
  if (violations.length === 0) return;
  throw new Error(
    `${String(violations.length)} accessibility rule(s) failed:\n\n${violations
      .map(describeViolation)
      .join('\n\n')}`,
  );
}
