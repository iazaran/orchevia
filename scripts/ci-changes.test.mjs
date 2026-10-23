import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyChanges } from './ci-changes.mjs';

const none = {
  frontend: false,
  rust: false,
  desktop: false,
  site: false,
  workflows: false,
  macos: false,
};

test('documentation edits avoid compilers but site edits request deployment', () => {
  assert.deepEqual(classifyChanges(['README.md', 'docs/development.md']), none);
  assert.deepEqual(classifyChanges(['docs/index.html']), { ...none, site: true });
  assert.deepEqual(classifyChanges(['docs/favicon.png']), { ...none, site: true });
});

test('frontend edits run frontend validation without native packaging', () => {
  for (const path of ['src/App.tsx', 'public/icon.svg', 'index.html', 'vite.config.ts']) {
    assert.deepEqual(classifyChanges([path]), { ...none, frontend: true });
  }
});

test('Rust and shell edits validate core and desktop', () => {
  for (const path of [
    'crates/core/src/engine.rs',
    'src-tauri/src/main.rs',
    'src-tauri/tests/commands.rs',
  ]) {
    assert.deepEqual(classifyChanges([path]), { ...none, rust: true, desktop: true });
  }
});

test('bundle inputs also package and verify the macOS app', () => {
  for (const path of [
    'src-tauri/icons/icon.icns',
    'src-tauri/Cargo.toml',
    'src-tauri/build.rs',
  ]) {
    assert.deepEqual(classifyChanges([path]), {
      ...none,
      rust: true,
      desktop: true,
      macos: true,
    });
  }
  // A later Rust source path must not clear an earlier bundle input.
  assert.equal(
    classifyChanges(['src-tauri/tauri.conf.json', 'crates/core/src/lib.rs']).macos,
    true,
  );
});

test('shared contracts, locks, and delivery scripts validate both stacks', () => {
  for (const path of [
    'Cargo.lock',
    'Cargo.toml',
    'package.json',
    'pnpm-lock.yaml',
    '.cargo/config.toml',
    'scripts/check-version.mjs',
  ]) {
    assert.deepEqual(classifyChanges([path]), {
      ...none,
      frontend: true,
      rust: true,
      desktop: true,
      workflows: true,
      macos: true,
    });
  }
});

test('Pages workflow changes validate the site; dependency scheduling avoids compilers', () => {
  for (const path of ['.github/workflows/pages.yml', 'scripts/build-apt-repo.sh']) {
    assert.deepEqual(classifyChanges([path]), { ...none, site: true, workflows: true });
  }
  assert.deepEqual(classifyChanges(['.github/dependabot.yml']), none);
});

test('known workflow edits request linting and macOS packaging without other compilers', () => {
  for (const path of [
    '.github/workflows/ci.yml',
    '.github/workflows/release.yml',
    'scripts/verify-macos-app.sh',
  ]) {
    assert.deepEqual(classifyChanges([path]), { ...none, workflows: true, macos: true });
  }
  assert.deepEqual(classifyChanges(['.github/workflows/new.yml']), {
    ...none,
    frontend: true,
    rust: true,
    desktop: true,
    workflows: true,
    macos: true,
  });
});

test('unknown inputs fail safe and changed sets combine their requirements', () => {
  assert.deepEqual(classifyChanges(['new-build-input']), {
    ...none,
    frontend: true,
    rust: true,
    desktop: true,
    workflows: true,
    macos: true,
  });
  assert.deepEqual(classifyChanges([]), none);
  assert.deepEqual(
    classifyChanges(['src/App.tsx', 'crates/core/src/lib.rs', 'docs/index.html']),
    { ...none, frontend: true, rust: true, desktop: true, site: true },
  );
});

test('desktop config JSON stays in the native validation scope', () => {
  assert.deepEqual(classifyChanges(['src-tauri/tauri.conf.json']), {
    ...none,
    rust: true,
    desktop: true,
    macos: true,
  });
});

test('event comparison uses PR merge-base and all commits in a main push', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, renameSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { changedPaths } = await import('./ci-changes.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'orchevia-changes-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  const commit = () => {
    git(['add', '.']);
    git([
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-qm',
      'fixture',
    ]);
    return git(['rev-parse', 'HEAD']).trim();
  };
  try {
    git(['init', '-q', '-b', 'main']);
    writeFileSync(join(dir, 'original.txt'), 'original');
    const base = commit();
    git(['checkout', '-qb', 'feature']);
    renameSync(join(dir, 'original.txt'), join(dir, 'renamed.txt'));
    const head = commit();
    git(['checkout', '-q', 'main']);
    writeFileSync(join(dir, 'base-only.txt'), 'base change');
    const updatedBase = commit();
    assert.deepEqual(
      changedPaths(
        'pull_request',
        { pull_request: { base: { sha: updatedBase }, head: { sha: head } } },
        git,
      ),
      ['original.txt', 'renamed.txt'],
    );
    git(['checkout', '-q', 'feature']);
    writeFileSync(join(dir, 'second.txt'), 'another commit');
    const pushedHead = commit();
    assert.deepEqual(changedPaths('push', { before: base, after: pushedHead }, git), [
      'original.txt',
      'renamed.txt',
      'second.txt',
    ]);
    assert.deepEqual(
      changedPaths('push', { before: '0'.repeat(40), after: pushedHead }, git),
      ['renamed.txt', 'second.txt'],
    );
    assert.throws(
      () => changedPaths('push', { before: '--bad-ref', after: head }, git),
      /full commit SHAs/,
    );
    assert.throws(() => changedPaths('workflow_dispatch', {}, git), /Unsupported/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
