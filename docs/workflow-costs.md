# Workflow context and cost controls

These controls work for any workflow using Claude or Codex Agent Profiles. They
are optional; existing saved workflows continue to start fresh. Orchevia uses your
locally installed CLI and authentication. It does not call a model provider itself.

## Reuse related work within a run

In the Agent inspector, give an implementer and its later fix nodes the same
**Session group**, such as `implementation-{{input.ticket}}`. They must use the
same complete profile configuration and effective working directory. The desktop
engine canonicalizes directories, serializes members of the group, and resumes
only the explicit successful session ID returned by the CLI. Unrelated groups
remain concurrent. A separate run always starts fresh.

Use a short follow-up instruction that identifies the new task. The earlier
conversation stays with the CLI; avoid pasting the initial instructions or full
implementation output again. Profile skills still apply each turn. Keep independent
reviewers fresh, or give each reviewer a separate group when continuity is explicitly
wanted. Include an item key when processing multiple tickets or PRs within one run.
A rendered group must be nonempty, at most 256 characters, with no line breaks.
Use documented namespaces (`workflow.*`, `input.*`, `ticket.*`, `node.<id>.output`
or other supported node fields). Bare `{{nodeId}}` group variables are rejected;
write `{{node.nodeId.output}}` so validation, rendering and reference remapping agree.

**Maximum turns per session** defaults to 4 (range 1–20). The next node starts a
fresh session when this limit is reached. Editing any profile setting or changing
the directory also starts fresh. Successful metadata survives an approval pause.
Failed, timed out, cancelled, malformed or incomplete turns are not reusable.
A failed resumed turn is attempted once even if its node has a retry policy:
replaying it could repeat file changes or other side effects. A later group member
starts fresh; there is no hidden fresh fallback. Explicit retries of an initial
fresh turn start new sessions, subject to the existing retry bounds.

Custom CLI profiles cannot join a session group. Managed nodes own stream and
resume arguments: remove conflicting `--resume`, `--continue`, `--last`, output
format, session persistence, or CLI directory/worktree flags from the profile's
extra arguments, including alternative Claude selectors `--from-pr` and `--teleport`.
Validation explains conflicts before execution. Nodes without a group start a
fresh conversation each time; they still use structured output unless the profile's
extra arguments set the output format (then they use text output and report no usage).

## Pass only relevant outputs between agents

Select **Context from completed nodes** in the inspector. `contextRefs` accepts
up to 16 unique other node IDs (readable keys in Simple JSON). Every selected node
must already have completed when this Agent starts; make that dependency explicit
with graph edges. The latest completed result supplies stdout and available stderr.
Failed/cancelled/skipped completed results can be passed to a recovery node.

**Context character budget** defaults to 12000 combined excerpt characters
(range 256–64000). The budget is divided across references, in selection order.
Long outputs retain their beginning and end with a visible truncation marker;
short outputs are included completely. Headers and markers add a small bounded
overhead. This does not summarize meaning or guarantee that every finding remains
in the excerpt. Inspect full source/diffs or increase the budget when exact detail
matters. Avoid also writing `{{node.review.output}}` into the prompt for the same
selected output; that would duplicate it and bypass the excerpt budget.

Full captured logs stay in Runs; context budgets only affect the next prompt.
Existing stdout/stderr capture limits still apply (200000 characters each).
Claude and Codex nodes store the final response and readable agent activity
separately; conditions and severity routing see clean final text instead of JSON
envelopes.
Command preview shows the fresh profile command; session IDs and handoff contents
are selected at runtime.

## Portable example

The Agent config in Simple JSON uses the same optional controls (document v1,
runtime schema v6). Profile names and node keys remain portable:

```json
{
  "profileName": "Claude Code — Implementation",
  "prompt": "Fix the current review findings, verify them against source, and run relevant tests.",
  "sessionGroup": "implementation-{{input.ticket}}",
  "sessionMaxTurns": 4,
  "contextRefs": ["review"],
  "contextMaxChars": 12000
}
```

Declare `ticket` as a workflow input and connect the completed review to this fix
node. The earlier implementer uses the same profile/group and directory. References
are remapped when importing, cloning workflows or instantiating templates. Arrange
preserves these settings; Optimize preserves omitted settings and shows proposed
behavior changes for review. An explicit empty `contextRefs` list clears handoffs.

## Samples, templates and generation

