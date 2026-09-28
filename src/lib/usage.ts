/**
 * Honest, local-only usage reporting.
 *
 * Orchevia cannot know remaining AI quota — that lives in the CLI/provider
 * dashboard. What it can show:
 * - per-run local facts (duration, attempts, profile attribution);
 * - per-profile aggregates from run history (runs + total execution time);
 * - usage hints the CLI itself printed (tokens/cost/duration patterns).
 */

import type { StoredNodeResult, StoredRun } from './workflow';
import type { AgentProfile } from './agents';

export interface ProfileUsage {
  profileId: string;
  profileName: string;
  adapter: string;
  runs: number;
  totalDurationMs: number;
  lastRunAt: string | null;
}

/** Aggregate local execution facts per Agent Profile from run history. */
export function aggregateProfileUsage(
  profiles: AgentProfile[],
  runs: StoredRun[],
  runResults: Record<string, StoredNodeResult[]>,
  workflows: {
    id: string;
    definition: {
      nodes: { id: string; type: string; config: { agentProfileId?: string } }[];
    };
  }[],
): ProfileUsage[] {
  const byWorkflow = new Map(workflows.map((w) => [w.id, w.definition]));
  const stats = new Map<
    string,
    { runs: Set<string>; totalMs: number; last: string | null }
  >();
  for (const run of runs) {
    const results = runResults[run.id] ?? [];
    const def = byWorkflow.get(run.workflowId);
    const profileOf = (nodeId: string): string | null => {
      const node = def?.nodes.find((n) => n.id === nodeId);
      const id = node?.config.agentProfileId;
      return id !== undefined && id !== '' ? id : null;
    };
    const seen = new Set<string>();
    for (const r of results) {
      const pid = profileOf(r.nodeId);
      if (pid === null) continue;
      const entry = stats.get(pid) ?? { runs: new Set<string>(), totalMs: 0, last: null };
      entry.totalMs += r.durationMs ?? 0;
      if (!seen.has(pid)) {
        seen.add(pid);
        entry.runs.add(run.id);
        if (entry.last === null || run.startedAt > entry.last) entry.last = run.startedAt;
      }
      stats.set(pid, entry);
    }
  }
  return profiles.map((p) => {
    const entry = stats.get(p.id);
    return {
      profileId: p.id,
      profileName: p.name,
      adapter: p.adapter,
      runs: entry?.runs.size ?? 0,
      totalDurationMs: entry?.totalMs ?? 0,
      lastRunAt: entry?.last ?? null,
    };
  });
}

/** Patterns CLIs commonly print (tokens, cost, elapsed). Display-only. */
const HINT_PATTERNS: RegExp[] = [
  /tokens?\s*[:=]?\s*\d[\d,]*/i,
  /input\s*[:=]?\s*\d+.*output\s*[:=]?\s*\d+/is,
  /\$\s?\d+\.\d{2,}/,
  /cost\s*[:=]/i,
  /elapsed\s*[:=]?\s*[\d.]+s/i,
  /duration\s*[:=]?\s*[\d.]+s/i,
];

export function extractUsageHints(stdout: string, stderr: string): string[] {
  const hints: string[] = [];
  const text = `${stdout}\n${stderr}`;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.length > 220) continue;
    if (HINT_PATTERNS.some((re) => re.test(trimmed)) && !hints.includes(trimmed)) {
      hints.push(trimmed);
    }
    if (hints.length >= 5) break;
  }
  return hints;
}

export function formatDurationMs(ms: number): string {
  if (ms <= 0) return '—';
  if (ms < 1000) return `${String(ms)}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${String(secs)}s`;
  const mins = Math.floor(secs / 60);
  const rest = secs % 60;
  return rest === 0 ? `${String(mins)}m` : `${String(mins)}m ${String(rest)}s`;
}
