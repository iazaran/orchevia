import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// codesign --display output for the published v0.1.20 arm64 app, which macOS
// reported as damaged: the linker's signature only, nothing over the bundle.
const linkerSigned = `Executable=/Volumes/Orchevia/Orchevia.app/Contents/MacOS/orchevia
Identifier=orchevia-89ee4ed25d7fe158
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=139672 flags=0x20002(adhoc,linker-signed) hashes=4361+0 location=embedded
CDHash=96329bccf49ef473c0d49d14a3287ed11736e760
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
Sealed Resources=none
Internal requirements=none
`;
const sealed = (cdhash = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678') =>
  `Executable=/Volumes/Orchevia/Orchevia.app/Contents/MacOS/orchevia
Identifier=dev.orchevia.app
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=139905 flags=0x10002(adhoc,runtime) hashes=4361+7 location=embedded
CDHash=${cdhash}
Signature=adhoc
Info.plist entries=17
TeamIdentifier=not set
Runtime Version=15.5.0
Sealed Resources version=2 rules=13 files=1
Internal requirements count=0 size=12
`;
// Launch behaviours of the fake executable. It records its PID, and opens its
// database where Orchevia does on macOS, under the HOME it was started with.
const data =
  'echo $$ > "$FAKE_PIDFILE"; data="$HOME/Library/Application Support/dev.orchevia.app"';
const app = {
  stays: `${data}; mkdir -p "$data" && echo db > "$data/orchevia.db" && exec sleep 30`,
  hangs: `${data}; exec sleep 30`,
  crashes: `${data}; echo "dyld: missing symbol" >&2; exit 1`,
  crashesAfterDatabase: `${data}; mkdir -p "$data" && echo db > "$data/orchevia.db" && exit 1`,
};

const tool = (dir, name, body) =>
  writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });

// Stand-ins for the macOS tools. Each fake .app carries the signature codesign
// reports for it, and a fake .dmg names the folder its volume shows.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'orchevia-macos-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  tool(
    bin,
    'codesign',
    `target=\${!#}
printf 'codesign %s\\n' "$*" >> "$FAKE_LOG"
if [ "$1" = --verify ]; then
  [ -f "$target/Contents/verify-error" ] || exit 0
  echo "$target: $(cat "$target/Contents/verify-error")" >&2; exit 1
fi
cat "$target/Contents/signature" >&2`,
  );
  tool(
    bin,
    'plutil',
    'value=$(sed -n "s/^$2=//p" "$6"); [ -n "$value" ] && echo "$value"',
  );
  tool(
    bin,
    'hdiutil',
    `printf 'hdiutil %s\\n' "$*" >> "$FAKE_LOG"
case $1 in
  verify) exit 0 ;;
  attach) cp -R "$(cat "\${!#}")/." "\${@: -2:1}/" ;;
  detach) find "\${!#}" -mindepth 1 -delete ;;
esac`,
  );
  tool(bin, 'lipo', 'echo "$FAKE_APP_ARCH"');
  tool(bin, 'uname', 'echo "$FAKE_HOST_ARCH"');
  tool(bin, 'arch', '[ "$FAKE_ROSETTA" = yes ]');
  tool(bin, 'ditto', 'cp -R "$1" "$2"');
  const home = join(dir, 'home');
  const temp = join(dir, 'tmp');
  mkdirSync(home);
  mkdirSync(temp);

  const makeApp = (path, signature, launch = app.stays) => {
    mkdirSync(join(path, 'Contents/MacOS'), { recursive: true });
    writeFileSync(
      join(path, 'Contents/Info.plist'),
      'CFBundleIdentifier=dev.orchevia.app\nCFBundleExecutable=orchevia\n',
    );
    writeFileSync(join(path, 'Contents/signature'), signature);
    tool(join(path, 'Contents/MacOS'), 'orchevia', launch);
  };
  const bundle = join(dir, 'bundle');
  const built = join(bundle, 'macos/Orchevia.app');
  const volume = join(dir, 'volume');
  mkdirSync(join(bundle, 'dmg'), { recursive: true });
  writeFileSync(join(bundle, 'dmg/Orchevia_0.1.21_aarch64.dmg'), volume);

  const run = (args = [], env = {}) =>
    spawnSync('bash', [resolve('scripts/verify-macos-app.sh'), bundle, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${String(process.env.PATH)}`,
        HOME: home,
        TMPDIR: temp,
        FAKE_LOG: join(dir, 'commands'),
        FAKE_PIDFILE: join(dir, 'app.pid'),
        FAKE_APP_ARCH: 'arm64',
        FAKE_HOST_ARCH: 'arm64',
        FAKE_ROSETTA: 'no',
        VERIFY_SETTLE_SECONDS: '1',
        VERIFY_STARTUP_SECONDS: '2',
        ...env,
      },
    });
  // The same app in the build folder and in the DMG, unless a test changes one.
  const ship = (signature, launch) => {
    rmSync(built, { recursive: true, force: true });
    rmSync(volume, { recursive: true, force: true });
    makeApp(built, signature, launch);
    cpSync(built, join(volume, 'Orchevia.app'), { recursive: true });
    rmSync(join(dir, 'app.pid'), { force: true });
    rmSync(join(dir, 'commands'), { force: true });
  };
  const commands = () => readFileSync(join(dir, 'commands'), 'utf8');
  // The EXIT trap detaches the image and removes its working folder.
  const leftovers = () => readdirSync(temp);
  // Whether the last launched fake app still runs (a zombie counts as gone).
  const appRunning = () => {
    const pid = readFileSync(join(dir, 'app.pid'), 'utf8').trim();
    const state = spawnSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' });
    return state.status === 0 && !state.stdout.trim().startsWith('Z');
  };
  return {
    dir,
    bundle,
    built,
    volume,
    home,
    run,
    ship,
    appRunning,
    commands,
    leftovers,
  };
}

test('refuses the linker-only signature that macOS reported as damaged', () => {
  const { dir, built, run, ship } = fixture();
  try {
    ship(linkerSigned);
    writeFileSync(
      join(built, 'Contents/verify-error'),
      'code has no resources but signature indicates they must be present',
    );
    let result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /code has no resources/);
    // The signature details alone refuse it too, whatever codesign --verify says.
    rmSync(join(built, 'Contents/verify-error'));
    result = run();
    assert.notEqual(result.status, 0);
    // Every missing part is named, not just the last one found.
    assert.match(
      result.stderr,
      /it is not signed as dev\.orchevia\.app; Info\.plist is not bound; resources are not sealed; only the linker signed the executable, so macOS would report a download as damaged/,
    );
    for (const [line, reason] of [
      ['Info.plist entries=17', /Info\.plist is not bound/],
      ['Sealed Resources version=2 rules=13 files=1', /resources are not sealed/],
      ['Identifier=dev.orchevia.app', /not signed as dev\.orchevia\.app/],
    ]) {
      ship(sealed().replace(`${line}\n`, ''));
      result = run();
      assert.notEqual(result.status, 0, line);
      assert.match(result.stderr, reason);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed codesign --verify blocks shipping even when the details look sealed', () => {
  const { dir, built, volume, run, ship } = fixture();
  try {
    for (const copy of [built, join(volume, 'Orchevia.app')]) {
      ship(sealed());
      writeFileSync(
        join(copy, 'Contents/verify-error'),
        'a sealed resource is missing or invalid',
      );
      const result = run();
      assert.notEqual(result.status, 0, copy);
      assert.match(result.stderr, /a sealed resource is missing or invalid/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('accepts a bundle signed as a whole only when the DMG holds the same app', () => {
  const { dir, bundle, volume, run, ship, commands, leftovers } = fixture();
  try {
    ship(sealed());
    let result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Signed bundle: .*\(a1b2c3d4e5f6/);
    assert.match(result.stdout, /DMG copy matches/);
    // Both copies get the strict, nested verification, and the image is detached.
    assert.equal(
      commands().match(/^codesign --verify --deep --strict --verbose=2 /gm)?.length,
      2,
    );
    assert.match(commands(), /^hdiutil attach -quiet -readonly -nobrowse /m);
    assert.match(commands(), /^hdiutil detach /m);
    assert.deepEqual(leftovers(), []);
    writeFileSync(join(volume, 'Orchevia.app/Contents/signature'), sealed('ffff0000'));
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /holds another signature \(ffff0000\)/);
    assert.match(commands(), /^hdiutil detach /m);
    assert.deepEqual(leftovers(), [], 'a failed check cleans up too');
    for (const extra of [['--lunch'], ['--launch', 'more']]) {
      result = run(extra);
      assert.equal(result.status, 2, extra.join(' '));
      assert.match(
        result.stderr,
        /usage: verify-macos-app\.sh <bundle-dir> \[--launch\]/,
      );
    }
    for (const args of [[], ['']]) {
      result = spawnSync('bash', [resolve('scripts/verify-macos-app.sh'), ...args], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 2, 'a missing bundle folder is a usage error too');
      assert.match(
        result.stderr,
        /usage: verify-macos-app\.sh <bundle-dir> \[--launch\]/,
      );
    }
    ship(sealed());
    rmSync(join(bundle, 'dmg'), { recursive: true });
    result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected an \.app .* and a \.dmg/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('launches the DMG copy and requires it to keep running with its database', () => {
  const { dir, home, run, ship, appRunning, leftovers } = fixture();
  try {
    ship(sealed(), app.stays);
    let result = run(['--launch']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Launched from the DMG and opened its database/);
    assert.equal(appRunning(), false, 'the launched app is stopped afterwards');
    // It ran with an empty home folder: the caller's data is never touched.
    assert.equal(existsSync(join(home, 'Library')), false);
    for (const launch of [app.crashes, app.crashesAfterDatabase, app.hangs]) {
      ship(sealed(), launch);
      result = run(['--launch']);
      assert.notEqual(result.status, 0, launch);
      assert.match(result.stderr, /did not keep running with its database open/);
    }
    assert.equal(appRunning(), false, 'a failed launch check stops the app too');
    assert.deepEqual(leftovers(), [], 'and still detaches and cleans up');
    // A database left by an earlier run cannot pass for an app that hangs.
    const stale = join(home, 'Library/Application Support/dev.orchevia.app');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'orchevia.db'), 'old');
    ship(sealed(), app.hangs);
    assert.notEqual(run(['--launch']).status, 0);
    ship(sealed(), app.crashes);
    assert.match(run(['--launch']).stderr, /dyld: missing symbol/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('launches an Intel build under Rosetta and skips one this Mac cannot run', () => {
  const { dir, run, ship } = fixture();
  try {
    ship(sealed(), app.crashes);
    const intel = { FAKE_APP_ARCH: 'x86_64' };
    let result = run(['--launch'], intel);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Launch skipped: this Mac is arm64 and cannot run the x86_64/,
    );
    result = run(['--launch'], { ...intel, FAKE_ROSETTA: 'yes' });
    assert.notEqual(result.status, 0, 'with Rosetta the Intel app must really launch');
    ship(sealed(), app.stays);
    result = run(['--launch'], { ...intel, FAKE_ROSETTA: 'yes' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Launched from the DMG/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
