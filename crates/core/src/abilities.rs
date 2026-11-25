//! What Claude Code and Codex bring from the user's own setup (v0.3.3).
//!
//! A headless step already loads the CLI's own configuration: Claude Code its
//! MCP servers, claude.ai connectors, skills, plugins and `CLAUDE.md`; Codex
//! its MCP servers, plugins and `AGENTS.md`. Two things do not carry over on
//! their own: Claude in Chrome is off unless the run passes `--chrome`, and
//! the tools a step may call without asking follow the permission settings.
//!
//! This module shows the user what is there and lets them decide once:
//! detection reads files and runs the CLI's own listing command (`claude mcp
//! list`, `codex mcp list --json`, `codex plugin list`). It never sends a
//! prompt and never writes a CLI's settings. The choice ([`AppAbilities`]) is
//! applied as flags when a profile resolves for a run
//! ([`crate::agents::AgentProfile::for_run`]).

use crate::agents::AdapterKind;
use crate::process::{run_command, CommandSpec};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Settings key of the app-wide [`AppAbilities`] (JSON).
pub const ABILITIES_SETTING: &str = "agents.abilities";
/// The flag that turns on Claude in Chrome for one Claude Code run.
pub const BROWSER_FLAG: &str = "--chrome";
/// The flag that keeps Claude in Chrome off.
pub const NO_BROWSER_FLAG: &str = "--no-chrome";
/// The MCP server Claude Code adds with [`BROWSER_FLAG`]; allowing it lets a
/// step use the browser without asking.
pub const BROWSER_TOOL_RULE: &str = "mcp__claude-in-chrome";
/// Bound for each listing command. `claude mcp list` health-checks every
/// server, and a first `npx`/`uvx` start can be slow.
pub const DETECT_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_STORED_LEN: usize = 8000;

/// The user's app-wide choice of what Claude Code steps may use from their own
/// setup. Profiles that follow the app default get it; a profile can still
/// turn the browser on or off for itself.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppAbilities {
    /// Run Claude Code steps with Claude in Chrome (`--chrome`), so they can
    /// use the browser the user is signed in to.
    #[serde(default)]
    pub browser: bool,
    /// Claude Code rules (`mcp__claude_ai_Atlassian_Rovo`, `WebFetch`) that
    /// steps of profiles following the app default may use without asking,
    /// passed with `--allowedTools` on top of the Claude Code settings. Unused
    /// at full access, which already allows everything.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_tools: Vec<String>,
}

impl AppAbilities {
    pub fn validate(&self) -> Vec<String> {
        crate::permissions::validate_tool_rules(&self.allowed_tools, "Allowed abilities")
    }
}

/// Parse and validate a value for [`ABILITIES_SETTING`] before it is saved.
pub fn parse_abilities_setting(value: &str) -> Result<AppAbilities, String> {
    if value.len() > MAX_STORED_LEN {
        return Err("Setting value too long.".to_string());
    }
    let invalid = || "Agent abilities must be a JSON object.".to_string();
    let object: serde_json::Value = serde_json::from_str(value).map_err(|_| invalid())?;
    if !object.is_object() {
        return Err(invalid());
    }
    let abilities: AppAbilities = serde_json::from_value(object).map_err(|_| invalid())?;
    let errors = abilities.validate();
    if let Some(first) = errors.into_iter().next() {
        return Err(first);
    }
    Ok(abilities)
}

/// A stored value as runs use it. Anything unreadable grants nothing.
pub fn stored_abilities(value: Option<&str>) -> AppAbilities {
    value
        .and_then(|value| parse_abilities_setting(value).ok())
        .unwrap_or_default()
}

/// One MCP server or account connector the CLI loads on its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConnector {
    /// As the CLI names it: `claude.ai Atlassian Rovo (2)`, `aws-mcp`.
    pub name: String,
    /// Claude Code's allow rule for every tool of the server
    /// (`mcp__claude_ai_Atlassian_Rovo_2`). Codex has no allow-list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule: Option<String>,
    /// `connected`, `needsAuth`, `pending`, `failed`, `enabled`, `disabled`
    /// or `unknown`.
    pub status: &'static str,
    /// `account` (claude.ai), `plugin` or `local`.
    pub scope: &'static str,
    /// Its program and URL origin, for display ([`display_target`]): never
    /// its arguments, which can hold credentials.
    pub target: String,
}

