//! Constrained MCP integration (Milestone 4).
//!
//! Users register local MCP servers (command + args, no secrets stored — the
//! child inherits Orchevia's environment). Orchevia speaks minimal JSON-RPC
//! over stdio: `initialize` → `notifications/initialized` → `tools/list` →
//! `tools/call`, one request at a time. Timeouts and cancellation kill the
//! child; every invocation records server/tool provenance in run history.
//!
//! Imported workflows never auto-invoke MCP tools: execution is explicit, and
//! disabled/unknown servers fail closed.

use crate::process::{CommandSpec, ProcessGroup, TERMINATE_GRACE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "enabled_default")]
    pub enabled: bool,
}

fn enabled_default() -> bool {
    true
}

impl McpServerConfig {
    pub fn validate(&self) -> Vec<String> {
        let mut errors = Vec::new();
        if self.id.trim().is_empty() {
            errors.push("MCP server id must not be empty.".to_string());
        }
        if self.name.trim().is_empty() {
            errors.push("MCP server name must not be empty.".to_string());
        }
        if self.command.trim().is_empty() {
            errors.push("MCP server command must not be empty.".to_string());
        }
        for arg in &self.args {
            if arg.contains('\0') || arg.contains('\n') {
                errors.push(format!("MCP arg '{arg}' contains invalid characters."));
            }
        }
        errors
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallResult {
    pub server_id: String,
    pub server_name: String,
    pub tool: String,
    pub is_error: bool,
    pub text: String,
}

/// Check a server command resolves without spawning it.
pub fn server_command_available(config: &McpServerConfig) -> bool {
    crate::tools::find_executable(&config.command).is_some()
}

/// List tools (handshake + `tools/list`), bounded by `timeout`.
pub fn list_tools(
    config: &McpServerConfig,
    timeout: Duration,
    cancel: &Arc<AtomicBool>,
) -> Result<Vec<McpToolInfo>, String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("Cancelled.".to_string());
    }
    let SpawnedServer {
        mut child,
        group,
        pipes,
        stderr_log,
    } = spawn_server(config)?;
    let result = run_bounded(&mut child, &group, pipes, timeout, cancel, |pipes| {
        pipes.initialize()?;
        pipes.list_tools()
    });
    shutdown(child, group);
    match result {
        Err(e) => Err(format!("{} Server stderr: {}", e, stderr_tail_wait(&stderr_log))),
        Ok(tools) if tools.is_empty() => Err(format!(
            "Server '{}' listed no tools (it started, but tools/list came back empty). Server stderr: {}",
            config.name,
            stderr_tail_wait(&stderr_log)
        )),
        Ok(tools) => Ok(tools),
    }
}

/// Call one tool with JSON arguments, bounded by `timeout`.
pub fn call_tool(
    config: &McpServerConfig,
    tool: &str,
    arguments: &serde_json::Value,
    timeout: Duration,
    cancel: &Arc<AtomicBool>,
) -> Result<McpCallResult, String> {
    if tool.trim().is_empty() {
        return Err("MCP tool name must not be empty.".to_string());
    }
    if cancel.load(Ordering::SeqCst) {
        return Err("Cancelled.".to_string());
    }
    let SpawnedServer {
        mut child,
        group,
        pipes,
        stderr_log,
    } = spawn_server(config)?;
    let tool_owned = tool.to_string();
    let tool_name = tool_owned.clone();
    let args_owned = arguments.clone();
    let server_id = config.id.clone();
    let server_name = config.name.clone();
    let result = run_bounded(&mut child, &group, pipes, timeout, cancel, move |pipes| {
        pipes.initialize()?;
        pipes.call_tool(&tool_owned, &args_owned)
    });
    shutdown(child, group);
    let (is_error, text) =
        result.map_err(|e| format!("{} Server stderr: {}", e, stderr_tail_wait(&stderr_log)))?;
    Ok(McpCallResult {
        server_id,
        server_name,
        tool: tool_name,
        is_error,
        text,
    })
}

