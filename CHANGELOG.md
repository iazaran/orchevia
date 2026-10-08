# Changelog

All notable changes are recorded here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/iazaran/orchevia/compare/v0.1.9...HEAD
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
