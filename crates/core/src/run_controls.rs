//! Additive run controls. Workflow routing remains owned by the engine.
use crate::{
    db::{StoredNodeResult, StoredRun},
    workflow::{NodeKind, Workflow},
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Copied or simulated output must not become a newly verified finding or cost.
pub fn is_new_execution(row: &StoredNodeResult) -> bool {
    serde_json::from_str::<serde_json::Value>(&row.structured_json)
        .is_ok_and(|metadata| metadata.get("reusedFrom").is_none() && metadata["simulated"] != true)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunOptions {
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub fixtures: HashMap<String, Vec<FixtureResult>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spend_limit_usd: Option<f64>,
    /// Per-run override for the workflow's saved Agent-attempt budget.
    /// `Some(n)` replaces it for this run; `None` inherits the saved value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_agent_attempts: Option<u32>,
    /// Per-run override for the advisory tool-call allowance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tool_calls: Option<u32>,
    /// Per-run override for the advisory nested-subagent allowance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_subagents: Option<u32>,
    /// When true, saved workflow limits are ignored for this run (explicit
    /// clearing). Overrides above still apply.
    #[serde(default)]
    pub ignore_saved_limits: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FixtureResult {
    pub status: String,
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub stderr: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub structured: serde_json::Value,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunExecution {
    #[serde(default)]
    pub options: RunOptions,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovered_from: Option<String>,
    #[serde(default)]
    pub recovery_choices: HashMap<String, RecoveryChoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spend_pause: Option<SpendPause>,
    /// Effective limits snapshotted when the run started. Later workflow
    /// edits never change an existing run.
    #[serde(default)]
    pub resolved_limits: ResolvedLimits,
    /// Agent attempts dispatched so far in this run (retries and loop
    /// visits count). Survives approvals, restarts and continuations;
    /// recovery starts a new budget and reused results are not re-charged.
    #[serde(default)]
    pub consumed_agent_attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_pause: Option<UsagePause>,
    /// Feedback cutoff, correction rounds and a feedback pause.
    #[serde(
        default,
        skip_serializing_if = "crate::feedback::FeedbackState::is_empty"
    )]
    pub feedback: crate::feedback::FeedbackState,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendPause {
    pub id: i64,
    pub reported_usd: f64,
}
/// Durable pause when the enforced Agent-attempt budget is exhausted.
/// Continuation explicitly extends the budget; cancellation ends the run.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsagePause {
    pub id: i64,
    pub consumed_attempts: u32,
    pub limit_attempts: u32,
}

/// Saved, optional workflow-wide usage controls. Every field is optional:
/// absent preserves ordinary execution. Only `max_agent_attempts` is
/// hard-enforced by the engine; the remaining allowances travel as advisory
/// guidance inside Agent prompts because the CLIs own their tool loops.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowLimits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_agent_attempts: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tool_calls: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_subagents: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spend_limit_usd: Option<f64>,
    /// Correction rounds feedback may start in one run (1–5, default 2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_correction_rounds: Option<u32>,
}

/// Effective per-run limits after merging saved workflow limits with the
/// start-run overrides. Snapshotted into `RunExecution` at start.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLimits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_agent_attempts: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tool_calls: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_subagents: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spend_limit_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_correction_rounds: Option<u32>,
}

impl ResolvedLimits {
    /// Correction rounds this run may make.
    pub fn correction_rounds(&self) -> u32 {
        self.max_correction_rounds
            .unwrap_or(crate::feedback::DEFAULT_CORRECTION_ROUNDS)
    }
}

/// Hard bounds for attempt/tool/subagent allowances (per run or per node).
pub const MAX_ATTEMPTS_LIMIT: u32 = 10_000;
pub const MAX_TOOL_CALL_LIMIT: u32 = 100_000;
pub const MAX_SUBAGENT_LIMIT: u32 = 1_000;

pub fn validate_limit_value(name: &str, value: u32, max: u32) -> Result<(), String> {
    if value == 0 {
        return Err(format!("{name} must be at least 1."));
    }
    if value > max {
        return Err(format!("{name} must not exceed {max}."));
    }
    Ok(())
}