/// Spawn the server child (own process group on Unix), returning ownership of
/// the process, its group and pipes. The caller keeps the [`Child`] so
/// timeouts can stop it even while a worker thread blocks on stdio. Server
/// stderr is drained on a background thread into shared memory (capped tail)
/// so failures can quote the real cause — e.g. a missing env var — instead of
/// reporting a bare EOF.
fn spawn_server(config: &McpServerConfig) -> Result<SpawnedServer, String> {
    if !config.enabled {
        return Err(format!("MCP server '{}' is disabled.", config.name));
    }
    let exe = crate::tools::require_executable(&config.command)
        .map_err(|message| format!("Failed to spawn MCP server '{}': {message}", config.command))?;
    let mut cmd = Command::new(&exe);
    cmd.args(&config.args);
    cmd.env("PATH", crate::tools::child_path());
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::process::isolate_process_group(&mut cmd);
    let mut child = crate::process::spawn_retrying(|| cmd.spawn())
        .map_err(|e| format!("Failed to spawn MCP server '{}': {e}", config.command))?;
    let group = ProcessGroup::new(Some(child.id()));
    let stdin = child.stdin.take().ok_or("MCP server has no stdin.")?;
    let stdout = child.stdout.take().ok_or("MCP server has no stdout.")?;
    let stderr = child.stderr.take().ok_or("MCP server has no stderr.")?;
    let stderr_log: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    std::thread::spawn({
        let log = Arc::clone(&stderr_log);
        move || {
            use std::io::Read;
            let mut handle = stderr;
            let mut buf = Vec::new();
            // Best effort: the child may be killed mid-read; whatever we got
            // is still more useful than nothing.
            let _ = handle.read_to_end(&mut buf);
            let text = String::from_utf8_lossy(&buf).into_owned();
            // Keep the tail — tracebacks and config errors land at the end.
            // Char-boundary safe: walk back at most TAIL_CHARS chars.
            const TAIL_CHARS: usize = 2000;
            let tail: String = text
                .chars()
                .rev()
                .take(TAIL_CHARS)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            let tail = if tail.len() < text.len() {
                format!("…{tail}")
            } else {
                tail
            };
            if let Ok(mut guard) = log.lock() {
                *guard = tail;
            }
        }
    });
    Ok(SpawnedServer {
        child,
        group,
        pipes: McpPipes {
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        },
        stderr_log,
    })
}

struct SpawnedServer {
    child: Child,
    group: ProcessGroup,
    pipes: McpPipes,
    stderr_log: Arc<Mutex<String>>,
}

