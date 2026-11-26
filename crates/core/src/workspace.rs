//! Workspace folders (v0.4.0): where Command and Agent steps that have no
//! folder of their own run, and so where their files are found afterwards.
//!
//! Before 0.4.0 such steps ran in whatever folder the app was started from
//! (`/` for a desktop launch, `src-tauri` for `pnpm tauri dev`). Now each
//! workflow gets a readable folder under one workspace root:
//! `~/Documents/Orchevia/<Workflow name> (<id>)` by default, or the root saved in
//! Environment. A node folder or the workflow's repository folder still wins.

use crate::db::SqliteDb;
use crate::workflow::{Node, NodeKind, WorkflowDefaults};
use std::path::{Path, PathBuf};

/// Setting holding an absolute workspace root; blank means the default.
pub const WORKSPACE_ROOT_SETTING: &str = "workspace.root";

/// Longest saved workspace root, in bytes.
pub const MAX_ROOT_BYTES: usize = 1024;

/// A saved root is blank (the default) or an absolute path on one line.
/// Mirrors `validateWorkspaceRoot` in `src/lib/outputs.ts`.
pub fn validate_root_setting(value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if value.len() > MAX_ROOT_BYTES || value.contains(['\0', '\n', '\r']) {
        return Err("The workspace folder must be one line of at most 1024 bytes.".into());
    }
    if !Path::new(trimmed).is_absolute() {
        return Err("The workspace folder must be an absolute path.".into());
    }
    if Path::new(trimmed).exists() && !Path::new(trimmed).is_dir() {
        return Err("The workspace folder must be a folder, not a file.".into());
    }
    Ok(())
}

/// Longest folder name derived from a workflow name, in characters.
const FOLDER_NAME_MAX: usize = 80;

/// The user's home folder, when `HOME` names an absolute path.
#[cfg(not(test))]
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|home| home.is_absolute())
}

/// Tests never create folders in the real home folder: engine tests run
/// folderless steps, which would otherwise fill `~/Documents/Orchevia`.
#[cfg(test)]
pub fn home_dir() -> Option<PathBuf> {
    Some(std::env::temp_dir().join(format!("orchevia-test-home-{}", std::process::id())))
}

/// `~/Documents/Orchevia` when the home folder has a Documents folder, else
/// `~/Orchevia`.
pub fn default_root(home: &Path) -> PathBuf {
    let documents = home.join("Documents");
    if documents.is_dir() {
        documents.join("Orchevia")
    } else {
        home.join("Orchevia")
    }
}

/// A saved root counts only when it is an absolute path; anything else
/// falls back to the default.
pub fn configured_root(saved: Option<&str>) -> Option<PathBuf> {
    saved
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
}

/// The workspace root in use: the saved one, else the default. `None` only
/// without a home folder and without a saved root.
pub fn root(db: &SqliteDb) -> Option<PathBuf> {
    let saved = db.get_setting(WORKSPACE_ROOT_SETTING).ok().flatten();
    configured_root(saved.as_deref()).or_else(|| home_dir().map(|home| default_root(&home)))
}

/// Characters of the workflow id that keep two workflows with the same name
/// (two uses of one template, a copy) in separate folders.
const ID_SUFFIX_CHARS: usize = 6;

/// A readable, file-system-safe folder name for a workflow: its name with
/// separators and control characters replaced, no leading dots, at most 80
/// characters, then the last six letters or digits of its id in brackets, so
/// two workflows with the same name never share a folder:
/// `Blog Post from a Brief (k3f9a2)`. Mirrors `workspaceFolderName` in
/// `src/lib/outputs.ts`.
pub fn folder_name(workflow_name: &str, workflow_id: &str) -> String {
    let mapped: String = workflow_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '(' | ')' | '+') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let collapsed = mapped.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_start_matches(['.', ' ', '-']);
    let truncated: String = trimmed.chars().take(FOLDER_NAME_MAX).collect();
    let base = truncated.trim_end_matches(['.', ' ']);
    let base = if base.is_empty() { "Workflow" } else { base };
    let id: Vec<char> = workflow_id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect();
    let suffix: String = id[id.len().saturating_sub(ID_SUFFIX_CHARS)..]
        .iter()
        .collect();
    if suffix.is_empty() {
        base.to_string()
    } else {
        format!("{base} ({suffix})")
    }
}

/// The folder a workflow's steps use when they have no folder of their own.
pub fn workflow_folder(root: &Path, workflow_name: &str, workflow_id: &str) -> PathBuf {
    root.join(folder_name(workflow_name, workflow_id))
}

/// A Command or Agent step with no folder of its own in a workflow without a
/// repository folder runs in the workspace.
pub fn uses_workspace(node: &Node, defaults: Option<&WorkflowDefaults>) -> bool {
    if !matches!(node.kind, NodeKind::Command | NodeKind::Agent) {
        return false;
    }
    let blank = |value: Option<&str>| value.map(str::trim).unwrap_or("").is_empty();
    blank(node.config.working_dir.as_deref()) && blank(defaults.and_then(|d| d.repo_dir.as_deref()))
}

/// Whether a step really works in the workspace: a folderless Command step,
/// or a folderless Agent step whose profile follows the step's folder. A
/// profile that sets its own folder or keeps the app's never uses it; an
/// unknown profile counts as following.
pub fn step_uses_workspace(
    node: &Node,
    defaults: Option<&WorkflowDefaults>,
    profiles: &[crate::agents::AgentProfile],
) -> bool {
    if !uses_workspace(node, defaults) {
        return false;
    }
    if node.kind != NodeKind::Agent {
        return true;
    }
    node.config
        .agent_profile_id
        .as_deref()
        .and_then(|id| profiles.iter().find(|p| p.id == id))
        .is_none_or(|p| p.working_dir_mode == crate::agents::WorkingDirMode::Node)
}

