/**
 * Mirror of `review::reported_severity` (crates/core/src/review.rs): the highest
 * severity a step's output reports, for `node.<id>.severity`.
 *
 * Structured ```finding blocks win when present. Otherwise a `P0`–`P3` tag in
 * prose counts unless it names the scale (`P0–P3`) or is negated right before
 * it (`no P1`, `zero P0 or P1`, `no blocking (P0/P1)`): a clean review that says
 * "No P0/P1 issues found" reports no severity, while "Found P0/P1 issues" does.
 */
const LEVELS = ['P0', 'P1', 'P2', 'P3'] as const;
type Level = (typeof LEVELS)[number];

const isWordChar = (c: string | undefined): boolean =>
  c !== undefined && /[\p{L}\p{N}_]/u.test(c);
const lastChar = (text: string): string | undefined => Array.from(text).at(-1);
const firstChar = (text: string): string | undefined => Array.from(text)[0];

function findingSeverities(text: string): string[] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase() === '```finding') {
      current = [];
    } else if (trimmed === '```') {
      if (current !== null) blocks.push(current);
      current = null;
    } else if (current !== null) {
      current.push(line);
    }
  }
  const severities: string[] = [];
  for (const block of blocks) {
    const fields = new Map<string, string>();
    for (const line of block) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (key === '') continue;
      const previous = fields.get(key);
      fields.set(key, previous === undefined ? value : `${previous}\n${value}`);
    }
    if ((fields.get('title') ?? '').trim() === '') continue;
    const raw = (fields.get('severity') ?? 'info').trim().toUpperCase();
    severities.push(LEVELS.find((level) => raw.includes(level)) ?? 'info');
  }
  return severities;
}

function startsWithLevel(text: string): boolean {
  return /^P[0-3]/.test(text);
}

function endsWithLevel(text: string): boolean {
  return /(?<![\p{L}\p{N}_])P[0-3]$/u.test(text);
}

/** The clause a tag sits in: after the last `.` `;` `:` `!` `?` or spaced dash. */
function clause(before: string): string {
  let start = 0;
  for (let i = 0; i < before.length; i += 1) {
    const c = before[i];
    const spacedDash =
      (c === '-' || c === '–' || c === '—') &&
      before[i - 1] === ' ' &&
      before[i + 1] === ' ';
    if (c === '.' || c === ';' || c === ':' || c === '!' || c === '?' || spacedDash)
      start = i + 1;
  }
  return before.slice(start);
}

/**
 * A negation right before the tag group ("no P1", "zero P0, P1 or P2",
 * "no blocking (P0/P1)"); at most one other word in between, and a contrast
 * ("but", "except") ends the search.
 */
function negated(clauseText: string): boolean {
  let rest = clauseText;
  let words = 0;
  for (;;) {
    rest = rest.replace(/[\s*_`([)\],/&]+$/u, '');
    if (endsWithLevel(rest)) {
      if (words > 0) return false;
      rest = rest.slice(0, -2);
      continue;
    }
    const match = /[\p{L}\p{N}'-]+$/u.exec(rest);
    const word = (match?.[0] ?? '').toLowerCase();
    rest = rest.slice(0, rest.length - (match?.[0].length ?? 0));
    if (word === '') return false;
    if (['no', 'none', 'zero', 'without', 'not', 'nothing'].includes(word)) return true;
    if (['or', 'and', 'nor'].includes(word) && words === 0) continue;
    if (['but', 'except', 'however', 'although', 'though', 'yet'].includes(word))
      return false;
    words += 1;
    if (words > 1) return false;
  }
}

function tagged(line: string, level: Level): boolean {
  for (
    let start = line.indexOf(level);
    start >= 0;
    start = line.indexOf(level, start + 1)
  ) {
    const beforeText = line.slice(0, start);
    const afterText = line.slice(start + level.length);
    const before = lastChar(beforeText);
    const after = firstChar(afterText);
    if (isWordChar(before) || isWordChar(after)) continue;
    // "P0–P3" names the scale, not a finding.
    const dash = (c: string | undefined): boolean => c === '-' || c === '–' || c === '—';
    const range =
      (dash(before) && endsWithLevel(Array.from(beforeText).slice(0, -1).join(''))) ||
      (dash(after) && startsWithLevel(Array.from(afterText).slice(1).join('')));
    if (!range && !negated(clause(beforeText))) return true;
  }
  return false;
}

export function reportedSeverity(text: string): Level | null {
  const findings = findingSeverities(text);
  if (findings.length > 0)
    return LEVELS.find((level) => findings.includes(level)) ?? null;
  const lines = text.split(/\r?\n/);
  return LEVELS.find((level) => lines.some((line) => tagged(line, level))) ?? null;
}
