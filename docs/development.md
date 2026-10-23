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
regressions without compiling unchanged application code (CI and release edits
also package for macOS, see below); new workflows fail safe
and run both stacks as well. Pure prose changes avoid compilers; formatting still runs.

`scripts/ci-changes.mjs` compares the PR head with its merge base, or the entire
before/after range on a main push. Deleted and renamed inputs remain visible.
Jobs are gated, not PR workflow triggers: skipped jobs have a conclusion and the
always-running **CI result** check fails if any applicable job fails or is cancelled.
Use **CI result** as the required check if adding branch rules; **Validate docs site**
runs only for site changes, so it must not be required. The old Tauri matrix check names have been retired; no status contexts were
required when this change was prepared. Repository protection is not changed here.

PR and main runs upload no installers. Linux desktop compilation uses the
production `custom-protocol` feature, which requires `dist/`. When native checks
apply, the frontend job builds it once and shares a one-day `ci-frontend` artifact
with the read-only desktop job in the same run. That artifact is never consumed by
release jobs; tag builds produce their own frontend from the tag source.
Desktop CI uses `cargo test -p orchevia --locked --all-targets`: it compiles the
entire shell with production default features and runs its tests in one profile.
A preceding `cargo check` would compile dependencies again as metadata only.
All three real platform packages are built on release tags. A UI-only change runs
frontend validation; a core or desktop
change also compiles/tests the Linux shell. Changes to macOS packaging inputs (the
Tauri config, icons and manifests under `src-tauri/`, both workflows,
`scripts/verify-macos-app.sh`, locks and unfamiliar files) also build the Apple
Silicon app and DMG and run the release's macOS checks (**Desktop macOS**). Other
macOS compilation is verified at release time, so platform-specific Rust failures
can first appear there.

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
The macOS app is signed ad-hoc (`bundle.macOS.signingIdentity: "-"`), not with a
Developer ID, and is not notarized. Apple Silicon runs signed code only, and the
linker's automatic signature covers the executable alone: v0.1.20 shipped that,
and macOS reported every downloaded copy as damaged. `scripts/verify-macos-app.sh`
runs before staging and refuses an app whose signature does not bind
`Info.plist`, seal the resources and carry the bundle identifier, checks that the
DMG holds the same signature, and launches the DMG's copy until it opens its
database (the Intel build under Rosetta). Pull requests that change packaging
inputs run the same build and checks for Apple Silicon in CI
(`Desktop macOS`). Release installer artifacts are kept for one
day (publication follows within minutes); packaging failure logs and the generated
DMG script are retained for 7 days.

Tauri's verbose log exposes generated DMG-script stdout/stderr, which otherwise
appears only at debug level. Packaging failures also print macOS version, Xcode,
architecture, disk space, and mounted disk images. No automatic packaging retry or
Finder workaround is applied without evidence of the underlying error.

### Merge is the beginning of release verification

1. Run `pnpm deps:update`, fold in any open Dependabot PR, run the complete local
   gate below, and open a PR against `main`.
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

Dependencies are refreshed in every release PR, alongside automatic patch PRs:

```bash
pnpm deps:update   # pnpm update + cargo update within declared ranges, then checks
```

It updates npm packages and the Cargo lockfile within the ranges in `package.json`
and `Cargo.toml`, re-runs `pnpm version:check`, and lists what it did not update:
`pnpm outdated` for npm, and Cargo's `Unchanged … (available: …)` lines for crates
held back by their ranges. Treat those as deliberate upgrades in their own change.
Then run the complete gate below; no test or security rule is relaxed.

Dependabot (`.github/dependabot.yml`) opens monthly grouped patch version PRs for
npm and Cargo, with at most one open version PR per ecosystem. The `allow` rules
restrict routine version updates to patches; security updates remain independent
and can propose a larger upgrade when needed and resolvable. GitHub Actions
retains its monthly grouped updates. If a bot PR is open when a release PR is
prepared, include its commit and close it with a link. PRs still need review and
passing checks; nothing merges automatically.

Keep compatible ranges: npm `^2.12.2` permits compatible 2.x releases, and Cargo
`"2.12"` means `>=2.12.0, <3.0.0`. Both already allow patch releases. A blanket
`2.12.*` would narrow those ranges. Cargo's 0.x compatibility boundaries differ:
`"0.18"` allows 0.18 patches but excludes 0.19 and 0.20. Commit both lockfiles to
keep builds reproducible; updates change the lockfiles through reviewed PRs.

The workspace currently patches glib to `vendor/glib` to backport
RUSTSEC-2024-0429 without mixing incompatible GTK binding generations. See
[the backport notes](../vendor/README.md) for provenance, verification and removal
criteria. Dependabot does not maintain this local source copy: review it when
the parent dependencies change, and remove the override when they support a
fixed registry release. Flexible ranges cannot solve incompatible parent ranges.

`pnpm version:check` fails when a Tauri npm package and its Rust crate differ in
major.minor (`@tauri-apps/api` ↔ `tauri`, `@tauri-apps/plugin-<name>` ↔
`tauri-plugin-<name>`), because Tauri refuses to build that combination. Upgrade
both sides together, along with `@tauri-apps/cli`. Never ignore a Tauri version
mismatch to get a green build.

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

### apt repository

Every Pages deployment runs `scripts/build-apt-repo.sh`, which downloads the `.deb`
of the newest three published releases, checks them against each release's
`SHA256SUMS`, and writes a repository under `/apt` signed with the
`APT_SIGNING_KEY` secret (an armored ed25519 signing key without passphrase). The
release workflow dispatches the Pages workflow on `main` after publishing, so a
new version reaches `apt upgrade` within minutes. To rebuild by hand:

```bash
gh workflow run pages.yml --ref main
```

Pull requests run the same script with a throwaway key and check the signature
with `gpgv`. If the key ever changes, users must download the new
`orchevia-archive-keyring.gpg`; keep a backup of the secret key outside GitHub.

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
