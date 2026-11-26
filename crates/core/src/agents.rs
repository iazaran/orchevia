//! Generic AI CLI adapter system + Agent Profiles (Milestone 2).
//!
//! The workflow engine never contains Claude/Codex-specific command syntax.
//! Each adapter knows how to turn an [`AgentProfile`] + rendered prompt into
//! a [`CommandSpec`] (executable + args, no shell). Adding a new CLI means
//! adding an adapter implementation + registration + tests, not engine edits.

use crate::process::CommandSpec;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// Linux limits a single argv string to 128 KiB on 4 KiB-page systems.
const MAX_ARG_PROMPT_BYTES: usize = 120 * 1024;

/// Supported AI CLI adapters. Serialized lowercase for stability.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdapterKind {
    Claude,
    Codex,
    Muse,
    Gemini,
    Antigravity,
    OpenCode,
    /// User-registered CLI (added manually in Agents). Contract: prompt is
    /// passed as the final argv element; `--model <m>` is added only when a
    /// model is set; `extra_args` come first. Effort is intentionally
    /// unmapped (the CLI's default applies).
    Custom,
}

impl AdapterKind {
    pub const BUILTIN: [Self; 6] = [
        Self::Claude,
        Self::Codex,
        Self::Muse,
        Self::Antigravity,
        Self::Gemini,
        Self::OpenCode,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Muse => "muse",
            Self::Gemini => "gemini",
            Self::Antigravity => "antigravity",
            Self::OpenCode => "opencode",
            Self::Custom => "custom",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
            Self::Muse => "Muse Code",
            Self::Gemini => "Gemini CLI",
            Self::Antigravity => "Google Antigravity CLI",
            Self::OpenCode => "OpenCode",
            Self::Custom => "Custom CLI",
        }
    }

    pub fn default_executable(self) -> &'static str {
        match self {
            Self::Antigravity => "agy",
            Self::Custom => "",
            _ => self.as_str(),
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::BUILTIN
            .into_iter()
            .chain([Self::Custom])
            .find(|kind| s.eq_ignore_ascii_case(kind.as_str()))
    }

    pub fn supports_profile_controls(self) -> bool {
        matches!(self, Self::Claude | Self::Codex)
    }

    pub fn all() -> Vec<AdapterInfo> {
        Self::BUILTIN.into_iter().chain([Self::Custom]).map(|id| AdapterInfo {
            id,
            display_name: id.display_name().into(),
            default_executable: id.default_executable().into(),
            supports_model_flag: true,
            supports_session_resume: id.supports_profile_controls(),
            notes: match id {
                Self::Claude => "Streams tokens and reported USD through Claude Code. Prompt on stdin.",
                Self::Codex => "Streams tokens through Codex. Prompt on stdin.",
                Self::Muse => "Runs muse exec with Muse Code's permission settings.",
                Self::Gemini => "Runs Gemini CLI headlessly. Requires a supported enterprise or API-key setup.",
                Self::Antigravity => "Runs agy in print mode using your Google sign-in and CLI settings.",
                Self::OpenCode => "Runs opencode run with your connected provider and CLI settings.",
                Self::Custom => "Your own coding CLI. Set the full binary path; prompt goes last.",
            }.into(),
        }).collect()
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
        _ => return Vec::new(),
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

/// What an Agent Profile's CLI may do without asking. Applied only as CLI
/// flags on each invocation: Orchevia never writes `~/.claude/settings.json`,
/// Codex config, or any project settings file, since those also govern the
/// user's interactive sessions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionLevel {
    /// Follow the app-wide agent permission setting
    /// ([`PERMISSION_DEFAULT_SETTING`]), resolved by
    /// [`AgentProfile::with_app_default`] before a run. The default, and what
    /// every profile saved without an explicit level reads as. While that
    /// setting is unset it means [`PermissionLevel::CliSettings`], so an
    /// upgrade widens nothing.
    #[default]
    AppDefault,
    /// No permission flag: the CLI's own settings decide.
    CliSettings,
    /// Claude Code only: `--allowedTools` with the profile's rules, on top of
    /// whatever the Claude Code settings already allow. Codex has no tool
    /// allow-list, so this level is not offered there.
    AllowedTools,
    /// Every permission check bypassed: Claude `--permission-mode
    /// bypassPermissions`, Codex `--dangerously-bypass-approvals-and-sandbox`.
    /// High risk for automation (see `trust.rs`); never a default.
    FullAccess,
}

impl PermissionLevel {
    fn is_app_default(&self) -> bool {
        *self == PermissionLevel::AppDefault
    }
}

/// Settings key of the app-wide agent permission level that profiles at
/// [`PermissionLevel::AppDefault`] follow. Unset until the user chooses (setup
/// wizard, Environment, or the one-time choice before a run), and read as
/// [`PermissionLevel::CliSettings`] until then.
pub const PERMISSION_DEFAULT_SETTING: &str = "agents.permissionDefault";

/// Parse a stored app-wide permission level: only the CLI settings and Full
/// access levels can apply to every profile.
pub fn parse_permission_default(value: &str) -> Result<PermissionLevel, String> {
    match value {
        "cliSettings" => Ok(PermissionLevel::CliSettings),
        "fullAccess" => Ok(PermissionLevel::FullAccess),
        _ => Err("Agent permissions must be cliSettings or fullAccess.".to_string()),
    }
}

/// The app-wide choices a profile follows when it runs: the permission level
/// ([`PERMISSION_DEFAULT_SETTING`]) and the abilities
/// ([`crate::abilities::ABILITIES_SETTING`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppAgentSettings {
    pub permission: PermissionLevel,
    pub abilities: crate::abilities::AppAbilities,
}

impl Default for AppAgentSettings {
    /// Nothing chosen yet: each CLI's own settings, and no abilities.
    fn default() -> Self {
        Self {
            permission: PermissionLevel::CliSettings,
            abilities: crate::abilities::AppAbilities::default(),
        }
    }
}

