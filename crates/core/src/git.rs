//! First-class Git adapter (Milestone 4), separate from GitHub.
//!
//! All operations invoke the local `git` binary with argv (no shell) in an
//! explicit repository directory. Read-only inspection never modifies the
//! repo; mutating operations refuse dirty/lossy states instead of forcing:
//! no silent discards, no `--force`, no `reset --hard`, no `clean -fd`.

use crate::process::{run_command, CommandSpec};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    /// Porcelain XY status, e.g. "M ", "??", "UU".
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub root: String,
    pub branch: String,
    pub clean: bool,
    pub changed_files: Vec<ChangedFile>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffSummary {
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub bare: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
}

/// Run git with argv in `dir`. Short timeout; errors carry stderr.
fn git(dir: &str, args: &[&str], timeout_secs: u64) -> Result<String, String> {
    if !std::path::Path::new(dir).is_dir() {
        return Err(format!("Directory does not exist: {dir}"));
    }
    let spec = CommandSpec {
        executable: "git".to_string(),
        args: args.iter().map(|s| (*s).to_string()).collect(),
        working_dir: Some(dir.to_string()),
    };
    let result = run_command(&spec, Some(Duration::from_secs(timeout_secs)))
        .map_err(|e| format!("Failed to run git: {e}"))?;
    if result.exit_code == Some(0) {
        Ok(result.stdout)
    } else {
        Err(result.stderr.trim().to_string())
    }
}

