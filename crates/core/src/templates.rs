//! Workflow templates (Milestone 6).
//!
//! Built-in templates ship as versioned constructors (role refs, never
//! profile ids or secrets). Users clone them, save their own, and
//! import/export portable JSON. Import validates shape + bounds and scans
//! for credential-like content; local-only material (profile ids bound to
//! this machine) is stripped to role refs where unambiguous, else rejected
//! with guidance.

use crate::workflow::{
    resolve_agent_roles, validate_workflow, ConditionConfig, Edge, Node, NodeConfig, NodeKind,
    Position, Workflow, CURRENT_SCHEMA_VERSION,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const TEMPLATE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    #[serde(default = "template_schema_version")]
    pub version: u32,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Workflow-type scope (`feature`, `bugfix`, `review`, `refactor`, …).
    #[serde(default = "general_scope")]
    pub category: String,
    pub workflow: Workflow,
}

fn template_schema_version() -> u32 {
    TEMPLATE_SCHEMA_VERSION
}

fn general_scope() -> String {
    "general".to_string()
}

impl Template {
    pub fn validate(&self) -> Vec<String> {
        let mut errors = Vec::new();
        if self.id.trim().is_empty() {
            errors.push("Template id must not be empty.".to_string());
        }
        if self.name.trim().is_empty() {
            errors.push("Template name must not be empty.".to_string());
        }
        if self.version > TEMPLATE_SCHEMA_VERSION {
            errors.push(format!(
                "Template schema v{} is newer than supported v{}.",
                self.version, TEMPLATE_SCHEMA_VERSION
            ));
        }
        // Credential scan: templates must never carry secrets.
        let flat = serde_json::to_string(&self.workflow)
            .unwrap_or_default()
            .to_ascii_lowercase();
        for marker in ["api-key", "apikey", "bearer", "password"] {
            if flat.contains(marker) {
                errors.push(format!(
                    "Template contains credential-like text ('{marker}'); refused."
                ));
            }
        }
        errors
    }
}

/// Instantiate: resolve roles, stamp ids, validate. Unresolved roles and
/// structural errors return messages (never a half-built workflow).
///
/// Machine-local setup (repository directories, MCP server ids) is reported
/// via `setup_needed` instead of blocking: the user fills those in after
/// preview. Everything else structural blocks.
pub fn instantiate(
    template: &Template,
    role_map: &HashMap<String, String>,
    new_ids: bool,
) -> Result<Instantiated, String> {
    let errors = template.validate();
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    let (mut workflow, unmapped) = resolve_agent_roles(&template.workflow, role_map);
    if !unmapped.is_empty() {
        return Err(format!(
            "Template needs role mappings for: {}.",
            unmapped.join(", ")
        ));
    }
    if new_ids {
        remap_ids(&mut workflow);
    }
    let issues = validate_workflow(&workflow);
    let mut blocking: Vec<String> = Vec::new();
    let mut setup_needed: Vec<String> = Vec::new();
    for issue in issues
        .iter()
        .filter(|i| i.severity == crate::workflow::ValidationSeverity::Error)
    {
        // Machine-local configuration, not structural breakage.
        if matches!(
            issue.code.as_str(),
            "git-dir-required" | "ticket-server-required" | "mcp-server-required"
        ) {
            setup_needed.push(issue.message.clone());
        } else {
            blocking.push(issue.message.clone());
        }
    }
    if !blocking.is_empty() {
        return Err(blocking.join("; "));
    }
    Ok(Instantiated {
        workflow,
        setup_needed,
    })
}

/// An instantiated template ready for preview/edit.
#[derive(Debug, Clone)]
pub struct Instantiated {
    pub workflow: Workflow,
    /// Non-blocking setup steps (repo dirs, server picks).
    pub setup_needed: Vec<String>,
}

