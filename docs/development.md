# Development, build, and release

## Prerequisites

Node 24+, pnpm 10+, Rust stable. Linux needs Tauri system libraries:

```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev libxdo-dev librsvg2-dev patchelf \
  libsoup-3.0-dev libjavascriptcoregtk-4.1-dev build-essential curl wget file \
  libssl-dev libgtk-3-dev libayatana-appindicator3-dev
```

macOS: `xcode-select --install`.

## Day-to-day

```bash
pnpm install
pnpm dev            # browser UI with mock backend (fastest loop)
pnpm tauri dev      # full desktop app
pnpm check          # version:check + format:check + lint + typecheck + tests (== CI frontend)
cargo test -p orchevia-core   # Rust core (works without system webview libs)
cargo clippy -p orchevia-core --all-targets -- -D warnings
cargo fmt --all -- --check
cargo check -p orchevia
```

## Why two Rust test scopes?

- `orchevia-core` is Tauri-free: runs everywhere, including minimal containers.
- The `orchevia` Tauri binary needs WebKit/GTK dev packages to link; it is compiled in
  CI (`tauri-build` job) and on contributor machines with system deps. Keep business
  logic in core so it stays covered regardless.

## Agent profile skills

Profiles may name up to eight Claude Code or Codex skills. The core validates
names and prefixes them to each prompt using the CLI's native invocation form.
The Tauri skill list reads file-backed metadata from the selected CLI's personal
skill directory, and from the repository when the profile has a fixed working
directory. The browser mock returns an empty discovered list because it has no
filesystem access; manual skill names remain available in both modes. Plugin,
synced, and per-node project skills can be entered manually. A name appearing
in the editor does not prove the CLI will load it; run a small workflow with
that profile before relying on the skill in an automation. The profile's
**Test** button checks CLI availability, not skill invocation.

## CI (`.github/workflows/ci.yml`)

On every PR and `main` push: frontend job (install frozen-lockfile → format → lint →
typecheck → tests → production build) + Rust job (fmt, clippy, core tests) + Tauri build
matrix (Ubuntu + macOS) + docs validation. Bundles live under the workspace
`target/release/bundle` directory. PR installer artifacts (`.deb`, `.AppImage`,
`.dmg`) upload to the Actions run with 14-day retention — **never** as public releases.

## Releases (`.github/workflows/release.yml`)

For a future version, push a matching `v*.*.*` tag → validate job → per-OS builds → combine artifacts and
checksums (`SHA256SUMS`) on Ubuntu → GitHub Release with generated notes. A tag by itself does not make installers available; the release workflow must complete. Keep `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, and `crates/core/Cargo.toml` versions in sync; move `CHANGELOG.md` entries out of
`Unreleased` when tagging. `pnpm version:check` checks those versions and the changelog;
release CI also rejects a tag that differs from the application version.

## GitHub Pages (`.github/workflows/pages.yml`)

`docs/` is the static site. PRs validate `index.html`; pushes to `main` deploy via the
official Pages actions. In Settings → Pages, select **GitHub Actions** as the source.
GitHub Free does not publish Pages from a private repository; a plan with private
repository Pages support or a public repository is required. A Pages deployment
must succeed before the URL resolves. A public Pages site does not make a private
repository or its release API public.

## Dependency updates

Dependabot (`.github/dependabot.yml`): weekly, grouped, max 5 open PRs per ecosystem
(npm, cargo, actions). TypeScript 7 is deferred until `typescript-eslint` supports
its compiler API. Security tooling is advisory, not blocking, to avoid flaky red CI
from transient scanners.

## Generation and release checks

The desktop generator reads configured Agent Profile mappings and probes enabled
MCP servers for actual tool names and required argument keys. Its prompt must
use discovered tool names rather than a hard-coded Jira example. This is read-only and
bounded (up to four servers, 12 seconds each). Generated previews highlight
shell-required environment variables. Orchevia's Jira MCP setup uses
`JIRA_URL`, `JIRA_USERNAME`, and `JIRA_API_TOKEN` for Cloud; if a proposal
contains `JIRA_BASE_URL` or `JIRA_EMAIL`, inspect and replace that raw Command
with the configured MCP tool before running.

The release workflow stages `Orchevia-linux-x86_64.deb`, `Orchevia-linux-x86_64.AppImage`,
`Orchevia-macos-arm64.dmg`, `Orchevia-macos-x86_64.dmg`, and `SHA256SUMS`.
The project page exposes direct downloads only when the release assets are
publicly accessible. Check the version in `src-tauri/tauri.conf.json` before tagging.
