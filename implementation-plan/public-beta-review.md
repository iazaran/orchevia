# Public beta review and release preparation

## Goal

Review the existing product, fix demonstrated defects, prepare version 0.1.0,
and deliver a pull request with passing checks. The user will merge and tag the
release; the follow-up Claude review prompt is deferred until then.

## Constraints

- Keep the Rust core, thin Tauri bridge, typed frontend backend, and browser mock.
- Preserve workflows and local data; no new architecture or product expansion.
- Use the existing UI components, validation conventions, and documentation.
- Commit focused groups with short messages; never include credentials or build output.

## Steps

- [x] Audit core execution, generation, CLI profiles, UI, docs, and delivery workflows.
- [x] Reproduce concrete defects with regression tests and repair their causes.
- [x] Align agent command previews with native argument order and configuration.
- [x] Improve shared dialog keyboard behavior using the existing modal component.
- [x] Consolidate the first-release changelog and document actual limits and setup.
- [x] Validate version/tag consistency and installer filenames in CI and release jobs.
- [x] Run all AGENTS.md checks, build Linux installers, and inspect the browser UI.
- [x] Self-review and independent review; group source and fixes into focused commits.
- [ ] Push the branch, create and attach the PR, watch checks, and fix any failures.

## Review focus

- Verbose or Unicode process output must not deadlock, panic, or grow without bounds.
- Cancelling, timing out, and resuming approval must preserve correct run state.
- Custom CLI prompts and flags must match the documented invocation contract.
- Keyboard users must be able to enter, navigate, dismiss, and leave dialogs.
- Release tags must match every application version and publish all promised assets.

## Evidence

Baseline: 228 Rust core tests passed. GitHub has no existing PRs or releases;
the default branch is main, with only LICENSE committed. Keep 0.1.0 for the
first public beta rather than imply an earlier shipped version.


Review repairs include capped process readers, UTF-8 truncation, atomic approval
and paused cancellation, per-run workflow snapshots, active-delete guards,
camelCase schedule/checkout compatibility, MCP tool normalization, stable and
valid profile mapping, mock approval/condition parity, keyboard dialogs, and
accurate local-storage/security guidance. Test dependencies were patched after
a confirmed advisory. Keep the existing app identifier to preserve local data;
its packaging warning is accepted. Direct-child cancellation does not guarantee
that independently spawned descendants stop, and this limit is documented.

Final local checks: 97 frontend tests, 250 core tests, and 2 desktop command tests.
Formatting, lint, type checking, Clippy, and version consistency pass. Linux
Debian/AppImage packages build; browser inspection covers desktop layout, dialog
keyboard handling, a safe Start-to-End mock run, and unavailable-release guidance.
The independent review also reproduced consecutive-gate stale approval and fixed
it with result-ID tokens checked inside the existing transaction. Real provider
workflows and skill loading are not covered by the browser smoke check.

## CI and release follow-up (2026-10-01)

Scope: reduce Actions usage, diagnose the two v0.1.3 Intel failures independently,
and document verified downloads without changing visibility, tags, or Pages settings.
Main was current at `d945d923c5e893882aee28763d719e376cf6ba3d`; PR #15 was merged,
#13/#14 closed, and no new dependency PRs were open.

- Replace PR/main bundle matrices with gated core/Linux desktop checks; retain Linux,
  Apple Silicon, and Intel tag packages. Keep unconditional formatting/version/docs
  checks and a failing aggregate for applicable failed/cancelled jobs.
- Share core-check caches with release validation, use the real root Cargo target,
  retain build dependencies on failure, and retry uploads once without a rebuild.
- Keep Pages validation on every PR; deploy only site changes on main. Group Actions
  dependency updates and limit grouped version PRs without disabling security updates.
- Diagnose attempt 1 as completed Intel DMG plus `ENOTFOUND` at artifact creation;
  attempt 2 as hidden DMG script failure after compilation. Inspect matching Tauri
  2.12 source: script stdout/stderr is debug-only and CI already skips Finder styling.
  Enable verbose logs/system diagnostics; do not claim an unverified bundling fix.
- Prepare 0.1.4 as the confirmed next release, with matching manifests, workspace
  Cargo lock entries, and dated changelog. The frontend lock has no app version;
  verify it with a frozen installation.
- README links directly to the v0.1.4 installers and checksums, with no older
  installer links or temporary build-status wording. Preserve public-soon
  guidance without downloads on the public page.
