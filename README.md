<div align="center">

<img src="./docs/favicon.png" alt="Orchevia logo: orbit-and-nodes mark on a blue-violet gradient" width="96" height="96" />

# Orchevia

**Your coding agents, one reviewable workflow — on your machine.**

[![CI](https://github.com/iazaran/orchevia/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/iazaran/orchevia/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/iazaran/orchevia?sort=semver&color=6ea8fe)](https://github.com/iazaran/orchevia/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/iazaran/orchevia/total?color=34d399)](https://github.com/iazaran/orchevia/releases)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)
![Platforms: macOS and Linux](https://img.shields.io/badge/platforms-macOS%20%7C%20Linux-lightgrey)
[![Built with Tauri 2](https://img.shields.io/badge/built%20with-Tauri%202%20%C2%B7%20Rust%20%C2%B7%20React-24c8db)](./docs/architecture.md)
[![GitHub stars](https://img.shields.io/github/stars/iazaran/orchevia?style=flat&color=fbbf24)](https://github.com/iazaran/orchevia/stargazers)

[**Download**](#download) · [Website](https://iazaran.github.io/orchevia/) ·
[Getting started](./docs/getting-started.md) · [Docs](./docs/architecture.md) ·
[Changelog](./CHANGELOG.md) · [Report an issue](https://github.com/iazaran/orchevia/issues/new/choose)

<img src="./docs/images/run-on-canvas.webp" alt="Orchevia showing a finished run on the canvas: a Jira ticket loaded over MCP, a branch, an implementation step, tests, fast and deep reviews in parallel, a fix loop, a human review and a draft pull request. The side panel shows the deep review's P1 finding and the clean second round." width="100%" />

</div>

Orchevia is a free desktop app for running **Claude Code, Codex, Gemini CLI, GitHub
Copilot CLI, Cursor CLI, OpenCode, Qwen Code, Google Antigravity CLI, Muse Code** and
more on your machine. Build a visual workflow that plans a change, pauses for your
approval, runs your tests and asks two independent reviewers to check the diff. Open
Runs to see what each step did and which findings survived the fix round.

- **Bring your own tools.** Sign in through the CLIs you already use. Orchevia needs
  no account and keeps workflows and run history in local SQLite.
- **Connect your stack.** 22 ready-made MCP setups — Google Workspace, Microsoft 365,
  Slack, Notion, Jira, GitHub, Linear, Sentry and more — with sign-in steps and a check
  that Orchevia can see your credentials, which never enter the app.
- **Approve and give feedback.** Pause at an Approval step or give a running step
  feedback before a push or PR comment.
- **Reuse and share.** Templates, Playbooks that detect your repository's commands, and
  **n8n import and export**.

**New in 0.3.1:** n8n import and export · 22 MCP setups in the server form · MCP
templates · Playbooks that detect your test, lint and build commands · seven more
coding CLIs in one click · a JSON editor that points at errors · a refreshed interface.
[Changelog](./CHANGELOG.md)

## Download

Pick the installer for your machine from the **[latest release](https://github.com/iazaran/orchevia/releases/latest)**:

| Platform              | Installer                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS · Apple Silicon | [Orchevia-macos-arm64.dmg](https://github.com/iazaran/orchevia/releases/latest/download/Orchevia-macos-arm64.dmg)                                                                                        |
| macOS · Intel         | [Orchevia-macos-x86_64.dmg](https://github.com/iazaran/orchevia/releases/latest/download/Orchevia-macos-x86_64.dmg)                                                                                      |
| Linux · x86_64        | [AppImage](https://github.com/iazaran/orchevia/releases/latest/download/Orchevia-linux-x86_64.AppImage) · [.deb](https://github.com/iazaran/orchevia/releases/latest/download/Orchevia-linux-x86_64.deb) |

**Debian and Ubuntu:** install from the signed apt repository instead, and
`sudo apt upgrade` keeps Orchevia up to date:

```bash
curl -fsSL https://iazaran.github.io/orchevia/apt/orchevia-archive-keyring.gpg | sudo tee /usr/share/keyrings/orchevia-archive-keyring.gpg > /dev/null
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/orchevia-archive-keyring.gpg] https://iazaran.github.io/orchevia/apt stable main" | sudo tee /etc/apt/sources.list.d/orchevia.list
sudo apt update && sudo apt install orchevia
```

| Checksums | [SHA256SUMS](https://github.com/iazaran/orchevia/releases/latest/download/SHA256SUMS) |

<details>
<summary><strong>Install steps and checksum verification</strong></summary>

Download your installer and `SHA256SUMS` into the same folder, keep the published file
names, and check for an `OK` line:

```bash
# Linux
sha256sum -c SHA256SUMS --ignore-missing
# macOS
shasum -a 256 -c SHA256SUMS --ignore-missing
```

- **macOS:** open the DMG and drag Orchevia to Applications. Builds are not notarized
  yet, so macOS blocks the first launch with a warning that it cannot verify Orchevia.
  Close the warning, then choose **Open Anyway** in **System Settings → Privacy &
  Security** (**System Preferences → Security & Privacy** on macOS 12 and earlier), or
  run `xattr -dr com.apple.quarantine /Applications/Orchevia.app`. If an older copy says it
  "is damaged", that was a signing bug fixed in v0.1.21: install the latest DMG, or run
  the same command.
- **Linux (.deb):** `sudo apt install ./Orchevia-linux-x86_64.deb`
- **Linux (AppImage):** `chmod +x Orchevia-linux-x86_64.AppImage`, then run it.

Orchevia tells you when a new version is ready (a banner, an Inbox entry and the
installer link under **Environment → Updates**, where you can also turn the check
off). From v0.1.24, AppImage and macOS copies can choose **Install and restart** there:
Orchevia downloads the signed update, checks its signature and restarts. With the apt
repository run `sudo apt update && sudo apt upgrade`; otherwise install the new file
over the old one. Your workflows and history are kept.

</details>

## Your first workflow

1. Install Orchevia, then open **Templates → First Workflow** and create a copy.
   The starter uses a local command and an approval. It needs no account,
   repository or agent.
2. Choose **Dry run** to try the routing, or **Run** to execute the echo commands.
   Open **Runs**, inspect the first step and approve to continue.
3. When you are ready for a code change, install and sign in to an agent CLI,
   then run **Agents → Check setup** on its profile. Start from **Implement a
   Task**, choose your repository, and supply your actual test command.

[First-run guide](./docs/getting-started.md) · [Agent setup](./docs/agents.md#supported-clis) ·
[MCP setups](./docs/integrations.md#connection-recipes) · [n8n import and export](./docs/integrations.md#n8n-import-and-export)

If Orchevia is useful to you, [star the repository on GitHub](https://github.com/iazaran/orchevia).

## See it in action

<table>
<tr>
<td width="50%" valign="top">

**Edit on a canvas.** Every node has an inspector: agent profile, prompt with
`{{variables}}`, required tools, session reuse, timeouts and loop bounds. Simple JSON
stays in sync, in an editor that colors it and points at mistakes.

<img src="./docs/images/editor-inspector.webp" alt="The workflow editor with the Implement agent step selected; the inspector shows its agent profile, prompt, handoffs, required tools and session settings." />

</td>
<td width="50%" valign="top">

**Read every run.** A full-width progress bar, then each step: what it is for, what it
is doing now and what it changed. A timeline shows parallel steps on one time axis;
raw output and CLI usage stay one click away.

<img src="./docs/images/run-timeline.webp" alt="The Runs view: a succeeded ticket-to-PR run with its API value, a full progress bar, the pull request report and a timeline of every step including the parallel reviews." />

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Know what it used.** Agent attempts, tokens and tool calls per workflow, profile and
model. CLI-reported dollar estimates stay separate from what you actually pay.

<img src="./docs/images/usage.webp" alt="The Usage and costs page: totals for 30 days, a daily chart of agent attempts and breakdowns by workflow, provider and model." />

</td>
<td width="50%" valign="top">

**Profiles per role.** Planning, implementation, fast and deep review: each with its own
CLI, model, effort and permission level. Missing CLIs show their install command.

<img src="./docs/images/agents.webp" alt="The Agents page: agent profiles for Claude, Codex, Gemini and GitHub Copilot CLI, then each supported CLI with its install command and a Create profile button." />

</td>
</tr>
<tr>
<td width="50%" valign="top">

**Connect tools in one form.** Pick one of 22 MCP setups: it fills in the command, shows
how to sign in, writes the `export` lines for your shell and lists the tools to call.

<img src="./docs/images/mcp-setups.webp" alt="The Add an MCP server picker: a search field, category filters and tiles for Google Workspace, Microsoft 365, Slack, Notion, Jira and Confluence, GitHub, GitLab, Linear and Sentry with sign-in and read-only badges." />

</td>
<td width="50%" valign="top">

**Move workflows to and from n8n.** Export any workflow as n8n JSON to paste onto an n8n
canvas, or import an n8n workflow. Every conversion lists what changed.

<img src="./docs/images/n8n-export.webp" alt="The Import and export dialog with Export and n8n workflow selected: colored n8n workflow JSON for the ticket workflow and a list of what changes in n8n." />

</td>
</tr>
</table>

## Generate a workflow from a goal

<img align="right" width="380" src="./docs/images/generate-dialog.webp" alt="The Generate workflow dialog: a goal describing a ticket-to-PR flow, a repository directory, and a preview listing 12 steps, 4 risk categories, one setup item, the compiler notes and the proposed steps." />

1. Open **Workflows → ✦ Generate**, pick a configured agent profile, and optionally point it at
   a repository so the draft uses your real paths and conventions. The AI is asked to
   inspect it without changing anything, but it runs with that profile's permissions.
2. Write the goal like a short spec. Name the agents, the commands that prove the change
   works, where you want to approve, and which writes are allowed:

   > Read Jira ticket {{input.ticket}} and plan it with Claude, then pause for my
   > approval. Implement it on branch {{input.branch}}, run pnpm test, and have Claude
   > and Codex review the diff in parallel. Fix P0/P1 findings (at most twice), then open
   > a draft PR.

3. Review the preview: steps, risk categories, setup items (such as picking the Jira MCP
   server) and every compiler repair. **Ask AI to fix** sends blocking problems back for
   another round.
4. **Accept & edit** opens it on the canvas. Run it with **Dry run** fixtures first if you
   want to test the routing without executing anything.

Generation prefers native Agent, Git, GitHub, Ticket, MCP, Condition and Approval nodes;
Command nodes cover your own tools. Explicit instructions such as "CLI only" win.
**✦ Assist** improves or rearranges an existing workflow through the same reviewed preview.

<br clear="all" />

## What you get

- **Visual workflow canvas.** Start, Command, Human Approval, AI Agent, Condition, Git,
  GitHub, Ticket (Jira via MCP), MCP Tool and End nodes; validation badges, run overlays,
  dependency-aware layout, and Simple/Advanced JSON.
- **Real control flow.** Constrained conditions (no scripting), parallel branches with
  joins, failure edges, bounded retries with backoff, guarded review/fix loops, per-node
  timeouts and typed workflow inputs.
- **Agent profiles.** Model, working directory and setup checks per profile for Claude
  Code, Codex, Gemini CLI, Google Antigravity CLI, OpenCode and Muse Code, plus
  one-click Custom CLI setups for GitHub Copilot CLI, Cursor CLI, Qwen Code, Amp,
  Aider, Goose and Kiro CLI. Claude Code and Codex also support managed sessions and
  structured run activity. [Supported CLI capabilities](./docs/agents.md#supported-clis)
- **Readable runs.** Step cards built from what the CLI reported: files changed, test
  results from the runner's own exit code and summary, failed commands, the agent's
  task list and what it is doing now. Text the agent wrote about itself is labelled as
  its words. **Review rounds** shows fixed, still-open, new and reintroduced
  findings with severity changes.
- **Feedback during a run.** Write a note on any step while the run is going. Before
  the run publishes, hits an approval or finishes, the step checks it against its work;
  if a change is needed it reruns with your note, and the steps that use its work
  rerun after it. Feedback that arrives after publishing is recorded, never applied.
- **Integrations.** Safe Git operations (dirty or lossy states refused), GitHub through
  your own `gh` (draft PRs, checks, comments), and 22 ready-made MCP setups for Jira,
  Slack, Google Workspace, Microsoft 365, Notion, GitHub, Linear, Sentry, docs and data
  tools, with **Check server** to test one before a workflow depends on it. Steps that
  push, open pull requests or comment are marked as publishing.
- **n8n import and export.** Commands, Git and GitHub steps, agents, conditions,
  approvals and tickets map to Execute Command, If, Wait and Jira nodes and back; the
  conversion notes list everything else.
- **Local automation.** Durable schedules, PR review and feedback watchers with bot-loop
  guards, a notification inbox, and opt-in background mode. Schedules that write need a
  per-schedule trust opt-in.
- **Templates and Playbooks.** Thirteen built-in templates (three use MCP), versioned
  JSON import and export, and per-repository test, lint and build commands, conventions
  and reviewer choices that **Detect commands** fills from package.json, Cargo.toml,
  Makefile, go.mod, pyproject.toml and more.
- **Run controls.** Dry runs with fixtures, agent-attempt budgets, an optional guard on
  CLI-reported spend, and recovery of failed runs from their original inputs.

## Workflow recipes

| Start with                | Typical sequence                                           | What you configure                                   |
| ------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| A change you want to make | Plan → Approve → Implement → Test → Review                 | Repository, agent profiles, real test command        |
| A tracked ticket          | Read Ticket → Plan → Approve → Implement → Test → Draft PR | Jira MCP, `git`/`gh`, profiles, explicit write steps |
| An existing PR            | Read PR → Independent reviews → Summarize → Human decision | Authenticated `gh`, PR input, reviewer profiles      |
| A nightly sweep           | Schedule or watcher → Review → Inbox notification          | Trusted schedule, read-only scope, reviewer profiles |
| A page, docs or a channel | MCP tool (Fetch, AWS Knowledge, Slack) → Brief             | The MCP setup, a planning profile                    |

Keep commits, pushes, comments and PR creation explicit in the graph. A review or a
passing test never merges anything unless you add that write step.

## Choose the right node

| Work                                              | Node                       | Configuration                        |
| ------------------------------------------------- | -------------------------- | ------------------------------------ |
| Implement, plan, or review code                   | AI Agent                   | Profile, prompt, repository, timeout |
| Inspect a repository or manage branches/worktrees | Git                        | Supported operation and repository   |
| Inspect a PR, create a draft PR, or add a comment | GitHub                     | Operation through authenticated `gh` |
| Read a Jira ticket                                | Ticket                     | Enabled MCP server and ticket key    |
| Call another integration operation                | MCP Tool                   | Discovered tool and JSON arguments   |
| Run tests, Docker, or unsupported CLI operations  | Command                    | Executable and separate arguments    |
| Choose a path or pause for a decision             | Condition / Human Approval | Condition or approval message        |

More: [execution semantics](docs/execution.md), [agent profiles and permissions](docs/agents.md),
[scheduling](docs/scheduling.md), [workflow costs](docs/workflow-costs.md) and the
[workflow schema](docs/workflow-schema.md).

## Orchevia and n8n

n8n automates web services with hundreds of integrations and runs on a server you host
or n8n hosts. Orchevia is a desktop app for coding agents working in your repositories:
approvals, cross-review rounds, bounded fix loops, Git and pull requests, with your own
CLI sign-ins and no server. They work well together: export a workflow to n8n when it
needs SaaS glue, or import an n8n workflow to run its commands and agents locally.

## Safety model

- **Explicit execution.** Opening, importing or previewing a workflow never runs it.
  Executables and arguments are passed separately; a shell runs only when a Command node
  asks for one.
- **Permissions you can read.** Profiles pass permission flags only on the command line;
  Orchevia never edits your Claude Code or Codex settings. Tools that Claude Code refuses
  fail the step instead of passing silently.
- **Untrusted input stays data.** Ticket text, PR content, imported workflows and AI
  output are treated as untrusted. Imports refuse files that contain credential-like
  fields.
- **Your machine, your permissions.** Steps run with your user permissions and are not
  sandboxed. Cancel and timeouts stop the step's process group on Linux and macOS.

Details: [security model](./docs/security.md) and [SECURITY.md](./SECURITY.md).

## Current limits

- **Beta:** Linux x86_64 and macOS (Apple Silicon and Intel). Windows is not supported
  yet. macOS builds are ad-hoc signed but not notarized, so the first launch needs
  **Open Anyway**.
- **Tools and sign-in:** install and authenticate CLIs yourself. Orchevia reads only
  `PATH` from your login shell; Jira and other MCP servers may need credentials in the
  environment the app was started from.
- **Local scheduling:** the app must be running. Background mode keeps it running when
  the window closes (with a tray icon where the desktop shows one); there is no cloud
  worker.
- **Refusal detection:** Codex reports no refusal events, and neither do Claude profiles
  whose extra arguments force text output (`--output-format`), so refused tools in
  those steps are not detected.

## Build from source

```bash
git clone https://github.com/iazaran/orchevia.git
cd orchevia
pnpm install
pnpm tauri dev   # the desktop app; `pnpm dev` is a browser demo with a mock backend
```

You need Node.js 24+, pnpm 10+, Rust stable, and the platform dependencies in
[the development guide](./docs/development.md). The project is split into `src/`
(React UI behind a typed `Backend` interface), `src-tauri/` (thin desktop commands) and
`crates/core/` (workflow model, validation, DAG engine, SQLite, scheduler, CLI adapters
and the generation compiler). Run the same checks as CI before opening a PR:

```bash
pnpm check
cargo test -p orchevia-core
cargo clippy -p orchevia-core --all-targets -- -D warnings
cargo fmt --check
cargo check -p orchevia
```

## Contributing and support

Contributions are welcome: workflow recipes, clearer setup guidance, accessibility
improvements, bug reports with a redacted log, or code. Start with
[CONTRIBUTING.md](./CONTRIBUTING.md), the [Code of Conduct](./CODE_OF_CONDUCT.md) and the
[roadmap](./ROADMAP.md). Questions go through [SUPPORT.md](./SUPPORT.md); please report
vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).

If Orchevia saves you a few terminal round-trips, a ⭐ helps other developers find it.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