fn remap_ids(workflow: &mut Workflow) {
    let mut id_map: HashMap<String, String> = HashMap::new();
    for node in workflow.nodes.iter_mut() {
        let fresh = format!("{}-inst", node.id);
        id_map.insert(node.id.clone(), fresh.clone());
        node.id = fresh;
    }
    workflow.id = format!("{}-inst", workflow.id);
    for edge in workflow.edges.iter_mut() {
        if let Some(fresh) = id_map.get(&edge.source) {
            edge.source = fresh.clone();
        }
        if let Some(fresh) = id_map.get(&edge.target) {
            edge.target = fresh.clone();
        }
        edge.id = format!("{}-inst", edge.id);
    }
}

/// Export portable JSON (no secrets by construction; validated on import).
pub fn export_template(template: &Template) -> Result<String, String> {
    let errors = template.validate();
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    serde_json::to_string_pretty(template).map_err(|e| e.to_string())
}

pub fn import_template(json: &str) -> Result<Template, String> {
    let template: Template =
        serde_json::from_str(json).map_err(|e| format!("Invalid template JSON: {e}"))?;
    let errors = template.validate();
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    if template.workflow.nodes.is_empty() {
        return Err("Template workflow has no nodes.".to_string());
    }
    Ok(template)
}

// -- Built-ins ---------------------------------------------------------------

fn node(id: &str, kind: NodeKind, y: f64, label: &str, config: NodeConfig) -> Node {
    Node {
        id: id.to_string(),
        kind,
        position: Position { x: 80.0, y },
        config,
        label: Some(label.to_string()),
    }
}

fn edge(id: &str, source: &str, target: &str, label: Option<&str>) -> Edge {
    Edge {
        id: id.to_string(),
        source: source.to_string(),
        target: target.to_string(),
        label: label.map(str::to_string),
    }
}

fn agent_role(id: &str, y: f64, label: &str, role: &str, prompt: &str) -> Node {
    node(
        id,
        NodeKind::Agent,
        y,
        label,
        NodeConfig {
            agent_role: Some(role.to_string()),
            prompt: Some(prompt.to_string()),
            ..NodeConfig::default()
        },
    )
}

fn template(
    id: &str,
    name: &str,
    category: &str,
    description: &str,
    nodes: Vec<Node>,
    edges: Vec<Edge>,
) -> Template {
    Template {
        id: id.to_string(),
        version: TEMPLATE_SCHEMA_VERSION,
        name: name.to_string(),
        description: description.to_string(),
        category: category.to_string(),
        workflow: Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: format!("tpl-{id}"),
            name: name.to_string(),
            inputs: Vec::new(),
            defaults: None,
            nodes,
            edges,
        },
    }
}

/// The nine built-in templates.
pub fn builtin_templates() -> Vec<Template> {
    vec![
        implement_ticket(),
        review_pull_request(),
        investigate_bug(),
        refactor(),
        dependency_upgrade(),
        multi_agent_review(),
        create_draft_pr(),
        watch_feedback(),
        ticket_to_pr(),
    ]
}

fn implement_ticket() -> Template {
    template(
        "implement-ticket",
        "Implement Ticket",
        "feature",
        "Plan → approve → implement → test → review → draft PR.",
        vec![
            node(
                "start",
                NodeKind::Start,
                0.0,
                "Start",
                NodeConfig::default(),
            ),
            agent_role(
                "plan",
                120.0,
                "Plan",
                "planning",
                "Plan {{workflow.name}}: {{ticket.key}} {{ticket.title}}. List files and risks.",
            ),
            node(
                "gate",
                NodeKind::Approval,
                240.0,
                "Approve plan",
                NodeConfig {
                    message: Some("Review the plan.".into()),
                    ..NodeConfig::default()
                },
            ),
            agent_role(
                "impl",
                360.0,
                "Implement",
                "implementation",
                "Implement the approved plan with tests.",
            ),
            node(
                "tests",
                NodeKind::Command,
                480.0,
                "Tests",
                NodeConfig {
                    executable: Some("cargo".into()),
                    args: vec!["test".into()],
                    ..NodeConfig::default()
                },
            ),
            agent_role(
                "review",
                600.0,
                "Review",
                "deepReview",
                "Review for P0/P1; tag severities.",
            ),
            node("end", NodeKind::End, 720.0, "End", NodeConfig::default()),
        ],
        vec![
            edge("e0", "start", "plan", None),
            edge("e1", "plan", "gate", None),
            edge("e2", "gate", "impl", None),
            edge("e3", "impl", "tests", None),
            edge("e4", "tests", "review", None),
            edge("e5", "review", "end", None),
        ],
    )
}

