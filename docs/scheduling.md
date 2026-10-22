# Scheduling, triggers & background mode

Orchevia is local-first: schedules and watchers run while **the app runs**.
There is no cloud service and no hidden daemon — background mode keeps the app
running when the window closes.

## Schedules

Kinds: one-time, fixed interval (60 s – 30 days), daily, weekly, cron
(5-field: minute hour day month weekday, with lists/ranges/steps). Timezones:
`local` (system), `utc`, or fixed `±HH:MM` — IANA names are unsupported by
design (no tz database); the UI offers concrete offsets instead.

Interval schedules use `everySecs` in JSON, matching the desktop and browser
interfaces. Existing saved `every_secs` values are still accepted and are
written back with the current field name.

- New schedules start **disabled** until reviewed.
- Enabling anything above read-only needs the **Trusted** opt-in; the risk
  summary lists what the workflow may do (see Security).
- Pause and resume a schedule or watcher with the switch on its card. Pausing
  clears the next run; resuming, or changing the cadence or timezone, computes a
  fresh one. Renaming keeps a pending slot.
- A slot that comes due while Orchevia runs always runs, even when the check that
  notices it is late. The missed-run policy covers only slots that passed while
  Orchevia was closed or the computer slept: `Skip` moves to the next slot and
  records `skipped: …` on the card (no storm after offline periods); `RunOnce`
  fires a single catch-up. Launch evaluates persisted due slots before advancing
  them, so `RunOnce` catch-up is retained.
- Automatic dispatch shares a two-active-run budget across schedules and watchers;
  pending, running and approval-paused runs count toward the budget. A workflow
  already active is deferred (distinct PR inputs may run separately). A held-back
  slot keeps its place (`deferredSlot`) and runs as soon as capacity frees, however
  long that takes; unstarted revisions remain eligible.
- The scheduler wakes when the next slot or watcher poll is due and checks at
  least once a minute; saves wake it at once. There is no interval setting.
- A slot that cannot start (the workflow now needs trust, it was deleted, or the
  start failed) is skipped; the Inbox reports it once per change, not on every
  check.
- Missed one-time runs within 15 minutes still fire once (late boot grace);
  ancient ones retire (Skip) instead of surprising you. A one-time schedule is
  complete once it ran at or after its time, so an earlier **Run now** does not
  use it up and a completed one cannot start again on the next check.
- Use **Run now** to fire manually; the card shows the last run time and result.
- Scheduled and watcher-started runs share the manual run cancellation controls.
  Cancel them under **Runs**; partial process output stays in history. Cancellation
  does not undo changes or remote writes already performed.

Intervals use a grid aligned to midnight in the schedule's timezone: a
15-minute schedule has quarter-hour slots, an hourly one runs on the hour local
time (also in half-hour zones) and a daily interval at local midnight. `local`
follows the system zone's daylight-saving rules for every slot: a daily time
skipped by the spring-forward jump runs an hour later, and a repeated fall-back
hour runs once. Fixed offsets never shift. In cron, when both the day of month
and the day of week are restricted, a date matching either one runs (standard
cron); expressions that can never match, such as 31 February, are rejected.

## Background mode

Automations → **Background mode** switch. Off (default): closing the window
quits. On: the window hides and schedules and watchers keep running. Opening
Orchevia again (app menu, dock, desktop file) shows the running window: only one
copy ever runs, so there is only one scheduler. Quit from the tray menu or with
**Quit Orchevia** on the Background mode card.

Some desktops show no tray icons, for example GNOME without the AppIndicator
extension (`sudo apt install gnome-shell-extension-appindicator`, then log out
and back in). Orchevia detects this, says so on the card, and the first time the
window hides it sends a desktop notification explaining how to get back. No
autostart is installed — reboot means relaunch, and missed schedules apply
their policy on boot.

Scheduler and watcher desktop notifications follow the same switch as every
other event (Notification preferences → desktop notifications) and the
**Failures** preference.

## Watchers (triggers)

Three trigger kinds, evaluated separately from execution:

- **Review requested** — open PRs in the watched repository whose review is
  requested from the authenticated GitHub user (`review-requested:@me -author:@me`, including GitHub team request scope). Drafts and your own PRs
  are excluded. New PRs and new head SHAs trigger; unchanged revisions never
  re-fire.
- **PR updated** — a pinned PR number; fires on new head SHA.
- **Feedback** — review/comments newer than the last handled state: ignores
  your own comments, Orchevia's own comments (marker footer), and already
  handled items (dedupe store, capped at 500).

Watcher intervals range from 300 s to 30 days (default 900 s). Enabling a new
watcher, re-enabling one, or changing its repository/workflow/PR scope queues
an immediate eligible check. Already open requested PRs are eligible on that
first check; enabling does not establish a baseline that silently skips them.
Existing handled revisions stay deduplicated when a watcher is re-enabled.
Later checks are relative to the last check, including quiet and error checks;
a first check at 17:21:24 with a 900-second interval is next eligible at
17:36:24, not 17:30. The global scheduler tick may delay a due check. Status
shows the last check, next eligibility time, quiet/deferred/error outcome and
accepted run IDs; the Automations view refreshes those statuses while open.

For a workflow that consumes `prNumber` through a reachable native PR operation
with `number: 0`, a rendered template or a condition's left operand, each new
PR revision receives a distinct dispatch within the shared run limit. A declared
but unused input, literal condition right operand, escaped template or unreachable
node does not make a workflow consume the PR. A workflow that scans the repository
independently receives one batch run, with `prNumbers`/`prHeadShas` provenance.
This prevents starting several copies of the same repository scan for one poll.
Pending revisions are reconsidered on the next eligible check.

Declared execution directories must agree with the watched repository. Native
checks resolve Git roots and canonical paths; node directories take precedence
over applicable workflow/profile defaults, exactly as in execution. Enabling a
mismatch is rejected, and runtime dispatch validates the definition it actually
starts. `input.repoDir` does not override working directories. The browser mock
checks normalized declared paths and cannot resolve filesystem symlinks or Git
roots. Arbitrary CLI scripts and agent prompt instructions remain user-controlled.

Each accepted run stores `automationKind`/`automationId` plus its watcher kind,
repository and PR revision or batch inputs. A `run-sched-` ID alone does not
identify whether a schedule or a watcher started it. Accepted dispatches are
checkpointed individually, so a failure starting a later PR cannot duplicate an
earlier one. Cancelling or failing an accepted run does not automatically retry
an unchanged revision: use an explicit manual run when needed.

Failures back off by leaving `last_checked_at` set — no hammering. Feedback keeps a separate
successful-handling watermark, so a failed poll or run start does not consume
unhandled comments. The next eligible poll can retry them; handled events remain
deduplicated. PR-scoped watchers pass
`prNumber`/`prHeadSha`/`feedbackCount` as workflow inputs; use `number: 0` in
GitHub nodes to consume `prNumber` at runtime.

## Review workflow

Automations → demo **PR review** creates:

```text
Start (input: prNumber)
  ↓
Load PR + changed files (gh)
  ↓
Parallel: Claude Review + Codex Review (finding-block convention)
  ↓
Condition: actionable P0/P1?
  ├─ Yes → post draft note (explicit node, Orchevia marker footer)
  └─ No  → mark checked (echo)
  ↓
End
```

Severity comes from the agents' own `severity:` fields (see Review findings),
never from Orchevia-owned AI. Unchanged revisions are not re-reviewed.

## CodeRabbit-style feedback loop

Treat CodeRabbit as one feedback source over generic comment/check polling
(source heuristic: login/body markers — no engine dependency on the bot):

```text
Create/Update PR
  ↓
Wait for checks/reviews (watcher: feedback)
  ↓
Collect new actionable feedback
  ↓
Condition: actionable?
  ├─ No → Finish
  └─ Yes → AI fix (bounded maxVisits) → Tests → AI review → Commit → Push → wait again
```

Every loop carries: maximum cycles (`maxVisits`), no auto-resolve, commit
safety (staged-only, explicit messages), full visibility in run history,
cancellation, and **no silent force-push** (the adapter has no force path at
all). Automated code changes only ever happen through explicit workflow nodes
you configured — never as a watcher side effect by itself.
