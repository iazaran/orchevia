import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'orchevia-version-'));
  try {
    for (const path of ['scripts', 'src-tauri', 'crates/core'])
      mkdirSync(join(dir, path), { recursive: true });
    for (const path of [
      'scripts/check-version.mjs',
      'package.json',
      'src-tauri/tauri.conf.json',
      'src-tauri/Cargo.toml',
      'crates/core/Cargo.toml',
      'Cargo.lock',
      'CHANGELOG.md',
    ])
      cpSync(path, join(dir, path));
    run(dir, (tag) =>
      spawnSync(
        process.execPath,
        [join(dir, 'scripts/check-version.mjs'), ...(tag ? [tag] : [])],
        { encoding: 'utf8' },
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('matching manifests and lockfile accept only the matching release tag', () => {
  fixture((_dir, check) => {
    assert.equal(check(`v${version}`).status, 0);
    assert.notEqual(check('v99.0.0').status, 0);
  });
});

test('version drift in an application manifest is rejected', () => {
  fixture((dir, check) => {
    const path = join(dir, 'src-tauri/tauri.conf.json');
    const config = JSON.parse(readFileSync(path, 'utf8'));
    config.version = '99.0.0';
    writeFileSync(path, JSON.stringify(config));
    assert.notEqual(check().status, 0);
  });
});

test('version drift in either workspace lockfile package is rejected', () => {
  for (const name of ['orchevia', 'orchevia-core']) {
    fixture((dir, check) => {
      const path = join(dir, 'Cargo.lock');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          `name = "${name}"\nversion = "${version}"`,
          `name = "${name}"\nversion = "99.0.0"`,
        ),
      );
      assert.notEqual(check().status, 0, `${name} must match the manifests`);
    });
  }
});
