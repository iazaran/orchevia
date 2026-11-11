# v0.2.0 plan: readable runs, live step feedback, remaining reliability gaps

Application version `0.1.24` → `0.2.0`. This note is the plan written before the
work; section 9 is rewritten at the end to record what shipped.

## 0. Starting point (verified in code, 2026-11-11)

- The engine rebuilds a run's routing state by replaying its stored results in
  the order they finished (`execute_inner`). Every resume (approval, spend or
  usage continuation) goes through that replay, so anything that changes
  routing must be written as a row and replay to the same state.
- Recovery (`recover_run`) creates a **new** run from a **failed** one, seeded
  with reused results. `run_controls::invalidated_nodes` computes the
  downstream closure over edges, `contextRefs`, `inputRefs` and `{{node.X…}}`
  references.
- Approvals engage only when nothing else is in flight; spend and usage
  guards pause durably (`RunExecution.spendPause` / `usagePause`).
- At startup, `running` runs are marked failed and their `running` rows failed
  (`src-tauri/src/main.rs`).
- There is no native Git push. The built-in templates push with a Command step
  (`push_branch` in `templates.rs`). GitHub writes are `CreatePr` and
  `PostComment`. MCP tools have no read/write classification.
- Agent output: `AgentOutput` keeps `activity` (text lines, "Tool: Name"), the
  final text, usage, refusals and tool counts. Live rows are rewritten every
  250 ms with the activity text only.
- v0.1.24 already shipped the agent setup check, 61-code validation parity,
  nested loops, `docs/smoke-tests.md`, macOS cleanup tests and the CLI canary.

## 1. Readable runs

**Core.** `AgentOutput` also collects a bounded digest from the CLI's own
events, stored as `agentDigest` result metadata and refreshed on the live row:

- `files`: paths from Claude `Edit`/`Write`/`MultiEdit`/`NotebookEdit` tool
  inputs and Codex `file_change` items (at most 100);
- `commands`: shell commands from Claude `Bash` inputs and Codex
  `command_execution` items, with the exit status the CLI reported (Codex
  `exit_code`; Claude `tool_result.is_error`), flagged `test` when the command
  is a known test runner (at most 60);
