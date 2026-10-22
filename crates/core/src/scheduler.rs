//! Background evaluation: schedules + GitHub watchers (Milestone 5).
//!
//! The runner is deliberately thin: pure decision functions (tested with
//! fake clocks and fixture PRs) plus a small async driver that claims due
//! work in SQLite, starts runs through a [`RunStarter`] seam, and notifies.
//! Concurrency is bounded (default 2 scheduled runs); failures back off
//! watcher polls instead of hammering `gh`.

use crate::db::SqliteDb;
use crate::github::{PrComment, PullRequest};
use crate::schedule::{CheckWindow, ScheduleDecision, Watcher, WatcherKind};
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

/// Longest the app loop sleeps between checks. Due times are computed, so
/// this only bounds clock changes and sleep/resume.
pub const MAX_CHECK_WAIT_SECS: u64 = 60;
/// Re-check delay for work that is due but waiting (run limit, active run).
pub const DUE_RECHECK_SECS: u64 = 30;

/// Pure core of [`Scheduler::next_wait`].
pub fn next_wait_for(
    schedules: &[crate::schedule::Schedule],
    watchers: &[Watcher],
    now: DateTime<Utc>,
) -> std::time::Duration {
    let schedule_due = schedules
        .iter()
        .filter(|schedule| schedule.enabled)
        .filter_map(|schedule| schedule.next_run_at);
    let watcher_due =
        watchers
            .iter()
            .filter(|watcher| watcher.enabled)
            .map(|watcher| match watcher.last_checked_at {
                None => now,
                Some(last) => {
                    last + chrono::Duration::seconds(watcher.check_interval_secs.max(300) as i64)
                }
            });
    let wait_secs = schedule_due
        .chain(watcher_due)
        .map(|due| {
            let until = due.signed_duration_since(now);
            if until <= chrono::Duration::zero() {
                DUE_RECHECK_SECS
            } else {
                // Round up so the check lands on or just after the slot.
                let millis = u64::try_from(until.num_milliseconds()).unwrap_or(u64::MAX);
                millis.div_ceil(1000)
            }
        })
        .min()
        .unwrap_or(MAX_CHECK_WAIT_SECS);
    std::time::Duration::from_secs(wait_secs.clamp(1, MAX_CHECK_WAIT_SECS))
}

/// Save a schedule from the editor or a card switch. It is normalized against
/// the stored row (`Schedule::prepare_save`) and written only if that row did
/// not change meanwhile (retried), so a save racing the scheduler never puts
/// back a slot that just ran.
pub fn save_schedule(
    db: &SqliteDb,
    schedule: &crate::schedule::Schedule,
    now: DateTime<Utc>,
) -> Result<crate::schedule::Schedule, String> {
    for _ in 0..5 {
        let previous = db.get_schedule(&schedule.id).map_err(|e| e.to_string())?;
        let mut prepared = schedule.clone();
        prepared.prepare_save(previous.as_ref(), now);
        if prepared.enabled {
            if let Some(reason) = prepared.one_time_spent(now) {
                return Err(reason.into());
            }
        }
        let errors = prepared.validate();
        if !errors.is_empty() {
            return Err(format!("Invalid schedule: {}", errors.join("; ")));
        }
        let saved = match &previous {
            None => db.upsert_schedule(&prepared).map(|()| true),
            Some(previous) => db.record_schedule_check(previous, &prepared),
        }
        .map_err(|e| e.to_string())?;
        if saved {
            return Ok(prepared);
        }
    }
    Err("The schedule kept changing while saving; try again.".into())
}

