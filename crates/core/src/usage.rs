//! Workflow-wide usage controls: capability labels, injected Agent guidance,
//! and history analytics.
//!
//! Orchevia enforces only what it owns — the number of dispatched Agent
//! attempts per run. Everything inside a CLI's own tool loop (individual
//! tools, nested subagents, agentic turns) is advisory prompt guidance plus
//! observed stream counts, because the CLI owns that loop. Monetary figures
//! stay in three separate lanes: user-entered subscription fees, CLI-reported
//! API-equivalent estimates, and optional labeled allocation between them.

use crate::agents::AdapterKind;
use crate::db::{SqliteDb, StoredNodeResult, StoredRun};
use crate::run_controls::ResolvedLimits;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// -- Capability labels -------------------------------------------------------

/// How a usage control behaves for one adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    /// Orchevia (or the CLI flag it passes) stops the work.
    Enforced,
    /// Counted from CLI stream events; visible in reports, stops nothing.
    Observed,
    /// Asked of the agent in the injected policy; not mechanically stopped.
    Advisory,
    /// No mechanism on this adapter; shown honestly as uncovered.
    Unsupported,
}

impl Capability {
    pub fn as_str(self) -> &'static str {
        match self {
            Capability::Enforced => "enforced",
            Capability::Observed => "observed",
            Capability::Advisory => "advisory",
            Capability::Unsupported => "unsupported",
        }
    }
}

/// What each adapter actually supports, verified against the commands
/// Orchevia builds in [`crate::agents`]:
/// - Orchevia never passes `--max-turns`/`--max-budget-usd` itself, so turn
///   and spend caps inside the CLI are not Orchevia-enforced. Claude's
///   `--max-turns` counts agentic turns, not individual tools, and its
///   `--max-budget-usd` is a client-side API estimate that can overshoot;
///   users may pass them via a profile's extra arguments (then they are the
///   CLI's own enforcement, reported here as advisory coverage).
/// - Codex has no verified equivalent flags, so turn/spend control there is
///   unsupported beyond the injected guidance.
/// - Custom/text adapters report no usage, so observation is unsupported.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterCapabilities {
    pub adapter: String,
    /// Total dispatched Agent attempts for the run (Orchevia dispatch gate).
    pub agent_attempts: Capability,
    /// Agentic turns inside one CLI invocation (e.g. Claude `--max-turns`).
    pub agent_turns: Capability,
    /// Individual tool calls inside one CLI invocation.
    pub tool_calls: Capability,
    /// Nested subagents spawned by the CLI invocation.
    pub subagents: Capability,
    /// CLI-reported USD estimates (pause the run; can overshoot).
    pub spend_estimate: Capability,
    /// Short human note naming the verified basis.
    pub note: String,
}

pub fn adapter_capabilities(adapter: AdapterKind) -> AdapterCapabilities {
    match adapter {
        AdapterKind::Claude => AdapterCapabilities {
            adapter: adapter.as_str().into(),
            agent_attempts: Capability::Enforced,
            agent_turns: Capability::Advisory,
            tool_calls: Capability::Advisory,
            subagents: Capability::Advisory,
            spend_estimate: Capability::Enforced,
            note: "Attempts enforced per run by Orchevia. Turns/tools/subagents are advisory guidance plus observed stream counts: Claude --max-turns counts agentic turns, not tools, and --max-budget-usd is a client-side estimate that can overshoot; Orchevia passes neither flag itself.".into(),
        },
        AdapterKind::Codex => AdapterCapabilities {
            adapter: adapter.as_str().into(),
            agent_attempts: Capability::Enforced,
            agent_turns: Capability::Advisory,
            tool_calls: Capability::Observed,
            subagents: Capability::Advisory,
            spend_estimate: Capability::Unsupported,
            note: "Attempts enforced per run by Orchevia. No verified Codex turn/spend flags: turns and subagents are advisory guidance; tool-completion events are observed where the CLI reports them. Codex runs report no USD.".into(),
        },
        AdapterKind::Custom => AdapterCapabilities {
            adapter: adapter.as_str().into(),
            agent_attempts: Capability::Enforced,
            agent_turns: Capability::Unsupported,
            tool_calls: Capability::Unsupported,
            subagents: Capability::Unsupported,
            spend_estimate: Capability::Unsupported,
            note: "Custom/text adapters report no usage: only the Orchevia attempt gate applies; turns, tools, subagents and spend are uncovered.".into(),
        },
    }
}

