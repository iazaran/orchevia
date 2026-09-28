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
for (const [path, value] of Object.entries(versions)) {
  if (value !== version)
    throw new Error(`${path}: ${String(value)} must match ${version}`);
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