fn review_pull_request() -> Template {
    template(
        "review-pr",
        "Review Pull Request",
        "review",
        "Load PR → parallel Claude/Codex reviews → actionable? → note or checked.",
        vec![
            node(
                "start",
                NodeKind::Start,
                0.0,
                "Start",
                NodeConfig::default(),
            ),
            node(
                "files",
                NodeKind::GitHub,
                120.0,
                "Changed files",
                NodeConfig {
                    github_op: Some(crate::workflow::GitHubOp::PrFiles { number: 0 }),
                    ..NodeConfig::default()
                },
            ),
            agent_role(
                "revA",
                240.0,
                "Claude Review",
                "fastReview",
                "Fast review with ```finding blocks.",
            ),
            agent_role(
                "revB",
                240.0,
                "Codex Review",
                "deepReview",
                "Deep review with ```finding blocks.",
            ),
            node(
                "cond",
                NodeKind::Condition,
                360.0,
                "Actionable?",
                NodeConfig {
                    condition: Some(ConditionConfig {
                        logic: crate::workflow::ConditionLogic::Or,
                        clauses: vec![
                            crate::workflow::ConditionClause {
                                left: "node.revA.severity".into(),
                                op: crate::workflow::ConditionOp::Contains,
                                right: "P0".into(),
                            },
                            crate::workflow::ConditionClause {
                                left: "node.revB.severity".into(),
                                op: crate::workflow::ConditionOp::Contains,
                                right: "P1".into(),
                            },
                        ],
                    }),
                    ..NodeConfig::default()
                },
            ),
            node(
                "note",
                NodeKind::GitHub,
                480.0,
                "Post note",
                NodeConfig {
                    github_op: Some(crate::workflow::GitHubOp::PostComment {
                        number: 0,
                        body:
                            "Automated review found P0/P1 items.\n\n<sub>posted by Orchevia</sub>"
                                .into(),
                    }),
                    ..NodeConfig::default()
                },
            ),
            node(
                "checked",
                NodeKind::Command,
                480.0,
                "Mark checked",
                NodeConfig {
                    executable: Some("echo".into()),
                    args: vec!["no actionable findings".into()],
                    ..NodeConfig::default()
                },
            ),
            node("end", NodeKind::End, 600.0, "End", NodeConfig::default()),
        ],
        vec![
            edge("e0", "start", "files", None),
            edge("e1", "files", "revA", None),
            edge("e2", "files", "revB", None),
            edge("e3", "revA", "cond", None),
            edge("e4", "revB", "cond", None),
            edge("e5", "cond", "note", Some("true")),
            edge("e6", "cond", "checked", Some("false")),
            edge("e7", "note", "end", None),
            edge("e8", "checked", "end", None),
        ],
    )
}

fn investigate_bug() -> Template {
    template(
        "investigate-bug",
        "Investigate Bug",
        "bugfix",
        "Reproduce → hypothesize → verify with tests.",
        vec![
            node(
                "start",
                NodeKind::Start,
                0.0,
                "Start",
                NodeConfig::default(),
            ),
            agent_role(
                "repro",
                120.0,
                "Reproduce",
                "implementation",
                "Reproduce the bug with a failing test first.",
            ),
            node(
                "gate",
                NodeKind::Approval,
                240.0,
                "Confirm repro",
                NodeConfig::default(),
            ),
            agent_role(
                "fix",
                360.0,
                "Fix + verify",
                "implementation",
                "Fix the root cause; keep the regression test green.",
            ),
            node("end", NodeKind::End, 480.0, "End", NodeConfig::default()),
        ],
        vec![
            edge("e0", "start", "repro", None),
            edge("e1", "repro", "gate", None),
            edge("e2", "gate", "fix", None),
            edge("e3", "fix", "end", None),
        ],
    )
}

