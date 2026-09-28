//! Durable local scheduling (Milestone 5).
//!
//! Schedules persist in SQLite and are evaluated against an injected `now`
//! (fake clocks in tests — never sleeps). Supported kinds: one-time,
//! fixed interval, daily, weekly, and 5-field cron. Timezones are explicit:
//! `utc`, `local` (system zone), or a fixed `±HH:MM` offset. IANA names are
//! intentionally unsupported (no tz database dependency); the UI explains
//! this and stores the concrete offset instead.
//!
//! Missed-run semantics (documented, no catch-up storms): a schedule fires at
//! most once per evaluation; when the app was offline past a fire time, the
//! policy decides — `Skip` jumps to the next future slot, `RunOnce` runs a
//! single catch-up then advances.

use chrono::{DateTime, Datelike, Offset, TimeZone, Timelike, Utc, Weekday};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    pub id: String,
    pub name: String,
    pub workflow_id: String,
    pub kind: ScheduleKind,
    /// `utc`, `local`, or `±HH:MM`.
    #[serde(default = "default_tz")]
    pub timezone: String,
    #[serde(default = "enabled_default")]
    pub enabled: bool,
    /// User opt-in for write-capable workflows (see trust.rs).
    #[serde(default)]
    pub trusted: bool,
    #[serde(default)]
    pub missed_policy: MissedPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_status: Option<String>,
}

fn default_tz() -> String {
    "local".to_string()
}