/// Record a manual "Run now" on the stored schedule without overwriting a
/// concurrent save or scheduler check (compare-and-swap, retried).
pub fn record_manual_run(
    db: &SqliteDb,
    schedule_id: &str,
    run_id: &str,
    now: DateTime<Utc>,
) -> Result<(), String> {
    for _ in 0..3 {
        let Some(current) = db.get_schedule(schedule_id).map_err(|e| e.to_string())? else {
            return Ok(());
        };
        let mut updated = current.clone();
        updated.last_run_at = Some(now);
        updated.last_status = Some(format!("manually started {run_id}"));
        // The manual run serves a slot that is due or held back, so it does
        // not start again automatically once this run ends.
        updated.deferred_slot = None;
        if !matches!(updated.kind, crate::schedule::ScheduleKind::OneTime { .. })
            && updated.next_run_at.is_some_and(|slot| slot <= now)
        {
            updated.next_run_at = crate::schedule::next_run(&updated.kind, &updated.timezone, now);
        }
        if db
            .record_schedule_check(&current, &updated)
            .map_err(|e| e.to_string())?
        {
            return Ok(());
        }
    }
    Err("The schedule kept changing; the run started but was not recorded on it.".into())
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

    /// One poll pass with the default grace for late slots, as part of a
    /// continuous run (see [`Scheduler::tick`]).
    pub async fn tick_once(
        &self,
        starter: &Arc<dyn RunStarter>,
        now: DateTime<Utc>,
    ) -> Vec<String> {
        let window = CheckWindow {
            grace: crate::schedule::default_missed_grace(),
            continuous: true,
        };
        self.tick(starter, now, window).await
    }

    /// One poll pass: schedules first, then due watchers. `window` says how
    /// late a schedule slot may be and still run as on time, and whether the
    /// app stayed awake since the previous check (the app loop passes
    /// [`crate::schedule::check_window`]). Returns human summaries for logging
    /// (never secrets).
    pub async fn tick(
        &self,
        starter: &Arc<dyn RunStarter>,
        now: DateTime<Utc>,
        window: CheckWindow,
    ) -> Vec<String> {
        let mut notes = Vec::new();
        let mut budget = self
            .db
            .list_active_runs()
            .map(|runs| self.max_concurrent_runs.saturating_sub(runs.len()))
            .unwrap_or(0);
        notes.extend(self.tick_schedules(starter, now, window, &mut budget).await);
        notes.extend(self.tick_watchers(starter, now, &mut budget).await);
        notes
    }

    /// How long the app loop may sleep before the next check: until the
    /// earliest enabled schedule slot or watcher poll, at most
    /// [`MAX_CHECK_WAIT_SECS`]. Work that is already due but waiting (run
    /// limit, active workflow) is re-checked after [`DUE_RECHECK_SECS`], so
    /// deferrals never spin. Saves wake the loop early.
    pub fn next_wait(&self, now: DateTime<Utc>) -> std::time::Duration {
        let schedules = self.db.list_schedules().unwrap_or_default();
        let watchers = self.db.list_watchers().unwrap_or_default();
        next_wait_for(&schedules, &watchers, now)
    }

    async fn tick_schedules(
        &self,
        starter: &Arc<dyn RunStarter>,
        now: DateTime<Utc>,
        window: CheckWindow,
        budget: &mut usize,
    ) -> Vec<String> {
        let mut notes = Vec::new();
        let schedules = self.db.list_schedules().unwrap_or_default();
        for mut schedule in schedules {
            let before = schedule.clone();
            // A slot held back before Orchevia quit or the computer slept is
            // a missed slot now: the policy decides, not its old place.
            if !window.continuous {
                schedule.deferred_slot = None;
            }
            let (decision, next) =
                crate::schedule::evaluate_with_grace(&schedule, now, window.grace);
            match decision {
                ScheduleDecision::Wait | ScheduleDecision::Retire => {
                    schedule.next_run_at = next;
                    if decision == ScheduleDecision::Retire {
                        schedule.enabled = false;
                        schedule.deferred_slot = None;
                    }
                    self.record_schedule(&before, &schedule, false);
                }
                ScheduleDecision::SkipMissed => {
                    // Visible on the card, so a skipped slot is never silent.
                    schedule.next_run_at = next;
                    schedule.deferred_slot = None;
                    schedule.last_status =
                        Some("skipped: a run was due while Orchevia was closed or asleep".into());
                    self.record_schedule(&before, &schedule, false);
                    notes.push(format!(
                        "schedule '{}' skipped a missed slot",
                        schedule.name
                    ));
                }
                ScheduleDecision::Fire => {
                    // Held back slots keep their place and run once capacity
                    // frees, however long that takes (see `deferred_slot`).
                    let defer = |schedule: &mut crate::schedule::Schedule, reason: &str| {
                        schedule.deferred_slot = crate::schedule::due_slot(schedule);
                        schedule.last_status = Some(format!("deferred: {reason}"));
                    };
                    if *budget == 0 {
                        defer(&mut schedule, "run limit reached");
                        self.record_schedule(&before, &schedule, false);
                        continue;
                    }
                    // Trust gate: re-check risk at fire time (workflow may
                    // have changed since the schedule was enabled).
                    let trust = match self.db.get_workflow(&schedule.workflow_id) {
                        Ok(Some(wf)) => match self.db.list_effective_agent_profiles() {
                            Ok(profiles) => crate::trust::may_enable_schedule(
                                &wf.definition,
                                &profiles,
                                schedule.trusted,
                            ),
                            Err(e) => Err(e.to_string()),
                        },
                        Ok(None) => Err(format!(
                            "Workflow '{}' no longer exists.",
                            schedule.workflow_id
                        )),
                        Err(e) => Err(e.to_string()),
                    };
                    if let Err(message) = trust {
                        // This slot cannot run: move on, and notify once per
                        // change instead of on every check.
                        schedule.next_run_at = next;
                        schedule.deferred_slot = None;
                        schedule.last_status = Some(format!("blocked: {message}"));
                        let changed = before.last_status != schedule.last_status;
                        self.record_schedule(&before, &schedule, false);
                        if changed {
                            self.notify(
                                "schedule-blocked",
                                "Scheduled run blocked",
                                &format!("Schedule '{}': {message}", schedule.name),
                                None,
                            );
                        }
                        continue;
                    }
                    if self.overlaps(&schedule.workflow_id, None).unwrap_or(true) {
                        defer(&mut schedule, "workflow already active");
                        self.record_schedule(&before, &schedule, false);
                        continue;
                    }
                    if !self.refresh_budget(budget).unwrap_or(false) {
                        defer(&mut schedule, "run limit reached");
                        self.record_schedule(&before, &schedule, false);
                        continue;
                    }
                    let inputs = HashMap::from([
                        ("automationKind".into(), "schedule".into()),
                        ("automationId".into(), schedule.id.clone()),
                    ]);
                    match starter.start_workflow_run(&schedule.workflow_id, &inputs) {
                        Ok(run_id) => {
                            *budget -= 1;
                            schedule.next_run_at = next;
                            schedule.deferred_slot = None;
                            schedule.last_run_at = Some(now);
                            schedule.last_status = Some(format!("started {run_id}"));
                            self.record_schedule(&before, &schedule, true);
                            notes.push(format!("schedule '{}' started {run_id}", schedule.name));
                            self.notify(
                                "schedule-started",
                                "Scheduled run started",
                                &format!("Schedule '{}' started {run_id}.", schedule.name),
                                Some(&run_id),
                            );
                        }
                        Err(e) => {
                            // No retry storm: this slot is spent; the next one
                            // tries again.
                            schedule.next_run_at = next;
                            schedule.deferred_slot = None;
                            schedule.last_status = Some(format!("failed to start: {e}"));
                            let changed = before.last_status != schedule.last_status;
                            self.record_schedule(&before, &schedule, false);
                            notes.push(format!("schedule '{}' failed: {e}", schedule.name));
                            if changed {
                                self.notify(
                                    "schedule-failed",
                                    "Scheduled run failed to start",
                                    &format!("Schedule '{}': {e}", schedule.name),
                                    None,
                                );
                            }
                        }
                    }
                }
            }
        }
        notes
    }

    /// Persist schedule bookkeeping; unchanged rows are not rewritten. A save
    /// that lands between this tick's read and write wins, except that a run
    /// this tick started is merged into the saved row so its slot is not
    /// started twice.
    fn record_schedule(
        &self,
        before: &crate::schedule::Schedule,
        after: &crate::schedule::Schedule,
        started: bool,
    ) {
        if before == after
            || self
                .db
                .record_schedule_check(before, after)
                .unwrap_or(false)
        {
            return;
        }
        if !started {
            return;
        }
        if let Ok(Some(current)) = self.db.get_schedule(&after.id) {
            let mut merged = current.clone();
            merged.last_run_at = after.last_run_at;
            merged.last_status = after.last_status.clone();
            if merged.next_run_at == before.next_run_at {
                merged.next_run_at = after.next_run_at;
                merged.deferred_slot = None;
            }
            let _ = self.db.record_schedule_check(&current, &merged);
        }
    }

    async fn tick_watchers(
        &self,
        starter: &Arc<dyn RunStarter>,
        now: DateTime<Utc>,
        budget: &mut usize,
    ) -> Vec<String> {
        let mut notes = Vec::new();
        let watchers = self.db.list_watchers().unwrap_or_default();
        for mut watcher in watchers {
            if !watcher.poll_due(now) {
                continue;
            }
            // last_checked_at also advances on failures for backoff. Preserve
            // the successful feedback watermark separately in the existing
            // watcher-scoped settings before a poll can overwrite that field.
            let before = watcher.clone();
            let feedback_since_key = watcher_setting_key(&watcher, "feedbackSince");
            self.remember_shas(&watcher, &HashMap::new());
            self.remember_comments(&watcher, &[]);
            if watcher.kind == WatcherKind::Feedback {
                let since = self
                    .feedback_since(&watcher)
                    .map(|since| since.to_rfc3339())
                    .unwrap_or_default();
                let _ = self.db.set_setting(&feedback_since_key, &since);
            }
            let outcome = self.poll_watcher(starter, &watcher, now, budget).await;
            match outcome {
                Ok((action, detail)) => {
                    if watcher.kind == WatcherKind::Feedback && !detail.starts_with("deferred:") {
                        let _ = self.db.set_setting(&feedback_since_key, &now.to_rfc3339());
                    }
                    watcher.last_checked_at = Some(now);
                    watcher.last_result = Some(detail.clone());
                    if let WatcherAction::Trigger { head_shas, .. } = &action {
                        // Remember handled revisions so they never re-fire.
                        if let Some((number, sha)) = head_shas.iter().next() {
                            let _ = number;
                            watcher.last_head_sha = Some(sha.clone());
                        }
                    }
                    let _ = self.db.record_watcher_check(&before, &watcher);
                    if !detail.starts_with("quiet") {
                        notes.push(detail);
                    }
                }
                Err(e) => {
                    // Back off: push next check out instead of hammering.
                    watcher.last_checked_at = Some(now);
                    watcher.last_result = Some(format!("error: {e}"));
                    let changed = before.last_result != watcher.last_result;
                    let _ = self.db.record_watcher_check(&before, &watcher);
                    notes.push(format!("watcher '{}' error: {e}", watcher.name));
                    // Failures must be visible: the Inbox shows this with
                    // details, once per new error rather than every poll.
                    if changed {
                        self.notify(
                            "watcher-error",
                            "Watcher failed",
                            &format!("Watcher '{}': {e}", watcher.name),
                            None,
                        );
                    }
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
        budget: &mut usize,
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
                let prs = crate::github::list_requested_reviews(&runner, &watcher.repo_dir)?;
                let mut known = HashMap::new();
                if let (Some(number), Some(sha)) =
                    (watcher.pr_number, watcher.last_head_sha.clone())
                {
                    known.insert(number, sha);
                }
                let mut known_all = self.known_shas(watcher);
                known_all.extend(known);
                let fresh: Vec<_> =
                    review_requested_updates(&prs, &known_all, auth.user.as_deref())
                        .into_iter()
                        .filter(|pr| watcher.pr_number.is_none_or(|number| number == pr.number))
                        .collect();
                if fresh.is_empty() {
                    return Ok((
                        WatcherAction::Quiet,
                        "quiet: no new requested revisions".to_string(),
                    ));
                }
                let workflow = self
                    .db
                    .get_workflow(&watcher.workflow_id)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| format!("Unknown workflow '{}'.", watcher.workflow_id))?;
                let scoped = workflow_consumes_pr_number(&workflow.definition);
                let mut shas = HashMap::new();
                let mut runs = Vec::new();
                if scoped {
                    for pr in &fresh {
                        if *budget == 0
                            || !self.watcher_current(watcher)?
                            || self.overlaps(&watcher.workflow_id, Some(pr.number))?
                            || !self.refresh_budget(budget)?
                        {
                            continue;
                        }
                        let mut inputs = watcher_inputs(watcher);
                        inputs.insert("prNumber".into(), pr.number.to_string());
                        inputs.insert("prHeadSha".into(), pr.head_sha.clone());
                        let run = starter.start_workflow_run(&watcher.workflow_id, &inputs)?;
                        *budget -= 1;
                        let revision = HashMap::from([(pr.number, pr.head_sha.clone())]);
                        // Persist each accepted dispatch immediately; a later failure
                        // must not cause the already-started PR to run again.
                        self.remember_shas(watcher, &revision);
                        shas.extend(revision);
                        runs.push(format!("#{}/{} → {run}", pr.number, pr.head_sha));
                    }
                } else if *budget > 0
                    && self.watcher_current(watcher)?
                    && !self.overlaps(&watcher.workflow_id, None)?
                    && self.refresh_budget(budget)?
                {
                    let mut inputs = watcher_inputs(watcher);
                    inputs.insert(
                        "prNumbers".into(),
                        fresh
                            .iter()
                            .map(|pr| pr.number.to_string())
                            .collect::<Vec<_>>()
                            .join(","),
                    );
                    inputs.insert(
                        "prHeadShas".into(),
                        serde_json::to_string(
                            &fresh
                                .iter()
                                .map(|pr| (pr.number, &pr.head_sha))
                                .collect::<HashMap<_, _>>(),
                        )
                        .map_err(|e| e.to_string())?,
                    );
                    let run = starter.start_workflow_run(&watcher.workflow_id, &inputs)?;
                    *budget -= 1;
                    shas.extend(fresh.iter().map(|pr| (pr.number, pr.head_sha.clone())));
                    self.remember_shas(watcher, &shas);
                    runs.push(format!("repository scan → {run}"));
                }
                if shas.is_empty() {
                    return Ok((WatcherAction::Quiet, "deferred: run limit or workflow already active; requested revisions remain eligible".into()));
                }
                let mut numbers: Vec<_> = shas.keys().copied().collect();
                numbers.sort_unstable();
                let detail = format!(
                    "watcher '{}' triggered {} ({} revision(s) deferred)",
                    watcher.name,
                    runs.join(", "),
                    fresh.len() - shas.len()
                );
                Ok((
                    WatcherAction::Trigger {
                        pr_numbers: numbers,
                        head_shas: shas,
                        reason: "review requested".into(),
                    },
                    detail,
                ))
            }
            WatcherKind::PrUpdated | WatcherKind::Feedback => {
                let number = watcher
                    .pr_number
                    .ok_or_else(|| "PR-scoped watcher needs a PR number.".to_string())?;
                if *budget == 0
                    || !self.watcher_current(watcher)?
                    || self.overlaps(&watcher.workflow_id, Some(number))?
                {
                    return Ok((
                        WatcherAction::Quiet,
                        "deferred: run limit or PR workflow already active".into(),
                    ));
                }
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
                    let mut inputs = watcher_inputs(watcher);
                    inputs.insert("prNumber".to_string(), number.to_string());
                    inputs.insert("prHeadSha".to_string(), pr.head_sha.clone());
                    if !self.watcher_current(watcher)? || !self.refresh_budget(budget)? {
                        return Ok((
                            WatcherAction::Quiet,
                            "deferred: watcher disabled, removed or scope changed during check"
                                .into(),
                        ));
                    }
                    let run_id = starter.start_workflow_run(&watcher.workflow_id, &inputs)?;
                    *budget -= 1;
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
                            "watcher '{}' triggered for new revision of #{number}: {run_id}",
                            watcher.name
                        ),
                    ));
                }
                // Feedback: comments/checks newer than the last handled state.
                let comments = crate::github::pr_comments(&runner, &watcher.repo_dir, number)?;
                let handled = self.handled_comments(watcher);
                let fresh = feedback_updates(
                    &comments,
                    self.feedback_since(watcher),
                    &handled,
                    auth.user.as_deref(),
                    "posted by Orchevia",
                );
                if fresh.is_empty() && !changed {
                    return Ok((WatcherAction::Quiet, "quiet".to_string()));
                }
                let mut inputs = watcher_inputs(watcher);
                inputs.insert("prNumber".to_string(), number.to_string());
                inputs.insert("prHeadSha".to_string(), pr.head_sha.clone());
                inputs.insert("feedbackCount".to_string(), fresh.len().to_string());
                if !self.watcher_current(watcher)? || !self.refresh_budget(budget)? {
                    return Ok((
                        WatcherAction::Quiet,
                        "deferred: watcher disabled, removed or scope changed during check".into(),
                    ));
                }
                let run_id = starter.start_workflow_run(&watcher.workflow_id, &inputs)?;
                *budget -= 1;
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
                        "watcher '{}' triggered: {} new feedback item(s) on #{number}: {run_id}",
                        watcher.name,
                        fresh.len()
                    ),
                ))
            }
        }
    }

    fn refresh_budget(&self, budget: &mut usize) -> Result<bool, String> {
        let available = self
            .max_concurrent_runs
            .saturating_sub(self.db.list_active_runs().map_err(|e| e.to_string())?.len());
        *budget = (*budget).min(available);
        Ok(*budget > 0)
    }

    fn watcher_current(&self, watcher: &Watcher) -> Result<bool, String> {
        let current = self
            .db
            .get_watcher(&watcher.id)
            .map_err(|e| e.to_string())?;
        if !current.is_some_and(|current| current.enabled && current.same_scope(watcher)) {
            return Ok(false);
        }
        validate_watcher_workflow(&self.db, watcher)?;
        Ok(true)
    }

    fn overlaps(&self, workflow_id: &str, pr_number: Option<u64>) -> Result<bool, String> {
        let runs = self.db.list_active_runs().map_err(|e| e.to_string())?;
        Ok(runs.iter().any(|run| {
            run.workflow_id == workflow_id
                && match pr_number {
                    None => true,
                    Some(number) => run
                        .inputs
                        .get("prNumber")
                        .is_none_or(|value| value == &number.to_string()),
                }
        }))
    }

    /// Inbox entry, plus a desktop notification when system notifications
    /// are on (Settings) and the matching preference allows it. Routine
    /// starts stay in the Inbox; blocked, failed and watcher errors follow
    /// the failure preference.
    fn notify(&self, kind: &str, title: &str, body: &str, run_id: Option<&str>) {
        let _ = self.db.push_notification(kind, title, body, run_id);
        if kind == "schedule-started" {
            return;
        }
        let prefs = self.db.get_notification_prefs().unwrap_or_default();
        let os_enabled = self
            .db
            .get_setting("notifications.os")
            .ok()
            .flatten()
            .is_some_and(|v| v == "1");
        if os_enabled && prefs.on_failure {
            crate::notify::dispatch_os(title, body);
        }
    }

    /// Successful feedback watermark, persisted with other watcher settings.
    fn feedback_since(&self, watcher: &Watcher) -> Option<DateTime<Utc>> {
        self.db
            .get_setting(&watcher_setting_key(watcher, "feedbackSince"))
            .ok()
            .flatten()
            .or_else(|| {
                (watcher.last_checked_at.is_some() || watcher.last_head_sha.is_some())
                    .then(|| {
                        self.db
                            .get_setting(&format!("watcher.{}.feedbackSince", watcher.id))
                            .ok()
                            .flatten()
                    })
                    .flatten()
            })
            .and_then(|raw| parse_time(&raw))
            .or_else(|| {
                // Preserve the existing baseline when upgrading a successful
                // watcher. An errored watcher has no trustworthy last-handled
                // timestamp, so recover unhandled comments through dedupe.
                watcher.last_checked_at.filter(|_| {
                    !watcher
                        .last_result
                        .as_deref()
                        .is_some_and(|result| result.starts_with("error:"))
                })
            })
    }

    /// Known head SHAs, persisted as settings (watcher-scoped).
    fn known_shas(&self, watcher: &Watcher) -> HashMap<u64, String> {
        self.db
            .get_setting(&watcher_setting_key(watcher, "shas"))
            .ok()
            .flatten()
            .or_else(|| {
                (watcher.last_checked_at.is_some() || watcher.last_head_sha.is_some())
                    .then(|| {
                        self.db
                            .get_setting(&format!("watcher.{}.shas", watcher.id))
                            .ok()
                            .flatten()
                    })
                    .flatten()
            })
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn remember_shas(&self, watcher: &Watcher, shas: &HashMap<u64, String>) {
        let mut known = self.known_shas(watcher);
        known.extend(shas.clone());
        if let Ok(raw) = serde_json::to_string(&known) {
            let _ = self
                .db
                .set_setting(&watcher_setting_key(watcher, "shas"), &raw);
        }
    }

    fn handled_comments(&self, watcher: &Watcher) -> HashSet<String> {
        self.db
            .get_setting(&watcher_setting_key(watcher, "handled"))
            .ok()
            .flatten()
            .or_else(|| {
                (watcher.last_checked_at.is_some() || watcher.last_head_sha.is_some())
                    .then(|| {
                        self.db
                            .get_setting(&format!("watcher.{}.handled", watcher.id))
                            .ok()
                            .flatten()
                    })
                    .flatten()
            })
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
                .set_setting(&watcher_setting_key(watcher, "handled"), &raw);
        }
    }
}