fn refactor() -> Template {
    template(
        "refactor",
        "Refactor",
        "refactor",
        "Scoped refactor with test gates before and after.",
        vec![
            node(
                "start",
                NodeKind::Start,
                0.0,
                "Start",
                NodeConfig::default(),
            ),
            node(
                "base",
                NodeKind::Command,
                120.0,
                "Baseline tests",
                NodeConfig {
                    executable: Some("cargo".into()),
                    args: vec!["test".into()],
                    ..NodeConfig::default()
                },
            ),
            agent_role(
                "ref",
                240.0,
                "Refactor",
                "implementation",
                "Refactor {{workflow.name}} without behavior change.",
            ),
            node(
                "verify",
                NodeKind::Command,
                360.0,
                "Verify tests",
                NodeConfig {
                    executable: Some("cargo".into()),
                    args: vec!["test".into()],
                    ..NodeConfig::default()
                },
            ),
            node("end", NodeKind::End, 480.0, "End", NodeConfig::default()),
        ],
        vec![
            edge("e0", "start", "base", None),
            edge("e1", "base", "ref", None),
            edge("e2", "ref", "verify", None),
            edge("e3", "verify", "end", None),
        ],
    )
}

fn dependency_upgrade() -> Template {
    let mut template = template(
        "dependency-upgrade",
        "Dependency Upgrade",
        "maintenance",
        "Upgrade one dependency, run tests, review the diff.",
        vec![
            node(
                "start",
                NodeKind::Start,
                0.0,
                "Start",
                NodeConfig::default(),
            ),
            agent_role(
                "up",
                120.0,
                "Upgrade",
                "implementation",
                "Upgrade {{input.dependency}}; keep the lockfile consistent.",
            ),
            node(
                "tests",
                NodeKind::Command,
                240.0,
                "Tests",
                NodeConfig {
                    executable: Some("cargo".into()),
                    args: vec!["test".into()],
                    ..NodeConfig::default()
                },
            ),
            agent_role(
                "rev",
                360.0,
                "Review diff",
                "fastReview",
                "Review the upgrade diff for breaking changes.",
            ),
            node("end", NodeKind::End, 480.0, "End", NodeConfig::default()),
        ],
        vec![
            edge("e0", "start", "up", None),
            edge("e1", "up", "tests", None),
            edge("e2", "tests", "rev", None),
            edge("e3", "rev", "end", None),
        ],
    );
    template
        .workflow
        .inputs
        .push(crate::workflow::WorkflowInput {
            name: "dependency".into(),
            label: Some("Dependency".into()),
            default: None,
            required: true,
        });
    template
}

fn multi_agent_review() -> Template {
    template(
        "multi-agent-review",
        "Run Multi-Agent Review",
        "review",
        "Parallel Claude + Codex reviews joined, then a severity gate.",
        vec![
            node(
                "start",
                NodeKind::Start,
                0.0,
                "Start",
                NodeConfig::default(),
            ),
            agent_role(
                "revA",
                120.0,
                "Claude Review",
                "fastReview",
                "Fast review with ```finding blocks.",
            ),
            agent_role(
                "revB",
                120.0,
                "Codex Review",
                "deepReview",
                "Deep review with ```finding blocks.",
            ),
            node(
                "join",
                NodeKind::Command,
                240.0,
                "Combine",
                NodeConfig {
                    executable: Some("echo".into()),
                    args: vec!["reviews complete".into()],
                    ..NodeConfig::default()
                },
            ),
            node(
                "cond",
                NodeKind::Condition,
                360.0,
                "Actionable?",
                NodeConfig {
                    condition: Some(ConditionConfig {
                        logic: crate::workflow::ConditionLogic::Or,
                        clauses: vec![
                            crate::workflow::ConditionClause {
                                left: "node.revA.severity".into(),
                                op: crate::workflow::ConditionOp::Contains,
                                right: "P0".into(),
                            },
                            crate::workflow::ConditionClause {
                                left: "node.revB.severity".into(),
                                op: crate::workflow::ConditionOp::Contains,
                                right: "P1".into(),
                            },
                        ],
                    }),
                    ..NodeConfig::default()
                },
            ),
            node(
                "yes",
                NodeKind::Approval,
                480.0,
                "Triage P0/P1",
                NodeConfig::default(),
            ),
            node(
                "no",
                NodeKind::Command,
                480.0,
                "Done",
                NodeConfig {
                    executable: Some("echo".into()),
                    args: vec!["clean".into()],
                    ..NodeConfig::default()
                },
            ),
            node("end", NodeKind::End, 600.0, "End", NodeConfig::default()),
        ],
        vec![
            edge("e0", "start", "revA", None),
            edge("e1", "start", "revB", None),
            edge("e2", "revA", "join", None),
            edge("e3", "revB", "join", None),
            edge("e4", "join", "cond", None),
            edge("e5", "cond", "yes", Some("true")),
            edge("e6", "cond", "no", Some("false")),
            edge("e7", "yes", "end", None),
            edge("e8", "no", "end", None),
        ],
    )
}

