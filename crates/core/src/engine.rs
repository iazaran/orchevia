//! Workflow execution engine.
//!
//! Milestone 3 semantics (see `docs/execution.md` for the full contract):
//! - The persisted workflow definition is the source of truth.
//! - DAG execution with fan-out/fan-in joins, condition branches, failure
//!   routing, bounded retries, and guarded loops (re-visits need explicit
//!   `max_visits`, cycles need a Condition).
//! - Progress is durable: every node result is written to SQLite immediately,
//!   so resume replays history and continues after approval gates or restart.
//! - Cancellation is cooperative between nodes and preemptive *within* a
//!   running command (the child is killed via `tokio::process`).
//! - Commands run with inherited environment but a fixed, explicit working
//!   directory; executable + args are passed separately (no shell).

use crate::{
    agents::{build_agent_command, AgentProfile},
    conditions::eval_condition,
    db::{DbError, NewNodeResult, RunStatus, SqliteDb, StoredNodeResult},
    prompt::render_prompt,
    tools::find_executable,
    workflow::{
        classify_edge_label, find_loop_edges, validate_workflow, Edge, EdgeKind, Node, NodeKind,
        ValidationSeverity, Workflow, MAX_TIMEOUT_SECS,
    },
};
use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::task::JoinSet;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("database error: {0}")]
    Db(String),
    #[error("validation failed: {0}")]
    Validation(String),
    #[error("unknown workflow: {0}")]
    UnknownWorkflow(String),
    #[error("unknown run: {0}")]
    UnknownRun(String),
    #[error("run is not paused: {0}")]
    NotPaused(String),
    #[error("io error: {0}")]
    Io(String),
}

impl From<DbError> for EngineError {
    fn from(e: DbError) -> Self {
        EngineError::Db(e.to_string())
    }
}

