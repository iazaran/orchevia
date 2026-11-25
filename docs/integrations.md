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
  and never on the main checkout — failed runs stay debuggable. A relative path
  is inside the repository (as git resolves it) and `~/` is your home folder.
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

**Check server** (Environment, v0.2.0) checks one server when you click it: the
program is found, it starts and completes the MCP handshake, it lists its tools, and
the tools your saved workflows use on it are there (MCP steps' tools and the
`jira_get_issue` lookup Ticket steps call). It never calls a tool. A failure says
where the check stopped and what to do next, quoting the server's error output; a
silent server is stopped after 45 seconds, and **Cancel check** stops it sooner. The
check proves the server answers and lists its tools, not that a tool works with your
data or credentials.

## Connection recipes

Open **Environment → + New MCP server** and pick a setup, or start from a blank
server. A setup fills in the command and arguments, lists how to sign in, writes
the `export` lines for your shell profile, checks which of those variables the
running app can see (names only, never values), and lists tools you can call.
Save the server, choose **Check server**, then select the server and one of its
tools in an **MCP Tool** step. Jira also works in a **Ticket** step.

Credentials never enter Orchevia: servers read them from the environment the app
was started from. Remote services run through
[`mcp-remote`](https://github.com/geelen/mcp-remote), which signs in through your
browser and keeps its tokens in `~/.mcp-auth`; a header such as
`Authorization:Bearer ${STRIPE_AGENT_API_KEY}` holds only the variable name, and
`mcp-remote` expands it. Setups with a placeholder (a folder, a repository or a
project reference) cannot be saved until you replace it.

| Category       | Setup              | Command                                                                                                   | Sign-in                                                |
| -------------- | ------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Work & docs    | Google Workspace   | `uvx workspace-mcp --tools gmail drive calendar docs sheets --read-only`                                  | `GOOGLE_OAUTH_CLIENT_ID`/`SECRET`, `USER_GOOGLE_EMAIL` |
|                | Microsoft 365      | `npx -y @softeria/ms-365-mcp-server --read-only`                                                          | One-time `--login` in a terminal                       |
|                | Slack              | `npx -y slack-mcp-server@latest --transport stdio --enabled-tools …`                                      | `SLACK_MCP_XOXP_TOKEN` or `SLACK_MCP_XOXB_TOKEN`       |
|                | Notion             | `npx -y @notionhq/notion-mcp-server`                                                                      | `NOTION_TOKEN`                                         |
| Code & tickets | Jira & Confluence  | `uvx mcp-atlassian --read-only`                                                                           | `JIRA_URL`, `JIRA_USERNAME`, `JIRA_API_TOKEN`          |
|                | GitHub             | `docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server stdio --read-only …` | `GITHUB_PERSONAL_ACCESS_TOKEN`                         |
|                | GitLab             | `npx -y mcp-remote https://gitlab.com/api/v4/mcp`                                                         | Browser                                                |
|                | Linear             | `npx -y mcp-remote https://mcp.linear.app/mcp/readonly`                                                   | Browser                                                |
|                | Sentry             | `npx -y @sentry/mcp-server@latest --skills=inspect`                                                       | `SENTRY_AUTH_TOKEN`                                    |
| Web & research | Fetch web pages    | `uvx mcp-server-fetch`                                                                                    | None                                                   |
|                | AWS Knowledge      | `uvx fastmcp run https://knowledge-mcp.global.api.aws`                                                    | None                                                   |
|                | Context7           | `npx -y @upstash/context7-mcp`                                                                            | Optional `CONTEXT7_API_KEY`                            |
|                | Brave Search       | `npx -y @brave/brave-search-mcp-server --transport stdio`                                                 | `BRAVE_API_KEY`                                        |
|                | Cloudflare Docs    | `npx -y mcp-remote https://docs.mcp.cloudflare.com/mcp`                                                   | None                                                   |
|                | Playwright browser | `npx -y @playwright/mcp@latest --headless --isolated`                                                     | None                                                   |
| Data & cloud   | Supabase           | `npx -y @supabase/mcp-server-supabase@latest --read-only --project-ref=…`                                 | `SUPABASE_ACCESS_TOKEN`                                |
|                | PostgreSQL         | `uvx postgres-mcp --access-mode=restricted`                                                               | `DATABASE_URI`                                         |
|                | Stripe             | `npx -y mcp-remote https://mcp.stripe.com --header Authorization:Bearer ${STRIPE_AGENT_API_KEY}`          | `STRIPE_AGENT_API_KEY`                                 |
| Local          | Filesystem         | `npx -y @modelcontextprotocol/server-filesystem --read-only /path/to/folder`                              | None                                                   |
|                | Git                | `uvx mcp-server-git --repository /path/to/repo`                                                           | None                                                   |
|                | Memory graph       | `npx -y @modelcontextprotocol/server-memory`                                                              | Optional `MEMORY_FILE_PATH`                            |
|                | Figma              | `npx -y mcp-remote http://127.0.0.1:3845/mcp`                                                             | Figma desktop app with Dev Mode                        |

The commands, flags, variables and tool names were checked against each project's
README or registry entry in November 2026. The earlier Google Docs and Gmail
recipes became the single Google Workspace setup; servers you already saved keep
working. If you use the `gws` CLI, `npx -y gws-mcp-server --read-only --services
docs,drive,gmail` still works as a blank server.

Use the provider's own setup for agent-managed MCP, such as the [Slack MCP
server for coding agents](https://docs.slack.dev/ai/slack-mcp-server/connect-to-harnesses/)
or [Google Workspace remote MCP](https://developers.google.com/workspace/guides/configure-mcp-servers).
Environment registers the local servers used by workflow nodes.

### MCP templates

Three templates call an MCP tool and hand its result to a planning agent as
data. They need no repository; the Use dialog names the setup each expects.

| Template             | MCP tool                                        | Setup           |
| -------------------- | ----------------------------------------------- | --------------- |
| Summarize a Web Page | `fetch` (`url`, `max_length`)                   | Fetch web pages |
| Answer from AWS Docs | `aws___search_documentation` (`search_phrase`)  | AWS Knowledge   |
| Slack Channel Digest | `conversations_history` (`channel_id`, `limit`) | Slack           |

## n8n import and export

Workflows → **Import / Export** exports the open workflow as n8n workflow JSON or
Orchevia Simple JSON, and imports either as a new workflow (laid out
automatically). Templates → **Import JSON…** accepts n8n JSON too, and **Export
JSON** offers both formats. Paste exported n8n JSON onto an n8n canvas (Ctrl+V or
⌘V), or save it as a `.json` file and use _Import from File_.

| Orchevia step        | n8n node                                      | Notes                                                                        |
| -------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| Start and run inputs | `manualTrigger` and a “Workflow inputs” `set` | `{{input.x}}` becomes an expression on the inputs node.                      |
| Command, Git, GitHub | `executeCommand`                              | The same `git` and `gh` commands; a working folder becomes `cd <dir> &&`.    |
| AI agent             | `executeCommand`                              | Calls the profile's CLI (`claude -p`, `codex exec`, `gemini --prompt`, …).   |
| Condition            | `if`                                          | True and false outputs keep their branches.                                  |
| Failure edge         | error output                                  | The node uses “continue (using error output)”.                               |
| Approval             | `wait`                                        | Resumes on its webhook; swap in a “send and wait” node to approve from chat. |
| Ticket               | `jira` (issue → get)                          | Connect Jira credentials in n8n.                                             |
| MCP tool             | `noOp` placeholder                            | n8n calls MCP only from an AI Agent; the note keeps the tool and arguments.  |

Values a step inserts (`{{input.x}}`, `{{node.x.output}}`) are exported inside
single quotes with their own quotes escaped, so in n8n a value stays one argument,
as it is in Orchevia; a step's own `sh -c` script keeps inserting values as shell
text, as it does in Orchevia.

Import maps triggers to Start (schedule and webhook triggers get a note). An
Execute Command becomes an argv Command step when it needs no shell, an Agent step
when it calls a known agent CLI with only the flags Orchevia itself writes
(`--model`, the prompt flag), and a `sh -c` step otherwise. `httpRequest` becomes a
`curl` Command without headers or credentials, `if` and `filter` become Conditions
(a filter's non-matching path ends the run), `wait`, `form` and “send and wait”
nodes become Approvals, Jira “get issue” becomes a Ticket, and AI Agent, LLM chain
and model nodes become an Agent step for your Implementation profile. Set nodes
become run inputs with their values as defaults. Merge, split, sort and other
data-shaping nodes are left out and their neighbours joined; a loop through one runs
its steps once. Code nodes and anything else without an equivalent become a step
that stops the run until you replace it, so nothing after it runs by accident.
Nodes no trigger reaches are left out, as n8n never runs them. Every conversion
lists what changed, and an n8n expression Orchevia cannot read is kept as visible
text (`[[…]]`) for you to replace.

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
