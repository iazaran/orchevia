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
- At most 2 scheduled runs concurrently; the poll interval is 30–3600 s
  (default 60 s) and re-read live from Settings.
- Missed one-time runs within 15 minutes still fire once (late boot grace);
  ancient ones retire (Skip) instead of surprising you.
- Use **Run now** to fire manually; the schedule row records last status.

Timezones are wall-clock in the chosen offset; DST edge cases follow the
fixed offset (documented limitation — prefer `local` for DST-aware daily
rhythms on laptops that travel).

## Background mode

Settings → Automations → _Run in background when windows close_. Off (default):
closing the window quits. On: the window hides to the tray (explicit indicator
in the UI); Quit happens only from the tray menu. No autostart is installed —
reboot means relaunch, and missed schedules apply their policy on boot.

## Watchers (triggers)

Three trigger kinds, evaluated separately from execution:

- **Review requested** — open PRs assigned to you (or all, minus drafts and
  your own). New PRs and new head SHAs trigger; unchanged revisions never
  re-fire.
- **PR updated** — a pinned PR number; fires on new head SHA.
- **Feedback** — comments/checks newer than the last handled state: ignores
  your own comments, Orchevia's own comments (marker footer), and already
  handled items (dedupe store, capped at 500).

Minimum poll interval is 300 s (conservative by default: 900 s). Failures back
off by leaving `last_checked_at` set — no hammering. Watchers pass
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
