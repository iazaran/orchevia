//! SQLite persistence for workflows and run history.
//!
//! Uses `rusqlite` with a bundled SQLite build so contributors don't need a
//! system SQLite. All timestamps are RFC 3339 UTC strings.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use thiserror::Error;

use crate::agents::AgentProfile;
use crate::mcp::McpServerConfig;
use crate::notify::{Notification, NotificationPrefs};
use crate::schedule::Schedule;
use crate::workflow::Workflow;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("workflow not found: {0}")]
    NotFound(String),
    #[error("filesystem error: {0}")]
    Io(String),
}

pub type DbResult<T> = Result<T, DbError>;

/// Stored workflow row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredWorkflow {
    pub id: String,
    pub name: String,
    pub definition: Workflow,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Pending,
    Running,
    Paused,
    Succeeded,
    Failed,
    Cancelled,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RunStatus::Pending => "pending",
            RunStatus::Running => "running",
            RunStatus::Paused => "paused",
            RunStatus::Succeeded => "succeeded",
            RunStatus::Failed => "failed",
            RunStatus::Cancelled => "cancelled",
        }
    }

    pub fn parse_status(s: &str) -> Self {
        match s {
            "running" => RunStatus::Running,
            "paused" => RunStatus::Paused,
            "succeeded" => RunStatus::Succeeded,
            "failed" => RunStatus::Failed,
            "cancelled" => RunStatus::Cancelled,
            _ => RunStatus::Pending,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRun {
    pub id: String,
    pub workflow_id: String,
    pub status: RunStatus,
    pub started_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<DateTime<Utc>>,
    /// Workflow input values used for this run (merged over defaults).
    #[serde(default)]
    pub inputs: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredNodeResult {
    pub id: i64,
    pub run_id: String,
    pub node_id: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub stderr: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub started_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<DateTime<Utc>>,
    /// 1-based attempt number (retries record multiple rows).
    #[serde(default = "one_u32")]
    pub attempt: u32,
    #[serde(default)]
    pub duration_ms: u64,
    /// Normalized envelope extras as JSON, e.g. `{"severity":"P0"}`.
    #[serde(default)]
    pub structured_json: String,
}

fn one_u32() -> u32 {
    1
}

/// Input for recording a node result (struct form keeps the call readable).
#[derive(Debug, Clone, Copy)]
pub struct NewNodeResult<'a> {
    pub run_id: &'a str,
    pub node_id: &'a str,
    pub status: &'a str,
    pub exit_code: Option<i32>,
    pub stdout: &'a str,
    pub stderr: &'a str,
    pub error: Option<&'a str>,
    pub attempt: u32,
    pub duration_ms: u64,
    pub structured_json: &'a str,
}

impl<'a> NewNodeResult<'a> {
    /// Simple result without attempt/structured metadata (attempt 1).
    pub fn simple(
        run_id: &'a str,
        node_id: &'a str,
        status: &'a str,
        exit_code: Option<i32>,
        error: Option<&'a str>,
    ) -> Self {
        Self {
            run_id,
            node_id,
            status,
            exit_code,
            stdout: "",
            stderr: "",
            error,
            attempt: 1,
            duration_ms: 0,
            structured_json: "{}",
        }
    }
}

/// Thread-safe SQLite wrapper. Tauri commands share one instance.
pub struct SqliteDb {
    conn: Mutex<Connection>,
}

impl SqliteDb {
    pub fn open(path: &Path) -> DbResult<Self> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| DbError::Io(format!("{}: {e}", path.display())))?;
            }
        }
        let conn = Connection::open(path)?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    pub fn open_in_memory() -> DbResult<Self> {
        let conn = Connection::open_in_memory()?;
        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> DbResult<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS workflows (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               definition TEXT NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS runs (
               id TEXT PRIMARY KEY,
               workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
               status TEXT NOT NULL,
               started_at TEXT NOT NULL,
               finished_at TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_runs_workflow ON runs(workflow_id);
             CREATE TABLE IF NOT EXISTS node_results (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
               node_id TEXT NOT NULL,
               status TEXT NOT NULL,
               exit_code INTEGER,
               stdout TEXT NOT NULL DEFAULT '',
               stderr TEXT NOT NULL DEFAULT '',
               error TEXT,
               started_at TEXT NOT NULL,
               finished_at TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_node_results_run ON node_results(run_id);
             CREATE TABLE IF NOT EXISTS agent_profiles (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               definition TEXT NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS known_folders (
               path TEXT PRIMARY KEY,
               last_used TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS mcp_servers (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               definition TEXT NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS schedules (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               definition TEXT NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS watchers (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               definition TEXT NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS notifications (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               kind TEXT NOT NULL,
               title TEXT NOT NULL DEFAULT '',
               body TEXT NOT NULL DEFAULT '',
               run_id TEXT,
               created_at TEXT NOT NULL,
               read INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);
             CREATE TABLE IF NOT EXISTS settings (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS preferences (
               key TEXT PRIMARY KEY,
               scope TEXT NOT NULL DEFAULT '*',
               value TEXT NOT NULL,
               source TEXT NOT NULL DEFAULT 'accepted',
               enabled INTEGER NOT NULL DEFAULT 1,
               note TEXT NOT NULL DEFAULT '',
               updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS observation_counts (
               key TEXT PRIMARY KEY,
               count INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS generations (
               id TEXT PRIMARY KEY,
               goal TEXT NOT NULL,
               generator_profile TEXT NOT NULL DEFAULT '',
               proposal_json TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'proposed',
               created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS user_templates (
               id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               definition TEXT NOT NULL,
               created_at TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );",
        )?;
        // Milestone 3 columns (idempotent for existing databases).
        for (table, column, ddl) in [
            ("runs", "inputs", "TEXT NOT NULL DEFAULT '{}'"),
            ("runs", "workflow_definition", "TEXT"),
            ("node_results", "attempt", "INTEGER NOT NULL DEFAULT 1"),
            ("node_results", "duration_ms", "INTEGER NOT NULL DEFAULT 0"),
            (
                "node_results",
                "structured_json",
                "TEXT NOT NULL DEFAULT '{}'",
            ),
        ] {
            if !has_column(&conn, table, column)? {
                conn.execute(
                    &format!("ALTER TABLE {table} ADD COLUMN {column} {ddl}"),
                    [],
                )?;
            }
        }
        Ok(())
    }

    // -- Workflows ----------------------------------------------------------

    pub fn upsert_workflow(&self, workflow: &Workflow) -> DbResult<StoredWorkflow> {
        let now = Utc::now();
        let definition = serde_json::to_string(workflow)?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let existing_created: Option<String> = conn
            .query_row(
                "SELECT created_at FROM workflows WHERE id = ?1",
                params![workflow.id],
                |row| row.get(0),
            )
            .optional()?;
        let created_at = existing_created.unwrap_or_else(|| now.to_rfc3339());
        conn.execute(
            "INSERT INTO workflows (id, name, definition, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, definition = excluded.definition, updated_at = excluded.updated_at",
            params![
                workflow.id,
                workflow.name,
                definition,
                created_at,
                now.to_rfc3339()
            ],
        )?;
        drop(conn);
        self.get_workflow(&workflow.id)?
            .ok_or(DbError::NotFound(workflow.id.clone()))
    }

    pub fn get_workflow(&self, id: &str) -> DbResult<Option<StoredWorkflow>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let row: Option<(String, String, String, String, String)> = conn
            .query_row(
                "SELECT id, name, definition, created_at, updated_at FROM workflows WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        row.map(
            |(id, name, definition, created_at, updated_at)| -> DbResult<StoredWorkflow> {
                Ok(StoredWorkflow {
                    id,
                    name,
                    definition: Workflow::from_json(&definition)?,
                    created_at: created_at.parse().unwrap_or_else(|_| Utc::now()),
                    updated_at: updated_at.parse().unwrap_or_else(|_| Utc::now()),
                })
            },
        )
        .transpose()
    }

    pub fn list_workflows(&self) -> DbResult<Vec<StoredWorkflow>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, name, definition, created_at, updated_at FROM workflows ORDER BY updated_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, name, definition, created_at, updated_at) = row?;
            // Corrupt definitions must not take down the whole list: skip
            // the row loudly (stderr) so the app stays usable and the damage
            // is visible in logs/diagnostics.
            let definition = match Workflow::from_json(&definition) {
                Ok(definition) => definition,
                Err(e) => {
                    eprintln!("[orchevia] skipping corrupt workflow '{id}': {e}");
                    continue;
                }
            };
            out.push(StoredWorkflow {
                id,
                name,
                definition,
                created_at: created_at.parse().unwrap_or_else(|_| Utc::now()),
                updated_at: updated_at.parse().unwrap_or_else(|_| Utc::now()),
            });
        }
        Ok(out)
    }

    pub fn delete_workflow(&self, id: &str) -> DbResult<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let active: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM runs WHERE workflow_id = ?1 AND status IN ('running', 'paused'))",
            params![id],
            |row| row.get(0),
        )?;
        if active {
            return Err(DbError::Io(format!(
                "Workflow '{id}' has running or paused runs; cancel them before deleting."
            )));
        }
        let changed = conn.execute("DELETE FROM workflows WHERE id = ?1", params![id])?;
        Ok(changed > 0)
    }

    // -- Runs ---------------------------------------------------------------

    pub fn create_run(
        &self,
        id: &str,
        workflow_id: &str,
        inputs: &std::collections::HashMap<String, String>,
    ) -> DbResult<StoredRun> {
        let workflow = self
            .get_workflow(workflow_id)?
            .ok_or_else(|| DbError::NotFound(workflow_id.to_string()))?;
        self.create_run_with_workflow(id, &workflow.definition, inputs)
    }

    pub fn create_run_with_workflow(
        &self,
        id: &str,
        workflow: &Workflow,
        inputs: &std::collections::HashMap<String, String>,
    ) -> DbResult<StoredRun> {
        let workflow_id = &workflow.id;
        let now = Utc::now();
        let inputs_json = serde_json::to_string(inputs)?;
        let definition = serde_json::to_string(workflow)?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        conn.execute(
            "INSERT INTO runs (id, workflow_id, status, started_at, inputs, workflow_definition) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                workflow_id,
                RunStatus::Running.as_str(),
                now.to_rfc3339(),
                inputs_json,
                definition
            ],
        )?;
        Ok(StoredRun {
            id: id.to_string(),
            workflow_id: workflow_id.to_string(),
            status: RunStatus::Running,
            started_at: now,
            finished_at: None,
            inputs: inputs.clone(),
        })
    }

    /// New runs use their immutable snapshot. Pre-snapshot runs fall back to
    /// the saved workflow because their original definition is unavailable.
    pub fn get_run_workflow(&self, id: &str) -> DbResult<Option<Workflow>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let definition: Option<String> = conn.query_row(
            "SELECT COALESCE(r.workflow_definition, w.definition) FROM runs r JOIN workflows w ON w.id = r.workflow_id WHERE r.id = ?1",
            params![id],
            |row| row.get(0),
        ).optional()?;
        definition
            .map(|json| Workflow::from_json(&json).map_err(DbError::from))
            .transpose()
    }

    pub fn finish_run(&self, id: &str, status: RunStatus) -> DbResult<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        conn.execute(
            "UPDATE runs SET status = ?1, finished_at = ?2 WHERE id = ?3",
            params![status.as_str(), Utc::now().to_rfc3339(), id],
        )?;
        Ok(())
    }

    /// Claim a paused run and record its decision in one transaction. A second
    /// request cannot resume the same gate or alter a terminal run.
    pub fn decide_paused_run(
        &self,
        id: &str,
        approved: bool,
        note: &str,
        expected_approval_id: Option<i64>,
    ) -> DbResult<bool> {
        let now = Utc::now().to_rfc3339();
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let tx = conn.transaction()?;
        let changed = tx.execute(
            "UPDATE runs SET status = ?1, finished_at = ?2 WHERE id = ?3 AND status = 'paused'",
            params![
                if approved { "running" } else { "failed" },
                if approved { None } else { Some(&now) },
                id
            ],
        )?;
        if changed == 0 {
            return Ok(false);
        }
        let paused: Option<(i64, String)> = tx.query_row(
            "SELECT id, node_id FROM node_results WHERE run_id = ?1 AND status = 'paused' ORDER BY id DESC LIMIT 1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        let Some((approval_id, node_id)) = paused else {
            return Ok(false);
        };
        if expected_approval_id.is_some_and(|expected| expected != approval_id) {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO node_results (run_id, node_id, status, exit_code, stdout, stderr, error, started_at, finished_at, attempt, duration_ms, structured_json)
             VALUES (?1, ?2, ?3, ?4, ?5, '', ?6, ?7, ?7, 1, 0, '{}')",
            params![id, node_id, if approved { "approved" } else { "rejected" }, if approved { Some(0) } else { None }, note, if approved { None } else { Some("Rejected by user.") }, now],
        )?;
        tx.commit()?;
        Ok(true)
    }

    pub fn cancel_paused_run(&self, id: &str) -> DbResult<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        Ok(conn.execute(
            "UPDATE runs SET status = 'cancelled', finished_at = ?1 WHERE id = ?2 AND status = 'paused'",
            params![Utc::now().to_rfc3339(), id],
        )? > 0)
    }

    pub fn list_runs(&self, limit: i64) -> DbResult<Vec<StoredRun>> {
        self.list_run_rows(limit, false, None)
    }

    pub fn list_active_runs(&self) -> DbResult<Vec<StoredRun>> {
        self.list_run_rows(i64::MAX, true, None)
    }

    pub fn list_workflow_runs(&self, workflow_id: &str, limit: i64) -> DbResult<Vec<StoredRun>> {
        self.list_run_rows(limit, false, Some(workflow_id))
    }

    fn list_run_rows(
        &self,
        limit: i64,
        active_only: bool,
        workflow_id: Option<&str>,
    ) -> DbResult<Vec<StoredRun>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, workflow_id, status, started_at, finished_at, inputs FROM runs WHERE (?2 = 0 OR status IN ('pending', 'running', 'paused')) AND (?3 IS NULL OR workflow_id = ?3) ORDER BY started_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit, active_only, workflow_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, workflow_id, status, started_at, finished_at, inputs) = row?;
            out.push(StoredRun {
                id,
                workflow_id,
                status: RunStatus::parse_status(&status),
                started_at: started_at.parse().unwrap_or_else(|_| Utc::now()),
                finished_at: finished_at.and_then(|s: String| s.parse().ok()),
                inputs: inputs
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
            });
        }
        Ok(out)
    }

    pub fn get_run(&self, id: &str) -> DbResult<Option<StoredRun>> {
        // Tuple is wide; alias keeps the row mapping readable.
        type RunRow = (
            String,
            String,
            String,
            String,
            Option<String>,
            Option<String>,
        );
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let row: Option<RunRow> = conn
            .query_row(
                "SELECT id, workflow_id, status, started_at, finished_at, inputs FROM runs WHERE id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?;
        Ok(row.map(
            |(id, workflow_id, status, started_at, finished_at, inputs)| StoredRun {
                id,
                workflow_id,
                status: RunStatus::parse_status(&status),
                started_at: started_at.parse().unwrap_or_else(|_| Utc::now()),
                finished_at: finished_at.and_then(|s: String| s.parse().ok()),
                inputs: inputs
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default(),
            },
        ))
    }

    /// Delete one finished run and its node results. Running/paused runs are
    /// refused — cancel first, so the engine never writes into a deleted run.
    pub fn delete_run(&self, id: &str) -> DbResult<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let status: Option<String> = conn
            .query_row(
                "SELECT status FROM runs WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let status = match status {
            None => return Ok(false),
            Some(s) => s,
        };
        if status == RunStatus::Running.as_str() || status == RunStatus::Paused.as_str() {
            return Err(DbError::Io(format!(
                "Run '{id}' is still {status}; cancel it before deleting."
            )));
        }
        conn.execute("DELETE FROM node_results WHERE run_id = ?1", params![id])?;
        let changed = conn.execute("DELETE FROM runs WHERE id = ?1", params![id])?;
        Ok(changed > 0)
    }

    /// Delete all finished runs and their results. Running/paused runs are
    /// kept; returns (removed, kept).
    pub fn clear_finished_runs(&self) -> DbResult<(usize, usize)> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        conn.execute(
            "DELETE FROM node_results WHERE run_id IN (SELECT id FROM runs WHERE status NOT IN ('running', 'paused'))",
            [],
        )?;
        let removed = conn.execute(
            "DELETE FROM runs WHERE status NOT IN ('running', 'paused')",
            [],
        )?;
        let kept: i64 = conn.query_row("SELECT COUNT(*) FROM runs", [], |row| row.get(0))?;
        Ok((removed, kept as usize))
    }

    /// Create a visible row before a Command or Agent process finishes.
    pub fn start_node_result(&self, run_id: &str, node_id: &str, attempt: u32) -> DbResult<i64> {
        let now = Utc::now().to_rfc3339();
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        conn.execute(
            "INSERT INTO node_results (run_id, node_id, status, started_at, attempt, structured_json) \
             VALUES (?1, ?2, 'running', ?3, ?4, '{}')",
            params![run_id, node_id, now, attempt],
        )?;
        Ok(conn.last_insert_rowid())
    }

    /// Replace a running row's captured streams; later snapshots include both
    /// streams so the UI sees a coherent prefix on every poll.
    pub fn update_node_output(&self, id: i64, stdout: &str, stderr: &str) -> DbResult<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let changed = conn.execute(
            "UPDATE node_results SET stdout = ?1, stderr = ?2 WHERE id = ?3 AND status = 'running'",
            params![stdout, stderr, id],
        )?;
        if changed == 0 {
            return Err(DbError::NotFound(format!("running node result {id}")));
        }
        Ok(())
    }

    /// Close process rows that were still running when the desktop app exited.
    pub fn fail_running_node_results(&self, run_id: &str, reason: &str) -> DbResult<usize> {
        let now = Utc::now().to_rfc3339();
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        Ok(conn.execute(
            "UPDATE node_results SET status = 'failed', error = ?1, finished_at = ?2 \
             WHERE run_id = ?3 AND status = 'running'",
            params![reason, now, run_id],
        )?)
    }

    /// Finalize the same row so the live step does not duplicate on completion.
    pub fn finish_node_result(&self, id: i64, input: NewNodeResult<'_>) -> DbResult<()> {
        let now = Utc::now().to_rfc3339();
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let changed = conn.execute(
            "UPDATE node_results SET status = ?1, exit_code = ?2, stdout = ?3, stderr = ?4, \
             error = ?5, finished_at = ?6, duration_ms = ?7, structured_json = ?8 \
             WHERE id = ?9 AND run_id = ?10 AND node_id = ?11 AND attempt = ?12 AND status = 'running'",
            params![
                input.status, input.exit_code, input.stdout, input.stderr, input.error,
                now, input.duration_ms as i64, input.structured_json, id,
                input.run_id, input.node_id, input.attempt,
            ],
        )?;
        if changed == 0 {
            return Err(DbError::NotFound(format!("running node result {id}")));
        }
        Ok(())
    }

    pub fn record_node_result(&self, input: NewNodeResult<'_>) -> DbResult<()> {
        let now = Utc::now().to_rfc3339();
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        conn.execute(
            "INSERT INTO node_results (run_id, node_id, status, exit_code, stdout, stderr, error, started_at, finished_at, attempt, duration_ms, structured_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                input.run_id,
                input.node_id,
                input.status,
                input.exit_code,
                input.stdout,
                input.stderr,
                input.error,
                now,
                now,
                input.attempt,
                input.duration_ms as i64,
                input.structured_json
            ],
        )?;
        Ok(())
    }

    pub fn list_node_results(&self, run_id: &str) -> DbResult<Vec<StoredNodeResult>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, run_id, node_id, status, exit_code, stdout, stderr, error, started_at, finished_at, attempt, duration_ms, structured_json
             FROM node_results WHERE run_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![run_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<i32>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<i64>>(10)?,
                row.get::<_, Option<i64>>(11)?,
                row.get::<_, Option<String>>(12)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (
                id,
                run_id,
                node_id,
                status,
                exit_code,
                stdout,
                stderr,
                error,
                started_at,
                finished_at,
                attempt,
                duration_ms,
                structured_json,
            ) = row?;
            out.push(StoredNodeResult {
                id,
                run_id,
                node_id,
                status,
                exit_code,
                stdout,
                stderr,
                error,
                started_at: started_at.parse().unwrap_or_else(|_| Utc::now()),
                finished_at: finished_at.and_then(|s: String| s.parse().ok()),
                attempt: attempt.unwrap_or(1).max(1) as u32,
                duration_ms: duration_ms.unwrap_or(0).max(0) as u64,
                structured_json: structured_json.unwrap_or_else(|| "{}".to_string()),
            });
        }
        Ok(out)
    }

    // -- Agent Profiles (Milestone 2) ----------------------------------------

    pub fn upsert_agent_profile(&self, profile: &AgentProfile) -> DbResult<()> {
        let errors = profile.validate();
        if !errors.is_empty() {
            return Err(DbError::Io(format!(
                "Invalid agent profile: {}",
                errors.join("; ")
            )));
        }
        let now = Utc::now();
        let definition = serde_json::to_string(profile)?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let existing_created: Option<String> = conn
            .query_row(
                "SELECT created_at FROM agent_profiles WHERE id = ?1",
                params![profile.id],
                |row| row.get(0),
            )
            .optional()?;
        let created_at = existing_created.unwrap_or_else(|| now.to_rfc3339());
        conn.execute(
            "INSERT INTO agent_profiles (id, name, definition, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, definition = excluded.definition, updated_at = excluded.updated_at",
            params![
                profile.id,
                profile.name,
                definition,
                created_at,
                now.to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn get_agent_profile(&self, id: &str) -> DbResult<Option<AgentProfile>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let row: Option<String> = conn
            .query_row(
                "SELECT definition FROM agent_profiles WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        row.map(|definition| {
            serde_json::from_str::<AgentProfile>(&definition).map_err(DbError::from)
        })
        .transpose()
    }

    pub fn list_agent_profiles(&self) -> DbResult<Vec<AgentProfile>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let mut stmt = conn.prepare("SELECT definition FROM agent_profiles ORDER BY name ASC")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            let definition = row?;
            match serde_json::from_str::<AgentProfile>(&definition) {
                Ok(profile) => out.push(profile),
                Err(e) => eprintln!("[orchevia] skipping corrupt agent_profiles row: {e}"),
            }
        }
        Ok(out)
    }

    pub fn delete_agent_profile(&self, id: &str) -> DbResult<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let changed = conn.execute("DELETE FROM agent_profiles WHERE id = ?1", params![id])?;
        Ok(changed > 0)
    }

    // -- MCP servers (Milestone 4) -------------------------------------------

    pub fn upsert_mcp_server(&self, server: &McpServerConfig) -> DbResult<()> {
        let errors = server.validate();
        if !errors.is_empty() {
            return Err(DbError::Io(format!(
                "Invalid MCP server: {}",
                errors.join("; ")
            )));
        }
        let now = Utc::now();
        let definition = serde_json::to_string(server)?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let existing_created: Option<String> = conn
            .query_row(
                "SELECT created_at FROM mcp_servers WHERE id = ?1",
                params![server.id],
                |row| row.get(0),
            )
            .optional()?;
        let created_at = existing_created.unwrap_or_else(|| now.to_rfc3339());
        conn.execute(
            "INSERT INTO mcp_servers (id, name, definition, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, definition = excluded.definition, updated_at = excluded.updated_at",
            params![
                server.id,
                server.name,
                definition,
                created_at,
                now.to_rfc3339()
            ],
        )?;
        Ok(())
    }

    pub fn get_mcp_server(&self, id: &str) -> DbResult<Option<McpServerConfig>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let row: Option<String> = conn
            .query_row(
                "SELECT definition FROM mcp_servers WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        row.map(|definition| {
            serde_json::from_str::<McpServerConfig>(&definition).map_err(DbError::from)
        })
        .transpose()
    }

    pub fn list_mcp_servers(&self) -> DbResult<Vec<McpServerConfig>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let mut stmt = conn.prepare("SELECT definition FROM mcp_servers ORDER BY name ASC")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            let definition = row?;
            match serde_json::from_str::<McpServerConfig>(&definition) {
                Ok(server) => out.push(server),
                Err(e) => eprintln!("[orchevia] skipping corrupt mcp_servers row: {e}"),
            }
        }
        Ok(out)
    }

    pub fn delete_mcp_server(&self, id: &str) -> DbResult<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let changed = conn.execute("DELETE FROM mcp_servers WHERE id = ?1", params![id])?;
        Ok(changed > 0)
    }

    /// Record a project folder as recently used (local-only, no secrets).
    pub fn touch_known_folder(&self, path: &str) -> DbResult<()> {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err(DbError::Io("Folder path must not be empty.".to_string()));
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        conn.execute(
            "INSERT INTO known_folders (path, last_used) VALUES (?1, ?2)
             ON CONFLICT(path) DO UPDATE SET last_used = excluded.last_used",
            params![trimmed, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn list_known_folders(&self, limit: i64) -> DbResult<Vec<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let mut stmt =
            conn.prepare("SELECT path FROM known_folders ORDER BY last_used DESC LIMIT ?1")?;
        let rows = stmt.query_map(params![limit.clamp(1, 100)], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
    }
}

/// Whether a SQLite table already has a column (for idempotent migrations).
fn has_column(conn: &rusqlite::Connection, table: &str, column: &str) -> DbResult<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(names.iter().any(|n| n == column))
}

impl SqliteDb {
    // -- Schedules + watchers (Milestone 5, disabled-by-default) --------------

    pub fn upsert_schedule(&self, schedule: &Schedule) -> DbResult<()> {
        let errors = schedule.validate();
        if !errors.is_empty() {
            return Err(DbError::Io(format!(
                "Invalid schedule: {}",
                errors.join("; ")
            )));
        }
        self.upsert_definition("schedules", &schedule.id, &schedule.name, schedule)
    }

    pub fn get_schedule(&self, id: &str) -> DbResult<Option<Schedule>> {
        self.get_definition("schedules", id)
    }

    pub fn list_schedules(&self) -> DbResult<Vec<Schedule>> {
        self.list_definitions("schedules")
    }

    pub fn delete_schedule(&self, id: &str) -> DbResult<bool> {
        self.delete_definition("schedules", id)
    }

    pub fn upsert_watcher(&self, watcher: &crate::schedule::Watcher) -> DbResult<()> {
        let errors = watcher.validate();
        if !errors.is_empty() {
            return Err(DbError::Io(format!(
                "Invalid watcher: {}",
                errors.join("; ")
            )));
        }
        self.upsert_definition("watchers", &watcher.id, &watcher.name, watcher)
    }

    pub fn record_schedule_check(
        &self,
        before: &crate::schedule::Schedule,
        after: &crate::schedule::Schedule,
    ) -> DbResult<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".into()))?;
        let changed = conn.execute(
            "UPDATE schedules SET definition = ?1, updated_at = ?2 WHERE id = ?3 AND definition = ?4",
            params![serde_json::to_string(after)?, Utc::now().to_rfc3339(), before.id, serde_json::to_string(before)?],
        )?;
        Ok(changed > 0)
    }

    /// Poll bookkeeping must not resurrect deleted watchers or overwrite a
    /// configuration changed while `gh` was running.
    pub fn record_watcher_check(
        &self,
        before: &crate::schedule::Watcher,
        after: &crate::schedule::Watcher,
    ) -> DbResult<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".into()))?;
        let changed = conn.execute(
            "UPDATE watchers SET definition = ?1, updated_at = ?2 WHERE id = ?3 AND definition = ?4",
            params![serde_json::to_string(after)?, Utc::now().to_rfc3339(), before.id, serde_json::to_string(before)?],
        )?;
        Ok(changed > 0)
    }

    pub fn get_watcher(&self, id: &str) -> DbResult<Option<crate::schedule::Watcher>> {
        self.get_definition("watchers", id)
    }

    pub fn list_watchers(&self) -> DbResult<Vec<crate::schedule::Watcher>> {
        self.list_definitions("watchers")
    }

    pub fn delete_watcher(&self, id: &str) -> DbResult<bool> {
        self.delete_definition("watchers", id)
    }

    fn upsert_definition<T: serde::Serialize>(
        &self,
        table: &str,
        id: &str,
        name: &str,
        value: &T,
    ) -> DbResult<()> {
        let allowed = ["schedules", "watchers"];
        if !allowed.contains(&table) {
            return Err(DbError::Io("Unknown definition table.".to_string()));
        }
        let now = Utc::now();
        let definition = serde_json::to_string(value)?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let existing_created: Option<String> = conn
            .query_row(
                &format!("SELECT created_at FROM {table} WHERE id = ?1"),
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let created_at = existing_created.unwrap_or_else(|| now.to_rfc3339());
        conn.execute(
            &format!(
                "INSERT INTO {table} (id, name, definition, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, definition = excluded.definition, updated_at = excluded.updated_at"
            ),
            params![id, name, definition, created_at, now.to_rfc3339()],
        )?;
        Ok(())
    }

    fn get_definition<T: serde::de::DeserializeOwned>(
        &self,
        table: &str,
        id: &str,
    ) -> DbResult<Option<T>> {
        let allowed = ["schedules", "watchers"];
        if !allowed.contains(&table) {
            return Err(DbError::Io("Unknown definition table.".to_string()));
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let row: Option<String> = conn
            .query_row(
                &format!("SELECT definition FROM {table} WHERE id = ?1"),
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        row.map(|definition| serde_json::from_str(&definition).map_err(DbError::from))
            .transpose()
    }

    fn list_definitions<T: serde::de::DeserializeOwned>(&self, table: &str) -> DbResult<Vec<T>> {
        let allowed = ["schedules", "watchers"];
        if !allowed.contains(&table) {
            return Err(DbError::Io("Unknown definition table.".to_string()));
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let mut stmt =
            conn.prepare(&format!("SELECT definition FROM {table} ORDER BY name ASC"))?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            let definition = row?;
            match serde_json::from_str::<T>(&definition) {
                Ok(value) => out.push(value),
                Err(e) => eprintln!("[orchevia] skipping corrupt {table} row: {e}"),
            }
        }
        Ok(out)
    }

    fn delete_definition(&self, table: &str, id: &str) -> DbResult<bool> {
        let allowed = ["schedules", "watchers"];
        if !allowed.contains(&table) {
            return Err(DbError::Io("Unknown definition table.".to_string()));
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let changed = conn.execute(&format!("DELETE FROM {table} WHERE id = ?1"), params![id])?;
        Ok(changed > 0)
    }

    // -- Notifications ---------------------------------------------------------

    pub fn push_notification(
        &self,
        kind: &str,
        title: &str,
        body: &str,
        run_id: Option<&str>,
    ) -> DbResult<i64> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        conn.execute(
            "INSERT INTO notifications (kind, title, body, run_id, created_at, read)
             VALUES (?1, ?2, ?3, ?4, ?5, 0)",
            params![
                kind,
                truncate_text(title, 200),
                truncate_text(body, 2000),
                run_id,
                Utc::now().to_rfc3339()
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn list_notifications(&self, limit: i64, unread_only: bool) -> DbResult<Vec<Notification>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let sql = if unread_only {
            "SELECT id, kind, title, body, run_id, created_at, read FROM notifications WHERE read = 0 ORDER BY id DESC LIMIT ?1"
        } else {
            "SELECT id, kind, title, body, run_id, created_at, read FROM notifications ORDER BY id DESC LIMIT ?1"
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![limit.clamp(1, 200)], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, kind, title, body, run_id, created_at, read) = row?;
            out.push(Notification {
                id,
                kind,
                title,
                body,
                run_id,
                created_at: created_at.parse().unwrap_or_else(|_| Utc::now()),
                read: read != 0,
            });
        }
        // Retention: keep the table bounded.
        let _ = conn.execute(
            "DELETE FROM notifications WHERE id NOT IN (SELECT id FROM notifications ORDER BY id DESC LIMIT 500)",
            [],
        );
        Ok(out)
    }

    pub fn mark_notification_read(&self, id: i64) -> DbResult<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        conn.execute(
            "UPDATE notifications SET read = 1 WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn mark_all_notifications_read(&self) -> DbResult<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        conn.execute("UPDATE notifications SET read = 1", [])?;
        Ok(())
    }

    // -- Settings ---------------------------------------------------------------

    pub fn get_setting(&self, key: &str) -> DbResult<Option<String>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(DbError::from)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> DbResult<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_notification_prefs(&self) -> DbResult<NotificationPrefs> {
        match self.get_setting("notifications.prefs")? {
            Some(raw) => serde_json::from_str(&raw).map_err(DbError::from),
            None => Ok(NotificationPrefs::default()),
        }
    }

    pub fn set_notification_prefs(&self, prefs: &NotificationPrefs) -> DbResult<()> {
        self.set_setting("notifications.prefs", &serde_json::to_string(prefs)?)
    }
}

fn truncate_text(text: &str, max: usize) -> String {
    if text.chars().count() > max {
        text.chars().take(max).collect()
    } else {
        text.to_string()
    }
}

impl SqliteDb {
    // -- Memory, generations, user templates (Milestone 6) ---------------------

    pub fn upsert_preference(&self, pref: &crate::memory::Preference) -> DbResult<()> {
        self.import_preferences(std::slice::from_ref(pref))
            .map(|_| ())
    }

    pub fn import_preferences(&self, preferences: &[crate::memory::Preference]) -> DbResult<usize> {
        if preferences.len() > 200 {
            return Err(DbError::Io("Too many preferences (max 200).".into()));
        }
        let mut keys = std::collections::HashSet::new();
        for pref in preferences {
            crate::memory::validate_preference(pref).map_err(DbError::Io)?;
            if !keys.insert(&pref.key) {
                return Err(DbError::Io("Duplicate preference key in import.".into()));
            }
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".into()))?;
        let transaction = conn.transaction()?;
        for pref in preferences {
            let prior: Option<String> = transaction
                .query_row(
                    "SELECT scope FROM preferences WHERE key = ?1",
                    params![pref.key],
                    |row| row.get(0),
                )
                .optional()?;
            if prior.as_ref().is_some_and(|scope| {
                scope != &pref.scope
                    && (scope.starts_with("repo:") || pref.scope.starts_with("repo:"))
            }) {
                return Err(DbError::Io(
                    "Project preference key collision; nothing imported.".into(),
                ));
            }
            transaction.execute(
                "INSERT INTO preferences (key, scope, value, source, enabled, note, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(key) DO UPDATE SET scope = excluded.scope, value = excluded.value, source = excluded.source, enabled = excluded.enabled, note = excluded.note, updated_at = excluded.updated_at",
                params![pref.key, pref.scope, serde_json::to_string(&pref.value)?, pref.source, i64::from(pref.enabled), pref.note, Utc::now().to_rfc3339()],
            )?;
        }
        transaction.commit()?;
        Ok(preferences.len())
    }

    pub fn list_preferences(&self) -> DbResult<Vec<crate::memory::Preference>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT key, scope, value, source, enabled, note FROM preferences ORDER BY key ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (key, scope, value, source, enabled, note) = row?;
            let value: serde_json::Value = serde_json::from_str(&value).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?;
            out.push(crate::memory::Preference {
                key,
                scope,
                value,
                source,
                enabled: enabled != 0,
                note,
            });
        }
        Ok(out)
    }

    pub fn delete_preference(&self, key: &str) -> DbResult<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let changed = conn.execute("DELETE FROM preferences WHERE key = ?1", params![key])?;
        Ok(changed > 0)
    }

    pub fn reset_memory(&self) -> DbResult<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        conn.execute("DELETE FROM preferences", [])?;
        conn.execute("DELETE FROM observation_counts", [])?;
        Ok(())
    }

    pub fn observation_count(&self, counter_key: &str) -> DbResult<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let count: Option<i64> = conn
            .query_row(
                "SELECT count FROM observation_counts WHERE key = ?1",
                params![counter_key],
                |row| row.get(0),
            )
            .optional()?;
        Ok(count.unwrap_or(0).max(0) as u32)
    }

    pub fn bump_observation(&self, counter_key: &str) -> DbResult<u32> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        conn.execute(
            "INSERT INTO observation_counts (key, count) VALUES (?1, 1)
             ON CONFLICT(key) DO UPDATE SET count = count + 1",
            params![counter_key],
        )?;
        let count: i64 = conn.query_row(
            "SELECT count FROM observation_counts WHERE key = ?1",
            params![counter_key],
            |row| row.get(0),
        )?;
        Ok(count.max(0) as u32)
    }

    pub fn record_generation(
        &self,
        id: &str,
        goal: &str,
        generator_profile: &str,
        proposal_json: &str,
        status: &str,
    ) -> DbResult<()> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        conn.execute(
            "INSERT INTO generations (id, goal, generator_profile, proposal_json, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, goal, generator_profile, proposal_json, status, Utc::now().to_rfc3339()],
        )?;
        // Retention: keep history bounded (configurable via settings).
        let keep: i64 = self
            .get_setting_inner(&conn, "history.generations")
            .and_then(|v| v.parse().ok())
            .unwrap_or(100)
            .clamp(10, 1000);
        conn.execute(
            "DELETE FROM generations WHERE id NOT IN (SELECT id FROM generations ORDER BY created_at DESC LIMIT ?1)",
            params![keep],
        )?;
        Ok(())
    }

    pub fn list_generations(&self, limit: i64) -> DbResult<Vec<StoredGeneration>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, goal, generator_profile, proposal_json, status, created_at
             FROM generations ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit.clamp(1, 200)], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, goal, generator_profile, proposal_json, status, created_at) = row?;
            out.push(StoredGeneration {
                id,
                goal,
                generator_profile,
                proposal_json,
                status,
                created_at: created_at.parse().unwrap_or_else(|_| Utc::now()),
            });
        }
        Ok(out)
    }

    pub fn upsert_user_template(&self, template: &crate::templates::Template) -> DbResult<()> {
        let errors = template.validate();
        if !errors.is_empty() {
            return Err(DbError::Io(format!(
                "Invalid template: {}",
                errors.join("; ")
            )));
        }
        let now = Utc::now();
        let definition = serde_json::to_string(template)?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let existing_created: Option<String> = conn
            .query_row(
                "SELECT created_at FROM user_templates WHERE id = ?1",
                params![template.id],
                |row| row.get(0),
            )
            .optional()?;
        let created_at = existing_created.unwrap_or_else(|| now.to_rfc3339());
        conn.execute(
            "INSERT INTO user_templates (id, name, definition, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, definition = excluded.definition, updated_at = excluded.updated_at",
            params![template.id, template.name, definition, created_at, now.to_rfc3339()],
        )?;
        Ok(())
    }

    pub fn list_user_templates(&self) -> DbResult<Vec<crate::templates::Template>> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let mut stmt = conn.prepare("SELECT definition FROM user_templates ORDER BY name ASC")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            let definition = row?;
            match serde_json::from_str::<crate::templates::Template>(&definition) {
                Ok(template) => out.push(template),
                Err(e) => eprintln!("[orchevia] skipping corrupt user_templates row: {e}"),
            }
        }
        Ok(out)
    }

    pub fn delete_user_template(&self, id: &str) -> DbResult<bool> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::Io("Database lock is poisoned.".to_string()))?;
        let changed = conn.execute("DELETE FROM user_templates WHERE id = ?1", params![id])?;
        Ok(changed > 0)
    }

    fn get_setting_inner(&self, conn: &rusqlite::Connection, key: &str) -> Option<String> {
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
    }
}

