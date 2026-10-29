//! Setup check for an Agent Profile: one short headless prompt, sent only when
//! the user asks, proves the CLI is installed, signed in, able to read a file
//! in its working folder and, at the profile's permission level, able to edit
//! one without asking. A `--version` probe cannot see any of that, and a CLI
//! update that quietly changes headless permissions shows up here first.
use crate::agent_output::AgentOutput;
use crate::agents::{
    build_agent_command, structured_output, AdapterKind, AgentProfile, PermissionLevel,
    StructuredOutput, WorkingDirMode,
};
use crate::process::{run_command, CommandSpec, ProcessResult};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Upper bound for the whole check prompt; a signed-in CLI answers in seconds.
pub const SETUP_CHECK_TIMEOUT: Duration = Duration::from_secs(180);
const PROBE_FILE: &str = "orchevia-setup-check.txt";
const REPLY_FILE: &str = "orchevia-setup-reply.txt";
const MAX_DETAIL: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CheckStatus {
    Skipped,
    Passed,
    Warning,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupCheckItem {
    /// `installed` | `answered` | `readFile` | `editFile`.
    pub id: String,
    pub label: String,
    pub status: CheckStatus,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupCheckReport {
    pub profile_id: String,
    pub profile_name: String,
    /// The worst item status; skipped items never count.
    pub status: CheckStatus,
    pub items: Vec<SetupCheckItem>,
    pub duration_ms: u64,
}

fn item(id: &str, label: &str, status: CheckStatus, detail: impl Into<String>) -> SetupCheckItem {
    SetupCheckItem {
        id: id.into(),
        label: label.into(),
        status,
        detail: detail.into(),
        hint: None,
    }
}

fn with_hint(mut item: SetupCheckItem, hint: impl Into<String>) -> SetupCheckItem {
    item.hint = Some(hint.into());
    item
}

const INSTALLED: &str = "CLI installed";
const ANSWERED: &str = "Signed in and answering";
const READ_FILE: &str = "Reads files in its working folder";
const EDIT_FILE: &str = "Edits files without asking";

/// Run the check with the profile's effective permission level (resolve
/// [`PermissionLevel::AppDefault`] first). Blocks for up to
/// [`SETUP_CHECK_TIMEOUT`]; Tauri callers run it on a blocking thread.
pub fn check_agent_setup(profile: &AgentProfile) -> SetupCheckReport {
    check_with_timeout(profile, SETUP_CHECK_TIMEOUT)
}

fn check_with_timeout(profile: &AgentProfile, timeout: Duration) -> SetupCheckReport {
    let started = std::time::Instant::now();
    let items = run_checks(profile, timeout);
    let status = items
        .iter()
        .map(|i| i.status)
        .max()
        .unwrap_or(CheckStatus::Skipped);
    SetupCheckReport {
        profile_id: profile.id.clone(),
        profile_name: profile.name.clone(),
        status,
        items,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    }
}

fn sign_in_hint(adapter: AdapterKind) -> &'static str {
    match adapter {
        AdapterKind::Claude => {
            "Run `claude` once in a terminal and sign in (`/login`), then check again."
        }
        AdapterKind::Codex => "Run `codex login` in a terminal, then check again.",
        AdapterKind::Custom => {
            "Sign in to this CLI the way its documentation describes, then check again."
        }
    }
}

fn skipped_after(items: &mut Vec<SetupCheckItem>, ids: &[(&str, &str)], why: &str) {
    for (id, label) in ids {
        items.push(item(id, label, CheckStatus::Skipped, why));
    }
}

fn run_checks(profile: &AgentProfile, timeout: Duration) -> Vec<SetupCheckItem> {
    let mut items = Vec::new();
    let later = [
        ("answered", ANSWERED),
        ("readFile", READ_FILE),
        ("editFile", EDIT_FILE),
    ];
    let exe = profile.effective_executable();
    let Some(path) = crate::tools::find_executable(&exe) else {
        let hint = match profile.adapter {
            AdapterKind::Claude => "Install Claude Code and check `claude --version` works in a terminal, or set its full path in this profile.",
            AdapterKind::Codex => "Install Codex and check `codex --version` works in a terminal, or set its full path in this profile.",
            AdapterKind::Custom => "Set the full path of the CLI in this profile.",
        };
        items.push(with_hint(
            item(
                "installed",
                INSTALLED,
                CheckStatus::Failed,
                format!(
                    "'{exe}' was not found in your login shell PATH or common install locations."
                ),
            ),
            hint,
        ));
        skipped_after(&mut items, &later, "Needs the CLI first.");
        return items;
    };
    let version = crate::tools::probe_version(&path, &["--version".to_string()]);
    items.push(item(
        "installed",
        INSTALLED,
        CheckStatus::Passed,
        match version {
            Some(v) => format!("{} ({v})", path.display()),
            None => path.display().to_string(),
        },
    ));

    let dir = match ProbeDir::create() {
        Ok(dir) => dir,
        Err(e) => {
            items.push(item(
                "answered",
                ANSWERED,
                CheckStatus::Failed,
                format!("Could not prepare a temporary folder for the check: {e}"),
            ));
            skipped_after(&mut items, &later[1..], "Needs a working folder first.");
            return items;
        }
    };
    let token = format!("orchevia-check-{}", uuid::Uuid::new_v4().simple());
    if let Err(e) = std::fs::write(dir.path().join(PROBE_FILE), format!("{token}\n")) {
        items.push(item(
            "answered",
            ANSWERED,
            CheckStatus::Failed,
            format!("Could not write the check file: {e}"),
        ));
        skipped_after(&mut items, &later[1..], "Needs a working folder first.");
        return items;
    }

    let spec = match probe_command(profile, dir.path()) {
        Ok(spec) => spec,
        Err(e) => {
            items.push(with_hint(
                item("answered", ANSWERED, CheckStatus::Failed, clip(&e)),
                "Fix the profile in Agents, then check again.",
            ));
            skipped_after(&mut items, &later[1..], "Needs an answer first.");
            return items;
        }
    };
    let outcome = match run_command(&spec, Some(timeout)) {
        Ok(result) => decode(profile, &result),
        Err(e) => {
            items.push(item(
                "answered",
                ANSWERED,
                CheckStatus::Failed,
                clip(&e.to_string()),
            ));
            skipped_after(&mut items, &later[1..], "Needs an answer first.");
            return items;
        }
    };

    if let Some(failure) = answer_failure(profile, &outcome, timeout) {
        items.push(failure);
        skipped_after(&mut items, &later[1..], "Needs an answer first.");
        return items;
    }
    items.push(item(
        "answered",
        ANSWERED,
        CheckStatus::Passed,
        format!(
            "Answered in {:.0}s.",
            Duration::from_millis(outcome.duration_ms).as_secs_f64()
        ),
    ));

    let custom = profile.adapter == AdapterKind::Custom;
    items.push(if outcome.text.contains(&token) {
        item(
            "readFile",
            READ_FILE,
            CheckStatus::Passed,
            "Read the check file and replied with its text.",
        )
    } else if custom {
        item(
            "readFile",
            READ_FILE,
            CheckStatus::Warning,
            "The reply did not contain the check file's text. Orchevia cannot tell how this custom CLI uses files.",
        )
    } else {
        with_hint(
            item(
                "readFile",
                READ_FILE,
                CheckStatus::Failed,
                denied_or("The reply did not contain the check file's text.", &outcome),
            ),
            "Check the profile's extra arguments and permissions, then check again.",
        )
    });

    let wrote = std::fs::read_to_string(dir.path().join(REPLY_FILE))
        .is_ok_and(|text| text.contains(&token));
    items.push(if wrote {
        item(
            "editFile",
            EDIT_FILE,
            CheckStatus::Passed,
            "Created a file in its working folder without asking.",
        )
    } else if custom {
        item(
            "editFile",
            EDIT_FILE,
            CheckStatus::Skipped,
            "Orchevia does not manage a custom CLI's permissions.",
        )
    } else {
        edit_refused(profile, &outcome)
    });
    items
}

/// The decoded parts of one check run.
struct Outcome {
    text: String,
    error: Option<String>,
    denials: Vec<String>,
    limit_exhausted: bool,
    raw: String,
    exit_code: Option<i32>,
    timed_out: bool,
    duration_ms: u64,
}

fn decode(profile: &AgentProfile, result: &ProcessResult) -> Outcome {
    let raw = format!("{}\n{}", result.stdout, result.stderr);
    let base = Outcome {
        text: result.stdout.clone(),
        error: None,
        denials: Vec::new(),
        limit_exhausted: false,
        raw,
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        duration_ms: result.duration_ms,
    };
    if structured_output(profile) != StructuredOutput::Supported {
        return base;
    }
    let mut output = AgentOutput::tolerant(profile.adapter);
    output.push(result.stdout.as_bytes());
    output.finish();
    Outcome {
        text: output.text.clone().unwrap_or_default(),
        error: output.error.clone(),
        denials: output
            .permission_denials
            .iter()
            .map(|d| d.tool_name.clone())
            .collect(),
        limit_exhausted: output.limit_exhausted,
        ..base
    }
}

/// Words CLIs print when they are not signed in.
const SIGN_IN_MARKERS: &[&str] = &[
    "/login",
    "not logged in",
    "log in",
    "login required",
    "sign in",
    "invalid api key",
    "authentication",
    "unauthorized",
    "codex login",
];

fn answer_failure(
    profile: &AgentProfile,
    outcome: &Outcome,
    timeout: Duration,
) -> Option<SetupCheckItem> {
    if outcome.timed_out {
        return Some(with_hint(
            item(
                "answered",
                ANSWERED,
                CheckStatus::Failed,
                format!("No answer within {}s.", timeout.as_secs()),
            ),
            "Run the CLI in a terminal: it may be waiting for a sign-in, an update or a prompt.",
        ));
    }
    if outcome.limit_exhausted {
        return Some(with_hint(
            item(
                "answered",
                ANSWERED,
                CheckStatus::Failed,
                clip(
                    outcome
                        .error
                        .as_deref()
                        .unwrap_or("The CLI stopped at a limit."),
                ),
            ),
            "Wait for your plan's limit to reset, or adjust the CLI limit, then check again.",
        ));
    }
    let succeeded = outcome.exit_code == Some(0)
        && (outcome.error.is_none() || !outcome.denials.is_empty())
        && !outcome.text.trim().is_empty();
    if succeeded {
        return None;
    }
    // The decoder's generic error says less than any reply the CLI printed.
    let reply = Some(outcome.text.trim().to_string()).filter(|t| !t.is_empty());
    let message = outcome
        .error
        .clone()
        .filter(|e| !e.trim().is_empty() && e != "CLI reported a failed result.")
        .or(reply)
        .or_else(|| outcome.error.clone())
        .or_else(|| first_line(&outcome.raw))
        .unwrap_or_else(|| match outcome.exit_code {
            Some(code) => format!("The CLI exited with code {code} and no answer."),
            None => "The CLI stopped without an answer.".into(),
        });
    let lower = format!("{message}\n{}", outcome.raw).to_lowercase();
    let signed_out = SIGN_IN_MARKERS.iter().any(|m| lower.contains(m));
    Some(if signed_out {
        with_hint(
            item(
                "answered",
                ANSWERED,
                CheckStatus::Failed,
                format!("Not signed in: {}", clip(&message)),
            ),
            sign_in_hint(profile.adapter),
        )
    } else {
        with_hint(
            item("answered", ANSWERED, CheckStatus::Failed, clip(&message)),
            "Run the CLI in a terminal with a short prompt to see the full error.",
        )
    })
}

fn denied_or(fallback: &str, outcome: &Outcome) -> String {
    if outcome.denials.is_empty() {
        fallback.to_string()
    } else {
        format!("Refused tools: {}.", outcome.denials.join(", "))
    }
}

fn edit_refused(profile: &AgentProfile, outcome: &Outcome) -> SetupCheckItem {
    let what = denied_or("No file was written.", outcome);
    match profile.permission_level {
        PermissionLevel::FullAccess => with_hint(
            item(
                "editFile",
                EDIT_FILE,
                CheckStatus::Failed,
                format!("Full access was requested, but the CLI did not edit. {what}"),
            ),
            "The CLI may have changed how it handles permissions in headless runs. Check for an Orchevia update, or report it with the CLI version.",
        ),
        PermissionLevel::AllowedTools => with_hint(
            item(
                "editFile",
                EDIT_FILE,
                CheckStatus::Warning,
                format!("Steps that edit files will be refused with these allowed tools. {what}"),
            ),
            "Add `Edit` and `Write` to this profile's allowed tools, or give it Full access.",
        ),
        PermissionLevel::AppDefault | PermissionLevel::CliSettings => {
            let settings = if profile.adapter == AdapterKind::Codex {
                "Codex settings"
            } else {
                "Claude Code settings"
            };
            with_hint(
                item(
                    "editFile",
                    EDIT_FILE,
                    CheckStatus::Warning,
                    format!("Under your {settings}, steps that edit files will be refused. {what}"),
                ),
                "Choose “Let agents work without asking” in Environment → Agent permissions, or give this profile its own level in Agents.",
            )
        }
    }
}

const PROBE_PROMPT: &str = "This is an Orchevia setup check. In the current folder, read the \
file orchevia-setup-check.txt. Then create a file named orchevia-setup-reply.txt in the same \
folder containing exactly that text. Finally reply with only that text. Do nothing else.";

/// The node command for the check prompt, run inside the temporary folder
/// whatever the profile's own working-folder mode.
fn probe_command(profile: &AgentProfile, dir: &Path) -> Result<CommandSpec, String> {
    let mut probe = profile.clone();
    probe.working_dir_mode = WorkingDirMode::Node;
    // Skills would be invoked by name before the prompt; the check tests the
    // CLI, its sign-in and its permissions, not a skill.
    probe.skills.clear();
    let mut spec = build_agent_command(&probe, PROBE_PROMPT, Some(&dir.to_string_lossy()))?;
    // `codex exec` refuses a folder that is not a Git repository.
    if profile.adapter == AdapterKind::Codex
        && !spec.args.iter().any(|a| a == "--skip-git-repo-check")
    {
        let at = if spec.args.last().is_some_and(|a| a == "-") {
            spec.args.len() - 1
        } else {
            spec.args.len()
        };
        spec.args.insert(at, "--skip-git-repo-check".into());
    }
    Ok(spec)
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

fn clip(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= MAX_DETAIL {
        return text.to_string();
    }
    let mut clipped: String = text.chars().take(MAX_DETAIL).collect();
    clipped.push('…');
    clipped
}

/// A fresh temporary folder, removed when dropped.
struct ProbeDir(PathBuf);

impl ProbeDir {
    fn create() -> std::io::Result<Self> {
        let path = std::env::temp_dir().join(format!(
            "orchevia-setup-check-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir(&path)?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ProbeDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn stub(dir: &Path, body: &str) -> String {
        let cli = dir.join("stub-cli");
        std::fs::write(&cli, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        cli.to_string_lossy().into_owned()
    }

    fn profile(adapter: AdapterKind, executable: String, level: PermissionLevel) -> AgentProfile {
        AgentProfile {
            id: "p1".into(),
            name: "Checked".into(),
            adapter,
            executable: Some(executable),
            model: None,
            effort: None,
            extra_args: Vec::new(),
            skills: Vec::new(),
            working_dir_mode: WorkingDirMode::Inherit,
            working_dir: None,
            default_timeout_secs: 60,
            role: None,
            permission_level: level,
            allowed_tools: Vec::new(),
        }
    }

    fn status(report: &SetupCheckReport, id: &str) -> CheckStatus {
        report
            .items
            .iter()
            .find(|i| i.id == id)
            .map(|i| i.status)
            .unwrap()
    }

    /// A Claude stub that reads the check file, optionally writes the reply,
    /// and prints stream-json; `denials` is the raw `permission_denials` JSON.
    const CLAUDE_ANSWER: &str = r#"if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
cat >/dev/null
token=$(cat orchevia-setup-check.txt)
WRITE
printf '{"type":"system","subtype":"init","session_id":"00000000-0000-4000-8000-000000000001"}\n'
printf '{"type":"result","subtype":"success","is_error":false,"result":"%s","permission_denials":DENIALS,"usage":{"input_tokens":5,"output_tokens":2}}\n' "$token""#;

    fn claude_stub(dir: &Path, writes: bool, denials: &str) -> String {
        stub(
            dir,
            &CLAUDE_ANSWER
                .replace(
                    "WRITE",
                    if writes {
                        "printf '%s' \"$token\" > orchevia-setup-reply.txt"
                    } else {
                        ":"
                    },
                )
                .replace("DENIALS", denials),
        )
    }

    #[test]
    fn a_working_profile_passes_every_check_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("cwd");
        let cli = claude_stub(dir.path(), true, "[]");
        let script = std::fs::read_to_string(&cli).unwrap().replace(
            "cat >/dev/null",
            &format!("cat >/dev/null\npwd > '{}'", cwd.display()),
        );
        std::fs::write(&cli, script).unwrap();
        let report = check_agent_setup(&profile(
            AdapterKind::Claude,
            cli,
            PermissionLevel::FullAccess,
        ));
        assert_eq!(report.status, CheckStatus::Passed, "{report:?}");
        assert_eq!(
            report
                .items
                .iter()
                .map(|i| i.id.as_str())
                .collect::<Vec<_>>(),
            ["installed", "answered", "readFile", "editFile"]
        );
        assert!(report.items[0].detail.contains("9.9.9"));
        // The check ran in its own temporary folder, removed afterwards.
        let ran_in = std::fs::read_to_string(cwd).unwrap();
        assert!(ran_in.contains("orchevia-setup-check-"), "{ran_in}");
        assert!(!Path::new(ran_in.trim()).exists());
    }

    #[test]
    fn full_access_that_still_cannot_edit_fails_the_check() {
        let dir = tempfile::tempdir().unwrap();
        let cli = claude_stub(
            dir.path(),
            false,
            r#"[{"tool_name":"Write","tool_use_id":"t1","tool_input":{"file_path":"orchevia-setup-reply.txt"}}]"#,
        );
        let report = check_agent_setup(&profile(
            AdapterKind::Claude,
            cli,
            PermissionLevel::FullAccess,
        ));
        assert_eq!(status(&report, "answered"), CheckStatus::Passed);
        assert_eq!(status(&report, "readFile"), CheckStatus::Passed);
        assert_eq!(status(&report, "editFile"), CheckStatus::Failed);
        assert_eq!(report.status, CheckStatus::Failed);
        let edit = report.items.iter().find(|i| i.id == "editFile").unwrap();
        assert!(edit.detail.contains("Refused tools: Write"), "{edit:?}");
    }

    #[test]
    fn cli_settings_that_refuse_edits_warn_with_the_way_out() {
        let dir = tempfile::tempdir().unwrap();
        let cli = claude_stub(dir.path(), false, "[]");
        let report = check_agent_setup(&profile(
            AdapterKind::Claude,
            cli,
            PermissionLevel::CliSettings,
        ));
        assert_eq!(report.status, CheckStatus::Warning);
        let edit = report.items.iter().find(|i| i.id == "editFile").unwrap();
        assert!(edit.detail.contains("Claude Code settings"));
        assert!(edit.hint.as_deref().unwrap().contains("Agent permissions"));
    }

    #[test]
    fn a_signed_out_cli_names_the_sign_in_step() {
        let dir = tempfile::tempdir().unwrap();
        let cli = stub(
            dir.path(),
            r#"if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi
cat >/dev/null
printf '{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}\n'
exit 1"#,
        );
        let report = check_agent_setup(&profile(
            AdapterKind::Claude,
            cli,
            PermissionLevel::CliSettings,
        ));
        let answered = report.items.iter().find(|i| i.id == "answered").unwrap();
        assert_eq!(answered.status, CheckStatus::Failed);
        assert_eq!(
            answered.detail,
            "Not signed in: Invalid API key · Please run /login"
        );
        assert!(answered.hint.as_deref().unwrap().contains("/login"));
        assert_eq!(status(&report, "readFile"), CheckStatus::Skipped);
        assert_eq!(status(&report, "editFile"), CheckStatus::Skipped);
    }

    #[test]
    fn codex_runs_outside_a_repository_and_reads_its_events() {
        let dir = tempfile::tempdir().unwrap();
        let args = dir.path().join("args");
        let cli = stub(
            dir.path(),
            &format!(
                r#"if [ "$1" = "--version" ]; then echo "codex-cli 0.99.0"; exit 0; fi
printf '%s\n' "$@" > {}
cat >/dev/null
token=$(cat orchevia-setup-check.txt)
printf '{{"type":"thread.started","thread_id":"00000000-0000-4000-8000-000000000002"}}\n'
printf '{{"type":"item.completed","item":{{"type":"agent_message","text":"%s"}}}}\n' "$token"
printf '{{"type":"turn.completed","usage":{{"input_tokens":3,"output_tokens":1}}}}\n'"#,
                args.display()
            ),
        );
        let report = check_agent_setup(&profile(
            AdapterKind::Codex,
            cli,
            PermissionLevel::CliSettings,
        ));
        assert_eq!(status(&report, "readFile"), CheckStatus::Passed);
        let edit = report.items.iter().find(|i| i.id == "editFile").unwrap();
        assert_eq!(edit.status, CheckStatus::Warning);
        assert!(edit.detail.contains("Codex settings"));
        let argv = std::fs::read_to_string(args).unwrap();
        let lines: Vec<&str> = argv.lines().collect();
        assert_eq!(lines.last(), Some(&"-"));
        assert!(lines.contains(&"--skip-git-repo-check"), "{argv}");
    }

    #[test]
    fn skills_are_not_invoked_by_the_check() {
        let dir = tempfile::tempdir().unwrap();
        let mut skilled = profile(
            AdapterKind::Claude,
            "claude".into(),
            PermissionLevel::FullAccess,
        );
        skilled.skills = vec!["code-review".into()];
        let spec = probe_command(&skilled, dir.path()).unwrap();
        let prompt = spec.stdin.unwrap();
        assert!(
            prompt.starts_with("This is an Orchevia setup check."),
            "{prompt}"
        );
        assert_eq!(
            spec.working_dir.as_deref(),
            Some(&*dir.path().to_string_lossy())
        );
    }

    #[test]
    fn a_missing_cli_skips_the_prompt() {
        let report = check_agent_setup(&profile(
            AdapterKind::Claude,
            "/nonexistent/orchevia-test-claude".into(),
            PermissionLevel::FullAccess,
        ));
        assert_eq!(status(&report, "installed"), CheckStatus::Failed);
        assert!(report.items[1..]
            .iter()
            .all(|i| i.status == CheckStatus::Skipped));
        assert_eq!(report.status, CheckStatus::Failed);
    }

    #[test]
    fn a_hanging_cli_times_out() {
        let dir = tempfile::tempdir().unwrap();
        let cli = stub(
            dir.path(),
            r#"if [ "$1" = "--version" ]; then echo "1.0"; exit 0; fi
sleep 30"#,
        );
        let report = check_with_timeout(
            &profile(AdapterKind::Claude, cli, PermissionLevel::FullAccess),
            Duration::from_secs(1),
        );
        let answered = report.items.iter().find(|i| i.id == "answered").unwrap();
        assert_eq!(answered.status, CheckStatus::Failed);
        assert!(answered.detail.contains("No answer within 1s"));
    }

    #[test]
    fn a_custom_cli_is_judged_on_its_text_only() {
        let dir = tempfile::tempdir().unwrap();
        let cli = stub(
            dir.path(),
            r#"if [ "$1" = "--version" ]; then echo "1.0"; exit 0; fi
cat orchevia-setup-check.txt"#,
        );
        let mut custom = profile(AdapterKind::Custom, cli, PermissionLevel::CliSettings);
        custom.working_dir_mode = WorkingDirMode::Node;
        let report = check_agent_setup(&custom);
        assert_eq!(status(&report, "readFile"), CheckStatus::Passed);
        assert_eq!(status(&report, "editFile"), CheckStatus::Skipped);
        assert_eq!(report.status, CheckStatus::Passed);
    }

    /// Manual check against the CLIs on this machine; each run sends one short
    /// prompt per profile on the signed-in plan:
    /// `cargo test -p orchevia-core real_cli_setup_check -- --ignored --nocapture`
    #[test]
    #[ignore = "sends real prompts with the installed Claude Code and Codex"]
    fn real_cli_setup_check() {
        for (adapter, level) in [
            (AdapterKind::Claude, PermissionLevel::FullAccess),
            (AdapterKind::Claude, PermissionLevel::CliSettings),
            (AdapterKind::Codex, PermissionLevel::FullAccess),
        ] {
            let mut real = profile(adapter, adapter.default_executable().into(), level);
            real.executable = None;
            let report = check_agent_setup(&real);
            println!("{adapter:?} {level:?}: {:#?}", report);
        }
    }
}