/// Read the drained stderr tail, waiting briefly for the drain thread: it may
/// still be flushing right after the child was killed. Never blocks long and
/// never returns values — presence of text only where the caller quotes it.
fn stderr_tail_wait(log: &Arc<Mutex<String>>) -> String {
    for _ in 0..12 {
        let current = log.lock().map(|g| g.trim().to_string()).unwrap_or_default();
        if !current.is_empty() {
            return current;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    "(no stderr output)".to_string()
}

/// Run `f` on a detached worker thread while the calling thread enforces
/// `timeout` and cooperative cancellation; the server's process group is
/// stopped on expiry/cancel. The worker is never joined: a descendant that
/// still holds the server's stdout cannot keep this call from returning.
fn run_bounded<T: Send + 'static>(
    child: &mut Child,
    group: &ProcessGroup,
    pipes: McpPipes,
    timeout: Duration,
    cancel: &Arc<AtomicBool>,
    f: impl FnOnce(&mut McpPipes) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("orchevia-mcp".into())
        .spawn(move || {
            let mut owned = pipes;
            let result = f(&mut owned);
            let _ = tx.send(result);
        })
        .map_err(|e| format!("MCP worker failed to start: {e}"))?;
    let deadline = Instant::now() + timeout;
    loop {
        match rx.recv_timeout(Duration::from_millis(25)) {
            Ok(result) => return result,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if cancel.load(Ordering::SeqCst) {
                    stop_server(child, group);
                    return Err("Cancelled.".to_string());
                }
                if Instant::now() >= deadline {
                    stop_server(child, group);
                    return Err(format!(
                        "MCP exchange exceeded {}s and was killed.",
                        timeout.as_secs()
                    ));
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err("MCP worker vanished.".to_string());
            }
        }
    }
}

/// `SIGTERM` the server's group, wait up to the grace period, then `SIGKILL`
/// whatever remains (e.g. the `node` process behind `npx`).
fn stop_server(child: &mut Child, group: &ProcessGroup) {
    group.terminate();
    #[cfg(not(unix))]
    let _ = child.kill();
    let deadline = Instant::now() + TERMINATE_GRACE;
    while Instant::now() < deadline && matches!(child.try_wait(), Ok(None)) {
        std::thread::sleep(Duration::from_millis(25));
    }
    group.kill();
    let _ = child.kill();
}

/// MCP servers run until told to stop; stop the whole tree after each exchange.
fn shutdown(mut child: Child, mut group: ProcessGroup) {
    stop_server(&mut child, &group);
    let _ = child.wait();
    group.release();
}

struct McpPipes {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
}

impl McpPipes {
    fn send(&mut self, value: &serde_json::Value) -> Result<(), String> {
        let mut line = serde_json::to_string(value).map_err(|e| e.to_string())?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("MCP write failed: {e}"))?;
        self.stdin
            .flush()
            .map_err(|e| format!("MCP flush failed: {e}"))?;
        Ok(())
    }

    fn recv(&mut self) -> Result<serde_json::Value, String> {
        let mut line = String::new();
        let n = self
            .stdout
            .read_line(&mut line)
            .map_err(|e| format!("MCP read failed: {e}"))?;
        if n == 0 {
            return Err("MCP server closed stdout.".to_string());
        }
        serde_json::from_str(line.trim()).map_err(|e| format!("MCP bad JSON: {e}"))
    }

    fn request(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))?;
        loop {
            let msg = self.recv()?;
            // Skip notifications / other ids; match our response id.
            if msg.get("id").and_then(|v| v.as_i64()) == Some(id) {
                if let Some(error) = msg.get("error") {
                    return Err(format!("MCP error: {error}"));
                }
                return msg
                    .get("result")
                    .cloned()
                    .ok_or_else(|| "MCP response has no result.".to_string());
            }
        }
    }

    fn initialize(&mut self) -> Result<(), String> {
        let _ = self.request(
            "initialize",
            serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "orchevia", "version": "0.1.0"},
            }),
        )?;
        self.send(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        }))?;
        Ok(())
    }

    fn list_tools(&mut self) -> Result<Vec<McpToolInfo>, String> {
        let result = self.request("tools/list", serde_json::json!({}))?;
        let tools = result
            .get("tools")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(tools
            .iter()
            .filter_map(|t| {
                Some(McpToolInfo {
                    name: t.get("name")?.as_str()?.to_string(),
                    description: t
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    input_schema: t.get("inputSchema").cloned(),
                })
            })
            .collect())
    }

    fn call_tool(
        &mut self,
        tool: &str,
        arguments: &serde_json::Value,
    ) -> Result<(bool, String), String> {
        let result = self.request(
            "tools/call",
            serde_json::json!({"name": tool, "arguments": arguments}),
        )?;
        let is_error = result
            .get("isError")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let text = result
            .get("content")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("text").and_then(|v| v.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        Ok((is_error, text.chars().take(100_000).collect()))
    }
}

/// One line of an MCP server check.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCheckItem {
    /// `found`, `started`, `listed` or `required`.
    pub id: &'static str,
    pub label: &'static str,
    /// `passed`, `warning`, `failed` or `skipped`.
    pub status: &'static str,
    pub detail: String,
    /// The next useful action when something is wrong.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

/// An explicit, bounded check of one MCP server: its program is found, it
/// starts and completes the MCP handshake, it lists its tools, and the tools
/// saved workflows use are among them. It never calls a tool.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCheckReport {
    pub server_id: String,
    pub server_name: String,
    /// The worst item: `failed` > `warning` > `passed` > `skipped`.
    pub status: &'static str,
    pub items: Vec<McpCheckItem>,
    pub tools: Vec<McpToolInfo>,
    pub duration_ms: u64,
}