/// A recorded workflow-generation proposal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredGeneration {
    pub id: String,
    pub goal: String,
    pub generator_profile: String,
    pub proposal_json: String,
    /// proposed | accepted | discarded | failed
    pub status: String,
    pub created_at: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::{Edge, Node, NodeConfig, NodeKind, Position, CURRENT_SCHEMA_VERSION};

    fn sample_workflow(id: &str) -> Workflow {
        Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: id.to_string(),
            name: format!("Workflow {id}"),
            inputs: Vec::new(),
            defaults: None,
            nodes: vec![Node {
                id: "start".into(),
                kind: NodeKind::Start,
                position: Position::default(),
                config: NodeConfig::default(),
                label: None,
            }],
            edges: vec![Edge {
                id: "e1".into(),
                source: "start".into(),
                target: "start".into(),
                label: None,
            }],
        }
    }

    #[test]
    fn preference_import_is_atomic_and_project_collisions_are_refused() {
        let db = SqliteDb::open_in_memory().unwrap();
        let p = crate::memory::Preference {
            key: "example".into(),
            scope: "*".into(),
            value: serde_json::json!("safe"),
            source: "manual".into(),
            enabled: true,
            note: String::new(),
        };
        let bad = crate::memory::Preference {
            key: "second".into(),
            value: serde_json::json!("bearer value"),
            ..p.clone()
        };
        assert!(db.import_preferences(&[p.clone(), bad]).is_err());
        assert!(db.list_preferences().unwrap().is_empty());
        db.import_preferences(&[p]).unwrap();
        let scope = "repo:/project-a";
        let a = crate::memory::Preference {
            key: crate::memory::project_key(scope, "testCommand").unwrap(),
            scope: scope.into(),
            value: serde_json::json!("make test"),
            source: "manual".into(),
            enabled: true,
            note: String::new(),
        };
        db.upsert_preference(&a).unwrap();
        let b = crate::memory::Preference {
            scope: "repo:/project-b".into(),
            ..a.clone()
        };
        assert!(db.upsert_preference(&b).is_err());
        assert_eq!(db.list_preferences().unwrap().len(), 2);
    }

    #[test]
    fn direct_run_lookup_retains_snapshot_beyond_recent_list() {
        let db = SqliteDb::open_in_memory().unwrap();
        let wf = sample_workflow("snapshots");
        db.upsert_workflow(&wf).unwrap();
        db.create_run_with_workflow("original-run", &wf, &std::collections::HashMap::new())
            .unwrap();
        for i in 0..105 {
            db.create_run_with_workflow(
                &format!("recent-{i}"),
                &wf,
                &std::collections::HashMap::new(),
            )
            .unwrap();
        }
        let mut edited = wf.clone();
        edited.name = "Edited later".into();
        db.upsert_workflow(&edited).unwrap();
        assert_eq!(db.list_runs(100).unwrap().len(), 100);
        assert!(db.get_run("original-run").unwrap().is_some());
        assert_eq!(db.get_run_workflow("original-run").unwrap(), Some(wf));
        assert!(db.get_run("missing").unwrap().is_none());
    }

    #[test]
    fn workflow_crud_round_trip() {
        let db = SqliteDb::open_in_memory().expect("open");
        let wf = sample_workflow("wf-1");
        let stored = db.upsert_workflow(&wf).expect("upsert");
        assert_eq!(stored.id, "wf-1");
        let fetched = db.get_workflow("wf-1").expect("get").expect("exists");
        assert_eq!(fetched.definition, wf);
        let list = db.list_workflows().expect("list");
        assert_eq!(list.len(), 1);
        assert!(db.delete_workflow("wf-1").expect("delete"));
        assert!(db.get_workflow("wf-1").expect("get").is_none());
    }

    #[test]
    fn poisoned_database_lock_returns_an_error_instead_of_panicking() {
        let db = SqliteDb::open_in_memory().expect("open");
        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = db.conn.lock().expect("initial lock");
            panic!("simulate poisoned lock");
        }));
        assert!(poisoned.is_err());
        assert!(
            matches!(db.list_workflows(), Err(DbError::Io(message)) if message == "Database lock is poisoned.")
        );
    }

    #[test]
    fn workflow_deletion_refuses_running_and_paused_runs() {
        for status in [RunStatus::Running, RunStatus::Paused] {
            let db = SqliteDb::open_in_memory().expect("open");
            db.upsert_workflow(&sample_workflow("wf-active"))
                .expect("workflow");
            db.create_run("run-active", "wf-active", &std::collections::HashMap::new())
                .expect("run");
            db.finish_run("run-active", status).expect("status");
            assert!(db.delete_workflow("wf-active").is_err());
            assert!(db.get_run("run-active").expect("run").is_some());
            db.finish_run("run-active", RunStatus::Cancelled)
                .expect("cancel");
            assert!(db.delete_workflow("wf-active").expect("delete"));
            assert!(db.get_run("run-active").expect("cascade").is_none());
        }
    }

    #[test]
    fn pre_snapshot_database_migrates_and_resumes_with_saved_definition() {
        let directory = tempfile::tempdir().expect("directory");
        let path = directory.path().join("legacy.sqlite");
        let mut workflow = sample_workflow("wf-legacy");
        {
            let db = SqliteDb::open(&path).expect("open");
            db.upsert_workflow(&workflow).expect("workflow");
            db.create_run(
                "run-legacy",
                &workflow.id,
                &std::collections::HashMap::new(),
            )
            .expect("run");
            db.conn
                .lock()
                .expect("connection")
                .execute("ALTER TABLE runs DROP COLUMN workflow_definition", [])
                .expect("legacy schema");
            workflow.name = "Saved later".into();
            db.upsert_workflow(&workflow).expect("edit");
        }
        let db = SqliteDb::open(&path).expect("migrate old database");
        assert_eq!(
            db.get_run_workflow("run-legacy")
                .expect("definition")
                .expect("run"),
            workflow
        );
        assert!(db
            .get_run_workflow("missing-run")
            .expect("missing")
            .is_none());
    }

    #[test]
    fn run_history_records_node_results() {
        let db = SqliteDb::open_in_memory().expect("open");
        db.upsert_workflow(&sample_workflow("wf-1"))
            .expect("upsert");
        db.create_run("run-1", "wf-1", &std::collections::HashMap::new())
            .expect("create run");
        db.record_node_result(NewNodeResult {
            run_id: "run-1",
            node_id: "start",
            status: "succeeded",
            exit_code: Some(0),
            stdout: "out",
            stderr: "err",
            error: None,
            attempt: 1,
            duration_ms: 5,
            structured_json: "{}",
        })
        .expect("record");
        db.finish_run("run-1", RunStatus::Succeeded)
            .expect("finish");
        let runs = db.list_runs(10).expect("list runs");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, RunStatus::Succeeded);
        assert!(runs[0].finished_at.is_some());
        let results = db.list_node_results("run-1").expect("results");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].stdout, "out");
    }

    #[test]
    fn restart_closes_live_node_rows_without_losing_output() {
        let db = SqliteDb::open_in_memory().expect("open");
        db.upsert_workflow(&sample_workflow("wf-1"))
            .expect("upsert");
        db.create_run("run-1", "wf-1", &std::collections::HashMap::new())
            .expect("create run");
        let id = db.start_node_result("run-1", "cmd", 1).expect("start node");
        db.update_node_output(id, "partial", "warning")
            .expect("output");
        db.fail_running_node_results("run-1", "Application restarted.")
            .expect("close running nodes");
        let rows = db.list_node_results("run-1").expect("results");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "failed");
        assert_eq!(rows[0].stdout, "partial");
        assert_eq!(rows[0].stderr, "warning");
        assert!(rows[0].finished_at.is_some());
    }

    #[test]
    fn run_deletion_refuses_active_and_clears_finished() {
        let db = SqliteDb::open_in_memory().expect("open");
        db.upsert_workflow(&sample_workflow("wf-1"))
            .expect("upsert");
        for run_id in ["run-active", "run-done"] {
            db.create_run(run_id, "wf-1", &std::collections::HashMap::new())
                .expect("create run");
            db.record_node_result(NewNodeResult::simple(
                run_id,
                "start",
                "succeeded",
                None,
                None,
            ))
            .expect("record");
        }
        db.finish_run("run-done", RunStatus::Succeeded)
            .expect("finish");
        // Active runs are refused: cancel first.
        assert!(db.delete_run("run-active").is_err());
        assert!(!db.delete_run("run-missing").expect("unknown"));
        assert!(db.delete_run("run-done").expect("delete"));
        assert!(db.get_run("run-done").expect("get").is_none());
        assert!(db
            .list_node_results("run-done")
            .expect("results")
            .is_empty());
        // Clear removes finished, keeps the active one.
        db.finish_run("run-active", RunStatus::Failed)
            .expect("finish");
        db.create_run("run-2", "wf-1", &std::collections::HashMap::new())
            .expect("create run");
        let (removed, kept) = db.clear_finished_runs().expect("clear");
        assert_eq!(removed, 1);
        assert_eq!(kept, 1);
        assert_eq!(db.list_runs(10).expect("list").len(), 1);
    }

    #[test]
    fn agent_profile_crud_round_trip() {
        use crate::agents::{AdapterKind, AgentProfile, WorkingDirMode};
        let db = SqliteDb::open_in_memory().expect("open");
        let profile = AgentProfile {
            id: "prof-1".to_string(),
            name: "Claude — Implementation".to_string(),
            adapter: AdapterKind::Claude,
            executable: None,
            model: Some("opus".to_string()),
            effort: None,
            extra_args: vec![],
            skills: vec![],
            working_dir_mode: WorkingDirMode::Inherit,
            working_dir: None,
            default_timeout_secs: 600,
            role: Some("implementation".to_string()),
        };
        db.upsert_agent_profile(&profile).expect("upsert");
        let fetched = db
            .get_agent_profile("prof-1")
            .expect("get")
            .expect("exists");
        assert_eq!(fetched, profile);
        assert_eq!(db.list_agent_profiles().expect("list").len(), 1);
        assert!(db.delete_agent_profile("prof-1").expect("delete"));
        assert!(db.get_agent_profile("prof-1").expect("get").is_none());
    }

    #[test]
    fn invalid_profile_rejected_on_upsert() {
        use crate::agents::{AdapterKind, AgentProfile, WorkingDirMode};
        let db = SqliteDb::open_in_memory().expect("open");
        let profile = AgentProfile {
            id: "bad".to_string(),
            name: "   ".to_string(),
            adapter: AdapterKind::Codex,
            executable: None,
            model: None,
            effort: None,
            extra_args: vec![],
            skills: vec![],
            working_dir_mode: WorkingDirMode::Inherit,
            working_dir: None,
            default_timeout_secs: 0,
            role: None,
        };
        assert!(db.upsert_agent_profile(&profile).is_err());
    }

    #[test]
    fn file_backed_db_persists_across_reopen() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("orchevia.db");
        {
            let db = SqliteDb::open(&path).expect("open");
            db.upsert_workflow(&sample_workflow("wf-9"))
                .expect("upsert");
        }
        let db2 = SqliteDb::open(&path).expect("reopen");
        assert!(db2.get_workflow("wf-9").expect("get").is_some());
    }
}

