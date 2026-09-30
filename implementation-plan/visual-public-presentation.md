# Visual and public presentation pass

## 2026-09-30 private beta follow-up

- Confirmed v0.1.2 publishes Linux AppImage/.deb and Apple Silicon/Intel Mac
  installers with checksums. README links to these files require repository
  access while the repository remains private.
- Preparing v0.1.3 pairs the Rust/frontend dialog-plugin 2.8.0 updates. The
  README retains working v0.1.2 links until newer installers are published.
- The public project page announces that repository access and downloads will
  be public soon. Removed release API polling and unavailable download controls;
  retained source instructions explicitly for contributors with access.
- Public launch still needs the user's visibility change and a follow-up to
  restore public download links. Existing Pages publication remains unchanged.

## Original presentation pass

- Reused the existing sidebar, React Flow canvas, node accent metadata, and static
  `docs/index.html` structure.
- Moved the sidebar collapse control into the brand header, retained the saved
  collapsed preference, and labeled every icon-only navigation button.
- Reused the existing safe Markdown renderer for generation-history goals and
  pretty-printed valid proposal JSON, keeping both sections height-limited.
- Increased node-kind contrast and made large workflows open near the beginning
  at a readable zoom. The existing fit control still provides a whole-graph view.
- Corrected the repository and planned Pages URL for the current owner, corrected
  the built-in template count, and replaced premature installer claims with
  source-build steps. The repository remains private and has no release yet.
- CI and release workflows now collect installer artifacts from the Cargo workspace
  target directory. Release publishing computes one checksum manifest after both
  platform artifacts are downloaded, and fails packaging if an expected installer
  is missing.
- Local `pnpm tauri build` produced Linux `.deb`, `.rpm`, and `.AppImage`
  packages. Tauri warns that the existing `dev.orchevia.app` identifier ends in
  `.app`; changing it would move the app data directory, so migration needs a
  separate decision before renaming it.
- Public launch still requires publishing the repository, verifying release
  artifacts in CI, and enabling GitHub Pages. No remote state was changed in
  this pass.

## 2026-09-24 follow-up

- Generation waiting state shows elapsed time with distinct copy as the local
  CLI continues; no fabricated progress percentage. Long explanations collapse
  behind a short summary, with risks and executable steps in details.
- Selected nodes keep their shadow under a crisp accent ring; the canvas uses a
  move cursor instead of React Flow's hand cursor.
- PR CI adds an Intel Mac installer build. Tagged releases stage stable Linux
  and Apple Silicon/Intel Mac filenames. The project page detects Linux/macOS,
  queries the latest public release, and reveals direct download links only
  for assets that exist. It falls back to source instructions while no release
  is public. README and the page now include contributor architecture and gates.
- A public repository, successful remote CI/release run, and GitHub Pages
  publication still require the user's later launch step. No remote changes
  were made.

- The updated `pnpm tauri build` completed locally and produced a `.deb`, `.rpm`,
  and `.AppImage`. Intel/Apple Silicon macOS artifacts remain unverified until
  GitHub Actions runs on the appropriate hosted runners.
