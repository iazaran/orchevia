# Architecture

## Layers

```text
┌────────────────────┐
│  React UI          │  presentation only: canvas, inspector, runs, environment
│  src/              │  NEVER spawns processes or opens SQLite directly
└─────────┬──────────┘
          │ Tauri `invoke` (typed commands)
┌─────────▼──────────┐
│  Tauri shell       │  thin adapters: argument validation + task spawning
│  src-tauri/        │  commands.rs (per-command fns), main.rs (setup, recovery)
└─────────┬──────────┘
          │ in-process calls
┌─────────▼──────────┐
│  Engine            │  run lifecycle: validate → plan → execute → persist
│  src-tauri/engine  │  durable progress, approval resume, cancellation
└─────────┬──────────┘
┌─────────▼──────────┐
│  orchevia-core     │  Tauri-free library, unit-testable anywhere:
│  crates/core/      │  workflow.rs (model+validation+planning)
│                    │  db.rs (SQLite, WAL, migrations)
│                    │  process.rs (shell-free runner, timeouts, process groups)
│                    │  tools.rs (CLI discovery, login-shell PATH)
└────────────────────┘
```

## Why this split

- **Testability**: `orchevia-core` has zero GUI/system-webview dependencies, so
  `cargo test -p orchevia-core` runs on any machine (including CI containers and
  contributor laptops without GTK/WebKit dev packages).
- **Future adapters**: Milestone 2 adds Claude/Codex behind a trait in core; the engine
  and UI only see the adapter interface, so new CLIs mean new adapter + tests, not engine
  surgery.
- **UI stays honest**: the frontend mirrors the domain types (`src/lib/workflow.ts`) and
  re-validates locally for responsiveness, but the Rust backend is authoritative.

## AI CLI adapters (Milestone 2)

```text
┌──────────────┐   build_agent_command()   ┌──────────────┐
│ AgentProfile │ ────────────────────────▶ │ CommandSpec  │ ──▶ existing runner
│ (DB row)     │   claude.rs / codex.rs    │ (exe + argv) │     (no shell)
└──────────────┘   logic lives in          └──────────────┘
                   agents.rs only
```

- `crates/core/src/agents.rs`: `AdapterKind` (Claude/Codex), `AgentProfile` +
  validation, per-adapter argv construction, `AdapterInfo` for the UI. The engine
  never branches on adapter names — it calls `build_agent_command`. Optional
  profile skills become CLI-native prompt mentions (`/name` for Claude Code,
  `$name` for Codex). Discovery reads only local `SKILL.md` metadata from the
  selected CLI's personal and fixed-profile repository directories. It never
  copies skill bodies into Orchevia's database or runs skill scripts itself.
- `crates/core/src/prompt.rs`: deterministic `{{variable}}` templating (no eval).
  Engine exposes workflow vars + completed node outputs; missing names fail the node.
- `db.rs`: `agent_profiles` + `known_folders` tables (paths only, local-only).
- Engine `start_run` checks profile existence + CLI-on-PATH up front
  (`agent-profile-missing` / `agent-cli-unavailable`); `run_agent_node` renders the
  prompt, builds argv, validates the working directory, and runs via the existing
  cancellable runner with node-or-profile timeout.
- Tauri `commands.rs` adds `list_adapters`, profile CRUD, `preview_agent_command`,
  `test_agent_profile`, `list_known_folders`. Frontend mirrors in `src/lib/agents.ts`
  with the same validation rules; `AgentsView` + agent node inspector consume them.

## Integrations (Milestone 4)

- `git.rs`: safe repository operations over argv (`status`, `diff_summary`,
  `branch_create`, `checkout` with dirty guard, explicit `stage`, staged-only
  `commit`, `worktree_add/remove/list` with clean-only removal, `remotes`,
  conflict detection). No `--force`, no shell, lossy states refused.
- `github.rs`: `GhRunner` (configurable executable for fixture tests) wrapping
  `gh --json` with tolerant parsing into normalized PR/file/check/comment
  structs; auth reduced to boolean + username; stderr scrubbed of token shapes.
- `mcp.rs`: minimal stdio JSON-RPC client (initialize → tools/list → tools/call)
  on a worker thread with timeout/cancellation kill; server registry in SQLite
  (command + args only, never secrets).
- `ticket.rs`: `TicketSource` trait + Jira-over-MCP source with provider-neutral
  `NormalizedTicket` and bounded prompt context; ticket text stays untrusted data.
- Engine runs Git/GitHub/Ticket/Mcp nodes on blocking threads with provenance
  (`git`, `gh`, `jira-mcp`, `mcp:server:tool`) in `structured_json`, and exposes
  `ticket.*` aliases from the latest ticket result. `start_run` checks `git`/`gh`
  availability and MCP server state up front.

## Automation (Milestone 5)

- `schedule.rs`: schedule/watcher types, minimal 5-field cron, explicit-offset
  timezones, pure `next_run`/`evaluate` over injected `now` (fake clocks in
  tests), missed-run Skip/RunOnce, disabled-by-default.
- `scheduler.rs`: thin async driver over a `RunStarter` seam — claims due
  schedules (bounded concurrency, fire-time trust re-check), polls watchers
  with SHA/handled-set dedup and bot-loop guards, records notifications.
