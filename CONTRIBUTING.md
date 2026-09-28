# Contributing to Orchevia

Thanks for your interest in Orchevia! This guide gets you from clone to running app and
passing checks.

## Prerequisites

- **Node.js** 22+ and **pnpm** 10+ (`corepack enable && corepack prepare pnpm@10 --activate`)
- **Rust** stable via [rustup](https://rustup.rs/)
- **Linux (Debian/Ubuntu) system deps** for Tauri development:

  ```bash
  sudo apt update
  sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf \
    libsoup-3.0-dev libjavascriptcoregtk-4.1-dev build-essential curl wget \
    file libssl-dev libgtk-3-dev libayatana-appindicator3-dev
  ```

- **macOS**: Xcode command-line tools (`xcode-select --install`). Rust + Node as above.

## Getting started

```bash
git clone https://github.com/iazaran/orchevia.git
cd orchevia
pnpm install

# Fastest UI loop: browser with a local mock backend (no Tauri needed)
pnpm dev

# Full desktop app
pnpm tauri dev
```

The browser mock backend persists workflows to `localStorage` and simulates execution — look
for it whenever Tauri APIs are unavailable. Real execution only happens in the desktop app.

## Commands

| Command                                                      | What it does                                         |
| ------------------------------------------------------------ | ---------------------------------------------------- |
| `pnpm dev`                                                   | Vite dev server (browser, mock backend)              |
| `pnpm build`                                                 | Typecheck + production frontend build                |
| `pnpm test`                                                  | Frontend tests (Vitest)                              |
| `pnpm lint`                                                  | ESLint (zero warnings allowed)                       |
| `pnpm typecheck`                                             | `tsc --noEmit` (strict)                              |
| `pnpm format`                                                | Prettier write; `format:check` verifies              |
| `pnpm check`                                                 | Closest local equivalent of CI                       |
| `pnpm tauri dev`                                             | Desktop app in development                           |
| `pnpm tauri build`                                           | Desktop packages                                     |
| `cargo test -p orchevia-core`                                | Rust core unit tests (no system webview libs needed) |
| `cargo clippy -p orchevia-core --all-targets -- -D warnings` | Rust core lints                                      |
| `cargo fmt --check`                                          | Rust formatting                                      |
| `cargo check -p orchevia`                                    | Desktop command type checking                        |
| `cargo test -p orchevia`                                     | Desktop command tests (needs webview dependencies)   |

## Project layout

```text
src/                 React frontend (no process logic here — ever)
  lib/               workflow domain mirror, backend abstraction
  components/        views: Workflows, Runs, Environment
  store.ts           Zustand app state
src-tauri/           Tauri shell and thin commands over the core
crates/core/         orchevia-core: workflow model, SQLite, process, tool discovery
docs/                landing page (index.html) + architecture/security/dev docs
implementation-plan/ staged milestone prompts (not shipped to users)
```

Rules of thumb:

- UI must not spawn processes or touch SQLite — use the typed backend interface.
- CLI specifics live behind adapters; the engine stays provider-neutral.
- Workflow JSON is versioned (`schemaVersion`); add migrations, never break old files silently.
- No `any` in TypeScript (document unavoidable exceptions), no `unwrap()`/`expect()` in Rust
  production paths, no `unsafe` without explicit justification.

## Tests

- Frontend: `pnpm test` (Vitest + Testing Library, jsdom). Domain, serialization, backend
  mock, and component interaction tests. No network, no real CLIs.
- Rust: `cargo test -p orchevia-core` covers workflow validation, execution order,
  persistence round-trips, safe process execution, and tool discovery with fakes.
- Add a test with every behavior change. Deterministic only — no sleeps against real time
  where avoidable, no external services.

## Pull requests

1. Fork, branch from `main` (`feature/<name>`).
2. Run all required checks in [AGENTS.md](./AGENTS.md) before pushing.
3. Fill in the PR template: what/why, testing, screenshots for UX changes, breaking changes.
4. CI must be green: frontend checks, Rust fmt/clippy/tests, smoke build, installer artifacts.

## Code of Conduct

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md). Be kind, be
precise, assume good intent.
