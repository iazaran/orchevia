//! Generic AI CLI adapter system + Agent Profiles (Milestone 2).
//!
//! The workflow engine never contains Claude/Codex-specific command syntax.
//! Each adapter knows how to turn an [`AgentProfile`] + rendered prompt into
//! a [`CommandSpec`] (executable + args, no shell). Adding a new CLI means
//! adding an adapter implementation + registration + tests, not engine edits.

use crate::process::CommandSpec;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Supported AI CLI adapters. Serialized lowercase for stability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdapterKind {
    Claude,
    Codex,
    /// User-registered CLI (added manually in Agents). Contract: prompt is
    /// passed as the final argv element; `--model <m>` is added only when a
    /// model is set; `extra_args` come first. Effort is intentionally
    /// unmapped (the CLI's default applies).
    Custom,
}

impl AdapterKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AdapterKind::Claude => "claude",
            AdapterKind::Codex => "codex",
            AdapterKind::Custom => "custom",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            AdapterKind::Claude => "Claude Code",
            AdapterKind::Codex => "Codex",
            AdapterKind::Custom => "Custom CLI",
        }
    }

    pub fn default_executable(self) -> &'static str {
        match self {
            AdapterKind::Claude => "claude",
            AdapterKind::Codex => "codex",
            // Custom has no default: the user must set an explicit path.
            AdapterKind::Custom => "",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "claude" => Some(AdapterKind::Claude),
            "codex" => Some(AdapterKind::Codex),
            "custom" => Some(AdapterKind::Custom),
            _ => None,
        }
    }

    pub fn all() -> Vec<AdapterInfo> {
        vec![
            AdapterInfo {
                id: AdapterKind::Claude,
                display_name: "Claude Code".to_string(),
                default_executable: "claude".to_string(),
                supports_model_flag: true,
                supports_session_resume: true,
                notes: "Uses `claude -p --output-format stream-json --verbose` with the prompt on stdin, so runs report tokens and USD. Model via `--model`."
                    .to_string(),
            },
            AdapterInfo {
                id: AdapterKind::Custom,
                display_name: "Custom CLI".to_string(),
                default_executable: String::new(),
                supports_model_flag: true,
                supports_session_resume: false,
                notes: "Your own coding CLI (aichat, sgpt, mods, …). Set the full binary path; prompt goes last, `--model` only when set."
                    .to_string(),
            },
            AdapterInfo {
                id: AdapterKind::Codex,
                display_name: "Codex".to_string(),
                default_executable: "codex".to_string(),
                supports_model_flag: true,
                supports_session_resume: true,
                notes: "Uses `codex exec --json -` with the prompt on stdin, so runs report tokens. Model via `--model`. Non-interactive."
                    .to_string(),
            },
        ]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInfo {
    pub id: AdapterKind,
    pub display_name: String,
    pub default_executable: String,
    pub supports_model_flag: bool,
    pub supports_session_resume: bool,
    pub notes: String,
}

/// A discoverable file-backed skill. Plugin and account-synced skills can
/// still be entered by name in the profile editor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillInfo {
    pub name: String,
    pub description: String,
    pub source: String,
}

pub fn discover_agent_skills(
    adapter: AdapterKind,
    working_dir: Option<&Path>,
) -> Vec<AgentSkillInfo> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    discover_agent_skills_in(adapter, &home, working_dir)
}

fn discover_agent_skills_in(
    adapter: AdapterKind,
    home: &Path,
    working_dir: Option<&Path>,
) -> Vec<AgentSkillInfo> {
    let (mut dirs, project_dir) = match adapter {
        AdapterKind::Claude => (vec![home.join(".claude/skills")], ".claude/skills"),
        AdapterKind::Codex => (
            vec![home.join(".agents/skills"), home.join(".codex/skills")],
            ".agents/skills",
        ),
        AdapterKind::Custom => return Vec::new(),
    };
    if let Some(dir) = working_dir.filter(|dir| dir.is_dir()) {
        let root = dir
            .ancestors()
            .find(|ancestor| ancestor.join(".git").exists())
            .unwrap_or(dir);
        let mut current = Some(dir);
        while let Some(path) = current {
            dirs.push(path.join(project_dir));
            if path == root {
                break;
            }
            current = path.parent();
        }
    }
    let mut seen = std::collections::HashSet::new();
    let mut skills = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let skill_file = path.join("SKILL.md");
            let Ok(contents) = std::fs::read_to_string(&skill_file) else {
                continue;
            };
            let folder_name = entry.file_name().to_string_lossy().into_owned();
            let (name, description) = skill_metadata(&contents, &folder_name);
            if !valid_skill_name(&name) || !seen.insert(name.to_ascii_lowercase()) {
                continue;
            }
            skills.push(AgentSkillInfo {
                name,
                description,
                source: skill_file.to_string_lossy().into_owned(),
            });
        }
    }
    skills.sort_by(|a, b| {
        a.name
            .to_ascii_lowercase()
            .cmp(&b.name.to_ascii_lowercase())
    });
    skills
}