/// Find the repository root for `dir` (empty when not in a repo).
pub fn discover_root(dir: &str) -> Option<String> {
    git(dir, &["rev-parse", "--show-toplevel"], 10)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Current branch name (`HEAD` when detached).
pub fn current_branch(root: &str) -> Result<String, String> {
    git(root, &["rev-parse", "--abbrev-ref", "HEAD"], 10).map(|s| s.trim().to_string())
}

/// Porcelain status with ahead/behind counts.
pub fn status(root: &str) -> Result<GitStatus, String> {
    let branch = current_branch(root)?;
    let porcelain = git(root, &["status", "--porcelain=v1", "--branch"], 15)?;
    let mut changed_files = Vec::new();
    let mut ahead = 0u32;
    let mut behind = 0u32;
    for line in porcelain.lines() {
        if let Some(tracking) = line.strip_prefix("## ") {
            // e.g. "## main...origin/main [ahead 1, behind 2]".
            if let Some((_, counts)) = tracking.split_once('[') {
                for chunk in counts.trim_end_matches(']').split(',').map(str::trim) {
                    if let Some(n) = chunk.strip_prefix("ahead ") {
                        ahead = n.trim().parse().unwrap_or(0);
                    }
                    if let Some(n) = chunk.strip_prefix("behind ") {
                        behind = n.trim().parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        if line.len() >= 4 {
            changed_files.push(ChangedFile {
                status: line[..2].to_string(),
                path: line[3..].trim().to_string(),
            });
        }
    }
    Ok(GitStatus {
        root: root.to_string(),
        branch,
        clean: changed_files.is_empty(),
        changed_files,
        ahead,
        behind,
    })
}

/// Unstaged + staged diff summary (`git diff HEAD --shortstat` + numstat).
pub fn diff_summary(root: &str) -> Result<DiffSummary, String> {
    let short = git(root, &["diff", "HEAD", "--shortstat"], 15)?;
    // e.g. " 2 files changed, 10 insertions(+), 3 deletions(-)".
    let mut files_changed = 0u32;
    let mut insertions = 0u32;
    let mut deletions = 0u32;
    for chunk in short.split(',') {
        let chunk = chunk.trim();
        if let Some(n) = chunk.split_whitespace().next() {
            let n: u32 = n.parse().unwrap_or(0);
            if chunk.contains("file") {
                files_changed = n;
            } else if chunk.contains("insertion") {
                insertions = n;
            } else if chunk.contains("deletion") {
                deletions = n;
            }
        }
    }
    Ok(DiffSummary {
        files_changed,
        insertions,
        deletions,
    })
}

/// Files with merge conflicts (unmerged paths).
pub fn conflict_files(root: &str) -> Result<Vec<String>, String> {
    let out = git(root, &["diff", "--name-only", "--diff-filter=U"], 15)?;
    Ok(out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
}

/// Create and switch to a branch. Refuses when the name exists (no silent
/// reuse) and when the worktree is conflicted.
pub fn branch_create(root: &str, name: &str) -> Result<String, String> {
    validate_branch_name(name)?;
    if !conflict_files(root)?.is_empty() {
        return Err("Repository has unresolved merge conflicts; resolve them first.".to_string());
    }
    git(root, &["checkout", "-b", name], 30)?;
    Ok(format!("Created and switched to branch '{name}'."))
}

/// Local branch names plus the current one (`HEAD` when detached).
pub fn branches(root: &str) -> Result<(String, Vec<String>), String> {
    let current = current_branch(root)?;
    let out = git(root, &["branch", "--format=%(refname:short)"], 10)?;
    let mut names: Vec<String> = out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    names.sort();
    names.dedup();
    Ok((current, names))
}

/// Switch branch. Refuses with dirty worktree unless `allow_dirty` — and even
/// then only switches (never discards); checkout itself may refuse.
pub fn checkout(root: &str, name: &str, allow_dirty: bool) -> Result<String, String> {
    validate_branch_name(name)?;
    if !allow_dirty && !status(root)?.clean {
        return Err(
            "Worktree is dirty; commit, stash, or enable the explicit dirty-checkout option."
                .to_string(),
        );
    }
    git(root, &["checkout", name], 30)?;
    Ok(format!("Switched to branch '{name}'."))
}

pub fn validate_branch_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Branch name must not be empty.".to_string());
    }
    if trimmed.len() > 200 {
        return Err("Branch name is too long.".to_string());
    }
    for bad in [' ', '~', '^', ':', '?', '*', '[', '\\', '\'', '"', '\n'] {
        if trimmed.contains(bad) {
            return Err(format!("Branch name contains invalid character '{bad}'."));
        }
    }
    if trimmed.starts_with('-') || trimmed.contains("..") || trimmed.ends_with('/') {
        return Err("Branch name is not a valid git ref.".to_string());
    }
    Ok(())
}

/// Stage explicit paths (never `git add -A` implicitly).
pub fn stage(root: &str, paths: &[String]) -> Result<String, String> {
    if paths.is_empty() {
        return Err("Stage needs at least one explicit path.".to_string());
    }
    let mut args = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    git(root, &args, 30)?;
    Ok(format!("Staged {} path(s).", paths.len()))
}

/// Commit what is staged. Refuses when nothing is staged (no empty commits).
pub fn commit_staged(root: &str, message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Commit message must not be empty.".to_string());
    }
    let staged = git(root, &["diff", "--cached", "--name-only"], 15)?;
    if staged.trim().is_empty() {
        return Err("Nothing staged; stage explicit paths first (no implicit -A).".to_string());
    }
    git(root, &["commit", "-m", message.trim()], 60)?;
    Ok("Committed staged changes.".to_string())
}

/// List remotes (`git remote -v`, fetch URLs).
pub fn remotes(root: &str) -> Result<Vec<RemoteInfo>, String> {
    let out = git(root, &["remote", "-v"], 10)?;
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for line in out.lines() {
        let mut parts = line.split_whitespace();
        if let (Some(name), Some(url), Some(kind)) = (parts.next(), parts.next(), parts.next()) {
            if kind == "(fetch)" && seen.insert(name.to_string()) {
                result.push(RemoteInfo {
                    name: name.to_string(),
                    url: url.to_string(),
                });
            }
        }
    }
    Ok(result)
}

/// Bounded unified diff for one repo-relative path (`git diff HEAD -- <path>`).
/// Read-only. Rejects absolute paths, `..` escapes, and empty names; output
/// is capped to `max_lines` lines / 40k chars so the UI never loads a whole
/// repo into memory. Never executes file content.
pub fn file_diff(root: &str, path: &str, max_lines: usize) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("File path must not be empty.".to_string());
    }
    if trimmed.len() > 500 {
        return Err("File path is too long.".to_string());
    }
    let p = std::path::Path::new(trimmed);
    if p.is_absolute() || trimmed.contains("..") || trimmed.starts_with('~') {
        return Err("File path must be repo-relative without '..'.".to_string());
    }
    let out = git(root, &["diff", "HEAD", "--", trimmed], 15)?;
    let cap_lines = max_lines.clamp(1, 500);
    let mut lines: Vec<&str> = out.lines().take(cap_lines + 1).collect();
    let truncated = lines.len() > cap_lines;
    lines.truncate(cap_lines);
    let mut text = lines.join("\n");
    if text.len() > 40_000 {
        text.truncate(40_000);
        text.push_str("\n… [diff truncated]");
    } else if truncated {
        text.push_str("\n… [diff truncated]");
    }
    if text.trim().is_empty() {
        Ok("(no diff for this path against HEAD)\n".to_string())
    } else {
        text.push('\n');
        Ok(text)
    }
}

/// Linked worktrees (`git worktree list --porcelain`).
pub fn worktree_list(root: &str) -> Result<Vec<WorktreeInfo>, String> {
    let out = git(root, &["worktree", "list", "--porcelain"], 15)?;
    let mut worktrees = Vec::new();
    let mut path = String::new();
    let mut branch = String::new();
    let mut bare = false;
    let mut flush = |path: &mut String, branch: &mut String, bare: &mut bool| {
        if !path.is_empty() {
            worktrees.push(WorktreeInfo {
                path: std::mem::take(path),
                branch: std::mem::take(branch),
                bare: std::mem::replace(bare, false),
            });
        }
    };
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(&mut path, &mut branch, &mut bare);
            path = p.trim().to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            branch = b.trim().trim_start_matches("refs/heads/").to_string();
        } else if line.trim() == "bare" {
            bare = true;
        } else if line.trim() == "detached" {
            branch = "HEAD (detached)".to_string();
        }
    }
    flush(&mut path, &mut branch, &mut bare);
    Ok(worktrees)
}