/// The tools saved workflows call on `server_id`: MCP steps' tools, and the
/// issue lookup Ticket steps use.
pub fn required_tools(workflows: &[crate::workflow::Workflow], server_id: &str) -> Vec<String> {
    use crate::workflow::NodeKind;
    let mut tools: Vec<String> = Vec::new();
    for node in workflows.iter().flat_map(|w| &w.nodes) {
        if node.config.mcp_server_id.as_deref() != Some(server_id) {
            continue;
        }
        let tool = match node.kind {
            NodeKind::Mcp => node
                .config
                .mcp_tool
                .clone()
                .filter(|t| !t.trim().is_empty()),
            NodeKind::Ticket => Some(crate::ticket::DEFAULT_TICKET_TOOL.to_string()),
            _ => None,
        };
        if let Some(tool) = tool {
            if !tools.contains(&tool) {
                tools.push(tool);
            }
        }
    }
    tools.sort();
    tools
}

fn check_item(
    id: &'static str,
    label: &'static str,
    status: &'static str,
    detail: impl Into<String>,
    hint: Option<&str>,
) -> McpCheckItem {
    McpCheckItem {
        id,
        label,
        status,
        detail: detail.into(),
        hint: hint.map(str::to_string),
    }
}

const FOUND: &str = "Program found";
const STARTED: &str = "Starts and completes the MCP handshake";
const LISTED: &str = "Lists its tools";
const REQUIRED: &str = "Has the tools your workflows use";

/// Run the check. Bounded by `timeout`, stopped by `cancel`; the server's
/// whole process tree is stopped afterwards.
pub fn check_server(
    config: &McpServerConfig,
    required: &[String],
    timeout: Duration,
    cancel: &Arc<AtomicBool>,
) -> McpCheckReport {
    let started_at = Instant::now();
    let mut items: Vec<McpCheckItem> = Vec::new();
    let mut tools: Vec<McpToolInfo> = Vec::new();
    let skip_rest = |items: &mut Vec<McpCheckItem>, why: &str| {
        for (id, label) in [
            ("started", STARTED),
            ("listed", LISTED),
            ("required", REQUIRED),
        ] {
            if !items.iter().any(|i| i.id == id) {
                items.push(check_item(id, label, "skipped", why, None));
            }
        }
    };
    if !config.enabled {
        items.push(check_item(
            "found",
            FOUND,
            "failed",
            "This server is turned off.",
            Some("Turn it on in its settings to check it."),
        ));
        skip_rest(&mut items, "Not checked: the server is off.");
    } else if let Some(path) = crate::tools::find_executable(&config.command) {
        items.push(check_item(
            "found",
            FOUND,
            "passed",
            path.to_string_lossy(),
            None,
        ));
        match check_exchange(config, timeout, cancel) {
            Err((phase, message, stderr)) => {
                let tail = if stderr.is_empty() {
                    String::new()
                } else {
                    format!(
                        " Its error output: {}",
                        stderr.chars().take(600).collect::<String>()
                    )
                };
                if message == "Cancelled." {
                    skip_rest(&mut items, "Cancelled.");
                } else if phase == "list" {
                    items.push(check_item(
                        "started",
                        STARTED,
                        "passed",
                        "It answered the handshake.",
                        None,
                    ));
                    items.push(check_item(
                        "listed",
                        LISTED,
                        "failed",
                        format!("{message}{tail}"),
                        Some("The server may need environment variables (tokens, URLs) set before Orchevia starts, or a newer version."),
                    ));
                    skip_rest(&mut items, "Not checked: no tool list.");
                } else {
                    let hint = if message.contains("exceeded") {
                        "It started but did not answer in time. Check its arguments and environment variables; a first run through npx or uvx may need longer to download."
                    } else {
                        "Run the command in a terminal to see why it stops, or check that it is an MCP server that speaks over stdio."
                    };
                    items.push(check_item(
                        "started",
                        STARTED,
                        "failed",
                        format!("{message}{tail}"),
                        Some(hint),
                    ));
                    skip_rest(&mut items, "Not checked: the server did not start.");
                }
            }
            Ok(listed) => {
                tools = listed;
                items.push(check_item(
                    "started",
                    STARTED,
                    "passed",
                    "It answered the handshake.",
                    None,
                ));
                if tools.is_empty() {
                    items.push(check_item(
                        "listed",
                        LISTED,
                        "warning",
                        "It started but lists no tools.",
                        Some("Check that its environment variables are set; some servers only offer tools once signed in."),
                    ));
                } else {
                    let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).take(8).collect();
                    items.push(check_item(
                        "listed",
                        LISTED,
                        "passed",
                        format!(
                            "{} tool{}: {}{}",
                            tools.len(),
                            if tools.len() == 1 { "" } else { "s" },
                            names.join(", "),
                            if tools.len() > names.len() {
                                ", …"
                            } else {
                                ""
                            }
                        ),
                        None,
                    ));
                }
                let missing: Vec<&String> = required
                    .iter()
                    .filter(|name| !tools.iter().any(|t| &t.name == *name))
                    .collect();
                items.push(if required.is_empty() {
                    check_item("required", REQUIRED, "skipped", "No saved workflow uses a tool from this server.", None)
                } else if missing.is_empty() {
                    check_item(
                        "required",
                        REQUIRED,
                        "passed",
                        format!("All {} tool{} your workflows use: {}.", required.len(), if required.len() == 1 { "" } else { "s" }, required.join(", ")),
                        None,
                    )
                } else {
                    check_item(
                        "required",
                        REQUIRED,
                        "failed",
                        format!(
                            "Missing: {}.",
                            missing.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
                        ),
                        Some("Check the tool names in the steps that use this server, or update the server."),
                    )
                });
            }
        }
    } else {
        items.push(check_item(
            "found",
            FOUND,
            "failed",
            format!("'{}' was not found on PATH or as a file.", config.command),
            Some("Install it, or set the full path to the program in this server's settings."),
        ));
        skip_rest(&mut items, "Not checked: the program was not found.");
    }
    let rank = |status: &str| match status {
        "failed" => 3,
        "warning" => 2,
        "passed" => 1,
        _ => 0,
    };
    let status = items
        .iter()
        .map(|i| i.status)
        .max_by_key(|s| rank(s))
        .unwrap_or("skipped");
    McpCheckReport {
        server_id: config.id.clone(),
        server_name: config.name.clone(),
        status,
        items,
        tools,
        duration_ms: started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    }
}

