import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function classifyChanges(paths) {
  const changes = {
    frontend: false,
    rust: false,
    desktop: false,
    site: false,
    workflows: false,
    macos: false,
  };
  for (const path of paths) {
    if (
      path === '.github/workflows/pages.yml' ||
      path === 'scripts/build-apt-repo.sh' ||
      (path.startsWith('docs/') && !path.endsWith('.md'))
    ) {
      // The site deployment also builds the apt repository.
      changes.site = true;
      if (!path.startsWith('docs/')) changes.workflows = true;
    } else if (
      [
        '.github/workflows/ci.yml',
        '.github/workflows/release.yml',
        'scripts/verify-macos-app.sh',
      ].includes(path)
    ) {
      // Lint workflows and exercise delivery scripts without recompiling unchanged
      // source, but package for macOS: both workflows build and verify the DMG.
      changes.workflows = changes.macos = true;
    } else if (
      path === '.github/workflows/cli-canary.yml' ||
      path === 'scripts/verify-linux-app.sh'
    ) {
      // The weekly canary and the release's Linux launch check: actionlint and the
      // delivery tests cover them; neither compiles nor packages in CI.
      changes.workflows = true;
    } else if (path.startsWith('crates/') || path.startsWith('src-tauri/')) {
      changes.rust = changes.desktop = true;
      // Configuration, icons and manifests shape the signed bundle; Rust source does not.
      // The macOS job also runs the process-tree cleanup tests, so the process-group
      // code itself is a macOS input too.
      if (
        (path.startsWith('src-tauri/') &&
          !path.startsWith('src-tauri/src/') &&
          !path.startsWith('src-tauri/tests/')) ||
        path === 'crates/core/src/process.rs'
      )
        changes.macos = true;
    } else if (
      path.startsWith('src/') ||
      path.startsWith('public/') ||
      [
        'index.html',
        'vite.config.ts',
        'vitest.config.ts',
        'eslint.config.js',
        'tsconfig.json',
      ].includes(path)
    ) {
      changes.frontend = true;
    } else if (
      path.endsWith('.md') ||
      path === 'LICENSE' ||
      path === '.github/dependabot.yml' ||
      path.startsWith('.github/ISSUE_TEMPLATE/')
    ) {
      // Formatting still runs on every PR; prose alone needs no compiler.
    } else {
      // Locks, build inputs, new workflows, and unfamiliar files fail safe.
      changes.frontend = changes.rust = changes.desktop = true;
      changes.workflows = changes.macos = true;
    }
  }
  return changes;
}

export function changedPaths(
  eventName,
  event,
  git = (args) => execFileSync('git', args, { encoding: 'utf8' }),
) {
  let base;
  let head;
  if (eventName === 'pull_request') {
    base = event.pull_request.base.sha;
    head = event.pull_request.head.sha;
  } else if (eventName === 'push') {
    base = event.before;
    head = event.after;
  } else {
    throw new Error(`Unsupported change event: ${eventName}`);
  }
  if (
    ![base, head].every((sha) => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha))
  ) {
    throw new Error('Expected full commit SHAs in the GitHub event');
  }
  const args = /^0{40}$/.test(base)
    ? ['ls-files', '-z']
    : [
        'diff',
        '--no-renames',
        '--name-only',
        '-z',
        `${base}${eventName === 'pull_request' ? '...' : '..'}${head}`,
      ];
  return git(args).split('\0').filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const changes = classifyChanges(changedPaths(process.env.GITHUB_EVENT_NAME, event));
  for (const [name, changed] of Object.entries(changes)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(changed)}\n`);
  }
  console.log(changes);
}