// -- Injected usage policy ---------------------------------------------------

/// Short coverage line for the injected policy: what is enforced versus
/// advisory on this adapter. Never mentions subscription balances.
pub fn policy_coverage_note(adapter: AdapterKind) -> &'static str {
    match adapter {
        AdapterKind::Claude => {
            "Only the run attempt budget is enforced; turns, tools and subagents are advisory guidance."
        }
        AdapterKind::Codex => {
            "Only the run attempt budget is enforced; turns and subagents are advisory, tool completions observed."
        }
        AdapterKind::Custom => {
            "Only the run attempt budget applies; this CLI reports no internal usage."
        }
    }
}
/// Marker delimiting the single injected policy block. Presence of the
/// marker means "already injected": handoffs and follow-up prompts must not
/// copy it again.
pub const USAGE_POLICY_MARKER: &str = "ORCHEVIA-USAGE-POLICY-v1";

/// Compose the one short policy injected into every Agent invocation through
/// the authoritative execution path. `node_allowance` is this node's own
/// advisory share (never the whole workflow budget); `remaining_attempts` is
/// the shared budget left, if limited. Stricter node instructions always win:
/// this policy adds bounds, never loosens models, independence, acceptance
/// criteria or required tests. It never mentions subscription-dollar
/// balances, which Orchevia cannot know.
pub fn build_usage_policy(
    node_allowance: Option<(Option<u32>, Option<u32>)>,
    remaining_attempts: Option<u32>,
    capabilities_note: &str,
) -> String {
    let mut lines = vec![
        format!(
            "[{USAGE_POLICY_MARKER}] Work inside these bounds; they never override the task's own requirements or tests."
        ),
        "Search before reading; open relevant ranges and bound command output.".into(),
        "Reuse supplied artifacts and previously verified results. Batch independent reads and related edits.".into(),
        "Avoid unchanged-code re-review; rerun checks only when changes, failures or uncertainty justify it.".into(),
    ];
    let (tools, subagents) = node_allowance.unwrap_or((None, None));
    match (tools, subagents) {
        (Some(t), Some(s)) => lines.push(format!(
            "Advisory allowance for this step: about {t} tool calls, {s} nested subagents."
        )),
        (Some(t), None) => lines.push(format!(
            "Advisory allowance for this step: about {t} tool calls."
        )),
        (None, Some(s)) => lines.push(format!(
            "Advisory allowance for this step: about {s} nested subagents."
        )),
        (None, None) => {}
    }
    lines.push(
        "Do not spawn agents unless explicitly allowed; count allowed descendants toward the shared allowance where observable.".into(),
    );
    if let Some(left) = remaining_attempts {
        lines.push(format!(
            "Shared run budget: about {left} Agent attempts remain. If the allowance cannot cover required work, preserve progress and explicitly report unfinished verification and the needed extension."
        ));
    } else {
        lines.push(
            "If the allowance cannot cover required work, preserve progress and explicitly report unfinished verification and the needed extension.".into(),
        );
    }
    lines.push("Never claim completion or approval merely to fit the allowance.".into());
    if !capabilities_note.trim().is_empty() {
        lines.push(format!("Coverage: {capabilities_note}"));
    }
    lines.join("\n")
}

/// Inject the policy into a composed Agent prompt exactly once. Prompts that
/// already carry the marker (resumed handoffs, follow-ups) pass through
/// untouched so earlier policies are never recursively copied.
pub fn inject_usage_policy(prompt: &str, policy: &str) -> String {
    if prompt.contains(USAGE_POLICY_MARKER) || policy.trim().is_empty() {
        return prompt.to_string();
    }
    if prompt.trim().is_empty() {
        return policy.to_string();
    }
    format!("{policy}\n\n---\n\n{prompt}")
}

// -- Analytics ---------------------------------------------------------------