New built-in templates pass relevant plans, implementation/test results, PR file
lists and findings as bounded handoffs. Ticket to Draft PR shares implementation
context with fixes; Address Review Feedback retains fix context through bounded
cycles. Reviewers stay fresh. The Plan → Implement → Review, PR Review and Review
Loop samples use the same controls. Existing saved copies are never rewritten.

Workflow Generator and Workflow Assistance are instructed to choose short follow-up
prompts, scoped session groups, useful predecessor excerpts and independent reviews,
while preserving required work, dependencies, approvals, requested provider/model
and explicit developer instructions. Preview and validation remain required before
running. These controls can reduce duplicated input; their effectiveness depends
on the task and CLI. They do not substitute for necessary context or quality checks.

The first wizard adds **Claude — General purpose** (Opus, medium effort,
`generalPurpose` role). Existing profiles with this exact name or an existing
Claude generalPurpose role are preserved. Other profile recommendations keep their
models and effort. Existing installations can rerun setup to create missing profiles.

## Measure with reported facts

Runs display fresh/resumed context and turn count. Token/cache counts and dollar
estimates are available in collapsed **CLI usage** details on each step; the timeline's
**CLI usage details** includes estimate coverage after agent attempts finish. Before
any attempt has reported or finished without a report, the empty summary is hidden.
A missing USD report stays unknown; it is never converted to zero.

Claude's `total_cost_usd` is preserved as `agentUsage.reported_cost_usd`. It is an
estimated API value, not a subscription charge. Claude documents that its session
dollar figure is computed from token pricing and is not relevant to billing for Pro
and Max subscriptions. API users should check their billing console for authoritative
charges. Orchevia cannot infer subscription limits, remaining five-hour quota, or a
run's share of a monthly fee from these fields. Check the provider's usage page or
interactive CLI usage view for those facts; no subscription percentages or dollar
allocations are invented from elapsed time. Longer histories can increase input
cost; caching and compaction depend on the CLI/provider. No savings percentage is
promised. Browser development uses simulated sessions and reports no token spend;
its directory normalization cannot resolve filesystem symlinks.