- `review.rs`: finding model, fenced-block extraction, FNV fingerprints,
  cross-agent dedup, per-run collection.
- `notify.rs`: preference-gated `emit_event` → Notification Center rows +
  opt-in OS dispatch (no new dependencies).
- `trust.rs`: risk categories from node mix + enable gates.
- Engine emits completion notifications (failures, pref-gated successes,
  actionable findings); scheduler-started runs carry the `run-sched-` prefix.
- Tauri: tray (generated icon, Show/Quit), hide-on-close background mode,
  60 s (configurable 30–3600 s) poll loop, settings allowlist, ~15 new
  commands. Frontend: Automations view (schedules/watchers/notifications/
  prefs), inbox bell, per-run findings, PR-review demo template.

## Generation, templates, memory (Milestone 6)

- `generation.rs`: versioned proposal schema, prose→JSON extraction, compile
  (known kinds, bounded numerics, edge/label checks, role resolution, full
  validation, risk analysis), generator prompt builder, blocking CLI runner.
  Proposals are untrusted until compiled; commands/shell/credentials/loops
  beyond bounds are rejected structurally.
  Generated Git/GitHub nodes carry an explicit tagged `gitOp`/`githubOp` from
  the proposal; missing operations fail compilation rather than defaulting to
  a read action. The prompt selects the smallest useful graph from supported
  capabilities while respecting explicit node restrictions. Ticket/MCP server
  wiring remains an after-preview setup step, while generated `mcpArgs` are
  preserved for the selected tool. Preview and accept never run the workflow.
- `templates.rs`: 8 versioned built-ins (role refs only) + user templates in
  SQLite; setup-tolerant instantiation (machine-local config reported, not
  fatal); import/export with credential scans.
- `memory.rs`: structured preferences, threshold suggestions (N=3, no
  re-nag after reject until reset), scoping, role-map application, portable
  export/import. DB: `preferences`, `observation_counts`, `generations`,
  `user_templates` tables.
- `workflow.rs`: `agent_role` refs + `resolve_agent_roles` (schema v5);
  engine rejects unresolved roles at start.
- Tauri: ~19 commands (generation flow, templates, memory, role map).
  Frontend: goal bar with preview/accept/retry/discard, Templates gallery,
  Memory view (suggestions, prefs, history), role-change observation.

## Data flow of a run

1. User clicks ▶ Run (explicit action — nothing auto-executes), optionally filling
   workflow inputs (defaults apply otherwise; required inputs block the start).
2. `run_workflow` loads the workflow, validates (errors block), merges input
   values, creates a `runs` row, and spawns a Tokio task; the command returns the
   run id immediately.
3. The DAG engine schedules ready nodes in definition order (up to 4 concurrent):
   `Start`/`End` record instantly; `Command`/`Agent` run via `tokio::process`
   (no shell, piped output, prompt on stdin, timeout, process-group stop on
   cancel/timeout) with bounded retries;
   `Condition` evaluates and routes; `Approval` pauses durably when nothing else
   is in flight. Untaken branches record `skipped`.
4. Command/Agent nodes create a `running` result row and update captured streams
   during execution; final status replaces the same row. Other node results
   (including `retrying` attempts and `skipped`) are written to SQLite before
   routing continues (durable progress with attempt/duration/structured extras).
5. `approve_run` records the decision (+ optional note) and resumes by replaying
   history — including after an app restart, since progress lives in the DB.
6. On startup, runs still marked `running` from a previous session are failed with
   “application restarted…”, because their child processes are gone and silently
   resuming external work would be unsafe. `paused` runs stay resumable.

## Persistence

- SQLite (bundled build, WAL mode, foreign keys on). Location: Tauri `app_data_dir`
  (`~/.local/share/dev.orchevia.app/orchevia.db` on Linux).
- Tables: `workflows(id, name, definition JSON, created_at, updated_at)`,
  `runs(id, workflow_id, status, started_at, finished_at, inputs JSON)`,
  `node_results(run_id, node_id, status, exit_code, stdout, stderr, error,
attempt, duration_ms, structured_json, …)`,
  `agent_profiles(id, name, definition, …)`, `known_folders(path, last_used)`.
- Workflow `definition` is the versioned JSON document (see `workflow-schema.md`,
  currently schema v3). Execution semantics: [execution.md](./execution.md).

## Frontend

- React 19 + TypeScript strict + Vite; Zustand store (`store.ts`); React Flow canvas.
- `lib/backend.ts` abstracts Tauri vs. browser: outside Tauri (plain `pnpm dev`) a
  `localStorage` mock simulates execution so contributors can iterate on UI without
  system deps. Real execution happens only in the desktop app.

## Performance notes

- Canvas renders memoized nodes only; run output arrives via 1.5 s polling and
  status badges — raw log tails never sit in high-frequency UI state, so
  200-node graphs and long agent sessions stay interactive (see validation
  benchmarks in core/frontend tests).
- No background polling except the active-run poller (plus the 60 s scheduler
  tick when automations exist); tool detection runs on demand.
- Parallel branches are bounded (≤4 concurrent nodes); SQLite writes serialize
  briefly on the DB mutex.
- Startup work: open one SQLite file, list workflows, recompute schedule slots
  — at launch, one background login-shell probe for `PATH` (5 s limit) and
  on-demand `--version` probes; nothing else is spawned.
