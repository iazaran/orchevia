import { describe, expect, it } from 'vitest';
import { reportedSeverity } from './severity';

// Shared with `SEVERITY_CASES` in crates/core/src/review.rs; keep both identical.
const CASES: [string, string | null][] = [
  ['No P0/P1 issues found.', null],
  ['There are no P0 or P1 findings.', null],
  ['Found zero P0, P1 or P2 problems.', null],
  ['Without **P1** findings, this is ready.', null],
  ['Tag severe issues P0/P1.', null],
  ['Severities run P0–P3.', null],
  ['Nothing blocking.', null],
  ['SP1 sprint notes', null],
  ['- **P1** src/a.ts:3 — the lock is never released', 'P1'],
  ['P0: crash on an empty cart', 'P0'],
  ['No P0 issues; one P2 naming nit.', 'P2'],
  ['Two findings: P2 naming and P1 race.', 'P1'],
  ['P1-level risk in auth', 'P1'],
  ['No P0/P1 issues.\n```finding\nseverity: P2\ntitle: Naming\n```', 'P2'],
  ['P0 crash mentioned in prose\n```finding\nseverity: info\ntitle: Note\n```', null],
];

describe('reportedSeverity', () => {
  it.each(CASES)('%j reports %s', (text, expected) => {
    expect(reportedSeverity(text)).toBe(expected);
  });
});
