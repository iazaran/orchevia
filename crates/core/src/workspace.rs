//! Workspace folders (v0.4.0): where Command and Agent steps that have no
//! folder of their own run, and so where their files are found afterwards.
//!
//! Before 0.4.0 such steps ran in whatever folder the app was started from
//! (`/` for a desktop launch, `src-tauri` for `pnpm tauri dev`). Now each
//! workflow gets a readable folder under one workspace root:
//! `~/Documents/Orchevia/<Workflow name>` by default, or the root saved in
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

/// A readable, file-system-safe folder name for a workflow: its name with
/// separators and control characters replaced, no leading dots, at most 80
/// characters. A name with nothing usable left falls back to the id.
pub fn folder_name(workflow_name: &str, workflow_id: &str) -> String {
    let clean = |text: &str| -> String {
        let mapped: String = text
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
        truncated.trim_end_matches(['.', ' ']).to_string()
    };
    let from_name = clean(workflow_name);
    if !from_name.is_empty() {
        return from_name;
    }
    let from_id = clean(workflow_id);
    if from_id.is_empty() {
        "Workflow".to_string()
    } else {
        from_id
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

    #[test]
    fn folder_names_are_readable_and_safe() {
        assert_eq!(
            folder_name("Blog Post from a Brief", "wf-1"),
            "Blog Post from a Brief"
        );
        assert_eq!(folder_name("a/b\\c:d", "wf-1"), "a-b-c-d");
        assert_eq!(folder_name("../escape", "wf-1"), "escape");
        assert_eq!(folder_name("  ..hidden  ", "wf-1"), "hidden");
        assert_eq!(
            folder_name("Tabs\tand\nnewlines", "wf"),
            "Tabs-and-newlines"
        );
        assert_eq!(folder_name("Résumé ✨ kit", "wf"), "Résumé - kit");
        assert_eq!(folder_name("///", "wf-7"), "wf-7");
        assert_eq!(folder_name("...", ".."), "Workflow");
        assert_eq!(folder_name("trailing dots...", "wf"), "trailing dots");
        let long = "x".repeat(200);
        assert_eq!(folder_name(&long, "wf").chars().count(), FOLDER_NAME_MAX);
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
        assert!(made.ends_with("Documents/Orchevia/Launch kit"));
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
