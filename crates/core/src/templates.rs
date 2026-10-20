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
        remap_ids(&mut workflow)?;
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

fn remap_ids(workflow: &mut Workflow) -> Result<(), String> {
    let mut id_map: HashMap<String, String> = HashMap::new();
    for node in workflow.nodes.iter_mut() {
        let fresh = format!("node-{}", uuid::Uuid::new_v4().simple());
        id_map.insert(node.id.clone(), fresh.clone());
        node.id = fresh;
    }
    for node in &mut workflow.nodes {
        crate::workflow_document::remap_config_references(&mut node.config, &id_map)?;
    }
    workflow.id = format!("wf-{}", uuid::Uuid::new_v4().simple());
    for edge in workflow.edges.iter_mut() {
        if let Some(fresh) = id_map.get(&edge.source) {
            edge.source = fresh.clone();
        }
        if let Some(fresh) = id_map.get(&edge.target) {
            edge.target = fresh.clone();
        }
        edge.id = format!("edge-{}", uuid::Uuid::new_v4().simple());
    }
    Ok(())
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

/// Human-editable template envelope; runtime definitions remain accepted on import.
pub fn export_developer_template(
    template: &Template,
    profiles: &[crate::agents::AgentProfile],
) -> Result<String, String> {
    let errors = template.validate();
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    let session = crate::workflow_document::export_document(&template.workflow, profiles)?;
    let mut value = serde_json::to_value(template).map_err(|e| e.to_string())?;
    value["workflow"] = serde_json::from_str(&session.json).map_err(|e| e.to_string())?;
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}
pub fn import_developer_template(
    json: &str,
    profiles: &[crate::agents::AgentProfile],
) -> Result<Template, String> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|e| format!("Invalid template or workflow JSON: {e}"))?;
    if !value.is_object() {
        return Err("Template or workflow JSON must be an object.".into());
    }
    let envelope = value.get("workflow").is_some();
    let document = value.get("workflow").unwrap_or(&value);
    let mut workflow = crate::workflow_document::import_document(
        &document.to_string(),
        None,
        &HashMap::new(),
        profiles,
        &HashMap::new(),
        "template-workflow",
    )?;
    for node in &mut workflow.nodes {
        if node.kind != NodeKind::Agent {
            continue;
        }
        let Some(id) = node.config.agent_profile_id.as_ref() else {
            continue;
        };
        if profiles.iter().any(|profile| &profile.id == id) {
            continue;
        }
        if node
            .config
            .agent_role
            .as_deref()
            .is_some_and(|role| !role.trim().is_empty())
        {
            node.config.agent_profile_id = None;
        } else {
            return Err(format!("Agent Profile '{id}' is missing. Set a portable agentRole or configure the profile in Agents."));
        }
    }
    if workflow.nodes.is_empty() {
        return Err("Template workflow has no nodes.".into());
    }
    let blocking: Vec<String> = validate_workflow(&workflow)
        .into_iter()
        .filter(|issue| {
            issue.severity == crate::workflow::ValidationSeverity::Error
                && !matches!(
                    issue.code.as_str(),
                    "git-dir-required" | "ticket-server-required" | "mcp-server-required"
                )
        })
        .map(|issue| issue.message)
        .collect();
    if !blocking.is_empty() {
        return Err(blocking.join("; "));
    }
    let mut metadata = if envelope {
        value
    } else {
        serde_json::json!({})
    };
    if metadata.get("id").is_none() {
        metadata["id"] = serde_json::json!(format!("user-{}", uuid::Uuid::new_v4().simple()));
    }
    if metadata.get("name").is_none() {
        metadata["name"] = serde_json::json!(&workflow.name);
    }
    metadata["workflow"] = serde_json::to_value(workflow).map_err(|e| e.to_string())?;
    import_template(&metadata.to_string())
}

// -- Built-ins ---------------------------------------------------------------
//
// Every built-in works in the repository chosen when the template is used
// (the workflow's `defaults.repoDir`), asks for what it needs as run inputs,
// and is replayed end to end in tests (`builtins_run_end_to_end`).

/// How reviewers report findings; `review::reported_severity` reads them.
const FINDINGS: &str = "Report each problem as a ```finding block with the lines `severity:` (P0 for data loss, security holes or crashes; P1 for wrong behavior or missing tests for changed logic; P2 or P3 for minor issues), `file:`, `line:`, `title:`, `explanation:` and `fix:`. If there is nothing to report, say so in one sentence without severity labels.";

/// Implementation steps leave tests and commits to the workflow, so they need
/// only file-edit permissions.
const NO_RUN: &str = "Do not run the test suite or commit; the workflow does both.";

/// Claude Code allow rules every implementation step declares.
const EDIT_TOOLS: [&str; 2] = ["Edit", "Write"];

/// Main column and side columns for parallel or loop steps.
const MAIN: f64 = 80.0;
const LEFT: f64 = -200.0;
const RIGHT: f64 = 360.0;

fn row(index: u32) -> f64 {
    f64::from(index) * 120.0
}

