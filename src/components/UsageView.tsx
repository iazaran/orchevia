import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Notice, useNoticeMessage } from './Notice';
import { confirmDialog } from './ConfirmDialog';
import { getBackend } from '../lib/backend';
import { errorMessage } from '../lib/errors';
import { estimateRangeUsd } from '../lib/run-controls';
import { formatTime } from '../lib/time';
import {
  emptyUsageSummary,
  parseMoneyList,
  subscriptionTotal,
  billingPeriod,
  formatDurationMs,
  type ExtraCharge,
  type SubscriptionFee,
  type UsageDay,
  type UsageSummary,
} from '../lib/usage';
import { useAppStore } from '../store';

const FEES_KEY = 'usage.subscriptionFees';
const EXTRAS_KEY = 'usage.extraCharges';
const SHARE_KEY = 'usage.allocationShare';
const METHOD_KEY = 'usage.allocationMethod';
/** Zero-filled calendar span is capped so unbounded ranges stay cheap. */
const MAX_CHART_DAYS = 366;

function isoDay(offsetDays: number): string {
  const date = new Date(Date.now() - offsetDays * 86_400_000);
  return date.toISOString().slice(0, 10);
}

/** Thousands separators for counts; never invents precision. */
function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Readable USD with two decimals. A small positive amount never renders as
 * measured zero.
 */
function formatUsd(value: number): string {
  if (value > 0 && value < 0.005) return '< USD 0.01';
  return `USD ${value.toFixed(2)}`;
}

/** Exact reported precision for tooltips and detail rows. */
function formatUsdExact(value: number): string {
  return `USD ${value.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 20, useGrouping: false })}`;
}

