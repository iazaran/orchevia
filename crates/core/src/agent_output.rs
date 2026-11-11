//! Incremental decoding for managed CLI conversations. No provider calls here.
use crate::agents::AdapterKind;
use crate::permissions::{claude_denials, denial_message, PermissionDenial};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const MAX_TEXT: usize = 200_000;
const MAX_EVENT_BYTES: usize = 4_000_000;
const MAX_DIGEST_FILES: usize = 100;
const MAX_DIGEST_COMMANDS: usize = 60;
const MAX_DIGEST_TASKS: usize = 40;

/// What a CLI did, built only from its own events: tool inputs, tool results
/// and items. Never from what the agent wrote about itself, except `message`,
/// which the run page labels as the agent's words. Bounded, so a long
/// conversation keeps a small summary.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDigest {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<DigestFile>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<DigestCommand>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tasks: Vec<DigestTask>,
    /// The latest action while the CLI runs ("Editing src/a.ts"); cleared
    /// when it finishes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doing: Option<String>,
    /// The agent's latest message, shortened.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "is_zero")]
    pub reads: u32,
    #[serde(skip_serializing_if = "is_zero")]
    pub searches: u32,
    /// Some files, commands or tasks were left out to stay bounded.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    #[serde(skip)]
    next_seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestFile {
    pub path: String,
    /// `added`, `edited` or `deleted`, as the CLI reported the change.
    pub change: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestCommand {
    pub command: String,
    /// `running`, `succeeded`, `failed` or `unknown`: the result the CLI
    /// reported for this command (Codex exit code, Claude `is_error`).
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// A known test runner (`cargo test`, `pnpm test`, `pytest`, …).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub test: bool,
    /// Stable id while the CLI runs, so a result finds its command after
    /// older ones were dropped to stay bounded.
    #[serde(skip)]
    seq: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestTask {
    pub id: String,
    pub text: String,
    /// `pending`, `in_progress` or `completed`.
    pub status: String,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// A tool call waiting for its result.
#[derive(Debug, Clone)]
enum PendingTool {
    /// A digest command by its stable id.
    Command(u64),
    File {
        path: String,
        change: &'static str,
    },
    TaskCreate(String),
}

fn shorten(text: &str, max: usize) -> String {
    let text = text.trim();
    let first = text.lines().next().unwrap_or("").trim();
    let mut out: String = first.chars().take(max).collect();
    if first.chars().count() > max || text.lines().count() > 1 {
        out.push('…');
    }
    out
}

/// The agent's latest words, kept whole up to 500 characters.
fn shorten_message(text: &str) -> String {
    let text = text.trim();
    let mut out: String = text.chars().take(500).collect();
    if text.chars().count() > 500 {
        out.push('…');
    }
    out
}

/// The last two path components, enough to recognise a file.
fn short_path(path: &str) -> String {
    let parts: Vec<&str> = path.rsplit('/').filter(|p| !p.is_empty()).take(2).collect();
    parts.into_iter().rev().collect::<Vec<_>>().join("/")
}

/// Codex wraps each command in the user's shell (`/usr/bin/zsh -lc 'ls'`);
/// show the command itself.
fn unwrap_shell(command: &str) -> String {
    let trimmed = command.trim();
    let mut parts = trimmed.splitn(3, ' ');
    let (Some(shell), Some(flag), Some(rest)) = (parts.next(), parts.next(), parts.next()) else {
        return trimmed.to_string();
    };
    let name = shell.rsplit('/').next().unwrap_or(shell);
    if !matches!(name, "sh" | "bash" | "zsh" | "dash" | "ksh" | "fish")
        || !matches!(flag, "-c" | "-lc" | "-lic" | "-ic")
    {
        return trimmed.to_string();
    }
    let rest = rest.trim();
    for quote in ['\'', '"'] {
        if rest.len() >= 2 && rest.starts_with(quote) && rest.ends_with(quote) {
            return rest[1..rest.len() - 1].to_string();
        }
    }
    rest.to_string()
}

const TEST_RUNNERS: [&str; 30] = [
    "cargo test",
    "cargo nextest",
    "npm test",
    "npm run test",
    "pnpm test",
    "pnpm run test",
    "pnpm vitest",
    "pnpm jest",
    "yarn vitest",
    "yarn jest",
    "yarn test",
    "yarn run test",
    "bun test",
    "deno test",
    "vitest",
    "jest",
    "pytest",
    "unittest",
    "go test",
    "phpunit",
    "pest",
    "rspec",
    "mvn test",
    "gradle test",
    "gradlew test",
    "dotnet test",
    "mix test",
    "make test",
    "ctest",
    "swift test",
];

/// Wrappers that run the command after them.
const RUN_WRAPPERS: [&str; 12] = [
    "npx ",
    "bunx ",
    "pnpm exec ",
    "pnpm dlx ",
    "yarn dlx ",
    "uv run ",
    "poetry run ",
    "pipenv run ",
    "time ",
    "env ",
    "python -m ",
    "python3 -m ",
];

/// Split a shell command at `&&`, `||`, `|`, `;`, newlines and a background
/// `&` outside quotes. Each segment comes with whether its exit status is
/// the command's: no `||` before it, and only `&&` after it.
fn shell_segments(command: &str) -> Vec<(String, bool)> {
    let chars: Vec<char> = command.chars().collect();
    let mut segments: Vec<(String, &str)> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        match (quote, c) {
            (Some(q), _) if c == q => {
                quote = None;
                current.push(c);
            }
            (Some(_), _) => current.push(c),
            (None, '\'' | '"') => {
                quote = Some(c);
                current.push(c);
            }
            (None, '&') if next == Some('&') => {
                segments.push((std::mem::take(&mut current), "&&"));
                i += 1;
            }
            (None, '|') if next == Some('|') => {
                segments.push((std::mem::take(&mut current), "||"));
                i += 1;
            }
            (None, '|') => segments.push((std::mem::take(&mut current), "|")),
            (None, ';' | '\n') => segments.push((std::mem::take(&mut current), ";")),
            // A lone `&` sends the command to the background; `2>&1` and
            // `&>` are redirections.
            (None, '&')
                if i.checked_sub(1).and_then(|p| chars.get(p)) != Some(&'>')
                    && next != Some('>') =>
            {
                segments.push((std::mem::take(&mut current), "&"));
            }
            _ => current.push(c),
        }
        i += 1;
    }
    segments.push((current, ""));
    (0..segments.len())
        .map(|index| {
            // It ran (nothing before it is `||`), in the foreground, and its
            // status is the command's (only `&&` after it).
            let reliable = segments[..index].iter().all(|(_, after)| *after != "||")
                && segments[index..]
                    .iter()
                    .all(|(_, after)| after.is_empty() || *after == "&&");
            (segments[index].0.clone(), reliable)
        })
        .collect()
}

/// A segment's command with environment assignments and wrappers removed,
/// and its program reduced to its file name.
fn command_core(segment: &str) -> String {
    let mut rest = segment.trim().to_lowercase();
    loop {
        let before = rest.clone();
        if let Some((first, tail)) = rest.split_once(char::is_whitespace) {
            let assignment = first.contains('=')
                && first
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
            if assignment {
                rest = tail.trim_start().to_string();
            }
        }
        for wrapper in RUN_WRAPPERS {
            if let Some(tail) = rest.strip_prefix(wrapper) {
                rest = tail.trim_start().to_string();
            }
        }
        if rest == before {
            break;
        }
    }
    match rest.split_once(char::is_whitespace) {
        Some((program, tail)) => {
            format!("{} {tail}", program.rsplit('/').next().unwrap_or(program))
        }
        None => rest.rsplit('/').next().unwrap_or(&rest).to_string(),
    }
}

/// Flags (lowercase) with which a runner builds, lists or describes tests
/// instead of running them.
const NO_TEST_RUN: [&str; 11] = [
    "--no-run",
    "--help",
    "-h",
    "--version",
    "--collect-only",
    "--co",
    "--list",
    "-list",
    "--listtests",
    "--showconfig",
    "--show-config",
];

/// Whether a shell command runs a known test runner whose exit status the
/// command's own status reports: the runner in command position, followed by
/// nothing but `&&`, and not in a mode that runs no tests. Used only to label
/// a command whose status the CLI reported; never to infer a result.
/// Mirrored by `looksLikeTestCommand` (shared cases in
/// `src/test/test-commands.json`).
pub fn is_test_command(command: &str) -> bool {
    shell_segments(command).iter().any(|(segment, reliable)| {
        let core = command_core(segment);
        *reliable
            && TEST_RUNNERS.iter().any(|runner| {
                core.strip_prefix(runner).is_some_and(|tail| {
                    (tail.is_empty() || tail.starts_with(char::is_whitespace)) && runs_tests(tail)
                })
            })
    })
}

/// Whether a runner's arguments leave it running tests: no listing
/// subcommand and no flag that only builds, lists or describes them.
fn runs_tests(arguments: &str) -> bool {
    let mut words = arguments.split_whitespace();
    if words.clone().next() == Some("list") {
        return false;
    }
    !words.any(|word| {
        NO_TEST_RUN.iter().any(|flag| {
            word.strip_prefix(flag)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('='))
        })
    })
}

impl AgentDigest {
    pub fn is_empty(&self) -> bool {
        *self == AgentDigest::default()
    }

    fn file(&mut self, path: &str, change: &str) {
        if path.trim().is_empty() {
            return;
        }
        if let Some(existing) = self.files.iter_mut().find(|f| f.path == path) {
            // A file created in this run stays "added" after later edits.
            if existing.change != "added" || change == "deleted" {
                existing.change = change.to_string();
            }
            return;
        }
        if self.files.len() >= MAX_DIGEST_FILES {
            self.truncated = true;
            return;
        }
        self.files.push(DigestFile {
            path: path.to_string(),
            change: change.to_string(),
        });
    }

    fn command(&mut self, command: &str) -> u64 {
        let command = unwrap_shell(command);
        if self.commands.len() >= MAX_DIGEST_COMMANDS {
            self.truncated = true;
            // Keep test runs: drop the oldest other command first.
            let drop = self
                .commands
                .iter()
                .position(|c| !c.test)
                .unwrap_or_default();
            self.commands.remove(drop);
        }
        self.next_seq += 1;
        self.commands.push(DigestCommand {
            test: is_test_command(&command),
            command: command.chars().take(300).collect(),
            status: "running".into(),
            exit_code: None,
            seq: self.next_seq,
        });
        self.next_seq
    }

    fn command_mut(&mut self, seq: u64) -> Option<&mut DigestCommand> {
        self.commands.iter_mut().find(|c| c.seq == seq)
    }

    fn task(&mut self, id: &str, text: &str, status: &str) {
        if let Some(task) = self.tasks.iter_mut().find(|t| t.id == id) {
            if !text.trim().is_empty() {
                task.text = shorten(text, 200);
            }
            if !status.is_empty() {
                task.status = status.to_string();
            }
            return;
        }
        if self.tasks.len() >= MAX_DIGEST_TASKS {
            self.truncated = true;
            return;
        }
        self.tasks.push(DigestTask {
            id: id.to_string(),
            text: shorten(text, 200),
            status: if status.is_empty() {
                "pending".into()
            } else {
                status.to_string()
            },
        });
    }
}

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
    /// A provider cap or missing required structured completion left the task
    /// unfinished. It must never release an ordinary failure route.
    pub incomplete: bool,
    /// A structured provider cap, distinct from a process killed by Orchevia.
    pub limit_exhausted: bool,
    /// Tool calls the CLI refused under its permission settings (Claude
    /// `permission_denials`). Non-empty fails the node even though the CLI
    /// itself reports success.
    pub permission_denials: Vec<PermissionDenial>,
    complete: bool,
    /// Observed tool calls inside this CLI invocation (Claude `tool_use`
    /// blocks, Codex `command_execution` items). Advisory companion to the
    /// enforced run attempt budget; stops nothing by itself.
    tool_calls: u64,
    /// Observed nested-subagent spawns (Claude `Task` tool uses). Codex has
    /// no verified equivalent shape, so Codex subagents stay unobserved.
    subagents: u64,
    tool_ids: HashSet<String>,
    /// What the CLI did, from its own events (see [`AgentDigest`]).
    pub digest: AgentDigest,
    pending_tools: HashMap<String, PendingTool>,
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
            incomplete: false,
            limit_exhausted: false,
            permission_denials: Vec::new(),
            complete: false,
            tool_calls: 0,
            subagents: 0,
            tool_ids: HashSet::new(),
            digest: AgentDigest::default(),
            pending_tools: HashMap::new(),
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
        if !self.complete {
            self.incomplete = true;
        }
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
        if self.tool_calls == 0 && !self.complete {
            return;
        }
        if !self.usage.is_object() {
            self.usage = serde_json::json!({});
        }
        self.usage["observed_tool_calls"] = serde_json::json!(self.tool_calls);
        if self.adapter == AdapterKind::Claude {
            self.usage["observed_subagents"] = serde_json::json!(self.subagents);
        }
    }

    fn observe_tools(&mut self, value: &Value) {
        match (self.adapter, value["type"].as_str()) {
            (AdapterKind::Claude, Some("assistant")) => {
                if let Some(blocks) = value.pointer("/message/content").and_then(Value::as_array) {
                    for block in blocks {
                        if block["type"] != "tool_use" {
                            continue;
                        }
                        if let Some(id) = block["id"].as_str() {
                            if !self.tool_ids.insert(id.into()) {
                                continue;
                            }
                        }
                        self.tool_calls += 1;
                        if matches!(block["name"].as_str(), Some("Task" | "Agent")) {
                            self.subagents += 1;
                        }
                    }
                }
            }
            (AdapterKind::Codex, Some("item.completed"))
                if value["item"]["type"] == "command_execution" =>
            {
                if let Some(id) = value["item"]["id"].as_str() {
                    if !self.tool_ids.insert(id.into()) {
                        return;
                    }
                }
                self.tool_calls += 1;
            }
            _ => {}
        }
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

    /// Update the digest from one event. Descendant (subagent) tool calls
    /// count, because their edits and commands are real; only top-level
    /// messages become the step's message.
    fn digest_event(&mut self, value: &Value) {
        let top = !value
            .get("parent_tool_use_id")
            .is_some_and(|v| !v.is_null());
        match (self.adapter, value["type"].as_str()) {
            (AdapterKind::Claude, Some("assistant")) => {
                let Some(blocks) = value.pointer("/message/content").and_then(Value::as_array)
                else {
                    return;
                };
                for block in blocks {
                    match block["type"].as_str() {
                        Some("tool_use") => self.claude_tool_use(block),
                        Some("text") if top => {
                            if let Some(text) = block["text"].as_str() {
                                if !text.trim().is_empty() {
                                    self.digest.message = Some(shorten_message(text));
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            (AdapterKind::Claude, Some("user")) => {
                let Some(blocks) = value.pointer("/message/content").and_then(Value::as_array)
                else {
                    return;
                };
                for block in blocks {
                    if block["type"] == "tool_result" {
                        self.claude_tool_result(block, &value["tool_use_result"]);
                    }
                }
            }
            (AdapterKind::Claude, Some("result")) if top => self.digest.doing = None,
            (AdapterKind::Codex, Some(kind @ ("item.started" | "item.completed"))) => {
                self.codex_item(&value["item"], kind == "item.completed", top);
            }
            (AdapterKind::Codex, Some("turn.completed" | "turn.failed")) => {
                self.digest.doing = None;
            }
            _ => {}
        }
    }

    fn claude_tool_use(&mut self, block: &Value) {
        let name = block["name"].as_str().unwrap_or("");
        let input = &block["input"];
        let id = block["id"].as_str().unwrap_or("").to_string();
        let text = |key: &str| input[key].as_str().unwrap_or("").to_string();
        let digest = &mut self.digest;
        match name {
            "Edit" | "MultiEdit" | "NotebookEdit" | "Write" => {
                let path = if name == "NotebookEdit" {
                    text("notebook_path")
                } else {
                    text("file_path")
                };
                digest.doing = Some(format!("Editing {}", short_path(&path)));
                self.pending_tools.insert(
                    id,
                    PendingTool::File {
                        path,
                        change: "edited",
                    },
                );
            }
            "Bash" => {
                let command = text("command");
                digest.doing = Some(format!("Running {}", shorten(&command, 120)));
                let index = digest.command(&command);
                self.pending_tools.insert(id, PendingTool::Command(index));
            }
            "Read" => {
                digest.reads += 1;
                digest.doing = Some(format!("Reading {}", short_path(&text("file_path"))));
            }
            "Grep" | "Glob" => {
                digest.searches += 1;
                digest.doing = Some(format!("Searching for {}", shorten(&text("pattern"), 80)));
            }
            "TodoWrite" => {
                if let Some(todos) = input["todos"].as_array() {
                    digest.tasks.clear();
                    for (index, todo) in todos.iter().enumerate() {
                        digest.task(
                            &(index + 1).to_string(),
                            todo["content"].as_str().unwrap_or(""),
                            todo["status"].as_str().unwrap_or("pending"),
                        );
                    }
                }
                digest.doing = Some("Updating its task list".into());
            }
            "TaskCreate" => {
                self.pending_tools
                    .insert(id, PendingTool::TaskCreate(text("subject")));
                digest.doing = Some("Updating its task list".into());
            }
            "TaskUpdate" => {
                let task_id = input["taskId"]
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| input["taskId"].as_u64().map(|n| n.to_string()))
                    .unwrap_or_default();
                if digest.tasks.iter().any(|t| t.id == task_id) {
                    digest.task(&task_id, &text("subject"), &text("status"));
                }
                if let Some(active) = input["activeForm"].as_str() {
                    digest.doing = Some(shorten(active, 120));
                }
            }
            "Task" | "Agent" => {
                digest.doing = Some(format!(
                    "Delegating: {}",
                    shorten(&text("description"), 100)
                ));
            }
            "WebFetch" => digest.doing = Some(format!("Reading {}", shorten(&text("url"), 100))),
            "WebSearch" => {
                digest.doing = Some(format!(
                    "Searching the web for {}",
                    shorten(&text("query"), 80)
                ));
            }
            // Loading deferred tools is housekeeping, not progress.
            "ToolSearch" => {}
            other if other.starts_with("mcp__") => {
                let mut parts = other.trim_start_matches("mcp__").splitn(2, "__");
                let server = parts.next().unwrap_or("");
                let tool = parts.next().unwrap_or("");
                digest.doing = Some(format!("Calling {server} → {tool}"));
            }
            other if !other.is_empty() => digest.doing = Some(format!("Using {other}")),
            _ => {}
        }
    }

    fn claude_tool_result(&mut self, block: &Value, detail: &Value) {
        let Some(id) = block["tool_use_id"].as_str() else {
            return;
        };
        let Some(pending) = self.pending_tools.remove(id) else {
            return;
        };
        let failed = block["is_error"].as_bool() == Some(true);
        let content = match &block["content"] {
            Value::String(text) => text.clone(),
            Value::Array(parts) => parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };
        match pending {
            PendingTool::Command(seq) => {
                if let Some(command) = self.digest.command_mut(seq) {
                    command.status = if failed { "failed" } else { "succeeded" }.into();
                    // Claude reports a failed call's code in its text; a
                    // success carries no code, so none is invented.
                    command.exit_code = failed
                        .then(|| {
                            content
                                .split("Exit code ")
                                .nth(1)
                                .and_then(|rest| rest.split_whitespace().next())
                                .and_then(|code| code.parse().ok())
                        })
                        .flatten();
                }
            }
            PendingTool::File { path, change } if !failed => {
                // A Write result says whether it created the file.
                let change = if detail["type"] == "create" {
                    "added"
                } else {
                    change
                };
                self.digest.file(&path, change);
            }
            PendingTool::File { .. } => {}
            PendingTool::TaskCreate(subject) if !failed => {
                let task_id = detail["task"]["id"]
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| {
                        content
                            .split("Task #")
                            .nth(1)
                            .and_then(|rest| rest.split_whitespace().next())
                            .map(str::to_string)
                    })
                    .unwrap_or_else(|| (self.digest.tasks.len() + 1).to_string());
                self.digest.task(&task_id, &subject, "pending");
            }
            PendingTool::TaskCreate(_) => {}
        }
    }

    /// Codex `exec --json` items. `command_execution` and `file_change` shapes
    /// were checked against Codex 0.166.0 (fixture); `todo_list`,
    /// `mcp_tool_call` and `web_search` follow its documented item types.
    fn codex_item(&mut self, item: &Value, completed: bool, top: bool) {
        let id = item["id"].as_str().unwrap_or("").to_string();
        let digest = &mut self.digest;
        match item["type"].as_str() {
            Some("command_execution") => {
                let command = item["command"].as_str().unwrap_or("");
                let index = match self.pending_tools.get(&id) {
                    Some(PendingTool::Command(index)) if !id.is_empty() => *index,
                    _ => {
                        let index = digest.command(command);
                        if !id.is_empty() {
                            self.pending_tools
                                .insert(id.clone(), PendingTool::Command(index));
                        }
                        index
                    }
                };
                if !completed {
                    digest.doing =
                        Some(format!("Running {}", shorten(&unwrap_shell(command), 120)));
                    return;
                }
                self.pending_tools.remove(&id);
                if let Some(entry) = digest.command_mut(index) {
                    let code = item["exit_code"]
                        .as_i64()
                        .and_then(|c| i32::try_from(c).ok());
                    entry.exit_code = code;
                    entry.status = match (code, item["status"].as_str()) {
                        (Some(0), _) => "succeeded",
                        (Some(_), _) | (None, Some("failed")) => "failed",
                        _ => "unknown",
                    }
                    .into();
                }
            }
            Some("file_change") => {
                let changes = item["changes"].as_array().cloned().unwrap_or_default();
                if !completed {
                    if let Some(path) = changes.first().and_then(|c| c["path"].as_str()) {
                        digest.doing = Some(format!("Editing {}", short_path(path)));
                    }
                    return;
                }
                if item["status"].as_str().is_some_and(|s| s != "completed") {
                    return;
                }
                for change in changes {
                    let kind = match change["kind"].as_str() {
                        Some("add") => "added",
                        Some("delete") => "deleted",
                        _ => "edited",
                    };
                    digest.file(change["path"].as_str().unwrap_or(""), kind);
                }
            }
            Some("todo_list") => {
                if let Some(items) = item["items"].as_array() {
                    digest.tasks.clear();
                    for (index, todo) in items.iter().enumerate() {
                        let status = if todo["completed"].as_bool() == Some(true) {
                            "completed"
                        } else {
                            "pending"
                        };
                        digest.task(
                            &(index + 1).to_string(),
                            todo["text"].as_str().unwrap_or(""),
                            status,
                        );
                    }
                }
            }
            Some("mcp_tool_call") if !completed => {
                digest.doing = Some(format!(
                    "Calling {} → {}",
                    item["server"].as_str().unwrap_or(""),
                    item["tool"].as_str().unwrap_or("")
                ));
            }
            Some("web_search") if !completed => {
                digest.doing = Some(format!(
                    "Searching the web for {}",
                    shorten(item["query"].as_str().unwrap_or(""), 80)
                ));
            }
            Some("agent_message") if completed && top => {
                if let Some(text) = item["text"].as_str().filter(|t| !t.trim().is_empty()) {
                    digest.message = Some(shorten_message(text));
                }
            }
            _ => {}
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
        // Count observable descendant tools, but never replace top-level
        // response, session or token totals with a descendant's envelope.
        self.observe_tools(&value);
        self.digest_event(&value);
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
                let cap = matches!(
                    value["subtype"].as_str(),
                    Some(
                        "error_max_turns"
                            | "error_max_budget_usd"
                            | "error_max_structured_output_retries"
                    )
                ) || value["stop_reason"].as_str() == Some("max_tokens");
                if cap {
                    self.incomplete = true;
                    self.limit_exhausted = true;
                    self.error = Some(format!("CLI stopped before completing required work ({}). Adjust the CLI limit and recover deliberately; extending Orchevia's attempt budget does not change this CLI limit.", value["subtype"].as_str().unwrap_or("max_tokens")));
                } else if value.get("is_error").and_then(Value::as_bool) == Some(true) {
                    // A signed-out or refused CLI puts its reason in `result`
                    // ("Not logged in · Please run /login") with no `errors`.
                    let reason = value.get("errors").map(Value::to_string).or_else(|| {
                        value
                            .get("result")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|text| !text.is_empty())
                            .map(str::to_string)
                    });
                    self.error = Some(
                        reason
                            .unwrap_or_else(|| "CLI reported a failed result.".into())
                            .chars()
                            .take(2000)
                            .collect(),
                    );
                }
                // Refused tools leave `subtype: success`; only this list says
                // the gated work never ran.
                self.permission_denials =
                    claude_denials(value.get("permission_denials").unwrap_or(&Value::Null));
                if !self.permission_denials.is_empty() {
                    let denied = denial_message(&self.permission_denials);
                    self.error = Some(match self.error.take() {
                        Some(previous) => format!("{denied}\n{previous}"),
                        None => denied,
                    });
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
            self.incomplete = true;
            self.error = Some("CLI completed without a response.".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::AdapterKind;

    fn commands(digest: &AgentDigest) -> Vec<(String, String, Option<i32>)> {
        digest
            .commands
            .iter()
            .map(|c| (c.command.clone(), c.status.clone(), c.exit_code))
            .collect()
    }

    #[test]
    fn a_recorded_claude_code_stream_becomes_a_digest() {
        let mut out = AgentOutput::tolerant(AdapterKind::Claude);
        out.push(include_bytes!("fixtures/claude-code-2.1.303-stream.jsonl"));
        out.finish();
        assert!(out.success(), "{:?}", out.error);
        let digest = &out.digest;
        // Written, then edited: still a file this run added.
        assert_eq!(
            digest.files,
            [DigestFile {
                path: "/work/repo/notes.txt".into(),
                change: "added".into()
            }]
        );
        assert_eq!(
            commands(digest),
            [
                ("ls".into(), "succeeded".into(), None),
                ("false".into(), "failed".into(), Some(1)),
            ]
        );
        let tasks: Vec<_> = digest
            .tasks
            .iter()
            .map(|t| (t.id.as_str(), t.status.as_str()))
            .collect();
        assert_eq!(tasks, [("1", "completed"), ("2", "completed")]);
        assert_eq!(digest.tasks[0].text, "Create and edit notes.txt");
        assert_eq!(digest.doing, None, "a finished run is doing nothing");
        assert!(digest.message.as_deref().unwrap().contains("hello world"));
        assert!(!digest.truncated);
    }

    /// The run page reads this exact shape (`src/lib/step-summary.ts`); the
    /// shared file pins it on both sides.
    #[test]
    fn the_digest_shape_matches_the_shared_fixture() {
        let mut out = AgentOutput::tolerant(AdapterKind::Claude);
        out.push(include_bytes!("fixtures/claude-code-2.1.303-stream.jsonl"));
        out.finish();
        let shared: Value =
            serde_json::from_str(include_str!("../../../src/test/agent-digest-claude.json"))
                .expect("shared digest fixture");
        assert_eq!(
            serde_json::to_value(&out.digest).expect("serialize"),
            shared
        );
    }

    #[test]
    fn a_recorded_codex_stream_becomes_a_digest() {
        let mut out = AgentOutput::tolerant(AdapterKind::Codex);
        out.push(include_bytes!("fixtures/codex-0.166.0-stream.jsonl"));
        out.finish();
        assert!(out.success(), "{:?}", out.error);
        let digest = &out.digest;
        assert_eq!(
            digest.files,
            [DigestFile {
                path: "/work/repo/notes.txt".into(),
                change: "added".into()
            }]
        );
        let ran = commands(digest);
        assert!(
            ran.contains(&("ls".into(), "succeeded".into(), Some(0))),
            "{ran:?}"
        );
        assert!(
            ran.contains(&("false".into(), "failed".into(), Some(1))),
            "{ran:?}"
        );
        assert!(
            ran.iter().all(|(c, _, _)| !c.starts_with("/usr/bin/zsh")),
            "the shell wrapper is removed: {ran:?}"
        );
        assert!(ran.iter().all(|(_, status, _)| status != "running"));
        assert_eq!(digest.message.as_deref(), Some("DONE"));
        assert_eq!(digest.doing, None);
    }

    #[test]
    fn a_live_stream_says_what_the_cli_is_doing_now() {
        let mut out = AgentOutput::tolerant(AdapterKind::Claude);
        out.push(b"{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Bash\",\"input\":{\"command\":\"cargo test -p core\"}}]}}\n");
        assert_eq!(
            out.digest.doing.as_deref(),
            Some("Running cargo test -p core")
        );
        assert_eq!(out.digest.commands[0].status, "running");
        assert!(out.digest.commands[0].test);
        out.push(b"{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"is_error\":true,\"content\":\"Exit code 101\\nerror: test failed\"}]}}\n");
        assert_eq!(out.digest.commands[0].status, "failed");
        assert_eq!(out.digest.commands[0].exit_code, Some(101));
        // A refused or failed edit changed nothing, so it is not listed.
        out.push(b"{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"t2\",\"name\":\"Edit\",\"input\":{\"file_path\":\"/r/src/lib.rs\"}}]}}\n");
        assert_eq!(out.digest.doing.as_deref(), Some("Editing src/lib.rs"));
        out.push(b"{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t2\",\"is_error\":true,\"content\":\"denied\"}]}}\n");
        assert!(out.digest.files.is_empty());
        // Codex reports a running command when it starts.
        let mut codex = AgentOutput::tolerant(AdapterKind::Codex);
        codex.push(b"{\"type\":\"item.started\",\"item\":{\"id\":\"c1\",\"type\":\"command_execution\",\"command\":\"bash -lc 'pnpm test'\",\"status\":\"in_progress\"}}\n");
        assert_eq!(codex.digest.doing.as_deref(), Some("Running pnpm test"));
        assert_eq!(codex.digest.commands.len(), 1);
        codex.push(b"{\"type\":\"item.completed\",\"item\":{\"id\":\"c1\",\"type\":\"command_execution\",\"command\":\"bash -lc 'pnpm test'\",\"exit_code\":0,\"status\":\"completed\"}}\n");
        assert_eq!(
            codex.digest.commands.len(),
            1,
            "start and end are one command"
        );
        assert_eq!(codex.digest.commands[0].status, "succeeded");
    }

    #[test]
    fn older_todo_lists_and_codex_todo_items_become_tasks() {
        let mut out = AgentOutput::tolerant(AdapterKind::Claude);
        out.push(b"{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"t\",\"name\":\"TodoWrite\",\"input\":{\"todos\":[{\"content\":\"Fix parser\",\"status\":\"completed\"},{\"content\":\"Add test\",\"status\":\"in_progress\"}]}}]}}\n");
        let tasks: Vec<_> = out
            .digest
            .tasks
            .iter()
            .map(|t| (t.text.as_str(), t.status.as_str()))
            .collect();
        assert_eq!(
            tasks,
            [("Fix parser", "completed"), ("Add test", "in_progress")]
        );
        let mut codex = AgentOutput::tolerant(AdapterKind::Codex);
        codex.push(b"{\"type\":\"item.completed\",\"item\":{\"id\":\"l\",\"type\":\"todo_list\",\"items\":[{\"text\":\"Read code\",\"completed\":true},{\"text\":\"Patch\",\"completed\":false}]}}\n");
        let tasks: Vec<_> = codex
            .digest
            .tasks
            .iter()
            .map(|t| t.status.as_str())
            .collect();
        assert_eq!(tasks, ["completed", "pending"]);
    }

    #[test]
    fn the_digest_stays_bounded_and_keeps_test_runs() {
        let mut out = AgentOutput::tolerant(AdapterKind::Codex);
        out.push(b"{\"type\":\"item.completed\",\"item\":{\"id\":\"t\",\"type\":\"command_execution\",\"command\":\"cargo test\",\"exit_code\":0}}\n");
        for n in 0..200 {
            out.push(format!("{{\"type\":\"item.completed\",\"item\":{{\"id\":\"c{n}\",\"type\":\"command_execution\",\"command\":\"echo {n}\",\"exit_code\":0}}}}\n{{\"type\":\"item.completed\",\"item\":{{\"id\":\"f{n}\",\"type\":\"file_change\",\"status\":\"completed\",\"changes\":[{{\"path\":\"/r/f{n}.txt\",\"kind\":\"update\"}}]}}}}\n").as_bytes());
        }
        let digest = &out.digest;
        assert!(digest.truncated);
        assert_eq!(digest.commands.len(), MAX_DIGEST_COMMANDS);
        assert_eq!(digest.files.len(), MAX_DIGEST_FILES);
        assert!(digest
            .commands
            .iter()
            .any(|c| c.command == "cargo test" && c.test));
        assert_eq!(digest.commands.last().unwrap().command, "echo 199");
    }

    #[test]
    fn a_late_result_never_lands_on_another_command_after_the_cap() {
        let mut out = AgentOutput::tolerant(AdapterKind::Claude);
        out.push(b"{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"slow\",\"name\":\"Bash\",\"input\":{\"command\":\"sleep 5\"}}]}}\n");
        for n in 0..70 {
            out.push(format!("{{\"type\":\"assistant\",\"message\":{{\"content\":[{{\"type\":\"tool_use\",\"id\":\"c{n}\",\"name\":\"Bash\",\"input\":{{\"command\":\"echo {n}\"}}}}]}}}}\n{{\"type\":\"user\",\"message\":{{\"content\":[{{\"type\":\"tool_result\",\"tool_use_id\":\"c{n}\",\"is_error\":false,\"content\":\"{n}\"}}]}}}}\n").as_bytes());
        }
        // The slow command was dropped to stay bounded; its failure is not
        // pinned on whichever command took its place.
        out.push(b"{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"slow\",\"is_error\":true,\"content\":\"Exit code 2\"}]}}\n");
        assert!(out.digest.truncated);
        assert!(out.digest.commands.iter().all(|c| c.status == "succeeded"));
    }

    #[test]
    fn test_runs_match_the_shared_list() {
        let shared: Value =
            serde_json::from_str(include_str!("../../../src/test/test-commands.json"))
                .expect("shared test commands");
        for command in shared["tests"].as_array().expect("tests") {
            let command = command.as_str().unwrap_or("");
            assert!(is_test_command(command), "{command}");
        }
        for command in shared["other"].as_array().expect("other") {
            let command = command.as_str().unwrap_or("");
            assert!(!is_test_command(command), "{command}");
        }
        assert_eq!(unwrap_shell("/usr/bin/zsh -lc 'ls -la'"), "ls -la");
        assert_eq!(unwrap_shell("bash -c \"cargo test\""), "cargo test");
        assert_eq!(unwrap_shell("git status"), "git status");
        assert_eq!(short_path("/a/b/c/d.rs"), "c/d.rs");
    }

    #[test]
    fn review_usage_codex_subagent_observation_stays_unknown() {
        let mut out = AgentOutput::new(AdapterKind::Codex);
        out.push(b"{\"type\":\"item.completed\",\"item\":{\"id\":\"tool-1\",\"type\":\"command_execution\"}}\n{\"type\":\"item.completed\",\"item\":{\"id\":\"tool-1\",\"type\":\"command_execution\"}}\n{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"done\"}}\n{\"type\":\"turn.completed\",\"usage\":{}}\n");
        out.finish();
        assert_eq!(out.usage["observed_tool_calls"], 1);
        assert!(out.usage.get("observed_subagents").is_none());
    }

    #[test]
    fn review_usage_claude_observes_current_agent_tool_and_empty_complete_turn() {
        let mut out = AgentOutput::new(AdapterKind::Claude);
        out.push(b"{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"agent-1\",\"name\":\"Agent\"}]}}\n{\"type\":\"result\",\"is_error\":false,\"result\":\"done\",\"usage\":{}}\n");
        out.finish();
        assert_eq!(out.usage["observed_subagents"], 1);
        let mut empty = AgentOutput::new(AdapterKind::Claude);
        empty.push(b"{\"type\":\"result\",\"is_error\":false,\"result\":\"done\",\"usage\":{}}\n");
        empty.finish();
        assert_eq!(empty.usage["observed_tool_calls"], 0);
        assert_eq!(empty.usage["observed_subagents"], 0);
    }

    #[test]
    fn review_usage_descendant_tools_count_without_replacing_parent_totals() {
        let mut out = AgentOutput::new(AdapterKind::Claude);
        out.push(b"{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"task-1\",\"name\":\"Agent\"}]}}\n{\"type\":\"assistant\",\"parent_tool_use_id\":\"task-1\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"child-read\",\"name\":\"Read\"}]}}\n{\"type\":\"result\",\"parent_tool_use_id\":\"task-1\",\"result\":\"child\",\"usage\":{\"input_tokens\":999}}\n{\"type\":\"result\",\"is_error\":false,\"result\":\"parent\",\"usage\":{\"input_tokens\":10}}\n");
        out.finish();
        assert_eq!(out.text.as_deref(), Some("parent"));
        assert_eq!(out.usage["input_tokens"], 10);
        assert_eq!(out.usage["observed_tool_calls"], 2);
        assert_eq!(out.usage["observed_subagents"], 1);
    }

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
    fn a_failed_result_without_errors_keeps_its_reason() {
        let mut out = AgentOutput::tolerant(AdapterKind::Claude);
        out.push(b"{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":true,\"result\":\"Not logged in \xc2\xb7 Please run /login\"}\n");
        out.finish();
        assert!(!out.success());
        assert_eq!(
            out.error.as_deref(),
            Some("Not logged in · Please run /login")
        );
        let mut bare = AgentOutput::tolerant(AdapterKind::Claude);
        bare.push(b"{\"type\":\"result\",\"is_error\":true}\n");
        bare.finish();
        assert_eq!(bare.error.as_deref(), Some("CLI reported a failed result."));
    }

    #[test]
    fn refused_tools_fail_a_result_that_claims_success() {
        let mut out = AgentOutput::tolerant(AdapterKind::Claude);
        out.push(b"{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"TICKET_STATUS=none\",\"usage\":{},\"permission_denials\":[{\"tool_name\":\"mcp__jira__getIssue\",\"tool_use_id\":\"t1\",\"tool_input\":{}}]}\n");
        out.finish();
        assert!(!out.success());
        assert!(
            !out.incomplete,
            "a refusal is an ordinary failure, not a cap"
        );
        assert_eq!(out.text.as_deref(), Some("TICKET_STATUS=none"));
        assert_eq!(out.permission_denials.len(), 1);
        assert_eq!(out.permission_denials[0].rules, ["mcp__jira"]);
        assert!(out
            .error
            .as_deref()
            .unwrap()
            .contains("allow with mcp__jira"));

        // An explicit CLI error is kept after the refusal summary.
        let mut both = AgentOutput::new(AdapterKind::Claude);
        both.push(b"{\"type\":\"result\",\"is_error\":true,\"errors\":[\"boom\"],\"permission_denials\":[{\"tool_name\":\"Write\"}]}\n");
        both.finish();
        let error = both.error.unwrap();
        assert!(error.starts_with("Claude refused 1 tool call "), "{error}");
        assert!(error.ends_with("[\"boom\"]"), "{error}");

        // An empty list changes nothing.
        let mut clean = AgentOutput::new(AdapterKind::Claude);
        clean.push(b"{\"type\":\"result\",\"is_error\":false,\"result\":\"ok\",\"usage\":{},\"permission_denials\":[]}\n");
        clean.finish();
        assert!(clean.success());
        assert!(clean.permission_denials.is_empty());
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
