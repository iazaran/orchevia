# v0.1.23 implementation outcome

A report that the Runs page scrolled "to the bottom without end", followed by a
review of the whole application. Application version `0.1.22` → `0.1.23`.
Workflow schema, templates and Simple JSON unchanged.

## 1. The Runs page scroll

**Before.** On a long run (33 steps in the report), the page scrolled past the End
step into blank space and the sidebar moved up with it. v0.1.22 added a
screen-reader label (`.sr-only`, `position: absolute`) to each timeline row. No
ancestor was positioned, so each label was placed against the window at its
static position. The labels of rows hidden inside the capped timeline sat far
below the app, and the document grew to reach them: 1826 px tall in a 768 px
window in the reproduction.

**Now.** `.view`, `.timeline-rows`/`.recovery-steps` and `.table-wrap` are
positioned, so absolutely positioned children stay inside their own scroll area,
and `html, body` have `overflow: hidden`: the app shell owns all scrolling.
`src/styles.test.tsx` loads the real stylesheet into jsdom and checks both. Every
page now measures exactly the window height in the browser mock.

## 2. Loop routing (`crates/core/src/engine.rs`)

`RunState` gains `resolved` (edge id → taken) for the current pass.

- `resolve_edge` takes the edge id and counts an edge once per pass. Before, a
  step's second visit decremented a join's `pending` again, so a join after the
  loop started before its other branch finished.
- `reset_cycle` also re-arms steps the earlier pass **skipped** downstream of the
  cycle, iterating to a fixpoint over steps that a re-armed step leads into. It
  then takes back re-armed steps' arrivals at steps still waiting (`pending > 0`)
  off the cycle. Before, a first pass that failed into the fix step cascaded skips
  through the condition to everything after the loop, and a failure route skipped
  on pass 1 could not be taken on pass 2. Both ended the run as Succeeded.
- A failed step whose taken routes all reached finished steps fails the run ("…
  failed and its failure route already ran").
- `release_waiting_exits` resolves the specific unresolved edges.

Replay (resume after approval or restart) goes through the same functions; a test
pauses and resumes across a re-armed pass.

## 3. Other engine and core fixes

- **Fail-fast results.** The Git and GitHub calls cannot be interrupted, so their
  result is always recorded. Ticket and MCP record `cancelled` only when the call
  did not succeed. Tested with a commit slowed by a `pre-commit` hook.
- **Retries after a usage pause** start after this visit's `retrying` rows
  (`attempts_used_this_visit`).
- **Timeout reasons** are appended after output truncation.
- **Reuse numbering** counts succeeded rows, as the recovery seeds do.
- **Validation** applies `defaults.branch` to blank branch/checkout names and a
  blank PR head, as the engine does.
- **Approvals.** `Engine::claim_approval` records the decision. The Tauri
  `approve_run` spawns the continuation instead of awaiting the whole run.
- **Assistance.** `compile_proposal_inner` takes the saved step ids and skips the
  generator-only "required" checks for them. `CompiledPreview::carried_over`
  (code, step) excludes errors the base workflow already had from
  `blocking_errors`. Optimize restores `required_tools` and keeps the base edges
  when the proposal sends none.
- **Generations.** `update_generation_status` replaces the re-insert that always
  hit the primary key.
- **Git/GitHub.** `worktree_path` resolves relative paths against the repository
  and `~/` against `HOME`. `create_pr` compares the branch part of `owner:branch`.
  `auth_status` reads stdout and stderr and both phrasings ("account x", "as x").
  `GitHubState` omits absent fields.
- **Cron.** Steps use `checked_add`.
- **Conditions.** Tokens carry `quoted` (a quoted word is never `and`/`or`), and
  rendering escapes `\` and quotes connector-like values, on both sides.
- **Shell.** `github_state`, `git_branches`, `git_current_branch`, `usage_summary`
  and `diagnostics_bundle` are `#[tauri::command(async)]`.

## 4. UI

- `DraftText.tsx`: `useDraftText`, `LinesTextarea`, `KeyValueTextarea`. They
  keep the typed draft while it still means the stored value. Used for Command
  args, stage paths, MCP args, profile and MCP server arguments, and inside
  `DirPicker`.
- Runs: running and paused runs read "so far". A paused row's `error` (the
  approval prompt) renders as a hint, and a decided pause reads "waited". The run
  list checks every 10 s while idle. Note, "Copied" and playbook choices are keyed
  by run. Workflow names fall back to the run snapshot. `stepLabel` and
  `timelineBarStatus` live in `run-report.ts`.
- Dialogs: `ConfirmHost` renders last, alert dialogs stack at z-index 60, the
  backdrop closes only on a press that starts on it, the opener is read during the
  first render, and a replaced confirmation resolves `false`.
- Editor: one `onDelete` handler with `removeFromWorkflow` (drops references), the
  only Start/End are `deletable: false`, input rows are keyed by position with a
  unique new name, and number fields accept only whole numbers.
- Schedules: whole-number checks, and the preview clears on a timezone change.
- Mock backend: persists schedules, watchers, notification prefs and custom models
  (as settings). It checks MCP servers and custom models, previews an empty prompt
  with a placeholder, and records the approval prompt in `error`.

## Deferred

- `validateWorkflowLocal` still lacks several Rust codes (cycle, unreachable,
  dead-end, git/GitHub op fields, edge labels). It only affects `pnpm dev` and the
  Templates "setup needed" list; it needs a parity fixture shared by both sides.
- "Save as template" accepts a workflow that "Use template" later reports as
  unfinished. This may be intended, since templates can carry setup work.
- Nested loops remain imperfect, as before.