#[cfg(test)]
mod automation_tests {
    use super::*;
    use crate::schedule::{Schedule, ScheduleKind, Watcher, WatcherKind};

    fn schedule(id: &str) -> Schedule {
        Schedule {
            id: id.into(),
            name: format!("Sched {id}"),
            workflow_id: "wf-1".into(),
            kind: ScheduleKind::Interval { every_secs: 3600 },
            timezone: "utc".into(),
            enabled: false,
            trusted: false,
            missed_policy: crate::schedule::MissedPolicy::Skip,
            last_run_at: None,
            next_run_at: None,
            last_status: None,
        }
    }

    #[test]
    fn schedule_crud_round_trip() {
        let db = SqliteDb::open_in_memory().expect("open");
        db.upsert_schedule(&schedule("s1")).expect("upsert");
        assert_eq!(db.list_schedules().expect("list").len(), 1);
        assert!(db.get_schedule("s1").expect("get").is_some());
        assert!(db.delete_schedule("s1").expect("delete"));
        assert!(db.get_schedule("s1").expect("get").is_none());
    }

    #[test]
    fn invalid_schedule_rejected() {
        let db = SqliteDb::open_in_memory().expect("open");
        let mut bad = schedule("bad");
        bad.kind = ScheduleKind::Interval { every_secs: 5 };
        assert!(db.upsert_schedule(&bad).is_err());
    }

