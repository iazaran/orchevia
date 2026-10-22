# Changelog

All notable changes are recorded here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **apt repository.** Debian and Ubuntu users can add the signed repository at
  `https://iazaran.github.io/orchevia/apt` and get new versions with
  `sudo apt upgrade` (see the README). It holds the newest three releases and is
  rebuilt by the Pages workflow after each release.
- When Orchevia was installed from the apt repository, **Environment → Updates**
  suggests `sudo apt update && sudo apt upgrade` instead of a download.

### Removed

- The early planning drafts under `docs/superpowers/`. The same designs are
  recorded in `implementation-plan/`, and the project website no longer serves
  them.

## [0.1.20] - 2026-10-22

### Added

- **Pause and resume from the card.** Schedules and watchers have an on/off switch
  on their card, so pausing no longer needs the editor. The same shared switch now
  drives Background mode, desktop notifications and update checks.
- **Update notices.** Orchevia asks GitHub for its latest release shortly after
  launch and twice a day. A newer version shows a banner, one Inbox entry and, with
  desktop notifications on, one desktop notification. **Environment → Updates**
  shows your version, links the installer that matches your install (.deb,
  AppImage or DMG) with the steps to apply it, and turns automatic checks off.
  Nothing installs automatically.
- **Quit Orchevia** on the Background mode card, for desktops without a tray icon.
- Schedule cards show the last run time, the last result (started, deferred,
  skipped, blocked) and a hint when a run is due or waiting for a free slot.

### Changed

- The scheduler sleeps until the next slot or watcher poll is due and checks at
  least once a minute; saving a schedule or watcher wakes it at once.
- Interval schedules sit on a grid aligned to midnight in their timezone (standard
  time for `local`), so hourly runs on the hour in half-hour zones too. Intervals
  stay exactly N seconds apart across daylight-saving changes; use a Daily schedule
  for a fixed wall-clock time.
- Cron with both a day of month and a day of week restricted runs on either one
  (standard cron). Leap-day expressions are found up to five years ahead.
- Development: `pnpm tauri dev` while an installed Orchevia runs only focuses the
  installed app, because they share an identifier; quit it first.
- Dependencies refreshed within their declared ranges.

### Removed

- The **Scheduler checks every** setting (30–3600 s). Slots no longer depend on it.

### Fixed

- **Schedules run on time while Orchevia is open.** A slot ran only if the scheduler
  noticed it within 5 minutes, but it could check as rarely as once an hour, so most
  slots were skipped without a trace. Every slot that comes due while the app runs
  now starts, however late the check. The missed-run policy covers only time the app
  was closed or the computer slept, and a skipped slot says so on its card.
- **Editing a schedule recomputes its next run.** Changing the cadence or timezone
  kept the next run of the old timing: an hourly schedule changed to every 5 minutes
  still waited for the next hour. Pausing clears the next run, resuming computes a
  fresh one, and renaming keeps a pending one. A stale editor copy no longer
  overwrites the last run or result.
- **Only one Orchevia runs.** Opening the app while it was hidden in background mode
  started another copy with its own scheduler on the same database, and that copy
  marked the first one's active runs as failed. Opening it again now shows the
  running window; on macOS the Dock icon does too.
- **Background mode without a tray icon.** GNOME shows no tray icons unless the
  AppIndicator extension is installed, so a hidden Orchevia could neither be shown
  nor quit. The Background mode card now says so and offers Quit, and the first
  hide sends a desktop notification explaining how to get back.
- **Held-back runs keep their place.** A slot deferred by the two-run limit or an
  active run of the same workflow was later dropped as "missed" (one-time schedules
  were retired). It now runs as soon as a slot frees while Orchevia keeps running;
  after a quit or sleep the missed-run policy decides. **Run now** counts as that
  slot's run.
- **Blocked schedules notify once.** A schedule whose workflow now needs trust, was
  deleted or failed to start notified on every check. It now skips that slot and
  reports each change once; watcher errors also notify once per new error.
- Scheduler and watcher desktop notifications ignored the desktop-notification
  switch. They now follow it and the **Failures** preference.
- `local` daily, weekly and cron schedules were an hour off after a daylight-saving
  change. Every slot now follows the system zone's rules: a time skipped by the
  spring-forward jump runs an hour later, and a time repeated by the fall-back hour
  runs once (a cron with `*` in the hour field keeps running through it).
- Cron expressions that can never match (31 February) are rejected instead of
  silently never running.
- The one-time date field showed and saved UTC as if it were local time, moving the
  run by your UTC offset. **Run now** before a one-time schedule's time no longer
  uses it up, and a finished one shows **Done** instead of a switch that turned
  itself back off.
- The desktop-notification checkbox always showed off after reopening Automations.
- A save racing a scheduler check could lose the run record or put back a slot that
  just ran, starting it twice, and **Run now** could overwrite a concurrent check.
  Saves now write only if the stored schedule did not change meanwhile.
