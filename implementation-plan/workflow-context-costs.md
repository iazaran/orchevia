# Workflow context and cost controls implementation plan

> Add regression tests before each behavior change; use the existing
> architecture and review the result before release.

**Goal:** Ship optional reusable sessions and bounded handoffs in v0.1.10.

**Architecture:** Extend NodeConfig, existing CLI adapters, engine capture and
result metadata. Keep the React Backend boundary and browser mock; use existing
prompt/reference remapping for portable authoring.

**Tech stack:** Rust/Tokio/SQLite, TypeScript/React/Vitest, Tauri 2.

## Global constraints

- Optional fields: runtime schema v6 and developer document v1 remain unchanged.
- sessionMaxTurns 1–20, default 4; contextMaxChars 256–64000, default 12000.
- Fresh sessions remain default; no execution/result caching or summarization call.
- Sessions belong to one run, exact profile configuration and canonical directory.
- Failed resumes are surfaced without automatic execution replay.
- General profile: `Claude — General purpose`, `generalPurpose`, `opus`, `medium`.

## Review focus

- An item loop in one directory must use a different group per item.
- Conflicting profile CLI flags must fail before managed session execution.
- Long provider event streams must not lose ids/final messages behind capture caps.
- Approval pauses must recover only the latest reusable successful session.
- Clone/import reference rewriting must preserve escaped placeholders and literals.

## Tasks

### 1. Contract and handoff composition

Files: workflow.rs, prompt.rs, workflow_document.rs, corresponding src/lib mirrors.
Interfaces: optional sessionGroup/sessionMaxTurns/contextRefs/contextMaxChars on
NodeConfig; deterministic bounded handoff composition from completed results.

- [x] Add failing tests for limits, references, Unicode truncation and JSON round trips.
- [x] Run targeted Rust/frontend tests and confirm the new assertions fail.
- [x] Mirror fields/validation and reference remapping; compose marked excerpts.
- [x] Run targeted suites and resolve regressions.

### 2. Adapter streaming and reusable execution

Files: agents.rs and engine.rs (focused adjacent module if needed), existing result metadata.
Interfaces: explicit session command builder; incremental decoder with readable text,
session id, provider errors and usage; per-run group locks and persisted session identity.

- [x] Add failing argv/decoder and fake-CLI engine tests for isolation, concurrency,
  turn rotation, error/timeout/retry and approval continuation.
- [x] Run focused tests, confirming the expected feature failures.
- [x] Add managed JSONL invocation, decode live/final output and persist metadata.
- [x] Acquire group locks before lookup, rotate at limits and invalidate failed attempts.
- [x] Run engine/adapter suites and preserve legacy text/custom command behavior.

### 3. Portable generation and browser mock

Files: generation.rs, src/lib/generation.ts, backend.ts, templates mirrors.
Interfaces: proposal fields survive compile/assistance; mock output/status/context/session
semantics match native, with simulated ids and no provider-spend claims.

- [x] Add failing remapping/proposal/mock regression tests.
- [x] Run targeted suites; then extend existing compilation and mock execution paths.
- [x] Update generator/assistance guidance for compact handoffs and per-item grouping.
- [x] Run native/frontend generation, template and backend suites.

### 4. Inspector and wizard profiles

Files: NodeInspector.tsx, agents.rs/agents.ts, OnboardingWizard and colocated tests.
Interfaces: editable group/turn/context controls; exact recommended general profile.

- [x] Add failing inspector editing and recommendation/preservation tests.
- [x] Run targeted tests; implement controls using existing inputs and patch helpers.
- [x] Add generalPurpose role and Opus/medium recommendation, preserving existing names.
- [x] Run component/profile tests and inspect browser mock presentation.

### 4a. Built-in context defaults (user-requested extension)

- [x] Add sample/template regressions before changing defaults.
- [x] Use bounded relevant predecessor handoffs in new samples/templates.
- [x] Share only related implementation/fix groups; preserve independent reviewers.
- [x] Pin browser built-in definitions to core constructors and verify remapping.

### 5. Release and complete review

Files: CHANGELOG, README, area docs, application/Tauri/core manifests and Cargo.lock.

- [x] Document controls, examples, reset/retry behavior and cost measurement limits.
- [x] Synchronize 0.1.10 and run pnpm version:check v0.1.10.
- [x] Run pnpm check/build, core tests/Clippy/fmt, desktop check/tests and diff check.
- [x] Self-review whole diff for correctness, privacy, parity and existing behavior.
- [ ] Commit logical changes, push only after local gates, open and attach the PR.

## Verification so far

- `pnpm check`: formatting, lint, type checking, 15 delivery tests and 231 frontend tests pass.
- `pnpm build`: passes; existing bundle-size advisory remains.
- `cargo test -p orchevia-core`: 316 pass, including explicit resume, approval recovery,
  profile/directory/run isolation, turn rotation, serialized parallel nodes, timeout
  partial output, failed-resume retry suppression and stream capture limits.
- Core Clippy with warnings denied, Rust formatting, desktop check and 4 desktop tests pass.
- `pnpm version:check v0.1.10` and `git diff --check` pass.
- Browser preview confirms sample session settings and selected bounded context sources.
- Real provider calls, measured billing savings, native GUI and installers were not exercised.

## Independent review and fixes

One fresh whole-branch review identified three issues. Regression tests failed
before each fix and passed afterward: reject alternative Claude session selectors;
provide simulated ticket, severity and visit variables for strict mock rendering;
and reject unsupported bare session aliases in both validators while preserving
escaped placeholders. No Critical or Minor findings remain. The pre-existing mock
parallel/loop scheduling approximation and existing template severity routing were
kept within their current scope; the desktop engine remains authoritative.
