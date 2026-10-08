# Workflow testing, recovery and observability — v0.1.11 design

Status: approved on 2026-10-08. The user selected all four saved ideas and
authorized inline implementation with routine decisions made autonomously.

## Intent and constraints

Help workflow authors test routing without tool calls, recover failed work
deliberately, understand elapsed time, and limit further dispatch using available
cost reports. Build on the existing engine, SQLite run snapshots, result rows,
Backend interface, thin Tauri commands and shared UI components. Preserve current
execution defaults and the runtime workflow schema v6.

Use additive persisted run metadata for execution mode, recovery provenance and
spend controls. Mirror every public field and error condition in TypeScript and
the browser backend. Existing runs migrate to ordinary execution with no guard.
All optional controls remain off for existing manual and automated runs.

## Selected approach

Extend the authoritative scheduler and its existing history replay; do not create
a second native workflow executor. Extend the existing browser simulator to cover
the new routing scenarios, with tests comparing observable contracts. Browser
execution remains explicitly simulated and cannot certify native concurrency.

A separate simulation engine would make routing drift likely. Merely extending
the current browser `orderOf` traversal cannot test native loops or joins. Those
approaches are rejected in favor of the existing core scheduler.

## 1. Fixture-driven dry-run

Add an explicit Dry run action beside workflow execution, using the selected
workflow snapshot and normal input defaults/required-input checks. An editable,
validated fixture document maps node ids to successive visit/attempt results.
Each supplied result includes a success/failure status, stdout/stderr, optional
exit code and structured output. Approval scenarios may approve, reject or pause.
Fixture editing starts with the workflow's effectful node ids and clear examples.

Start, End and Condition retain native graph behavior. Every Command, Agent, Git,
GitHub, Ticket and MCP execution must enter the fixture path before profile lookup,
directory access, executable discovery, process creation or integration calls.
No fixture for a reached visit/attempt means a recorded failure with a clear
message; never repeat the last fixture or fall back to real execution. Structural
validation and bounded retry/loop policies still apply. Fixtures do not require
installed CLIs, authenticated integrations or existing local directories.

Persist fixtures with the run so approval/restart continuation cannot change
execution mode or use real tools. Reserved metadata is engine-owned; fixture
structured output cannot forge actual spend, sessions or recovery provenance.
Dry-runs are labeled in lists, details and overlays, and remain inspectable as
test history. Exclude them from actual usage, verified project knowledge,
workflow-assistance failure selection, actionable findings and automation claims.
They verify supplied scenarios, rather than tool correctness or all graph paths.

## 2. Deliberate failed-step recovery

Offer Recover on failed runs. Preview the original immutable snapshot, inputs,
failure, reusable outputs and affected steps. A new linked run leaves the source
history unchanged; recovering never uses the currently edited workflow.

Compute invalidation from graph edges and data references, including condition
inputs and prompt/context references. Treat connected loop cycles as a unit when
invalidating affected visits. Joins wait for the appropriate retained or replayed
branches. Preserve completed, unaffected visits with their routing decisions;
never seed a downstream output whose prerequisites have been invalidated.

The preview requires a per-step decision for every previously attempted effectful
step that could be encountered again: reuse valid success, replay, or explicitly
skip. Failed/cancelled attempts may have changed files or external state, so they
require replay/skip decisions too. Reuse is disabled for failed, cancelled or
invalidated outputs. Explain that skipping supplies no success output and may
skip dependent work or fail an expression that needs that output.

Include newly reached effectful branches in the preview's explicit execution
scope. Automatically recompute deterministic graph markers/conditions as needed;
do not reuse obsolete approval decisions for affected work. Previously completed
unaffected approvals remain historical decisions. New agent execution starts
fresh: copied output does not imply a provider session is resumable.

The core validates the submitted decisions against a freshly computed plan before
creating the linked run. Creation plus retained results must be atomic. Reused
rows identify the source result and are marked historical reuse; their durations
and costs do not count as new execution. An invalid or stale plan starts nothing.
Repeated recovery requests must not accidentally start duplicate recoveries.

## 3. Run timeline

Add a bounded, scrollable timeline to Runs using persisted timestamps and result
rows, with one row for each attempt/visit. Use a common time axis so concurrent
work overlaps visibly. Show status, node label, attempt, duration, exact timestamp
tooltips, and links to existing output details. Include running intervals and
approval waiting until the corresponding decision/cancellation. Display missing
or invalid timestamps as unknown instead of inventing timing.

Run elapsed time comes from run start/end, never the sum of node durations.
Recovered outputs appear as reused history rather than new execution bars.
Show CLI-reported USD only when present, counting each execution attempt once.
Identify partial coverage and missing Agent cost reports; distinguish dry-run
fixtures from actual spend. Provide accessible text equivalents and preserve the
existing light/dark CSS-variable conventions.

## 4. Optional reported-spend guard

Allow a positive, finite USD threshold in the manual run options, disabled by
default. Persist it with the run. Use only validated, nonnegative structured
`agentUsage.reported_cost_usd` from actual new execution attempts. Do not infer
dollars from tokens or stdout patterns. Claude currently reports this field for
managed result streams; Codex/custom/legacy text execution may have no USD report.
Show coverage explicitly and warn in the control that missing costs cannot stop
dispatch. Dry-run fixture costs never contribute to actual spend.

When reported spend reaches the threshold, stop dispatching further effectful
nodes. Drain already running siblings, preserving outputs, then pause durably
only if more effectful work remains. Pure graph completion may finish the run
without a meaningless final pause. Record a guard pause distinctly from a
workflow Approval so continuation never fabricates node success or changes a
Condition branch.

Offer explicit Continue with a higher threshold or Continue without guard, plus
Cancel. Validate a replacement threshold above the currently reported total;
reject stale or duplicate decisions atomically. Persist the new choice across
restart and approval continuation. Keep partial/unknown totals visible throughout.
Already dispatched work and end-of-invocation reports can overshoot; this is a
dispatch guard, not a universal billing cap or subscription-quota meter. Native
provider budget flags are outside this change because they have different billing
and invocation semantics.

## Delivery and verification

Implement in dependency order: additive run contracts/persistence, dry-run routing,
recovery planning/execution, spend pauses, then timeline and integrated controls.
Add regression tests before each behavior change, using existing colocated suites
and fake-CLI engine fixtures. Test parallel joins, loop visits, retries, missing
fixtures for every effectful kind, cancellation, restart/approval continuation,
snapshot edits, dependent-output invalidation, stale decisions, and absent/partial
cost reporting. Prove dry-run side-effect isolation with sentinel files/tools.

Update CHANGELOG.md, README.md, docs/execution.md, docs/workflow-costs.md,
docs/workflow-schema.md, ROADMAP.md and implementation-plan notes with actual
delivered behavior. Synchronize package/Tauri/core/Cargo.lock versions to 0.1.11.
Run pnpm check/build, cargo test -p orchevia-core, core Clippy with warnings denied,
cargo fmt --check, cargo check -p orchevia, and git diff --check. Perform a complete
self-review before committing, pushing and opening the PR. The user owns merging;
installer availability is not asserted without release-asset verification.
