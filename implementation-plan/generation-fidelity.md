# Generation fidelity pass

## Scope

Generated proposals now choose from Orchevia's existing Agent, Git, GitHub,
Ticket, MCP Tool, Condition, Human Approval, and Command capabilities. The
prompt asks for the smallest graph that preserves the user's requested work,
decisions, dependencies, and approval gates. Explicit node restrictions take
priority over native preferences.

Proposal Git and GitHub nodes carry the existing tagged `gitOp` and `githubOp`
shapes. The compiler preserves those operations, rejects missing or unknown
ones, and lets workflow validation block incomplete writes. A Command with no
executable is rejected instead of silently promoting an argument or becoming an
Agent. Direct
Claude/Codex commands remain Commands with an Agent Profile bypass note.
Unsupported native operations such as Git push can be explicit Command steps
and appear as remote writes in the existing risk review. Generated MCP tool
arguments are preserved and listed in preview alongside actions and parameters.
The prompt also requires a push before opening a PR from a new local branch.
Accepting still never runs a workflow.

## Verification on 2026-09-24

- `pnpm check`: passed, including formatting, lint, typecheck, and 85 frontend tests.
- `cargo test -p orchevia-core`: passed, 219 tests.
- `cargo clippy -p orchevia-core --all-targets -- -D warnings`: passed.
- `cargo fmt --check`: passed.
- `cargo check -p orchevia`: passed.
- `pnpm build`: passed, with Vite bundle-size and mixed-import warnings.

The tests pin deterministic prompt text, operation preservation, validation,
risks, command rejection, and preview descriptions. They do not establish
that every real model response will choose an ideal graph. A manual generation
check with local Claude or Codex on a disposable repo remains useful. Inspect
read-only answering, a branch and draft PR, a ticket/MCP decision with an
approval, and a goal explicitly excluding Agent nodes. Do not run write-capable
proposals during that generation check.

## Following passes

1. Persist and display incremental node output in Runs, then improve long-text
   rendering and finding classification.
2. Improve canvas navigation, node color distinction, sidebar behavior, and
   shared visual consistency.
3. Review public README, contributor documentation, and repository site before
   publication.

## 2026-09-24 follow-up: Jira command failure and reviewer mapping

A generated Jira workflow used a raw `bash -c` REST step requiring
`JIRA_BASE_URL` and `JIRA_EMAIL`. Orchevia's configured Jira MCP guide uses
`JIRA_URL` and `JIRA_USERNAME`, and MCP tool discovery worked for the user.
The shell step bypassed that working integration and failed before the ticket
was read. Two requested Claude Fable reviews also resolved to Codex because
the generator knew role names but not their actual Agent Profile mappings.

The generator now receives the current role/profile names, adapters, and model
choices plus enabled MCP server tool names and required argument keys. Discovery
is bounded to four servers and 12 seconds per server; a failed probe is
reported as unavailable context without preventing generation. The prompt
requires exact reviewer counts/provider mapping and forbids invented Jira REST
credentials. The compiler exposes required shell variables and calls out the
known Jira-name mismatch in the setup checklist. Existing saved workflows are
not silently rewritten; the failed one needs regeneration or manual editing.

Focused Rust tests cover named reviewers and Jira shell-guard setup. Final
verification: `pnpm check` (87 frontend tests), `cargo test -p orchevia-core`
(225 tests), core clippy, Rust formatting, and `cargo check -p orchevia` all
passed. One initial full core run hit an intermittent MCP fixture `Text file
busy` error; the isolated test and the complete suite passed on rerun.

## Jira MCP naming correction

The upstream `sooperset/mcp-atlassian` configuration documents `JIRA_URL`,
`JIRA_USERNAME`, and `JIRA_API_TOKEN` for Jira Cloud. `JIRA_BASE_URL` and
`JIRA_EMAIL` are possible custom shell variable names, not this server's
configuration. The Environment guide now says so. The generator prompt no
longer demonstrates a fabricated `searchJiraIssuesUsingJql` tool; it requires
names from the server's discovered tool list.
