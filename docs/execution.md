# Execution semantics (workflow engine v3)

This document is the contract for how Orchevia runs workflows. The persisted
workflow definition captured when the run starts is the source of truth;
canvas positions never affect execution.

## Graph rules

- **Entry:** exactly one `start` node. Validation rejects zero or multiple.
- **Acyclic by default:** any cycle must pass through a `condition` node (loop
  guard) and every node on the cycle must set `maxVisits >= 2` (explicit bound,
  max 100). Otherwise validation fails with `cycle-needs-condition` /
  `cycle-unbounded`. Loop edges into `end` are rejected.
- **Scheduling:** a node runs when all its non-loop incoming edges have
  resolved (a join waits for every branch) and at least one was taken. Loop-back
  edges never gate readiness; a taken loop edge re-arms its target's cycle.
- **Determinism:** ready nodes start in workflow definition order. Parallel
  branches run concurrently (bounded, see below) so _completion_ order varies,
  but routing decisions are pure functions of recorded results.
- **Skips are records:** untaken branches are recorded as `skipped` node
  results (visible on canvas overlay and in run history), never silent gaps.

## Node behaviors

| Node                | Behavior                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start` / `end`     | Instant success markers.                                                                                                                                                                            |
| `command` / `agent` | Run a local process (no shell), optional bounded retries, optional per-node timeout (1–3600 s, default 600). Non-zero exit fails the node.                                                          |
| `approval`          | Pauses the run durably (`paused` row + run status `paused`). Resumes via approve (records `approved` + optional note) or fails via reject. Approvals engage only when no other branch is in flight. |
| `condition`         | Evaluates a constrained expression (see below) and routes to the `true` or `false` labeled edge. Missing variables or type errors fail the node.                                                    |

## Edge labels (routing)

| Label               | Meaning                                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| _(none)_, `success` | Taken when the source succeeds.                                                  |
| `failure`           | Taken when the source fails (recovery path).                                     |
| `true` / `false`    | Taken when a `condition` evaluates accordingly. Only valid on condition outputs. |

A failed node with no taken `failure` edge fails the run immediately
(fail-fast: siblings are cancelled). A failed node _with_ a failure edge keeps
going — the recovery branch is a normal path from there. Unknown labels warn at
validation and behave as success edges.

## Conditions

Small deterministic formulas: `<variable> <operator> <literal>`, joined by one
logic (`and` / `or`; mixing is rejected). Operators: `==`, `!=`, `contains`,
`not contains`, `>`, `<`, `>=`, `<=`. No scripting, no function calls, no eval.

Namespaces: `workflow.name`, `workflow.id`, `input.<name>` (declared workflow
inputs), `node.<id>`, `node.<id>.output`, `node.<id>.status`,
`node.<id>.exitCode`, `node.<id>.severity`, `node.<id>.visits`. Unknown names
fail validation (`condition-unknown-ref` / `prompt-unknown-variable`) and, if
somehow reached at runtime, fail the node instead of guessing a branch.

## Retries

`retry: { maxAttempts: 1–10, delayMs: 0–60000, backoff: bool }`. Every attempt
is a history row: non-final failures are `retrying`, the final one is
`succeeded`/`failed`. Backoff doubles the delay per attempt (capped at 60 s).
Delays are cancellation-aware. Timeouts count as failures and are retried under
the same policy.

## Loops

Review/fix pattern: `… → review → condition(true → fix → review, false → end)`.
Each loop-back needs `maxVisits >= 2` on the cycle nodes; exceeding it fails the
run with `Loop limit exceeded`. While a loop continues, sibling (exit-path)
edges stay pending — they resolve on the exit visit, so exits are never skipped
prematurely. Side nodes off the cycle path run once (documented limitation: put
per-iteration work on the cycle with its own bound).

`node.<id>.visits` exposes completed visit counts for loop-exit conditions.

## Parallelism

Up to 4 nodes execute concurrently per run (separate processes; SQLite writes
serialize briefly on the DB mutex). Cancellation and fail-fast propagate via a
shared flag that kills in-flight children. Command and Agent stdout/stderr
snapshots are stored in the running node row about every 250 ms when output
changes. The Runs view polls the stored rows every 1.5 s; canvas overlays show
status badges rather than log tails.

Command and Agent output is capped at 200,000 characters per stream; capture
retains at most 800,004 bytes per stream to accommodate UTF-8. Additional output
is drained and discarded while still extending an output-sensitive deadline.
Blocking CLI calls (including workflow generation) drain both streams while the
child runs and retain at most 256 KiB per stream. Truncated output carries a
visible marker and never splits a UTF-8 character.
After the direct child exits or is killed, blocking calls drain for at most two
seconds, preserving captured output even when a descendant holds the pipes open.

## Approvals, recovery, restarts

- Command and Agent results appear as `running` rows before completion;
  final status and output replace the same row. Other results (including
  `retrying`, `skipped`, `paused`) are written before routing continues. Resume
  replays terminal history only.
- `paused` runs survive app restart and resume via approve/reject (with optional
  annotating note stored on the decision row).
- Approval decisions atomically claim a currently paused run and record the
  decision. Repeated or concurrent decisions are rejected; cancelling a paused
  run prevents later approval. Downstream work starts once after approval.
- The UI sends the paused result row's ID with each decision. The transaction
  checks that ID against the current gate, so a delayed duplicate cannot approve
  another gate or a later visit to the same gate. Core callers may omit the ID
  when deliberately deciding whichever gate is currently paused.
- New runs persist an immutable workflow definition and use it when resuming,
  so later saved edits affect future runs. Older runs without a snapshot use
  the current saved definition; their original definition cannot be recovered.
- Workflow deletion is refused while it has running or paused runs. Deleting
  an inactive workflow also deletes its finished run history and node results.
- Runs still `running` at startup are marked `failed` ("application restarted…"):
  their child processes are gone and silently resuming external work is unsafe.
  Any `running` node result is also marked failed while its captured output is
  preserved.
- `retrying` rows are intermediate: a restart during a retry delay re-runs the
  node from attempt 1 (prior attempts stay visible in history).

## Validation before execution

Errors block `start_run`; warnings don't. Beyond the schema rules, the engine
checks: required inputs supplied, referenced Agent Profiles exist with CLIs on
`PATH`, condition/prompt variable references resolve, true+false branches
present, label placement, cycle guards and bounds, retry/timeout bounds, input
name validity and uniqueness. See `workflow-schema.md` for the code list.
