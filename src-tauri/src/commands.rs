//! Tauri commands: thin adapters over `orchevia-core` + the engine.
//!
//! The UI must never spawn processes or touch SQLite directly; everything
//! goes through these commands.

use orchevia_core::scheduler::RunStarter;
use orchevia_core::{
    agents::{
        build_agent_command, discover_agent_skills, preview_agent_command as format_agent_preview,
        AdapterInfo, AdapterKind, AgentProfile, AgentSkillInfo,
    },
    db::{SqliteDb, StoredNodeResult, StoredRun, StoredWorkflow},
    engine::{CancellationRegistry, Engine},
    mcp::McpServerConfig,
    process::CommandSpec,
    prompt::referenced_variables,
    tools::{default_tools, discover_tools, ToolStatus},
    workflow::{validate_workflow, Workflow, CURRENT_SCHEMA_VERSION},
};
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

pub struct AppState {
    pub db: Arc<SqliteDb>,
    pub engine: Engine,
    pub cancel: CancellationRegistry,
    pub scheduler_wake: Arc<tokio::sync::Notify>,
}

impl AppState {
    pub fn new(db: Arc<SqliteDb>) -> Self {
        let cancel = CancellationRegistry::default();
        let engine = Engine::new(Arc::clone(&db), cancel.clone());
        Self {
            db,
            engine,
            cancel,
            scheduler_wake: Arc::new(tokio::sync::Notify::new()),
        }
    }