/// Whether the CLI can use the user's browser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostBrowser {
    pub available: bool,
    /// Orchevia can turn it on for a run (Claude Code's `--chrome`). Codex
    /// decides on its own through its plugins.
    pub switchable: bool,
    pub detail: String,
}

/// What one CLI brings from the user's setup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostAbilities {
    pub adapter: AdapterKind,
    pub installed: bool,
    pub connectors: Vec<HostConnector>,
    /// The CLI listed its servers. `false` when the listing could not run or
    /// failed, so an empty `connectors` says nothing about what is set up.
    pub connectors_listed: bool,
    /// Why the connector list is missing or may be incomplete.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connectors_note: Option<String>,
    pub browser: HostBrowser,
    /// File-backed personal skills; plugins can add more.
    pub skills: Vec<String>,
    /// Enabled plugins (Codex).
    pub plugins: Vec<String>,
    /// Personal instruction files every step reads (`~/.claude/CLAUDE.md`).
    pub instructions: Vec<String>,
    /// Rules the user's own Claude Code settings already allow that matter
    /// here: MCP servers and tools, `WebFetch`, `WebSearch`.
    pub allowed_in_settings: Vec<String>,
    pub detected_at: String,
}

/// Claude Code's name for an MCP server inside tool names and allow rules:
/// `claude.ai Atlassian Rovo (2)` → `claude_ai_Atlassian_Rovo_2`. Characters
/// other than letters, digits, `_` and `-` become `_`; claude.ai connector
/// names also lose repeated and outer underscores.
pub fn claude_server_key(name: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if !name.starts_with("claude.ai ") {
        return replaced;
    }
    let mut collapsed = String::with_capacity(replaced.len());
    for c in replaced.chars() {
        if c == '_' && collapsed.ends_with('_') {
            continue;
        }
        collapsed.push(c);
    }
    collapsed.trim_matches('_').to_string()
}

