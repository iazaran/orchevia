//! Workflow domain model: serializable, versioned, canvas-independent.
//!
//! The persisted workflow definition is the source of truth. Visual positions
//! are stored alongside nodes but execution semantics depend only on the
//! graph (nodes + edges), never on coordinates.

use serde::{Deserialize, Serialize};

/// Current workflow schema version. Bump when making breaking changes and
/// add a migration in [`migrate_workflow_json`].
pub const CURRENT_SCHEMA_VERSION: u32 = 6;

/// Upper bound for any node/profile timeout (12 h). Long AI implementations
/// need hours; the bound still guarantees termination. Per-node
/// `extend_on_output` additionally slides the deadline while output flows.
pub const MAX_TIMEOUT_SECS: u64 = 43_200;

/// A workflow definition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub edges: Vec<Edge>,
    /// Typed workflow inputs available as `{{input.<name>}}` (Milestone 3).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inputs: Vec<WorkflowInput>,
    /// Workflow-level defaults so Git/GitHub nodes don't repeat the same
    /// repository and branch on every node. Node config always wins when set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defaults: Option<WorkflowDefaults>,
}

/// Repository/branch defaults shared by a workflow's Git/GitHub nodes.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// A declared workflow input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowInput {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    #[serde(default)]
    pub required: bool,
}

/// A single node in the workflow graph.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: NodeKind,
    #[serde(default)]
    pub position: Position,
    #[serde(default)]
    pub config: NodeConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// Supported node kinds: Start/Command/Approval/End (M1), Agent (M2),
/// Condition (M3), Git/GitHub/Ticket/Mcp integrations (M4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    Start,
    Command,
    Approval,
    Agent,
    Condition,
    Git,
    /// Canonical JSON is `gitHub` (camelCase); `github` is accepted for the
    /// TypeScript frontend and older payloads.
    #[serde(alias = "github")]
    GitHub,
    Ticket,
    Mcp,
    End,
}

/// Canvas position. Execution never depends on this.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}

/// Per-kind configuration.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    // -- AI Agent node (Milestone 2) -------------------------------------
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_profile_id: Option<String>,
    /// Logical role (`planning`, `implementation`, …) resolved to a profile
    /// at instantiation (templates/proposals, Milestone 6). Never executed
    /// raw: compile roles before running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Node ids whose outputs are exposed as `{{node.<id>.output}}` plus
    /// their raw stdout under `{{node.<id>}}`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
    /// When true, the timeout counts from the last stdout/stderr output
    /// instead of node start ("AI is working, not hanging"): each chunk of
    /// output restarts the countdown, up to MAX_TIMEOUT_SECS total.
    #[serde(default)]
    pub extend_on_output: bool,
    // -- Advanced engine (Milestone 3) -----------------------------------
    /// Bounded retry policy for Command/Agent nodes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<RetryPolicy>,
    /// How many times this node may execute in one run (loop support).
    /// Default 1; nodes on a cycle must set >= 2 (explicit bound).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_visits: Option<u32>,
    /// Condition expression for Condition nodes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<ConditionConfig>,
    // -- Integrations (Milestone 4) --------------------------------------
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_op: Option<GitOp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub github_op: Option<GitHubOp>,
    /// Ticket key template (`{{…}}` allowed) for Ticket nodes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ticket_key: Option<String>,
    /// MCP server id for Ticket/Mcp nodes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_server_id: Option<String>,
    /// MCP tool name for Mcp nodes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_tool: Option<String>,
    /// MCP string arguments (values are `{{…}}` templates) for Mcp nodes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_args: Option<std::collections::HashMap<String, String>>,
}

/// A Git repository operation (all arg-based, lossy states refused).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum GitOp {
    Status,
    DiffSummary,
    BranchCreate {
        name: String,
    },
    Checkout {
        name: String,
        #[serde(default, rename = "allowDirty", alias = "allow_dirty")]
        allow_dirty: bool,
    },
    Stage {
        #[serde(default)]
        paths: Vec<String>,
    },
    Commit {
        message: String,
    },
    WorktreeAdd {
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
    },
    WorktreeRemove {
        path: String,
    },
    WorktreeList,
    Remotes,
}

/// A GitHub operation via the local `gh` CLI (user's own auth).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum GitHubOp {
    /// PR for the current branch (succeeds empty-handed when none).
    PrStatus,
    ListPrs {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        state: Option<String>,
    },
    PrDetails {
        number: u64,
    },
    PrFiles {
        number: u64,
    },
    PrChecks {
        number: u64,
    },
    CreatePr {
        title: String,
        #[serde(default)]
        body: String,
        base: String,
        head: String,
        #[serde(default)]
        draft: bool,
    },
    PostComment {
        number: u64,
        body: String,
    },
}

/// Bounded retry policy. Attempt counts are 1-based: `max_attempts: 1` means
/// "run once, never retry".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicy {
    pub max_attempts: u32,
    #[serde(default)]
    pub delay_ms: u64,
    #[serde(default)]
    pub backoff: bool,
}

/// How clauses in a condition combine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConditionLogic {
    And,
    Or,
}

/// Comparison operators for condition clauses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConditionOp {
    Equals,
    /// Accepts `not_equals` (LLMs often emit snake_case in proposals).
    #[serde(alias = "not_equals")]
    NotEquals,
    Contains,
    /// Accepts `not_contains` (same reason as above).
    #[serde(alias = "not_contains")]
    NotContains,
    Greater,
    Less,
    /// Accepts `greater_or_equal`.
    #[serde(alias = "greater_or_equal")]
    GreaterOrEqual,
    /// Accepts `less_or_equal`.
    #[serde(alias = "less_or_equal")]
    LessOrEqual,
}

impl ConditionOp {
    /// Parse operator text (`==`, `!=`, `contains`, `not contains`, ...).
    pub fn parse(text: &str) -> Option<Self> {
        match text.to_ascii_lowercase().as_str() {
            "==" | "=" | "eq" | "equals" => Some(ConditionOp::Equals),
            "!=" | "<>" | "ne" => Some(ConditionOp::NotEquals),
            "contains" => Some(ConditionOp::Contains),
            "not contains" | "!contains" | "notcontains" => Some(ConditionOp::NotContains),
            ">" | "gt" => Some(ConditionOp::Greater),
            "<" | "lt" => Some(ConditionOp::Less),
            ">=" | "gte" => Some(ConditionOp::GreaterOrEqual),
            "<=" | "lte" => Some(ConditionOp::LessOrEqual),
            _ => None,
        }
    }

    pub fn symbol(self) -> &'static str {
        match self {
            ConditionOp::Equals => "==",
            ConditionOp::NotEquals => "!=",
            ConditionOp::Contains => "contains",
            ConditionOp::NotContains => "not contains",
            ConditionOp::Greater => ">",
            ConditionOp::Less => "<",
            ConditionOp::GreaterOrEqual => ">=",
            ConditionOp::LessOrEqual => "<=",
        }
    }
}

/// One `<variable> <operator> <literal>` comparison.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionClause {
    pub left: String,
    pub op: ConditionOp,
    pub right: String,
}

/// A small boolean formula over run variables (no scripting, no eval).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConditionConfig {
    pub logic: ConditionLogic,
    #[serde(default)]
    pub clauses: Vec<ConditionClause>,
}

/// A directed edge between two nodes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ValidationSeverity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub code: String,
    pub message: String,
    pub severity: ValidationSeverity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
}

impl Workflow {
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: id.into(),
            name: name.into(),
            nodes: Vec::new(),
            edges: Vec::new(),
            inputs: Vec::new(),
            defaults: None,
        }
    }

    /// Parse from JSON, applying migrations for older schema versions.
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        let mut wf: Workflow = serde_json::from_str(json)?;
        migrate_workflow(&mut wf);
        Ok(wf)
    }

    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }
}