/// Whether any of a workflow's steps works in its workspace folder.
pub fn workflow_uses_workspace(
    workflow: &crate::workflow::Workflow,
    profiles: &[crate::agents::AgentProfile],
) -> bool {
    workflow
        .nodes
        .iter()
        .any(|n| step_uses_workspace(n, workflow.defaults.as_ref(), profiles))
}

/// Create the folder and its parents; returns it as a string.
pub fn prepare(folder: &Path) -> Result<String, String> {
    std::fs::create_dir_all(folder).map_err(|e| {
        format!(
            "Could not create the workspace folder {}: {e}",
            folder.display()
        )
    })?;
    Ok(folder.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow::NodeConfig;

    fn node(kind: NodeKind, dir: Option<&str>) -> Node {
        Node {
            id: "n".into(),
            kind,
            position: crate::workflow::Position { x: 0.0, y: 0.0 },
            config: NodeConfig {
                working_dir: dir.map(str::to_string),
                ..NodeConfig::default()
            },
            label: None,
        }
    }

    /// Shared with `src/lib/outputs.test.ts`.
    #[test]
    fn folder_names_are_readable_and_safe() {
        let cases = [
            (
                "Blog Post from a Brief",
                "wf-mwxtc6717ulqfo",
                "Blog Post from a Brief (7ulqfo)",
            ),
            ("a/b\\c:d", "wf-1", "a-b-c-d (wf1)"),
            ("../escape", "x", "escape (x)"),
            ("  ..hidden  ", "ABCdef123", "hidden (def123)"),
            ("Tabs\tand\nnewlines", "wf", "Tabs-and-newlines (wf)"),
            ("Résumé ✨ kit", "wf", "Résumé - kit (wf)"),
            ("///", "wf-7", "Workflow (wf7)"),
            ("...", "..", "Workflow"),
            ("trailing dots...", "wf", "trailing dots (wf)"),
        ];
        for (name, id, expected) in cases {
            assert_eq!(folder_name(name, id), expected, "{name}");
        }
        let long = "x".repeat(200);
        assert_eq!(
            folder_name(&long, "abc").chars().count(),
            FOLDER_NAME_MAX + " (abc)".len()
        );
        // Two workflows with one name get two folders.
        assert_ne!(
            folder_name("Same", "wf-aaaaaa"),
            folder_name("Same", "wf-bbbbbb")
        );
    }

    #[test]
    fn only_folderless_commands_and_agents_use_the_workspace() {
        let repo = WorkflowDefaults {
            repo_dir: Some("/repo".into()),
            branch: None,
        };
        let blank = WorkflowDefaults {
            repo_dir: Some("  ".into()),
            branch: None,
        };
        assert!(uses_workspace(&node(NodeKind::Agent, None), None));
        assert!(uses_workspace(
            &node(NodeKind::Command, Some(" ")),
            Some(&blank)
        ));
        assert!(!uses_workspace(&node(NodeKind::Command, None), Some(&repo)));
        assert!(!uses_workspace(&node(NodeKind::Agent, Some("/x")), None));
        for kind in [
            NodeKind::Git,
            NodeKind::GitHub,
            NodeKind::Mcp,
            NodeKind::Start,
        ] {
            assert!(!uses_workspace(&node(kind, None), None));
        }
    }

    #[test]
    fn roots_prefer_a_saved_absolute_path_then_documents() {
        assert_eq!(
            configured_root(Some(" /data/work ")),
            Some(PathBuf::from("/data/work"))
        );
        assert_eq!(configured_root(Some("relative/path")), None);
        assert_eq!(configured_root(Some("  ")), None);
        let home = tempfile::tempdir().unwrap();
        assert_eq!(default_root(home.path()), home.path().join("Orchevia"));
        std::fs::create_dir(home.path().join("Documents")).unwrap();
        assert_eq!(
            default_root(home.path()),
            home.path().join("Documents").join("Orchevia")
        );
        let folder = workflow_folder(&default_root(home.path()), "Launch kit", "wf");
        let made = prepare(&folder).unwrap();
        assert!(Path::new(&made).is_dir());
        assert!(made.ends_with("Documents/Orchevia/Launch kit (wf)"));
    }

    #[test]
    fn saved_roots_are_blank_or_absolute() {
        assert!(validate_root_setting("").is_ok());
        assert!(validate_root_setting("  ").is_ok());
        assert!(validate_root_setting("/data/work").is_ok());
        assert!(validate_root_setting("work").is_err());
        assert!(validate_root_setting("/a\nb").is_err());
        assert!(validate_root_setting(&format!("/{}", "x".repeat(MAX_ROOT_BYTES))).is_err());
    }

    #[test]
    fn tests_never_use_the_real_home_folder() {
        let home = home_dir().unwrap();
        assert!(home.starts_with(std::env::temp_dir()));
        let db = SqliteDb::open_in_memory().unwrap();
        assert!(root(&db).unwrap().starts_with(std::env::temp_dir()));
    }

    #[test]
    fn the_saved_root_is_read_from_settings() {
        let db = SqliteDb::open_in_memory().unwrap();
        db.set_setting(WORKSPACE_ROOT_SETTING, "/srv/orchevia")
            .unwrap();
        assert_eq!(root(&db), Some(PathBuf::from("/srv/orchevia")));
    }
}
