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
  MACOS_RESULT: 'success',
  RUST_CHANGED: 'true',
  DESKTOP_CHANGED: 'true',
  MACOS_CHANGED: 'true',
};

test('required result accepts intentional skips and rejects failures, cancellations, and missing gates', () => {
  assert.equal(execute(result, { env: passing }).status, 0);
  assert.equal(
    execute(result, {
      env: {
        ...passing,
        RUST_CHANGED: 'false',
        DESKTOP_CHANGED: 'false',
        MACOS_CHANGED: 'false',
        RUST_RESULT: 'skipped',
        DESKTOP_RESULT: 'skipped',
        MACOS_RESULT: 'skipped',
      },
    }).status,
    0,
  );
  for (const key of [
    'CHANGES_RESULT',
    'FRONTEND_RESULT',
    'RUST_RESULT',
    'DESKTOP_RESULT',
    'MACOS_RESULT',
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
  assert.notEqual(
    execute(result, { env: { ...passing, MACOS_CHANGED: '', MACOS_RESULT: 'skipped' } })
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

test('signed update files publish only as a complete set', () => {
  const updates = [
    'Orchevia-linux-x86_64.AppImage.sig',
    'Orchevia-macos-arm64.app.tar.gz',
    'Orchevia-macos-arm64.app.tar.gz.sig',
    'Orchevia-macos-x86_64.app.tar.gz',
    'Orchevia-macos-x86_64.app.tar.gz.sig',
  ];
  const dir = mkdtempSync(join(tmpdir(), 'orchevia-publish-'));
  const artifactDir = join(dir, 'release-artifacts');
  mkdirSync(artifactDir);
  try {
    for (const name of assets) writeFileSync(join(artifactDir, name), name);
    for (const name of updates.slice(0, 4)) writeFileSync(join(artifactDir, name), name);
    assert.notEqual(
      execute(checksums, { cwd: dir }).status,
      0,
      'a missing update signature must block publication',
    );
    writeFileSync(join(artifactDir, updates[4]), updates[4]);
    assert.equal(execute(checksums, { cwd: dir }).status, 0);
    const sums = readFileSync(join(artifactDir, 'SHA256SUMS'), 'utf8');
    assert.match(sums, /\.\/Orchevia-macos-arm64\.app\.tar\.gz\n/);
    assert.doesNotMatch(sums, /\.sig/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('signing without the public key of the app stops before building', () => {
  const build = runBlock(
    '.github/workflows/release.yml',
    'Build and package (capture bundler stdout and stderr)',
  );
  const dir = mkdtempSync(join(tmpdir(), 'orchevia-build-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  mkdirSync(join(dir, 'src-tauri'));
  // A stand-in pnpm records the arguments the real build would get.
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nprintf "%s\\n" "$@" > args\n', {
    mode: 0o755,
  });
  const run = (pubkey, key) => {
    writeFileSync(
      join(dir, 'src-tauri/tauri.conf.json'),
      JSON.stringify({ plugins: { updater: { pubkey } } }),
    );
    rmSync(join(dir, 'args'), { force: true });
    return execute(build, {
      cwd: dir,
      env: {
        PATH: `${bin}:${String(process.env.PATH)}`,
        RELEASE_BUNDLES: 'deb,appimage',
        RELEASE_TARGET: '',
        TAURI_SIGNING_PRIVATE_KEY: key,
      },
    });
  };
  try {
    let result = run('', 'secret');
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /no plugins\.updater\.pubkey/);
    assert.equal(run('', '').status, 0);
    assert.doesNotMatch(
      readFileSync(join(dir, 'args'), 'utf8'),
      /createUpdaterArtifacts/,
    );
    result = run('cHVibGlj', 'secret');
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(dir, 'args'), 'utf8'), /createUpdaterArtifacts":true/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const stage = runBlock('.github/workflows/release.yml', 'Stage artifacts');

function stagingFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'orchevia-stage-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const lipo = (archs) =>
    writeFileSync(join(bin, 'lipo'), `#!/bin/sh\necho '${archs}'\n`, { mode: 0o755 });
  return { dir, lipo, path: `${bin}:${String(process.env.PATH)}` };
}

test('macOS staging names the DMG by its target architecture and rejects any other binary', () => {
  const { dir, lipo, path } = stagingFixture();
  try {
    const bundle = join(dir, 'target/x86_64-apple-darwin/release/bundle');
    const executables = join(bundle, 'macos/Orchevia.app/Contents/MacOS');
    mkdirSync(executables, { recursive: true });
    writeFileSync(join(executables, 'orchevia'), 'binary', { mode: 0o755 });
    mkdirSync(join(bundle, 'dmg'));
    writeFileSync(join(bundle, 'dmg/Orchevia_0.1.17_x64.dmg'), 'intel dmg');
    const env = {
      PATH: path,
      RUNNER_OS: 'macOS',
      RELEASE_ARCH: 'x86_64',
      RELEASE_TARGET: 'x86_64-apple-darwin',
    };
    for (const archs of ['arm64', 'x86_64 arm64']) {
      lipo(archs);
      assert.notEqual(
        execute(stage, { cwd: dir, env }).status,
        0,
        `a ${archs} binary must not ship as the Intel DMG`,
      );
    }
    lipo('x86_64');
    assert.equal(execute(stage, { cwd: dir, env }).status, 0);
    assert.equal(
      readFileSync(join(dir, 'release-artifacts/Orchevia-macos-x86_64.dmg'), 'utf8'),
      'intel dmg',
    );
    // A signed update bundle ships beside the DMG, and never without its signature.
    writeFileSync(join(bundle, 'macos/Orchevia.app.tar.gz'), 'update');
    assert.notEqual(execute(stage, { cwd: dir, env }).status, 0);
    writeFileSync(join(bundle, 'macos/Orchevia.app.tar.gz.sig'), 'signature');
    assert.equal(execute(stage, { cwd: dir, env }).status, 0);
    for (const [name, content] of [
      ['Orchevia-macos-x86_64.app.tar.gz', 'update'],
      ['Orchevia-macos-x86_64.app.tar.gz.sig', 'signature'],
    ])
      assert.equal(readFileSync(join(dir, 'release-artifacts', name), 'utf8'), content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Linux staging requires both packages from the host bundle', () => {
  const { dir, path } = stagingFixture();
  try {
    const bundle = join(dir, 'target/release/bundle');
    mkdirSync(join(bundle, 'deb'), { recursive: true });
    mkdirSync(join(bundle, 'appimage'), { recursive: true });
    writeFileSync(join(bundle, 'deb/orchevia_0.1.17_amd64.deb'), 'deb');
    const env = {
      PATH: path,
      RUNNER_OS: 'Linux',
      RELEASE_ARCH: 'x86_64',
      RELEASE_TARGET: '',
    };
    assert.notEqual(
      execute(stage, { cwd: dir, env }).status,
      0,
      'a missing AppImage must block staging',
    );
    writeFileSync(join(bundle, 'appimage/orchevia_0.1.17_amd64.AppImage'), 'appimage');
    writeFileSync(join(bundle, 'appimage/orchevia_0.1.17_amd64.AppImage.sig'), 'sig');
    assert.equal(execute(stage, { cwd: dir, env }).status, 0);
    assert.equal(
      readFileSync(
        join(dir, 'release-artifacts/Orchevia-linux-x86_64.AppImage.sig'),
        'utf8',
      ),
      'sig',
    );
    for (const [name, content] of [
      ['Orchevia-linux-x86_64.deb', 'deb'],
      ['Orchevia-linux-x86_64.AppImage', 'appimage'],
    ])
      assert.equal(readFileSync(join(dir, 'release-artifacts', name), 'utf8'), content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function releaseMatrix() {
  const lines = readFileSync('.github/workflows/release.yml', 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trim() === 'include:');
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^ {10}- (\w+): (.*)$/.exec(line);
    const field = /^ {12}(\w+): (.*)$/.exec(line);
    if (item) entries.push({ [item[1]]: item[2] });
    else if (field && entries.length) entries[entries.length - 1][field[1]] = field[2];
    else if (line.trim() && !line.trim().startsWith('#')) break;
  }
  return entries;
}

test('macOS release builds keep the .app that staging inspects, for the right targets', () => {
  const mac = releaseMatrix().filter((entry) => entry.os?.startsWith('macos'));
  assert.deepEqual(
    mac.map(({ arch, target }) => [arch, target]),
    [
      ['arm64', 'aarch64-apple-darwin'],
      ['x86_64', 'x86_64-apple-darwin'],
    ],
  );
  // Requesting `dmg` alone makes Tauri delete the .app after packaging.
  for (const entry of mac)
    assert.deepEqual(entry.bundles.split(',').sort(), ['app', 'dmg']);
});

test('macOS apps are signed as a whole and checked before they ship', () => {
  // The linker's signature alone makes a downloaded app "damaged" (v0.1.20).
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  assert.equal(config.bundle.macOS.signingIdentity, '-');
  const release = readFileSync('.github/workflows/release.yml', 'utf8');
  const verify = release.indexOf('- name: Verify the macOS app');
  assert.ok(verify > release.indexOf('- name: Build and package'));
  assert.ok(verify < release.indexOf('- name: Stage artifacts'));
  assert.match(
    release.slice(verify, release.indexOf('- name: Stage artifacts')),
    /if: runner\.os == 'macOS'\n[\s\S]*\n\s+run: bash scripts\/verify-macos-app\.sh "target\/\$RELEASE_TARGET\/release\/bundle" --launch\n/,
  );
  // The notes give steps that still work on macOS 15 and later.
  assert.match(release, /\*\*Open Anyway\*\*/);
  assert.doesNotMatch(release, /right-click/i);
  // Pull requests that touch packaging run the same checks on Apple Silicon.
  assert.match(
    readFileSync('.github/workflows/ci.yml', 'utf8'),
    /if: needs\.changes\.outputs\.macos == 'true'\n\s+runs-on: macos-15\n[\s\S]*?run: bash scripts\/verify-macos-app\.sh target\/aarch64-apple-darwin\/release\/bundle --launch\n/,
  );
});
