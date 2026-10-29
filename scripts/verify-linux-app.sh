#!/usr/bin/env bash
# Refuse a Linux release whose app does not start: the counterpart of
# verify-macos-app.sh for the .deb and the AppImage.
#
#   scripts/verify-linux-app.sh <bundle-dir>
#
# <bundle-dir> is Tauri's target/release/bundle. The .deb is unpacked, not
# installed, and the command its desktop entry names is started; the AppImage
# starts as downloaded, extracting itself because CI runners have no FUSE.
# Each launch gets an empty home folder, a cleared environment and an Xvfb
# display of its own, and must open its database there and keep running.
# Nothing reaches an existing install's data, a desktop session or its D-Bus,
# but Xvfb must be installed.
set -euo pipefail

usage='usage: verify-linux-app.sh <bundle-dir>'
bundle=${1:-}
if [ -z "$bundle" ] || [ $# -gt 1 ]; then
  echo "$usage" >&2
  exit 2
fi
settle=${VERIFY_SETTLE_SECONDS:-5}
startup=${VERIFY_STARTUP_SECONDS:-60}
# The data folder every Linux install has used (the identifier in tauri.conf.json).
identifier=dev.orchevia.app
deb=$(find "$bundle/deb" -maxdepth 1 -type f -name '*.deb' -print -quit 2>/dev/null || true)
appimage=$(find "$bundle/appimage" -maxdepth 1 -type f -name '*.AppImage' -print -quit 2>/dev/null || true)
if [ -z "$deb" ] || [ -z "$appimage" ]; then
  echo "Expected a .deb under $bundle/deb and an .AppImage under $bundle/appimage" >&2
  exit 1
fi
if ! command -v Xvfb >/dev/null; then
  echo 'Xvfb is required to launch the app (apt-get install xvfb).' >&2
  exit 1
fi

work=$(mktemp -d)
xvfb=
pid=
# Stop the launched app's process group, forcing it after ten seconds.
stop() {
  kill -TERM -- "-$pid" 2>/dev/null || return 0
  for _ in $(seq 10); do
    kill -0 -- "-$pid" 2>/dev/null || break
    sleep 1
  done
  kill -KILL -- "-$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}
cleanup() {
  [ -z "$pid" ] || stop
  if [ -n "$xvfb" ]; then
    kill "$xvfb" 2>/dev/null || true
    wait "$xvfb" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

# Xvfb picks a free display and writes its number to descriptor 3 when ready.
Xvfb -displayfd 3 -screen 0 1280x800x24 -nolisten tcp 3>"$work/display" >"$work/xvfb.log" 2>&1 &
xvfb=$!
for _ in $(seq 50); do
  if [ -s "$work/display" ] || ! kill -0 "$xvfb" 2>/dev/null; then break; fi
  sleep 0.2
done
if [ ! -s "$work/display" ]; then
  cat "$work/xvfb.log" >&2
  echo 'Xvfb did not start.' >&2
  exit 1
fi
display=":$(head -n 1 "$work/display")"

# launch <name> [NAME=value...] <command...>: start the command as its own
# process group with an empty home folder, and require it to open its database
# there and keep running.
launch() {
  local name=$1 home log database
  shift
  home="$work/home-${name// /-}"
  log="$work/${name// /-}.log"
  database="$home/.local/share/$identifier/orchevia.db"
  mkdir -p "$home" "$work/tmp"
  setsid env -i HOME="$home" PATH=/usr/local/bin:/usr/bin:/bin DISPLAY="$display" \
    TMPDIR="$work/tmp" "$@" >"$log" 2>&1 &
  pid=$!
  for _ in $(seq "$startup"); do
    if [ -s "$database" ] || ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 1
  done
  # A crash while opening the window comes after the database exists.
  [ -s "$database" ] && sleep "$settle"
  if [ ! -s "$database" ] || ! kill -0 "$pid" 2>/dev/null; then
    cat "$log" >&2
    echo "The $name did not keep running with its database open." >&2
    exit 1
  fi
  stop
  pid=
  echo "Launched the $name; it opened its database."
}

# The .deb: start what its desktop entry runs, from the unpacked package.
root="$work/deb"
mkdir "$root"
dpkg-deb -x "$deb" "$root"
entry=$(find "$root/usr/share/applications" -maxdepth 1 -type f -name '*.desktop' -print -quit 2>/dev/null || true)
if [ -z "$entry" ]; then
  echo "$deb installs no desktop entry, so no launcher would show Orchevia." >&2
  exit 1
fi
command=$(sed -n 's/^Exec=//p' "$entry" | head -n 1)
program=${command%% *}
case $program in
  /*) binary="$root$program" ;;
  *) binary="$root/usr/bin/$program" ;;
esac
if [ -z "$program" ] || [ ! -f "$binary" ] || [ ! -x "$binary" ]; then
  echo "$(basename "$entry") runs '$command', which $(basename "$deb") does not install." >&2
  exit 1
fi
launch 'app from the .deb' "$binary"

# The AppImage, unchanged; it extracts itself instead of mounting with FUSE.
launch 'AppImage' APPIMAGE_EXTRACT_AND_RUN=1 "$appimage"