/// Filters for [`usage_summary`]. Date boundaries are RFC 3339: `from`
/// inclusive, `to` exclusive. Display timezone is informational only;
/// grouping is by UTC calendar day.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageFilter {
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub workflow_ids: Vec<String>,
    #[serde(default)]
    pub adapters: Vec<String>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub timezone: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDay {
    pub day: String,
    pub runs: u32,
    pub agent_attempts: u32,
    pub reported_usd: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWorkflowRow {
    pub workflow_id: String,
    /// Workflow name recorded when the run started (snapshot), not the
    /// current mutable label.
    pub workflow_name: String,
    pub runs: u32,
    pub agent_attempts: u32,
    pub reported_usd: f64,
    pub unknown_usd_attempts: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageModelRow {
    /// Adapter + model recorded at execution time; legacy rows stay "unknown".
    pub adapter: String,
    pub model: String,
    pub agent_attempts: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reported_usd: f64,
    pub observed_tool_calls: u64,
    pub observed_subagents: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub runs: u32,
    pub agent_attempts: u32,
    pub failed_attempts: u32,
    pub retried_attempts: u32,
    pub reused_results: u32,
    pub simulated_results: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reported_usd: f64,
    pub reported_usd_attempts: u32,
    pub unknown_usd_attempts: u32,
    pub observed_tool_calls: u64,
    pub observed_subagents: u64,
    /// Rows whose adapter/model predates execution-time recording.
    pub unknown_model_attempts: u32,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub totals: UsageTotals,
    pub days: Vec<UsageDay>,
    pub by_workflow: Vec<UsageWorkflowRow>,
    pub by_model: Vec<UsageModelRow>,
    /// Inclusive start / exclusive end actually applied, RFC 3339.
    pub from: Option<String>,
    pub to: Option<String>,
    /// Timezone label echoed for display; grouping is UTC days.
    pub timezone: String,
    /// Rows scanned (runs), so the UI can say when history is thin.
    pub runs_scanned: u32,
    /// Recent per-attempt CLI-reported USD samples (newest first, capped)
    /// for comparable-history estimate ranges. Never a forecast by itself.
    #[serde(default)]
    pub recent_attempt_usd: Vec<f64>,
}

/// Cap for shipped USD samples: enough for quartile ranges, bounded for IPC.
pub const MAX_USD_SAMPLES: usize = 500;

fn metadata(row: &StoredNodeResult) -> serde_json::Value {
    serde_json::from_str(&row.structured_json).unwrap_or_default()
}

fn meta_u64(meta: &serde_json::Value, key: &str) -> u64 {
    meta.pointer(&format!("/agentUsage/{key}"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0)
}

fn is_agent_result(row: &StoredNodeResult, agent_ids: &std::collections::HashSet<String>) -> bool {
    if agent_ids.contains(&row.node_id) {
        return true;
    }
    // Snapshot missing (legacy runs): fall back to envelope keys.
    let meta = metadata(row);
    meta.get("agentUsage").is_some() || meta.get("agentSession").is_some()
}

/// Aggregate run history in the backend. Never built from a capped recent
/// list: every stored run in range is scanned. Fixtures (`simulated`) and
/// reused outputs contribute no new consumption. Missing fields, malformed
/// records, legacy history and unsupported adapters stay "unknown", never
/// zero-filled into a false precision.
pub fn usage_summary(db: &SqliteDb, filter: &UsageFilter) -> Result<UsageSummary, String> {
    let runs: Vec<StoredRun> = db.list_all_runs().map_err(|e| e.to_string())?;
    let from = filter
        .from
        .as_deref()
        .map(chrono::DateTime::parse_from_rfc3339)
        .transpose()
        .map_err(|_| "Invalid 'from' date; use RFC 3339.".to_string())?
        .map(|d| d.with_timezone(&chrono::Utc));
    let to = filter
        .to
        .as_deref()
        .map(chrono::DateTime::parse_from_rfc3339)
        .transpose()
        .map_err(|_| "Invalid 'to' date; use RFC 3339.".to_string())?
        .map(|d| d.with_timezone(&chrono::Utc));
    let mut summary = UsageSummary {
        from: filter.from.clone(),
        to: filter.to.clone(),
        timezone: filter.timezone.clone().unwrap_or_else(|| "UTC".into()),
        ..UsageSummary::default()
    };
    // Workflow names at execution time come from the stored snapshot.
    let mut days: HashMap<String, UsageDay> = HashMap::new();
    let mut workflows: HashMap<String, UsageWorkflowRow> = HashMap::new();
    let mut models: HashMap<(String, String), UsageModelRow> = HashMap::new();
    let mut scanned = 0u32;
    for run in &runs {
        if !filter.workflow_ids.is_empty() && !filter.workflow_ids.contains(&run.workflow_id) {
            continue;
        }
        if let Some(from) = from {
            if run.started_at < from {
                continue;
            }
        }
        if let Some(to) = to {
            if run.started_at >= to {
                continue;
            }
        }
        let dry = run.execution.options.dry_run;
        let snapshot = db.get_run_snapshot(&run.id).ok().flatten();
        let snapshot_name = snapshot
            .as_ref()
            .map(|w| w.name.clone())
            .unwrap_or_else(|| run.workflow_id.clone());
        // Agent identity at execution time: node kinds from the snapshot,
        // so text-mode and legacy rows still count as attempts (unknown
        // model/usage), never as zero.
        let agent_ids: std::collections::HashSet<String> = snapshot
            .map(|w| {
                w.nodes
                    .iter()
                    .filter(|n| n.kind == crate::workflow::NodeKind::Agent)
                    .map(|n| n.id.clone())
                    .collect()
            })
            .unwrap_or_default();
        let rows = db.list_node_results(&run.id).map_err(|e| e.to_string())?;
        // Terminal-event dedupe: identical (node, attempt, status) rows keep
        // the first; parent/subagent wrapper rows never enter totals.
        let mut seen_terminal: HashMap<(String, u32, String), bool> = HashMap::new();
        let mut run_attempts = 0u32;
        let mut run_usd = 0.0f64;
        let mut run_unknown = 0u32;
        let mut run_in = 0u64;
        let mut run_out = 0u64;
        let mut counted_rows: Vec<&StoredNodeResult> = Vec::new();
        for row in &rows {
            if !is_agent_result(row, &agent_ids) {
                // Reused non-agent outputs still count as reuse evidence.
                let meta = metadata(row);
                if meta.get("reusedFrom").is_some() {
                    summary.totals.reused_results += 1;
                } else if meta.get("simulated") == Some(&serde_json::Value::Bool(true)) {
                    summary.totals.simulated_results += 1;
                }
                continue;
            }
            let meta = metadata(row);
            let simulated = meta.get("simulated") == Some(&serde_json::Value::Bool(true));
            let reused = meta.get("reusedFrom").is_some();
            if simulated {
                summary.totals.simulated_results += 1;
                continue;
            }
            if reused {
                summary.totals.reused_results += 1;
                continue;
            }
            let terminal = matches!(
                row.status.as_str(),
                "succeeded" | "failed" | "cancelled" | "retrying"
            );
            if terminal {
                let key = (row.node_id.clone(), row.attempt, row.status.clone());
                if seen_terminal.insert(key, true).is_some() {
                    continue; // duplicate terminal event for the same attempt
                }
            }
            // Adapter/model recorded at execution time; legacy rows unknown.
            let adapter = meta
                .pointer("/agentUsage/adapter")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let model = meta
                .pointer("/agentUsage/model")
                .and_then(serde_json::Value::as_str)
                .filter(|m| !m.trim().is_empty())
                .unwrap_or("unknown")
                .to_string();
            if !filter.adapters.is_empty() && !filter.adapters.contains(&adapter) {
                continue;
            }
            if !filter.models.is_empty() && !filter.models.contains(&model) {
                continue;
            }
            counted_rows.push(row);
            run_attempts += 1;
            run_in += meta_u64(&meta, "input_tokens")
                + meta_u64(&meta, "cached_input_tokens")
                + meta_u64(&meta, "cache_read_input_tokens");
            run_out += meta_u64(&meta, "output_tokens");
            if let Some(cost) = meta
                .pointer("/agentUsage/reported_cost_usd")
                .and_then(serde_json::Value::as_f64)
                .filter(|n| n.is_finite() && *n >= 0.0)
            {
                run_usd += cost;
                summary.totals.reported_usd += cost;
                summary.totals.reported_usd_attempts += 1;
                if summary.recent_attempt_usd.len() < MAX_USD_SAMPLES {
                    summary.recent_attempt_usd.push(cost);
                }
            } else {
                summary.totals.unknown_usd_attempts += 1;
                run_unknown += 1;
            }
            let tools = meta_u64(&meta, "observed_tool_calls");
            let subs = meta_u64(&meta, "observed_subagents");
            summary.totals.observed_tool_calls += tools;
            summary.totals.observed_subagents += subs;
            if adapter == "unknown" {
                summary.totals.unknown_model_attempts += 1;
            }
            if row.status == "failed" {
                summary.totals.failed_attempts += 1;
            }
            if row.status == "retrying" {
                summary.totals.retried_attempts += 1;
            }
            let entry = models
                .entry((adapter.clone(), model.clone()))
                .or_insert_with(|| UsageModelRow {
                    adapter: adapter.clone(),
                    model: model.clone(),
                    ..UsageModelRow::default()
                });
            entry.agent_attempts += 1;
            entry.input_tokens += meta_u64(&meta, "input_tokens")
                + meta_u64(&meta, "cached_input_tokens")
                + meta_u64(&meta, "cache_read_input_tokens");
            entry.output_tokens += meta_u64(&meta, "output_tokens");
            if let Some(cost) = meta
                .pointer("/agentUsage/reported_cost_usd")
                .and_then(serde_json::Value::as_f64)
                .filter(|n| n.is_finite() && *n >= 0.0)
            {
                entry.reported_usd += cost;
            }
            entry.observed_tool_calls += tools;
            entry.observed_subagents += subs;
        }
        if counted_rows.is_empty() && !dry {
            // Runs without agent attempts still count as workflow runs.
        }
        scanned += 1;
        if dry {
            continue; // dry fixtures never contribute to consumption totals
        }
        summary.totals.runs += 1;
        summary.totals.agent_attempts += run_attempts;
        summary.totals.input_tokens += run_in;
        summary.totals.output_tokens += run_out;
        let day = run.started_at.format("%Y-%m-%d").to_string();
        let day_entry = days.entry(day.clone()).or_insert_with(|| UsageDay {
            day,
            ..UsageDay::default()
        });
        day_entry.runs += 1;
        day_entry.agent_attempts += run_attempts;
        day_entry.reported_usd += run_usd;
        day_entry.input_tokens += run_in;
        day_entry.output_tokens += run_out;
        let wf_entry =
            workflows
                .entry(run.workflow_id.clone())
                .or_insert_with(|| UsageWorkflowRow {
                    workflow_id: run.workflow_id.clone(),
                    workflow_name: snapshot_name.clone(),
                    ..UsageWorkflowRow::default()
                });
        wf_entry.runs += 1;
        wf_entry.agent_attempts += run_attempts;
        wf_entry.reported_usd += run_usd;
        wf_entry.unknown_usd_attempts += run_unknown;
    }
    let mut day_list: Vec<UsageDay> = days.into_values().collect();
    day_list.sort_by(|a, b| a.day.cmp(&b.day));
    let mut wf_list: Vec<UsageWorkflowRow> = workflows.into_values().collect();
    wf_list.sort_by(|a, b| {
        b.agent_attempts
            .cmp(&a.agent_attempts)
            .then_with(|| a.workflow_name.cmp(&b.workflow_name))
    });
    let mut model_list: Vec<UsageModelRow> = models.into_values().collect();
    model_list.sort_by(|a, b| {
        b.agent_attempts.cmp(&a.agent_attempts).then_with(|| {
            a.adapter
                .cmp(&b.adapter)
                .then_with(|| a.model.cmp(&b.model))
        })
    });
    summary.days = day_list;
    summary.by_workflow = wf_list;
    summary.by_model = model_list;
    summary.runs_scanned = scanned;
    Ok(summary)
}

// -- Subscription vs estimate separation -------------------------------------

/// User-entered subscription fee for a billing period. Illustrative settings
/// only — never defaults, never verified provider prices.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscriptionFee {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub amount_usd: f64,
    /// e.g. "2026-10-01/2026-11-01"; free text, shown verbatim.
    #[serde(default)]
    pub period: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtraCharge {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub amount_usd: f64,
}

pub fn validate_money_entries(label: &str, entries: &[(String, f64)]) -> Result<(), String> {
    for (name, amount) in entries {
        if !amount.is_finite() || *amount < 0.0 {
            return Err(format!(
                "{label} '{name}' must be a finite USD amount >= 0."
            ));
        }
    }
    Ok(())
}

/// Suggest an API-equivalent target range from comparable measured history.
/// Returns `None` ("Insufficient history") when fewer than `min_samples`
/// comparable attempts exist. Approximate scenarios only — never a fixed
/// USD-to-tools exchange rate and never a cost forecast.
pub fn estimate_range_usd(samples_usd: &[f64], min_samples: usize) -> Option<(f64, f64, usize)> {
    let mut valid: Vec<f64> = samples_usd
        .iter()
        .copied()
        .filter(|n| n.is_finite() && *n >= 0.0)
        .collect();
    if valid.len() < min_samples {
        return None;
    }
    valid.sort_by(|a, b| a.total_cmp(b));
    let low = valid[valid.len() / 4];
    let high = valid[(valid.len() * 3) / 4].max(low);
    Some((low, high, valid.len()))
}

/// Keep [`ResolvedLimits`] visible for policy/tests without moving ownership.
pub fn remaining_attempts(limits: &ResolvedLimits, consumed: u32) -> Option<u32> {
    limits
        .max_agent_attempts
        .map(|max| max.saturating_sub(consumed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run_controls::{resolve_limits, RunOptions, WorkflowLimits};

    #[test]
    fn policy_injects_once_and_never_recurses() {
        let policy = build_usage_policy(Some((Some(50), Some(2))), Some(7), "test");
        assert!(policy.contains(USAGE_POLICY_MARKER));
        assert!(policy.contains("Never claim completion"));
        let once = inject_usage_policy("Do the task.", &policy);
        assert!(once.contains(USAGE_POLICY_MARKER));
        let twice = inject_usage_policy(&once, &policy);
        assert_eq!(once, twice);
        assert_eq!(twice.matches(USAGE_POLICY_MARKER).count(), 1);
        // Empty prompts still carry the policy alone; empty policy is a no-op.
        assert_eq!(inject_usage_policy("", &policy), policy);
        assert_eq!(inject_usage_policy("Do the task.", "  "), "Do the task.");
    }

    #[test]
    fn policy_gives_node_share_not_workflow_budget() {
        let policy = build_usage_policy(Some((Some(40), None)), None, "");
        assert!(policy.contains("about 40 tool calls"));
        assert!(!policy.contains("Shared run budget"));
        assert!(!policy.to_lowercase().contains("subscription"));
        assert!(!policy.contains("balance"));
    }

    #[test]
    fn limits_resolve_saved_then_override_then_clear() {
        let saved = WorkflowLimits {
            max_agent_attempts: Some(10),
            max_tool_calls: Some(100),
            max_subagents: None,
            spend_limit_usd: Some(5.0),
        };
        let inherit = resolve_limits(Some(&saved), &RunOptions::default());
        assert_eq!(inherit.max_agent_attempts, Some(10));
        assert_eq!(inherit.spend_limit_usd, Some(5.0));
        let over = resolve_limits(
            Some(&saved),
            &RunOptions {
                max_agent_attempts: Some(3),
                ..RunOptions::default()
            },
        );
        assert_eq!(over.max_agent_attempts, Some(3));
        assert_eq!(over.max_tool_calls, Some(100));
        let cleared = resolve_limits(
            Some(&saved),
            &RunOptions {
                ignore_saved_limits: true,
                max_tool_calls: Some(7),
                ..RunOptions::default()
            },
        );
        assert_eq!(cleared.max_agent_attempts, None);
        assert_eq!(cleared.max_tool_calls, Some(7));
        assert_eq!(cleared.spend_limit_usd, None);
    }

    #[test]
    fn estimate_range_needs_samples_and_stays_approximate() {
        assert!(estimate_range_usd(&[1.0, 2.0], 3).is_none());
        let (low, high, n) = estimate_range_usd(&[1.0, 2.0, 3.0, 4.0, 8.0], 3).expect("range");
        assert_eq!(n, 5);
        assert!(low <= high);
        assert!(estimate_range_usd(&[f64::NAN, f64::INFINITY, -1.0], 1).is_none());
    }

    #[test]
    fn claude_and_codex_capabilities_are_honest() {
        let claude = adapter_capabilities(AdapterKind::Claude);
        assert_eq!(claude.agent_attempts, Capability::Enforced);
        assert_eq!(claude.tool_calls, Capability::Advisory);
        let codex = adapter_capabilities(AdapterKind::Codex);
        assert_eq!(codex.spend_estimate, Capability::Unsupported);
        let custom = adapter_capabilities(AdapterKind::Custom);
        assert_eq!(custom.tool_calls, Capability::Unsupported);
        for caps in [claude, codex, custom] {
            assert!(!caps.note.trim().is_empty());
        }
    }
}
