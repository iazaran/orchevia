# Desktop smoke tests

The maintained matrix of desktop flows per installer: what CI, the release workflow
and the weekly CLI canary check automatically, and what a maintainer checks by hand
before calling a release verified on that installer. Keep it current when a check
moves from manual to automated, or when an installer is added.

## Matrix

| Flow                                | Linux x86_64 `.deb` | Linux x86_64 AppImage | macOS arm64 DMG                 | macOS Intel DMG     |
| ----------------------------------- | ------------------- | --------------------- | ------------------------------- | ------------------- |
| Install and first launch            | Release             | Release               | Release, CI (packaging inputs)  | Release (Rosetta)   |
| Local generation                    | Manual              | Manual                | Manual                          | Manual              |
| Approvals                           | Manual              | Manual                | Manual                          | Manual              |
| Automation (schedules and watchers) | Manual              | Manual                | Manual                          | Manual              |
| Restart recovery                    | Manual              | Manual                | Manual                          | Manual              |
| MCP and process cleanup             | CI (core); Manual   | CI (core); Manual     | CI (core, macOS inputs); Manual | Manual              |
| In-place updates                    | Manual (apt)        | Manual (updater)      | Manual (updater)                | Manual (updater)    |
| Agent CLIs accept Orchevia's flags  | Weekly              | Weekly                | Weekly (Linux CLIs)             | Weekly (Linux CLIs) |

- **CI**: [`ci.yml`](../.github/workflows/ci.yml) on pull requests and `main`.
  _CI (core)_ is the **Rust** job's `cargo test -p orchevia-core` on Linux, which
  tests the engine, not an installed package. _CI (core, macOS inputs)_ is the
  **Desktop macOS** job's process-tree cleanup tests on Apple Silicon; that job runs
  when macOS packaging inputs or `crates/core/src/process.rs` change, and also
  packages the app and launches it from the DMG.
- **Release**: [`release.yml`](../.github/workflows/release.yml) on a version tag,
  before anything is published. **Verify the macOS app** checks the signature and
  launches the DMG's app; **Verify the Linux packages launch** starts the app from
  the unpacked `.deb` and the AppImage. Each must open its database in an empty home
  folder and keep running.
- **Weekly**: [`cli-canary.yml`](../.github/workflows/cli-canary.yml) installs the
  newest Claude Code and Codex and runs, signed out, every command Orchevia builds
  for them (Agent nodes at each permission level and effort, text output, workflow
  generation, a session group's first and resumed turn). It fails when a flag is
  refused or ignored, when `--version` stops showing a version, or when Orchevia's
  decoder cannot read the structured output, and names the CLI version and flag.
- **Manual**: the steps below, on the installer in that column.

The core tests behind _CI (core)_ also cover approvals, schedules, watchers and
restart recovery in the engine and database. They run on Linux only and use stand-in
CLIs, so the manual steps stay for every installer.

The Linux launch runs on the release runner (`ubuntu-latest`), the system the
packages are built on. An AppImage carries libraries from there, so a launch on an
older distribution remains a manual check.

## Manual steps

Use a disposable project folder with a Git repository, and real, signed-in
Claude Code and Codex. On macOS, check both the arm64 and the Intel DMG (Intel on an
Intel Mac, or under Rosetta).

**Install and first launch.** Install the release file as the README describes
(`.deb` via `apt` or the file, AppImage made executable, DMG dragged to
Applications). Orchevia opens with the sample workflow; Environment lists Git, the
GitHub CLI, Claude Code and Codex with their versions.

**Local generation.** Generate a workflow from a one-line goal with each CLI and the
repository selected. The preview shows the steps; nothing runs until you choose to.

**Approvals.** Run a workflow with an approval step. The run pauses; approve once
and reject once. Approving continues the run, rejecting fails it, and both show in
the run's timeline.

**Automation.** Enable a schedule due in two minutes and a watcher on the
repository, turn on background mode and close the window. Both start a run on
time. On
GNOME without the AppIndicator extension, confirm the documented no-tray behaviour.

**Restart recovery.** Start a long Command step (`sleep 120`), quit from the tray
menu, and relaunch. The run is marked failed with "Application restarted while this
run was in progress"; a run paused at an approval is still waiting.

**MCP and process cleanup.** Run an Agent node whose CLI starts an MCP server (for
example through `npx`) and cancel it; then let a node time out; then quit the app
during a run. Each time, `ps ax | grep -E 'claude|codex|npx|node'` shows nothing
left from that run.

**In-place updates.** Install the previous release, open it, and update:

- AppImage and macOS (0.1.24 or later, from a release built with the update
  signing secret): **Environment → Updates → Check now**, then **Install and
  restart**. It asks first, refuses while a workflow is running, and restarts on
  the new version. The release's `latest.json` lists the AppImage and both macOS
  bundles; the signatures were verified before publication.
- A release built without the signing secret has no `latest.json`: **Install and
  restart** is not offered, and the download steps show instead.
- `.deb`: `sudo apt update && sudo apt upgrade` from the signed apt repository.

Workflows, runs and settings are all still there afterwards.

## Running the automated checks locally

```bash
# Process-tree cleanup tests, as the Desktop macOS job runs them
cargo test -p orchevia-core --lib -- process::tests:: mcp::tests:: \
  tools::tests::noisy_login_shell tools::tests::hung_login_shell \
  engine::integration_tests::cancel engine::integration_tests::timeout_

# Linux launch check (needs Xvfb; uses an empty home folder and its own display)
pnpm tauri build --bundles deb,appimage
bash scripts/verify-linux-app.sh target/release/bundle

# macOS signature and launch check
bash scripts/verify-macos-app.sh target/aarch64-apple-darwin/release/bundle --launch

# CLI canary against installed copies (empty home folder, cleared environment;
# signed-out Codex retries failing requests for about 15 s per command)
ORCHEVIA_CANARY_CLAUDE=$(command -v claude) ORCHEVIA_CANARY_CODEX=$(command -v codex) \
  cargo test -p orchevia-core --lib cli_canary -- --ignored --nocapture
```

The launch checks never touch an existing install's data. The macOS check needs no
other Orchevia running, since the app allows one copy per user.
