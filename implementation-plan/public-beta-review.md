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