fn enabled_default() -> bool {
    // New schedules start DISABLED until reviewed (imported or created).
    false
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MissedPolicy {
    #[default]
    Skip,
    RunOnce,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ScheduleKind {
    OneTime {
        at: DateTime<Utc>,
    },
    Interval {
        #[serde(rename = "everySecs", alias = "every_secs")]
        every_secs: u64,
    },
    Daily {
        hour: u32,
        minute: u32,
    },
    Weekly {
        weekday: WeekdayDto,
        hour: u32,
        minute: u32,
    },
    Cron {
        expr: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WeekdayDto {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

impl WeekdayDto {
    fn weekday(self) -> Weekday {
        match self {
            WeekdayDto::Mon => Weekday::Mon,
            WeekdayDto::Tue => Weekday::Tue,
            WeekdayDto::Wed => Weekday::Wed,
            WeekdayDto::Thu => Weekday::Thu,
            WeekdayDto::Fri => Weekday::Fri,
            WeekdayDto::Sat => Weekday::Sat,
            WeekdayDto::Sun => Weekday::Sun,
        }
    }
}

impl Schedule {
    pub fn validate(&self) -> Vec<String> {
        let mut errors = Vec::new();
        if self.id.trim().is_empty() {
            errors.push("Schedule id must not be empty.".to_string());
        }
        if self.name.trim().is_empty() {
            errors.push("Schedule name must not be empty.".to_string());
        }
        if self.workflow_id.trim().is_empty() {
            errors.push("Schedule needs a workflow.".to_string());
        }
        if parse_tz_offset(&self.timezone, Utc::now()).is_none() {
            errors.push("Timezone must be 'utc', 'local', or '±HH:MM'.".to_string());
        }
        match &self.kind {
            ScheduleKind::OneTime { .. } => {}
            ScheduleKind::Interval { every_secs } => {
                if !(60..=86400 * 30).contains(every_secs) {
                    errors.push("Interval must be 60 s – 30 days.".to_string());
                }
            }
            ScheduleKind::Daily { hour, minute } => {
                if *hour > 23 || *minute > 59 {
                    errors.push("Daily time must be a valid HH:MM.".to_string());
                }
            }
            ScheduleKind::Weekly { hour, minute, .. } => {
                if *hour > 23 || *minute > 59 {
                    errors.push("Weekly time must be a valid HH:MM.".to_string());
                }
            }
            ScheduleKind::Cron { expr } => {
                if let Err(e) = parse_cron(expr) {
                    errors.push(format!("Invalid cron: {e}"));
                }
            }
        }
        errors
    }
}

/// Resolve a timezone name to a fixed UTC offset in seconds.
/// `local` uses the system zone at `now`; IANA names are rejected.
pub fn parse_tz_offset(name: &str, now: DateTime<Utc>) -> Option<i32> {
    let lower = name.trim().to_ascii_lowercase();
    if lower == "utc" {
        return Some(0);
    }
    if lower == "local" {
        return Some(now.with_timezone(&chrono::Local).offset().local_minus_utc());
    }
    let (negative, rest) = match lower.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, lower.strip_prefix('+').unwrap_or(&lower)),
    };
    let (hours, minutes) = rest.split_once(':')?;
    let hours: i32 = hours.parse().ok()?;
    let minutes: i32 = minutes.parse().ok()?;
    if !(0..=23).contains(&hours) || !(0..=59).contains(&minutes) {
        return None;
    }
    let sign = if negative { -1 } else { 1 };
    Some(sign * (hours * 3600 + minutes * 60))
}

/// Next fire time strictly after `now`. Pure function of (schedule, now).
pub fn next_run(kind: &ScheduleKind, timezone: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let offset = parse_tz_offset(timezone, now)?;
    match kind {
        ScheduleKind::OneTime { at } => (*at > now).then_some(*at),
        ScheduleKind::Interval { every_secs } => {
            if *every_secs == 0 {
                return None;
            }
            let secs = (*every_secs).max(60);
            let epoch = now.timestamp().div_euclid(secs as i64) * secs as i64 + secs as i64;
            DateTime::from_timestamp(epoch, 0)
        }
        ScheduleKind::Daily { hour, minute } => next_daily(*hour, *minute, offset, now),
        ScheduleKind::Weekly {
            weekday,
            hour,
            minute,
        } => next_weekly(weekday.weekday(), *hour, *minute, offset, now),
        ScheduleKind::Cron { expr } => {
            let cron = parse_cron(expr).ok()?;
            next_cron(&cron, offset, now)
        }
    }
}

fn in_zone(offset_secs: i32, utc: DateTime<Utc>) -> chrono::DateTime<chrono::FixedOffset> {
    let offset = chrono::FixedOffset::east_opt(offset_secs).unwrap_or_else(|| Utc.fix());
    utc.with_timezone(&offset)
}

fn next_daily(
    hour: u32,
    minute: u32,
    offset_secs: i32,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let offset = chrono::FixedOffset::east_opt(offset_secs)?;
    let zoned = in_zone(offset_secs, now);
    let today = zoned.date_naive();
    let candidate = offset
        .from_local_datetime(&today.and_hms_opt(hour, minute, 0)?)
        .single()?;
    if candidate > zoned {
        return Some(candidate.with_timezone(&Utc));
    }
    let tomorrow = today.succ_opt()?;
    tomorrow
        .and_hms_opt(hour, minute, 0)
        .and_then(|naive| offset.from_local_datetime(&naive).single())
        .map(|zoned| zoned.with_timezone(&Utc))
}

fn next_weekly(
    weekday: Weekday,
    hour: u32,
    minute: u32,
    offset_secs: i32,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let offset = chrono::FixedOffset::east_opt(offset_secs)?;
    let zoned = in_zone(offset_secs, now);
    for delta_days in 0..8 {
        let date = zoned.date_naive() + chrono::Days::new(delta_days);
        if date.weekday() != weekday {
            continue;
        }
        if let Some(naive) = date.and_hms_opt(hour, minute, 0) {
            if let Some(candidate) = offset.from_local_datetime(&naive).single() {
                if candidate > zoned {
                    return Some(candidate.with_timezone(&Utc));
                }
            }
        }
    }
    None
}

// -- Minimal 5-field cron --------------------------------------------------------

#[derive(Debug, Clone)]
struct CronSpec {
    minutes: Vec<u32>,
    hours: Vec<u32>,
    days: Vec<u32>,
    months: Vec<u32>,
    weekdays: Vec<u32>, // 0 = Sunday
}

fn parse_cron_field(text: &str, min: u32, max: u32) -> Result<Vec<u32>, String> {
    let mut values = Vec::new();
    for part in text.split(',') {
        let part = part.trim();
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => (
                range,
                Some(
                    step.parse::<u32>()
                        .map_err(|_| format!("Bad step '{step}' in '{text}'."))?,
                ),
            ),
            None => (part, None),
        };
        if step == Some(0) {
            return Err(format!("Step must be >= 1 in '{text}'."));
        }
        let (low, high) = if range == "*" || range.is_empty() {
            (min, max)
        } else if let Some((a, b)) = range.split_once('-') {
            let a: u32 = a
                .parse()
                .map_err(|_| format!("Bad value '{a}' in '{text}'."))?;
            let b: u32 = b
                .parse()
                .map_err(|_| format!("Bad value '{b}' in '{text}'."))?;
            if a > b {
                return Err(format!("Reversed range '{range}' in '{text}'."));
            }
            (a, b)
        } else {
            let v: u32 = range
                .parse()
                .map_err(|_| format!("Bad value '{range}' in '{text}'."))?;
            (v, v)
        };
        if low < min || high > max {
            return Err(format!("Value out of range {min}-{max} in '{text}'."));
        }
        let step = step.unwrap_or(1);
        let mut v = low;
        while v <= high {
            values.push(v);
            v += step;
        }
    }
    values.sort_unstable();
    values.dedup();
    Ok(values)
}

fn parse_cron(expr: &str) -> Result<CronSpec, String> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return Err("Cron needs 5 fields: minute hour day month weekday.".to_string());
    }
    Ok(CronSpec {
        minutes: parse_cron_field(fields[0], 0, 59)?,
        hours: parse_cron_field(fields[1], 0, 23)?,
        days: parse_cron_field(fields[2], 1, 31)?,
        months: parse_cron_field(fields[3], 1, 12)?,
        weekdays: parse_cron_field(fields[4], 0, 7).map(|mut days| {
            // Normalize Sunday 7 -> 0.
            days.iter_mut().for_each(|d| {
                if *d == 7 {
                    *d = 0;
                }
            });
            days.sort_unstable();
            days.dedup();
            days
        })?,
    })
}