fn skill_metadata(contents: &str, folder_name: &str) -> (String, String) {
    let mut lines = contents.lines();
    if lines.next() != Some("---") {
        return (folder_name.to_string(), String::new());
    }
    let mut name = folder_name.to_string();
    let mut description = String::new();
    for line in lines.take(50) {
        if line == "---" {
            break;
        }
        if let Some(value) = line.strip_prefix("name:") {
            name = value.trim().trim_matches(['\'', '"']).to_string();
        } else if let Some(value) = line.strip_prefix("description:") {
            description = value.trim().trim_matches(['\'', '"']).to_string();
        }
    }
    (name, description)
}

fn valid_skill_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name.split(':').all(|part| {
            !part.is_empty()
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
}

/// Logical role a profile serves. Stored as string; UI offers defaults.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRole(pub String);

impl AgentRole {
    pub fn well_known() -> Vec<String> {
        vec![
            "planning".to_string(),
            "implementation".to_string(),
            "fastReview".to_string(),
            "deepReview".to_string(),
            "workflowGenerator".to_string(),
            "workflowAssistance".to_string(),
            "generalPurpose".to_string(),
        ]
    }
}

/// Explicit names are portable, but must identify exactly one configured profile.
pub fn resolve_profile_name(name: &str, profiles: &[AgentProfile]) -> Result<String, String> {
    let mut matches = profiles.iter().filter(|p| p.name == name.trim());
    let profile = matches
        .next()
        .ok_or_else(|| format!("No Agent Profile named '{name}'. Configure it in Agents."))?;
    if matches.next().is_some() {
        return Err(format!(
            "Agent Profile name '{name}' is ambiguous. Rename duplicate profiles."
        ));
    }
    Ok(profile.id.clone())
}

/// How the working directory for an agent run is chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkingDirMode {
    /// Use the node's `working_dir` (must exist).
    #[default]
    Node,
    /// Use the profile's fixed directory.
    Profile,
    /// Inherit the Orchevia process cwd (explicit opt-in, discouraged for
    /// repo-mutating work).
    Inherit,
}

/// Reasoning/effort level for an agent run. Stored as string; UI offers presets.
/// Mapped to adapter argv at build time (no shell involved).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentEffort(pub String);

impl AgentEffort {
    pub fn allowed() -> Vec<String> {
        vec![
            "low".to_string(),
            "medium".to_string(),
            "high".to_string(),
            "xhigh".to_string(),
        ]
    }
}

/// Persisted user configuration for invoking a local AI CLI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub adapter: AdapterKind,
    /// Explicit executable path/name. `None` = auto-detect default on PATH.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executable: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Optional reasoning/effort level (low/medium/high/xhigh). When set, it
    /// is mapped to adapter argv; when absent, the CLI default applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default)]
    pub extra_args: Vec<String>,
    /// CLI-native skill names to invoke explicitly at the start of each run.
    /// Empty for existing profiles and when the CLI should choose skills itself.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<String>,
    #[serde(default)]
    pub working_dir_mode: WorkingDirMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
    /// Per-run timeout in seconds (bounded, default 3600 = 1 h).
    #[serde(default = "default_timeout")]
    pub default_timeout_secs: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

fn default_timeout() -> u64 {
    3600
}

