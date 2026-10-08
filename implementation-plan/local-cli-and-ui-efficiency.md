# Local CLI reliability and UI efficiency — v0.1.12 plan

**Goal:** Make Orchevia use the developer's installed `claude`, `codex`, `git`, `gh`
and MCP servers more reliably from a desktop launch, and run them more efficiently,
without changing what the product is.
**Base:** `main` @ `b782dbe` (clean). Branch `claude/v0.1.12-local-cli-ui-efficiency`.
**Delivery:** the maintainer asked for a single v0.1.12 PR. The two planned slices
(core/native CLI reliability, frontend refresh efficiency) stay in separate focused
commits and touch disjoint files; this note covers the CLI slice and the shared
decisions, `ui-efficiency-reliability.md` covers the UI slice.

## Constraints

- No provider SDKs, API keys, credential storage, telemetry, hosted execution or
  network calls from Orchevia. Opening/editing/importing/previewing never runs.
- No workflow-schema, import or DB changes. No new Backend methods.
- Claude Code, Codex and Custom CLI profiles keep working; Custom keeps argv prompts.
- Linux x86_64 and macOS are targets; Windows keeps today's behavior (no regressions).
- `libc` (already in `Cargo.lock`, 0.2.189) becomes a direct `orchevia-core`
  dependency, only for process-group signals on Unix.

## Baseline (before changes)

`pnpm check` (37 files, 242 tests), `cargo test -p orchevia-core` (336 tests),
clippy `-D warnings`, `cargo fmt --check`, `cargo check -p orchevia`: all pass.

## Leads checked against the code

### Confirmed

| Lead                                                                   | Evidence on `b782dbe`                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fallback list misses nvm, fnm, bun, cargo, pnpm, Linuxbrew, Claude dir | `tools.rs` `fallback_candidates` lists only `.local/bin`, `.npm-global/bin`, `.volta/bin`, `.asdf/shims`, mise shims and five fixed dirs.                                                                                                                                   |
| Exec bit ignored                                                       | `find_on_path` / `fallback_candidates` use `is_file()` only.                                                                                                                                                                                                                |
| Lookup rescans before every spawn                                      | `require_executable` → `find_executable` in `process.rs:71`, `engine.rs:3513`, `mcp.rs:163`, plus `is_executable_available` per agent node.                                                                                                                                 |
| Children inherit the GUI `PATH`                                        | No `PATH` is set on any `Command` (`process.rs`, `engine.rs` tokio spawn, `mcp.rs`, `notify.rs`). A found npm/nvm `claude` with `#!/usr/bin/env node` fails when `node` is only on the shell `PATH`.                                                                        |
| Probes block the main thread                                           | `detect_tools`, `test_agent_profile` are sync `#[tauri::command]`s (Tauri 2 runs these on the main thread) that run `--version` with a 5 s timeout each.                                                                                                                    |
| Misleading error                                                       | `require_executable` tells users to "launch Orchevia from a terminal once".                                                                                                                                                                                                 |
| Prompt in one argv element                                             | `build_agent_command` (`agents.rs:479-512`) and `build_session_command` (`-- <prompt>`, `agents.rs:639`). Stdin is null (`process.rs:84`, `engine.rs:3528`). Handoffs/templated outputs reach `MAX_STREAM_CHARS = 200_000` chars (`engine.rs:120`), above Linux's 128 KiB `MAX_ARG_STRLEN`, and argv is visible in `ps`. |
| Ordinary nodes report no usage                                         | Only managed session-group nodes create `AgentOutput` (`engine.rs:3064`); plain nodes run `--output-format text` / plain `codex exec`, so the spend guard (`run_controls.rs:289`) counts them as unknown.                                                                  |
| Only the direct child is killed                                        | `child.kill()` at `engine.rs:3612/3659/3675/3717`, `process.rs:180/205`, `mcp.rs:255/259/275`. No process groups anywhere.                                                                                                                                                  |
| MCP exchange can hang                                                  | `mcp.rs` `run_bounded` uses `std::thread::scope`; the scope joins the worker, which can block forever in `read_line` while a grandchild holds the server's stdout after the kill.                                                                                            |
| App quit leaves children                                               | `main.rs` ends with `.run(generate_context!())`; nothing signals children on exit, and `kill_on_drop` covers only direct tokio children whose futures are dropped.                                                                                                         |

### Rejected or narrowed

- _"Cancel/timeout can hang on pipes in the engine and `process.rs`."_ Narrowed: both
  already bound drains (2 s `recv_timeout` / `tokio::time::timeout`) and abort readers
  on cancel. Only `mcp.rs` was unbounded. The fix is still applied everywhere through
  process groups, so descendants stop instead of being abandoned.
