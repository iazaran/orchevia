import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  UPDATE_BUNDLES,
  buildManifest,
  parsePublicKey,
  verifySignature,
} from './updater-manifest.mjs';

// Made with `tauri signer generate` and `tauri signer sign` from a throwaway
// key whose private half was discarded.
const fixture = (name) => readFileSync(join('scripts/fixtures/updater', name));
const publicKey = fixture('throwaway.key.pub').toString().trim();
const bundle = fixture('bundle.bin');
const signature = fixture('bundle.bin.sig').toString().trim();

test('accepts a real Tauri signature and rejects any change to it', () => {
  assert.equal(parsePublicKey(publicKey).keyId.length, 8);
  assert.equal(verifySignature(bundle, signature, publicKey), true);
  assert.equal(verifySignature(Buffer.from('tampered'), signature, publicKey), false);
  // The trusted comment (timestamp and file name) is signed too.
  const text = Buffer.from(signature, 'base64').toString();
  const edited = Buffer.from(text.replace('file:bundle.bin', 'file:other.bin')).toString(
    'base64',
  );
  assert.equal(verifySignature(bundle, edited, publicKey), false);
  assert.throws(() => verifySignature(bundle, signature, ''), /empty/);
});

function releaseDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'orchevia-updater-'));
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(dir, name), content);
  return dir;
}

const signedRelease = () =>
  Object.fromEntries(
    Object.values(UPDATE_BUNDLES).flatMap((asset) => [
      [asset, bundle],
      [`${asset}.sig`, signature],
    ]),
  );

test('writes one entry per platform pointing at the tagged release', () => {
  const dir = releaseDir(signedRelease());
  try {
    const manifest = buildManifest({
      dir,
      tag: 'v0.1.24',
      publicKey,
      date: new Date('2026-10-30T12:00:00.123Z'),
    });
    assert.equal(manifest.version, '0.1.24');
    assert.equal(manifest.pub_date, '2026-10-30T12:00:00Z');
    assert.deepEqual(Object.keys(manifest.platforms).sort(), [
      'darwin-aarch64',
      'darwin-x86_64',
      'linux-x86_64-appimage',
    ]);
    // Debian installs must never match: apt owns their files.
    assert.equal(manifest.platforms['linux-x86_64'], undefined);
    assert.equal(
      manifest.platforms['darwin-aarch64'].url,
      'https://github.com/iazaran/orchevia/releases/download/v0.1.24/Orchevia-macos-arm64.app.tar.gz',
    );
    assert.equal(manifest.platforms['darwin-aarch64'].signature, signature);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a release without the signing secret ships installers only', () => {
  const dir = releaseDir({ 'Orchevia-linux-x86_64.AppImage': bundle });
  try {
    assert.equal(
      buildManifest({ dir, tag: 'v0.1.24', publicKey, date: new Date() }),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses partial, unverifiable or keyless signed releases', () => {
  const files = signedRelease();
  delete files['Orchevia-macos-x86_64.app.tar.gz.sig'];
  let dir = releaseDir(files);
  try {
    assert.throws(
      () => buildManifest({ dir, tag: 'v0.1.24', publicKey, date: new Date() }),
      /missing for: Orchevia-macos-x86_64\.app\.tar\.gz/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  dir = releaseDir({ ...signedRelease(), 'Orchevia-macos-arm64.app.tar.gz': 'other' });
  try {
    assert.throws(
      () => buildManifest({ dir, tag: 'v0.1.24', publicKey, date: new Date() }),
      /does not verify/,
    );
    assert.throws(
      () => buildManifest({ dir, tag: 'v0.1.24', publicKey: '', date: new Date() }),
      /no updater public key/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the command line writes latest.json only for signed releases', () => {
  const dir = releaseDir({ 'Orchevia-linux-x86_64.deb': 'deb' });
  try {
    const run = spawnSync(
      process.execPath,
      ['scripts/updater-manifest.mjs', dir, 'v0.1.24'],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /installs from its downloads only/);
    assert.throws(() => readFileSync(join(dir, 'latest.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the app pins a minisign public key for its updates', () => {
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  // Emptying it would quietly turn in-place updates off for every copy.
  assert.equal(parsePublicKey(config.plugins.updater.pubkey).keyId.length, 8);
  assert.deepEqual(config.plugins.updater.endpoints, [
    'https://github.com/iazaran/orchevia/releases/latest/download/latest.json',
  ]);
});