/// Apply forward migrations so older persisted workflows load.
fn migrate_workflow(wf: &mut Workflow) {
    if wf.schema_version == 0 {
        wf.schema_version = 1;
    }
    if wf.schema_version == 1 {
        // v1 -> v2: Agent node fields are all optional with defaults, so no
        // data rewrite is needed; just bump the version marker.
        wf.schema_version = 2;
    }
    if wf.schema_version == 2 {
        // v2 -> v3: Condition/retry/inputs/max_visits fields all default, and
        // `inputs` defaults to empty. Bump only.
        wf.schema_version = 3;
    }
    if wf.schema_version == 3 {
        // v3 -> v4: Git/GitHub/Ticket/Mcp node kinds + op configs, all
        // optional with defaults. Bump only.
        wf.schema_version = 4;
    }
    if wf.schema_version == 4 {
        // v4 -> v5: `agent_role` is optional with a default. Bump only.
        wf.schema_version = 5;
    }
    if wf.schema_version == 5 {
        // v5 -> v6: workflow-level `defaults` (repo_dir/branch) are optional.
        // Bump only.
        wf.schema_version = 6;
    }
    // Future migrations go here, guarded by `if wf.schema_version < N`.
}

/// Routing meaning of an edge label.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeKind {
    /// Taken when the source succeeds (default for unlabeled edges).
    Success,
    /// Taken when the source fails.
    Failure,
    /// Taken when a Condition evaluates to true.
    TrueBranch,
    /// Taken when a Condition evaluates to false.
    FalseBranch,
    /// Unrecognized label: treated as Success, flagged by validation.
    Unknown,
}

/// Classify an edge label (case-insensitive, trimmed).
pub fn classify_edge_label(label: Option<&str>) -> EdgeKind {
    match label.unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "" | "success" | "ok" | "on success" | "default" => EdgeKind::Success,
        "failure" | "fail" | "error" | "on failure" | "on error" => EdgeKind::Failure,
        "true" | "yes" | "on true" => EdgeKind::TrueBranch,
        "false" | "no" | "on false" => EdgeKind::FalseBranch,
        _ => EdgeKind::Unknown,
    }
}

/// Find loop-back edges: edges whose target is an ancestor in a DFS walk
/// from Start. Loop edges are excluded from join readiness counts and may
/// only re-trigger nodes with `max_visits >= 2`. Returns edge ids.
pub fn find_loop_edges(wf: &Workflow) -> std::collections::HashSet<String> {
    let mut loop_edges = std::collections::HashSet::new();
    let Some(start) = wf.nodes.iter().find(|n| n.kind == NodeKind::Start) else {
        return loop_edges;
    };
    let mut outgoing: std::collections::HashMap<&str, Vec<&Edge>> =
        std::collections::HashMap::new();
    for edge in &wf.edges {
        outgoing.entry(edge.source.as_str()).or_default().push(edge);
    }
    // Iterative DFS with an explicit on-stack set for back-edge detection.
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut on_stack: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut stack: Vec<(&str, usize)> = vec![(start.id.as_str(), 0)];
    on_stack.insert(start.id.clone());
    while let Some((node_id, child_idx)) = stack.pop() {
        let children = outgoing.get(node_id).cloned().unwrap_or_default();
        if child_idx < children.len() {
            stack.push((node_id, child_idx + 1));
            let edge = children[child_idx];
            if on_stack.contains(edge.target.as_str()) {
                loop_edges.insert(edge.id.clone());
            } else if visited.insert(edge.target.clone()) {
                on_stack.insert(edge.target.clone());
                // Leak-free: target ids live in `wf`; find the &str slice.
                let target: &str = wf
                    .nodes
                    .iter()
                    .find(|n| n.id == edge.target)
                    .map(|n| n.id.as_str())
                    .unwrap_or(edge.target.as_str());
                stack.push((target, 0));
            }
        } else {
            on_stack.remove(node_id);
        }
    }
    loop_edges
}

/// Nodes reachable from `from` following outgoing edges (including `from`).
pub fn reachable_from(wf: &Workflow, from: &str) -> std::collections::HashSet<String> {
    let mut seen = std::collections::HashSet::new();
    let mut stack = vec![from.to_string()];
    while let Some(current) = stack.pop() {
        if !seen.insert(current.clone()) {
            continue;
        }
        for edge in wf.edges.iter().filter(|e| e.source == current) {
            stack.push(edge.target.clone());
        }
    }
    seen
}

/// Whether `target` is reachable from `from`.
pub fn can_reach(wf: &Workflow, from: &str, target: &str) -> bool {
    reachable_from(wf, from).contains(target)
}

/// Well-known agent roles for templates, proposals, and role defaults.
pub fn well_known_roles() -> Vec<String> {
    vec![
        "planning".to_string(),
        "implementation".to_string(),
        "fastReview".to_string(),
        "deepReview".to_string(),
        "workflowGenerator".to_string(),
    ]
}

pub fn is_known_role(role: &str) -> bool {
    well_known_roles().iter().any(|r| r == role)
}

/// Resolve logical `agent_role`s to concrete profile ids. Returns the
/// resolved workflow plus the list of roles that had no mapping (caller
/// surfaces them as validation-grade errors, never silent).
pub fn resolve_agent_roles(
    workflow: &Workflow,
    role_map: &std::collections::HashMap<String, String>,
) -> (Workflow, Vec<String>) {
    let mut resolved = workflow.clone();
    let mut unmapped = Vec::new();
    for node in resolved
        .nodes
        .iter_mut()
        .filter(|n| n.kind == NodeKind::Agent)
    {
        if let Some(role) = node.config.agent_role.clone() {
            match role_map.get(&role) {
                Some(profile_id) => {
                    node.config.agent_profile_id = Some(profile_id.clone());
                    node.config.agent_role = None;
                }
                None => {
                    if !unmapped.contains(&role) {
                        unmapped.push(role);
                    }
                }
            }
        }
    }
    unmapped.sort();
    (resolved, unmapped)
}