- _"Generator prompts can exceed argv limits."_ Rejected for size:
  `generation.rs` refuses prompts over 100,000 bytes. The generator still moves to
  stdin (same text mode, so `parse_proposal` is unchanged) to keep prompts out of `ps`.
- _"Generator/assistance should get structured output."_ Not clearly safe: generation
  parses the CLI's text as proposal JSON and stores no usage. It stays in text mode.
- On this machine `claude`/`codex` are native binaries in `~/.local/bin`, so the
  `#!/usr/bin/env node` failure applies to npm/nvm installs, not every install. The
  fix stays because it is the common npm installation path.

## Chosen changes (CLI slice)

1. **Search environment** (`tools.rs`).
   - `refresh_search_environment()` runs `$SHELL -i -l -c 'echo MARK; printenv PATH; echo MARK'`
     once (stdin null, own process group, 5 s hard timeout, killed on expiry,
     `ORCHEVIA_RESOLVING_ENVIRONMENT=1` set so rc files can skip slow work). Output is
     parsed between unique marker lines so rc-file banners are ignored. Only `PATH`
     is imported; no other variable is read.
   - Effective search `PATH` = login-shell `PATH`, then Orchevia's own `PATH`, then
     existing well-known dirs (now including nvm default/newest, fnm, `~/.bun/bin`,
     `~/.cargo/bin`, pnpm home, Linuxbrew, `~/.claude/local`). Failure/timeout keeps
     the safe fallback (current `PATH` + well-known dirs).
   - Every child gets this `PATH` (`process.rs`, engine tokio spawn, MCP, generator,
     git/gh, probes, notifications). Absolute executables in profiles/nodes are
     used verbatim, before any lookup.
   - Lookups cache resolved paths; a cache hit is re-validated with one `stat` (exec
     bit) so uninstalls fall back to a rescan. Resolution happens off the main thread
     at startup; Environment/Agents **Refresh** (`detect_tools`) invalidates and
     re-resolves. Callers that arrive mid-resolution wait (bounded by the timeout).
   - The exec bit is required on Unix. `detect_tools` and `test_agent_profile` become
     async commands using `spawn_blocking`. New error text: not found in the login
     shell `PATH` or common install locations; install it, set the full path in the
     profile/node, then Refresh.
