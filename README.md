# Orchevia

> **Describe the task once. Inspect the plan as a graph. Let your own AI CLIs do the work.**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)

[Installation and availability](#install) · [Documentation](./docs/architecture.md) · [Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) · [Report an issue](https://github.com/iazaran/orchevia/issues/new/choose)

Orchevia is a **local-first** desktop app for visual developer workflows. You describe
a task — _"implement this ticket with Claude, review with Codex, open a draft PR"_ — inspect
it as a graph of steps, press **Run**, and each step executes through **tools already
installed on your machine**: Claude Code, Codex, `git`, `gh`, your test commands.

**Orchevia is not an AI provider.** No Orchevia account, model API key configuration, telemetry, or hosted execution service.
AI work is delegated to CLIs you installed and authenticated yourself.

**Who it's for:** developers who already drive Claude Code / Codex from the terminal and want
repeatable, inspectable, one-click flows (plan → approve → implement → review, ticket →
branch → draft PR, nightly review sweeps) without sending code to an Orchevia service. Your AI CLIs may contact their own providers.

![Example Orchevia workflow: Start → Implement with Claude → Human Approval → Review with Codex → End](./docs/workflow-visual.svg)

## Install

The newest verified installer set is [v0.1.2](https://github.com/iazaran/orchevia/releases/tag/v0.1.2) (checked 2026-10-01).
[v0.1.3](https://github.com/iazaran/orchevia/releases/tag/v0.1.3) is marked Latest but has **no installer assets**.
Its release build failed on Intel macOS; all v0.1.3 downloads and checksums remain pending.
The links below intentionally point to the published v0.1.2 files. A tag or release page alone does not prove files exist.
The repository and release files are **private for now**: sign in to GitHub with an
account that has repository access. The repository and downloads will be public soon.

| Platform                    | Installer                                                                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS Apple Silicon (arm64) | [.dmg](https://github.com/iazaran/orchevia/releases/download/v0.1.2/Orchevia-macos-arm64.dmg)                                                                                                            |
| macOS Intel (x86_64)        | [.dmg](https://github.com/iazaran/orchevia/releases/download/v0.1.2/Orchevia-macos-x86_64.dmg)                                                                                                           |
| Linux x86_64                | [AppImage](https://github.com/iazaran/orchevia/releases/download/v0.1.2/Orchevia-linux-x86_64.AppImage) · [.deb](https://github.com/iazaran/orchevia/releases/download/v0.1.2/Orchevia-linux-x86_64.deb) |

Verify downloads against [SHA256SUMS](https://github.com/iazaran/orchevia/releases/download/v0.1.2/SHA256SUMS).
macOS installers are unsigned and not notarized; on first launch, right-click the
app and choose **Open**. See the release notes for the quarantine-removal command.
Download the installer you need and `SHA256SUMS` into the same directory, keep the
published filenames, then verify the file you downloaded:

```bash
# Linux
sha256sum -c SHA256SUMS --ignore-missing
# macOS
shasum -a 256 -c SHA256SUMS --ignore-missing
```

Require an `OK` result for your installer. Stable `latest/download` links are not
used while GitHub's latest release has no files. Contributors can inspect
[CI checks](https://github.com/iazaran/orchevia/actions/workflows/ci.yml) and the
[release workflow](https://github.com/iazaran/orchevia/actions/workflows/release.yml)
while signed in; private workflow badges do not load reliably for readers.

### Build from source

Contributors with repository access can also build from source:

```bash
git clone https://github.com/iazaran/orchevia.git
cd orchevia
pnpm install
pnpm tauri dev
```

You need Node.js 24+, pnpm 10+, Rust stable, and the platform dependencies listed in
[the development guide](./docs/development.md). `pnpm dev` opens a browser demo backed
by localStorage; it does **not** run real CLI processes. The desktop app does.

Optional tools (`git`, `gh`, `claude`, `codex`) are detected locally; install and
authenticate the ones your workflows need.

## Your first workflow in 5 minutes

1. **Open Orchevia** — the first-run wizard detects your tools and creates Claude + Codex
   agent profiles. (Reopen it anytime from the sidebar.)
2. **Workflows → Samples… → Plan → Implement → Review → Create.** A ready-made graph
   appears on the canvas: Claude plans, **you approve the plan**, Claude implements,
   Codex reviews.
3. **Select any node** to configure it (profile, prompt, timeout). Validation badges on
   the canvas tell you what's missing before you run.
4. **Press ▶ Run.** Execution is always explicit — opening a workflow never runs it.
   Watch progress on the canvas, inspect live per-node stdout/stderr under **Runs**, approve
   the paused gate, or cancel anytime.
5. **Go further:** describe a goal with **✦ Generate** (your local CLI drafts a validated
   preview — never auto-runs), save flows as reusable **Templates**, or schedule nightly
   runs under **Automations**.

```text
Start → Implement (Claude) → Human Approval → Review (Codex) → End
```

## What you get

- **Visual workflow canvas** — Start, Command, Human Approval, AI Agent, Condition,
  Git, GitHub, Ticket (Jira via MCP), MCP Tool, End nodes; edge labels, validation
  badges, run-status overlays, duplication, and a readable starting view for large flows.
- **Real control flow** — constrained conditions (no scripting), parallel branches with
  joins, failure-recovery edges, bounded retries with backoff, guarded review/fix loops,
  per-node timeouts, typed workflow inputs.
- **Agent Profiles** — per-CLI model/effort/working-directory configuration for Claude
  Code, Codex, or any custom CLI; optionally select installed CLI skills for a profile
  or let the CLI choose them. `{{variable}}` prompt templating uses inputs and upstream
  outputs; missing CLIs fail validation clearly.
- **Git/GitHub/Jira integrations** — safe git ops (dirty/lossy states refused),
  GitHub via your own `gh` (draft PRs, checks, comments), Jira tickets via a local MCP
  server, generic MCP tool calls with provenance.
- **Local automation** — durable schedules, opt-in tray background mode, GitHub
  review/feedback watchers with bot-loop guards, normalized P0–P3 findings,
  trust-gated writes, notification center.
- **Local-first persistence** — workflows, runs, profiles, schedules, templates, and
  memory live in SQLite on your machine, with versioned JSON import/export.
  Authentication stays in your CLI or MCP server configuration.
- **Explicit execution** — executables and arguments are passed separately; a Command node
  can explicitly invoke a shell. The active child is stopped
  on cancel, ticket/PR content is treated as untrusted input.

How it fits together: [docs/architecture.md](./docs/architecture.md) ·
[workflow schema](./docs/workflow-schema.md) · [security model](./docs/security.md) ·
[site source](./docs/index.html).

## How generation works

A configured local AI CLI drafts a proposal. Orchevia validates and compiles it into a
preview you can edit before running. It uses native Agent, Git, GitHub, Ticket, MCP,
Condition, and Approval nodes when they fit the goal; Command nodes cover local tools
and unsupported operations. Explicit instructions such as “CLI only” take priority.
Compiler notes show any repair or setup needed before you accept the workflow.

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

For example, declare a `ticket` input and ask Generate:

> Read Jira ticket {{input.ticket}}, plan its implementation with Claude, pause for
> my approval, implement and run the repository's tests, then request one Codex
> review. Use native nodes and leave all changes uncommitted.

Review the preview's setup checklist, assign the intended profiles, and inspect
write operations before accepting. A goal is a draft specification; generation is
not a guarantee that every requested integration operation is supported.

## Current limits

- **Beta:** version 0.1.3 targets Linux x86_64 and macOS Apple Silicon/Intel.
  Windows is not supported. macOS installers are unsigned and not notarized.
- **Tools and authentication:** install and authenticate CLIs yourself. Jira and
  other MCP servers may need credentials in their inherited environment.
- **Local scheduling:** the app must stay running; enable background mode to keep
  schedules active after closing the window. There is no remote worker service.
- **Execution permissions:** commands and agents run with your user permissions.
  Orchevia does not sandbox them. A Command node can explicitly invoke a shell.
- **Profiles and skills:** model availability depends on your CLI/account. Skill
  discovery reads metadata; use a small workflow to check that a skill loads.

## For developers

- `src/`: React editor and a typed `Backend` interface. `pnpm dev` uses the
  browser mock to iterate on views and interactions without native processes.
- `src-tauri/`: desktop shell and thin commands that expose core behavior.
- `crates/core/`: workflow schema, validation, DAG engine, local SQLite,
  scheduler, CLI adapters, Git/GitHub/MCP integrations, and generation compiler.
- `docs/`: architecture, [workflow schema](./docs/workflow-schema.md),
  [security model](./docs/security.md), and the [development guide](./docs/development.md).

Run the same checks used by CI before a PR:

```bash
pnpm check
cargo test -p orchevia-core
cargo clippy -p orchevia-core --all-targets -- -D warnings
cargo fmt --check
cargo check -p orchevia
```

Generation asks the selected local CLI for a compact JSON proposal. It now shows
configured role/profile mappings and discovered MCP tool names to the generator;
compilation validates the graph and exposes required setup before accepting it.
For Jira Cloud, the MCP guide uses `JIRA_URL`, `JIRA_USERNAME`, and
`JIRA_API_TOKEN`. Raw shell commands may demand different variables; inspect
Command nodes before Run. The Runs view keeps per-node output and errors so a
failed step is traceable.

## Roadmap

Short version: visual editor → agent profiles → advanced engine → Git/GitHub/Jira/MCP →
scheduling & PR review loops → NL generation + local memory → hardening → public beta.
Full version: [ROADMAP.md](./ROADMAP.md).

## Contributing

Contributions are welcome! Start with [CONTRIBUTING.md](./CONTRIBUTING.md) and the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

See [SECURITY.md](./SECURITY.md). Orchevia executes local commands on your behalf:
workflows are explicit, commands can be previewed before running, and ticket/PR
content is treated as untrusted input. Output is stored locally and may contain
sensitive data; review it before sharing.

## Support

Questions? See [SUPPORT.md](./SUPPORT.md) for where to ask and how to file useful bug reports.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