/// A name is valid for workflow inputs: 1-64 chars of letters/digits/`_`/`-`,
/// starting with a letter or underscore.
pub fn is_valid_input_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Validate a workflow before execution. Returns issues (errors + warnings).
/// Execution is allowed only when no `Error` issues exist.
pub fn validate_workflow(wf: &Workflow) -> Vec<ValidationIssue> {
    let mut issues = Vec::new();

    if wf.schema_version > CURRENT_SCHEMA_VERSION {
        push_error(
            &mut issues,
            "schema-too-new",
            format!(
                "Workflow schema v{} is newer than supported v{}. Please update Orchevia.",
                wf.schema_version, CURRENT_SCHEMA_VERSION
            ),
            None,
        );
        return issues;
    }

    if wf.name.trim().is_empty() {
        push_error(
            &mut issues,
            "name-required",
            "Workflow name must not be empty.".to_string(),
            None,
        );
    }

    let starts: Vec<&Node> = wf
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Start)
        .collect();
    let ends: Vec<&Node> = wf
        .nodes
        .iter()
        .filter(|n| n.kind == NodeKind::End)
        .collect();
    if starts.len() != 1 {
        push_error(
            &mut issues,
            "single-start",
            format!(
                "Workflow must have exactly one Start node, found {}.",
                starts.len()
            ),
            None,
        );
    }
    if ends.is_empty() {
        push_error(
            &mut issues,
            "end-required",
            "Workflow must have at least one End node.".to_string(),
            None,
        );
    }

    let node_ids: std::collections::HashSet<&str> =
        wf.nodes.iter().map(|n| n.id.as_str()).collect();
    for edge in &wf.edges {
        if !node_ids.contains(edge.source.as_str()) {
            push_error(
                &mut issues,
                "edge-unknown-source",
                format!(
                    "Edge '{}' references unknown source node '{}'.",
                    edge.id, edge.source
                ),
                None,
            );
        }
        if !node_ids.contains(edge.target.as_str()) {
            push_error(
                &mut issues,
                "edge-unknown-target",
                format!(
                    "Edge '{}' references unknown target node '{}'.",
                    edge.id, edge.target
                ),
                None,
            );
        }
        if edge.source == edge.target {
            push_error(
                &mut issues,
                "edge-self-loop",
                format!("Edge '{}' connects a node to itself.", edge.id),
                Some(edge.source.clone()),
            );
        }
    }

    // Node-level config checks.
    for node in &wf.nodes {
        match node.kind {
            NodeKind::Command => {
                let exe = node.config.executable.as_deref().unwrap_or("").trim();
                if exe.is_empty() {
                    push_error(
                        &mut issues,
                        "command-executable-required",
                        "Command node requires an executable.".to_string(),
                        Some(node.id.clone()),
                    );
                } else if exe == "compose" {
                    push_warning(
                        &mut issues,
                        "command-executable-suspicious",
                        "`compose` is not a standalone tool here — use executable `docker` with args starting `compose` (or the `docker-compose` binary).".to_string(),
                        Some(node.id.clone()),
                    );
                }
                if let Some(t) = node.config.timeout_secs {
                    if !(1..=MAX_TIMEOUT_SECS).contains(&t) {
                        push_error(
                            &mut issues,
                            "command-timeout-invalid",
                            "Command timeout must be between 1 second and 12 hours (43200)."
                                .to_string(),
                            Some(node.id.clone()),
                        );
                    }
                }
                validate_retry(node, &mut issues);
                validate_max_visits(node, &mut issues);
            }
            NodeKind::Agent => {
                let profile = node.config.agent_profile_id.as_deref().unwrap_or("").trim();
                let role = node.config.agent_role.as_deref().unwrap_or("").trim();
                if profile.is_empty() && role.is_empty() {
                    push_error(
                        &mut issues,
                        "agent-profile-required",
                        "AI Agent node requires an Agent Profile (or a role for templates/proposals).".to_string(),
                        Some(node.id.clone()),
                    );
                }
                if !role.is_empty() && !is_known_role(role) {
                    push_warning(
                        &mut issues,
                        "agent-role-unknown",
                        format!("Agent role '{role}' is not a well-known role; resolve it before running."),
                        Some(node.id.clone()),
                    );
                }
                let prompt = node.config.prompt.as_deref().unwrap_or("").trim();
                if prompt.is_empty() {
                    push_error(
                        &mut issues,
                        "agent-prompt-required",
                        "AI Agent node requires a prompt/instruction.".to_string(),
                        Some(node.id.clone()),
                    );
                }
                if let Some(t) = node.config.timeout_secs {
                    if !(1..=MAX_TIMEOUT_SECS).contains(&t) {
                        push_error(
                            &mut issues,
                            "agent-timeout-invalid",
                            "AI Agent timeout must be between 1 second and 12 hours (43200)."
                                .to_string(),
                            Some(node.id.clone()),
                        );
                    }
                }
                for input in &node.config.input_refs {
                    if !node_ids.contains(input.as_str()) {
                        push_error(
                            &mut issues,
                            "agent-input-unknown",
                            format!("AI Agent node references unknown node '{input}'."),
                            Some(node.id.clone()),
                        );
                    }
                }
                validate_retry(node, &mut issues);
                validate_max_visits(node, &mut issues);
            }
            NodeKind::Condition => {
                match node.config.condition.as_ref() {
                    None => push_error(
                        &mut issues,
                        "condition-required",
                        "Condition node requires a condition expression.".to_string(),
                        Some(node.id.clone()),
                    ),
                    Some(condition) => {
                        if condition.clauses.is_empty() {
                            push_error(
                                &mut issues,
                                "condition-required",
                                "Condition node requires at least one clause.".to_string(),
                                Some(node.id.clone()),
                            );
                        }
                        for clause in &condition.clauses {
                            if let Err(message) = check_variable_ref(wf, &clause.left, &node_ids) {
                                push_error(
                                    &mut issues,
                                    "condition-unknown-ref",
                                    format!("Condition references unknown variable: {message}"),
                                    Some(node.id.clone()),
                                );
                            }
                        }
                        // Branch edges: exactly one true + one false outgoing.
                        let outs: Vec<&Edge> =
                            wf.edges.iter().filter(|e| e.source == node.id).collect();
                        let has_true = outs.iter().any(|e| {
                            classify_edge_label(e.label.as_deref()) == EdgeKind::TrueBranch
                        });
                        let has_false = outs.iter().any(|e| {
                            classify_edge_label(e.label.as_deref()) == EdgeKind::FalseBranch
                        });
                        if !has_true || !has_false {
                            push_error(
                                &mut issues,
                                "condition-branches-required",
                                "Condition node needs one 'true' and one 'false' outgoing edge (labels).".to_string(),
                                Some(node.id.clone()),
                            );
                        }
                    }
                }
                validate_max_visits(node, &mut issues);
            }
            NodeKind::Start | NodeKind::End | NodeKind::Approval => {
                validate_max_visits(node, &mut issues);
            }
            NodeKind::Git => {
                match node.config.git_op.as_ref() {
                    None => push_error(
                        &mut issues,
                        "git-op-required",
                        "Git node requires an operation.".to_string(),
                        Some(node.id.clone()),
                    ),
                    Some(op) => validate_git_op(node, op, &mut issues),
                }
                if node
                    .config
                    .working_dir
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                    && wf
                        .defaults
                        .as_ref()
                        .and_then(|d| d.repo_dir.as_deref())
                        .unwrap_or("")
                        .trim()
                        .is_empty()
                {
                    push_error(
                        &mut issues,
                        "git-dir-required",
                        "Git node requires a working directory: set it on the node or set a workflow default (select the canvas background to edit Workflow settings).".to_string(),
                        Some(node.id.clone()),
                    );
                }
                validate_max_visits(node, &mut issues);
            }
            NodeKind::GitHub => {
                match node.config.github_op.as_ref() {
                    None => push_error(
                        &mut issues,
                        "github-op-required",
                        "GitHub node requires an operation.".to_string(),
                        Some(node.id.clone()),
                    ),
                    Some(op) => validate_github_op(node, op, &mut issues),
                }
                if node
                    .config
                    .working_dir
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                    && wf
                        .defaults
                        .as_ref()
                        .and_then(|d| d.repo_dir.as_deref())
                        .unwrap_or("")
                        .trim()
                        .is_empty()
                {
                    push_error(
                        &mut issues,
                        "git-dir-required",
                        "GitHub node requires a working directory: set it on the node or set a workflow default (select the canvas background to edit Workflow settings).".to_string(),
                        Some(node.id.clone()),
                    );
                }
                validate_max_visits(node, &mut issues);
            }
            NodeKind::Ticket => {
                if node
                    .config
                    .ticket_key
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    push_error(
                        &mut issues,
                        "ticket-key-required",
                        "Ticket node requires a ticket key ({{…}} templates allowed).".to_string(),
                        Some(node.id.clone()),
                    );
                }
                if node
                    .config
                    .mcp_server_id
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    push_error(
                        &mut issues,
                        "ticket-server-required",
                        "Ticket node requires an MCP server (Jira source).".to_string(),
                        Some(node.id.clone()),
                    );
                }
                validate_max_visits(node, &mut issues);
            }
            NodeKind::Mcp => {
                if node
                    .config
                    .mcp_server_id
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    push_error(
                        &mut issues,
                        "mcp-server-required",
                        "MCP node requires a server.".to_string(),
                        Some(node.id.clone()),
                    );
                }
                if node
                    .config
                    .mcp_tool
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .is_empty()
                {
                    push_error(
                        &mut issues,
                        "mcp-tool-required",
                        "MCP node requires a tool name.".to_string(),
                        Some(node.id.clone()),
                    );
                }
                validate_max_visits(node, &mut issues);
            }
        }
        // Prompt template variable references (agent nodes).
        if node.kind == NodeKind::Agent {
            if let Some(template) = node.config.prompt.as_deref() {
                for name in crate::prompt::referenced_variables(template) {
                    if let Err(message) = check_variable_ref(wf, &name, &node_ids) {
                        push_error(
                            &mut issues,
                            "prompt-unknown-variable",
                            format!("Prompt references unknown variable: {message}"),
                            Some(node.id.clone()),
                        );
                    }
                }
            }
        }
    }

    // Workflow inputs: names valid + unique.
    {
        let mut seen_inputs = std::collections::HashSet::new();
        for input in &wf.inputs {
            if !is_valid_input_name(&input.name) {
                push_error(
                    &mut issues,
                    "input-name-invalid",
                    format!(
                        "Input name '{}' must start with a letter/underscore and hold letters, digits, '_' or '-'.",
                        input.name
                    ),
                    None,
                );
            }
            if !seen_inputs.insert(input.name.clone()) {
                push_error(
                    &mut issues,
                    "input-duplicate",
                    format!("Duplicate workflow input '{}'.", input.name),
                    None,
                );
            }
        }
    }

    // Edge labels: true/false only make sense on Condition outputs; unknown
    // labels warn (treated as success at runtime).
    {
        let by_id: std::collections::HashMap<&str, &Node> =
            wf.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
        for edge in &wf.edges {
            let kind = classify_edge_label(edge.label.as_deref());
            if kind == EdgeKind::Unknown {
                push_warning(
                    &mut issues,
                    "edge-label-unknown",
                    format!(
                        "Edge '{}' has an unrecognized label '{}'; it will behave as a success edge.",
                        edge.id,
                        edge.label.as_deref().unwrap_or("")
                    ),
                    None,
                );
                continue;
            }
            if matches!(kind, EdgeKind::TrueBranch | EdgeKind::FalseBranch) {
                let source_kind = by_id.get(edge.source.as_str()).map(|n| n.kind);
                if source_kind != Some(NodeKind::Condition) {
                    push_error(
                        &mut issues,
                        "edge-label-misplaced",
                        format!(
                            "Edge '{}' uses a true/false label but its source is not a Condition node.",
                            edge.id
                        ),
                        None,
                    );
                }
            }
        }
    }

    // Cycles: every loop-back edge must pass through a Condition (loop guard)
    // and every node on the cycle needs an explicit bound (max_visits >= 2).
    {
        let loop_edges = find_loop_edges(wf);
        let by_id: std::collections::HashMap<&str, &Node> =
            wf.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
        for edge in wf.edges.iter().filter(|e| loop_edges.contains(&e.id)) {
            // Nodes on this cycle: reachable from target AND able to reach source.
            let from_target = reachable_from(wf, &edge.target);
            let cycle_nodes: Vec<&Node> = wf
                .nodes
                .iter()
                .filter(|n| from_target.contains(&n.id) && can_reach(wf, &n.id, &edge.source))
                .collect();
            if !cycle_nodes.iter().any(|n| n.kind == NodeKind::Condition) {
                push_error(
                    &mut issues,
                    "cycle-needs-condition",
                    format!(
                        "Cycle through edge '{}' has no Condition node to guard it; loops must branch on a Condition.",
                        edge.id
                    ),
                    Some(edge.source.clone()),
                );
            }
            for node in cycle_nodes {
                if node.config.max_visits.unwrap_or(1) < 2 {
                    push_error(
                        &mut issues,
                        "cycle-unbounded",
                        format!(
                            "Node '{}' is on a cycle but has no explicit loop bound (set max visits >= 2).",
                            node_label(node)
                        ),
                        Some(node.id.clone()),
                    );
                }
            }
        }
        // Loop edges into End nodes make no sense (End terminates).
        for edge in wf.edges.iter().filter(|e| loop_edges.contains(&e.id)) {
            if by_id.get(edge.target.as_str()).map(|n| n.kind) == Some(NodeKind::End) {
                push_error(
                    &mut issues,
                    "cycle-into-end",
                    format!(
                        "Loop edge '{}' targets an End node, which terminates the run.",
                        edge.id
                    ),
                    Some(edge.target.clone()),
                );
            }
        }
    }

    // Reachability: nodes unreachable from Start produce warnings.
    if starts.len() == 1 {
        // `starts[0]` is safe: length checked above.
        let start_id = starts[0].id.clone();
        let mut reachable = std::collections::HashSet::new();
        let mut stack = vec![start_id.as_str()];
        // Build adjacency.
        let mut outgoing: std::collections::HashMap<&str, Vec<&str>> =
            std::collections::HashMap::new();
        for edge in &wf.edges {
            outgoing
                .entry(edge.source.as_str())
                .or_default()
                .push(edge.target.as_str());
        }
        while let Some(current) = stack.pop() {
            if !reachable.insert(current) {
                continue;
            }
            if let Some(next) = outgoing.get(current) {
                stack.extend(next.iter());
            }
        }
        for node in &wf.nodes {
            if !reachable.contains(node.id.as_str()) {
                push_warning(
                    &mut issues,
                    "unreachable-node",
                    format!(
                        "Node '{}' is unreachable from Start and will not execute.",
                        node_label(node)
                    ),
                    Some(node.id.clone()),
                );
            }
        }
        // Dead-end check: non-End nodes with no outgoing edge.
        for node in &wf.nodes {
            if node.kind == NodeKind::End {
                continue;
            }
            let has_outgoing = wf.edges.iter().any(|e| e.source == node.id);
            if has_outgoing {
                continue;
            }
            // A terminal Approval/Command node is suspicious.
            push_warning(
                &mut issues,
                "dead-end-node",
                format!(
                    "Node '{}' has no outgoing connection; the run will stop there.",
                    node_label(node)
                ),
                Some(node.id.clone()),
            );
        }
    }

    issues
}

