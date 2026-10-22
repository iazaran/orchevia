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

use chrono::{DateTime, Datelike, TimeZone, Timelike, Utc, Weekday};
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
    /// A due slot held back by the run limit or an active run. It still runs
    /// when capacity frees, however late, because Orchevia was running when
    /// it came due; the missed-run policy is only for closed or asleep time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deferred_slot: Option<DateTime<Utc>>,
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

    /// Timing is the kind and timezone: name, workflow, trust and policy edits
    /// keep the stored slot.
    pub fn same_timing(&self, other: &Self) -> bool {
        self.kind == other.kind && self.timezone == other.timezone
    }

    /// Normalize a schedule submitted by the editor or a card toggle. Run
    /// bookkeeping comes from the stored copy (the form may be stale). The
    /// next slot is kept only while the schedule stays enabled with the same
    /// timing, so a pending (deferred) slot survives a rename; changed timing
    /// or re-enabling recomputes it from `now`, and a paused schedule has none.
    pub fn prepare_save(&mut self, previous: Option<&Self>, now: DateTime<Utc>) {
        if let Some(previous) = previous {
            self.last_run_at = previous.last_run_at;
            self.last_status = previous.last_status.clone();
        }
        let kept = previous
            .filter(|previous| self.enabled && previous.enabled && self.same_timing(previous));
        self.next_run_at = kept.and_then(|previous| previous.next_run_at);
        self.deferred_slot = kept.and_then(|previous| previous.deferred_slot);
        if !self.enabled {
            return;
        }
        if self.next_run_at.is_none() {
            let (_, next) = evaluate(self, now);
            self.next_run_at = next;
        }
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
/// `local` follows the system zone's daylight-saving rules for each slot;
/// fixed offsets never shift. Interval slots sit on a grid aligned to the
/// zone's midnight (a 15-minute interval fires on the quarter hours).
pub fn next_run(kind: &ScheduleKind, timezone: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let offset = parse_tz_offset(timezone, now)?;
    let local = timezone.trim().eq_ignore_ascii_case("local");
    let fixed = chrono::FixedOffset::east_opt(offset)?;
    match kind {
        ScheduleKind::OneTime { at } => (*at > now).then_some(*at),
        ScheduleKind::Interval { every_secs } => {
            if *every_secs == 0 {
                return None;
            }
            let secs = (*every_secs).max(60) as i64;
            let shifted = now.timestamp() + i64::from(offset);
            let slot = shifted.div_euclid(secs) * secs + secs - i64::from(offset);
            DateTime::from_timestamp(slot, 0)
        }
        ScheduleKind::Daily { hour, minute } if local => {
            next_daily_in(&chrono::Local, *hour, *minute, now)
        }
        ScheduleKind::Daily { hour, minute } => next_daily_in(&fixed, *hour, *minute, now),
        ScheduleKind::Weekly {
            weekday,
            hour,
            minute,
        } if local => next_weekly_in(&chrono::Local, weekday.weekday(), *hour, *minute, now),
        ScheduleKind::Weekly {
            weekday,
            hour,
            minute,
        } => next_weekly_in(&fixed, weekday.weekday(), *hour, *minute, now),
        ScheduleKind::Cron { expr } => {
            let cron = parse_cron(expr).ok()?;
            if local {
                next_cron_in(&cron, &chrono::Local, now)
            } else {
                next_cron_in(&cron, &fixed, now)
            }
        }
    }
}

/// The first instant of a wall-clock time in `tz` that is after `after`.
/// Across a fall-back hour it picks the occurrence still ahead; a time
/// skipped by a spring-forward jump has none.
fn resolve_after<Tz: TimeZone>(
    tz: &Tz,
    naive: chrono::NaiveDateTime,
    after: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let instant = match tz.from_local_datetime(&naive) {
        chrono::LocalResult::Single(at) => at.with_timezone(&Utc),
        chrono::LocalResult::Ambiguous(first, second) => {
            let first = first.with_timezone(&Utc);
            if first > after {
                first
            } else {
                second.with_timezone(&Utc)
            }
        }
        chrono::LocalResult::None => return None,
    };
    (instant > after).then_some(instant)
}

/// A daily or weekly time on `date`; a time inside a spring-forward gap runs
/// an hour later instead of being skipped.
fn wall_time_after<Tz: TimeZone>(
    tz: &Tz,
    date: chrono::NaiveDate,
    hour: u32,
    minute: u32,
    after: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let naive = date.and_hms_opt(hour, minute, 0)?;
    resolve_after(tz, naive, after).or_else(|| {
        let shifted = naive + chrono::Duration::hours(1);
        match tz.from_local_datetime(&naive) {
            chrono::LocalResult::None => resolve_after(tz, shifted, after),
            _ => None,
        }
    })
}

#[cfg(test)]
fn next_daily(
    hour: u32,
    minute: u32,
    offset_secs: i32,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    next_daily_in(
        &chrono::FixedOffset::east_opt(offset_secs)?,
        hour,
        minute,
        now,
    )
}

fn next_daily_in<Tz: TimeZone>(
    tz: &Tz,
    hour: u32,
    minute: u32,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let today = now.with_timezone(tz).date_naive();
    (0..3).find_map(|delta| {
        let date = today.checked_add_days(chrono::Days::new(delta))?;
        wall_time_after(tz, date, hour, minute, now)
    })
}

#[cfg(test)]
fn next_weekly(
    weekday: Weekday,
    hour: u32,
    minute: u32,
    offset_secs: i32,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    next_weekly_in(
        &chrono::FixedOffset::east_opt(offset_secs)?,
        weekday,
        hour,
        minute,
        now,
    )
}

fn next_weekly_in<Tz: TimeZone>(
    tz: &Tz,
    weekday: Weekday,
    hour: u32,
    minute: u32,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let today = now.with_timezone(tz).date_naive();
    (0..15).find_map(|delta| {
        let date = today.checked_add_days(chrono::Days::new(delta))?;
        if date.weekday() != weekday {
            return None;
        }
        wall_time_after(tz, date, hour, minute, now)
    })
}

// -- Minimal 5-field cron --------------------------------------------------------

#[derive(Debug, Clone)]
struct CronSpec {
    minutes: Vec<u32>,
    hours: Vec<u32>,
    days: Vec<u32>,
    months: Vec<u32>,
    weekdays: Vec<u32>, // 0 = Sunday
    /// Day-of-month / day-of-week fields that start with `*`. As in standard
    /// cron, when both are restricted a date matching either one runs.
    days_any: bool,
    weekdays_any: bool,
}

impl CronSpec {
    fn date_matches(&self, date: chrono::NaiveDate) -> bool {
        if !self.months.contains(&date.month()) {
            return false;
        }
        let day = self.days.contains(&date.day());
        let weekday = self
            .weekdays
            .contains(&date.weekday().num_days_from_sunday());
        match (self.days_any, self.weekdays_any) {
            (false, false) => day || weekday,
            _ => day && weekday,
        }
    }

    /// No date can ever match: only day-of-month is restricted and none of
    /// its days exists in any chosen month (`0 0 31 2 *`). Mirrors
    /// `cronNeverMatches` in `src/lib/scheduler.ts`.
    fn never_matches(&self) -> bool {
        !self.days_any
            && self.weekdays_any
            && self.months.iter().all(|month| {
                let longest = match month {
                    2 => 29,
                    4 | 6 | 9 | 11 => 30,
                    _ => 31,
                };
                self.days.iter().all(|day| *day > longest)
            })
    }
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
    let spec = CronSpec {
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
        days_any: fields[2].starts_with('*'),
        weekdays_any: fields[4].starts_with('*'),
    };
    if spec.never_matches() {
        return Err("Cron never matches: no chosen month has that day.".to_string());
    }
    Ok(spec)
}

/// Walk local wall-clock time, skipping whole days and hours that cannot
/// match, for up to five years (enough for 29 February). Wall times skipped
/// by a spring-forward jump do not run.
fn next_cron_in<Tz: TimeZone>(
    spec: &CronSpec,
    tz: &Tz,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let start = now.with_timezone(tz).naive_local() + chrono::Duration::minutes(1);
    let mut cursor = start.with_second(0)?.with_nanosecond(0)?;
    let limit = start + chrono::Duration::days(5 * 366);
    while cursor < limit {
        let date = cursor.date();
        if !spec.date_matches(date) {
            cursor = date.succ_opt()?.and_hms_opt(0, 0, 0)?;
            continue;
        }
        if !spec.hours.contains(&cursor.hour()) {
            cursor = cursor.with_minute(0)? + chrono::Duration::hours(1);
            continue;
        }
        if spec.minutes.contains(&cursor.minute()) {
            if let Some(at) = resolve_after(tz, cursor, now) {
                return Some(at);
            }
        }
        cursor += chrono::Duration::minutes(1);
    }
    None
}

// -- Evaluation -----------------------------------------------------------------

/// How late a slot may be noticed and still count as on time when the
/// scheduler cannot tell how long it was away: the first check after launch,
/// or the first check after the computer slept.
pub fn default_missed_grace() -> chrono::Duration {
    chrono::Duration::minutes(5)
}

/// What the scheduler should do about a schedule at `now`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScheduleDecision {
    /// Not due.
    Wait,
    /// Due: run exactly once, then advance past `now`.
    Fire,
    /// A slot passed while Orchevia was closed or asleep and the `Skip`
    /// policy drops it: advance past `now` without running.
    SkipMissed,
    /// One-time elapsed long ago / misconfigured: retire without running.
    Retire,
}

