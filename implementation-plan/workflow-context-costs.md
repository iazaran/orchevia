# Workflow context and cost controls implementation plan

> Execute inline using superpowers:executing-plans. Add regression tests before
> each behavior change; use the existing architecture and perform self-review.

**Goal:** Ship optional reusable sessions and bounded handoffs in v0.1.10.

**Architecture:** Extend NodeConfig, existing CLI adapters, engine capture and
result metadata. Keep the React Backend boundary and browser mock; use existing
prompt/reference remapping for portable authoring.

**Tech stack:** Rust/Tokio/SQLite, TypeScript/React/Vitest, Tauri 2.

**Spec:** `docs/superpowers/specs/2026-10-06-workflow-context-costs-design.md`

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

- [ ] Add failing tests for limits, references, Unicode truncation and JSON round trips.
- [ ] Run targeted Rust/frontend tests and confirm the new assertions fail.
- [ ] Mirror fields/validation and reference remapping; compose marked excerpts.
- [ ] Run targeted suites and resolve regressions.

### 2. Adapter streaming and reusable execution

Files: agents.rs and engine.rs (focused adjacent module if needed), existing result metadata.
Interfaces: explicit session command builder; incremental decoder with readable text,
session id, provider errors and usage; per-run group locks and persisted session identity.

- [ ] Add failing argv/decoder and fake-CLI engine tests for isolation, concurrency,
  turn rotation, error/timeout/retry and approval continuation.
- [ ] Run focused tests, confirming the expected feature failures.
- [ ] Add managed JSONL invocation, decode live/final output and persist metadata.
- [ ] Acquire group locks before lookup, rotate at limits and invalidate failed attempts.
- [ ] Run engine/adapter suites and preserve legacy text/custom command behavior.

### 3. Portable generation and browser mock

Files: generation.rs, src/lib/generation.ts, backend.ts, templates mirrors.
Interfaces: proposal fields survive compile/assistance; mock output/status/context/session
semantics match native, with simulated ids and no provider-spend claims.

- [ ] Add failing remapping/proposal/mock regression tests.
- [ ] Run targeted suites; then extend existing compilation and mock execution paths.
- [ ] Update generator/assistance guidance for compact handoffs and per-item grouping.
- [ ] Run native/frontend generation, template and backend suites.

### 4. Inspector and wizard profiles

Files: NodeInspector.tsx, agents.rs/agents.ts, OnboardingWizard and colocated tests.
Interfaces: editable group/turn/context controls; exact recommended general profile.

- [ ] Add failing inspector editing and recommendation/preservation tests.
- [ ] Run targeted tests; implement controls using existing inputs and patch helpers.
- [ ] Add generalPurpose role and Opus/medium recommendation, preserving existing names.
- [ ] Run component/profile tests and inspect browser mock presentation.

### 5. Release and complete review

Files: CHANGELOG, README, area docs, application/Tauri/core manifests and Cargo.lock.

- [ ] Document controls, examples, reset/retry behavior and cost measurement limits.
- [ ] Synchronize 0.1.10 and run pnpm version:check v0.1.10.
- [ ] Run pnpm check/build, core tests/Clippy/fmt, desktop check/tests and diff check.
- [ ] Self-review whole diff for correctness, privacy, parity and existing behavior.
- [ ] Commit logical changes, push only after local gates, open and attach the PR.
