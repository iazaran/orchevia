import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Notice, useNoticeMessage } from './Notice';
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
  type UsageSummary,
} from '../lib/usage';
import { useAppStore } from '../store';

const FEES_KEY = 'usage.subscriptionFees';
const EXTRAS_KEY = 'usage.extraCharges';
const SHARE_KEY = 'usage.allocationShare';
const METHOD_KEY = 'usage.allocationMethod';

function isoDay(offsetDays: number): string {
  const date = new Date(Date.now() - offsetDays * 86_400_000);
  return date.toISOString().slice(0, 10);
}

function money(value: number): string {
  return `USD ${value.toFixed(2)}`;
}

function metric(value: number, reported: number, attempts: number): string {
  if (attempts === 0) return '—';
  if (reported === 0 && value === 0)
    return `Unknown (${String(attempts)} missing reports)`;
  return `${String(value)} (${String(reported)}/${String(attempts)} reports${reported < attempts ? '; partial' : ''})`;
}

export function UsageView(): React.JSX.Element {
  const workflows = useAppStore((s) => s.workflows);
  const profiles = useAppStore((s) => s.profiles);
  const setView = useAppStore((s) => s.setView);
  const [from, setFrom] = useState(() => isoDay(29));
  const [to, setTo] = useState(() => isoDay(0));
  const [workflowId, setWorkflowId] = useState('');
  const [adapter, setAdapter] = useState('');
  const [model, setModel] = useState('');
  const [summary, setSummary] = useState<UsageSummary>(emptyUsageSummary());
  const [loading, setLoading] = useState(true);
  const [error, setError, , errorEvent] = useNoticeMessage('error');
  const [fees, setFees] = useState<SubscriptionFee[]>([]);
  const [extras, setExtras] = useState<ExtraCharge[]>([]);
  const [share, setShare] = useState('');
  const [method, setMethod] = useState('manual');
  const [settingsError, setSettingsError, , settingsErrorEvent] =
    useNoticeMessage('error');
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [target, setTarget] = useState('');
  const [newFeeLabel, setNewFeeLabel] = useState('');
  const [newFeeAmount, setNewFeeAmount] = useState('');
  const [newFeePeriod, setNewFeePeriod] = useState('');
  const [newExtraLabel, setNewExtraLabel] = useState('');
  const [newExtraAmount, setNewExtraAmount] = useState('');
  const [newExtraPeriod, setNewExtraPeriod] = useState('');
  const refreshGeneration = useRef(0);

  const refresh = useCallback(() => {
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
  }, [from, to, workflowId, adapter, model, setError]);

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
        setFees(
          parseMoneyList<SubscriptionFee>(feesRaw, (entry) =>
            typeof entry.label === 'string' && typeof entry.period === 'string'
              ? {
                  label: entry.label,
                  amountUsd: typeof entry.amountUsd === 'number' ? entry.amountUsd : NaN,
                  period: entry.period,
                }
              : null,
          ),
        );
        setExtras(
          parseMoneyList<ExtraCharge>(extrasRaw, (entry) =>
            typeof entry.label === 'string'
              ? {
                  label: entry.label,
                  amountUsd: typeof entry.amountUsd === 'number' ? entry.amountUsd : NaN,
                  ...(typeof entry.period === 'string' ? { period: entry.period } : {}),
                }
              : null,
          ),
        );
        if (shareRaw !== null) setShare(shareRaw);
        if (methodRaw === 'manual') setMethod(methodRaw);
      })
      .catch((err: unknown) => {
        if (!cancelled) setSettingsError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [setSettingsError]);

  const saveSettings = (): void => {
    setSettingsError(null);
    setSettingsSaved(false);
    void (async () => {
      try {
        const backend = getBackend();
        await backend.setSetting(FEES_KEY, JSON.stringify(fees));
        await backend.setSetting(EXTRAS_KEY, JSON.stringify(extras));
        await backend.setSetting(SHARE_KEY, share.trim());
        await backend.setSetting(METHOD_KEY, method);
        setSettingsSaved(true);
      } catch (err: unknown) {
        setSettingsError(errorMessage(err));
      }
    })();
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
  const maxDay = Math.max(1, ...summary.days.map((d) => d.agentAttempts));
  const modelOptions = useMemo(
    () => [...new Set(summary.byModel.map((row) => row.model))].sort(),
    [summary.byModel],
  );

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
          Three lanes stay separate: (1) subscription fees you enter, (2) CLI-reported
          API-equivalent estimates with their source and coverage, (3) an optional labeled
          allocation between them. Orchevia cannot see subscription balances, remaining
          quota, or five-hour windows — check your provider dashboard for those. Dates
          group by UTC day; your display timezone is {summary.timezone || 'UTC'}.
        </p>
        <section aria-label="Filters" className="usage-filters">
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
            <section aria-label="Totals" className="usage-cards">
              <div className="usage-card">
                <div className="usage-card-value">{String(totals.runs)}</div>
                <div className="usage-card-label">Workflow runs</div>
              </div>
              <div className="usage-card">
                <div className="usage-card-value">{String(totals.agentAttempts)}</div>
                <div className="usage-card-label">
                  Agent attempts ({String(totals.failedAttempts)} failed,{' '}
                  {String(totals.retriedAttempts)} retried)
                </div>
              </div>
              <div className="usage-card">
                <div className="usage-card-value">
                  {totals.reportedUsdAttempts > 0 ? money(totals.reportedUsd) : 'Unknown'}
                </div>
                <div className="usage-card-label">
                  Estimated API value ({String(totals.reportedUsdAttempts)} reported,{' '}
                  {String(totals.unknownUsdAttempts)} unknown)
                </div>
              </div>
              <div className="usage-card">
                <div className="usage-card-value">
                  {metric(
                    totals.observedToolCalls,
                    totals.coverage.toolCalls,
                    totals.agentAttempts,
                  )}
                </div>
                <div className="usage-card-label">
                  Observed tool calls · subagents:{' '}
                  {metric(
                    totals.observedSubagents,
                    totals.coverage.subagents,
                    totals.agentAttempts,
                  )}
                  ; {String(totals.unknownModelAttempts)} legacy unknown model
                </div>
              </div>
              <div className="usage-card">
                <div className="usage-card-value">{String(totals.reusedResults)}</div>
                <div className="usage-card-label">
                  Reused results ({String(totals.simulatedResults)} simulated — neither
                  charged as new work)
                </div>
              </div>
            </section>
            <section aria-label="Daily activity">
              <h2>Daily activity</h2>
              {summary.days.length === 0 ? (
                <p className="field-hint">No agent attempts in this range.</p>
              ) : (
                <>
                  <svg
                    className="usage-chart"
                    viewBox={`0 0 ${String(summary.days.length * 44 + 8)} 120`}
                    role="img"
                    aria-label={`Agent attempts per day from ${summary.days[0]?.day ?? ''} to ${summary.days.at(-1)?.day ?? ''}`}
                    style={{ width: '100%', maxWidth: 720, height: 'auto' }}
                  >
                    {summary.days.map((day, index) => {
                      const height = Math.max(
                        2,
                        Math.round((day.agentAttempts / maxDay) * 96),
                      );
                      return (
                        <g key={day.day}>
                          <title>
                            {day.day}: {String(day.agentAttempts)} attempts,{' '}
                            {String(day.runs)} runs, USD {day.reportedUsd.toFixed(4)}
                          </title>
                          <rect
                            x={4 + index * 44}
                            y={110 - height}
                            width={32}
                            height={height}
                            className="usage-bar"
                          />
                        </g>
                      );
                    })}
                  </svg>
                  <details className="field-hint">
                    <summary>Daily numbers</summary>
                    <ul>
                      {summary.days.map((day) => (
                        <li key={day.day}>
                          {day.day}: {String(day.runs)} runs, {String(day.agentAttempts)}{' '}
                          attempts, USD {day.reportedUsd.toFixed(4)},{' '}
                          {String(day.inputTokens + day.outputTokens)} reported token
                          subtotal (missing reports excluded)
                        </li>
                      ))}
                    </ul>
                  </details>
                </>
              )}
            </section>
            <section aria-label="By workflow">
              <h2>By workflow</h2>
              {summary.byWorkflow.length === 0 ? (
                <p className="field-hint">No workflow activity in this range.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Workflow</th>
                        <th scope="col">Runs</th>
                        <th scope="col">Attempts</th>
                        <th scope="col">Est. API USD</th>
                        <th scope="col">Unknown USD</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.byWorkflow.map((row) => (
                        <tr key={row.workflowId}>
                          <td title={row.workflowId}>{row.workflowName}</td>
                          <td>{String(row.runs)}</td>
                          <td>{String(row.agentAttempts)}</td>
                          <td>
                            {row.agentAttempts > row.unknownUsdAttempts
                              ? row.reportedUsd.toFixed(4)
                              : 'Unknown'}
                          </td>
                          <td>{String(row.unknownUsdAttempts)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="field-hint">
                Names are recorded when each run starts; renaming a workflow later does
                not rewrite history. Workflow-run counts are execution counts, not
                completed PR or ticket counts.
              </p>
            </section>
            <section aria-label="By AI profile">
              <h2>By AI profile</h2>
              {summary.byProfile.length === 0 ? (
                <p className="field-hint">No AI profile activity in this range.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">AI profile</th>
                        <th scope="col">Runs</th>
                        <th scope="col">Attempts</th>
                        <th scope="col">Execution time</th>
                        <th scope="col">Last run</th>
                        <th scope="col">Est. API USD</th>
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
                                title={
                                  row.profileId === null
                                    ? label
                                    : `${label} · ${row.profileId}`
                                }
                                style={{
                                  maxWidth: 240,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {label}
                              </div>
                              {current && (
                                <span className="field-hint">current name</span>
                              )}
                            </td>
                            <td>{String(row.runs)}</td>
                            <td>{String(row.agentAttempts)}</td>
                            <td>{formatDurationMs(row.totalDurationMs)}</td>
                            <td title={row.lastRunAt}>
                              {row.lastRunAt ? formatTime(row.lastRunAt) : 'Unknown'}
                            </td>
                            <td>
                              {row.reportedUsdAttempts > 0
                                ? row.reportedUsd.toFixed(4)
                                : 'Unknown'}{' '}
                              ({String(row.reportedUsdAttempts)}/
                              {String(row.agentAttempts)} reports;{' '}
                              {String(row.unknownUsdAttempts)} unknown)
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="field-hint">
                Profile IDs come from each saved run snapshot; missing attribution stays
                Unknown. Names are current profile labels. Deleted profiles retain their
                recorded IDs. Runs count once per profile; attempts and execution time
                include retries and loop visits. Execution time sums recorded attempt
                durations, including concurrent work. CLI USD is an API-equivalent
                estimate with missing reports shown separately.
              </p>
            </section>
            <section aria-label="By provider and model">
              <h2>By provider and model</h2>
              {summary.byModel.length === 0 ? (
                <p className="field-hint">No identified model activity in this range.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Provider</th>
                        <th scope="col">Model</th>
                        <th scope="col">Attempts</th>
                        <th scope="col">Tokens in/out</th>
                        <th scope="col">Cache / reasoning</th>
                        <th scope="col">Est. API USD</th>
                        <th scope="col">Observed tools/subagents</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.byModel.map((row) => (
                        <tr key={`${row.adapter}::${row.model}`}>
                          <td>{row.adapter}</td>
                          <td>{row.model}</td>
                          <td>{String(row.agentAttempts)}</td>
                          <td>
                            In:{' '}
                            {metric(
                              row.inputTokens,
                              row.coverage.inputTokens,
                              row.agentAttempts,
                            )}
                            <br />
                            Out:{' '}
                            {metric(
                              row.outputTokens,
                              row.coverage.outputTokens,
                              row.agentAttempts,
                            )}
                          </td>
                          <td>
                            Codex cached:{' '}
                            {metric(
                              row.cachedInputTokens,
                              row.coverage.cachedInputTokens,
                              row.agentAttempts,
                            )}
                            <br />
                            Claude cache read:{' '}
                            {metric(
                              row.cacheReadInputTokens,
                              row.coverage.cacheReadInputTokens,
                              row.agentAttempts,
                            )}
                            <br />
                            Claude cache write:{' '}
                            {metric(
                              row.cacheCreationInputTokens,
                              row.coverage.cacheCreationInputTokens,
                              row.agentAttempts,
                            )}
                            <br />
                            Reasoning:{' '}
                            {metric(
                              row.reasoningOutputTokens,
                              row.coverage.reasoningOutputTokens,
                              row.agentAttempts,
                            )}
                          </td>
                          <td>
                            {row.reportedUsdAttempts > 0
                              ? row.reportedUsd.toFixed(4)
                              : 'Unknown'}{' '}
                            ({String(row.reportedUsdAttempts)}/{String(row.agentAttempts)}{' '}
                            reports)
                          </td>
                          <td>
                            Tools:{' '}
                            {metric(
                              row.observedToolCalls,
                              row.coverage.toolCalls,
                              row.agentAttempts,
                            )}
                            <br />
                            Subagents:{' '}
                            {metric(
                              row.observedSubagents,
                              row.coverage.subagents,
                              row.agentAttempts,
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="field-hint">
                Identity is recorded at execution time. Legacy rows without it stay
                “unknown” — never zero. Codex runs report tokens but no USD; custom and
                plain-text runs report neither. Input totals include available Claude
                cache read/write components; Codex cached input is already included in its
                input count. Reasoning is a separate reported subset of output. Missing
                counters stay unknown.
              </p>
            </section>
          </>
        )}
        <section aria-label="Subscription fees">
          <h2>Subscription fees (you enter these)</h2>
          <p className="field-hint">
            Illustrative settings for your own bookkeeping — not defaults, not verified
            provider prices, and never mixed into API-equivalent estimates. A partial date
            range never prorates a full monthly fee.
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
          {fees.length === 0 && extras.length === 0 ? (
            <p className="field-hint">No fees entered yet.</p>
          ) : (
            <ul className="usage-money-list">
              {fees.map((fee, index) => (
                <li key={`fee-${String(index)}-${fee.label}`}>
                  {fee.label} · {money(fee.amountUsd)} ·{' '}
                  {fee.period || 'period unspecified'}
                  {!inAllocationRange(fee.period)
                    ? ' · outside allocation (period unrecognized or outside date range)'
                    : ''}{' '}
                  <button
                    className="btn btn-ghost danger-hover"
                    aria-label={`Remove fee ${fee.label}`}
                    onClick={() => setFees(fees.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </li>
              ))}
              {extras.map((extra, index) => (
                <li key={`extra-${String(index)}-${extra.label}`}>
                  {extra.label} (extra) · {money(extra.amountUsd)} ·{' '}
                  {extra.period || 'period unspecified'}
                  {!inAllocationRange(extra.period ?? '')
                    ? ' · outside allocation (period unrecognized or outside date range)'
                    : ''}{' '}
                  <button
                    className="btn btn-ghost danger-hover"
                    aria-label={`Remove extra charge ${extra.label}`}
                    onClick={() => setExtras(extras.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="usage-add-row">
            <input
              className="input"
              aria-label="Fee label"
              placeholder="Label, e.g. Claude"
              value={newFeeLabel}
              onChange={(e) => setNewFeeLabel(e.target.value)}
            />
            <input
              className="input"
              aria-label="Fee amount USD"
              placeholder="Amount USD"
              type="number"
              min={0}
              step="any"
              value={newFeeAmount}
              onChange={(e) => setNewFeeAmount(e.target.value)}
            />
            <input
              className="input"
              aria-label="Billing period"
              placeholder="Period, e.g. 2026-10-01/2026-11-01"
              value={newFeePeriod}
              onChange={(e) => setNewFeePeriod(e.target.value)}
            />
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
          <div className="usage-add-row">
            <input
              className="input"
              aria-label="Extra charge label"
              placeholder="Extra charge label"
              value={newExtraLabel}
              onChange={(e) => setNewExtraLabel(e.target.value)}
            />
            <input
              className="input"
              aria-label="Extra charge amount USD"
              placeholder="Amount USD"
              type="number"
              min={0}
              step="any"
              value={newExtraAmount}
              onChange={(e) => setNewExtraAmount(e.target.value)}
            />
            <input
              className="input"
              aria-label="Extra billing period"
              placeholder="Optional YYYY-MM-DD/YYYY-MM-DD"
              value={newExtraPeriod}
              onChange={(e) => setNewExtraPeriod(e.target.value)}
            />
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
          <p className="field-hint">Entered total: {money(feeTotal)}.</p>
          <p className="field-hint">
            Billing periods use UTC start-inclusive/end-exclusive dates. Unspecified or
            unrecognized periods remain visible outside allocation.
          </p>
        </section>
        <section aria-label="Subscription allocation">
          <h2>Subscription-cost allocation (optional)</h2>
          <p className="field-hint">
            An allocation, not a measurement: declare Orchevia's share of the full entered
            billing-period pool. This manual pool is independent of the current history
            filters for workflow, provider and model; dates select full overlapping
            billing periods, without prorating. It does not assign a price to filtered
            attempts or runs. Outside and untracked usage is represented only by the share
            you declare.
          </p>
          <div className="usage-add-row">
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
            <button className="btn btn-primary" onClick={saveSettings}>
              Save subscription settings
            </button>
          </div>
          {settingsSaved && (
            <p className="field-hint" role="status">
              Subscription settings saved.
            </p>
          )}
          {allocated !== null && (
            <p className="field-hint">
              Allocated to Orchevia-tracked work: {money(allocated)} ({method}, share{' '}
              {share.trim()}% of {money(allocationPool)} across full entered periods; no
              prorating). Outside or untracked usage is excluded from this figure.
            </p>
          )}
        </section>
        <section aria-label="API-equivalent target">
          <h2>API-equivalent target (optional)</h2>
          <p className="field-hint">
            A spend-control aid, not a subscription cap. Comparable measured history in
            one workflow/provider/model cohort offers an estimate range with its sample
            count and coverage. Type a target to see approximate attempt scenarios. Joint
            tool/subagent and USD coverage is unavailable, so no tool or subagent
            conversion is inferred.
          </p>
          <div className="usage-add-row">
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
          {estimate === undefined ? (
            <p className="field-hint" role="status">
              Insufficient history: select one workflow/provider/model cohort with at
              least 3 comparable attempts reporting USD. Mixed or unknown identities
              cannot establish comparability.
            </p>
          ) : (
            <p className="field-hint">
              Comparable attempts: {String(estimate.samples)} with USD reports (attempt
              cost roughly {money(estimate.low)}–{money(estimate.high)} each,
              interquartile range).
              {target.trim() !== '' &&
              Number.isFinite(targetNum) &&
              targetNum > 0 &&
              estimate.low > 0 &&
              estimate.high > 0 &&
              Number.isFinite(targetNum / estimate.low) &&
              Number.isFinite(targetNum / estimate.high) ? (
                <>
                  {' '}
                  A {money(targetNum)} target resembles roughly{' '}
                  {String(Math.floor(targetNum / estimate.high))}–
                  {String(Math.ceil(targetNum / estimate.low))} such attempts —
                  approximate, partial coverage, not an enforceable exchange rate.
                </>
              ) : null}
            </p>
          )}
        </section>
        <p className="field-hint">
          Generated {formatTime(new Date().toISOString())} · {String(summary.runsScanned)}{' '}
          runs scanned
          {summary.from ? ` from ${summary.from}` : ''}
          {summary.to ? ` to ${summary.to}` : ''}.
        </p>
      </div>
    </>
  );
}