pub fn validate_workflow_limits(limits: &WorkflowLimits) -> Result<(), String> {
    if let Some(n) = limits.max_agent_attempts {
        validate_limit_value("Agent attempt limit", n, MAX_ATTEMPTS_LIMIT)?;
    }
    if let Some(n) = limits.max_tool_calls {
        validate_limit_value("Tool-call allowance", n, MAX_TOOL_CALL_LIMIT)?;
    }
    if let Some(n) = limits.max_subagents {
        validate_limit_value("Subagent allowance", n, MAX_SUBAGENT_LIMIT)?;
    }
    if let Some(n) = limits.spend_limit_usd {
        if !n.is_finite() || n <= 0.0 {
            return Err("Spend limit must be a positive finite USD amount.".into());
        }
    }
    if let Some(n) = limits.max_correction_rounds {
        validate_limit_value(
            "Correction round limit",
            n,
            crate::feedback::MAX_CORRECTION_ROUNDS,
        )?;
    }
    Ok(())
}

/// Merge saved workflow limits with per-run overrides. `ignore_saved_limits`
/// clears every saved value; explicit overrides still apply on top.
pub fn resolve_limits(saved: Option<&WorkflowLimits>, options: &RunOptions) -> ResolvedLimits {
    let base = if options.ignore_saved_limits {
        None
    } else {
        saved
    };
    ResolvedLimits {
        max_agent_attempts: options
            .max_agent_attempts
            .or_else(|| base.and_then(|l| l.max_agent_attempts)),
        max_tool_calls: options
            .max_tool_calls
            .or_else(|| base.and_then(|l| l.max_tool_calls)),
        max_subagents: options
            .max_subagents
            .or_else(|| base.and_then(|l| l.max_subagents)),
        spend_limit_usd: options
            .spend_limit_usd
            .or_else(|| base.and_then(|l| l.spend_limit_usd)),
        // No per-run override; cleared like the others it falls back to 2.
        max_correction_rounds: base.and_then(|l| l.max_correction_rounds),
    }
}

/// Agent attempts actually dispatched in this run: new executions of Agent
/// nodes only. Reused (`reusedFrom`) and simulated (dry-run fixture) results
/// are never charged; retries and loop visits each count.
pub fn count_agent_attempts(workflow: &Workflow, rows: &[StoredNodeResult]) -> u32 {
    let ids: std::collections::HashSet<String> = workflow
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Agent)
        .map(|n| n.id.clone())
        .collect();
    count_dispatched_attempts(rows, &ids)
}

/// Same count over an explicit Agent-node id set (for task-level gates that
/// do not hold the whole workflow definition).
pub fn count_dispatched_attempts(
    rows: &[StoredNodeResult],
    agent_ids: &std::collections::HashSet<String>,
) -> u32 {
    rows.iter()
        .filter(|row| agent_ids.contains(&row.node_id) && is_dispatched_attempt(row))
        .count() as u32
}

/// Guard, skip and preflight rows never represent a dispatched CLI process.
pub(crate) fn is_dispatched_attempt(row: &StoredNodeResult) -> bool {
    is_dispatched_record(&row.status, &row.structured_json)
}