- Schedules and watchers saved by older versions (for example with `every_secs`)
  could never record a check, so a due slot could start again on every check.
- The browser mock (`pnpm dev`) validates schedules with the desktop app's rules and
  messages.

## [0.1.19] - 2026-10-21

### Changed

- **Agent permissions are decided once.** Headless Claude Code and Codex cannot
  ask for permission mid-run, and since v0.1.16 every refused tool fails the step,
  so workflows stopped at a different refused tool on each run and asked for new
  rules every time. Now one app-wide choice covers every Agent Profile:
  - **Let agents work without asking** gives Claude Code
    `--permission-mode bypassPermissions` and Codex
    `--dangerously-bypass-approvals-and-sandbox`, so no step is refused a tool.
  - **Follow each CLI's own settings** keeps the previous behaviour.

  Choose it in the setup wizard's new **Permissions** step or in **Environment →
  Agent permissions**. Until you choose, nothing widens: starting a run, using a
  template or importing one asks once, and can switch profiles that collected
  their own allow-lists back to the app default.

- Agent Profiles get an **App default** level, the new default for every
  profile without an explicit level. Agents shows what each profile runs with,
  and a profile can still keep its own level (CLI settings, Allowed tools or
  Full access). Profiles whose extra arguments set permissions themselves keep
  them.
- Refused steps in Runs offer **Let agents work without asking** next to adding
  the suggested rules, and the refusal message names it.

### Fixed

- Suggested rules for a refused shell command no longer treat a heredoc body or a
  redirection as commands. A refused `cat > PR_BODY.md <<'EOF' … EOF` suggested
  rules such as `Bash(The *)` and `Bash(EOF *)`, which admit nothing.

### Security

- Full access chosen app-wide counts as **Run AI CLI with full access** in
  workflow risks and schedule trust checks, exactly like a Full access profile.
  It never enables a schedule or watcher by itself.

### Dependencies

- Refreshed npm and Cargo dependencies within their declared ranges (Tauri
  2.12.5, Tauri CLI 2.12.4, Vite 8.3.5).

## [0.1.18] - 2026-10-21

### Fixed

- The built-in templates now run as shipped for a new user:
  - **Implement a Task** (was Implement Ticket) asks for the task as a
    description or pasted ticket text and never fetches links, which default
    Claude Code permissions refuse. Before, its first step always failed with
    missing `ticket.key` and `ticket.title`.
  - **Ticket to Draft PR** sends fix rounds back to both reviewers, runs the
    tests, commits, pushes the branch and then opens the draft PR. Before, a
    Codex finding looped until "Loop limit exceeded", and nothing pushed the
    branch.
  - **Review Pull Request** asks for the PR number, reviews the PR's diff, and
    asks for approval before posting one comment with both reviews.
  - **Address Review Feedback** (was Watch Review Feedback) checks out the PR,
    loads its feedback and routes on P0 as well as P1 findings.
  - **Investigate Bug**, **Refactor**, **Dependency Upgrade**, **Run Multi-Agent
    Review** and **Create Draft PR** ask for what they work on (the bug, the
    refactor goal, the install command, the base branch, the PR title) and push
    before opening a PR. Pushes fail fast instead of waiting for a credential
    prompt, and Create Draft PR's checkout is not blocked by untracked files.
  - Every implementation step declares the tools it needs (`Edit`, `Write`) and
    is told not to run tests, builds or package managers (the workflow does), so
    a missing Claude Code permission shows up when the template is used, not as
    a refused step mid-run.