fn push_error(
    issues: &mut Vec<ValidationIssue>,
    code: &str,
    message: String,
    node_id: Option<String>,
) {
    issues.push(ValidationIssue {
        code: code.to_string(),
        message,
        severity: ValidationSeverity::Error,
        node_id,
    });
}

fn push_warning(
    issues: &mut Vec<ValidationIssue>,
    code: &str,
    message: String,
    node_id: Option<String>,
) {
    issues.push(ValidationIssue {
        code: code.to_string(),
        message,
        severity: ValidationSeverity::Warning,
        node_id,
    });
}

fn node_label(node: &Node) -> String {
    node.label
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("{:?} ({})", node.kind, node.id))
}

/// Validate per-operation Git fields.
fn validate_git_op(node: &Node, op: &GitOp, issues: &mut Vec<ValidationIssue>) {
    let blank = |s: &str| s.trim().is_empty();
    let mut err = |code: &str, message: String| {
        push_error(issues, code, message, Some(node.id.clone()));
    };
    match op {
        GitOp::Status | GitOp::DiffSummary | GitOp::WorktreeList | GitOp::Remotes => {}
        GitOp::BranchCreate { name } | GitOp::Checkout { name, .. } => {
            if blank(name) {
                err(
                    "git-branch-required",
                    "Git branch operation needs a name.".to_string(),
                );
            } else if let Err(message) = crate::git::validate_branch_name(name) {
                err("git-branch-invalid", message);
            }
        }
        GitOp::Stage { paths } => {
            if paths.iter().all(|p| blank(p)) {
                err(
                    "git-paths-required",
                    "Stage needs at least one explicit path (no implicit -A).".to_string(),
                );
            }
        }
        GitOp::Commit { message } => {
            if blank(message) {
                err(
                    "git-message-required",
                    "Commit needs an explicit message.".to_string(),
                );
            }
        }
        GitOp::WorktreeAdd { path, branch } => {
            if blank(path) {
                err(
                    "git-path-required",
                    "Worktree needs an explicit path.".to_string(),
                );
            }
            if let Some(name) = branch {
                if !blank(name) {
                    if let Err(message) = crate::git::validate_branch_name(name) {
                        err("git-branch-invalid", message);
                    }
                }
            }
        }
        GitOp::WorktreeRemove { path } => {
            if blank(path) {
                err(
                    "git-path-required",
                    "Worktree removal needs an explicit path.".to_string(),
                );
            }
        }
    }
}