    #[test]
    fn watcher_crud_and_interval_floor() {
        let db = SqliteDb::open_in_memory().expect("open");
        let watcher = Watcher {
            id: "w1".into(),
            name: "Reviews".into(),
            workflow_id: "wf-1".into(),
            kind: WatcherKind::ReviewRequested,
            repo_dir: "/tmp".into(),
            pr_number: None,
            enabled: false,
            check_interval_secs: 900,
            last_head_sha: None,
            last_checked_at: None,
            last_result: None,
        };
        db.upsert_watcher(&watcher).expect("upsert");
        assert_eq!(db.list_watchers().expect("list").len(), 1);
        let mut too_fast = watcher.clone();
        too_fast.id = "w2".into();
        too_fast.check_interval_secs = 60;
        assert!(db.upsert_watcher(&too_fast).is_err());
    }

    #[test]
    fn notifications_push_list_and_read() {
        let db = SqliteDb::open_in_memory().expect("open");
        db.push_notification("approval", "T", "B", Some("run-1"))
            .expect("push");
        db.push_notification("info", "T2", "B2", None)
            .expect("push");
        assert_eq!(db.list_notifications(10, false).expect("list").len(), 2);
        assert_eq!(db.list_notifications(10, true).expect("unread").len(), 2);
        db.mark_all_notifications_read().expect("read");
        assert!(db.list_notifications(10, true).expect("unread").is_empty());
    }

