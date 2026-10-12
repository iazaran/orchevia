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

/** CLI estimates cannot reconcile a subscription bill or measure remaining quota. */
export const CLI_COST_EXPLANATION =
  "CLI dollar estimates are not your subscription bill. Subscription limits and remaining quota are unavailable here; check your provider's usage page.";

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
    if (run.execution?.options.dryRun) continue;
    const results = runResults[run.id] ?? [];
    const def = byWorkflow.get(run.workflowId);
    const profileOf = (nodeId: string): string | null => {
      const node = def?.nodes.find((n) => n.id === nodeId);
      const id = node?.config.agentProfileId;
      return id !== undefined && id !== '' ? id : null;
    };
    const seen = new Set<string>();
    for (const r of results) {
      try {
        const metadata: unknown = JSON.parse(r.structuredJson ?? '{}');
        if (
          isRecord(metadata) &&
          (metadata.reusedFrom !== undefined || metadata.simulated === true)
        )
          continue;
      } catch {
        /* Old plain results retain local timing. */
      }
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

export interface UsageFilter {
  from?: string;
  to?: string;
  workflowIds?: string[];
  adapters?: string[];
  models?: string[];
  timezone?: string;
}

export interface UsageDay {
  day: string;
  runs: number;
  agentAttempts: number;
  reportedUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageWorkflowRow {
  workflowId: string;
  /** Workflow name recorded when the run started, not the current label. */
  workflowName: string;
  runs: number;
  agentAttempts: number;
  reportedUsd: number;
  unknownUsdAttempts: number;
}

export interface UsageModelRow {
  /** Adapter + model recorded at execution time; legacy rows are unknown. */
  adapter: string;
  model: string;
  agentAttempts: number;
  inputTokens: number;
  outputTokens: number;
  reportedUsd: number;
  observedToolCalls: number;
  observedSubagents: number;
}

export interface UsageTotals {
  runs: number;
  agentAttempts: number;
  failedAttempts: number;
  retriedAttempts: number;
  reusedResults: number;
  simulatedResults: number;
  inputTokens: number;
  outputTokens: number;
  reportedUsd: number;
  reportedUsdAttempts: number;
  unknownUsdAttempts: number;
  observedToolCalls: number;
  observedSubagents: number;
  unknownModelAttempts: number;
}

export interface UsageSummary {
  totals: UsageTotals;
  days: UsageDay[];
  byWorkflow: UsageWorkflowRow[];
  byModel: UsageModelRow[];
  from?: string;
  to?: string;
  timezone: string;
  runsScanned: number;
  /** Recent per-attempt CLI-reported USD samples (newest first, capped). */
  recentAttemptUsd: number[];
}

export function emptyUsageSummary(): UsageSummary {
  return {
    totals: {
      runs: 0,
      agentAttempts: 0,
      failedAttempts: 0,
      retriedAttempts: 0,
      reusedResults: 0,
      simulatedResults: 0,
      inputTokens: 0,
      outputTokens: 0,
      reportedUsd: 0,
      reportedUsdAttempts: 0,
      unknownUsdAttempts: 0,
      observedToolCalls: 0,
      observedSubagents: 0,
      unknownModelAttempts: 0,
    },
    days: [],
    byWorkflow: [],
    byModel: [],
    timezone: 'UTC',
    runsScanned: 0,
    recentAttemptUsd: [],
  };
}

/**
 * User-entered subscription fees for a billing period, plus explicit extra
 * charges. Illustrative settings only — never defaults or verified prices,
 * and never mixed into API-equivalent estimates.
 */
export interface SubscriptionFee {
  label: string;
  amountUsd: number;
  period: string;
}

export interface ExtraCharge {
  label: string;
  amountUsd: number;
}

export function subscriptionTotal(
  fees: SubscriptionFee[],
  extras: ExtraCharge[],
): number {
  return [...fees.map((f) => f.amountUsd), ...extras.map((e) => e.amountUsd)]
    .filter((n) => Number.isFinite(n) && n >= 0)
    .reduce((sum, n) => sum + n, 0);
}

/** Guarded parse for the subscription settings documents. */
export function parseMoneyList<T extends { amountUsd: number }>(
  raw: string | null,
  pick: (entry: Record<string, unknown>) => T | null,
): T[] {
  if (raw === null || raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: T[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
      const item = pick(entry as Record<string, unknown>);
      if (item !== null && Number.isFinite(item.amountUsd) && item.amountUsd >= 0)
        out.push(item);
    }
    return out;
  } catch {
    return [];
  }
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

/** Structured CLI facts only; no quota, spend estimates or mock token counts. */
export function agentContextDetails(structuredJson?: string): {
  sessionLabel: string | null;
  group: string;
  usageHints: string[];
  activity: string;
  /** Why the CLI ran in text mode and reported no usage, when it did. */
  outputNote: string;
  simulated: boolean;
} | null {
  if (!structuredJson) return null;
  try {
    const data: unknown = JSON.parse(structuredJson);
    if (!isRecord(data)) return null;
    const session = isRecord(data.agentSession) ? data.agentSession : null;
    const usage = isRecord(data.agentUsage) ? data.agentUsage : null;
    const outputNote =
      typeof data.agentOutputNote === 'string' ? data.agentOutputNote : '';
    if (!session && !usage && typeof data.agentActivity !== 'string' && outputNote === '')
      return null;
    const hints: string[] = [];
    for (const [key, label] of [
      ['input_tokens', 'input'],
      ['cached_input_tokens', 'cached input'],
      ['cache_read_input_tokens', 'cache read'],
      ['cache_creation_input_tokens', 'cache creation'],
      ['output_tokens', 'output'],
      ['reported_cost_usd', 'estimated API USD'],
    ]) {
      if (!key || !label) continue;
      const value: unknown = usage?.[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
        hints.push(`${label}: ${String(value)}`);
    }
    const turn: unknown = session?.turn;
    const simulated = data.simulated === true;
    return {
      sessionLabel:
        session && typeof turn === 'number' && Number.isInteger(turn) && turn > 0
          ? `${session.reused === true ? 'Resumed' : 'Fresh'} context · turn ${String(turn)}${simulated ? ' (simulated)' : ''}`
          : null,
      group: typeof session?.group === 'string' ? session.group : '',
      usageHints: hints,
      activity: typeof data.agentActivity === 'string' ? data.agentActivity : '',
      outputNote,
      simulated,
    };
  } catch {
    return null;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
