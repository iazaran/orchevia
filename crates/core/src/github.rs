//! GitHub integration via the local `gh` CLI (Milestone 4).
//!
//! Orchevia never talks to github.com directly here: every operation shells
//! out to `gh` (argv, no shell) using the user's own authentication. Tokens
//! are never read, displayed, or persisted — `gh auth status` output is
//! reduced to a boolean + username. `--json` outputs are parsed tolerantly
//! (unknown fields ignored) into normalized structs.
//!
//! The executable is configurable ([`GhRunner`]) so tests point at fixture
//! scripts instead of real `gh` + network.

use crate::process::{run_command, CommandSpec, ProcessResult};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub authenticated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoIdentity {
    pub owner: String,
    pub repo: String,
    pub host: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: String,
    pub head_branch: String,
    pub base_branch: String,
    pub head_sha: String,
    pub url: String,
    pub is_draft: bool,
    #[serde(default)]
    pub review_requests: Vec<String>,
    #[serde(default)]
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFileMeta {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckStatus {
    pub name: String,
    pub state: String,
    pub conclusion: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrComment {
    pub author: String,
    pub body: String,
    pub path: String,
    pub line: i64,
    pub created_at: String,
    /// Heuristic source: "coderabbit", "github-review", "comment", ...
    pub source: String,
}

#[derive(Debug, Clone)]
pub struct GhRunner {
    pub executable: String,
    pub timeout_secs: u64,
}

impl Default for GhRunner {
    fn default() -> Self {
        Self {
            executable: default_executable(),
            timeout_secs: 30,
        }
    }
}

/// Binary used for GitHub operations. `ORCHEVIA_GH_BIN` overrides it — a
/// documented test hook so fixture scripts stand in for `gh` without
/// touching the process PATH.
pub fn default_executable() -> String {
    std::env::var("ORCHEVIA_GH_BIN").unwrap_or_else(|_| "gh".to_string())
}

/// Whether the GitHub CLI resolves (honors the test override).
pub fn cli_available() -> bool {
    let exe = default_executable();
    if exe.contains('/') {
        return std::path::Path::new(&exe).is_file();
    }
    crate::tools::find_executable(&exe).is_some()
}

/// Process-global lock for tests that mutate `ORCHEVIA_GH_BIN`: the key is
/// shared process state, so holders must serialize (parallel test threads).
#[cfg(test)]
pub static GH_BIN_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

impl GhRunner {
    fn run(&self, cwd: &str, args: &[&str]) -> Result<String, String> {
        let result = self.run_result(cwd, args)?;
        if result.exit_code == Some(0) {
            Ok(result.stdout)
        } else {
            OkDenied::redact(&result.stdout, result.stderr.trim())
        }
    }

    fn run_result(&self, cwd: &str, args: &[&str]) -> Result<ProcessResult, String> {
        if !std::path::Path::new(cwd).is_dir() {
            return Err(format!("Directory does not exist: {cwd}"));
        }
        let spec = CommandSpec {
            executable: self.executable.clone(),
            args: args.iter().map(|s| (*s).to_string()).collect(),
            working_dir: Some(cwd.to_string()),
            stdin: None,
        };
        run_command(&spec, Some(Duration::from_secs(self.timeout_secs)))
            .map_err(|e| format!("Failed to run '{}': {e}", self.executable))
    }
}

/// Error path that redacts anything token-shaped before surfacing.
struct OkDenied;
impl OkDenied {
    fn redact<T>(_stdout: &str, stderr: &str) -> Result<T, String> {
        // Never surface long hex runs (possible tokens) from CLI errors.
        let mut scrubbed = String::with_capacity(stderr.len());
        let mut run = String::new();
        let flush_run = |run: &mut String, out: &mut String| {
            if run.len() > 20 {
                out.push_str("[redacted]");
            } else {
                out.push_str(run);
            }
            run.clear();
        };
        for ch in stderr.chars() {
            if ch.is_ascii_hexdigit() {
                run.push(ch);
            } else {
                flush_run(&mut run, &mut scrubbed);
                scrubbed.push(ch);
            }
        }
        flush_run(&mut run, &mut scrubbed);
        Err(scrubbed
            .chars()
            .take(2000)
            .collect::<String>()
            .trim()
            .to_string())
    }
}

/// Authentication status without exposing tokens.
pub fn auth_status(runner: &GhRunner) -> AuthStatus {
    match runner.run(&std::env::temp_dir().to_string_lossy(), &["auth", "status"]) {
        Ok(out) => {
            // Typical: "Logged in to github.com account alice (keyring)".
            let user = out
                .lines()
                .find_map(|line| {
                    let lower = line.to_ascii_lowercase();
                    let at = lower.find("account ")?;
                    line[at + "account ".len()..]
                        .split_whitespace()
                        .next()
                        .map(str::to_string)
                })
                .filter(|u| !u.is_empty() && u.len() <= 100);
            AuthStatus {
                authenticated: true,
                user,
            }
        }
        Err(_) => AuthStatus {
            authenticated: false,
            user: None,
        },
    }
}

pub fn repo_identity(runner: &GhRunner, cwd: &str) -> Result<RepoIdentity, String> {
    let out = runner.run(
        cwd,
        &[
            "repo",
            "view",
            "--json",
            "nameWithOwner,owner,name",
            "--jq",
            ".",
        ],
    )?;
    // Prefer structured parse; fall back to owner/repo split.
    let value: serde_json::Value = serde_json::from_str(&out)
        .map_err(|_| "Cannot parse `gh repo view` output.".to_string())?;
    let nwo = value
        .get("nameWithOwner")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let (owner, repo) = nwo.split_once('/').unwrap_or(("", ""));
    if owner.is_empty() || repo.is_empty() {
        return Err("Not a GitHub repository (no owner/repo).".to_string());
    }
    Ok(RepoIdentity {
        owner: owner.to_string(),
        repo: repo.to_string(),
        host: "github.com".to_string(),
    })
}

fn normalize_pr(value: &serde_json::Value) -> Option<PullRequest> {
    Some(PullRequest {
        number: value.get("number")?.as_u64()?,
        title: value
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        state: value
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("open")
            .to_string(),
        author: value
            .get("author")
            .and_then(|v| v.get("login"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        head_branch: value
            .get("headRefName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        base_branch: value
            .get("baseRefName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        head_sha: value
            .get("headRefOid")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        url: value
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        is_draft: value
            .get("isDraft")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        review_requests: value
            .get("reviewRequests")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|r| r.get("login").and_then(|v| v.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        labels: value
            .get("labels")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|l| l.get("name").and_then(|v| v.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

const PR_FIELDS: &str = "number,title,state,author,headRefName,baseRefName,headRefOid,url,isDraft,reviewRequests,labels";

/// Open PRs (optionally filtered by state).
pub fn list_prs(runner: &GhRunner, cwd: &str, state: &str) -> Result<Vec<PullRequest>, String> {
    let out = runner.run(
        cwd,
        &[
            "pr", "list", "--state", state, "--json", PR_FIELDS, "--limit", "50",
        ],
    )?;
    let values: serde_json::Value =
        serde_json::from_str(&out).map_err(|_| "Cannot parse `gh pr list` output.".to_string())?;
    Ok(values
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(normalize_pr)
        .collect())
}

/// GitHub applies the authenticated user's requested-review scope, including
/// team requests. Scope the query before the result limit so unrelated PRs
/// cannot hide requested reviews on busy repositories.
pub fn list_requested_reviews(runner: &GhRunner, cwd: &str) -> Result<Vec<PullRequest>, String> {
    let out = runner.run(
        cwd,
        &[
            "pr",
            "list",
            "--state",
            "open",
            "--search",
            "review-requested:@me -author:@me",
            "--json",
            PR_FIELDS,
            "--limit",
            "50",
        ],
    )?;
    let values: Vec<serde_json::Value> = serde_json::from_str(&out)
        .map_err(|_| "Cannot parse requested-review PR list.".to_string())?;
    Ok(values.iter().filter_map(normalize_pr).collect())
}

pub fn pr_details(runner: &GhRunner, cwd: &str, number: u64) -> Result<PullRequest, String> {
    let num = number.to_string();
    let out = runner.run(cwd, &["pr", "view", &num, "--json", PR_FIELDS])?;
    let value: serde_json::Value =
        serde_json::from_str(&out).map_err(|_| "Cannot parse `gh pr view` output.".to_string())?;
    normalize_pr(&value).ok_or_else(|| format!("PR #{number} not found."))
}

/// PR for the current branch (empty when none).
pub fn pr_for_branch(runner: &GhRunner, cwd: &str) -> Result<Option<PullRequest>, String> {
    let branch = crate::git::current_branch(cwd).unwrap_or_default();
    let prs = list_prs(runner, cwd, "open")?;
    Ok(prs.into_iter().find(|pr| pr.head_branch == branch))
}

/// Changed files with add/del counts.
pub fn pr_files(runner: &GhRunner, cwd: &str, number: u64) -> Result<Vec<ChangedFileMeta>, String> {
    let num = number.to_string();
    // `gh pr diff` has no per-file counts; `pr view --json files` does.
    let out = runner.run(cwd, &["pr", "view", &num, "--json", "files"])?;
    let value: serde_json::Value = serde_json::from_str(&out)
        .map_err(|_| "Cannot parse `gh pr view --json files` output.".to_string())?;
    let files = value
        .get("files")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| format!("PR #{number} returned no file list."))?;
    Ok(files
        .iter()
        .filter_map(|file| {
            Some(ChangedFileMeta {
                path: file.get("path")?.as_str()?.to_string(),
                additions: file
                    .get("additions")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
                deletions: file
                    .get("deletions")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(0),
            })
        })
        .collect())
}

/// CI/check conclusions for a PR.
pub fn pr_checks(runner: &GhRunner, cwd: &str, number: u64) -> Result<Vec<CheckStatus>, String> {
    let num = number.to_string();
    let result = runner.run_result(cwd, &["pr", "checks", &num, "--json", "name,state,bucket"])?;
    // gh uses 1 for failed checks and 8 for pending checks. Preserve those
    // results, but only when stdout really contains check data; auth/network
    // failures also use 1 and must remain errors with their stderr intact.
    let values = serde_json::from_str::<Vec<serde_json::Value>>(&result.stdout);
    let valid_checks = values.as_ref().is_ok_and(|values| {
        !values.is_empty()
            && values.iter().all(|value| {
                value.get("name").is_some_and(|name| name.is_string())
                    && value.get("state").is_some_and(|state| state.is_string())
                    && matches!(
                        value.get("bucket").and_then(|bucket| bucket.as_str()),
                        Some("pass" | "fail" | "pending" | "skipping" | "cancel")
                    )
            })
    });
    if result.exit_code != Some(0) && !(matches!(result.exit_code, Some(1 | 8)) && valid_checks) {
        return OkDenied::redact(&result.stdout, result.stderr.trim());
    }
    let values = values.map_err(|_| "Cannot parse `gh pr checks` output.".to_string())?;
    Ok(values
        .iter()
        .map(|v| CheckStatus {
            name: v
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            state: v
                .get("state")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            conclusion: if v.get("bucket").and_then(|bucket| bucket.as_str()) == Some("pending") {
                String::new()
            } else {
                v.get("state")
                    .and_then(|state| state.as_str())
                    .unwrap_or("")
                    .to_ascii_lowercase()
            },
        })
        .collect())
}

/// Review + inline comments, normalized with a bot-source heuristic.
pub fn pr_comments(runner: &GhRunner, cwd: &str, number: u64) -> Result<Vec<PrComment>, String> {
    let num = number.to_string();
    let out = runner.run(cwd, &["pr", "view", &num, "--json", "reviews,comments"])?;
    let value: serde_json::Value =
        serde_json::from_str(&out).map_err(|_| "Cannot parse PR comments.".to_string())?;
    let mut comments = Vec::new();
    if let Some(reviews) = value.get("reviews").and_then(|v| v.as_array()) {
        for review in reviews {
            let author = review
                .get("author")
                .and_then(|a| a.get("login"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let body = review.get("body").and_then(|v| v.as_str()).unwrap_or("");
            if body.trim().is_empty() {
                continue;
            }
            comments.push(PrComment {
                source: classify_comment_source(&author, body),
                author,
                body: body.to_string(),
                path: String::new(),
                line: -1,
                created_at: review
                    .get("submittedAt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            });
        }
    }
    if let Some(items) = value.get("comments").and_then(|v| v.as_array()) {
        for item in items {
            let author = item
                .get("author")
                .and_then(|a| a.get("login"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let body = item.get("body").and_then(|v| v.as_str()).unwrap_or("");
            if body.trim().is_empty() {
                continue;
            }
            comments.push(PrComment {
                source: classify_comment_source(&author, body),
                author,
                body: body.to_string(),
                path: item
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                line: item.get("line").and_then(|v| v.as_i64()).unwrap_or(-1),
                created_at: item
                    .get("createdAt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            });
        }
    }
    Ok(comments)
}

/// Recognize bot feedback (CodeRabbit et al.) without hard-coding the engine
/// to any single bot: login or body markers decide.
pub fn classify_comment_source(author: &str, body: &str) -> String {
    let lower = format!("{author}\n{body}").to_ascii_lowercase();
    if lower.contains("coderabbit") {
        return "coderabbit".to_string();
    }
    if lower.contains("[bot]") || author.ends_with("[bot]") || author.ends_with("-bot") {
        return "bot".to_string();
    }
    if lower.contains("lgtm") || lower.contains("approved") {
        return "github-review".to_string();
    }
    "comment".to_string()
}

#[derive(Debug, Clone)]
pub struct CreatePrRequest {
    pub title: String,
    pub body: String,
    pub base: String,
    pub head: String,
    pub draft: bool,
}

/// Preview the exact argv a PR creation would use (shown before execution).
pub fn preview_create_pr(request: &CreatePrRequest) -> Vec<String> {
    let mut args = vec![
        "pr".to_string(),
        "create".to_string(),
        "--title".to_string(),
        request.title.clone(),
        "--body".to_string(),
        request.body.clone(),
        "--base".to_string(),
        request.base.clone(),
        "--head".to_string(),
        request.head.clone(),
    ];
    if request.draft {
        args.push("--draft".to_string());
    }
    args
}

/// Create a PR. The caller (workflow node config) is explicit: title, base,
/// head, draft flag, and a body preview are required upstream.
pub fn create_pr(
    runner: &GhRunner,
    cwd: &str,
    request: &CreatePrRequest,
) -> Result<PullRequest, String> {
    if request.title.trim().is_empty() {
        return Err("PR title must not be empty.".to_string());
    }
    if request.base.trim().is_empty() || request.head.trim().is_empty() {
        return Err("PR base and head branches are required.".to_string());
    }
    let argv = preview_create_pr(request);
    let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    let _out = runner.run(cwd, &refs)?;
    // Re-read the PR for the head branch to return normalized details. A
    // fork head (`owner:branch`) is listed by its branch alone; branch names
    // cannot contain ':'.
    let head = request.head.trim();
    let branch = head.rsplit_once(':').map_or(head, |(_, branch)| branch);
    let prs = list_prs(runner, cwd, "open")?;
    prs.into_iter()
        .find(|pr| pr.head_branch == branch)
        .ok_or_else(|| "PR created but could not be read back.".to_string())
}

/// Post a comment (explicit workflow action only).
pub fn post_comment(
    runner: &GhRunner,
    cwd: &str,
    number: u64,
    body: &str,
) -> Result<String, String> {
    if body.trim().is_empty() {
        return Err("Comment body must not be empty.".to_string());
    }
    let num = number.to_string();
    runner.run(cwd, &["pr", "comment", &num, "--body", body.trim()])
}

/// Request reviewers (best-effort: some hosts forbid it via CLI).
pub fn request_reviewers(
    runner: &GhRunner,
    cwd: &str,
    number: u64,
    reviewers: &[String],
) -> Result<String, String> {
    if reviewers.is_empty() {
        return Err("At least one reviewer is required.".to_string());
    }
    let num = number.to_string();
    let mut args = vec!["pr", "edit", &num];
    for reviewer in reviewers {
        args.push("--add-reviewer");
        args.push(reviewer.as_str());
    }
    runner.run(cwd, &args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Fixture `gh`: a shell script dispatching on argv to canned outputs.
    fn fixture_runner() -> (tempfile::TempDir, GhRunner) {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = dir.path().join("gh");
        std::fs::write(
            &script,
            r#"#!/bin/sh
# Minimal gh fixture: match subcommand, print canned JSON.
if [ "$1" = "auth" ]; then
  echo "Logged in to github.com account fixture-user (keyring)"
  exit 0
fi
if [ "$1" = "repo" ]; then
  echo '{"nameWithOwner":"acme/shop","owner":{"login":"acme"},"name":"shop"}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  echo '[{"number":7,"title":"Fix cart","state":"open","author":{"login":"bob"},"headRefName":"fix-cart","baseRefName":"main","headRefOid":"abc123","url":"https://github.com/acme/shop/pull/7","isDraft":true,"reviewRequests":[{"login":"alice"}],"labels":[{"name":"bug"}]}]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ] && [ "$5" = "files" ]; then
  echo '{"files":[{"path":"a.ts","additions":10,"deletions":2}]}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo '{"number":7,"title":"Fix cart","state":"open","author":{"login":"bob"},"headRefName":"fix-cart","baseRefName":"main","headRefOid":"abc123","url":"https://github.com/acme/shop/pull/7","isDraft":true,"reviewRequests":[{"login":"alice"}],"labels":[],"reviews":[{"author":{"login":"coderabbitai[bot]"},"body":"coderabbit: possible N+1","submittedAt":"2026-01-01T00:00:00Z"}],"comments":[{"author":{"login":"alice"},"body":"please rebase","path":"a.ts","line":12,"createdAt":"2026-01-02T00:00:00Z"}]}'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then
  if [ "$5" != "name,state,bucket" ]; then
    echo 'Unknown JSON field: "conclusion"' >&2
    exit 1
  fi
  case "$3" in
    8) echo '[{"name":"ci","state":"IN_PROGRESS","bucket":"pending"}]'; exit 8 ;;
    9) echo '[{"name":"ci","state":"FAILURE","bucket":"fail"}]'; exit 1 ;;
    10) echo 'authentication required' >&2; exit 1 ;;
    11) echo '{"message":"unexpected response"}'; exit 0 ;;
    *) echo '[{"name":"ci","state":"SUCCESS","bucket":"pass"}]'; exit 0 ;;
  esac
fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  echo "https://github.com/acme/shop/pull/8"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "comment" ]; then
  echo "commented"
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then
  echo "edited"
  exit 0
fi
echo "unexpected: $*" >&2
exit 1
"#,
        )
        .expect("write fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
                .expect("chmod");
        }
        let runner = GhRunner {
            executable: script.to_string_lossy().into_owned(),
            timeout_secs: 10,
        };
        let _ = HashMap::<String, String>::new();
        (dir, runner)
    }

    fn cwd(dir: &tempfile::TempDir) -> String {
        dir.path().to_string_lossy().into_owned()
    }

    #[test]
    fn auth_reports_user_without_token() {
        let (dir, runner) = fixture_runner();
        let _ = cwd(&dir);
        let status = auth_status(&runner);
        assert!(status.authenticated);
        assert_eq!(status.user.as_deref(), Some("fixture-user"));
    }

    #[test]
    fn repo_identity_parses_owner_repo() {
        let (dir, runner) = fixture_runner();
        let identity = repo_identity(&runner, &cwd(&dir)).expect("identity");
        assert_eq!(identity.owner, "acme");
        assert_eq!(identity.repo, "shop");
    }

    #[test]
    fn pr_list_and_details_normalize() {
        let (dir, runner) = fixture_runner();
        let prs = list_prs(&runner, &cwd(&dir), "open").expect("list");
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].number, 7);
        assert!(prs[0].is_draft);
        assert_eq!(prs[0].review_requests, vec!["alice".to_string()]);
        let details = pr_details(&runner, &cwd(&dir), 7).expect("details");
        assert_eq!(details.head_sha, "abc123");
    }

    #[test]
    fn files_checks_comments_normalize() {
        let (dir, runner) = fixture_runner();
        let files = pr_files(&runner, &cwd(&dir), 7).expect("files");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "a.ts");
        assert_eq!(files[0].additions, 10);
        let checks = pr_checks(&runner, &cwd(&dir), 7).expect("checks");
        assert_eq!(checks[0].conclusion, "success");
        let comments = pr_comments(&runner, &cwd(&dir), 7).expect("comments");
        assert_eq!(comments.len(), 2);
        assert!(comments.iter().any(|c| c.source == "coderabbit"));
    }

    #[test]
    fn pr_checks_returns_pending_and_failed_results_without_hiding_cli_errors() {
        let (dir, runner) = fixture_runner();
        let pending = pr_checks(&runner, &cwd(&dir), 8).expect("pending checks");
        assert_eq!(pending[0].state, "IN_PROGRESS");
        assert_eq!(pending[0].conclusion, "");
        let failed = pr_checks(&runner, &cwd(&dir), 9).expect("failed checks");
        assert_eq!(failed[0].conclusion, "failure");
        assert_eq!(
            pr_checks(&runner, &cwd(&dir), 10).expect_err("auth error"),
            "authentication required"
        );
        assert!(pr_checks(&runner, &cwd(&dir), 11).is_err());
    }

    #[test]
    fn create_pr_round_trips_to_list() {
        let (dir, runner) = fixture_runner();
        // Fixture list always returns PR 7; create targets a different head
        // to prove the read-back lookup path fails cleanly instead.
        let request = CreatePrRequest {
            title: "T".into(),
            body: "B".into(),
            base: "main".into(),
            head: "fix-cart".into(),
            draft: true,
        };
        let preview = preview_create_pr(&request);
        assert!(preview.contains(&"--draft".to_string()));
        let created = create_pr(&runner, &cwd(&dir), &request).expect("create");
        assert_eq!(created.number, 7);
        let fork = CreatePrRequest {
            head: "contributor:fix-cart".into(),
            ..request
        };
        assert_eq!(
            create_pr(&runner, &cwd(&dir), &fork).expect("fork").number,
            7
        );
        assert!(post_comment(&runner, &cwd(&dir), 7, "hello").is_ok());
        assert!(post_comment(&runner, &cwd(&dir), 7, "   ").is_err());
    }

    #[test]
    fn missing_executable_is_unavailable_not_panic() {
        let runner = GhRunner {
            executable: "orchevia-definitely-missing-gh-xyz".into(),
            timeout_secs: 5,
        };
        let status = auth_status(&runner);
        assert!(!status.authenticated);
    }

    #[test]
    fn coderabbit_recognized_as_feedback_source() {
        assert_eq!(
            classify_comment_source("coderabbitai[bot]", "looks good"),
            "coderabbit"
        );
        assert_eq!(
            classify_comment_source("alice", "lgtm, approved"),
            "github-review"
        );
        assert_eq!(classify_comment_source("bob", "please fix"), "comment");
    }
}
