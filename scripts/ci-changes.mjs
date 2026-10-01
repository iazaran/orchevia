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
  };
  for (const path of paths) {
    if (
      path === '.github/workflows/pages.yml' ||
      (path.startsWith('docs/') && !path.endsWith('.md'))
    ) {
      changes.site = true;
      if (path === '.github/workflows/pages.yml') changes.workflows = true;
    } else if (
      ['.github/workflows/ci.yml', '.github/workflows/release.yml'].includes(path)
    ) {
      // Lint workflows and exercise delivery scripts without recompiling unchanged source.
      changes.workflows = true;
    } else if (path.startsWith('crates/') || path.startsWith('src-tauri/')) {
      changes.rust = changes.desktop = true;
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
      changes.workflows = true;
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