/// Validate per-operation GitHub fields.
fn validate_github_op(node: &Node, op: &GitHubOp, issues: &mut Vec<ValidationIssue>) {
    let mut err = |code: &str, message: String| {
        push_error(issues, code, message, Some(node.id.clone()));
    };
    match op {
        GitHubOp::PrStatus
        | GitHubOp::ListPrs { .. }
        | GitHubOp::PrDetails { .. }
        | GitHubOp::PrFiles { .. }
        | GitHubOp::PrChecks { .. } => {}
        GitHubOp::CreatePr {
            title, base, head, ..
        } => {
            if title.trim().is_empty() {
                err(
                    "github-title-required",
                    "PR creation needs an explicit title.".to_string(),
                );
            }
            if base.trim().is_empty() || head.trim().is_empty() {
                err(
                    "github-branches-required",
                    "PR creation needs explicit base and head branches.".to_string(),
                );
            }
        }
        GitHubOp::PostComment { body, .. } => {
            if body.trim().is_empty() {
                err(
                    "github-body-required",
                    "Comments need an explicit body.".to_string(),
                );
            }
        }
    }
}

/// Validate a retry policy: bounded attempts, sane delay.
fn validate_retry(node: &Node, issues: &mut Vec<ValidationIssue>) {
    if let Some(retry) = node.config.retry.as_ref() {
        if !(1..=10).contains(&retry.max_attempts) {
            push_error(
                issues,
                "retry-unbounded",
                "Retry max attempts must be between 1 and 10.".to_string(),
                Some(node.id.clone()),
            );
        }
        if retry.delay_ms > 60_000 {
            push_error(
                issues,
                "retry-delay-invalid",
                "Retry delay must not exceed 60 seconds.".to_string(),
                Some(node.id.clone()),
            );
        }
    }
}

/// Validate the loop bound: 1 (default, no loop) through 100.
fn validate_max_visits(node: &Node, issues: &mut Vec<ValidationIssue>) {
    if let Some(max) = node.config.max_visits {
        if !(1..=100).contains(&max) {
            push_error(
                issues,
                "loop-limit-invalid",
                "Node max visits must be between 1 and 100.".to_string(),
                Some(node.id.clone()),
            );
        }
    }
}

/// Check a `dotted.path` variable reference against workflow inputs, node
/// ids, and the `workflow.*` namespace. Returns `Ok(())` or a description.
fn check_variable_ref(
    wf: &Workflow,
    name: &str,
    node_ids: &std::collections::HashSet<&str>,
) -> Result<(), String> {
    let mut parts = name.split('.');
    match parts.next().unwrap_or("") {
        "workflow" => match parts.next().unwrap_or("") {
            "name" | "id" => Ok(()),
            other => Err(format!("'{name}': workflow has no field '{other}'.")),
        },
        "input" => match parts.next() {
            Some(input) if wf.inputs.iter().any(|i| i.name == input) => Ok(()),
            Some(input) => Err(format!("'{name}': no workflow input '{input}'.")),
            None => Err(format!("'{name}': expected input.<name>.")),
        },
        // Ticket aliases resolve at runtime from the latest ticket result.
        "ticket" => match parts.next() {
            Some("key" | "title" | "description" | "acceptanceCriteria" | "status" | "url") => {
                Ok(())
            }
            Some(field) => Err(format!("'{name}': ticket has no field '{field}'.")),
            None => Err(format!("'{name}': expected ticket.<field>.")),
        },
        "node" => match parts.next() {
            Some(id) if node_ids.contains(id) => match parts.next() {
                None | Some("output" | "status" | "exitCode" | "severity" | "visits") => Ok(()),
                Some(field) => Err(format!("'{name}': node has no field '{field}'.")),
            },
            Some(id) => Err(format!("'{name}': no node '{id}'.")),
            None => Err(format!("'{name}': expected node.<id>[.field].")),
        },
        // Bare single-segment names are legacy shorthand for node outputs.
        other if !name.contains('.') => {
            if node_ids.contains(other) {
                Ok(())
            } else {
                Err(format!(
                    "'{name}': no node, input, or workflow field matches."
                ))
            }
        }
        _ => Err(format!(
            "'{name}': must start with workflow., input., or node.."
        )),
    }
}

/// Compute a deterministic execution order by walking from Start following
/// edges. Milestone 1 supports linear flows: at each step the first outgoing
/// edge (in definition order) is taken. Returns node ids in visit order.
/// Stops at End nodes, dead ends, or cycles (cycle reported as an error).
pub fn plan_execution_order(wf: &Workflow) -> Result<Vec<String>, String> {
    let start = wf
        .nodes
        .iter()
        .find(|n| n.kind == NodeKind::Start)
        .ok_or_else(|| "Workflow has no Start node.".to_string())?;
    let mut order = Vec::new();
    let mut visited = std::collections::HashSet::new();
    let mut current = start.id.clone();
    loop {
        if !visited.insert(current.clone()) {
            return Err(format!("Cycle detected at node '{current}'."));
        }
        order.push(current.clone());
        let node = wf
            .nodes
            .iter()
            .find(|n| n.id == current)
            .ok_or_else(|| format!("Unknown node '{current}'."))?;
        if node.kind == NodeKind::End {
            break;
        }
        let next = wf.edges.iter().find(|e| e.source == current);
        match next {
            Some(edge) => current = edge.target.clone(),
            None => break,
        }
    }
    Ok(order)
}

