/**
 * Honest, local-only usage reporting.
 *
 * Orchevia cannot know remaining AI quota — that lives in the CLI/provider
 * dashboard. What it can show:
 * - per-run local facts (duration, attempts, profile attribution);
 * - per-profile aggregates from run history (runs + total execution time);
 * - usage hints the CLI itself printed (tokens/cost/duration patterns).
 */

/** CLI estimates cannot reconcile a subscription bill or measure remaining quota. */
export const CLI_COST_EXPLANATION =
  "CLI dollar estimates are not your subscription bill. Subscription limits and remaining quota are unavailable here; check your provider's usage page.";

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

export interface UsageProfileRow {
  /** Profile ID from the saved run snapshot; never today's workflow assignment. */
  profileId: string | null;
  runs: number;
  agentAttempts: number;
  totalDurationMs: number;
  lastRunAt?: string;
  reportedUsd: number;
  reportedUsdAttempts: number;
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
  reportedUsdAttempts: number;
  unknownUsdAttempts: number;
  observedToolCalls: number;
  observedSubagents: number;
  cachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  coverage: UsageCoverage;
}

/** Attempts reporting each metric; missing fields never become measured zeroes. */
export interface UsageCoverage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  toolCalls: number;
  subagents: number;
}

export function emptyUsageCoverage(): UsageCoverage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    toolCalls: 0,
    subagents: 0,
  };
}

export function measuredUsage(
  usage: Record<string, unknown> | null,
  adapter: string,
): Omit<
  UsageModelRow,
  | 'adapter'
  | 'model'
  | 'agentAttempts'
  | 'reportedUsd'
  | 'reportedUsdAttempts'
  | 'unknownUsdAttempts'
> {
  const count = (key: string): number | undefined => {
    const value = usage?.[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;
  };
  const input = count('input_tokens');
  const output = count('output_tokens');
  const cached = count('cached_input_tokens');
  const read = count('cache_read_input_tokens');
  const created = count('cache_creation_input_tokens');
  const reasoning = count('reasoning_output_tokens');
  const tools = count('observed_tool_calls');
  const subs = count('observed_subagents');
  return {
    inputTokens: (input ?? 0) + (adapter === 'claude' ? (read ?? 0) + (created ?? 0) : 0),
    outputTokens: output ?? 0,
    cachedInputTokens: cached ?? 0,
    cacheReadInputTokens: read ?? 0,
    cacheCreationInputTokens: created ?? 0,
    reasoningOutputTokens: reasoning ?? 0,
    observedToolCalls: tools ?? 0,
    observedSubagents: subs ?? 0,
    coverage: {
      inputTokens: Number(
        input !== undefined &&
          (adapter !== 'claude' || (read !== undefined && created !== undefined)),
      ),
      outputTokens: Number(output !== undefined),
      cachedInputTokens: Number(cached !== undefined),
      cacheReadInputTokens: Number(read !== undefined),
      cacheCreationInputTokens: Number(created !== undefined),
      reasoningOutputTokens: Number(reasoning !== undefined),
      toolCalls: Number(tools !== undefined),
      subagents: Number(subs !== undefined),
    },
  };
}

export function addUsageCoverage(target: UsageCoverage, coverage: UsageCoverage): void {
  for (const key of Object.keys(target) as (keyof UsageCoverage)[])
    target[key] += coverage[key];
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
  cachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningOutputTokens: number;
  coverage: UsageCoverage;
}

export interface UsageSummary {
  totals: UsageTotals;
  days: UsageDay[];
  byWorkflow: UsageWorkflowRow[];
  byModel: UsageModelRow[];
  byProfile: UsageProfileRow[];
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
      cachedInputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 0,
      coverage: emptyUsageCoverage(),
    },
    days: [],
    byWorkflow: [],
    byModel: [],
    byProfile: [],
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
  period?: string;
}

/** Explicit UTC billing periods; old free-form labels stay visible outside allocation. */
export function billingPeriod(period: string): { from: string; to: string } | null {
  const match = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(period);
  const from = match?.[1];
  const to = match?.[2];
  if (!from || !to) return null;
  const valid = (day: string): boolean => {
    const time = Date.parse(`${day}T00:00:00.000Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day;
  };
  return valid(from) && valid(to) && from < to ? { from, to } : null;
}

export function validateUsageSetting(key: string, value: string): void {
  if (key === 'usage.allocationShare') {
    if (value.trim() === '') return;
    const share = Number(value);
    if (
      !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) ||
      !Number.isFinite(share) ||
      share < 0 ||
      share > 100
    )
      throw new Error('Orchevia share must be a finite percentage from 0 to 100.');
  } else if (key === 'usage.allocationMethod') {
    if (!['manual', 'proportional', 'even'].includes(value))
      throw new Error('Unknown allocation method.');
  } else if (key === 'usage.subscriptionFees' || key === 'usage.extraCharges') {
    let entries: unknown;
    try {
      entries = JSON.parse(value);
    } catch {
      throw new Error('Fee list must be a JSON array.');
    }
    if (!Array.isArray(entries) || entries.length > 100)
      throw new Error('Fee list must be a JSON array with at most 100 entries.');
    for (const entry of entries) {
      if (
        !isRecord(entry) ||
        typeof entry.label !== 'string' ||
        entry.label.trim() === '' ||
        new TextEncoder().encode(entry.label).length > 200 ||
        typeof entry.amountUsd !== 'number' ||
        !Number.isFinite(entry.amountUsd) ||
        entry.amountUsd < 0 ||
        (key === 'usage.subscriptionFees' && typeof entry.period !== 'string') ||
        (entry.period !== undefined &&
          (typeof entry.period !== 'string' ||
            new TextEncoder().encode(entry.period).length > 120))
      )
        throw new Error(
          'Fees require a label, a finite nonnegative USD amount and a bounded period label.',
        );
    }
  }
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