fn node(id: &str, kind: NodeKind, x: f64, y: f64, label: &str, config: NodeConfig) -> Node {
    Node {
        id: id.to_string(),
        kind,
        position: Position { x, y },
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

/// Edges for a list of `(source, target)` pairs, labelled `true`/`false` when given.
fn edges(pairs: &[(&str, &str, Option<&str>)]) -> Vec<Edge> {
    pairs
        .iter()
        .enumerate()
        .map(|(i, (source, target, label))| edge(&format!("e{i}"), source, target, *label))
        .collect()
}

fn start() -> Node {
    node(
        "start",
        NodeKind::Start,
        MAIN,
        0.0,
        "Start",
        NodeConfig::default(),
    )
}

fn end(y: f64) -> Node {
    node("end", NodeKind::End, MAIN, y, "End", NodeConfig::default())
}

fn input(name: &str, label: &str, default: Option<&str>) -> crate::workflow::WorkflowInput {
    crate::workflow::WorkflowInput {
        name: name.into(),
        label: Some(label.into()),
        default: default.map(str::to_string),
        required: default.is_none(),
    }
}

fn test_input() -> crate::workflow::WorkflowInput {
    input(
        "testCommand",
        "Test command (e.g. npm test, cargo test, make test)",
        None,
    )
}

fn base_input() -> crate::workflow::WorkflowInput {
    input("base", "Base branch for the pull request", Some("main"))
}

fn pr_input() -> crate::workflow::WorkflowInput {
    input("prNumber", "Pull request number (e.g. 128)", None)
}

fn agent(
    id: &str,
    (x, y): (f64, f64),
    label: &str,
    role: &str,
    prompt: &str,
    context_refs: &[&str],
    context_chars: u32,
) -> Node {
    node(
        id,
        NodeKind::Agent,
        x,
        y,
        label,
        NodeConfig {
            agent_role: Some(role.to_string()),
            prompt: Some(format!("Read the repository instructions first. {prompt}")),
            context_refs: context_refs.iter().map(|id| (*id).to_string()).collect(),
            context_max_chars: (!context_refs.is_empty()).then_some(context_chars),
            ..NodeConfig::default()
        },
    )
}

/// An implementation step: edits files, leaves tests and commits to the workflow.
fn implementer(id: &str, x: f64, y: f64, label: &str, prompt: &str, context_refs: &[&str]) -> Node {
    let mut step = agent(
        id,
        (x, y),
        label,
        "implementation",
        &format!("{prompt} {NO_RUN}"),
        context_refs,
        12000,
    );
    step.config.required_tools = EDIT_TOOLS.iter().map(|rule| (*rule).to_string()).collect();
    step
}

fn reviewer(
    id: &str,
    at: (f64, f64),
    label: &str,
    role: &str,
    prompt: &str,
    context_refs: &[&str],
    context_chars: u32,
) -> Node {
    agent(
        id,
        at,
        label,
        role,
        &format!("{prompt} {FINDINGS}"),
        context_refs,
        context_chars,
    )
}

fn run_tests(id: &str, y: f64, label: &str) -> Node {
    node(
        id,
        NodeKind::Command,
        MAIN,
        y,
        label,
        NodeConfig {
            executable: Some("sh".into()),
            args: vec!["-c".into(), "{{input.testCommand}}".into()],
            ..NodeConfig::default()
        },
    )
}

fn command(id: &str, x: f64, y: f64, label: &str, executable: &str, args: &[&str]) -> Node {
    node(
        id,
        NodeKind::Command,
        x,
        y,
        label,
        NodeConfig {
            executable: Some(executable.into()),
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
            ..NodeConfig::default()
        },
    )
}

fn approval(id: &str, x: f64, y: f64, label: &str, message: &str) -> Node {
    node(
        id,
        NodeKind::Approval,
        x,
        y,
        label,
        NodeConfig {
            message: Some(message.into()),
            ..NodeConfig::default()
        },
    )
}

fn github(id: &str, y: f64, label: &str, op: crate::workflow::GitHubOp) -> Node {
    node(
        id,
        NodeKind::GitHub,
        MAIN,
        y,
        label,
        NodeConfig {
            github_op: Some(op),
            ..NodeConfig::default()
        },
    )
}

fn git(id: &str, y: f64, label: &str, op: crate::workflow::GitOp) -> Node {
    node(
        id,
        NodeKind::Git,
        MAIN,
        y,
        label,
        NodeConfig {
            git_op: Some(op),
            ..NodeConfig::default()
        },
    )
}

/// True when any reviewer reported a P0 or P1 finding.
fn severity_gate(id: &str, y: f64, reviewers: &[&str]) -> Node {
    use crate::workflow::{ConditionClause, ConditionLogic, ConditionOp};
    node(
        id,
        NodeKind::Condition,
        MAIN,
        y,
        "P0/P1 found?",
        NodeConfig {
            condition: Some(ConditionConfig {
                logic: ConditionLogic::Or,
                clauses: reviewers
                    .iter()
                    .flat_map(|reviewer| {
                        ["P0", "P1"].map(|level| ConditionClause {
                            left: format!("node.{reviewer}.severity"),
                            op: ConditionOp::Contains,
                            right: level.into(),
                        })
                    })
                    .collect(),
            }),
            ..NodeConfig::default()
        },
    )
}

fn push_branch(y: f64) -> Node {
    command(
        "push",
        MAIN,
        y,
        "Push branch",
        "git",
        &["push", "-u", "origin", "{{input.branch}}"],
    )
}

/// Bound the review/fix cycle: up to two fix rounds, then the run stops with
/// the findings visible.
fn bound_loop(nodes: &mut [Node], cycle: &[&str], fix: &str) {
    for node in nodes {
        if node.id == fix {
            node.config.max_visits = Some(2);
        } else if cycle.contains(&node.id.as_str()) {
            node.config.max_visits = Some(3);
        }
    }
}

fn template(
    id: &str,
    name: &str,
    category: &str,
    description: &str,
    inputs: Vec<crate::workflow::WorkflowInput>,
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
            inputs,
            defaults: None,
            limits: None,
            nodes,
            edges,
        },
    }
}

/// The nine built-in templates.
pub fn builtin_templates() -> Vec<Template> {
    vec![
        implement_task(),
        review_pull_request(),
        investigate_bug(),
        refactor(),
        dependency_upgrade(),
        multi_agent_review(),
        create_draft_pr(),
        address_feedback(),
        ticket_to_pr(),
    ]
}

fn implement_task() -> Template {
    template(
        "implement-ticket",
        "Implement a Task",
        "feature",
        "Plan → you approve → implement → test → review. Works from a ticket key, a link or a plain description; no Jira setup needed. Leaves the change uncommitted for you.",
        vec![
            input("task", "Task: ticket key, link or description", None),
            test_input(),
        ],
        vec![
            start(),
            agent(
                "plan",
                (MAIN, row(1)),
                "Plan",
                "planning",
                "Plan this task: {{input.task}}. If it is a ticket key or link you can open, read it first. List the files to change, the tests to add and the risks. Do not edit any files.",
                &[],
                12000,
            ),
            approval(
                "gate",
                MAIN,
                row(2),
                "Approve plan",
                "Check the plan before any file changes.",
            ),
            implementer(
                "impl",
                MAIN,
                row(3),
                "Implement",
                "Implement the approved plan for: {{input.task}}. Keep the change focused and add or update tests.",
                &["plan"],
            ),
            run_tests("tests", row(4), "Run tests"),
            reviewer(
                "review",
                (MAIN, row(5)),
                "Review",
                "deepReview",
                "Review the uncommitted changes in this repository (run `git diff`) for this task: {{input.task}}.",
                &["impl", "tests"],
                12000,
            ),
            end(row(6)),
        ],
        edges(&[
            ("start", "plan", None),
            ("plan", "gate", None),
            ("gate", "impl", None),
            ("impl", "tests", None),
            ("tests", "review", None),
            ("review", "end", None),
        ]),
    )
}

