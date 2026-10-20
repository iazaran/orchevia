//! Trust and risk categories for automation (Milestone 5).
//!
//! Scheduled or triggered workflows may run while the user is not looking.
//! Every workflow gets a risk set from its node mix; enabling automation over
//! anything above read-only requires an explicit per-schedule `trusted`
//! opt-in. Imported/created schedules start disabled regardless.

use crate::agents::AgentProfile;
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
    /// An Agent node's profile bypasses every CLI permission check (the Full
    /// access level, or extra arguments that do the same). High risk: the
    /// CLI may run any tool, unattended.
    FullAccessAgent,
}

impl RiskCategory {
    pub fn label(self) -> &'static str {
        match self {
            RiskCategory::ReadOnly => "Read repository",
            RiskCategory::LocalWrite => "Modify local files",
            RiskCategory::RepositoryMutation => "Create commits / branches",
            RiskCategory::RemoteWrite => "Push / create or comment on PRs",
            RiskCategory::ExternalTool => "Invoke external tools (AI CLI / MCP)",
            RiskCategory::FullAccessAgent => {
                "Run AI CLI with full access (permission checks bypassed)"
            }
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

/// [`workflow_risks`] plus what the configured Agent Profiles allow: a node
/// whose profile has full access adds [`RiskCategory::FullAccessAgent`]. A
/// node that names only a role counts every profile with that role.
pub fn workflow_risks_with_profiles(
    workflow: &Workflow,
    profiles: &[AgentProfile],
) -> BTreeSet<RiskCategory> {
    let mut risks = workflow_risks(workflow);
    let full_access = workflow
        .nodes
        .iter()
        .filter(|node| node.kind == NodeKind::Agent)
        .any(|node| {
            let id = node
                .config
                .agent_profile_id
                .as_deref()
                .filter(|id| !id.trim().is_empty());
            profiles
                .iter()
                .filter(|profile| match id {
                    Some(id) => profile.id == id,
                    None => {
                        node.config.agent_role.is_some() && profile.role == node.config.agent_role
                    }
                })
                .any(AgentProfile::has_full_access)
        });
    if full_access {
        risks.insert(RiskCategory::FullAccessAgent);
    }
    risks
}

/// Whether a schedule may be enabled: read-only always; anything else needs
/// the explicit trusted opt-in. Profiles decide whether an Agent node runs
/// with full access, which is listed as its own risk.
pub fn may_enable_schedule(
    workflow: &Workflow,
    profiles: &[AgentProfile],
    trusted: bool,
) -> Result<(), String> {
    let risks = workflow_risks_with_profiles(workflow, profiles);
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
        assert!(may_enable_schedule(&wf, &[], false).is_ok());
    }

    #[test]
    fn command_workflow_requires_trust() {
        let wf = workflow_with(vec![node("a", NodeKind::Command)]);
        assert!(may_enable_schedule(&wf, &[], false).is_err());
        assert!(may_enable_schedule(&wf, &[], true).is_ok());
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
        assert!(may_enable_schedule(&wf, &[], false).is_ok());
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
        assert!(may_enable_schedule(&wf, &[], false).is_err());
    }

    fn profile(id: &str, role: &str, level: crate::agents::PermissionLevel) -> AgentProfile {
        let mut profile: AgentProfile = serde_json::from_value(serde_json::json!({
            "id": id, "name": id, "adapter": "claude", "role": role,
            "extraArgs": [], "workingDirMode": "node", "defaultTimeoutSecs": 60
        }))
        .unwrap();
        profile.permission_level = level;
        profile
    }

    #[test]
    fn full_access_profiles_are_a_separate_high_risk() {
        use crate::agents::PermissionLevel;
        let mut agent = node("a", NodeKind::Agent);
        agent.config.agent_profile_id = Some("full".into());
        let wf = workflow_with(vec![agent]);
        let profiles = vec![
            profile("full", "implementation", PermissionLevel::FullAccess),
            profile("tools", "fastReview", PermissionLevel::AllowedTools),
        ];
        let risks = workflow_risks_with_profiles(&wf, &profiles);
        assert!(risks.contains(&RiskCategory::FullAccessAgent));
        let err = may_enable_schedule(&wf, &profiles, false).unwrap_err();
        assert!(
            err.contains("Run AI CLI with full access (permission checks bypassed)"),
            "{err}"
        );
        assert!(may_enable_schedule(&wf, &profiles, true).is_ok());

        // The same node on a profile that keeps the CLI's own settings or a
        // tool list is the ordinary agent risk.
        let mut narrow = wf.clone();
        narrow.nodes[0].config.agent_profile_id = Some("tools".into());
        let risks = workflow_risks_with_profiles(&narrow, &profiles);
        assert!(!risks.contains(&RiskCategory::FullAccessAgent));
        assert!(risks.contains(&RiskCategory::ExternalTool));
    }

    #[test]
    fn role_only_nodes_count_every_profile_with_that_role() {
        use crate::agents::PermissionLevel;
        let mut agent = node("a", NodeKind::Agent);
        agent.config.agent_role = Some("implementation".into());
        let wf = workflow_with(vec![agent]);
        let mut extra = profile("old", "implementation", PermissionLevel::CliSettings);
        extra.extra_args = vec!["--dangerously-skip-permissions".into()];
        assert!(workflow_risks_with_profiles(&wf, &[extra.clone()])
            .contains(&RiskCategory::FullAccessAgent));
        extra.role = Some("planning".into());
        assert!(
            !workflow_risks_with_profiles(&wf, &[extra]).contains(&RiskCategory::FullAccessAgent)
        );
    }
}