impl AgentProfile {
    /// Validate configuration without touching the filesystem/network.
    /// Returns human-readable error strings.
    pub fn validate(&self) -> Vec<String> {
        let mut errors = Vec::new();
        if self.name.trim().is_empty() {
            errors.push("Profile name must not be empty.".to_string());
        }
        if self.id.trim().is_empty() {
            errors.push("Profile id must not be empty.".to_string());
        }
        if !(1..=crate::workflow::MAX_TIMEOUT_SECS).contains(&self.default_timeout_secs) {
            errors
                .push("Default timeout must be between 1 second and 12 hours (43200).".to_string());
        }
        for arg in &self.extra_args {
            if let Err(e) = validate_extra_arg(arg) {
                errors.push(e);
            }
        }
        if self.adapter == AdapterKind::Custom && !self.skills.is_empty() {
            errors
                .push("Skills are supported only for Claude Code and Codex profiles.".to_string());
        }
        if self.skills.len() > 8 {
            errors.push("Select at most 8 skills per profile.".to_string());
        }
        let mut seen_skills = std::collections::HashSet::new();
        for skill in &self.skills {
            if !valid_skill_name(skill) {
                errors.push(format!("Invalid skill name '{skill}'. Use letters, numbers, - or _, with optional namespace:name."));
            } else if !seen_skills.insert(skill.to_ascii_lowercase()) {
                errors.push(format!("Duplicate skill name '{skill}'."));
            }
        }
        if self.adapter == AdapterKind::Custom
            && self.executable.as_deref().unwrap_or("").trim().is_empty()
        {
            errors.push("Custom CLI profiles need an explicit executable path.".to_string());
        }
        if self.working_dir_mode == WorkingDirMode::Profile
            && self.working_dir.as_deref().unwrap_or("").trim().is_empty()
        {
            errors.push("Profile working directory mode requires a directory.".to_string());
        }
        // Model values are adapter-specific free-form config; only guard
        // against shell metacharacter injection confusion (we never use a
        // shell, but keep values sane).
        if let Some(m) = self.model.as_deref() {
            if m.trim().is_empty() {
                errors.push("Model must not be blank when set.".to_string());
            }
            if m.len() > 120 {
                errors.push("Model value is too long (max 120 chars).".to_string());
            }
        }
        if let Some(e) = self.effort.as_deref() {
            let trimmed = e.trim();
            if trimmed.is_empty() {
                errors.push("Effort must not be blank when set.".to_string());
            } else if trimmed.len() > 24 {
                errors.push("Effort value is too long (max 24 chars).".to_string());
            } else if !AgentEffort::allowed()
                .iter()
                .any(|a| a.eq_ignore_ascii_case(trimmed))
            {
                errors.push("Effort must be one of: low, medium, high, xhigh.".to_string());
            }
        }
        errors
    }

    /// Effective executable: explicit override or adapter default.
    pub fn effective_executable(&self) -> String {
        self.executable
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| self.adapter.default_executable().to_string())
    }
}

/// Extra args are passed verbatim (no shell) but must not smuggle
/// credential flags or shell syntax. Keep the allow-list tight.
fn validate_extra_arg(arg: &str) -> Result<(), String> {
    let lower = arg.to_ascii_lowercase();
    // Block flags that accept secrets; users authenticate in their own CLI.
    for forbidden in [
        "api-key",
        "apikey",
        "auth-token",
        "access-token",
        "bearer",
        "password",
        "secret",
    ] {
        if lower.contains(forbidden) {
            return Err(format!(
                "Extra argument '{arg}' looks like a credential flag and is not allowed."
            ));
        }
    }
    if arg.contains('\0') || arg.contains('\n') {
        return Err(format!(
            "Extra argument '{arg}' contains invalid characters."
        ));
    }
    Ok(())
}

/// How an ordinary (non-session) Agent node reports its result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StructuredOutput {
    /// Claude stream-json / Codex JSONL, decoded into the final response text
    /// plus CLI-reported usage.
    Supported,
    /// Custom CLIs print their own text; Orchevia does not parse it.
    Unsupported,
    /// The profile's extra arguments choose their own output format, so the
    /// node keeps the text invocation. The note explains the missing usage.
    Conflict(String),
}

fn has_flag(profile: &AgentProfile, flag: &str) -> Option<String> {
    profile
        .extra_args
        .iter()
        .find(|arg| *arg == flag || arg.starts_with(&format!("{flag}=")))
        .cloned()
}

/// A Claude profile that sets `--input-format` reads its prompt differently
/// (e.g. `stream-json`), so it keeps the previous invocation: the prompt as an
/// argument after `-p`, with text output.
fn claude_reads_custom_input(profile: &AgentProfile) -> Option<String> {
    (profile.adapter == AdapterKind::Claude)
        .then(|| has_flag(profile, "--input-format"))
        .flatten()
}