/// Handshake then `tools/list`; an error names the phase it stopped in
/// (`start`, `initialize` or `list`) and carries the server's error output.
fn check_exchange(
    config: &McpServerConfig,
    timeout: Duration,
    cancel: &Arc<AtomicBool>,
) -> Result<Vec<McpToolInfo>, (&'static str, String, String)> {
    if cancel.load(Ordering::SeqCst) {
        return Err(("start", "Cancelled.".into(), String::new()));
    }
    let SpawnedServer {
        mut child,
        group,
        pipes,
        stderr_log,
    } = spawn_server(config).map_err(|e| ("start", e, String::new()))?;
    let phase = Arc::new(Mutex::new("initialize"));
    let reached = Arc::clone(&phase);
    let result = run_bounded(&mut child, &group, pipes, timeout, cancel, move |pipes| {
        pipes.initialize()?;
        if let Ok(mut current) = reached.lock() {
            *current = "list";
        }
        pipes.list_tools()
    });
    shutdown(child, group);
    let phase = phase.lock().map(|p| *p).unwrap_or("initialize");
    result.map_err(|e| (phase, e, stderr_tail_wait(&stderr_log)))
}

/// Probe a server command with `--version`-style courtesy: MCP servers speak
/// stdio, so availability is just "resolves on PATH / is a file".
pub fn probe_server(config: &McpServerConfig) -> HashMap<String, String> {
    let mut info = HashMap::new();
    info.insert("id".to_string(), config.id.clone());
    info.insert("name".to_string(), config.name.clone());
    info.insert(
        "available".to_string(),
        server_command_available(config).to_string(),
    );
    info
}

