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
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendPause {
    pub id: i64,
    pub reported_usd: f64,
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