/// Whether ordinary Agent nodes for `profile` can use structured output.
pub fn structured_output(profile: &AgentProfile) -> StructuredOutput {
    if let Some(arg) = claude_reads_custom_input(profile) {
        return StructuredOutput::Conflict(format!(
            "Text output used: the profile's extra argument '{arg}' changes how Claude \
             reads its prompt, so the prompt is passed as an argument and this run reports \
             no token or cost data. Remove it to enable usage reporting."
        ));
    }
    let flags: &[&str] = match profile.adapter {
        AdapterKind::Claude => &["--output-format"],
        AdapterKind::Codex => &["--json", "--experimental-json"],
        AdapterKind::Custom => return StructuredOutput::Unsupported,
    };
    for flag in flags {
        if let Some(arg) = has_flag(profile, flag) {
            return StructuredOutput::Conflict(format!(
                "Text output used: the profile's extra argument '{arg}' sets the CLI output \
                 format, so this run reports no token or cost data. Remove it to enable \
                 usage reporting."
            ));
        }
    }
    StructuredOutput::Supported
}

/// Validated pieces shared by every invocation form.
struct Prepared {
    working_dir: Option<String>,
    /// Rendered prompt with CLI-native skill mentions prefixed.
    prompt: String,
    effort: Option<String>,
}

fn prepare(
    profile: &AgentProfile,
    rendered_prompt: &str,
    node_working_dir: Option<&str>,
) -> Result<Prepared, String> {
    let config_errors = profile.validate();
    if !config_errors.is_empty() {
        return Err(config_errors.join("; "));
    }
    if rendered_prompt.trim().is_empty() {
        return Err("Prompt must not be empty.".to_string());
    }
    if profile.effective_executable().trim().is_empty() {
        return Err("Custom CLI profiles need an explicit executable path.".to_string());
    }
    let working_dir = match profile.working_dir_mode {
        WorkingDirMode::Node => node_working_dir.map(str::to_string),
        WorkingDirMode::Profile => profile.working_dir.clone(),
        WorkingDirMode::Inherit => None,
    };
    if let Some(dir) = working_dir.as_deref() {
        if !std::path::Path::new(dir).is_dir() {
            return Err(format!("Working directory does not exist: {dir}"));
        }
    }
    let prompt = if profile.skills.is_empty() {
        rendered_prompt.to_string()
    } else {
        let prefix = match profile.adapter {
            AdapterKind::Claude => "/",
            AdapterKind::Codex => "$",
            AdapterKind::Custom => {
                return Err("Custom CLI profiles cannot invoke skills.".to_string())
            }
        };
        format!(
            "{}\n\n{rendered_prompt}",
            profile
                .skills
                .iter()
                .map(|name| format!("{prefix}{name}"))
                .collect::<Vec<_>>()
                .join(" ")
        )
    };
    let effort = profile
        .effort
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .map(|e| e.to_ascii_lowercase());
    Ok(Prepared {
        working_dir,
        prompt,
        effort,
    })
}

fn push_model_and_effort(args: &mut Vec<String>, profile: &AgentProfile, effort: Option<&str>) {
    if let Some(model) = profile.model.as_deref().filter(|m| !m.trim().is_empty()) {
        args.push("--model".to_string());
        args.push(model.trim().to_string());
    }
    if let Some(effort) = effort {
        if profile.adapter == AdapterKind::Claude {
            args.push("--effort".to_string());
            args.push(effort.to_string());
        } else if profile.adapter == AdapterKind::Codex {
            args.push("-c".to_string());
            args.push(format!("model_reasoning_effort=\"{effort}\""));
        }
    }
}

/// Build the command an ordinary Agent node runs for a profile + rendered
/// prompt: structured output when [`structured_output`] allows it, the text
/// invocation otherwise.
///
/// Never uses a shell. Claude and Codex receive the prompt on stdin (`claude
/// -p`, `codex exec … -`), so prompt text can neither become flags nor hit
/// argv length limits. Custom CLIs keep the prompt as the final argument.
pub fn build_agent_command(
    profile: &AgentProfile,
    rendered_prompt: &str,
    node_working_dir: Option<&str>,
) -> Result<CommandSpec, String> {
    match structured_output(profile) {
        StructuredOutput::Supported => {
            build_structured_command(profile, rendered_prompt, node_working_dir, None)
        }
        _ => build_text_agent_command(profile, rendered_prompt, node_working_dir),
    }
}

