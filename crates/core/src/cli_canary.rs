//! CLI canary: the newest Claude Code and Codex, signed out, against every
//! argument list Orchevia builds for them.
//!
//! The argument lists come from the builders the engine and workflow
//! generation use ([`build_agent_command`], [`build_text_agent_command`],
//! [`build_session_command`] and [`crate::generation::generator_command`]),
//! with every permission level and effort a profile can hold, so the canary
//! cannot drift from what Orchevia really sends. Every run must be accepted:
//! no refused or ignored argument. The output Orchevia reads without an
//! account must still read the same way: the `--version` line through
//! [`crate::tools::version_line`], and the structured stream through
//! Orchevia's own decoder, including a resumed session that reports the same
//! id.
//!
//! The live checks are ignored by default. `.github/workflows/cli-canary.yml`
//! runs them weekly against the latest npm releases; locally they use any
//! installed copies:
//!
//! ```text
//! ORCHEVIA_CANARY_CLAUDE=$(command -v claude) ORCHEVIA_CANARY_CODEX=$(command -v codex) \
//!   cargo test -p orchevia-core --lib cli_canary -- --ignored --nocapture
//! ```
//!
//! Each CLI runs with a cleared environment (only `PATH` is kept), an empty
//! temporary home folder and a new git repository as its working directory,
//! so no account, credential or setting of whoever runs it is read or changed.
//! Claude Code stops before any request; signed-out Codex sends requests that
//! fail with 401 and retries them for about 15 seconds per run.

use crate::agent_output::AgentOutput;
use crate::agents::{
    build_agent_command, build_session_command, build_text_agent_command, AdapterKind, AgentEffort,
    AgentProfile, PermissionLevel, WorkingDirMode,
};
use crate::process::{CommandSpec, ProcessGroup, ProcessResult};
use std::io::{Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};

const PROMPT: &str = "Reply with the single word OK.";
/// Signed-out Codex retries for about 15 seconds; leave room for slow runners.
const RUN_TIMEOUT: Duration = Duration::from_secs(180);
const ALLOWED_TOOLS: [&str; 3] = ["Edit", "Bash(git status *)", "mcp__jira"];

/// Phrases with which a CLI refuses part of its command line.
const REFUSALS: [&str; 12] = [
    "unknown option",
    "unexpected argument",
    "unrecognized",
    "invalid value",
    "is invalid",
    "unknown argument",
    "unknown flag",
    "unknown command",
    "unknown subcommand",
    "missing required",
    "too many arguments",
    "requires a value",
];
/// Words that mean a refusal or deprecation when the line names one of the
/// arguments Orchevia passed (other warnings are not about Orchevia).
const WARNINGS: [&str; 8] = [
    "unknown",
    "invalid",
    "deprecated",
    "no longer",
    "not supported",
    "unsupported",
    "ignoring",
    "ignored",
];
/// Signs that a text-mode run got past its arguments to the sign-in check.
const SIGN_IN: [&str; 9] = [
    "log in",
    "logged in",
    "login",
    "sign in",
    "signed in",
    "unauthorized",
    "401",
    "authentication",
    "api key",
];

/// How Orchevia reads a run's stdout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reading {
    /// Plain text: profiles that choose their own output format, and
    /// workflow generation.
    Text,
    /// Structured events, tolerating stray lines (ordinary Agent nodes).
    Events,
    /// Structured events only (session group turns).
    SessionEvents,
}

#[derive(Debug, Clone)]
struct Invocation {
    label: String,
    spec: CommandSpec,
    reading: Reading,
    /// The session a resumed turn must report; Orchevia drops the
    /// conversation when the CLI answers with another one.
    resumes: Option<String>,
}

/// What a finished or stopped run printed.
#[derive(Debug, Default)]
struct Output {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

fn level_name(level: PermissionLevel) -> &'static str {
    match level {
        PermissionLevel::AppDefault => "app default",
        PermissionLevel::CliSettings => "CLI settings",
        PermissionLevel::AllowedTools => "allowed tools",
        PermissionLevel::FullAccess => "full access",
    }
}

