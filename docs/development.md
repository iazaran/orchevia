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
pnpm check          # versions + format + lint + types + delivery tests + UI tests
cargo test -p orchevia-core   # Rust core (works without system webview libs)
cargo clippy -p orchevia-core --all-targets -- -D warnings
cargo fmt --all -- --check
cargo check -p orchevia
```

## Why two Rust test scopes?

- `orchevia-core` is Tauri-free: runs everywhere, including minimal containers.
- The `orchevia` Tauri binary needs WebKit/GTK dev packages to link; it is compiled in
  CI (`desktop` job) and on contributor machines with system deps. Keep business
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

On every PR and `main` push, the frontend check always runs version consistency,
repository formatting, delivery-script tests, and public-documentation tests.
Changed frontend inputs also run lint, typecheck, all UI tests, and a production
build. Native inputs run core fmt/clippy/tests and Linux desktop compilation and
command tests. Shared manifests, locks, workflow/build scripts, and unfamiliar
inputs run both stacks. Pure prose changes avoid compilers; formatting still runs.

`scripts/ci-changes.mjs` compares the PR head with its merge base, or the entire
before/after range on a main push. Deleted and renamed inputs remain visible.
Jobs are gated, not PR workflow triggers: skipped jobs have a conclusion and the
always-running **CI result** check fails if any applicable job fails or is cancelled.
Use **CI result** and **Validate docs site** as required checks if adding branch
rules. The old Tauri matrix check names have been retired; no status contexts were
required when this change was prepared. Repository protection is not changed here.

PR/main no longer build or upload installers. Linux desktop compilation uses the
production `custom-protocol` feature, which requires `dist/`. When native checks
apply, the frontend job builds it once and shares a one-day `ci-frontend` artifact
with the read-only desktop job in the same run. That artifact is never consumed by
release jobs; tag builds produce their own frontend from the tag source.
All three real platform packages are
built on release tags. A UI-only change runs frontend validation; a core or desktop
change also compiles/tests the Linux shell. macOS compilation and packaging are
verified at release time, so platform-specific failures can first appear there.

pnpm caches its store by lockfile. Rust caches the actual workspace `target/`
(no redundant `src-tauri/target`), with separate core-check, desktop-check, and
release-build keys. Main writes CI Rust caches; PRs restore them. Release validation
can restore the main core cache, and tag builds retain dependency caches even when
packaging or upload fails. Toolchain/lock changes and GitHub cache scope can still
cause misses. Compiled workspace crates and installers are not a release reuse path.

The previous PR → main → tag sequence built three platforms at each stage (nine
installer builds); now only the three tag builds remain, alongside cheaper Linux
checks on applicable PR/main changes. On the last v0.1.3 main CI, bundle jobs took
about 7:05 Linux, 1:39 Apple Silicon, and 7:35 Intel (16:19 total runner time,
including setup/cache work). The net saving is lower because Linux checks still
cost time; cache warmth and runner billing rates vary. No fixed percentage of
account minutes is promised. Shorter artifact retention saves storage, not build
minutes. Concurrency cancels obsolete PR/main runs.

## Releases (`.github/workflows/release.yml`)

A matching `v*.*.*` tag runs fresh validation, then Linux x86_64 (`.deb`, AppImage),
Apple Silicon (`macos-15`, arm64 DMG), and Intel (`macos-15-intel`, x86_64 DMG)
builds. Runner architecture is checked before packaging; an unused Linux RPM is
no longer built. Each build uploads only its staged installers. A transient upload
failure gets one upload-only retry in the same job, without rebuilding. Release
concurrency serializes attempts for the same tag without cancelling an active build.

Publication accepts only artifacts from that tag workflow run, never PR artifacts
or a `workflow_run` handoff. It requires all four expected nonempty installer files
before generating `SHA256SUMS` and publishing with generated notes. Builds and
validation have read-only contents permission; only publication has contents write.
Installers remain unsigned on macOS. Release artifact retention is 14 days;
packaging failure logs and the generated DMG script are retained for 7 days.

Tauri's verbose log exposes generated DMG-script stdout/stderr, which otherwise
appears only at debug level. Packaging failures also print macOS version, Xcode,
architecture, disk space, and mounted disk images. No automatic packaging retry or
Finder workaround is applied without evidence of the underlying error.

### Version 0.1.4 availability

Version 0.1.4 is prepared for release after this PR merges. Its four installers and
`SHA256SUMS` are pending publication. The README lists only planned 0.1.4 files;
older installer links have been removed. Add authenticated versioned download links
only after the new release completes and every file is verified. Stable
`latest/download` links may be used only when those exact URLs resolve correctly.

The repository remains private. The latest published release was assetless when
checked on 2026-10-01; neither a tag nor an Actions artifact is an installable release
download. A public Pages deployment does not grant access to private assets.

The Intel v0.1.3 [release run](https://github.com/iazaran/orchevia/actions/runs/36755474756)
failed in two different places:

- Attempt 1 completed `Orchevia_0.1.3_x64.dmg` and staged a 5,810,069-byte DMG;
  artifact creation then failed with `ENOTFOUND` (network/DNS at upload).
- Attempt 2 compiled the binary and app, then failed in `bundle_dmg.sh` before
  staging/upload. The original nonverbose log does not identify the failing
  `hdiutil`/script command. It is not evidence of another upload failure or a
  particular Finder bug. Tauri already skips Finder styling when `CI=true`.

### Maintainer handoff

Merge this PR after checks pass, then create the matching `v0.1.4` tag/release.
`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
`crates/core/Cargo.toml`, workspace entries in `Cargo.lock`, and the dated changelog
entry are aligned to 0.1.4. `pnpm-lock.yaml` has no application-version field and
requires no change for this version bump; frozen installation verifies it remains
consistent. `pnpm version:check v0.1.4` checks manifests, Cargo lock entries,
changelog, and tag agreement.

