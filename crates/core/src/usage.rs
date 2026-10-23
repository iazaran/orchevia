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

/// Remove earlier injected blocks from handoffs, then prepend the current
/// invocation's policy once. The shared allowance may have changed since a
/// previous invocation.
pub fn inject_usage_policy(prompt: &str, policy: &str) -> String {
    if policy.trim().is_empty() {
        return prompt.to_string();
    }
    let mut cleaned = prompt.to_string();
    let marker = format!("[{USAGE_POLICY_MARKER}]");
    while let Some(start) = cleaned.find(&marker) {
        let Some(end) = cleaned[start..].find("\n\n---\n\n") else {
            break;
        };
        cleaned.replace_range(start..start + end + "\n\n---\n\n".len(), "");
    }
    if cleaned.trim().is_empty() {
        return policy.to_string();
    }
    format!("{policy}\n\n---\n\n{cleaned}")
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
    /// Only these runs (the Runs view asks for one run's part of its day).
    #[serde(default)]
    pub run_ids: Vec<String>,
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
pub struct UsageProfileRow {
    /// Profile ID from the immutable run snapshot. Missing snapshots/IDs stay unknown.
    pub profile_id: Option<String>,
    pub runs: u32,
    pub agent_attempts: u32,
    pub total_duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<chrono::DateTime<chrono::Utc>>,
    pub reported_usd: f64,
    pub reported_usd_attempts: u32,
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
    pub reported_usd_attempts: u32,
    pub unknown_usd_attempts: u32,
    pub observed_tool_calls: u64,
    pub observed_subagents: u64,
    pub cached_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub coverage: UsageCoverage,
}

/// Number of attempts reporting each metric. Absent counters remain unknown;
/// a reported zero counts as covered. Claude total-input coverage requires its
/// uncached, cache-read and cache-write components.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCoverage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cached_input_tokens: u32,
    pub cache_read_input_tokens: u32,
    pub cache_creation_input_tokens: u32,
    pub reasoning_output_tokens: u32,
    pub tool_calls: u32,
    pub subagents: u32,
}

impl UsageCoverage {
    fn add(&mut self, other: &Self) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cached_input_tokens += other.cached_input_tokens;
        self.cache_read_input_tokens += other.cache_read_input_tokens;
        self.cache_creation_input_tokens += other.cache_creation_input_tokens;
        self.reasoning_output_tokens += other.reasoning_output_tokens;
        self.tool_calls += other.tool_calls;
        self.subagents += other.subagents;
    }
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
    pub cached_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub coverage: UsageCoverage,
}

/// Agent work per UTC day (the day each run started) and provider, so a
/// monthly plan's fee can be spread over the days it was used.
/// `agent_attempts`, `duration_ms` and the reported USD follow every filter.
/// The `all_*` fields count every dispatched attempt of that provider on that
/// day, whatever the workflow, run or model filters, so a filtered view gets its
/// part of the day's fee rather than all of it. They only see runs inside the
/// requested `from`/`to`, so callers ask for whole UTC days.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageProviderDay {
    pub day: String,
    pub adapter: String,
    pub agent_attempts: u32,
    pub duration_ms: u64,
    pub reported_usd: f64,
    pub reported_usd_attempts: u32,
    pub all_agent_attempts: u32,
    pub all_duration_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub totals: UsageTotals,
    pub days: Vec<UsageDay>,
    pub by_workflow: Vec<UsageWorkflowRow>,
    pub by_model: Vec<UsageModelRow>,
    pub by_profile: Vec<UsageProfileRow>,
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
    /// Filtered attempts per UTC day and provider (see [`UsageProviderDay`]).
    #[serde(default)]
    pub provider_days: Vec<UsageProviderDay>,
}

/// Cap for shipped USD samples: enough for quartile ranges, bounded for IPC.
pub const MAX_USD_SAMPLES: usize = 500;

fn metadata(row: &StoredNodeResult) -> serde_json::Value {
    serde_json::from_str(&row.structured_json).unwrap_or_default()
}