fn next_cron(spec: &CronSpec, offset_secs: i32, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    // Minute-by-minute scan, capped at ~366 days (bounded, documented).
    let mut cursor = now + chrono::Duration::minutes(1);
    cursor = cursor.with_second(0).and_then(|d| d.with_nanosecond(0))?;
    for _ in 0..(366 * 24 * 60) {
        let zoned = in_zone(offset_secs, cursor);
        let minute = zoned.minute();
        let hour = zoned.hour();
        let day = zoned.day();
        let month = zoned.month();
        let weekday = zoned.weekday().num_days_from_sunday();
        if spec.minutes.contains(&minute)
            && spec.hours.contains(&hour)
            && spec.days.contains(&day)
            && spec.months.contains(&month)
            && spec.weekdays.contains(&weekday)
        {
            return Some(cursor);
        }
        cursor += chrono::Duration::minutes(1);
    }
    None
}

// -- Evaluation -----------------------------------------------------------------

/// What the scheduler should do about a schedule at `now`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScheduleDecision {
    /// Not due.
    Wait,
    /// Due: run exactly once, then advance past `now`.
    Fire,
    /// One-time elapsed long ago / misconfigured: retire without running.
    Retire,
}

/// Decide + compute the stored `next_run_at` afterwards. Pure and total.
pub fn evaluate(
    schedule: &Schedule,
    now: DateTime<Utc>,
) -> (ScheduleDecision, Option<DateTime<Utc>>) {
    if !schedule.enabled {
        return (ScheduleDecision::Wait, schedule.next_run_at);
    }
    match &schedule.kind {
        ScheduleKind::OneTime { at } => {
            if *at > now {
                return (ScheduleDecision::Wait, Some(*at));
            }
            // One-time within a grace window still fires once (late boot);
            // ancient ones retire instead of surprising the user.
            if now.signed_duration_since(*at) <= chrono::Duration::minutes(15) {
                return (ScheduleDecision::Fire, None);
            }
            match schedule.missed_policy {
                MissedPolicy::RunOnce => (ScheduleDecision::Fire, None),
                MissedPolicy::Skip => (ScheduleDecision::Retire, None),
            }
        }
        _ => {
            let due_at = schedule
                .next_run_at
                .or_else(|| next_run(&schedule.kind, &schedule.timezone, now));
            match due_at {
                None => (ScheduleDecision::Wait, None),
                Some(slot) if slot > now => (ScheduleDecision::Wait, Some(slot)),
                Some(slot) => {
                    // Missed window: policy decides, then advance past now.
                    let advance = next_run(&schedule.kind, &schedule.timezone, now);
                    match schedule.missed_policy {
                        MissedPolicy::Skip => {
                            // Skip the stale slot silently (no storm): fire
                            // only when the slot is fresh (within one poll).
                            if now.signed_duration_since(slot) <= chrono::Duration::minutes(5) {
                                (ScheduleDecision::Fire, advance)
                            } else {
                                (ScheduleDecision::Wait, advance)
                            }
                        }
                        MissedPolicy::RunOnce => (ScheduleDecision::Fire, advance),
                    }
                }
            }
        }
    }
}

