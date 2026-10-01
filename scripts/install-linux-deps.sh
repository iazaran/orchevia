#!/usr/bin/env bash
set -euo pipefail

# GitHub's mirror list prioritizes Azure even when it responds extremely slowly.
# Keep Ubuntu's archive/security fallbacks and the runner's signed APT sources.
# The optional path allows a fixture to exercise this without touching host APT.
mirrors=${1:-/etc/apt/apt-mirrors.txt}
if [[ -f "$mirrors" ]] && grep -q '^https://archive\.ubuntu\.com/ubuntu/' "$mirrors"; then
  sudo sed -i '\#^http://azure\.archive\.ubuntu\.com/ubuntu/\([[:space:]]\|$\)#d' "$mirrors"
  cat "$mirrors"
else
  echo 'Runner mirror list differs from the expected layout; keeping its sources.'
fi

apt_options=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)
echo 'Updating signed package indexes'
time sudo apt-get "${apt_options[@]}" update
echo 'Installing Tauri build and packaging dependencies'
# Retain recommended media packages: AppImage bundles the media framework.
time sudo apt-get "${apt_options[@]}" install -y libwebkit2gtk-4.1-dev libxdo-dev \
  librsvg2-dev patchelf libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev build-essential curl wget file \
  libssl-dev libgtk-3-dev libayatana-appindicator3-dev