/// Plain-text invocation: `claude -p --output-format text`, `codex exec -`
/// (prompt on stdin), or the Custom CLI contract. Used by text fallbacks and
/// workflow generation, which parses the CLI's text as proposal JSON.
pub fn build_text_agent_command(
    profile: &AgentProfile,
    rendered_prompt: &str,
    node_working_dir: Option<&str>,
) -> Result<CommandSpec, String> {
    let Prepared {
        working_dir,
        prompt,
        effort,
    } = prepare(profile, rendered_prompt, node_working_dir)?;
    let mut args: Vec<String> = Vec::new();
    let stdin = match profile.adapter {
        AdapterKind::Claude if claude_reads_custom_input(profile).is_some() => {
            // Previous invocation, unchanged for profiles with their own input format.
            args.push("-p".to_string());
            args.push(prompt);
            args.push("--output-format".to_string());
            args.push("text".to_string());
            push_model_and_effort(&mut args, profile, effort.as_deref());
            args.extend(profile.extra_args.iter().cloned());
            None
        }
        AdapterKind::Claude => {
            args.push("-p".to_string());
            args.push("--output-format".to_string());
            args.push("text".to_string());
            push_model_and_effort(&mut args, profile, effort.as_deref());
            args.extend(profile.extra_args.iter().cloned());
            Some(prompt)
        }
        AdapterKind::Codex => {
            args.push("exec".to_string());
            push_model_and_effort(&mut args, profile, effort.as_deref());
            args.push("-".to_string());
            args.extend(profile.extra_args.iter().cloned());
            Some(prompt)
        }
        AdapterKind::Custom => {
            push_model_and_effort(&mut args, profile, None);
            args.extend(profile.extra_args.iter().cloned());
            args.push(prompt);
            None
        }
    };
    Ok(CommandSpec {
        executable: profile.effective_executable(),
        args,
        working_dir,
        stdin,
    })
}

/// Claude `stream-json` / Codex JSONL invocation, optionally resuming an
/// explicit session. The prompt travels on stdin.
fn build_structured_command(
    profile: &AgentProfile,
    rendered_prompt: &str,
    node_working_dir: Option<&str>,
    resume_id: Option<&str>,
) -> Result<CommandSpec, String> {
    if profile.adapter == AdapterKind::Custom {
        return Err("Custom CLI profiles do not support structured output.".into());
    }
    let Prepared {
        working_dir,
        prompt,
        effort,
    } = prepare(profile, rendered_prompt, node_working_dir)?;
    let mut args: Vec<String> = if profile.adapter == AdapterKind::Claude {
        vec![
            "-p".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--verbose".into(),
        ]
    } else {
        vec!["exec".into(), "--json".into()]
    };
    push_model_and_effort(&mut args, profile, effort.as_deref());
    args.extend(profile.extra_args.iter().cloned());
    if let Some(id) = resume_id {
        args.extend([
            if profile.adapter == AdapterKind::Claude {
                "--resume".into()
            } else {
                "resume".into()
            },
            id.into(),
        ]);
    }
    if profile.adapter == AdapterKind::Codex {
        args.push("-".into());
    }
    Ok(CommandSpec {
        executable: profile.effective_executable(),
        args,
        working_dir,
        stdin: Some(prompt),
    })
}

/// Managed conversations require explicit ids and structured output. Conflicting
/// user flags are rejected before invoking the CLI rather than overriding them.
pub fn validate_session_profile(profile: &AgentProfile) -> Result<(), String> {
    if profile.adapter == AdapterKind::Custom {
        return Err("Custom CLI profiles do not support session groups.".into());
    }
    let flags: &[&str] = match profile.adapter {
        AdapterKind::Claude => &[
            "--from-pr",
            "--teleport",
            "--resume",
            "-r",
            "--continue",
            "-c",
            "--session-id",
            "--fork-session",
            "--no-session-persistence",
            "--output-format",
            "--input-format",
            "--include-partial-messages",
            "--forward-subagent-text",
            "--worktree",
            "-w",
            "--cloud",
            "--remote",
        ],
        _ => &[
            "resume",
            "fork",
            "review",
            "--last",
            "--ephemeral",
            "--json",
            "--experimental-json",
            "--output-last-message",
            "-o",
            "--output-schema",
            "--cd",
            "-C",
            "--worktree",
        ],
    };
    for arg in &profile.extra_args {
        if flags.iter().any(|flag| {
            arg == flag
                || arg.starts_with(&format!("{flag}="))
                || (flag.len() == 2 && flag.starts_with('-') && arg.starts_with(flag))
        }) {
            return Err(format!("Extra argument '{arg}' conflicts with managed session groups. Remove it or use a fresh-session node."));
        }
    }
    Ok(())
}