/// Registry of cancellation flags for in-flight runs.
#[derive(Debug, Default, Clone)]
pub struct CancellationRegistry {
    inner: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl CancellationRegistry {
    fn flags(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        // The map holds atomic flags only; recovering its guard preserves
        // cancellation after an unrelated task unwinds while holding it.
        match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    pub fn flag_for(&self, run_id: &str) -> Arc<AtomicBool> {
        let mut map = self.flags();
        map.entry(run_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    pub fn cancel(&self, run_id: &str) -> bool {
        let map = self.flags();
        if let Some(flag) = map.get(run_id) {
            flag.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    pub fn remove(&self, run_id: &str) {
        self.flags().remove(run_id);
    }

    fn decide_paused_run(
        &self,
        db: &SqliteDb,
        run_id: &str,
        approved: bool,
        note: &str,
        expected_approval_id: Option<i64>,
    ) -> Result<bool, EngineError> {
        // Cancellation cannot miss the new flag between the database claim
        // and resumption. Failed or rejected decisions create no flag.
        let mut map = self.flags();
        if !db.decide_paused_run(run_id, approved, note, expected_approval_id)? {
            return Ok(false);
        }
        if approved {
            map.insert(run_id.to_string(), Arc::new(AtomicBool::new(false)));
        }
        Ok(true)
    }
}

/// Default per-command timeout (generous; AI CLIs can run long).
const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(600);
/// Cap per stream kept in memory before truncation.
const MAX_STREAM_CHARS: usize = 200_000;

struct Capture {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    last_output: Instant,
}

impl Capture {
    fn append(&mut self, bytes: &[u8], is_stdout: bool) {
        let stream = if is_stdout {
            &mut self.stdout
        } else {
            &mut self.stderr
        };
        // Four bytes per Unicode scalar plus one extra scalar lets the
        // existing character truncation mark overflow without keeping logs
        // indefinitely. Continue reading discarded bytes to avoid pipe stalls.
        let retain = bytes
            .len()
            .min((MAX_STREAM_CHARS * 4 + 4).saturating_sub(stream.len()));
        stream.extend_from_slice(&bytes[..retain]);
        self.last_output = Instant::now();
    }
}
/// Upper bound on concurrently executing nodes in one run.
const MAX_PARALLEL_NODES: usize = 4;

pub struct Engine {
    db: Arc<SqliteDb>,
    cancel: CancellationRegistry,
}

/// Routing-relevant outcome of a node execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NodeOutcome {
    Succeeded,
    Failed,
    Skipped,
    Cancelled,
    Paused,
}

/// What a spawned node task reports (rows are recorded inside the task).
enum TaskOutcome {
    Succeeded,
    Failed,
    ConditionBranch(bool),
    Cancelled,
}

/// Terminal row statuses: they complete a node visit. `retrying` and `paused`
/// rows are intermediate and do not.
fn is_terminal_status(status: &str) -> bool {
    matches!(
        status,
        "succeeded" | "failed" | "skipped" | "approved" | "rejected" | "cancelled"
    )
}

fn outcome_of_status(status: &str) -> NodeOutcome {
    match status {
        "succeeded" | "approved" => NodeOutcome::Succeeded,
        "failed" | "rejected" => NodeOutcome::Failed,
        "skipped" => NodeOutcome::Skipped,
        "paused" => NodeOutcome::Paused,
        _ => NodeOutcome::Cancelled,
    }
}

/// Static graph view over a workflow definition.
struct Graph {
    nodes: HashMap<String, Node>,
    outgoing: HashMap<String, Vec<Edge>>,
    incoming: HashMap<String, Vec<Edge>>,
    loop_edges: HashSet<String>,
    def_order: HashMap<String, usize>,
}

impl Graph {
    fn build(workflow: &Workflow) -> Result<Self, EngineError> {
        if !workflow.nodes.iter().any(|n| n.kind == NodeKind::Start) {
            return Err(EngineError::Validation(
                "Workflow has no Start node.".to_string(),
            ));
        }
        let mut nodes = HashMap::new();
        let mut def_order = HashMap::new();
        for (index, node) in workflow.nodes.iter().enumerate() {
            def_order.insert(node.id.clone(), index);
            nodes.insert(node.id.clone(), node.clone());
        }
        let mut outgoing: HashMap<String, Vec<Edge>> = HashMap::new();
        let mut incoming: HashMap<String, Vec<Edge>> = HashMap::new();
        for edge in &workflow.edges {
            outgoing
                .entry(edge.source.clone())
                .or_default()
                .push(edge.clone());
            incoming
                .entry(edge.target.clone())
                .or_default()
                .push(edge.clone());
        }
        let loop_edges = find_loop_edges(workflow);
        Ok(Self {
            nodes,
            outgoing,
            incoming,
            loop_edges,
            def_order,
        })
    }

    fn max_visits(&self, node_id: &str) -> u32 {
        self.nodes
            .get(node_id)
            .and_then(|n| n.config.max_visits)
            .unwrap_or(1)
            .clamp(1, 100)
    }

    fn is_loop_edge(&self, edge_id: &str) -> bool {
        self.loop_edges.contains(edge_id)
    }

    /// Non-loop in-degree: loop-back edges never gate readiness.
    fn join_degree(&self, node_id: &str) -> usize {
        self.incoming
            .get(node_id)
            .map(|edges| edges.iter().filter(|e| !self.is_loop_edge(&e.id)).count())
            .unwrap_or(0)
    }
}

/// Dynamic scheduling state for one run.
#[derive(Debug, Default)]
struct RunState {
    terminal: HashMap<String, NodeOutcome>,
    visits: HashMap<String, u32>,
    pending: HashMap<String, usize>,
    taken: HashMap<String, bool>,
}

impl Engine {
    pub fn new(db: Arc<SqliteDb>, cancel: CancellationRegistry) -> Self {
        Self { db, cancel }
    }

    pub fn cancel_run(&self, run_id: &str) -> Result<bool, EngineError> {
        let paused = self.db.cancel_paused_run(run_id)?;
        Ok(self.cancel.cancel(run_id) || paused)
    }

    /// Record a node result without captured output.
    fn record_simple(
        &self,
        run_id: &str,
        node_id: &str,
        status: &str,
        exit_code: Option<i32>,
        error: Option<&str>,
    ) -> Result<(), EngineError> {
        self.db
            .record_node_result(NewNodeResult::simple(
                run_id, node_id, status, exit_code, error,
            ))
            .map_err(EngineError::from)
    }

    /// Validate (structure + inputs + agent availability), persist the run
    /// with merged input values, and leave execution to [`Engine::execute`].
    pub fn start_run(
        &self,
        workflow: &Workflow,
        run_id: &str,
        inputs: &HashMap<String, String>,
    ) -> Result<(), EngineError> {
        // Merge defaults under caller-supplied values.
        let mut merged: HashMap<String, String> = workflow
            .inputs
            .iter()
            .filter_map(|i| i.default.clone().map(|d| (i.name.clone(), d)))
            .collect();
        for (key, value) in inputs {
            merged.insert(key.clone(), value.clone());
        }
        let mut issues = validate_workflow(workflow);
        // Required inputs validate the effective value after caller overrides.
        for input in &workflow.inputs {
            if input.required
                && merged
                    .get(&input.name)
                    .map(|s| s.trim().is_empty())
                    .unwrap_or(true)
            {
                issues.push(crate::workflow::ValidationIssue {
                    code: "input-required".to_string(),
                    message: format!("Workflow input '{}' is required.", input.name),
                    severity: ValidationSeverity::Error,
                    node_id: None,
                });
            }
        }
        // Availability checks that need the DB: every Agent node must
        // reference an existing profile whose CLI is installed.
        for node in workflow.nodes.iter().filter(|n| n.kind == NodeKind::Agent) {
            if node
                .config
                .agent_role
                .as_deref()
                .map(|r| !r.trim().is_empty())
                .unwrap_or(false)
            {
                issues.push(crate::workflow::ValidationIssue {
                    code: "agent-role-unresolved".to_string(),
                    message: "AI Agent node still references a role; resolve roles to profiles before running.".to_string(),
                    severity: ValidationSeverity::Error,
                    node_id: Some(node.id.clone()),
                });
                continue;
            }
            let profile_id = node.config.agent_profile_id.as_deref().unwrap_or("");
            match self.db.get_agent_profile(profile_id) {
                Ok(Some(profile)) => {
                    let exe = profile.effective_executable();
                    if !is_executable_available(&exe) {
                        issues.push(crate::workflow::ValidationIssue {
                            code: "agent-cli-unavailable".to_string(),
                            message: format!(
                                "Agent Profile '{}' needs '{}', which was not found on PATH.",
                                profile.name, exe
                            ),
                            severity: ValidationSeverity::Error,
                            node_id: Some(node.id.clone()),
                        });
                    }
                }
                Ok(None) => issues.push(crate::workflow::ValidationIssue {
                    code: "agent-profile-missing".to_string(),
                    message: format!(
                        "AI Agent node references unknown Agent Profile '{profile_id}'."
                    ),
                    severity: ValidationSeverity::Error,
                    node_id: Some(node.id.clone()),
                }),
                Err(e) => {
                    return Err(EngineError::Db(e.to_string()));
                }
            }
        }
        // Integration availability: git/gh binaries and MCP servers.
        let needs_git = workflow.nodes.iter().any(|n| n.kind == NodeKind::Git);
        let needs_gh = workflow.nodes.iter().any(|n| n.kind == NodeKind::GitHub);
        if needs_git && !is_executable_available("git") {
            issues.push(crate::workflow::ValidationIssue {
                code: "git-cli-unavailable".to_string(),
                message: "Git nodes need the 'git' CLI, which was not found on PATH.".to_string(),
                severity: ValidationSeverity::Error,
                node_id: None,
            });
        }
        if needs_gh && !crate::github::cli_available() {
            issues.push(crate::workflow::ValidationIssue {
                code: "gh-cli-unavailable".to_string(),
                message: "GitHub nodes need the 'gh' CLI, which was not found on PATH.".to_string(),
                severity: ValidationSeverity::Error,
                node_id: None,
            });
        }
        for node in workflow
            .nodes
            .iter()
            .filter(|n| matches!(n.kind, NodeKind::Mcp | NodeKind::Ticket))
        {
            let server_id = node.config.mcp_server_id.as_deref().unwrap_or("");
            match self.db.get_mcp_server(server_id) {
                Ok(Some(server)) => {
                    if !server.enabled {
                        issues.push(crate::workflow::ValidationIssue {
                            code: "mcp-server-disabled".to_string(),
                            message: format!("MCP server '{}' is disabled.", server.name),
                            severity: ValidationSeverity::Error,
                            node_id: Some(node.id.clone()),
                        });
                    } else if !crate::mcp::server_command_available(&server) {
                        issues.push(crate::workflow::ValidationIssue {
                            code: "mcp-server-unavailable".to_string(),
                            message: format!(
                                "MCP server '{}' needs '{}', which was not found.",
                                server.name, server.command
                            ),
                            severity: ValidationSeverity::Error,
                            node_id: Some(node.id.clone()),
                        });
                    }
                }
                Ok(None) => issues.push(crate::workflow::ValidationIssue {
                    code: "mcp-server-missing".to_string(),
                    message: format!("Node references unknown MCP server '{server_id}'."),
                    severity: ValidationSeverity::Error,
                    node_id: Some(node.id.clone()),
                }),
                Err(e) => {
                    return Err(EngineError::Db(e.to_string()));
                }
            }
        }
        if issues
            .iter()
            .any(|i| i.severity == ValidationSeverity::Error)
        {
            let msgs: Vec<String> = issues
                .into_iter()
                .filter(|i| i.severity == ValidationSeverity::Error)
                .map(|i| i.message)
                .collect();
            return Err(EngineError::Validation(msgs.join("; ")));
        }
        self.db
            .create_run_with_workflow(run_id, workflow, &merged)?;
        Ok(())
    }

    /// Execute (or resume) a run to a terminal state. Durable + cancellable.
    ///
    /// Scheduler-started runs use ids prefixed `run-sched-`; completion
    /// notifications honor that (scheduled-success prefs) without extra
    /// plumbing through approve/resume paths.
    pub async fn execute(&self, workflow: Workflow, run_id: String) {
        let scheduled = run_id.starts_with("run-sched-");
        let workflow_name = workflow.name.clone();
        let flag = self.cancel.flag_for(&run_id);
        let result = self.execute_inner(&workflow, &run_id, &flag).await;
        // Remove the old execution flag before publishing a paused status.
        // Resumption then registers its own flag without this task removing it.
        self.cancel.remove(&run_id);
        match result {
            Ok(RunOutcome::Finished(status)) => {
                let _ = self.db.finish_run(&run_id, status);
                self.emit_terminal(&workflow, &run_id, &workflow_name, scheduled, status);
            }
            Ok(RunOutcome::Paused) => {
                let _ = self.db.finish_run(&run_id, RunStatus::Paused);
                crate::notify::emit_event(
                    &self.db,
                    &crate::notify::NotifyEvent::ApprovalNeeded {
                        run_id: run_id.clone(),
                        workflow: workflow_name,
                    },
                );
            }
            Err(e) => {
                let message = e.to_string();
                let _ = self.record_simple(&run_id, "run", "failed", None, Some(&message));
                let _ = self.db.finish_run(&run_id, RunStatus::Failed);
                crate::notify::emit_event(
                    &self.db,
                    &crate::notify::NotifyEvent::WorkflowFailed {
                        run_id: run_id.clone(),
                        workflow: workflow_name,
                        scheduled,
                    },
                );
            }
        }
    }

    /// Completion notifications: failures, successes (pref-gated), and
    /// actionable P0/P1 review findings extracted from agent outputs.
    fn emit_terminal(
        &self,
        workflow: &Workflow,
        run_id: &str,
        workflow_name: &str,
        scheduled: bool,
        status: RunStatus,
    ) {
        match status {
            RunStatus::Failed => {
                crate::notify::emit_event(
                    &self.db,
                    &crate::notify::NotifyEvent::WorkflowFailed {
                        run_id: run_id.to_string(),
                        workflow: workflow_name.to_string(),
                        scheduled,
                    },
                );
            }
            RunStatus::Succeeded => {
                let actionable = self.actionable_finding_count(workflow, run_id);
                if actionable > 0 {
                    crate::notify::emit_event(
                        &self.db,
                        &crate::notify::NotifyEvent::ActionableFindings {
                            run_id: run_id.to_string(),
                            count: actionable,
                        },
                    );
                }
                crate::notify::emit_event(
                    &self.db,
                    &crate::notify::NotifyEvent::WorkflowSucceeded {
                        run_id: run_id.to_string(),
                        workflow: workflow_name.to_string(),
                        scheduled,
                    },
                );
            }
            _ => {}
        }
    }

    /// Count actionable findings across agent node outputs in a run.
    fn actionable_finding_count(&self, workflow: &Workflow, run_id: &str) -> usize {
        let agent_nodes: Vec<&Node> = workflow
            .nodes
            .iter()
            .filter(|n| n.kind == NodeKind::Agent)
            .collect();
        if agent_nodes.is_empty() {
            return 0;
        }
        let rows = self.db.list_node_results(run_id).unwrap_or_default();
        let mut outputs: Vec<(String, String, String)> = Vec::new();
        for node in agent_nodes {
            let profile_label = node
                .config
                .agent_profile_id
                .as_deref()
                .and_then(|id| self.db.get_agent_profile(id).ok().flatten())
                .map(|p| p.name)
                .unwrap_or_default();
            if let Some(row) = rows
                .iter()
                .rev()
                .find(|r| r.node_id == node.id && r.status == "succeeded")
            {
                outputs.push((node.id.clone(), profile_label, row.stdout.clone()));
            }
        }
        crate::review::grouped_findings(&outputs)
            .into_iter()
            .filter(|grouped| grouped.finding.actionable())
            .count()
    }

    async fn execute_inner(
        &self,
        workflow: &Workflow,
        run_id: &str,
        flag: &Arc<AtomicBool>,
    ) -> Result<RunOutcome, EngineError> {
        let snapshot = self.db.get_run_workflow(run_id)?;
        let workflow = snapshot.as_ref().unwrap_or(workflow);
        let run = self
            .db
            .get_run(run_id)?
            .ok_or_else(|| EngineError::UnknownRun(run_id.to_string()))?;
        let graph = Graph::build(workflow)?;
        let mut state = RunState::default();
        for node in workflow.nodes.iter() {
            state
                .pending
                .insert(node.id.clone(), graph.join_degree(&node.id));
            state.taken.insert(node.id.clone(), false);
        }
        // Start nodes are entry points: always taken.
        for node in workflow.nodes.iter().filter(|n| n.kind == NodeKind::Start) {
            state.taken.insert(node.id.clone(), true);
        }
        // Replay durable history (resume path): same routing as live.
        // Condition branches come from stored rows, so no re-evaluation.
        let rows = self.db.list_node_results(run_id)?;
        for row in rows.iter().filter(|r| is_terminal_status(&r.status)) {
            let outcome = outcome_of_status(&row.status);
            if outcome == NodeOutcome::Succeeded || outcome == NodeOutcome::Failed {
                *state.visits.entry(row.node_id.clone()).or_insert(0) += 1;
            }
            state.terminal.insert(row.node_id.clone(), outcome);
            if outcome == NodeOutcome::Paused || outcome == NodeOutcome::Cancelled {
                continue;
            }
            let branch = branch_of_row(row);
            let effect = self.apply_completion(
                &graph,
                &mut state,
                run_id,
                &Completion {
                    node_id: &row.node_id,
                    outcome,
                    branch,
                    record: false,
                },
            )?;
            if effect.run_failed.is_some() {
                // History already failed; keep replaying for state fullness.
                continue;
            }
        }

        let mut in_flight: HashSet<String> = HashSet::new();
        let mut set: JoinSet<(String, TaskOutcome)> = JoinSet::new();
        let mut fail_fast: Option<FailFast> = None;

        loop {
            if flag.load(Ordering::SeqCst) && fail_fast.is_none() {
                fail_fast = Some(FailFast::Cancelled);
            }
            // Ready nodes in definition order (deterministic scheduling).
            let mut ready: Vec<String> = workflow
                .nodes
                .iter()
                .filter(|n| {
                    !state.terminal.contains_key(&n.id)
                        && !in_flight.contains(&n.id)
                        && state.pending.get(&n.id).copied().unwrap_or(0) == 0
                        && state.taken.get(&n.id).copied().unwrap_or(false)
                        && state.visits.get(&n.id).copied().unwrap_or(0) < graph.max_visits(&n.id)
                })
                .map(|n| n.id.clone())
                .collect();
            ready.sort_by_key(|id| graph.def_order.get(id).copied().unwrap_or(usize::MAX));

            // Approval gates engage only when nothing else is in flight, so a
            // pause never strands running siblings mid-branch.
            if fail_fast.is_none() && in_flight.is_empty() {
                if let Some(approval) = ready
                    .iter()
                    .find(|id| graph.nodes.get(*id).map(|n| n.kind) == Some(NodeKind::Approval))
                {
                    let message = graph
                        .nodes
                        .get(approval)
                        .and_then(|n| n.config.message.clone())
                        .filter(|m| !m.trim().is_empty())
                        .unwrap_or_else(|| "Waiting for human approval.".to_string());
                    self.record_simple(run_id, approval, "paused", None, Some(&message))?;
                    return Ok(RunOutcome::Paused);
                }
            }

            if fail_fast.is_none() {
                let capacity = MAX_PARALLEL_NODES.saturating_sub(in_flight.len());
                for id in ready.iter().take(capacity) {
                    let id_owned = id.clone();
                    let kind = graph.nodes.get(&id_owned).map(|n| n.kind);
                    if kind == Some(NodeKind::Approval) {
                        continue; // waits for the drain above
                    }
                    let node = graph.nodes.get(&id_owned).cloned().ok_or_else(|| {
                        EngineError::Validation(format!(
                            "Ready node '{id_owned}' is missing from the workflow."
                        ))
                    })?;
                    let db = Arc::clone(&self.db);
                    let task_flag = Arc::clone(flag);
                    let owned = TaskInput {
                        node,
                        workflow_id: workflow.id.clone(),
                        workflow_name: workflow.name.clone(),
                        workflow_defaults: workflow.defaults.clone(),
                        run_id: run_id.to_string(),
                        inputs: run.inputs.clone(),
                    };
                    set.spawn(async move {
                        let outcome = execute_node_task(db, owned, task_flag).await;
                        (id_owned, outcome)
                    });
                    in_flight.insert(id.clone());
                }
            }

            if in_flight.is_empty() {
                // Drained after fail-fast: finish without touching ready work.
                if let Some(fail) = fail_fast.clone() {
                    match fail {
                        FailFast::Cancelled => {
                            return Ok(RunOutcome::Finished(RunStatus::Cancelled));
                        }
                        FailFast::Failure(message) => {
                            let _ =
                                self.record_simple(run_id, "run", "failed", None, Some(&message));
                            return Ok(RunOutcome::Finished(RunStatus::Failed));
                        }
                    }
                }
                if all_terminal(&graph, &state) {
                    return Ok(RunOutcome::Finished(RunStatus::Succeeded));
                }
                // Nothing ready, nothing flying, work remains: this cannot
                // happen for validated workflows; fail loudly, not silently.
                let stuck: Vec<String> = workflow
                    .nodes
                    .iter()
                    .filter(|n| !state.terminal.contains_key(&n.id))
                    .map(|n| n.id.clone())
                    .collect();
                let message = format!(
                    "Scheduler deadlock: nodes never became ready: {}.",
                    stuck.join(", ")
                );
                let _ = self.record_simple(run_id, "run", "failed", None, Some(&message));
                return Ok(RunOutcome::Finished(RunStatus::Failed));
            }

            // Await one completion.
            let completed = set.join_next().await;
            let (node_id, task_outcome) = match completed {
                Some(Ok(pair)) => pair,
                Some(Err(e)) => {
                    let message = format!("Worker task panicked: {e}");
                    let _ = self.record_simple(run_id, "run", "failed", None, Some(&message));
                    return Ok(RunOutcome::Finished(RunStatus::Failed));
                }
                None => continue,
            };
            in_flight.remove(&node_id);

            let (outcome, branch) = match task_outcome {
                TaskOutcome::Succeeded => (NodeOutcome::Succeeded, None),
                TaskOutcome::Failed => (NodeOutcome::Failed, None),
                TaskOutcome::ConditionBranch(branch) => (NodeOutcome::Succeeded, Some(branch)),
                TaskOutcome::Cancelled => (NodeOutcome::Cancelled, None),
            };
            // Record the visit for real executions (tasks already wrote rows).
            if outcome == NodeOutcome::Succeeded || outcome == NodeOutcome::Failed {
                *state.visits.entry(node_id.clone()).or_insert(0) += 1;
            }
            state.terminal.insert(node_id.clone(), outcome);
            if outcome == NodeOutcome::Cancelled {
                if fail_fast.is_none() {
                    fail_fast = Some(FailFast::Cancelled);
                }
                continue;
            }
            let effect = self.apply_completion(
                &graph,
                &mut state,
                run_id,
                &Completion {
                    node_id: &node_id,
                    outcome,
                    branch,
                    record: true,
                },
            )?;
            if let Some(message) = effect.run_failed {
                fail_fast = Some(FailFast::Failure(message));
                // Fail fast: stop siblings promptly; drained below.
                flag.store(true, Ordering::SeqCst);
            }
            continue;
        }
    }

    /// Route a completed node: resolve outgoing edges, reset loop subgraphs,
    /// cascade skips. When `record` is true, skip rows are persisted.
    fn apply_completion(
        &self,
        graph: &Graph,
        state: &mut RunState,
        run_id: &str,
        completion: &Completion,
    ) -> Result<ApplyEffect, EngineError> {
        let node_id = completion.node_id;
        let outcome = completion.outcome;
        let condition_branch = completion.branch;
        let record = completion.record;
        let mut effect = ApplyEffect { run_failed: None };
        let outgoing = graph.outgoing.get(node_id).cloned().unwrap_or_default();
        // Condition nodes route by branch; others by success/failure.
        let is_condition = graph.nodes.get(node_id).map(|n| n.kind) == Some(NodeKind::Condition);
        // Classify every outgoing edge first.
        let mut taken_loop: Vec<&Edge> = Vec::new();
        let mut taken_normal: Vec<&Edge> = Vec::new();
        let mut untaken_normal: Vec<&Edge> = Vec::new();
        for edge in &outgoing {
            let kind = classify_edge_label(edge.label.as_deref());
            let taken = match outcome {
                NodeOutcome::Succeeded => {
                    if is_condition {
                        matches!(
                            (condition_branch, kind),
                            (Some(true), EdgeKind::TrueBranch)
                                | (Some(false), EdgeKind::FalseBranch)
                        )
                    } else {
                        matches!(kind, EdgeKind::Success | EdgeKind::Unknown)
                    }
                }
                NodeOutcome::Failed => matches!(kind, EdgeKind::Failure),
                NodeOutcome::Skipped | NodeOutcome::Cancelled | NodeOutcome::Paused => false,
            };
            if graph.is_loop_edge(&edge.id) {
                if taken {
                    taken_loop.push(edge);
                }
                continue;
            }
            if taken {
                taken_normal.push(edge);
            } else {
                untaken_normal.push(edge);
            }
        }
        // Loop-back edges first: they reset the cycle for re-execution.
        for edge in &taken_loop {
            let visits = state.visits.get(&edge.target).copied().unwrap_or(0);
            if visits < graph.max_visits(&edge.target) {
                self.reset_cycle(graph, state, &edge.target, node_id);
                self.resolve_edge(graph, state, run_id, &edge.target, true, record)?;
            } else {
                effect.run_failed = Some(format!(
                    "Loop limit exceeded at '{}' (max {} visits).",
                    edge.target,
                    graph.max_visits(&edge.target)
                ));
            }
        }
        if effect.run_failed.is_some() {
            return Ok(effect);
        }
        for edge in &taken_normal {
            if state.terminal.contains_key(&edge.target) {
                continue;
            }
            self.resolve_edge(graph, state, run_id, &edge.target, true, record)?;
        }
        // Untaken branches resolve immediately — except while a loop
        // continues: sibling targets must wait for the exit visit, otherwise
        // they would be skipped prematurely and block the loop exit.
        if taken_loop.is_empty() {
            for edge in &untaken_normal {
                if state.terminal.contains_key(&edge.target) {
                    continue;
                }
                self.resolve_edge(graph, state, run_id, &edge.target, false, record)?;
            }
        }
        if outcome == NodeOutcome::Failed && taken_normal.is_empty() && taken_loop.is_empty() {
            // No failure route: the run fails here.
            let label = graph
                .nodes
                .get(node_id)
                .and_then(|n| n.label.clone())
                .unwrap_or_else(|| node_id.to_string());
            effect.run_failed = Some(format!("Node '{label}' failed with no failure route."));
        }
        Ok(effect)
    }

    /// Mark one incoming edge resolved for `target`; cascade skip when the
    /// node can no longer be taken.
    fn resolve_edge(
        &self,
        graph: &Graph,
        state: &mut RunState,
        run_id: &str,
        target: &str,
        taken: bool,
        record: bool,
    ) -> Result<(), EngineError> {
        if state.terminal.contains_key(target) {
            return Ok(());
        }
        if let Some(pending) = state.pending.get_mut(target) {
            *pending = pending.saturating_sub(1);
        }
        if taken {
            state.taken.insert(target.to_string(), true);
        }
        let pending = state.pending.get(target).copied().unwrap_or(0);
        if pending == 0 && !state.taken.get(target).copied().unwrap_or(false) {
            self.mark_skipped(graph, state, run_id, target, record)?;
        }
        Ok(())
    }

    /// Record a skip and propagate to downstream joins.
    fn mark_skipped(
        &self,
        graph: &Graph,
        state: &mut RunState,
        run_id: &str,
        node_id: &str,
        record: bool,
    ) -> Result<(), EngineError> {
        if state.terminal.contains_key(node_id) {
            return Ok(());
        }
        if record {
            self.record_simple(run_id, node_id, "skipped", None, None)?;
        }
        state
            .terminal
            .insert(node_id.to_string(), NodeOutcome::Skipped);
        let outgoing = graph.outgoing.get(node_id).cloned().unwrap_or_default();
        for edge in &outgoing {
            if graph.is_loop_edge(&edge.id) {
                continue;
            }
            self.resolve_edge(graph, state, run_id, &edge.target, false, record)?;
        }
        Ok(())
    }

    /// Prepare a loop target for re-execution: clear terminal marks for the
    /// nodes on the cycle (reachable from the target and able to reach the
    /// source), so they run again bounded by `max_visits`. Nodes off the
    /// cycle keep their state: exit-path nodes resolve on the exit visit,
    /// and one-shot side nodes stay completed. History rows stay in SQLite.
    fn reset_cycle(&self, graph: &Graph, state: &mut RunState, target: &str, source: &str) {
        let from_target = reachable_from_graph(graph, target);
        let cycle: Vec<String> = from_target
            .into_iter()
            .filter(|id| can_reach_graph(graph, id, source) || id == source)
            .collect();
        for node_id in &cycle {
            state.terminal.remove(node_id);
        }
        // The source just completed; it rejoins the cycle as re-runnable.
        state.terminal.remove(source);
        let mut cycle_set: HashSet<String> = cycle.into_iter().collect();
        cycle_set.insert(source.to_string());
        // Recompute readiness: pending = non-loop incoming from
        // non-terminal sources; taken cleared (the loop edge re-sets it).
        for node_id in &cycle_set {
            let pending = graph
                .incoming
                .get(node_id)
                .map(|edges| {
                    edges
                        .iter()
                        .filter(|e| {
                            !graph.is_loop_edge(&e.id) && !state.terminal.contains_key(&e.source)
                        })
                        .count()
                })
                .unwrap_or(0);
            state.pending.insert(node_id.clone(), pending);
            state.taken.insert(node_id.clone(), false);
        }
    }

    /// Resume a paused run after an approval decision, with an optional note.
    pub async fn approve_run(
        &self,
        run_id: &str,
        approved: bool,
        note: Option<&str>,
        workflow: Workflow,
    ) -> Result<(), EngineError> {
        self.approve_run_with_approval(run_id, approved, note, None, workflow)
            .await
    }

    pub async fn approve_run_with_approval(
        &self,
        run_id: &str,
        approved: bool,
        note: Option<&str>,
        expected_approval_id: Option<i64>,
        workflow: Workflow,
    ) -> Result<(), EngineError> {
        let workflow = self.db.get_run_workflow(run_id)?.unwrap_or(workflow);

        if !self.cancel.decide_paused_run(
            &self.db,
            run_id,
            approved,
            note.unwrap_or("").trim(),
            expected_approval_id,
        )? {
            return Err(EngineError::NotPaused(run_id.to_string()));
        }
        if approved {
            self.execute(workflow, run_id.to_string()).await;
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
enum FailFast {
    Cancelled,
    Failure(String),
}

struct ApplyEffect {
    run_failed: Option<String>,
}

/// One completed node to route through the graph.
struct Completion<'a> {
    node_id: &'a str,
    outcome: NodeOutcome,
    branch: Option<bool>,
    record: bool,
}

enum RunOutcome {
    Finished(RunStatus),
    Paused,
}

/// Owned inputs for a spawned node task.
struct TaskInput {
    node: Node,
    workflow_id: String,
    workflow_name: String,
    workflow_defaults: Option<crate::workflow::WorkflowDefaults>,
    run_id: String,
    inputs: HashMap<String, String>,
}

/// Execute one node (Start/End/Command/Agent/Condition) with retries.
/// Approval and skip handling live in the scheduler, never here.
async fn execute_node_task(
    db: Arc<SqliteDb>,
    task: TaskInput,
    flag: Arc<AtomicBool>,
) -> TaskOutcome {
    let node_id = task.node.id.clone();
    match task.node.kind {
        NodeKind::Start | NodeKind::End => {
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                &node_id,
                "succeeded",
                Some(0),
                None,
            ));
            TaskOutcome::Succeeded
        }
        NodeKind::Approval => {
            // Scheduler never spawns approvals; defensive failure.
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                &node_id,
                "failed",
                None,
                Some("Approval reached worker (scheduler bug)."),
            ));
            TaskOutcome::Failed
        }
        NodeKind::Condition => execute_condition_task(&db, &task, &node_id),
        NodeKind::Git => execute_git_task(&db, &task, &node_id, &flag).await,
        NodeKind::GitHub => execute_github_task(&db, &task, &node_id, &flag).await,
        NodeKind::Ticket => execute_ticket_task(&db, &task, &node_id, &flag).await,
        NodeKind::Mcp => execute_mcp_task(&db, &task, &node_id, &flag).await,
        NodeKind::Command => {
            let exe = task.node.config.executable.clone().unwrap_or_default();
            let vars = match build_vars(
                &db,
                &task.workflow_id,
                &task.workflow_name,
                &task.run_id,
                &task.inputs,
            ) {
                Ok(vars) => vars,
                Err(error) => {
                    let error = error.to_string();
                    let _ = db.record_node_result(NewNodeResult::simple(
                        &task.run_id,
                        &node_id,
                        "failed",
                        None,
                        Some(&error),
                    ));
                    return TaskOutcome::Failed;
                }
            };
            let mut args = Vec::new();
            for argument in &task.node.config.args {
                let (rendered, missing) = render_prompt(argument, &vars);
                if !missing.is_empty() {
                    let error = format!("Missing command variables: {}.", missing.join(", "));
                    let _ = db.record_node_result(NewNodeResult::simple(
                        &task.run_id,
                        &node_id,
                        "failed",
                        None,
                        Some(&error),
                    ));
                    return TaskOutcome::Failed;
                }
                args.push(rendered);
            }
            let timeout = task
                .node
                .config
                .timeout_secs
                .unwrap_or(DEFAULT_COMMAND_TIMEOUT.as_secs())
                .clamp(1, MAX_TIMEOUT_SECS);
            let retry = task.node.config.retry.clone();
            // Blank node dir inherits the workflow default: repo-bound commands
            // (docker compose, test runners) run where the repo is, not in the
            // app's own directory. Explicit node dirs always win.
            let working_dir = command_working_dir(&task);
            run_with_retries(RetryRequest {
                db: &db,
                run_id: &task.run_id,
                node_id: &node_id,
                executable: &exe,
                args: &args,
                working_dir,
                timeout: Duration::from_secs(timeout),
                retry,
                extend_on_output: task.node.config.extend_on_output,
                flag: &flag,
            })
            .await
        }
        NodeKind::Agent => execute_agent_task(&db, &task, &node_id, &flag).await,
    }
}

fn execute_condition_task(db: &Arc<SqliteDb>, task: &TaskInput, node_id: &str) -> TaskOutcome {
    let config = match task.node.config.condition.as_ref() {
        Some(config) => config,
        None => {
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some("Condition node has no expression."),
            ));
            return TaskOutcome::Failed;
        }
    };
    let vars = match build_vars(
        db,
        &task.workflow_id,
        &task.workflow_name,
        &task.run_id,
        &task.inputs,
    ) {
        Ok(vars) => vars,
        Err(e) => {
            let message = e.to_string();
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some(&message),
            ));
            return TaskOutcome::Failed;
        }
    };
    match eval_condition(config, &vars) {
        Ok(branch) => {
            let structured = if branch {
                "{\"branch\":\"true\"}"
            } else {
                "{\"branch\":\"false\"}"
            };
            let _ = db.record_node_result(NewNodeResult {
                run_id: &task.run_id,
                node_id,
                status: "succeeded",
                exit_code: Some(0),
                stdout: if branch { "true" } else { "false" },
                stderr: "",
                error: None,
                attempt: 1,
                duration_ms: 0,
                structured_json: structured,
            });
            TaskOutcome::ConditionBranch(branch)
        }
        Err(e) => {
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some(&format!("Condition error: {e}")),
            ));
            TaskOutcome::Failed
        }
    }
}