    pub fn scheduler_starter(&self) -> EngineStarter {
        EngineStarter {
            db: Arc::clone(&self.db),
            cancel: self.cancel.clone(),
        }
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStarted {
    pub run_id: String,
}

#[tauri::command]
pub fn encode_workflow_document(
    state: State<AppState>,
    workflow: Workflow,
) -> Result<orchevia_core::workflow_document::DocumentSession, String> {
    orchevia_core::workflow_document::export_document(
        &workflow,
        &state.db.list_agent_profiles().map_err(|e| e.to_string())?,
    )
}
#[tauri::command]
pub fn decode_workflow_document(
    state: State<AppState>,
    json: String,
    base: Option<Workflow>,
    node_ids: Option<std::collections::HashMap<String, String>>,
) -> Result<Workflow, String> {
    let profiles = state.db.list_agent_profiles().map_err(|e| e.to_string())?;
    orchevia_core::workflow_document::import_document(
        &json,
        base.as_ref(),
        &node_ids.unwrap_or_default(),
        &profiles,
        &default_role_map(&state),
        &format!("wf-{}", Uuid::new_v4().simple()),
    )
}

// -- Workflows ---------------------------------------------------------------

#[tauri::command]
pub fn list_workflows(state: State<AppState>) -> Result<Vec<StoredWorkflow>, String> {
    state.db.list_workflows().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_workflow(state: State<AppState>, id: String) -> Result<Option<StoredWorkflow>, String> {
    state.db.get_workflow(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_workflow(state: State<AppState>, workflow: Workflow) -> Result<StoredWorkflow, String> {
    if workflow.schema_version > CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported schema version {}.",
            workflow.schema_version
        ));
    }
    state
        .db
        .upsert_workflow(&workflow)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_workflow(state: State<AppState>, id: String) -> Result<bool, String> {
    state.db.delete_workflow(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn validate_workflow_cmd(
    workflow: Workflow,
) -> Result<Vec<orchevia_core::workflow::ValidationIssue>, String> {
    Ok(validate_workflow(&workflow))
}

// -- Environment -------------------------------------------------------------

/// Re-resolve the login shell PATH (dropping cached lookups), then probe the
/// registered tools. Runs on a blocking thread: never on the UI thread.
#[tauri::command]
pub async fn detect_tools() -> Result<Vec<ToolStatus>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        orchevia_core::tools::refresh_search_environment();
        discover_tools(&default_tools())
    })
    .await
    .map_err(|e| format!("Tool detection failed to join: {e}"))
}

// -- Runs --------------------------------------------------------------------

#[tauri::command]
pub async fn run_workflow(
    state: State<'_, AppState>,
    workflow_id: String,
    inputs: Option<std::collections::HashMap<String, String>>,
    options: Option<orchevia_core::run_controls::RunOptions>,
) -> Result<RunStarted, String> {
    let stored = state
        .db
        .get_workflow(&workflow_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Unknown workflow '{workflow_id}'."))?;
    let run_id = format!("run-{}", Uuid::new_v4().simple());
    state
        .engine
        .start_run_with_options(
            &stored.definition,
            &run_id,
            &inputs.unwrap_or_default(),
            &options.unwrap_or_default(),
        )
        .map_err(|e| e.to_string())?;
    // Clone what the background task needs; the command returns immediately.
    let engine_db = Arc::clone(&state.db);
    let cancel = state.cancel.clone();
    let workflow = stored.definition.clone();
    let run_id_clone = run_id.clone();
    tokio::spawn(async move {
        let engine = Engine::new(engine_db, cancel);
        engine.execute(workflow, run_id_clone).await;
    });
    Ok(RunStarted { run_id })
}

#[tauri::command]
pub fn preview_recovery(
    state: State<AppState>,
    run_id: String,
) -> Result<orchevia_core::run_controls::RecoveryPlan, String> {
    state
        .engine
        .preview_recovery(&run_id)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn recover_run(
    state: State<'_, AppState>,
    run_id: String,
    choices: std::collections::HashMap<String, orchevia_core::run_controls::RecoveryChoice>,
    fingerprint: String,
    request_id: String,
) -> Result<RunStarted, String> {
    let new_id = format!("run-{}", Uuid::new_v4().simple());
    let recovered = state
        .engine
        .recover_run(&run_id, &new_id, &choices, &fingerprint, &request_id)
        .map_err(|e| e.to_string())?;
    if recovered == new_id {
        let workflow = state
            .db
            .get_run_workflow(&new_id)
            .map_err(|e| e.to_string())?
            .ok_or("Run snapshot unavailable.")?;
        let db = Arc::clone(&state.db);
        let cancel = state.cancel.clone();
        let child_id = new_id.clone();
        tokio::spawn(async move {
            Engine::new(db, cancel).execute(workflow, child_id).await;
        });
    }
    Ok(RunStarted { run_id: recovered })
}
#[tauri::command]
pub async fn continue_spend_run(
    state: State<'_, AppState>,
    run_id: String,
    expected_pause_id: i64,
    limit: Option<f64>,
) -> Result<(), String> {
    state
        .engine
        .continue_spend_run(&run_id, expected_pause_id, limit)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cancel_run(state: State<AppState>, run_id: String) -> Result<bool, String> {
    state.engine.cancel_run(&run_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn approve_run(
    state: State<'_, AppState>,
    run_id: String,
    approved: bool,
    note: Option<String>,
    expected_approval_id: Option<i64>,
) -> Result<(), String> {
    // Resume the definition captured for this run, including after edits.
    let workflow = state
        .db
        .get_run_workflow(&run_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Unknown run '{run_id}'."))?;
    let engine_db = Arc::clone(&state.db);
    let cancel = state.cancel.clone();
    let engine = Engine::new(engine_db, cancel);
    engine
        .approve_run_with_approval(
            &run_id,
            approved,
            note.as_deref(),
            expected_approval_id,
            workflow,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_known_folders(
    state: State<AppState>,
    limit: Option<i64>,
) -> Result<Vec<String>, String> {
    state
        .db
        .list_known_folders(limit.unwrap_or(20))
        .map_err(|e| e.to_string())
}

// -- Integrations: GitHub, MCP (Milestone 4) -----------------------------------
// (Git itself runs inside workflows through Git nodes in the engine; the
// native repo-inspector commands were removed with the Changes view.)

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubState {
    pub installed: bool,
    pub authenticated: bool,
    pub user: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitBranches {
    pub current: String,
    pub branches: Vec<String>,
}

/// Branches of the repo containing `working_dir`: current + list for branch
/// pickers. Narrow helper for branch fields (with one-click Detect): the full
/// repo inspector stays removed by design.
#[tauri::command]
pub fn git_branches(working_dir: String) -> Result<GitBranches, String> {
    let root = orchevia_core::git::discover_root(working_dir.trim())
        .ok_or_else(|| "Not a git repository.".to_string())?;
    let (current, branches) = orchevia_core::git::branches(&root)?;
    if current.trim().is_empty() {
        return Err("Could not determine the current branch.".to_string());
    }
    Ok(GitBranches { current, branches })
}

/// Back-compat alias returning just the current branch.
#[tauri::command]
pub fn git_current_branch(working_dir: String) -> Result<String, String> {
    Ok(git_branches(working_dir)?.current)
}

#[tauri::command]
pub fn github_state() -> Result<GitHubState, String> {
    let installed = orchevia_core::tools::find_executable("gh").is_some();
    if !installed {
        return Ok(GitHubState {
            installed: false,
            authenticated: false,
            user: None,
            version: None,
        });
    }
    let runner = orchevia_core::github::GhRunner::default();
    let auth = orchevia_core::github::auth_status(&runner);
    let version = orchevia_core::tools::default_tools()
        .into_iter()
        .find(|t| t.id == "gh")
        .and_then(|def| {
            orchevia_core::tools::discover_tools(&[def])
                .into_iter()
                .next()
        })
        .and_then(|s| s.version);
    Ok(GitHubState {
        installed: true,
        authenticated: auth.authenticated,
        user: auth.user,
        version,
    })
}

#[tauri::command]
pub fn list_mcp_servers(state: State<AppState>) -> Result<Vec<McpServerConfig>, String> {
    state.db.list_mcp_servers().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_mcp_server(
    state: State<AppState>,
    server: McpServerConfig,
) -> Result<McpServerConfig, String> {
    state
        .db
        .upsert_mcp_server(&server)
        .map_err(|e| e.to_string())?;
    state
        .db
        .get_mcp_server(&server.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Failed to read back saved MCP server.".to_string())
}

#[tauri::command]
pub fn delete_mcp_server(state: State<AppState>, id: String) -> Result<bool, String> {
    state.db.delete_mcp_server(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mcp_list_tools(
    state: State<'_, AppState>,
    server_id: String,
) -> Result<Vec<orchevia_core::mcp::McpToolInfo>, String> {
    let server = state
        .db
        .get_mcp_server(&server_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Unknown MCP server '{server_id}'."))?;
    // Discovery runs on a blocking thread so a slow server never stalls the
    // async runtime; bounded at 45 s (first `uvx` run downloads the package).
    let cancel = state.cancel.flag_for(&format!("mcp-discover-{server_id}"));
    tauri::async_runtime::spawn_blocking(move || {
        orchevia_core::mcp::list_tools(&server, std::time::Duration::from_secs(45), &cancel)
    })
    .await
    .map_err(|e| format!("MCP discovery failed to join: {e}"))?
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvPresence {
    pub name: String,
    pub present: bool,
}

/// Which of the named environment variables are visible to Orchevia (and
/// therefore to spawned MCP servers). Names only — values are never read,
/// returned, or logged. Lets users prove a shell-profile export actually
/// reached the desktop app before debugging the server itself.
#[tauri::command]
pub fn mcp_env_present(names: Vec<String>) -> Vec<EnvPresence> {
    names
        .into_iter()
        .take(20)
        .map(|raw| {
            let name = raw.trim().chars().take(64).collect::<String>();
            let present = !name.is_empty()
                && std::env::var_os(&name)
                    .map(|v| !v.is_empty())
                    .unwrap_or(false);
            EnvPresence { name, present }
        })
        .collect()
}

#[tauri::command]
pub fn mcp_preview(
    server_id: String,
    command: String,
    args: Vec<String>,
) -> Result<String, String> {
    let _ = server_id;
    Ok(orchevia_core::mcp::preview_server(
        &orchevia_core::mcp::McpServerConfig {
            id: server_id,
            name: String::new(),
            command,
            args,
            enabled: true,
        },
    ))
}

// -- Automation: schedules, watchers, notifications (Milestone 5) ---------------

/// Starts runs for the background scheduler (validates + spawns like a
/// manual run, but marks the run id as scheduler-started).
#[derive(Clone)]
pub struct EngineStarter {
    pub db: Arc<SqliteDb>,
    pub cancel: CancellationRegistry,
}

impl orchevia_core::scheduler::RunStarter for EngineStarter {
    fn start_workflow_run(
        &self,
        workflow_id: &str,
        inputs: &std::collections::HashMap<String, String>,
    ) -> Result<String, String> {
        let stored = self
            .db
            .get_workflow(workflow_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Unknown workflow '{workflow_id}'."))?;
        // Validate the exact definition that will be executed, even if the
        // workflow changed between a GitHub check and this dispatch.
        if inputs
            .get("automationKind")
            .is_some_and(|kind| kind == "watcher")
        {
            let watcher_id = inputs
                .get("automationId")
                .ok_or("Watcher dispatch needs automationId.")?;
            let watcher = self
                .db
                .get_watcher(watcher_id)
                .map_err(|e| e.to_string())?
                .ok_or("Watcher was removed during dispatch.")?;
            if !watcher.enabled
                || watcher.workflow_id != workflow_id
                || inputs.get("repoDir") != Some(&watcher.repo_dir)
            {
                return Err("Watcher was disabled or changed during dispatch.".into());
            }
            orchevia_core::scheduler::validate_watcher_definition(
                &self.db,
                &stored.definition,
                &watcher,
            )?;
        }
        let run_id = format!("run-sched-{}", Uuid::new_v4().simple());
        let engine = Engine::new(Arc::clone(&self.db), self.cancel.clone());
        engine
            .start_run(&stored.definition, &run_id, inputs)
            .map_err(|e| e.to_string())?;
        let workflow = stored.definition.clone();
        let run_id_clone = run_id.clone();
        tokio::spawn(async move {
            engine.execute(workflow, run_id_clone).await;
        });
        Ok(run_id)
    }
}

fn check_schedule_trust(
    state: &State<AppState>,
    workflow_id: &str,
    trusted: bool,
) -> Result<(), String> {
    let stored = state
        .db
        .get_workflow(workflow_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Unknown workflow '{workflow_id}'."))?;
    orchevia_core::trust::may_enable_schedule(&stored.definition, trusted)
}

#[tauri::command]
pub fn list_schedules(
    state: State<AppState>,
) -> Result<Vec<orchevia_core::schedule::Schedule>, String> {
    state.db.list_schedules().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_schedule(
    state: State<AppState>,
    mut schedule: orchevia_core::schedule::Schedule,
) -> Result<orchevia_core::schedule::Schedule, String> {
    // Enabling automation over write-capable workflows needs trust.
    if schedule.enabled {
        check_schedule_trust(&state, &schedule.workflow_id, schedule.trusted)?;
    }
    // (Re)compute the next slot on save so the UI shows it immediately.
    let now = chrono::Utc::now();
    let (_, next) = orchevia_core::schedule::evaluate(&schedule, now);
    schedule.next_run_at = next;
    state
        .db
        .upsert_schedule(&schedule)
        .map_err(|e| e.to_string())?;
    state.scheduler_wake.notify_one();
    state
        .db
        .get_schedule(&schedule.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Failed to read back saved schedule.".to_string())
}

#[tauri::command]
pub fn delete_schedule(state: State<AppState>, id: String) -> Result<bool, String> {
    state.db.delete_schedule(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fire_schedule_now(
    state: State<'_, AppState>,
    id: String,
) -> Result<RunStarted, String> {
    let schedule = state
        .db
        .get_schedule(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Unknown schedule '{id}'."))?;
    check_schedule_trust(&state, &schedule.workflow_id, schedule.trusted)?;
    let starter = EngineStarter {
        db: Arc::clone(&state.db),
        cancel: state.cancel.clone(),
    };
    let run_id = starter
        .start_workflow_run(
            &schedule.workflow_id,
            &std::collections::HashMap::from([
                ("automationKind".into(), "schedule".into()),
                ("automationId".into(), schedule.id.clone()),
                ("automationTrigger".into(), "manual".into()),
            ]),
        )
        .map_err(|e| e.to_string())?;
    // Record the manual fire on the schedule row.
    let mut updated = schedule;
    updated.last_run_at = Some(chrono::Utc::now());
    updated.last_status = Some(format!("manually started {run_id}"));
    let _ = state.db.upsert_schedule(&updated);
    Ok(RunStarted { run_id })
}

#[tauri::command]
pub fn schedule_preview(
    kind: orchevia_core::schedule::ScheduleKind,
    timezone: String,
    count: Option<u8>,
) -> Result<Vec<String>, String> {
    // Reuse the same validators the save path uses.
    let probe = orchevia_core::schedule::Schedule {
        id: "preview".into(),
        name: "preview".into(),
        workflow_id: "preview".into(),
        kind: kind.clone(),
        timezone: timezone.clone(),
        enabled: true,
        trusted: true,
        missed_policy: orchevia_core::schedule::MissedPolicy::Skip,
        last_run_at: None,
        next_run_at: None,
        last_status: None,
    };
    let errors = probe.validate();
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(orchevia_core::schedule::upcoming(
        &kind,
        &timezone,
        chrono::Utc::now(),
        count.unwrap_or(3) as usize,
    )
    .into_iter()
    .map(|dt| dt.to_rfc3339())
    .collect())
}

#[tauri::command]
pub fn list_watchers(
    state: State<AppState>,
) -> Result<Vec<orchevia_core::schedule::Watcher>, String> {
    state.db.list_watchers().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_watcher(
    state: State<AppState>,
    mut watcher: orchevia_core::schedule::Watcher,
) -> Result<orchevia_core::schedule::Watcher, String> {
    // Enabling is the trust opt-in; declared repository bindings must agree.
    if watcher.enabled {
        orchevia_core::scheduler::validate_watcher_workflow(&state.db, &watcher)?;
    }
    let previous = state
        .db
        .get_watcher(&watcher.id)
        .map_err(|e| e.to_string())?;
    watcher.prepare_save(previous.as_ref());
    state
        .db
        .upsert_watcher(&watcher)
        .map_err(|e| e.to_string())?;
    state.scheduler_wake.notify_one();
    state
        .db
        .get_watcher(&watcher.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Failed to read back saved watcher.".to_string())
}

#[tauri::command]
pub async fn watcher_scope_issues(
    state: State<'_, AppState>,
    watcher: orchevia_core::schedule::Watcher,
) -> Result<Vec<String>, String> {
    let db = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || {
        match orchevia_core::scheduler::validate_watcher_workflow(&db, &watcher) {
            Ok(()) => Vec::new(),
            Err(message) => vec![message],
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_watcher(state: State<AppState>, id: String) -> Result<bool, String> {
    state.db.delete_watcher(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workflow_risks(
    workflow: Workflow,
) -> Result<Vec<orchevia_core::trust::RiskCategory>, String> {
    Ok(orchevia_core::trust::workflow_risks(&workflow)
        .into_iter()
        .collect())
}

#[tauri::command]
pub fn get_run_findings(
    state: State<AppState>,
    run_id: String,
) -> Result<Vec<orchevia_core::review::GroupedFinding>, String> {
    if state
        .db
        .get_run(&run_id)
        .map_err(|e| e.to_string())?
        .is_some_and(|r| r.execution.options.dry_run)
    {
        return Ok(Vec::new());
    }
    let workflow = state
        .db
        .get_run_workflow(&run_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Unknown run '{run_id}'."))?;
    let results = state
        .db
        .list_node_results(&run_id)
        .map_err(|e| e.to_string())?;
    let mut outputs: Vec<(String, String, String)> = Vec::new();
    for node in workflow
        .nodes
        .iter()
        .filter(|n| n.kind == orchevia_core::workflow::NodeKind::Agent)
    {
        let profile = node
            .config
            .agent_profile_id
            .as_deref()
            .and_then(|id| state.db.get_agent_profile(id).ok().flatten())
            .map(|p| p.name)
            .unwrap_or_default();
        if let Some(row) = results
            .iter()
            .rev()
            .find(|r| r.node_id == node.id && r.status == "succeeded")
        {
            if orchevia_core::run_controls::is_new_execution(row) {
                outputs.push((node.id.clone(), profile, row.stdout.clone()));
            }
        }
    }
    Ok(orchevia_core::review::grouped_findings(&outputs))
}

#[tauri::command]
pub fn list_notifications(
    state: State<AppState>,
    limit: Option<i64>,
    unread_only: Option<bool>,
) -> Result<Vec<orchevia_core::notify::Notification>, String> {
    state
        .db
        .list_notifications(limit.unwrap_or(50), unread_only.unwrap_or(false))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mark_notification_read(state: State<AppState>, id: i64) -> Result<(), String> {
    state
        .db
        .mark_notification_read(id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mark_all_notifications_read(state: State<AppState>) -> Result<(), String> {
    state
        .db
        .mark_all_notifications_read()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_notification_prefs(
    state: State<AppState>,
) -> Result<orchevia_core::notify::NotificationPrefs, String> {
    state.db.get_notification_prefs().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_notification_prefs(
    state: State<AppState>,
    prefs: orchevia_core::notify::NotificationPrefs,
) -> Result<(), String> {
    state
        .db
        .set_notification_prefs(&prefs)
        .map_err(|e| e.to_string())
}

const ALLOWED_SETTINGS: &[&str] = &[
    "background.mode",
    "notifications.os",
    "scheduler.intervalSecs",
    "ui.theme",
    "onboarding.completed",
    "workflow.assistanceProfileId",
];

/// User-taught model names per adapter ("claude" | "codex" | "custom").
/// Neither CLI exposes a non-interactive model list (Claude Code tracks it as
/// an open feature request; Codex only has the interactive /model picker),
/// and querying provider APIs would need API keys Orchevia will never ask
/// for — so users teach Orchevia their models once, and every profile editor
/// suggests the union of presets + these. Stored as JSON in settings.
fn custom_models_key(adapter: &str) -> Option<String> {
    match adapter.trim().to_ascii_lowercase().as_str() {
        "claude" | "codex" | "custom" => Some(format!(
            "models.custom.{}",
            adapter.trim().to_ascii_lowercase()
        )),
        _ => None,
    }
}

fn parse_custom_models(json: &str) -> Result<Vec<String>, String> {
    let raw: Vec<serde_json::Value> =
        serde_json::from_str(json).map_err(|_| "Model list must be JSON.".to_string())?;
    if raw.len() > 50 {
        return Err("At most 50 custom models per adapter.".to_string());
    }
    let mut out = Vec::with_capacity(raw.len());
    for item in raw {
        let name = item.as_str().unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        if name.len() > 120 {
            return Err("Model names must be at most 120 characters.".to_string());
        }
        if !out.iter().any(|n: &String| n == name) {
            out.push(name.to_string());
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn list_custom_models(state: State<AppState>, adapter: String) -> Result<Vec<String>, String> {
    let key = custom_models_key(&adapter).ok_or_else(|| "Unknown adapter.".to_string())?;
    match state.db.get_setting(&key).map_err(|e| e.to_string())? {
        None => Ok(Vec::new()),
        Some(json) => parse_custom_models(&json),
    }
}

#[tauri::command]
pub fn save_custom_models(
    state: State<AppState>,
    adapter: String,
    models: Vec<String>,
) -> Result<Vec<String>, String> {
    let key = custom_models_key(&adapter).ok_or_else(|| "Unknown adapter.".to_string())?;
    let cleaned = parse_custom_models(&serde_json::to_string(&models).unwrap_or_default())?;
    let stored = serde_json::to_string(&cleaned).map_err(|e| e.to_string())?;
    state
        .db
        .set_setting(&key, &stored)
        .map_err(|e| e.to_string())?;
    Ok(cleaned)
}

#[tauri::command]
pub fn get_setting(state: State<AppState>, key: String) -> Result<Option<String>, String> {
    get_setting_for_db(&state.db, &key)
}

fn get_setting_for_db(db: &SqliteDb, key: &str) -> Result<Option<String>, String> {
    if !ALLOWED_SETTINGS.contains(&key) {
        return Err(format!("Setting '{key}' is not user-configurable."));
    }
    db.get_setting(key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_setting(state: State<AppState>, key: String, value: String) -> Result<(), String> {
    set_setting_for_db(&state.db, &key, &value)
}

fn set_setting_for_db(db: &SqliteDb, key: &str, value: &str) -> Result<(), String> {
    if !ALLOWED_SETTINGS.contains(&key) {
        return Err(format!("Setting '{key}' is not user-configurable."));
    }
    if key == "scheduler.intervalSecs" {
        let secs: u64 = value
            .parse()
            .map_err(|_| "Interval must be a number.".to_string())?;
        if !(30..=3600).contains(&secs) {
            return Err("Scheduler interval must be 30–3600 s.".to_string());
        }
    }
    if value.len() > 200 {
        return Err("Setting value too long.".to_string());
    }
    db.set_setting(key, value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_runs(state: State<AppState>, limit: Option<i64>) -> Result<Vec<StoredRun>, String> {
    state
        .db
        .list_runs(limit.unwrap_or(50).clamp(1, 500))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_run(state: State<AppState>, run_id: String) -> Result<Option<StoredRun>, String> {
    state.db.get_run(&run_id).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn get_run_workflow(
    state: State<AppState>,
    run_id: String,
) -> Result<Option<Workflow>, String> {
    state
        .db
        .get_run_workflow(&run_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_run_results(
    state: State<AppState>,
    run_id: String,
) -> Result<Vec<StoredNodeResult>, String> {
    state
        .db
        .list_node_results(&run_id)
        .map_err(|e| e.to_string())
}

/// Delete one finished run and its node results. Running/paused runs are
/// refused — cancel first, so the engine never writes into a deleted run.
#[tauri::command]
pub fn delete_run(state: State<AppState>, run_id: String) -> Result<bool, String> {
    state.db.delete_run(&run_id).map_err(|e| e.to_string())
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearedRuns {
    pub removed: usize,
    pub kept: usize,
}

/// Delete all finished runs and their results. Running/paused runs are kept.
#[tauri::command]
pub fn clear_finished_runs(state: State<AppState>) -> Result<ClearedRuns, String> {
    let (removed, kept) = state.db.clear_finished_runs().map_err(|e| e.to_string())?;
    Ok(ClearedRuns { removed, kept })
}

/// Render a safe display preview of a command (shell-escaped, display only).
#[tauri::command]
pub fn preview_command(executable: String, args: Vec<String>) -> Result<String, String> {
    Ok(CommandSpec {
        executable,
        args,
        working_dir: None,
        stdin: None,
    }
    .preview())
}

// -- Agent Profiles / adapters (Milestone 2) ----------------------------------

#[tauri::command]
pub fn list_adapters() -> Result<Vec<AdapterInfo>, String> {
    Ok(AdapterKind::all())
}

#[tauri::command]
pub fn list_agent_profiles(state: State<AppState>) -> Result<Vec<AgentProfile>, String> {
    state.db.list_agent_profiles().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_agent_skills(
    adapter: AdapterKind,
    working_dir: Option<String>,
) -> Result<Vec<AgentSkillInfo>, String> {
    Ok(discover_agent_skills(
        adapter,
        working_dir.as_deref().map(std::path::Path::new),
    ))
}

#[tauri::command]
pub fn save_agent_profile(
    state: State<AppState>,
    profile: AgentProfile,
) -> Result<AgentProfile, String> {
    state
        .db
        .upsert_agent_profile(&profile)
        .map_err(|e| e.to_string())?;
    state
        .db
        .get_agent_profile(&profile.id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Failed to read back saved profile.".to_string())
}

#[tauri::command]
pub fn delete_agent_profile(state: State<AppState>, id: String) -> Result<bool, String> {
    state
        .db
        .delete_agent_profile(&id)
        .map_err(|e| e.to_string())
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreview {
    pub executable: String,
    pub args: Vec<String>,
    pub preview: String,
    pub referenced_variables: Vec<String>,
}

#[tauri::command]
pub fn preview_agent_command(
    state: State<AppState>,
    profile_id: String,
    prompt_template: String,
    working_dir: Option<String>,
) -> Result<AgentPreview, String> {
    let profile = state
        .db
        .get_agent_profile(&profile_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Unknown Agent Profile '{profile_id}'."))?;
    // Render a note, not secrets: placeholders stay unresolved in preview.
    // Fallible throughout: a profile whose directory vanished reports the
    // problem instead of panicking (no expect() on production paths).
    let spec = build_agent_command(&profile, &prompt_template, working_dir.as_deref())
        .or_else(|first_err| {
            build_agent_command(
                &profile,
                "prompt preview (unresolved variables shown verbatim)",
                None,
            )
            .map_err(|_| first_err)
        })
        .map_err(|e| e.to_string())?;
    Ok(AgentPreview {
        executable: spec.executable.clone(),
        args: spec.args.clone(),
        preview: format_agent_preview(&profile, &prompt_template),
        referenced_variables: referenced_variables(&prompt_template),
    })
}

#[tauri::command]
pub async fn test_agent_profile(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<ToolStatus, String> {
    let profile = state
        .db
        .get_agent_profile(&profile_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Unknown Agent Profile '{profile_id}'."))?;
    // The `--version` probe can take seconds; keep it off the UI thread.
    tauri::async_runtime::spawn_blocking(move || probe_agent_profile(&profile))
        .await
        .map_err(|e| format!("Profile test failed to join: {e}"))
}

fn probe_agent_profile(profile: &AgentProfile) -> ToolStatus {
    let exe = profile.effective_executable();
    let found =
        orchevia_core::tools::find_executable(&exe).map(|p| p.to_string_lossy().into_owned());
    // Probe --version without a shell; failure just reports unavailable.
    let version = found.as_deref().and_then(|path| {
        let spec = CommandSpec {
            executable: path.to_string(),
            args: vec!["--version".to_string()],
            working_dir: None,
            stdin: None,
        };
        orchevia_core::process::run_command(&spec, Some(std::time::Duration::from_secs(5)))
            .ok()
            .filter(|r| r.exit_code == Some(0))
            .and_then(|r| {
                format!("{}\n{}", r.stdout, r.stderr)
                    .lines()
                    .map(str::trim)
                    .find(|l| !l.is_empty())
                    .map(|l| l.chars().take(120).collect())
            })
    });
    ToolStatus {
        id: profile.id.clone(),
        display_name: format!("{} ({})", profile.name, profile.adapter.as_str()),
        installed: found.is_some(),
        version,
        path: found,
    }
}

// -- Generation, templates, memory (Milestone 6) -------------------------------

/// Role → profile map from configured profiles, completed by accepted
/// role preferences (accepted existing profile choices precede first-role fallback).
fn default_role_map(state: &State<AppState>) -> std::collections::HashMap<String, String> {
    role_map_for_db(&state.db)
}

fn role_map_for_db(db: &SqliteDb) -> std::collections::HashMap<String, String> {
    orchevia_core::memory::resolve_role_defaults(
        &db.list_agent_profiles().unwrap_or_default(),
        &db.list_preferences().unwrap_or_default(),
    )
}

#[tauri::command]
pub fn role_map_default(
    state: State<AppState>,
) -> Result<std::collections::HashMap<String, String>, String> {
    Ok(default_role_map(&state))
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateList {
    pub builtin: Vec<orchevia_core::templates::Template>,
    pub user: Vec<orchevia_core::templates::Template>,
}

#[tauri::command]
pub fn list_templates(state: State<AppState>) -> Result<TemplateList, String> {
    Ok(TemplateList {
        builtin: orchevia_core::templates::builtin_templates(),
        user: state.db.list_user_templates().map_err(|e| e.to_string())?,
    })
}

#[tauri::command]
pub fn save_user_template(
    state: State<AppState>,
    template: orchevia_core::templates::Template,
) -> Result<orchevia_core::templates::Template, String> {
    state
        .db
        .upsert_user_template(&template)
        .map_err(|e| e.to_string())?;
    // Read back through list (no get-by-id helper by design).
    state
        .db
        .list_user_templates()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|t| t.id == template.id)
        .ok_or_else(|| "Failed to read back saved template.".to_string())
}

#[tauri::command]
pub fn save_workflow_as_template(
    state: State<AppState>,
    workflow_id: String,
    name: String,
    category: Option<String>,
) -> Result<orchevia_core::templates::Template, String> {
    let stored = state
        .db
        .get_workflow(&workflow_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Unknown workflow '{workflow_id}'."))?;
    // Keep exact reviewer choices locally. Portable export resolves IDs to names.
    let definition = stored.definition.clone();
    let template = orchevia_core::templates::Template {
        id: format!("user-{}", uuid::Uuid::new_v4().simple()),
        version: orchevia_core::templates::TEMPLATE_SCHEMA_VERSION,
        name,
        description: format!("Saved from workflow '{}'.", stored.name),
        category: category.unwrap_or_else(|| "general".to_string()),
        workflow: definition,
    };
    state
        .db
        .upsert_user_template(&template)
        .map_err(|e| e.to_string())?;
    Ok(template)
}

#[tauri::command]
pub fn delete_user_template(state: State<AppState>, id: String) -> Result<bool, String> {
    state
        .db
        .delete_user_template(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_template(
    state: State<AppState>,
    id: String,
    builtin: bool,
) -> Result<String, String> {
    let template = find_template(&state, &id, builtin)?;
    orchevia_core::templates::export_developer_template(
        &template,
        &state.db.list_agent_profiles().map_err(|e| e.to_string())?,
    )
}

#[tauri::command]
pub fn import_template(
    state: State<AppState>,
    json: String,
) -> Result<orchevia_core::templates::Template, String> {
    let mut template = orchevia_core::templates::import_developer_template(
        &json,
        &state.db.list_agent_profiles().map_err(|e| e.to_string())?,
    )?;
    // Namespace imported ids to avoid collisions.
    template.id = format!("user-{}", uuid::Uuid::new_v4().simple());
    state
        .db
        .upsert_user_template(&template)
        .map_err(|e| e.to_string())?;
    Ok(template)
}

fn find_template(
    state: &State<AppState>,
    id: &str,
    builtin: bool,
) -> Result<orchevia_core::templates::Template, String> {
    if builtin {
        orchevia_core::templates::builtin_templates()
            .into_iter()
            .find(|t| t.id == id)
            .ok_or_else(|| format!("Unknown template '{id}'."))
    } else {
        state
            .db
            .list_user_templates()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|t| t.id == id)
            .ok_or_else(|| format!("Unknown template '{id}'."))
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstantiationPreview {
    pub workflow: Workflow,
    pub setup_needed: Vec<String>,
}

#[tauri::command]
pub fn instantiate_template(
    state: State<AppState>,
    id: String,
    builtin: bool,
    role_map: Option<std::collections::HashMap<String, String>>,
) -> Result<InstantiationPreview, String> {
    let template = find_template(&state, &id, builtin)?;
    let map = role_map.unwrap_or_else(|| default_role_map(&state));
    let instantiated = orchevia_core::templates::instantiate(&template, &map, true)?;
    Ok(InstantiationPreview {
        workflow: instantiated.workflow,
        setup_needed: instantiated.setup_needed,
    })
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationPreview {
    pub generation_id: String,
    pub proposal_name: String,
    pub explanation: String,
    pub workflow: Workflow,
    pub issues: Vec<orchevia_core::workflow::ValidationIssue>,
    pub unavailable: Vec<String>,
    pub risk_labels: Vec<String>,
    pub risky_nodes: Vec<String>,
    pub blocking: Vec<String>,
    pub repairs: Vec<String>,
    pub setup_needed: Vec<String>,
    pub unmapped_roles: Vec<String>,
}

/// Max generator-goal length in characters. Covers the user goal plus the
/// declared-inputs/repair context the UI appends, with headroom below the
/// generator prompt ceiling.
const MAX_GOAL_CHARS: usize = 12_000;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowAssistanceRequest {
    pub workflow_id: String,
    pub mode: orchevia_core::generation::AssistanceMode,
}

#[tauri::command]
pub async fn generate_workflow(
    state: State<'_, AppState>,
    profile_id: String,
    goal: String,
    repo_dir: Option<String>,
    branch: Option<String>,
    assistance: Option<WorkflowAssistanceRequest>,
) -> Result<GenerationPreview, String> {
    if goal.trim().is_empty() {
        return Err("Describe what you want to do first.".to_string());
    }
    // Character budget (not bytes — multibyte text must not be penalized).
    // The frontend appends declared-inputs/repair context to the goal before
    // sending, so the cap covers the total, with headroom below the generator
    // prompt ceiling.
    if goal.chars().count() > MAX_GOAL_CHARS {
        return Err(format!(
            "Goal is too long (max {MAX_GOAL_CHARS} characters)."
        ));
    }
    let base = assistance
        .as_ref()
        .map(|request| {
            state
                .db
                .get_workflow(&request.workflow_id)
                .map_err(|e| e.to_string())?
                .map(|stored| stored.definition)
                .ok_or_else(|| "The workflow for assistance no longer exists.".to_string())
        })
        .transpose()?;
    let (repo_dir, branch) = if let Some(workflow) = &base {
        (
            orchevia_core::generation::assistance_repo_dir(workflow),
            workflow.defaults.as_ref().and_then(|d| d.branch.clone()),
        )
    } else {
        (repo_dir, branch)
    };
    let profile = state
        .db
        .get_agent_profile(&profile_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Unknown Agent Profile '{profile_id}'."))?;
    if !cli_available(&profile.effective_executable()) {
        return Err(format!(
            "Profile '{}' needs '{}', which was not found on PATH. Set the full executable \
             path in the profile, or install it and use Refresh in Environment.",
            profile.name,
            profile.effective_executable()
        ));
    }
    // Optional repo grounding: validated here (length + existence), then
    // handed to the prompt (recon instructions) and the compiled workflow
    // (node working dirs + workflow defaults).
    let repo_dir = repo_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(dir) = repo_dir.as_deref() {
        if dir.len() > 500 {
            return Err("Repository directory is too long.".to_string());
        }
        if !std::path::Path::new(dir).is_dir() {
            return Err(format!("Repository directory does not exist: {dir}"));
        }
    }
    let branch = branch
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(b) = branch.as_deref() {
        if b.len() > 200 {
            return Err("Branch name is too long.".to_string());
        }
    }
    let repo_dir = repo_dir
        .as_deref()
        .map(|dir| {
            std::fs::canonicalize(dir)
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|e| e.to_string())
        })
        .transpose()?;
    let repo = repo_dir
        .clone()
        .map(|dir| orchevia_core::generation::RepoContext {
            dir,
            branch: branch.clone(),
        });
    let roles = orchevia_core::workflow::well_known_roles();
    let role_map = default_role_map(&state);
    let profiles = state.db.list_agent_profiles().map_err(|e| e.to_string())?;
    let prompt_label = |value: &str| {
        value
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(120)
            .collect::<String>()
    };
    let memory_scope = repo
        .as_ref()
        .map(|context| orchevia_core::memory::project_scope(&context.dir))
        .transpose()?;
    let preferences = state.db.list_preferences().map_err(|e| e.to_string())?;
    let memory_context =
        orchevia_core::memory::project_context(&preferences, memory_scope.as_deref());
    let mut profile_context =
        orchevia_core::generation::build_profile_context(&profiles, &role_map, &memory_context);
    if let (Some(workflow), Some(request)) = (&base, &assistance) {
        let run_context =
            orchevia_core::generation::latest_assistance_run_context(&state.db, workflow)?;
        profile_context.push('\n');
        profile_context.push_str(&orchevia_core::generation::build_assistance_context(
            workflow,
            request.mode,
            &profiles,
            &run_context,
        )?);
    }
    // Probe configured MCP servers before drafting. Their actual tool names and
    // required argument keys prevent the generator from inventing Jira REST
    // credentials or an MCP method that the installed server does not expose.
    let servers = state.db.list_mcp_servers().map_err(|e| e.to_string())?;
    for server in servers.into_iter().filter(|server| server.enabled).take(4) {
        let server_name = prompt_label(&server.name);
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let tools = tauri::async_runtime::spawn_blocking(move || {
            orchevia_core::mcp::list_tools(&server, std::time::Duration::from_secs(12), &cancel)
        })
        .await
        .map_err(|e| format!("MCP discovery task failed to join: {e}"))?;
        match tools {
            Ok(tools) => {
                profile_context.push_str(&format!("\n- MCP server {server_name} tools:"));
                for tool in tools.iter().take(100) {
                    let required = tool
                        .input_schema
                        .as_ref()
                        .and_then(|schema| schema.get("required"))
                        .and_then(|required| required.as_array())
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|item| item.as_str())
                                .map(|name| {
                                    let kind = tool
                                        .input_schema
                                        .as_ref()
                                        .and_then(|schema| schema.get("properties"))
                                        .and_then(|properties| properties.get(name))
                                        .and_then(|property| property.get("type"))
                                        .and_then(|kind| kind.as_str())
                                        .unwrap_or("unknown");
                                    format!("{}: {}", prompt_label(name), prompt_label(kind))
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    profile_context.push_str(&format!(
                        "\n  - {} (required args: {})",
                        prompt_label(&tool.name),
                        if required.is_empty() { "none".to_string() } else { required.join(", ") }
                    ));
                }
            }
            Err(_) => profile_context.push_str(&format!(
                "\n- MCP server {server_name}: configured, tool discovery unavailable; do not guess tools or arguments"
            )),
        }
    }
    let prompt = orchevia_core::generation::build_generator_prompt(
        goal.trim(),
        &roles,
        &[
            "start",
            "command",
            "approval",
            "agent",
            "condition",
            "git",
            "github",
            "ticket",
            "mcp",
            "end",
        ],
        repo.as_ref(),
        &profile_context,
    );
    let generation_id = format!("gen-{}", uuid::Uuid::new_v4().simple());
    // Blocking CLI run on a worker thread; bounded by the profile timeout.
    let output = tauri::async_runtime::spawn_blocking(move || {
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        orchevia_core::generation::run_generator_cli(
            &profile,
            &prompt,
            repo_dir.as_deref(),
            &cancel,
        )
    })
    .await
    .map_err(|e| format!("Generator task failed to join: {e}"))??;
    let proposal = match orchevia_core::generation::parse_proposal(&output) {
        Ok(proposal) => proposal,
        Err(e) => {
            let _ = state.db.record_generation(
                &generation_id,
                goal.trim(),
                &profile_id,
                &truncate_for_history(&output),
                "failed",
            );
            return Err(format!(
                "{e} You can retry or repair the wording and generate again."
            ));
        }
    };
    let proposal_json = serde_json::to_string_pretty(&proposal).unwrap_or_default();
    let workflow_id = format!("wf-gen-{}", uuid::Uuid::new_v4().simple());
    let defaults = repo.map(|r| orchevia_core::workflow::WorkflowDefaults {
        repo_dir: Some(r.dir),
        branch: r.branch,
    });
    let compiled = if let (Some(workflow), Some(request)) = (&base, &assistance) {
        orchevia_core::generation::compile_assistance_proposal(
            &proposal,
            workflow,
            request.mode,
            &role_map,
            &profiles,
        )
    } else {
        orchevia_core::generation::compile_proposal_with_profiles(
            &proposal,
            &role_map,
            &workflow_id,
            defaults,
            &profiles,
        )
    };
    match compiled {
        Ok(preview) => {
            let _ = state.db.record_generation(
                &generation_id,
                goal.trim(),
                &profile_id,
                &proposal_json,
                "proposed",
            );
            // Borrow before the partial moves below (blocking_errors takes &self).
            let blocking = preview.blocking_errors();
            Ok(GenerationPreview {
                generation_id,
                proposal_name: proposal.name.clone(),
                explanation: preview.explanation.clone(),
                workflow: preview.workflow,
                issues: preview.issues,
                unavailable: preview.unavailable,
                risk_labels: preview.risk_labels,
                risky_nodes: preview.risky_nodes,
                blocking,
                repairs: preview.repairs,
                setup_needed: preview.setup_needed,
                unmapped_roles: preview.unmapped_roles,
            })
        }
        Err(e) => {
            let _ = state.db.record_generation(
                &generation_id,
                goal.trim(),
                &profile_id,
                &proposal_json,
                "failed",
            );
            Err(format!("Proposal rejected: {e}"))
        }
    }
}

fn truncate_for_history(text: &str) -> String {
    text.chars().take(20_000).collect()
}

/// PATH/file check (exec bit included) shared by generator + test flows (no spawning).
fn cli_available(exe: &str) -> bool {
    orchevia_core::tools::find_executable(exe).is_some()
}

#[tauri::command]
pub fn mark_generation_status(
    state: State<AppState>,
    id: String,
    status: String,
) -> Result<(), String> {
    if !["proposed", "accepted", "discarded", "failed"].contains(&status.as_str()) {
        return Err("Unknown generation status.".to_string());
    }
    // Generations are append-only history; status flips via re-record.
    let generations = state.db.list_generations(500).map_err(|e| e.to_string())?;
    let generation = generations
        .into_iter()
        .find(|g| g.id == id)
        .ok_or_else(|| format!("Unknown generation '{id}'."))?;
    state
        .db
        .record_generation(
            &id,
            &generation.goal,
            &generation.generator_profile,
            &generation.proposal_json,
            &status,
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_generations(
    state: State<AppState>,
    limit: Option<i64>,
) -> Result<Vec<orchevia_core::db::StoredGeneration>, String> {
    state
        .db
        .list_generations(limit.unwrap_or(50))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_project_memory_context(
    state: State<AppState>,
    repo_dir: Option<String>,
) -> Result<orchevia_core::memory::ProjectMemoryContext, String> {
    let scope = repo_dir
        .filter(|d| !d.trim().is_empty())
        .map(|d| orchevia_core::memory::project_scope(&d))
        .transpose()?;
    let preferences = state.db.list_preferences().map_err(|e| e.to_string())?;
    Ok(orchevia_core::memory::project_context(
        &preferences,
        scope.as_deref(),
    ))
}

#[tauri::command]
pub fn save_project_preference(
    state: State<AppState>,
    repo_dir: String,
    field: String,
    value: serde_json::Value,
    note: String,
) -> Result<orchevia_core::memory::Preference, String> {
    let scope = orchevia_core::memory::project_scope(&repo_dir)?;
    let preference = orchevia_core::memory::Preference {
        key: orchevia_core::memory::project_key(&scope, &field)?,
        scope,
        value,
        source: "manual".into(),
        enabled: true,
        note,
    };
    state
        .db
        .upsert_preference(&preference)
        .map_err(|e| e.to_string())?;
    Ok(preference)
}

#[tauri::command]
pub fn list_preferences(
    state: State<AppState>,
) -> Result<Vec<orchevia_core::memory::Preference>, String> {
    state.db.list_preferences().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_preference(
    state: State<AppState>,
    preference: orchevia_core::memory::Preference,
) -> Result<orchevia_core::memory::Preference, String> {
    orchevia_core::memory::validate_preference(&preference)?;
    let stored = preference;
    state
        .db
        .upsert_preference(&stored)
        .map_err(|e| e.to_string())?;
    Ok(stored)
}

#[tauri::command]
pub fn delete_preference(state: State<AppState>, key: String) -> Result<bool, String> {
    state.db.delete_preference(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reset_memory(state: State<AppState>) -> Result<(), String> {
    state.db.reset_memory().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_memory(state: State<AppState>) -> Result<String, String> {
    let prefs = state.db.list_preferences().map_err(|e| e.to_string())?;
    orchevia_core::memory::export_preferences(&prefs)
}

#[tauri::command]
pub fn import_memory(state: State<AppState>, json: String) -> Result<usize, String> {
    let prefs = orchevia_core::memory::import_preferences(&json)?;
    state
        .db
        .import_preferences(&prefs)
        .map_err(|e| e.to_string())
}

/// Record observed edits; returns fresh suggestions (if learning is on).
#[tauri::command]
pub fn observe_edits(
    state: State<AppState>,
    observations: Vec<orchevia_core::memory::EditObservation>,
) -> Result<Vec<orchevia_core::memory::Preference>, String> {
    let prefs = state.db.list_preferences().map_err(|e| e.to_string())?;
    if !orchevia_core::memory::learning_enabled(&prefs) {
        return Ok(Vec::new());
    }
    for observation in observations.iter().take(20) {
        orchevia_core::memory::validate_observation(observation)?;
    }
    let mut suggestions = Vec::new();
    for observation in observations.iter().take(20) {
        let counter_key = orchevia_core::memory::observation_counter_key(observation);
        let key = orchevia_core::memory::preference_key(&observation.scope, &observation.field);
        if prefs.iter().any(|p| p.key == key)
            || suggestions
                .iter()
                .any(|p: &orchevia_core::memory::Preference| p.key == key)
        {
            continue;
        }
        let count = state
            .db
            .bump_observation(&counter_key)
            .map_err(|e| e.to_string())?;
        if count >= orchevia_core::memory::SUGGESTION_THRESHOLD {
            let suggestion = orchevia_core::memory::Preference {
                key,
                scope: observation.scope.clone(),
                value: serde_json::Value::String(observation.to.clone()),
                source: "suggested".to_string(),
                enabled: true,
                note: format!(
                    "Suggested after {count} saved edits to {}. Previous value: {}.",
                    observation.field,
                    observation.from.chars().take(80).collect::<String>()
                ),
            };
            state
                .db
                .upsert_preference(&suggestion)
                .map_err(|e| e.to_string())?;
            suggestions.push(suggestion);
        }
    }
    Ok(suggestions)
}

// -- Diagnostics (Milestone 7) --------------------------------------------------------

/// Privacy-preserving local diagnostics bundle: versions, counts, tool
/// availability, recent error kinds. No prompts, no file contents, no
/// credentials, no environment dumps. Preview in the UI; never uploaded.
#[tauri::command]
pub fn diagnostics_bundle(state: State<AppState>) -> Result<String, String> {
    let tools = discover_tools(&default_tools());
    let search = orchevia_core::tools::search_environment();
    let runs = state.db.list_runs(1000).map_err(|e| e.to_string())?;
    let mut by_status = std::collections::HashMap::new();
    for run in &runs {
        *by_status.entry(format!("{:?}", run.status)).or_insert(0u32) += 1;
    }
    let recent_errors: Vec<serde_json::Value> = state
        .db
        .list_notifications(200, false)
        .map(|notes| {
            notes
                .into_iter()
                .filter(|n| n.kind == "failure" || n.kind == "schedule-blocked")
                .take(20)
                .map(|n| {
                    serde_json::json!({
                        "kind": n.kind,
                        "title": n.title.chars().take(160).collect::<String>(),
                        "at": n.created_at.to_rfc3339(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let bundle = serde_json::json!({
        "orcheviaVersion": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "schemaVersions": {
            "workflow": CURRENT_SCHEMA_VERSION,
            "generation": orchevia_core::generation::GENERATION_SCHEMA_VERSION,
            "template": orchevia_core::templates::TEMPLATE_SCHEMA_VERSION,
        },
        "counts": {
            "workflows": state.db.list_workflows().map(|w| w.len()).unwrap_or(0),
            "runs": runs.len(),
            "runsByStatus": by_status,
            "agentProfiles": state.db.list_agent_profiles().map(|v| v.len()).unwrap_or(0),
            "mcpServers": state.db.list_mcp_servers().map(|v| v.len()).unwrap_or(0),
            "schedules": state.db.list_schedules().map(|v| v.len()).unwrap_or(0),
            "watchers": state.db.list_watchers().map(|v| v.len()).unwrap_or(0),
            "templates": state.db.list_user_templates().map(|v| v.len()).unwrap_or(0),
            "preferences": state.db.list_preferences().map(|v| v.len()).unwrap_or(0),
        },
        "searchPath": {
            "source": search.source(),
            "directories": search.dirs().len(),
            "note": search.note(),
        },
        "tools": tools.iter().map(|t| serde_json::json!({
            "id": t.id,
            "installed": t.installed,
            "version": t.version,
        })).collect::<Vec<_>>(),
        "settings": {
            "background.mode": state.db.get_setting("background.mode").unwrap_or(None),
            "scheduler.intervalSecs": state.db.get_setting("scheduler.intervalSecs").unwrap_or(None),
            "notifications.os": state.db.get_setting("notifications.os").unwrap_or(None),
        },
        "recentErrors": recent_errors,
        "note": "Local-only bundle. Review before sharing; it contains counts, versions, and error titles — no prompts, files, or credentials.",
    });
    serde_json::to_string_pretty(&bundle).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn assistance_setting_round_trips_and_unknown_keys_are_rejected() {
        let db = orchevia_core::db::SqliteDb::open_in_memory().expect("db");
        assert_eq!(
            super::get_setting_for_db(&db, "workflow.assistanceProfileId").unwrap(),
            None
        );
        super::set_setting_for_db(&db, "workflow.assistanceProfileId", "assistant").unwrap();
        assert_eq!(
            super::get_setting_for_db(&db, "workflow.assistanceProfileId")
                .unwrap()
                .as_deref(),
            Some("assistant")
        );
        assert!(super::get_setting_for_db(&db, "private.setting").is_err());
        assert!(super::set_setting_for_db(&db, "private.setting", "value").is_err());
        assert_eq!(db.get_setting("private.setting").unwrap(), None);
    }

    use super::{custom_models_key, parse_custom_models, role_map_for_db, AppState};

    #[cfg(unix)]
    #[tokio::test]
    async fn manual_controls_cancel_scheduler_runs_with_partial_output() {
        use orchevia_core::{db::RunStatus, scheduler::RunStarter, workflow::NodeKind};
        use std::{collections::HashMap, sync::Arc, time::Duration};

        let db = Arc::new(orchevia_core::db::SqliteDb::open_in_memory().expect("db"));
        let mut workflow = orchevia_core::workflow::sample_workflow();
        let command = workflow
            .nodes
            .iter_mut()
            .find(|node| node.kind == NodeKind::Command)
            .expect("command");
        let node_id = command.id.clone();
        command.config.executable = Some("sh".into());
        command.config.args = vec!["-c".into(), "printf scheduled; sleep 5".into()];
        db.upsert_workflow(&workflow).expect("workflow");
        let state = AppState::new(Arc::clone(&db));
        let run_id = state
            .scheduler_starter()
            .start_workflow_run(&workflow.id, &HashMap::new())
            .expect("scheduled run");

        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if db
                    .list_node_results(&run_id)
                    .expect("results")
                    .iter()
                    .any(|result| result.node_id == node_id && result.stdout.contains("scheduled"))
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("running output");
        assert!(state.engine.cancel_run(&run_id).expect("cancel"));
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if db
                    .get_run(&run_id)
                    .expect("run")
                    .is_some_and(|run| run.status == RunStatus::Cancelled)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("cancelled run");
        let results = db.list_node_results(&run_id).expect("results");
        assert!(results.iter().any(|result| result.node_id == node_id
            && result.status == "cancelled"
            && result.stdout.contains("scheduled")));
    }

    #[test]
    fn role_preferences_do_not_resolve_deleted_profiles() {
        let db = orchevia_core::db::SqliteDb::open_in_memory().expect("db");
        db.upsert_preference(&orchevia_core::memory::Preference {
            key: orchevia_core::memory::keys::DEEP_REVIEW_PROFILE.into(),
            scope: "*".into(),
            value: serde_json::json!("deleted-profile"),
            source: "accepted".into(),
            enabled: true,
            note: String::new(),
        })
        .expect("preference");
        assert!(!role_map_for_db(&db).contains_key("deepReview"));
    }

    #[test]
    fn custom_model_registry_validates() {
        assert!(custom_models_key("claude").is_some());
        assert!(custom_models_key(" Codex ").is_some());
        assert!(custom_models_key("custom").is_some());
        assert!(custom_models_key("gpt").is_none());
        assert_eq!(
            parse_custom_models(r#"["a", "b", "a", "  "]"#).expect("parse"),
            vec!["a".to_string(), "b".to_string()]
        );
        assert!(parse_custom_models(r#"{"x":1}"#).is_err());
        assert!(parse_custom_models(r#"[""]"#)
            .expect("blanks skipped")
            .is_empty());
    }
}