/// Human-readable argv preview (display only, no shell involved).
pub fn preview_server(config: &McpServerConfig) -> String {
    let spec = CommandSpec {
        executable: config.command.clone(),
        args: config.args.clone(),
        working_dir: None,
        stdin: None,
    };
    spec.preview()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Fixture MCP server: minimal JSON-RPC over stdio in sh.
    fn fixture_config() -> (tempfile::TempDir, McpServerConfig) {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = dir.path().join("fake-mcp.sh");
        std::fs::write(
            &script,
            r#"#!/bin/sh
# Minimal MCP fixture over newline-delimited JSON-RPC.
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      n=$(printf '%s' "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"fake","version":"0"}}}\n' "$n"
      ;;
    *'"method":"tools/list"'*)
      n=$(printf '%s' "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"jira_get_issue","description":"Get a Jira issue","inputSchema":{"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}}]}}\n' "$n"
      ;;
    *'"method":"tools/call"'*)
      n=$(printf '%s' "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
      # As an argument, not the format: macOS sh (bash) would turn \" into ".
      printf '%s\n' '{"jsonrpc":"2.0","id":'"$n"',"result":{"content":[{"type":"text","text":"{\"key\":\"DEV-1234\",\"summary\":\"Cart bug\"}"}],"isError":false}}'
      ;;
    *) ;;
  esac