    #[test]
    fn settings_and_prefs_round_trip() {
        let db = SqliteDb::open_in_memory().expect("open");
        assert!(db.get_setting("x").expect("get").is_none());
        db.set_setting("x", "1").expect("set");
        assert_eq!(db.get_setting("x").expect("get").as_deref(), Some("1"));
        let prefs = db.get_notification_prefs().expect("prefs");
        assert!(prefs.on_approval);
        let mut custom = prefs;
        custom.on_scheduled_success = true;
        db.set_notification_prefs(&custom).expect("save");
        assert!(
            db.get_notification_prefs()
                .expect("prefs")
                .on_scheduled_success
        );
    }
}

#[cfg(test)]
mod corruption_tests {
    use super::*;

    #[test]
    fn corrupt_workflow_row_does_not_break_listing() {
        let db = SqliteDb::open_in_memory().expect("open");
        let conn = db.conn.lock().expect("lock");
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO workflows (id, name, definition, created_at, updated_at) VALUES ('good', 'G', '{\"schemaVersion\":5,\"id\":\"good\",\"name\":\"G\",\"nodes\":[],\"edges\":[]}', ?1, ?1)",
            params![now],
        )
        .expect("insert good");
        conn.execute(
            "INSERT INTO workflows (id, name, definition, created_at, updated_at) VALUES ('bad', 'B', 'not-json{{{', ?1, ?1)",
            params![now],
        )
        .expect("insert bad");
        drop(conn);
        let list = db.list_workflows().expect("list tolerates corruption");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "good");
    }
}
