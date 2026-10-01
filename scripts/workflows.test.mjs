import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Execute the workflow's real shell block so these checks exercise its behavior.
function runBlock(path, step) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${step}`);
  assert.notEqual(start, -1, `Missing workflow step: ${step}`);
  const run = lines.findIndex(
    (line, index) => index > start && line === '        run: |',
  );
  assert.notEqual(run, -1, `Missing shell block: ${step}`);
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}
const execute = (script, options = {}) =>
  spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
    encoding: 'utf8',
    ...options,
  });
const result = runBlock(
  '.github/workflows/ci.yml',
  'Require every applicable check to pass',
);
const passing = {
  CHANGES_RESULT: 'success',
  FRONTEND_RESULT: 'success',
  RUST_RESULT: 'success',
  DESKTOP_RESULT: 'success',
  RUST_CHANGED: 'true',
  DESKTOP_CHANGED: 'true',
};

test('required result accepts intentional skips and rejects failures, cancellations, and missing gates', () => {
  assert.equal(execute(result, { env: passing }).status, 0);
  assert.equal(
    execute(result, {
      env: {
        ...passing,
        RUST_CHANGED: 'false',
        DESKTOP_CHANGED: 'false',
        RUST_RESULT: 'skipped',
        DESKTOP_RESULT: 'skipped',
      },
    }).status,
    0,
  );
  for (const key of [
    'CHANGES_RESULT',
    'FRONTEND_RESULT',
    'RUST_RESULT',
    'DESKTOP_RESULT',
  ]) {
    for (const value of ['failure', 'cancelled', 'skipped'])
      assert.notEqual(
        execute(result, { env: { ...passing, [key]: value } }).status,
        0,
        `${key}=${value}`,
      );
  }
  assert.notEqual(
    execute(result, { env: { ...passing, RUST_CHANGED: '', RUST_RESULT: 'skipped' } })
      .status,
    0,
  );
});

const assets = [
  'Orchevia-linux-x86_64.deb',
  'Orchevia-linux-x86_64.AppImage',
  'Orchevia-macos-arm64.dmg',
  'Orchevia-macos-x86_64.dmg',
];
const checksums = runBlock('.github/workflows/release.yml', 'Checksums');

test('publication requires all four nonempty installers and produces their exact checksums', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchevia-publish-'));
  const artifactDir = join(dir, 'release-artifacts');
  mkdirSync(artifactDir);
  try {
    for (const name of assets.slice(0, 3)) writeFileSync(join(artifactDir, name), name);
    assert.notEqual(
      execute(checksums, { cwd: dir }).status,
      0,
      'a missing Intel DMG must block publication',
    );
    writeFileSync(join(artifactDir, assets[3]), '');
    assert.notEqual(
      execute(checksums, { cwd: dir }).status,
      0,
      'an empty DMG must block publication',
    );
    writeFileSync(join(artifactDir, assets[3]), assets[3]);
    assert.equal(execute(checksums, { cwd: dir }).status, 0);
    const sums = readFileSync(join(artifactDir, 'SHA256SUMS'), 'utf8');
    for (const name of assets)
      assert.ok(
        sums.includes(`${createHash('sha256').update(name).digest('hex')}  ./${name}`),
      );
    rmSync(join(artifactDir, 'SHA256SUMS'));
    writeFileSync(join(artifactDir, 'unexpected.rpm'), 'extra');
    assert.notEqual(
      execute(checksums, { cwd: dir }).status,
      0,
      'unexpected release contents must be rejected',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
