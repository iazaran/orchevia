//! Incremental decoding for managed CLI conversations. No provider calls here.
use crate::agents::AdapterKind;
use serde_json::Value;

const MAX_TEXT: usize = 200_000;
const MAX_EVENT_BYTES: usize = 4_000_000;

pub(crate) struct AgentOutput {
    adapter: AdapterKind,
    /// Keep non-JSON lines as activity instead of failing (ordinary nodes:
    /// wrapper scripts or runtimes may print a stray line). Session turns stay
    /// strict so malformed conversations are never reused.
    tolerant: bool,
    pending: Vec<u8>,
    discarding: bool,
    activity_chars: usize,
    pub activity: String,
    pub text: Option<String>,
    pub session_id: Option<String>,
    pub usage: Value,
    pub error: Option<String>,
    complete: bool,
    /// Observed tool calls inside this CLI invocation (Claude `tool_use`
    /// blocks, Codex `command_execution` items). Advisory companion to the
    /// enforced run attempt budget; stops nothing by itself.
    tool_calls: u64,
    /// Observed nested-subagent spawns (Claude `Task` tool uses). Codex has
    /// no verified equivalent shape, so Codex subagents stay unobserved.
    subagents: u64,
}

impl AgentOutput {
    pub fn new(adapter: AdapterKind) -> Self {
        Self {
            adapter,
            tolerant: false,
            pending: Vec::new(),
            discarding: false,
            activity_chars: 0,
            activity: String::new(),
            text: None,
            session_id: None,
            usage: Value::Null,
            error: None,
            complete: false,
            tool_calls: 0,
            subagents: 0,
        }
    }

    /// Decoder for ordinary Agent nodes; see `tolerant`.
    pub fn tolerant(adapter: AdapterKind) -> Self {
        Self {
            tolerant: true,
            ..Self::new(adapter)
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if byte == b'\n' {
                if !self.discarding {
                    self.event();
                }
                self.pending.clear();
                self.discarding = false;
            } else if !self.discarding {
                if self.pending.len() == MAX_EVENT_BYTES {
                    self.pending.clear();
                    self.discarding = true;
                    self.error = Some("CLI output event exceeded the 4 MB limit.".into());
                } else {
                    self.pending.push(byte);
                }
            }
        }
    }

    pub fn finish(&mut self) {
        if !self.pending.is_empty() && !self.discarding {
            self.event();
            self.pending.clear();
        }
        self.flush_counts();
        if !self.complete && self.error.is_none() {
            self.error = Some(
                "CLI did not return a completed structured result; partial output is preserved."
                    .into(),
            );
        }
    }

    pub fn success(&self) -> bool {
        self.complete && self.error.is_none()
    }

    /// Copy observed in-CLI counts into the usage envelope. Called when a
    /// terminal event lands and at finish, so partial output keeps partial
    /// counts. Creates the envelope when the CLI reported no usage block
    /// but did emit countable tool events.
    fn flush_counts(&mut self) {
        if self.tool_calls == 0 && self.subagents == 0 {
            return;
        }
        if !self.usage.is_object() {
            self.usage = serde_json::json!({});
        }
        self.usage["observed_tool_calls"] = serde_json::json!(self.tool_calls);
        self.usage["observed_subagents"] = serde_json::json!(self.subagents);
    }

    fn add_activity(&mut self, text: &str) {
        if text.is_empty() || self.activity_chars >= MAX_TEXT {
            return;
        }
        let part: String = text.chars().take(MAX_TEXT - self.activity_chars).collect();
        self.activity_chars += part.chars().count();
        self.activity.push_str(&part);
        if self.activity_chars < MAX_TEXT {
            self.activity.push('\n');
            self.activity_chars += 1;
        }
    }

    fn response(&mut self, text: &str) {
        self.text = Some(text.chars().take(MAX_TEXT).collect());
        if text.chars().count() > MAX_TEXT {
            if let Some(value) = self.text.as_mut() {
                value.push_str("\n… [truncated]");
            }
        }
    }

