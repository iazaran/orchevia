import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const version = JSON.parse(read('package.json')).version;
const versions = {
  'src-tauri/tauri.conf.json': JSON.parse(read('src-tauri/tauri.conf.json')).version,
  'src-tauri/Cargo.toml': /^version = "([^"]+)"/m.exec(read('src-tauri/Cargo.toml'))?.[1],
  'crates/core/Cargo.toml': /^version = "([^"]+)"/m.exec(
    read('crates/core/Cargo.toml'),
  )?.[1],
};
const lockedPackages = read('Cargo.lock').split('[[package]]');
for (const name of ['orchevia', 'orchevia-core']) {
  const locked = lockedPackages.find((entry) => entry.includes(`\nname = "${name}"\n`));
  versions[`Cargo.lock (${name})`] = /^version = "([^"]+)"/m.exec(locked ?? '')?.[1];
}
for (const [path, value] of Object.entries(versions)) {
  if (value !== version)
    throw new Error(`${path}: ${String(value)} must match ${version}`);
}
// Tauri refuses to build when an npm package and its Rust crate differ in
// major.minor, and automated updates can move one side without the other.
const npmLocked = (name) =>
  new RegExp(`^  '${name.replace(/[/.]/g, '\\$&')}@(\\d+\\.\\d+)\\.\\d+':`, 'm').exec(
    read('pnpm-lock.yaml'),
  )?.[1];
const crateLocked = (name) =>
  /^version = "(\d+\.\d+)\.\d+"/m.exec(
    lockedPackages.find((entry) => entry.includes(`\nname = "${name}"\n`)) ?? '',
  )?.[1];
const manifest = JSON.parse(read('package.json'));
const pairs = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
  .map((name) =>
    name === '@tauri-apps/api'
      ? [name, 'tauri']
      : name.startsWith('@tauri-apps/plugin-')
        ? [name, `tauri-plugin-${name.slice('@tauri-apps/plugin-'.length)}`]
        : null,
  )
  .filter((pair) => pair !== null);
for (const [npm, crate] of pairs) {
  const [npmVersion, crateVersion] = [npmLocked(npm), crateLocked(crate)];
  if (npmVersion === undefined || npmVersion !== crateVersion)
    throw new Error(
      `${npm} ${String(npmVersion)} and ${crate} ${String(crateVersion)} must share major.minor`,
    );
}
if (!read('CHANGELOG.md').includes(`## [${version}] - `)) {
  throw new Error(`CHANGELOG.md needs a dated entry for ${version}`);
}
const tag = process.argv[2];
if (tag !== undefined && tag !== `v${version}`) {
  throw new Error(`Release tag ${tag} must match v${version}`);
}
console.log(
  `Application versions match ${version}${tag === undefined ? '' : ` (${tag})`}`,
);