async fn execute_agent_task(
    db: &Arc<SqliteDb>,
    task: &TaskInput,
    node_id: &str,
    flag: &Arc<AtomicBool>,
) -> TaskOutcome {
    let profile_id = task
        .node
        .config
        .agent_profile_id
        .clone()
        .unwrap_or_default();
    let profile: AgentProfile = match db.get_agent_profile(&profile_id) {
        Ok(Some(profile)) => profile,
        _ => {
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some(&format!("Unknown Agent Profile '{profile_id}'.")),
            ));
            return TaskOutcome::Failed;
        }
    };
    if !is_executable_available(&profile.effective_executable()) {
        let _ = db.record_node_result(NewNodeResult::simple(
            &task.run_id,
            node_id,
            "failed",
            None,
            Some(&format!(
                "Agent Profile '{}' needs '{}', which was not found on PATH.",
                profile.name,
                profile.effective_executable()
            )),
        ));
        return TaskOutcome::Failed;
    }
    let vars = match build_vars(
        db,
        &task.workflow_id,
        &task.workflow_name,
        &task.run_id,
        &task.inputs,
    ) {
        Ok(vars) => vars,
        Err(e) => {
            let message = e.to_string();
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some(&message),
            ));
            return TaskOutcome::Failed;
        }
    };
    let template = task.node.config.prompt.clone().unwrap_or_default();
    let (rendered, missing) = render_prompt(&template, &vars);
    if !missing.is_empty() {
        let _ = db.record_node_result(NewNodeResult::simple(
            &task.run_id,
            node_id,
            "failed",
            None,
            Some(&format!(
                "Missing prompt variables: {}. Referenced inputs must come from completed upstream nodes.",
                missing.join(", ")
            )),
        ));
        return TaskOutcome::Failed;
    }
    let spec =
        match build_agent_command(&profile, &rendered, task.node.config.working_dir.as_deref()) {
            Ok(spec) => spec,
            Err(e) => {
                let _ = db.record_node_result(NewNodeResult::simple(
                    &task.run_id,
                    node_id,
                    "failed",
                    None,
                    Some(&e),
                ));
                return TaskOutcome::Failed;
            }
        };
    if let Some(dir) = spec.working_dir.as_deref() {
        let _ = db.touch_known_folder(dir);
    }
    let timeout = task
        .node
        .config
        .timeout_secs
        .unwrap_or(profile.default_timeout_secs)
        .clamp(1, MAX_TIMEOUT_SECS);
    let retry = task.node.config.retry.clone();
    run_with_retries(RetryRequest {
        db,
        run_id: &task.run_id,
        node_id,
        executable: &spec.executable,
        args: &spec.args,
        working_dir: spec.working_dir.as_deref(),
        timeout: Duration::from_secs(timeout),
        retry,
        extend_on_output: task.node.config.extend_on_output,
        flag,
    })
    .await
}

/// Resolve the repository root for integration nodes: explicit node
/// working directory first, then the workflow default. Fails clearly when
/// neither is set or the directory is not a repo.
fn resolve_repo_root(task: &TaskInput) -> Result<String, String> {
    let mut dir = task.node.config.working_dir.as_deref().unwrap_or("").trim();
    if dir.is_empty() {
        dir = task
            .workflow_defaults
            .as_ref()
            .and_then(|d| d.repo_dir.as_deref())
            .unwrap_or("")
            .trim();
    }
    if dir.is_empty() {
        return Err(
            "Git/GitHub nodes need a working directory: set it on the node or set a workflow default.".to_string(),
        );
    }
    if !std::path::Path::new(dir).is_dir() {
        return Err(format!("Working directory does not exist: {dir}"));
    }
    crate::git::discover_root(dir).ok_or_else(|| format!("Not a git repository: {dir}"))
}

/// Working directory for command nodes: explicit node dir wins, blank
/// inherits the workflow default (repo-bound commands run in the repo).
fn command_working_dir(task: &TaskInput) -> Option<&str> {
    let node_dir = task.node.config.working_dir.as_deref().unwrap_or("").trim();
    if node_dir.is_empty() {
        task.workflow_defaults
            .as_ref()
            .and_then(|d| d.repo_dir.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    } else {
        Some(node_dir)
    }
}

/// Workflow default branch, when set and non-blank.
fn default_branch(task: &TaskInput) -> Option<&str> {
    task.workflow_defaults
        .as_ref()
        .and_then(|d| d.branch.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Fill empty branch fields in a rendered git op from the workflow default.
/// Explicit values always win; nodes without a default behave as before.
fn apply_git_branch_default(
    op: crate::workflow::GitOp,
    task: &TaskInput,
) -> crate::workflow::GitOp {
    use crate::workflow::GitOp as Op;
    let Some(branch) = default_branch(task) else {
        return op;
    };
    match op {
        Op::BranchCreate { name } if name.trim().is_empty() => Op::BranchCreate {
            name: branch.to_string(),
        },
        Op::Checkout { name, allow_dirty } if name.trim().is_empty() => Op::Checkout {
            name: branch.to_string(),
            allow_dirty,
        },
        Op::WorktreeAdd { path, branch: None } => Op::WorktreeAdd {
            path,
            branch: Some(branch.to_string()),
        },
        other => other,
    }
}

/// Fill an empty PR head (CreatePr) from the workflow default branch.
/// Explicit values always win.
fn apply_github_branch_default(
    op: crate::workflow::GitHubOp,
    task: &TaskInput,
) -> crate::workflow::GitHubOp {
    use crate::workflow::GitHubOp as Op;
    let Some(branch) = default_branch(task) else {
        return op;
    };
    match op {
        Op::CreatePr {
            title,
            body,
            base,
            head,
            draft,
        } if head.trim().is_empty() => Op::CreatePr {
            title,
            body,
            base,
            head: branch.to_string(),
            draft,
        },
        other => other,
    }
}

/// Timeout for integration nodes (shorter default than AI commands).
fn integration_timeout(task: &TaskInput) -> Duration {
    Duration::from_secs(
        task.node
            .config
            .timeout_secs
            .unwrap_or(60)
            .clamp(1, MAX_TIMEOUT_SECS),
    )
}

/// Record a finished blocking integration call.
fn record_integration_result(
    db: &Arc<SqliteDb>,
    run_id: &str,
    node_id: &str,
    duration_ms: u64,
    outcome: Result<(String, String), String>,
    provenance: &str,
) -> TaskOutcome {
    match outcome {
        Ok((stdout, structured)) => {
            let with_provenance = merge_provenance(&structured, provenance);
            let _ = db.record_node_result(NewNodeResult {
                run_id,
                node_id,
                status: "succeeded",
                exit_code: Some(0),
                stdout: &truncate_chars(stdout),
                stderr: "",
                error: None,
                attempt: 1,
                duration_ms,
                structured_json: &with_provenance,
            });
            TaskOutcome::Succeeded
        }
        Err(message) => {
            let _ = db.record_node_result(NewNodeResult {
                run_id,
                node_id,
                status: "failed",
                exit_code: None,
                stdout: "",
                stderr: "",
                error: Some(&message),
                attempt: 1,
                duration_ms,
                structured_json: "{}",
            });
            TaskOutcome::Failed
        }
    }
}

/// Attach `{"provenance": …}` next to a structured payload (best effort).
fn merge_provenance(structured: &str, provenance: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(structured) {
        Ok(serde_json::Value::Object(mut map)) => {
            map.insert(
                "provenance".to_string(),
                serde_json::Value::String(provenance.to_string()),
            );
            serde_json::Value::Object(map).to_string()
        }
        _ => format!("{{\"provenance\":\"{provenance}\"}}"),
    }
}

async fn execute_git_task(
    db: &Arc<SqliteDb>,
    task: &TaskInput,
    node_id: &str,
    flag: &Arc<AtomicBool>,
) -> TaskOutcome {
    if flag.load(Ordering::SeqCst) {
        return TaskOutcome::Cancelled;
    }
    let op = match task.node.config.git_op.clone() {
        Some(op) => op,
        None => {
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some("Git node has no operation."),
            ));
            return TaskOutcome::Failed;
        }
    };
    let root = match resolve_repo_root(task) {
        Ok(root) => root,
        Err(e) => {
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some(&e),
            ));
            return TaskOutcome::Failed;
        }
    };
    let vars = match build_vars(
        db,
        &task.workflow_id,
        &task.workflow_name,
        &task.run_id,
        &task.inputs,
    ) {
        Ok(vars) => vars,
        Err(e) => {
            let message = e.to_string();
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some(&message),
            ));
            return TaskOutcome::Failed;
        }
    };
    // Render {{…}} templates inside user-supplied Git strings (commit message,
    // branch names, worktree paths) so native nodes can ask for values via
    // workflow inputs. Missing variables fail the run instead of committing
    // with silently empty text.
    let op = match render_git_op(&op, &vars) {
        Ok(op) => apply_git_branch_default(op, task),
        Err(e) => {
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some(&e),
            ));
            return TaskOutcome::Failed;
        }
    };
    let started = Instant::now();
    let blocking = tokio::task::spawn_blocking(move || do_git_op(&op, &root)).await;
    let duration_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    if flag.load(Ordering::SeqCst) {
        let _ = db.record_node_result(NewNodeResult::simple(
            &task.run_id,
            node_id,
            "cancelled",
            None,
            Some("Cancelled by user."),
        ));
        return TaskOutcome::Cancelled;
    }
    match blocking {
        Ok(outcome) => {
            record_integration_result(db, &task.run_id, node_id, duration_ms, outcome, "git")
        }
        Err(_) => {
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some("Git worker panicked."),
            ));
            TaskOutcome::Failed
        }
    }
}

/// Blocking git work (runs on a blocking thread). Returns display text +
/// structured JSON for downstream conditions/prompts.
fn do_git_op(op: &crate::workflow::GitOp, root: &str) -> Result<(String, String), String> {
    use crate::workflow::GitOp as Op;
    match op {
        Op::Status => {
            let status = crate::git::status(root)?;
            let mut display = format!(
                "{} on {} ({})\n",
                status.root,
                status.branch,
                if status.clean { "clean" } else { "dirty" }
            );
            for file in status.changed_files.iter().take(50) {
                display.push_str(&format!("{} {}\n", file.status, file.path));
            }
            let mut structured_value = serde_json::to_value(&status).map_err(|e| e.to_string())?;
            // Cap embedded file lists; the display text already truncates.
            if let Some(files) = structured_value
                .get_mut("changedFiles")
                .and_then(|v| v.as_array_mut())
            {
                files.truncate(200);
            }
            Ok((display, structured_value.to_string()))
        }
        Op::DiffSummary => {
            let summary = crate::git::diff_summary(root)?;
            let display = format!(
                "{} file(s) changed, +{} -{}\n",
                summary.files_changed, summary.insertions, summary.deletions
            );
            let structured = serde_json::to_string(&summary).map_err(|e| e.to_string())?;
            Ok((display, structured))
        }
        Op::BranchCreate { name } => {
            let message = crate::git::branch_create(root, name)?;
            Ok((
                format!("{message}\n"),
                "{\"op\":\"branchCreate\"}".to_string(),
            ))
        }
        Op::Checkout { name, allow_dirty } => {
            let message = crate::git::checkout(root, name, *allow_dirty)?;
            Ok((format!("{message}\n"), "{\"op\":\"checkout\"}".to_string()))
        }
        Op::Stage { paths } => {
            let message = crate::git::stage(root, paths)?;
            Ok((format!("{message}\n"), "{\"op\":\"stage\"}".to_string()))
        }
        Op::Commit { message } => {
            let done = crate::git::commit_staged(root, message)?;
            Ok((format!("{done}\n"), "{\"op\":\"commit\"}".to_string()))
        }
        Op::WorktreeAdd { path, branch } => {
            let message = crate::git::worktree_add(root, path, branch.as_deref())?;
            let structured = serde_json::json!({"op": "worktreeAdd", "path": path});
            Ok((format!("{message}\n"), structured.to_string()))
        }
        Op::WorktreeRemove { path } => {
            let message = crate::git::worktree_remove(root, path)?;
            Ok((
                format!("{message}\n"),
                "{\"op\":\"worktreeRemove\"}".to_string(),
            ))
        }
        Op::WorktreeList => {
            let list = crate::git::worktree_list(root)?;
            let mut display = String::new();
            for worktree in &list {
                display.push_str(&format!("{} ({})\n", worktree.path, worktree.branch));
            }
            let structured = serde_json::to_string(&list).map_err(|e| e.to_string())?;
            Ok((display, structured))
        }
        Op::Remotes => {
            let all = crate::git::remotes(root)?;
            let mut display = String::new();
            for remote in &all {
                display.push_str(&format!("{} {}\n", remote.name, remote.url));
            }
            let structured = serde_json::to_string(&all).map_err(|e| e.to_string())?;
            Ok((display, structured))
        }
    }
}

/// Run a command with bounded retries. Every attempt is persisted: failed
/// non-final attempts as `retrying`, the final one as `succeeded`/`failed`.
async fn execute_github_task(
    db: &Arc<SqliteDb>,
    task: &TaskInput,
    node_id: &str,
    flag: &Arc<AtomicBool>,
) -> TaskOutcome {
    if flag.load(Ordering::SeqCst) {
        return TaskOutcome::Cancelled;
    }
    let op = match task.node.config.github_op.clone() {
        Some(op) => op,
        None => {
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some("GitHub node has no operation."),
            ));
            return TaskOutcome::Failed;
        }
    };
    let root = match resolve_repo_root(task) {
        Ok(root) => root,
        Err(e) => {
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some(&e),
            ));
            return TaskOutcome::Failed;
        }
    };
    let vars = match build_vars(
        db,
        &task.workflow_id,
        &task.workflow_name,
        &task.run_id,
        &task.inputs,
    ) {
        Ok(vars) => vars,
        Err(e) => {
            let message = e.to_string();
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some(&message),
            ));
            return TaskOutcome::Failed;
        }
    };
    // Render templates inside the op (titles/bodies/branches may use inputs).
    // PR number 0 means "from runtime inputs" (watchers pass prNumber).
    let op = match resolve_pr_number(&op, &task.inputs) {
        Ok(op) => op,
        Err(e) => {
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some(&e),
            ));
            return TaskOutcome::Failed;
        }
    };
    let op = match render_github_op(&op, &vars) {
        Ok(op) => apply_github_branch_default(op, task),
        Err(e) => {
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some(&e),
            ));
            return TaskOutcome::Failed;
        }
    };
    let timeout = integration_timeout(task);
    let started = Instant::now();
    let blocking = tokio::task::spawn_blocking(move || do_github_op(&op, &root, timeout)).await;
    let duration_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    if flag.load(Ordering::SeqCst) {
        let _ = db.record_node_result(NewNodeResult::simple(
            &task.run_id,
            node_id,
            "cancelled",
            None,
            Some("Cancelled by user."),
        ));
        return TaskOutcome::Cancelled;
    }
    match blocking {
        Ok(outcome) => {
            record_integration_result(db, &task.run_id, node_id, duration_ms, outcome, "gh")
        }
        Err(_) => {
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some("GitHub worker panicked."),
            ));
            TaskOutcome::Failed
        }
    }
}

