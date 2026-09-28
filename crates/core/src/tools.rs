//! Generic local CLI discovery.
//!
//! A `ToolDefinition` describes an optional external executable; discovery
//! finds it on `PATH` and probes `--version` safely (no shell, short
//! timeout). The UI renders whatever definitions are registered, so adding a
//! new tool does not require UI or engine changes.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

use crate::process::{run_command, CommandSpec};

/// Built-in tool identifiers for Milestone 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KnownTool {
    Git,
    Gh,
    Claude,
    Codex,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub id: String,
    pub display_name: String,
    pub executables: Vec<String>,
    pub version_args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub id: String,
    pub display_name: String,
    pub installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// Default registry: the four optional CLIs from Milestone 1.
pub fn default_tools() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            id: "git".into(),
            display_name: "Git".into(),
            executables: vec!["git".into()],
            version_args: vec!["--version".into()],
        },
        ToolDefinition {
            id: "gh".into(),
            display_name: "GitHub CLI".into(),
            executables: vec!["gh".into()],
            version_args: vec!["--version".into()],
        },
        ToolDefinition {
            id: "claude".into(),
            display_name: "Claude Code".into(),
            executables: vec!["claude".into()],
            version_args: vec!["--version".into()],
        },
        ToolDefinition {
            id: "codex".into(),
            display_name: "Codex".into(),
            executables: vec!["codex".into()],
            version_args: vec!["--version".into()],
        },
    ]
}

/// Discover all registered tools.
pub fn discover_tools(definitions: &[ToolDefinition]) -> Vec<ToolStatus> {
    definitions.iter().map(discover_one).collect()
}

fn discover_one(def: &ToolDefinition) -> ToolStatus {
    for exe in &def.executables {
        if let Some(path) = find_executable(exe) {
            let version = probe_version(&path, &def.version_args);
            return ToolStatus {
                id: def.id.clone(),
                display_name: def.display_name.clone(),
                installed: true,
                version,
                path: Some(path.to_string_lossy().into_owned()),
            };
        }
    }
    ToolStatus {
        id: def.id.clone(),
        display_name: def.display_name.clone(),
        installed: false,
        version: None,
        path: None,
    }
}

/// Well-known install locations beyond `PATH`.
///
/// GUI-launched desktop apps do not inherit the user's shell `PATH`
/// (`.bashrc`/`.zshrc`, nvm/mise/volta shims), so CLIs installed for the
/// terminal are invisible to a pure `PATH` lookup. These fallbacks cover the
/// installers and version managers developers actually use; every candidate
/// is an explicit file check, nothing is executed here.
pub fn fallback_candidates(exe: &str, home: Option<&std::path::Path>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(h) = home {
        for sub in [
            ".local/bin",
            ".npm-global/bin",
            ".volta/bin",
            ".asdf/shims",
            ".local/share/mise/shims",
        ] {
            dirs.push(h.join(sub));
        }
    }
    for fixed in [
        "/usr/local/bin",
        "/usr/bin",
        "/opt/homebrew/bin",
        "/opt/local/bin",
        "/snap/bin",
    ] {
        dirs.push(PathBuf::from(fixed));
    }
    dirs.into_iter()
        .map(|d| d.join(exe))
        .filter(|p| p.is_file())
        .collect()
}

/// Find an executable on `PATH`, falling back to well-known install
/// locations (see [`fallback_candidates`]). Pure lookup: never executes.
pub fn find_executable(exe: &str) -> Option<PathBuf> {
    if let Some(path) = find_on_path(exe) {
        return Some(path);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    fallback_candidates(exe, home.as_deref()).into_iter().next()
}

/// Resolve a bare executable name to an absolute path (`PATH` plus
/// well-known install locations). Pass-through when `exe` already contains
/// a path separator. Used before every spawn so GUI-launched processes find
/// terminal-installed CLIs.
pub fn resolve_executable(exe: &str) -> Option<String> {
    let trimmed = exe.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Some(trimmed.to_string());
    }
    find_executable(trimmed).map(|p| p.to_string_lossy().into_owned())
}