pub(crate) fn is_dispatched_record(status: &str, structured_json: &str) -> bool {
    let metadata = serde_json::from_str::<serde_json::Value>(structured_json).unwrap_or_default();
    matches!(
        status,
        "running" | "succeeded" | "failed" | "retrying" | "cancelled" | "checked"
    ) && metadata.get("reusedFrom").is_none()
        && metadata["simulated"] != true
        && metadata["notDispatched"] != true
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecoveryChoice {
    Reuse,
    Replay,
    Skip,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryNode {
    pub node_id: String,
    pub label: String,
    pub kind: NodeKind,
    pub affected: bool,
    pub previous_status: Option<String>,
    pub choices: Vec<RecoveryChoice>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPlan {
    pub source_run_id: String,
    pub fingerprint: String,
    pub nodes: Vec<RecoveryNode>,
}

pub fn effectful(kind: NodeKind) -> bool {
    matches!(
        kind,
        NodeKind::Command
            | NodeKind::Agent
            | NodeKind::Git
            | NodeKind::GitHub
            | NodeKind::Ticket
            | NodeKind::Mcp
    )
}

impl RunOptions {
    pub fn validate(&self, workflow: &Workflow) -> Result<(), String> {
        if self
            .spend_limit_usd
            .is_some_and(|n| !n.is_finite() || n <= 0.0)
        {
            return Err("Spend limit must be a positive finite USD amount.".into());
        }
        if let Some(n) = self.max_agent_attempts {
            validate_limit_value("Agent attempt limit", n, MAX_ATTEMPTS_LIMIT)?;
        }
        if let Some(n) = self.max_tool_calls {
            validate_limit_value("Tool-call allowance", n, MAX_TOOL_CALL_LIMIT)?;
        }
        if let Some(n) = self.max_subagents {
            validate_limit_value("Subagent allowance", n, MAX_SUBAGENT_LIMIT)?;
        }
        if !self.dry_run && !self.fixtures.is_empty() {
            return Err("Fixtures require Dry run.".into());
        }
        if self.dry_run && self.spend_limit_usd.is_some() {
            return Err("Dry-run fixtures do not measure actual spend.".into());
        }
        for (key, fixtures) in &self.fixtures {
            // `feedback:<AI step>` feeds that step's feedback checks.
            let check = key.strip_prefix("feedback:");
            let id = check.unwrap_or(key);
            let node = workflow
                .nodes
                .iter()
                .find(|n| n.id == *id)
                .ok_or_else(|| format!("Unknown fixture node '{key}'."))?;
            if check.is_some() && node.kind != NodeKind::Agent {
                return Err(format!(
                    "Feedback-check fixtures need an AI step; '{id}' is not one."
                ));
            }
            if !effectful(node.kind) && node.kind != NodeKind::Approval {
                return Err(format!("Node '{id}' does not accept fixtures."));
            }
            if fixtures.len() > 1000 {
                return Err("At most 1000 fixture attempts per node.".into());
            }
            for fixture in fixtures {
                let allowed = if node.kind == NodeKind::Approval {
                    matches!(fixture.status.as_str(), "approved" | "rejected" | "paused")
                } else {
                    matches!(fixture.status.as_str(), "succeeded" | "failed")
                };
                if !allowed {
                    return Err(format!("Invalid fixture status for '{id}'."));
                }
                if fixture.stdout.len()
                    + fixture.stderr.len()
                    + fixture.structured.to_string().len()
                    > 800_000
                {
                    return Err("Fixture output exceeds 800000 bytes.".into());
                }
                if !fixture.structured.is_null() && !fixture.structured.is_object() {
                    return Err("Fixture structured output must be an object.".into());
                }
                if fixture.structured.as_object().is_some_and(|o| {
                    [
                        "agentSession",
                        "agentUsage",
                        "agentActivity",
                        "simulated",
                        "reusedFrom",
                        "command",
                        "agentDigest",
                        "correction",
                        "feedbackCheck",
                    ]
                    .iter()
                    .any(|k| o.contains_key(*k))
                }) {
                    return Err("Fixture contains reserved execution metadata.".into());
                }
            }
        }
        Ok(())
    }
}

/// The results that still stand: a feedback correction supersedes a step's
/// results before its round, so a step the round has not run again since
/// has none.
pub fn current_results(rows: &[StoredNodeResult]) -> Vec<StoredNodeResult> {
    let superseded = superseded_by_corrections(rows);
    rows.iter()
        .filter(|r| superseded.get(&r.node_id).is_none_or(|after| r.id > *after))
        .cloned()
        .collect()
}

/// Data references supplement graph dependencies, including ids containing dots.
pub fn recovery_plan(
    run: &StoredRun,
    workflow: &Workflow,
    rows: &[StoredNodeResult],
) -> RecoveryPlan {
    let current = current_results(rows);
    let latest: HashMap<_, _> = current
        .iter()
        .filter(|r| {
            matches!(
                r.status.as_str(),
                "succeeded" | "failed" | "cancelled" | "approved" | "rejected" | "skipped"
            )
        })
        .map(|r| (r.node_id.as_str(), r))
        .collect();
    let affected = invalidated_nodes(workflow, &current);
    let nodes = workflow
        .nodes
        .iter()
        .filter(|n| effectful(n.kind))
        .map(|node| {
            let previous = latest.get(node.id.as_str());
            let mut choices = vec![RecoveryChoice::Replay, RecoveryChoice::Skip];
            if !affected.contains(&node.id) && previous.is_some_and(|r| r.status == "succeeded") {
                choices.insert(0, RecoveryChoice::Reuse);
            }
            RecoveryNode {
                node_id: node.id.clone(),
                label: node.label.clone().unwrap_or_else(|| node.id.clone()),
                kind: node.kind,
                affected: affected.contains(&node.id),
                previous_status: previous.map(|r| r.status.clone()),
                choices,
            }
        })
        .collect();
    RecoveryPlan {
        source_run_id: run.id.clone(),
        fingerprint: format!(
            "{}:{}:{}",
            run.id,
            rows.len(),
            rows.last().map(|r| r.id).unwrap_or(0)
        ),
        nodes,
    }
}

/// For each step a feedback correction round reran (or refreshed and ran
/// again after it), the id of the last such round's marker row: results
/// before it were superseded.
pub fn superseded_by_corrections(rows: &[StoredNodeResult]) -> HashMap<String, i64> {
    let mut superseded = HashMap::new();
    for row in rows {
        let Some((reruns, refreshed)) = round_steps(row) else {
            continue;
        };
        for id in reruns {
            superseded.insert(id, row.id);
        }
        for id in refreshed {
            if rows.iter().any(|later| {
                later.id > row.id
                    && later.node_id == id
                    && matches!(
                        later.status.as_str(),
                        "succeeded" | "failed" | "approved" | "rejected"
                    )
            }) {
                superseded.insert(id, row.id);
            }
        }
    }
    superseded
}

/// Every step a correction round named (rerun or refreshed). In a recovered
/// run their reuse and skip choices and approval seeds stop applying, since
/// they run again on the corrected work.
pub fn corrected_steps(rows: &[StoredNodeResult]) -> HashSet<String> {
    rows.iter()
        .filter_map(round_steps)
        .flat_map(|(reruns, refreshed)| reruns.into_iter().chain(refreshed))
        .collect()
}

/// A correction round's marker: the steps it reruns and those it refreshes.
fn round_steps(row: &StoredNodeResult) -> Option<(Vec<String>, Vec<String>)> {
    if row.node_id != crate::feedback::ROUND_NODE || row.status != "correcting" {
        return None;
    }
    let value = serde_json::from_str::<serde_json::Value>(&row.structured_json).ok()?;
    let list = |keys: &[&str]| -> Vec<String> {
        keys.iter()
            .flat_map(|key| {
                value["feedbackRound"][*key]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
            })
            .filter_map(|id| id.as_str().map(str::to_string))
            .collect()
    };
    Some((list(&["roots", "affected"]), list(&["refreshed"])))
}

/// Every "B uses A's work" pair: graph edges, `contextRefs`, `inputRefs`,
/// `{{node.A…}}` references and ticket variables. Shared by recovery and
/// feedback corrections.
pub fn dependency_pairs(workflow: &Workflow) -> Vec<(String, String)> {
    dependency_pairs_except(workflow, &HashSet::new())
}

/// [`dependency_pairs`] without the edges in `skip` (loop-back edges, when a
/// correction must not re-arm a loop that may not go round again).
pub fn dependency_pairs_except(
    workflow: &Workflow,
    skip: &HashSet<String>,
) -> Vec<(String, String)> {
    let mut dependencies: Vec<(String, String)> = workflow
        .edges
        .iter()
        .filter(|e| !skip.contains(&e.id))
        .map(|e| (e.source.clone(), e.target.clone()))
        .collect();
    for node in &workflow.nodes {
        if let Ok(config) = serde_json::to_value(&node.config) {
            let text = config.to_string();
            for upstream in &workflow.nodes {
                if node.id != upstream.id
                    && (node.config.context_refs.contains(&upstream.id)
                        || node.config.input_refs.contains(&upstream.id)
                        || (upstream.kind == NodeKind::Ticket && text.contains("ticket."))
                        || text.contains(&format!("node.{}.", upstream.id))
                        || text.contains(&format!("node.{}\"", upstream.id))
                        || text.contains(&format!("node.{}}}}}", upstream.id)))
                {
                    dependencies.push((upstream.id.clone(), node.id.clone()));
                }
            }
        }
    }
    dependencies
}

/// Every step that uses the work of `seeds`, directly or through others
/// (the seeds themselves only when a loop leads back to them).
pub fn downstream_closure(workflow: &Workflow, seeds: &HashSet<String>) -> HashSet<String> {
    closure_over(&dependency_pairs(workflow), seeds)
}

/// Every step reached from `seeds` through `dependencies`.
pub fn closure_over(dependencies: &[(String, String)], seeds: &HashSet<String>) -> HashSet<String> {
    let mut reached: HashSet<String> = HashSet::new();
    let mut frontier: Vec<String> = seeds.iter().cloned().collect();
    while let Some(id) = frontier.pop() {
        for (source, target) in dependencies.iter() {
            if *source == id && reached.insert(target.clone()) {
                frontier.push(target.clone());
            }
        }
    }
    reached
}

pub fn invalidated_nodes(workflow: &Workflow, rows: &[StoredNodeResult]) -> HashSet<String> {
    let mut latest: HashMap<&str, &StoredNodeResult> = HashMap::new();
    for row in rows {
        if matches!(
            row.status.as_str(),
            "succeeded" | "failed" | "cancelled" | "approved" | "rejected" | "skipped"
        ) {
            latest.insert(&row.node_id, row);
        }
    }
    let mut affected: HashSet<String> = latest
        .iter()
        .filter(|(_, r)| matches!(r.status.as_str(), "failed" | "cancelled" | "rejected"))
        .map(|(id, _)| (*id).to_string())
        .collect();
    let dependencies = dependency_pairs(workflow);
    loop {
        let mut changed = false;
        for (source, target) in &dependencies {
            if affected.contains(source) {
                changed |= affected.insert(target.clone());
            }
        }
        if !changed {
            break;
        }
    }
    affected
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportedSpend {
    pub reported_usd: f64,
    pub reported_attempts: usize,
    pub unknown_attempts: usize,
}
pub fn reported_spend(
    workflow: &Workflow,
    rows: &[StoredNodeResult],
    dry_run: bool,
) -> ReportedSpend {
    let mut result = ReportedSpend::default();
    if dry_run {
        return result;
    }
    for row in rows {
        if !workflow
            .nodes
            .iter()
            .any(|n| n.id == row.node_id && n.kind == NodeKind::Agent)
            || row.status == "running"
            || row.status == "paused"
            || row.status == "skipped"
        {
            continue;
        }
        let metadata: serde_json::Value =
            serde_json::from_str(&row.structured_json).unwrap_or_default();
        if metadata.get("reusedFrom").is_some() || metadata["simulated"] == true {
            continue;
        }
        if let Some(cost) = metadata["agentUsage"]["reported_cost_usd"]
            .as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
        {
            result.reported_usd += cost;
            result.reported_attempts += 1;
        } else {
            result.unknown_attempts += 1;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: i64, node: &str, status: &str, metadata: serde_json::Value) -> StoredNodeResult {
        StoredNodeResult {
            id,
            run_id: "r".into(),
            node_id: node.into(),
            status: status.into(),
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: None,
            started_at: chrono::Utc::now(),
            finished_at: None,
            attempt: 1,
            duration_ms: 0,
            structured_json: metadata.to_string(),
        }
    }

    #[test]
    fn recovery_never_offers_a_result_a_correction_superseded() {
        // start → a → b → end and start → d → end; a round corrected a and
        // d in parallel; a ran again, d failed before b ran again.
        let wf = Workflow::from_json(
            &serde_json::json!({"schemaVersion":6,"id":"wf","name":"W",
            "nodes":[{"id":"start","type":"start"},
              {"id":"a","type":"agent","config":{"agentProfileId":"p","prompt":"A"}},
              {"id":"b","type":"agent","config":{"agentProfileId":"p","prompt":"B"}},
              {"id":"d","type":"agent","config":{"agentProfileId":"p","prompt":"D"}},
              {"id":"end","type":"end"}],
            "edges":[{"id":"e1","source":"start","target":"a"},{"id":"e2","source":"a","target":"b"},
              {"id":"e3","source":"b","target":"end"},{"id":"e4","source":"start","target":"d"},
              {"id":"e5","source":"d","target":"end"}]})
            .to_string(),
        )
        .expect("workflow");
        let none = serde_json::json!({});
        let rows = vec![
            row(1, "start", "succeeded", none.clone()),
            row(2, "a", "succeeded", none.clone()),
            row(3, "d", "succeeded", none.clone()),
            row(4, "b", "succeeded", none.clone()),
            row(
                5,
                crate::feedback::ROUND_NODE,
                "correcting",
                serde_json::json!({"feedbackRound":{"round":1,"roots":["a","d"],"affected":["b","end"],"refreshed":[]}}),
            ),
            row(6, "a", "succeeded", none.clone()),
            row(7, "d", "failed", none),
        ];
        let run = StoredRun {
            execution: RunExecution::default(),
            id: "r".into(),
            workflow_id: "wf".into(),
            status: crate::db::RunStatus::Failed,
            started_at: chrono::Utc::now(),
            finished_at: None,
            inputs: HashMap::new(),
        };
        let plan = recovery_plan(&run, &wf, &rows);
        let node = |id: &str| {
            plan.nodes
                .iter()
                .find(|n| n.node_id == id)
                .expect("node")
                .clone()
        };
        assert_eq!(node("a").choices[0], RecoveryChoice::Reuse);
        let b = node("b");
        assert!(!b.choices.contains(&RecoveryChoice::Reuse), "{b:?}");
        assert_eq!(b.previous_status, None);
    }
}
