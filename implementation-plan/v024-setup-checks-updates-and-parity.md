# v0.1.24 implementation outcome

The deferred fixes from v0.1.23 plus the roadmap items for setup diagnostics,
CLI drift, in-place updates, authoring and accessibility. Application version
`0.1.23` → `0.1.24`. Workflow schema stays 6 (`scriptFile` is optional);
templates and Simple JSON gain only that field.

## 1. Setup check (`crates/core/src/setup_check.rs`)

`check_agent_setup(profile)` replaces the `--version`-only profile test (the
`test_agent_profile` command is gone). It runs the profile's own Agent command,
with its model, effort, extra arguments and effective permission level, but
without skills, in a fresh temporary folder that is removed afterwards. The
prompt asks the CLI to read `orchevia-setup-check.txt` (a random token), write
it to `orchevia-setup-reply.txt` and reply with it.

- Items: `installed` (path and version), `answered`, `readFile`, `editFile`.
  Status order is skipped < passed < warning < failed; the report takes the
  worst.
- `answered` fails on a timeout (180 s), a usage limit, a non-zero exit or an
  empty reply. Sign-in markers (`/login`, `not logged in`, `401`, `codex
  login`, …) turn it into "Not signed in" with the adapter's sign-in command.
- `editFile` reads the reply file, not the CLI's claim. A refused edit is a
  warning at CLI settings or Allowed tools (steps that edit will be refused) and
  a failure at Full access (the CLI no longer honours the flag headless, the
  2026-10-20 regression). Custom CLIs skip it.
- Codex runs with `--skip-git-repo-check`, because the temporary folder is not
  a repository.
- Verified against the installed Claude Code 2.1.303 and Codex 0.162.1: Full
  access passes every item, CLI settings warns "Refused tools: Write", and an
  empty HOME reports "Not signed in" for both
  (`cargo test -p orchevia-core real_cli_setup_check -- --ignored --nocapture`
  sends real prompts).

UI: `SetupCheck.tsx` (checklist, `useSetupChecks`, `SetupCheckPanel`). Agents has
**Check setup** per profile; Environment (**Agent setup check**) and the wizard's
last step check every profile, one at a time, only on request. The mock reports
the missing CLI, as the desktop app does when nothing is installed.

`AgentOutput` now keeps a failed Claude result's `result` text ("Not logged in ·
Please run /login") when it has no `errors`, so ordinary steps say why too.

## 2. In-place updates

- `tauri-plugin-updater` 2.14 (rustls; no OpenSSL, so the Intel DMG still
  cross-compiles). `plugins.updater` in `tauri.conf.json` pins the minisign
  public key (key id `2DD327186AEDBA69`) and the endpoint
  `releases/latest/download/latest.json`.
- `DesktopInfo.inPlaceUpdates` is true for `appimage` and `app` installs of a
  build whose public key is set. `install_update(version)` refuses other install
  kinds (apt and deb keep their own path) and any `running` run, checks the
  signed update's version and downloads it. It then holds admission
  (`CancellationRegistry::hold_admission`: run starts and approval, spend and
  usage continuations take the same lock and get `EngineError::Updating`),
  checks for running runs again, installs and restarts. A schedule slot refused
  with `UPDATE_INSTALLING` is held back (`deferred_slot`) and runs after the
  restart instead of being spent. The single-instance lock is
  released by Tauri's exit cleanup before the restart.
- Environment → Updates shows **Install and restart** (confirmation first); the
  download link stays.