done
"#,
        )
        .expect("write fixture");
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
                name: "Jira MCP".into(),
                command: script.to_string_lossy().into_owned(),
                args: vec![],
                enabled: true,
            },
        )
    }

    fn cancel_flag() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    fn statuses(report: &McpCheckReport) -> Vec<(&'static str, &'static str)> {
        report.items.iter().map(|i| (i.id, i.status)).collect()
    }

    fn script_config(dir: &tempfile::TempDir, name: &str, body: &str) -> McpServerConfig {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.path().join(name);
        std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).expect("script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        McpServerConfig {
            id: name.into(),
            name: name.into(),
            command: script.to_string_lossy().into_owned(),
            args: vec![],
            enabled: true,
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_working_server_passes_and_names_missing_workflow_tools() {
        let (_dir, config) = fixture_config();
        let report = check_server(
            &config,
            &["jira_get_issue".into()],
            Duration::from_secs(10),
            &cancel_flag(),
        );
        assert_eq!(report.status, "passed", "{report:#?}");
        assert_eq!(
            statuses(&report),
            [
                ("found", "passed"),
                ("started", "passed"),
                ("listed", "passed"),
                ("required", "passed")
            ]
        );
        assert_eq!(report.tools[0].name, "jira_get_issue");
        let missing = check_server(
            &config,
            &["jira_search".into(), "jira_get_issue".into()],
            Duration::from_secs(10),
            &cancel_flag(),
        );
        assert_eq!(missing.status, "failed");
        assert_eq!(missing.items[3].detail, "Missing: jira_search.");
        let unused = check_server(&config, &[], Duration::from_secs(10), &cancel_flag());
        assert_eq!(unused.items[3].status, "skipped");
    }

    #[cfg(unix)]
    #[test]
    fn a_server_that_stops_or_stays_silent_says_where_and_what_to_do() {
        let dir = tempfile::tempdir().expect("tempdir");
        let crash = script_config(&dir, "crash", "echo 'JIRA_URL is not set' >&2; exit 3");
        let report = check_server(&crash, &[], Duration::from_secs(10), &cancel_flag());
        assert_eq!(
            statuses(&report),
            [
                ("found", "passed"),
                ("started", "failed"),
                ("listed", "skipped"),
                ("required", "skipped")
            ]
        );
        assert!(
            report.items[1].detail.contains("JIRA_URL is not set"),
            "{report:#?}"
        );
        assert!(report.items[1].hint.is_some());
        let silent = script_config(&dir, "silent", "sleep 30");
        let started = Instant::now();
        let report = check_server(&silent, &[], Duration::from_secs(1), &cancel_flag());
        assert!(started.elapsed() < Duration::from_secs(10), "bounded");
        assert_eq!(report.items[1].status, "failed");
        assert!(report.items[1]
            .hint
            .as_deref()
            .unwrap_or("")
            .contains("did not answer in time"));
        let cancelled = Arc::new(AtomicBool::new(true));
        let report = check_server(&silent, &[], Duration::from_secs(10), &cancelled);
        assert!(
            report.items[1..].iter().all(|i| i.status == "skipped"),
            "{report:#?}"
        );
    }

    #[test]
    fn a_missing_or_disabled_server_is_not_started() {
        let missing = McpServerConfig {
            id: "m".into(),
            name: "m".into(),
            command: "no-such-mcp-server-v020".into(),
            args: vec![],
            enabled: true,
        };
        let report = check_server(&missing, &[], Duration::from_secs(1), &cancel_flag());
        assert_eq!(report.items[0].status, "failed");
        assert!(report.items[0]
            .hint
            .as_deref()
            .unwrap_or("")
            .contains("full path"));
        let off = McpServerConfig {
            enabled: false,
            ..missing
        };
        let report = check_server(&off, &[], Duration::from_secs(1), &cancel_flag());
        assert_eq!(report.items[0].detail, "This server is turned off.");
        assert_eq!(report.status, "failed");
    }

    #[test]
    fn workflows_name_the_tools_they_need_from_a_server() {
        let workflow: crate::workflow::Workflow = serde_json::from_value(serde_json::json!({
            "schemaVersion": 6, "id": "w", "name": "W",
            "nodes": [
                {"id": "a", "type": "mcp", "position": {"x":0,"y":0}, "config": {"mcpServerId": "jira", "mcpTool": "jira_search"}},
                {"id": "b", "type": "ticket", "position": {"x":0,"y":0}, "config": {"mcpServerId": "jira", "ticketKey": "X-1"}},
                {"id": "c", "type": "mcp", "position": {"x":0,"y":0}, "config": {"mcpServerId": "other", "mcpTool": "x"}}
            ],
            "edges": []
        }))
        .expect("workflow");
        assert_eq!(
            required_tools(&[workflow], "jira"),
            ["jira_get_issue", "jira_search"]
        );
    }

    #[test]
    fn config_validation_rejects_blanks() {
        let bad = McpServerConfig {
            id: "".into(),
            name: "".into(),
            command: "".into(),
            args: vec![],
            enabled: true,
        };
        assert!(!bad.validate().is_empty());
    }

    #[test]
    fn lists_tools_from_fixture_server() {
        let (_dir, config) = fixture_config();
        let tools =
            list_tools(&config, Duration::from_secs(10), &cancel_flag()).expect("list tools");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "jira_get_issue");
        assert_eq!(
            tools[0]
                .input_schema
                .as_ref()
                .and_then(|schema| schema.get("required")),
            Some(&serde_json::json!(["key"]))
        );
    }

    #[test]
    fn calls_tool_and_returns_text() {
        let (_dir, config) = fixture_config();
        let result = call_tool(
            &config,
            "jira_get_issue",
            &serde_json::json!({"key": "DEV-1234"}),
            Duration::from_secs(10),
            &cancel_flag(),
        )
        .expect("call");
        assert!(!result.is_error);
        assert!(result.text.contains("DEV-1234"));
        assert_eq!(result.server_id, "jira");
    }

    /// Fixture server that dies immediately after printing the real cause
    /// to stderr — the mcp-atlassian-without-env-vars shape.
    fn crashing_config() -> (tempfile::TempDir, McpServerConfig) {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = dir.path().join("crash-mcp.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\necho 'JIRA_URL is required, see setup docs' >&2\nexit 1\n",
        )
        .expect("write fixture");
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
                name: "Jira MCP".into(),
                command: script.to_string_lossy().into_owned(),
                args: vec![],
                enabled: true,
            },
        )
    }

    /// Fixture server that handshakes fine but lists zero tools.
    fn empty_config() -> (tempfile::TempDir, McpServerConfig) {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = dir.path().join("empty-mcp.sh");
        std::fs::write(
            &script,
            r#"#!/bin/sh
echo 'WARN: starting with limited configuration' >&2
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      n=$(printf '%s' "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"empty","version":"0"}}}\n' "$n"
      ;;
    *'"method":"tools/list"'*)
      n=$(printf '%s' "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
      printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$n"
      ;;
    *) ;;
  esac
done
"#,
        )
        .expect("write fixture");
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
                name: "Jira MCP".into(),
                command: script.to_string_lossy().into_owned(),
                args: vec![],
                enabled: true,
            },
        )
    }

    #[test]
    fn crashing_server_quotes_stderr() {
        let (_dir, config) = crashing_config();
        let err =
            list_tools(&config, Duration::from_secs(10), &cancel_flag()).expect_err("must fail");
        assert!(
            err.contains("JIRA_URL is required"),
            "stderr must be quoted, got: {err}"
        );
    }

    #[test]
    fn empty_tool_list_reports_stderr_instead_of_silence() {
        let (_dir, config) = empty_config();
        let err = list_tools(&config, Duration::from_secs(10), &cancel_flag())
            .expect_err("must fail loudly");
        assert!(err.contains("no tools"), "got: {err}");
        assert!(err.contains("limited configuration"), "got: {err}");
    }

    #[test]
    fn disabled_server_fails_closed() {
        let (_dir, mut config) = fixture_config();
        config.enabled = false;
        assert!(list_tools(&config, Duration::from_secs(5), &cancel_flag()).is_err());
    }

    #[test]
    fn missing_command_fails_with_clear_message() {
        let config = McpServerConfig {
            id: "x".into(),
            name: "X".into(),
            command: "orchevia-definitely-missing-mcp-xyz".into(),
            args: vec![],
            enabled: true,
        };
        assert!(!server_command_available(&config));
        assert!(list_tools(&config, Duration::from_secs(5), &cancel_flag()).is_err());
    }

    #[test]
    fn cancelled_flag_aborts_before_spawn() {
        let (_dir, config) = fixture_config();
        let flag = Arc::new(AtomicBool::new(true));
        assert!(list_tools(&config, Duration::from_secs(5), &flag).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn timeout_returns_promptly_while_a_grandchild_holds_the_pipe() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let script = dir.path().join("stuck-mcp.sh");
        let group_file = dir.path().join("group");
        let sleeper_file = dir.path().join("sleeper");
        // Never answers; a background grandchild inherits stdout, so killing
        // only the direct child would leave `read_line` blocked for 30 s.
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\necho $$ > {}\nsleep 30 &\necho $! > {}\nwait\n",
                shell_escape::escape(group_file.to_string_lossy()),
                shell_escape::escape(sleeper_file.to_string_lossy())
            ),
        )
        .expect("write");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        let config = McpServerConfig {
            id: "stuck".into(),
            name: "Stuck".into(),
            command: script.to_string_lossy().into_owned(),
            args: vec![],
            enabled: true,
        };
        let started = std::time::Instant::now();
        let err = list_tools(&config, Duration::from_millis(500), &cancel_flag()).unwrap_err();
        assert!(err.contains("exceeded"), "got: {err}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "took {:?}",
            started.elapsed()
        );
        let group: u32 = std::fs::read_to_string(&group_file)
            .expect("group")
            .trim()
            .parse()
            .expect("pid");
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while crate::process::process_group_alive(group) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            !crate::process::process_group_alive(group),
            "grandchild survived"
        );
        let sleeper = crate::process::test_support::recorded_pid(&sleeper_file);
        assert!(
            crate::process::test_support::stops(sleeper),
            "grandchild survived"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_finished_exchange_stops_everything_the_server_started() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, mut config) = fixture_config();
        let group_file = dir.path().join("group");
        let sleeper_file = dir.path().join("sleeper");
        // A server that leaves a helper running, as `npx` leaves `node`.
        let script = dir.path().join("server-with-helper.sh");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\necho $$ > {}\nsleep 30 &\necho $! > {}\nexec {}\n",
                shell_escape::escape(group_file.to_string_lossy()),
                shell_escape::escape(sleeper_file.to_string_lossy()),
                shell_escape::escape(config.command.as_str().into())
            ),
        )
        .expect("write");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        config.command = script.to_string_lossy().into_owned();
        let tools =
            list_tools(&config, Duration::from_secs(10), &cancel_flag()).expect("list tools");
        assert_eq!(tools.len(), 1);
        let group = crate::process::test_support::recorded_pid(&group_file);
        let sleeper = crate::process::test_support::recorded_pid(&sleeper_file);
        assert!(
            crate::process::test_support::stops(sleeper),
            "the server's helper survived shutdown"
        );
        // Linux still counts the helper until it is reaped.
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while crate::process::process_group_alive(group) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!crate::process::process_group_alive(group));
    }
}
