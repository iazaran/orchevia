# Security and trust model

Orchevia runs local commands on your behalf. This document states the guarantees,
the boundaries, and the limits of the current application.

## Guarantees

1. **Explicit execution.** Workflows run only via ▶ Run / approve-resume. Opening,
   importing, previewing, or editing a workflow never executes anything.
2. **No implicit shell.** `process.rs` and the Tauri engine pass executable + argv separately
   to the OS. Arguments containing `;`, `$()`, backticks, or pipes are inert data.
   The UI preview is shell-escaped for _display only_. A Command node can
   explicitly invoke `bash`, `sh`, or another interpreter; that script then has
   the full permissions of your user.
3. **Killing is real.** Cancel flips an atomic flag checked between nodes _and_ stops
   the in-flight child. On Linux and macOS each child leads its own process group;
   cancel, timeouts (default 10 min per command), MCP shutdown and app exit send
   `SIGTERM` to the group, wait up to 2 s, then `SIGKILL` whatever remains, so
   shells, MCP servers and `npx`/`uvx` descendants stop too. A normal exit leaves
   deliberately backgrounded descendants alone, and a tool that moves its own
   processes into a new session or group can still detach them. Windows stops only
   the direct child.
4. **Output hygiene.** stdout/stderr are truncated (256 KiB Rust core / 200k chars
   engine) to bound memory; environment variables are inherited but never dumped,
   logged, or persisted.
5. **No secret storage.** There is no field, table, or log for credentials. Do not paste
   tokens into workflow fields — they would land in SQLite-backed run history.
6. **Crash honesty.** Runs interrupted by an app restart are marked `failed`
   (“application restarted…”), never silently resumed mid-command.

## Boundaries

- Orchevia does **not** sandbox commands: a `rm -rf` node does what it says. The
  mitigation is visibility (preview + history), not containment. Read workflows before
  running them, especially imported ones.
- Third-party CLIs (Claude Code, Codex) act under their own permissions and may send
  prompt/repo content to their providers. Orchevia cannot make them offline and does
  not claim to.
- Ticket/PR text and imported workflows/templates are **untrusted input**. Future AI
  nodes must treat them as data, never as instructions.

## AI agent execution (Milestone 2)

1. **Explicit start.** Opening/importing a workflow never runs an agent; ▶ Run and
   approval-resume are the only triggers. Generated or imported agent nodes start
   disabled-by-validation until their profile exists and the CLI is on `PATH`.
2. **Informed approval.** The node inspector shows which CLI/profile will execute, the
   prompt template with referenced variables, and a shell-escaped argv preview.
   The first run of a repo-mutating profile should pass through a Human Approval gate
   (the demo workflow does: plan → approve → implement → review).
3. **No secrets by design.** Profiles store configuration only — no tokens, keys, or
   environment dumps. Credential-like extra args (`--api-key`, `password`, …) are
   rejected at validation; authenticate in your own CLI instead.
4. **No shell, no prompt-as-flags.** Claude and Codex read the prompt from stdin
   (`claude -p`, `codex exec … -`), so it never becomes flags, never hits argument
   size limits and does not show up in process listings. Custom CLIs get it as one
   final argv element. `agents.rs` is the only place adapter syntax lives.
5. **Explicit working directory.** Node or profile directories must exist before
   execution; the engine records used folders locally (paths only) for convenience.
   Agent runs inherit the process environment (needed by the CLIs) but Orchevia never
   persists it. The one change is `PATH`: Orchevia asks your login shell for it once
   (`$SHELL -i -l -c`, no terminal, 5 s limit, falling back to its own `PATH` plus
   common install directories) and uses that value for lookups and every child. Your
   rc files run during that probe exactly as they do when you open a terminal; no
   other variable is read or imported.
6. **Bounded + cancellable.** Node-or-profile timeout (1–43200 s) kills hung agents;
   cancel kills the in-flight child; missing prompt variables fail the node instead of
   sending a half-rendered prompt.