fn review_pull_request() -> Template {
    use crate::workflow::GitHubOp;
    template(
        "review-pr",
        "Review Pull Request",
        "review",
        "Load a PR and its diff → Claude and Codex review in parallel → if they find P0/P1 problems, you approve posting one comment; otherwise it is marked clean.",
        vec![pr_input()],
        vec![
            start(),
            github("details", row(1), "Load PR", GitHubOp::PrDetails { number: 0 }),
            command(
                "diff",
                MAIN,
                row(2),
                "Fetch diff",
                "gh",
                &["pr", "diff", "{{input.prNumber}}"],
            ),
            reviewer(
                "revA",
                (LEFT, row(3)),
                "Claude review",
                "fastReview",
                "Review pull request #{{input.prNumber}} using its details and diff above. Open files in this repository for context when the diff is not enough.",
                &["details", "diff"],
                48000,
            ),
            reviewer(
                "revB",
                (RIGHT, row(3)),
                "Codex review",
                "deepReview",
                "Deep review of pull request #{{input.prNumber}} (details and diff above): correctness, security and missing tests.",
                &["details", "diff"],
                48000,
            ),
            severity_gate("gate", row(4), &["revA", "revB"]),
            approval(
                "approve",
                LEFT,
                row(5),
                "Post findings?",
                "The reviews found P0/P1 problems. Approve to post them as one comment on the PR; reject to stop without posting.",
            ),
            node(
                "note",
                NodeKind::GitHub,
                LEFT,
                row(6),
                "Post comment",
                NodeConfig {
                    github_op: Some(GitHubOp::PostComment {
                        number: 0,
                        body: "Review findings from Orchevia (Claude and Codex)\n\n### Claude\n\n{{node.revA.output}}\n\n### Codex\n\n{{node.revB.output}}".into(),
                    }),
                    ..NodeConfig::default()
                },
            ),
            command(
                "clean",
                RIGHT,
                row(5),
                "No blocking findings",
                "echo",
                &["No P0/P1 findings in pull request {{input.prNumber}}."],
            ),
            end(row(7)),
        ],
        edges(&[
            ("start", "details", None),
            ("details", "diff", None),
            ("diff", "revA", None),
            ("diff", "revB", None),
            ("revA", "gate", None),
            ("revB", "gate", None),
            ("gate", "approve", Some("true")),
            ("gate", "clean", Some("false")),
            ("approve", "note", None),
            ("note", "end", None),
            ("clean", "end", None),
        ]),
    )
}

fn investigate_bug() -> Template {
    template(
        "investigate-bug",
        "Investigate Bug",
        "bugfix",
        "Find the root cause and add a failing regression test → you confirm → fix → test. Leaves the change uncommitted for you.",
        vec![
            input("bug", "Bug: issue key, link or description", None),
            test_input(),
        ],
        vec![
            start(),
            implementer(
                "repro",
                MAIN,
                row(1),
                "Find the cause",
                "Investigate this bug: {{input.bug}}. Find the root cause and add a regression test that fails because of it, but do not fix the bug yet. Explain the cause and name the new test.",
                &[],
            ),
            approval(
                "gate",
                MAIN,
                row(2),
                "Confirm the cause",
                "Check the explanation and the new regression test before the fix.",
            ),
            implementer(
                "fix",
                MAIN,
                row(3),
                "Fix",
                "Fix the root cause described above. Keep the new regression test and do not weaken existing tests.",
                &["repro"],
            ),
            run_tests("tests", row(4), "Run tests"),
            end(row(5)),
        ],
        edges(&[
            ("start", "repro", None),
            ("repro", "gate", None),
            ("gate", "fix", None),
            ("fix", "tests", None),
            ("tests", "end", None),
        ]),
    )
}

fn refactor() -> Template {
    template(
        "refactor",
        "Refactor",
        "refactor",
        "Run the tests → refactor without changing behavior → run the tests again → review. Leaves the change uncommitted for you.",
        vec![
            input(
                "target",
                "What to refactor and the goal (e.g. split src/cart.ts into smaller modules)",
                None,
            ),
            test_input(),
        ],
        vec![
            start(),
            run_tests("before", row(1), "Run tests (before)"),
            implementer(
                "ref",
                MAIN,
                row(2),
                "Refactor",
                "Refactor without changing behavior: {{input.target}}. Keep public interfaces and existing tests unchanged.",
                &["before"],
            ),
            run_tests("after", row(3), "Run tests (after)"),
            reviewer(
                "review",
                (MAIN, row(4)),
                "Review",
                "fastReview",
                "Review the uncommitted refactor (run `git diff`) for any change in behavior. The goal was: {{input.target}}.",
                &["ref", "after"],
                12000,
            ),
            end(row(5)),
        ],
        edges(&[
            ("start", "before", None),
            ("before", "ref", None),
            ("ref", "after", None),
            ("after", "review", None),
            ("review", "end", None),
        ]),
    )
}

fn dependency_upgrade() -> Template {
    template(
        "dependency-upgrade",
        "Dependency Upgrade",
        "maintenance",
        "Update the manifest and adapt the code → install → test → review the upgrade. Leaves the change uncommitted for you.",
        vec![
            input(
                "dependency",
                "Dependency and target version (e.g. react to 19.3)",
                None,
            ),
            input(
                "installCommand",
                "Install command that updates the lockfile (e.g. pnpm install, npm install, cargo update)",
                None,
            ),
            test_input(),
        ],
        vec![
            start(),
            implementer(
                "up",
                MAIN,
                row(1),
                "Upgrade",
                "Upgrade {{input.dependency}}: change the version in the dependency manifest and adapt the code to its breaking changes. Do not run the package manager; the workflow installs next.",
                &[],
            ),
            node(
                "install",
                NodeKind::Command,
                MAIN,
                row(2),
                "Install dependencies",
                NodeConfig {
                    executable: Some("sh".into()),
                    args: vec!["-c".into(), "{{input.installCommand}}".into()],
                    ..NodeConfig::default()
                },
            ),
            run_tests("tests", row(3), "Run tests"),
            reviewer(
                "review",
                (MAIN, row(4)),
                "Review upgrade",
                "fastReview",
                "Review the upgrade of {{input.dependency}} (run `git diff`) for breaking changes and risky API use.",
                &["up", "tests"],
                12000,
            ),
            end(row(5)),
        ],
        edges(&[
            ("start", "up", None),
            ("up", "install", None),
            ("install", "tests", None),
            ("tests", "review", None),
            ("review", "end", None),
        ]),
    )
}

