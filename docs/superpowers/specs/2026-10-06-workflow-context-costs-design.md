# Workflow context and cost controls

The user approved the proposed design on 2026-10-06: reusable sessions within
a run, bounded handoffs between agents, authoring controls and generation
guidance, and a Claude general-purpose Opus/medium profile for v0.1.10.
The three local v2 workflow examples informed the use cases; their private
repository paths, tickets, accounts and instructions are not shipped.

## Intent

Reduce repeated repository discovery and oversized copied outputs without
weakening workflow instructions, independent reviews or existing workflows.
Use existing Rust engine/adapters/result persistence and mirrored frontend
contracts. No provider account, API key, telemetry, new service architecture or
additional summarization call is introduced. Savings depend on workload and
CLI caching; continuing an unnecessarily long conversation can cost more.

## Session contract

Agent nodes may set `sessionGroup` (a nonempty string supporting existing
`{{…}}` variables) and `sessionMaxTurns` (1–20, default 4). Absent group means
the existing fresh invocation. A group identifies a conversation only inside
one run, with an identical profile configuration and canonical effective
working directory. Never use the CLI's last/continue selector. Use Claude
`--resume <id>` and Codex `exec … resume <id>` with recorded explicit ids.

Serialize group members inside the run. Different profiles, directories and
runs remain independent. Persist session id, identity, turn count and reuse
decision in existing result metadata so an approval pause/resume can recover
it. Only successful completed turns are reusable. Failure, timeout,
cancellation, malformed/missing session output or the turn limit causes the
next invocation to start fresh. A resume failure is reported normally, without
automatically replaying a potentially mutating prompt. Retry attempts start
fresh, obey existing retry limits, and do not silently fall back from a failed
resume. Reject user extra arguments that conflict with managed session/output
flags when group reuse is enabled. Custom adapters reject session groups.

Provider JSONL is decoded incrementally to preserve readable live output,
final response, partial text, severity scanning and downstream conditions.
Session and available usage metadata are captured without feeding provider
event envelopes into subsequent prompts. Existing capture limits still apply.

For unrelated items within a loop, authors must include an item identity in the
group, such as `review-{{node.select-pr.output}}`, and return a compact stable
identity from that selection node. Independent reviewers use separate groups
or fresh sessions; implementation and fix nodes can share a group.

## Cross-agent handoffs

Optional `contextRefs` selects completed node outputs to append to an agent
prompt. `contextMaxChars` bounds the total excerpt characters (256–64000,
default 12000); labels/status and explicit truncation markers are additional
small, bounded overhead. Allocate the budget fairly across selected outputs,
preserve the beginning and end, and mark omissions. Keep stored outputs at
their existing capture limit. Unknown, duplicate, self or incomplete references
fail clearly. Existing explicit output placeholders are unchanged; authors
should avoid copying the same output into both the prompt and contextRefs.
No automatic summarization, silent prompt truncation or cached execution.

## Authoring and compatibility

Expose these optional controls in the existing agent inspector. Mirror shape
and semantic validation in Rust and TypeScript; preserve Simple JSON imports,
exports, clones, templates and proposal compilation, including reference
remapping in sessionGroup/contextRefs. Optional fields keep runtime schema v6
and developer document v1. The MockBackend mirrors validation, grouping and
handoff semantics with simulated sessions and clearly simulated usage.
Generator/assistance instructions teach short explicit follow-up tasks, compact
handoffs, independent reviewers and per-item group keys, respecting user rules.

Add `generalPurpose` to suggested roles and recommend `Claude — General
purpose`, model `opus`, effort `medium`, preserving existing profiles by role
or exact name. Other profile recommendations retain their current choices.

## Verification and release

Regression tests cover explicit resume argv, streaming/partial/error decoding,
group isolation/serialization/rotation, retries, approval resumption, bounded
Unicode handoffs, malformed references/config, JSON/template/proposal remapping,
mock behavior and wizard preservation. Run every AGENTS.md gate, desktop tests,
frontend build, version validation, self-review and browser mock checks.
Synchronize all application manifests/lock entries to 0.1.10, update changelog,
area docs and README release targets without claiming unpublished installers.
Commit and open a PR; the user retains merge and release decisions.

CLI references: [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference), and
[Claude cost guidance](https://code.claude.com/docs/en/costs).
