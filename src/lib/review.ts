/** Browser-preview mirror of review.rs. The desktop reads visits from SQLite. */
import type { FindingHistory, GroupedFinding, ReviewFinding } from './scheduler';
import { findingFields, normalizeSeverity } from './severity';
import type { StoredNodeResult, Workflow } from './workflow';

interface ReviewVisit {
  nodeId: string;
  resultId: number;
  source: string;
  stdout: string;
}

const normalize = (text: string): string =>
  text
    .trim()
    .split(/\s+/u)
    .join(' ')
    .replace(/[A-Z]/g, (c) => c.toLowerCase());

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function fingerprint(finding: Omit<ReviewFinding, 'fingerprint'>): string {
  const { severity, file, lineStart, title, explanation } = finding;
  const head = Array.from(explanation).slice(0, 160).join('');
  const key = [
    normalize(severity),
    normalize(file ?? ''),
    lineStart ?? -1,
    normalize(title),
    normalize(head),
  ].join('|');
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(key)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function lineNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[+-]?\d+$/.test(raw)) return undefined;
  const number = Number(raw);
  return Number.isSafeInteger(number) ? number : undefined;
}

function extractFindings(visit: ReviewVisit): ReviewFinding[] {
  const unique = new Map<string, ReviewFinding>();
  for (const fields of findingFields(visit.stdout)) {
    const finding = {
      severity: normalizeSeverity(fields.get('severity') ?? ''),
      category: fields.get('category') ?? '',
      title: fields.get('title') ?? '',
      explanation: fields.get('explanation') ?? '',
      file: fields.get('file')?.trim() || undefined,
      lineStart: lineNumber(fields.get('line') ?? fields.get('line_start')),
      lineEnd: lineNumber(fields.get('line_end')),
      confidence: fields.get('confidence'),
      source: visit.source,
      suggestedFix: fields.get('fix') ?? fields.get('suggested_fix'),
    };
    const id = fingerprint(finding);
    if (!unique.has(id)) unique.set(id, { ...finding, fingerprint: id });
  }
  return [...unique.values()];
}

