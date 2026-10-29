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
  Nodes unreachable from Start remain validation warnings, receive a durable
  skip, and do not prevent connected paths or joins from completing. Resuming
  an approval preserves those skip rows without duplicating them.

## Node behaviors

| Node                | Behavior                                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start` / `end`     | Instant success markers.                                                                                                                                                                                                                 |
| `command` / `agent` | Run a local process with separate arguments (a shell only when explicit), optional bounded retries and per-node timeout up to 12 hours. Commands default to 600 seconds; agents use their profile default. Non-zero exit fails the node. |
| `approval`          | Pauses the run durably (`paused` row + run status `paused`). Resumes via approve (records `approved` + optional note) or fails via reject. Approvals engage only when no other branch is in flight.                                      |
| `condition`         | Evaluates a constrained expression (see below) and routes to the `true` or `false` labeled edge. Missing variables or type errors fail the node.                                                                                         |

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

Structured Agent responses that identify a provider budget/turn limit, or that
lack a completed structured result, are incomplete work. They fail the run without
taking ordinary failure edges, so a publish or approval fallback cannot treat an
unfinished review as clearance. Partial output is preserved. Adjust any provider
profile cap and use deliberate failed-run recovery before replaying such work;
extending an Orchevia attempt budget does not change a provider's own cap.
Explicit local process timeouts retain their configured retry and failure-recovery
behavior; they are distinguished from unexpected missing terminal responses.

## Conditions

Small deterministic formulas: `<variable> <operator> <literal>`, joined by one
logic (`and` / `or`; mixing is rejected). Operators: `==`, `!=`, `contains`,
`not contains`, `>`, `<`, `>=`, `<=`. No scripting, no function calls, no eval.

Namespaces: `workflow.name`, `workflow.id`, `input.<name>` (declared workflow
inputs), `node.<id>`, `node.<id>.output`, `node.<id>.status`,
`node.<id>.exitCode`, `node.<id>.severity`, `node.<id>.visits`. Unknown names
fail validation (`condition-unknown-ref` / `prompt-unknown-variable`) and, if
somehow reached at runtime, fail the node instead of guessing a branch.

`node.<id>.severity` is the highest severity an Agent step reported. ```finding
blocks win when present; otherwise a `P0`–`P3` tag in the prose counts unless it
names the scale (`P0–P3`) or is negated right before it (`no P1`, `zero P0 or
P1`, `no blocking (P0/P1)`), so "No P0/P1 issues found" reports nothing while
"Found P0/P1 issues" reports P0. When in doubt it reports the tag rather than
hiding it. A review with no findings reads as an empty string, so `severity
contains P1` is simply false, and a later visit replaces an earlier one.

## Retries

