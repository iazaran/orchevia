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
command tests. Shared manifests, locks, build scripts, and unfamiliar inputs run
both stacks. Edits to the three existing workflows run actionlint and the delivery
regressions without compiling unchanged application code; new workflows fail safe
and run both stacks as well. Pure prose changes avoid compilers; formatting still runs.

`scripts/ci-changes.mjs` compares the PR head with its merge base, or the entire
before/after range on a main push. Deleted and renamed inputs remain visible.
Jobs are gated, not PR workflow triggers: skipped jobs have a conclusion and the
always-running **CI result** check fails if any applicable job fails or is cancelled.
Use **CI result** as the required check if adding branch rules; **Validate docs site**
runs only for site changes, so it must not be required. The old Tauri matrix check names have been retired; no status contexts were
required when this change was prepared. Repository protection is not changed here.

PR/main no longer build or upload installers. Linux desktop compilation uses the
production `custom-protocol` feature, which requires `dist/`. When native checks
apply, the frontend job builds it once and shares a one-day `ci-frontend` artifact
with the read-only desktop job in the same run. That artifact is never consumed by
release jobs; tag builds produce their own frontend from the tag source.
Desktop CI uses `cargo test -p orchevia --locked --all-targets`: it compiles the
entire shell with production default features and runs its tests in one profile.
A preceding `cargo check` would compile dependencies again as metadata only.
All three real platform packages are built on release tags. A UI-only change runs
frontend validation; a core or desktop
change also compiles/tests the Linux shell. macOS compilation and packaging are
verified at release time, so platform-specific failures can first appear there.

pnpm caches its store by lockfile. Rust caches the actual workspace `target/`
(no redundant `src-tauri/target`), with separate core-check and desktop-check keys.
Main and PRs save successful CI dependency caches. GitHub isolates PR writes in their
merge-ref scope, so later updates of that PR can restore them, while main and release
tags cannot. Release validation restores the trusted main core cache without saving.
Release builds use no cache at all: caches from one tag cannot be restored by another
tag, so saving them only cost time and cache space. Toolchain/lock changes also cause
misses. Compiled workspace crates and installers are not a release reuse path.

### Keeping Actions usage low

Private repositories spend the account's included Actions minutes, and macOS minutes
count at a premium; public repositories run standard GitHub-hosted runners for free.
The workflows stay frugal either way:

- Both macOS DMGs build on Apple Silicon (the Intel one cross-compiled) instead of on
  a slow Intel runner, and release builds skip caches that could never be restored.
- Release installer artifacts live for one day and `ci-frontend` for one day; the
  published release assets are the permanent copies. Release assets do not count
  toward Actions storage.
- Pages runs only for site changes, CI skips compilers for prose, and Dependabot
  batches updates monthly.

Old Actions artifacts that are still within their retention period can be removed
under **Actions → Caches/Artifacts** or with `gh api`; deleting them is permanent.

