# ADR 0001 — Tauri 2 + React + SQLite

- Status: accepted
- Date: 2026-09-22
- Context: Orchevia must be a fast, polished, local-first desktop app for macOS and
  Linux that orchestrates local CLIs, persists workflows/runs durably, and stays
  maintainable as an open-source project.

## Decision

- **Tauri 2** (not Electron): native webview shell, small binaries, Rust backend in the
  same process model, lower memory footprint. No Electron.
- **Rust** for execution/persistence/process management: safe process APIs, strong
  SQLite story (`rusqlite` bundled), fearless concurrency for the engine.
- **React + TypeScript (strict) + Vite**: largest contributor pool, excellent canvas
  ecosystem (**XYFlow/React Flow**), fast HMR.
- **SQLite** (bundled, WAL): single-file local durability, zero-config, SQL query power
  for run history; migrates cleanly as the schema grows.
- **Zustand**: minimal, hook-based state without boilerplate; canvas perf via local
  React Flow state, not global store.
- **pnpm**: fast, disk-efficient, strict lockfile discipline.

## Consequences

- Contributors need Rust + Node toolchains and (for desktop builds) OS webview dev
  libraries; the browser mock backend keeps UI iteration dependency-free.
- Core logic must stay in the Tauri-free `orchevia-core` crate so tests run without
  system webview libraries.
- Unsigned macOS builds until signing/notarization is set up (documented limitation).