pub fn build_session_command(
    profile: &AgentProfile,
    prompt: &str,
    node_dir: Option<&str>,
    resume_id: Option<&str>,
) -> Result<CommandSpec, String> {
    validate_session_profile(profile)?;
    if resume_id.is_some_and(|id| uuid::Uuid::parse_str(id).is_err()) {
        return Err("Invalid recorded session id.".into());
    }
    build_structured_command(profile, prompt, node_dir, resume_id)
}

/// Safe display preview (shell-escaped, display only).
pub fn preview_agent_command(profile: &AgentProfile, rendered_prompt: &str) -> String {
    match build_agent_command(profile, rendered_prompt, None) {
        Ok(spec) => spec.preview(),
        Err(e) => format!("<invalid: {e}>"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claude_profile() -> AgentProfile {
        AgentProfile {
            id: "p1".to_string(),
            name: "Claude — Implementation".to_string(),
            adapter: AdapterKind::Claude,
            executable: None,
            model: Some("opus".to_string()),
            effort: None,
            extra_args: vec![],
            skills: vec![],
            working_dir_mode: WorkingDirMode::Inherit,
            working_dir: None,
            default_timeout_secs: 3600,
            role: Some("implementation".to_string()),
        }
    }

    #[test]
    fn claude_command_uses_print_mode() {
        let spec = build_agent_command(&claude_profile(), "hello", None).expect("build");
        assert_eq!(spec.executable, "claude");
        assert_eq!(
            spec.args,
            [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--model",
                "opus"
            ]
        );
        // The prompt travels on stdin, never in argv.
        assert_eq!(spec.stdin.as_deref(), Some("hello"));
        assert!(!spec.args.iter().any(|a| a.contains("hello")));
        assert!(spec.preview().ends_with("<prompt via stdin, 5 chars>"));
    }

    #[test]
    fn conflicting_output_flags_keep_the_text_invocation_with_a_note() {
        let mut claude = claude_profile();
        claude.extra_args = vec!["--output-format".into(), "json".into()];
        let StructuredOutput::Conflict(note) = structured_output(&claude) else {
            panic!("--output-format must conflict");
        };
        assert!(note.contains("--output-format") && note.contains("no token or cost data"));
        let spec = build_agent_command(&claude, "hi", None).unwrap();
        assert_eq!(
            spec.args,
            [
                "-p",
                "--output-format",
                "text",
                "--model",
                "opus",
                "--output-format",
                "json"
            ]
        );
        assert_eq!(spec.stdin.as_deref(), Some("hi"));

        let mut codex = claude_profile();
        codex.adapter = AdapterKind::Codex;
        assert_eq!(structured_output(&codex), StructuredOutput::Supported);
        codex.extra_args = vec!["--json".into()];
        assert!(matches!(
            structured_output(&codex),
            StructuredOutput::Conflict(_)
        ));
        let spec = build_agent_command(&codex, "hi", None).unwrap();
        assert_eq!(spec.args, ["exec", "--model", "opus", "-", "--json"]);

        let mut custom = claude_profile();
        custom.adapter = AdapterKind::Custom;
        custom.executable = Some("/usr/local/bin/aichat".into());
        assert_eq!(structured_output(&custom), StructuredOutput::Unsupported);
    }

    #[test]
    fn claude_profiles_with_their_own_input_format_keep_the_argument_prompt() {
        let mut claude = claude_profile();
        claude.extra_args = vec!["--input-format".into(), "stream-json".into()];
        let StructuredOutput::Conflict(note) = structured_output(&claude) else {
            panic!("--input-format must keep text mode");
        };
        assert!(note.contains("--input-format") && note.contains("passed as an argument"));
        let spec = build_agent_command(&claude, "hi", None).unwrap();
        assert_eq!(
            spec.args,
            [
                "-p",
                "hi",
                "--output-format",
                "text",
                "--model",
                "opus",
                "--input-format",
                "stream-json"
            ]
        );
        assert!(spec.stdin.is_none());
        // Session groups still reject it before running.
        assert!(validate_session_profile(&claude).is_err());
    }

    #[test]
    fn text_commands_for_generation_read_the_prompt_from_stdin() {
        let claude = build_text_agent_command(&claude_profile(), "draft", None).unwrap();
        assert_eq!(
            claude.args,
            ["-p", "--output-format", "text", "--model", "opus"]
        );
        assert_eq!(claude.stdin.as_deref(), Some("draft"));
        let mut codex = claude_profile();
        codex.adapter = AdapterKind::Codex;
        codex.effort = Some("high".into());
        let codex = build_text_agent_command(&codex, "draft", None).unwrap();
        assert_eq!(
            codex.args,
            [
                "exec",
                "--model",
                "opus",
                "-c",
                "model_reasoning_effort=\"high\"",
                "-"
            ]
        );
        assert_eq!(codex.stdin.as_deref(), Some("draft"));
    }

    #[test]
    fn managed_commands_keep_session_flags_and_prompt_separate() {
        let id = "00000000-0000-4000-8000-000000000001";
        for adapter in [AdapterKind::Claude, AdapterKind::Codex] {
            let mut p = claude_profile();
            p.adapter = adapter;
            p.effort = Some("medium".into());
            let spec = build_session_command(&p, "--last is task text", None, Some(id)).unwrap();
            // Prompt text is stdin data and can never be parsed as a flag.
            assert_eq!(spec.stdin.as_deref(), Some("--last is task text"));
            assert!(!spec.args.iter().any(|a| a.contains("task text")));
            if adapter == AdapterKind::Codex {
                assert_eq!(spec.args.last().unwrap(), "-");
            } else {
                assert_eq!(spec.args.last().unwrap(), id);
            }
            assert!(spec.args.windows(2).any(|pair| pair
                == [
                    if adapter == AdapterKind::Claude {
                        "--resume"
                    } else {
                        "resume"
                    },
                    id
                ]));
            assert!(spec.args.contains(&"opus".into()));
            for flag in if adapter == AdapterKind::Claude {
                vec![
                    "--from-pr",
                    "--from-pr=123",
                    "--teleport",
                    "--teleport=other",
                    "--resume=other",
                    "-rOTHER",
                    "--output-format=text",
                    "--no-session-persistence",
                    "--worktree",
                ]
            } else {
                vec!["--last", "--ephemeral", "--json", "--cd=/other", "resume"]
            } {
                p.extra_args = vec![flag.into()];
                assert!(
                    build_session_command(&p, "Work", None, None).is_err(),
                    "{flag}"
                );
            }
        }
    }

    #[test]
    fn codex_command_uses_exec() {
        let mut p = claude_profile();
        p.adapter = AdapterKind::Codex;
        let spec = build_agent_command(&p, "review this", None).expect("build");
        assert_eq!(spec.executable, "codex");
        assert_eq!(spec.args, ["exec", "--json", "--model", "opus", "-"]);
        assert_eq!(spec.stdin.as_deref(), Some("review this"));
    }

    #[test]
    fn selected_skills_are_invoked_by_the_matching_cli() {
        let mut value = serde_json::to_value(claude_profile()).expect("serialize");
        value["skills"] = serde_json::json!(["code-review", "team:style"]);
        let mut profile: AgentProfile = serde_json::from_value(value).expect("deserialize");
        let claude = build_agent_command(&profile, "Review this change", None).expect("build");
        assert_eq!(
            claude.stdin.as_deref(),
            Some("/code-review /team:style\n\nReview this change")
        );

        profile.adapter = AdapterKind::Codex;
        let codex = build_agent_command(&profile, "Review this change", None).expect("build");
        assert_eq!(
            codex.stdin.as_deref(),
            Some("$code-review $team:style\n\nReview this change")
        );
    }

    #[test]
    fn invalid_skill_names_are_rejected_before_running() {
        let mut value = serde_json::to_value(claude_profile()).expect("serialize");
        value["skills"] = serde_json::json!(["../unsafe"]);
        let profile: AgentProfile = serde_json::from_value(value).expect("deserialize");
        assert!(profile
            .validate()
            .iter()
            .any(|error| error.contains("skill")));
    }

    #[test]
    fn skill_discovery_reads_only_matching_cli_and_project_scope() {
        let root = tempfile::tempdir().expect("tempdir");
        let home = root.path().join("home");
        let repo = root.path().join("repo");
        let codex_skill = home.join(".agents/skills/review");
        let claude_skill = repo.join(".claude/skills/deploy");
        std::fs::create_dir_all(&codex_skill).expect("codex dir");
        std::fs::create_dir_all(&claude_skill).expect("claude dir");
        std::fs::write(
            codex_skill.join("SKILL.md"),
            "---\nname: review\ndescription: Review code\n---\n",
        )
        .expect("codex skill");
        std::fs::write(
            claude_skill.join("SKILL.md"),
            "---\nname: deploy\ndescription: Deploy project\n---\n",
        )
        .expect("claude skill");

        let codex = discover_agent_skills_in(AdapterKind::Codex, &home, Some(&repo));
        assert_eq!(
            codex.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["review"]
        );
        assert_eq!(codex[0].description, "Review code");
        let claude = discover_agent_skills_in(AdapterKind::Claude, &home, Some(&repo));
        assert_eq!(
            claude.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            vec!["deploy"]
        );
    }

    #[test]
    fn empty_prompt_rejected() {
        assert!(build_agent_command(&claude_profile(), "   ", None).is_err());
    }

    #[test]
    fn credential_flags_rejected() {
        let mut p = claude_profile();
        p.extra_args = vec!["--api-key=abc".to_string()];
        assert!(!p.validate().is_empty());
    }

    #[test]
    fn missing_profile_dir_rejected() {
        let mut p = claude_profile();
        p.working_dir_mode = WorkingDirMode::Profile;
        p.working_dir = None;
        assert!(!p.validate().is_empty());
    }

    #[test]
    fn timeout_bounds_enforced() {
        let mut p = claude_profile();
        p.default_timeout_secs = 0;
        assert!(!p.validate().is_empty());
        p.default_timeout_secs = 99999;
        assert!(!p.validate().is_empty());
    }

    #[test]
    fn nonexistent_node_dir_rejected_at_build() {
        let mut p = claude_profile();
        p.working_dir_mode = WorkingDirMode::Node;
        let err =
            build_agent_command(&p, "hi", Some("/definitely/not/here-xyz")).expect_err("must fail");
        assert!(err.contains("does not exist"));
    }

    #[test]
    fn profile_dir_must_exist_at_build() {
        let mut p = claude_profile();
        p.working_dir_mode = WorkingDirMode::Profile;
        p.working_dir = Some("/definitely/not/here-xyz".to_string());
        assert!(build_agent_command(&p, "hi", None).is_err());
    }

    #[test]
    fn effort_maps_to_claude_flag() {
        let mut p = claude_profile();
        p.effort = Some("high".to_string());
        let spec = build_agent_command(&p, "hi", None).expect("build");
        assert!(spec.args.contains(&"--effort".to_string()));
        assert!(spec.args.contains(&"high".to_string()));
    }

    #[test]
    fn effort_maps_to_codex_config() {
        let mut p = claude_profile();
        p.adapter = AdapterKind::Codex;
        p.effort = Some("xhigh".to_string());
        let spec = build_agent_command(&p, "hi", None).expect("build");
        assert!(spec.args.contains(&"-c".to_string()));
        assert!(spec
            .args
            .iter()
            .any(|a| a.contains("model_reasoning_effort")));
    }

    #[test]
    fn custom_cli_needs_explicit_executable() {
        let mut p = claude_profile();
        p.adapter = AdapterKind::Custom;
        p.executable = None;
        assert!(!p.validate().is_empty());
        assert!(build_agent_command(&p, "hi", None).is_err());
        p.executable = Some("/usr/local/bin/aichat".to_string());
        assert!(p.validate().is_empty());
        let spec = build_agent_command(&p, "do it", None).expect("build");
        assert_eq!(spec.executable, "/usr/local/bin/aichat");
        // Custom CLI contract is unchanged: prompt is the final argv element.
        assert_eq!(spec.args.last().map(String::as_str), Some("do it"));
        assert!(spec.stdin.is_none());
    }

    #[test]
    fn custom_cli_keeps_prompt_after_model_and_extra_arguments() {
        let mut profile = claude_profile();
        profile.adapter = AdapterKind::Custom;
        profile.executable = Some("aichat".into());
        profile.model = Some("local-model".into());
        profile.extra_args = vec!["--no-stream".into()];
        let spec = build_agent_command(&profile, "implement this", None).expect("build");
        assert_eq!(
            spec.args,
            ["--model", "local-model", "--no-stream", "implement this"]
        );
    }

    #[test]
    fn invalid_effort_rejected() {
        let mut p = claude_profile();
        p.effort = Some("ultra".to_string());
        assert!(!p.validate().is_empty());
    }
}