fn create_draft_pr() -> Template {
    let mut template = template(
        "create-draft-pr",
        "Create Draft PR",
        "feature",
        "Final test + review, then an explicit draft PR.",
        vec![
            node(
                "start",
                NodeKind::Start,
                0.0,
                "Start",
                NodeConfig::default(),
            ),
            node(
                "tests",
                NodeKind::Command,
                120.0,
                "Tests",
                NodeConfig {
                    executable: Some("cargo".into()),
                    args: vec!["test".into()],
                    ..NodeConfig::default()
                },
            ),
            agent_role(
                "rev",
                240.0,
                "Final review",
                "fastReview",
                "Final pass with ```finding blocks.",
            ),
            node(
                "pr",
                NodeKind::GitHub,
                360.0,
                "Draft PR",
                NodeConfig {
                    github_op: Some(crate::workflow::GitHubOp::CreatePr {
                        title: "{{workflow.name}}".into(),
                        body: "Automated draft.".into(),
                        base: "main".into(),
                        head: "{{input.branch}}".into(),
                        draft: true,
                    }),
                    ..NodeConfig::default()
                },
            ),
            node("end", NodeKind::End, 480.0, "End", NodeConfig::default()),
        ],
        vec![
            edge("e0", "start", "tests", None),
            edge("e1", "tests", "rev", None),
            edge("e2", "rev", "pr", None),
            edge("e3", "pr", "end", None),
        ],
    );
    template
        .workflow
        .inputs
        .push(crate::workflow::WorkflowInput {
            name: "branch".into(),
            label: Some("Head branch".into()),
            default: None,
            required: true,
        });
    template
}

fn watch_feedback() -> Template {
    let visits = |config: NodeConfig| NodeConfig {
        max_visits: Some(3),
        ..config
    };
    template(
        "watch-feedback",
        "Watch Review Feedback",
        "review",
        "Poll PR feedback; fix + re-test while actionable (bounded).",
        vec![
            node(
                "start",
                NodeKind::Start,
                0.0,
                "Start",
                NodeConfig::default(),
            ),
            Node {
                id: "fix".into(),
                kind: NodeKind::Agent,
                position: Position { x: 80.0, y: 120.0 },
                config: visits(NodeConfig {
                    agent_role: Some("implementation".into()),
                    prompt: Some("Address the latest review feedback with tests.".into()),
                    ..NodeConfig::default()
                }),
                label: Some("Address feedback".into()),
            },
            Node {
                id: "tests".into(),
                kind: NodeKind::Command,
                position: Position { x: 80.0, y: 240.0 },
                config: visits(NodeConfig {
                    executable: Some("cargo".into()),
                    args: vec!["test".into()],
                    ..NodeConfig::default()
                }),
                label: Some("Tests".into()),
            },
            Node {
                id: "rev".into(),
                kind: NodeKind::Agent,
                position: Position { x: 80.0, y: 360.0 },
                config: visits(NodeConfig {
                    agent_role: Some("fastReview".into()),
                    prompt: Some("Re-review with ```finding blocks.".into()),
                    ..NodeConfig::default()
                }),
                label: Some("Re-review".into()),
            },
            node(
                "cond",
                NodeKind::Condition,
                480.0,
                "Still actionable?",
                NodeConfig {
                    condition: Some(ConditionConfig {
                        logic: crate::workflow::ConditionLogic::And,
                        clauses: vec![crate::workflow::ConditionClause {
                            left: "node.rev.severity".into(),
                            op: crate::workflow::ConditionOp::Contains,
                            right: "P1".into(),
                        }],
                    }),
                    max_visits: Some(3),
                    ..NodeConfig::default()
                },
            ),
            node("end", NodeKind::End, 600.0, "End", NodeConfig::default()),
        ],
        vec![
            edge("e0", "start", "fix", None),
            edge("e1", "fix", "tests", None),
            edge("e2", "tests", "rev", None),
            edge("e3", "rev", "cond", None),
            edge("e4", "cond", "fix", Some("true")),
            edge("e5", "cond", "end", Some("false")),
        ],
    )
}