/// Decide + compute the stored `next_run_at` afterwards, with the default
/// grace for late slots. Pure and total.
pub fn evaluate(
    schedule: &Schedule,
    now: DateTime<Utc>,
) -> (ScheduleDecision, Option<DateTime<Utc>>) {
    evaluate_with_grace(schedule, now, default_missed_grace())
}

/// [`evaluate`] with an explicit `grace`: how late a slot may be noticed and
/// still count as on time. The scheduler widens it to cover the time since its
/// previous check, so a slot that came due while Orchevia was running is never
/// treated as one missed while it was closed, however long the check interval.
pub fn evaluate_with_grace(
    schedule: &Schedule,
    now: DateTime<Utc>,
    grace: chrono::Duration,
) -> (ScheduleDecision, Option<DateTime<Utc>>) {
    if !schedule.enabled {
        return (ScheduleDecision::Wait, schedule.next_run_at);
    }
    match &schedule.kind {
        ScheduleKind::OneTime { at } => {
            // Complete once it ran at or after its time. A manual run before
            // it, or a time moved later, leaves it armed.
            if schedule.last_run_at.is_some_and(|last| last >= *at) {
                return (ScheduleDecision::Retire, None);
            }
            if *at > now {
                return (ScheduleDecision::Wait, Some(*at));
            }
            // One-time within a grace window still fires once (late boot);
            // ancient ones retire instead of surprising the user.
            if schedule.deferred_slot == Some(*at)
                || now.signed_duration_since(*at) <= grace.max(chrono::Duration::minutes(15))
            {
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
                    let advance = next_run(&schedule.kind, &schedule.timezone, now);
                    if schedule.deferred_slot == Some(slot)
                        || now.signed_duration_since(slot) <= grace
                    {
                        return (ScheduleDecision::Fire, advance);
                    }
                    // Missed while closed or asleep: the policy decides, and
                    // either way at most one run (no catch-up storm).
                    match schedule.missed_policy {
                        MissedPolicy::Skip => (ScheduleDecision::SkipMissed, advance),
                        MissedPolicy::RunOnce => (ScheduleDecision::Fire, advance),
                    }
                }
            }
        }
    }
}

