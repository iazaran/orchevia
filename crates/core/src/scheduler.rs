//! Background evaluation: schedules + GitHub watchers (Milestone 5).
//!
//! The runner is deliberately thin: pure decision functions (tested with
//! fake clocks and fixture PRs) plus a small async driver that claims due
//! work in SQLite, starts runs through a [`RunStarter`] seam, and notifies.
//! Concurrency is bounded (default 2 scheduled runs); failures back off
//! watcher polls instead of hammering `gh`.

use crate::db::SqliteDb;
use crate::github::{PrComment, PullRequest};
use crate::schedule::{ScheduleDecision, Watcher, WatcherKind};
use chrono::{DateTime, Utc};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// Seam for starting runs (real engine in the app, fake in tests).
pub trait RunStarter: Send + Sync {
    fn start_workflow_run(
        &self,
        workflow_id: &str,
        inputs: &HashMap<String, String>,
    ) -> Result<String, String>;
}

/// What a watcher poll decided.
#[derive(Debug, Clone, PartialEq)]
pub enum WatcherAction {
    /// Nothing new.
    Quiet,
    /// Run the workflow for these PR revisions/keys.
    Trigger {
        pr_numbers: Vec<u64>,
        head_shas: HashMap<u64, String>,
        reason: String,
    },
}

/// Pure: which PRs need (re-)review. New PRs and new head SHAs trigger;
/// unchanged revisions never re-trigger.
pub fn review_requested_updates<'a>(
    prs: &'a [PullRequest],
    known_shas: &HashMap<u64, String>,
    own_login: Option<&str>,
) -> Vec<&'a PullRequest> {
    prs.iter()
        .filter(|pr| {
            if pr.is_draft {
                return false;
            }
            if let Some(own) = own_login {
                if pr.author.eq_ignore_ascii_case(own) {
                    return false;
                }
            }
            match known_shas.get(&pr.number) {
                None => true,
                Some(sha) => sha != &pr.head_sha,
            }
        })
        .collect()
}

/// Pure: new actionable feedback since last handled state.
/// `handled_comment_ids` uses author+timestamp+body-prefix keys; own comments
/// (by login or Orchevia marker) are ignored to avoid bot loops.
pub fn feedback_updates<'a>(
    comments: &'a [PrComment],
    since: Option<DateTime<Utc>>,
    handled: &HashSet<String>,
    own_login: Option<&str>,
    orchevia_marker: &str,
) -> Vec<&'a PrComment> {
    comments
        .iter()
        .filter(|comment| {
            if let Some(login) = own_login {
                if comment.author.eq_ignore_ascii_case(login) {
                    return false;
                }
            }
            if comment.body.contains(orchevia_marker) {
                return false;
            }
            if handled.contains(&comment_key(comment)) {
                return false;
            }
            match (since, parse_time(&comment.created_at)) {
                (Some(since), Some(at)) => at > since,
                (Some(_), None) => false,
                (None, _) => true,
            }
        })
        .collect()
}

fn comment_key(comment: &PrComment) -> String {
    let head: String = comment.body.chars().take(80).collect();
    format!("{}|{}|{}", comment.author, comment.created_at, head)
}

fn parse_time(raw: &str) -> Option<DateTime<Utc>> {
    raw.parse::<DateTime<Utc>>().ok()
}

/// Scheduler driver state (cloned into the background task).
pub struct Scheduler {
    pub db: Arc<SqliteDb>,
    pub max_concurrent_runs: usize,
}

impl Scheduler {
    pub fn new(db: Arc<SqliteDb>) -> Self {
        Self {
            db,
            max_concurrent_runs: 2,
        }
    }

    /// One poll pass: schedules first, then due watchers. Returns human
    /// summaries for logging (never secrets).
    pub async fn tick_once(
        &self,
        starter: &Arc<dyn RunStarter>,
        now: DateTime<Utc>,
    ) -> Vec<String> {
        let mut notes = Vec::new();
        notes.extend(self.tick_schedules(starter, now).await);
        notes.extend(self.tick_watchers(starter, now).await);
        notes
    }

