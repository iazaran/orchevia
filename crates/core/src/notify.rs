//! Local notifications (Milestone 5).
//!
//! Two layers: a persisted in-app Notification Center (always available) and
//! best-effort OS desktop dispatch (`notify-send` on Linux, `osascript` on
//! macOS, silent no-op when absent). Users configure *which* events notify;
//! routine successes never spam.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: i64,
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    #[serde(default)]
    pub read: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPrefs {
    #[serde(default = "yes")]
    pub on_approval: bool,
    #[serde(default = "yes")]
    pub on_failure: bool,
    #[serde(default = "yes")]
    pub on_actionable_findings: bool,
    #[serde(default)]
    pub on_scheduled_success: bool,
    #[serde(default = "yes")]
    pub on_feedback_needs_action: bool,
}

fn yes() -> bool {
    true
}

impl Default for NotificationPrefs {
    fn default() -> Self {
        Self {
            on_approval: true,
            on_failure: true,
            on_actionable_findings: true,
            on_scheduled_success: false,
            on_feedback_needs_action: true,
        }
    }
}

/// Events the engine/scheduler can raise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotifyEvent {
    ApprovalNeeded {
        run_id: String,
        workflow: String,
    },
    WorkflowFailed {
        run_id: String,
        workflow: String,
        scheduled: bool,
    },
    WorkflowSucceeded {
        run_id: String,
        workflow: String,
        scheduled: bool,
    },
    ActionableFindings {
        run_id: String,
        count: usize,
    },
    FeedbackNeedsAction {
        watcher: String,
        detail: String,
    },
}

/// Decide whether an event notifies under the user's prefs. Pure and tested.
pub fn should_notify(prefs: &NotificationPrefs, event: &NotifyEvent) -> bool {
    match event {
        NotifyEvent::ApprovalNeeded { .. } => prefs.on_approval,
        NotifyEvent::WorkflowFailed { scheduled, .. } => {
            prefs.on_failure || (*scheduled && prefs.on_scheduled_success)
        }
        NotifyEvent::WorkflowSucceeded { scheduled, .. } => {
            *scheduled && prefs.on_scheduled_success
        }
        NotifyEvent::ActionableFindings { .. } => prefs.on_actionable_findings,
        NotifyEvent::FeedbackNeedsAction { .. } => prefs.on_feedback_needs_action,
    }
}

pub fn render_event(event: &NotifyEvent) -> (String, String, Option<String>) {
    match event {
        NotifyEvent::ApprovalNeeded { run_id, workflow } => (
            "Approval needed".to_string(),
            format!("Workflow '{workflow}' waits for approval."),
            Some(run_id.clone()),
        ),
        NotifyEvent::WorkflowFailed {
            run_id, workflow, ..
        } => (
            "Workflow failed".to_string(),
            format!("Workflow '{workflow}' failed."),
            Some(run_id.clone()),
        ),
        NotifyEvent::WorkflowSucceeded {
            run_id, workflow, ..
        } => (
            "Workflow finished".to_string(),
            format!("Workflow '{workflow}' succeeded."),
            Some(run_id.clone()),
        ),
        NotifyEvent::ActionableFindings { run_id, count } => (
            "Actionable findings".to_string(),
            format!("{count} P0/P1 finding(s) need attention."),
            Some(run_id.clone()),
        ),
        NotifyEvent::FeedbackNeedsAction { watcher, detail } => (
            "Review feedback".to_string(),
            format!("Watcher '{watcher}': {detail}"),
            None,
        ),
    }
}

/// Best-effort OS dispatch. Never fails the caller: returns false when no
/// supported notifier exists. No new dependencies: `notify-send` (Linux) or
/// `osascript` (macOS) with argv, short timeout.
pub fn dispatch_os(title: &str, body: &str) -> bool {
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("notify-send")
            .arg("--app-name=Orchevia")
            .arg(title)
            .arg(body)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display notification {} with title {}",
            applescript_string(body),
            applescript_string(title)
        );
        std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (title, body);
        false
    }
}

#[cfg(target_os = "macos")]
fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Check prefs, persist to the Notification Center, and best-effort dispatch
/// to the OS (only when the user enabled system notifications in settings).
/// Never fails the caller; never used in unit tests with OS dispatch on.
pub fn emit_event(db: &crate::db::SqliteDb, event: &NotifyEvent) {
    let prefs = db.get_notification_prefs().unwrap_or_default();
    if !should_notify(&prefs, event) {
        return;
    }
    let (title, body, run_id) = render_event(event);
    let _ = db.push_notification(&kind_label(event), &title, &body, run_id.as_deref());
    let os_enabled = db
        .get_setting("notifications.os")
        .ok()
        .flatten()
        .map(|v| v == "1")
        .unwrap_or(false);
    if os_enabled {
        dispatch_os(&title, &body);
    }
}

fn kind_label(event: &NotifyEvent) -> String {
    match event {
        NotifyEvent::ApprovalNeeded { .. } => "approval".to_string(),
        NotifyEvent::WorkflowFailed { .. } => "failure".to_string(),
        NotifyEvent::WorkflowSucceeded { .. } => "success".to_string(),
        NotifyEvent::ActionableFindings { .. } => "findings".to_string(),
        NotifyEvent::FeedbackNeedsAction { .. } => "feedback".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routine_success_does_not_notify_by_default() {
        let prefs = NotificationPrefs::default();
        assert!(!should_notify(
            &prefs,
            &NotifyEvent::WorkflowSucceeded {
                run_id: "r".into(),
                workflow: "w".into(),
                scheduled: false,
            }
        ));
    }

    #[test]
    fn scheduled_success_opt_in() {
        let mut prefs = NotificationPrefs::default();
        assert!(!should_notify(
            &prefs,
            &NotifyEvent::WorkflowSucceeded {
                run_id: "r".into(),
                workflow: "w".into(),
                scheduled: true,
            }
        ));
        prefs.on_scheduled_success = true;
        assert!(should_notify(
            &prefs,
            &NotifyEvent::WorkflowSucceeded {
                run_id: "r".into(),
                workflow: "w".into(),
                scheduled: true,
            }
        ));
    }

    #[test]
    fn approval_failure_findings_notify() {
        let prefs = NotificationPrefs::default();
        assert!(should_notify(
            &prefs,
            &NotifyEvent::ApprovalNeeded {
                run_id: "r".into(),
                workflow: "w".into()
            }
        ));
        assert!(should_notify(
            &prefs,
            &NotifyEvent::WorkflowFailed {
                run_id: "r".into(),
                workflow: "w".into(),
                scheduled: false
            }
        ));
        assert!(should_notify(
            &prefs,
            &NotifyEvent::ActionableFindings {
                run_id: "r".into(),
                count: 2
            }
        ));
    }

    #[test]
    fn prefs_can_silence_everything() {
        let prefs = NotificationPrefs {
            on_approval: false,
            on_failure: false,
            on_actionable_findings: false,
            on_scheduled_success: false,
            on_feedback_needs_action: false,
        };
        assert!(!should_notify(
            &prefs,
            &NotifyEvent::FeedbackNeedsAction {
                watcher: "w".into(),
                detail: "d".into()
            }
        ));
    }
}