/// A profile as a user could save it. A struct literal on purpose: a new
/// profile field does not compile here until the canary covers it.
fn profile(
    adapter: AdapterKind,
    executable: &str,
    level: PermissionLevel,
    effort: Option<&str>,
) -> AgentProfile {
    AgentProfile {
        id: format!("canary-{}", adapter.as_str()),
        name: format!("{} canary", adapter.display_name()),
        adapter,
        executable: Some(executable.to_string()),
        model: Some(
            match adapter {
                AdapterKind::Codex => "gpt-5-codex",
                _ => "sonnet",
            }
            .to_string(),
        ),
        effort: effort.map(str::to_string),
        extra_args: Vec::new(),
        skills: Vec::new(),
        working_dir_mode: WorkingDirMode::Node,
        working_dir: None,
        default_timeout_secs: 600,
        role: None,
        permission_level: level,
        allowed_tools: if level == PermissionLevel::AllowedTools {
            ALLOWED_TOOLS.iter().map(|rule| rule.to_string()).collect()
        } else {
            Vec::new()
        },
    }
}

/// Add an invocation; one that repeats an earlier argument list only adds its
/// label there.
fn push(
    list: &mut Vec<Invocation>,
    label: String,
    spec: Result<CommandSpec, String>,
    reading: Reading,
) {
    let spec = spec.unwrap_or_else(|error| panic!("{label}: Orchevia could not build it: {error}"));
    if let Some(same) = list
        .iter_mut()
        .find(|known| known.spec.args == spec.args && known.reading == reading)
    {
        same.label = format!("{}; {label}", same.label);
        return;
    }
    list.push(Invocation {
        label,
        spec,
        reading,
        resumes: None,
    });
}

/// Every one-shot command Orchevia builds for `adapter`: Agent nodes at each
/// permission level a profile can hold and at each effort, the text
/// invocation and workflow generation.
fn invocations(adapter: AdapterKind, executable: &str, repo: &str) -> Vec<Invocation> {
    let mut list = Vec::new();
    for level in [
        PermissionLevel::CliSettings,
        PermissionLevel::AllowedTools,
        PermissionLevel::FullAccess,
    ] {
        let profile = profile(adapter, executable, level, None);
        // Profile validation decides which levels the CLI offers.
        if profile.validate().is_empty() {
            push(
                &mut list,
                format!("Agent node, {}", level_name(level)),
                build_agent_command(&profile, PROMPT, Some(repo)),
                Reading::Events,
            );
        }
    }
    for effort in AgentEffort::allowed() {
        let profile = profile(
            adapter,
            executable,
            PermissionLevel::CliSettings,
            Some(&effort),
        );
        push(
            &mut list,
            format!("Agent node, {effort} effort"),
            build_agent_command(&profile, PROMPT, Some(repo)),
            Reading::Events,
        );
    }
    let plain = profile(adapter, executable, PermissionLevel::CliSettings, None);
    push(
        &mut list,
        "text output".into(),
        build_text_agent_command(&plain, PROMPT, Some(repo)),
        Reading::Text,
    );
    push(
        &mut list,
        "workflow generation".into(),
        crate::generation::generator_command(&plain, PROMPT, Some(repo)),
        Reading::Text,
    );
    if adapter == AdapterKind::Claude {
        // A profile that sets its own input format gets the prompt as an argument.
        let mut own_input = plain;
        own_input.extra_args = vec!["--input-format".into(), "text".into()];
        push(
            &mut list,
            "Agent node, prompt as an argument".into(),
            build_agent_command(&own_input, PROMPT, Some(repo)),
            Reading::Text,
        );
    }
    list
}

/// A session group turn: the first one, or one resuming `resume`.
fn session_turn(
    adapter: AdapterKind,
    executable: &str,
    repo: &str,
    resume: Option<&str>,
) -> Invocation {
    let profile = profile(adapter, executable, PermissionLevel::CliSettings, None);
    let label = if resume.is_some() {
        "session group, resumed turn"
    } else {
        "session group, first turn"
    };
    let spec = build_session_command(&profile, PROMPT, Some(repo), resume)
        .unwrap_or_else(|error| panic!("{label}: Orchevia could not build it: {error}"));
    Invocation {
        label: label.into(),
        spec,
        reading: Reading::SessionEvents,
        resumes: resume.map(str::to_string),
    }
}