/// Advance `next_run_at` after any evaluation (idempotent bookkeeping).
pub fn refresh_next(schedule: &mut Schedule, now: DateTime<Utc>) {
    let (_, next) = evaluate(schedule, now);
    schedule.next_run_at = next;
}

/// Upcoming fire times for display (next N slots, best effort).
pub fn upcoming(
    kind: &ScheduleKind,
    timezone: &str,
    now: DateTime<Utc>,
    count: usize,
) -> Vec<DateTime<Utc>> {
    let mut out = Vec::new();
    let mut cursor = now;
    for _ in 0..count.min(8) {
        match next_run(kind, timezone, cursor) {
            Some(slot) => {
                out.push(slot);
                cursor = slot + chrono::Duration::seconds(1);
            }
            None => break,
        }
    }
    out
}

/// Small display map for schedule rows (id + computed next run).
pub fn describe_next(schedule: &Schedule, now: DateTime<Utc>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    map.insert("id".to_string(), schedule.id.clone());
    if let Some(next) = schedule
        .next_run_at
        .or_else(|| next_run(&schedule.kind, &schedule.timezone, now))
    {
        map.insert("nextRunAt".to_string(), next.to_rfc3339());
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_accepts_frontend_seconds_field() {
        let kind: ScheduleKind = serde_json::from_value(serde_json::json!({
            "kind": "interval", "everySecs": 3600
        }))
        .expect("frontend interval parses");
        assert_eq!(kind, ScheduleKind::Interval { every_secs: 3600 });
    }

    #[test]
    fn interval_legacy_seconds_field_serializes_as_camel_case() {
        let kind: ScheduleKind = serde_json::from_value(serde_json::json!({
            "kind": "interval", "every_secs": 3600
        }))
        .expect("saved interval remains compatible");
        assert_eq!(
            serde_json::to_value(kind).expect("serialize interval"),
            serde_json::json!({ "kind": "interval", "everySecs": 3600 })
        );
    }

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        chrono::NaiveDate::from_ymd_opt(y, mo, d)
            .expect("date")
            .and_hms_opt(h, mi, 0)
            .expect("time")
            .and_utc()
    }

    #[test]
    fn interval_aligns_to_grid() {
        let now = utc(2026, 3, 4, 10, 7);
        let next =
            next_run(&ScheduleKind::Interval { every_secs: 3600 }, "utc", now).expect("next");
        assert_eq!(next, utc(2026, 3, 4, 11, 0));
    }

    #[test]
    fn daily_today_or_tomorrow() {
        let now = utc(2026, 3, 4, 10, 0);
        let next = next_run(
            &ScheduleKind::Daily {
                hour: 9,
                minute: 30,
            },
            "utc",
            now,
        )
        .expect("next");
        assert_eq!(next, utc(2026, 3, 5, 9, 30));
        let next = next_run(
            &ScheduleKind::Daily {
                hour: 11,
                minute: 0,
            },
            "utc",
            now,
        )
        .expect("next");
        assert_eq!(next, utc(2026, 3, 4, 11, 0));
    }

    #[test]
    fn daily_respects_offset() {
        // 10:00 UTC with +02:00 is 12:00 local; 11:00 local already passed.
        let now = utc(2026, 3, 4, 10, 0);
        let next = next_run(
            &ScheduleKind::Daily {
                hour: 11,
                minute: 0,
            },
            "+02:00",
            now,
        )
        .expect("next");
        assert_eq!(next, utc(2026, 3, 5, 9, 0));
    }

    #[test]
    fn daily_rejects_out_of_range_offset() {
        let now = utc(2026, 3, 4, 10, 0);
        assert_eq!(next_daily(11, 0, 86_400, now), None);
        assert_eq!(next_daily(11, 0, -86_400, now), None);
    }

    #[test]
    fn weekly_rejects_out_of_range_offset() {
        let now = utc(2026, 3, 4, 10, 0);
        assert_eq!(next_weekly(Weekday::Fri, 11, 0, 86_400, now), None);
        assert_eq!(next_weekly(Weekday::Fri, 11, 0, -86_400, now), None);
    }

    #[test]
    fn weekly_finds_next_weekday() {
        // 2026-03-04 is a Wednesday.
        assert_eq!(utc(2026, 3, 4, 0, 0).weekday(), Weekday::Wed);
        let now = utc(2026, 3, 4, 10, 0);
        let next = next_run(
            &ScheduleKind::Weekly {
                weekday: WeekdayDto::Fri,
                hour: 9,
                minute: 0,
            },
            "utc",
            now,
        )
        .expect("next");
        assert_eq!(next, utc(2026, 3, 6, 9, 0));
    }

    #[test]
    fn cron_every_15_minutes() {
        let now = utc(2026, 3, 4, 10, 7);
        let next = next_run(
            &ScheduleKind::Cron {
                expr: "*/15 * * * *".into(),
            },
            "utc",
            now,
        )
        .expect("next");
        assert_eq!(next, utc(2026, 3, 4, 10, 15));
    }

    #[test]
    fn cron_weekday_morning() {
        let now = utc(2026, 3, 4, 10, 7); // Wednesday
        let next = next_run(
            &ScheduleKind::Cron {
                expr: "0 9 * * 1".into(),
            },
            "utc",
            now,
        )
        .expect("next");
        // Next Monday 09:00.
        assert_eq!(next, utc(2026, 3, 9, 9, 0));
    }

    #[test]
    fn cron_validation_rejects_garbage() {
        assert!(parse_cron("*/15 * * *").is_err());
        assert!(parse_cron("99 * * * *").is_err());
        assert!(parse_cron("*/0 * * * *").is_err());
        assert!(parse_cron("0 9 * * mon").is_err());
    }

    #[test]
    fn one_time_fires_once_then_retires() {
        let at = utc(2026, 3, 4, 10, 0);
        let schedule = Schedule {
            id: "s".into(),
            name: "S".into(),
            workflow_id: "w".into(),
            kind: ScheduleKind::OneTime { at },
            timezone: "utc".into(),
            enabled: true,
            trusted: true,
            missed_policy: MissedPolicy::Skip,
            last_run_at: None,
            next_run_at: Some(at),
            last_status: None,
        };
        assert_eq!(
            evaluate(&schedule, utc(2026, 3, 4, 9, 0)).0,
            ScheduleDecision::Wait
        );
        // Within grace: fires.
        assert_eq!(
            evaluate(&schedule, utc(2026, 3, 4, 10, 5)).0,
            ScheduleDecision::Fire
        );
        // Ancient with Skip: retires, never storms.
        assert_eq!(
            evaluate(&schedule, utc(2026, 3, 5, 10, 0)).0,
            ScheduleDecision::Retire
        );
    }

    #[test]
    fn stale_interval_skips_without_storm() {
        let schedule = Schedule {
            id: "s".into(),
            name: "S".into(),
            workflow_id: "w".into(),
            kind: ScheduleKind::Interval { every_secs: 3600 },
            timezone: "utc".into(),
            enabled: true,
            trusted: true,
            missed_policy: MissedPolicy::Skip,
            last_run_at: None,
            next_run_at: Some(utc(2026, 3, 1, 0, 0)), // days stale
            last_status: None,
        };
        let (decision, next) = evaluate(&schedule, utc(2026, 3, 4, 10, 7));
        assert_eq!(decision, ScheduleDecision::Wait);
        assert_eq!(next, Some(utc(2026, 3, 4, 11, 0)));
    }

    #[test]
    fn disabled_never_fires() {
        let schedule = Schedule {
            id: "s".into(),
            name: "S".into(),
            workflow_id: "w".into(),
            kind: ScheduleKind::Interval { every_secs: 3600 },
            timezone: "utc".into(),
            enabled: false,
            trusted: false,
            missed_policy: MissedPolicy::Skip,
            last_run_at: None,
            next_run_at: Some(utc(2026, 3, 4, 9, 0)),
            last_status: None,
        };
        assert_eq!(
            evaluate(&schedule, utc(2026, 3, 4, 10, 0)).0,
            ScheduleDecision::Wait
        );
    }

    #[test]
    fn validation_bounds_intervals_and_cron() {
        let mut schedule = Schedule {
            id: "s".into(),
            name: "S".into(),
            workflow_id: "w".into(),
            kind: ScheduleKind::Interval { every_secs: 10 },
            timezone: "utc".into(),
            enabled: true,
            trusted: false,
            missed_policy: MissedPolicy::Skip,
            last_run_at: None,
            next_run_at: None,
            last_status: None,
        };
        assert!(!schedule.validate().is_empty());
        schedule.kind = ScheduleKind::Interval { every_secs: 300 };
        assert!(schedule.validate().is_empty());
        schedule.timezone = "Mars/Olympus".into();
        assert!(!schedule.validate().is_empty());
    }
}

