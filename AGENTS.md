# AGENTS.md — instructions for coding agents (and humans) working in this repo

Orchevia is a local-first desktop app (Tauri 2 + Rust + React/TypeScript) that
orchestrates locally installed developer CLIs through visual workflows. It is
not an AI provider: no accounts, no API keys, no telemetry.

## Commands (run all before finishing)

```bash
pnpm check                                   # format:check + lint + typecheck + tests
cargo test -p orchevia-core
cargo clippy -p orchevia-core --all-targets -- -D warnings
cargo fmt --check
cargo check -p orchevia                      # Tauri shell (needs no extra setup here)
```

Fix failures instead of weakening rules. `pnpm dev` runs the UI with a
`localStorage` mock backend; `pnpm tauri dev` runs the real desktop app. Only
one copy runs (single-instance guard, shared identifier and data folder): quit
an installed Orchevia first, or the dev build just focuses it and exits.

## Architecture (do not blur these lines)

- `src/` (React UI) never spawns processes or touches SQLite. All backend
  access goes through `src/lib/backend.ts` (`Backend` interface).
- `MockBackend` (same file) keeps `pnpm dev` usable; every `Backend` method
  needs a mock twin with identical semantics (including error cases).
- `src-tauri/src/commands.rs` holds thin Tauri commands over `orchevia-core`.
  Register new commands in `src-tauri/src/main.rs`.
- `crates/core/` is the authority: workflow model, validation, engine,
  scheduler, SQLite, process runner, CLI adapters. No `expect()`/`unwrap()` on
  production paths (tests only).

## TypeScript ↔ Rust contract (most bugs live here)

- Serde is `camelCase` everywhere: Rust `working_dir` ↔ TS `workingDir`,
  `agent_profile_id` ↔ `agentProfileId`. Tauri auto-converts command args
  (`run_id` ↔ `runId`). Mirror every field on both sides.
- `CURRENT_SCHEMA_VERSION` must match in `crates/core/src/workflow.rs` and
  `src/lib/workflow.ts` (pinned by tests on both sides). Bump + add a
  `migrate_workflow` step for breaking changes; new optional fields need no
  migration but need the TS mirror + validation mirror.
- Validation is mirrored: `validate_workflow` (Rust, authoritative) and
  `validateWorkflowLocal` (TS, responsive). Same codes, same fallback logic
  (e.g. workflow `defaults.repoDir` satisfying `git-dir-required`).
- `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` are on: never
  assign explicit `undefined` to optional props (build clean objects or use the
  `setWorkflowDefaults`-style helper), and never index without a check.
- Prettier is law (`pnpm format:check` runs in CI). ESLint runs with
  `--max-warnings 0`; `String(x)` conversions are required by
  `restrict-template-expressions`.

## UI conventions

- Never `window.confirm` / `window.prompt` / `alert` — use `confirmDialog()`
  (resolves `false` when the host isn't mounted; zero native dialogs policy).
- Never hand-roll ✕ buttons, banners, or modal shells — use the shared
  components in `src/components/`: `<CloseButton variant>` (`modal` | `card`
  | `notice` | `ghost`), `<Notice variant onDismiss>` (info/warn/error
  banners), `<Modal label onClose onBackdrop>` (dialogs). Backend rejections
  become messages via `errorMessage()` (`src/lib/errors.ts`), never inline
  ternaries; guarded `localStorage` goes through `readLocal`/`writeLocal`
  (`src/lib/storage.ts`). Inline destructive-adjacent buttons:
  `.btn-ghost.danger-hover`.
- Status pills: `status-running/succeeded/failed/paused/cancelled` (+ LIVE
  `.live-badge`). Node accents live in `NODE_KIND_META` (keep hues distinct).
- Dark-first via CSS vars in `src/styles.css`; light theme is
  `[data-theme='light']` overrides only. Long text: capped scroll regions,
  `<details>` expansion, ellipsis + `title` tooltips — never an unbounded wall.
- Timestamps: `formatTime`/`formatDate` from `src/lib/time.ts` (exact value in
  `title`). Destructive actions always confirm; empty/loading/error states on
  every view; `aria` labels on icon-only buttons.

## Domain notes

- Generation: goal → local CLI drafts JSON → `parse_proposal` →
  `compile_proposal` (repairs, never silent drops) → preview (never auto-runs).
  Prompt lives in `build_generator_prompt`; explicit user instructions override
  native-node defaults. Proposals carry roles, never profile ids (resolved at
  compile). `RepoContext` grounds drafts in a real repo.
- Engine: DAG scheduler (≤4 concurrent), bounded retries, guarded review loops,
  durable approvals, per-node timeouts (cap `MAX_TIMEOUT_SECS` = 12 h),
  `extend_on_output` slides the deadline on output activity. Timeouts kill but
  keep partial output.
- Workflow `defaults` (`repoDir`/`branch`): node config always wins; engine,
  validation, and inspector must agree on the fallback chain.
- Tests: colocated `*.test.ts` (vitest) and `#[cfg(test)]` modules (in-memory
  SQLite via `open_in_memory`, `__setMockBackendForTests` for frontend). Add or
  adjust tests for every behavior change.

## Docs to update with behavior changes

`CHANGELOG.md` (Keep a Changelog), `implementation-plan/` notes, `ROADMAP.md`
if direction changes, `docs/*.md` for the area you touched.
