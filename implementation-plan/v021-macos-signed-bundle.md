# v0.1.21 implementation outcome

A macOS app that opens after download, and release checks that keep it that way.
Application version `0.1.20` → `0.1.21`. Workflow schema, templates and Simple
JSON unchanged.

## Why

A user on Apple Silicon downloaded `Orchevia-macos-arm64.dmg` with Chrome, and
macOS said "Orchevia.app is damaged and can't be opened. You should move it to the
Trash." The published v0.1.20 DMG explains it:

- `Contents/MacOS/orchevia` carried only the signature `ld` adds to every arm64
  binary: `flags=0x20002(adhoc,linker-signed)`, identifier
  `orchevia-89ee4ed25d7fe158`, `Info.plist=not bound`, `Sealed Resources=none`.
- The bundle had no `Contents/_CodeSignature`. Tauri signs only when
  `bundle.macOS.signingIdentity` is set, and it was not.
- On a macOS 15 runner, `codesign --verify --deep --strict` on that app fails
  with "code has no resources but signature indicates they must be present".
  Gatekeeper treats an invalid signature on a quarantined app as damage, so it
  offers only the Trash; Open Anyway is never offered.

Apple Silicon runs signed code only, so the executable itself still launches once
the quarantine flag is removed. That is why the `xattr` command worked and the
problem never showed on a machine that built the app locally.

## Fix

- `bundle.macOS.signingIdentity: "-"`: Tauri signs the executable and then the
  bundle ad-hoc, with the hardened runtime. The signature now binds `Info.plist`,
  seals the resources and uses the bundle identifier `dev.orchevia.app`. Tauri
  skips signing the DMG for `-` (tauri-apps/tauri#12288) and skips notarization
  without Apple credentials.
- An ad-hoc signature is not a Developer ID, so Gatekeeper still blocks the first
  launch of a downloaded copy. It now says Apple could not verify Orchevia, and
  System Settings → Privacy & Security offers **Open Anyway**. Only Developer ID
  signing plus notarization (a paid Apple Developer membership) removes that
  prompt.

## Release checks

`scripts/verify-macos-app.sh <bundle-dir> [--launch]` runs on both macOS release
builds before staging, and in the new **Desktop macOS** CI job:

1. `codesign --verify --deep --strict`, then the displayed signature must name the
   bundle identifier, bind `Info.plist`, seal resources (version 2), have a CDHash
   and not be `linker-signed`. Each check alone rejects the v0.1.20 app.
2. `hdiutil verify`, then the DMG is mounted read-only and its app must pass the
   same checks with the same CDHash as the built app.
3. `--launch` copies the DMG's app out with `ditto` and starts it with `HOME` set
   to an empty folder. It requires the process to stay up for a few seconds after
   `orchevia.db` appears under that folder's
   `Library/Application Support/dev.orchevia.app`, so a database from an earlier
   run cannot pass and a real install's data is never touched. The app is stopped
   on every exit path. The Intel build runs under Rosetta on the Apple Silicon
   runner; without Rosetta the launch is skipped.

The script is written for the runners' `/bin/bash` 3.2: failures inside command
substitutions are returned explicitly. Its tests run the real script with fake
`codesign`, `plutil`, `hdiutil`, `lipo`, `uname`, `arch` and `ditto`, using the
exact `codesign --display` output of the v0.1.20 app. Disabling the
`codesign --verify` result, the empty home folder or the stop on failure each
makes a test fail.

`scripts/ci-changes.mjs` has a `macos` output: Tauri config, icons and manifests
under `src-tauri/` (not Rust source or tests), `ci.yml`, `release.yml`, the
script, and every fail-safe input (locks, `package.json`). **CI result** requires
the job when it applies. It builds `aarch64-apple-darwin` with the release
command, without a Rust cache.

## Evidence

A temporary workflow on the PR branch ran on GitHub's macOS 15.7 runners
(Apple Silicon, `/bin/bash` 3.2.57, Rosetta installed) before the PR:

- **v0.1.20 as published:** the gate fails at `codesign --verify` with "code has
  no resources but signature indicates they must be present". After copying the
  app out of a DMG quarantined as a Chrome download, `spctl --assess` printed the
  same error instead of `rejected`, `syspolicy_check distribution` reported a
  fatal **Codesign Error**, and opening it showed "“Orchevia” is damaged and
  can't be opened. You should move it to the Trash." with Cancel and Move to
  Trash: the reported dialog.
- **This build, both architectures:** `Identifier=dev.orchevia.app`,
  `flags=0x10002(adhoc,runtime)`, `Info.plist entries=15`,
  `Sealed Resources version=2`, "valid on disk" and "satisfies its Designated
  Requirement"; the DMG copy had the same CDHash; the arm64 app and the x86_64
  app (under Rosetta) launched from the DMG and opened their database. Quarantined
  the same way, `spctl` printed `rejected` (policy, not a broken signature),
  `syspolicy_check` reported only the missing notarization ticket and an XProtect
  lookup error it also reports for v0.1.20, and opening it showed "“Orchevia” Not
  Opened. Apple could not verify “Orchevia” is free of malware…" with Done and
  Move to Trash: the prompt that Open Anyway approves.
- Copying the app out of a quarantined DMG quarantines every file in it,
  including `Contents/MacOS/orchevia`, so the documented command is recursive
  (`xattr -dr`).
- Installed in `/Applications` from that quarantined DMG, `xattr -dr
  com.apple.quarantine /Applications/Orchevia.app` left no quarantine attribute
  and `open` showed the app window with the setup wizard: for this build before
  any launch, for this build after a blocked first launch, and for v0.1.20 after
  its "damaged" dialog. So the command also unblocks copies of older releases.
- While the first-launch prompt is up, macOS holds the quarantined app suspended
  in an App Translocation mount, so a check for the installed path does not see
  it; the gate launches its own unquarantined copy instead.

## Docs

README, website install card and FAQ, release-note body, SECURITY.md,
`docs/hardening.md`, `docs/security.md`, `docs/development.md`, and the macOS
step in **Environment → Updates** now describe Open Anyway and
`xattr -dr com.apple.quarantine /Applications/Orchevia.app`. Right-click → Open
no longer bypasses Gatekeeper on macOS 15, so it is gone.

## Not done

- Developer ID signing and notarization need an Apple Developer membership and
  the `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`
  and notarization secrets that Tauri reads.
- Other macOS Rust compilation is still first exercised by the release.