- `release.yml`: with `TAURI_SIGNING_PRIVATE_KEY` set, the build passes
  `bundle.createUpdaterArtifacts` and fails early if the config has no public
  key (the bundler's own error is "Missing comment in public key"). Staging
  copies `Orchevia-linux-x86_64.AppImage.sig` and
  `Orchevia-macos-<arch>.app.tar.gz` plus `.sig`. Checksums accept 4 files, or 9
  with the whole update set. `scripts/updater-manifest.mjs` verifies every
  signature (Ed25519, BLAKE2b-prehashed, trusted comment included) against the
  pinned key before writing `latest.json`. Only the `linux-x86_64-appimage` key
  is offered on Linux, so a .deb install can never match it.
- Verified locally: a release AppImage signed with a throwaway key produced its
  `.sig`, the manifest script accepted it and rejected a one-byte change. The
  in-app install and restart has not run end to end yet; the first chance is
  updating 0.1.24 to the next release.

## 3. Delivery checks

- `crates/core/src/cli_canary.rs` (ignored tests) builds every argv Orchevia
  sends Claude Code and Codex with the real builders and checks the flags against
  the newest npm releases, signed out, in a clean environment.
  `.github/workflows/cli-canary.yml` runs it weekly.
- The macOS CI job runs the process-tree cleanup tests before packaging; they
  now also check each grandchild with `ps -o stat=`.
- `scripts/verify-linux-app.sh` launches the `.deb` binary and the AppImage
  under Xvfb with an empty HOME before staging.
- `docs/smoke-tests.md` is the smoke-test matrix.

## 4. Engine: nested loops

Each loop-back edge has its own body: its target plus every step that reaches
the loop-back's source without passing the target, with inner loops folded into
the outer body when all their exits land in it. Going round re-arms only that
body. An untaken edge leaving a loop is held while any body step is unfinished,
then released as not taken. Replay goes through the same functions. Nine tests
(seven failed before) cover an outer loop restarting before the inner one (it
deadlocked), joins fed by a parallel branch (they started early), failure routes
on later passes and approvals inside the inner loop.

The browser mock's `replayGraph` is now a port of the same routing, including
the v0.1.23 rules it lacked. 16 vitest cases mirror the engine's traces.

## 5. Validation parity and script files

- Rust and TS `VALIDATION_CODES` list the same 61 codes, and
  `src/test/validation-parity.json` (30 cases) pins code, severity, step and
  edge on both sides. Issues gain `edgeId`. The 10 run-start codes that need the
  database or `PATH` are explicit, tested exemptions. Escaped `\{{…}}` no longer
  counts as a variable.
- `scriptFile` on Command steps resolves like the working folder (node
  `workingDir`, then `defaults.repoDir`; `~/` and absolute paths allowed) and
  runs `<executable or bash> <path> <args…>`. Only `/…` and `~/…` count as
  rooted on both sides; `C:\…` is a relative name on Linux and macOS. Codes: `command-script-required`,
  `-templated`, `-dir-required`, `-misplaced`. Results record the exact argv as
  `command` metadata (reserved in fixtures), shown as "Ran …" / "Would run …".
  A path left relative by a relative working folder is anchored at the app's
  working folder, and a path that is not a regular file is refused before it is
  opened. A `~/` script stays in Script file mode, because a plain argument
  would not expand `~`.

## 6. Smaller changes

- Save as template lists the setup Use template will ask for
  (`SETUP_ISSUE_CODES`) apart from the errors it refuses.
- The playbook save is offered only on steps labelled test, lint or build
  (`playbookField`, shared with edit observations).
- axe-core checks every view, the shared dialogs and the new controls; the fixes
  are listed in the changelog.

## Deferred and known limits

- `cycle-needs-condition` accepts an inner cycle without its own condition when
  the outer loop has one; it is still bounded by visit limits and routes
  correctly, and tightening it would reject workflows that validate today.
- Unusual loop shapes (a side entry into a loop body, or overlapping loops that
  each exit into the other) can hold an exit until nothing else can run; the
  outcome is still right, decided later.
- Codex at CLI settings refuses a folder that is not a Git repository.
- The generator prompt does not offer `scriptFile`; drafts could invent paths.
- A script step is never treated as a remote write, even if the script pushes.
- The AppImage is built on `ubuntu-latest` and may not start on older
  distributions.
- `implementation-plan/v018-ready-to-use-templates.md` still lists nested-loop
  exits as a known limit; section 4 supersedes it.