- A clean review no longer reads as a blocking one. `node.<id>.severity` now
  comes from finding blocks first; a plain-text `P0`–`P3` tag no longer counts
  when it names the scale (`P0–P3`) or is negated right before it ("No P0/P1
  issues found"), while "Found P0/P1 issues" still reports P0. A review without
  findings reads as an empty severity instead of failing the condition with an
  unknown variable, and a later clean visit replaces an earlier finding.
- A loop whose fix step returns to the reviews through another step
  (`gate -true-> fix -> tests -> … -> gate`) no longer skips the exit path on the
  first round. Before, such a run could end as succeeded without ever running the
  steps after the loop. If the loop ends another way (a failure route), the
  waiting exit is skipped instead of stalling the run, and a fix branch that has
  used its visits ends the run with "Loop limit exceeded" instead of a scheduler
  deadlock. The browser demo follows the same rules.
- AI steps without their own working directory run in the workflow's repository
  directory, like Command, Git and GitHub steps. Before, they ran in Orchevia's
  own folder.
- The GitHub "Changed files" step uses `gh pr view --json files`; it called a
  `gh pr diff --numstat` option that does not exist.
- Ticket steps accept a Jira URL as well as an issue key.
- The "Review loop" sample re-runs both reviewers after a fix, and the "Review
  pull request" sample asks for approval before posting.

### Added

- **Use template** opens a short setup: the repository folder (required), the
  Jira/MCP server for ticket steps, the inputs each run asks for, and any tool
  permissions the mapped profiles lack.
- The core tests replay all nine built-in templates end to end in the real engine
  with stub Claude/Codex CLIs, a fake Jira server, a fake `gh` and a local Git
  remote.

### Changed

- Dependencies are refreshed in each release PR with the new `pnpm deps:update`
  (npm and Cargo within their declared ranges, then a version check and a list of
  what was held back). Dependabot now opens version-update PRs only for GitHub
  Actions; security updates are unaffected.
- `pnpm version:check` fails when a Tauri npm package and its Rust crate differ in
  major.minor (`@tauri-apps/api` and `tauri`, `@tauri-apps/plugin-*` and
  `tauri-plugin-*`), which Tauri refuses to build.
- Dependencies were updated within their ranges: eslint 10.13.0,
  typescript-eslint 8.72.0, tauri 2.12.4, tauri-build 2.7.3, tokio 1.54.0, and
  current patch releases of their dependencies.

## [0.1.17] - 2026-10-20

### Added

- The project page was rebuilt for the public launch:
  - an interactive, in-browser replay of a ticket → reviewed draft PR run that
    pauses for your approval, reviews in parallel, loops once for a fix and opens
    a draft PR;
  - a step-by-step guide to the workflow generator;
  - a tabbed tour of real app screens (editor, runs, usage, agents);
  - download cards that recommend the installers for the visitor's OS, and a
    link-preview image.

  It loads nothing from other sites and never calls the GitHub API.

- The README was rewritten for the public repository: badges, downloads from the
  latest release, screenshots, a generator guide, the safety model and current
  limits.
- `docs/images/` holds screenshots of real app screens (WebP) and
  `social-preview.jpg` for link previews and the repository's social preview.

### Changed

- Download links in the README and on the project page point to
  `releases/latest/download/<file>`, so they stay valid for every release without
  edits. The private-repository notices are gone.
- Release builds use less of the account's Actions minutes and storage:
  - Both macOS DMGs build on Apple Silicon runners. The Intel one is
    cross-compiled, and every app binary must report exactly the requested
    architecture before it is staged.
  - Release builds no longer save dependency caches, which a later tag could never
    restore.
  - Installer artifacts are kept for one day instead of 14.
- The Pages workflow runs only when the site or its workflow changes. Its
  validation checks the latest-release links and that every referenced image
  exists.
- Dependabot checks for updates monthly instead of weekly.
- Dependencies were updated:
  - frontend: React 19.3.1, `@tauri-apps/api` 2.12.4, `@tauri-apps/cli` 2.12.3,
    `@tauri-apps/plugin-dialog` 2.8.3, Vitest 5.0.5, Prettier 3.9.10,
    typescript-eslint 8.71.2 and jsdom 30.1.3, among others;
  - Rust: tauri-build 2.7.2, tauri-plugin-dialog 2.8.3, tokio 1.53.3,
    serde_json 1.0.154 and uuid 1.28.0.
- Examples, placeholders and tests use generic ticket keys.
- The Generate dialog's repository hint no longer claims the AI never writes. It is
  asked to read the repository without changing it, but it runs with the chosen
  profile's permissions.

## [0.1.16] - 2026-10-20

### Added

- Agent Profiles have a **Permissions** setting, passed only as CLI flags (no
  Claude Code, Codex or project settings file is ever written):
  **Use Claude Code / Codex settings** (default, no flag), **Allowed tools**
  (Claude Code `--allowedTools`, on top of what its settings allow) and
  **Full access** (Claude `--permission-mode bypassPermissions`, Codex
  `--dangerously-bypass-approvals-and-sandbox`). Codex has no tool allow-list,
  so it offers only its settings and full access. Saving Full access asks for
  confirmation; it is never a default.
- Agent nodes can declare the tools they need (`requiredTools`, Claude Code allow
  rules) in the inspector, Simple JSON and templates. Template import, the open
  workflow and the start-run form list declared tools the chosen profile does not
  grant and offer to add them. Template and document versions stay 1, so earlier
  exports import unchanged.
- Runs marks a step whose tools were refused, lists each refused call with the
  allow rule that would admit it, and offers to add the missing rules to the
  step's profile.

### Changed

- Profiles saved before v0.1.16 read as **Use Claude Code settings**, so upgrading
  widens no permissions.
- A workflow whose Agent node runs on a full-access profile (or one whose extra
  arguments bypass permission checks) lists the high-risk automation category
  **Run AI CLI with full access**; its schedules need the trusted opt-in, and the
  trust message names the risk.
- Dark theme: buttons have a visible resting border and fill, ghost buttons an
  outline, cards a distinct edge, and selected tabs and segments (Usage
  breakdown, Last 7 / 30 days, selected chips) a filled accent state. The light
  theme is unchanged.

### Fixed

- A Claude agent whose tool calls were refused no longer reports success. Headless
  `claude -p` refuses tools its settings do not allow, ignores
  `defaultMode: bypassPermissions` from a project's settings file, and still ends
  with `"subtype":"success"`. Orchevia now reads the result's `permission_denials`,
  fails the node with the `permissionDenied` failure kind, and names each refused
  tool with the rule that would admit it (`mcp__<server>`,
  `Bash(<command prefix> *)`, or the tool name). Failure routes and recovery work
  as for other agent failures; the node is not retried automatically.
- Text-output Claude runs (profiles whose extra arguments choose the output or
  input format) say in their output note that refused tools go undetected.
  Codex `exec --json` reports no event for a sandbox-blocked command, so Codex
  refusals stay undetected; see [refused tool calls](docs/agents.md#refused-tool-calls).

## [0.1.15] - 2026-10-15

### Added

- Inbox **Open run** now opens the exact run in Runs with its details selected:
  it fetches by run ID (so older runs outside the recent 100 still resolve,
  including runs whose workflow was deleted), retains the selected run across
  list refreshes, guards navigation/selection races, blocks duplicate clicks,
  and marks the notification read only after successful committed navigation.
  Missing runs and backend failures surface an error and leave the item unread.
  The workflow canvas overlay path (`Show on canvas`) is unchanged.
- Usage date presets (Last 7 / 30 days), a reset-filters action, and inline
  validation that blocks summary requests for invalid or reversed ranges.
- An expandable daily data table (day, runs, attempts, reported USD subtotal)
  backing the activity chart, plus a Workflow / AI profile / Provider & model
  tabbed breakdown, thousands separators, right-aligned tabular numerals, and
  two-decimal USD with exact precision in tooltips.
- Subscription settings now track unsaved changes, disable Save while clean or
  saving, confirm fee/extra removal, and report save failures without claiming
  success or losing drafts.

### Changed

- The daily activity chart is a bounded-height panel with a labeled attempts
  axis, integer ticks, gridlines, a zero baseline, capped bar widths, adaptive
  date labels, and explicit zero-filled UTC days — sparse activity no longer
  implies consecutive dates, and zero-attempt days draw no bar.
- Usage overview cards carry one prominent value each with CLI-reported
  coverage stated alongside; lengthy accounting explanations moved into
  disclosures. `Unknown USD` is now `Attempts missing USD`; provider rows show
  only reported cache/reasoning metrics with full counters behind disclosure.
- Inbox rows use a dedicated kind/content/actions layout with a restrained
  read/unread treatment instead of dimming the whole card.
- Shared table headers, row hover, numeric alignment, and light-theme form
  error contrast were polished without changing the dark-first identity.

### Fixed

- Zero-attempt days no longer render a positive-looking bar in the usage chart.
- Selected older runs can no longer be dropped from Runs by a list refresh or
  poll, and a late Inbox navigation can no longer override a newer selection.
- Subscription fee/extra inputs use labeled field groups with stable alignment
  and narrow amount/percentage widths instead of stretching full-width.
- Inbox waits for run details before navigating, so the Runs mount refresh cannot
  cancel notification read marking. Late list refreshes and transient retention
  failures preserve the selected older run.
- Unreported overview tool/subagent counts stay unknown; long-range charts retain
  readable axes, and the daily table preserves later activity beyond the chart cap.
- Subscription loading failures can be retried, draft controls lock during loading
  and saving, and breakdown tabs support keyboard navigation.

## [0.1.14] - 2026-10-12

### Added

- One floating start-run form replaces the inline inputs panel and the separate
  run-options dialog: inputs, dry-run fixtures and per-run limit overrides share
  a single explicit Start/Cancel flow. Workflows without inputs still review the
  effective limits before starting. The toolbar **Run options** button is now
  **Usage limits**, editing the workflow's saved limits; every run snapshots its
  effective values so later edits never change an existing run.
- Saved workflow-wide usage controls: an enforced Agent-attempt budget plus
  advisory tool-call, subagent and spend allowances. Dispatch reserves capacity
  before parallel siblings run, retries and loop visits count, and reused or
  simulated results are never charged. Exhaustion pauses the run durably with
  partial output preserved; only an explicit extension or cancellation resumes
  it, and ordinary approval cannot clear it. Per-node advisory allowances and a
  single injected policy per Agent invocation carry the bounds to the CLI.
- Honest capability labels per provider: only the run attempt budget is
  Orchevia-enforced; CLI turns, tools and subagents are advisory guidance plus
  observed stream counts (Claude `--max-turns` counts turns, not tools;
  `--max-budget-usd` is an estimate that can overshoot; Codex reports no USD).
  Incomplete or budget-limited reviews never emit success markers, approvals or
  publications for unfinished work.
- A **Usage & costs** page after Environment: date range, workflow/provider/model
  filters, daily chart, workflow, AI profile and model tables, and a compact Runs summary
  linking to it. History aggregates in the backend over every stored run (never
  a capped recent list) with UTC-day grouping. Subscription fees you enter,
  CLI-reported API estimates with source and coverage, and an optional labeled
  allocation stay in separate lanes; thin history reports **Insufficient
  history** instead of fabricated rates.
- Hovering or keyboard-focusing a node highlights its directly incoming and
  outgoing connections without touching selection, labels, accents or run-status
  colors. Each workflow's pan/zoom persists locally and restores on return;
  without a saved viewport the graph opens with a centered fit.

### Changed

- Document v1 Simple JSON round-trips workflow limits and per-node allowances;
  generation assistance preserves existing limits and allowances instead of
  erasing them. New `usage_summary`, `continue_usage_run` and
  `adapter_capabilities` backend commands back the page and the dialogs, with
  matching browser-mock behavior. New `usage.*` settings keys store subscription
  fees, extras, allocation share and method.
- AI profile run counts, execution time and CLI-reported cost coverage now live in
  **Usage & costs**; Agents focuses on profile configuration. Historical profile
  attribution uses each run's saved workflow, retaining deleted or unknown identities.

### Fixed

- Parallel Agent siblings can no longer each spend the same remaining attempt
  allowance; resumed, approved and continued runs keep one budget while recovery
  starts a new one without re-charging reused results.
- Ordinary and session-managed retries share the same atomic attempt gate; pause
  records and undispatched work do not consume attempts. Saved API-estimate limits
  apply to dispatch, and continuing a guard returns control to the desktop while
  execution resumes in the background.
- Structured provider-limit errors and incomplete CLI responses stop dependent
  work instead of following a failure route that could publish an unchecked result.
  Explicit local timeouts retain their configured retry and recovery behavior.
- Usage history retains distinct loop visits, accounts for provider-specific cache
  tokens, and exposes missing counter coverage. Subscription allocations remain
  explicit fee pools rather than prices derived from filtered workflow activity.
- Pending start/save/continue dialogs cannot dismiss via Escape or their close
  button; keyboard focus highlights the actual canvas node. Large workflows can
  fit below 30% zoom, and corrupt viewport storage can recover on the next move.

## [0.1.13] - 2026-10-09

### Changed

- Runs place review findings beside each originating agent's latest successful
  step, retaining deduplicated source attribution. Finding titles, paths, suggested
  fixes, code and tables wrap within the available width.
- CLI dollar values move into collapsed usage details and are labeled estimated
  API value, with subscription billing and remaining quota explicitly separate.
  Empty dollar summaries are hidden; missing reports still mark estimates partial.
  The optional reported-USD guard retains its behavior with clearer estimate wording.
- Expanded live stdout, stderr and agent activity follow the newest output. Scrolling
  up pauses following; **Follow latest** resumes it. The expand button says **Show
  full output**, avoiding a newline count that does not match wrapped screen lines.

### Fixed

- Bottom-left notifications slide in and out from the left and hold their exit
  position until removal, preventing a return to their resting appearance. Removal
  follows animation completion, with a reduced-motion/timer fallback.
- Expanding the last step's agent activity works on the first click.
- Runs detail columns can shrink to fit long findings and output instead of
  expanding the page horizontally.

## [0.1.12] - 2026-10-08

### Added

- Ordinary Claude and Codex Agent nodes use structured CLI output, so Runs, timelines
  and the reported-spend guard receive CLI token counts (and Claude's USD) without a
  session group. Node output is the clean final response, as for session groups (the
  trailing newline of text mode is no longer included). Profiles whose extra arguments
  choose their own output format keep text mode (Claude profiles with their own
  `--input-format` also keep the prompt as an argument), and Runs explains the missing
  usage. Stray non-JSON lines are kept as activity instead of failing the node.

### Changed

- Desktop launches resolve the login shell's `PATH` once in the background (5 s
  limit, safe fallback) and give it to every CLI, Git, GitHub, MCP, generation and
  probe process, so nvm/fnm installs and their `node` interpreter are found. More
  install locations are checked, files must be executable, lookups are cached and
  Environment/Agents **Refresh** re-resolves. Only `PATH` is imported; a launch from a
  terminal keeps that terminal's `PATH`. Tool detection and profile tests no longer
  block the window.
- Claude and Codex prompts travel on stdin instead of one command-line argument,
  avoiding the 128 KiB argument limit and process-list exposure. Previews show
  `<prompt via stdin, N chars>`; Custom CLI profiles are unchanged.
- Runs reloads a finished selected run only when its results can change, refetches
  findings only for the selected run's own new results and ignores late findings
  after a selection change. Markdown output is parsed once per text, and branch
  suggestions wait 250 ms for repository path typing to pause.

### Fixed

- Cancel, timeouts, MCP shutdown and app exit stop a CLI's whole process group on
  Linux and macOS (SIGTERM, 2 s grace, SIGKILL), so shells, MCP servers and
  `npx`/`uvx` descendants no longer survive; a CLI that ignores SIGTERM is stopped
  after the grace period. MCP calls return on timeout even when a descendant holds the
  pipe. Partial output is kept.

## [0.1.11] - 2026-10-08

### Added

- Fixture-driven Dry run uses the native scheduler to exercise branches, joins,
  bounded loops, retries and approvals without running developer CLIs or integrations.
  Missing fixtures fail explicitly; test history is labeled and excluded from spend,
  actionable findings and verified project knowledge.
- Failed-run recovery previews the original snapshot and requires an explicit
  reuse, replay or skip choice for every tool step. Linked runs preserve inputs,
  invalidate graph/data/context dependents and retain unaffected approval decisions.
- Runs include a common-axis timeline for overlapping attempts, visits and approval
  waits, with CLI-reported USD and unknown/partial coverage.
- Optional reported-USD spend guard pauses further tool dispatch after in-flight
  work drains. Continue with a higher threshold, disable the guard explicitly or
  cancel; decisions survive restart and reject stale requests.

### Changed

- Browser execution covers branch/join/loop routing for the new controls and
  persists snapshots, fixtures and recovery provenance. It remains simulated.
- Reused results are attributed to their source and do not resume source agent
  conversations or count as new execution time/spend.

## [0.1.10] - 2026-10-06

### Added

- Optional Claude/Codex session groups for related Agent nodes within a run,
  isolated by exact profile and working directory, serialized and bounded by a
  configurable turn limit. Successful sessions survive approval pauses.
- Selected context handoffs with a combined character budget and marked head/tail
  excerpts. Stored run logs retain their existing capture limits.
- Inspector and Simple JSON controls; generation and workflow assistance guidance
  for short follow-ups, independent reviews and per-item loop context.
- Runs show fresh/resumed context, CLI-reported token/cache/cost fields when
  supplied, and separate captured agent activity. Browser execution is simulated.
- Wizard recommendation **Claude — General purpose**, Opus with medium effort,
  preserving existing profiles with that name or role.

### Changed

- New built-in templates and AI workflow samples use bounded predecessor handoffs
  and implementation/fix session groups where useful; independent reviewers stay
  fresh. Existing saved workflows opt in without a schema migration.
- Managed nodes decode structured CLI streams into clean final output for conditions.
  Failed resumed turns are never automatically retried; later group members start
  fresh. Fresh attempts retain explicitly configured retry policies.

## [0.1.9] - 2026-10-05

### Changed

- Notifications, warnings, errors and workflow save feedback stack at the bottom-left
  above dialogs without shifting content. Information fades after five seconds;
  warnings and errors stay until dismissed. New Inbox events use the same feedback.
- AI Agent inspectors show the configured profile, CLI, model and effort, and explain
  missing profiles or unresolved imported roles. Using a template reports its selected
  profiles; manually selecting a profile clears the unresolved role.

### Fixed

- Setup wizard and workflow assistance can read and save the default assistance
  profile in the desktop app. Browser settings now mirror desktop access/validation.
- Watcher and schedule badges align vertically with their shared delete controls.

## [0.1.8] - 2026-10-05

### Added

- Reviewable local CLI assistance for existing workflows, with a configurable
  Workflow Assistance profile, developer instructions, project playbook and
  latest matching run failure context. Applying a preview never starts a run.
- Direct Simple JSON or Advanced workflow JSON import into a new template.
- Watcher last/next-check status, quiet/error outcomes and automation provenance.

### Changed

- Arrange uses dependency layers, branch/join centering, measured dimensions and
  loop entry order in both directions. Canvas controls have a translucent bar.
- Workflow/node edits autosave with saving/saved/error feedback and retry; local
  drafts survive refreshes and navigation. Redundant editor Save buttons removed.
- Project suggestions also observe new test/lint/build steps through existing
  review controls; repository playbooks remain isolated and accepted-only.
- Formatted reports render tables, nested lists, headings, code and safe links.

### Fixed

- Right-align workflow actions with responsive wrapping and reserve watcher
  card space for both the Enabled badge and shared delete control.
- Refresh Runs on every navigation entry, preserve selection and reject stale
  refresh responses while keeping one non-overlapping polling loop.
- Enforce GitHub requested-review scope, revision deduplication, bounded watcher
  dispatch and schedule overlap controls; preserve accepted partial dispatches.
- Prevent one-time schedules from repeatedly firing and preserve due work on
  scheduler startup instead of advancing it before evaluation.

## [0.1.7] - 2026-10-04

### Added

- A command-only getting-started guide and portable Hello Orchevia workflow,
  practical workflow recipes, setup troubleshooting, and expanded project-site
  explanations of authoring, approvals, project memory, and product boundaries.

### Changed

- Preserve newer editor drafts during saves, serialize saves per workflow, and
  scope validation and run-input review to the selected workflow.
- Replace historical release instructions with a maintained merge, tag and
  installer-verification guide; align permanent installer links with v0.1.7.

### Fixed

- Cancel scheduled and watcher-started runs through the same controls as manual
  runs, retaining partial output.
- Read native GitHub PR checks using supported CLI fields and normalize pending,
  failed, cancelled and skipped checks without losing CLI errors.
- Preserve unhandled watcher feedback after a failed poll or run start, and
  report actual Git tracking ahead/behind counts.
- Record unreachable nodes as skipped so warning-only graphs complete and joins
  and approval replay remain consistent.
- Assign newly created Agent Profiles to accepted generated workflow steps instead
  of saving unresolved roles.
- Prevent older save responses from replacing newer edits or another workflow's
  validation, and prevent input values from carrying across workflows.

## [0.1.6] - 2026-10-03

### Added

- Simple workflow JSON with readable keys, full configuration, portable template
  exports, and an Advanced view preserving existing raw JSON compatibility.
- Editable repository playbooks for commands, conventions, reviewers and reusable
  templates; evidence-backed suggestions and explicit successful-run promotion.
- Recommended Claude/Codex profiles matching the tested model and effort choices,
  including separate exact selections for reviewers sharing the same role.

### Changed

- Arrange graphs vertically by default with dependency ranks, branch lanes,
  bounded loop groups, measured node sizes and an explicit horizontal option.
- Make all nine built-in templates language neutral; project tests use a required
  command input. Browser preview supports persisted templates and memory.
- Prefer supported native workflow operations in generation, preserve explicit
  CLI restrictions, include accepted project knowledge and all profile choices,
  and explain unsupported Command fallbacks and AI profile bypasses.

### Fixed

- Open the exact immutable run graph from Inbox or Runs, with read-only result
  inspection and guarded navigation; read notifications leave the unread view.
- Remap spaced references when cloning templates while preserving MCP and condition
  literals, reject malformed editor values, preserve Command argument boundaries
  during interpolation, and reject effective blank required inputs before execution.
- Keep cancelled run navigation unread and preserve working directories and JSON
  edit observations in project-memory suggestions.
- Synchronize canvas nodes after external JSON edits and preserve existing
  reviewer selections ahead of role defaults.

## [0.1.5] - 2026-10-01

### Changed

- Validate existing workflow edits with actionlint and delivery tests without
  rebuilding unchanged frontend or native code; unfamiliar inputs still run both stacks.
- Compile and test all Linux desktop targets once with production default features,
  and save isolated PR dependency caches for later updates of the same PR.
- Include the grouped Actions upgrades for Node setup, artifact downloads, and Pages.
- Align application versions and current installer/checksum links to 0.1.5.

### Fixed

- Avoid the slow Azure APT mirror observed during the 0.1.4 Linux release, while
  retaining signed Ubuntu sources, security updates, and packaging/media dependencies.
- Add APT timing output and bounded connection retries to diagnose future setup delays.

## [0.1.4] - 2026-10-01

### Changed

- Gate frontend and native CI by changed inputs, replace routine installer matrices
  with Linux desktop checks, and keep all three release architectures on tag builds.
- Deploy Pages only for site changes, group Actions dependency updates, and improve
  Rust cache scopes while preserving required-check conclusions and security updates.
- Prepare version 0.1.4 with direct versioned installer and checksum links; remove
  older download links and the private CI badge.

### Fixed

- Capture verbose packaging diagnostics, retain dependency caches on release-build
  failure, and retry a failed installer upload once without recompiling.
- Require all four installers before publication and validate workspace Cargo lock
  versions against application manifests.

## [0.1.3] - 2026-09-30

### Changed

- Updated the Rust and frontend dialog plugins together to 2.8.0, including
  the Rust plugin and filesystem dependencies.
- Added authenticated installer links to the README and clarified that the
  repository and downloads will be public soon on the project page.

### Fixed

- Removed public release polling and unavailable download controls from the
  project page while the repository remains private.

## [0.1.2] - 2026-09-30

### Changed

- Updated the Rust and frontend Tauri packages together to 2.12, along with
  tauri-build, thiserror, TypeScript 6, esbuild, and Node.js types.

## [0.1.1] - 2026-09-29

### Changed

- Updated Rust, frontend, and GitHub Actions dependencies, retaining a TypeScript
  version supported by the current lint toolchain.
- Clarified public download and GitHub Pages availability in the README and site.

### Fixed

- Adapted component state handling to the newer React Hooks lint rules.
- Kept the Vite build's esbuild minifier available after the Vite upgrade.

## [0.1.0] - 2026-09-28

First beta tag. Public installers depend on a successful release workflow and
repository release access.

### Added

- Local desktop application for Linux and macOS, built with Tauri, React, and Rust.
- Visual workflows with Command, AI Agent, Git, GitHub, Jira Ticket, MCP Tool,
  Condition, Human Approval, Start, and End nodes.
- Parallel execution, joins, failure routing, bounded retries and guarded loops,
  workflow inputs, repository defaults, and per-node timeouts up to 12 hours.
- Claude Code, Codex, and custom CLI profiles with models, reasoning effort,
  optional skills, local discovery, and command previews.
- Goal-to-workflow generation grounded in an optional repository, using configured
  profiles and discovered MCP tools; editable previews, setup checklists, and
  repair guidance. Accepting a proposal never starts execution.
- Live per-node output, formatted reports, cancellation, durable human approvals,
  run history, and normalized review findings.
- Reusable built-in and user templates, JSON import/export, local preference memory,
  schedules, GitHub watchers, a notification inbox, and optional tray background mode.
- Setup wizard, tool detection, Jira MCP guidance, dark/light/system themes,
  accessible sidebar controls, and shared dialogs with keyboard focus handling.
- Contributor guides, security documentation, and a responsive project page with
  OS-aware downloads that appear when public release assets are available.
- PR checks and installer builds for Linux, Apple Silicon macOS, and Intel macOS;
  tagged releases with stable asset names, checksums, and version consistency checks.

### Fixed

- Verbose process output is drained while commands run and captured within limits;
  Unicode truncation preserves valid text.
- Custom CLI arguments precede the final prompt; browser previews include model,
  effort, skills, additional arguments, and referenced variables.
- Approval decisions are claimed atomically so repeated requests cannot restart
  the same paused work or decide a later gate; each run keeps its initial workflow definition, active
  workflows cannot be deleted, and run action errors are shown in the interface.
- Interval schedules and dirty-checkout settings use consistent camelCase
  fields across Rust and TypeScript, with compatibility for earlier saved data.
- Invalid schedule offsets and poisoned database locks report errors instead of
  panicking; run controls preserve cancellation during resumed execution.
- Test tooling is updated to the patched Vitest release; CI uses Node.js 22
  and a compatible Ubuntu indicator dependency set.
- Frontend development ignores native build output, preventing unrelated page
  reloads while Rust checks or installer builds run.
- Workflow generation preserves supported native operations and flags missing
  setup or unsupported actions rather than silently substituting them.
- Generator setup guidance matches the Jira MCP Cloud variables `JIRA_URL`,
  `JIRA_USERNAME`, and `JIRA_API_TOKEN`.
- Selected workflow nodes use a crisp outline and distinct kind colors; long
  generator explanations, run output, and history are expandable and scrollable.

### Known limitations

- macOS installers are unsigned and not notarized.
- Automation requires Orchevia to remain running; closing the window keeps it
  active only when background mode is enabled.
- Browser development uses a simulated backend and cannot run local CLIs.
- Skill discovery is metadata only; verify skill invocation with a small workflow.
- Commands are not sandboxed. CLI output is stored locally and can contain
  sensitive information; review logs before sharing them.

[Unreleased]: https://github.com/iazaran/orchevia/compare/v0.1.19...HEAD
[0.1.19]: https://github.com/iazaran/orchevia/compare/v0.1.18...v0.1.19
[0.1.18]: https://github.com/iazaran/orchevia/compare/v0.1.17...v0.1.18
[0.1.17]: https://github.com/iazaran/orchevia/compare/v0.1.16...v0.1.17
[0.1.16]: https://github.com/iazaran/orchevia/compare/v0.1.15...v0.1.16
[0.1.15]: https://github.com/iazaran/orchevia/compare/v0.1.14...v0.1.15
[0.1.14]: https://github.com/iazaran/orchevia/compare/v0.1.13...v0.1.14
[0.1.13]: https://github.com/iazaran/orchevia/compare/v0.1.12...v0.1.13
[0.1.12]: https://github.com/iazaran/orchevia/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/iazaran/orchevia/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/iazaran/orchevia/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/iazaran/orchevia/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/iazaran/orchevia/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/iazaran/orchevia/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/iazaran/orchevia/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/iazaran/orchevia/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/iazaran/orchevia/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/iazaran/orchevia/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/iazaran/orchevia/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/iazaran/orchevia/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/iazaran/orchevia/releases/tag/v0.1.0
