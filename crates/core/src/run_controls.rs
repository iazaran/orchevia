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
        "running" | "succeeded" | "failed" | "retrying" | "cancelled"
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
        for (id, fixtures) in &self.fixtures {
            let node = workflow
                .nodes
                .iter()
                .find(|n| n.id == *id)
                .ok_or_else(|| format!("Unknown fixture node '{id}'."))?;
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

/// Data references supplement graph dependencies, including ids containing dots.
pub fn recovery_plan(
    run: &StoredRun,
    workflow: &Workflow,
    rows: &[StoredNodeResult],
) -> RecoveryPlan {
    let latest: HashMap<_, _> = rows
        .iter()
        .filter(|r| {
            matches!(
                r.status.as_str(),
                "succeeded" | "failed" | "cancelled" | "approved" | "rejected" | "skipped"
            )
        })
        .map(|r| (r.node_id.as_str(), r))
        .collect();
    let affected = invalidated_nodes(workflow, rows);
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
    let mut dependencies: Vec<(String, String)> = workflow
        .edges
        .iter()
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
