# Orchevia 0.4.1

Feedback on 0.4.0: Home is nice but should be a real dashboard (what is running,
something from the Inbox, what matters in usage), and pages must stop mixing
left-aligned narrow content with full-width content.

## Implementation and handoff

- [x] Page column in `src/styles.css`: `.main` defines `--page-gutter`
  (`max(24px, (100% - --page-max) / 2)`, `--page-max` 1360 px); `.topbar`,
  `.view` and `.update-banner` pad with it, so the title and body line up and
  centre beyond the cap. Removed the box caps (`.section-panel`, `.empty-state`,
  `.notice`, `.run-list`, `.inbox-list`, `.usage-chart-panel`, `.ability-cli`,
  `.home-view`, `.setup-check-profiles`); only `.section-hint` keeps
  `--measure`. `src/styles.test.tsx` pins the gutter and the absence of caps.
- [x] Dashboard data in `src/lib/dashboard.ts` (pure, tested): `activityByDay`
  (local days, DST-safe), `weekStats`/`weekDelta`, `upcomingAutomations`
  (enabled schedules' `nextRunAt`, watchers' `watcherNextCheck`),
  `attentionItems` (waiting runs, unread non-update entries, today's failures,
  each run once), `monthToDateFilter` (UTC month, whole days, as plan costs
  need), `formatSpan`. `formatRelative` in `src/lib/time.ts`.
- [x] `run_stamps` (Tauri command over `usage::run_stamps` and
  `SqliteDb::list_run_stamps`, mock twin `runStamps`): status and times of every
  run started since an RFC 3339 instant, newest first, three columns only. Home's
  figures and chart count it (never `listRuns(100)`), read again when the recent
  list's ids or statuses change. Same "Invalid 'since' date; use RFC 3339."
  error on both sides.
- [x] `list_active_runs` (Tauri command over `SqliteDb::list_active_runs`, mock
  twin `listActiveRuns`): pending, running and paused runs however old. The
  store keeps them as `activeRuns`, refreshed with runs every 5 s, and
  `mergeActiveRuns` adds the ones `listRuns(100)` misses for the sidebar count
  and Home (live cards, Needs you). `list_runs` itself is unchanged, so Runs
  and its tests keep their list.
- [x] `HomeView`: pulse line, four figure tiles (buttons to Runs/Usage), Running
  now (`runProgress` over `getRunWorkflow` + `getRunResults`, every 2 s, at most
  three runs), Up next, Activity (CSS bars, `role="img"` summary), Recent runs,
  Needs you (4 rows + "more in the Inbox"), Usage this month (`usageSummary` +
  `estimatePlanCost` with the saved plans and share; refetched when a run
  finishes), kinds of work, workflow cards. Figures and the chart are hidden
  until there is a run.
- [x] Sidebar: `.nav-live` running count on Runs; App refreshes runs with the
  Inbox every 5 s while the window is visible.
- [x] Runs detail empty state with **Open the latest run**; Usage chart drawn at
  the panel width (ResizeObserver, 480–1600 coordinates, 760 without one);
  Environment permission levels and abilities side by side; Inbox relative
  times, unwrapped buttons; Usage tiles share Home's tile style.
- [x] Mock backend keeps `notifications` (list newest first, `limit` clamped
  1–200, `unreadOnly`, mark read persists), matching `db.rs`.
- [x] Site: new `docs/images/home.webp` (1440 × 1000 @2x from the seeded mock),
  alt text and the Home card copy.

- [x] Review (Fable, Codex). Fixed: figures built from the 100-run list; the
  cost tile showing the API value without plans; success and schedule-started
  entries in Needs you; "more in the Inbox" pointing at runs; a rolling 7 × 24 h
  count beside a 7-calendar-day chart; failures shown after a rerun; Home polling
  runs on its own and live progress without an in-flight guard or visibility
  gate; raw ISO tooltips; a progress bar with a value before its first reading;
  the Workflows title bar centred over a full-bleed editor. Second reviewer:
  older running or waiting runs dropping off Home and the sidebar; a stale
  "Up next" (automations now refresh every 30 s, a passed slot reads "due
  now"); Home's open-run buttons failing silently; the window starting 14 × 24 h
  back instead of at local midnight; usage not re-read while a run still runs;
  zero tokens shown when none were reported; a mouse-only daily breakdown (now
  also a screen-reader table); Inbox cards squeezed below 1000 px; mock Inbox
  retention (newest 500 after a listing, as `db.rs`); a persistence test that
  passed on an empty list. Not changed: tooltips use `formatTime` like every
  view (no offset), so two times in a DST fall-back hour look alike.

## Notes for the next release

- The mock backend still never creates Inbox entries from run events; only
  seeded entries show in `pnpm dev`.
- Home's live progress reads each live run's results (with output) every 3 s;
  a light progress endpoint or an event stream would make it cheaper.