/// Ticket → branch → implement → two reviews → fix loop → human review →
/// draft PR. Mirrors a real team flow: ticket context comes from a Jira MCP
/// server picked after preview, branch names come from run inputs, and a
/// human approves before anything is published.
fn ticket_to_pr() -> Template {
    let loop_bound = |config: NodeConfig| NodeConfig {
        max_visits: Some(2),
        ..config
    };
    let mut template = template(
        "ticket-to-pr",
        "Ticket to Draft PR",
        "feature",
        "Ticket → branch → implement → Claude/Codex reviews → fix loop → human review → draft PR.",
        vec![
            node("start", NodeKind::Start, 0.0, "Start", NodeConfig::default()),
            node(
                "ticket",
                NodeKind::Ticket,
                120.0,
                "Load ticket",
                NodeConfig {
                    ticket_key: Some("{{input.ticket}}".into()),
                    ..NodeConfig::default()
                },
            ),
            node(
                "branch",
                NodeKind::Git,
                240.0,
                "Create branch",
                NodeConfig {
                    git_op: Some(crate::workflow::GitOp::BranchCreate {
                        name: "{{input.branch}}".into(),
                    }),
                    ..NodeConfig::default()
                },
            ),
            agent_role(
                "impl",
                360.0,
                "Implement",
                "implementation",
                "Implement {{ticket.key}}: {{ticket.title}}. Keep commits small with short messages; run the project's tests before finishing.",
            ),
            Node {
                id: "rev_fast".into(),
                kind: NodeKind::Agent,
                position: Position { x: 80.0, y: 480.0 },
                config: loop_bound(NodeConfig {
                    agent_role: Some("fastReview".into()),
                    prompt: Some(
                        "Fast review: report findings as finding blocks with severity/file/line/title/explanation/fix. Tag severe issues P0/P1.".into(),
                    ),
                    ..NodeConfig::default()
                }),
                label: Some("Claude Review".into()),
            },
            Node {
                id: "rev_deep".into(),
                kind: NodeKind::Agent,
                position: Position { x: 80.0, y: 600.0 },
                config: loop_bound(NodeConfig {
                    agent_role: Some("deepReview".into()),
                    prompt: Some(
                        "Deep review: report findings as finding blocks with severity/file/line/title/explanation/fix. Tag severe issues P0/P1. Do not re-run tests that already passed.".into(),
                    ),
                    ..NodeConfig::default()
                }),
                label: Some("Codex Review".into()),
            },
            node(
                "cond",
                NodeKind::Condition,
                720.0,
                "P0/P1 found?",
                loop_bound(NodeConfig {
                    condition: Some(ConditionConfig {
                        logic: crate::workflow::ConditionLogic::Or,
                        clauses: vec![
                            crate::workflow::ConditionClause {
                                left: "node.rev_fast.severity".into(),
                                op: crate::workflow::ConditionOp::Contains,
                                right: "P0".into(),
                            },
                            crate::workflow::ConditionClause {
                                left: "node.rev_deep.severity".into(),
                                op: crate::workflow::ConditionOp::Contains,
                                right: "P1".into(),
                            },
                        ],
                    }),
                    ..NodeConfig::default()
                }),
            ),
            agent_role(
                "fix",
                840.0,
                "Fix findings",
                "implementation",
                "Address the P0/P1 findings above with tests; keep commits small.",
            ),
            node(
                "approve",
                NodeKind::Approval,
                960.0,
                "Human review",
                NodeConfig {
                    message: Some(
                        "A human reviews the implementation and findings before the draft PR is opened.".into(),
                    ),
                    ..NodeConfig::default()
                },
            ),
            node(
                "pr",
                NodeKind::GitHub,
                1080.0,
                "Draft PR",
                NodeConfig {
                    github_op: Some(crate::workflow::GitHubOp::CreatePr {
                        title: "{{input.branch}}".into(),
                        body: "Draft for {{ticket.key}}: {{ticket.title}}.".into(),
                        base: "main".into(),
                        head: "{{input.branch}}".into(),
                        draft: true,
                    }),
                    ..NodeConfig::default()
                },
            ),
            node("end", NodeKind::End, 1200.0, "End", NodeConfig::default()),
        ],
        vec![
            edge("e0", "start", "ticket", None),
            edge("e1", "ticket", "branch", None),
            edge("e2", "branch", "impl", None),
            edge("e3", "impl", "rev_fast", None),
            edge("e4", "impl", "rev_deep", None),
            edge("e5", "rev_fast", "cond", None),
            edge("e6", "rev_deep", "cond", None),
            edge("e7", "cond", "fix", Some("true")),
            edge("e8", "cond", "approve", Some("false")),
            edge("e9", "fix", "rev_fast", None),
            edge("e10", "approve", "pr", None),
            edge("e11", "pr", "end", None),
        ],
    );
    // fix loops back into the reviews: it needs the same visit bound.
    if let Some(fix) = template.workflow.nodes.iter_mut().find(|n| n.id == "fix") {
        fix.config.max_visits = Some(2);
    }
    template
        .workflow
        .inputs
        .push(crate::workflow::WorkflowInput {
            name: "ticket".into(),
            label: Some("Ticket key (e.g. DEV-1234)".into()),
            default: None,
            required: true,
        });
    template
        .workflow
        .inputs
        .push(crate::workflow::WorkflowInput {
            name: "branch".into(),
            label: Some("Branch name".into()),
            default: None,
            required: true,
        });
    template
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roles() -> HashMap<String, String> {
        ["planning", "implementation", "fastReview", "deepReview"]
            .iter()
            .map(|r| ((*r).to_string(), format!("p-{r}")))
            .collect()
    }

    #[test]
    fn builtins_instantiate_cleanly() {
        for template in builtin_templates() {
            let instantiated =
                instantiate(&template, &roles(), false).expect("builtin must instantiate");
            let workflow = instantiated.workflow;
            assert!(
                workflow
                    .nodes
                    .iter()
                    .filter(|n| n.kind == NodeKind::Agent)
                    .all(|n| n.config.agent_profile_id.is_some()),
                "template {} left roles unresolved",
                template.id
            );
        }
        assert_eq!(builtin_templates().len(), 9);
    }

    #[test]
    fn missing_roles_reported() {
        let template = builtin_templates()
            .into_iter()
            .find(|t| t.id == "implement-ticket")
            .expect("template");
        let err = instantiate(&template, &HashMap::new(), false).expect_err("must fail");
        assert!(err.contains("planning"), "{err}");
    }

    #[test]
    fn export_import_round_trips_and_strips_nothing_secret() {
        let template = builtin_templates()
            .into_iter()
            .find(|t| t.id == "review-pr")
            .expect("template");
        let json = export_template(&template).expect("export");
        let back = import_template(&json).expect("import");
        assert_eq!(back, template);
    }

    #[test]
    fn credential_templates_refused() {
        let mut template = builtin_templates()
            .into_iter()
            .find(|t| t.id == "implement-ticket")
            .expect("template");
        template.workflow.nodes.push(Node {
            id: "evil".into(),
            kind: NodeKind::Command,
            position: Position::default(),
            config: NodeConfig {
                executable: Some("echo".into()),
                args: vec!["--password=hunter2".into()],
                ..NodeConfig::default()
            },
            label: None,
        });
        assert!(export_template(&template).is_err());
        assert!(import_template(&serde_json::to_string(&template).expect("json")).is_err());
    }
}