/// [`resolve_executable`], with a user-facing error explaining how to fix it.
pub fn require_executable(exe: &str) -> Result<String, String> {
    resolve_executable(exe).ok_or_else(|| {
        format!(
            "'{exe}' was not found on PATH or in well-known install locations. Install it, \
             launch Orchevia from a terminal once so it inherits your shell PATH, or set \
             the full binary path explicitly."
        )
    })
}

pub fn find_on_path(exe: &str) -> Option<PathBuf> {
    if exe.contains('/') || exe.contains('\\') {
        let p = PathBuf::from(exe);
        return p.is_file().then_some(p);
    }
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        let candidate = dir.join(exe);
        if candidate.is_file() {
            return Some(candidate);
        }
        // Windows PATHEXT handling (harmless elsewhere, future-proofing).
        #[cfg(windows)]
        for ext in ["exe", "cmd", "bat"] {
            let with_ext = candidate.with_extension(ext);
            if with_ext.is_file() {
                return Some(with_ext);
            }
        }
    }
    None
}

/// Run `<exe> <version_args>` with a short timeout; return the first line.
fn probe_version(exe: &std::path::Path, version_args: &[String]) -> Option<String> {
    let exe_str = exe.to_string_lossy().into_owned();
    let spec = CommandSpec {
        executable: exe_str,
        args: version_args.to_vec(),
        working_dir: None,
    };
    let result = run_command(&spec, Some(Duration::from_secs(5))).ok()?;
    if result.exit_code != Some(0) {
        return None;
    }
    let combined = format!("{}\n{}", result.stdout, result.stderr);
    combined
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(120).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_tool_reports_not_found() {
        let defs = vec![ToolDefinition {
            id: "nope".into(),
            display_name: "Nope".into(),
            executables: vec!["orchevia-definitely-missing-binary-xyz".into()],
            version_args: vec!["--version".into()],
        }];
        let statuses = discover_tools(&defs);
        assert_eq!(statuses.len(), 1);
        assert!(!statuses[0].installed);
        assert!(statuses[0].version.is_none());
    }

    #[test]
    fn echo_based_tool_is_discovered() {
        // `sh` should exist on every Unix dev machine; use it as a stand-in.
        let defs = vec![ToolDefinition {
            id: "sh".into(),
            display_name: "Shell".into(),
            executables: vec!["sh".into()],
            version_args: vec!["--version".into()],
        }];
        let statuses = discover_tools(&defs);
        assert!(statuses[0].installed);
        assert!(statuses[0].path.is_some());
    }

    #[test]
    fn fallback_candidates_find_home_binaries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bin_dir = dir.path().join(".local").join("bin");
        std::fs::create_dir_all(&bin_dir).expect("mkdir");
        let exe = bin_dir.join("orchevia-fake-claude-xyz");
        std::fs::write(&exe, "#!/bin/sh\nexit 0\n").expect("write");
        let found = fallback_candidates("orchevia-fake-claude-xyz", Some(dir.path()));
        assert_eq!(found, vec![exe]);
        assert!(
            fallback_candidates("orchevia-definitely-missing-xyz", Some(dir.path())).is_empty()
        );
    }

    #[test]
    fn fallback_candidates_reject_non_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        // A directory with the exe name must not match.
        std::fs::create_dir_all(dir.path().join(".local").join("bin").join("mydir"))
            .expect("mkdir");
        assert!(fallback_candidates("mydir", Some(dir.path())).is_empty());
    }

    #[test]
    fn resolve_executable_prefers_absolute_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        let exe = dir.path().join("my-tool");
        std::fs::write(&exe, "#!/bin/sh\nexit 0\n").expect("write");
        let abs = exe.to_string_lossy().into_owned();
        assert_eq!(resolve_executable(&abs).as_deref(), Some(abs.as_str()));
        assert!(resolve_executable("   ").is_none());
        assert!(require_executable("orchevia-definitely-missing-xyz").is_err());
    }

    #[test]
    fn default_registry_has_four_tools() {
        let tools = default_tools();
        assert_eq!(tools.len(), 4);
        let ids: Vec<&str> = tools.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"git"));
        assert!(ids.contains(&"gh"));
        assert!(ids.contains(&"claude"));
        assert!(ids.contains(&"codex"));
    }
}