fn multi_agent_review() -> Template {
    template(
        "multi-agent-review",
        "Run Multi-Agent Review",
        "review",
        "Diff this branch and your uncommitted work against a base branch → Claude and Codex review in parallel → triage P0/P1 findings or mark it clean.",
        vec![input("base", "Compare against branch", Some("main"))],
        vec![
            start(),
            command(
                "diff",
                MAIN,
                row(1),
                "Collect diff",
                "git",
                &["diff", "{{input.base}}"],
            ),
            reviewer(
                "revA",
                (LEFT, row(2)),
                "Claude review",
                "fastReview",
                "Review the changes in the diff above (this branch and uncommitted work compared with {{input.base}}). Open files in this repository for context when the diff is not enough.",
                &["diff"],
                48000,
            ),
            reviewer(
                "revB",
                (RIGHT, row(2)),
                "Codex review",
                "deepReview",
                "Deep review of the diff above (compared with {{input.base}}): correctness, security and missing tests.",
                &["diff"],
                48000,
            ),
            severity_gate("gate", row(3), &["revA", "revB"]),
            approval(
                "triage",
                LEFT,
                row(4),
                "Triage P0/P1",
                "The reviews found P0/P1 problems. Read them in Runs, then approve to finish.",
            ),
            command(
                "clean",
                RIGHT,
                row(4),
                "No blocking findings",
                "echo",
                &["No P0/P1 findings."],
            ),
            end(row(5)),
        ],
        edges(&[
            ("start", "diff", None),
            ("diff", "revA", None),
            ("diff", "revB", None),
            ("revA", "gate", None),
            ("revB", "gate", None),
            ("gate", "triage", Some("true")),
            ("gate", "clean", Some("false")),
            ("triage", "end", None),
            ("clean", "end", None),
        ]),
    )
}

fn create_draft_pr() -> Template {
    use crate::workflow::{GitHubOp, GitOp};
    template(
        "create-draft-pr",
        "Create Draft PR",
        "feature",
        "Check out your branch → test → review → you approve → push and open a draft PR.",
        vec![
            input("branch", "Branch with your committed work", None),
            input("title", "Pull request title", None),
            test_input(),
            base_input(),
        ],
        vec![
            start(),
            git(
                "checkout",
                row(1),
                "Check out branch",
                GitOp::Checkout {
                    name: "{{input.branch}}".into(),
                    allow_dirty: false,
                },
            ),
            run_tests("tests", row(2), "Run tests"),
            reviewer(
                "review",
                (MAIN, row(3)),
                "Review",
                "fastReview",
                "Review the commits on this branch compared with {{input.base}} (run `git diff {{input.base}}...HEAD`).",
                &["tests"],
                12000,
            ),
            approval(
                "approve",
                MAIN,
                row(4),
                "Open the PR?",
                "Check the review. Approving pushes the branch and opens a draft pull request.",
            ),
            push_branch(row(5)),
            github(
                "pr",
                row(6),
                "Open draft PR",
                GitHubOp::CreatePr {
                    title: "{{input.title}}".into(),
                    body: "Tested with `{{input.testCommand}}` and reviewed in Orchevia.".into(),
                    base: "{{input.base}}".into(),
                    head: "{{input.branch}}".into(),
                    draft: true,
                },
            ),
            end(row(7)),
        ],
        edges(&[
            ("start", "checkout", None),
            ("checkout", "tests", None),
            ("tests", "review", None),
            ("review", "approve", None),
            ("approve", "push", None),
            ("push", "pr", None),
            ("pr", "end", None),
        ]),
    )
}

fn address_feedback() -> Template {
    let mut template = template(
        "watch-feedback",
        "Address Review Feedback",
        "review",
        "Check out a PR → address its review feedback → test → re-review, with up to two fix rounds. A feedback watcher can run it with the PR number. Leaves the change uncommitted for you.",
        vec![pr_input(), test_input()],
        vec![
            start(),
            command(
                "checkout",
                MAIN,
                row(1),
                "Check out PR branch",
                "gh",
                &["pr", "checkout", "{{input.prNumber}}"],
            ),
            command(
                "feedback",
                MAIN,
                row(2),
                "Load feedback",
                "gh",
                &[
                    "pr",
                    "view",
                    "{{input.prNumber}}",
                    "--json",
                    "title,body,reviews,comments",
                ],
            ),
            implementer(
                "address",
                MAIN,
                row(3),
                "Address feedback",
                "Address the review feedback on pull request #{{input.prNumber}} shown above. Change only what the feedback asks for and add tests where needed.",
                &["feedback"],
            ),
            run_tests("tests", row(4), "Run tests"),
            reviewer(
                "review",
                (MAIN, row(5)),
                "Re-review",
                "fastReview",
                "Review the uncommitted changes (run `git diff`) against the PR feedback above.",
                &["feedback", "tests"],
                12000,
            ),
            severity_gate("gate", row(6), &["review"]),
            implementer(
                "fix",
                LEFT,
                row(6),
                "Fix findings",
                "Fix the P0/P1 findings from the review above.",
                &["review"],
            ),
            end(row(7)),
        ],
        edges(&[
            ("start", "checkout", None),
            ("checkout", "feedback", None),
            ("feedback", "address", None),
            ("address", "tests", None),
            ("tests", "review", None),
            ("review", "gate", None),
            ("gate", "fix", Some("true")),
            ("gate", "end", Some("false")),
            ("fix", "tests", None),
        ]),
    );
    for node in &mut template.workflow.nodes {
        if node.id == "address" || node.id == "fix" {
            node.config.session_group = Some("feedback-{{input.prNumber}}".into());
            node.config.session_max_turns = Some(4);
        }
    }
    bound_loop(
        &mut template.workflow.nodes,
        &["tests", "review", "gate"],
        "fix",
    );
    template
}

