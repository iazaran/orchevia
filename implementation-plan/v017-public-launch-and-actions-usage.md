# v0.1.17 implementation outcome

Public-launch presentation, lower GitHub Actions usage, and the pending dependency
updates. Application version `0.1.16` → `0.1.17`. No application behavior, schema,
template or Simple JSON version changes.

## Why

The repository and releases are about to become public. The README and project
page still described them as private, pinned every download to one version, and
had no screenshots of the app. Release runs were also the account's largest
Actions cost: private-repository macOS minutes count at a premium, the Intel DMG
job took about 11 minutes, release builds saved caches that the next tag can never
restore, and about 1.1 GB of duplicate installer artifacts sat in Actions storage
for 14 days.

## Delivered

1. **Dependencies.** The two open Dependabot groups (frontend: 12 updates, Rust:
   5 updates) are included as their original commits. `tauri` 2.12.x and
   `@tauri-apps/api` 2.12.x still share major and minor versions.
2. **Release workflow** (`release.yml`):
   - Both DMGs build on `macos-15` (Apple Silicon): `aarch64-apple-darwin`
     natively and `x86_64-apple-darwin` cross-compiled. Staging checks every
     executable in the `.app` with `lipo -archs` against the matrix architecture.
   - Build jobs no longer use Rust or pnpm caches; validation restores main's core
     cache with `save-if: false`.
   - Installer artifacts are kept for one day.
   - `scripts/workflows.test.mjs` runs the real staging block: an arm64 or
     universal binary can't ship as the Intel DMG, and Linux needs both packages.
3. **Other workflows.**
   - Pages starts only for `docs/**`, its own workflow or `scripts/ci-changes.mjs`.
     Its validation requires latest-release links and existing images.
   - Dependabot is monthly.
4. **README** rewritten for the public repository:
   - badges (CI, release, downloads, license, platforms, stack, stars);
   - `releases/latest/download/` links and install steps, including macOS
     "Open Anyway";
   - screenshots, a generator guide, the safety model and current limits,
     including undetected Codex refusals.
5. **Project page** (`docs/index.html`):
   - OS-aware download recommendation and accessible tabs for a tour of real
     screens;
   - a generator guide with a copyable goal;
   - an in-browser replay of a ticket → reviewed draft PR run (approval pause,
     parallel reviews, one fix loop, draft PR);
   - latest-release install cards and a large social-preview card.

   No external requests, no storage, and `prefers-reduced-motion` is respected.
6. **Screenshots.** `docs/images/*.webp` are 2× captures of the browser build seeded
   with demo data (a showcase workflow, a realistic run with a P1 fix loop, 30
   days of review runs). Generation and tool detection were stubbed in the page for
   the capture only; nothing in the app changed.
7. **Tests.**
   - `src/test/public-docs.test.ts` pins the latest-release links, the absence of
     private wording and API polling, image alt text and files, and navigation.
   - It also runs the page's scripts in jsdom: OS recommendation, tab keyboard
     navigation, a full demo replay including the approval pause, and reset
     during a pause.
8. **Docs.**
   - The development guide covers the release, Pages, screenshots, Dependabot and
     "Keeping Actions usage low".
   - Getting started, ROADMAP and CONTRIBUTING (Node 24+) were updated.
   - Employer-like ticket keys in tests and a placeholder became `DEV-1234`.

## Not changed

- Old release assets stay: they do not count toward Actions storage and keep older
  versions installable.
- Existing Actions artifacts expire on their own; deleting them early is a manual,
  permanent maintainer action.
- macOS signing/notarization, Windows builds and an auto-updater remain future work.