`retry: { maxAttempts: 1–10, delayMs: 0–60000, backoff: bool }`. Every attempt
is a history row: non-final failures are `retrying`, the final one is
`succeeded`/`failed`. Backoff doubles the delay per attempt (capped at 60 s).
Delays are cancellation-aware. Timeouts count as failures and are retried under
the same policy. A Claude node whose tool calls were refused
([refused tool calls](agents.md#refused-tool-calls)) fails without automatic
retries, because the same profile would be refused again. Its failure route still
runs.

## Loops

Review/fix pattern: `… → review → condition(true → fix → review, false → end)`.
Each loop-back needs `maxVisits >= 2` on the cycle nodes; exceeding it fails the
run with `Loop limit exceeded`. While a loop can still go round, edges that leave
it stay pending: the pass that takes one resolves it, and the ones left are
skipped once every step of the loop has finished, so exits are never skipped
prematurely. This also holds when the condition's taken branch loops back through
another step (`condition -true-> fix -> tests -> … -> condition`) and for failure
routes out of the loop; branches inside the loop resolve as usual. When several
reviewers feed the condition, loop the fix back to all of them
so none keeps a stale finding. Side nodes off the cycle path run once (documented limitation: put
per-iteration work on the cycle with its own bound).

Each pass decides the steps after the loop again (since 0.1.23). A step the
previous pass skipped downstream of the loop, such as a failure route that pass
did not take or the steps after a condition a failure skipped, runs if the next
pass takes it. Each edge counts once per pass, so a step's second visit is not the
arrival of another branch at a join after the loop. A step that fails when its only
failure route already ran fails the run.

`node.<id>.visits` exposes completed visit counts for loop-exit conditions.

### Nested loops

A loop can run inside another (since 0.1.24), for example a fix loop inside a
review loop:
`… → tests → gate(true → fix → tests, false → review) → again(true → tests, false → publish)`.
The outer loop may go back to the inner loop's first step, as here, or to a step
before it.

- A loop is the steps its loop-back repeats. An inner loop is only its own
  steps; an outer loop includes the loops inside it.
- Leaving the inner loop is an exit even though the path comes back through the
  outer loop: while the fix loop goes round, `review` waits instead of being
  skipped. The steps after the outer loop, including a join fed by another
  branch, wait for the outer loop's last pass.
- Going round the inner loop re-runs only its steps; going round the outer loop
  re-runs everything inside it, inner loop included.
- `maxVisits` and `node.<id>.visits` count the whole run, not one outer pass. An
  inner step's bound must cover all its rounds on every outer pass; the pass
  that goes over fails the run with `Loop limit exceeded`.
- A failure route that leaves both loops ends them: the steps after the loops
  that it does not lead to are skipped.

## Parallelism

Up to 4 nodes execute concurrently per run (separate processes; SQLite writes
serialize briefly on the DB mutex). Cancellation and fail-fast propagate via a
shared flag that stops in-flight children. On Linux and macOS every child leads
its own process group: cancel and timeouts send `SIGTERM` to the group, allow 2 s,
then `SIGKILL` the rest, so descendants (shells, MCP servers, `npx`/`uvx`) stop
with it and partial output is kept. A normal exit does not signal the group.
Command and Agent stdout/stderr snapshots are stored in the running node row about
every 250 ms when output changes. The Runs view polls while a run is running or
paused (every 1.5 s); a finished selected run is not reloaded unless its results can
still change. Canvas overlays show status badges rather than log tails.

A run's page opens with its facts (start, duration, step count with skipped and
failed steps, agent attempts, cost on your plans and API value), then a
**Report** taken from the step that leads straight to an End node (a summary
step), falling back to the last agent output. Leading `Key: value` and
`KEY=value` lines show as a two-column list; the rest is formatted text. A
failed run's report names the step it stopped at, or the approval that was
rejected. Condition and approval steps never supply the report themselves. The timeline and each step
card carry the same step number; every step is its own card with its status
colour down the left edge, and its controls (such as saving a command to the
project playbook) stay inside that card.

Command and Agent output is capped at 200,000 characters per stream; capture
retains at most 800,004 bytes per stream to accommodate UTF-8. Additional output
is drained and discarded while still extending an output-sensitive deadline.
Blocking CLI calls (including workflow generation) drain both streams while the
child runs and retain at most 256 KiB per stream. Truncated output carries a
visible marker and never splits a UTF-8 character.
After the direct child exits or is stopped, blocking calls drain for at most two
seconds, preserving captured output even when a descendant holds the pipes open.
MCP exchanges never wait on such a pipe: a timeout or cancel returns once the
server's group is stopped.

Claude and Codex prompts are written to the CLI's stdin, which is then closed; a CLI
that exits without reading it does not delay the node. Children receive the search
`PATH` resolved from your login shell (see [agents.md](./agents.md)).

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
checks: required inputs supplied, referenced Agent Profiles exist with executable
CLIs on the search `PATH` (login shell `PATH`, Orchevia's own `PATH` and common
install directories), condition/prompt variable references resolve, true+false branches
present, label placement, cycle guards and bounds, retry/timeout bounds, input
name validity and uniqueness. See `workflow-schema.md` for the code list.

## Inbox and run graphs

Inbox shows unread notifications by default. Mark read removes an item from
that view; Show read history makes it accessible again. Open run retrieves that
specific run directly, including runs beyond the recent list, and opens it in
Runs with its details selected; the selection survives list refreshes. A
successful navigation marks the item read; errors remain visible and leave it
unread. Show on canvas in Runs opens the same run's saved graph and results as
a read-only overlay instead. Run graphs are read-only snapshots and refresh
their outputs while displayed.
Use Edit saved workflow to return to the editable definition. Historical runs
created before snapshots use the saved definition as their existing fallback.

## Agent context controls

Optional session groups serialize related Agent turns within a run and exact
profile/directory. Only completed successful explicit CLI sessions are reused.
Failed resumed turns bypass automatic retries; later group members start fresh.
Selected completed-node handoffs have a combined excerpt budget; stored logs remain
available. See [workflow cost controls](workflow-costs.md) for limits and examples.

## Dry-run workflow tests

Select **Dry run** in Workflows, review the inputs and edit the fixture JSON.
Fixtures are keyed by node id; each array supplies successive attempts/visits:

```json
{
  "review": [
    {
      "status": "succeeded",
      "stdout": "needs fixes",
      "structured": { "severity": "P1" }
    },
    { "status": "succeeded", "stdout": "ready", "structured": { "severity": "P2" } }
  ],
  "approval": [{ "status": "paused" }],
  "fix": [{ "status": "succeeded", "stdout": "fixed" }]
}
```

Commands, Agents, Git, GitHub, Ticket and MCP nodes use fixtures before any tool,
profile or directory lookup. Start/End/Condition nodes use the ordinary scheduler.
Every reached effectful attempt needs a fixture; exhaustion records a failure and
never invokes a real tool. A missing Approval fixture pauses for a human decision;
provided Approval fixtures use `approved`, `rejected` or `paused`. Each effectful
fixture uses `succeeded` or `failed`; stdout/stderr, exitCode and structured output
are optional. Reserved session/usage/provenance metadata is rejected. Bounds:
1000 fixture attempts per node, 800000 output/structured bytes per fixture.

Normal structural validation, required inputs, failure routing, retry policies,
joins and loop limits apply. Supplied fixtures and execution mode persist through
approval/restart continuation. Test runs are labeled **DRY RUN** and remain
inspectable, but cannot supply actual spend, actionable findings or verified
playbook commands. Fixtures verify the supplied scenario, not real tool behavior.
The browser follows these routing scenarios but does not prove native concurrency.

## Recovering failed runs

Select a failed run and choose **Recover failed run**. Review a choice for every
potential tool step, including dormant branches: **Reuse successful output**,
**Execute again**, or **Skip this step**. Failed/cancelled invocations may have
partially written files or external state; explicit replay is your decision to
execute again. Skips supply no successful output and can skip downstream work.

Recovery creates a linked run from the original snapshot and input values. The
source is unchanged. Legacy history without an original snapshot cannot be recovered.
Failed/cancelled work invalidates graph and data dependents,
including context/input handoffs and loop cycles. Changing an upstream choice to
replay or skip also prohibits dependent reuse. Retained results enter routing
when ready, so joins still wait correctly; unaffected completed approvals are
historical reuse, while affected approvals ask again. Reused Agents never import
source provider-session metadata. Unavailable additional visits fail instead of
silently replaying a tool. Repeated requests with the same recovery request id
return the existing child; conflicting decisions are rejected.

## Timeline, spend and usage pauses

Runs places attempts and repeated visits on a common timestamp axis. Concurrent
bars overlap; elapsed time comes from run start/end instead of summed durations.
Approval and spend waiting extend to the decision or terminal run timestamp.
Unknown timing is labeled, and reused outputs appear as historical reuse with no
new duration. Older integration rows with only measured duration show that duration
with an unknown axis position. Output links scroll to the existing result details.

The optional [reported-spend guard](workflow-costs.md#reported-spend-guard) creates
a distinct durable pause. Ordinary Approve cannot bypass it. Review the spend
pause to increase the threshold or explicitly continue without it; Cancel remains
available. Pure graph completion after the final tool can finish without a pause.

The [workflow usage budget](workflow-costs.md#workflow-usage-limits-v0114) works
the same way for dispatched Agent attempts: exhaustion records a `guardPaused`
usage row (never a success marker) and pauses durably. Review the usage pause to
extend the budget explicitly or continue without the guard; ordinary approval
cannot clear it, and stale or duplicate continuations are rejected. Budget-limited
reviews contribute no findings, approvals or publications for unfinished work.

## Reading run output and findings

Long stdout, stderr and agent activity use **Show full output** rather than a
newline count, since one source line may wrap across many screen lines. Expanding
output scrolls to its latest text. While a step is running, new text keeps the
expanded viewport at the bottom. Scroll up to read earlier text without being
pulled down; **Follow latest** resumes following. Each stream has its own bounded
viewport, including formatted and raw Markdown.

Review findings appear inside each source agent's latest successful step, matching
the backend's finding extraction. Findings shared by several agents appear at each
source step with their deduplicated attribution. Findings whose sources cannot be
matched to a stored step remain visible in a separate fallback section. Long text,
paths, suggested fixes and Markdown code/tables wrap instead of widening the page.