/// Resolve PR number 0 from runtime inputs (watchers inject `prNumber`).
/// Explicit numbers pass through untouched.
fn resolve_pr_number(
    op: &crate::workflow::GitHubOp,
    inputs: &HashMap<String, String>,
) -> Result<crate::workflow::GitHubOp, String> {
    use crate::workflow::GitHubOp as Op;
    let from_inputs = || {
        inputs
            .get("prNumber")
            .and_then(|s| s.trim().parse::<u64>().ok())
            .filter(|n| *n > 0)
            .ok_or_else(|| {
                "PR number is 0: provide inputs.prNumber (watchers pass it automatically)."
                    .to_string()
            })
    };
    Ok(match op {
        Op::PrDetails { number } if *number == 0 => Op::PrDetails {
            number: from_inputs()?,
        },
        Op::PrFiles { number } if *number == 0 => Op::PrFiles {
            number: from_inputs()?,
        },
        Op::PrChecks { number } if *number == 0 => Op::PrChecks {
            number: from_inputs()?,
        },
        Op::PostComment { number, body } if *number == 0 => Op::PostComment {
            number: from_inputs()?,
            body: body.clone(),
        },
        other => other.clone(),
    })
}

/// Render `{{…}}` templates inside a GitHub op; missing vars fail the node.
fn render_git_op(
    op: &crate::workflow::GitOp,
    vars: &HashMap<String, String>,
) -> Result<crate::workflow::GitOp, String> {
    use crate::workflow::GitOp as Op;
    let render = |template: &str| {
        let (rendered, missing) = render_prompt(template, vars);
        if missing.is_empty() {
            Ok(rendered)
        } else {
            Err(format!("Missing variables: {}", missing.join(", ")))
        }
    };
    // Only render templates when the value actually contains `{{`; plain
    // values pass through untouched (and keep strict failure for typos).
    let render_maybe = |template: &str| {
        if template.contains("{{") {
            render(template)
        } else {
            Ok(template.to_string())
        }
    };
    Ok(match op {
        Op::Status => Op::Status,
        Op::DiffSummary => Op::DiffSummary,
        Op::BranchCreate { name } => Op::BranchCreate {
            name: render_maybe(name)?,
        },
        Op::Checkout { name, allow_dirty } => Op::Checkout {
            name: render_maybe(name)?,
            allow_dirty: *allow_dirty,
        },
        Op::Stage { paths } => Op::Stage {
            paths: paths.clone(),
        },
        Op::Commit { message } => Op::Commit {
            message: render(message)?,
        },
        Op::WorktreeAdd { path, branch } => Op::WorktreeAdd {
            path: render_maybe(path)?,
            branch: match branch {
                Some(b) => Some(render_maybe(b)?),
                None => None,
            },
        },
        Op::WorktreeRemove { path } => Op::WorktreeRemove {
            path: render_maybe(path)?,
        },
        Op::WorktreeList => Op::WorktreeList,
        Op::Remotes => Op::Remotes,
    })
}

fn render_github_op(
    op: &crate::workflow::GitHubOp,
    vars: &HashMap<String, String>,
) -> Result<crate::workflow::GitHubOp, String> {
    use crate::workflow::GitHubOp as Op;
    let render = |template: &str| {
        let (rendered, missing) = render_prompt(template, vars);
        if missing.is_empty() {
            Ok(rendered)
        } else {
            Err(format!("Missing variables: {}", missing.join(", ")))
        }
    };
    Ok(match op {
        Op::PrStatus => Op::PrStatus,
        Op::ListPrs { state } => Op::ListPrs {
            state: state.clone(),
        },
        Op::PrDetails { number } => Op::PrDetails { number: *number },
        Op::PrFiles { number } => Op::PrFiles { number: *number },
        Op::PrChecks { number } => Op::PrChecks { number: *number },
        Op::CreatePr {
            title,
            body,
            base,
            head,
            draft,
        } => Op::CreatePr {
            title: render(title)?,
            body: render(body)?,
            base: render(base)?,
            head: render(head)?,
            draft: *draft,
        },
        Op::PostComment { number, body } => Op::PostComment {
            number: *number,
            body: render(body)?,
        },
    })
}

fn do_github_op(
    op: &crate::workflow::GitHubOp,
    root: &str,
    timeout: Duration,
) -> Result<(String, String), String> {
    use crate::workflow::GitHubOp as Op;
    let runner = crate::github::GhRunner {
        executable: crate::github::default_executable(),
        timeout_secs: timeout.as_secs().max(5),
    };
    match op {
        Op::PrStatus => match crate::github::pr_for_branch(&runner, root)? {
            Some(pr) => {
                let display = format!("#{} {} ({})\n{}\n", pr.number, pr.title, pr.state, pr.url);
                Ok((display, serde_json::json!({"pr": pr}).to_string()))
            }
            None => Ok((
                "No open PR for the current branch.\n".to_string(),
                "{\"pr\":null}".to_string(),
            )),
        },
        Op::ListPrs { state } => {
            let prs = crate::github::list_prs(&runner, root, state.as_deref().unwrap_or("open"))?;
            let mut display = String::new();
            for pr in &prs {
                display.push_str(&format!(
                    "#{} {} [{}]{}\n",
                    pr.number,
                    pr.title,
                    pr.state,
                    if pr.is_draft { " (draft)" } else { "" }
                ));
            }
            Ok((display, serde_json::json!({"prs": prs}).to_string()))
        }
        Op::PrDetails { number } => {
            let pr = crate::github::pr_details(&runner, root, *number)?;
            let display = format!(
                "#{} {} by {} ({} → {})\nSHA {}\n{}\n",
                pr.number, pr.title, pr.author, pr.head_branch, pr.base_branch, pr.head_sha, pr.url
            );
            Ok((display, serde_json::json!({"pr": pr}).to_string()))
        }
        Op::PrFiles { number } => {
            let files = crate::github::pr_files(&runner, root, *number)?;
            let mut display = String::new();
            for file in files.iter().take(100) {
                display.push_str(&format!(
                    "{} +{} -{}\n",
                    file.path, file.additions, file.deletions
                ));
            }
            Ok((display, serde_json::json!({"files": files}).to_string()))
        }
        Op::PrChecks { number } => {
            let checks = crate::github::pr_checks(&runner, root, *number)?;
            let mut display = String::new();
            for check in &checks {
                display.push_str(&format!(
                    "{}: {} ({})\n",
                    check.name, check.state, check.conclusion
                ));
            }
            Ok((display, serde_json::json!({"checks": checks}).to_string()))
        }
        Op::CreatePr {
            title,
            body,
            base,
            head,
            draft,
        } => {
            let created = crate::github::create_pr(
                &runner,
                root,
                &crate::github::CreatePrRequest {
                    title: title.clone(),
                    body: body.clone(),
                    base: base.clone(),
                    head: head.clone(),
                    draft: *draft,
                },
            )?;
            let display = format!("#{} {}\n{}\n", created.number, created.title, created.url);
            Ok((display, serde_json::json!({"pr": created}).to_string()))
        }
        Op::PostComment { number, body } => {
            let done = crate::github::post_comment(&runner, root, *number, body)?;
            Ok((
                format!("{done}\n"),
                serde_json::json!({"op": "postComment", "number": number}).to_string(),
            ))
        }
    }
}

async fn execute_ticket_task(
    db: &Arc<SqliteDb>,
    task: &TaskInput,
    node_id: &str,
    flag: &Arc<AtomicBool>,
) -> TaskOutcome {
    if flag.load(Ordering::SeqCst) {
        return TaskOutcome::Cancelled;
    }
    let server_id = task.node.config.mcp_server_id.clone().unwrap_or_default();
    let key_template = task.node.config.ticket_key.clone().unwrap_or_default();
    let server = match db.get_mcp_server(&server_id) {
        Ok(Some(server)) => server,
        _ => {
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some(&format!("Unknown or unavailable MCP server '{server_id}'.")),
            ));
            return TaskOutcome::Failed;
        }
    };
    if !server.enabled {
        let _ = db.record_node_result(NewNodeResult::simple(
            &task.run_id,
            node_id,
            "failed",
            None,
            Some(&format!("MCP server '{}' is disabled.", server.name)),
        ));
        return TaskOutcome::Failed;
    }
    let vars = match build_vars(
        db,
        &task.workflow_id,
        &task.workflow_name,
        &task.run_id,
        &task.inputs,
    ) {
        Ok(vars) => vars,
        Err(e) => {
            let message = e.to_string();
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some(&message),
            ));
            return TaskOutcome::Failed;
        }
    };
    let (rendered_key, missing) = render_prompt(&key_template, &vars);
    if !missing.is_empty() {
        let _ = db.record_node_result(NewNodeResult::simple(
            &task.run_id,
            node_id,
            "failed",
            None,
            Some(&format!(
                "Missing ticket key variables: {}",
                missing.join(", ")
            )),
        ));
        return TaskOutcome::Failed;
    }
    let timeout = integration_timeout(task);
    let flag_clone = Arc::clone(flag);
    let started = Instant::now();
    let blocking = tokio::task::spawn_blocking(move || {
        let source = crate::ticket::JiraMcpSource {
            server,
            tool_name: "jira_get_issue".to_string(),
            timeout,
            cancel: flag_clone,
            max_context_chars: 8000,
        };
        use crate::ticket::TicketSource;
        source.load_ticket(rendered_key.trim())
    })
    .await;
    let duration_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    if flag.load(Ordering::SeqCst) {
        let _ = db.record_node_result(NewNodeResult::simple(
            &task.run_id,
            node_id,
            "cancelled",
            None,
            Some("Cancelled by user."),
        ));
        return TaskOutcome::Cancelled;
    }
    match blocking {
        Ok(Ok(ticket)) => {
            let structured = serde_json::json!({"ticket": ticket}).to_string();
            let with_provenance = merge_provenance(&structured, "jira-mcp");
            let _ = db.record_node_result(NewNodeResult {
                run_id: &task.run_id,
                node_id,
                status: "succeeded",
                exit_code: Some(0),
                stdout: &truncate_chars(ticket.prompt_context(8000)),
                stderr: "",
                error: None,
                attempt: 1,
                duration_ms,
                structured_json: &with_provenance,
            });
            TaskOutcome::Succeeded
        }
        Ok(Err(e)) => {
            let _ = db.record_node_result(NewNodeResult {
                run_id: &task.run_id,
                node_id,
                status: "failed",
                exit_code: None,
                stdout: "",
                stderr: "",
                error: Some(&e),
                attempt: 1,
                duration_ms,
                structured_json: "{}",
            });
            TaskOutcome::Failed
        }
        Err(_) => {
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some("Ticket worker panicked."),
            ));
            TaskOutcome::Failed
        }
    }
}

async fn execute_mcp_task(
    db: &Arc<SqliteDb>,
    task: &TaskInput,
    node_id: &str,
    flag: &Arc<AtomicBool>,
) -> TaskOutcome {
    if flag.load(Ordering::SeqCst) {
        return TaskOutcome::Cancelled;
    }
    let server_id = task.node.config.mcp_server_id.clone().unwrap_or_default();
    let tool = task.node.config.mcp_tool.clone().unwrap_or_default();
    let server = match db.get_mcp_server(&server_id) {
        Ok(Some(server)) => server,
        _ => {
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some(&format!("Unknown or unavailable MCP server '{server_id}'.")),
            ));
            return TaskOutcome::Failed;
        }
    };
    if !server.enabled {
        let _ = db.record_node_result(NewNodeResult::simple(
            &task.run_id,
            node_id,
            "failed",
            None,
            Some(&format!("MCP server '{}' is disabled.", server.name)),
        ));
        return TaskOutcome::Failed;
    }
    let vars = match build_vars(
        db,
        &task.workflow_id,
        &task.workflow_name,
        &task.run_id,
        &task.inputs,
    ) {
        Ok(vars) => vars,
        Err(e) => {
            let message = e.to_string();
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some(&message),
            ));
            return TaskOutcome::Failed;
        }
    };
    // Render each argument value as a template; missing vars fail the node.
    let mut args_json = serde_json::Map::new();
    for (key, template) in task.node.config.mcp_args.clone().unwrap_or_default() {
        let (rendered, missing) = render_prompt(&template, &vars);
        if !missing.is_empty() {
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some(&format!(
                    "Missing MCP argument variables for '{key}': {}",
                    missing.join(", ")
                )),
            ));
            return TaskOutcome::Failed;
        }
        args_json.insert(key, serde_json::Value::String(rendered));
    }
    let timeout = integration_timeout(task);
    let flag_clone = Arc::clone(flag);
    let started = Instant::now();
    let blocking = tokio::task::spawn_blocking(move || {
        crate::mcp::call_tool(
            &server,
            tool.trim(),
            &serde_json::Value::Object(args_json),
            timeout,
            &flag_clone,
        )
    })
    .await;
    let duration_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    if flag.load(Ordering::SeqCst) {
        let _ = db.record_node_result(NewNodeResult::simple(
            &task.run_id,
            node_id,
            "cancelled",
            None,
            Some("Cancelled by user."),
        ));
        return TaskOutcome::Cancelled;
    }
    match blocking {
        Ok(Ok(result)) => {
            // Tool-level errors fail the node (visible, with provenance).
            let provenance = format!("mcp:{}:{}", result.server_id, result.tool);
            let structured = serde_json::json!({
                "server": result.server_id,
                "tool": result.tool,
                "isError": result.is_error,
                "provenance": provenance,
            })
            .to_string();
            if result.is_error {
                let _ = db.record_node_result(NewNodeResult {
                    run_id: &task.run_id,
                    node_id,
                    status: "failed",
                    exit_code: None,
                    stdout: &truncate_chars(result.text.clone()),
                    stderr: "",
                    error: Some(&format!("MCP tool '{}' returned an error.", result.tool)),
                    attempt: 1,
                    duration_ms,
                    structured_json: &structured,
                });
                TaskOutcome::Failed
            } else {
                let _ = db.record_node_result(NewNodeResult {
                    run_id: &task.run_id,
                    node_id,
                    status: "succeeded",
                    exit_code: Some(0),
                    stdout: &truncate_chars(result.text),
                    stderr: "",
                    error: None,
                    attempt: 1,
                    duration_ms,
                    structured_json: &structured,
                });
                TaskOutcome::Succeeded
            }
        }
        Ok(Err(e)) => {
            let _ = db.record_node_result(NewNodeResult {
                run_id: &task.run_id,
                node_id,
                status: "failed",
                exit_code: None,
                stdout: "",
                stderr: "",
                error: Some(&e),
                attempt: 1,
                duration_ms,
                structured_json: "{}",
            });
            TaskOutcome::Failed
        }
        Err(_) => {
            let _ = db.record_node_result(NewNodeResult::simple(
                &task.run_id,
                node_id,
                "failed",
                None,
                Some("MCP worker panicked."),
            ));
            TaskOutcome::Failed
        }
    }
}

struct RetryRequest<'a> {
    db: &'a Arc<SqliteDb>,
    run_id: &'a str,
    node_id: &'a str,
    executable: &'a str,
    args: &'a [String],
    working_dir: Option<&'a str>,
    timeout: Duration,
    retry: Option<crate::workflow::RetryPolicy>,
    extend_on_output: bool,
    flag: &'a Arc<AtomicBool>,
}

async fn run_with_retries(request: RetryRequest<'_>) -> TaskOutcome {
    let RetryRequest {
        db,
        run_id,
        node_id,
        executable,
        args,
        working_dir,
        timeout,
        retry,
        extend_on_output,
        flag,
    } = request;
    let max_attempts = retry
        .as_ref()
        .map(|r| r.max_attempts.clamp(1, 10))
        .unwrap_or(1);
    let delay_ms = retry.as_ref().map(|r| r.delay_ms.min(60_000)).unwrap_or(0);
    let backoff = retry.as_ref().map(|r| r.backoff).unwrap_or(false);
    if let Some(dir) = working_dir {
        let _ = db.touch_known_folder(dir);
    }
    for attempt in 1..=max_attempts {
        if flag.load(Ordering::SeqCst) {
            let _ = db.record_node_result(NewNodeResult::simple(
                run_id,
                node_id,
                "cancelled",
                None,
                Some("Cancelled by user."),
            ));
            return TaskOutcome::Cancelled;
        }
        let started = Instant::now();
        let live_id = db.start_node_result(run_id, node_id, attempt).ok();
        let outcome = run_command_cancellable(
            executable,
            args,
            working_dir,
            timeout,
            extend_on_output,
            flag,
            live_id.map(|id| (db.as_ref(), id)),
        )
        .await;
        let duration_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
        match outcome {
            CommandOutcome::Completed {
                code,
                stdout,
                stderr,
            } => {
                let structured = severity_scan(&stdout)
                    .map(|sev| format!("{{\"severity\":\"{sev}\"}}"))
                    .unwrap_or_else(|| "{}".to_string());
                if code == Some(0) {
                    persist_command_result(
                        db,
                        live_id,
                        NewNodeResult {
                            run_id,
                            node_id,
                            status: "succeeded",
                            exit_code: code,
                            stdout: &stdout,
                            stderr: &stderr,
                            error: None,
                            attempt,
                            duration_ms,
                            structured_json: &structured,
                        },
                    );
                    return TaskOutcome::Succeeded;
                }
                let last = attempt == max_attempts;
                let error = if last {
                    format!("Command exited with status {}.", code.unwrap_or(-1))
                } else {
                    let wait = retry_delay(delay_ms, backoff, attempt);
                    format!(
                        "Attempt {attempt} of {max_attempts} failed (exit {}); retrying in {}ms.",
                        code.unwrap_or(-1),
                        wait.as_millis()
                    )
                };
                persist_command_result(
                    db,
                    live_id,
                    NewNodeResult {
                        run_id,
                        node_id,
                        status: if last { "failed" } else { "retrying" },
                        exit_code: code,
                        stdout: &stdout,
                        stderr: &stderr,
                        error: Some(&error),
                        attempt,
                        duration_ms,
                        structured_json: &structured,
                    },
                );
                if last {
                    return TaskOutcome::Failed;
                }
                if !sleep_interruptible(retry_delay(delay_ms, backoff, attempt), flag).await {
                    let _ = db.record_node_result(NewNodeResult::simple(
                        run_id,
                        node_id,
                        "cancelled",
                        None,
                        Some("Cancelled by user."),
                    ));
                    return TaskOutcome::Cancelled;
                }
            }
            CommandOutcome::Cancelled { stdout, stderr } => {
                persist_command_result(
                    db,
                    live_id,
                    NewNodeResult {
                        run_id,
                        node_id,
                        status: "cancelled",
                        exit_code: None,
                        stdout: &stdout,
                        stderr: &stderr,
                        error: Some("Cancelled by user."),
                        attempt,
                        duration_ms,
                        structured_json: "{}",
                    },
                );
                return TaskOutcome::Cancelled;
            }
        }
    }
    TaskOutcome::Failed
}

