# Git, GitHub, Ticket, and MCP integrations

Orchevia integrates with developer systems through tools you already
authenticated — never through Orchevia-owned credentials.

## Priority order

1. **Local CLI** where practical (`git`, `gh`).
2. **MCP** where it provides a clean provider-neutral path (Jira tickets,
   generic tool calls).
3. Direct provider APIs: not used. If a future integration needs one, it gets
   an explicit design review first.

## Git (`git` node)

Operations: status, diff summary, branch create/checkout, stage explicit
paths, commit staged, worktree add/remove/list, remotes. All arg-based, no
shell, no `--force`, no `reset --hard`, no `clean -fd`.

Safety rules enforced by the adapter (not just the UI):

- Dirty-checkout requires an explicit opt-in (and still never discards).
- Commits refuse empty staging; staging requires explicit paths (no implicit `-A`).
- Worktree paths must not exist yet; removal works **only on clean worktrees**
  and never on the main checkout — failed runs stay debuggable.
- Branch names are validated; conflicts block branch creation.

## Isolated worktrees (optional)

A workflow can `worktreeAdd` (named `wt-<branch>` by convention, stored wherever
you choose, e.g. `/tmp/orchevia-wt-*`), run agent implementation inside it, then
`worktreeRemove` on success. On failure the worktree is preserved with its
uncommitted state for inspection. Tradeoff: worktrees share the object database
(fast, cheap) but run the same hooks/environment — review configuration before
executing untrusted branches.

## GitHub (`github` node, via `gh`)

Uses your authenticated `gh`. Detected states: installed / authenticated /
configured / unavailable / error (see Environment). Operations: PR-for-branch,
list PRs, PR details/files/checks/comments, create PR (draft supported), and
post comment. Reviewer requests currently need an explicit Command node using
`gh pr edit --add-reviewer`; they are not a native GitHub node operation. Tolerant `--json` parsing: unknown fields ignored.

**PR checks:** use the installed CLI's supported `name`, `state`, and `bucket`
fields. Pending and failed checks are returned as data, including when `gh`
returns its pending/failed-check exit code. Authentication and network errors
remain errors. The normalized result preserves check names and states, with an
empty conclusion for pending checks and a lowercase terminal state otherwise.
Reading checks does not wait for CI, enforce an approval gate, or merge the PR;
route on the result explicitly when the workflow needs that decision.

**PR creation safety:** title/base/head are required in node config; the run
shows repository, branch/base, title, draft flag, and body preview in history.
Nothing pushes or comments unless the workflow explicitly contains that node.

## Tickets (`ticket` node, Jira over MCP)

Register an MCP server in Environment (command + args only — no secrets
stored), then reference it with a key like `{{input.ticket}}`. The ticket is
normalized (`key`, `title`, `description`, `acceptanceCriteria`, `status`,
`url`, `labels`) into `ticket.*` prompt variables with a bounded context
(default 8000 chars). Non-Jira field layouts degrade gracefully (unknown
fields ignored, raw text kept as description).

No Jira credentials live in Orchevia: authenticate inside your MCP server setup.
For Orchevia's suggested `uvx mcp-atlassian` server, the Jira Cloud environment
variables are `JIRA_URL`, `JIRA_USERNAME`, and `JIRA_API_TOKEN`, as documented
by [mcp-atlassian](https://github.com/sooperset/mcp-atlassian/blob/main/docs/configuration.mdx).
`JIRA_BASE_URL` and `JIRA_EMAIL` may be used by a custom shell script, but
`mcp-atlassian` does not read them. A generated raw Command using those names
is a separate integration path. If Environment → **List tools** shows Jira
tools, use Ticket/MCP nodes and keep the working MCP configuration.

## Generic MCP (`mcp` node)

Call one configured tool with templated string arguments. Each invocation is
bounded (timeout + cancellation stop the server's process group), records server/tool
provenance, and treats tool-level `isError` as node failure. Disabled or
missing servers fail validation; imported workflows never auto-invoke.
Generation discovers enabled servers' tool names and required argument keys
before drafting; when discovery fails, the prompt asks for a setup gate
instead of a fabricated MCP method. The node currently accepts string argument values, so complex
schema inputs need manual handling.

## Example: ticket-to-draft-PR

```text
Manual input: ticket key ({{input.ticket}})
  ↓
Ticket node (Jira via MCP) → ticket.* variables
  ↓
Git status (clean check)
  ↓
Worktree add / branch create
  ↓
AI Plan → Approval → AI Implement
  ↓
Tests (command)
  ↓
AI Reviews
  ↓
Commit staged → Create draft PR
  ↓
End
```

Every write step (stage paths, commit message, PR title/base/head) is explicit
node configuration — no special-case engine code.

## Manual integration tests

`crates/core` tests use temp repos, fixture `gh`, and fixture MCP servers
(all offline). Optional live checks against your own tools are out of scope
for CI: use a scratch workflow in the desktop app instead.
