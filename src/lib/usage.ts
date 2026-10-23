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
  "API value is what pay-as-you-go API pricing would charge for the same tokens, as the CLI reports it. On a monthly plan you pay the plan fee instead: enter it in Usage & costs to see your cost. Remaining quota is on your provider's usage page.";

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
  /** Only these runs (the Runs view asks for one run's part of its day). */
  runIds?: string[];
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

/**
 * Agent work per UTC day (the day each run started) and provider, so a monthly
 * plan's fee can be spread over the days it was used. The `all*` fields count
 * every dispatched attempt of that provider on that day, whatever the workflow,
 * run or model filters, so a filtered view gets its part of the day's fee
 * rather than all of it. They only see runs inside the requested `from`/`to`,
 * so callers ask for whole UTC days.
 */
export interface UsageProviderDay {
  day: string;
  adapter: string;
  agentAttempts: number;
  durationMs: number;
  reportedUsd: number;
  reportedUsdAttempts: number;
  allAgentAttempts: number;
  allDurationMs: number;
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
  /** Filtered attempts per UTC day and provider. */
  providerDays: UsageProviderDay[];
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
    providerDays: [],
  };
}

/** Providers a plan can be entered for (the adapters that report usage). */
export const PLAN_PROVIDERS = ['claude', 'codex'] as const;
export type PlanProvider = (typeof PLAN_PROVIDERS)[number];

export const PLAN_PROVIDER_LABELS: Record<PlanProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/** Upper bound for an entered monthly amount; anything above is a typo. */
export const MAX_PLAN_MONTHLY_USD = 100_000;

/**
 * What the user pays for one provider, as they entered it (never a looked-up
 * price). A monthly plan's fee is spread over the days that provider was used;
 * pay-per-use (`api`) billing costs the API value the CLI reports.
 */
export type ProviderPlan =
  | { billing: 'subscription'; monthlyUsd: number; name?: string }
  | { billing: 'api'; name?: string };

export type ProviderPlans = Partial<Record<PlanProvider, ProviderPlan>>;

function isPlanProvider(value: string): value is PlanProvider {
  return (PLAN_PROVIDERS as readonly string[]).includes(value);
}

/** Mirrors `validate_plans` in the core: same rules, same messages. */
export function validatePlans(value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Plans must be a JSON object keyed by provider.');
  }
  if (!isRecord(parsed))
    throw new Error('Plans must be a JSON object keyed by provider.');
  // The core reads providers in sorted key order; check them in the same order
  // so both report the same first problem.
  for (const provider of Object.keys(parsed).sort()) {
    const plan = parsed[provider];
    if (!isPlanProvider(provider))
      throw new Error(`Unknown plan provider '${provider}'.`);
    if (!isRecord(plan)) throw new Error('Each plan must be an object.');
    if (Object.keys(plan).some((key) => !['billing', 'monthlyUsd', 'name'].includes(key)))
      throw new Error('Plans hold only billing, monthlyUsd and name.');
    if (plan.billing === 'subscription') {
      const amount = plan.monthlyUsd;
      if (
        typeof amount !== 'number' ||
        !Number.isFinite(amount) ||
        amount < 0 ||
        amount > MAX_PLAN_MONTHLY_USD
      )
        throw new Error('A monthly plan needs its monthly USD amount, from 0 to 100000.');
    } else if (plan.billing === 'api') {
      if ('monthlyUsd' in plan)
        throw new Error('Pay-per-use billing has no monthly amount.');
    } else {
      throw new Error("Plan billing must be 'subscription' or 'api'.");
    }
    if (
      'name' in plan &&
      (typeof plan.name !== 'string' || new TextEncoder().encode(plan.name).length > 80)
    )
      throw new Error('A plan name is text of at most 80 bytes.');
  }
}

/** Saved plans; an unreadable document reads as no plans rather than failing the page. */
export function parsePlans(raw: string | null): ProviderPlans {
  if (raw === null || raw.trim() === '') return {};
  try {
    validatePlans(raw);
    const parsed = JSON.parse(raw) as Record<string, ProviderPlan>;
    const plans: ProviderPlans = {};
    for (const provider of PLAN_PROVIDERS) {
      const plan = parsed[provider];
      if (plan !== undefined) plans[provider] = plan;
    }
    return plans;
  } catch {
    return {};
  }
}

/** Share of plan use that goes through Orchevia, in percent; blank means all of it. */
export function parsePlanShare(raw: string | null): number {
  const text = raw?.trim() ?? '';
  if (text === '') return 100;
  const share = Number(text);
  return /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) &&
    Number.isFinite(share) &&
    share >= 0 &&
    share <= 100
    ? share
    : 100;
}

export function validateUsageSetting(key: string, value: string): void {
  if (key === 'usage.planShare') {
    if (value.trim() === '') return;
    const share = Number(value);
    if (
      !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) ||
      !Number.isFinite(share) ||
      share < 0 ||
      share > 100
    )
      throw new Error("Orchevia's share must be a percentage from 0 to 100.");
  } else if (key === 'usage.plans') {
    validatePlans(value);
  }
}

/** Days in the UTC month of a `YYYY-MM-DD` day (a monthly fee covers them all). */
export function daysInMonth(day: string): number {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(day);
  if (!match) return 30;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
}

