/**
 * Mirror of `review::reported_severity` (crates/core/src/review.rs): the highest
 * severity a step's output reports, for `node.<id>.severity`.
 *
 * Structured ```finding blocks win when present. Otherwise a `P0`–`P3` tag in
 * prose counts, except when it is part of a list or range (`P0/P1`, `P0–P3`)
 * or negated (`no P1`, `zero P0 or P1`): a clean review that says
 * "No P0/P1 issues found" reports no severity.
 */
const LEVELS = ['P0', 'P1', 'P2', 'P3'] as const;
type Level = (typeof LEVELS)[number];

const isWordChar = (c: string | undefined): boolean =>
  c !== undefined && /[\p{L}\p{N}_]/u.test(c);
const isLetter = (c: string): boolean => /\p{L}/u.test(c);
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
  return /P[0-3]$/.test(text);
}

function negated(before: string): boolean {
  let rest = before;
  for (;;) {
    const trimmed = rest.replace(/[\s*_`([,/&\-–—]+$/u, '');
    const lower = trimmed.toLowerCase();
    const connector = ['or', 'and', 'nor'].find(
      (word) =>
        lower.endsWith(word) &&
        !isWordChar(lastChar(lower.slice(0, lower.length - word.length))),
    );
    if (connector !== undefined) {
      rest = trimmed.slice(0, trimmed.length - connector.length);
    } else if (endsWithLevel(trimmed) && !isWordChar(lastChar(trimmed.slice(0, -2)))) {
      rest = trimmed.slice(0, -2);
    } else {
      const chars = Array.from(trimmed);
      const word: string[] = [];
      while (chars.length > 0 && isLetter(chars[chars.length - 1] ?? '')) {
        word.unshift(chars.pop() ?? '');
      }
      return ['no', 'zero', 'without', 'not', 'nor'].includes(
        word.join('').toLowerCase(),
      );
    }
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
    const joined = (c: string | undefined): boolean =>
      c === '/' || c === '-' || c === '–' || c === '—';
    const listed =
      before === '/' ||
      after === '/' ||
      (joined(before) && endsWithLevel(Array.from(beforeText).slice(0, -1).join(''))) ||
      (joined(after) && startsWithLevel(Array.from(afterText).slice(1).join('')));
    if (!listed && !negated(beforeText)) return true;
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