- `todos`: the latest Claude `TodoWrite` list or Codex `todo_list` (at most 40);
- `doing`: the most recent meaningful action ("Editing src/a.ts", "Running
  cargo test", "Reading …", "Searching …", an agent message), for live steps;
- event shapes checked against recorded Claude Code and Codex streams kept as
  test fixtures.

**UI.** A pure `src/lib/step-summary.ts` turns a result row plus its step into:
purpose (step label, kind, first line of the prompt, command or operation),
what it is doing now (live), outcome facts (files changed, tests with their
result, findings, decision, blockers) and execution labels (attempt N of M,
visit N, reused from run X, simulated, correction for feedback #N). Facts come
only from exit codes, parsed test summaries, recorded tool inputs and finding
blocks; text the agent wrote about itself is labelled as the agent's words.

`RunsView` step cards lead with that summary. Commands, stdout, stderr, agent
activity and CLI usage move under one **Details and log** disclosure per step
(open by default for a failed step and while a step is running and followed).
Errors, refused tools, findings and feedback stay outside it. The run header
gains a progress line (done, running, skipped, still to run) and the steps
running now, including parallel ones. Old runs without a digest fall back to
today's output view.

## 2. Publication steps

- `NodeConfig.publishes: Option<bool>` (optional, schema stays 6). A step
  publishes when `publishes` is true, or when it is a GitHub `createPr` or
  `postComment` that does not set `publishes: false`.
- Validation warning `publish-unmarked` on a Command step whose argv plainly
  publishes (`git push`, `gh pr create|comment|merge|review`, `gh release
  create`, `glab mr create`, `npm|pnpm|yarn publish`, `cargo publish`) without
  the marker. Mirrored in TS with parity fixture cases.
- Built-in templates mark their push steps; `compile_proposal` marks generated
  Command steps that match the same rule, so drafts need no new field.
- The inspector shows a **Publishes** switch on Command, Git, GitHub and MCP
  steps.

## 3. Step feedback: storage and rules

- Table `run_feedback` (run, step, the result row it was written on, text ≤
  4000 characters, status, decision, the agent step that handled it, check and
  correction result ids, round, carried-from id, timestamps). At most 50 items
  per run.
- Statuses: `pending`, `checking`, `satisfied`, `correcting`, `addressed`,
  `needs-attention`, `late`, `not-processed`.
- Feedback is accepted only while the run is `running` or `paused`, on a step
  that has started. It never touches the saved workflow or another run.
- **Cutoff.** `RunExecution.feedback.publicationStarted` records the first
  publication step's dispatch. Submission and that claim each run under the
  database connection lock: feedback that lands before the claim is `pending`
  and blocks the claim; feedback after it is `late` ("arrived after *Push
  branch* started"), recorded and never processed automatically.
- **Startup.** The interrupted-run sweep moves into core
  (`SqliteDb::close_interrupted_runs`): open feedback of a run marked failed
  becomes `not-processed`, and a `running` feedback-check row becomes a closed
  check, never a failed visit.
- **Recovery** carries `not-processed` feedback into the new run as `pending`,
  linked by `carriedFrom`.

## 4. Step feedback: processing

- **Checkpoints** are publication steps, Approval steps and End. While feedback
  is `pending`, a ready checkpoint is held; other ready work keeps running.
  When nothing is in flight and only checkpoints are ready (or the run is about
  to finish), the engine runs a feedback round.
- **Who checks.** An Agent step checks feedback on itself. Feedback on any
  other step goes to the nearest upstream Agent step it depends on (edges,
  then data references). With none, the item needs attention.
- **Check.** One CLI call per target step with a fixed prompt: the step's
  instructions, its latest result, the feedback quoted as user text, and an
  instruction not to change anything. The reply ends with an
  `orchevia-feedback` JSON block: `satisfied` (with an explanation) or `change`
  (with what to change). Missing or unparseable output, a failed call, or a
  check that edited files counts as needs attention, never as satisfied. Check
  rows use the new non-terminal status `checked`, so replay never routes them,
  while attempt budgets and reported spend count them.
- **Correction.** When any target needs a change, one marker row (step
  `__feedback`, status `correcting`, metadata `feedbackRound` with round,
  targets, roots and affected steps) resets routing for the targets and their
  downstream closure (the `invalidated_nodes` relation), re-arms each affected
  step's visit allowance, recomputes arrivals from unaffected steps, and gates
  the affected steps until the root targets finish. The root targets run again
  through the normal scheduler with the feedback, the check's requested change
  and the previous result appended to their prompt; their rows carry
  `correction` metadata. Affected steps then rerun by normal routing;
  unaffected results stay. Replay applies the marker row at the same point.
- **Same run.** Corrections stay in the run the feedback was given on;
  `recover_run` is not used.
- **Approvals.** No new approval. An already-decided Approval step inside the
  affected set is asked again; one outside keeps its decision.
- **Bounds.** `WorkflowLimits.maxCorrectionRounds` (1–5, default 2). Reaching
  it with feedback still pending, a check needing attention, or a failed
  correction pauses the run before the checkpoint (`RunExecution.feedback.pause`,
  the spend/usage pause pattern). **Continue** proceeds as it is; cancel stops.
- **Accounting.** Checks and corrections count toward the agent-attempt budget
  and spend guard like any attempt; unknown usage stays unknown. Dry runs use
  fixtures (`feedback:<agentStepId>` for checks; corrections take the step's
  next fixture).
- **Run end.** Items still open when a run fails or is cancelled become
  `not-processed` (or `needs-attention` when their correction failed).
- **Mock.** `replayGraph` applies the marker row and gate; the mock processes
  feedback at the same checkpoints (a browser-only check that always asks for a
  change, said so in its explanation).

## 5. Feedback UI

- **Feedback** on each started step of a running or paused run opens a
  composer that states when it will be checked.
- Each step card lists its feedback with status, decision and links to the
  check and correction rows. The run header summarises open feedback, the next
  checkpoint and late items.
- A feedback pause has its own **Review feedback pause** dialog (continue as it
  is, or cancel the run).

## 6. Reliability gaps

- **MCP Check server:** command found, server started and initialized, tools
  listed, required tools present (from saved workflows' MCP steps); each
  failure names its next action. Never calls a tool, bounded (45 s),
  cancellable, off the UI thread, only on click; mock twin.
- **Validation:** new codes on both sides with parity cases; re-audit Templates
  "setup needed" against execution validation; keep `cycle-needs-condition`
  lenient for inner cycles (documented).
- **Coverage:** engine tests for every feedback path (satisfied, change, a
  Command step's feedback, parallel branch untouched, submit/claim race, late
  feedback, feedback during a correction, round limit and pause, approval
  re-asked, replay after an approval inside a correction, nested loops, cancel
  during a check, restart, recovery carry-over, dry-run fixtures, accounting);
  matching vitest cases for the mock replay; dry-run recipes for bug fix →
  tests → review, PR review and scheduled maintenance.
- **Smoke matrix:** v0.2.0 rows, including the first in-place update from
  0.1.24.

## 7. Commits

1. Dependency refresh.
2. This plan.
3. Agent digest (core) and readable step cards (UI).
4. Publication marker, validation and templates.
5. Feedback storage, cutoff, startup sweep and recovery carry-over.
6. Feedback engine (checks, corrections, replay, pause) and mock twin.
7. Feedback UI.
8. MCP check.
9. Coverage and recipe fixtures.
10. Docs and smoke matrix.
11. Version 0.2.0.

## 8. Known limits (expected)

- Commands, custom CLIs, MCP tools and agents can publish without the marker;
  Orchevia cannot see that.
- Feedback cannot reach a CLI process that is already running; it waits for the
  next checkpoint.
- A check asks the agent not to change anything but cannot enforce it; a check
  whose recorded tool use shows an edit needs attention.

## 9. Outcome

To be written when the work is done.