Linux CI and release jobs share `scripts/install-linux-deps.sh`. The hosted runner's
mirror list normally prefers Azure, which returned packages very slowly in the
[v0.1.4 release run](https://github.com/iazaran/orchevia/actions/runs/36889916059):
APT fetched 78.3 MB in 20:42 at 63.1 KB/s, making setup take 21:12. The script removes
that mirror only when Ubuntu's archive fallback is present. Signed source definitions,
security indexes, and the full packaging/media dependency set stay intact. Connection
timeouts and three retries bound stalled requests; timing output distinguishes index
refresh from installation. No host dependency installation is skipped on cache hits.

## Releases (`.github/workflows/release.yml`)

A matching `v*.*.*` tag runs fresh validation, then Linux x86_64 (`.deb`, AppImage)
and both macOS DMGs. The two DMGs build on Apple Silicon `macos-15` runners:
`aarch64-apple-darwin` natively and `x86_64-apple-darwin` cross-compiled, which is
much faster than an Intel runner. Before staging, every executable in the `.app`
must report exactly the requested architecture (`lipo -archs`), so an Apple Silicon
binary can never ship as the Intel DMG. The macOS jobs request `app,dmg`: with `dmg`
alone, Tauri deletes the `.app` after packaging and there would be nothing to check. The Linux runner's architecture is checked
too. Each build uploads only its staged installers. A transient upload failure gets
one upload-only retry in the same job, without rebuilding. Release concurrency
serializes attempts for the same tag without cancelling an active build.

Release builds keep no dependency caches: a tag run can restore only caches saved
by the same tag or by `main`, so a cache saved by one release is never reused by
the next. Validation restores `main`'s Rust cache read-only.

Publication accepts only artifacts from that tag workflow run, never PR artifacts
or a `workflow_run` handoff. It requires all four expected nonempty installer files
before generating `SHA256SUMS` and publishing with generated notes. Builds and
validation have read-only contents permission; only publication has contents write.
Installers remain unsigned on macOS. Release installer artifacts are kept for one
day (publication follows within minutes); packaging failure logs and the generated
DMG script are retained for 7 days.

Tauri's verbose log exposes generated DMG-script stdout/stderr, which otherwise
appears only at debug level. Packaging failures also print macOS version, Xcode,
architecture, disk space, and mounted disk images. No automatic packaging retry or
Finder workaround is applied without evidence of the underlying error.

### Merge is the beginning of release verification

1. Run the complete local gate below and open a PR against `main`.
2. Merge after **CI result** passes (and **Validate docs site**, when the PR changes
   the site). Main CI checks the
   merged source; Pages deploys changed site files. Neither builds installers.
3. Fetch the merged commit and check its version before creating a new tag.
   The application version, both Cargo manifests, Tauri configuration,
   Cargo lock workspace packages and dated changelog entry must all read the
   release version being prepared (e.g. `0.1.15` for the v0.1.15 release).
4. The maintainer creates `v<version>` (e.g. `v0.1.15`) on that merged commit
   and pushes the tag. Do not move or recreate an existing version tag. The
   Release workflow builds all supported platforms from the tag and publishes
   permanent GitHub assets.
5. Verify the successful Release run and all four nonempty installer assets plus
   `SHA256SUMS`. The README and project page link to
   `releases/latest/download/<file>`, so they need no edit per release; check that
   those links now serve the new version. Download the checksum file and compare its
   hashes with GitHub's asset digests; verify each downloaded installer before using it.
6. Smoke-test installation and a small real workflow on Linux, Apple Silicon and
   Intel macOS before claiming those native paths are verified.

Example maintainer commands, **after merge** and after checking the intended commit
(substitute the release version for `<version>`):

```bash
git switch main
git pull --ff-only
pnpm version:check v<version>
git tag v<version>
git push origin v<version>
gh run list --workflow release.yml --limit 5
gh release view v<version> --json url,assets
```

The [README's installer links](../README.md#download) always resolve to the latest
release's `.deb`, AppImage, arm64 DMG, x86_64 DMG and `SHA256SUMS`. Temporary Actions
artifacts expire and are not install guidance. A release page without all its files
is not an installer-ready release.

If release jobs fail, separate packaging, upload and validation failures before
retrying. Retained verbose bundler logs are the starting point for DMG failures.
Ask before additional expensive reruns; retry only failed jobs when approved.
Never rerun an older tag expecting it to gain a newer workflow's fixes.

## GitHub Pages (`.github/workflows/pages.yml`)

The Pages workflow starts only for changes under `docs/`, to the workflow itself or
to `scripts/ci-changes.mjs`. Only changed site files (HTML, images, robots/sitemap,
or the Pages workflow) deploy on main; Markdown documentation edits do not republish
the site. Manual dispatch on main remains available for an approved redeploy. PRs
never deploy. Site validation checks that the page parses, links every installer
and `SHA256SUMS` from the latest release, never calls the GitHub API, and ships
every local image it references. CI runs the documentation tests
(`src/test/public-docs.test.ts`) on every PR, including the page's interactive demo,
tabs and download recommendation.

### Screenshots

The images in `docs/images/` are real screens of the browser build (`pnpm dev`)
seeded with demo data, captured at 2× scale as WebP. Retake them when the screens
they show change noticeably; keep the file names so the README and the page do not
change. `social-preview.jpg` (1280×640) is the link-preview image; upload it under
**Settings → Social preview** too.

## Dependency updates

Dependabot (`.github/dependabot.yml`) runs monthly, with one grouped version-update
PR per ecosystem (npm, Cargo and GitHub Actions); monthly batches keep CI runs low.
The open version-PR limit is one per ecosystem; it does not delay security updates.
Keep compiler, lint and test-tool compatibility verified together. Do not accept an
ecosystem upgrade merely because a package manager resolves it. Run frozen
installation and the full gate; no test or security rule is relaxed.

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
`Orchevia-macos-arm64.dmg`, `Orchevia-macos-x86_64.dmg`, and `SHA256SUMS`. Keep these
names stable: the README and project page link to them through `releases/latest`.
Check the version in `src-tauri/tauri.conf.json` before tagging.

## Complete local quality gate

```bash
pnpm check
pnpm build
cargo test -p orchevia-core
cargo clippy -p orchevia-core --all-targets -- -D warnings
cargo fmt --check
cargo check -p orchevia
cargo test -p orchevia
pnpm version:check v<version>
git diff --check
```

Substitute the release version under preparation for `<version>`.

When changing behavior, find the existing implementation pattern first, add a
regression that fails for the original issue, and run it after the fix. Keep
browser/native semantics aligned through `Backend`; mirror model and validation
changes in TypeScript and Rust. Use the shared dialogs, notices, timestamps and
error helpers rather than introducing parallel conventions.

For async views and saves, preserve newer drafts and ignore stale responses after
selection or navigation changes. React's [effect cleanup guidance](https://react.dev/reference/react/useEffect#fetching-data-with-effects)
explains the lifecycle principle. TypeScript's
[exact optional properties](https://www.typescriptlang.org/tsconfig/exactOptionalPropertyTypes.html)
and [checked indexing](https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html)
match this repository's contract rules. For local processes, Rust's
[Child documentation](https://doc.rust-lang.org/std/process/struct.Child.html)
describes explicit child cleanup; cancellation and timeout tests must retain
partial output. Verify CLI contracts against their installed help and official
manuals, including [GitHub check fields and exit codes](https://cli.github.com/manual/gh_pr_checks).