export interface PlanCostLine {
  adapter: string;
  /** Null when no plan is entered for this provider: its cost is unknown. */
  plan: ProviderPlan | null;
  /** Estimated cost, or null when it cannot be worked out (no plan, or pay per use without any dollar report). */
  usd: number | null;
  /** Days with this provider's agent work in the filtered set. */
  activeDays: number;
  agentAttempts: number;
  /** API value the CLI reported for these attempts. */
  reportedUsd: number;
  /** Attempts without a USD report (pay-per-use cost is then partial). */
  unknownUsdAttempts: number;
}

export interface PlanCost {
  /** Sum of the lines whose cost is known; null when none is. */
  totalUsd: number | null;
  /** True when every line is known and none is missing USD reports. */
  complete: boolean;
  lines: PlanCostLine[];
  /** Estimated cost per UTC day (known lines only). */
  byDay: Record<string, number>;
  /** Days whose estimate leaves out a provider without a plan or a dollar report. */
  partialDays: string[];
}

/**
 * What the filtered agent work cost on the user's own plans.
 *
 * A monthly plan costs `monthlyUsd / days in that month` for each day its
 * provider was used, times `sharePct` (the part of plan use that goes through
 * Orchevia). When the view is filtered, each day's fee is split by agent time
 * against everything that provider ran that day. Pay-per-use billing costs the
 * reported API value. Providers without an entered plan stay unknown.
 */
export function estimatePlanCost(
  days: UsageProviderDay[],
  plans: ProviderPlans,
  sharePct = 100,
): PlanCost {
  const share = Number.isFinite(sharePct)
    ? Math.min(100, Math.max(0, sharePct)) / 100
    : 1;
  const lines = new Map<string, PlanCostLine>();
  const byDay: Record<string, number> = {};
  const partialDays = new Set<string>();
  for (const entry of days) {
    if (entry.agentAttempts <= 0) continue;
    const plan = isPlanProvider(entry.adapter) ? (plans[entry.adapter] ?? null) : null;
    const line = lines.get(entry.adapter) ?? {
      adapter: entry.adapter,
      plan,
      usd: plan?.billing === 'subscription' ? 0 : null,
      activeDays: 0,
      agentAttempts: 0,
      reportedUsd: 0,
      unknownUsdAttempts: 0,
    };
    line.activeDays += 1;
    line.agentAttempts += entry.agentAttempts;
    line.reportedUsd += entry.reportedUsd;
    line.unknownUsdAttempts += entry.agentAttempts - entry.reportedUsdAttempts;
    let usd: number | null = null;
    if (plan?.billing === 'subscription') {
      const part =
        entry.allDurationMs > 0
          ? entry.durationMs / entry.allDurationMs
          : entry.allAgentAttempts > 0
            ? entry.agentAttempts / entry.allAgentAttempts
            : 1;
      usd = (plan.monthlyUsd / daysInMonth(entry.day)) * Math.min(1, part) * share;
    } else if (plan?.billing === 'api' && entry.reportedUsdAttempts > 0) {
      // A day without any dollar report stays unknown, never USD 0.
      usd = entry.reportedUsd;
    }
    if (usd !== null) {
      line.usd = (line.usd ?? 0) + usd;
      byDay[entry.day] = (byDay[entry.day] ?? 0) + usd;
    }
    if (
      usd === null ||
      (plan?.billing === 'api' && entry.reportedUsdAttempts < entry.agentAttempts)
    )
      partialDays.add(entry.day);
    lines.set(entry.adapter, line);
  }
  const list = [...lines.values()].sort((a, b) => a.adapter.localeCompare(b.adapter));
  const known = list.filter((line) => line.usd !== null);
  return {
    totalUsd:
      known.length > 0 ? known.reduce((sum, line) => sum + (line.usd ?? 0), 0) : null,
    complete: list.every(
      (line) =>
        line.usd !== null &&
        (line.plan?.billing !== 'api' || line.unknownUsdAttempts === 0),
    ),
    lines: list,
    byDay,
    partialDays: [...partialDays].sort(),
  };
}

/** Provider name for cost rows: "Claude Code", "Codex", or the adapter as recorded. */
export function providerLabel(adapter: string): string {
  return isPlanProvider(adapter)
    ? PLAN_PROVIDER_LABELS[adapter]
    : adapter === 'unknown'
      ? 'Unknown (legacy)'
      : adapter;
}

/** Why an estimate is incomplete: providers without a plan, or pay-per-use attempts without a dollar report. */
export function planCostGap(cost: PlanCost): string | null {
  const missing = cost.lines.filter((line) => line.plan === null);
  if (missing.length > 0)
    return `No plan entered for ${missing.map((line) => providerLabel(line.adapter)).join(', ')}`;
  const unreported = cost.lines
    .filter((line) => line.plan?.billing === 'api')
    .reduce((sum, line) => sum + line.unknownUsdAttempts, 0);
  if (unreported === 0) return null;
  return `${unreported.toLocaleString('en-US')} pay-per-use attempt${unreported === 1 ? '' : 's'} reported no dollar figure`;
}

/**
 * Readable USD with two decimals. A small positive amount never renders as
 * measured zero.
 */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.005) return '< USD 0.01';
  return `USD ${value.toFixed(2)}`;
}

/** Exact reported precision for tooltips and detail rows. */
export function formatUsdExact(value: number): string {
  return `USD ${value.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 20, useGrouping: false })}`;
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