- The maintainer creates v0.1.4 after merge and passing checks. An old-tag rerun
  cannot pick up new workflow diagnostics. No release reruns here.

Validation covers change classification including native JSON, PR merge-base,
multi-commit pushes, renames/deletions, initial pushes, and malformed refs; version
and Cargo lock drift; public-page privacy and README availability; actionlint; all
AGENTS.md checks plus desktop command tests and the frontend production build.
A clean source fixture caught the desktop default `custom-protocol` requirement
for `dist/`. CI now builds frontend output once and shares it only within that
read-only CI run; tag builds never use that PR/main artifact. Verify runtime
packaging on macOS in the maintainer-approved new tag build.

Final local results: 103 UI tests, 13 delivery tests, 250 core tests, and 2 desktop
command tests passed. All required lint/format/type/compile checks, frozen offline
pnpm install, version/tag consistency, actionlint, and pnpm build passed. The
frontend build retains its existing large-chunk advisory; no bundle rule was weakened.

The 0.1.4 follow-up reran all AGENTS.md checks, pnpm build, and frozen lockfile
validation successfully. The initial core run hit `Text file busy` while spawning
`mcp::tests::lists_tools_from_fixture_server`; that unchanged fixture passed both
in isolation and in the full 250-test rerun. No test or production rule was weakened.

## Actions optimization and 0.1.5 (2026-10-01)

Main was fast-forwarded to merged PR #16 (`2e9a01e`); work continues on
`optimize-actions-and-dependencies`. Dependabot #17 contains only four compatible
Actions upgrades, included here and left open until merge.

The v0.1.4 release run `36889916059` completed successfully. Both macOS DMGs and
Linux packages are published; all four nonempty installer asset digests agree with
the downloaded `SHA256SUMS`. Linux setup took 21:12 because Azure's APT mirror
downloaded 78.3 MB in 20:42 (63.1 KB/s). Packaging then took 9:20. This is distinct
from the previous Intel bundler/upload failures, which did not recur in v0.1.4.

- Share a tested Linux setup script between CI and release. Remove Azure's slow
  mirror only with Ubuntu's archive fallback present, preserve signed/security
  sources and media dependencies, and log update/install timings with bounded retries.
- Replace the redundant desktop `cargo check` pass with one all-target test build.
  Production default features and the frontend artifact remain required.
- Lint edits to existing workflows instead of compiling unchanged application code;
  new workflows, shared build scripts, manifests, and unknown inputs remain conservative.
  Keep aggregate checks and all frontend/core tests for their applicable changes.
- Allow isolated PR cache writes so repeated PR updates can reuse changed dependencies.
  Main/tag jobs cannot consume those PR caches. Different release tags still cannot
  reuse one another's release-profile caches; no extra cache-warming builds are added.
- Prepare 0.1.5 manifests/lock entries/changelog and direct current-version download
  links. Preserve private-repository access guidance and the public-soon page notice.

Estimated savings: existing-workflow-only PR/main edits avoid roughly 6–7 minutes
of desktop work plus the core job, minus workflow linting overhead. Native CI avoids
the observed 2:15–2:22 check pass. Mirror throughput remains variable; the 20-minute
stall is a measured optimization target, not a guaranteed reduction. All three
platform release builds and their validation/publication gates remain.

Validate all AGENTS.md commands, production frontend build, all-target desktop tests,
delivery regressions, actionlint/ShellCheck, frozen dependency installation, and
version/tag consistency before a single push. The maintainer merges, then creates
v0.1.5 and verifies its four installers/checksums. No manual build/rerun or tag here.

Local results: all AGENTS.md commands, frozen offline pnpm installation,
`pnpm build`, `pnpm version:check v0.1.5`, and the exact CI all-target desktop test
command passed (103 UI tests, 15 delivery tests, 250 core tests, 2 desktop tests).
The same pinned actionlint container used in CI passed workflow linting and
ShellCheck for the Linux setup script. Isolated source fixtures confirmed that the
all-target desktop test build rejects a type error inside production `main` and
missing `dist/`; removing the separate check does not bypass either compile gate.
Self-review preserved all three release platforms, publication/checksum gates,
private page guidance, and artifact digest enforcement. The existing frontend
large-chunk advisory remains. Actual mirror timings and Pages deployment will be
verified in the maintainer's post-merge/tag runs.