fn persist_command_result(db: &SqliteDb, live_id: Option<i64>, input: NewNodeResult<'_>) {
    match live_id {
        Some(id) => {
            let _ = db.finish_node_result(id, input);
        }
        None => {
            let _ = db.record_node_result(input);
        }
    }
}

fn retry_delay(base_ms: u64, backoff: bool, attempt: u32) -> Duration {
    if base_ms == 0 {
        return Duration::from_millis(0);
    }
    let factor: u64 = if backoff {
        1u64 << (attempt.saturating_sub(1).min(6))
    } else {
        1
    };
    Duration::from_millis(base_ms.saturating_mul(factor).min(60_000))
}

/// Sleep that returns false when cancellation arrives first.
async fn sleep_interruptible(duration: Duration, flag: &Arc<AtomicBool>) -> bool {
    if duration.is_zero() {
        return !flag.load(Ordering::SeqCst);
    }
    let deadline = Instant::now() + duration;
    while Instant::now() < deadline {
        if flag.load(Ordering::SeqCst) {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    !flag.load(Ordering::SeqCst)
}

/// Scan output for severity tokens (P0 highest). Convention-based: prompts
/// ask agents to tag findings; matching is substring with boundaries.
fn severity_scan(text: &str) -> Option<&str> {
    ["P0", "P1", "P2", "P3"]
        .into_iter()
        .find(|severity| contains_token(text, severity))
}

fn contains_token(text: &str, token: &str) -> bool {
    let bytes = text.as_bytes();
    let needle = token.as_bytes();
    if needle.len() > bytes.len() {
        return false;
    }
    for i in 0..=(bytes.len() - needle.len()) {
        if &bytes[i..i + needle.len()] != needle {
            continue;
        }
        let before = i.checked_sub(1).map(|j| bytes[j]);
        let after = bytes.get(i + needle.len()).copied();
        let boundary = |c: Option<u8>| {
            c.map(|b| !(b.is_ascii_alphanumeric() || b == b'_'))
                .unwrap_or(true)
        };
        if boundary(before) && boundary(after) {
            return true;
        }
    }
    false
}

fn severity_from_json(structured_json: &str) -> Option<String> {
    serde_json::from_str::<HashMap<String, String>>(structured_json)
        .ok()
        .and_then(|map| map.get("severity").cloned())
}

fn branch_of_row(row: &StoredNodeResult) -> Option<bool> {
    serde_json::from_str::<HashMap<String, String>>(&row.structured_json)
        .ok()
        .and_then(|map| map.get("branch").cloned())
        .map(|branch| branch == "true")
}

fn insert_row_vars(vars: &mut HashMap<String, String>, row: &StoredNodeResult) {
    vars.insert(format!("node.{}", row.node_id), row.stdout.clone());
    vars.insert(format!("node.{}.output", row.node_id), row.stdout.clone());
    if let Some(code) = row.exit_code {
        vars.insert(format!("node.{}.exitCode", row.node_id), code.to_string());
    }
    vars.insert(format!("node.{}.status", row.node_id), row.status.clone());
    if let Some(severity) = severity_from_json(&row.structured_json) {
        vars.insert(format!("node.{}.severity", row.node_id), severity);
    }
}

/// Variables for prompts/conditions: workflow identity, inputs, every
/// recorded node output (latest row wins), severity extras, visit counts.
fn build_vars(
    db: &SqliteDb,
    workflow_id: &str,
    workflow_name: &str,
    run_id: &str,
    inputs: &HashMap<String, String>,
) -> Result<HashMap<String, String>, EngineError> {
    let mut vars = HashMap::new();
    vars.insert("workflow.name".to_string(), workflow_name.to_string());
    vars.insert("workflow.id".to_string(), workflow_id.to_string());
    for (key, value) in inputs {
        vars.insert(format!("input.{key}"), value.clone());
    }
    let mut visits: HashMap<String, u32> = HashMap::new();
    let rows = db.list_node_results(run_id)?;
    for row in &rows {
        insert_row_vars(&mut vars, row);
        if is_terminal_status(&row.status)
            && matches!(
                row.status.as_str(),
                "succeeded" | "failed" | "approved" | "rejected"
            )
        {
            *visits.entry(row.node_id.clone()).or_insert(0) += 1;
        }
    }
    for (node_id, count) in visits {
        vars.insert(format!("node.{node_id}.visits"), count.to_string());
    }
    insert_ticket_from_rows(&mut vars, &rows);
    Ok(vars)
}

/// Row-driven `ticket.*` aliases from the latest successful Ticket node, so
/// prompts read `{{ticket.key}}` without hardcoding node ids.
fn insert_ticket_from_rows(
    vars: &mut HashMap<String, String>,
    rows: &[crate::db::StoredNodeResult],
) {
    for row in rows {
        if row.status != "succeeded" {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&row.structured_json) {
            if let Some(ticket) = value.get("ticket") {
                let str_field = |name: &str| {
                    ticket
                        .get(name)
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string()
                };
                // Latest ticket row wins (rows are in id order).
                vars.insert("ticket.key".to_string(), str_field("key"));
                vars.insert("ticket.title".to_string(), str_field("title"));
                vars.insert("ticket.description".to_string(), str_field("description"));
                vars.insert("ticket.status".to_string(), str_field("status"));
                vars.insert(
                    "ticket.url".to_string(),
                    ticket
                        .get("url")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                );
                let criteria = ticket
                    .get("acceptanceCriteria")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                vars.insert("ticket.acceptanceCriteria".to_string(), criteria);
            }
        }
    }
}

fn all_terminal(graph: &Graph, state: &RunState) -> bool {
    graph.nodes.keys().all(|id| state.terminal.contains_key(id))
}

/// Nodes reachable from `from` following outgoing edges (including `from`).
fn reachable_from_graph(graph: &Graph, from: &str) -> HashSet<String> {
    let mut seen = HashSet::new();
    let mut stack = vec![from.to_string()];
    while let Some(current) = stack.pop() {
        if !seen.insert(current.clone()) {
            continue;
        }
        if let Some(edges) = graph.outgoing.get(&current) {
            for edge in edges {
                stack.push(edge.target.clone());
            }
        }
    }
    seen
}

fn can_reach_graph(graph: &Graph, from: &str, target: &str) -> bool {
    reachable_from_graph(graph, from).contains(target)
}

enum CommandOutcome {
    Completed {
        code: Option<i32>,
        stdout: String,
        stderr: String,
    },
    Cancelled {
        stdout: String,
        stderr: String,
    },
}

/// Run a command with timeout + cancellation. The child is killed on cancel
/// or timeout (kill-on-drop + explicit kill).
///
/// When `extend_on_output` is set, the deadline slides with output activity
/// ("AI is working, not hanging"): every stdout/stderr chunk restarts the
/// countdown, up to MAX_TIMEOUT_SECS total. Partial output is always kept, so
/// a killed run still shows what the process produced.
async fn run_command_cancellable(
    executable: &str,
    args: &[String],
    working_dir: Option<&str>,
    timeout: Duration,
    extend_on_output: bool,
    cancel: &Arc<AtomicBool>,
    progress: Option<(&SqliteDb, i64)>,
) -> CommandOutcome {
    if executable.trim().is_empty() {
        return CommandOutcome::Completed {
            code: None,
            stdout: String::new(),
            stderr: "Executable must not be empty.".to_string(),
        };
    }
    if let Some(dir) = working_dir {
        if !std::path::Path::new(dir).is_dir() {
            return CommandOutcome::Completed {
                code: None,
                stdout: String::new(),
                stderr: format!("Working directory does not exist: {dir}"),
            };
        }
    }
    let resolved = match crate::tools::require_executable(executable) {
        Ok(path) => path,
        Err(message) => {
            return CommandOutcome::Completed {
                code: None,
                stdout: String::new(),
                stderr: message,
            };
        }
    };
    let mut cmd = tokio::process::Command::new(&resolved);
    cmd.args(args);
    if let Some(dir) = working_dir {
        cmd.current_dir(dir);
    }
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    // Ensure no orphaned children on drop.
    cmd.kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            return CommandOutcome::Completed {
                code: None,
                stdout: String::new(),
                stderr: format!("Failed to spawn '{executable}': {e}"),
            };
        }
    };

    let started = Instant::now();
    let absolute_ceiling = started + Duration::from_secs(MAX_TIMEOUT_SECS);
    // Incremental pipe readers: capture output while running (so activity
    // extends the deadline and partial output survives a kill).
    let capture = std::sync::Arc::new(std::sync::Mutex::new(Capture {
        stdout: Vec::new(),
        stderr: Vec::new(),
        last_output: started,
    }));
    async fn pump_pipe<R>(
        pipe: Option<R>,
        capture: std::sync::Arc<std::sync::Mutex<Capture>>,
        is_stdout: bool,
    ) where
        R: tokio::io::AsyncRead + Unpin,
    {
        let Some(mut pipe) = pipe else {
            return;
        };
        let mut buf = [0u8; 8192];
        loop {
            match tokio::io::AsyncReadExt::read(&mut pipe, &mut buf).await {
                Ok(0) => return,
                Ok(n) => {
                    if let Ok(mut guard) = capture.lock() {
                        guard.append(&buf[..n], is_stdout);
                    }
                }
                Err(_) => return,
            }
        }
    }
    let out_handle = tokio::spawn(pump_pipe(
        child.stdout.take(),
        std::sync::Arc::clone(&capture),
        true,
    ));
    let err_handle = tokio::spawn(pump_pipe(
        child.stderr.take(),
        std::sync::Arc::clone(&capture),
        false,
    ));
    let take_output = |ceiling_hit: bool| {
        let guard = capture.lock().ok();
        let (stdout, mut stderr) = match guard.as_deref() {
            Some(c) => (
                String::from_utf8_lossy(&c.stdout).into_owned(),
                String::from_utf8_lossy(&c.stderr).into_owned(),
            ),
            None => (String::new(), String::new()),
        };
        if ceiling_hit {
            stderr.push_str(&format!(
                "\nStopped after {}s (extend-on-output ceiling of 12 h).",
                MAX_TIMEOUT_SECS
            ));
        }
        (truncate_chars(stdout), truncate_chars(stderr))
    };
    let mut last_persisted = (0usize, 0usize);
    let mut last_flush = started;
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            let _ = child.wait().await;
            out_handle.abort();
            err_handle.abort();
            let (stdout, stderr) = take_output(false);
            return CommandOutcome::Cancelled { stdout, stderr };
        }
        let now = Instant::now();
        if now.duration_since(last_flush) >= Duration::from_millis(250) {
            if let Some((db, id)) = progress {
                if let Ok(guard) = capture.lock() {
                    let current = (guard.stdout.len(), guard.stderr.len());
                    if current != last_persisted {
                        let stdout =
                            truncate_chars(String::from_utf8_lossy(&guard.stdout).into_owned());
                        let stderr =
                            truncate_chars(String::from_utf8_lossy(&guard.stderr).into_owned());
                        let _ = db.update_node_output(id, &stdout, &stderr);
                        last_persisted = current;
                    }
                }
            }
            last_flush = now;
        }
        let deadline = if extend_on_output {
            let last = capture
                .lock()
                .ok()
                .map(|c| c.last_output)
                .unwrap_or(started);
            (last + timeout).min(absolute_ceiling)
        } else {
            started + timeout
        };
        if now >= absolute_ceiling && extend_on_output {
            let _ = child.kill().await;
            let _ = child.wait().await;
            // Bounded drain: grandchildren can hold pipes open after the
            // child dies; never wait on them forever.
            let _ = tokio::time::timeout(Duration::from_secs(2), async {
                let _ = tokio::join!(out_handle, err_handle);
            })
            .await;
            let (stdout, stderr) = take_output(true);
            return CommandOutcome::Completed {
                code: None,
                stdout,
                stderr,
            };
        }
        if now >= deadline {
            let _ = child.kill().await;
            let _ = child.wait().await;
            // Bounded drain: grandchildren can hold pipes open after the
            // child dies; never wait on them forever.
            let _ = tokio::time::timeout(Duration::from_secs(2), async {
                let _ = tokio::join!(out_handle, err_handle);
            })
            .await;
            let (stdout, mut stderr) = take_output(false);
            stderr.push_str(&format!(
                "\nCommand timed out after {}s and was killed.{}",
                timeout.as_secs(),
                if extend_on_output {
                    " (no output arrived in time)"
                } else {
                    ""
                }
            ));
            return CommandOutcome::Completed {
                code: None,
                stdout,
                stderr: truncate_chars(stderr),
            };
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let _ = child.wait().await;
                // Bounded drain: grandchildren can hold pipes open after the
                // child dies; never wait on them forever.
                let _ = tokio::time::timeout(Duration::from_secs(2), async {
                    let _ = tokio::join!(out_handle, err_handle);
                })
                .await;
                let (stdout, stderr) = take_output(false);
                return CommandOutcome::Completed {
                    code: status.code(),
                    stdout,
                    stderr,
                };
            }
            Ok(None) => tokio::time::sleep(Duration::from_millis(25)).await,
            Err(_) => {
                let _ = child.kill().await;
                return CommandOutcome::Completed {
                    code: None,
                    stdout: String::new(),
                    stderr: "Failed to wait on child process.".to_string(),
                };
            }
        }
    }
}

/// Check an executable name/path without spawning it.
fn is_executable_available(exe: &str) -> bool {
    let trimmed = exe.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return std::path::Path::new(trimmed).is_file();
    }
    find_executable(trimmed).is_some()
}