/// Whether `line` is a structured event as Orchevia's decoder expects it.
fn is_event(line: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()
        .is_some_and(|value| value.get("type").and_then(|kind| kind.as_str()).is_some())
}

/// Whether `word` appears in `line` on its own, not inside a longer flag or word.
fn mentions(line: &str, word: &str) -> bool {
    let part = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    line.match_indices(word).any(|(at, _)| {
        !line[..at].chars().next_back().is_some_and(part)
            && !line[at + word.len()..].chars().next().is_some_and(part)
    })
}

/// The arguments `line` names: flags, subcommands, `-c` keys and values.
/// Prompts, ids shorter than three characters and `-` are left out.
fn named(line: &str, args: &[String]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for arg in args {
        let candidates = [Some(arg.as_str()), arg.split_once('=').map(|(key, _)| key)];
        for word in candidates.into_iter().flatten() {
            let usable = !word.contains(char::is_whitespace)
                && (word.len() >= 3 || (word.len() == 2 && word.starts_with('-')));
            if usable && mentions(line, word) && !found.iter().any(|known| known == word) {
                found.push(word.to_string());
            }
        }
    }
    found
}

/// Lines in which the CLI refused or ignored part of its command line, each
/// naming the arguments involved.
fn refusals(output: &Output, args: &[String]) -> Vec<String> {
    output
        .stderr
        .lines()
        .chain(output.stdout.lines())
        .map(str::trim)
        .filter(|line| !line.is_empty() && !is_event(line))
        .filter_map(|line| {
            let lower = line.to_ascii_lowercase();
            let names = named(line, args);
            let refused = REFUSALS.iter().any(|phrase| lower.contains(phrase))
                || (!names.is_empty() && WARNINGS.iter().any(|word| lower.contains(word)));
            refused.then(|| {
                if names.is_empty() {
                    format!("refused its command line: {line}")
                } else {
                    format!("refused {}: {line}", names.join(", "))
                }
            })
        })
        .collect()
}

fn tail(text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    lines[lines.len().saturating_sub(8)..].join("\n")
}

/// Problems with one run (none when the CLI accepted the command and Orchevia
/// reads its output), and the session id Orchevia read from it.
fn assess(
    adapter: AdapterKind,
    invocation: &Invocation,
    output: &Output,
) -> (Vec<String>, Option<String>) {
    let refused = refusals(output, &invocation.spec.args);
    if !refused.is_empty() {
        return (refused, None);
    }
    if output.timed_out {
        return (
            vec![format!(
                "did not finish within {} seconds",
                RUN_TIMEOUT.as_secs()
            )],
            None,
        );
    }
    let mut problems = Vec::new();
    if invocation.reading == Reading::Text {
        let lower = format!("{}\n{}", output.stdout, output.stderr).to_ascii_lowercase();
        if output.stdout.trim().is_empty() && !SIGN_IN.iter().any(|word| lower.contains(word)) {
            problems.push(format!(
                "printed no answer and no sign-in failure (exit code {:?}), so it never \
                 reached the model call:\n{}",
                output.code,
                tail(&output.stderr)
            ));
        }
        return (problems, None);
    }
    let session = invocation.reading == Reading::SessionEvents;
    if session {
        for (number, line) in output.stdout.lines().enumerate() {
            if !line.trim().is_empty() && !is_event(line) {
                let line: String = line.chars().take(200).collect();
                problems.push(format!(
                    "stdout line {} is not a JSON event, which fails every session turn: {line}",
                    number + 1
                ));
            }
        }
    }
    let mut decoder = if session {
        AgentOutput::new(adapter)
    } else {
        AgentOutput::tolerant(adapter)
    };
    decoder.push(output.stdout.as_bytes());
    // An error at this point came from an event the decoder understood.
    let reported_error = decoder.error.is_some();
    decoder.finish();
    if decoder.incomplete && !reported_error {
        problems.push(format!(
            "the output has no final event Orchevia recognises (Claude `result`; Codex \
             `turn.completed`, `turn.failed` or `error`), so every run would end as \
             incomplete:\n{}",
            tail(&format!("{}\n{}", output.stdout, output.stderr))
        ));
    }
    if session && decoder.session_id.is_none() {
        problems.push(
            "reported no session id, so session groups could not continue the conversation".into(),
        );
    }
    if let Some(expected) = invocation.resumes.as_deref() {
        if decoder.session_id.as_deref() != Some(expected) {
            problems.push(format!(
                "resumed session {:?} instead of {expected}, so Orchevia would drop the \
                 conversation",
                decoder.session_id
            ));
        }
    }
    (problems, decoder.session_id)
}