fn meta_count(meta: &serde_json::Value, key: &str) -> Option<u64> {
    meta.pointer(&format!("/agentUsage/{key}"))
        .and_then(serde_json::Value::as_u64)
        .filter(|value| *value <= 9_007_199_254_740_991)
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
    let mut profiles: HashMap<Option<String>, UsageProfileRow> = HashMap::new();
    let mut provider_days: HashMap<(String, String), UsageProviderDay> = HashMap::new();
    let mut scanned = 0u32;
    for run in &runs {
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
        // Runs outside the workflow and run filters still add to each
        // provider-day's total agent time, which splits a plan's daily fee.
        let in_scope = (filter.workflow_ids.is_empty()
            || filter.workflow_ids.contains(&run.workflow_id))
            && (filter.run_ids.is_empty() || filter.run_ids.contains(&run.id));
        let dry = run.execution.options.dry_run;
        if dry && !in_scope {
            continue;
        }
        let day = run.started_at.format("%Y-%m-%d").to_string();
        let snapshot = db.get_run_snapshot(&run.id).ok().flatten();
        let snapshot_name = snapshot
            .as_ref()
            .map(|w| w.name.clone())
            .unwrap_or_else(|| run.workflow_id.clone());
        // Agent identity at execution time: node kinds from the snapshot,
        // so text-mode and legacy rows still count as attempts (unknown
        // model/usage), never as zero.
        let agent_ids: std::collections::HashSet<String> = snapshot
            .as_ref()
            .map(|w| {
                w.nodes
                    .iter()
                    .filter(|n| n.kind == crate::workflow::NodeKind::Agent)
                    .map(|n| n.id.clone())
                    .collect()
            })
            .unwrap_or_default();
        let agent_profiles: HashMap<String, Option<String>> = snapshot
            .as_ref()
            .map(|w| {
                w.nodes
                    .iter()
                    .filter(|n| n.kind == crate::workflow::NodeKind::Agent)
                    .map(|n| {
                        (
                            n.id.clone(),
                            n.config
                                .agent_profile_id
                                .clone()
                                .filter(|id| !id.trim().is_empty()),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        let rows = db.list_node_results(&run.id).map_err(|e| e.to_string())?;
        // A persisted result id identifies one dispatch. Loop visits can
        // share node/attempt/status; they must each contribute consumption.
        let mut seen_results = std::collections::HashSet::new();
        let mut run_profiles = std::collections::HashSet::new();
        let mut run_attempts = 0u32;
        let mut run_usd = 0.0f64;
        let mut run_unknown = 0u32;
        let mut run_in = 0u64;
        let mut run_out = 0u64;
        for row in &rows {
            if !is_agent_result(row, &agent_ids) {
                if !in_scope {
                    continue;
                }
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
                summary.totals.simulated_results += u32::from(in_scope);
                continue;
            }
            if reused {
                summary.totals.reused_results += u32::from(in_scope);
                continue;
            }
            if dry
                || !crate::run_controls::is_dispatched_attempt(row)
                || !seen_results.insert(row.id)
            {
                continue;
            }
            // Adapter/model recorded at execution time; legacy rows unknown.
            let adapter = meta
                .pointer("/agentUsage/adapter")
                .and_then(serde_json::Value::as_str)
                .filter(|a| !a.trim().is_empty())
                .unwrap_or("unknown")
                .to_string();
            let model = meta
                .pointer("/agentUsage/model")
                .and_then(serde_json::Value::as_str)
                .filter(|m| !m.trim().is_empty())
                .unwrap_or("unknown")
                .to_string();
            let provider_day = provider_days
                .entry((day.clone(), adapter.clone()))
                .or_insert_with(|| UsageProviderDay {
                    day: day.clone(),
                    adapter: adapter.clone(),
                    ..UsageProviderDay::default()
                });
            provider_day.all_agent_attempts += 1;
            provider_day.all_duration_ms += row.duration_ms;
            if !in_scope
                || (!filter.adapters.is_empty() && !filter.adapters.contains(&adapter))
                || (!filter.models.is_empty() && !filter.models.contains(&model))
            {
                continue;
            }
            provider_day.agent_attempts += 1;
            provider_day.duration_ms += row.duration_ms;
            run_attempts += 1;
            let input = meta_count(&meta, "input_tokens");
            let output = meta_count(&meta, "output_tokens");
            let cached = meta_count(&meta, "cached_input_tokens");
            let read = meta_count(&meta, "cache_read_input_tokens");
            let created = meta_count(&meta, "cache_creation_input_tokens");
            let reasoning = meta_count(&meta, "reasoning_output_tokens");
            // Codex cached_input_tokens is a subset of input_tokens. Claude
            // reports three disjoint input components.
            let input_total = input.unwrap_or(0)
                + if adapter == "claude" {
                    read.unwrap_or(0) + created.unwrap_or(0)
                } else {
                    0
                };
            let tools = meta_count(&meta, "observed_tool_calls");
            let subs = meta_count(&meta, "observed_subagents");
            let coverage = UsageCoverage {
                input_tokens: u32::from(
                    input.is_some()
                        && (adapter != "claude" || (read.is_some() && created.is_some())),
                ),
                output_tokens: u32::from(output.is_some()),
                cached_input_tokens: u32::from(cached.is_some()),
                cache_read_input_tokens: u32::from(read.is_some()),
                cache_creation_input_tokens: u32::from(created.is_some()),
                reasoning_output_tokens: u32::from(reasoning.is_some()),
                tool_calls: u32::from(tools.is_some()),
                subagents: u32::from(subs.is_some()),
            };
            run_in += input_total;
            run_out += output.unwrap_or(0);
            summary.totals.cached_input_tokens += cached.unwrap_or(0);
            summary.totals.cache_read_input_tokens += read.unwrap_or(0);
            summary.totals.cache_creation_input_tokens += created.unwrap_or(0);
            summary.totals.reasoning_output_tokens += reasoning.unwrap_or(0);
            summary.totals.coverage.add(&coverage);
            let cost = meta
                .pointer("/agentUsage/reported_cost_usd")
                .and_then(serde_json::Value::as_f64)
                .filter(|n| n.is_finite() && *n >= 0.0);
            if let Some(cost) = cost {
                provider_day.reported_usd += cost;
                provider_day.reported_usd_attempts += 1;
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
            summary.totals.observed_tool_calls += tools.unwrap_or(0);
            summary.totals.observed_subagents += subs.unwrap_or(0);
            if adapter == "unknown" || model == "unknown" {
                summary.totals.unknown_model_attempts += 1;
            }
            if row.status == "failed" {
                summary.totals.failed_attempts += 1;
            }
            if row.status == "retrying" {
                summary.totals.retried_attempts += 1;
            }
            let profile_id = agent_profiles.get(&row.node_id).cloned().flatten();
            let profile = profiles
                .entry(profile_id.clone())
                .or_insert_with(|| UsageProfileRow {
                    profile_id: profile_id.clone(),
                    ..UsageProfileRow::default()
                });
            profile.runs += u32::from(run_profiles.insert(profile_id));
            profile.agent_attempts += 1;
            profile.total_duration_ms += row.duration_ms;
            if profile.last_run_at.is_none_or(|last| run.started_at > last) {
                profile.last_run_at = Some(run.started_at);
            }
            if let Some(cost) = cost {
                profile.reported_usd += cost;
                profile.reported_usd_attempts += 1;
            } else {
                profile.unknown_usd_attempts += 1;
            }
            let entry = models
                .entry((adapter.clone(), model.clone()))
                .or_insert_with(|| UsageModelRow {
                    adapter: adapter.clone(),
                    model: model.clone(),
                    ..UsageModelRow::default()
                });
            entry.agent_attempts += 1;
            entry.input_tokens += input_total;
            entry.output_tokens += output.unwrap_or(0);
            entry.cached_input_tokens += cached.unwrap_or(0);
            entry.cache_read_input_tokens += read.unwrap_or(0);
            entry.cache_creation_input_tokens += created.unwrap_or(0);
            entry.reasoning_output_tokens += reasoning.unwrap_or(0);
            entry.coverage.add(&coverage);
            if let Some(cost) = cost {
                entry.reported_usd += cost;
                entry.reported_usd_attempts += 1;
            } else {
                entry.unknown_usd_attempts += 1;
            }
            entry.observed_tool_calls += tools.unwrap_or(0);
            entry.observed_subagents += subs.unwrap_or(0);
        }
        if !in_scope {
            continue;
        }
        scanned += 1;
        if dry || (run_attempts == 0 && (!filter.adapters.is_empty() || !filter.models.is_empty()))
        {
            continue; // dry fixtures never contribute to consumption totals
        }
        summary.totals.runs += 1;
        summary.totals.agent_attempts += run_attempts;
        summary.totals.input_tokens += run_in;
        summary.totals.output_tokens += run_out;
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
    let mut profile_list: Vec<UsageProfileRow> = profiles.into_values().collect();
    profile_list.sort_by(|a, b| {
        b.agent_attempts
            .cmp(&a.agent_attempts)
            .then_with(|| a.profile_id.cmp(&b.profile_id))
    });
    summary.by_profile = profile_list;
    let mut provider_list: Vec<UsageProviderDay> = provider_days
        .into_values()
        .filter(|entry| entry.agent_attempts > 0)
        .collect();
    provider_list.sort_by(|a, b| a.day.cmp(&b.day).then_with(|| a.adapter.cmp(&b.adapter)));
    summary.provider_days = provider_list;
    summary.runs_scanned = scanned;
    Ok(summary)
}

// -- Plans: what the user pays, kept apart from CLI-reported API value -------

/// Providers a plan can be entered for (the adapters that report usage).
pub const PLAN_PROVIDERS: [&str; 2] = ["claude", "codex"];

/// Upper bound for an entered monthly amount; anything above is a typo.
pub const MAX_PLAN_MONTHLY_USD: f64 = 100_000.0;

/// `usage.plans`: `{ "<provider>": { "billing": "subscription" | "api",
/// "monthlyUsd"?: number, "name"?: string } }`. A monthly plan's fee is spread
/// over the days its provider was used; pay-per-use billing costs the API
/// value the CLI reports. Entered by the user, never a looked-up price.
pub fn validate_plans(value: &str) -> Result<(), String> {
    let plans: serde_json::Map<String, serde_json::Value> = serde_json::from_str(value)
        .map_err(|_| "Plans must be a JSON object keyed by provider.".to_string())?;
    for (provider, plan) in &plans {
        if !PLAN_PROVIDERS.contains(&provider.as_str()) {
            return Err(format!("Unknown plan provider '{provider}'."));
        }
        let Some(plan) = plan.as_object() else {
            return Err("Each plan must be an object.".into());
        };
        if plan
            .keys()
            .any(|key| !["billing", "monthlyUsd", "name"].contains(&key.as_str()))
        {
            return Err("Plans hold only billing, monthlyUsd and name.".into());
        }
        match plan.get("billing").and_then(serde_json::Value::as_str) {
            Some("subscription") => {
                let amount = plan.get("monthlyUsd").and_then(serde_json::Value::as_f64);
                if !amount
                    .is_some_and(|n| n.is_finite() && (0.0..=MAX_PLAN_MONTHLY_USD).contains(&n))
                {
                    return Err(
                        "A monthly plan needs its monthly USD amount, from 0 to 100000.".into(),
                    );
                }
            }
            Some("api") => {
                if plan.contains_key("monthlyUsd") {
                    return Err("Pay-per-use billing has no monthly amount.".into());
                }
            }
            _ => return Err("Plan billing must be 'subscription' or 'api'.".into()),
        }
        if plan
            .get("name")
            .is_some_and(|name| !name.as_str().is_some_and(|text| text.len() <= 80))
        {
            return Err("A plan name is text of at most 80 bytes.".into());
        }
    }
    Ok(())
}

pub fn validate_usage_setting(key: &str, value: &str) -> Result<(), String> {
    match key {
        "usage.planShare" => {
            let text = value.trim();
            if text.is_empty() {
                return Ok(());
            }
            let decimal = text.chars().all(|c| c.is_ascii_digit() || c == '.')
                && text.chars().filter(|c| *c == '.').count() <= 1
                && text.chars().any(|c| c.is_ascii_digit());
            if !decimal
                || !text
                    .parse::<f64>()
                    .is_ok_and(|n| n.is_finite() && (0.0..=100.0).contains(&n))
            {
                return Err("Orchevia's share must be a percentage from 0 to 100.".into());
            }
        }
        "usage.plans" => validate_plans(value)?,
        _ => {}
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

    fn analytics_db() -> SqliteDb {
        let db = SqliteDb::open_in_memory().unwrap();
        let workflow = serde_json::from_value(serde_json::json!({
            "schemaVersion": crate::workflow::CURRENT_SCHEMA_VERSION,
            "id":"analytics", "name":"Recorded name", "inputs":[],
            "nodes":[{"id":"a","type":"agent","position":{"x":0,"y":0},"config":{}}],
            "edges":[]
        }))
        .unwrap();
        db.upsert_workflow(&workflow).unwrap();
        db.create_run_with_workflow("r", &workflow, &HashMap::new())
            .unwrap();
        db
    }

    fn analytics_row(db: &SqliteDb, status: &str, usage: serde_json::Value) {
        db.record_node_result(crate::db::NewNodeResult {
            structured_json: &serde_json::json!({"agentUsage": usage}).to_string(),
            ..crate::db::NewNodeResult::simple("r", "a", status, Some(0), None)
        })
        .unwrap();
    }

    #[test]
    fn analytics_counts_distinct_loop_visits_and_excludes_undispatched_rows() {
        let db = analytics_db();
        for _ in 0..2 {
            analytics_row(
                &db,
                "succeeded",
                serde_json::json!({"adapter":"claude","model":"m","reported_cost_usd":2}),
            );
        }
        analytics_row(&db, "skipped", serde_json::Value::Null);
        analytics_row(&db, "guardPaused", serde_json::Value::Null);
        let summary = usage_summary(&db, &UsageFilter::default()).unwrap();
        assert_eq!(summary.totals.agent_attempts, 2);
        assert_eq!(summary.totals.reported_usd, 4.0);
        assert_eq!(summary.totals.unknown_usd_attempts, 0);
    }

    #[test]
    fn analytics_uses_adapter_specific_input_token_semantics() {
        let db = analytics_db();
        analytics_row(
            &db,
            "succeeded",
            serde_json::json!({"adapter":"codex","model":"c","input_tokens":23,"cached_input_tokens":20,"output_tokens":3}),
        );
        analytics_row(
            &db,
            "failed",
            serde_json::json!({"adapter":"claude","model":"m","input_tokens":10,"cache_read_input_tokens":30,"cache_creation_input_tokens":20,"output_tokens":5}),
        );
        let summary = usage_summary(&db, &UsageFilter::default()).unwrap();
        assert_eq!(summary.totals.input_tokens, 83);
        assert_eq!(summary.totals.output_tokens, 8);
        assert_eq!(
            summary
                .by_model
                .iter()
                .find(|r| r.adapter == "codex")
                .unwrap()
                .input_tokens,
            23
        );
        assert_eq!(summary.totals.cached_input_tokens, 20);
        assert_eq!(summary.totals.cache_read_input_tokens, 30);
        assert_eq!(summary.totals.cache_creation_input_tokens, 20);
        assert_eq!(summary.totals.coverage.input_tokens, 2);
        assert_eq!(summary.totals.coverage.tool_calls, 0);
        assert_eq!(summary.totals.coverage.subagents, 0);
    }

    #[test]
    fn analytics_distinguishes_reported_zero_from_missing_metrics() {
        let db = analytics_db();
        analytics_row(
            &db,
            "succeeded",
            serde_json::json!({"adapter":"codex","model":"c","input_tokens":0,"output_tokens":0,"observed_tool_calls":0,"reasoning_output_tokens":2}),
        );
        analytics_row(
            &db,
            "failed",
            serde_json::json!({"adapter":"custom","model":"text"}),
        );
        let summary = usage_summary(&db, &UsageFilter::default()).unwrap();
        assert_eq!(summary.totals.agent_attempts, 2);
        assert_eq!(summary.totals.input_tokens, 0);
        assert_eq!(summary.totals.coverage.input_tokens, 1);
        assert_eq!(summary.totals.coverage.tool_calls, 1);
        assert_eq!(summary.totals.coverage.subagents, 0);
        assert_eq!(summary.totals.reasoning_output_tokens, 2);
        assert_eq!(summary.totals.coverage.reasoning_output_tokens, 1);
    }

    #[test]
    fn analytics_scans_more_than_fifty_runs_and_uses_instant_boundaries() {
        let db = analytics_db();
        let workflow = db.get_run_snapshot("r").unwrap().unwrap();
        for n in 0..55 {
            db.create_run_with_workflow(&format!("r{n}"), &workflow, &HashMap::new())
                .unwrap();
        }
        let all = usage_summary(&db, &UsageFilter::default()).unwrap();
        assert_eq!(all.totals.runs, 56);
        let first = db.get_run("r").unwrap().unwrap().started_at;
        let same_instant = first
            .with_timezone(&chrono::FixedOffset::east_opt(14_400).unwrap())
            .to_rfc3339();
        assert_eq!(
            usage_summary(
                &db,
                &UsageFilter {
                    from: Some(same_instant.clone()),
                    ..Default::default()
                }
            )
            .unwrap()
            .totals
            .runs,
            56
        );
        assert_eq!(
            usage_summary(
                &db,
                &UsageFilter {
                    to: Some(same_instant),
                    ..Default::default()
                }
            )
            .unwrap()
            .totals
            .runs,
            0
        );
    }

    fn timed_row(db: &SqliteDb, run: &str, duration_ms: u64, usage: serde_json::Value) {
        db.record_node_result(crate::db::NewNodeResult {
            structured_json: &serde_json::json!({"agentUsage": usage}).to_string(),
            duration_ms,
            ..crate::db::NewNodeResult::simple(run, "a", "succeeded", Some(0), None)
        })
        .unwrap();
    }

    #[test]
    fn provider_days_keep_the_whole_day_for_splitting_a_plan_fee() {
        let db = analytics_db();
        let mut other = db.get_run_snapshot("r").unwrap().unwrap();
        other.id = "other".into();
        db.upsert_workflow(&other).unwrap();
        db.create_run_with_workflow("r2", &other, &HashMap::new())
            .unwrap();
        let claude = serde_json::json!({"adapter":"claude","model":"m","reported_cost_usd":3});
        timed_row(&db, "r", 3_000, claude.clone());
        timed_row(&db, "r2", 1_000, claude);
        timed_row(
            &db,
            "r2",
            5_000,
            serde_json::json!({"adapter":"codex","model":"c"}),
        );

        let all = usage_summary(&db, &UsageFilter::default()).unwrap();
        let claude_day = all
            .provider_days
            .iter()
            .find(|d| d.adapter == "claude")
            .unwrap();
        assert_eq!(claude_day.agent_attempts, 2);
        assert_eq!(claude_day.duration_ms, 4_000);
        assert_eq!(claude_day.all_duration_ms, 4_000);
        assert_eq!(claude_day.reported_usd, 6.0);
        assert_eq!(claude_day.reported_usd_attempts, 2);
        assert_eq!(all.provider_days.len(), 2);

        // A workflow filter keeps the day's totals, so its share is 3 of 4 s.
        let filtered = usage_summary(
            &db,
            &UsageFilter {
                workflow_ids: vec!["analytics".into()],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(filtered.totals.runs, 1);
        assert_eq!(filtered.runs_scanned, 1);
        assert_eq!(filtered.provider_days.len(), 1, "codex ran only in r2");
        let part = &filtered.provider_days[0];
        assert_eq!((part.duration_ms, part.all_duration_ms), (3_000, 4_000));
        assert_eq!(part.day, claude_day.day);

        // So does a single run, as the Runs view asks for it.
        let run = usage_summary(
            &db,
            &UsageFilter {
                run_ids: vec!["r2".into()],
                adapters: vec!["codex".into()],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(run.provider_days.len(), 1);
        assert_eq!(run.provider_days[0].adapter, "codex");
        assert_eq!(run.provider_days[0].duration_ms, 5_000);
        assert_eq!(run.provider_days[0].all_duration_ms, 5_000);
        assert_eq!(run.totals.agent_attempts, 1);
    }

    #[test]
    fn provider_days_leave_out_simulated_reused_and_dry_work() {
        let db = analytics_db();
        let claude = serde_json::json!({"adapter":"claude","model":"m"});
        timed_row(&db, "r", 2_000, claude.clone());
        for marker in [
            serde_json::json!({"agentUsage": claude.clone(), "simulated": true}),
            serde_json::json!({"agentUsage": claude.clone(), "reusedFrom": "old-run"}),
        ] {
            db.record_node_result(crate::db::NewNodeResult {
                structured_json: &marker.to_string(),
                duration_ms: 9_000,
                ..crate::db::NewNodeResult::simple("r", "a", "succeeded", Some(0), None)
            })
            .unwrap();
        }
        let workflow = db.get_run_snapshot("r").unwrap().unwrap();
        db.create_run_with_execution(
            "dry",
            &workflow,
            &HashMap::new(),
            &crate::run_controls::RunExecution {
                options: RunOptions {
                    dry_run: true,
                    ..RunOptions::default()
                },
                ..Default::default()
            },
        )
        .unwrap();
        timed_row(&db, "dry", 7_000, claude);
        let summary = usage_summary(&db, &UsageFilter::default()).unwrap();
        assert_eq!(summary.provider_days.len(), 1);
        let day = &summary.provider_days[0];
        assert_eq!((day.agent_attempts, day.duration_ms), (1, 2_000));
        assert_eq!((day.all_agent_attempts, day.all_duration_ms), (1, 2_000));
    }

    #[test]
    fn plans_validate_billing_amount_and_provider() {
        validate_plans(
            r#"{"claude":{"billing":"subscription","monthlyUsd":120,"name":"Max 5x"},"codex":{"billing":"api"}}"#,
        )
        .unwrap();
        validate_plans("{}").unwrap();
        for (value, message) in [
            ("[]", "JSON object"),
            (r#"{"gemini":{"billing":"api"}}"#, "Unknown plan provider"),
            (r#"{"claude":"max"}"#, "must be an object"),
            (r#"{"claude":{"billing":"monthly"}}"#, "billing must be"),
            (
                r#"{"claude":{"billing":"subscription"}}"#,
                "monthly USD amount",
            ),
            (
                r#"{"claude":{"billing":"subscription","monthlyUsd":100001}}"#,
                "monthly USD amount",
            ),
            (
                r#"{"codex":{"billing":"api","monthlyUsd":0}}"#,
                "no monthly amount",
            ),
            (
                r#"{"codex":{"billing":"api","seats":2}}"#,
                "only billing, monthlyUsd and name",
            ),
            (
                r#"{"codex":{"billing":"api","name":7}}"#,
                "at most 80 bytes",
            ),
        ] {
            let error = validate_plans(value).unwrap_err();
            assert!(error.contains(message), "{value}: {error}");
        }
        // Providers are checked in sorted order, like the TypeScript mirror.
        assert_eq!(
            validate_plans(
                r#"{"codex":{"billing":"subscription"},"claude":{"billing":"api","monthlyUsd":0}}"#
            )
            .unwrap_err(),
            "Pay-per-use billing has no monthly amount."
        );
        assert!(validate_usage_setting("usage.planShare", "").is_ok());
        assert!(validate_usage_setting("usage.planShare", "62.5").is_ok());
        assert!(validate_usage_setting("usage.planShare", "1e2").is_err());
    }

    #[test]
    fn analytics_provider_filter_excludes_unmatched_runs() {
        let db = analytics_db();
        analytics_row(
            &db,
            "succeeded",
            serde_json::json!({"adapter":"claude","model":"m"}),
        );
        let summary = usage_summary(
            &db,
            &UsageFilter {
                adapters: vec!["codex".into()],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(summary.totals.runs, 0);
        assert!(summary.days.is_empty());
        assert!(summary.by_workflow.is_empty());
    }

    #[test]
    fn analytics_profiles_use_run_snapshots_and_preserve_attempt_and_usd_coverage() {
        let db = SqliteDb::open_in_memory().unwrap();
        let mut workflow: crate::workflow::Workflow = serde_json::from_value(serde_json::json!({
            "schemaVersion": crate::workflow::CURRENT_SCHEMA_VERSION,
            "id":"profiles", "name":"Recorded workflow", "inputs":[], "edges":[],
            "nodes":[
                {"id":"a","type":"agent","position":{"x":0,"y":0},"config":{"agentProfileId":"p1"}},
                {"id":"b","type":"agent","position":{"x":0,"y":0},"config":{"agentProfileId":"deleted-profile"}},
                {"id":"legacy","type":"agent","position":{"x":0,"y":0},"config":{}}
            ]
        })).unwrap();
        db.upsert_workflow(&workflow).unwrap();
        db.create_run_with_workflow("r1", &workflow, &HashMap::new())
            .unwrap();
        let latest = db
            .create_run_with_workflow("r2", &workflow, &HashMap::new())
            .unwrap();
        for (run, node, status, duration, meta) in [
            (
                "r1",
                "a",
                "succeeded",
                100,
                serde_json::json!({"agentUsage":{"adapter":"claude","model":"shared","reported_cost_usd":1}}),
            ),
            (
                "r1",
                "a",
                "retrying",
                200,
                serde_json::json!({"agentUsage":{"adapter":"claude","model":"shared"}}),
            ),
            (
                "r1",
                "a",
                "succeeded",
                300,
                serde_json::json!({"agentUsage":{"adapter":"claude","model":"shared","reported_cost_usd":0}}),
            ),
            (
                "r1",
                "b",
                "succeeded",
                400,
                serde_json::json!({"agentUsage":{"adapter":"claude","model":"shared","reported_cost_usd":2}}),
            ),
            (
                "r1",
                "legacy",
                "failed",
                500,
                serde_json::json!({"agentUsage":{"adapter":"custom","model":"text"}}),
            ),
            (
                "r1",
                "a",
                "succeeded",
                900,
                serde_json::json!({"reusedFrom":"earlier"}),
            ),
            (
                "r1",
                "a",
                "succeeded",
                900,
                serde_json::json!({"simulated":true}),
            ),
            ("r1", "a", "skipped", 900, serde_json::json!({})),
            (
                "r1",
                "a",
                "failed",
                900,
                serde_json::json!({"notDispatched":true}),
            ),
            (
                "r2",
                "a",
                "succeeded",
                600,
                serde_json::json!({"agentUsage":{"adapter":"claude","model":"shared","reported_cost_usd":3}}),
            ),
        ] {
            db.record_node_result(crate::db::NewNodeResult {
                duration_ms: duration,
                structured_json: &meta.to_string(),
                ..crate::db::NewNodeResult::simple(run, node, status, Some(0), None)
            })
            .unwrap();
        }
        // Today's name and assignment must never rewrite the saved attribution.
        workflow.name = "Renamed workflow".into();
        workflow.nodes[0].config.agent_profile_id = Some("deleted-profile".into());
        db.upsert_workflow(&workflow).unwrap();
        let summary = usage_summary(&db, &UsageFilter::default()).unwrap();
        let json = serde_json::to_value(&summary).unwrap();
        let profiles = json["byProfile"].as_array().expect("profile aggregates");
        assert_eq!(profiles.len(), 3);
        let first = profiles.iter().find(|p| p["profileId"] == "p1").unwrap();
        assert_eq!(first["runs"], 2);
        assert_eq!(first["agentAttempts"], 4);
        assert_eq!(first["totalDurationMs"], 1200);
        assert_eq!(first["reportedUsd"], 4.0);
        assert_eq!(first["reportedUsdAttempts"], 3);
        assert_eq!(first["unknownUsdAttempts"], 1);
        assert_eq!(
            first["lastRunAt"],
            serde_json::to_value(latest.started_at).unwrap()
        );
        let deleted = profiles
            .iter()
            .find(|p| p["profileId"] == "deleted-profile")
            .unwrap();
        assert_eq!(deleted["runs"], 1);
        assert_eq!(deleted["agentAttempts"], 1);
        assert_eq!(deleted["totalDurationMs"], 400);
        let unknown = profiles.iter().find(|p| p["profileId"].is_null()).unwrap();
        assert_eq!(unknown["unknownUsdAttempts"], 1);
        assert_eq!(unknown["reportedUsdAttempts"], 0);
        assert_eq!(unknown["totalDurationMs"], 500);
        assert_eq!(summary.by_model.len(), 2);
        assert_eq!(summary.totals.agent_attempts, 6);
        assert_eq!(summary.totals.reported_usd, 6.0);

        for filter in [
            UsageFilter {
                adapters: vec!["codex".into()],
                ..Default::default()
            },
            UsageFilter {
                models: vec!["other".into()],
                ..Default::default()
            },
            UsageFilter {
                workflow_ids: vec!["other".into()],
                ..Default::default()
            },
            UsageFilter {
                to: Some(latest.started_at.to_rfc3339()),
                from: Some(latest.started_at.to_rfc3339()),
                ..Default::default()
            },
        ] {
            let filtered = usage_summary(&db, &filter).unwrap();
            assert_eq!(
                serde_json::to_value(filtered).unwrap()["byProfile"],
                serde_json::json!([])
            );
        }
        let filtered = usage_summary(
            &db,
            &UsageFilter {
                models: vec!["shared".into()],
                adapters: vec!["claude".into()],
                workflow_ids: vec!["profiles".into()],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(filtered).unwrap()["byProfile"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn analytics_profiles_do_not_guess_from_current_workflow_without_a_run_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.db");
        let db = SqliteDb::open(&path).unwrap();
        let workflow: crate::workflow::Workflow = serde_json::from_value(serde_json::json!({
            "schemaVersion": crate::workflow::CURRENT_SCHEMA_VERSION,
            "id":"legacy", "name":"Current", "inputs":[], "edges":[],
            "nodes":[{"id":"a","type":"agent","position":{"x":0,"y":0},"config":{"agentProfileId":"p1"}}]
        })).unwrap();
        db.upsert_workflow(&workflow).unwrap();
        db.create_run_with_workflow("r", &workflow, &HashMap::new())
            .unwrap();
        analytics_row(
            &db,
            "succeeded",
            serde_json::json!({"adapter":"claude","model":"m"}),
        );
        rusqlite::Connection::open(&path)
            .unwrap()
            .execute(
                "UPDATE runs SET workflow_definition = NULL WHERE id = 'r'",
                [],
            )
            .unwrap();
        let summary =
            serde_json::to_value(usage_summary(&db, &UsageFilter::default()).unwrap()).unwrap();
        assert_eq!(
            summary["byProfile"][0]["profileId"],
            serde_json::Value::Null
        );
        assert_eq!(summary["byProfile"][0]["agentAttempts"], 1);
    }

    #[test]
    fn policy_replaces_stale_handoff_policy_with_current_allowance() {
        let old = build_usage_policy(Some((Some(40), None)), Some(5), "old coverage");
        let current = build_usage_policy(Some((Some(3), None)), Some(1), "current coverage");
        let handoff = format!("Task\n{}", inject_usage_policy("Earlier task", &old));
        let prompt = inject_usage_policy(&handoff, &current);
        assert!(prompt.contains("about 3 tool calls"));
        assert!(!prompt.contains("about 40 tool calls"));
        assert!(prompt.contains("Earlier task"));
        assert_eq!(prompt.matches(USAGE_POLICY_MARKER).count(), 1);
    }

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
