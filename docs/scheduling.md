# Scheduling, triggers & background mode

Orchevia is local-first: schedules and watchers run while **the app runs**.
There is no cloud service and no hidden daemon — background mode keeps the app
in the system tray when windows close.

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
- At most one catch-up per policy: `Skip` jumps stale slots silently (no
  storm after offline periods); `RunOnce` fires a single catch-up.
- Automatic dispatch shares a two-active-run budget across schedules and watchers;
  pending, running and approval-paused runs count toward the budget. A workflow
  already active is deferred (distinct PR inputs may run separately). Due slots
  and unstarted revisions remain eligible. The scheduler poll interval is 30–3600 s
  (default 60 s) and re-read live from Settings. Launch evaluates persisted due
  slots before advancing them, so `RunOnce` catch-up is retained.
- Missed one-time runs within 15 minutes still fire once (late boot grace);
  ancient ones retire (Skip) instead of surprising you. A completed one-time
  schedule cannot start again on the next check.
- Use **Run now** to fire manually; the schedule row records last status.
- Scheduled and watcher-started runs share the manual run cancellation controls.
  Cancel them under **Runs**; partial process output stays in history. Cancellation
  does not undo changes or remote writes already performed.

Intervals use an epoch-aligned grid: a 15-minute schedule has quarter-hour
slots. Daily, weekly and cron schedules use the chosen offset. Fixed offsets
do not follow DST; `local` samples the system offset when calculating the next
slot, so already stored future slots are not an IANA/DST-aware calendar.

## Background mode

Settings → Automations → _Run in background when windows close_. Off (default):
closing the window quits. On: the window hides to the tray (explicit indicator
in the UI); Quit happens only from the tray menu. No autostart is installed —
reboot means relaunch, and missed schedules apply their policy on boot.

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