    fn event(&mut self) {
        if self.pending.iter().all(u8::is_ascii_whitespace) {
            return;
        }
        let value: Value = match serde_json::from_slice(&self.pending) {
            Ok(value) => value,
            Err(_) if self.tolerant => {
                let line = String::from_utf8_lossy(&self.pending).into_owned();
                self.add_activity(line.trim_end());
                return;
            }
            Err(_) => {
                self.error = Some("CLI returned malformed structured output.".into());
                return;
            }
        };
        // Subagent events cannot replace the top-level response/session.
        if value
            .get("parent_tool_use_id")
            .is_some_and(|v| !v.is_null())
        {
            return;
        }
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        let session = if self.adapter == AdapterKind::Claude {
            value.get("session_id")
        } else if kind == "thread.started" {
            value.get("thread_id")
        } else {
            None
        };
        if let Some(id) = session
            .and_then(Value::as_str)
            .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        {
            self.session_id = Some(id.to_string());
        }
        match (self.adapter, kind) {
            (AdapterKind::Claude, "assistant") => {
                if let Some(content) = value.pointer("/message/content").and_then(Value::as_array) {
                    for block in content {
                        if block.get("type").and_then(Value::as_str) == Some("text") {
                            if let Some(text) = block.get("text").and_then(Value::as_str) {
                                self.add_activity(text);
                                self.response(text);
                            }
                        } else if let Some(name) = block.get("name").and_then(Value::as_str) {
                            // Any named content block is a tool invocation
                            // (`tool_use`); the nested-agent tool is "Task".
                            // Observed only: killing the process after this
                            // event cannot un-run the tool.
                            self.tool_calls += 1;
                            if name == "Task" {
                                self.subagents += 1;
                            }
                            self.add_activity(&format!("Tool: {name}"));
                        }
                    }
                }
            }
            (AdapterKind::Claude, "user") => {
                if let Some(content) = value.pointer("/message/content").and_then(Value::as_array) {
                    for block in content {
                        if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                            if let Some(text) = block.get("content").and_then(Value::as_str) {
                                self.add_activity(text);
                            }
                        }
                    }
                }
            }
            (AdapterKind::Claude, "result") => {
                self.complete = true;
                if let Some(text) = value.get("result").and_then(Value::as_str) {
                    self.response(text);
                }
                self.usage = value.get("usage").cloned().unwrap_or(Value::Null);
                self.flush_counts();
                if let Some(cost) = value.get("total_cost_usd").and_then(Value::as_f64) {
                    if cost.is_finite() && cost >= 0.0 {
                        if !self.usage.is_object() {
                            self.usage = serde_json::json!({});
                        }
                        self.usage["reported_cost_usd"] = serde_json::json!(cost);
                    }
                }
                if value.get("is_error").and_then(Value::as_bool) == Some(true) {
                    self.error = Some(
                        value
                            .get("errors")
                            .map(Value::to_string)
                            .unwrap_or_else(|| "CLI reported a failed result.".into())
                            .chars()
                            .take(2000)
                            .collect(),
                    );
                }
            }
            (AdapterKind::Codex, "item.completed") => {
                let item = &value["item"];
                match item.get("type").and_then(Value::as_str) {
                    Some("agent_message") => {
                        if let Some(text) = item.get("text").and_then(Value::as_str) {
                            self.add_activity(text);
                            self.response(text);
                        }
                    }
                    Some("command_execution") => {
                        self.tool_calls += 1;
                        if let Some(command) = item.get("command").and_then(Value::as_str) {
                            self.add_activity(command);
                        }
                        if let Some(output) = item.get("aggregated_output").and_then(Value::as_str)
                        {
                            self.add_activity(output);
                        }
                    }
                    _ => {}
                }
            }
            (AdapterKind::Codex, "turn.completed") => {
                self.complete = true;
                self.usage = value.get("usage").cloned().unwrap_or(Value::Null);
                self.flush_counts();
            }
            (_, "error" | "turn.failed") => {
                self.error = Some(
                    value
                        .get("message")
                        .or_else(|| value.pointer("/error/message"))
                        .and_then(Value::as_str)
                        .unwrap_or("CLI reported an error.")
                        .chars()
                        .take(2000)
                        .collect(),
                );
            }
            _ => {}
        }
        if self.complete && self.text.is_none() && self.error.is_none() {
            self.error = Some("CLI completed without a response.".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::AdapterKind;

    #[test]
    fn split_streams_preserve_partial_text_and_explicit_provider_errors() {
        let mut out = AgentOutput::new(AdapterKind::Claude);
        let text = "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"partial 🙂\"}]}}\n";
        for b in text.as_bytes().chunks(3) {
            out.push(b);
        }
        assert!(out.activity.contains("partial 🙂"));
        out.push(b"{\"type\":\"result\",\"is_error\":true,\"errors\":[\"budget reached\"]}\n");
        out.finish();
        assert!(out.error.as_deref().unwrap().contains("budget reached"));
        assert!(!out.success());
    }

    #[test]
    fn ordinary_nodes_keep_stray_lines_while_sessions_stay_strict() {
        let events = b"wrapper: starting claude\n{\"type\":\"result\",\"is_error\":false,\"result\":\"done\",\"usage\":{\"input_tokens\":1}}\n";
        let mut ordinary = AgentOutput::tolerant(AdapterKind::Claude);
        ordinary.push(events);
        ordinary.finish();
        assert!(ordinary.success(), "{:?}", ordinary.error);
        assert_eq!(ordinary.text.as_deref(), Some("done"));
        assert!(ordinary.activity.contains("wrapper: starting claude"));
        let mut session = AgentOutput::new(AdapterKind::Claude);
        session.push(events);
        session.finish();
        assert!(!session.success());
        // Without a completed result the tolerant decoder still fails.
        let mut incomplete = AgentOutput::tolerant(AdapterKind::Codex);
        incomplete.push(b"plain text only\n");
        incomplete.finish();
        assert!(!incomplete.success());
    }

    #[test]
    fn final_response_and_session_survive_activity_capture_limits() {
        let mut out = AgentOutput::new(AdapterKind::Codex);
        let event = format!("{{\"type\":\"item.completed\",\"item\":{{\"type\":\"command_execution\",\"command\":\"test\",\"aggregated_output\":\"{}\"}}}}\n", "x".repeat(20000));
        for _ in 0..100 {
            out.push(event.as_bytes());
        }
        out.push(b"{\"type\":\"thread.started\",\"thread_id\":\"00000000-0000-4000-8000-000000000001\"}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"FINAL P2\"}}\n{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":23,\"cached_input_tokens\":20,\"output_tokens\":3}}");
        out.finish();
        assert_eq!(out.text.as_deref(), Some("FINAL P2"));
        assert!(out.session_id.is_some());
        assert!(out.success());
        assert_eq!(out.usage["cached_input_tokens"], 20);
        assert!(out.activity.len() < 800000);
    }
}
