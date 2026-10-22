//! Update notices. The UI asks GitHub for the latest release (opt-out in
//! Environment → Updates); this module validates the version it reports and
//! records one notice per new version: an Inbox entry, plus a desktop
//! notification when system notifications are on. Nothing is downloaded or
//! installed automatically.

use crate::db::SqliteDb;

/// Last version announced, so each release is announced once.
pub const NOTIFIED_VERSION_SETTING: &str = "updates.notifiedVersion";

/// The running app's version (the core crate is versioned with the app).
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// `major.minor.patch` with an optional `v` prefix. Pre-releases and other
/// shapes are not offered as updates. Mirrors `parseVersion` in
/// `src/lib/updates.ts`.
pub fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let text = text.trim();
    let text = text.strip_prefix('v').unwrap_or(text);
    let mut parts = text.split('.');
    let mut next = || -> Option<u64> {
        let part = parts.next()?;
        if part.is_empty() || part.len() > 9 || !part.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let version = (next()?, next()?, next()?);
    parts.next().is_none().then_some(version)
}

/// Whether `candidate` is a release newer than `current`.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(candidate), Some(current)) => candidate > current,
        _ => false,
    }
}

/// Record that `version` is available, once per version. Returns whether a
/// notice was created; versions that are not newer than the running app are
/// ignored.
pub fn record_update_notice(db: &SqliteDb, version: &str) -> Result<bool, String> {
    let current = current_version();
    let Some((major, minor, patch)) = parse_version(version) else {
        return Err(format!("'{version}' is not a release version."));
    };
    if !is_newer(version, current) {
        return Ok(false);
    }
    let normalized = format!("{major}.{minor}.{patch}");
    let notified = db
        .get_setting(NOTIFIED_VERSION_SETTING)
        .map_err(|e| e.to_string())?;
    if notified.as_deref() == Some(normalized.as_str()) {
        return Ok(false);
    }
    let title = format!("Orchevia {normalized} is available");
    let body = format!(
        "You have {current}. Open Environment → Updates to download it; your workflows and history are kept."
    );
    db.push_notification("update", &title, &body, None)
        .map_err(|e| e.to_string())?;
    let os_enabled = db
        .get_setting("notifications.os")
        .ok()
        .flatten()
        .is_some_and(|v| v == "1");
    if os_enabled {
        crate::notify::dispatch_os(&title, &body);
    }
    db.set_setting(NOTIFIED_VERSION_SETTING, &normalized)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_release_versions_only() {
        assert_eq!(parse_version("0.1.20"), Some((0, 1, 20)));
        assert_eq!(parse_version("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version(" v1.2.3 "), Some((1, 2, 3)));
        assert_eq!(parse_version("1.2"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
        assert_eq!(parse_version("1.2.3-beta.1"), None);
        assert_eq!(parse_version("1..3"), None);
        assert_eq!(parse_version("latest"), None);
    }

    #[test]
    fn compares_numerically() {
        assert!(is_newer("0.1.20", "0.1.19"));
        assert!(is_newer("v0.2.0", "0.1.99"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("0.1.19", "0.1.19"));
        assert!(!is_newer("0.1.9", "0.1.19"));
        assert!(!is_newer("garbage", "0.1.19"));
    }

    #[test]
    fn records_each_new_version_once() {
        let db = SqliteDb::open_in_memory().expect("db");
        let (major, minor, patch) = parse_version(current_version()).expect("version");
        let next = format!("{major}.{minor}.{}", patch + 1);
        assert!(record_update_notice(&db, &next).expect("first"));
        assert!(!record_update_notice(&db, &format!("v{next}")).expect("repeat"));
        assert!(!record_update_notice(&db, current_version()).expect("current"));
        assert!(record_update_notice(&db, "not a version").is_err());
        let notes = db.list_notifications(10, false).expect("list");
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].kind, "update");
        assert!(notes[0].title.contains(&next));
        let later = format!("{major}.{}.0", minor + 1);
        assert!(record_update_notice(&db, &later).expect("later"));
    }
}
