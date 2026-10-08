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
Validation explains conflicts before execution. Profiles without
a group keep the existing invocation behavior.

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
Managed execution stores final response and readable agent activity separately;
conditions and severity routing see clean final text instead of JSON envelopes.
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
context with fixes; Watch Review Feedback retains fix context through bounded
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

Runs display fresh/resumed context and turn count, plus token/cache counts and USD
cost only when the CLI reports them. These are per-invocation provider facts, not
remaining quota or a billing reconciliation. Longer histories can increase input
cost; caching and compaction depend on the CLI/provider. No savings percentage is
promised. Browser development uses simulated sessions and reports no token spend;
its directory normalization cannot resolve filesystem symlinks.

Provider references: [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference),
[Claude cost guidance](https://code.claude.com/docs/en/costs).

## Reported-spend guard

Open **Run options** and enter a positive USD threshold, or leave it blank for
ordinary execution. The guard adds up finite, nonnegative structured
`agentUsage.reported_cost_usd` for newly executed Agent attempts. It does not
estimate dollars from tokens or text patterns. Reused and simulated results do
not contribute. Runs reports the number of priced attempts and attempts missing
USD reports; unknown coverage means the displayed total is partial.

Claude managed result streams can report USD. Codex/custom and legacy plain-text
calls may not report any USD. A missing report cannot trigger a dollar guard;
unsupported calls can therefore continue. This is neither a provider quota meter
nor a universal hard billing cap. Provider-native budget flags are not configured
by this feature.

Once known spend reaches the threshold, no further effectful work is dispatched.
Already running siblings finish and may increase spend further. The engine then
pauses if more tools are ready; pure graph completion may finish the run. Choose
**Review spend pause**, then enter a threshold above the reported total or choose
**Continue without the spend guard**. Decisions are atomic, identify the exact
pause, persist across restart, and reject stale/duplicate continuation. Ordinary
workflow approvals cannot authorize a spend pause. Cancel keeps partial output.