/// Grace for the scheduler's next check: the time since its previous check
/// (plus a minute of slack), never below [`default_missed_grace`]. When the
/// wall clock moved more than a minute further than the monotonic clock, the
/// computer slept (or the clock was changed): slots in that gap were missed
/// while asleep, so the default applies. `previous` is the wall time of the
/// previous check and `monotonic_elapsed` the monotonic time since it.
pub fn check_grace(
    previous: Option<DateTime<Utc>>,
    monotonic_elapsed: std::time::Duration,
    now: DateTime<Utc>,
) -> chrono::Duration {
    let base = default_missed_grace();
    let Some(previous) = previous else {
        return base;
    };
    let wall = now.signed_duration_since(previous);
    let Ok(monotonic) = chrono::Duration::from_std(monotonic_elapsed) else {
        return base;
    };
    if wall < chrono::Duration::zero() || wall - monotonic > chrono::Duration::minutes(1) {
        return base;
    }
    base.max(wall + chrono::Duration::minutes(1))
}

/// The slot a `Fire` decision is about: the one-time instant, or the stored
/// next slot of a recurring schedule.
pub fn due_slot(schedule: &Schedule) -> Option<DateTime<Utc>> {
    match &schedule.kind {
        ScheduleKind::OneTime { at } => Some(*at),
        _ => schedule.next_run_at,
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
            deferred_slot: None,
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
    fn completed_one_time_schedule_never_refires() {
        let now = utc(2026, 3, 4, 10, 0);
        let schedule = Schedule {
            id: "once".into(),
            name: "Once".into(),
            workflow_id: "wf".into(),
            kind: ScheduleKind::OneTime { at: now },
            timezone: "utc".into(),
            enabled: true,
            trusted: true,
            missed_policy: MissedPolicy::RunOnce,
            last_run_at: Some(now),
            next_run_at: None,
            last_status: Some("started run".into()),
            deferred_slot: None,
        };
        assert_eq!(
            evaluate(&schedule, now + chrono::Duration::minutes(1)).0,
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
            deferred_slot: None,
        };
        let (decision, next) = evaluate(&schedule, utc(2026, 3, 4, 10, 7));
        assert_eq!(decision, ScheduleDecision::SkipMissed);
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
            deferred_slot: None,
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
            deferred_slot: None,
        };
        assert!(!schedule.validate().is_empty());
        schedule.kind = ScheduleKind::Interval { every_secs: 300 };
        assert!(schedule.validate().is_empty());
        schedule.timezone = "Mars/Olympus".into();
        assert!(!schedule.validate().is_empty());
    }

    /// Berlin rules for 2026 without a tz database: CET (+01:00), CEST
    /// (+02:00) from 29 March 01:00 UTC to 25 October 01:00 UTC.
    #[derive(Debug, Clone, Copy)]
    struct Berlin2026;

    #[derive(Debug, Clone, Copy)]
    struct BerlinOffset(chrono::FixedOffset);

    impl chrono::Offset for BerlinOffset {
        fn fix(&self) -> chrono::FixedOffset {
            self.0
        }
    }

    impl Berlin2026 {
        fn hours(hours: i32) -> BerlinOffset {
            BerlinOffset(chrono::FixedOffset::east_opt(hours * 3600).expect("offset"))
        }
    }

    impl TimeZone for Berlin2026 {
        type Offset = BerlinOffset;

        fn from_offset(_: &BerlinOffset) -> Self {
            Berlin2026
        }

        fn offset_from_local_date(
            &self,
            local: &chrono::NaiveDate,
        ) -> chrono::LocalResult<BerlinOffset> {
            self.offset_from_local_datetime(&local.and_hms_opt(0, 0, 0).expect("midnight"))
        }

        fn offset_from_local_datetime(
            &self,
            local: &chrono::NaiveDateTime,
        ) -> chrono::LocalResult<BerlinOffset> {
            let valid: Vec<BerlinOffset> = [2, 1]
                .into_iter()
                .map(Self::hours)
                .filter(|offset| {
                    let utc = *local - chrono::Duration::seconds(offset.0.local_minus_utc().into());
                    self.offset_from_utc_datetime(&utc).0 == offset.0
                })
                .collect();
            match valid.as_slice() {
                [] => chrono::LocalResult::None,
                [one] => chrono::LocalResult::Single(*one),
                [earlier, later, ..] => chrono::LocalResult::Ambiguous(*earlier, *later),
            }
        }

        fn offset_from_utc_date(&self, utc: &chrono::NaiveDate) -> BerlinOffset {
            self.offset_from_utc_datetime(&utc.and_hms_opt(0, 0, 0).expect("midnight"))
        }

        fn offset_from_utc_datetime(&self, instant: &chrono::NaiveDateTime) -> BerlinOffset {
            let summer = utc(2026, 3, 29, 1, 0).naive_utc()..utc(2026, 10, 25, 1, 0).naive_utc();
            Self::hours(if summer.contains(instant) { 2 } else { 1 })
        }
    }

    #[test]
    fn daily_local_follows_daylight_saving() {
        // Computed on Saturday (CEST) for Sunday, after clocks go back.
        let next = next_daily_in(&Berlin2026, 9, 0, utc(2026, 10, 24, 10, 0));
        assert_eq!(next, Some(utc(2026, 10, 25, 8, 0)), "09:00 CET");
        // 02:30 does not exist on 29 March: it runs at 03:30 CEST instead.
        let next = next_daily_in(&Berlin2026, 2, 30, utc(2026, 3, 28, 12, 0));
        assert_eq!(next, Some(utc(2026, 3, 29, 1, 30)));
        let next = next_weekly_in(&Berlin2026, Weekday::Mon, 9, 0, utc(2026, 10, 24, 10, 0));
        assert_eq!(next, Some(utc(2026, 10, 26, 8, 0)));
    }

    #[test]
    fn cron_local_runs_a_repeated_hour_once() {
        let spec = parse_cron("30 2 * * *").expect("cron");
        // 02:00 CEST on 25 October: 02:30 comes twice; the first one runs.
        let first = next_cron_in(&spec, &Berlin2026, utc(2026, 10, 25, 0, 0));
        assert_eq!(first, Some(utc(2026, 10, 25, 0, 30)));
        let after = next_cron_in(&spec, &Berlin2026, utc(2026, 10, 25, 0, 30));
        assert_eq!(
            after,
            Some(utc(2026, 10, 26, 1, 30)),
            "next day, not the repeat"
        );
    }

    #[test]
    fn cron_day_fields_combine_like_standard_cron() {
        // Restricted day and weekday: either one matches (Monday 26 Oct).
        let next = next_run(
            &ScheduleKind::Cron {
                expr: "0 9 1 * 1".into(),
            },
            "utc",
            utc(2026, 10, 22, 12, 0),
        );
        assert_eq!(next, Some(utc(2026, 10, 26, 9, 0)));
        // A starred weekday leaves the day of month in charge.
        let next = next_run(
            &ScheduleKind::Cron {
                expr: "0 9 1 * *".into(),
            },
            "utc",
            utc(2026, 10, 22, 12, 0),
        );
        assert_eq!(next, Some(utc(2026, 11, 1, 9, 0)));
        // Leap day, more than a year ahead.
        let next = next_run(
            &ScheduleKind::Cron {
                expr: "0 0 29 2 *".into(),
            },
            "utc",
            utc(2026, 10, 22, 12, 0),
        );
        assert_eq!(next, Some(utc(2028, 2, 29, 0, 0)));
    }

    #[test]
    fn cron_errors_match_the_typescript_mirror() {
        // Pinned in src/lib/scheduler.test.ts as well.
        let error = |expr: &str| parse_cron(expr).err().unwrap_or_default();
        assert_eq!(
            error("*/15 * * *"),
            "Cron needs 5 fields: minute hour day month weekday."
        );
        assert_eq!(error("99 * * * *"), "Value out of range 0-59 in '99'.");
        assert_eq!(error("*/0 * * * *"), "Step must be >= 1 in '*/0'.");
        assert_eq!(error("0 9 * * mon"), "Bad value 'mon' in 'mon'.");
        assert_eq!(error("1-2-3 * * * *"), "Bad value '2-3' in '1-2-3'.");
        assert_eq!(error("5-1 * * * *"), "Reversed range '5-1' in '5-1'.");
        assert_eq!(
            error("0 0 31 2 *"),
            "Cron never matches: no chosen month has that day."
        );
    }

    #[test]
    fn cron_that_never_matches_is_invalid() {
        assert!(parse_cron("0 0 31 2 *").is_err());
        assert!(parse_cron("0 0 30,31 2 *").is_err());
        assert!(parse_cron("0 0 31 4,6 *").is_err());
        assert!(
            parse_cron("0 0 31 2 1").is_ok(),
            "Mondays in February still match"
        );
        assert!(parse_cron("0 0 31 1-3 *").is_ok());
    }

    #[test]
    fn interval_grid_follows_the_timezone() {
        let now = utc(2026, 3, 4, 10, 7);
        // 15:37 at +05:30: the next hourly slot is 16:00 local.
        let next = next_run(&ScheduleKind::Interval { every_secs: 3600 }, "+05:30", now);
        assert_eq!(next, Some(utc(2026, 3, 4, 10, 30)));
        // Daily interval at -08:00 lands on local midnight.
        let next = next_run(
            &ScheduleKind::Interval { every_secs: 86_400 },
            "-08:00",
            now,
        );
        assert_eq!(next, Some(utc(2026, 3, 5, 8, 0)));
    }

    fn interval(every_secs: u64, next_run_at: Option<DateTime<Utc>>) -> Schedule {
        Schedule {
            id: "s".into(),
            name: "Review PRs".into(),
            workflow_id: "w".into(),
            kind: ScheduleKind::Interval { every_secs },
            timezone: "local".into(),
            enabled: true,
            trusted: true,
            missed_policy: MissedPolicy::Skip,
            last_run_at: None,
            next_run_at,
            last_status: None,
            deferred_slot: None,
        }
    }

    #[test]
    fn slot_noticed_late_while_running_still_fires() {
        // Hourly checks noticed the 20:00 slot at 20:23; the app was running
        // the whole time, so the grace covers the gap and the slot runs.
        let schedule = interval(3600, Some(utc(2026, 10, 22, 20, 0)));
        let now = utc(2026, 10, 22, 20, 23);
        assert_eq!(
            evaluate(&schedule, now).0,
            ScheduleDecision::SkipMissed,
            "default grace alone treats it as missed"
        );
        let grace = chrono::Duration::minutes(61);
        let (decision, next) = evaluate_with_grace(&schedule, now, grace);
        assert_eq!(decision, ScheduleDecision::Fire);
        assert_eq!(next, Some(utc(2026, 10, 22, 21, 0)));
    }

    #[test]
    fn run_once_policy_catches_up_a_single_missed_slot() {
        let mut schedule = interval(3600, Some(utc(2026, 3, 1, 0, 0)));
        schedule.missed_policy = MissedPolicy::RunOnce;
        let (decision, next) = evaluate(&schedule, utc(2026, 3, 4, 10, 7));
        assert_eq!(decision, ScheduleDecision::Fire);
        assert_eq!(next, Some(utc(2026, 3, 4, 11, 0)));
    }

    #[test]
    fn check_grace_covers_awake_gaps_only() {
        let now = utc(2026, 10, 22, 20, 23);
        let hour = std::time::Duration::from_secs(3600);
        assert_eq!(check_grace(None, hour, now), default_missed_grace());
        // Awake for the whole hour since the previous check.
        assert_eq!(
            check_grace(Some(now - chrono::Duration::hours(1)), hour, now),
            chrono::Duration::minutes(61)
        );
        // A quick re-check never shrinks below the default.
        assert_eq!(
            check_grace(
                Some(now - chrono::Duration::seconds(30)),
                std::time::Duration::from_secs(30),
                now
            ),
            default_missed_grace()
        );
        // Asleep for most of the gap: monotonic time stood still.
        assert_eq!(
            check_grace(
                Some(now - chrono::Duration::hours(1)),
                std::time::Duration::from_secs(600),
                now
            ),
            default_missed_grace()
        );
        // Clock set backwards.
        assert_eq!(
            check_grace(Some(now + chrono::Duration::minutes(5)), hour, now),
            default_missed_grace()
        );
    }

    #[test]
    fn editing_the_interval_recomputes_the_next_slot() {
        // Stored hourly with the 21:00 slot; edited to every 5 minutes at
        // 20:42 with the stale slot still in the form.
        let stored = interval(3600, Some(utc(2026, 10, 22, 21, 0)));
        let mut edited = interval(300, stored.next_run_at);
        edited.prepare_save(Some(&stored), utc(2026, 10, 22, 20, 42));
        assert_eq!(edited.next_run_at, Some(utc(2026, 10, 22, 20, 45)));
    }

    #[test]
    fn saving_without_timing_changes_keeps_a_pending_slot() {
        // A slot deferred by the run limit is still due; a rename keeps it.
        let mut stored = interval(300, Some(utc(2026, 10, 22, 20, 45)));
        stored.last_run_at = Some(utc(2026, 10, 22, 20, 40));
        stored.last_status = Some("deferred: run limit reached".into());
        let mut edited = stored.clone();
        edited.name = "Review requested PRs".into();
        edited.last_run_at = None;
        edited.last_status = None;
        edited.prepare_save(Some(&stored), utc(2026, 10, 22, 20, 47));
        assert_eq!(edited.next_run_at, Some(utc(2026, 10, 22, 20, 45)));
        assert_eq!(
            edited.last_run_at, stored.last_run_at,
            "bookkeeping is kept"
        );
        assert_eq!(edited.last_status, stored.last_status);
    }

    #[test]
    fn pausing_clears_and_resuming_recomputes_the_slot() {
        let stored = interval(300, Some(utc(2026, 10, 22, 9, 0)));
        let mut paused = stored.clone();
        paused.enabled = false;
        paused.prepare_save(Some(&stored), utc(2026, 10, 22, 9, 2));
        assert_eq!(paused.next_run_at, None);
        // Resumed hours later: no stale slot from before the pause.
        let mut resumed = paused.clone();
        resumed.enabled = true;
        resumed.prepare_save(Some(&paused), utc(2026, 10, 22, 14, 1));
        assert_eq!(resumed.next_run_at, Some(utc(2026, 10, 22, 14, 5)));
        // A new schedule gets its first slot.
        let mut created = interval(300, None);
        created.prepare_save(None, utc(2026, 10, 22, 14, 1));
        assert_eq!(created.next_run_at, Some(utc(2026, 10, 22, 14, 5)));
    }

    #[test]
    fn one_time_stays_armed_after_an_earlier_manual_run() {
        let at = utc(2026, 3, 4, 10, 0);
        let mut schedule = Schedule {
            kind: ScheduleKind::OneTime { at },
            next_run_at: Some(at),
            ..interval(300, None)
        };
        // "Run now" an hour before the scheduled time.
        schedule.last_run_at = Some(utc(2026, 3, 4, 9, 0));
        assert_eq!(
            evaluate(&schedule, utc(2026, 3, 4, 9, 30)).0,
            ScheduleDecision::Wait
        );
        assert_eq!(
            evaluate(&schedule, utc(2026, 3, 4, 10, 0)).0,
            ScheduleDecision::Fire
        );
        // After the scheduled run it is complete.
        schedule.last_run_at = Some(utc(2026, 3, 4, 10, 0));
        assert_eq!(
            evaluate(&schedule, utc(2026, 3, 4, 10, 1)).0,
            ScheduleDecision::Retire
        );
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
        if self.pr_number == Some(0) {
            errors.push("PR number must be above 0.".to_string());
        }
        if self.check_interval_secs < 300 || self.check_interval_secs > 2_592_000 {
            errors.push(
                "Watcher interval must be 300 s to 30 days (be kind to the API).".to_string(),
            );
        }
        if matches!(self.kind, WatcherKind::PrUpdated | WatcherKind::Feedback)
            && self.pr_number.is_none()
        {
            errors.push("PR-scoped watchers need a PR number.".to_string());
        }
        errors
    }

    /// Scope excludes display name, interval and enabled state: edits to those
    /// must retain handled revisions. Repository/workflow/PR changes reset them.
    pub fn same_scope(&self, other: &Self) -> bool {
        self.repo_dir == other.repo_dir
            && self.workflow_id == other.workflow_id
            && self.kind == other.kind
            && self.pr_number == other.pr_number
    }

    pub fn prepare_save(&mut self, previous: Option<&Self>) {
        if let Some(previous) = previous {
            if self.same_scope(previous) {
                self.last_head_sha = previous.last_head_sha.clone();
                self.last_checked_at = previous.last_checked_at;
                self.last_result = previous.last_result.clone();
                if self.enabled && !previous.enabled {
                    self.last_checked_at = None;
                    self.last_result = Some("waiting: first check after enabling".into());
                }
            } else {
                self.last_head_sha = None;
                self.last_checked_at = None;
                self.last_result = None;
            }
        }
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
