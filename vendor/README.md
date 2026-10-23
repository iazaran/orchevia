# glib 0.18.5 security backport

This directory holds the published glib 0.18.5 crate with exactly the two-line
pointer-mutability fix from
[gtk-rs/gtk-rs-core#1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343),
upstream commit `05dff0ee696f9bcd8617cd48c4b812d046d440cb`.
It addresses [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)
([GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g)).

## Provenance and scope

- Package: `glib` 0.18.5, published on crates.io, MIT licensed.
- Original archive: <https://static.crates.io/crates/glib/glib-0.18.5.crate>.
- Archive SHA-256:
  `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`.
- Original source revision (the archive's `.cargo_vcs_info.json`):
  `42b9caf98e03ded086362d9653ca58fe94dc8658`, subdirectory `glib`.
- `glib/LICENSE`, `glib/COPYRIGHT`, all sources, manifests, tests and benchmarks
  are retained from the archive. Only `glib/src/variant_iter.rs` is changed:
  `let p` becomes `let mut p`, and the variadic C output argument becomes `&mut p`.
- The package version remains 0.18.5; it is not advertised as an official patched
  release. The workspace's `[patch.crates-io]` selects it for every glib 0.18
  consumer. No newer binding generation is mixed into the GTK3 graph.

Tauri's GTK3/WebKitGTK dependencies require glib 0.18, while the advisory's fixed
published series starts at 0.20. An ordinary lockfile update or broader direct
dependency range cannot satisfy both. A local source copy keeps the backport
reviewable and reproducible without relying on a mutable third-party Git branch.

## Verification

```bash
cargo tree --locked -i glib
cargo test -p orchevia --locked --test glib_variant_iter
```

The tree must resolve one glib 0.18.5 from this directory. The Linux integration
test uses that same dependency; `[profile.test.package.glib]` enables optimization
because the original undefined behavior is compiler-sensitive. The test failed
with a null-pointer abort on the original registry source before the backport.
It covers forward/reverse iteration, skipping, the final value, exhaustion,
empty arrays and UTF-8. Desktop CI's `--all-targets` includes it on Linux.

To review the source, download the archive, verify the checksum above, extract
it outside the checkout, and compare its `glib-0.18.5/` with `vendor/glib/`.
Only the two-line change described above should differ. Keep third-party source
formatting intact; format the project's tests and this document normally.

## Maintenance and removal

Dependabot can update published dependencies but does not maintain this local
copy. Version-based scanners may still report glib 0.18.5; an alert disappearing
because the source is local is not evidence of a fix. Do not dismiss the alert
or add an advisory ignore on the strength of the package source alone.

At every Tauri/GTK dependency upgrade, check for a compatible fixed registry
release. When the full Linux dependency graph can resolve one without the
override, remove `[patch.crates-io]`, the workspace exclusion, and `vendor/glib/`;
regenerate `Cargo.lock`, keep the regression test aligned with the new binding
version, and rerun it plus all repository gates. Until then, review upstream
security changes for this vendored crate manually.
