# Hardening notes (Milestone 7 audit)

What the pre-beta audit covered, what changed, and what residual risk the
project accepts. Honest limitations beat aspirational claims.

## Audit results

- **No TODO/FIXME debt** in shipped code; no `unsafe` Rust anywhere; no `any`
  in TypeScript (strict + exact optional properties throughout).
- **Panics:** production paths avoid `unwrap`/`expect`. Preview errors and
  desktop startup failures return or report errors instead of panicking.
- **Process safety:** spawns are argv-based without an implicit shell. A node
  may explicitly run an interpreter. Cancellation and timeouts stop the direct
  child; independently spawned descendants are not guaranteed to stop.
- **Secrets:** no credential configuration fields; `gh` authentication stays
  in `gh`; MCP stores command+args only. GitHub errors scrub token-shaped runs,
  and template/memory imports scan credential markers. Stored command output
  is not generally scrubbed and must be reviewed before sharing.
- **Persistence:** idempotent migrations (new tables + added columns);
  corrupt definition rows are skipped loudly instead of failing whole lists;
  run history retains captured output; interrupted `running` runs are failed honestly
  on boot; `paused` runs stay resumable.
- **Performance:** 200-node validation benchmarks (Rust + frontend, <2 s
  budget); memoized canvas nodes; bounded parallelism (≤4); conservative
  poll intervals (1.5 s runs, 60 s scheduler, ≥300 s watchers).

## Residual risks (accepted)

- Commands are **not sandboxed**: a destructive node does what it says.
  Mitigation is visibility (previews, history, risk summaries), not containment.
- Third-party CLIs act under their own permissions and may phone home.
- Unsigned macOS builds need a Gatekeeper bypass; verify SHA256SUMS.
- Loop-exit reasoning for exotic re-convergent diamonds across loop
  iterations is best-effort (simple review/fix cycles are exact).
- Timezones are fixed offsets (`local`/`utc`/`±HH:MM`); no IANA database.
- OS notifications depend on `notify-send`/`osascript` presence.

## Diagnostics

Environment → Export diagnostics bundle: versions, counts, tool presence,
recent error titles. No prompts, files, or credentials. Review before sharing;
nothing ever uploads automatically.

## Updater decision

No automatic updater ships while macOS builds are unsigned: an updater without
signed metadata would be theater. When signing exists, enable Tauri updater
with pinned public-key verification — never weaken signature checks.

## Release checklist (maintainers)

1. All versions `0.x.y` in sync: `package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`, `crates/core/Cargo.toml`.
2. `CHANGELOG.md`: move `Unreleased` items under the release header.
3. `pnpm check`, `cargo test -p orchevia-core`, clippy/fmt clean.
4. Tag `v0.x.y` → release workflow validates, builds Linux/macOS artifacts,
   writes SHA256SUMS, publishes with the unsigned-macOS notice.
5. Verify artifacts install + launch; attach notes to the release.
6. Docs already served from `docs/` via the Pages workflow.

## Branch protection (recommended)

Required checks: `Frontend (format · lint · typecheck · tests · build)`,
`Rust (fmt · clippy · tests)`, `Tauri build (ubuntu-latest, macos-latest)`.
Require PR review; dismiss stale approvals on push.