2. **Prompts on stdin** (`agents.rs`, `process.rs`, `engine.rs`).
   - `CommandSpec` gains `stdin: Option<String>`. Claude: `claude -p …` with the
     prompt on stdin (verified: `claude --help` 2.1.233 reads the prompt from stdin
     when no positional prompt is given in `--print` mode). Codex: `codex exec … -`
     and `codex exec … resume <id> -` (verified: `codex exec --help` 0.159.3, "`-`
     reads instructions from stdin"). Skill prefixes stay at the start of the prompt.
     Custom CLI keeps the prompt as the final argument.
   - The runner writes stdin from a separate thread/task, then closes it (EOF). A CLI
     that exits early produces `EPIPE`, which is ignored; the writer never blocks
     result collection and is aborted on cancel/timeout.
   - `CommandSpec::preview()` appends `<prompt via stdin, N chars>`.
3. **Structured output for ordinary Agent nodes** (`agents.rs`, `engine.rs`).
   - Claude: `-p --output-format stream-json --verbose`; Codex: `exec --json`. The
     existing `AgentOutput` decoder produces the final text, usage, activity and
     errors exactly as for session groups; ordinary nodes store `agentUsage` and
     `agentActivity` without `agentSession`.
   - Node output (conditions, handoffs, templates, severity) is the decoded final
     response text. Plain text mode printed the same response plus a trailing
     newline; the decoded text has none, matching session-group nodes since v0.1.10.
   - Conflicting profile arguments (`--output-format` for Claude; `--json` /
     `--experimental-json` for Codex) keep the old text invocation for that node and
     record `agentOutputNote` metadata, shown in Runs with the agent context.
   - Generation/assistance keep text mode (see rejected leads).
4. **Process-tree cleanup** (`process.rs`, `engine.rs`, `mcp.rs`, `main.rs`).
   - Unix children start in their own process group. Cancel, timeout, MCP shutdown
     and app exit send `SIGTERM` to the group, wait up to 2 s, then `SIGKILL`.
     Normal exits keep today's behavior (background descendants are not killed).
   - A live-group registry plus an RAII guard kills the group if a future is
     dropped; `RunEvent::Exit` terminates every registered group.
   - `mcp.rs` uses a detached worker so a timeout or cancel always returns; drains
     stay bounded and partial output is preserved.
   - Windows: unchanged direct-child kill.

## Regression tests (fake CLIs only)

- Search env: noisy rc output parsing, timeout → fallback, exec-bit rejection, cached
  lookup re-validation, fake CLI with `#!/usr/bin/env <fake-node>` resolvable only
  through the resolved `PATH`.
- Stdin: >200 KB prompt through a fake CLI that reports the bytes it read (engine and
  sync runner), early-exit CLI (EPIPE) without hang, EOF observed (`cat`-style CLI).
- Structured: stream-json / JSONL fixtures → clean final text, usage recorded, spend
  guard sees the cost; conflicting-args fallback note; Custom CLI unchanged.
- Process groups: fake CLI that forks a sleeping grandchild leaves no process in its
  group after cancel and after timeout (engine + sync runner); MCP timeout returns
  promptly while a grandchild holds the pipe; partial output retained.

## Measurement scenarios

- Stdin: 300,000-byte prompt (> 128 KiB argv limit) accepted end to end; previously
  `E2BIG` at spawn. Reported in PR with the fake CLI's byte count.
- Process groups: grandchild survival count after cancel/timeout (before > 0, after 0).
- MCP: elapsed time of a 1 s timeout with a pipe-holding grandchild (before: until the
  grandchild exits; after: about 1 s + grace).
- UI counts: see `ui-efficiency-reliability.md`.

## Deferred (later PR, after this merges)

- Live-output persistence rewriting full streams every 250 ms under the capture lock
  (`engine.rs` ~3620-3642).
- SQLite: single `Mutex<Connection>`, no `busy_timeout`/`synchronous`, missing `runs`
  indexes, full-log loads for status/spend, deletes outside transactions, startup
  recovery via `list_runs(1000)` (`main.rs:63`).
- Tauri events instead of polling.
- Remaining blocking sync commands (`github_state`, `git_branches`, `diagnostics_bundle`).
- No timeout on OS notifications.
- Blocking `gh` calls inside the async scheduler.
- MCP discovery cache for generation.
- 25 ms busy-wait loops.
- A global concurrency limit for CLI processes.
- Generator prompt size and cache-friendly ordering.

## Results

Implemented as planned. Differences from the plan: OS notifications (`notify-send`,
`osascript`) keep the inherited environment because they are system binaries and
their timeout work is deferred; the login shell comes from `$SHELL` (falling back to
`/bin/zsh` on macOS, `/bin/bash` or `/bin/sh` elsewhere) rather than the passwd
database.

Measured on `main` @ `b782dbe` with the same fake processes, then on this branch:

| Scenario (Linux x86_64, fake CLIs)                         | Before                                     | After                                |
| ---------------------------------------------------------- | ------------------------------------------ | ------------------------------------ |
| Agent node with a 300,000-byte prompt                      | `Argument list too long (os error 7)`      | succeeds; CLI read 300000 stdin bytes |
| Ordinary Claude node `structured_json`                     | `{}` (no usage, spend guard blind)         | `agentUsage` incl. reported USD       |
| Engine cancel / timeout with a `sleep 30 &` grandchild     | grandchild alive afterwards (both)         | process group empty                  |
| Sync runner timeout with a grandchild                      | grandchild alive afterwards                | process group empty                  |
| MCP `list_tools` 0.5 s timeout, grandchild holds stdout    | returned after 30.3 s                      | returns within the 5 s test bound    |

Real CLI smoke calls (5 total, disposable git repo, temp database, launched with
`env -i … PATH=/usr/bin:/bin` to mimic a desktop launch; login-shell `PATH` resolved
including nvm): Claude `haiku` ×4, Codex `gpt-6-luna` (low effort, read-only
sandbox) ×1. Plain Claude and Codex nodes returned `OK` with usage (Claude
`reported_cost_usd` 0.022). A Claude run cancelled at 2.5 s ended `cancelled` with
usage kept and an empty process group. Two runs asking Claude to run a long idle
command through its Bash tool were declined by the CLI's own policy, so real
tool-subprocess cancellation remains a manual check.

## Status

- [x] Search environment, exec bit, async probes, error text
- [x] Stdin prompts
- [x] Structured output for ordinary nodes
- [x] Process-group cleanup and MCP bound
- [x] Docs, CHANGELOG, version 0.1.12, README/project page
- [x] Real CLI smoke checks
- [ ] Independent review (see PR)
