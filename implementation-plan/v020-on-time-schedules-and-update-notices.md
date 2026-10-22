# v0.1.20 implementation outcome

On-time schedules, one app instance, pause switches and update notices.
Application version `0.1.19` → `0.1.20`. Workflow schema unchanged; template and
Simple JSON versions stay 1. Schedules gain an optional `deferredSlot` field (no
migration: absent means none).

## Why

A "Review PRs" schedule (every 3600 s, Skip policy) never ran on a Debian GNOME
desktop. The database showed `nextRunAt` 21:00, no `lastRunAt`, no status and the
scheduler poll setting at 3600 s. Three findings:

1. `evaluate` fired a past slot only when it was noticed within 5 minutes, even
   though the poll interval could be an hour. With hourly checks at :15 past, every
   slot was skipped, silently.
2. Changing the interval to 300 s kept `nextRunAt` 21:00: the editor sent the
   stored slot back and `save_schedule` kept any future slot.
3. Three Orchevia processes were running. GNOME without the AppIndicator extension
   has no StatusNotifier host, so the tray icon never appeared; each relaunch from
   the app menu started another process, scheduler and startup "mark running runs
   failed" pass on the same database.

A read-only audit of the automation code found more: deferred slots dropped as
"missed", blocked schedules notifying on every tick, scheduler desktop
notifications ignoring `notifications.os`, DST-shifted `local` slots, AND-ed cron
day fields, unmatched crons accepted, a UTC/local mix-up in the one-time field, an
always-off notification checkbox, mock/Rust validation drift and compare-and-swap
races in run bookkeeping.

## Scheduling

- `evaluate_with_grace` takes the grace explicitly. The app loop passes
  `check_grace(previous_wall, monotonic_elapsed, now)`: the time since the previous
  check plus a minute, never below 5 minutes. When the wall clock advanced more than
  a minute beyond the monotonic clock (`Instant`, which stops during suspend on
  Linux and macOS), the computer slept and the default applies. So slots due while
  the app was awake always fire; `Skip`/`RunOnce` only see closed or asleep time.
- `check_window` also reports whether the app stayed awake since the previous
  check (`CheckWindow::continuous`). The first check after launch or sleep clears
  `deferredSlot` before evaluating, so a slot held back before a quit follows the
  missed-run policy instead of running days later.
- `ScheduleDecision::SkipMissed` records `skipped: …` instead of a silent advance.
- `deferredSlot` marks a slot held back by the run budget or an active run; that
  slot fires whatever the grace (one-time too) and is cleared on fire, skip, retire
  or block.
- Blocked (trust, deleted workflow) and failed starts advance past the slot and
  notify only when `lastStatus` changes. Watcher errors notify when `lastResult`
  changes.
- `Scheduler::notify` gates desktop dispatch on `notifications.os` and
  `on_failure`, like `notify::emit_event`.
- `record_schedule_check`/`record_watcher_check` compare the parsed stored row
  with `before` under one lock (`replace_definition_if_unchanged`). The old SQL
  text comparison never matched rows written by older versions (`every_secs`,
  fields added since), so their bookkeeping was never recorded.
- `scheduler::save_schedule` reads, runs `prepare_save`, validates and writes
  through that compare-and-swap (5 tries), so a save racing a fired slot cannot
  put it back.
- `record_schedule` skips unchanged rows; when its compare-and-swap loses to a save
  after a run started, it merges `lastRunAt`/`lastStatus` and, if the saved slot is
  still the fired one, the advanced slot. `record_manual_run` replaces the blind
  upsert in `fire_schedule_now`.
- One-time schedules are complete when `lastRunAt >= at`, so a manual run earlier
  or a moved time leaves them armed.
  `Schedule::one_time_spent` (mirrored by `oneTimeSpent`) refuses to turn on a
  completed one, or one whose time passed with Skip; the card shows Done or
  Expired instead of a switch.
- `record_manual_run` clears `deferredSlot` and advances a due recurring slot, so
  the manual run is not followed by an automatic one for the same slot.