fn ticket_to_pr() -> Template {
    use crate::workflow::{GitHubOp, GitOp};
    let mut template = template(
        "ticket-to-pr",
        "Ticket to Draft PR",
        "feature",
        "Jira ticket → branch → implement → test → Claude and Codex review → fix loop → you review → commit, push and open a draft PR. Needs a Jira MCP server.",
        vec![
            input("ticket", "Jira ticket key or URL (e.g. DEV-1234)", None),
            input("branch", "New branch name (e.g. dev-1234-short-title)", None),
            test_input(),
            base_input(),
        ],
        vec![
            start(),
            node(
                "ticket",
                NodeKind::Ticket,
                MAIN,
                row(1),
                "Load Jira ticket",
                NodeConfig {
                    ticket_key: Some("{{input.ticket}}".into()),
                    ..NodeConfig::default()
                },
            ),
            git(
                "branch",
                row(2),
                "Create branch",
                GitOp::BranchCreate {
                    name: "{{input.branch}}".into(),
                },
            ),
            implementer(
                "impl",
                MAIN,
                row(3),
                "Implement",
                "Implement {{ticket.key}}: {{ticket.title}} using the ticket details above. Keep the change focused and add or update tests.",
                &["ticket"],
            ),
            run_tests("tests", row(4), "Run tests"),
            reviewer(
                "rev_fast",
                (LEFT, row(5)),
                "Claude review",
                "fastReview",
                "Review the uncommitted changes for {{ticket.key}} (run `git diff`) against the ticket above.",
                &["ticket", "tests"],
                12000,
            ),
            reviewer(
                "rev_deep",
                (RIGHT, row(5)),
                "Codex review",
                "deepReview",
                "Deep review of the uncommitted changes for {{ticket.key}} (run `git diff`): correctness, security and missing tests.",
                &["ticket", "tests"],
                12000,
            ),
            severity_gate("gate", row(6), &["rev_fast", "rev_deep"]),
            implementer(
                "fix",
                LEFT - 260.0,
                row(6),
                "Fix findings",
                "Fix the P0/P1 findings from both reviews above.",
                &["rev_fast", "rev_deep"],
            ),
            approval(
                "approve",
                MAIN,
                row(7),
                "Human review",
                "Check the change and the review findings. Approving commits the change, pushes the branch and opens a draft pull request.",
            ),
            git(
                "stage",
                row(8),
                "Stage changes",
                GitOp::Stage {
                    paths: vec![".".into()],
                },
            ),
            git(
                "commit",
                row(9),
                "Commit",
                GitOp::Commit {
                    message: "{{ticket.key}}: {{ticket.title}}".into(),
                },
            ),
            push_branch(row(10)),
            github(
                "pr",
                row(11),
                "Open draft PR",
                GitHubOp::CreatePr {
                    title: "{{ticket.key}}: {{ticket.title}}".into(),
                    body: "Implements {{ticket.key}}. Tested with `{{input.testCommand}}` and reviewed by Claude and Codex in Orchevia.".into(),
                    base: "{{input.base}}".into(),
                    head: "{{input.branch}}".into(),
                    draft: true,
                },
            ),
            end(row(12)),
        ],
        edges(&[
            ("start", "ticket", None),
            ("ticket", "branch", None),
            ("branch", "impl", None),
            ("impl", "tests", None),
            ("tests", "rev_fast", None),
            ("tests", "rev_deep", None),
            ("rev_fast", "gate", None),
            ("rev_deep", "gate", None),
            ("gate", "fix", Some("true")),
            ("gate", "approve", Some("false")),
            ("fix", "tests", None),
            ("approve", "stage", None),
            ("stage", "commit", None),
            ("commit", "push", None),
            ("push", "pr", None),
            ("pr", "end", None),
        ]),
    );
    for node in &mut template.workflow.nodes {
        if node.id == "impl" || node.id == "fix" {
            node.config.session_group = Some("implementation-{{input.ticket}}".into());
            node.config.session_max_turns = Some(4);
        }
    }
    bound_loop(
        &mut template.workflow.nodes,
        &["tests", "rev_fast", "rev_deep", "gate"],
        "fix",
    );
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
    fn simple_template_exports_preserve_operations_and_accept_legacy_files() {
        for template in builtin_templates() {
            let json = export_developer_template(&template, &[]).unwrap();
            assert!(!json.contains("position"));
            let imported = import_developer_template(&json, &[]).unwrap();
            assert_eq!(imported.name, template.name);
            assert_eq!(imported.workflow.nodes.len(), template.workflow.nodes.len());
            for (a, b) in imported.workflow.nodes.iter().zip(&template.workflow.nodes) {
                assert_eq!(a.config, b.config);
            }
            assert_eq!(
                import_developer_template(&export_template(&template).unwrap(), &[]).unwrap(),
                template
            );
        }
    }

    #[test]
    fn direct_workflow_import_creates_portable_template() {
        let original = builtin_templates().remove(0);
        let simple = crate::workflow_document::export_document(&original.workflow, &[]).unwrap();
        for json in [simple.json, original.workflow.to_json().unwrap()] {
            let imported = import_developer_template(&json, &[]).unwrap();
            assert_eq!(imported.name, original.workflow.name);
            assert_eq!(imported.category, "general");
            assert_eq!(imported.workflow.nodes.len(), original.workflow.nodes.len());
            for (a, b) in imported.workflow.nodes.iter().zip(&original.workflow.nodes) {
                assert_eq!(a.config, b.config);
            }
            assert!(export_developer_template(&imported, &[]).is_ok());
        }
    }

    #[test]
    fn direct_template_import_rejects_malformed_and_semantically_broken_workflows() {
        for json in [
            "null",
            "[]",
            "{}",
            r#"{"version":1,"name":"Broken","nodes":[],"edges":[]}"#,
        ] {
            assert!(import_developer_template(json, &[]).is_err());
        }
        let mut template = builtin_templates().remove(0);
        template.workflow.edges[0].target = "missing".into();
        assert!(
            import_developer_template(&serde_json::to_string(&template).unwrap(), &[]).is_err()
        );
    }

    #[test]
    fn direct_template_import_requires_portable_agent_bindings() {
        let mut template = builtin_templates().remove(0);
        let reviewer = template
            .workflow
            .nodes
            .iter_mut()
            .find(|node| node.kind == NodeKind::Agent)
            .unwrap();
        reviewer.config.agent_profile_id = Some("foreign-profile".into());
        reviewer.config.agent_role = None;
        let error =
            import_developer_template(&template.workflow.to_json().unwrap(), &[]).unwrap_err();
        assert!(error.contains("missing"));
        let reviewer = template
            .workflow
            .nodes
            .iter_mut()
            .find(|node| node.kind == NodeKind::Agent)
            .unwrap();
        reviewer.config.agent_role = Some("deepReview".into());
        let imported =
            import_developer_template(&template.workflow.to_json().unwrap(), &[]).unwrap();
        let reviewer = imported
            .workflow
            .nodes
            .iter()
            .find(|node| node.kind == NodeKind::Agent)
            .unwrap();
        assert_eq!(reviewer.config.agent_role.as_deref(), Some("deepReview"));
        assert!(reviewer.config.agent_profile_id.is_none());
        assert!(export_developer_template(&imported, &[]).is_ok());
    }

    #[test]
    fn templates_declare_the_tools_their_agents_need() {
        let mut template = builtin_templates().remove(0);
        let agent = template
            .workflow
            .nodes
            .iter_mut()
            .find(|node| node.kind == NodeKind::Agent)
            .unwrap();
        agent.config.required_tools = vec![
            "mcp__claude_ai_Atlassian_Rovo_2".into(),
            "Bash(git status *)".into(),
        ];
        // Both export forms keep version 1 and carry the declaration; the
        // field name trips none of the credential markers.
        for json in [
            export_developer_template(&template, &[]).unwrap(),
            export_template(&template).unwrap(),
        ] {
            let value: serde_json::Value = serde_json::from_str(&json).unwrap();
            assert_eq!(value["version"], 1);
            if value["workflow"].get("schemaVersion").is_none() {
                assert_eq!(value["workflow"]["version"], 1);
            }
            assert!(json.contains("requiredTools"));
            let imported = import_developer_template(&json, &[]).unwrap();
            let agent = imported
                .workflow
                .nodes
                .iter()
                .find(|node| node.kind == NodeKind::Agent)
                .unwrap();
            assert_eq!(
                agent.config.required_tools,
                ["mcp__claude_ai_Atlassian_Rovo_2", "Bash(git status *)"]
            );
        }
        // Files exported before the field existed still import unchanged.
        let mut before = builtin_templates().remove(0);
        for node in &mut before.workflow.nodes {
            node.config.required_tools.clear();
        }
        let legacy = export_developer_template(&before, &[]).unwrap();
        assert!(!legacy.contains("requiredTools"));
        assert!(import_developer_template(&legacy, &[]).is_ok());
        // A declared tool can never smuggle a credential past the scan.
        let mut secret = template.clone();
        secret
            .workflow
            .nodes
            .iter_mut()
            .find(|node| node.kind == NodeKind::Agent)
            .unwrap()
            .config
            .required_tools = vec!["Bash(curl -H 'Authorization: Bearer x' *)".into()];
        assert!(import_developer_template(&serde_json::to_string(&secret).unwrap(), &[]).is_err());
    }

    #[test]
    fn declared_tools_are_validated_where_they_apply() {
        let mut wf = crate::workflow::sample_workflow();
        wf.nodes[1].kind = NodeKind::Agent;
        wf.nodes[1].config.agent_profile_id = Some("p".into());
        wf.nodes[1].config.prompt = Some("Work".into());
        wf.nodes[1].config.required_tools = vec!["Edit".into(), "not a rule".into()];
        let codes: Vec<String> = validate_workflow(&wf).into_iter().map(|i| i.code).collect();
        assert!(
            codes.contains(&"agent-required-tools-invalid".to_string()),
            "{codes:?}"
        );
        wf.nodes[1].config.required_tools = vec!["Edit".into()];
        wf.nodes[0].config.required_tools = vec!["Write".into()];
        let codes: Vec<String> = validate_workflow(&wf).into_iter().map(|i| i.code).collect();
        assert!(!codes.contains(&"agent-required-tools-invalid".to_string()));
        assert!(codes.contains(&"agent-required-tools-misplaced".to_string()));
    }

    /// Replays every built-in template in the real engine: stub Claude/Codex,
    /// a fake Jira MCP server, a fake `gh`, and a temp repository with a local
    /// `origin`. Each must finish as a new user would run it after "Use
    /// template": the repository chosen, the run form filled in.
    #[cfg(unix)]
    #[tokio::test]
    // Test-only serialization of the process-global `ORCHEVIA_GH_BIN`, as in
    // the engine's fake-gh tests: a single blocking holder, never contended.
    #[allow(clippy::await_holding_lock)]
    async fn builtins_run_end_to_end() {
        use crate::db::{RunStatus, SqliteDb};
        use crate::engine::{CancellationRegistry, Engine};
        use std::os::unix::fs::PermissionsExt;
        use std::path::Path;
        use std::sync::Arc;

        let _gh_guard = crate::github::GH_BIN_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let root = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(root.path()).unwrap();
        let state = root.join("state");
        std::fs::create_dir_all(&state).unwrap();
        let script = |name: &str, body: String| {
            let path = root.join(name);
            std::fs::write(&path, body).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path.to_string_lossy().into_owned()
        };
        let state_dir = state.to_string_lossy();
        // Headless Claude stand-in: the first deep review reports a P1 finding,
        // later reviews say "No P0/P1 issues found.", other steps edit a file.
        let claude = script(
            "claude",
            format!(
                r#"#!/bin/sh
prompt=$(cat)
printf '%s\n' "$prompt" >> {state_dir}/prompts
sid=
next=0
for arg in "$@"; do
  if [ "$next" = 1 ]; then sid=$arg; next=0; fi
  case "$arg" in --resume) next=1;; esac
done
if [ -z "$sid" ]; then
  n=$(cat {state_dir}/sessions 2>/dev/null || echo 0); n=$((n+1)); echo $n > {state_dir}/sessions
  sid=$(printf '00000000-0000-4000-8000-%012d' "$n")
fi
case "$prompt" in
  *"Deep review"*)
    n=$(cat {state_dir}/deep 2>/dev/null || echo 0); n=$((n+1)); echo $n > {state_dir}/deep
    if [ "$n" = 1 ]; then
      text='```finding\nseverity: P1\nfile: src/cart.ts\nline: 2\ntitle: Missing empty-cart check\nexplanation: An empty cart crashes the total.\nfix: Return 0 early.\n```'
    else
      text='No P0/P1 issues found.'
    fi ;;
  *"finding block"*) text='No P0/P1 issues found.' ;;
  *) echo change >> stub-change.txt; text='Done.' ;;
