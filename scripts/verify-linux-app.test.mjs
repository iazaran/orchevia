import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// The script starts each app with setsid, which only Linux provides.
const linux = { skip: process.platform !== 'linux' };

const tool = (path, body) =>
  writeFileSync(path, `#!/bin/bash\n${body}\n`, { mode: 0o755 });

// Fixture: a Tauri bundle folder whose .deb and AppImage hold fake apps, with
// stand-ins for Xvfb and dpkg-deb. The apps run with a cleared environment, so
// they report to files named in their own text.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'orchevia-linux-'));
  const bin = join(dir, 'bin');
  const temp = join(dir, 'tmp');
  const home = join(dir, 'home');
  const reports = join(dir, 'reports');
  for (const path of [bin, temp, home, reports]) mkdirSync(path);
  tool(
    join(bin, 'Xvfb'),
    `printf 'Xvfb %s\\n' "$*" >> "$FAKE_LOG"
if [ "$FAKE_XVFB" = fails ]; then echo 'Fatal server error: no screens' >&2; exit 1; fi
echo 99 >&3
exec sleep 30`,
  );
  tool(
    join(bin, 'dpkg-deb'),
    `printf 'dpkg-deb %s\\n' "$*" >> "$FAKE_LOG"
[ "$1" = -x ] && cp -R "$(cat "$2")/." "$3/"`,
  );

  // Each fake app records its environment and process ids, and leaves a
  // helper running in its process group, as WebKit's processes would.
  const report = (name) =>
    `env > ${reports}/${name}.env; echo $$ >> ${reports}/${name}.pids
sleep 30 & echo $! >> ${reports}/${name}.pids
data="$HOME/.local/share/dev.orchevia.app"`;
  const behaviours = {
    stays: (name) =>
      `${report(name)}; mkdir -p "$data" && echo db > "$data/orchevia.db" && exec sleep 30`,
    hangs: (name) => `${report(name)}; exec sleep 30`,
    crashes: (name) =>
      `${report(name)}; echo "orchevia: error while loading shared libraries: libwebkit2gtk-4.1.so.0" >&2; exit 127`,
    crashesAfterDatabase: (name) =>
      `${report(name)}; mkdir -p "$data" && echo db > "$data/orchevia.db" && exit 1`,
  };

  const bundle = join(dir, 'bundle');
  const debRoot = join(dir, 'deb-root');
  const appImage = join(bundle, 'appimage/Orchevia_0.1.24_amd64.AppImage');
  const ship = ({
    deb = 'stays',
    appimage = 'stays',
    exec = 'orchevia',
    entry = true,
  } = {}) => {
    for (const path of [bundle, debRoot, reports])
      rmSync(path, { recursive: true, force: true });
    for (const path of [
      join(bundle, 'deb'),
      join(bundle, 'appimage'),
      join(debRoot, 'usr/bin'),
      join(debRoot, 'usr/share/applications'),
      reports,
    ])
      mkdirSync(path, { recursive: true });
    writeFileSync(join(bundle, 'deb/Orchevia_0.1.24_amd64.deb'), debRoot);
    tool(join(debRoot, 'usr/bin/orchevia'), behaviours[deb]('deb'));
    if (entry)
      writeFileSync(
        join(debRoot, 'usr/share/applications/Orchevia.desktop'),
        `[Desktop Entry]\nName=Orchevia\nExec=${exec}\nType=Application\n`,
      );
    tool(appImage, behaviours[appimage]('appimage'));
    rmSync(join(dir, 'commands'), { force: true });
  };

  const run = (args = [bundle], env = {}) =>
    spawnSync('bash', [resolve('scripts/verify-linux-app.sh'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${String(process.env.PATH)}`,
        HOME: home,
        TMPDIR: temp,
        XDG_DATA_HOME: join(home, 'xdg-data'),
        FAKE_LOG: join(dir, 'commands'),
        VERIFY_SETTLE_SECONDS: '1',
        VERIFY_STARTUP_SECONDS: '2',
        ...env,
      },
    });
  const read = (name) => readFileSync(join(reports, name), 'utf8');
  const launched = (name) => existsSync(join(reports, `${name}.env`));
  // Every process a fake app started has stopped (a zombie counts as gone).
  const stopped = (name) =>
    read(`${name}.pids`)
      .trim()
      .split('\n')
      .every((pid) => {
        const state = spawnSync('ps', ['-o', 'stat=', '-p', pid], { encoding: 'utf8' });
        return state.status !== 0 || state.stdout.trim().startsWith('Z');
      });
  const commands = () => readFileSync(join(dir, 'commands'), 'utf8');
  // The EXIT trap stops Xvfb and removes the working folder.
  const leftovers = () => readdirSync(temp);
  return { dir, bundle, home, run, ship, read, launched, stopped, commands, leftovers };
}

test('rejects a wrong call or a bundle without both packages', linux, () => {
  const { dir, bundle, run, ship } = fixture();
  try {
    ship();
    for (const args of [[], [''], [bundle, 'more']]) {
      const result = run(args);
      assert.equal(result.status, 2, JSON.stringify(args));
      assert.match(result.stderr, /usage: verify-linux-app\.sh <bundle-dir>/);
    }
    for (const missing of ['deb', 'appimage']) {
      ship();
      rmSync(join(bundle, missing), { recursive: true });
      const result = run();
      assert.equal(result.status, 1, missing);
      assert.match(result.stderr, /Expected a \.deb under .* and an \.AppImage under/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('launches the .deb and the AppImage in isolation and stops them', linux, () => {
  const { dir, home, run, ship, read, stopped, commands, leftovers } = fixture();
  try {
    ship();
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Launched the app from the \.deb; it opened its database/,
    );
    assert.match(result.stdout, /Launched the AppImage; it opened its database/);
    assert.match(commands(), /^Xvfb -displayfd 3 .*-nolisten tcp/m);
    assert.match(commands(), /^dpkg-deb -x .*Orchevia_0\.1\.24_amd64\.deb /m);
    for (const name of ['deb', 'appimage']) {
      const env = read(`${name}.env`);
      // A cleared environment: an empty home folder and its own display only.
      assert.match(env, /^DISPLAY=:99$/m);
      assert.doesNotMatch(env, /^(XDG_DATA_HOME|FAKE_LOG|DBUS_SESSION_BUS_ADDRESS)=/m);
      const appHome = /^HOME=(.*)$/m.exec(env)?.[1] ?? '';
      assert.notEqual(appHome, home);
      assert.ok(appHome.startsWith(join(dir, 'tmp')), appHome);
      assert.ok(stopped(name), `${name} and its helper are stopped afterwards`);
    }
    assert.match(read('appimage.env'), /^APPIMAGE_EXTRACT_AND_RUN=1$/m);
    assert.doesNotMatch(read('deb.env'), /APPIMAGE_EXTRACT_AND_RUN/);
    // The caller's own data folders are never touched.
    assert.deepEqual(readdirSync(home), []);
    assert.deepEqual(leftovers(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses a package whose app crashes, hangs or dies after opening', linux, () => {
  const { dir, run, ship, launched, stopped, leftovers } = fixture();
  try {
    for (const deb of ['crashes', 'hangs', 'crashesAfterDatabase']) {
      ship({ deb });
      const result = run();
      assert.equal(result.status, 1, deb);
      assert.match(result.stderr, /The app from the \.deb did not keep running/);
      assert.ok(stopped('deb'), `${deb}: stopped after a failed check`);
      assert.equal(launched('appimage'), false, 'the AppImage waits for a working .deb');
    }
    ship({ deb: 'crashes' });
    assert.match(run().stderr, /error while loading shared libraries: libwebkit2gtk/);
    for (const appimage of ['crashes', 'hangs']) {
      ship({ appimage });
      const result = run();
      assert.equal(result.status, 1, appimage);
      assert.match(result.stderr, /The AppImage did not keep running/);
      assert.ok(stopped('appimage'));
    }
    assert.deepEqual(leftovers(), [], 'failed checks clean up too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('requires a desktop entry that starts an installed program', linux, () => {
  const { dir, run, ship, launched } = fixture();
  try {
    ship({ entry: false });
    let result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /installs no desktop entry/);
    ship({ exec: 'orchevia-old %U' });
    result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /runs 'orchevia-old %U', which .*\.deb does not install/);
    // Absolute Exec paths resolve inside the package, field codes are ignored.
    ship({ exec: '/usr/bin/orchevia %U' });
    result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(launched('deb'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('explains a display server that does not start', linux, () => {
  const { dir, run, ship, launched, leftovers } = fixture();
  try {
    ship();
    const result = run(undefined, { FAKE_XVFB: 'fails' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Fatal server error[\s\S]*Xvfb did not start/);
    assert.equal(launched('deb'), false);
    assert.deepEqual(leftovers(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
