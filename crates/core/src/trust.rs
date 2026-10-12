//! Trust and risk categories for automation (Milestone 5).
//!
//! Scheduled or triggered workflows may run while the user is not looking.
//! Every workflow gets a risk set from its node mix; enabling automation over
//! anything above read-only requires an explicit per-schedule `trusted`
//! opt-in. Imported/created schedules start disabled regardless.

use crate::workflow::{NodeKind, Workflow};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RiskCategory {
    ReadOnly,
    LocalWrite,
    RepositoryMutation,
    RemoteWrite,
    ExternalTool,
}

impl RiskCategory {
    pub fn label(self) -> &'static str {
        match self {
            RiskCategory::ReadOnly => "Read repository",
            RiskCategory::LocalWrite => "Modify local files",
            RiskCategory::RepositoryMutation => "Create commits / branches",
            RiskCategory::RemoteWrite => "Push / create or comment on PRs",
            RiskCategory::ExternalTool => "Invoke external tools (AI CLI / MCP)",
        }
    }
}

/// Compute the risk set of a workflow from its nodes. Conservative: unknown
/// or write-capable ops escalate.
pub fn workflow_risks(workflow: &Workflow) -> BTreeSet<RiskCategory> {
    let mut risks = BTreeSet::from([RiskCategory::ReadOnly]);
    for node in &workflow.nodes {
        match node.kind {
            NodeKind::Start | NodeKind::End | NodeKind::Condition | NodeKind::Approval => {}
            NodeKind::Command => {
                risks.insert(RiskCategory::LocalWrite);
                if node.config.executable.as_deref() == Some("git")
                    && node.config.args.first().map(String::as_str) == Some("push")
                {
                    risks.insert(RiskCategory::RemoteWrite);
                }
            }
            NodeKind::Agent => {
                risks.insert(RiskCategory::LocalWrite);
                risks.insert(RiskCategory::ExternalTool);
            }
            NodeKind::Mcp | NodeKind::Ticket => {
                risks.insert(RiskCategory::ExternalTool);
            }
            NodeKind::Git => {
                use crate::workflow::GitOp as Op;
                match node.config.git_op.as_ref() {
                    Some(
                        Op::BranchCreate { .. }
                        | Op::Checkout { .. }
                        | Op::Stage { .. }
                        | Op::Commit { .. }
                        | Op::WorktreeAdd { .. }
                        | Op::WorktreeRemove { .. },
                    ) => {
                        risks.insert(RiskCategory::RepositoryMutation);
                    }
                    _ => {
                        risks.insert(RiskCategory::ReadOnly);
                    }
                }
            }
            NodeKind::GitHub => {
                use crate::workflow::GitHubOp as Op;
                match node.config.github_op.as_ref() {
                    Some(Op::CreatePr { .. } | Op::PostComment { .. }) => {
                        risks.insert(RiskCategory::RemoteWrite);
                    }
                    _ => {
                        risks.insert(RiskCategory::ReadOnly);
                    }
                }
            }
        }
    }
    risks
}

/// Whether a schedule may be enabled: read-only always; anything else needs
/// the explicit trusted opt-in.
pub fn may_enable_schedule(workflow: &Workflow, trusted: bool) -> Result<(), String> {
    let risks = workflow_risks(workflow);
    let write = risks.iter().any(|r| *r != RiskCategory::ReadOnly);
    if write && !trusted {
        let labels: Vec<&str> = risks
            .iter()
            .filter(|r| **r != RiskCategory::ReadOnly)
            .map(|r| r.label())
            .collect();
        return Err(format!(
            "Schedule needs explicit trust for: {}. Review the workflow, then opt in.",
            labels.join(", ")
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::{Node, NodeConfig, Position, CURRENT_SCHEMA_VERSION};

    fn workflow_with(nodes: Vec<Node>) -> Workflow {
        Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: "w".into(),
            name: "W".into(),
            inputs: Vec::new(),
            defaults: None,
            limits: None,
            nodes,
            edges: Vec::new(),
        }
    }

    fn node(id: &str, kind: NodeKind) -> Node {
        Node {
            id: id.into(),
            kind,
            position: Position::default(),
            config: NodeConfig::default(),
            label: None,
        }
    }

    #[test]
    fn read_only_workflow_needs_no_trust() {
        let wf = workflow_with(vec![node("a", NodeKind::Start), node("b", NodeKind::End)]);
        assert!(may_enable_schedule(&wf, false).is_ok());
    }

    #[test]
    fn command_workflow_requires_trust() {
        let wf = workflow_with(vec![node("a", NodeKind::Command)]);
        assert!(may_enable_schedule(&wf, false).is_err());
        assert!(may_enable_schedule(&wf, true).is_ok());
    }

    #[test]
    fn agent_escalates_to_external_tool() {
        let wf = workflow_with(vec![node("a", NodeKind::Agent)]);
        let risks = workflow_risks(&wf);
        assert!(risks.contains(&RiskCategory::ExternalTool));
        assert!(risks.contains(&RiskCategory::LocalWrite));
    }

    #[test]
    fn read_only_git_stays_read_only() {
        use crate::workflow::GitOp;
        let mut n = node("g", NodeKind::Git);
        n.config.git_op = Some(GitOp::Status);
        let wf = workflow_with(vec![n]);
        assert!(may_enable_schedule(&wf, false).is_ok());
    }

    #[test]
    fn commit_mutates_and_pr_creation_is_remote() {
        use crate::workflow::{GitHubOp, GitOp};
        let mut g = node("g", NodeKind::Git);
        g.config.git_op = Some(GitOp::Commit {
            message: "x".into(),
        });
        let mut h = node("h", NodeKind::GitHub);
        h.config.github_op = Some(GitHubOp::CreatePr {
            title: "t".into(),
            body: String::new(),
            base: "main".into(),
            head: "b".into(),
            draft: true,
        });
        let wf = workflow_with(vec![g, h]);
        let risks = workflow_risks(&wf);
        assert!(risks.contains(&RiskCategory::RepositoryMutation));
        assert!(risks.contains(&RiskCategory::RemoteWrite));
        assert!(may_enable_schedule(&wf, false).is_err());
    }
}