esac
printf '{{"type":"result","subtype":"success","is_error":false,"session_id":"%s","result":"cwd=%s\\n%s"}}\n' "$sid" "$(pwd)" "$text"
"#
            ),
        );
        let gh = script(
            "gh",
            format!(
                r#"#!/bin/sh
case "$1 $2" in
  "pr view")
    if [ "$5" = files ]; then echo '{{"files":[{{"path":"src/cart.ts","additions":3,"deletions":1}}]}}'; exit 0; fi
    echo '{{"number":7,"title":"Fix cart","state":"open","author":{{"login":"bob"}},"headRefName":"fix-cart","baseRefName":"main","headRefOid":"abc","url":"https://github.com/acme/shop/pull/7","isDraft":false,"reviewRequests":[],"labels":[],"reviews":[{{"author":{{"login":"alice"}},"body":"Please handle an empty cart.","submittedAt":"2026-10-01T00:00:00Z"}}],"comments":[]}}' ;;
  "pr diff") printf 'diff --git a/src/cart.ts b/src/cart.ts\n+export const total = 0;\n' ;;
  "pr checkout") echo "Switched to fix-cart" ;;
  "pr create") printf '%s\n' "$@" > {state_dir}/created; echo https://github.com/acme/shop/pull/8 ;;
  "pr list")
    echo '[{{"number":8,"title":"T","state":"open","author":{{"login":"a"}},"headRefName":"dev-1234-cart","baseRefName":"main","headRefOid":"x","url":"u","isDraft":true,"reviewRequests":[],"labels":[]}},{{"number":9,"title":"T","state":"open","author":{{"login":"a"}},"headRefName":"feature/cart","baseRefName":"main","headRefOid":"y","url":"u","isDraft":true,"reviewRequests":[],"labels":[]}}]' ;;
  "pr comment") printf '%s\n' "$@" > {state_dir}/comment; echo commented ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