The maintainer creates the matching new tag/release. Do not move or recreate an
existing tag: rerunning v0.1.3 uses its original workflow and will not gain these
changes. Ask for approval before additional expensive reruns/manual release builds.
If approved, rerun only failed jobs rather than the whole matrix; successful tag-run
artifacts can be used by the dependent publish job while retained. An old upload
failure cannot recover an unuploaded DMG from a runner that has already exited.

After a release completes, verify all four nonempty installers and checksums,
update the README to that version, and only adopt latest-download links when those
exact URLs work for authorized readers. Do not claim files are downloadable before
publication. No release build is manually dispatched by this change.

## GitHub Pages (`.github/workflows/pages.yml`)

Every PR and main push validates the site; only changed site files (HTML, images,
robots/sitemap, or the Pages workflow) deploy on main. Markdown documentation edits
do not republish the site. Manual dispatch on main remains available for an approved
Pages redeploy. PRs never deploy. Site validation and UI documentation tests guard
the private-beta/public-soon notice and reject private download links/API polling.

The public page continues to say the repository and downloads will be public soon.
A public Pages deployment does not grant access to private repository release files.
Repository visibility and Pages settings are unchanged.

## Dependency updates

Dependabot (`.github/dependabot.yml`) remains weekly, with one grouped version-update
PR per ecosystem (npm, Cargo, and now GitHub Actions). The open version-PR limit is
one per ecosystem; it does not disable security updates. TypeScript 7 is deferred
until `typescript-eslint` supports its compiler API. No test/security rule is relaxed.
PRs #13/#14 were closed as superseded before this change; no new dependency PRs were
open during the audit. Review future dependency PRs separately.

Update the Rust `tauri` crate and npm `@tauri-apps/api` together: their major and
minor versions must match. Dependabot groups npm and Cargo separately, so combine
paired Tauri upgrades in a reviewed change. Update `@tauri-apps/cli` and the related
Cargo lockfile too, then run local validation before paying for tag builds. Never
ignore a Tauri version mismatch to get a green build.

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
