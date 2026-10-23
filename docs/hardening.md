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
  poll intervals (1.5 s runs, scheduler waking at due times and at least every
  60 s, ≥300 s watchers).

## Residual risks (accepted)

- Commands are **not sandboxed**: a destructive node does what it says.
  Mitigation is visibility (previews, history, risk summaries), not containment.
- Third-party CLIs act under their own permissions and may phone home.
- macOS builds are ad-hoc signed, not notarized: the first launch needs Open
  Anyway in Privacy & Security; verify SHA256SUMS.
- Loop-exit reasoning for exotic re-convergent diamonds across loop
  iterations is best-effort (simple review/fix cycles are exact).
- Timezones are fixed offsets (`local`/`utc`/`±HH:MM`); no IANA database.
- OS notifications depend on `notify-send`/`osascript` presence.

## Diagnostics

Environment → Export diagnostics bundle: versions, counts, tool presence,
recent error titles. No prompts, files, or credentials. Review before sharing;
nothing ever uploads automatically.

## Updater decision

Since v0.1.20 Orchevia tells you when a new release is ready: shortly after
launch and twice a day it asks GitHub's public releases API for this
repository's latest version (no identifiers, no account; turn it off in
Environment → Updates). A newer version shows a banner, one Inbox entry and,
when desktop notifications are on, one desktop notification, with a link to the
matching installer.

Debian and Ubuntu users can install from the signed apt repository at
`https://iazaran.github.io/orchevia/apt` (key `orchevia-archive-keyring.gpg`
there), so `sudo apt upgrade` installs new versions; the app then suggests that
command instead of a download.

Nothing else installs automatically. AppImage and macOS updates wait for signed
release metadata: enable the Tauri updater with pinned public-key verification
— never weaken signature checks.

## Release checklist (maintainers)

1. All versions `0.x.y` in sync: `package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`, `crates/core/Cargo.toml`.
2. `CHANGELOG.md`: move `Unreleased` items under the release header.
3. `pnpm check`, `cargo test -p orchevia-core`, clippy/fmt clean.
4. Tag `v0.x.y` → release workflow validates, builds Linux/macOS artifacts,
   refuses a macOS app not signed as a whole bundle
   (`scripts/verify-macos-app.sh`), writes SHA256SUMS, publishes with the
   macOS first-launch notice.
5. Verify artifacts install + launch; attach notes to the release.
6. Docs already served from `docs/` via the Pages workflow.
7. After publishing, the release workflow dispatches the Pages workflow, which
   rebuilds the signed apt repository from the newest three releases (secret
   `APT_SIGNING_KEY`). Check `https://iazaran.github.io/orchevia/apt/dists/stable/InRelease`
   lists the new version's `Packages` hash.

## Branch protection (recommended)

Required check: `CI result`. It aggregates every CI job and also reports for
docs-only changes, so no pull request waits for a skipped job. Require PR review;
dismiss stale approvals on push; no force pushes to `main`.
