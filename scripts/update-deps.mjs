// Refresh dependencies within their declared ranges, as part of preparing a
// release, then list what still needs a deliberate (major) upgrade.
import { spawnSync } from 'node:child_process';

function run(command, args, allowFailure = false) {
  console.log(`\n$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) process.exit(result.status ?? 1);
}

run('pnpm', ['update']);
// --verbose also lists crates held back by the ranges in Cargo.toml.
run('cargo', ['update', '--verbose']);
// Tauri npm packages and crates must still share major.minor.
run(process.execPath, ['scripts/check-version.mjs']);
console.log('\nNot updated automatically (outside the declared ranges):');
run('pnpm', ['outdated'], true);