function comparisonKey(finding: ReviewFinding): string {
  const file = finding.file?.replace(/^(\.\/)+/, '');
  const title = normalize(
    finding.title
      .replace(/^#+/, '')
      .trim()
      .replace(/[.:]+$/, ''),
  );
  return JSON.stringify([file, title]);
}

function matchDistance(a: ReviewFinding, b: ReviewFinding): number | undefined {
  if (a.lineStart === undefined || b.lineStart === undefined) return undefined;
  const endA = Math.max(a.lineStart, a.lineEnd ?? a.lineStart);
  const endB = Math.max(b.lineStart, b.lineEnd ?? b.lineStart);
  return Math.max(0, b.lineStart - endA, a.lineStart - endB);
}

type Occurrence = FindingHistory['occurrences'][number];

function compareVisits(
  nodeId: string,
  visits: { resultId: number; findings: ReviewFinding[] }[],
): FindingHistory[] {
  const tracks: Occurrence[][] = [];
  for (const [offset, { resultId, findings }] of visits.entries()) {
    const previous = new Map<
      string,
      { track: Occurrence[]; index: number; last: Occurrence }[]
    >();
    for (const [index, track] of tracks.entries()) {
      const last = track.at(-1);
      if (last === undefined) continue;
      const key = comparisonKey(last.finding);
      const prior = previous.get(key) ?? [];
      prior.push({ track, index, last });
      previous.set(key, prior);
    }
    const keys = findings.map(comparisonKey);
    const counts = new Map<string, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    const candidates = findings.flatMap((finding, index) => {
      const key = comparisonKey(finding);
      const prior = previous.get(key) ?? [];
      const unique = prior.length === 1 && counts.get(key) === 1;
      return prior.flatMap(({ track, index: trackIndex, last }) => {
        const distance = matchDistance(last.finding, finding);
        return unique || (distance !== undefined && distance <= 20)
          ? [{ track, trackIndex, index, last: last.visit, distance: distance ?? 21 }]
          : [];
      });
    });
    candidates.sort(
      (a, b) =>
        a.distance - b.distance ||
        b.last - a.last ||
        a.trackIndex - b.trackIndex ||
        a.index - b.index,
    );
    const used = new Set<Occurrence[]>();
    const matches = new Map<number, Occurrence[]>();
    for (const { track, index } of candidates) {
      if (used.has(track) || matches.has(index)) continue;
      matches.set(index, track);
      used.add(track);
    }
    for (const [index, finding] of findings.entries()) {
      const occurrence = { resultId, visit: offset + 1, finding };
      const track = matches.get(index);
      if (track === undefined) tracks.push([occurrence]);
      else track.push(occurrence);
    }
  }
  return tracks.flatMap((occurrences) => {
    const first = occurrences[0];
    const last = occurrences.at(-1);
    if (first === undefined || last === undefined) return [];
    const previous = occurrences.at(-2);
    let state: FindingHistory['state'] = 'new';
    if (last.visit < visits.length) state = 'fixed';
    else if (previous !== undefined)
      state = previous.visit + 1 === last.visit ? 'stillOpen' : 'reintroduced';
    return [
      {
        id: [nodeId, first.resultId, first.finding.fingerprint].join(':'),
        state,
        occurrences,
        ...(previous !== undefined && previous.finding.severity !== last.finding.severity
          ? { previousSeverity: previous.finding.severity }
          : {}),
      },
    ];
  });
}

export function groupedReviewFindings(visits: ReviewVisit[]): GroupedFinding[] {
  const byNode = new Map<string, ReviewVisit[]>();
  for (const visit of visits) {
    const history = byNode.get(visit.nodeId) ?? [];
    history.push(visit);
    byNode.set(visit.nodeId, history);
  }
  const groups = new Map<string, GroupedFinding>();
  const histories: FindingHistory[] = [];
  for (const nodeId of [...byNode.keys()].sort(compareText)) {
    const completed = (byNode.get(nodeId) ?? [])
      .sort((a, b) => a.resultId - b.resultId)
      .map((visit) => ({ resultId: visit.resultId, findings: extractFindings(visit) }));
    const latest = completed.at(-1);
    if (latest === undefined) continue;
    for (const finding of latest.findings) {
      const existing = groups.get(finding.fingerprint);
      groups.set(finding.fingerprint, {
        finding: existing?.finding ?? finding,
        sources: [...new Set([...(existing?.sources ?? []), finding.source])].sort(
          compareText,
        ),
        resultIds: [...(existing?.resultIds ?? []), latest.resultId],
      });
    }
    if (completed.length > 1) histories.push(...compareVisits(nodeId, completed));
  }
  const current = [...groups.values()].sort(
    (a, b) =>
      compareText(a.finding.severity, b.finding.severity) ||
      compareText(a.finding.title, b.finding.title) ||
      compareText(a.finding.fingerprint, b.finding.fingerprint),
  );
  const historical: GroupedFinding[] = [];
  for (const history of histories) {
    const last = history.occurrences.at(-1);
    if (last === undefined) continue;
    const finding = last.finding;
    const existing = groups.get(finding.fingerprint);
    if (existing !== undefined) (existing.history ??= []).push(history);
    else {
      const group = { finding, sources: [], history: [history] };
      groups.set(finding.fingerprint, group);
      historical.push(group);
    }
  }
  return [...current, ...historical];
}

export function runReviewFindings(
  workflow: Workflow,
  results: StoredNodeResult[],
  profileName: (id: string) => string | undefined,
): GroupedFinding[] {
  const sources = new Map(
    workflow.nodes
      .filter((node) => node.type === 'agent')
      .map((node) => {
        const label = profileName(node.config.agentProfileId ?? '');
        return [node.id, label?.trim() ? `${node.id} (${label})` : node.id];
      }),
  );
  const visits: ReviewVisit[] = [];
  for (const row of results) {
    const source = sources.get(row.nodeId);
    if (source === undefined || row.status !== 'succeeded') continue;
    try {
      const data: unknown = JSON.parse(row.structuredJson ?? '{}');
      if (
        data !== null &&
        typeof data === 'object' &&
        ('reusedFrom' in data ||
          'feedbackCheck' in data ||
          ('simulated' in data && data.simulated === true))
      )
        continue;
    } catch {
      continue;
    }
    visits.push({ nodeId: row.nodeId, resultId: row.id, source, stdout: row.stdout });
  }
  return groupedReviewFindings(visits);
}