/// Extra arguments that set permissions themselves and so conflict with a
/// profile-level permission setting (or bypass checks on their own).
fn permission_flags(adapter: AdapterKind) -> &'static [&'static str] {
    match adapter {
        AdapterKind::Claude => &[
            "--permission-mode",
            "--allowedTools",
            "--allowed-tools",
            "--dangerously-skip-permissions",
            "--allow-dangerously-skip-permissions",
        ],
        AdapterKind::Codex => &[
            "--sandbox",
            "-s",
            "--dangerously-bypass-approvals-and-sandbox",
            "--yolo",
            "--full-auto",
            "--approve-for-me",
        ],
        _ => &[],
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
    /// Missing in stored definitions (`agent_profiles.definition`) means
    /// [`PermissionLevel::AppDefault`].
    #[serde(default, skip_serializing_if = "PermissionLevel::is_app_default")]
    pub permission_level: PermissionLevel,
    /// Claude Code allow rules (`Edit`, `mcp__server`, `Bash(git *)`), passed
    /// as `--allowedTools` at the [`PermissionLevel::AllowedTools`] level and
    /// kept, unused, at the other levels.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_tools: Vec<String>,
    /// Claude Code only: run with Claude in Chrome (`--chrome`) so steps can
    /// use the user's own browser. `None` follows the app-wide choice
    /// ([`crate::abilities::AppAbilities::browser`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser: Option<bool>,
}

fn default_timeout() -> u64 {
    3600
}

impl AgentProfile {
    /// Validate configuration without touching the filesystem/network.
    /// Returns human-readable error strings.
    pub fn validate(&self) -> Vec<String> {
        self.validate_with_limit(true)
    }

    /// [`Self::validate`] for a profile resolved with [`Self::for_run`]: its
    /// rule list may hold the saved list plus the rules the run adds, so the
    /// per-list limit (which applies when a list is saved) is not checked.
    fn validate_for_run(&self) -> Vec<String> {
        self.validate_with_limit(false)
    }

    fn validate_with_limit(&self, limit_rules: bool) -> Vec<String> {
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
        if !self.adapter.supports_profile_controls() && !self.skills.is_empty() {
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
        if self.adapter != AdapterKind::Claude && !self.allowed_tools.is_empty() {
            errors.push("Allowed tools apply only to Claude Code profiles.".to_string());
        }
        errors.extend(crate::permissions::validate_tool_rule_list(
            &self.allowed_tools,
            "Allowed tools",
            limit_rules,
        ));
        match (self.adapter, self.permission_level) {
            (_, PermissionLevel::AppDefault | PermissionLevel::CliSettings) => {}
            (adapter, _) if !adapter.supports_profile_controls() => errors.push(
                "Permission levels apply only to Claude Code and Codex profiles.".to_string(),
            ),
            (AdapterKind::Codex, PermissionLevel::AllowedTools) => errors.push(
                "Codex has no tool allow-list. Use Codex settings or Full access.".to_string(),
            ),
            (AdapterKind::Claude, PermissionLevel::AllowedTools)
                if self.allowed_tools.is_empty() =>
            {
                errors.push("Allowed tools needs at least one tool.".to_string())
            }
            _ => {}
        }
        if self.browser == Some(true) && self.adapter != AdapterKind::Claude {
            errors.push("Browser use applies only to Claude Code profiles.".to_string());
        }
        if self.browser.is_some() {
            if let Some(arg) = self.browser_argument() {
                errors.push(format!(
                    "Extra argument '{arg}' conflicts with the profile's browser setting. Remove it or follow the app default."
                ));
            }
        }
        if matches!(
            self.permission_level,
            PermissionLevel::AllowedTools | PermissionLevel::FullAccess
        ) {
            if let Some(arg) = self.permission_argument() {
                errors.push(format!(
                    "Extra argument '{arg}' conflicts with the profile's permission setting. Remove it or use the CLI settings level."
                ));
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

    /// The first extra argument that sets permissions itself, if any.
    fn permission_argument(&self) -> Option<&String> {
        self.extra_args.iter().find(|arg| {
            permission_flags(self.adapter)
                .iter()
                .any(|flag| *arg == flag || arg.starts_with(&format!("{flag}=")))
        })
    }

    /// The profile as a run uses it: [`PermissionLevel::AppDefault`] becomes
    /// the app-wide level (`default`, CLI settings or Full access). A Custom
    /// CLI, or a profile whose extra arguments set permissions themselves,
    /// keeps its own behaviour (CLI settings: no flag added).
    pub fn with_app_default(mut self, default: PermissionLevel) -> Self {
        if self.permission_level == PermissionLevel::AppDefault {
            self.permission_level = match default {
                PermissionLevel::FullAccess
                    if self.adapter.supports_profile_controls()
                        && self.permission_argument().is_none() =>
                {
                    PermissionLevel::FullAccess
                }
                _ => PermissionLevel::CliSettings,
            };
        }
        self
    }

    /// An extra argument that turns Claude in Chrome on or off itself.
    fn browser_argument(&self) -> Option<&String> {
        (self.adapter == AdapterKind::Claude)
            .then(|| {
                self.extra_args.iter().find(|arg| {
                    *arg == crate::abilities::BROWSER_FLAG
                        || *arg == crate::abilities::NO_BROWSER_FLAG
                })
            })
            .flatten()
    }

    /// The profile as a run uses it: the app-wide permission level
    /// ([`Self::with_app_default`]) and the abilities the user chose once
    /// ([`crate::abilities::AppAbilities`]).
    ///
    /// For Claude Code, `browser` becomes the flag the run passes: `Some(true)`
    /// (`--chrome`) when the profile or, following it, the app turns the
    /// browser on; `Some(false)` (`--no-chrome`) when the profile turns it
    /// off; `None` (no flag) when it follows an app that leaves it off, or
    /// when its extra arguments pass `--chrome` or `--no-chrome` themselves. Below full access, the browser's tools and,
    /// for a profile that follows the app default, the abilities allowed in
    /// Environment are added as allow rules: a CLI settings level becomes
    /// Allowed tools with just those rules, and Allowed tools keeps its own
    /// rules plus them. A profile whose extra arguments set permissions keeps
    /// them. Other CLIs get no browser and no rules.
    pub fn for_run(self, app: &AppAgentSettings) -> Self {
        let follows_app = self.permission_level == PermissionLevel::AppDefault;
        let mut profile = self.with_app_default(app.permission);
        if profile.adapter != AdapterKind::Claude {
            profile.browser = None;
            return profile;
        }
        // Its own `--chrome` / `--no-chrome` decides, and so does an explicit
        // Off (passed as `--no-chrome`, so a Claude Code default cannot turn
        // the browser on). Following an app that leaves the browser off adds
        // nothing: the Claude Code settings decide, as before v0.3.3.
        profile.browser = if profile.browser_argument().is_some() {
            None
        } else {
            match profile.browser {
                Some(own) => Some(own),
                None => app.abilities.browser.then_some(true),
            }
        };
        let browser = profile.browser == Some(true);
        if profile.has_full_access() || profile.permission_argument().is_some() {
            return profile;
        }
        let mut grants: Vec<String> = Vec::new();
        if follows_app {
            grants.extend(app.abilities.allowed_tools.iter().cloned());
        }
        if browser {
            grants.push(crate::abilities::BROWSER_TOOL_RULE.to_string());
        }
        if grants.is_empty() {
            return profile;
        }
        let mut rules = match profile.permission_level {
            PermissionLevel::AllowedTools => std::mem::take(&mut profile.allowed_tools),
            PermissionLevel::CliSettings => Vec::new(),
            _ => return profile,
        };
        for rule in grants {
            if !rules.contains(&rule) {
                rules.push(rule);
            }
        }
        profile.permission_level = PermissionLevel::AllowedTools;
        profile.allowed_tools = rules;
        profile
    }

    /// Whether runs with this profile use the user's browser: Claude in Chrome
    /// turned on for it, or `--chrome` among its extra arguments. Call it on a
    /// profile resolved with [`Self::for_run`].
    pub fn uses_browser(&self) -> bool {
        self.adapter == AdapterKind::Claude
            && (self.browser == Some(true)
                || self
                    .extra_args
                    .iter()
                    .any(|arg| arg == crate::abilities::BROWSER_FLAG))
    }

    /// Whether runs with this profile bypass every permission check, through
    /// the Full access level or the profile's own extra arguments. Call it on
    /// a profile resolved with [`AgentProfile::with_app_default`].
    pub fn has_full_access(&self) -> bool {
        if self.permission_level == PermissionLevel::FullAccess {
            return true;
        }
        let args = &self.extra_args;
        args.iter().enumerate().any(|(i, arg)| {
            let next = args.get(i + 1).map(String::as_str);
            match self.adapter {
                AdapterKind::Claude => {
                    arg == "--dangerously-skip-permissions"
                        || arg == "--permission-mode=bypassPermissions"
                        || (arg == "--permission-mode" && next == Some("bypassPermissions"))
                }
                AdapterKind::Codex => {
                    matches!(
                        arg.as_str(),
                        "--dangerously-bypass-approvals-and-sandbox"
                            | "--yolo"
                            | "--sandbox=danger-full-access"
                            | "-sdanger-full-access"
                    ) || (matches!(arg.as_str(), "--sandbox" | "-s")
                        && next == Some("danger-full-access"))
                }
                AdapterKind::Muse => matches!(
                    arg.as_str(),
                    "--yolo" | "--disable-approval" | "--disable-sandbox"
                ),
                AdapterKind::Gemini => {
                    matches!(arg.as_str(), "--yolo" | "-y" | "--approval-mode=yolo")
                        || (arg == "--approval-mode" && next == Some("yolo"))
                }
                AdapterKind::Antigravity => {
                    arg == "--dangerously-skip-permissions"
                        || arg == "--dangerously-skip-permissions=true"
                }
                AdapterKind::OpenCode => arg == "--auto" || arg == "--auto=true",
                AdapterKind::Custom => false,
            }
        })
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
    // Claude reports refused tools only on its structured result event.
    let missing = if profile.adapter == AdapterKind::Claude {
        "no token or cost data, and refused tool calls go undetected"
    } else {
        "no token or cost data"
    };
    if let Some(arg) = claude_reads_custom_input(profile) {
        return StructuredOutput::Conflict(format!(
            "Text output used: the profile's extra argument '{arg}' changes how Claude \
             reads its prompt, so the prompt is passed as an argument and this run reports \
             {missing}. Remove it to enable usage reporting."
        ));
    }
    let flags: &[&str] = match profile.adapter {
        AdapterKind::Claude => &["--output-format"],
        AdapterKind::Codex => &["--json", "--experimental-json"],
        _ => return StructuredOutput::Unsupported,
    };
    for flag in flags {
        if let Some(arg) = has_flag(profile, flag) {
            return StructuredOutput::Conflict(format!(
                "Text output used: the profile's extra argument '{arg}' sets the CLI output \
                 format, so this run reports {missing}. Remove it to enable usage reporting."
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
    let config_errors = profile.validate_for_run();
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
            _ => return Err("This CLI profile cannot invoke skills.".to_string()),
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

/// Codex refuses a folder outside a Git repository unless told otherwise.
/// Steps in a workspace or documents folder are deliberate, so a known
/// folder outside any repository gets `--skip-git-repo-check`, once: never
/// when the profile's own arguments already pass it (Codex rejects a repeated
/// flag). Repository folders and an unknown folder keep Codex's own check.
fn push_codex_outside_repository(
    args: &mut Vec<String>,
    profile: &AgentProfile,
    working_dir: Option<&str>,
) {
    if working_dir.is_some_and(|dir| !crate::git::inside_repository(std::path::Path::new(dir)))
        && !profile
            .extra_args
            .iter()
            .any(|arg| arg == CODEX_SKIP_GIT_CHECK)
    {
        args.push(CODEX_SKIP_GIT_CHECK.to_string());
    }
}

/// Codex's flag for working outside a Git repository.
pub(crate) const CODEX_SKIP_GIT_CHECK: &str = "--skip-git-repo-check";

fn push_model_and_effort(args: &mut Vec<String>, profile: &AgentProfile, effort: Option<&str>) {
    if let Some(model) = profile.model.as_deref().filter(|m| !m.trim().is_empty()) {
        args.push("--model".to_string());
        args.push(model.trim().to_string());
    }
    if let Some(effort) = effort {
        if matches!(
            profile.adapter,
            AdapterKind::Claude | AdapterKind::Antigravity
        ) {
            args.push("--effort".to_string());
            args.push(effort.to_string());
        } else if profile.adapter == AdapterKind::Codex {
            args.push("-c".to_string());
            args.push(format!("model_reasoning_effort=\"{effort}\""));
        }
    }
}

/// Permission flags for the profile's level; nothing at the CLI settings
/// level. Flags only: no settings file is written.
fn push_permissions(args: &mut Vec<String>, profile: &AgentProfile) {
    match (profile.adapter, profile.permission_level) {
        (AdapterKind::Claude, PermissionLevel::AllowedTools) => {
            // One comma-joined value, as the Agent SDK passes it: the flag is
            // variadic, so separate values could swallow a following argument.
            args.push("--allowedTools".into());
            args.push(profile.allowed_tools.join(","));
        }
        (AdapterKind::Claude, PermissionLevel::FullAccess) => {
            args.push("--permission-mode".into());
            args.push("bypassPermissions".into());
        }
        (AdapterKind::Codex, PermissionLevel::FullAccess) => {
            args.push("--dangerously-bypass-approvals-and-sandbox".into());
        }
        _ => {}
    }
}

/// `--chrome` or `--no-chrome` for a Claude Code profile resolved with
/// [`AgentProfile::for_run`]; nothing when its browser choice is `None`.
fn push_browser(args: &mut Vec<String>, profile: &AgentProfile) {
    if profile.adapter != AdapterKind::Claude {
        return;
    }
    match profile.browser {
        Some(true) => args.push(crate::abilities::BROWSER_FLAG.into()),
        Some(false) => args.push(crate::abilities::NO_BROWSER_FLAG.into()),
        None => {}
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
    if matches!(
        profile.adapter,
        AdapterKind::Muse | AdapterKind::OpenCode | AdapterKind::Antigravity | AdapterKind::Gemini
    ) && prompt.len() > MAX_ARG_PROMPT_BYTES
    {
        return Err(format!("{} takes prompts as a command argument. Shorten the prompt or reduce the step's context character limit. The prompt must fit in 120 KiB.", profile.adapter.display_name()));
    }
    let mut args: Vec<String> = Vec::new();
    let stdin = match profile.adapter {
        AdapterKind::Claude if claude_reads_custom_input(profile).is_some() => {
            // Previous invocation, unchanged for profiles with their own input format.
            args.push("-p".to_string());
            args.push(prompt);
            args.push("--output-format".to_string());
            args.push("text".to_string());
            push_model_and_effort(&mut args, profile, effort.as_deref());
            push_permissions(&mut args, profile);
            push_browser(&mut args, profile);
            args.extend(profile.extra_args.iter().cloned());
            None
        }
        AdapterKind::Claude => {
            args.push("-p".to_string());
            args.push("--output-format".to_string());
            args.push("text".to_string());
            push_model_and_effort(&mut args, profile, effort.as_deref());
            push_permissions(&mut args, profile);
            push_browser(&mut args, profile);
            args.extend(profile.extra_args.iter().cloned());
            Some(prompt)
        }
        AdapterKind::Codex => {
            args.push("exec".to_string());
            push_codex_outside_repository(&mut args, profile, working_dir.as_deref());
            push_model_and_effort(&mut args, profile, effort.as_deref());
            push_permissions(&mut args, profile);
            args.push("-".to_string());
            args.extend(profile.extra_args.iter().cloned());
            Some(prompt)
        }
        AdapterKind::Muse | AdapterKind::OpenCode => {
            args.push(
                if profile.adapter == AdapterKind::Muse {
                    "exec"
                } else {
                    "run"
                }
                .into(),
            );
            push_model_and_effort(&mut args, profile, None);
            args.extend(profile.extra_args.iter().cloned());
            args.extend(["--".into(), prompt]);
            None
        }
        AdapterKind::Gemini | AdapterKind::Antigravity => {
            push_model_and_effort(&mut args, profile, effort.as_deref());
            args.extend(profile.extra_args.iter().cloned());
            args.extend(["--output-format".into(), "text".into()]);
            let flag = if profile.adapter == AdapterKind::Gemini {
                "--prompt"
            } else {
                "--print"
            };
            args.push(format!("{flag}={prompt}"));
            None
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
    if !profile.adapter.supports_profile_controls() {
        return Err("This CLI profile does not support structured output.".into());
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
    if profile.adapter == AdapterKind::Codex {
        push_codex_outside_repository(&mut args, profile, working_dir.as_deref());
    }
    push_model_and_effort(&mut args, profile, effort.as_deref());
    push_permissions(&mut args, profile);
    push_browser(&mut args, profile);
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

/// Use ordinary handoffs for automatically created steps whose mapped profile
/// cannot resume a managed session. The caller reports the affected steps.
pub fn use_supported_sessions(
    workflow: &mut crate::workflow::Workflow,
    profiles: &[AgentProfile],
) -> Vec<String> {
    let mut changed = Vec::new();
    for node in &mut workflow.nodes {
        if node.kind != crate::workflow::NodeKind::Agent || node.config.session_group.is_none() {
            continue;
        }
        let profile = profiles
            .iter()
            .find(|p| Some(p.id.as_str()) == node.config.agent_profile_id.as_deref());
        if profile.is_some_and(|p| !p.adapter.supports_profile_controls()) {
            node.config.session_group = None;
            node.config.session_max_turns = None;
            changed.push(node.label.clone().unwrap_or_else(|| node.id.clone()));
        }
    }
    changed
}

/// Managed conversations require explicit ids and structured output. Conflicting
/// user flags are rejected before invoking the CLI rather than overriding them.
pub fn validate_session_profile(profile: &AgentProfile) -> Result<(), String> {
    if !profile.adapter.supports_profile_controls() {
        return Err(format!(
            "{} profiles do not support session groups.",
            profile.adapter.display_name()
        ));
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

    #[test]
    fn new_adapters_use_headless_text_and_keep_cli_permissions() {
        for (kind, executable, expected) in [
            (
                AdapterKind::Muse,
                "muse",
                vec!["exec", "--model", "test-model", "--", "--prompt-like"],
            ),
            (
                AdapterKind::Gemini,
                "gemini",
                vec![
                    "--model",
                    "test-model",
                    "--output-format",
                    "text",
                    "--prompt=--prompt-like",
                ],
            ),
            (
                AdapterKind::Antigravity,
                "agy",
                vec![
                    "--model",
                    "test-model",
                    "--output-format",
                    "text",
                    "--print=--prompt-like",
                ],
            ),
            (
                AdapterKind::OpenCode,
                "opencode",
                vec!["run", "--model", "test-model", "--", "--prompt-like"],
            ),
        ] {
            let mut profile = AgentProfile {
                adapter: kind,
                ..claude_profile()
            };
            profile.permission_level = PermissionLevel::AppDefault;
            profile.model = Some("test-model".into());
            let profile = profile.with_app_default(PermissionLevel::FullAccess);
            assert_eq!(profile.permission_level, PermissionLevel::CliSettings);
            assert!(validate_session_profile(&profile).is_err());
            assert!(matches!(
                structured_output(&profile),
                StructuredOutput::Unsupported
            ));
            let actual = build_agent_command(&profile, "--prompt-like", None).unwrap();
            assert_eq!(actual.executable, executable);
            assert_eq!(actual.args, expected);
            assert!(actual.stdin.is_none());
        }
    }

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
            permission_level: PermissionLevel::CliSettings,
            allowed_tools: vec![],
            browser: None,
        }
    }

    #[test]
    fn oversized_multibyte_prompt_has_an_actionable_error() {
        let profile = AgentProfile {
            adapter: AdapterKind::Muse,
            ..claude_profile()
        };
        let error = build_agent_command(&profile, &"💬".repeat(32_000), None).unwrap_err();
        assert!(error.contains("prompt must fit in 120 KiB"), "{error}");
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
    fn stored_profiles_without_a_permission_setting_follow_the_app_default() {
        let stored = r#"{"id":"p","name":"Old","adapter":"claude","extraArgs":[],"workingDirMode":"node","defaultTimeoutSecs":3600}"#;
        let profile: AgentProfile = serde_json::from_str(stored).expect("legacy definition");
        assert_eq!(profile.permission_level, PermissionLevel::AppDefault);
        assert!(profile.allowed_tools.is_empty());
        assert!(!profile.has_full_access());
        // The default is not written back, so stored definitions of existing
        // profiles stay byte-identical.
        let value = serde_json::to_value(&profile).unwrap();
        assert!(value.get("permissionLevel").is_none());
        assert!(value.get("allowedTools").is_none());
        // Until the user chooses, the app default is the CLI's own settings:
        // no flag, exactly as before this setting existed.
        for profile in [
            profile.clone(),
            profile
                .clone()
                .with_app_default(PermissionLevel::CliSettings),
        ] {
            let spec = build_agent_command(&profile, "hi", None).unwrap();
            assert_eq!(
                spec.args,
                ["-p", "--output-format", "stream-json", "--verbose"]
            );
        }
        // An explicit CLI settings choice is kept, so it can override a Full
        // access app default.
        let mut explicit = profile;
        explicit.permission_level = PermissionLevel::CliSettings;
        let value = serde_json::to_value(&explicit).unwrap();
        assert_eq!(value["permissionLevel"], "cliSettings");
        let back: AgentProfile = serde_json::from_value(value).unwrap();
        assert_eq!(back.permission_level, PermissionLevel::CliSettings);
    }

    #[test]
    fn the_app_default_resolves_per_profile() {
        let full = |profile: AgentProfile| profile.with_app_default(PermissionLevel::FullAccess);
        let mut claude = claude_profile();
        claude.permission_level = PermissionLevel::AppDefault;
        let resolved = full(claude.clone());
        assert_eq!(resolved.permission_level, PermissionLevel::FullAccess);
        assert!(resolved.has_full_access());
        assert!(build_agent_command(&resolved, "hi", None)
            .unwrap()
            .args
            .windows(2)
            .any(|w| w == ["--permission-mode", "bypassPermissions"]));
        let mut codex = claude.clone();
        codex.adapter = AdapterKind::Codex;
        assert!(build_agent_command(&full(codex), "hi", None)
            .unwrap()
            .args
            .iter()
            .any(|a| a == "--dangerously-bypass-approvals-and-sandbox"));
        // Explicit levels are the profile's own choice and win.
        for level in [
            PermissionLevel::CliSettings,
            PermissionLevel::AllowedTools,
            PermissionLevel::FullAccess,
        ] {
            let mut own = claude.clone();
            own.permission_level = level;
            own.allowed_tools = vec!["Edit".into()];
            assert_eq!(full(own).permission_level, level);
        }
        // A profile whose own arguments set permissions keeps them, and a
        // Custom CLI has no permission flags to add.
        let mut own_flags = claude.clone();
        own_flags.extra_args = vec!["--permission-mode".into(), "acceptEdits".into()];
        assert!(
            own_flags.validate().is_empty(),
            "{:?}",
            own_flags.validate()
        );
        let resolved = full(own_flags);
        assert_eq!(resolved.permission_level, PermissionLevel::CliSettings);
        assert!(!resolved.has_full_access());
        let mut custom = claude.clone();
        custom.adapter = AdapterKind::Custom;
        custom.executable = Some("/usr/bin/aichat".into());
        custom.model = None;
        assert!(custom.validate().is_empty(), "{:?}", custom.validate());
        assert_eq!(full(custom).permission_level, PermissionLevel::CliSettings);
        // Only the two app-wide levels parse.
        assert_eq!(
            parse_permission_default("fullAccess"),
            Ok(PermissionLevel::FullAccess)
        );
        assert_eq!(
            parse_permission_default("cliSettings"),
            Ok(PermissionLevel::CliSettings)
        );
        for value in ["allowedTools", "appDefault", "", "FullAccess"] {
            assert!(parse_permission_default(value).is_err(), "{value}");
        }
    }

    #[test]
    fn permission_levels_map_to_cli_flags_only() {
        let mut claude = claude_profile();
        claude.permission_level = PermissionLevel::AllowedTools;
        claude.allowed_tools = vec![
            "mcp__claude_ai_Atlassian_Rovo_2".into(),
            "Bash(git status *)".into(),
            "Edit".into(),
        ];
        assert!(claude.validate().is_empty(), "{:?}", claude.validate());
        let spec = build_agent_command(&claude, "hi", None).unwrap();
        assert_eq!(
            spec.args,
            [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--model",
                "opus",
                "--allowedTools",
                "mcp__claude_ai_Atlassian_Rovo_2,Bash(git status *),Edit"
            ]
        );
        // Text and session invocations carry the same flags.
        let text = build_text_agent_command(&claude, "hi", None).unwrap();
        assert!(text.args.ends_with(&[
            "--allowedTools".to_string(),
            "mcp__claude_ai_Atlassian_Rovo_2,Bash(git status *),Edit".to_string()
        ]));
        let id = "00000000-0000-4000-8000-000000000001";
        let session = build_session_command(&claude, "hi", None, Some(id)).unwrap();
        assert!(session.args.windows(2).any(|w| w[0] == "--allowedTools"));
        assert_eq!(session.args.last().unwrap(), id);

        claude.permission_level = PermissionLevel::FullAccess;
        assert!(claude.has_full_access());
        let spec = build_agent_command(&claude, "hi", None).unwrap();
        assert!(spec
            .args
            .windows(2)
            .any(|w| w == ["--permission-mode", "bypassPermissions"]));
        assert!(!spec.args.iter().any(|a| a == "--allowedTools"));

        let mut codex = claude_profile();
        codex.adapter = AdapterKind::Codex;
        codex.permission_level = PermissionLevel::FullAccess;
        let spec = build_agent_command(&codex, "hi", None).unwrap();
        assert_eq!(
            spec.args,
            [
                "exec",
                "--json",
                "--model",
                "opus",
                "--dangerously-bypass-approvals-and-sandbox",
                "-"
            ]
        );
        let resumed = build_session_command(&codex, "hi", None, Some(id)).unwrap();
        let bypass = resumed
            .args
            .iter()
            .position(|a| a == "--dangerously-bypass-approvals-and-sandbox")
            .unwrap();
        let resume = resumed.args.iter().position(|a| a == "resume").unwrap();
        assert!(
            bypass < resume,
            "exec options precede the resume subcommand"
        );
        codex.permission_level = PermissionLevel::CliSettings;
        let spec = build_agent_command(&codex, "hi", None).unwrap();
        assert_eq!(spec.args, ["exec", "--json", "--model", "opus", "-"]);
    }

    #[test]
    fn codex_runs_outside_a_repository_only_where_asked() {
        let outside = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        std::fs::create_dir(repo.path().join(".git")).unwrap();
        let nested = repo.path().join("docs");
        std::fs::create_dir(&nested).unwrap();
        let mut codex = claude_profile();
        codex.adapter = AdapterKind::Codex;
        codex.permission_level = PermissionLevel::CliSettings;
        codex.working_dir_mode = WorkingDirMode::Node;
        let dir = |p: &std::path::Path| p.to_string_lossy().into_owned();
        let flagged = |spec: &CommandSpec| spec.args.iter().any(|a| a == "--skip-git-repo-check");
        let spec = build_agent_command(&codex, "hi", Some(&dir(outside.path()))).unwrap();
        assert_eq!(spec.args[..3], ["exec", "--json", "--skip-git-repo-check"]);
        let resumed = build_session_command(
            &codex,
            "hi",
            Some(&dir(outside.path())),
            Some("019a0000-0000-7000-8000-000000000001"),
        )
        .unwrap();
        let skip = resumed
            .args
            .iter()
            .position(|a| a == "--skip-git-repo-check")
            .unwrap();
        let resume = resumed.args.iter().position(|a| a == "resume").unwrap();
        assert!(skip < resume, "exec options precede the resume subcommand");
        let text = build_text_agent_command(&codex, "hi", Some(&dir(outside.path()))).unwrap();
        assert_eq!(text.args[..2], ["exec", "--skip-git-repo-check"]);
        for inside in [repo.path(), nested.as_path()] {
            assert!(!flagged(
                &build_agent_command(&codex, "hi", Some(&dir(inside))).unwrap()
            ));
        }
        assert!(!flagged(&build_agent_command(&codex, "hi", None).unwrap()));
        let mut claude = claude_profile();
        claude.working_dir_mode = WorkingDirMode::Node;
        assert!(!flagged(
            &build_agent_command(&claude, "hi", Some(&dir(outside.path()))).unwrap()
        ));
        // A profile that already passes the flag gets it once.
        codex.extra_args = vec!["--skip-git-repo-check".into()];
        let spec = build_agent_command(&codex, "hi", Some(&dir(outside.path()))).unwrap();
        assert_eq!(
            spec.args
                .iter()
                .filter(|a| *a == "--skip-git-repo-check")
                .count(),
            1
        );
    }

    #[test]
    fn permission_settings_are_validated_per_adapter() {
        let mut p = claude_profile();
        p.permission_level = PermissionLevel::AllowedTools;
        assert!(p.validate().iter().any(|e| e.contains("at least one tool")));
        p.allowed_tools = vec![
            "Bash(git *)".into(),
            "--dangerously-skip-permissions".into(),
        ];
        assert!(p
            .validate()
            .iter()
            .any(|e| e.contains("Invalid allowed tool")));
        p.allowed_tools = vec!["Edit".into()];
        p.extra_args = vec!["--permission-mode".into(), "acceptEdits".into()];
        assert!(p
            .validate()
            .iter()
            .any(|e| e.contains("conflicts with the profile's permission setting")));
        // Extra permission flags stay the user's own choice at the default level.
        p.permission_level = PermissionLevel::CliSettings;
        assert!(p.validate().is_empty(), "{:?}", p.validate());

        let mut codex = claude_profile();
        codex.adapter = AdapterKind::Codex;
        codex.permission_level = PermissionLevel::AllowedTools;
        codex.allowed_tools = vec!["Edit".into()];
        let errors = codex.validate();
        assert!(errors.iter().any(|e| e.contains("no tool allow-list")));
        assert!(errors
            .iter()
            .any(|e| e.contains("only to Claude Code profiles")));
        codex.allowed_tools.clear();
        codex.permission_level = PermissionLevel::FullAccess;
        assert!(codex.validate().is_empty());
        codex.extra_args = vec!["--sandbox".into(), "read-only".into()];
        assert!(!codex.validate().is_empty());

        let mut custom = claude_profile();
        custom.adapter = AdapterKind::Custom;
        custom.executable = Some("/usr/local/bin/aichat".into());
        custom.permission_level = PermissionLevel::FullAccess;
        assert!(custom
            .validate()
            .iter()
            .any(|e| e.contains("only to Claude Code and Codex")));
    }

    #[test]
    fn full_access_is_recognised_in_extra_arguments_too() {
        let mut claude = claude_profile();
        for args in [
            vec!["--dangerously-skip-permissions"],
            vec!["--permission-mode", "bypassPermissions"],
            vec!["--permission-mode=bypassPermissions"],
        ] {
            claude.extra_args = args.iter().map(|a| a.to_string()).collect();
            assert!(claude.has_full_access(), "{args:?}");
        }
        claude.extra_args = vec!["--permission-mode".into(), "acceptEdits".into()];
        assert!(!claude.has_full_access());
        let mut codex = claude_profile();
        codex.adapter = AdapterKind::Codex;
        for args in [
            vec!["--sandbox", "danger-full-access"],
            vec!["-s", "danger-full-access"],
            vec!["--yolo"],
        ] {
            codex.extra_args = args.iter().map(|a| a.to_string()).collect();
            assert!(codex.has_full_access(), "{args:?}");
        }
        codex.extra_args = vec!["--sandbox".into(), "workspace-write".into()];
        assert!(!codex.has_full_access());
    }

    #[test]
    fn conflicting_output_flags_keep_the_text_invocation_with_a_note() {
        let mut claude = claude_profile();
        claude.extra_args = vec!["--output-format".into(), "json".into()];
        let StructuredOutput::Conflict(note) = structured_output(&claude) else {
            panic!("--output-format must conflict");
        };
        assert!(note.contains("--output-format") && note.contains("no token or cost data"));
        assert!(note.contains("refused tool calls go undetected"));
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

    fn app(permission: PermissionLevel, browser: bool, allowed: &[&str]) -> AppAgentSettings {
        AppAgentSettings {
            permission,
            abilities: crate::abilities::AppAbilities {
                browser,
                allowed_tools: allowed.iter().map(|r| r.to_string()).collect(),
            },
        }
    }

    fn following() -> AgentProfile {
        AgentProfile {
            permission_level: PermissionLevel::AppDefault,
            ..claude_profile()
        }
    }

    #[test]
    fn the_browser_ability_adds_chrome_and_allows_its_tools_below_full_access() {
        let profile = following().for_run(&app(PermissionLevel::CliSettings, true, &[]));
        assert_eq!(profile.browser, Some(true));
        assert_eq!(profile.permission_level, PermissionLevel::AllowedTools);
        assert_eq!(profile.allowed_tools, ["mcp__claude-in-chrome"]);
        let spec = build_agent_command(&profile, "hello", None).expect("build");
        let chrome = spec
            .args
            .iter()
            .position(|a| a == "--chrome")
            .expect("--chrome");
        let allowed = spec
            .args
            .windows(2)
            .position(|w| w == ["--allowedTools", "mcp__claude-in-chrome"])
            .expect("allowed");
        assert!(allowed < chrome, "{:?}", spec.args);
        // Text and session invocations carry it too.
        let text = build_text_agent_command(&profile, "hello", None).expect("text");
        assert!(text.args.iter().any(|a| a == "--chrome"));

        let full = following().for_run(&app(PermissionLevel::FullAccess, true, &["WebFetch"]));
        assert_eq!(full.permission_level, PermissionLevel::FullAccess);
        assert!(full.allowed_tools.is_empty());
        let spec = build_agent_command(&full, "hello", None).expect("build");
        assert!(spec.args.iter().any(|a| a == "--chrome"));
        assert!(!spec.args.iter().any(|a| a == "--allowedTools"));
    }

    #[test]
    fn a_profile_choice_overrides_the_app_browser_and_its_own_flags_win() {
        let on = app(PermissionLevel::CliSettings, true, &[]);
        let off = AgentProfile {
            browser: Some(false),
            ..following()
        }
        .for_run(&on);
        assert_eq!(off.browser, Some(false));
        assert_eq!(off.permission_level, PermissionLevel::CliSettings);
        let spec = build_agent_command(&off, "hello", None).expect("build");
        // Off is passed on, so a Claude Code default cannot turn it on.
        assert!(
            spec.args.iter().any(|a| a == "--no-chrome"),
            "{:?}",
            spec.args
        );
        assert!(!spec.args.iter().any(|a| a == "--chrome"));
        // Following an app that leaves the browser off adds no flag at all.
        let quiet = following().for_run(&AppAgentSettings::default());
        assert_eq!(quiet.browser, None);
        let spec = build_agent_command(&quiet, "hello", None).expect("build");
        assert!(
            !spec.args.iter().any(|a| a.contains("chrome")),
            "{:?}",
            spec.args
        );

        let own = AgentProfile {
            browser: Some(true),
            ..following()
        }
        .for_run(&AppAgentSettings::default());
        assert_eq!(own.browser, Some(true));
        assert!(own.uses_browser());

        let flagged = AgentProfile {
            extra_args: vec!["--no-chrome".into()],
            ..following()
        }
        .for_run(&on);
        assert_eq!(flagged.browser, None);
        assert!(!flagged.uses_browser());
        let spec = build_agent_command(&flagged, "hello", None).expect("build");
        assert_eq!(spec.args.iter().filter(|a| a.contains("chrome")).count(), 1);

        let user_flag = AgentProfile {
            extra_args: vec!["--chrome".into()],
            ..claude_profile()
        }
        .for_run(&AppAgentSettings::default());
        assert!(
            user_flag.uses_browser(),
            "its own --chrome still uses the browser"
        );
    }

    #[test]
    fn allowed_abilities_reach_only_profiles_that_follow_the_app_default() {
        let settings = app(
            PermissionLevel::CliSettings,
            false,
            &["mcp__claude_ai_Atlassian_Rovo", "WebFetch"],
        );
        let follows = following().for_run(&settings);
        assert_eq!(follows.permission_level, PermissionLevel::AllowedTools);
        assert_eq!(
            follows.allowed_tools,
            ["mcp__claude_ai_Atlassian_Rovo", "WebFetch"]
        );

        // An explicit CLI settings level keeps the CLI's settings alone.
        let own = claude_profile().for_run(&settings);
        assert_eq!(own.permission_level, PermissionLevel::CliSettings);
        assert!(own.allowed_tools.is_empty());

        // Its own Allowed tools level keeps its rules and adds only the browser's.
        let listed = AgentProfile {
            permission_level: PermissionLevel::AllowedTools,
            allowed_tools: vec!["Edit".into()],
            ..claude_profile()
        };
        assert_eq!(listed.clone().for_run(&settings).allowed_tools, ["Edit"]);
        let with_browser = listed.for_run(&app(PermissionLevel::CliSettings, true, &["WebFetch"]));
        assert_eq!(
            with_browser.allowed_tools,
            ["Edit", "mcp__claude-in-chrome"]
        );

        // A profile whose extra arguments set permissions keeps them.
        let flags = AgentProfile {
            extra_args: vec!["--permission-mode".into(), "acceptEdits".into()],
            ..following()
        }
        .for_run(&settings);
        assert_eq!(flags.permission_level, PermissionLevel::CliSettings);
        assert!(flags.allowed_tools.is_empty());
    }

    #[test]
    fn a_full_saved_list_still_runs_with_the_rules_a_run_adds() {
        let full = AgentProfile {
            permission_level: PermissionLevel::AllowedTools,
            allowed_tools: (0..crate::permissions::MAX_TOOL_RULES)
                .map(|i| format!("mcp__server_{i}"))
                .collect(),
            ..claude_profile()
        };
        assert!(full.validate().is_empty());
        let run = full.for_run(&app(PermissionLevel::CliSettings, true, &[]));
        assert_eq!(
            run.allowed_tools.len(),
            crate::permissions::MAX_TOOL_RULES + 1
        );
        // Saving such a list is refused; running with it is not.
        assert!(!run.validate().is_empty());
        let spec = build_agent_command(&run, "hello", None).expect("build");
        assert!(spec.args.iter().any(|a| a == "--chrome"));
    }

    #[test]
    fn other_clis_get_no_browser_and_no_rules() {
        let codex = AgentProfile {
            adapter: AdapterKind::Codex,
            model: None,
            browser: None,
            ..following()
        }
        .for_run(&app(PermissionLevel::CliSettings, true, &["WebFetch"]));
        assert_eq!(codex.browser, None);
        assert_eq!(codex.permission_level, PermissionLevel::CliSettings);
        assert!(codex.allowed_tools.is_empty());
        let spec = build_agent_command(&codex, "hello", None).expect("build");
        assert!(!spec.args.iter().any(|a| a.contains("chrome")));
        assert!(!codex.uses_browser());
    }

    #[test]
    fn browser_settings_are_validated() {
        let codex = AgentProfile {
            adapter: AdapterKind::Codex,
            browser: Some(true),
            ..claude_profile()
        };
        assert!(codex
            .validate()
            .contains(&"Browser use applies only to Claude Code profiles.".to_string()));
        let conflict = AgentProfile {
            browser: Some(true),
            extra_args: vec!["--no-chrome".into()],
            ..claude_profile()
        };
        assert!(conflict
            .validate()
            .iter()
            .any(|e| e.contains("'--no-chrome'")));
        let fine = AgentProfile {
            browser: Some(false),
            ..claude_profile()
        };
        assert!(fine.validate().is_empty());
        // "Off" with --chrome among the extra arguments would still use the browser.
        let off_but_flagged = AgentProfile {
            browser: Some(false),
            extra_args: vec!["--chrome".into()],
            ..claude_profile()
        };
        assert!(off_but_flagged
            .validate()
            .iter()
            .any(|e| e.contains("'--chrome'")));
        // Saved without the field, it reads as following the app.
        let stored: AgentProfile = serde_json::from_value(serde_json::json!({
            "id": "p", "name": "P", "adapter": "claude", "extraArgs": [],
            "workingDirMode": "node", "defaultTimeoutSecs": 60
        }))
        .expect("profile");
        assert_eq!(stored.browser, None);
        assert!(serde_json::to_value(&stored)
            .expect("json")
            .get("browser")
            .is_none());
    }
}