    async fn tick_schedules(
        &self,
        starter: &Arc<dyn RunStarter>,
        now: DateTime<Utc>,
    ) -> Vec<String> {
        let mut notes = Vec::new();
        let schedules = self.db.list_schedules().unwrap_or_default();
        // Bounded concurrency: count running runs started by scheduler.
        let running = self
            .db
            .list_runs(200)
            .map(|runs| {
                runs.iter()
                    .filter(|r| matches!(r.status, crate::db::RunStatus::Running))
                    .count()
            })
            .unwrap_or(usize::MAX);
        let mut budget = self
            .max_concurrent_runs
            .saturating_sub(running.min(self.max_concurrent_runs));
        for mut schedule in schedules {
            if budget == 0 {
                break;
            }
            let (decision, next) = crate::schedule::evaluate(&schedule, now);
            schedule.next_run_at = next;
            match decision {
                ScheduleDecision::Wait | ScheduleDecision::Retire => {
                    let _ = self.db.upsert_schedule(&schedule);
                }
                ScheduleDecision::Fire => {
                    if !schedule.enabled {
                        continue;
                    }
                    // Trust gate: re-check risk at fire time (workflow may
                    // have changed since the schedule was enabled).
                    let trust = match self.db.get_workflow(&schedule.workflow_id) {
                        Ok(Some(wf)) => {
                            crate::trust::may_enable_schedule(&wf.definition, schedule.trusted)
                        }
                        Ok(None) => Err(format!(
                            "Workflow '{}' no longer exists.",
                            schedule.workflow_id
                        )),
                        Err(e) => Err(e.to_string()),
                    };
                    if let Err(message) = trust {
                        schedule.last_status = Some(format!("blocked: {message}"));
                        let _ = self.db.upsert_schedule(&schedule);
                        self.notify(
                            "schedule-blocked",
                            "Scheduled run blocked",
                            &format!("Schedule '{}': {message}", schedule.name),
                            None,
                        );
                        continue;
                    }
                    match starter.start_workflow_run(&schedule.workflow_id, &HashMap::new()) {
                        Ok(run_id) => {
                            budget -= 1;
                            schedule.last_run_at = Some(now);
                            schedule.last_status = Some(format!("started {run_id}"));
                            let _ = self.db.upsert_schedule(&schedule);
                            notes.push(format!("schedule '{}' started {run_id}", schedule.name));
                            self.notify(
                                "schedule-started",
                                "Scheduled run started",
                                &format!("Schedule '{}' started {run_id}.", schedule.name),
                                Some(&run_id),
                            );
                        }
                        Err(e) => {
                            schedule.last_status = Some(format!("failed to start: {e}"));
                            let _ = self.db.upsert_schedule(&schedule);
                            notes.push(format!("schedule '{}' failed: {e}", schedule.name));
                        }
                    }
                }
            }
        }
        notes
    }

    async fn tick_watchers(
        &self,
        starter: &Arc<dyn RunStarter>,
        now: DateTime<Utc>,
    ) -> Vec<String> {
        let mut notes = Vec::new();
        let watchers = self.db.list_watchers().unwrap_or_default();
        for mut watcher in watchers {
            if !watcher.poll_due(now) {
                continue;
            }
            let outcome = self.poll_watcher(starter, &watcher, now).await;
            match outcome {
                Ok((action, detail)) => {
                    watcher.last_checked_at = Some(now);
                    watcher.last_result = Some(detail.clone());
                    if let WatcherAction::Trigger { head_shas, .. } = &action {
                        // Remember handled revisions so they never re-fire.
                        if let Some((number, sha)) = head_shas.iter().next() {
                            let _ = number;
                            watcher.last_head_sha = Some(sha.clone());
                        }
                    }
                    let _ = self.db.upsert_watcher(&watcher);
                    if detail != "quiet" {
                        notes.push(detail);
                    }
                }
                Err(e) => {
                    // Back off: push next check out instead of hammering.
                    watcher.last_checked_at = Some(now);
                    watcher.last_result = Some(format!("error: {e}"));
                    let _ = self.db.upsert_watcher(&watcher);
                    notes.push(format!("watcher '{}' error: {e}", watcher.name));
                    // Failures must be visible: the Inbox shows this with details.
                    self.notify(
                        "watcher-error",
                        "Watcher failed",
                        &format!("Watcher '{}': {e}", watcher.name),
                        None,
                    );
                }
            }
        }
        notes
    }