"#
            ),
        );
        let jira = script(
            "jira-mcp",
            r#"#!/bin/sh
while IFS= read -r line; do
  n=$(printf '%s' "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
  case "$line" in
    *'"method":"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"fake","version":"0"}}}\n' "$n" ;;
    *'"method":"tools/call"'*'"DEV-1234"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"{\\"key\\":\\"DEV-1234\\",\\"summary\\":\\"Cart bug\\"}"}],"isError":false}}\n' "$n" ;;
    *'"method":"tools/call"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"not found"}],"isError":true}}\n' "$n" ;;
  esac
done
"#
            .to_string(),
        );
        std::env::set_var("ORCHEVIA_GH_BIN", &gh);
        // Restore the process-global override even when an assertion fails.
        struct ResetGhBin;
        impl Drop for ResetGhBin {
            fn drop(&mut self) {
                std::env::remove_var("ORCHEVIA_GH_BIN");
            }
        }
        let _reset_gh_bin = ResetGhBin;
        let git = |dir: &Path, args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(dir)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };

        let db = Arc::new(SqliteDb::open_in_memory().unwrap());
        let engine = Engine::new(Arc::clone(&db), CancellationRegistry::default());
        let profile: crate::agents::AgentProfile = serde_json::from_value(serde_json::json!({
            "id": "stub", "name": "Stub Claude", "adapter": "claude", "executable": claude,
            "extraArgs": [], "workingDirMode": "node", "defaultTimeoutSecs": 60
        }))
        .unwrap();
        db.upsert_agent_profile(&profile).unwrap();
        db.upsert_mcp_server(&crate::mcp::McpServerConfig {
            id: "jira".into(),
            name: "Jira".into(),
            command: jira,
            args: vec![],
            enabled: true,
        })
        .unwrap();
        let roles: HashMap<String, String> =
            ["planning", "implementation", "fastReview", "deepReview"]
                .iter()
                .map(|r| ((*r).to_string(), "stub".to_string()))
                .collect();

        for template in builtin_templates() {
            for entry in std::fs::read_dir(&state).unwrap() {
                std::fs::remove_file(entry.unwrap().path()).unwrap();
            }
            let case = root.join(&template.id);
            let remote = case.join("remote.git");
            let repo = case.join("repo");
            std::fs::create_dir_all(&repo).unwrap();
            git(&case, &["init", "-q", "--bare", "-b", "main", "remote.git"]);
            git(&repo, &["init", "-q", "-b", "main"]);
            git(&repo, &["config", "user.email", "test@example.com"]);
            git(&repo, &["config", "user.name", "Test"]);
            std::fs::create_dir_all(repo.join("src")).unwrap();
            std::fs::write(repo.join("src/cart.ts"), "export const total = 1;\n").unwrap();
            git(&repo, &["add", "."]);
            git(&repo, &["commit", "-qm", "init"]);
            git(
                &repo,
                &["remote", "add", "origin", &remote.to_string_lossy()],
            );
            git(&repo, &["push", "-q", "origin", "main"]);
            git(&repo, &["checkout", "-qb", "feature/cart"]);
            std::fs::write(repo.join("src/cart.ts"), "export const total = 2;\n").unwrap();
            git(&repo, &["commit", "-qam", "Cart total"]);
            git(&repo, &["checkout", "-q", "main"]);

            // What "Use template" does: repository default, MCP server pick.
            let mut workflow = instantiate(&template, &roles, false).unwrap().workflow;
            workflow.defaults = Some(crate::workflow::WorkflowDefaults {
                repo_dir: Some(repo.to_string_lossy().into_owned()),
                branch: None,
            });
            for node in &mut workflow.nodes {
                if node.kind == NodeKind::Ticket {
                    node.config.mcp_server_id = Some("jira".into());
                }
                // Command steps call `gh` from PATH; point them at the fake.
                if node.config.executable.as_deref() == Some("gh") {
                    node.config.executable = Some(gh.clone());
                }
            }
            assert!(
                validate_workflow(&workflow)
                    .iter()
                    .all(|i| i.severity != crate::workflow::ValidationSeverity::Error),
                "{}: {:?}",
                template.id,
                validate_workflow(&workflow)
            );
            let inputs: HashMap<String, String> = [
                ("task", "Add a cart total"),
                ("testCommand", "true"),
                ("installCommand", "true"),
                ("prNumber", "7"),
                ("bug", "The cart total is negative"),
                ("target", "Split src/cart.ts"),
                ("dependency", "lodash to 4.17.21"),
                (
                    "branch",
                    if template.id == "create-draft-pr" {
                        "feature/cart"
                    } else {
                        "dev-1234-cart"
                    },
                ),
                ("title", "Cart total"),
                ("ticket", "https://acme.atlassian.net/browse/DEV-1234"),
            ]
            .into_iter()
            .filter(|(name, _)| workflow.inputs.iter().any(|i| i.name == *name))
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
            let run_id = format!("run-{}", template.id);
            db.upsert_workflow(&workflow).unwrap();
            engine.start_run(&workflow, &run_id, &inputs).unwrap();
            engine.execute(workflow.clone(), run_id.clone()).await;
            for _ in 0..4 {
                if db.get_run(&run_id).unwrap().unwrap().status != RunStatus::Paused {
                    break;
                }
                engine
                    .approve_run(&run_id, true, None, workflow.clone())
                    .await
                    .unwrap();
            }
            let rows = db.list_node_results(&run_id).unwrap();
            let summary: Vec<String> = rows
                .iter()
                .map(|r| {
                    format!(
                        "{} {} {}",
                        r.node_id,
                        r.status,
                        r.error.clone().unwrap_or_default()
                    )
                })
                .collect();
            assert_eq!(
                db.get_run(&run_id).unwrap().unwrap().status,
                RunStatus::Succeeded,
                "{}: {summary:#?}",
                template.id
            );
            let agents: Vec<&str> = workflow
                .nodes
                .iter()
                .filter(|n| n.kind == NodeKind::Agent)
                .map(|n| n.id.as_str())
                .collect();
            for row in rows
                .iter()
                .filter(|r| r.status == "succeeded" && agents.contains(&r.node_id.as_str()))
            {
                assert!(
                    row.stdout
                        .starts_with(&format!("cwd={}", repo.to_string_lossy())),
                    "{} {} ran outside the repository: {}",
                    template.id,
                    row.node_id,
                    row.stdout
                );
            }
            let visits = |id: &str| {
                rows.iter()
                    .filter(|r| r.node_id == id && r.status == "succeeded")
                    .count()
            };
            match template.id.as_str() {
                "ticket-to-pr" => {
                    let prompts = std::fs::read_to_string(state.join("prompts")).unwrap();
                    assert!(
                        prompts.contains("Implement DEV-1234: Cart bug"),
                        "{prompts}"
                    );
                    // One fix round: Codex's P1 is fixed, both reviewers re-review.
                    assert_eq!(
                        (visits("fix"), visits("rev_deep"), visits("rev_fast")),
                        (1, 2, 2)
                    );
                    assert_eq!(
                        git(&remote, &["log", "-1", "--format=%s", "dev-1234-cart"]),
                        "DEV-1234: Cart bug"
                    );
                    let created = std::fs::read_to_string(state.join("created")).unwrap();
                    for arg in [
                        "DEV-1234: Cart bug",
                        "--base\nmain",
                        "--head\ndev-1234-cart",
                        "--draft",
                    ] {
                        assert!(created.contains(arg), "{arg}: {created}");
                    }
                }
                "create-draft-pr" => {
                    assert_eq!(
                        git(&remote, &["log", "-1", "--format=%s", "feature/cart"]),
                        "Cart total"
                    );
                    let created = std::fs::read_to_string(state.join("created")).unwrap();
                    assert!(created.contains("--title\nCart total"), "{created}");
                }
                "review-pr" => {
                    let comment = std::fs::read_to_string(state.join("comment")).unwrap();
                    assert!(comment.starts_with("pr\ncomment\n7\n"), "{comment}");
                    assert!(comment.contains("Missing empty-cart check"), "{comment}");
                }
                "multi-agent-review" => assert_eq!(visits("triage"), 0),
                "watch-feedback" => {
                    assert_eq!(visits("fix"), 0);
                    // The PR's review feedback reaches the agent that addresses it.
                    let prompts = std::fs::read_to_string(state.join("prompts")).unwrap();
                    assert!(
                        prompts.contains("Please handle an empty cart."),
                        "{prompts}"
                    );
                }
                _ => {}
            }
        }
    }

    #[test]
    fn browser_template_fixture_matches_core() {
        let mirrored: Vec<Template> =
            serde_json::from_str(include_str!("../../../src/lib/builtin-templates.json")).unwrap();
        assert_eq!(mirrored, builtin_templates());
    }

    #[test]
    fn builtin_test_steps_use_required_command_input() {
        for template in builtin_templates() {
            let tests: Vec<_> = template
                .workflow
                .nodes
                .iter()
                .filter(|node| {
                    node.kind == NodeKind::Command
                        && node
                            .label
                            .as_deref()
                            .unwrap_or("")
                            .to_lowercase()
                            .contains("test")
                })
                .collect();
            if tests.is_empty() {
                continue;
            }
            assert_eq!(
                template
                    .workflow
                    .inputs
                    .iter()
                    .filter(|i| i.name == "testCommand")
                    .count(),
                1
            );
            let input = template
                .workflow
                .inputs
                .iter()
                .find(|i| i.name == "testCommand")
                .unwrap();
            assert!(input.required && input.default.is_none());
            for node in tests {
                assert_eq!(node.config.executable.as_deref(), Some("sh"));
                assert_eq!(node.config.args, vec!["-c", "{{input.testCommand}}"]);
            }
        }
    }

    #[test]
    fn explicit_profile_survives_template_role_defaults() {
        let mut t = builtin_templates().remove(0);
        t.workflow.nodes[1].config.agent_profile_id = Some("explicit-reviewer".into());
        let cloned = instantiate(&t, &roles(), true).unwrap();
        assert_eq!(
            cloned.workflow.nodes[1].config.agent_profile_id.as_deref(),
            Some("explicit-reviewer")
        );
    }

    #[test]
    fn repeated_instantiation_creates_independent_clones() {
        let template = builtin_templates().remove(0);
        let first = instantiate(&template, &roles(), true).unwrap().workflow;
        let second = instantiate(&template, &roles(), true).unwrap().workflow;
        assert_ne!(first.id, second.id);
        assert_ne!(first.nodes[0].id, second.nodes[0].id);
    }

    #[test]
    fn instantiated_references_follow_new_ids() {
        let mut t = builtin_templates().remove(0);
        t.workflow.nodes[1].config.prompt = Some("Read {{node.start.output}}".into());
        t.workflow.nodes[1].config.input_refs = vec!["start".into()];
        let cloned = instantiate(&t, &roles(), true).unwrap();
        let start_id = &cloned.workflow.nodes[0].id;
        assert_eq!(
            cloned.workflow.nodes[1].config.prompt,
            Some(format!("Read {{{{node.{start_id}.output}}}}"))
        );
        assert_eq!(
            cloned.workflow.nodes[1].config.input_refs,
            vec![start_id.clone()]
        );
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