function isDayString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function nextDay(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * The backend only returns days with runs. Fill every calendar day in the
 * selected span with explicit zeroes so sparse activity never reads as
 * consecutive dates.
 */
function fillDays(
  active: UsageDay[],
  from: string,
  to: string,
): { days: UsageDay[]; truncated: boolean } {
  const first = active[0]?.day ?? '';
  const last = active[active.length - 1]?.day ?? '';
  const start = from !== '' && isDayString(from) ? from : first;
  const end = to !== '' && isDayString(to) ? to : last;
  if (start === '' || end === '' || start > end)
    return { days: active, truncated: false };
  const byDay = new Map(active.map((day) => [day.day, day]));
  const days: UsageDay[] = [];
  let cursor = start;
  let truncated = false;
  while (cursor <= end) {
    const known = byDay.get(cursor);
    days.push(
      known ?? {
        day: cursor,
        runs: 0,
        agentAttempts: 0,
        reportedUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
    );
    if (days.length >= MAX_CHART_DAYS) {
      truncated = nextDay(cursor) <= end;
      break;
    }
    cursor = nextDay(cursor);
  }
  return { days, truncated };
}

/** Small integer tick steps (1/2/5 × 10^k) for the attempts axis. */
function attemptTicks(maxValue: number): number[] {
  if (maxValue <= 0) return [0];
  const raw = maxValue / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const exact =
    normalized <= 1
      ? magnitude
      : normalized <= 2
        ? 2 * magnitude
        : normalized <= 5
          ? 5 * magnitude
          : 10 * magnitude;
  // Attempt counts are integers: never offer fractional ticks.
  const step = Math.max(1, exact);
  const ticks: number[] = [];
  for (let value = 0; value < maxValue; value += step) ticks.push(value);
  const top = ticks[ticks.length - 1] ?? 0;
  ticks.push(top < maxValue ? top + step : top);
  return ticks;
}

function DailyChart({ days }: { days: UsageDay[] }): React.JSX.Element {
  const height = 240;
  const padLeft = 60;
  const padTop = 10;
  const padBottom = 30;
  const padRight = 10;
  const count = days.length;
  // Keep axis text and plot height independent of the date span. More days
  // produce narrower bars, not a huge viewBox scaled into unreadable labels.
  const width = 760;
  const plotWidth = width - padLeft - padRight;
  const slot = Math.min(96, plotWidth / Math.max(1, count));
  const barWidth = Math.min(34, slot * 0.62);
  const startX = padLeft + (plotWidth - count * slot) / 2;
  const maxAttempts = Math.max(0, ...days.map((d) => d.agentAttempts));
  const ticks = attemptTicks(maxAttempts);
  const top = ticks[ticks.length - 1] ?? 0;
  const plotHeight = height - padTop - padBottom;
  const baseline = padTop + plotHeight;
  const y = (value: number): number =>
    top === 0 ? baseline : padTop + plotHeight * (1 - value / top);
  const labelStride = Math.max(1, Math.ceil(count / 10));
  const firstDay = days[0]?.day ?? '';
  const lastDay = days[days.length - 1]?.day ?? '';

  return (
    <div className="usage-chart-panel">
      <svg
        className="usage-chart"
        viewBox={`0 0 ${String(width)} ${String(height)}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Agent attempts per UTC day from ${firstDay} to ${lastDay}`}
        style={{ width: '100%', height: 240, maxWidth: 760 }}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={padLeft}
              x2={width - padRight}
              y1={y(tick)}
              y2={y(tick)}
              className="usage-grid"
            />
            <text x={padLeft - 6} y={y(tick) + 4} textAnchor="end" className="usage-tick">
              {formatCount(tick)}
            </text>
          </g>
        ))}
        <line
          x1={padLeft}
          x2={width - padRight}
          y1={baseline}
          y2={baseline}
          className="usage-axis"
        />
        {days.map((day, index) => {
          const barHeight =
            day.agentAttempts === 0 || top === 0 ? 0 : y(0) - y(day.agentAttempts);
          const x = startX + index * slot + (slot - barWidth) / 2;
          return (
            <g key={day.day}>
              {day.agentAttempts > 0 && (
                <rect
                  x={x}
                  y={y(day.agentAttempts)}
                  width={barWidth}
                  height={barHeight}
                  className="usage-bar"
                >
                  <title>
                    {day.day}: {formatCount(day.agentAttempts)} attempts,{' '}
                    {formatCount(day.runs)} runs, {formatUsdExact(day.reportedUsd)}{' '}
                    reported subtotal
                  </title>
                </rect>
              )}
              {index % labelStride === 0 && (
                <text
                  x={startX + index * slot + slot / 2}
                  y={height - 10}
                  textAnchor="middle"
                  className="usage-tick"
                >
                  {day.day.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <p className="field-hint">
        Metric: agent attempts per UTC calendar day. Days without runs show no bar (zero),
        never a gap in the date sequence.
      </p>
    </div>
  );
}

/** Inline validation for the date filters; the summary request never fires while set. */
function dateRangeError(from: string, to: string): string | null {
  if (from !== '' && !isDayString(from))
    return 'Start date must be a valid calendar date (YYYY-MM-DD).';
  if (to !== '' && !isDayString(to))
    return 'End date must be a valid calendar date (YYYY-MM-DD).';
  if (from !== '' && to !== '' && from > to)
    return 'Start date must be on or before the end date.';
  return null;
}

/**
 * One usage figure with its coverage stated inline: measured zero (full
 * reports, value 0), partial, or unknown (no reports). Never combines the
 * value with other counters.
 */
function CoveredValue({
  value,
  reported,
  attempts,
  format,
}: {
  value: number;
  reported: number;
  attempts: number;
  format: (value: number) => string;
}): React.JSX.Element {
  if (attempts === 0) return <>—</>;
  if (reported === 0)
    return <span title="No attempts reported this metric">Unknown</span>;
  const text = format(value);
  if (reported < attempts)
    return (
      <span
        title={`${formatCount(reported)} of ${formatCount(attempts)} attempts reported this metric; missing reports excluded`}
      >
        {text} <span className="coverage-flag">partial</span>
      </span>
    );
  return <span>{text}</span>;
}

type BreakdownTab = 'workflow' | 'profile' | 'model';
const BREAKDOWN_TABS: [BreakdownTab, string][] = [
  ['workflow', 'Workflow'],
  ['profile', 'AI profile'],
  ['model', 'Provider & model'],
];

export function UsageView(): React.JSX.Element {
  const workflows = useAppStore((s) => s.workflows);
  const profiles = useAppStore((s) => s.profiles);
  const setView = useAppStore((s) => s.setView);
  const [from, setFrom] = useState(() => isoDay(29));
  const [to, setTo] = useState(() => isoDay(0));
  const [workflowId, setWorkflowId] = useState('');
  const [adapter, setAdapter] = useState('');
  const [model, setModel] = useState('');
  const [breakdown, setBreakdown] = useState<BreakdownTab>('workflow');
  const [summary, setSummary] = useState<UsageSummary>(emptyUsageSummary());
  const [loading, setLoading] = useState(true);
  const [error, setError, , errorEvent] = useNoticeMessage('error');
  const filterError = dateRangeError(from, to);
  const [fees, setFees] = useState<SubscriptionFee[]>([]);
  const [extras, setExtras] = useState<ExtraCharge[]>([]);
  const [share, setShare] = useState('');
  const [method, setMethod] = useState('manual');
  const [settingsError, setSettingsError, , settingsErrorEvent] =
    useNoticeMessage('error');
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsLoadAttempt, setSettingsLoadAttempt] = useState(0);
  const [target, setTarget] = useState('');
  const [newFeeLabel, setNewFeeLabel] = useState('');
  const [newFeeAmount, setNewFeeAmount] = useState('');
  const [newFeePeriod, setNewFeePeriod] = useState('');
  const [newExtraLabel, setNewExtraLabel] = useState('');
  const [newExtraAmount, setNewExtraAmount] = useState('');
  const [newExtraPeriod, setNewExtraPeriod] = useState('');
  const refreshGeneration = useRef(0);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);

  const draftSnapshot = JSON.stringify({
    fees,
    extras,
    share: share.trim(),
    method,
  });
  const settingsLoaded = savedSnapshot !== null;
  const settingsDirty = settingsLoaded && draftSnapshot !== savedSnapshot;

  const refresh = useCallback(() => {
    // Invalid or reversed dates show inline validation; no request is built.
    if (filterError !== null) return;
    const generation = ++refreshGeneration.current;
    void (async () => {
      setLoading(true);
      setError(null);
      const filter: {
        from?: string;
        to?: string;
        workflowIds?: string[];
        adapters?: string[];
        models?: string[];
        timezone?: string;
      } = {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
      if (from !== '') filter.from = `${from}T00:00:00.000Z`;
      // `to` is an inclusive calendar day in the UI; the backend boundary is
      // exclusive, so advance it by one day.
      if (to !== '') {
        const exclusive = new Date(`${to}T00:00:00.000Z`);
        exclusive.setUTCDate(exclusive.getUTCDate() + 1);
        filter.to = exclusive.toISOString();
      }
      if (workflowId !== '') filter.workflowIds = [workflowId];
      if (adapter !== '') filter.adapters = [adapter];
      if (model.trim() !== '') filter.models = [model.trim()];
      try {
        const result = await getBackend().usageSummary(filter);
        if (refreshGeneration.current === generation) setSummary(result);
      } catch (err: unknown) {
        if (refreshGeneration.current === generation) setError(errorMessage(err));
      } finally {
        if (refreshGeneration.current === generation) setLoading(false);
      }
    })();
  }, [from, to, workflowId, adapter, model, setError, filterError]);

  useEffect(() => {
    refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getBackend().getSetting(FEES_KEY),
      getBackend().getSetting(EXTRAS_KEY),
      getBackend().getSetting(SHARE_KEY),
      getBackend().getSetting(METHOD_KEY),
    ])
      .then(([feesRaw, extrasRaw, shareRaw, methodRaw]) => {
        if (cancelled) return;
        const nextFees = parseMoneyList<SubscriptionFee>(feesRaw, (entry) =>
          typeof entry.label === 'string' && typeof entry.period === 'string'
            ? {
                label: entry.label,
                amountUsd: typeof entry.amountUsd === 'number' ? entry.amountUsd : NaN,
                period: entry.period,
              }
            : null,
        );
        const nextExtras = parseMoneyList<ExtraCharge>(extrasRaw, (entry) =>
          typeof entry.label === 'string'
            ? {
                label: entry.label,
                amountUsd: typeof entry.amountUsd === 'number' ? entry.amountUsd : NaN,
                ...(typeof entry.period === 'string' ? { period: entry.period } : {}),
              }
            : null,
        );
        setFees(nextFees);
        setExtras(nextExtras);
        setShare(shareRaw ?? '');
        setMethod('manual');
        setSavedSnapshot(
          JSON.stringify({
            fees: nextFees,
            extras: nextExtras,
            share: (shareRaw ?? '').trim(),
            method: methodRaw === 'manual' ? methodRaw : 'manual',
          }),
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) setSettingsError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setSettingsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [setSettingsError, settingsLoadAttempt]);

  const saveSettings = (): void => {
    if (savingRef.current || !settingsDirty) return;
    savingRef.current = true;
    setSettingsError(null);
    setSettingsSaved(false);
    setSaving(true);
    const snapshot = draftSnapshot;
    void (async () => {
      try {
        const backend = getBackend();
        await backend.setSetting(FEES_KEY, JSON.stringify(fees));
        await backend.setSetting(EXTRAS_KEY, JSON.stringify(extras));
        await backend.setSetting(SHARE_KEY, share.trim());
        await backend.setSetting(METHOD_KEY, method);
        // Success is claimed only when every required write succeeded.
        // Drafts stay in state either way, so a failure loses nothing.
        setSavedSnapshot(snapshot);
        setSettingsSaved(true);
      } catch (err: unknown) {
        setSettingsError(errorMessage(err));
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    })();
  };

  const removeFee = (index: number): void => {
    const fee = fees[index];
    void confirmDialog({
      title: 'Remove this fee?',
      message: `“${fee?.label ?? ''}” leaves the draft. Save to persist the removal.`,
      confirmLabel: 'Remove',
      danger: true,
    }).then((ok) => {
      if (ok) {
        setSettingsSaved(false);
        setFees(fees.filter((_, i) => i !== index));
      }
    });
  };

  const removeExtra = (index: number): void => {
    const extra = extras[index];
    void confirmDialog({
      title: 'Remove this extra charge?',
      message: `“${extra?.label ?? ''}” leaves the draft. Save to persist the removal.`,
      confirmLabel: 'Remove',
      danger: true,
    }).then((ok) => {
      if (ok) {
        setSettingsSaved(false);
        setExtras(extras.filter((_, i) => i !== index));
      }
    });
  };

  const totals = summary.totals;
  const feeTotal = useMemo(() => subscriptionTotal(fees, extras), [fees, extras]);
  const inAllocationRange = useCallback(
    (period: string): boolean => {
      const bounds = billingPeriod(period);
      return (
        bounds !== null &&
        (from === '' || bounds.to > from) &&
        (to === '' || bounds.from <= to)
      );
    },
    [from, to],
  );
  const allocationPool = useMemo(
    () =>
      subscriptionTotal(
        fees.filter((fee) => inAllocationRange(fee.period)),
        extras.filter((extra) => inAllocationRange(extra.period ?? '')),
      ),
    [fees, extras, inAllocationRange],
  );
  const sharePct = Number(share);
  const shareValid =
    share.trim() !== '' && Number.isFinite(sharePct) && sharePct >= 0 && sharePct <= 100;
  const allocated = shareValid ? (allocationPool * sharePct) / 100 : null;
  const targetNum = Number(target);
  const estimate = useMemo(
    () =>
      summary.byWorkflow.length === 1 &&
      summary.byModel.length === 1 &&
      summary.byModel[0]?.model !== 'unknown' &&
      summary.byModel[0]?.adapter !== 'unknown'
        ? estimateRangeUsd(summary.recentAttemptUsd, 3)
        : undefined,
    [summary],
  );
  const modelOptions = useMemo(
    () => [...new Set(summary.byModel.map((row) => row.model))].sort(),
    [summary.byModel],
  );
  const chart = useMemo(() => fillDays(summary.days, from, to), [summary.days, from, to]);
  // Filling calendar gaps is bounded, but the accessible table must retain all
  // actual activity even when the selected range exceeds that chart limit.
  const dailyRows = chart.truncated ? summary.days : chart.days;

  const applyPreset = (days: number): void => {
    setFrom(isoDay(days - 1));
    setTo(isoDay(0));
  };

  const resetFilters = (): void => {
    setFrom(isoDay(29));
    setTo(isoDay(0));
    setWorkflowId('');
    setAdapter('');
    setModel('');
  };

  const filtersCustomized =
    from !== isoDay(29) ||
    to !== isoDay(0) ||
    workflowId !== '' ||
    adapter !== '' ||
    model !== '';

  return (
    <>
      <div className="topbar">
        <h1>Usage & costs</h1>
        <span className="topbar-sub">
          Measured local-agent work and honest cost separation.
        </span>
        <div className="topbar-actions">
          <button className="btn btn-ghost" onClick={() => setView('runs')}>
            Runs
          </button>
          <button className="btn" onClick={refresh} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>
      <div className="view usage-view">
        <p className="field-hint" style={{ marginTop: 0 }}>
          Subscription fees you enter, CLI-reported API-equivalent estimates with their
          coverage, and an optional manual allocation stay in separate lanes. Orchevia
          cannot see subscription balances or remaining quota.
        </p>
        <details className="field-hint usage-about">
          <summary>What each figure means</summary>
          <p>
            Dates group by UTC day; your display timezone is {summary.timezone || 'UTC'}.
            Dry runs never contribute to consumption totals. History aggregates over every
            stored run, not just the recent Runs list. CLI dollar figures are
            API-equivalent estimates reported by the CLI itself — never subscription
            spend, remaining quota, or an enforceable provider allowance. Missing reports
            are unknown, not zero; reused and simulated results are not new consumption.
          </p>
        </details>
        <section aria-label="Filters" className="usage-filters-section">
          <div className="usage-filter-actions">
            {[7, 30].map((days) => {
              const selected = from === isoDay(days - 1) && to === isoDay(0);
              return (
                <button
                  key={days}
                  className={`btn btn-ghost${selected ? ' active-tab' : ''}`}
                  aria-pressed={selected}
                  onClick={() => applyPreset(days)}
                >
                  Last {days} days
                </button>
              );
            })}
            <button
              className="btn btn-ghost"
              onClick={resetFilters}
              disabled={!filtersCustomized}
              title="Restore the default 30-day range and clear filters"
            >
              Reset filters
            </button>
          </div>
          <div className="usage-filters">
            <div className="field">
              <label className="field-label" htmlFor="usage-from">
                From (inclusive)
              </label>
              <input
                id="usage-from"
                type="date"
                className="input"
                value={from}
                max={to !== '' ? to : undefined}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="usage-to">
                To (inclusive)
              </label>
              <input
                id="usage-to"
                type="date"
                className="input"
                value={to}
                min={from !== '' ? from : undefined}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="usage-workflow">
                Workflow
              </label>
              <select
                id="usage-workflow"
                className="input"
                value={workflowId}
                onChange={(e) => setWorkflowId(e.target.value)}
              >
                <option value="">All workflows</option>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="usage-provider">
                Provider
              </label>
              <select
                id="usage-provider"
                className="input"
                value={adapter}
                onChange={(e) => setAdapter(e.target.value)}
              >
                <option value="">All providers</option>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="custom">Custom</option>
                <option value="unknown">Unknown (legacy)</option>
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="usage-model">
                Model
              </label>
              <input
                id="usage-model"
                className="input"
                list="usage-model-options"
                value={model}
                placeholder="All models"
                onChange={(e) => setModel(e.target.value)}
              />
              <datalist id="usage-model-options">
                {modelOptions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
          </div>
          {filterError !== null && (
            <p className="form-error" role="alert">
              {filterError}
            </p>
          )}
        </section>
        {error !== null && (
          <Notice variant="error" eventId={errorEvent} onDismiss={() => setError(null)}>
            {error}
          </Notice>
        )}
        {loading ? (
          <p className="field-hint" role="status">
            Loading usage…
          </p>
        ) : summary.runsScanned === 0 ? (
          <Notice inline>
            No runs in this range. Runs appear here after explicit workflow executions —
            dry runs never contribute to consumption totals.
          </Notice>
        ) : (
          <>
            <section aria-label="Overview" className="usage-cards">
              <div className="usage-card">
                <div className="usage-card-value">{formatCount(totals.runs)}</div>
                <div className="usage-card-label">Workflow runs</div>
              </div>
              <div className="usage-card">
                <div className="usage-card-value">
                  {formatCount(totals.agentAttempts)}
                </div>
                <div className="usage-card-label">
                  Agent attempts
                  <span className="usage-card-sub">
                    {formatCount(totals.failedAttempts)} failed ·{' '}
                    {formatCount(totals.retriedAttempts)} retried
                  </span>
                </div>
              </div>
              <div className="usage-card">
                <div
                  className="usage-card-value"
                  title={
                    totals.reportedUsdAttempts > 0
                      ? formatUsdExact(totals.reportedUsd)
                      : undefined
                  }
                >
                  {totals.reportedUsdAttempts > 0
                    ? formatUsd(totals.reportedUsd)
                    : 'Unknown'}
                </div>
                <div className="usage-card-label">
                  Estimated API value
                  <span className="usage-card-sub">
                    CLI-reported · {formatCount(totals.reportedUsdAttempts)}/
                    {formatCount(totals.agentAttempts)} reports
                  </span>
                </div>
              </div>
              <div className="usage-card">
                <div className="usage-card-value">
                  <CoveredValue
                    value={totals.observedToolCalls}
                    reported={totals.coverage.toolCalls}
                    attempts={totals.agentAttempts}
                    format={formatCount}
                  />
                </div>
                <div className="usage-card-label">
                  Observed tool calls
                  <span className="usage-card-sub">
                    {formatCount(totals.coverage.toolCalls)}/
                    {formatCount(totals.agentAttempts)} attempts reported
                  </span>
                </div>
              </div>
              <div className="usage-card">
                <div className="usage-card-value">
                  <CoveredValue
                    value={totals.observedSubagents}
                    reported={totals.coverage.subagents}
                    attempts={totals.agentAttempts}
                    format={formatCount}
                  />
                </div>
                <div className="usage-card-label">
                  Observed subagents
                  <span className="usage-card-sub">
                    {formatCount(totals.coverage.subagents)}/
                    {formatCount(totals.agentAttempts)} attempts reported
                  </span>
                </div>
              </div>
              <div className="usage-card">
                <div className="usage-card-value">
                  {formatCount(totals.reusedResults)}
                </div>
                <div className="usage-card-label">
                  Reused results
                  <span className="usage-card-sub">
                    {formatCount(totals.simulatedResults)} simulated · neither charged as
                    new work
                  </span>
                </div>
              </div>
            </section>
            <details className="field-hint usage-about">
              <summary>How these totals are counted</summary>
              <p>
                Attempts missing a USD report stay unknown, never zero (
                {formatCount(totals.unknownUsdAttempts)} here).{' '}
                {formatCount(totals.unknownModelAttempts)} attempts predate provider
                identity and stay legacy unknown. Reused and simulated results are not new
                consumption. Workflow-run counts are execution counts, not completed PR or
                ticket counts.
              </p>
            </details>
            <section aria-label="Daily activity">
              <h2>Daily activity — agent attempts</h2>
              {chart.days.length === 0 ? (
                <p className="field-hint">No agent attempts in this range.</p>
              ) : (
                <>
                  <DailyChart days={chart.days} />
                  {chart.truncated && (
                    <p className="field-hint">
                      The filled calendar span is capped at {String(MAX_CHART_DAYS)} days;
                      later dates are omitted from the chart. The daily table includes
                      every day with runs in the selected range.
                    </p>
                  )}
                  <details className="usage-daily-table">
                    <summary>
                      Daily table ({formatCount(dailyRows.length)}{' '}
                      {dailyRows.length === 1 ? 'day' : 'days'}
                      {chart.truncated ? ' with runs' : ''}, UTC)
                    </summary>
                    <div className="table-wrap">
                      <table>
                        <caption className="sr-only">
                          Agent attempts, runs and reported USD subtotal per UTC day. USD
                          is a reported subtotal with missing reports excluded, not
                          complete coverage.
                        </caption>
                        <thead>
                          <tr>
                            <th scope="col">Day (UTC)</th>
                            <th scope="col" className="num">
                              Runs
                            </th>
                            <th scope="col" className="num">
                              Agent attempts
                            </th>
                            <th scope="col" className="num">
                              Reported USD subtotal
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {dailyRows.map((day) => (
                            <tr key={day.day}>
                              <td>{day.day}</td>
                              <td className="num">{formatCount(day.runs)}</td>
                              <td className="num">{formatCount(day.agentAttempts)}</td>
                              <td className="num" title={formatUsdExact(day.reportedUsd)}>
                                {day.agentAttempts === 0
                                  ? '—'
                                  : formatUsd(day.reportedUsd)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="field-hint">
                      Daily USD is the reported subtotal for that day (missing reports
                      excluded). The current daily figures cannot prove complete coverage
                      — see the report counts in the breakdown below.
                    </p>
                  </details>
                </>
              )}
            </section>
            <section aria-label="Breakdown">
              <h2>Breakdown</h2>
              <div className="usage-tabs" role="tablist" aria-label="Breakdown views">
                {BREAKDOWN_TABS.map(([tab, label], index) => (
                  <button
                    key={tab}
                    id={`usage-tab-${tab}`}
                    role="tab"
                    aria-selected={breakdown === tab}
                    aria-controls={`usage-panel-${tab}`}
                    tabIndex={breakdown === tab ? 0 : -1}
                    className={`btn btn-ghost${breakdown === tab ? ' active-tab' : ''}`}
                    onClick={() => setBreakdown(tab)}
                    onKeyDown={(event) => {
                      const nextIndex =
                        event.key === 'ArrowRight'
                          ? (index + 1) % BREAKDOWN_TABS.length
                          : event.key === 'ArrowLeft'
                            ? (index + BREAKDOWN_TABS.length - 1) % BREAKDOWN_TABS.length
                            : event.key === 'Home'
                              ? 0
                              : event.key === 'End'
                                ? BREAKDOWN_TABS.length - 1
                                : null;
                      if (nextIndex === null) return;
                      const next = BREAKDOWN_TABS[nextIndex];
                      if (next === undefined) return;
                      event.preventDefault();
                      setBreakdown(next[0]);
                      document.getElementById(`usage-tab-${next[0]}`)?.focus();
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {breakdown === 'workflow' && (
                <div
                  id="usage-panel-workflow"
                  role="tabpanel"
                  aria-label="By workflow"
                  tabIndex={0}
                >
                  {summary.byWorkflow.length === 0 ? (
                    <p className="field-hint">No workflow activity in this range.</p>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">Workflow</th>
                            <th scope="col" className="num">
                              Runs
                            </th>
                            <th scope="col" className="num">
                              Attempts
                            </th>
                            <th scope="col" className="num">
                              Est. API USD
                            </th>
                            <th scope="col" className="num">
                              Attempts missing USD
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {summary.byWorkflow.map((row) => (
                            <tr key={row.workflowId}>
                              <td title={row.workflowId}>{row.workflowName}</td>
                              <td className="num">{formatCount(row.runs)}</td>
                              <td className="num">{formatCount(row.agentAttempts)}</td>
                              <td className="num" title={formatUsdExact(row.reportedUsd)}>
                                {row.agentAttempts > row.unknownUsdAttempts
                                  ? formatUsd(row.reportedUsd)
                                  : 'Unknown'}
                              </td>
                              <td className="num">
                                {formatCount(row.unknownUsdAttempts)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className="field-hint">
                    Names are recorded when each run starts; renaming a workflow later
                    does not rewrite history.
                  </p>
                </div>
              )}
              {breakdown === 'profile' && (
                <div
                  id="usage-panel-profile"
                  role="tabpanel"
                  aria-label="By AI profile"
                  tabIndex={0}
                >
                  {summary.byProfile.length === 0 ? (
                    <p className="field-hint">No AI profile activity in this range.</p>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">AI profile</th>
                            <th scope="col" className="num">
                              Runs
                            </th>
                            <th scope="col" className="num">
                              Attempts
                            </th>
                            <th scope="col">Execution time</th>
                            <th scope="col">Last run</th>
                            <th scope="col" className="num">
                              Est. API USD
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {summary.byProfile.map((row) => {
                            const current = profiles.find(
                              (profile) => profile.id === row.profileId,
                            );
                            const label = current?.name ?? row.profileId ?? 'Unknown';
                            return (
                              <tr key={JSON.stringify(row.profileId)}>
                                <td>
                                  <div
                                    className="cell-ellipsis"
                                    title={
                                      row.profileId === null
                                        ? label
                                        : `${label} · ${row.profileId}`
                                    }
                                  >
                                    {label}
                                  </div>
                                  {current && (
                                    <span className="field-hint">current name</span>
                                  )}
                                </td>
                                <td className="num">{formatCount(row.runs)}</td>
                                <td className="num">{formatCount(row.agentAttempts)}</td>
                                <td>{formatDurationMs(row.totalDurationMs)}</td>
                                <td title={row.lastRunAt}>
                                  {row.lastRunAt ? formatTime(row.lastRunAt) : 'Unknown'}
                                </td>
                                <td
                                  className="num"
                                  title={
                                    row.reportedUsdAttempts > 0
                                      ? formatUsdExact(row.reportedUsd)
                                      : undefined
                                  }
                                >
                                  {row.reportedUsdAttempts > 0
                                    ? formatUsd(row.reportedUsd)
                                    : 'Unknown'}{' '}
                                  <span className="coverage-flag">
                                    ({formatCount(row.reportedUsdAttempts)}/
                                    {formatCount(row.agentAttempts)} reports;{' '}
                                    {formatCount(row.unknownUsdAttempts)} unknown)
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className="field-hint">
                    Profile IDs come from each saved run snapshot; missing attribution
                    stays Unknown. Deleted profiles retain their recorded IDs. Attempts
                    and execution time include retries and loop visits; execution time
                    sums recorded attempt durations, including concurrent work.
                  </p>
                </div>
              )}
              {breakdown === 'model' && (
                <div
                  id="usage-panel-model"
                  role="tabpanel"
                  aria-label="By provider and model"
                  tabIndex={0}
                >
                  {summary.byModel.length === 0 ? (
                    <p className="field-hint">
                      No identified model activity in this range.
                    </p>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">Provider</th>
                            <th scope="col">Model</th>
                            <th scope="col" className="num">
                              Attempts
                            </th>
                            <th scope="col" className="num">
                              Tokens in
                            </th>
                            <th scope="col" className="num">
                              Tokens out
                            </th>
                            <th scope="col" className="num">
                              Est. API USD
                            </th>
                            <th scope="col">Details</th>
                          </tr>
                        </thead>
                        <tbody>
                          {summary.byModel.map((row) => (
                            <tr key={`${row.adapter}::${row.model}`}>
                              <td>{row.adapter}</td>
                              <td>{row.model}</td>
                              <td className="num">{formatCount(row.agentAttempts)}</td>
                              <td className="num">
                                <CoveredValue
                                  value={row.inputTokens}
                                  reported={row.coverage.inputTokens}
                                  attempts={row.agentAttempts}
                                  format={formatCount}
                                />
                              </td>
                              <td className="num">
                                <CoveredValue
                                  value={row.outputTokens}
                                  reported={row.coverage.outputTokens}
                                  attempts={row.agentAttempts}
                                  format={formatCount}
                                />
                              </td>
                              <td
                                className="num"
                                title={
                                  row.reportedUsdAttempts > 0
                                    ? formatUsdExact(row.reportedUsd)
                                    : undefined
                                }
                              >
                                {row.reportedUsdAttempts > 0
                                  ? formatUsd(row.reportedUsd)
                                  : 'Unknown'}{' '}
                                <span className="coverage-flag">
                                  ({formatCount(row.reportedUsdAttempts)}/
                                  {formatCount(row.agentAttempts)} reports)
                                </span>
                              </td>
                              <td>
                                <details>
                                  <summary>Counters</summary>
                                  <dl className="usage-counters">
                                    <div>
                                      <dt>Observed tools</dt>
                                      <dd>
                                        <CoveredValue
                                          value={row.observedToolCalls}
                                          reported={row.coverage.toolCalls}
                                          attempts={row.agentAttempts}
                                          format={formatCount}
                                        />
                                      </dd>
                                    </div>
                                    <div>
                                      <dt>Observed subagents</dt>
                                      <dd>
                                        <CoveredValue
                                          value={row.observedSubagents}
                                          reported={row.coverage.subagents}
                                          attempts={row.agentAttempts}
                                          format={formatCount}
                                        />
                                      </dd>
                                    </div>
                                    {row.coverage.cachedInputTokens > 0 && (
                                      <div>
                                        <dt>Codex cached input</dt>
                                        <dd>
                                          <CoveredValue
                                            value={row.cachedInputTokens}
                                            reported={row.coverage.cachedInputTokens}
                                            attempts={row.agentAttempts}
                                            format={formatCount}
                                          />
                                        </dd>
                                      </div>
                                    )}
                                    {row.coverage.cacheReadInputTokens > 0 && (
                                      <div>
                                        <dt>Claude cache read</dt>
                                        <dd>
                                          <CoveredValue
                                            value={row.cacheReadInputTokens}
                                            reported={row.coverage.cacheReadInputTokens}
                                            attempts={row.agentAttempts}
                                            format={formatCount}
                                          />
                                        </dd>
                                      </div>
                                    )}
                                    {row.coverage.cacheCreationInputTokens > 0 && (
                                      <div>
                                        <dt>Claude cache write</dt>
                                        <dd>
                                          <CoveredValue
                                            value={row.cacheCreationInputTokens}
                                            reported={
                                              row.coverage.cacheCreationInputTokens
                                            }
                                            attempts={row.agentAttempts}
                                            format={formatCount}
                                          />
                                        </dd>
                                      </div>
                                    )}
                                    {row.coverage.reasoningOutputTokens > 0 && (
                                      <div>
                                        <dt>Reasoning output</dt>
                                        <dd>
                                          <CoveredValue
                                            value={row.reasoningOutputTokens}
                                            reported={row.coverage.reasoningOutputTokens}
                                            attempts={row.agentAttempts}
                                            format={formatCount}
                                          />
                                        </dd>
                                      </div>
                                    )}
                                  </dl>
                                  <p className="field-hint">
                                    Only reported metrics appear above. Identity is
                                    recorded at execution time; legacy rows without it
                                    stay “unknown”. Input totals include available Claude
                                    cache read/write components; Codex cached input is
                                    already included in its input count. Reasoning is a
                                    separate reported subset of output.
                                  </p>
                                </details>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </section>
          </>
        )}
        <section aria-label="Subscription and allocation settings">
          <h2>Subscription & allocation settings</h2>
          <p className="field-hint">
            Illustrative settings for your own bookkeeping — not defaults, not verified
            provider prices, and never mixed into API-equivalent estimates. A partial date
            range never prorates a full monthly fee. Billing periods use UTC
            start-inclusive/end-exclusive dates; unspecified or unrecognized periods
            remain visible outside allocation.
          </p>
          {settingsError !== null && (
            <Notice
              variant="error"
              eventId={settingsErrorEvent}
              onDismiss={() => setSettingsError(null)}
            >
              {settingsError}
            </Notice>
          )}
          {settingsLoading && (
            <p className="field-hint" role="status">
              Loading subscription settings…
            </p>
          )}
          {!settingsLoaded && !settingsLoading && (
            <button
              className="btn"
              onClick={() => {
                setSettingsLoading(true);
                setSettingsError(null);
                setSettingsLoadAttempt((attempt) => attempt + 1);
              }}
            >
              Retry loading subscription settings
            </button>
          )}
          <fieldset
            className="usage-settings-fields"
            disabled={!settingsLoaded || saving}
            aria-label="Subscription settings"
            onChange={() => setSettingsSaved(false)}
          >
            {fees.length === 0 && extras.length === 0 ? (
              <p className="field-hint">No fees entered yet.</p>
            ) : (
              <div className="table-wrap">
                <table aria-label="Entered subscription fees and extra charges">
                  <thead>
                    <tr>
                      <th scope="col">Label</th>
                      <th scope="col" className="num">
                        Amount (USD)
                      </th>
                      <th scope="col">Billing period</th>
                      <th scope="col">Allocation</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {fees.map((fee, index) => (
                      <tr key={`fee-${String(index)}-${fee.label}`}>
                        <td>{fee.label}</td>
                        <td className="num" title={formatUsdExact(fee.amountUsd)}>
                          {formatUsd(fee.amountUsd)}
                        </td>
                        <td>{fee.period || 'period unspecified'}</td>
                        <td>
                          {!inAllocationRange(fee.period) && (
                            <span className="coverage-flag">outside allocation</span>
                          )}
                        </td>
                        <td>
                          <button
                            className="btn btn-ghost danger-hover"
                            aria-label={`Remove fee ${fee.label}`}
                            onClick={() => removeFee(index)}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                    {extras.map((extra, index) => (
                      <tr key={`extra-${String(index)}-${extra.label}`}>
                        <td>
                          {extra.label} <span className="coverage-flag">extra</span>
                        </td>
                        <td className="num" title={formatUsdExact(extra.amountUsd)}>
                          {formatUsd(extra.amountUsd)}
                        </td>
                        <td>{extra.period || 'period unspecified'}</td>
                        <td>
                          {!inAllocationRange(extra.period ?? '') && (
                            <span className="coverage-flag">outside allocation</span>
                          )}
                        </td>
                        <td>
                          <button
                            className="btn btn-ghost danger-hover"
                            aria-label={`Remove extra charge ${extra.label}`}
                            onClick={() => removeExtra(index)}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="usage-form-grid">
              <div className="field">
                <label className="field-label" htmlFor="usage-fee-label">
                  Fee label
                </label>
                <input
                  id="usage-fee-label"
                  className="input"
                  placeholder="e.g. Claude"
                  value={newFeeLabel}
                  onChange={(e) => setNewFeeLabel(e.target.value)}
                />
              </div>
              <div className="field field-narrow">
                <label className="field-label" htmlFor="usage-fee-amount">
                  Fee amount (USD)
                </label>
                <input
                  id="usage-fee-amount"
                  className="input"
                  type="number"
                  min={0}
                  step="any"
                  value={newFeeAmount}
                  onChange={(e) => setNewFeeAmount(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="usage-fee-period">
                  Billing period (UTC range)
                </label>
                <input
                  id="usage-fee-period"
                  className="input"
                  placeholder="2026-10-01/2026-11-01"
                  value={newFeePeriod}
                  onChange={(e) => setNewFeePeriod(e.target.value)}
                />
              </div>
              <div className="field field-action">
                <span className="field-label" aria-hidden="true">
                  &nbsp;
                </span>
                <button
                  className="btn"
                  disabled={newFeeLabel.trim() === '' || newFeeAmount.trim() === ''}
                  onClick={() => {
                    const amount = Number(newFeeAmount);
                    if (!Number.isFinite(amount) || amount < 0) {
                      setSettingsError('Fee amount must be a finite USD amount >= 0.');
                      return;
                    }
                    if (billingPeriod(newFeePeriod.trim()) === null) {
                      setSettingsError(
                        'Billing period must be a valid UTC start/end range (YYYY-MM-DD/YYYY-MM-DD), with end exclusive.',
                      );
                      return;
                    }
                    setSettingsSaved(false);
                    setFees([
                      ...fees,
                      {
                        label: newFeeLabel.trim(),
                        amountUsd: amount,
                        period: newFeePeriod.trim(),
                      },
                    ]);
                    setNewFeeLabel('');
                    setNewFeeAmount('');
                    setNewFeePeriod('');
                  }}
                >
                  Add fee
                </button>
              </div>
            </div>
            <div className="usage-form-grid">
              <div className="field">
                <label className="field-label" htmlFor="usage-extra-label">
                  Extra charge label
                </label>
                <input
                  id="usage-extra-label"
                  className="input"
                  placeholder="e.g. Overage"
                  value={newExtraLabel}
                  onChange={(e) => setNewExtraLabel(e.target.value)}
                />
              </div>
              <div className="field field-narrow">
                <label className="field-label" htmlFor="usage-extra-amount">
                  Extra amount (USD)
                </label>
                <input
                  id="usage-extra-amount"
                  className="input"
                  type="number"
                  min={0}
                  step="any"
                  value={newExtraAmount}
                  onChange={(e) => setNewExtraAmount(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="usage-extra-period">
                  Extra billing period (optional)
                </label>
                <input
                  id="usage-extra-period"
                  className="input"
                  placeholder="YYYY-MM-DD/YYYY-MM-DD"
                  value={newExtraPeriod}
                  onChange={(e) => setNewExtraPeriod(e.target.value)}
                />
              </div>
              <div className="field field-action">
                <span className="field-label" aria-hidden="true">
                  &nbsp;
                </span>
                <button
                  className="btn"
                  disabled={newExtraLabel.trim() === '' || newExtraAmount.trim() === ''}
                  onClick={() => {
                    const amount = Number(newExtraAmount);
                    if (!Number.isFinite(amount) || amount < 0) {
                      setSettingsError('Extra amount must be a finite USD amount >= 0.');
                      return;
                    }
                    if (
                      newExtraPeriod.trim() !== '' &&
                      billingPeriod(newExtraPeriod.trim()) === null
                    ) {
                      setSettingsError(
                        'Extra billing period must be a valid UTC start/end range (YYYY-MM-DD/YYYY-MM-DD), with end exclusive.',
                      );
                      return;
                    }
                    setSettingsSaved(false);
                    setExtras([
                      ...extras,
                      {
                        label: newExtraLabel.trim(),
                        amountUsd: amount,
                        ...(newExtraPeriod.trim() !== ''
                          ? { period: newExtraPeriod.trim() }
                          : {}),
                      },
                    ]);
                    setNewExtraLabel('');
                    setNewExtraAmount('');
                    setNewExtraPeriod('');
                  }}
                >
                  Add extra
                </button>
              </div>
            </div>
            <p className="field-hint">Entered total: {formatUsd(feeTotal)}.</p>
            <h3>Subscription-cost allocation (optional)</h3>
            <p className="field-hint">
              An allocation, not a measurement: declare Orchevia&apos;s share of the full
              entered billing-period pool. This manual pool is independent of the current
              history filters for workflow, provider and model; dates select full
              overlapping billing periods, without prorating. It does not assign a price
              to filtered attempts or runs.
            </p>
            <div className="usage-form-grid usage-allocation-grid">
              <div className="field field-narrow">
                <label className="field-label" htmlFor="usage-share">
                  Orchevia share %
                </label>
                <input
                  id="usage-share"
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  step="any"
                  value={share}
                  placeholder="e.g. 60"
                  onChange={(e) => setShare(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="usage-method">
                  Method
                </label>
                <select
                  id="usage-method"
                  className="input"
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                >
                  <option value="manual">
                    Declared share of full entered billing periods
                  </option>
                </select>
              </div>
              <div className="field field-action">
                <span className="field-label" aria-hidden="true">
                  &nbsp;
                </span>
                <button
                  className="btn btn-primary"
                  onClick={saveSettings}
                  disabled={!settingsDirty || saving}
                >
                  {saving ? 'Saving…' : 'Save subscription settings'}
                </button>
              </div>
            </div>
            {settingsDirty && (
              <p className="field-hint" role="status">
                Unsaved changes — Add/Remove edits are draft until saved.
              </p>
            )}
            {settingsSaved && !settingsDirty && (
              <p className="field-hint" role="status">
                Subscription settings saved.
              </p>
            )}
            {allocated !== null && (
              <p className="field-hint">
                Allocated to Orchevia-tracked work: {formatUsd(allocated)} ({method},
                share {share.trim()}% of {formatUsd(allocationPool)} across full entered
                periods; no prorating). Outside or untracked usage is excluded from this
                figure.
              </p>
            )}
          </fieldset>
        </section>
        <section aria-label="API-equivalent target">
          <h2>API-equivalent target (optional)</h2>
          <details className="field-hint usage-about">
            <summary>When is this available?</summary>
            <p>
              A spend-control aid, not a subscription cap. Comparable measured history in
              one workflow/provider/model cohort offers an estimate range with its sample
              count and coverage. Type a target to see approximate attempt scenarios.
              Joint tool/subagent and USD coverage is unavailable, so no tool or subagent
              conversion is inferred.
            </p>
          </details>
          <div className="usage-form-grid">
            <div className="field field-narrow">
              <label className="field-label" htmlFor="usage-target">
                Target USD
              </label>
              <input
                id="usage-target"
                className="input"
                type="number"
                min={0.000001}
                step="any"
                value={target}
                placeholder="e.g. 5"
                onChange={(e) => setTarget(e.target.value)}
              />
            </div>
          </div>
          {estimate === undefined ? (
            <p className="field-hint" role="status">
              Insufficient history: select one workflow/provider/model cohort with at
              least 3 comparable attempts reporting USD. Mixed or unknown identities
              cannot establish comparability.
            </p>
          ) : (
            <p className="field-hint">
              Comparable attempts: {formatCount(estimate.samples)} with USD reports
              (attempt cost roughly {formatUsd(estimate.low)}–{formatUsd(estimate.high)}{' '}
              each, interquartile range).
              {target.trim() !== '' &&
              Number.isFinite(targetNum) &&
              targetNum > 0 &&
              estimate.low > 0 &&
              estimate.high > 0 &&
              Number.isFinite(targetNum / estimate.low) &&
              Number.isFinite(targetNum / estimate.high) ? (
                <>
                  {' '}
                  A {formatUsd(targetNum)} target resembles roughly{' '}
                  {formatCount(Math.floor(targetNum / estimate.high))}–
                  {formatCount(Math.ceil(targetNum / estimate.low))} such attempts —
                  approximate, partial coverage, not an enforceable exchange rate.
                </>
              ) : null}
            </p>
          )}
        </section>
        <p className="field-hint">
          Generated {formatTime(new Date().toISOString())} ·{' '}
          {formatCount(summary.runsScanned)} runs scanned
          {summary.from ? ` from ${summary.from}` : ''}
          {summary.to ? ` to ${summary.to}` : ''}.
        </p>
      </div>
    </>
  );
}