    async fn poll_watcher(
        &self,
        starter: &Arc<dyn RunStarter>,
        watcher: &Watcher,
        _now: DateTime<Utc>,
    ) -> Result<(WatcherAction, String), String> {
        if !watcher.enabled {
            return Ok((WatcherAction::Quiet, "quiet".to_string()));
        }
        let runner = crate::github::GhRunner::default();
        // Auth once for own-login filtering (bot-loop guard).
        let auth = crate::github::auth_status(&runner);
        if !auth.authenticated {
            return Err("gh is not authenticated; run `gh auth login`.".to_string());
        }
        match watcher.kind {
            WatcherKind::ReviewRequested => {
                let prs = crate::github::list_prs(&runner, &watcher.repo_dir, "open")?;
                let mut known = HashMap::new();
                if let (Some(number), Some(sha)) =
                    (watcher.pr_number, watcher.last_head_sha.clone())
                {
                    known.insert(number, sha);
                }
                let mut known_all = self.known_shas(watcher);
                known_all.extend(known);
                let fresh = review_requested_updates(&prs, &known_all, auth.user.as_deref());
                if fresh.is_empty() {
                    return Ok((WatcherAction::Quiet, "quiet".to_string()));
                }
                let numbers: Vec<u64> = fresh.iter().map(|pr| pr.number).collect();
                let shas: HashMap<u64, String> = fresh
                    .iter()
                    .map(|pr| (pr.number, pr.head_sha.clone()))
                    .collect();
                for pr in &fresh {
                    let mut inputs = HashMap::new();
                    inputs.insert("prNumber".to_string(), pr.number.to_string());
                    inputs.insert("prHeadSha".to_string(), pr.head_sha.clone());
                    starter.start_workflow_run(&watcher.workflow_id, &inputs)?;
                }
                self.remember_shas(watcher, &shas);
                Ok((
                    WatcherAction::Trigger {
                        pr_numbers: numbers.clone(),
                        head_shas: shas,
                        reason: "review requested".to_string(),
                    },
                    format!("watcher '{}' triggered for PR(s) {numbers:?}", watcher.name),
                ))
            }
            WatcherKind::PrUpdated | WatcherKind::Feedback => {
                let number = watcher
                    .pr_number
                    .ok_or_else(|| "PR-scoped watcher needs a PR number.".to_string())?;
                let pr = crate::github::pr_details(&runner, &watcher.repo_dir, number)?;
                let known = self.known_shas(watcher);
                let changed = known
                    .get(&number)
                    .map(|sha| sha != &pr.head_sha)
                    .unwrap_or(true);
                if watcher.kind == WatcherKind::PrUpdated {
                    if !changed {
                        return Ok((WatcherAction::Quiet, "quiet".to_string()));
                    }
                    let mut inputs = HashMap::new();
                    inputs.insert("prNumber".to_string(), number.to_string());
                    inputs.insert("prHeadSha".to_string(), pr.head_sha.clone());
                    starter.start_workflow_run(&watcher.workflow_id, &inputs)?;
                    let mut shas = HashMap::new();
                    shas.insert(number, pr.head_sha.clone());
                    self.remember_shas(watcher, &shas);
                    return Ok((
                        WatcherAction::Trigger {
                            pr_numbers: vec![number],
                            head_shas: shas,
                            reason: "new PR revision".to_string(),
                        },
                        format!(
                            "watcher '{}' triggered for new revision of #{number}",
                            watcher.name
                        ),
                    ));
                }
                // Feedback: comments/checks newer than the last handled state.
                let comments = crate::github::pr_comments(&runner, &watcher.repo_dir, number)?;
                let handled = self.handled_comments(watcher);
                let fresh = feedback_updates(
                    &comments,
                    watcher.last_checked_at,
                    &handled,
                    auth.user.as_deref(),
                    "posted by Orchevia",
                );
                if fresh.is_empty() && !changed {
                    return Ok((WatcherAction::Quiet, "quiet".to_string()));
                }
                let mut inputs = HashMap::new();
                inputs.insert("prNumber".to_string(), number.to_string());
                inputs.insert("prHeadSha".to_string(), pr.head_sha.clone());
                inputs.insert("feedbackCount".to_string(), fresh.len().to_string());
                starter.start_workflow_run(&watcher.workflow_id, &inputs)?;
                let mut shas = HashMap::new();
                shas.insert(number, pr.head_sha.clone());
                self.remember_shas(watcher, &shas);
                self.remember_comments(watcher, &fresh);
                Ok((
                    WatcherAction::Trigger {
                        pr_numbers: vec![number],
                        head_shas: shas,
                        reason: format!("{} new feedback item(s)", fresh.len()),
                    },
                    format!(
                        "watcher '{}' triggered: {} new feedback item(s) on #{number}",
                        watcher.name,
                        fresh.len()
                    ),
                ))
            }
        }
    }