Provider references: [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference),
[Claude cost guidance](https://code.claude.com/docs/en/costs).

## Reported-spend guard

Open **Usage limits** (or override per run in the start form) and enter a positive
USD threshold, or leave it blank for
ordinary execution. The guard adds up finite, nonnegative structured
`agentUsage.reported_cost_usd` for newly executed Agent attempts. It does not
estimate dollars from tokens or text patterns. Reused and simulated results do
not contribute. Runs reports the number of attempts with estimates and attempts
missing USD reports inside collapsed usage details; unknown coverage means the
estimate is partial.

Claude Agent nodes report USD in their structured result, with or without a session
group. Codex reports tokens but no USD. Custom CLIs, profiles whose extra arguments
force text output (Runs shows a note) and legacy plain-text results report none. A
missing report cannot trigger a dollar guard; unsupported calls can therefore
continue. This is neither a provider quota meter
nor a universal hard billing cap. Provider-native budget flags are not configured
by this feature.

Once the reported estimate reaches the threshold, no further effectful work is dispatched.
Already running siblings finish and may increase the reported estimate further. The engine then
pauses if more tools are ready; pure graph completion may finish the run. Choose
**Review spend pause**, then enter a threshold above the reported total or choose
**Continue without the spend guard**. Decisions are atomic, identify the exact
pause, persist across restart, and reject stale/duplicate continuation. Ordinary
workflow approvals cannot authorize a spend pause. Cancel keeps partial output.

## Workflow usage limits (v0.1.14)

Open **Usage limits** in the Workflows toolbar to save optional per-workflow
controls; the start form shows the effective values and accepts a clearly marked
override for one run. Empty clears a limit back to ordinary execution. Every run
snapshots its effective limits at start (manual, scheduled and watcher runs
alike), so later workflow edits never change an existing run.

- **Agent attempts per run (enforced).** Total dispatched Agent attempts,
  counting retries and loop visits. Capacity is reserved before parallel
  siblings dispatch, so they cannot each spend the same remaining allowance.
  Consumption persists across approvals, restarts and continuations; recovery
  starts a new budget and reused or simulated results are never re-charged.
  Exhaustion preserves partial output and pauses the run durably: extend the
  budget explicitly or cancel. A stale or duplicate continuation is rejected,
  and ordinary approval cannot clear a usage pause.
- **Tool calls / subagents (advisory).** Allowances per run or per Agent node
  travel as guidance inside each Agent prompt (one injected policy block per
  invocation, never recursively copied) and are observed where the CLI reports
  them. The CLI owns its tool loop, so these never hard-stop work. Per-node
  values are that step's share, never the whole workflow budget; stricter node
  instructions always win, and the policy never mentions subscription balances.
  Each dispatch uses the remaining observed run allowance and reserves a share for
  other possible attempts. Retries receive refreshed guidance, and a node's own
  allowance can only tighten the workflow allowance. Unsupported or incomplete
  observations remain visible coverage limits; these figures are not hard caps.
- **Spend target (API-equivalent).** The existing reported-spend guard, saved
  per workflow and overridable per run as before.

An incomplete or budget-limited review is neither approval nor evidence of
cleanliness: guard-paused nodes record no success marker, contribute no
findings, and release no dependent approvals, publications or side effects
until the required work actually runs.
Known structured provider-limit errors and missing terminal responses stop the
graph without taking ordinary failure routes. Prompt-only allowances still depend
on the agent following the guidance; Orchevia does not infer completion or reliable
dollar balances from arbitrary prose.
Explicit local process timeouts retain configured retries and failure recovery.

### Control coverage

| Control                | Claude                          | Codex                | Custom/text |
| ---------------------- | ------------------------------- | -------------------- | ----------- |
| Agent attempts per run | enforced                        | enforced             | enforced    |
| Agentic turns          | advisory                        | advisory             | unsupported |
| Individual tool calls  | advisory (+observed)            | observed             | unsupported |
| Nested subagents       | advisory (+observed Task/Agent) | advisory             | unsupported |
| Spend estimate pause   | enforced (can overshoot)        | unsupported (no USD) | unsupported |

Orchevia passes no `--max-turns`/`--max-budget-usd` flags itself. Claude's
`--max-turns` counts agentic turns, not individual tools, and its
`--max-budget-usd` is a client-side API estimate that can overshoot; users may
pass them via a profile's extra arguments as the CLI's own enforcement. Codex
has no verified equivalent flags. Killing a process after a streamed tool event
never un-runs that tool. No SDK, provider or gateway layer is introduced to
manufacture enforcement that does not exist.

## Usage & costs page

**Usage & costs** (after Environment) aggregates run history in the backend over
every stored run — never a capped recent list — with date presets and range,
workflow/provider/model filters, a daily chart, and a tabbed Workflow, AI
profile and Provider & model breakdown. Boundaries are inclusive start /
exclusive end, grouped by UTC day with the display timezone shown. The chart is
a bounded panel of agent attempts per UTC day with zero-filled gaps and an
expandable daily table; daily USD stays a reported subtotal, not proven
coverage. The filled chart span is capped at 366 days; longer ranges retain all
actual days with runs in the daily table. Unreported tool/subagent counters stay
unknown. Subscription settings can retry loading and lock draft controls while
loading or saving. Workflow names and adapter/model identity are recorded
at execution time; legacy rows stay “unknown”, never zero. Fixtures and reused
outputs contribute no new consumption; duplicate terminal events and
parent/subagent wrapper rows are not double-counted. Workflow-run counts are
execution counts, not completed PR or ticket counts.

AI profile rows include distinct runs, dispatched attempts, execution time and
CLI-reported API estimates with missing-report coverage. Profile IDs come from
the run's saved workflow, so reassigning a node later does not change attribution.
Existing profiles display their current names; deleted profiles retain their IDs,
and history without a saved identity stays unknown. This replaces the usage panel
on Agents, which now focuses on configuring profiles.

Three money lanes stay separate: user-entered subscription fees and extras for
a billing period, CLI-reported API-equivalent estimates with source and
coverage, and an optional manual fee pool with its declared Orchevia share
(outside/untracked usage excluded). Full overlapping billing periods remain
unprorated; periods outside the selected range or without valid dates are not
allocated. Provider, workflow or model filters do not convert the pool into
per-run or per-attempt prices. The illustrative
$120 + $24 example from early feedback is a settings example, not a default or
a verified price. The API-equivalent target offers estimate ranges with sample
counts from comparable history, or **Insufficient history** — never fabricated
rates, and no reverse calculator from tool counts to enforceable dollars.
