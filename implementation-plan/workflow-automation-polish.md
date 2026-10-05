# Workflow and automation polish — v0.1.8

## Intent and constraints

Implement the eleven user requirements from the 2026-10-05 implementation prompt. Improve the existing editor, local CLI generation/preview, project playbooks, template import, report renderer and automation scheduler without introducing a new architecture. Execution stays explicit; assistance proposals require review. Preserve workflow/runtime schema v6 and portability. Keep Backend/mock and Rust/TypeScript contracts aligned. The user owns merge, tag and release publication.

Base: latest origin/main, 0c1a6fb (v0.1.7). Branch: codex/workflow-automation-polish. The clean checkout allows work on this dedicated branch without a second checkout. The old local polish-developer-release branch was identical to merged main and was removed; its remote was already removed. Open dependency branches are retained.

## Implementation tasks

- [x] Editor geometry and persistence (points 1, 2, 6, 7): inspect WorkflowCanvas, workflow layout helpers, NodeInspector and store autosave. Add regression coverage for branches/joins/cycles, measured bounds and autosave failure/retry. Improve geometry in both directions; persist every editor edit safely; show saving/saved/error feedback and retain only necessary form Save controls. Right-align header actions with responsive wrapping; use approximately 75% opacity toolbar backgrounds in both themes.
- [x] Existing-workflow assistance and project knowledge (points 3, 5): extend generation/profile/preview flows through Backend and thin Tauri commands. Ground assistance in the current saved workflow, developer instructions, latest relevant run failure and its repository playbook. Add configurable setup-wizard assistance defaults. Preserve review/promotion controls and project isolation; test context selection and proposal application.
- [x] Direct workflow template import (point 4): inspect TemplatesView, workflow-document conversion and existing native/mock template importer. Accept supported plain workflow JSON as well as template wrappers, preserve configuration/portable profile bindings, and test malformed inputs without requiring a selected workflow.
- [x] Automation reliability and visibility (points 8, 10): trace scheduler/watchers/GitHub scope/shared run starter, revisions, inputs, overlap, cancellation and first checks. Test verified scope/deduplication/timing defects before fixes. Existing requested PR revisions must be eligible initially. Expose last/next check, quiet/error outcomes and clear per-PR dispatch. Reserve badge space using shared CloseButton patterns. Check schedules separately and document intended interval/timezone behavior.
- [x] Report rendering and Runs navigation (points 9, 11): extend the existing safe Markdown parser/component for tables, headings, ordered/unordered lists, inline/fenced code and links. Preserve raw/copy/download/scroll behavior. Refresh upon each Runs navigation with guarded requests and selection preservation. Add meaningful regressions.
- [x] Delivery: self-review all eleven points, synchronize version manifests/lockfile/references, update changelog and area docs. Run pnpm check, pnpm build, cargo test -p orchevia-core, cargo clippy -p orchevia-core --all-targets -- -D warnings, cargo fmt --check, cargo check -p orchevia and git diff --check. Verify UI in the browser where available. Group neutral commits, push once local validation passes, create/attach PR, and verify GitHub actions.

## Review focus

- Navigation/save races must not overwrite current edits or switch to a stale run/workflow.
- Multiple PRs are distinct dispatches only when the workflow consumes the supplied PR; repository-wide scans must not fan out blindly.
- Cancellation and failed dispatch must not advance revisions incorrectly or make running work immune to manual controls.
- Project context must exclude other repositories and pending/rejected/disabled knowledge.
- Plain JSON import and assistance must retain input/reference/profile bindings, with explicit semantic diagnostics and no automatic execution.

## Evidence and decisions

The saved screenshots are preserved as textual observations in memory; their transient image paths are unavailable. The user did not create a schedule; run-sched IDs alone do not identify a schedule. Five watcher runs at the same instant remain an observation until correlated with actual run inputs/revisions. Polling need not align with wall-clock quarter-hours or produce a run on an unchanged revision.

Implementation evidence and local validation are recorded below. External delivery is tracked by the pull request and its checks.

### Early verification and confirmed defects

- Clean v0.1.7 baseline: 158 frontend tests passed.
- New report regressions failed on missing tables/links, numbering split across
  blank lines and nested list structure; parser tests and component raw toggles
  now pass. Raw HTML remains escaped and unsafe URL schemes remain text.
- Plain workflow import failed with “Template needs a workflow” in core and
  “undefined is not valid JSON” in the mock. Core and mock now accept plain
  documents and envelopes, reject structural errors before persistence, and
  preserve roles/configuration. Foreign machine-only profile IDs produce guidance;
  a declared role remains portable. Native and mock fail/pass evidence recorded.
- Runs entry never refreshed when the cached list lacked active runs. New entry,
  return, error-retention and non-overlapping-poll regressions pass.