    fn notify(&self, kind: &str, title: &str, body: &str, run_id: Option<&str>) {
        let _ = self.db.push_notification(kind, title, body, run_id);
        // Best-effort OS dispatch under the stored prefs (quiet by default
        // for routine starts: only failures/approvals/findings surface).
        let prefs = self.db.get_notification_prefs().unwrap_or_default();
        let event = if kind == "schedule-started" {
            // Routine starts stay in the Center; no OS ping.
            return;
        } else {
            crate::notify::NotifyEvent::FeedbackNeedsAction {
                watcher: title.to_string(),
                detail: body.to_string(),
            }
        };
        if crate::notify::should_notify(&prefs, &event) {
            crate::notify::dispatch_os(title, body);
        }
    }

    /// Known head SHAs, persisted as settings (watcher-scoped).
    fn known_shas(&self, watcher: &Watcher) -> HashMap<u64, String> {
        self.db
            .get_setting(&format!("watcher.{}.shas", watcher.id))
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn remember_shas(&self, watcher: &Watcher, shas: &HashMap<u64, String>) {
        let mut known = self.known_shas(watcher);
        known.extend(shas.clone());
        if let Ok(raw) = serde_json::to_string(&known) {
            let _ = self
                .db
                .set_setting(&format!("watcher.{}.shas", watcher.id), &raw);
        }
    }

    fn handled_comments(&self, watcher: &Watcher) -> HashSet<String> {
        self.db
            .get_setting(&format!("watcher.{}.handled", watcher.id))
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
            .map(|v| v.into_iter().collect())
            .unwrap_or_default()
    }

    fn remember_comments(&self, watcher: &Watcher, fresh: &[&PrComment]) {
        let mut handled = self.handled_comments(watcher);
        for comment in fresh {
            handled.insert(format!(
                "{}|{}|{}",
                comment.author,
                comment.created_at,
                comment.body.chars().take(80).collect::<String>()
            ));
        }
        // Bound the set.
        let mut vec: Vec<String> = handled.into_iter().collect();
        vec.sort();
        vec.truncate(500);
        if let Ok(raw) = serde_json::to_string(&vec) {
            let _ = self
                .db
                .set_setting(&format!("watcher.{}.handled", watcher.id), &raw);
        }
    }
}

/// Scheduled-run starter trait object helper.
pub type StarterArc = Arc<dyn RunStarter>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::PrComment;

    fn pr(number: u64, sha: &str, author: &str, draft: bool) -> PullRequest {
        PullRequest {
            number,
            title: format!("PR {number}"),
            state: "open".into(),
            author: author.into(),
            head_branch: format!("b-{number}"),
            base_branch: "main".into(),
            head_sha: sha.into(),
            url: String::new(),
            is_draft: draft,
            review_requests: vec![],
            labels: vec![],
        }
    }