/// The origin of a URL token (`scheme://host[:port]`), without the user
/// name, password, path or query, any of which can hold a secret.
fn url_origin(token: &str) -> Option<String> {
    let (scheme, rest) = token.split_once("://")?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    // Show it only when it reads as a host and port. A password holding a raw
    // "/" cuts the authority early ("user:pa" of "user:pa/ss@host"), and that
    // must not be shown as a host.
    let (name, port) = match host.rsplit_once(':') {
        Some((name, port)) if !name.ends_with(']') || name.starts_with('[') => (name, Some(port)),
        _ => (host, None),
    };
    let name_ok = !name.is_empty()
        && (name.starts_with('[') && name.ends_with(']')
            || name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')));
    let port_ok = port.is_none_or(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    (name_ok && port_ok).then(|| format!("{scheme}://{host}"))
}

/// A server's command line or URL as safe to show: the program's name and the
/// first URL's origin. Arguments, URL paths, queries and credentials can hold
/// secrets (a password in a connection URI, a token in a URL path), so they
/// never leave the backend.
pub fn display_target(raw: &str) -> String {
    let mut tokens = raw.split_whitespace();
    let first = tokens.next().unwrap_or("");
    if let Some(origin) = url_origin(first) {
        return origin;
    }
    let program = Path::new(first)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    match tokens.find_map(url_origin) {
        Some(origin) if !program.is_empty() => format!("{program} · {origin}"),
        Some(origin) => origin,
        None => program,
    }
}

const STATUS_MARKERS: [&str; 7] = [" - ✔", " - ✓", " - ✘", " - ✗", " - !", " - ⏸", " - ⚠"];

/// Parse `claude mcp list`: one `name: target - <mark> status` line per
/// server, after a "Checking MCP server health…" line.
pub fn parse_claude_mcp_list(text: &str) -> Vec<HostConnector> {
    let mut connectors = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some((name, rest)) = line.split_once(": ") else {
            continue;
        };
        let Some(at) = STATUS_MARKERS
            .iter()
            .filter_map(|marker| rest.find(marker))
            .min()
        else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        // The words after the mark: "✔ Connected", "! Needs authentication",
        // "✘ Failed to connect — 401 Unauthorized". Judge by how they start,
        // so "Disconnected" or a 401 in a failure never reads as usable.
        let status_text = rest[at + 3..]
            .trim_start_matches(|c: char| !c.is_ascii_alphabetic())
            .to_ascii_lowercase();
        let status = if status_text.starts_with("connected") {
            "connected"
        } else if status_text.starts_with("needs auth") {
            "needsAuth"
        } else if status_text.starts_with("pending") {
            "pending"
        } else if status_text.starts_with("disabled") {
            "disabled"
        } else if status_text.starts_with("fail")
            || status_text.starts_with("error")
            || status_text.starts_with("disconnected")
        {
            "failed"
        } else {
            "unknown"
        };
        let scope = if name.starts_with("claude.ai ") {
            "account"
        } else if name.starts_with("plugin:") {
            "plugin"
        } else {
            "local"
        };
        connectors.push(HostConnector {
            name: name.to_string(),
            rule: Some(format!("mcp__{}", claude_server_key(name))),
            status,
            scope,
            target: display_target(&rest[..at]),
        });
    }
    connectors
}

/// Parse `codex mcp list --json`.
pub fn parse_codex_mcp_list(json: &str) -> Result<Vec<HostConnector>, String> {
    let value: serde_json::Value = serde_json::from_str(json.trim())
        .map_err(|_| "Codex listed its MCP servers in an unexpected format.".to_string())?;
    let Some(items) = value.as_array() else {
        return Err("Codex listed its MCP servers in an unexpected format.".to_string());
    };
    Ok(items
        .iter()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?.trim();
            if name.is_empty() {
                return None;
            }
            let enabled = item
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let transport = item.get("transport");
            let target = transport
                .and_then(|t| t.get("url"))
                .and_then(|v| v.as_str())
                .map(display_target)
                .or_else(|| {
                    let command = transport?.get("command")?.as_str()?;
                    let args: Vec<&str> = transport
                        .and_then(|t| t.get("args"))
                        .and_then(|v| v.as_array())
                        .map(|args| args.iter().filter_map(|a| a.as_str()).collect())
                        .unwrap_or_default();
                    Some(display_target(
                        &std::iter::once(command)
                            .chain(args)
                            .collect::<Vec<_>>()
                            .join(" "),
                    ))
                })
                .unwrap_or_default();
            Some(HostConnector {
                name: name.to_string(),
                rule: None,
                status: if enabled { "enabled" } else { "disabled" },
                scope: "local",
                target,
            })
        })
        .collect())
}

/// Enabled plugins from `codex plugin list` ("name@marketplace  installed,
/// enabled  …" rows). Opaque app ids are left out.
pub fn parse_codex_plugin_list(text: &str) -> Vec<String> {
    let mut plugins = Vec::new();
    for line in text.lines() {
        if !line.contains("installed, enabled") {
            continue;
        }
        let Some(id) = line.split_whitespace().next() else {
            continue;
        };
        let name = id.split('@').next().unwrap_or(id).to_string();
        let opaque = name
            .strip_prefix("app-")
            .is_some_and(|rest| rest.len() >= 16 && rest.chars().all(|c| c.is_ascii_hexdigit()));
        if !name.is_empty() && !opaque && !plugins.contains(&name) {
            plugins.push(name);
        }
    }
    plugins
}

/// Enabled plugins from Codex's `config.toml`, the fallback when `codex
/// plugin list` cannot run: `[plugins."name@market"]` followed by
/// `enabled = true`.
pub fn codex_config_plugins(config: &str) -> Vec<String> {
    let mut plugins = Vec::new();
    let mut current: Option<String> = None;
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            current = line
                .strip_prefix("[plugins.\"")
                .and_then(|rest| rest.strip_suffix("\"]"))
                .map(|id| id.split('@').next().unwrap_or(id).to_string());
            continue;
        }
        let Some(name) = current.as_ref() else {
            continue;
        };
        let compact: String = line.chars().filter(|c| !c.is_whitespace()).collect();
        if compact == "enabled=true" && !plugins.contains(name) {
            plugins.push(name.clone());
        }
    }
    plugins
}