- Browser mock QA imported a plain report workflow into a template, cloned it,
  explicitly ran only the simulation and showed rendered tables, safe PR links,
  sequential numbering and nested lists with Raw/Copy/Download controls intact.
- Root self-review retains published v0.1.7 installer URLs while source/release
  instructions target v0.1.8. Download assertions now explicitly pin the published
  installer version instead of equating unreleased source with available assets.

### Final implementation and self-review

- Header actions wrap at narrower widths; graph arrangement uses measured bounds,
  dependency ranks, branch/join alignment, cycle groups and separated islands.
  Both Arrange and Fit View reserve the measured toolbar height. Toolbar
  backgrounds use 75% opacity in both themes.
- Every structured workflow/node edit shares a debounced, serialized autosave
  queue. Failed drafts survive navigation/refresh with explicit Retry save.
  Header/node Save controls are removed; unrelated forms retain explicit saves.
  Deferred saves cannot overwrite newer drafts or save another selected workflow.
- Assistance reuses local CLI generation and reviewed previews. The setup wizard
  configures a dedicated assistant or selects an existing profile. Arrange changes
  positions only; Optimize preserves existing IDs/types, bindings and advanced
  configuration. Source changes during drafting or asynchronous profile setup
  reject stale application. No automatic execution occurs.
- Project playbooks already offered canonical scope and reviewed suggestions.
  Newly added test/lint/build commands now participate in observations; assistance
  includes only accepted/enabled matching project/global memory and bounded errors
  from the latest matching workflow/repository run.
- Direct template import, safe Markdown reports and Runs-on-entry refresh are
  mirrored/tested. Selected run responses are sequenced; delayed workflow lists
  cannot restore successfully deleted workflows.
- Independent review found seven P2 races/scope issues. All were corrected: stale
  assistance application, stale deletion lists, post-GitHub watcher scope changes,
  literal condition operands misclassified as PR inputs, wrong execution repository,
  stale active-run budget, and mismatched supplied save definitions. Root review
  additionally corrected same-run response ordering and Fit View toolbar clearance.

### Watcher and schedule findings

Confirmed defects: requested-review watchers queried open PRs without enforcing
requested-review scope, bypassed the shared run budget, started a repository scanner
once per eligible PR, and checkpointed successful revisions too late after partial
failures. Saving did not wake the sleeping scheduler. Boot pre-advanced schedule
slots and completed one-time schedules could repeat. These paths now have regressions
and fixes, fresh shared capacity/overlap guards, scope checks and atomic bookkeeping.

Requested reviews use the authenticated user's GitHub search scope before limiting.
Existing requested revisions are initially eligible. A workflow that actually
consumes the supplied PR dispatches distinct revisions within the shared capacity;
a repository scanner receives one batch. Accepted starts are checkpointed immediately.
Cancelled accepted revisions remain handled; unstarted revisions remain eligible.
Run inputs record automation identity, PR/batch provenance and manual schedule trigger.

The current downloaded Review requested PRs workflow independently scans all requested
PRs and contains no supplied PR reference. This supports the scanner diagnosis but
is not an immutable snapshot of the reported runs. No installed Orchevia database
was available, so the five historical runs cannot be classified individually.
The shared run-sched prefix does not establish schedule origin. Watcher eligibility
is last-check-relative (17:21:24 +900s = 17:36:24), unlike grid-aligned interval
schedules. Quiet checks do not start runs. Last/next check and quiet/deferred/error
results are now visible; enabling queues an immediate check.

### Validation and limits

Passed on the final application source:

- pnpm check: version 0.1.8, formatting, zero-warning lint, TypeScript,
  15 delivery tests and 208 frontend tests across 33 files.
- pnpm build.
- cargo test -p orchevia-core: 302 tests.
- cargo clippy -p orchevia-core --all-targets -- -D warnings.
- cargo fmt --check.
- cargo check -p orchevia and cargo test -p orchevia: 3 command tests.
- git diff --check.

An unchanged MCP fixture initially hit transient Text file busy during spawn;
it then passed alone and in the complete 302-test suite without weakening tests.
Delivery tests required execution permission for temporary Git repositories after
sandbox spawnSync git EPERM; the complete pnpm check passed with that permission.

Browser mock QA: direct plain JSON template import and cloning; explicit simulated
report run; rendered tables/links/ordered and nested lists with Raw/Copy/Download;
Runs return refresh; right-aligned/wrapped actions at 1440px and 900px; dark/light
toolbar opacity; manual Fit View clearance; horizontal Arrange and saved feedback;
Enabled watcher badge/delete separation. Temporary theme/viewport overrides reset.
No installed native GUI, real generation CLI/provider, live authenticated watcher
dispatch or installer execution was tested. Browser mock automation does not execute.
Published installer links remain pinned to verified v0.1.7; no v0.1.8 assets are claimed.
Merge, release tag and publication remain with the user.