    #[test]
    fn new_and_changed_revisions_trigger() {
        let prs = vec![pr(1, "aaa", "bob", false), pr(2, "bbb", "carol", false)];
        let fresh = review_requested_updates(&prs, &HashMap::new(), Some("alice"));
        assert_eq!(fresh.len(), 2);
        let mut known = HashMap::new();
        known.insert(1u64, "aaa".to_string());
        known.insert(2u64, "bbb".to_string());
        assert!(review_requested_updates(&prs, &known, Some("alice")).is_empty());
        // New head SHA re-triggers.
        let prs = vec![pr(1, "zzz", "bob", false), pr(2, "bbb", "carol", false)];
        let fresh = review_requested_updates(&prs, &known, Some("alice"));
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].number, 1);
    }

    #[test]
    fn drafts_and_own_prs_ignored() {
        let prs = vec![pr(1, "a", "alice", false), pr(2, "b", "bob", true)];
        assert!(review_requested_updates(&prs, &HashMap::new(), Some("alice")).is_empty());
    }

    fn comment(author: &str, body: &str, at: &str) -> PrComment {
        PrComment {
            author: author.into(),
            body: body.into(),
            path: String::new(),
            line: -1,
            created_at: at.into(),
            source: "comment".into(),
        }
    }

    #[test]
    fn feedback_filters_handled_own_and_marker() {
        let comments = vec![
            comment("alice", "my own note", "2026-03-04T10:00:00Z"),
            comment("bob", "please fix", "2026-03-04T10:00:00Z"),
            comment("bot", "posted by Orchevia: draft", "2026-03-04T10:00:00Z"),
            comment("carol", "old news", "2026-03-01T10:00:00Z"),
        ];
        let since: DateTime<Utc> = "2026-03-04T09:00:00Z".parse().expect("time");
        let fresh = feedback_updates(
            &comments,
            Some(since),
            &HashSet::new(),
            Some("alice"),
            "posted by Orchevia",
        );
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].author, "bob");
    }

    #[test]
    fn handled_ids_never_refire() {
        let comments = vec![comment("bob", "please fix", "2026-03-04T10:00:00Z")];
        let mut handled = HashSet::new();
        handled.insert("bob|2026-03-04T10:00:00Z|please fix".to_string());
        let fresh = feedback_updates(&comments, None, &handled, None, "posted by Orchevia");
        assert!(fresh.is_empty());
    }

    #[test]
    fn watcher_poll_due_respects_interval_and_flag() {
        use crate::schedule::{Watcher, WatcherKind};
        let now: DateTime<Utc> = "2026-03-04T10:00:00Z".parse().expect("time");
        let watcher = Watcher {
            id: "w".into(),
            name: "W".into(),
            workflow_id: "wf".into(),
            kind: WatcherKind::ReviewRequested,
            repo_dir: "/tmp".into(),
            pr_number: None,
            enabled: false,
            check_interval_secs: 900,
            last_head_sha: None,
            last_checked_at: None,
            last_result: None,
        };
        assert!(!watcher.poll_due(now));
        let watcher = Watcher {
            enabled: true,
            ..watcher
        };
        assert!(watcher.poll_due(now));
        let watcher = Watcher {
            last_checked_at: Some(now),
            ..watcher
        };
        assert!(!watcher.poll_due(now));
    }
}

#[cfg(test)]
mod tick_tests {
    use super::*;
    use crate::schedule::{MissedPolicy, Schedule, ScheduleKind};
    use crate::workflow::{Node, NodeConfig, NodeKind, Position, Workflow, CURRENT_SCHEMA_VERSION};
    use std::sync::Mutex;

    struct FakeStarter {
        started: Mutex<Vec<(String, HashMap<String, String>)>>,
    }

    impl RunStarter for FakeStarter {
        fn start_workflow_run(
            &self,
            workflow_id: &str,
            inputs: &HashMap<String, String>,
        ) -> Result<String, String> {
            let id = format!("run-fake-{}", self.started.lock().expect("lock").len());
            self.started
                .lock()
                .expect("lock")
                .push((workflow_id.to_string(), inputs.clone()));
            Ok(id)
        }
    }

    fn linear_workflow(id: &str) -> Workflow {
        Workflow {
            schema_version: CURRENT_SCHEMA_VERSION,
            id: id.to_string(),
            name: id.to_string(),
            inputs: Vec::new(),
            defaults: None,
            nodes: vec![
                Node {
                    id: "start".into(),
                    kind: NodeKind::Start,
                    position: Position::default(),
                    config: NodeConfig::default(),
                    label: None,
                },
                Node {
                    id: "end".into(),
                    kind: NodeKind::End,
                    position: Position::default(),
                    config: NodeConfig::default(),
                    label: None,
                },
            ],
            edges: Vec::new(),
        }
    }

    #[tokio::test]
    async fn due_schedule_fires_once_and_advances() {
        let db = Arc::new(SqliteDb::open_in_memory().expect("db"));
        db.upsert_workflow(&linear_workflow("wf-1")).expect("wf");
        let now = Utc::now();
        db.upsert_schedule(&Schedule {
            id: "s1".into(),
            name: "S".into(),
            workflow_id: "wf-1".into(),
            kind: ScheduleKind::Interval { every_secs: 3600 },
            timezone: "utc".into(),
            enabled: true,
            trusted: true,
            missed_policy: MissedPolicy::RunOnce,
            last_run_at: None,
            next_run_at: Some(now - chrono::Duration::seconds(10)),
            last_status: None,
        })
        .expect("sched");
        let scheduler = Scheduler::new(Arc::clone(&db));
        let starter: Arc<dyn RunStarter> = Arc::new(FakeStarter {
            started: Mutex::new(Vec::new()),
        });
        let notes = scheduler.tick_once(&starter, now).await;
        assert!(notes.iter().any(|n| n.contains("started")), "{notes:?}");
        // Second tick: no duplicate (slot advanced past now).
        let notes = scheduler.tick_once(&starter, now).await;
        assert!(!notes.iter().any(|n| n.contains("started")), "{notes:?}");
        let sched = db.get_schedule("s1").expect("get").expect("exists");
        assert!(sched.next_run_at.map(|n| n > now).unwrap_or(false));
    }