- The loop sleeps `next_wait`: until the earliest enabled schedule slot or watcher
  poll (rounded up to the second), 30 s for due-but-waiting work, at most 60 s. The
  `scheduler.intervalSecs` setting is removed from both allow-lists.

## Time math

- `next_run` uses `chrono::Local` for `local` (per-slot DST) and `FixedOffset`
  otherwise, through generic `next_daily_in`/`next_weekly_in`/`next_cron_in`.
  `resolve_after` uses the first occurrence of a wall time repeated by the
  fall-back hour (the second would run the slot twice); daily and weekly times
  inside a spring-forward gap run an hour later; cron skips gap minutes. A test `TimeZone` (Berlin 2026 rules) pins this without a tz database.
- Interval grids are exact (`next_interval`) and shift by the zone offset; for
  `local` that is the standard-time offset (`standard_offset`: the smaller of
  the January and July offsets), so DST never shortens, doubles or drifts them.
- Cron walks real time minute by minute through the zone's wall clock, skipping
  non-matching days and hours, five years ahead, so a repeated fall-back hour is
  seen twice: a `*` hour field runs through it (Vixie), an hour-restricted cron
  runs a repeated time once. Day-of-month and day-of-week are OR-ed when neither field starts with `*`
  (Vixie semantics). `never_matches` rejects only-day-of-month expressions with no
  day in any chosen month; it is structural, so the TypeScript mirror is exact.

## Saves and the mock

- `scheduler::save_schedule` refuses only turning a spent one-time schedule on,
  so renaming an enabled one that is held back (or ran seconds ago) still saves.
- `Schedule::prepare_save(previous, now)`: bookkeeping from the stored row; slot
  and `deferredSlot` kept only while enabled before and after with the same kind
  and timezone; otherwise recomputed (none while paused).
- `prepareScheduleSave` and `validateSchedule` mirror it in TypeScript with the
  same messages (cron errors pinned on both sides). The mock computes no slots, so
  it leaves `nextRunAt` empty where the desktop computes one.

## Desktop shell

- `tauri-plugin-single-instance` (first plugin): a second launch shows and focuses
  the main window and exits before setup. macOS `RunEvent::Reopen` does the same.
- `desktop::tray_available` asks the session bus `NameHasOwner
  org.kde.StatusNotifierWatcher` through `gdbus`, then `busctl` (no new crates),
  once off the UI thread at launch. Without a tray host, the first hide sends one
  desktop notification regardless of the notification switch: it is the only sign
  the app is still running.
- Commands: `desktop_info`, `quit_app`, `open_external_url` (only
  `https://github.com/iazaran/orchevia…`, plain URL characters, `xdg-open`/`open`,
  reaped), `record_update_notice`.

## Update notices

- The webview fetches `api.github.com/repos/iazaran/orchevia/releases/latest`
  (GitHub sends `Access-Control-Allow-Origin: *`, also on 404). No HTTP crate.
  While the repository is private the answer is 404: "No published release was
  found."
- `parseLatestRelease` keeps only repository links; `isNewer`/`parseVersion`
  mirror `updates.rs`. `record_update_notice` stores `updates.notifiedVersion`, so
  each release creates one Inbox entry; `updates.dismissedVersion` hides the
  banner; `updates.check = 0` turns automatic checks off.
- Environment → Updates picks the asset by `installKind` (`deb` from dpkg's
  `orchevia.list`, `appimage` from `$APPIMAGE`, `app` on macOS) and shows the
  install step.
- In-place installation needs signed metadata (Tauri updater) and an apt
  repository; see ROADMAP.

## UI

- `Switch` (`role="switch"`) for card pause/resume, Background mode, desktop
  notifications and automatic update checks. Forms with Save keep checkboxes.
- The notification preferences editor remounts once stored prefs load instead of
  showing defaults, and loads `notifications.os`.
- The one-time field converts with `toLocalInputValue`/`fromLocalInputValue` and
  ignores an empty value; the timezone list keeps a stored offset outside it.

## Validation

`pnpm check`, `cargo test -p orchevia-core`, `cargo clippy -p orchevia-core
--all-targets -- -D warnings`, `cargo fmt --check`, `cargo check -p orchevia`.