/// The version Orchevia would show, or why it would show none.
fn assess_version(args: &[String], output: &Output) -> Result<String, String> {
    let command = args.join(" ");
    if output.timed_out {
        return Err(format!(
            "`{command}` took longer than Orchevia's {}-second probe, so Environment \
             would show no version",
            crate::tools::VERSION_PROBE_TIMEOUT.as_secs()
        ));
    }
    let shown = crate::tools::version_line(&ProcessResult {
        exit_code: output.code,
        stdout: output.stdout.clone(),
        stderr: output.stderr.clone(),
        duration_ms: 0,
        timed_out: output.timed_out,
    })
    .ok_or_else(|| {
        format!(
            "`{command}` exited with {:?} and printed nothing Orchevia shows as a version:\n{}",
            output.code,
            tail(&output.stderr)
        )
    })?;
    let numbered = shown.as_bytes().windows(3).any(|window| {
        window[0].is_ascii_digit() && window[1] == b'.' && window[2].is_ascii_digit()
    });
    if numbered {
        Ok(shown)
    } else {
        Err(format!(
            "`{command}` printed {shown:?} first, which has no version number"
        ))
    }
}

/// Run `spec` with a cleared environment (only `PATH` is kept) and `home` as
/// its home folder, stopping its process group after `timeout`.
fn run(spec: &CommandSpec, home: &Path, timeout: Duration) -> Output {
    let mut command = std::process::Command::new(&spec.executable);
    command.args(&spec.args).env_clear().env("HOME", home);
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    if let Some(dir) = &spec.working_dir {
        command.current_dir(dir);
    }
    command
        .stdin(if spec.stdin.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::process::isolate_process_group(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Output {
                stderr: format!("could not start {}: {error}", spec.executable),
                ..Output::default()
            }
        }
    };
    let group = ProcessGroup::new(Some(child.id()));
    if let (Some(input), Some(mut pipe)) = (spec.stdin.clone(), child.stdin.take()) {
        std::thread::spawn(move || {
            let _ = pipe.write_all(input.as_bytes());
        });
    }
    fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::sync::mpsc::Receiver<String> {
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            let _ = sender.send(String::from_utf8_lossy(&bytes).into_owned());
        });
        receiver
    }
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let deadline = Instant::now() + timeout;
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => {
                timed_out = true;
                group.kill();
                let _ = child.kill();
                break child.wait().ok();
            }
        }
    };
    // Dropping the group stops helpers left behind, which closes the pipes.
    drop(group);
    let collect = |receiver: std::sync::mpsc::Receiver<String>| {
        receiver
            .recv_timeout(Duration::from_secs(5))
            .unwrap_or_default()
    };
    Output {
        code: status.and_then(|status| status.code()),
        stdout: collect(stdout),
        stderr: collect(stderr),
        timed_out,
    }
}

/// The executable named by `variable`, else the CLI's default name on `PATH`.
fn locate(adapter: AdapterKind, variable: &str) -> String {
    if let Some(path) = std::env::var_os(variable).filter(|path| !path.is_empty()) {
        return path.to_string_lossy().into_owned();
    }
    std::env::var_os("PATH")
        .and_then(|paths| {
            std::env::split_paths(&paths)
                .map(|dir| dir.join(adapter.default_executable()))
                .find(|path| crate::tools::is_executable_file(path))
        })
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| {
            panic!(
                "{} was not found: set {variable} to its executable or put `{}` on PATH",
                adapter.display_name(),
                adapter.default_executable()
            )
        })
}

/// Escape a workflow command value for GitHub Actions (`::error::`).
fn escape_annotation(text: &str, property: bool) -> String {
    let escaped = text
        .replace('%', "%25")
        .replace('\r', "%0D")
        .replace('\n', "%0A");
    if property {
        escaped.replace(':', "%3A").replace(',', "%2C")
    } else {
        escaped
    }
}