/// Validate declared execution directories against the repository being polled.
/// Inputs do not override working directories in the engine.
pub fn validate_watcher_workflow(db: &SqliteDb, watcher: &Watcher) -> Result<(), String> {
    let workflow = db
        .get_workflow(&watcher.workflow_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Unknown workflow '{}'.", watcher.workflow_id))?
        .definition;
    validate_watcher_definition(db, &workflow, watcher)
}

pub fn validate_watcher_definition(
    db: &SqliteDb,
    workflow: &crate::workflow::Workflow,
    watcher: &Watcher,
) -> Result<(), String> {
    use crate::agents::WorkingDirMode;
    use crate::workflow::NodeKind;
    let mut roots: HashMap<String, String> = HashMap::new();
    let mut scope = |directory: &str| -> Result<String, String> {
        if let Some(root) = roots.get(directory) {
            return Ok(root.clone());
        }
        let root = crate::git::discover_root(directory).unwrap_or_else(|| directory.into());
        let scope = crate::memory::project_scope(&root)?;
        roots.insert(directory.to_string(), scope.clone());
        Ok(scope)
    };
    let expected = scope(&watcher.repo_dir)?;
    let profiles = db.list_agent_profiles().map_err(|e| e.to_string())?;
    for node in &workflow.nodes {
        let explicit = node
            .config
            .working_dir
            .as_deref()
            .map(str::trim)
            .filter(|dir| !dir.is_empty());
        let fallback = workflow
            .defaults
            .as_ref()
            .and_then(|defaults| defaults.repo_dir.as_deref())
            .map(str::trim)
            .filter(|dir| !dir.is_empty());
        let directory = match node.kind {
            NodeKind::Git | NodeKind::GitHub | NodeKind::Command => explicit.or(fallback),
            NodeKind::Agent => profiles
                .iter()
                .find(|profile| Some(&profile.id) == node.config.agent_profile_id.as_ref())
                .and_then(|profile| match profile.working_dir_mode {
                    WorkingDirMode::Node => explicit,
                    WorkingDirMode::Profile => profile.working_dir.as_deref(),
                    WorkingDirMode::Inherit => None,
                }),
            _ => None,
        };
        if let Some(directory) = directory {
            if scope(directory)? != expected {
                return Err(format!("Watcher repository does not match workflow node '{}'. Set its working directory (or applicable workflow/profile default) to the watched repository.", node.id));
            }
        } else if matches!(node.kind, NodeKind::Git | NodeKind::GitHub) {
            return Err(format!("Workflow node '{}' needs a repository directory matching the watcher; input.repoDir does not override directories.", node.id));
        }
    }
    Ok(())
}

fn watcher_setting_key(watcher: &Watcher, suffix: &str) -> String {
    // Include the actual scope so an old in-flight check cannot consume a
    // revision in a newly edited watcher scope with the same id.
    format!(
        "watcher.{}.scope.{:?}.{suffix}",
        watcher.id,
        (
            watcher.kind,
            &watcher.repo_dir,
            &watcher.workflow_id,
            watcher.pr_number
        )
    )
}

fn watcher_inputs(watcher: &Watcher) -> HashMap<String, String> {
    HashMap::from([
        ("automationKind".into(), "watcher".into()),
        ("automationId".into(), watcher.id.clone()),
        ("watcherKind".into(), format!("{:?}", watcher.kind)),
        ("repoDir".into(), watcher.repo_dir.clone()),
    ])
}

/// A declared input alone is insufficient: the workflow must consume it.
/// Native PR operations resolve number 0; templates use input.prNumber.
pub fn workflow_consumes_pr_number(workflow: &crate::workflow::Workflow) -> bool {
    use crate::workflow::{GitHubOp, GitOp, NodeKind};
    fn consumes(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::String(template) => {
                crate::prompt::render_prompt(template, &HashMap::new())
                    .1
                    .iter()
                    .any(|name| name == "input.prNumber")
            }
            serde_json::Value::Array(values) => values.iter().any(consumes),
            serde_json::Value::Object(values) => values.values().any(consumes),
            _ => false,
        }
    }
    let reachable = workflow
        .nodes
        .iter()
        .find(|node| node.kind == NodeKind::Start)
        .map(|start| crate::workflow::reachable_from(workflow, &start.id))
        .unwrap_or_default();
    workflow
        .nodes
        .iter()
        .filter(|node| reachable.contains(&node.id))
        .any(|node| {
            let config = &node.config;
            if node.kind == NodeKind::GitHub
                && matches!(
                    config.github_op,
                    Some(
                        GitHubOp::PrDetails { number: 0 }
                            | GitHubOp::PrFiles { number: 0 }
                            | GitHubOp::PrChecks { number: 0 }
                            | GitHubOp::PostComment { number: 0, .. }
                    )
                )
            {
                return true;
            }
            let value = match node.kind {
                NodeKind::Condition => {
                    return config.condition.as_ref().is_some_and(|condition| {
                        condition
                            .clauses
                            .iter()
                            .any(|clause| clause.left == "input.prNumber")
                    })
                }
                NodeKind::Command => serde_json::to_value(&config.args),
                NodeKind::Agent => serde_json::to_value(&config.prompt),
                NodeKind::Mcp => serde_json::to_value(&config.mcp_args),
                NodeKind::Ticket => serde_json::to_value(&config.ticket_key),
                NodeKind::Git if !matches!(config.git_op, Some(GitOp::Stage { .. })) => {
                    serde_json::to_value(&config.git_op)
                }
                NodeKind::GitHub if !matches!(config.github_op, Some(GitHubOp::ListPrs { .. })) => {
                    serde_json::to_value(&config.github_op)
                }
                _ => return false,
            };
            value.is_ok_and(|value| consumes(&value))
        })
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
            limits: None,
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
            deferred_slot: None,
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

    fn skip_schedule(id: &str, next_run_at: DateTime<Utc>) -> Schedule {
        Schedule {
            id: id.into(),
            name: "Review PRs".into(),
            workflow_id: "wf-1".into(),
            kind: ScheduleKind::Interval { every_secs: 3600 },
            timezone: "utc".into(),
            enabled: true,
            trusted: true,
            missed_policy: MissedPolicy::Skip,
            last_run_at: None,
            next_run_at: Some(next_run_at),
            last_status: None,
            deferred_slot: None,
        }
    }

    #[tokio::test]
    async fn slot_due_since_the_previous_check_fires_however_late() {
        let db = Arc::new(SqliteDb::open_in_memory().expect("db"));
        db.upsert_workflow(&linear_workflow("wf-1")).expect("wf");
        let now = Utc::now();
        db.upsert_schedule(&skip_schedule("s1", now - chrono::Duration::minutes(23)))
            .expect("sched");
        let scheduler = Scheduler::new(Arc::clone(&db));
        let starter: Arc<dyn RunStarter> = Arc::new(FakeStarter {
            started: Mutex::new(Vec::new()),
        });
        // The previous check was an hour ago and the app stayed awake.
        let window = crate::schedule::check_window(
            Some(now - chrono::Duration::hours(1)),
            std::time::Duration::from_secs(3600),
            now,
        );
        let notes = scheduler.tick(&starter, now, window).await;
        assert!(notes.iter().any(|n| n.contains("started")), "{notes:?}");
        let sched = db.get_schedule("s1").expect("get").expect("exists");
        assert_eq!(sched.last_run_at, Some(now));
    }

    #[tokio::test]
    async fn slot_missed_while_closed_is_skipped_visibly() {
        let db = Arc::new(SqliteDb::open_in_memory().expect("db"));
        db.upsert_workflow(&linear_workflow("wf-1")).expect("wf");
        let now = Utc::now();
        db.upsert_schedule(&skip_schedule("s1", now - chrono::Duration::minutes(23)))
            .expect("sched");
        let scheduler = Scheduler::new(Arc::clone(&db));
        let starter: Arc<dyn RunStarter> = Arc::new(FakeStarter {
            started: Mutex::new(Vec::new()),
        });
        // First check after launch: the default grace applies.
        let notes = scheduler.tick_once(&starter, now).await;
        assert!(!notes.iter().any(|n| n.contains("started")), "{notes:?}");
        let sched = db.get_schedule("s1").expect("get").expect("exists");
        assert_eq!(sched.last_run_at, None);
        assert!(sched
            .last_status
            .as_deref()
            .is_some_and(|status| status.starts_with("skipped:")));
        assert!(sched.next_run_at.is_some_and(|next| next > now));
    }

    #[test]
    fn next_wait_lands_on_the_earliest_slot() {
        let now = Utc::now();
        let soon = skip_schedule("soon", now + chrono::Duration::milliseconds(12_300));
        let later = skip_schedule("later", now + chrono::Duration::minutes(40));
        let mut paused = skip_schedule("paused", now + chrono::Duration::seconds(2));
        paused.enabled = false;
        assert_eq!(
            next_wait_for(&[later.clone(), soon, paused], &[], now),
            std::time::Duration::from_secs(13)
        );
        // Nothing sooner than a minute: re-check within a minute anyway.
        assert_eq!(
            next_wait_for(&[later], &[], now),
            std::time::Duration::from_secs(MAX_CHECK_WAIT_SECS)
        );
        assert_eq!(
            next_wait_for(&[], &[], now),
            std::time::Duration::from_secs(MAX_CHECK_WAIT_SECS)
        );
        // Due but deferred (run limit): no busy loop.
        let deferred = skip_schedule("deferred", now - chrono::Duration::seconds(5));
        assert_eq!(
            next_wait_for(&[deferred], &[], now),
            std::time::Duration::from_secs(DUE_RECHECK_SECS)
        );
    }

    #[test]
    fn next_wait_counts_watcher_polls() {
        let now = Utc::now();
        let watcher = Watcher {
            id: "w".into(),
            name: "W".into(),
            workflow_id: "wf-1".into(),
            kind: WatcherKind::ReviewRequested,
            repo_dir: "/tmp/repo".into(),
            pr_number: None,
            enabled: true,
            check_interval_secs: 300,
            last_head_sha: None,
            last_checked_at: Some(now - chrono::Duration::seconds(290)),
            last_result: None,
        };
        assert_eq!(
            next_wait_for(&[], std::slice::from_ref(&watcher), now),
            std::time::Duration::from_secs(10)
        );
        let fresh = Watcher {
            last_checked_at: None,
            ..watcher
        };
        assert_eq!(
            next_wait_for(&[], &[fresh], now),
            std::time::Duration::from_secs(DUE_RECHECK_SECS)
        );
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
            deferred_slot: None,
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

    #[cfg(unix)]
    #[tokio::test]
    #[allow(clippy::await_holding_lock)] // existing process-global gh fixture lock
    async fn feedback_retries_unhandled_comments_after_start_failure() {
        use crate::schedule::{Watcher, WatcherKind};
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::{AtomicBool, Ordering};

        struct RetryStarter {
            fail: AtomicBool,
            started: Mutex<Vec<HashMap<String, String>>>,
        }
        impl RunStarter for RetryStarter {
            fn start_workflow_run(
                &self,
                _workflow_id: &str,
                inputs: &HashMap<String, String>,
            ) -> Result<String, String> {
                if self.fail.load(Ordering::SeqCst) {
                    return Err("Required workflow input is missing.".into());
                }
                self.started.lock().expect("started").push(inputs.clone());
                Ok("run-feedback-retry".into())
            }
        }

        let _bin_guard = crate::github::GH_BIN_TEST_LOCK.lock().expect("lock");
        let dir = tempfile::tempdir().expect("tempdir");
        let script = dir.path().join("gh");
        std::fs::write(
            &script,
            r#"#!/bin/sh
if [ "$1" = "auth" ]; then
  echo 'Logged in to github.com account alice (keyring)'
elif [ "$5" = "reviews,comments" ]; then
  echo '{"reviews":[],"comments":[{"author":{"login":"carol"},"body":"old feedback","createdAt":"2026-03-04T08:00:00Z"},{"author":{"login":"bob"},"body":"please fix","createdAt":"2026-03-04T09:30:00Z"}]}'
else
  echo '{"number":7,"headRefOid":"stable"}'
fi
"#,
        )
        .expect("fixture");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
            .expect("executable");
        std::env::set_var("ORCHEVIA_GH_BIN", &script);
        let db = Arc::new(SqliteDb::open_in_memory().expect("db"));
        let now: DateTime<Utc> = "2026-03-04T10:00:00Z".parse().expect("now");
        db.upsert_watcher(&Watcher {
            id: "feedback-retry".into(),
            name: "Feedback retry".into(),
            workflow_id: "wf".into(),
            kind: WatcherKind::Feedback,
            repo_dir: dir.path().to_string_lossy().into_owned(),
            pr_number: Some(7),
            enabled: true,
            check_interval_secs: 300,
            last_head_sha: Some("stable".into()),
            last_checked_at: Some(now - chrono::Duration::hours(1)),
            last_result: Some("quiet".into()),
        })
        .expect("watcher");
        db.upsert_workflow(&linear_workflow("wf"))
            .expect("workflow");
        db.set_setting("watcher.feedback-retry.shas", r#"{"7":"stable"}"#)
            .expect("known sha");
        let concrete = Arc::new(RetryStarter {
            fail: AtomicBool::new(true),
            started: Mutex::new(Vec::new()),
        });
        let starter: Arc<dyn RunStarter> = concrete.clone();
        let scheduler = Scheduler::new(Arc::clone(&db));
        let first = scheduler.tick_once(&starter, now).await;
        concrete.fail.store(false, Ordering::SeqCst);
        let retry = scheduler
            .tick_once(&starter, now + chrono::Duration::minutes(5))
            .await;
        let quiet = scheduler
            .tick_once(&starter, now + chrono::Duration::minutes(10))
            .await;
        std::env::remove_var("ORCHEVIA_GH_BIN");
        assert!(first.iter().any(|note| note.contains("error")), "{first:?}");
        assert!(
            retry.iter().any(|note| note.contains("triggered")),
            "{retry:?}"
        );
        assert!(
            quiet.is_empty(),
            "handled feedback must stay quiet: {quiet:?}"
        );
        let started = concrete.started.lock().expect("started");
        assert_eq!(started.len(), 1);
        assert_eq!(
            started[0].get("feedbackCount").map(String::as_str),
            Some("1")
        );
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

#[cfg(all(test, unix))]
mod reliability_tests {
    use super::*;
    use crate::workflow::{sample_workflow, GitHubOp};
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Mutex;

    struct Recorder {
        inputs: Mutex<Vec<HashMap<String, String>>>,
        fail_number: Option<String>,
    }
    impl RunStarter for Recorder {
        fn start_workflow_run(
            &self,
            _: &str,
            inputs: &HashMap<String, String>,
        ) -> Result<String, String> {
            if self
                .fail_number
                .as_ref()
                .is_some_and(|n| inputs.get("prNumber") == Some(n))
            {
                return Err("fixture start failed".into());
            }
            let mut rows = self.inputs.lock().expect("rows");
            rows.push(inputs.clone());
            Ok(format!("run-{}", rows.len()))
        }
    }
    fn setup(scoped: bool) -> (tempfile::TempDir, Arc<SqliteDb>, Watcher) {
        let dir = tempfile::tempdir().expect("dir");
        let script = dir.path().join("gh");
        std::fs::write(&script, r#"#!/bin/sh
if [ "$1" = "auth" ]; then
  echo 'Logged in to github.com account alice (keyring)'
elif [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  case "$*" in
    *review-requested:@me*) echo '[{"number":1,"author":{"login":"bob"},"headRefOid":"a","reviewRequests":[{"login":"alice"}]},{"number":2,"author":{"login":"carol"},"headRefOid":"b","reviewRequests":[{"login":"alice"}]},{"number":3,"author":{"login":"dan"},"headRefOid":"c","reviewRequests":[{"login":"alice"}]}]' ;;
    *) echo '[{"number":9,"author":{"login":"bob"},"headRefOid":"unrelated","reviewRequests":[{"login":"someone-else"}]}]' ;;
  esac
else
  exit 1
fi
"#).expect("script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        std::env::set_var("ORCHEVIA_GH_BIN", &script);
        let db = Arc::new(SqliteDb::open_in_memory().expect("db"));
        let mut wf = sample_workflow();
        wf.id = "wf".into();
        if scoped {
            wf.nodes[1].kind = crate::workflow::NodeKind::GitHub;
            wf.nodes[1].config.github_op = Some(GitHubOp::PrDetails { number: 0 });
            wf.nodes[1].config.working_dir = Some(dir.path().to_string_lossy().into_owned());
        }
        db.upsert_workflow(&wf).expect("wf");
        let watcher = Watcher {
            id: "requested".into(),
            name: "Requested".into(),
            workflow_id: "wf".into(),
            kind: WatcherKind::ReviewRequested,
            repo_dir: dir.path().to_string_lossy().into_owned(),
            pr_number: None,
            enabled: true,
            check_interval_secs: 300,
            last_head_sha: None,
            last_checked_at: None,
            last_result: None,
        };
        db.upsert_watcher(&watcher).expect("watcher");
        (dir, db, watcher)
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn disabling_a_watcher_during_dispatch_stops_the_remaining_batch() {
        let _guard = crate::github::GH_BIN_TEST_LOCK.lock().expect("lock");
        let (_dir, db, watcher) = setup(true);
        struct DisableStarter {
            db: Arc<SqliteDb>,
            watcher: Watcher,
            count: Mutex<usize>,
        }
        impl RunStarter for DisableStarter {
            fn start_workflow_run(
                &self,
                _: &str,
                _: &HashMap<String, String>,
            ) -> Result<String, String> {
                *self.count.lock().expect("count") += 1;
                let mut disabled = self.watcher.clone();
                disabled.enabled = false;
                self.db.upsert_watcher(&disabled).expect("disable");
                Ok("accepted-run".into())
            }
        }
        let concrete = Arc::new(DisableStarter {
            db: Arc::clone(&db),
            watcher,
            count: Mutex::new(0),
        });
        let starter: Arc<dyn RunStarter> = concrete.clone();
        Scheduler::new(Arc::clone(&db))
            .tick_once(&starter, Utc::now())
            .await;
        assert_eq!(*concrete.count.lock().expect("count"), 1);
        assert!(
            !db.get_watcher("requested")
                .expect("get")
                .expect("watcher")
                .enabled
        );
        std::env::remove_var("ORCHEVIA_GH_BIN");
    }

    #[tokio::test]
    async fn full_run_budget_defers_schedule_without_consuming_its_slot() {
        use crate::schedule::{MissedPolicy, Schedule, ScheduleKind};
        let db = Arc::new(SqliteDb::open_in_memory().expect("db"));
        let wf = sample_workflow();
        db.upsert_workflow(&wf).expect("wf");
        for id in ["manual-one", "manual-two"] {
            db.create_run(id, &wf.id, &HashMap::new()).expect("run");
        }
        let now = Utc::now();
        db.upsert_schedule(&Schedule {
            id: "capacity".into(),
            name: "Due".into(),
            workflow_id: wf.id,
            kind: ScheduleKind::Interval { every_secs: 900 },
            timezone: "utc".into(),
            enabled: true,
            trusted: true,
            missed_policy: MissedPolicy::RunOnce,
            last_run_at: None,
            next_run_at: Some(now),
            last_status: None,
            deferred_slot: None,
        })
        .expect("schedule");
        let starter: Arc<dyn RunStarter> = Arc::new(Recorder {
            inputs: Mutex::new(vec![]),
            fail_number: None,
        });
        Scheduler::new(Arc::clone(&db))
            .tick_once(&starter, now)
            .await;
        let saved = db.get_schedule("capacity").expect("get").expect("exists");
        assert_eq!(saved.next_run_at, Some(now));
        assert_eq!(
            saved.last_status.as_deref(),
            Some("deferred: run limit reached")
        );
    }

    fn due_schedule(id: &str, workflow_id: &str, slot: DateTime<Utc>) -> Schedule {
        Schedule {
            id: id.into(),
            name: "Due".into(),
            workflow_id: workflow_id.into(),
            kind: ScheduleKind::Interval { every_secs: 900 },
            timezone: "utc".into(),
            enabled: true,
            trusted: true,
            missed_policy: MissedPolicy::Skip,
            last_run_at: None,
            next_run_at: Some(slot),
            last_status: None,
            deferred_slot: None,
        }
    }

    use crate::schedule::{MissedPolicy, Schedule, ScheduleKind};

    #[tokio::test]
    async fn a_held_back_slot_runs_when_capacity_frees_however_late() {
        let db = Arc::new(SqliteDb::open_in_memory().expect("db"));
        let wf = sample_workflow();
        db.upsert_workflow(&wf).expect("wf");
        for id in ["manual-one", "manual-two"] {
            db.create_run(id, &wf.id, &HashMap::new()).expect("run");
        }
        let slot = Utc::now();
        db.upsert_schedule(&due_schedule("held", &wf.id, slot))
            .expect("schedule");
        let recorder = Arc::new(Recorder {
            inputs: Mutex::new(vec![]),
            fail_number: None,
        });
        let starter: Arc<dyn RunStarter> = recorder.clone();
        let scheduler = Scheduler::new(Arc::clone(&db));
        // Ten minutes of 30-second checks while both run slots are taken:
        // far beyond the default grace, yet the slot is never "missed".
        for step in 0..=20 {
            let now = slot + chrono::Duration::seconds(30 * step);
            let window = crate::schedule::check_window(
                Some(now - chrono::Duration::seconds(30)),
                std::time::Duration::from_secs(30),
                now,
            );
            scheduler.tick(&starter, now, window).await;
        }
        let saved = db.get_schedule("held").expect("get").expect("exists");
        assert_eq!(saved.deferred_slot, Some(slot));
        assert_eq!(saved.next_run_at, Some(slot));
        assert!(recorder.inputs.lock().expect("rows").is_empty());
        for id in ["manual-one", "manual-two"] {
            db.finish_run(id, crate::db::RunStatus::Succeeded)
                .expect("finish");
        }
        let later = slot + chrono::Duration::minutes(11);
        scheduler.tick_once(&starter, later).await;
        assert_eq!(recorder.inputs.lock().expect("rows").len(), 1);
        let saved = db.get_schedule("held").expect("get").expect("exists");
        assert_eq!(saved.deferred_slot, None);
        assert!(saved.next_run_at.is_some_and(|next| next > later));
        assert_eq!(saved.last_run_at, Some(later));
    }

    #[tokio::test]
    async fn a_held_back_slot_follows_the_policy_after_quit_or_sleep() {
        let db = Arc::new(SqliteDb::open_in_memory().expect("db"));
        let wf = sample_workflow();
        db.upsert_workflow(&wf).expect("wf");
        let slot = Utc::now() - chrono::Duration::days(3);
        let mut held = due_schedule("held", &wf.id, slot);
        held.deferred_slot = Some(slot);
        db.upsert_schedule(&held).expect("schedule");
        let recorder = Arc::new(Recorder {
            inputs: Mutex::new(vec![]),
            fail_number: None,
        });
        let starter: Arc<dyn RunStarter> = recorder.clone();
        // First check after a relaunch (or after the computer slept).
        let now = Utc::now();
        let window = crate::schedule::check_window(None, std::time::Duration::ZERO, now);
        assert!(!window.continuous);
        Scheduler::new(Arc::clone(&db))
            .tick(&starter, now, window)
            .await;
        assert!(
            recorder.inputs.lock().expect("rows").is_empty(),
            "Skip skips it"
        );
        let saved = db.get_schedule("held").expect("get").expect("exists");
        assert_eq!(saved.deferred_slot, None);
        assert!(saved
            .last_status
            .as_deref()
            .is_some_and(|status| status.starts_with("skipped:")));
    }

    #[tokio::test]
    async fn a_blocked_schedule_notifies_once_and_moves_on() {
        let db = Arc::new(SqliteDb::open_in_memory().expect("db"));
        let mut schedule = due_schedule("orphan", "deleted-workflow", Utc::now());
        schedule.missed_policy = MissedPolicy::RunOnce;
        let slot = schedule.next_run_at.expect("slot");
        db.upsert_schedule(&schedule).expect("schedule");
        let starter: Arc<dyn RunStarter> = Arc::new(Recorder {
            inputs: Mutex::new(vec![]),
            fail_number: None,
        });
        let scheduler = Scheduler::new(Arc::clone(&db));
        for minutes in [0, 1, 16, 31] {
            scheduler
                .tick_once(&starter, slot + chrono::Duration::minutes(minutes))
                .await;
        }
        let saved = db.get_schedule("orphan").expect("get").expect("exists");
        assert!(saved
            .last_status
            .as_deref()
            .is_some_and(|status| status.starts_with("blocked:")));
        assert!(saved.next_run_at.is_some_and(|next| next > slot));
        let blocked = db
            .list_notifications(50, false)
            .expect("notes")
            .into_iter()
            .filter(|n| n.kind == "schedule-blocked")
            .count();
        assert_eq!(blocked, 1);
    }

    #[tokio::test]
    async fn a_save_racing_a_started_run_keeps_the_run_recorded() {
        let db = Arc::new(SqliteDb::open_in_memory().expect("db"));
        let slot = Utc::now();
        let before = due_schedule("raced", "wf", slot);
        // The user renamed the schedule after the tick read it.
        let mut renamed = before.clone();
        renamed.name = "Renamed".into();
        db.upsert_schedule(&renamed).expect("schedule");
        let mut after = before.clone();
        after.last_run_at = Some(slot);
        after.last_status = Some("started run-1".into());
        after.next_run_at = Some(slot + chrono::Duration::minutes(15));
        Scheduler::new(Arc::clone(&db)).record_schedule(&before, &after, true);
        let saved = db.get_schedule("raced").expect("get").expect("exists");
        assert_eq!(saved.name, "Renamed");
        assert_eq!(saved.last_run_at, Some(slot));
        assert_eq!(
            saved.next_run_at, after.next_run_at,
            "the slot is not run twice"
        );
    }

    #[test]
    fn saving_a_stale_copy_keeps_what_the_scheduler_recorded() {
        let db = SqliteDb::open_in_memory().expect("db");
        let slot = Utc::now();
        let form = due_schedule("edit", "wf", slot);
        db.upsert_schedule(&form).expect("schedule");
        // The scheduler ran the slot after the editor opened.
        let mut ran = form.clone();
        ran.last_run_at = Some(slot);
        ran.last_status = Some("started run-1".into());
        ran.next_run_at = Some(slot + chrono::Duration::minutes(15));
        assert!(db.record_schedule_check(&form, &ran).expect("record"));
        let mut renamed = form.clone();
        renamed.name = "Renamed".into();
        let saved = save_schedule(&db, &renamed, slot).expect("save");
        assert_eq!(saved.name, "Renamed");
        assert_eq!(
            saved.next_run_at, ran.next_run_at,
            "the used slot stays used"
        );
        assert_eq!(saved.last_run_at, Some(slot));
        assert_eq!(db.get_schedule("edit").expect("get"), Some(saved));
        let mut invalid = renamed.clone();
        invalid.kind = ScheduleKind::Interval { every_secs: 5 };
        assert_eq!(
            save_schedule(&db, &invalid, slot).err().as_deref(),
            Some("Invalid schedule: Interval must be 60 s – 30 days.")
        );
    }

    #[test]
    fn a_spent_one_time_schedule_cannot_be_turned_back_on() {
        let db = SqliteDb::open_in_memory().expect("db");
        let at = Utc::now() - chrono::Duration::hours(1);
        let mut once = due_schedule("once", "wf", at);
        once.kind = ScheduleKind::OneTime { at };
        once.enabled = false;
        once.last_run_at = Some(at);
        db.upsert_schedule(&once).expect("schedule");
        let mut resumed = once.clone();
        resumed.enabled = true;
        assert_eq!(
            save_schedule(&db, &resumed, Utc::now()).err().as_deref(),
            Some("This one-time schedule already ran. Pick a new time to run it again.")
        );
        // A new time arms it again.
        let later = Utc::now() + chrono::Duration::hours(1);
        resumed.kind = ScheduleKind::OneTime { at: later };
        let saved = save_schedule(&db, &resumed, Utc::now()).expect("rearmed");
        assert_eq!(saved.next_run_at, Some(later));
        // Never ran, time long gone, Skip policy.
        let mut stale = due_schedule("stale", "wf", at);
        stale.kind = ScheduleKind::OneTime { at };
        assert_eq!(
            save_schedule(&db, &stale, Utc::now()).err().as_deref(),
            Some("This one-time schedule's time has passed. Pick a new time.")
        );
    }

    #[tokio::test]
    async fn manual_runs_are_recorded_without_overwriting_the_row() {
        let db = SqliteDb::open_in_memory().expect("db");
        let slot = Utc::now();
        let mut stored = due_schedule("manual", "wf", slot);
        stored.deferred_slot = Some(slot);
        db.upsert_schedule(&stored).expect("schedule");
        let now = slot + chrono::Duration::seconds(5);
        record_manual_run(&db, "manual", "run-9", now).expect("record");
        let saved = db.get_schedule("manual").expect("get").expect("exists");
        assert_eq!(saved.last_status.as_deref(), Some("manually started run-9"));
        // The manual run serves the held-back slot: no automatic repeat.
        assert_eq!(saved.deferred_slot, None);
        assert!(saved.next_run_at.is_some_and(|next| next > now));
        assert!(record_manual_run(&db, "missing", "run-1", now).is_ok());
    }

    #[tokio::test]
    async fn deleting_a_schedule_during_start_does_not_resurrect_it() {
        use crate::schedule::{MissedPolicy, Schedule, ScheduleKind};
        let db = Arc::new(SqliteDb::open_in_memory().expect("db"));
        db.upsert_workflow(&sample_workflow()).expect("workflow");
        let now = Utc::now();
        db.upsert_schedule(&Schedule {
            id: "delete-me".into(),
            name: "Once".into(),
            workflow_id: sample_workflow().id,
            kind: ScheduleKind::OneTime { at: now },
            timezone: "utc".into(),
            enabled: true,
            trusted: true,
            missed_policy: MissedPolicy::RunOnce,
            last_run_at: None,
            next_run_at: Some(now),
            last_status: None,
            deferred_slot: None,
        })
        .expect("schedule");
        struct DeleteStarter(Arc<SqliteDb>);
        impl RunStarter for DeleteStarter {
            fn start_workflow_run(
                &self,
                _: &str,
                _: &HashMap<String, String>,
            ) -> Result<String, String> {
                self.0.delete_schedule("delete-me").expect("delete");
                Ok("accepted-run".into())
            }
        }
        let starter: Arc<dyn RunStarter> = Arc::new(DeleteStarter(Arc::clone(&db)));
        Scheduler::new(Arc::clone(&db))
            .tick_once(&starter, now)
            .await;
        assert!(db.get_schedule("delete-me").expect("get").is_none());
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn a_workflow_pointing_to_another_repository_is_not_dispatched() {
        let _guard = crate::github::GH_BIN_TEST_LOCK.lock().expect("lock");
        let (_dir, db, watcher) = setup(true);
        let other = tempfile::tempdir().expect("other repo");
        let mut wf = db.get_workflow("wf").expect("get").expect("wf").definition;
        wf.nodes[1].config.working_dir = Some(other.path().to_string_lossy().into_owned());
        db.upsert_workflow(&wf).expect("update");
        let concrete = Arc::new(Recorder {
            inputs: Mutex::new(vec![]),
            fail_number: None,
        });
        let starter: Arc<dyn RunStarter> = concrete.clone();
        let notes = Scheduler::new(Arc::clone(&db))
            .tick_once(&starter, Utc::now())
            .await;
        assert!(concrete.inputs.lock().expect("inputs").is_empty());
        assert!(
            notes.iter().any(|note| note.contains("repository")),
            "{notes:?}"
        );
        assert!(Scheduler::new(db).known_shas(&watcher).is_empty());
        std::env::remove_var("ORCHEVIA_GH_BIN");
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn manual_runs_started_during_github_poll_reduce_the_dispatch_budget() {
        let _guard = crate::github::GH_BIN_TEST_LOCK.lock().expect("lock");
        let (dir, db, mut watcher) = setup(false);
        watcher.kind = WatcherKind::PrUpdated;
        watcher.pr_number = Some(7);
        db.upsert_watcher(&watcher).expect("watcher");
        let script = dir.path().join("gh");
        let marker = dir.path().join("started");
        std::fs::write(
            &script,
            r#"#!/bin/sh
if [ "$1" = "auth" ]; then echo 'Logged in to github.com account alice (keyring)'
else
  touch "$(dirname "$0")/started"; sleep 0.3
  echo '{"number":7,"headRefOid":"a"}'
fi
"#,
        )
        .expect("script");
        let mut manual_wf = sample_workflow();
        manual_wf.id = "manual-workflow".into();
        db.upsert_workflow(&manual_wf).expect("workflow");
        let manual_db = Arc::clone(&db);
        let insert = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            while !marker.exists() && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            assert!(marker.exists());
            for id in ["manual-one", "manual-two"] {
                manual_db
                    .create_run(id, "manual-workflow", &HashMap::new())
                    .expect("run");
            }
        });
        let concrete = Arc::new(Recorder {
            inputs: Mutex::new(vec![]),
            fail_number: None,
        });
        let starter: Arc<dyn RunStarter> = concrete.clone();
        Scheduler::new(db).tick_once(&starter, Utc::now()).await;
        insert.join().expect("manual runs");
        assert!(concrete.inputs.lock().expect("inputs").is_empty());
        std::env::remove_var("ORCHEVIA_GH_BIN");
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn pr_scoped_watchers_recheck_saved_scope_after_slow_github_reads() {
        let _guard = crate::github::GH_BIN_TEST_LOCK.lock().expect("lock");
        for kind in [WatcherKind::PrUpdated, WatcherKind::Feedback] {
            let (dir, db, mut watcher) = setup(false);
            watcher.kind = kind;
            watcher.pr_number = Some(7);
            db.upsert_watcher(&watcher).expect("watcher");
            let script = dir.path().join("gh");
            let marker = dir.path().join("started");
            std::fs::write(&script, r#"#!/bin/sh
if [ "$1" = "auth" ]; then
  echo 'Logged in to github.com account alice (keyring)'
elif [ "$5" = "reviews,comments" ]; then
  echo '{"reviews":[],"comments":[{"author":{"login":"bob"},"body":"please fix","createdAt":"2026-03-04T09:30:00Z"}]}'
else
  touch "$(dirname "$0")/started"
  sleep 0.3
  echo '{"number":7,"headRefOid":"a"}'
fi
"#).expect("script");
            let editing_db = Arc::clone(&db);
            let mut changed = watcher;
            if kind == WatcherKind::PrUpdated {
                changed.enabled = false;
            } else {
                changed.repo_dir = "/different-repository".into();
            }
            let edit = std::thread::spawn(move || {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
                while !marker.exists() && std::time::Instant::now() < deadline {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                assert!(
                    marker.exists(),
                    "GitHub query must start before editing scope"
                );
                editing_db.upsert_watcher(&changed).expect("edit");
            });
            let concrete = Arc::new(Recorder {
                inputs: Mutex::new(vec![]),
                fail_number: None,
            });
            let starter: Arc<dyn RunStarter> = concrete.clone();
            Scheduler::new(db).tick_once(&starter, Utc::now()).await;
            edit.join().expect("edit finished");
            assert!(
                concrete.inputs.lock().expect("inputs").is_empty(),
                "{kind:?} must honor changes made during the GitHub read"
            );
        }
        std::env::remove_var("ORCHEVIA_GH_BIN");
    }

    #[test]
    fn literal_condition_right_operand_does_not_consume_a_pr() {
        use crate::workflow::{
            ConditionClause, ConditionConfig, ConditionLogic, ConditionOp, NodeKind,
        };
        let mut wf = sample_workflow();
        wf.nodes[1].kind = NodeKind::Condition;
        wf.nodes[1].config.args.clear();
        wf.nodes[1].config.condition = Some(ConditionConfig {
            logic: ConditionLogic::And,
            clauses: vec![ConditionClause {
                left: "workflow.name".into(),
                op: ConditionOp::Equals,
                right: "input.prNumber".into(),
            }],
        });
        assert!(!workflow_consumes_pr_number(&wf));
        wf.nodes[1]
            .config
            .condition
            .as_mut()
            .expect("condition")
            .clauses[0]
            .right = "{{input.prNumber}}".into();
        assert!(
            !workflow_consumes_pr_number(&wf),
            "right operands remain literal even with template syntax"
        );
    }

    #[test]
    fn pr_consumption_includes_mcp_templates_but_excludes_escaped_literals() {
        let mut wf = sample_workflow();
        wf.nodes[1].config.args = vec![r"\{{input.prNumber}}".into()];
        assert!(
            !workflow_consumes_pr_number(&wf),
            "escaped text is not a consumed PR input"
        );
        wf.nodes[1].config.args.clear();
        wf.nodes[1].kind = crate::workflow::NodeKind::Mcp;
        wf.nodes[1].config.mcp_args =
            Some(HashMap::from([("pr".into(), "{{input.prNumber}}".into())]));
        assert!(workflow_consumes_pr_number(&wf));
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn requested_reviews_are_scoped_bounded_and_initially_eligible() {
        let _guard = crate::github::GH_BIN_TEST_LOCK.lock().expect("lock");
        let (_dir, db, _) = setup(true);
        let concrete = Arc::new(Recorder {
            inputs: Mutex::new(vec![]),
            fail_number: None,
        });
        let starter: Arc<dyn RunStarter> = concrete.clone();
        let scheduler = Scheduler::new(db);
        let now = Utc::now();
        scheduler.tick_once(&starter, now).await;
        let first = concrete.inputs.lock().expect("rows").clone();
        assert_eq!(first.len(), 2, "two-run budget applies to watcher dispatch");
        assert_eq!(first[0].get("prNumber").map(String::as_str), Some("1"));
        assert_eq!(
            first[0].get("automationId").map(String::as_str),
            Some("requested")
        );
        scheduler
            .tick_once(&starter, now + chrono::Duration::minutes(5))
            .await;
        let rows = concrete.inputs.lock().expect("rows");
        assert_eq!(
            rows.len(),
            3,
            "deferred PR remains eligible; handled SHAs do not refire"
        );
        assert_eq!(rows[2].get("prNumber").map(String::as_str), Some("3"));
        std::env::remove_var("ORCHEVIA_GH_BIN");
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn repository_scanner_dispatches_once_for_the_batch() {
        let _guard = crate::github::GH_BIN_TEST_LOCK.lock().expect("lock");
        let (_dir, db, _) = setup(false);
        let concrete = Arc::new(Recorder {
            inputs: Mutex::new(vec![]),
            fail_number: None,
        });
        let starter: Arc<dyn RunStarter> = concrete.clone();
        let scheduler = Scheduler::new(db);
        scheduler.tick_once(&starter, Utc::now()).await;
        let rows = concrete.inputs.lock().expect("rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("prNumbers").map(String::as_str), Some("1,2,3"));
        assert!(!rows[0].contains_key("prNumber"));
        std::env::remove_var("ORCHEVIA_GH_BIN");
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn partial_dispatch_failure_retains_successful_revision() {
        let _guard = crate::github::GH_BIN_TEST_LOCK.lock().expect("lock");
        let (_dir, db, watcher) = setup(true);
        let concrete = Arc::new(Recorder {
            inputs: Mutex::new(vec![]),
            fail_number: Some("2".into()),
        });
        let starter: Arc<dyn RunStarter> = concrete.clone();
        let scheduler = Scheduler::new(db);
        scheduler.tick_once(&starter, Utc::now()).await;
        assert_eq!(
            scheduler.known_shas(&watcher).get(&1).map(String::as_str),
            Some("a")
        );
        assert!(!scheduler.known_shas(&watcher).contains_key(&2));
        std::env::remove_var("ORCHEVIA_GH_BIN");
    }
}
