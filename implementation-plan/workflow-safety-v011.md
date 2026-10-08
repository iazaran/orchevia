# Workflow safety v0.1.11 implementation plan

> Execute inline using superpowers:executing-plans. User approved autonomous
> implementation on 2026-10-08 without another plan approval checkpoint.

**Goal:** Ship fixture-driven dry-runs, deliberate recovery, timelines and reported-spend guards.
**Architecture:** Extend the existing engine and persisted run history. Additive
run execution metadata lives in SQLite and is mirrored through Backend and Tauri.
**Tech stack:** Rust/Tokio/SQLite, React/TypeScript/Vitest, Tauri 2.
**Spec:** `docs/superpowers/specs/2026-10-08-workflow-safety-v011-design.md`

## Global constraints

- Preserve workflow schema v6, existing defaults, all legacy run entry points.
- Fixtures never dispatch real tools; every reached effectful attempt needs a fixture.
- Recovery uses original snapshot/inputs and explicit per-node choices.
- Only newly executed, structured CLI-reported USD counts toward a guard.
- Pause decisions and recovery creation are durable and atomic.

## Review focus

- Fixture exhaustion during loops/retries must fail without a real fallback.
- Parallel and data-only dependents must invalidate stale recovered outputs.
- Copied session metadata must never resume a source provider conversation.
- Stale approval/guard decisions must not continue a different pause.
- Simulated/reused costs and outputs must not become verified project knowledge.

### Task 1: Run contracts and dry-run

Files: core run-control module, db.rs, engine.rs, lib.rs, workflow.ts,
run-controls.ts and their colocated tests.
Interfaces: RunOptions (dryRun, fixtures, spendLimitUsd); RunExecution
(options, recoveredFrom, recoveryChoices, spendPause); fixtures per node ordered
by execution attempt; persisted metadata on StoredRun.

- [x] Add tests: serialization/migration, fixture validation, every effectful kind,
  missing/exhausted fixtures, branch/loop/join/retry behavior and approval continuation.
- [x] Run targeted tests: expected feature failures.
- [x] Implement additive persistence, pre-tool fixture dispatch and reserved metadata.
- [x] Run targeted tests: all pass; no subprocess/integration access in dry-run.

### Task 2: Failed-run recovery

Files: run-controls mirrors, db.rs, engine.rs, backend.ts, Tauri commands.
Interfaces: RecoveryPlan entries with allowed choices and source fingerprint;
recoverRun(sourceRunId, choices, expectedFingerprint, requestId) returns runId.

- [x] Add tests for snapshot/input preservation, missing choices, invalid reuse,
  graph/data/loop invalidation, independent retained branches, skip semantics,
  atomic failure and duplicate request idempotence.
- [x] Run tests: expected feature failures.
- [x] Implement planning and atomic linked-run creation; retained rows carry provenance.
- [x] Run tests: all pass; source history and source provider sessions remain isolated.

### Task 3: Spend guard and browser parity

Files: run-controls mirrors, db.rs, engine.rs, backend.ts, commands.rs, main.rs.
Interfaces: continueSpendRun(runId, expectedPauseId, replacementLimit?) and
previewRecovery(runId); runWorkflow gains optional RunOptions.

- [x] Add tests for partial/missing/reused/simulated costs, invalid thresholds,
  drain-before-pause, pure completion, cancellation, restart and duplicate decisions.
- [x] Run tests: expected feature failures.
- [x] Implement dispatch guard and atomic continuation; mirror new behavior in mock.
- [x] Run native/frontend suites: all pass.

### Task 4: Timeline and controls

Files: RunTimeline.tsx, RunControls.tsx, WorkflowsView.tsx, RunsView.tsx,
usage.ts, styles.css and component/helper tests.
Interfaces: shared fixture/run-options editor; per-node recovery choices;
common timestamp timeline with waiting intervals, costs and textual equivalents.

- [x] Add tests for fixture submission, recovery decisions, guard continuation,
  overlapping attempts, approval waits, unknown timestamps and spend coverage.
- [x] Run tests: expected feature failures.
- [x] Implement shared Modal/Notice controls and timeline; exclude test/reused knowledge.
- [x] Run frontend tests/build: all pass.

### Task 5: Release and complete review

Files: version manifests/lock, CHANGELOG, README, execution/cost/schema docs, ROADMAP.

- [x] Document delivered semantics and limitations; synchronize 0.1.11.
- [x] Run pnpm check/build, core tests/Clippy/fmt, desktop check, diff check.
- [x] Self-review the whole branch and obtain a fresh independent review.
- [x] Fix actionable findings with regression tests; rerun affected checks.
- [ ] Commit logical changes, push the feature branch, open and attach the PR.

## Execution ledger

- Baseline: pnpm check passes (15 delivery tests, 231 frontend tests); core tests
  pass (316), Clippy/fmt and desktop check pass. Delivery test Git subprocesses
  require execution outside the sandbox; no code workaround needed.
- Pre-flight: Tasks 2–4 consume the same RunExecution metadata. Runtime schema
  stays v6 because these controls belong to runs, rather than workflow definitions.
- Ruling: work in the dedicated branch in the user's existing checkout; no extra
  worktree was requested and there is no competing checkout to isolate.

- Delivered: all four controls extend the existing engine, result history and Backend.
  Manual/automated defaults stay unchanged; runtime workflow schema remains v6.
- Native scenarios: fixture exhaustion across retries/loop visits and all six
  effectful kinds; sentinel isolation; snapshot/input preservation; explicit choices,
  context/data invalidation and historical approvals; source session/usage stripping;
  guard drain with a fake managed CLI, single continuation, cancellation and reopen.
- Browser verification: dry-run failure, deliberate reuse/skip recovery into a linked
  successful run, preserved history after reload, guard options, and DRY RUN canvas label.
- Independent review: five findings reproduced and resolved with regression tests:
  legacy snapshot fallback, pause publication race, reused findings, integration
  timing, and cancelled managed attempts losing already reported USD.
- Self-review: corrected mock deletion persistence/request cleanup, finalized
  interrupted browser attempt rows, and matched optional JSON-null semantics.
- Release docs: verified published v0.1.10 contains all four installer assets and
  SHA256SUMS; README fallback now points there. v0.1.11 assets remain conditional
  on the future tag workflow. No installer, native GUI or live-provider test claim.
- Final local gates: 336 core tests, four desktop-command tests, 242 frontend tests,
  15 delivery tests; core Clippy, cargo fmt/check, pnpm check/build and version check.
  The build retains the existing advisory about chunks larger than 500 kB.
- Compatibility ruling: ordinary browser sample execution preserves its existing
  lenient availability behavior; the new dry-run/guard entry points perform the
  mirrored structural validation. Browser simulation is not native concurrency proof.