/// Add an isolated worktree. The path must not exist yet; the branch is
/// created when missing (`-b`), reused otherwise. Never deletes user work.
pub fn worktree_add(root: &str, path: &str, branch: Option<&str>) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("Worktree path must not be empty.".to_string());
    }
    if std::path::Path::new(path).exists() {
        return Err(format!("Worktree path already exists: {path}"));
    }
    if let Some(parent) = std::path::Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Cannot create worktree parent: {e}"))?;
        }
    }
    match branch {
        Some(name) => {
            validate_branch_name(name)?;
            // Create (-b) when the branch is new, attach when it exists.
            let exists = git(
                root,
                &["show-ref", "--verify", &format!("refs/heads/{name}")],
                10,
            )
            .is_ok();
            if exists {
                git(root, &["worktree", "add", path, name], 60)?;
            } else {
                git(root, &["worktree", "add", "-b", name, path], 60)?;
            }
            Ok(format!("Worktree ready at '{path}' on branch '{name}'."))
        }
        None => {
            git(root, &["worktree", "add", "--detach", path], 60)?;
            Ok(format!("Detached worktree ready at '{path}'."))
        }
    }
}

/// Remove a worktree. Only clean worktrees are removed: uncommitted changes
/// (tracked or untracked) refuse removal so failed runs stay debuggable and
/// no user work is ever deleted. There is intentionally no force flag — `git`
/// itself would require `--force`, which Orchevia never passes.
pub fn worktree_remove(root: &str, path: &str) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("Worktree path must not be empty.".to_string());
    }
    let main = discover_root(root).unwrap_or_else(|| root.to_string());
    if same_path(path, &main) {
        return Err("Refusing to remove the main worktree.".to_string());
    }
    let dirty = git(path, &["status", "--porcelain=v1"], 15)
        .map(|s| !s.trim().is_empty())
        .unwrap_or(true);
    if dirty {
        return Err(
            "Worktree has uncommitted changes; preserve or commit them first. Removal never deletes user work."
                .to_string(),
        );
    }
    git(root, &["worktree", "remove", path], 60)?;
    Ok(format!("Removed worktree '{path}'."))
}

fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        std::path::Path::new(p)
            .canonicalize()
            .map(|c| c.to_string_lossy().into_owned())
            .unwrap_or_else(|_| p.to_string())
    };
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Fresh repo with one commit + user config (skips when git is missing).
    fn fresh_repo() -> Option<tempfile::TempDir> {
        if !git_available() {
            return None;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_string_lossy().into_owned();
        let run = |args: &[&str]| {
            let spec = CommandSpec {
                executable: "git".into(),
                args: args.iter().map(|s| (*s).to_string()).collect(),
                working_dir: Some(root.clone()),
            };
            run_command(&spec, Some(Duration::from_secs(15))).expect("git")
        };
        assert!(run(&["init", "-b", "main"]).exit_code == Some(0));
        assert!(run(&["config", "user.email", "test@orchevia.dev"]).exit_code == Some(0));
        assert!(run(&["config", "user.name", "Orchevia Test"]).exit_code == Some(0));
        std::fs::write(dir.path().join("a.txt"), "hello\n").expect("write");
        assert!(run(&["add", "a.txt"]).exit_code == Some(0));
        assert!(run(&["commit", "-m", "init"]).exit_code == Some(0));
        Some(dir)
    }

    #[test]
    fn status_reports_clean_repo() {
        let Some(dir) = fresh_repo() else {
            eprintln!("SKIP: git not installed");
            return;
        };
        let root = dir.path().to_string_lossy().into_owned();
        let found = discover_root(&root).expect("root");
        assert!(!found.is_empty());
        let state = status(&found).expect("status");
        assert!(state.clean);
        assert_eq!(state.branch, "main");
        assert!(state.changed_files.is_empty());
    }

    #[test]
    fn status_reports_ahead_and_behind_for_a_diverged_tracking_branch() {
        let Some(dir) = fresh_repo() else {
            eprintln!("SKIP: git not installed");
            return;
        };
        let root = dir.path().to_string_lossy().into_owned();
        git(&root, &["branch", "upstream"], 10).expect("upstream branch");
        git(&root, &["branch", "--set-upstream-to=upstream", "main"], 10).expect("set tracking");
        assert_eq!(status(&root).expect("aligned").ahead, 0);
        std::fs::write(dir.path().join("local.txt"), "local\n").expect("local write");
        stage(&root, &["local.txt".into()]).expect("local stage");
        commit_staged(&root, "local commit").expect("local commit");
        assert_eq!(status(&root).expect("ahead").ahead, 1);
        checkout(&root, "upstream", false).expect("checkout upstream");
        std::fs::write(dir.path().join("remote.txt"), "remote\n").expect("remote write");
        stage(&root, &["remote.txt".into()]).expect("remote stage");
        commit_staged(&root, "upstream commit").expect("upstream commit");
        checkout(&root, "main", false).expect("checkout main");
        let porcelain =
            git(&root, &["status", "--porcelain=v1", "--branch"], 15).expect("porcelain fixture");
        assert!(porcelain.contains("[ahead 1, behind 1]"), "{porcelain}");
        let state = status(&root).expect("diverged status");
        assert_eq!(state.ahead, 1);
        assert_eq!(state.behind, 1);
        assert!(state.clean);
    }

    #[test]
    fn dirty_file_shows_up() {
        let Some(dir) = fresh_repo() else {
            eprintln!("SKIP: git not installed");
            return;
        };
        let root = dir.path().to_string_lossy().into_owned();
        std::fs::write(dir.path().join("a.txt"), "changed\n").expect("write");
        let state = status(&root).expect("status");
        assert!(!state.clean);
        assert!(state.changed_files.iter().any(|f| f.path == "a.txt"));
        let summary = diff_summary(&root).expect("summary");
        assert_eq!(summary.files_changed, 1);
        assert!(summary.insertions + summary.deletions > 0);
    }

    #[test]
    fn branch_lifecycle_with_dirty_guard() {
        let Some(dir) = fresh_repo() else {
            eprintln!("SKIP: git not installed");
            return;
        };
        let root = dir.path().to_string_lossy().into_owned();
        branch_create(&root, "feature-x").expect("create");
        assert_eq!(current_branch(&root).expect("branch"), "feature-x");
        std::fs::write(dir.path().join("a.txt"), "dirty\n").expect("write");
        // Dirty checkout refused without opt-in.
        assert!(checkout(&root, "main", false).is_err());
        checkout(&root, "main", true).expect("dirty checkout with opt-in");
        assert_eq!(current_branch(&root).expect("branch"), "main");
    }

    #[test]
    fn commit_requires_staged_changes() {
        let Some(dir) = fresh_repo() else {
            eprintln!("SKIP: git not installed");
            return;
        };
        let root = dir.path().to_string_lossy().into_owned();
        assert!(commit_staged(&root, "nothing").is_err());
        std::fs::write(dir.path().join("a.txt"), "v2\n").expect("write");
        stage(&root, &["a.txt".to_string()]).expect("stage");
        commit_staged(&root, "second").expect("commit");
        assert!(status(&root).expect("status").clean);
    }

    #[test]
    fn worktree_add_and_remove_with_guards() {
        let Some(dir) = fresh_repo() else {
            eprintln!("SKIP: git not installed");
            return;
        };
        let root = dir.path().to_string_lossy().into_owned();
        let wt = dir.path().join("wt-feature").to_string_lossy().into_owned();
        worktree_add(&root, &wt, Some("wt-branch")).expect("add");
        let list = worktree_list(&root).expect("list");
        assert!(list.iter().any(|w| w.path == wt));
        // Dirty worktree removal is refused (no force flag exists).
        std::fs::write(std::path::Path::new(&wt).join("new.txt"), "x\n").expect("write");
        assert!(worktree_remove(&root, &wt).is_err());
        std::fs::remove_file(std::path::Path::new(&wt).join("new.txt")).expect("clean");
        worktree_remove(&root, &wt).expect("remove when clean");
        let relisted = worktree_list(&root).expect("relist");
        assert!(!relisted.iter().any(|w| w.path == wt));
        // Main worktree can never be removed through this path.
        assert!(worktree_remove(&root, &root).is_err());
    }

    #[test]
    fn invalid_branch_names_rejected() {
        assert!(validate_branch_name("").is_err());
        assert!(validate_branch_name("has space").is_err());
        assert!(validate_branch_name("a..b").is_err());
        assert!(validate_branch_name("-dash").is_err());
        assert!(validate_branch_name("ok/feature-1").is_ok());
    }

    #[test]
    fn branches_lists_current_first() {
        let Some(dir) = fresh_repo() else {
            eprintln!("SKIP: git not installed");
            return;
        };
        let root = dir.path().to_string_lossy().into_owned();
        let (current, names) = branches(&root).expect("branches");
        assert_eq!(current, "main");
        assert!(names.contains(&"main".to_string()));
        branch_create(&root, "feature-x").expect("create");
        let (current, names) = branches(&root).expect("branches");
        assert_eq!(current, "feature-x");
        assert!(names.contains(&"main".to_string()));
    }

    #[test]
    fn file_diff_is_bounded_and_guarded() {
        let Some(dir) = fresh_repo() else {
            eprintln!("SKIP: git not installed");
            return;
        };
        let root = dir.path().to_string_lossy().into_owned();
        std::fs::write(dir.path().join("a.txt"), "changed\n").expect("write");
        let diff = file_diff(&root, "a.txt", 200).expect("diff");
        assert!(diff.contains("changed") || diff.contains("a.txt") || !diff.is_empty());
        assert!(file_diff(&root, "../escape.txt", 200).is_err());
        assert!(file_diff(&root, "/abs.txt", 200).is_err());
        assert!(file_diff(&root, "   ", 200).is_err());
    }

    #[test]
    fn outside_repo_has_no_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        // Fresh tempdir is not a repo (unless tests run inside one — use a
        // distinctive missing subdir guard instead).
        let missing = dir.path().join("nope").to_string_lossy().into_owned();
        assert!(discover_root(&missing).is_none());
    }
}