## Integrations (Milestone 4)

- **Repository mutation.** Git nodes refuse lossy states (no `--force`, no
  `reset --hard`, dirty checkout needs opt-in, commits need staging, worktree
  removal is clean-only and never touches the main checkout). Review the repo +
  branch + operation in run history before trusting a workflow.
- **Remote writes.** PR creation, comments, and reviewer requests only happen
  through explicit nodes with explicit config (title/base/head/body previewed).
  Scheduled/triggered remote writes additionally require trust opt-in (M5).
- **MCP tool invocation.** Servers are local commands you registered; only
  enabled servers run, with timeouts and provenance (`server:tool`) on every
  result. Importing a workflow does not disable an already enabled server;
  review its MCP nodes before running.
- **Prompt injection from ticket/PR text.** Ticket descriptions, PR bodies, and
  review comments are **untrusted input**. They are passed to AI agents as data
  and rendered into `ticket.*`/prompt variables with explicit bounds — never
  executed as instructions. AI-generated follow-ups (commits, comments) always
  pass through explicit nodes, never auto-fire.
- **Untrusted repositories.** Cloned content (hooks, branch names, file paths)
  is treated as data: branch names are validated, paths are explicit, and
  worktree execution is opt-in isolation, not a sandbox.
- **Secret handling.** `gh` tokens stay inside `gh`; MCP servers inherit the
  environment but Orchevia stores only command+args (no env values, no tokens).
  GitHub CLI error messages scrub token-shaped runs. This is not a general
  output sanitizer: run history stores tool output, which may contain sensitive
  information. Review logs before sharing them.

## Automation trust (Milestone 5)

- **Risk categories.** Every workflow is summarized as read-only, local write,
  repository mutation, remote write, and/or external tool use (computed from
  node kinds and ops — inspect it in Automations before enabling anything).
- **Explicit opt-in.** Schedules over anything above read-only require the
  Trusted checkbox; the trust check re-runs at fire time (workflows may have
  changed) and blocks with a clear message otherwise.
- **Disabled by default.** Created or imported schedules/watchers start
  disabled; enabling a watcher is itself the opt-in, recorded on the row.
- **No surprise writes.** Watchers only _start runs_; code changes, pushes,
  and comments happen exclusively through explicit workflow nodes. Feedback
  loops are bounded (`maxVisits`), never auto-resolve, and never force-push.
- **Bot-loop guards.** Watchers ignore the user's own comments, Orchevia's own
  comments (marker footer), and already-handled items; unchanged SHAs never
  re-fire.
- **Notifications, not silent action.** Approvals, failures, P0/P1 findings,
  and feedback events land in the Notification Center; system popups are an
  additional explicit opt-in (off by default).

## Generation safety (Milestone 6)

- **Untrusted proposals.** Generator output is parsed as data (JSON
  extraction), validated, capability-checked, and risk-analyzed before a human
  ever sees the preview — and previewed workflows never auto-run.
- **Constrained schema.** Unknown node types, invalid operations, and unbounded
  loops/retries are rejected. Only recognized workflow fields are compiled;
  proposals do not enable schedules. Arbitrary prompts and command arguments
  are not credential-scrubbed and must be reviewed before running.
- **Role indirection.** Generated workflows reference roles, never profile ids
  in proposals; repository paths may be supplied as context. Missing roles are
  shown as setup requirements before acceptance.
- **Memory hygiene.** Preferences hold role/profile names and booleans —
  never tokens. Import scans for credential-like values; export is
  human-readable JSON you can audit before sharing.

## Residual risk (accepted, documented)

- A malicious workflow file could include destructive commands; review before ▶ Run.
- `workingDir` is user-configured; path traversal inside a repo is the user's own
  filesystem — no privilege boundary is crossed, but destructive commands still apply.
- Unsigned macOS builds (see README) rely on user Gatekeeper bypass; verify checksums.

## Reporting

See [SECURITY.md](../SECURITY.md). Private advisories preferred; 72 h acknowledgment goal.