/// First-run sample: Start → Inspect Environment → Run Command → End.
/// Safe everywhere (`uname`, `echo`), used to seed fresh desktop installs.
pub fn sample_workflow() -> Workflow {
    let node = |id: &str, kind: NodeKind, y: f64, label: &str, config: NodeConfig| Node {
        id: format!("sample-{id}"),
        kind,
        position: Position { x: 80.0, y },
        config,
        label: Some(label.to_string()),
    };
    let edge = |id: &str, source: &str, target: &str| Edge {
        id: format!("sample-{id}"),
        source: format!("sample-{source}"),
        target: format!("sample-{target}"),
        label: None,
    };
    Workflow {
        schema_version: CURRENT_SCHEMA_VERSION,
        id: "wf-sample".to_string(),
        name: "Sample: Environment Check".to_string(),
        inputs: Vec::new(),
        defaults: None,
        nodes: vec![
            node(
                "start",
                NodeKind::Start,
                60.0,
                "Start",
                NodeConfig::default(),
            ),
            node(
                "env",
                NodeKind::Command,
                180.0,
                "Inspect Environment",
                NodeConfig {
                    executable: Some("uname".to_string()),
                    args: vec!["-a".to_string()],
                    ..NodeConfig::default()
                },
            ),
            node(
                "cmd",
                NodeKind::Command,
                300.0,
                "Run Command",
                NodeConfig {
                    executable: Some("echo".to_string()),
                    args: vec!["Hello from Orchevia".to_string()],
                    ..NodeConfig::default()
                },
            ),
            node("end", NodeKind::End, 420.0, "End", NodeConfig::default()),
        ],
        edges: vec![
            edge("e0", "start", "env"),
            edge("e1", "env", "cmd"),
            edge("e2", "cmd", "end"),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn linear_workflow() -> Workflow {
        Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: "wf-1".to_string(),
            name: "Sample".to_string(),
            inputs: Vec::new(),
            defaults: None,
            nodes: vec![
                Node {
                    id: "start".into(),
                    kind: NodeKind::Start,
                    position: Position { x: 0.0, y: 0.0 },
                    config: NodeConfig::default(),
                    label: Some("Start".into()),
                },
                Node {
                    id: "cmd".into(),
                    kind: NodeKind::Command,
                    position: Position { x: 0.0, y: 100.0 },
                    config: NodeConfig {
                        executable: Some("echo".into()),
                        args: vec!["hello".into()],
                        ..NodeConfig::default()
                    },
                    label: Some("Run Command".into()),
                },
                Node {
                    id: "end".into(),
                    kind: NodeKind::End,
                    position: Position { x: 0.0, y: 200.0 },
                    config: NodeConfig::default(),
                    label: Some("End".into()),
                },
            ],
            edges: vec![
                Edge {
                    id: "e1".into(),
                    source: "start".into(),
                    target: "cmd".into(),
                    label: None,
                },
                Edge {
                    id: "e2".into(),
                    source: "cmd".into(),
                    target: "end".into(),
                    label: None,
                },
            ],
        }
    }

    #[test]
    fn valid_workflow_has_no_errors() {
        let wf = linear_workflow();
        let issues = validate_workflow(&wf);
        assert!(
            issues
                .iter()
                .all(|i| i.severity == ValidationSeverity::Warning),
            "unexpected errors: {issues:?}"
        );
    }

    #[test]
    fn missing_start_is_error() {
        let mut wf = linear_workflow();
        wf.nodes.retain(|n| n.kind != NodeKind::Start);
        let issues = validate_workflow(&wf);
        assert!(issues
            .iter()
            .any(|i| i.code == "single-start" && i.severity == ValidationSeverity::Error));
    }

    #[test]
    fn command_without_executable_is_error() {
        let mut wf = linear_workflow();
        wf.nodes
            .iter_mut()
            .find(|n| n.id == "cmd")
            .expect("cmd node")
            .config
            .executable = None;
        let issues = validate_workflow(&wf);
        assert!(issues
            .iter()
            .any(|i| i.code == "command-executable-required"));
    }

    #[test]
    fn unreachable_node_warns() {
        let mut wf = linear_workflow();
        wf.nodes.push(Node {
            id: "orphan".into(),
            kind: NodeKind::Command,
            position: Position::default(),
            config: NodeConfig {
                executable: Some("echo".into()),
                ..NodeConfig::default()
            },
            label: None,
        });
        let issues = validate_workflow(&wf);
        assert!(issues.iter().any(|i| i.code == "unreachable-node"));
    }

    #[test]
    fn execution_order_follows_edges() {
        let wf = linear_workflow();
        assert_eq!(
            plan_execution_order(&wf).expect("order"),
            vec!["start".to_string(), "cmd".to_string(), "end".to_string()]
        );
    }

    #[test]
    fn execution_order_detects_cycle() {
        let mut wf = linear_workflow();
        wf.edges.push(Edge {
            id: "e3".into(),
            source: "cmd".into(),
            target: "start".into(),
            label: None,
        });
        // First outgoing edge from cmd is still e2 (definition order), so walk
        // terminates at end. Replace edges to force the cycle instead.
        wf.edges = vec![
            Edge {
                id: "e1".into(),
                source: "start".into(),
                target: "cmd".into(),
                label: None,
            },
            Edge {
                id: "e3".into(),
                source: "cmd".into(),
                target: "start".into(),
                label: None,
            },
        ];
        assert!(plan_execution_order(&wf).is_err());
    }

    #[test]
    fn serialization_round_trip() {
        let wf = linear_workflow();
        let json = wf.to_json().expect("serialize");
        let parsed = Workflow::from_json(&json).expect("deserialize");
        assert_eq!(wf, parsed);
    }

    #[test]
    fn checkout_accepts_frontend_dirty_opt_in() {
        let op: GitOp = serde_json::from_value(serde_json::json!({
            "op": "checkout", "name": "feature/test", "allowDirty": true
        }))
        .expect("frontend checkout parses");
        assert_eq!(
            op,
            GitOp::Checkout {
                name: "feature/test".into(),
                allow_dirty: true,
            }
        );
        let without_opt_in: GitOp = serde_json::from_value(serde_json::json!({
            "op": "checkout", "name": "feature/test"
        }))
        .expect("checkout without dirty opt-in parses");
        assert!(matches!(
            without_opt_in,
            GitOp::Checkout {
                allow_dirty: false,
                ..
            }
        ));
    }

    #[test]
    fn checkout_legacy_dirty_opt_in_serializes_as_camel_case() {
        let op: GitOp = serde_json::from_value(serde_json::json!({
            "op": "checkout", "name": "feature/test", "allow_dirty": true
        }))
        .expect("saved checkout remains compatible");
        assert_eq!(
            serde_json::to_value(op).expect("serialize checkout"),
            serde_json::json!({
                "op": "checkout", "name": "feature/test", "allowDirty": true
            })
        );
    }

    /// The TypeScript frontend speaks slightly different spellings in one
    /// place (`github` instead of camelCase `gitHub`). Every node kind and op
    /// the UI can emit must deserialize — this is the contract that broke the
    /// "Demo: PR review" save path.
    #[test]
    fn frontend_spellings_deserialize() {
        let json = r#"{
            "schemaVersion": 4, "id": "w", "name": "N",
            "inputs": [{"name": "x"}],
            "nodes": [
                {"id": "s", "type": "start", "position": {"x": 0, "y": 0}, "config": {}},
                {"id": "g", "type": "github", "position": {"x": 0, "y": 0},
                 "config": {"workingDir": "/r", "githubOp": {"op": "createPr", "title": "T", "body": "B", "base": "main", "head": "f", "draft": true}}},
                {"id": "h", "type": "git", "position": {"x": 0, "y": 0},
                 "config": {"workingDir": "/r", "gitOp": {"op": "commit", "message": "M"}}},
                {"id": "c", "type": "condition", "position": {"x": 0, "y": 0},
                 "config": {"condition": {"logic": "or", "clauses": [{"left": "input.x", "op": "contains", "right": "y"}]}}},
                {"id": "e", "type": "end", "position": {"x": 0, "y": 0}, "config": {}}
            ],
            "edges": [
                {"id": "e1", "source": "s", "target": "g"},
                {"id": "e2", "source": "g", "target": "h"},
                {"id": "e3", "source": "h", "target": "c", "label": "success"},
                {"id": "e4", "source": "c", "target": "e", "label": "true"}
            ]
        }"#;
        let wf = Workflow::from_json(json).expect("frontend spellings must parse");
        assert!(wf.nodes.iter().any(|n| n.kind == NodeKind::GitHub));
        // Only the deliberately incomplete branch wiring may error (the
        // fixture has a `true` edge but no `false` edge).
        for issue in validate_workflow(&wf) {
            assert!(
                issue.severity != crate::workflow::ValidationSeverity::Error
                    || issue.code == "condition-branches-required",
                "unexpected error: {issue:?}"
            );
        }
    }

    #[test]
    fn schema_v0_migrates_to_current() {
        let json = r#"{"schemaVersion":0,"id":"w","name":"N","nodes":[],"edges":[]}"#;
        let wf = Workflow::from_json(json).expect("parse");
        assert_eq!(wf.schema_version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn schema_v1_migrates_to_v2() {
        let json = r#"{"schemaVersion":1,"id":"w","name":"N","nodes":[],"edges":[]}"#;
        let wf = Workflow::from_json(json).expect("parse");
        assert_eq!(wf.schema_version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn agent_node_requires_profile_and_prompt() {
        let mut wf = linear_workflow();
        wf.nodes.push(Node {
            id: "agent".into(),
            kind: NodeKind::Agent,
            position: Position::default(),
            config: NodeConfig::default(),
            label: None,
        });
        let issues = validate_workflow(&wf);
        assert!(issues.iter().any(|i| i.code == "agent-profile-required"));
        assert!(issues.iter().any(|i| i.code == "agent-prompt-required"));
    }

    #[test]
    fn agent_node_with_profile_and_prompt_validates() {
        let mut wf = linear_workflow();
        wf.nodes.push(Node {
            id: "agent".into(),
            kind: NodeKind::Agent,
            position: Position::default(),
            config: NodeConfig {
                agent_profile_id: Some("p1".into()),
                prompt: Some("Review {{workflow.name}}".into()),
                ..NodeConfig::default()
            },
            label: None,
        });
        let issues = validate_workflow(&wf);
        assert!(
            !issues.iter().any(|i| i.code == "agent-profile-required"),
            "unexpected: {issues:?}"
        );
    }

    fn branch_fixture() -> Workflow {
        // Start -> Cond -true-> A -\
        //                -false-> B -+-> Join -> End
        let node = |id: &str, kind: NodeKind, config: NodeConfig| Node {
            id: id.into(),
            kind,
            position: Position::default(),
            config,
            label: None,
        };
        let edge = |id: &str, source: &str, target: &str, label: Option<&str>| Edge {
            id: id.into(),
            source: source.into(),
            target: target.into(),
            label: label.map(str::to_string),
        };
        Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: "wf-branch".into(),
            name: "Branch".into(),
            inputs: Vec::new(),
            defaults: None,
            nodes: vec![
                node("start", NodeKind::Start, NodeConfig::default()),
                node(
                    "cond",
                    NodeKind::Condition,
                    NodeConfig {
                        condition: Some(ConditionConfig {
                            logic: ConditionLogic::Or,
                            clauses: vec![ConditionClause {
                                left: "input.mode".into(),
                                op: ConditionOp::Equals,
                                right: "fast".into(),
                            }],
                        }),
                        ..NodeConfig::default()
                    },
                ),
                node(
                    "a",
                    NodeKind::Command,
                    NodeConfig {
                        executable: Some("echo".into()),
                        ..NodeConfig::default()
                    },
                ),
                node(
                    "b",
                    NodeKind::Command,
                    NodeConfig {
                        executable: Some("echo".into()),
                        ..NodeConfig::default()
                    },
                ),
                node(
                    "join",
                    NodeKind::Command,
                    NodeConfig {
                        executable: Some("echo".into()),
                        ..NodeConfig::default()
                    },
                ),
                node("end", NodeKind::End, NodeConfig::default()),
            ],
            edges: vec![
                edge("e0", "start", "cond", None),
                edge("e1", "cond", "a", Some("true")),
                edge("e2", "cond", "b", Some("false")),
                edge("e3", "a", "join", None),
                edge("e4", "b", "join", None),
                edge("e5", "join", "end", None),
            ],
        }
    }

    #[test]
    fn condition_with_branches_and_declared_input_validates() {
        let mut wf = branch_fixture();
        wf.inputs.push(WorkflowInput {
            name: "mode".into(),
            label: None,
            default: Some("fast".into()),
            required: false,
        });
        let issues = validate_workflow(&wf);
        let errors: Vec<&ValidationIssue> = issues
            .iter()
            .filter(|i| i.severity == ValidationSeverity::Error)
            .collect();
        assert!(errors.is_empty(), "unexpected errors: {errors:?}");
    }

    #[test]
    fn condition_missing_branches_is_error() {
        let mut wf = branch_fixture();
        wf.edges.retain(|e| e.id != "e2");
        let issues = validate_workflow(&wf);
        assert!(issues
            .iter()
            .any(|i| i.code == "condition-branches-required"));
    }

    #[test]
    fn condition_unknown_ref_is_error() {
        let mut wf = branch_fixture();
        let cond = wf.nodes.iter_mut().find(|n| n.id == "cond").expect("cond");
        cond.config.condition = Some(ConditionConfig {
            logic: ConditionLogic::And,
            clauses: vec![ConditionClause {
                left: "node.ghost.output".into(),
                op: ConditionOp::Equals,
                right: "x".into(),
            }],
        });
        let issues = validate_workflow(&wf);
        assert!(issues.iter().any(|i| i.code == "condition-unknown-ref"));
    }

    #[test]
    fn prompt_unknown_variable_is_error() {
        let mut wf = linear_workflow();
        let cmd = wf.nodes.iter_mut().find(|n| n.id == "cmd").expect("cmd");
        cmd.kind = NodeKind::Agent;
        cmd.config = NodeConfig {
            agent_profile_id: Some("p1".into()),
            prompt: Some("Hello {{input.missing}}".into()),
            ..NodeConfig::default()
        };
        let issues = validate_workflow(&wf);
        assert!(issues.iter().any(|i| i.code == "prompt-unknown-variable"));
    }

    #[test]
    fn retry_bounds_are_enforced() {
        let mut wf = linear_workflow();
        let cmd = wf.nodes.iter_mut().find(|n| n.id == "cmd").expect("cmd");
        cmd.config.retry = Some(RetryPolicy {
            max_attempts: 99,
            delay_ms: 0,
            backoff: false,
        });
        let issues = validate_workflow(&wf);
        assert!(issues.iter().any(|i| i.code == "retry-unbounded"));
    }

    #[test]
    fn unbounded_cycle_is_rejected() {
        // cmd -> cond -> cmd loop without max_visits.
        let mut wf = linear_workflow();
        wf.nodes.push(Node {
            id: "cond".into(),
            kind: NodeKind::Condition,
            position: Position::default(),
            config: NodeConfig {
                condition: Some(ConditionConfig {
                    logic: ConditionLogic::And,
                    clauses: vec![ConditionClause {
                        left: "workflow.name".into(),
                        op: ConditionOp::NotEquals,
                        right: "done".into(),
                    }],
                }),
                ..NodeConfig::default()
            },
            label: None,
        });
        wf.edges = vec![
            Edge {
                id: "e1".into(),
                source: "start".into(),
                target: "cmd".into(),
                label: None,
            },
            Edge {
                id: "e2".into(),
                source: "cmd".into(),
                target: "cond".into(),
                label: None,
            },
            Edge {
                id: "e3".into(),
                source: "cond".into(),
                target: "end".into(),
                label: Some("false".into()),
            },
            Edge {
                id: "e4".into(),
                source: "cond".into(),
                target: "cmd".into(),
                label: Some("true".into()),
            },
        ];
        let issues = validate_workflow(&wf);
        assert!(issues.iter().any(|i| i.code == "cycle-unbounded"));
        // Bounding both cycle nodes clears it.
        for id in ["cmd", "cond"] {
            wf.nodes
                .iter_mut()
                .find(|n| n.id == id)
                .expect("node")
                .config
                .max_visits = Some(3);
        }
        let issues = validate_workflow(&wf);
        assert!(
            !issues.iter().any(|i| i.code == "cycle-unbounded"),
            "unexpected: {issues:?}"
        );
    }

    #[test]
    fn duplicate_inputs_rejected() {
        let mut wf = linear_workflow();
        for _ in 0..2 {
            wf.inputs.push(WorkflowInput {
                name: "branch".into(),
                label: None,
                default: None,
                required: false,
            });
        }
        assert!(validate_workflow(&wf)
            .iter()
            .any(|i| i.code == "input-duplicate"));
    }

    #[test]
    fn loop_edges_detect_back_edge() {
        let mut wf = linear_workflow();
        wf.edges.push(Edge {
            id: "back".into(),
            source: "cmd".into(),
            target: "start".into(),
            label: None,
        });
        let loops = find_loop_edges(&wf);
        assert!(loops.contains("back"));
        assert!(!loops.contains("e1"));
    }
}

#[cfg(test)]
mod integration_validation_tests {
    use super::*;

    fn node_with(id: &str, kind: NodeKind, config: NodeConfig) -> Node {
        Node {
            id: id.into(),
            kind,
            position: Position::default(),
            config,
            label: None,
        }
    }

    fn shell(workflow_nodes: Vec<Node>) -> Workflow {
        let mut nodes = vec![node_with("start", NodeKind::Start, NodeConfig::default())];
        nodes.extend(workflow_nodes);
        nodes.push(node_with("end", NodeKind::End, NodeConfig::default()));
        Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: "wf".into(),
            name: "W".into(),
            inputs: Vec::new(),
            defaults: None,
            nodes,
            edges: Vec::new(),
        }
    }

    #[test]
    fn git_node_requires_op_and_dir() {
        let wf = shell(vec![node_with("g", NodeKind::Git, NodeConfig::default())]);
        let issues = validate_workflow(&wf);
        assert!(issues.iter().any(|i| i.code == "git-op-required"));
        assert!(issues.iter().any(|i| i.code == "git-dir-required"));
    }

    #[test]
    fn git_status_with_dir_validates() {
        let wf = shell(vec![node_with(
            "g",
            NodeKind::Git,
            NodeConfig {
                git_op: Some(GitOp::Status),
                working_dir: Some("/tmp".into()),
                ..NodeConfig::default()
            },
        )]);
        let issues = validate_workflow(&wf);
        assert!(
            !issues
                .iter()
                .any(|i| i.code == "git-op-required" || i.code == "git-dir-required"),
            "{issues:?}"
        );
    }

    #[test]
    fn github_create_pr_requires_branches() {
        let wf = shell(vec![node_with(
            "g",
            NodeKind::GitHub,
            NodeConfig {
                github_op: Some(GitHubOp::CreatePr {
                    title: "".into(),
                    body: String::new(),
                    base: "main".into(),
                    head: "".into(),
                    draft: true,
                }),
                working_dir: Some("/tmp".into()),
                ..NodeConfig::default()
            },
        )]);
        let issues = validate_workflow(&wf);
        assert!(issues.iter().any(|i| i.code == "github-title-required"));
        assert!(issues.iter().any(|i| i.code == "github-branches-required"));
    }

    #[test]
    fn ticket_and_mcp_require_refs() {
        let wf = shell(vec![
            node_with("t", NodeKind::Ticket, NodeConfig::default()),
            node_with("m", NodeKind::Mcp, NodeConfig::default()),
        ]);
        let issues = validate_workflow(&wf);
        assert!(issues.iter().any(|i| i.code == "ticket-key-required"));
        assert!(issues.iter().any(|i| i.code == "ticket-server-required"));
        assert!(issues.iter().any(|i| i.code == "mcp-server-required"));
        assert!(issues.iter().any(|i| i.code == "mcp-tool-required"));
    }

    #[test]
    fn schema_v3_migrates_to_v4() {
        let json = r#"{"schemaVersion":3,"id":"w","name":"N","nodes":[],"edges":[]}"#;
        let wf = Workflow::from_json(json).expect("parse");
        assert_eq!(wf.schema_version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn schema_v4_migrates_to_v5() {
        // v4 is what frontends wrote before the version stamp was fixed;
        // agent_role defaults, so migration is bump-only.
        let json = r#"{"schemaVersion":4,"id":"w","name":"N","nodes":[],"edges":[]}"#;
        let wf = Workflow::from_json(json).expect("parse");
        assert_eq!(wf.schema_version, CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn compose_executable_warns() {
        let mut wf = Workflow::new("w", "N");
        wf.nodes.push(Node {
            id: "c".into(),
            kind: NodeKind::Command,
            position: Position::default(),
            config: NodeConfig {
                executable: Some("compose".to_string()),
                args: vec!["up".to_string(), "-d".to_string()],
                ..Default::default()
            },
            label: None,
        });
        assert!(validate_workflow(&wf)
            .iter()
            .any(|i| i.code == "command-executable-suspicious"));
    }

    #[test]
    fn schema_v5_migrates_to_v6_with_empty_defaults() {
        let json = r#"{"schemaVersion":5,"id":"w","name":"N","nodes":[],"edges":[]}"#;
        let wf = Workflow::from_json(json).expect("parse");
        assert_eq!(wf.schema_version, CURRENT_SCHEMA_VERSION);
        assert!(wf.defaults.is_none());
    }

    #[test]
    fn workflow_defaults_satisfy_git_dir_validation() {
        let mut wf = Workflow::new("w", "N");
        wf.nodes.push(Node {
            id: "g".into(),
            kind: NodeKind::Git,
            position: Position::default(),
            config: NodeConfig {
                git_op: Some(GitOp::Status),
                ..Default::default()
            },
            label: None,
        });
        // No node dir, no default: error.
        assert!(validate_workflow(&wf)
            .iter()
            .any(|i| i.code == "git-dir-required"));
        // Workflow default clears it.
        wf.defaults = Some(WorkflowDefaults {
            repo_dir: Some("/repo".into()),
            branch: Some("feature/x".into()),
        });
        assert!(!validate_workflow(&wf)
            .iter()
            .any(|i| i.code == "git-dir-required"));
    }
}

#[cfg(test)]
mod sample_tests {
    use super::*;

    #[test]
    fn sample_validates_cleanly() {
        let wf = sample_workflow();
        let issues = validate_workflow(&wf);
        let errors: Vec<&ValidationIssue> = issues
            .iter()
            .filter(|i| i.severity == ValidationSeverity::Error)
            .collect();
        assert!(errors.is_empty(), "{errors:?}");
    }
}

#[cfg(test)]
mod perf_tests {
    use super::*;
    use std::time::Instant;

    /// Representative large canvas: validation must stay interactive.
    #[test]
    fn validates_200_nodes_quickly() {
        let mut wf = Workflow::new("big", "Big");
        wf.nodes.push(Node {
            id: "start".into(),
            kind: NodeKind::Start,
            position: Position::default(),
            config: NodeConfig::default(),
            label: None,
        });
        for i in 0..198 {
            wf.nodes.push(Node {
                id: format!("cmd-{i}"),
                kind: NodeKind::Command,
                position: Position::default(),
                config: NodeConfig {
                    executable: Some("echo".into()),
                    ..NodeConfig::default()
                },
                label: None,
            });
        }
        wf.nodes.push(Node {
            id: "end".into(),
            kind: NodeKind::End,
            position: Position::default(),
            config: NodeConfig::default(),
            label: None,
        });
        for pair in ["start".to_string()]
            .into_iter()
            .chain((0..198).map(|i| format!("cmd-{i}")))
            .collect::<Vec<String>>()
            .windows(2)
        {
            wf.edges.push(Edge {
                id: format!("e-{}", pair[0]),
                source: pair[0].clone(),
                target: pair[1].clone(),
                label: None,
            });
        }
        wf.edges.push(Edge {
            id: "e-last".into(),
            source: "cmd-197".into(),
            target: "end".into(),
            label: None,
        });
        let started = Instant::now();
        let issues = validate_workflow(&wf);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "validation too slow: {:?}",
            started.elapsed()
        );
        assert!(
            issues
                .iter()
                .all(|i| i.severity != ValidationSeverity::Error),
            "{issues:?}"
        );
    }
}
