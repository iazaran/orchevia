#!/usr/bin/env bash
# Refuse a macOS build that a downloaded copy could not open. Apple Silicon runs
# signed code only, and the linker's automatic signature covers the executable
# alone: without a signature over the whole bundle, Gatekeeper reports a
# downloaded app as "damaged" and offers no way to open it (v0.1.20).
#
#   scripts/verify-macos-app.sh <bundle-dir> [--launch]
#
# <bundle-dir> is Tauri's target/[<triple>/]release/bundle. The .app and the
# copy inside the DMG must carry the same signature over the whole bundle.
# --launch also starts the DMG's copy with an empty home folder and requires it
# to open its database there, under Rosetta for an Intel build on Apple Silicon,
# unless this Mac cannot run that architecture. Run it on a CI runner: an
# Orchevia already running here would take the launch instead.
set -euo pipefail

usage='usage: verify-macos-app.sh <bundle-dir> [--launch]'
bundle=${1:-}
launch=${2:-}
if [ -z "$bundle" ] || [ $# -gt 2 ] || { [ -n "$launch" ] && [ "$launch" != --launch ]; }; then
  echo "$usage" >&2
  exit 2
fi
settle=${VERIFY_SETTLE_SECONDS:-5}
startup=${VERIFY_STARTUP_SECONDS:-60}
app=$(find "$bundle/macos" -maxdepth 1 -type d -name '*.app' -print -quit 2>/dev/null || true)
dmg=$(find "$bundle/dmg" -maxdepth 1 -type f -name '*.dmg' -print -quit 2>/dev/null || true)
if [ -z "$app" ] || [ -z "$dmg" ]; then
  echo "Expected an .app under $bundle/macos and a .dmg under $bundle/dmg" >&2
  exit 1
fi

plist() { plutil -extract "$2" raw -o - "$1/Contents/Info.plist"; }

# Print the CDHash of an app signed as a whole bundle, or explain what is missing.
# Written for the system bash 3.2, so failures are returned explicitly.
sealed() {
  local app=$1 details id hash problems=
  codesign --verify --deep --strict --verbose=2 "$app" || return 1
  details=$(codesign --display --verbose=4 "$app" 2>&1) || return 1
  id=$(plist "$app" CFBundleIdentifier) || return 1
  grep -qxF "Identifier=$id" <<<"$details" || problems="$problems; it is not signed as $id"
  grep -q '^Info\.plist entries=' <<<"$details" || problems="$problems; Info.plist is not bound"
  grep -q '^Sealed Resources version=2' <<<"$details" ||
    problems="$problems; resources are not sealed"
  if grep -q 'linker-signed' <<<"$details"; then
    problems="$problems; only the linker signed the executable"
  fi
  hash=$(sed -n 's/^CDHash=//p' <<<"$details")
  [ -n "$hash" ] || problems="$problems; the signature has no CDHash"
  if [ -n "$problems" ]; then
    printf '%s\n' "$details" >&2
    echo "$app: ${problems#; }, so macOS would report a download as damaged." >&2
    return 1
  fi
  echo "$hash"
}

built=$(sealed "$app") || exit 1
echo "Signed bundle: $app ($built)"

hdiutil verify -quiet "$dmg"
work=$(mktemp -d)
mount="$work/dmg"
mkdir "$mount"
attached=
pid=
# Stop the launched app, forcing it after ten seconds.
stop() {
  kill "$pid" 2>/dev/null || return 0
  for _ in $(seq 10); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  kill -9 "$pid" 2>/dev/null || true
}
cleanup() {
  [ -z "$pid" ] || stop
  # Leave the folder rather than delete through a volume that is still mounted.
  if [ -n "$attached" ] && ! hdiutil detach -quiet "$mount" &&
    ! hdiutil detach -quiet -force "$mount"; then
    echo "Could not detach $dmg; it stays mounted at $mount" >&2
    return
  fi
  rm -rf "$work"
}
trap cleanup EXIT
hdiutil attach -quiet -readonly -nobrowse -noautoopen -mountpoint "$mount" "$dmg"
attached=1
shipped="$mount/$(basename "$app")"
packed=$(sealed "$shipped") || exit 1
if [ "$packed" != "$built" ]; then
  echo "$dmg holds another signature ($packed) than the built app ($built)" >&2
  exit 1
fi
echo "DMG copy matches: $dmg"

[ "$launch" = --launch ] || exit 0
executable=$(plist "$shipped" CFBundleExecutable)
archs=$(lipo -archs "$shipped/Contents/MacOS/$executable")
if [ "$archs" != "$(uname -m)" ] &&
  ! { [ "$archs" = x86_64 ] && arch -x86_64 /usr/bin/true 2>/dev/null; }; then
  echo "Launch skipped: this Mac is $(uname -m) and cannot run the $archs app."
  exit 0
fi
# Install it the way a user drags it out of the DMG. The empty home folder means
# a database from an earlier run cannot pass for this one, and no existing
# install's data is touched.
mkdir "$work/Applications" "$work/home"
copy="$work/Applications/$(basename "$app")"
ditto "$shipped" "$copy"
database="$work/home/Library/Application Support/$(plist "$copy" CFBundleIdentifier)/orchevia.db"
HOME="$work/home" "$copy/Contents/MacOS/$executable" >"$work/launch.log" 2>&1 &
pid=$!
for _ in $(seq "$startup"); do
  if [ -s "$database" ] || ! kill -0 "$pid" 2>/dev/null; then break; fi
  sleep 1
done
# A crash while opening the window comes after the database exists.
[ -s "$database" ] && sleep "$settle"
if [ ! -s "$database" ] || ! kill -0 "$pid" 2>/dev/null; then
  cat "$work/launch.log" >&2
  echo "The app from the DMG did not keep running with its database open." >&2
  exit 1
fi
stop
pid=
echo "Launched from the DMG and opened its database."
