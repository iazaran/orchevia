import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// Run the actual setup script with fake privileged commands; never change host APT.
test('Linux setup avoids the slow Azure mirror and propagates APT failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchevia-apt-'));
  const mirrors = join(dir, 'apt-mirrors.txt');
  const log = join(dir, 'commands');
  const original =
    'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n' +
    'https://archive.ubuntu.com/ubuntu/\tpriority:2\n' +
    'https://security.ubuntu.com/ubuntu/\tpriority:3\n';
  writeFileSync(join(dir, 'sudo'), '#!/bin/bash\nexec "$@"\n', { mode: 0o755 });
  writeFileSync(
    join(dir, 'apt-get'),
    '#!/bin/bash\nprintf "%s\\n" "$*" >> "$APT_TEST_LOG"\n' +
      'if [[ " $* " == *" $APT_TEST_FAIL_COMMAND "* ]]; then exit "$APT_TEST_STATUS"; fi\n',
    { mode: 0o755 },
  );
  const run = (status = '0', command = 'update') =>
    spawnSync('bash', [resolve('scripts/install-linux-deps.sh'), mirrors], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        APT_TEST_LOG: log,
        APT_TEST_STATUS: status,
        APT_TEST_FAIL_COMMAND: command,
      },
    });
  try {
    writeFileSync(mirrors, original);
    assert.equal(run().status, 0);
    assert.equal(readFileSync(mirrors, 'utf8'), original.split('\n').slice(1).join('\n'));
    const commands = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(commands.length, 2);
    assert.match(commands[0], /Acquire::Retries=3.*update$/);
    assert.match(commands[1], /install -y libwebkit2gtk-4\.1-dev/);
    assert.match(commands[1], /libayatana-appindicator3-dev/);
    assert.doesNotMatch(
      commands.join('\n'),
      /allow-unauthenticated|fix-missing|no-install-recommends/,
    );
    // If the mirror layout changes, preserve it rather than emptying its sources.
    writeFileSync(mirrors, 'http://azure.archive.ubuntu.com/ubuntu/\n');
    assert.equal(run().status, 0);
    assert.equal(
      readFileSync(mirrors, 'utf8'),
      'http://azure.archive.ubuntu.com/ubuntu/\n',
    );
    writeFileSync(log, '');
    assert.notEqual(run('42').status, 0);
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
    writeFileSync(log, '');
    assert.notEqual(run('42', 'install').status, 0);
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
