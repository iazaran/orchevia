# glib security backport and patch updates

Keep the application at 0.1.20. GTK3 and WebKitGTK require glib 0.18, so
upgrading only glib to the advisory's fixed 0.20 series is incompatible.
Retain existing compatible dependency ranges rather than narrowing them to
patch wildcards. Use Cargo's standard patch mechanism for an exact backport
of gtk-rs/gtk-rs-core#1343 into the published glib 0.18.5 source, preserving
its license and recording provenance. Remove the override once the upstream
desktop dependency chain supports a fixed published version.

1. Add a Linux desktop regression test covering forward, reverse, skipped,
   final, empty and UTF-8 string iteration. Optimize glib in the test profile
   to reproduce the compiler-sensitive bug; verify failure before the fix.
2. Vendor glib 0.18.5, apply only the upstream pointer-mutability fix, and
   select it through the workspace patch. Verify the regression passes and
   Cargo resolves one glib source across the desktop tree.
3. Re-enable monthly npm/Cargo version PRs, grouped per ecosystem, allowing
   patch updates only. Keep security updates independent. Document ranges,
   the local backport, its maintenance limits and removal criteria.
4. Run all AGENTS.md gates, optimized regression and frozen npm install;
   review the diff and vendor provenance, then push and open a PR.

Review focus: the backport must retain GTK's 0.18 API, affect every glib
consumer, preserve copyright/license, avoid unrelated dependency changes,
and keep all application versions unchanged. A path override is maintained
locally; it does not promise automatic Dependabot remediation or alert closure.

## Verification and review

- Original registry glib: the optimized regression aborted on a null pointer.
  Backported source: the same test passes; one vendored glib resolves throughout
  the desktop dependency tree.
- Archive SHA-256 verified; all 121 archive files are retained. Only the two
  upstream lines in `src/variant_iter.rs` differ. Original license whitespace
  is preserved along with the license itself.
- Frozen pnpm installation, `pnpm check` (19 delivery and 412 frontend tests),
  465 core tests, core Clippy with warnings denied, Rust format, desktop compile
  and all desktop tests (6 existing plus the regression) passed.
- Self-review and independent review found no blocking issues. All application
  versions remain 0.1.20. The vendored upstream code emits existing compiler
  warnings; no lint suppression or source cleanup was added to hide them.
- Prettier excludes the unchanged third-party source and local nested Claude
  worktrees, which otherwise caused formatting failures in unrelated generated
  schemas. Project-owned tests and backport documentation remain checked.