// -- Watchers ------------------------------------------------------------------

/// A GitHub watcher: polls for review requests, PR updates, or review
/// feedback and runs a workflow for new revisions only. Stored disabled
/// until reviewed; triggers never embed credentials.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Watcher {
    pub id: String,
    pub name: String,
    pub workflow_id: String,
    pub kind: WatcherKind,
    /// Local repository directory the watcher inspects via `gh`.
    pub repo_dir: String,
    /// Pinned PR for PrUpdated/Feedback kinds; None = all requested reviews.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_number: Option<u64>,
    #[serde(default)]
    pub enabled: bool,
    /// Poll interval, conservative floor of 300 s.
    #[serde(default = "default_check_interval")]
    pub check_interval_secs: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_head_sha: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_result: Option<String>,
}

fn default_check_interval() -> u64 {
    900
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WatcherKind {
    ReviewRequested,
    PrUpdated,
    Feedback,
}

impl Watcher {
    pub fn validate(&self) -> Vec<String> {
        let mut errors = Vec::new();
        if self.id.trim().is_empty() {
            errors.push("Watcher id must not be empty.".to_string());
        }
        if self.name.trim().is_empty() {
            errors.push("Watcher name must not be empty.".to_string());
        }
        if self.workflow_id.trim().is_empty() {
            errors.push("Watcher needs a workflow.".to_string());
        }
        if self.repo_dir.trim().is_empty() {
            errors.push("Watcher needs a repository directory.".to_string());
        }
        if self.check_interval_secs < 300 {
            errors
                .push("Watcher interval must be at least 300 s (be kind to the API).".to_string());
        }
        if matches!(self.kind, WatcherKind::PrUpdated | WatcherKind::Feedback)
            && self.pr_number.is_none()
        {
            errors.push("PR-scoped watchers need a PR number.".to_string());
        }
        errors
    }

    /// Whether the watcher is due for a poll at `now`.
    pub fn poll_due(&self, now: DateTime<Utc>) -> bool {
        if !self.enabled {
            return false;
        }
        match self.last_checked_at {
            None => true,
            Some(last) => {
                now.signed_duration_since(last)
                    >= chrono::Duration::seconds(self.check_interval_secs.max(300) as i64)
            }
        }
    }
}