fn truncate_chars(s: String) -> String {
    if s.chars().count() > MAX_STREAM_CHARS {
        let truncated: String = s.chars().take(MAX_STREAM_CHARS).collect();
        format!("{truncated}\n… [truncated]")
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poisoned_cancellation_registry_recovers_without_losing_flags() {
        let registry = CancellationRegistry::default();
        let flag = registry.flag_for("run-poisoned");
        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = registry.inner.lock().expect("initial lock");
            panic!("simulate registry poison");
        }));
        assert!(poisoned.is_err());
        assert!(registry.cancel("run-poisoned"));
        assert!(flag.load(Ordering::SeqCst));
        assert!(Arc::ptr_eq(&flag, &registry.flag_for("run-poisoned")));
        registry.remove("run-poisoned");
        assert!(!registry.cancel("run-poisoned"));
    }

    #[test]
    fn output_capture_discards_excess_bytes_but_tracks_activity() {
        let mut capture = Capture {
            stdout: Vec::new(),
            stderr: Vec::new(),
            last_output: Instant::now() - Duration::from_secs(10),
        };
        let chunk = vec![b'a'; 8192];
        for _ in 0..200 {
            capture.append(&chunk, true);
            capture.append(&chunk, false);
        }
        assert!(capture.stdout.len() <= 800004);
        assert!(capture.stderr.len() <= 800004);
        assert!(capture.last_output.elapsed() < Duration::from_secs(1));
        assert!(
            truncate_chars(String::from_utf8_lossy(&capture.stdout).into_owned())
                .ends_with("… [truncated]")
        );
    }
    use crate::workflow::{
        ConditionClause, ConditionConfig, ConditionLogic, ConditionOp, NodeConfig, Position,
        RetryPolicy, WorkflowDefaults, WorkflowInput, CURRENT_SCHEMA_VERSION,
    };
    use std::sync::Arc;

    fn command_node(id: &str, exe: &str, args: &[&str], y: f64) -> Node {
        Node {
            id: id.to_string(),
            kind: NodeKind::Command,
            position: Position { x: 80.0, y },
            config: NodeConfig {
                executable: Some(exe.to_string()),
                args: args.iter().map(|s| s.to_string()).collect(),
                ..NodeConfig::default()
            },
            label: Some(id.to_string()),
        }
    }

    fn simple_node(id: &str, kind: NodeKind, y: f64) -> Node {
        Node {
            id: id.to_string(),
            kind,
            position: Position { x: 80.0, y },
            config: NodeConfig::default(),
            label: Some(id.to_string()),
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

    fn task_with_defaults(node: Node, defaults: Option<WorkflowDefaults>) -> TaskInput {
        TaskInput {
            node,
            workflow_id: "wf".to_string(),
            workflow_name: "W".to_string(),
            workflow_defaults: defaults,
            run_id: "run".to_string(),
            inputs: HashMap::new(),
        }
    }

    #[test]
    fn workflow_defaults_fill_repo_and_branch() {
        use crate::workflow::{GitHubOp, GitOp, WorkflowDefaults};
        let defaults = Some(WorkflowDefaults {
            repo_dir: Some("/repo".to_string()),
            branch: Some("feature/x".to_string()),
        });
        let task = task_with_defaults(simple_node("g", NodeKind::Git, 0.0), defaults.clone());
        // Node dir empty + default set: falls back instead of erroring on emptiness.
        // (Existence/repo checks still apply; /repo need not exist for this unit.)
        let err = resolve_repo_root(&task).expect_err("missing dir must fail");
        assert!(err.contains("does not exist") || err.contains("Not a git repository"));

        // Explicit node dir wins over the default.
        let mut explicit = simple_node("g2", NodeKind::Git, 0.0);
        explicit.config.working_dir = Some("/does-not-exist".to_string());
        let task2 = task_with_defaults(explicit, defaults.clone());
        let err2 = resolve_repo_root(&task2).expect_err("bad dir must fail");
        assert!(err2.contains("/does-not-exist"));

        // Branch defaults fill empty names, never explicit ones.
        let filled = apply_git_branch_default(
            GitOp::Checkout {
                name: "".to_string(),
                allow_dirty: false,
            },
            &task,
        );
        assert_eq!(
            filled,
            GitOp::Checkout {
                name: "feature/x".to_string(),
                allow_dirty: false,
            }
        );
        let kept = apply_git_branch_default(
            GitOp::Checkout {
                name: "mine".to_string(),
                allow_dirty: false,
            },
            &task,
        );
        assert_eq!(
            kept,
            GitOp::Checkout {
                name: "mine".to_string(),
                allow_dirty: false,
            }
        );
        let pr = apply_github_branch_default(
            GitHubOp::CreatePr {
                title: "T".to_string(),
                body: "".to_string(),
                base: "main".to_string(),
                head: "".to_string(),
                draft: true,
            },
            &task,
        );
        match pr {
            GitHubOp::CreatePr { head, .. } => assert_eq!(head, "feature/x"),
            _ => panic!("expected CreatePr"),
        }
        // No defaults: ops pass through untouched.
        let bare = task_with_defaults(simple_node("g3", NodeKind::Git, 0.0), None);
        let untouched = apply_git_branch_default(GitOp::Status, &bare);
        assert_eq!(untouched, GitOp::Status);
    }

    /// The milestone vertical slice: Start → echo → Approval → echo → End.
    fn vertical_slice() -> Workflow {
        let ids = ["start", "cmd1", "gate", "cmd2", "end"];
        let nodes = vec![
            simple_node(ids[0], NodeKind::Start, 0.0),
            command_node(ids[1], "echo", &["hello"], 100.0),
            simple_node(ids[2], NodeKind::Approval, 200.0),
            command_node(ids[3], "echo", &["world"], 300.0),
            simple_node(ids[4], NodeKind::End, 400.0),
        ];
        let edges = ids
            .windows(2)
            .enumerate()
            .map(|(i, pair)| edge(&format!("e{i}"), pair[0], pair[1], None))
            .collect();
        Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: "wf-vertical".to_string(),
            name: "Vertical slice".to_string(),
            inputs: Vec::new(),
            defaults: None,
            nodes,
            edges,
        }
    }

    fn harness() -> (Arc<SqliteDb>, Engine) {
        let db = Arc::new(SqliteDb::open_in_memory().expect("in-memory db"));
        let engine = Engine::new(Arc::clone(&db), CancellationRegistry::default());
        (db, engine)
    }

    fn empty_inputs() -> HashMap<String, String> {
        HashMap::new()
    }

    async fn run_to_end(db: &Arc<SqliteDb>, engine: &Engine, wf: Workflow, run_id: &str) {
        db.upsert_workflow(&wf).expect("upsert");
        engine
            .start_run(&wf, run_id, &empty_inputs())
            .expect("start");
        engine.execute(wf, run_id.to_string()).await;
    }

    #[tokio::test]
    async fn command_output_is_visible_before_the_node_finishes() {
        let (db, engine) = harness();
        let wf = Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: "wf-live".into(),
            name: "Live output".into(),
            inputs: Vec::new(),
            defaults: None,
            nodes: vec![
                simple_node("start", NodeKind::Start, 0.0),
                command_node(
                    "cmd",
                    "sh",
                    &["-c", "printf early; sleep 2; printf late"],
                    100.0,
                ),
                simple_node("end", NodeKind::End, 200.0),
            ],
            edges: vec![
                edge("e1", "start", "cmd", None),
                edge("e2", "cmd", "end", None),
            ],
        };
        db.upsert_workflow(&wf).expect("upsert");
        engine
            .start_run(&wf, "run-live", &empty_inputs())
            .expect("start");
        let runner = tokio::spawn(async move {
            engine.execute(wf, "run-live".into()).await;
        });
        let live = tokio::time::timeout(Duration::from_millis(1200), async {
            loop {
                if let Some(row) = db
                    .list_node_results("run-live")
                    .expect("results")
                    .into_iter()
                    .find(|row| row.node_id == "cmd" && row.stdout.contains("early"))
                {
                    break row;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("early output should be visible before completion");
        assert_eq!(live.status, "running");
        assert!(live.finished_at.is_none());
        runner.await.expect("runner");
        let final_row = db
            .list_node_results("run-live")
            .expect("results")
            .into_iter()
            .find(|row| row.node_id == "cmd")
            .expect("command row");
        assert_eq!(final_row.id, live.id);
        assert_eq!(final_row.status, "succeeded");
        assert_eq!(final_row.stdout, "earlylate");
        assert!(final_row.finished_at.is_some());
    }

    #[tokio::test]
    async fn vertical_slice_pauses_at_approval_then_succeeds() {
        let (db, engine) = harness();
        let wf = vertical_slice();
        db.upsert_workflow(&wf).expect("upsert");

        engine
            .start_run(&wf, "run-1", &empty_inputs())
            .expect("start");
        engine.execute(wf.clone(), "run-1".to_string()).await;

        let runs = db.list_runs(10).expect("runs");
        assert_eq!(runs[0].status, RunStatus::Paused);

        engine
            .approve_run("run-1", true, Some("looks good"), wf.clone())
            .await
            .expect("approve");
        let runs = db.list_runs(10).expect("runs");
        assert_eq!(runs[0].status, RunStatus::Succeeded);

        let results = db.list_node_results("run-1").expect("results");
        let statuses: Vec<(&str, &str)> = results
            .iter()
            .map(|r| (r.node_id.as_str(), r.status.as_str()))
            .collect();
        assert!(statuses.contains(&("cmd1", "succeeded")));
        assert!(statuses.contains(&("gate", "approved")));
        assert!(statuses.contains(&("cmd2", "succeeded")));
        let approved = results
            .iter()
            .find(|r| r.node_id == "gate" && r.status == "approved")
            .expect("approved");
        assert_eq!(approved.stdout, "looks good");
        let cmd1 = results.iter().find(|r| r.node_id == "cmd1").expect("cmd1");
        assert!(cmd1.stdout.contains("hello"));
    }

    #[tokio::test]
    async fn rejection_fails_the_run() {
        let (db, engine) = harness();
        let wf = vertical_slice();
        db.upsert_workflow(&wf).expect("upsert");
        engine
            .start_run(&wf, "run-2", &empty_inputs())
            .expect("start");
        engine.execute(wf.clone(), "run-2".to_string()).await;
        engine
            .approve_run("run-2", false, None, wf)
            .await
            .expect("reject");
        let runs = db.list_runs(10).expect("runs");
        assert_eq!(runs[0].status, RunStatus::Failed);
    }

    #[tokio::test]
    async fn approval_refuses_a_run_with_an_existing_terminal_decision() {
        let (db, engine) = harness();
        let wf = vertical_slice();
        run_to_end(&db, &engine, wf.clone(), "run-rejected").await;
        engine
            .approve_run("run-rejected", false, None, wf.clone())
            .await
            .expect("reject");
        assert!(matches!(
            engine.approve_run("run-rejected", true, None, wf).await,
            Err(EngineError::NotPaused(_))
        ));
        assert_eq!(
            db.get_run("run-rejected")
                .expect("run")
                .expect("stored")
                .status,
            RunStatus::Failed
        );
        assert!(!engine.cancel_run("run-rejected").expect("terminal cancel"));
    }

    #[tokio::test]
    async fn cancelling_a_paused_run_prevents_later_approval() {
        let (db, engine) = harness();
        let wf = vertical_slice();
        run_to_end(&db, &engine, wf.clone(), "run-cancel-paused").await;
        assert!(engine.cancel_run("run-cancel-paused").expect("cancel"));
        assert_eq!(
            db.get_run("run-cancel-paused")
                .expect("run")
                .expect("stored")
                .status,
            RunStatus::Cancelled
        );
        assert!(matches!(
            engine
                .approve_run("run-cancel-paused", true, None, wf)
                .await,
            Err(EngineError::NotPaused(_))
        ));
    }

    #[tokio::test]
    async fn concurrent_approval_requests_execute_downstream_once() {
        let (db, engine) = harness();
        let mut wf = vertical_slice();
        let cmd = wf
            .nodes
            .iter_mut()
            .find(|node| node.id == "cmd2")
            .expect("cmd2");
        cmd.config.executable = Some("sh".into());
        cmd.config.args = vec!["-c".into(), "sleep 0.1; echo once".into()];
        run_to_end(&db, &engine, wf.clone(), "run-double-approval").await;
        let (first, second) = tokio::join!(
            engine.approve_run("run-double-approval", true, None, wf.clone()),
            engine.approve_run("run-double-approval", true, None, wf.clone()),
        );
        assert!(first.is_ok());
        assert!(matches!(second, Err(EngineError::NotPaused(_))));
        let rows = db
            .list_node_results("run-double-approval")
            .expect("results");
        assert_eq!(rows.iter().filter(|row| row.node_id == "cmd2").count(), 1);
        assert_eq!(
            rows.iter().filter(|row| row.status == "approved").count(),
            1
        );
    }

    #[tokio::test]
    async fn duplicate_approval_cannot_decide_a_later_consecutive_gate() {
        let (db, engine) = harness();
        let wf = Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: "wf-two-gates".into(),
            name: "Two gates".into(),
            inputs: Vec::new(),
            defaults: None,
            nodes: vec![
                simple_node("start", NodeKind::Start, 0.0),
                simple_node("gate1", NodeKind::Approval, 100.0),
                simple_node("gate2", NodeKind::Approval, 200.0),
                simple_node("end", NodeKind::End, 300.0),
            ],
            edges: vec![
                edge("e1", "start", "gate1", None),
                edge("e2", "gate1", "gate2", None),
                edge("e3", "gate2", "end", None),
            ],
        };
        run_to_end(&db, &engine, wf.clone(), "run-two-gates").await;
        let paused = db
            .list_node_results("run-two-gates")
            .expect("results")
            .into_iter()
            .find(|row| row.status == "paused")
            .expect("paused");
        let (first, second) = tokio::join!(
            engine.approve_run_with_approval(
                "run-two-gates",
                true,
                None,
                Some(paused.id),
                wf.clone()
            ),
            engine.approve_run_with_approval(
                "run-two-gates",
                true,
                None,
                Some(paused.id),
                wf.clone()
            ),
        );
        assert!(first.is_ok());
        assert!(matches!(second, Err(EngineError::NotPaused(_))));
        assert_eq!(
            db.get_run("run-two-gates")
                .expect("run")
                .expect("stored")
                .status,
            RunStatus::Paused
        );
        let rows = db.list_node_results("run-two-gates").expect("results");
        assert_eq!(
            rows.iter().filter(|row| row.status == "approved").count(),
            1
        );
        let next = rows
            .iter()
            .rev()
            .find(|row| row.status == "paused")
            .expect("second gate");
        engine
            .approve_run_with_approval("run-two-gates", false, None, Some(next.id), wf.clone())
            .await
            .expect("reject second gate");
        assert!(matches!(
            engine
                .approve_run_with_approval("run-two-gates", true, None, Some(next.id), wf)
                .await,
            Err(EngineError::NotPaused(_))
        ));
    }

    #[tokio::test]
    async fn approval_resumes_the_original_workflow_after_saved_edits() {
        let (db, engine) = harness();
        let mut wf = vertical_slice();
        let cmd = wf
            .nodes
            .iter_mut()
            .find(|node| node.id == "cmd2")
            .expect("cmd2");
        cmd.config.executable = Some("echo".into());
        cmd.config.args = vec!["original".into()];
        run_to_end(&db, &engine, wf.clone(), "run-snapshot").await;
        wf.nodes
            .iter_mut()
            .find(|node| node.id == "cmd2")
            .expect("cmd2")
            .config
            .args = vec!["edited".into()];
        db.upsert_workflow(&wf).expect("save edit");
        engine
            .approve_run("run-snapshot", true, None, wf)
            .await
            .expect("approve");
        let rows = db.list_node_results("run-snapshot").expect("results");
        assert_eq!(
            rows.iter()
                .find(|row| row.node_id == "cmd2")
                .expect("cmd2")
                .stdout
                .trim(),
            "original"
        );
    }

    #[tokio::test]
    async fn failing_command_stops_the_run() {
        let (db, engine) = harness();
        let mut wf = vertical_slice();
        // Make the first command fail.
        let cmd1 = wf.nodes.iter_mut().find(|n| n.id == "cmd1").expect("cmd1");
        cmd1.config.executable = Some("false".to_string());
        cmd1.config.args.clear();
        run_to_end(&db, &engine, wf, "run-3").await;
        let runs = db.list_runs(10).expect("runs");
        assert_eq!(runs[0].status, RunStatus::Failed);
        let results = db.list_node_results("run-3").expect("results");
        assert!(results.iter().any(|r| r.status == "failed"));
        // Nodes after the failure never executed (they are skipped, not run).
        assert!(results
            .iter()
            .all(|r| r.node_id != "cmd2" || r.status == "skipped"));
        assert_eq!(status_of(&db, "run-3", "cmd2"), "skipped");
    }

    #[test]
    fn invalid_workflow_cannot_start() {
        let (_db, engine) = harness();
        let mut wf = vertical_slice();
        wf.nodes.retain(|n| n.kind != NodeKind::Start);
        let err = engine
            .start_run(&wf, "run-4", &empty_inputs())
            .expect_err("must fail");
        assert!(matches!(err, EngineError::Validation(_)));
    }

    #[tokio::test]
    async fn cancellation_before_start_marks_run_cancelled() {
        let (db, _) = harness();
        let wf = vertical_slice();
        db.upsert_workflow(&wf).expect("upsert");
        let cancel = CancellationRegistry::default();
        cancel.flag_for("run-5").store(true, Ordering::SeqCst);
        let engine = Engine::new(Arc::clone(&db), cancel);
        engine
            .start_run(&wf, "run-5", &empty_inputs())
            .expect("start");
        engine.execute(wf, "run-5".to_string()).await;
        let runs = db.list_runs(10).expect("runs");
        assert_eq!(runs[0].status, RunStatus::Cancelled);
    }

    fn echo_profile(id: &str) -> crate::agents::AgentProfile {
        crate::agents::AgentProfile {
            id: id.to_string(),
            name: format!("Echo {id}"),
            adapter: crate::agents::AdapterKind::Claude,
            // `echo` stands in for the AI CLI: the adapter still builds
            // `-p <prompt>` argv, and echo prints it back deterministically.
            executable: Some("echo".to_string()),
            model: None,
            effort: None,
            extra_args: vec![],
            skills: vec![],
            working_dir_mode: crate::agents::WorkingDirMode::Inherit,
            working_dir: None,
            default_timeout_secs: 60,
            role: None,
        }
    }

    fn agent_workflow(profile_id: &str) -> Workflow {
        let nodes = vec![
            simple_node("start", NodeKind::Start, 0.0),
            Node {
                id: "agent1".to_string(),
                kind: NodeKind::Agent,
                position: Position { x: 80.0, y: 100.0 },
                config: NodeConfig {
                    agent_profile_id: Some(profile_id.to_string()),
                    prompt: Some("Say hello for {{workflow.name}}".to_string()),
                    timeout_secs: Some(60),
                    ..NodeConfig::default()
                },
                label: Some("Agent".to_string()),
            },
            simple_node("end", NodeKind::End, 200.0),
        ];
        let edges = vec![
            edge("e0", "start", "agent1", None),
            edge("e1", "agent1", "end", None),
        ];
        Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: "wf-agent".to_string(),
            name: "Agent slice".to_string(),
            inputs: Vec::new(),
            defaults: None,
            nodes,
            edges,
        }
    }

    #[tokio::test]
    async fn agent_node_renders_prompt_and_succeeds_with_fake_cli() {
        let (db, engine) = harness();
        db.upsert_agent_profile(&echo_profile("p-echo"))
            .expect("profile");
        let wf = agent_workflow("p-echo");
        run_to_end(&db, &engine, wf, "run-agent-1").await;
        let runs = db.list_runs(10).expect("runs");
        assert_eq!(runs[0].status, RunStatus::Succeeded);
        let results = db.list_node_results("run-agent-1").expect("results");
        let agent = results
            .iter()
            .find(|r| r.node_id == "agent1")
            .expect("agent");
        assert_eq!(agent.status, "succeeded");
        assert!(agent.stdout.contains("Say hello for Agent slice"));
    }

    #[test]
    fn missing_profile_blocks_start() {
        let (_db, engine) = harness();
        let wf = agent_workflow("no-such-profile");
        let err = engine
            .start_run(&wf, "run-agent-2", &empty_inputs())
            .expect_err("must fail");
        assert!(matches!(err, EngineError::Validation(_)));
        assert!(err.to_string().contains("unknown Agent Profile"));
    }

    #[tokio::test]
    async fn missing_prompt_variable_fails_node_cleanly() {
        let (db, engine) = harness();
        db.upsert_agent_profile(&echo_profile("p-echo-2"))
            .expect("profile");
        let mut wf = agent_workflow("p-echo-2");
        wf.nodes
            .iter_mut()
            .find(|n| n.id == "agent1")
            .expect("agent1")
            .config
            .prompt = Some("Hello {{node.ghost.output}}".to_string());
        // Bypass pure validation to exercise the runtime path.
        db.upsert_workflow(&wf).expect("upsert");
        db.create_run("run-agent-3", &wf.id, &empty_inputs())
            .expect("run");
        engine.execute(wf, "run-agent-3".to_string()).await;
        let results = db.list_node_results("run-agent-3").expect("results");
        assert!(results.iter().any(|r| r.status == "failed"));
        let runs = db.list_runs(10).expect("runs");
        assert_eq!(runs[0].status, RunStatus::Failed);
    }

    #[test]
    fn unavailable_cli_blocks_start() {
        let (db, engine) = harness();
        let mut profile = echo_profile("p-missing-cli");
        profile.executable = Some("orchevia-definitely-missing-binary-xyz".to_string());
        db.upsert_agent_profile(&profile).expect("profile");
        let wf = agent_workflow("p-missing-cli");
        let err = engine
            .start_run(&wf, "run-agent-4", &empty_inputs())
            .expect_err("must fail");
        assert!(err.to_string().contains("not found on PATH"));
    }

    // -- Milestone 3: branches, joins, retries, loops -------------------------

    fn branch_workflow() -> Workflow {
        Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: "wf-branch".to_string(),
            name: "Branch".to_string(),
            inputs: vec![WorkflowInput {
                name: "mode".into(),
                label: None,
                default: Some("fast".into()),
                required: false,
            }],
            defaults: None,
            nodes: vec![
                simple_node("start", NodeKind::Start, 0.0),
                Node {
                    id: "cond".into(),
                    kind: NodeKind::Condition,
                    position: Position { x: 80.0, y: 100.0 },
                    config: NodeConfig {
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
                    label: Some("Fast?".into()),
                },
                command_node("a", "echo", &["A"], 200.0),
                command_node("b", "echo", &["B"], 300.0),
                command_node("join", "echo", &["joined"], 400.0),
                simple_node("end", NodeKind::End, 500.0),
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

    fn status_of(db: &Arc<SqliteDb>, run_id: &str, node_id: &str) -> String {
        db.list_node_results(run_id)
            .expect("results")
            .iter()
            .rev()
            .find(|r| r.node_id == node_id)
            .map(|r| r.status.clone())
            .unwrap_or_else(|| "missing".to_string())
    }

    #[tokio::test]
    async fn condition_true_branch_skips_false_side() {
        let (db, engine) = harness();
        let wf = branch_workflow();
        let mut inputs = HashMap::new();
        inputs.insert("mode".to_string(), "fast".to_string());
        db.upsert_workflow(&wf).expect("upsert");
        engine.start_run(&wf, "run-cond-t", &inputs).expect("start");
        engine.execute(wf, "run-cond-t".to_string()).await;
        let runs = db.list_runs(10).expect("runs");
        assert_eq!(runs[0].status, RunStatus::Succeeded);
        assert_eq!(status_of(&db, "run-cond-t", "a"), "succeeded");
        assert_eq!(status_of(&db, "run-cond-t", "b"), "skipped");
        assert_eq!(status_of(&db, "run-cond-t", "join"), "succeeded");
    }

    #[tokio::test]
    async fn condition_false_branch_skips_true_side() {
        let (db, engine) = harness();
        let wf = branch_workflow();
        let mut inputs = HashMap::new();
        inputs.insert("mode".to_string(), "slow".to_string());
        db.upsert_workflow(&wf).expect("upsert");
        engine.start_run(&wf, "run-cond-f", &inputs).expect("start");
        engine.execute(wf, "run-cond-f".to_string()).await;
        assert_eq!(status_of(&db, "run-cond-f", "a"), "skipped");
        assert_eq!(status_of(&db, "run-cond-f", "b"), "succeeded");
        let runs = db.list_runs(10).expect("runs");
        assert_eq!(runs[0].status, RunStatus::Succeeded);
    }

    #[tokio::test]
    async fn parallel_fanout_joins_before_downstream() {
        let (db, engine) = harness();
        let wf = Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: "wf-fan".to_string(),
            name: "Fan".to_string(),
            inputs: Vec::new(),
            defaults: None,
            nodes: vec![
                simple_node("start", NodeKind::Start, 0.0),
                command_node("left", "echo", &["L"], 100.0),
                command_node("right", "echo", &["R"], 200.0),
                command_node("join", "echo", &["J"], 300.0),
                simple_node("end", NodeKind::End, 400.0),
            ],
            edges: vec![
                edge("e0", "start", "left", None),
                edge("e1", "start", "right", None),
                edge("e2", "left", "join", None),
                edge("e3", "right", "join", None),
                edge("e4", "join", "end", None),
            ],
        };
        run_to_end(&db, &engine, wf, "run-fan").await;
        for node in ["start", "left", "right", "join", "end"] {
            assert_eq!(status_of(&db, "run-fan", node), "succeeded", "node {node}");
        }
    }

    #[tokio::test]
    async fn failure_edge_routes_to_recovery() {
        let (db, engine) = harness();
        let wf = Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: "wf-failroute".to_string(),
            name: "FailRoute".to_string(),
            inputs: Vec::new(),
            defaults: None,
            nodes: vec![
                simple_node("start", NodeKind::Start, 0.0),
                command_node("risky", "false", &[], 100.0),
                command_node("recover", "echo", &["recovered"], 200.0),
                simple_node("end", NodeKind::End, 300.0),
            ],
            edges: vec![
                edge("e0", "start", "risky", None),
                edge("e1", "risky", "recover", Some("failure")),
                edge("e2", "recover", "end", None),
            ],
        };
        run_to_end(&db, &engine, wf, "run-failroute").await;
        let runs = db.list_runs(10).expect("runs");
        assert_eq!(runs[0].status, RunStatus::Succeeded);
        assert_eq!(status_of(&db, "run-failroute", "risky"), "failed");
        assert_eq!(status_of(&db, "run-failroute", "recover"), "succeeded");
        let recover = db
            .list_node_results("run-failroute")
            .expect("results")
            .into_iter()
            .find(|r| r.node_id == "recover")
            .expect("recover row");
        assert!(recover.stdout.contains("recovered"));
    }

    #[tokio::test]
    async fn retry_exhaustion_records_each_attempt() {
        let (db, engine) = harness();
        let mut flaky = command_node("flaky", "false", &[], 100.0);
        flaky.config.retry = Some(RetryPolicy {
            max_attempts: 3,
            delay_ms: 0,
            backoff: false,
        });
        let wf = Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: "wf-retry".to_string(),
            name: "Retry".to_string(),
            inputs: Vec::new(),
            defaults: None,
            nodes: vec![
                simple_node("start", NodeKind::Start, 0.0),
                flaky,
                simple_node("end", NodeKind::End, 200.0),
            ],
            edges: vec![
                edge("e0", "start", "flaky", None),
                edge("e1", "flaky", "end", None),
            ],
        };
        run_to_end(&db, &engine, wf, "run-retry").await;
        let runs = db.list_runs(10).expect("runs");
        assert_eq!(runs[0].status, RunStatus::Failed);
        let rows = db.list_node_results("run-retry").expect("results");
        let attempts: Vec<&StoredNodeResult> =
            rows.iter().filter(|r| r.node_id == "flaky").collect();
        assert_eq!(attempts.len(), 3);
        assert_eq!(attempts[0].status, "retrying");
        assert_eq!(attempts[1].status, "retrying");
        assert_eq!(attempts[2].status, "failed");
        assert_eq!(attempts[2].attempt, 3);
    }

    #[tokio::test]
    async fn retry_succeeds_on_second_attempt() {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = dir.path().join("flaky.sh");
        let marker = dir.path().join("marker");
        std::fs::write(
            &script,
            "#!/bin/sh\nif [ -f \"$1.done\" ]; then exit 0; else touch \"$1.done\"; exit 1; fi\n",
        )
        .expect("write script");
        let script_arg: String = script.to_string_lossy().into_owned();
        let marker_arg: String = marker.to_string_lossy().into_owned();
        let mut flaky = command_node(
            "flaky",
            "sh",
            &[script_arg.as_str(), marker_arg.as_str()],
            100.0,
        );
        flaky.config.retry = Some(RetryPolicy {
            max_attempts: 2,
            delay_ms: 0,
            backoff: false,
        });
        let (db, engine) = harness();
        let wf = Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: "wf-flaky".to_string(),
            name: "Flaky".to_string(),
            inputs: Vec::new(),
            defaults: None,
            nodes: vec![
                simple_node("start", NodeKind::Start, 0.0),
                flaky,
                simple_node("end", NodeKind::End, 200.0),
            ],
            edges: vec![
                edge("e0", "start", "flaky", None),
                edge("e1", "flaky", "end", None),
            ],
        };
        run_to_end(&db, &engine, wf, "run-flaky").await;
        let runs = db.list_runs(10).expect("runs");
        assert_eq!(runs[0].status, RunStatus::Succeeded);
        assert_eq!(status_of(&db, "run-flaky", "flaky"), "succeeded");
    }

    fn loop_workflow(always_again: bool) -> Workflow {
        // Start -> Fix -> Cond -true-> Fix (loop) / -false-> End.
        let mut fix = command_node("fix", "echo", &["fixing"], 100.0);
        fix.config.max_visits = Some(3);
        let mut cond = Node {
            id: "cond".into(),
            kind: NodeKind::Condition,
            position: Position { x: 80.0, y: 200.0 },
            config: NodeConfig {
                condition: Some(if always_again {
                    ConditionConfig {
                        logic: ConditionLogic::And,
                        clauses: vec![ConditionClause {
                            left: "input.again".into(),
                            op: ConditionOp::Equals,
                            right: "yes".into(),
                        }],
                    }
                } else {
                    ConditionConfig {
                        logic: ConditionLogic::And,
                        clauses: vec![ConditionClause {
                            left: "node.fix.visits".into(),
                            op: ConditionOp::Less,
                            right: "2".into(),
                        }],
                    }
                }),
                max_visits: Some(3),
                ..NodeConfig::default()
            },
            label: Some("Again?".into()),
        };
        let _ = &mut cond;
        Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: "wf-loop".to_string(),
            name: "Loop".to_string(),
            inputs: if always_again {
                vec![WorkflowInput {
                    name: "again".into(),
                    label: None,
                    default: Some("yes".into()),
                    required: false,
                }]
            } else {
                Vec::new()
            },
            defaults: None,
            nodes: vec![
                simple_node("start", NodeKind::Start, 0.0),
                fix,
                cond,
                simple_node("end", NodeKind::End, 300.0),
            ],
            edges: vec![
                edge("e0", "start", "fix", None),
                edge("e1", "fix", "cond", None),
                edge("e2", "cond", "fix", Some("true")),
                edge("e3", "cond", "end", Some("false")),
            ],
        }
    }

    #[tokio::test]
    async fn bounded_loop_runs_until_condition_flips() {
        let (db, engine) = harness();
        run_to_end(&db, &engine, loop_workflow(false), "run-loop").await;
        let runs = db.list_runs(10).expect("runs");
        assert_eq!(runs[0].status, RunStatus::Succeeded);
        let rows = db.list_node_results("run-loop").expect("results");
        let fixes: Vec<&StoredNodeResult> = rows
            .iter()
            .filter(|r| r.node_id == "fix" && r.status == "succeeded")
            .collect();
        assert_eq!(
            fixes.len(),
            2,
            "fix ran twice before visits>=2 flipped the branch"
        );
        assert_eq!(status_of(&db, "run-loop", "end"), "succeeded");
    }

    #[tokio::test]
    async fn loop_limit_exceeded_fails_the_run() {
        let (db, engine) = harness();
        run_to_end(&db, &engine, loop_workflow(true), "run-loop-limit").await;
        let runs = db.list_runs(10).expect("runs");
        assert_eq!(runs[0].status, RunStatus::Failed);
        let rows = db.list_node_results("run-loop-limit").expect("results");
        let run_row = rows.iter().find(|r| r.node_id == "run").expect("run row");
        assert!(run_row
            .error
            .as_deref()
            .unwrap_or("")
            .contains("Loop limit"));
    }

    #[tokio::test]
    async fn template_test_command_preserves_compound_shell_argument() {
        let template = crate::templates::builtin_templates().remove(0);
        let tests = template
            .workflow
            .nodes
            .iter()
            .find(|n| n.id == "tests")
            .unwrap()
            .clone();
        let mut wf = Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: "test-command".into(),
            name: "Tests".into(),
            defaults: None,
            inputs: template.workflow.inputs,
            nodes: vec![
                simple_node("start", NodeKind::Start, 0.0),
                tests,
                simple_node("end", NodeKind::End, 200.0),
            ],
            edges: vec![
                edge("e1", "start", "tests", None),
                edge("e2", "tests", "end", None),
            ],
        };
        wf.inputs.retain(|i| i.name == "testCommand");
        let (db, engine) = harness();
        db.upsert_workflow(&wf).unwrap();
        let empty = HashMap::from([("testCommand".into(), "  ".into())]);
        assert!(engine.start_run(&wf, "blank", &empty).is_err());
        let inputs = HashMap::from([(
            "testCommand".into(),
            "printf '%s' 'one two'; printf '%s' ' three'".into(),
        )]);
        engine.start_run(&wf, "compound", &inputs).unwrap();
        engine.execute(wf, "compound".into()).await;
        let results = db.list_node_results("compound").unwrap();
        let result = results.iter().find(|r| r.node_id == "tests").unwrap();
        assert_eq!(result.status, "succeeded", "{result:?}");
        assert_eq!(result.stdout, "one two three");
    }

    #[test]
    fn required_command_validates_effective_override_before_persisting() {
        let (db, engine) = harness();
        let mut wf = vertical_slice();
        wf.inputs.push(WorkflowInput {
            name: "testCommand".into(),
            label: None,
            default: Some("printf REAL_TEST".into()),
            required: true,
        });
        db.upsert_workflow(&wf).unwrap();
        for (i, value) in ["", "  "].iter().enumerate() {
            let id = format!("blank-override-{i}");
            assert!(engine
                .start_run(
                    &wf,
                    &id,
                    &HashMap::from([("testCommand".into(), value.to_string())])
                )
                .is_err());
            assert!(db.get_run(&id).unwrap().is_none());
        }
        engine
            .start_run(&wf, "default-command", &empty_inputs())
            .unwrap();
        assert_eq!(
            db.get_run("default-command")
                .unwrap()
                .unwrap()
                .inputs
                .get("testCommand")
                .map(String::as_str),
            Some("printf REAL_TEST")
        );
    }

    #[test]
    fn required_input_missing_blocks_start() {
        let (_db, engine) = harness();
        let mut wf = vertical_slice();
        wf.inputs.push(WorkflowInput {
            name: "ticket".into(),
            label: None,
            default: None,
            required: true,
        });
        let err = engine
            .start_run(&wf, "run-input", &empty_inputs())
            .expect_err("must fail");
        assert!(err.to_string().contains("required"));
        let mut provided = HashMap::new();
        provided.insert("ticket".to_string(), "DEV-1".to_string());
        // Other validation passes, so providing the input unblocks start.
        let db = SqliteDb::open_in_memory().expect("db");
        db.upsert_workflow(&wf).expect("upsert");
        let engine = Engine::new(Arc::new(db), CancellationRegistry::default());
        engine
            .start_run(&wf, "run-input-2", &provided)
            .expect("start");
    }

    #[tokio::test]
    async fn command_timeout_fails_node() {
        let (db, engine) = harness();
        let mut sleeper = command_node("sleeper", "sleep", &["30"], 100.0);
        sleeper.config.timeout_secs = Some(1);
        let wf = Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: "wf-timeout".to_string(),
            name: "Timeout".to_string(),
            inputs: Vec::new(),
            defaults: None,
            nodes: vec![
                simple_node("start", NodeKind::Start, 0.0),
                sleeper,
                simple_node("end", NodeKind::End, 200.0),
            ],
            edges: vec![
                edge("e0", "start", "sleeper", None),
                edge("e1", "sleeper", "end", None),
            ],
        };
        run_to_end(&db, &engine, wf, "run-timeout").await;
        let runs = db.list_runs(10).expect("runs");
        assert_eq!(runs[0].status, RunStatus::Failed);
        assert!(status_of(&db, "run-timeout", "sleeper") == "failed");
    }
    #[test]
    fn command_dir_falls_back_to_workflow_default() {
        let task = task_with_defaults(simple_node("c", NodeKind::Command, 0.0), None);
        assert_eq!(command_working_dir(&task), None);
        let defaults = Some(WorkflowDefaults {
            repo_dir: Some("/repo".to_string()),
            branch: None,
        });
        let task = task_with_defaults(simple_node("c", NodeKind::Command, 0.0), defaults);
        assert_eq!(command_working_dir(&task), Some("/repo"));
        let mut explicit = simple_node("c2", NodeKind::Command, 0.0);
        explicit.config.working_dir = Some("/elsewhere".to_string());
        let task = task_with_defaults(
            explicit,
            Some(WorkflowDefaults {
                repo_dir: Some("/repo".to_string()),
                branch: None,
            }),
        );
        assert_eq!(command_working_dir(&task), Some("/elsewhere"));
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use crate::mcp::McpServerConfig;
    use crate::workflow::{GitHubOp, GitOp, NodeConfig, Position, CURRENT_SCHEMA_VERSION};

    fn git_present() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Fresh repo with one commit; None when git is missing (skip).
    fn fresh_repo() -> Option<(tempfile::TempDir, String)> {
        if !git_present() {
            return None;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_string_lossy().into_owned();
        let run = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&root)
                .output()
                .expect("git")
        };
        assert!(run(&["init", "-b", "main"]).status.success());
        assert!(run(&["config", "user.email", "t@orchevia.dev"])
            .status
            .success());
        assert!(run(&["config", "user.name", "T"]).status.success());
        std::fs::write(dir.path().join("a.txt"), "hi\n").expect("write");
        assert!(run(&["add", "a.txt"]).status.success());
        assert!(run(&["commit", "-m", "init"]).status.success());
        Some((dir, root))
    }

    fn git_node(id: &str, op: crate::workflow::GitOp, root: &str) -> Node {
        Node {
            id: id.to_string(),
            kind: NodeKind::Git,
            position: Position::default(),
            config: NodeConfig {
                git_op: Some(op),
                working_dir: Some(root.to_string()),
                ..NodeConfig::default()
            },
            label: Some(id.to_string()),
        }
    }

    fn linear_git_workflow(nodes: Vec<Node>, edges: Vec<Edge>, id: &str) -> Workflow {
        Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: id.to_string(),
            name: id.to_string(),
            inputs: Vec::new(),
            defaults: None,
            nodes,
            edges,
        }
    }

    fn harness() -> (Arc<SqliteDb>, Engine) {
        let db = Arc::new(SqliteDb::open_in_memory().expect("in-memory db"));
        let engine = Engine::new(Arc::clone(&db), CancellationRegistry::default());
        (db, engine)
    }

    #[tokio::test]
    async fn git_status_node_reports_branch() {
        let Some((_dir, root)) = fresh_repo() else {
            eprintln!("SKIP: git not installed");
            return;
        };
        let (db, engine) = harness();
        let wf = linear_git_workflow(
            vec![
                Node {
                    id: "start".into(),
                    kind: NodeKind::Start,
                    position: Position::default(),
                    config: NodeConfig::default(),
                    label: None,
                },
                git_node("gstat", GitOp::Status, &root),
                Node {
                    id: "end".into(),
                    kind: NodeKind::End,
                    position: Position::default(),
                    config: NodeConfig::default(),
                    label: None,
                },
            ],
            vec![
                Edge {
                    id: "e0".into(),
                    source: "start".into(),
                    target: "gstat".into(),
                    label: None,
                },
                Edge {
                    id: "e1".into(),
                    source: "gstat".into(),
                    target: "end".into(),
                    label: None,
                },
            ],
            "wf-git-status",
        );
        db.upsert_workflow(&wf).expect("upsert");
        engine
            .start_run(&wf, "run-git-1", &HashMap::new())
            .expect("start");
        engine.execute(wf, "run-git-1".to_string()).await;
        let runs = db.list_runs(10).expect("runs");
        assert_eq!(runs[0].status, RunStatus::Succeeded);
        let row = db
            .list_node_results("run-git-1")
            .expect("results")
            .into_iter()
            .find(|r| r.node_id == "gstat")
            .expect("git row");
        assert_eq!(row.status, "succeeded");
        assert!(row.stdout.contains("main"));
        assert!(row.structured_json.contains("clean"));
    }

    #[tokio::test]
    async fn cancelling_a_command_keeps_its_partial_output() {
        let flag = Arc::new(AtomicBool::new(false));
        let cancel_flag = Arc::clone(&flag);
        let canceller = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            cancel_flag.store(true, Ordering::SeqCst);
        });
        let outcome = run_command_cancellable(
            "sh",
            &["-c".to_string(), "echo before-cancel; sleep 30".to_string()],
            None,
            Duration::from_secs(40),
            false,
            &flag,
            None,
        )
        .await;
        canceller.await.expect("canceller");
        match outcome {
            CommandOutcome::Cancelled { stdout, .. } => {
                assert!(stdout.contains("before-cancel"), "{stdout}");
            }
            CommandOutcome::Completed { .. } => panic!("command should be cancelled"),
        }
    }

    #[tokio::test]
    async fn timeout_kills_but_keeps_partial_output() {
        let flag = Arc::new(AtomicBool::new(false));
        let outcome = run_command_cancellable(
            "sh",
            &["-c".to_string(), "echo hello-partial; sleep 30".to_string()],
            None,
            Duration::from_millis(400),
            false,
            &flag,
            None,
        )
        .await;
        match outcome {
            CommandOutcome::Completed {
                code,
                stdout,
                stderr,
            } => {
                assert_eq!(code, None);
                assert!(stdout.contains("hello-partial"), "{stdout}");
                assert!(stderr.contains("timed out"), "{stderr}");
            }
            CommandOutcome::Cancelled { .. } => panic!("must time out, not cancel"),
        }
    }

    #[tokio::test]
    async fn extend_on_output_survives_slow_drips() {
        // Five ticks 0.5 s apart: a fixed 1 s budget fails, activity mode passes.
        let script = "for i in 1 2 3 4 5; do echo tick; sleep 0.5; done";
        let flag = Arc::new(AtomicBool::new(false));
        let fixed = run_command_cancellable(
            "sh",
            &["-c".to_string(), script.to_string()],
            None,
            Duration::from_secs(1),
            false,
            &flag,
            None,
        )
        .await;
        assert!(
            matches!(fixed, CommandOutcome::Completed { code: None, .. }),
            "fixed budget must time out"
        );
        let extended = run_command_cancellable(
            "sh",
            &["-c".to_string(), script.to_string()],
            None,
            Duration::from_secs(1),
            true,
            &flag,
            None,
        )
        .await;
        match extended {
            CommandOutcome::Completed { code, stdout, .. } => {
                assert_eq!(code, Some(0));
                assert_eq!(stdout.matches("tick").count(), 5, "{stdout}");
            }
            CommandOutcome::Cancelled { .. } => panic!("must succeed, not cancel"),
        }
    }

    #[tokio::test]
    async fn git_branch_and_commit_flow() {
        let Some((_dir, root)) = fresh_repo() else {
            eprintln!("SKIP: git not installed");
            return;
        };
        let (db, engine) = harness();
        std::fs::write(format!("{root}/a.txt"), "v2\n").expect("write");
        let wf = linear_git_workflow(
            vec![
                Node {
                    id: "start".into(),
                    kind: NodeKind::Start,
                    position: Position::default(),
                    config: NodeConfig::default(),
                    label: None,
                },
                git_node(
                    "mk",
                    GitOp::BranchCreate {
                        name: "feature-t".into(),
                    },
                    &root,
                ),
                git_node(
                    "st",
                    GitOp::Stage {
                        paths: vec!["a.txt".into()],
                    },
                    &root,
                ),
                git_node(
                    "ci",
                    GitOp::Commit {
                        message: "second".into(),
                    },
                    &root,
                ),
                Node {
                    id: "end".into(),
                    kind: NodeKind::End,
                    position: Position::default(),
                    config: NodeConfig::default(),
                    label: None,
                },
            ],
            vec![
                Edge {
                    id: "e0".into(),
                    source: "start".into(),
                    target: "mk".into(),
                    label: None,
                },
                Edge {
                    id: "e1".into(),
                    source: "mk".into(),
                    target: "st".into(),
                    label: None,
                },
                Edge {
                    id: "e2".into(),
                    source: "st".into(),
                    target: "ci".into(),
                    label: None,
                },
                Edge {
                    id: "e3".into(),
                    source: "ci".into(),
                    target: "end".into(),
                    label: None,
                },
            ],
            "wf-git-flow",
        );
        db.upsert_workflow(&wf).expect("upsert");
        engine
            .start_run(&wf, "run-git-2", &HashMap::new())
            .expect("start");
        engine.execute(wf, "run-git-2".to_string()).await;
        assert_eq!(
            db.list_runs(10).expect("runs")[0].status,
            RunStatus::Succeeded
        );
        assert_eq!(
            crate::git::current_branch(&root).expect("branch"),
            "feature-t"
        );
    }

    #[tokio::test]
    async fn git_dirty_checkout_refused_without_opt_in() {
        let Some((_dir, root)) = fresh_repo() else {
            eprintln!("SKIP: git not installed");
            return;
        };
        let (db, engine) = harness();
        std::fs::write(format!("{root}/a.txt"), "dirty\n").expect("write");
        let wf = linear_git_workflow(
            vec![
                Node {
                    id: "start".into(),
                    kind: NodeKind::Start,
                    position: Position::default(),
                    config: NodeConfig::default(),
                    label: None,
                },
                git_node(
                    "co",
                    GitOp::Checkout {
                        name: "other".into(),
                        allow_dirty: false,
                    },
                    &root,
                ),
                Node {
                    id: "end".into(),
                    kind: NodeKind::End,
                    position: Position::default(),
                    config: NodeConfig::default(),
                    label: None,
                },
            ],
            vec![
                Edge {
                    id: "e0".into(),
                    source: "start".into(),
                    target: "co".into(),
                    label: None,
                },
                Edge {
                    id: "e1".into(),
                    source: "co".into(),
                    target: "end".into(),
                    label: None,
                },
            ],
            "wf-git-dirty",
        );
        db.upsert_workflow(&wf).expect("upsert");
        // Bypass start_run (needs branch `other` to exist — it doesn't; the
        // runtime failure path is what we assert, plus dirty-guard wording
        // when the branch exists). Create the branch first via CLI.
        std::process::Command::new("git")
            .args(["branch", "other"])
            .current_dir(&root)
            .output()
            .expect("branch");
        engine
            .start_run(&wf, "run-git-3", &HashMap::new())
            .expect("start");
        engine.execute(wf, "run-git-3".to_string()).await;
        assert_eq!(db.list_runs(10).expect("runs")[0].status, RunStatus::Failed);
        let row = db
            .list_node_results("run-git-3")
            .expect("results")
            .into_iter()
            .find(|r| r.node_id == "co")
            .expect("row");
        assert!(row.error.as_deref().unwrap_or("").contains("dirty"));
    }

    /// Fixture MCP server answering ticket calls.
    fn ticket_server() -> (tempfile::TempDir, McpServerConfig) {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = dir.path().join("ticket-mcp.sh");
        std::fs::write(
            &script,
            r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      n=$(printf '%s' "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{}}}\n' "$n"
      ;;
    *'"method":"tools/call"'*)
      n=$(printf '%s' "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"{\\"key\\":\\"DEV-1234\\",\\"summary\\":\\"Cart bug\\",\\"description\\":\\"Empty cart fails\\",\\"status\\":{\\"name\\":\\"To Do\\"}}"}],"isError":false}}\n' "$n"
      ;;
    *) ;;
  esac
done
"#,
        )
        .expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
                .expect("chmod");
        }
        (
            dir,
            McpServerConfig {
                id: "jira".into(),
                name: "Jira".into(),
                command: script.to_string_lossy().into_owned(),
                args: vec![],
                enabled: true,
            },
        )
    }

    fn ticket_workflow(server_id: &str, key: &str) -> Workflow {
        Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: "wf-ticket".to_string(),
            name: "Ticket flow".to_string(),
            inputs: Vec::new(),
            defaults: None,
            nodes: vec![
                Node {
                    id: "start".into(),
                    kind: NodeKind::Start,
                    position: Position::default(),
                    config: NodeConfig::default(),
                    label: None,
                },
                Node {
                    id: "t".into(),
                    kind: NodeKind::Ticket,
                    position: Position::default(),
                    config: NodeConfig {
                        ticket_key: Some(key.to_string()),
                        mcp_server_id: Some(server_id.to_string()),
                        timeout_secs: Some(20),
                        ..NodeConfig::default()
                    },
                    label: None,
                },
                Node {
                    id: "end".into(),
                    kind: NodeKind::End,
                    position: Position::default(),
                    config: NodeConfig::default(),
                    label: None,
                },
            ],
            edges: vec![
                Edge {
                    id: "e0".into(),
                    source: "start".into(),
                    target: "t".into(),
                    label: None,
                },
                Edge {
                    id: "e1".into(),
                    source: "t".into(),
                    target: "end".into(),
                    label: None,
                },
            ],
        }
    }

    #[tokio::test]
    async fn ticket_node_loads_and_exposes_aliases() {
        let (_dir, server) = ticket_server();
        let (db, engine) = harness();
        db.upsert_mcp_server(&server).expect("server");
        let wf = ticket_workflow("jira", "DEV-1234");
        db.upsert_workflow(&wf).expect("upsert");
        engine
            .start_run(&wf, "run-ticket-1", &HashMap::new())
            .expect("start");
        engine.execute(wf.clone(), "run-ticket-1".to_string()).await;
        assert_eq!(
            db.list_runs(10).expect("runs")[0].status,
            RunStatus::Succeeded
        );
        // ticket.* aliases resolve from the stored ticket payload.
        let vars =
            build_vars(&db, &wf.id, &wf.name, "run-ticket-1", &HashMap::new()).expect("vars");
        assert_eq!(vars.get("ticket.key").map(String::as_str), Some("DEV-1234"));
        assert_eq!(
            vars.get("ticket.title").map(String::as_str),
            Some("Cart bug")
        );
    }

    #[test]
    fn missing_mcp_server_blocks_start() {
        let (_db, engine) = harness();
        let wf = ticket_workflow("nope", "DEV-1");
        let err = engine
            .start_run(&wf, "run-ticket-2", &HashMap::new())
            .expect_err("must fail");
        assert!(err.to_string().contains("unknown MCP server"));
    }

    #[test]
    fn git_op_renders_input_templates() {
        use crate::workflow::GitOp;
        let mut vars = HashMap::new();
        vars.insert("input.commitMessage".to_string(), "Ship DEV-1".to_string());
        let rendered = render_git_op(
            &GitOp::Commit {
                message: "{{input.commitMessage}}".to_string(),
            },
            &vars,
        )
        .expect("render");
        match rendered {
            GitOp::Commit { message } => assert_eq!(message, "Ship DEV-1"),
            _ => panic!("wrong op"),
        }
        let err = render_git_op(
            &GitOp::Commit {
                message: "{{input.missing}}".to_string(),
            },
            &vars,
        )
        .expect_err("must fail on missing var");
        assert!(err.contains("Missing variables"));
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // test-only serialization lock; held
                                         // across awaits to serialize process-global env mutation, never
                                         // contended in a way that can deadlock (blocking acquire, single holder)
    async fn github_node_with_fake_gh_and_bypassed_availability() {
        // Fake `gh` answering pr list; exercises the runtime path end to end.
        // Serialized with other ORCHEVIA_GH_BIN mutators (process-global key).
        let _bin_guard = crate::github::GH_BIN_TEST_LOCK.lock().expect("lock");
        let dir = tempfile::tempdir().expect("tempdir");
        let script = dir.path().join("gh");
        std::fs::write(
            &script,
            r#"#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  echo '[{"number":3,"title":"T","state":"open","author":{"login":"a"},"headRefName":"b","baseRefName":"main","headRefOid":"x","url":"u","isDraft":false,"reviewRequests":[],"labels":[]}]'
  exit 0
fi
echo "unexpected: $*" >&2
exit 1
"#,
        )
        .expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
                .expect("chmod");
        }
        // Fixture binary via the documented test hook (no PATH mutation,
        // so parallel tests are unaffected). Restored at the end.
        std::env::set_var("ORCHEVIA_GH_BIN", script.to_string_lossy().into_owned());

        let Some((_repo, root)) = fresh_repo() else {
            std::env::remove_var("ORCHEVIA_GH_BIN");
            eprintln!("SKIP: git not installed");
            return;
        };
        let (db, engine) = harness();
        let wf = Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: "wf-gh".to_string(),
            name: "GH".to_string(),
            inputs: Vec::new(),
            defaults: None,
            nodes: vec![
                Node {
                    id: "start".into(),
                    kind: NodeKind::Start,
                    position: Position::default(),
                    config: NodeConfig::default(),
                    label: None,
                },
                Node {
                    id: "g".into(),
                    kind: NodeKind::GitHub,
                    position: Position::default(),
                    config: NodeConfig {
                        github_op: Some(GitHubOp::ListPrs {
                            state: Some("open".into()),
                        }),
                        working_dir: Some(root.clone()),
                        timeout_secs: Some(20),
                        ..NodeConfig::default()
                    },
                    label: None,
                },
                Node {
                    id: "end".into(),
                    kind: NodeKind::End,
                    position: Position::default(),
                    config: NodeConfig::default(),
                    label: None,
                },
            ],
            edges: vec![
                Edge {
                    id: "e0".into(),
                    source: "start".into(),
                    target: "g".into(),
                    label: None,
                },
                Edge {
                    id: "e1".into(),
                    source: "g".into(),
                    target: "end".into(),
                    label: None,
                },
            ],
        };
        db.upsert_workflow(&wf).expect("upsert");
        engine
            .start_run(&wf, "run-gh-1", &HashMap::new())
            .expect("start");
        engine.execute(wf, "run-gh-1".to_string()).await;
        assert_eq!(
            db.list_runs(10).expect("runs")[0].status,
            RunStatus::Succeeded
        );
        let row = db
            .list_node_results("run-gh-1")
            .expect("results")
            .into_iter()
            .find(|r| r.node_id == "g")
            .expect("row");
        assert!(row.stdout.contains("#3"));
        std::env::remove_var("ORCHEVIA_GH_BIN");
    }
}
