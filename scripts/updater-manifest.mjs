// Write `latest.json` for the in-place updater from the signed update bundles
// a release built, after checking every signature against the public key the
// app carries. All platforms or none: without the signing secret a release
// ships installers only and the app keeps offering the download.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'iazaran/orchevia';

/** Updater platform key → release asset. Only the AppImage key is offered on
 * Linux: Debian packages update through apt, never by replacing files. */
export const UPDATE_BUNDLES = {
  'linux-x86_64-appimage': 'Orchevia-linux-x86_64.AppImage',
  'darwin-aarch64': 'Orchevia-macos-arm64.app.tar.gz',
  'darwin-x86_64': 'Orchevia-macos-x86_64.app.tar.gz',
};

const decode = (base64, what) => {
  const text = Buffer.from(base64.trim(), 'base64').toString('utf8');
  if (text.length === 0) throw new Error(`${what} is empty.`);
  return text.split('\n');
};

/** Minisign public key as Tauri stores it (base64 of the key file). */
export function parsePublicKey(base64) {
  const [, line] = decode(base64, 'The update public key');
  const bytes = Buffer.from(line ?? '', 'base64');
  if (bytes.length !== 42 || bytes.subarray(0, 2).toString() !== 'Ed')
    throw new Error('The update public key is not a minisign Ed25519 key.');
  return {
    keyId: bytes.subarray(2, 10),
    key: createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: bytes.subarray(10).toString('base64url') },
      format: 'jwk',
    }),
  };
}

/** Whether `signature` (base64 of a minisign signature file, as Tauri writes
 * `.sig` files) signs `file` with `publicKey`, trusted comment included. */
export function verifySignature(file, signature, publicKey) {
  const { keyId, key } = parsePublicKey(publicKey);
  const [, sigLine, trusted, globalLine] = decode(signature, 'The signature');
  const sig = Buffer.from(sigLine ?? '', 'base64');
  const algorithm = sig.subarray(0, 2).toString();
  if (sig.length !== 74 || (algorithm !== 'ED' && algorithm !== 'Ed'))
    throw new Error('The signature is not a minisign Ed25519 signature.');
  if (!sig.subarray(2, 10).equals(keyId)) return false;
  const message =
    algorithm === 'ED' ? createHash('blake2b512').update(file).digest() : file;
  const prefix = 'trusted comment: ';
  if (trusted === undefined || !trusted.startsWith(prefix)) return false;
  const signed = sig.subarray(10);
  const comment = Buffer.from(trusted.slice(prefix.length));
  return (
    verify(null, message, key, signed) &&
    verify(
      null,
      Buffer.concat([signed, comment]),
      key,
      Buffer.from(globalLine ?? '', 'base64'),
    )
  );
}

/** The manifest, or `null` when the release has no signed update bundles. */
export function buildManifest({ dir, tag, publicKey, date }) {
  const signed = Object.entries(UPDATE_BUNDLES).map(([platform, asset]) => ({
    platform,
    asset,
    hasSig: existsSync(join(dir, `${asset}.sig`)),
  }));
  if (signed.every((entry) => !entry.hasSig)) return null;
  const missing = signed.filter((entry) => !entry.hasSig).map((entry) => entry.asset);
  if (missing.length > 0)
    throw new Error(`Signed update bundles are missing for: ${missing.join(', ')}.`);
  if (publicKey.trim() === '')
    throw new Error(
      'Update bundles are signed, but src-tauri/tauri.conf.json has no updater public key.',
    );
  const version = tag.replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${tag} is not a release tag.`);
  const platforms = {};
  for (const { platform, asset } of signed) {
    const signature = readFileSync(join(dir, `${asset}.sig`), 'utf8').trim();
    if (!verifySignature(readFileSync(join(dir, asset)), signature, publicKey))
      throw new Error(
        `${asset}.sig does not verify with the app's update public key; check the signing secret.`,
      );
    platforms[platform] = {
      signature,
      url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${asset}`,
    };
  }
  return {
    version,
    notes: `https://github.com/${REPOSITORY}/releases/tag/${tag}`,
    pub_date: date.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    platforms,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [dir, tag] = process.argv.slice(2);
  if (dir === undefined || tag === undefined)
    throw new Error('Usage: node scripts/updater-manifest.mjs <artifact-dir> <tag>');
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const manifest = buildManifest({
    dir,
    tag,
    publicKey: String(config.plugins?.updater?.pubkey ?? ''),
    date: new Date(),
  });
  if (manifest === null) {
    console.log(
      'No signed update bundles: this release installs from its downloads only.',
    );
  } else {
    writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Wrote latest.json for ${Object.keys(manifest.platforms).join(', ')}.`);
  }
}
