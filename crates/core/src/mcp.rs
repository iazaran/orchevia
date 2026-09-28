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

use crate::process::CommandSpec;
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
    let cmd = config.command.trim();
    if cmd.is_empty() {
        return false;
    }
    if cmd.contains('/') || cmd.contains('\\') {
        return std::path::Path::new(cmd).is_file();
    }
    crate::tools::find_executable(cmd).is_some()
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
    let (mut child, pipes, stderr_log) = spawn_server(config)?;
    let result = run_bounded(&mut child, pipes, timeout, cancel, |pipes| {
        pipes.initialize()?;
        pipes.list_tools()
    });
    shutdown(child);
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
    let (mut child, pipes, stderr_log) = spawn_server(config)?;
    let tool_owned = tool.to_string();
    let tool_name = tool_owned.clone();
    let args_owned = arguments.clone();
    let server_id = config.id.clone();
    let server_name = config.name.clone();
    let result = run_bounded(&mut child, pipes, timeout, cancel, move |pipes| {
        pipes.initialize()?;
        pipes.call_tool(&tool_owned, &args_owned)
    });
    shutdown(child);
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

/// Spawn the server child, returning ownership of the process plus pipes.
/// The caller keeps the [`Child`] so timeouts can kill it even while a
/// worker thread blocks on stdio. Server stderr is drained on a background
/// thread into shared memory (capped tail) so failures can quote the real
/// cause — e.g. a missing env var — instead of reporting a bare EOF.
fn spawn_server(config: &McpServerConfig) -> Result<(Child, McpPipes, Arc<Mutex<String>>), String> {
    if !config.enabled {
        return Err(format!("MCP server '{}' is disabled.", config.name));
    }
    let exe = crate::tools::require_executable(&config.command)
        .map_err(|message| format!("Failed to spawn MCP server '{}': {message}", config.command))?;
    let mut cmd = Command::new(&exe);
    cmd.args(&config.args);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn MCP server '{}': {e}", config.command))?;
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
    Ok((
        child,
        McpPipes {
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        },
        stderr_log,
    ))
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

/// Run `f` on a worker thread while the main thread enforces `timeout` and
/// cooperative cancellation; the child is killed on expiry/cancel.
fn run_bounded<T: Send + 'static>(
    child: &mut Child,
    pipes: McpPipes,
    timeout: Duration,
    cancel: &Arc<AtomicBool>,
    f: impl FnOnce(&mut McpPipes) -> Result<T, String> + Send,
) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::scope(|scope| {
        scope.spawn(move || {
            let mut owned = pipes;
            let result = f(&mut owned);
            let _ = tx.send(result);
        });
        let deadline = Instant::now() + timeout;
        loop {
            match rx.recv_timeout(Duration::from_millis(25)) {
                Ok(result) => return result,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if cancel.load(Ordering::SeqCst) {
                        let _ = child.kill();
                        return Err("Cancelled.".to_string());
                    }
                    if Instant::now() >= deadline {
                        let _ = child.kill();
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
    })
}

fn shutdown(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
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
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"{\"key\":\"DEV-1234\",\"summary\":\"Cart bug\"}"}],"isError":false}}\n' "$n"
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
}
