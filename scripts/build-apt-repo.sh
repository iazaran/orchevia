#!/usr/bin/env bash
# Build the signed apt repository served at <site>/apt from the .deb of the
# newest published releases, so `sudo apt upgrade` picks up new versions.
#
#   APT_SIGNING_KEY=<armored secret key> scripts/build-apt-repo.sh <output-dir>
#
# Needs gh (GH_TOKEN), gpg, dpkg-deb and apt-ftparchive. Releases without a
# .deb yet (still building) are skipped; at least one must have it.
set -euo pipefail

out=${1:?usage: build-apt-repo.sh <output-dir>}
repo=${GITHUB_REPOSITORY:-iazaran/orchevia}
keep=${APT_KEEP_RELEASES:-3}
asset=Orchevia-linux-x86_64.deb
: "${APT_SIGNING_KEY:?APT_SIGNING_KEY must hold the armored signing key}"

# Absolute, because the indexes are written after changing into it.
mkdir -p "$out"
out=$(cd "$out" && pwd)

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export GNUPGHOME="$work/gnupg"
mkdir -m 700 "$GNUPGHOME"
printf '%s\n' "$APT_SIGNING_KEY" | gpg --batch --quiet --import
fingerprint=$(gpg --batch --with-colons --list-secret-keys | awk -F: '/^fpr/ { print $10; exit }')
test -n "$fingerprint"

pool="$out/pool/main/o/orchevia"
binary="$out/dists/stable/main/binary-amd64"
mkdir -p "$pool" "$binary"

count=0
while read -r tag && [ "$count" -lt "$keep" ]; do
  dir="$work/$tag"
  mkdir -p "$dir"
  if ! gh release download "$tag" --repo "$repo" --dir "$dir" \
    --pattern "$asset" --pattern SHA256SUMS 2>/dev/null ||
    [ ! -s "$dir/$asset" ]; then
    echo "skip $tag: no $asset yet"
    continue
  fi
  (cd "$dir" && sha256sum -c SHA256SUMS --ignore-missing)
  version=$(dpkg-deb -f "$dir/$asset" Version)
  arch=$(dpkg-deb -f "$dir/$asset" Architecture)
  test "v$version" = "$tag"
  test "$arch" = amd64
  mv "$dir/$asset" "$pool/orchevia_${version}_${arch}.deb"
  count=$((count + 1))
done < <(gh release list --repo "$repo" --exclude-drafts --exclude-pre-releases \
  --limit 20 --json tagName --jq '.[].tagName')
test "$count" -gt 0

cd "$out"
apt-ftparchive packages pool > "$binary/Packages"
gzip -9kn "$binary/Packages"
# Written outside dists/ first so Release does not list itself.
apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=Orchevia \
  -o APT::FTPArchive::Release::Label=Orchevia \
  -o APT::FTPArchive::Release::Suite=stable \
  -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Architectures=amd64 \
  -o APT::FTPArchive::Release::Components=main \
  -o "APT::FTPArchive::Release::Description=Orchevia desktop app" \
  release dists/stable > "$work/Release"
mv "$work/Release" dists/stable/Release
gpg --batch --yes --local-user "$fingerprint" --clearsign \
  --output dists/stable/InRelease dists/stable/Release
gpg --batch --yes --local-user "$fingerprint" --armor --detach-sign \
  --output dists/stable/Release.gpg dists/stable/Release
gpg --batch --export "$fingerprint" > orchevia-archive-keyring.gpg
gpg --batch --armor --export "$fingerprint" > orchevia-archive-keyring.asc
echo "apt repository with $count release(s), signed by $fingerprint"