/// The rules in a Claude Code settings document's `permissions.allow` that
/// matter for abilities: MCP servers and tools, `WebFetch`, `WebSearch`.
pub fn claude_allowed_rules(settings: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(settings) else {
        return Vec::new();
    };
    value
        .get("permissions")
        .and_then(|p| p.get("allow"))
        .and_then(|a| a.as_array())
        .map(|rules| {
            rules
                .iter()
                .filter_map(|rule| rule.as_str())
                .filter(|rule| {
                    rule.starts_with("mcp__")
                        || *rule == "WebFetch"
                        || rule.starts_with("WebFetch(")
                        || *rule == "WebSearch"
                })
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Browser profile folders that may hold native messaging hosts.
fn browser_host_dirs(home: &Path) -> Vec<(&'static str, PathBuf)> {
    let linux = [
        ("Google Chrome", ".config/google-chrome"),
        ("Chromium", ".config/chromium"),
        ("Brave", ".config/BraveSoftware/Brave-Browser"),
        ("Microsoft Edge", ".config/microsoft-edge"),
    ];
    let mac = [
        ("Google Chrome", "Library/Application Support/Google/Chrome"),
        ("Chromium", "Library/Application Support/Chromium"),
        (
            "Brave",
            "Library/Application Support/BraveSoftware/Brave-Browser",
        ),
        (
            "Microsoft Edge",
            "Library/Application Support/Microsoft Edge",
        ),
    ];
    linux
        .into_iter()
        .chain(mac)
        .map(|(name, dir)| (name, home.join(dir).join("NativeMessagingHosts")))
        .collect()
}

fn browsers_with_host(home: &Path, host: &str) -> Vec<&'static str> {
    let mut found = Vec::new();
    for (name, dir) in browser_host_dirs(home) {
        if dir.join(host).is_file() && !found.contains(&name) {
            found.push(name);
        }
    }
    found
}

/// Claude in Chrome: Claude Code installs a native messaging host for the
/// extension, and remembers that it saw the extension in `~/.claude.json`.
pub fn claude_browser(home: &Path) -> HostBrowser {
    let browsers = browsers_with_host(home, "com.anthropic.claude_code_browser_extension.json");
    let seen = std::fs::read_to_string(home.join(".claude.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|config| config.get("cachedChromeExtensionInstalled")?.as_bool())
        .unwrap_or(false);
    if browsers.is_empty() && !seen {
        return HostBrowser {
            available: false,
            switchable: true,
            detail: "Claude in Chrome is not set up. Install the Claude extension in Chrome, then run /chrome once in Claude Code.".to_string(),
        };
    }
    HostBrowser {
        available: true,
        switchable: true,
        detail: if browsers.is_empty() {
            "Claude in Chrome is set up.".to_string()
        } else {
            format!("Claude in Chrome is set up for {}.", browsers.join(", "))
        },
    }
}

/// Codex uses a browser through its own plugins; Orchevia has no switch.
pub fn codex_browser(home: &Path, plugins: &[String]) -> HostBrowser {
    let on: Vec<&str> = plugins
        .iter()
        .map(String::as_str)
        .filter(|p| matches!(*p, "chrome" | "browser" | "browser-use"))
        .collect();
    if !on.is_empty() {
        return HostBrowser {
            available: true,
            switchable: false,
            detail: format!(
                "Codex’s {} plugin{} on; Codex decides when to use {}.",
                on.join(" and "),
                if on.len() == 1 { " is" } else { "s are" },
                if on.len() == 1 { "it" } else { "them" }
            ),
        };
    }
    let extension = !browsers_with_host(home, "com.openai.codexextension.json").is_empty();
    HostBrowser {
        available: false,
        switchable: false,
        detail: if extension {
            "The Codex Chrome extension is installed. Turn on Codex’s Chrome plugin in Codex to use it."
        } else {
            "Codex has no browser plugin turned on."
        }
        .to_string(),
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn codex_home(home: &Path) -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .unwrap_or_else(|| home.join(".codex"))
}

/// Run a listing command in the home folder. `Err` carries what to tell the
/// user.
fn list_output(
    executable: &str,
    args: &[&str],
    home: &Path,
    timeout: Duration,
) -> Result<String, String> {
    let spec = CommandSpec {
        executable: executable.to_string(),
        args: args.iter().map(|a| a.to_string()).collect(),
        working_dir: home.is_dir().then(|| home.to_string_lossy().into_owned()),
        stdin: None,
    };
    let result = run_command(&spec, Some(timeout)).map_err(|e| e.to_string())?;
    if result.timed_out {
        return Err(format!(
            "`{} {}` did not finish within {} s.",
            executable,
            args.join(" "),
            timeout.as_secs()
        ));
    }
    if result.exit_code != Some(0) {
        let detail = result
            .stderr
            .lines()
            .chain(result.stdout.lines())
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("no output")
            .chars()
            .take(200)
            .collect::<String>();
        return Err(format!(
            "`{} {}` failed: {detail}",
            executable,
            args.join(" ")
        ));
    }
    Ok(result.stdout)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Detect what `adapter` (Claude Code or Codex) brings from the user's setup.
/// `executable` overrides the CLI's default name or path. Bounded by
/// `timeout` per listing command.
pub fn detect_abilities(
    adapter: AdapterKind,
    executable: Option<&str>,
    timeout: Duration,
) -> Result<HostAbilities, String> {
    let home = home_dir();
    let executable = executable
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| adapter.default_executable());
    let installed = crate::tools::find_executable(executable).is_some();
    let skills = crate::agents::discover_agent_skills(adapter, None)
        .into_iter()
        .map(|skill| skill.name)
        .collect();
    match adapter {
        AdapterKind::Claude => {
            let (connectors, connectors_note) = if installed {
                match list_output(executable, &["mcp", "list"], &home, timeout) {
                    Ok(text) => (parse_claude_mcp_list(&text), None),
                    Err(message) => (Vec::new(), Some(message)),
                }
            } else {
                (
                    Vec::new(),
                    Some("Claude Code is not installed.".to_string()),
                )
            };
            let instructions = [home.join(".claude/CLAUDE.md")]
                .into_iter()
                .filter(|path| path.is_file())
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            let allowed_in_settings = std::fs::read_to_string(home.join(".claude/settings.json"))
                .map(|text| claude_allowed_rules(&text))
                .unwrap_or_default();
            Ok(HostAbilities {
                adapter,
                installed,
                connectors_listed: connectors_note.is_none(),
                connectors,
                connectors_note,
                browser: claude_browser(&home),
                skills,
                plugins: Vec::new(),
                instructions,
                allowed_in_settings,
                detected_at: now(),
            })
        }
        AdapterKind::Codex => {
            let codex_dir = codex_home(&home);
            let (connectors, connectors_note) = if installed {
                match list_output(executable, &["mcp", "list", "--json"], &home, timeout)
                    .and_then(|json| parse_codex_mcp_list(&json))
                {
                    Ok(list) => (list, None),
                    Err(message) => (Vec::new(), Some(message)),
                }
            } else {
                (Vec::new(), Some("Codex is not installed.".to_string()))
            };
            let plugins = installed
                .then(|| list_output(executable, &["plugin", "list"], &home, timeout).ok())
                .flatten()
                .map(|text| parse_codex_plugin_list(&text))
                .unwrap_or_else(|| {
                    std::fs::read_to_string(codex_dir.join("config.toml"))
                        .map(|text| codex_config_plugins(&text))
                        .unwrap_or_default()
                });
            let instructions = [codex_dir.join("AGENTS.md")]
                .into_iter()
                .filter(|path| path.is_file())
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            Ok(HostAbilities {
                adapter,
                installed,
                connectors_listed: connectors_note.is_none(),
                connectors,
                connectors_note,
                browser: codex_browser(&home, &plugins),
                skills,
                plugins,
                instructions,
                allowed_in_settings: Vec::new(),
                detected_at: now(),
            })
        }
        other => Err(format!(
            "{} uses its own settings; Orchevia lists abilities only for Claude Code and Codex.",
            other.display_name()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_server_keys_match_the_tool_names_claude_code_uses() {
        // Verified against Claude Code 2.1.326's init event, November 2026.
        for (name, key) in [
            ("claude.ai Atlassian Rovo (2)", "claude_ai_Atlassian_Rovo_2"),
            ("claude.ai Atlassian Rovo", "claude_ai_Atlassian_Rovo"),
            ("claude.ai AWS MCP", "claude_ai_AWS_MCP"),
            ("claude.ai Google Drive", "claude_ai_Google_Drive"),
            ("claude-in-chrome", "claude-in-chrome"),
            ("aws-mcp", "aws-mcp"),
            ("plugin:context7:context7", "plugin_context7_context7"),
        ] {
            assert_eq!(claude_server_key(name), key, "{name}");
        }
    }

    #[test]
    fn reads_claude_mcp_list_lines_with_their_status() {
        let text = "Checking MCP server health…\n\n\
claude.ai Atlassian Rovo (2): https://mcp.atlassian.com/v1/mcp - ✔ Connected\n\
claude.ai Sentry: https://mcp.sentry.dev/mcp - ! Needs authentication\n\
phpstorm: http://127.0.0.1:64442/stream (HTTP) - ✘ Failed to connect — ECONNREFUSED: Unable to connect.\n\
aws-mcp: uvx mcp-proxy-for-aws@latest https://aws-mcp.us-east-1.api.aws/mcp --metadata INSTALL_SOURCE=aws-cli - ✔ Connected\n\
local-db: npx -y db-server - ⏸ Pending approval\n\
plugin:context7:context7: npx -y @upstash/context7-mcp - ✔ Connected\n";
        let list = parse_claude_mcp_list(text);
        let rows: Vec<(&str, Option<&str>, &str, &str)> = list
            .iter()
            .map(|c| (c.name.as_str(), c.rule.as_deref(), c.status, c.scope))
            .collect();
        assert_eq!(
            rows,
            [
                (
                    "claude.ai Atlassian Rovo (2)",
                    Some("mcp__claude_ai_Atlassian_Rovo_2"),
                    "connected",
                    "account"
                ),
                (
                    "claude.ai Sentry",
                    Some("mcp__claude_ai_Sentry"),
                    "needsAuth",
                    "account"
                ),
                ("phpstorm", Some("mcp__phpstorm"), "failed", "local"),
                ("aws-mcp", Some("mcp__aws-mcp"), "connected", "local"),
                ("local-db", Some("mcp__local-db"), "pending", "local"),
                (
                    "plugin:context7:context7",
                    Some("mcp__plugin_context7_context7"),
                    "connected",
                    "plugin"
                ),
            ]
        );
        assert_eq!(list[0].target, "https://mcp.atlassian.com");
        assert_eq!(list[2].target, "http://127.0.0.1:64442");
        assert_eq!(list[3].target, "uvx · https://aws-mcp.us-east-1.api.aws");
        assert!(
            parse_claude_mcp_list("No MCP servers configured. Use `claude mcp add`.").is_empty()
        );
        // A failure that mentions authorization, or a disconnected server, is
        // not usable.
        let failing = parse_claude_mcp_list(
            "a: https://a.example/mcp - ✘ Failed to connect — 401 Unauthorized\n\
b: https://b.example/mcp - ✘ Disconnected\n\
c: https://c.example/mcp - ✔ Connected (3 tools)\n",
        );
        let statuses: Vec<&str> = failing.iter().map(|c| c.status).collect();
        assert_eq!(statuses, ["failed", "failed", "connected"]);
    }

    #[test]
    fn reads_codex_servers_and_plugins() {
        let json = r#"[
          {"name":"aws-mcp","enabled":true,"transport":{"type":"stdio","command":"uvx","args":["mcp-proxy-for-aws@latest","https://aws-mcp.us-east-1.api.aws/mcp"]}},
          {"name":"docs","enabled":false,"transport":{"type":"streamable_http","url":"https://example.com/mcp"}}
        ]"#;
        let list = parse_codex_mcp_list(json).expect("list");
        assert_eq!(list[0].status, "enabled");
        assert_eq!(list[0].target, "uvx · https://aws-mcp.us-east-1.api.aws");
        assert_eq!(list[1].status, "disabled");
        assert_eq!(list[1].target, "https://example.com");
        assert!(list.iter().all(|c| c.rule.is_none()));
        assert!(parse_codex_mcp_list("not json").is_err());

        let plugins = "PLUGIN   STATUS   VERSION   SOURCE\n\
browser@openai-bundled               installed, enabled  26.1120  /x\n\
latex@openai-bundled                 not installed                /x\n\
chrome@openai-bundled                installed, enabled  26.1120  /x\n\
app-6a83901dde988191b3f3cefdcc19acfa@openai-curated-remote  installed, enabled  2.0.2  x\n\
gmail@openai-curated-remote          installed, enabled  0.1.10  x\n";
        assert_eq!(
            parse_codex_plugin_list(plugins),
            ["browser", "chrome", "gmail"]
        );
        let config = "[features]\nmemories = true\n\n[plugins.\"chrome@openai-bundled\"]\nenabled = true\n\n[plugins.\"latex@openai-bundled\"]\nenabled = false\n[mcp_servers.x]\nenabled = true\n";
        assert_eq!(codex_config_plugins(config), ["chrome"]);
    }

    #[test]
    fn keeps_only_the_settings_rules_abilities_use() {
        let settings = r#"{"permissions":{"allow":["Bash(git *)","mcp__claude_ai_Atlassian_Rovo_2","mcp__claude_ai_Atlassian_Rovo__search","WebFetch","WebSearch","Read(//home/**)"]}}"#;
        assert_eq!(
            claude_allowed_rules(settings),
            [
                "mcp__claude_ai_Atlassian_Rovo_2",
                "mcp__claude_ai_Atlassian_Rovo__search",
                "WebFetch",
                "WebSearch"
            ]
        );
        assert!(claude_allowed_rules("{").is_empty());
    }

    #[test]
    fn finds_the_browser_extension_hosts() {
        let home = tempfile::tempdir().expect("home");
        assert!(!claude_browser(home.path()).available);
        let hosts = home
            .path()
            .join(".config/BraveSoftware/Brave-Browser/NativeMessagingHosts");
        std::fs::create_dir_all(&hosts).expect("dir");
        std::fs::write(
            hosts.join("com.anthropic.claude_code_browser_extension.json"),
            "{}",
        )
        .expect("host");
        let browser = claude_browser(home.path());
        assert!(browser.available && browser.switchable);
        assert_eq!(browser.detail, "Claude in Chrome is set up for Brave.");

        let codex = codex_browser(home.path(), &["chrome".to_string(), "gmail".to_string()]);
        assert!(codex.available && !codex.switchable);
        assert!(!codex_browser(home.path(), &[]).available);
    }

    #[test]
    fn the_stored_choice_is_validated_and_unreadable_values_grant_nothing() {
        let ok = parse_abilities_setting(
            r#"{"browser":true,"allowedTools":["mcp__claude_ai_Slack","WebFetch"]}"#,
        )
        .expect("valid");
        assert!(ok.browser);
        assert_eq!(ok.allowed_tools, ["mcp__claude_ai_Slack", "WebFetch"]);
        assert!(parse_abilities_setting(r#"{"allowedTools":["Bash(rm -rf /"]}"#).is_err());
        assert!(parse_abilities_setting("[]").is_err());
        // Missing fields take their defaults; an explicit null is refused.
        assert!(parse_abilities_setting(r#"{"browser":null}"#).is_err());
        assert!(parse_abilities_setting(r#"{"allowedTools":null}"#).is_err());
        assert_eq!(
            parse_abilities_setting("{}").expect("empty"),
            AppAbilities::default()
        );
        assert_eq!(stored_abilities(Some("{oops")), AppAbilities::default());
        assert_eq!(stored_abilities(None), AppAbilities::default());
        assert_eq!(
            serde_json::to_string(&AppAbilities::default()).expect("json"),
            r#"{"browser":false}"#
        );
    }

    #[test]
    fn other_clis_report_that_they_use_their_own_settings() {
        assert!(detect_abilities(AdapterKind::Gemini, None, Duration::from_secs(1)).is_err());
    }

    #[cfg(unix)]
    fn fake_cli(dir: &tempfile::TempDir, name: &str, body: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.path().join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("script");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        path.to_string_lossy().into_owned()
    }

    #[cfg(unix)]
    #[test]
    fn detection_runs_only_the_listing_commands() {
        let dir = tempfile::tempdir().expect("dir");
        let log = dir.path().join("calls");
        let claude = fake_cli(
            &dir,
            "claude",
            &format!(
                "echo \"$*\" >> {}\nif [ \"$1 $2\" = \"mcp list\" ]; then\n  echo 'Checking MCP server health…'\n  echo 'claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected'\nelse\n  exit 9\nfi",
                log.display()
            ),
        );
        let found = detect_abilities(AdapterKind::Claude, Some(&claude), Duration::from_secs(10))
            .expect("detect");
        assert!(found.installed);
        assert_eq!(found.connectors.len(), 1);
        assert_eq!(
            found.connectors[0].rule.as_deref(),
            Some("mcp__claude_ai_Slack")
        );
        assert!(found.connectors_note.is_none());
        assert!(found.connectors_listed);
        assert_eq!(std::fs::read_to_string(&log).expect("log"), "mcp list\n");

        let codex_log = dir.path().join("codex-calls");
        let codex = fake_cli(
            &dir,
            "codex",
            &format!("echo \"$*\" >> {}\n", codex_log.display()),
        );
        let codex_body = std::fs::read_to_string(&codex).expect("script")
            + "case \"$*\" in\n  'mcp list --json') echo '[{\"name\":\"docs\",\"enabled\":true,\"transport\":{\"url\":\"https://d.example/mcp\"}}]' ;;\n  'plugin list') echo 'chrome@openai-bundled   installed, enabled  1  x' ;;\n  *) exit 9 ;;\nesac\n";
        std::fs::write(&codex, codex_body).expect("script");
        let found = detect_abilities(AdapterKind::Codex, Some(&codex), Duration::from_secs(10))
            .expect("detect");
        assert_eq!(
            std::fs::read_to_string(&codex_log).expect("log"),
            "mcp list --json\nplugin list\n"
        );
        assert!(found.connectors_listed);
        assert_eq!(found.connectors[0].name, "docs");
        assert_eq!(found.plugins, ["chrome"]);
        assert!(found.browser.available && !found.browser.switchable);

        let broken = fake_cli(&dir, "broken", "echo 'not signed in' >&2\nexit 1");
        let found = detect_abilities(AdapterKind::Claude, Some(&broken), Duration::from_secs(10))
            .expect("detect");
        assert!(found.connectors.is_empty());
        assert!(
            !found.connectors_listed,
            "a failed listing is not an empty one"
        );
        assert!(
            found
                .connectors_note
                .as_deref()
                .unwrap_or("")
                .contains("not signed in"),
            "{found:?}"
        );
        let missing = detect_abilities(
            AdapterKind::Claude,
            Some("orchevia-no-such-claude-v033"),
            Duration::from_secs(1),
        )
        .expect("detect");
        assert!(!missing.installed);
        assert_eq!(
            missing.connectors_note.as_deref(),
            Some("Claude Code is not installed.")
        );
    }

    #[test]
    fn server_targets_never_carry_arguments_or_credentials() {
        for (raw, shown) in [
            (
                "npx -y pg-mcp postgresql://admin:s3cret@db.example:5432/app?sslmode=require",
                "npx · postgresql://db.example:5432",
            ),
            (
                "https://mcp.zapier.com/api/mcp/s/SECRET-TOKEN/sse",
                "https://mcp.zapier.com",
            ),
            ("/opt/tools/my-server --token abc123", "my-server"),
            ("uvx server --api-key=xyz", "uvx"),
            // A raw "/" in a password must not leave half of it behind.
            ("npx pg postgresql://user:pa/ss@db.example/app", "npx"),
            ("http://[::1]:8080/mcp", "http://[::1]:8080"),
            ("", ""),
        ] {
            assert_eq!(display_target(raw), shown, "{raw}");
        }
        let list = parse_claude_mcp_list("db: npx -y pg-mcp postgresql://u:pw@h/x - ✔ Connected\n");
        assert_eq!(list[0].target, "npx · postgresql://h");
        assert!(!format!("{list:?}").contains("pw"));
    }
}
