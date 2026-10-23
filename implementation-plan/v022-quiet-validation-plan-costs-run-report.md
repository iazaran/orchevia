# v0.1.22 implementation outcome

Feedback from a day of real use: warnings about fields nobody had reached yet,
a "cost" that read as five weeks of subscription spent in one day, and a run page
where steps and their buttons ran into each other. Application version `0.1.21` →
`0.1.22`. Workflow schema, templates and Simple JSON unchanged.

## 1. Validation waits until the user asks for something

**Before.** Opening a schedule, watcher, agent profile or MCP server editor showed
a red error toast at once ("Schedule name must not be empty."), and the Save
button was disabled with no reason given in the form. In the workflow editor,
every edit re-ran validation and pushed a toast listing up to four problems,
usually about steps the user had not configured yet. Typing a condition in text
form raised a toast on every keystroke that did not parse yet.

**Now.**

- `useSubmitValidation` + `FormError` (`src/components/FormValidation.tsx`): Save
  stays clickable; the first Save with a problem shows it inline, next to the
  button, and from then on it follows the form and clears when fixed. Used by the
  schedule, watcher, agent profile and MCP server editors. The watcher's scope
  check still disables Save while it runs.
- Workflow editor: the toast is gone. `SetupStatus` puts a quiet count in the
  canvas toolbar ("2 to finish", or "1 note" when nothing blocks a run) that opens
  the list; each entry names its step (`issueNodeLabel`) and selects it. The
  canvas validates once when a workflow opens, so the count is right before the
  first edit. The node inspector lists only the selected step's own errors as
  "To finish this step" (inline, no alert). Red borders on nodes are unchanged.
- Start dialog: pressing Start validates first and lists "Finish this before
  running" with each step's label and a **Show step** button that closes the
  dialog and selects it. Its error message is inline too.
- Condition text form: a parse error shows under the field, as an inline
  `role="alert"`, once the field is left; typing hides it again.

## 2. Estimated cost on the user's own plans

**Before.** Usage & costs led with **Estimated API value**: USD 62.88 for one day of
runs, against a USD 120 + USD 24 monthly bill. The subscription section took fees
with explicit UTC billing periods and an unprorated "Orchevia share" of the whole
period, so it could not answer "what did today cost?".

**Now.** One setting per provider replaces the fee lists and allocation:

- `usage.plans` (JSON): `{ claude | codex: { billing: "subscription", monthlyUsd,
  name? } | { billing: "api", name? } }`. `validate_plans` (core) and
  `validatePlans` (TS) share rules and messages; `MAX_PLAN_MONTHLY_USD` is 100000.
- `usage.planShare`: optional percentage (blank = 100) of plan use that goes
  through Orchevia, for people who also use the CLIs on their own.
- The old keys `usage.subscriptionFees`, `usage.extraCharges`,
  `usage.allocationShare` and `usage.allocationMethod` are no longer accepted;
  values already stored are ignored.

`usage_summary` returns `providerDays`: per UTC day (run start) and adapter, the
filtered attempts, agent time and reported USD, plus `allAgentAttempts` /
`allDurationMs` for everything that adapter ran that day regardless of workflow,
run or model filters. A new `runIds` filter lets the Runs view ask for one run.
`estimatePlanCost` (TS) turns that into money:

- monthly plan: `monthlyUsd / days in that month` for each UTC day on which a run
  using that provider started (a run belongs to its start day), times the share; a filtered view gets `durationMs / allDurationMs`
  of the day (attempt counts when no time was recorded), so filtered views add up
  to the whole;
- pay per use: the reported API value; a day with no dollar report stays unknown
  rather than USD 0 (Codex never reports one);
- no plan: unknown, and the total is marked partial (so is each day it touches,
  and the "N× your estimated cost" comparison only shows when the estimate is
  complete and every attempt reported its API value).

The overview leads with **Estimated cost** (or a link to enter plans), keeps
**API value** beside it (with "N× your estimated cost" when both are complete), and adds **Cost by
provider** and an estimated-cost column in the daily table. Breakdown columns say
**API value**. Each finished run's header shows **Cost on your plans** for its own
part of the day, next to the API value; without plans it says the API value is not
the bill and links to the plans.

Worked example (the report that prompted this): 13 Claude attempts worth
USD 62.88 and one Codex attempt on 2026-10-23, with USD 120 and USD 24 plans, cost
120/31 + 24/31 ≈ USD 4.65 for that day if nothing else ran.

## 3. The run page

- Header: workflow name and status, then facts (started, took / running for,
  steps with skipped and failed counts, agent attempts, cost on your plans,
  API value), then the run ID in small type. The run list shows start time and
  duration instead of two timestamps.
- **Report** comes before the timeline and is taken from the step that leads to an
  End node (`reportResult`, looking past conditions and approvals, whose output is
  only the branch taken), so the "Summary" step wins over the last agent check;
  without one it falls back to the last agent output, then any output. Leading
  `Key: value` / `KEY=value` lines (`reportFields`) render as a two-column list
  (indented lines continue a value, such as a commit list); the rest is Markdown.
  A failed run's report names the step it stopped at (or the rejected approval),
  with a link. A run's plan cost is worked out again when another run started the
  same UTC day starts or finishes, since they share that day's fee.
- Steps are an ordered list of cards: a header bar with a high-contrast number
  ringed in the status colour, the label, status, kind and duration; a meta line
  (profile, exit, attempt, context); the body; and, for successful Commands, the
  playbook control folded inside the same card as "Save this command to the
  project playbook…" with "Save it as the project's [Test command]". The status
  colour runs down each card's left edge; skipped steps collapse to their header.
  `:target` highlights a step reached from a link.
- Timeline rows carry the same numbers in a status-coloured badge, show
  "attempt N" only for retries, and give labels more room.

## Verification

`pnpm check`, `cargo test -p orchevia-core`, clippy with `-D warnings`,
`cargo fmt --check`, `cargo check -p orchevia` and the desktop settings test. The
browser build was checked against a copy of the reported run: report from step 32
(Summary), USD 4.65 on the entered plans against USD 55.76 of API value, numbered
step cards, the editor's setup count and the Start dialog's list.