/// Check one CLI end to end and fail with every problem found.
fn check_cli(adapter: AdapterKind, variable: &str) {
    let executable = locate(adapter, variable);
    let cli = adapter.display_name();
    let root = tempfile::tempdir().expect("temporary folder");
    let home = root.path().join("home");
    let repo = root.path().join("repo");
    std::fs::create_dir_all(&home).expect("home folder");
    std::fs::create_dir_all(&repo).expect("repository folder");
    // Codex works only inside a repository it trusts, as Orchevia's nodes do.
    let init = run(
        &CommandSpec {
            executable: "git".into(),
            args: vec!["init".into(), "-q".into()],
            working_dir: Some(repo.to_string_lossy().into_owned()),
            stdin: None,
        },
        &home,
        Duration::from_secs(30),
    );
    assert_eq!(init.code, Some(0), "git init failed: {}", init.stderr);
    let repo = repo.to_string_lossy().into_owned();

    let mut problems: Vec<String> = Vec::new();
    let mut checked: Vec<String> = Vec::new();
    let version_args = crate::tools::default_tools()
        .into_iter()
        .find(|tool| tool.id == adapter.as_str())
        .map(|tool| tool.version_args)
        .expect("Environment probes this CLI");
    let probe = CommandSpec {
        executable: executable.clone(),
        args: version_args.clone(),
        working_dir: None,
        stdin: None,
    };
    // A cold first start on a fresh runner is not what Environment sees.
    let _ = run(&probe, &home, RUN_TIMEOUT);
    let mut shown_args = vec![adapter.default_executable().to_string()];
    shown_args.extend(version_args);
    let version = match assess_version(
        &shown_args,
        &run(&probe, &home, crate::tools::VERSION_PROBE_TIMEOUT),
    ) {
        Ok(version) => version,
        Err(problem) => {
            problems.push(format!("version probe: {problem}"));
            "(version unknown)".into()
        }
    };

    let mut pending = invocations(adapter, &executable, &repo);
    pending.push(session_turn(adapter, &executable, &repo, None));
    let mut index = 0;
    while index < pending.len() {
        let invocation = pending[index].clone();
        index += 1;
        let started = Instant::now();
        let output = run(&invocation.spec, &home, RUN_TIMEOUT);
        let (found, session) = assess(adapter, &invocation, &output);
        let preview = CommandSpec {
            executable: adapter.default_executable().into(),
            ..invocation.spec.clone()
        }
        .preview();
        checked.push(format!(
            "{} {} ({:.1} s): {preview}",
            if found.is_empty() { "ok    " } else { "FAILED" },
            invocation.label,
            started.elapsed().as_secs_f32()
        ));
        for problem in found {
            problems.push(format!(
                "{}: {problem}\n  command: {preview}",
                invocation.label
            ));
        }
        if invocation.reading == Reading::SessionEvents && invocation.resumes.is_none() {
            match session {
                Some(id) => pending.push(session_turn(adapter, &executable, &repo, Some(&id))),
                None => problems.push(
                    "session group, resumed turn: not checked, the first turn reported no \
                     session id"
                        .into(),
                ),
            }
        }
    }

    println!(
        "{cli} {version} ({executable})\n{}",
        checked
            .iter()
            .map(|line| format!("  {line}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    if std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true") {
        for problem in &problems {
            println!(
                "::error title={}::{}",
                escape_annotation(&format!("{cli} {version}"), true),
                escape_annotation(problem, false)
            );
        }
    }
    assert!(
        problems.is_empty(),
        "{cli} {version} no longer works the way Orchevia uses it:\n- {}",
        problems.join("\n- ")
    );
}

#[test]
#[ignore = "runs the installed Claude Code; see the module documentation"]
fn live_claude_code_accepts_what_orchevia_sends() {
    check_cli(AdapterKind::Claude, "ORCHEVIA_CANARY_CLAUDE");
}

#[test]
#[ignore = "runs the installed Codex; see the module documentation"]
fn live_codex_accepts_what_orchevia_sends() {
    check_cli(AdapterKind::Codex, "ORCHEVIA_CANARY_CODEX");
}

// Output captured from Claude Code 2.1.312 and Codex 0.165.0, signed out,
// trimmed to the fields Orchevia reads.
const CLAUDE_SESSION: &str = "6faec563-6fae-4324-bd64-76a171379d3d";
const CLAUDE_SIGNED_OUT: &str = r#"{"type":"system","subtype":"init","cwd":"/tmp/repo","session_id":"6faec563-6fae-4324-bd64-76a171379d3d","model":"claude-sonnet","permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.312"}
{"type":"assistant","message":{"model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"Not logged in · Please run /login"}]},"parent_tool_use_id":null,"session_id":"6faec563-6fae-4324-bd64-76a171379d3d","error":"authentication_failed"}
{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","session_id":"6faec563-6fae-4324-bd64-76a171379d3d","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"permission_denials":[]}
"#;
const CODEX_SESSION: &str = "01a188ec-7181-7e11-8454-e3635dc14f67";
const CODEX_SIGNED_OUT: &str = r#"{"type":"thread.started","thread_id":"01a188ec-7181-7e11-8454-e3635dc14f67"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `gpt-5-codex` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}
{"type":"turn.started"}
{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses)"}
{"type":"error","message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses"}
{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses"}}
"#;
const CODEX_STDERR: &str = "WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir \"/tmp\"\n2026-10-29T18:29:19.407678Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses\n";

fn output(code: i32, stdout: &str, stderr: &str) -> Output {
    Output {
        code: Some(code),
        stdout: stdout.into(),
        stderr: stderr.into(),
        timed_out: false,
    }
}

fn args(line: &str) -> Vec<String> {
    line.split(' ').map(str::to_string).collect()
}

#[test]
fn refusals_name_the_argument_and_skip_unrelated_noise() {
    let claude = args("-p --output-format stream-json --verbose --model sonnet --effort xhigh");
    for (stderr, expected) in [
        ("Error: unknown option '--verbose'", "refused --verbose:"),
        (
            "error: option '--output-format <format>' argument 'stream-json' is invalid. \
             Allowed choices are text, json.",
            "refused --output-format, stream-json:",
        ),
        (
            "Warning: Unknown --effort value 'xhigh' — ignoring it and using the default \
             effort. Valid values: low, medium, high, max.",
            "refused --effort, xhigh:",
        ),
        (
            "Warning: --verbose is deprecated with --output-format stream-json",
            "refused --output-format, stream-json, --verbose:",
        ),
    ] {
        let found = refusals(&output(1, "", stderr), &claude);
        assert_eq!(found.len(), 1, "{stderr}");
        assert!(found[0].starts_with(expected), "{}", found[0]);
    }
    let codex =
        args("exec --json --model gpt-5-codex resume 01a188ec-7181-7e11-8454-e3635dc14f67 -");
    let found = refusals(
        &output(2, "", "error: unexpected argument '--json' found\n\n  tip: to pass '--json' as a value, use '-- --json'\n\nUsage: codex exec [OPTIONS] [PROMPT]"),
        &codex,
    );
    assert_eq!(found.len(), 1, "{found:?}");
    assert!(found[0].starts_with("refused --json:"), "{}", found[0]);
    let found = refusals(
        &output(2, "", "error: unrecognized subcommand 'resume'"),
        &codex,
    );
    assert!(found[0].starts_with("refused resume:"), "{}", found[0]);
    // Unnamed refusals are still reported.
    let found = refusals(&output(1, "", "error: too many arguments"), &codex);
    assert!(
        found[0].starts_with("refused its command line:"),
        "{found:?}"
    );

    // Sign-in failures, transport noise, JSON events and runtime warnings that
    // name nothing Orchevia passed are not refusals.
    for (stdout, stderr) in [
        (CLAUDE_SIGNED_OUT, ""),
        ("Not logged in · Please run /login", ""),
        (CODEX_SIGNED_OUT, CODEX_STDERR),
        (
            "",
            "ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication",
        ),
        (
            "",
            "(node:812) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.",
        ),
    ] {
        assert!(
            refusals(&output(1, stdout, stderr), &claude).is_empty(),
            "{stderr}"
        );
        assert!(
            refusals(&output(1, stdout, stderr), &codex).is_empty(),
            "{stderr}"
        );
    }
    // `-p` inside `--permission-mode` and a value inside a longer word are not mentions.
    assert!(named("unknown --permission-mode", &args("-p")).is_empty());
    assert!(named("an invalid highway", &args("--effort high")).is_empty());
    assert_eq!(
        named(
            "warning: model_reasoning_effort is deprecated",
            &args("-c model_reasoning_effort=\"high\"")
        ),
        ["model_reasoning_effort"]
    );
}

#[test]
fn signed_out_streams_read_the_way_orchevia_reads_them() {
    let check = |adapter: AdapterKind, reading: Reading, resumes: Option<&str>, out: &Output| {
        let invocation = Invocation {
            label: "check".into(),
            spec: CommandSpec {
                executable: adapter.default_executable().into(),
                args: Vec::new(),
                working_dir: None,
                stdin: None,
            },
            reading,
            resumes: resumes.map(str::to_string),
        };
        assess(adapter, &invocation, out)
    };
    for reading in [Reading::Events, Reading::SessionEvents] {
        let (problems, session) = check(
            AdapterKind::Claude,
            reading,
            None,
            &output(1, CLAUDE_SIGNED_OUT, ""),
        );
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(session.as_deref(), Some(CLAUDE_SESSION));
        let (problems, session) = check(
            AdapterKind::Codex,
            reading,
            None,
            &output(1, CODEX_SIGNED_OUT, CODEX_STDERR),
        );
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(session.as_deref(), Some(CODEX_SESSION));
    }
    let resumed = check(
        AdapterKind::Codex,
        Reading::SessionEvents,
        Some(CODEX_SESSION),
        &output(1, CODEX_SIGNED_OUT, ""),
    );
    assert!(resumed.0.is_empty(), "{:?}", resumed.0);
    let other = check(
        AdapterKind::Claude,
        Reading::SessionEvents,
        Some("00000000-0000-4000-8000-000000000001"),
        &output(1, CLAUDE_SIGNED_OUT, ""),
    );
    assert!(other.0[0].contains("instead of 00000000-"), "{:?}", other.0);

    // A stream without a final event, a stray line in a session and a
    // missing session id are each explained.
    let unfinished = CLAUDE_SIGNED_OUT
        .lines()
        .take(2)
        .collect::<Vec<_>>()
        .join("\n");
    let (problems, _) = check(
        AdapterKind::Claude,
        Reading::Events,
        None,
        &output(1, &unfinished, ""),
    );
    assert!(problems[0].contains("no final event"), "{problems:?}");
    let stray = format!("wrapper: starting\n{CLAUDE_SIGNED_OUT}");
    let (problems, _) = check(
        AdapterKind::Claude,
        Reading::Events,
        None,
        &output(1, &stray, ""),
    );
    assert!(
        problems.is_empty(),
        "ordinary nodes tolerate it: {problems:?}"
    );
    let (problems, _) = check(
        AdapterKind::Claude,
        Reading::SessionEvents,
        None,
        &output(1, &stray, ""),
    );
    assert!(
        problems[0].starts_with("stdout line 1 is not a JSON event"),
        "{problems:?}"
    );
    let anonymous = CODEX_SIGNED_OUT
        .lines()
        .skip(1)
        .collect::<Vec<_>>()
        .join("\n");
    let (problems, _) = check(
        AdapterKind::Codex,
        Reading::SessionEvents,
        None,
        &output(1, &anonymous, ""),
    );
    assert_eq!(problems.len(), 1, "{problems:?}");
    assert!(problems[0].contains("no session id"));

    // Text runs need an answer or a sign-in failure, and refusals come first.
    let text = |out: &Output| check(AdapterKind::Codex, Reading::Text, None, out).0;
    assert!(text(&output(1, "Not logged in · Please run /login\n", "")).is_empty());
    assert!(text(&output(
        1,
        "",
        "ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication"
    ))
    .is_empty());
    assert!(text(&output(1, "", "panicked at main.rs:12"))[0].contains("never reached"));
    let timed_out = Output {
        timed_out: true,
        ..Output::default()
    };
    assert!(text(&timed_out)[0].contains("did not finish"));
}

#[test]
fn version_probes_explain_what_environment_would_show() {
    let probe = args("claude --version");
    assert_eq!(
        assess_version(&probe, &output(0, "2.1.312 (Claude Code)\n", "")).as_deref(),
        Ok("2.1.312 (Claude Code)")
    );
    // Codex warns on stderr; stdout comes first, as in Environment.
    assert_eq!(
        assess_version(&probe, &output(0, "codex-cli 0.165.0\n", CODEX_STDERR)).as_deref(),
        Ok("codex-cli 0.165.0")
    );
    let timed_out = Output {
        timed_out: true,
        ..Output::default()
    };
    for (out, reason) in [
        (timed_out, "longer than Orchevia's 5-second probe"),
        (
            output(1, "", "error: unknown option"),
            "exited with Some(1)",
        ),
        (output(0, "Claude Code\n", ""), "no version number"),
    ] {
        let problem = assess_version(&probe, &out).unwrap_err();
        assert!(problem.contains(reason), "{problem}");
    }
}

#[test]
fn invocations_cover_every_permission_level_effort_and_output_mode() {
    let repo = std::env::temp_dir().to_string_lossy().into_owned();
    let has = |list: &[Invocation], words: &[&str]| {
        list.iter().any(|i| {
            i.spec
                .args
                .windows(words.len())
                .any(|window| window == words)
        })
    };
    let claude = invocations(AdapterKind::Claude, "claude", &repo);
    for words in [
        &["-p", "--output-format", "stream-json", "--verbose"][..],
        &["--permission-mode", "bypassPermissions"],
        &["--allowedTools", "Edit,Bash(git status *),mcp__jira"],
        &["--output-format", "text"],
        &["-p", PROMPT],
        &["--model", "sonnet"],
    ] {
        assert!(has(&claude, words), "{words:?}");
    }
    let codex = invocations(AdapterKind::Codex, "codex", &repo);
    for words in [
        &["exec", "--json"][..],
        &["--dangerously-bypass-approvals-and-sandbox"],
        &["--model", "gpt-5-codex"],
    ] {
        assert!(has(&codex, words), "{words:?}");
    }
    assert!(codex.iter().any(|i| i.reading == Reading::Text
        && i.spec.args.first().map(String::as_str) == Some("exec")
        && !i.spec.args.contains(&"--json".to_string())));
    // Codex offers no allowed-tools level.
    assert!(!codex.iter().any(|i| i.label.contains("allowed tools")));
    for effort in AgentEffort::allowed() {
        assert!(has(&claude, &["--effort", &effort]), "{effort}");
        let config = format!("model_reasoning_effort=\"{effort}\"");
        assert!(has(&codex, &["-c", &config]), "{effort}");
    }
    // Workflow generation sends the text invocation; both labels stay visible.
    for list in [&claude, &codex] {
        assert!(list
            .iter()
            .all(|i| i.spec.working_dir.as_deref() == Some(repo.as_str())));
        assert!(list
            .iter()
            .any(|i| i.label == "text output; workflow generation"));
        let mut seen: Vec<&Vec<String>> = Vec::new();
        for invocation in list.iter() {
            assert!(
                !seen.contains(&&invocation.spec.args),
                "{}",
                invocation.label
            );
            seen.push(&invocation.spec.args);
        }
    }
    let id = "01a188ec-7181-7e11-8454-e3635dc14f67";
    let resumed = session_turn(AdapterKind::Claude, "claude", &repo, Some(id));
    assert!(resumed.spec.args.windows(2).any(|w| w == ["--resume", id]));
    let resumed = session_turn(AdapterKind::Codex, "codex", &repo, Some(id));
    assert!(resumed.spec.args.windows(2).any(|w| w == ["resume", id]));
    assert_eq!(resumed.spec.args.last().map(String::as_str), Some("-"));
    assert_eq!(resumed.resumes.as_deref(), Some(id));
}

#[test]
fn annotations_escape_github_command_syntax() {
    assert_eq!(
        escape_annotation("50% done\nnext: a, b", false),
        "50%25 done%0Anext: a, b"
    );
    assert_eq!(
        escape_annotation("Codex 0.1: x, y", true),
        "Codex 0.1%3A x%2C y"
    );
}