    #[tokio::test]
    async fn untrusted_write_schedule_blocked_with_message() {
        use crate::workflow::NodeKind as NK;
        let db = Arc::new(SqliteDb::open_in_memory().expect("db"));
        let mut wf = linear_workflow("wf-risky");
        wf.nodes.push(Node {
            id: "cmd".into(),
            kind: NK::Command,
            position: Position::default(),
            config: NodeConfig {
                executable: Some("echo".into()),
                ..NodeConfig::default()
            },
            label: None,
        });
        db.upsert_workflow(&wf).expect("wf");
        let now = Utc::now();
        db.upsert_schedule(&Schedule {
            id: "s2".into(),
            name: "Risky".into(),
            workflow_id: "wf-risky".into(),
            kind: ScheduleKind::Interval { every_secs: 3600 },
            timezone: "utc".into(),
            enabled: true,
            trusted: false,
            missed_policy: MissedPolicy::RunOnce,
            last_run_at: None,
            next_run_at: Some(now - chrono::Duration::seconds(10)),
            last_status: None,
        })
        .expect("sched");
        let scheduler = Scheduler::new(Arc::clone(&db));
        let starter: Arc<dyn RunStarter> = Arc::new(FakeStarter {
            started: Mutex::new(Vec::new()),
        });
        scheduler.tick_once(&starter, now).await;
        let sched = db.get_schedule("s2").expect("get").expect("exists");
        assert!(
            sched
                .last_status
                .as_deref()
                .unwrap_or("")
                .contains("blocked"),
            "{:?}",
            sched.last_status
        );
        // A blocked notice landed in the Center.
        assert!(!db.list_notifications(10, false).expect("notes").is_empty());
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // test-only serialization lock; see engine test note
    async fn unauthenticated_watcher_backs_off_without_runs() {
        // Serialized with other ORCHEVIA_GH_BIN mutators (process-global key).
        let _bin_guard = crate::github::GH_BIN_TEST_LOCK.lock().expect("lock");
        use crate::schedule::{Watcher, WatcherKind};
        let db = Arc::new(SqliteDb::open_in_memory().expect("db"));
        db.upsert_workflow(&linear_workflow("wf-w")).expect("wf");
        // Point ORCHEVIA_GH_BIN at a missing binary so auth fails fast.
        std::env::set_var("ORCHEVIA_GH_BIN", "orchevia-definitely-missing-gh-xyz");
        db.upsert_watcher(&Watcher {
            id: "w1".into(),
            name: "W".into(),
            workflow_id: "wf-w".into(),
            kind: WatcherKind::ReviewRequested,
            repo_dir: "/tmp".into(),
            pr_number: None,
            enabled: true,
            check_interval_secs: 300,
            last_head_sha: None,
            last_checked_at: None,
            last_result: None,
        })
        .expect("watcher");
        let scheduler = Scheduler::new(Arc::clone(&db));
        let starter: Arc<dyn RunStarter> = Arc::new(FakeStarter {
            started: Mutex::new(Vec::new()),
        });
        let now = Utc::now();
        let notes = scheduler.tick_once(&starter, now).await;
        std::env::remove_var("ORCHEVIA_GH_BIN");
        assert!(notes.iter().any(|n| n.contains("error")), "{notes:?}");
        let watcher = db.get_watcher("w1").expect("get").expect("exists");
        assert!(watcher.last_checked_at.is_some(), "next poll pushed out");
        // The failure is visible in the notification Center with details.
        let notes_db = db.list_notifications(10, false).expect("notes");
        assert!(
            notes_db.iter().any(|n| n.kind == "watcher-error"
                && n.title.contains("Watcher failed")
                && n.body.contains('W')),
            "{notes_db:?}"
        );
    }
}
