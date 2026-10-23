import { describe, expect, it, vi } from 'vitest';
import {
  LATEST_RELEASE_API,
  UPDATE_REQUEST_TIMEOUT_MS,
  allowedExternalUrl,
  assetFor,
  fetchUpdateCheck,
  installSteps,
  isNewer,
  parseLatestRelease,
  parseVersion,
} from './updates';

const release = {
  tag_name: 'v0.2.0',
  html_url: 'https://github.com/iazaran/orchevia/releases/tag/v0.2.0',
  published_at: '2026-11-01T10:00:00Z',
  assets: [
    {
      name: 'Orchevia-linux-x86_64.deb',
      browser_download_url:
        'https://github.com/iazaran/orchevia/releases/download/v0.2.0/Orchevia-linux-x86_64.deb',
    },
    {
      name: 'Orchevia-macos-arm64.dmg',
      browser_download_url:
        'https://github.com/iazaran/orchevia/releases/download/v0.2.0/Orchevia-macos-arm64.dmg',
    },
    { name: 'evil.deb', browser_download_url: 'https://example.com/evil.deb' },
  ],
};

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (url: RequestInfo | URL) => {
    expect(url).toBe(LATEST_RELEASE_API);
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
}

describe('versions (mirror of updates.rs)', () => {
  it('parses release versions only', () => {
    expect(parseVersion('0.1.20')).toEqual([0, 1, 20]);
    expect(parseVersion(' v1.2.3 ')).toEqual([1, 2, 3]);
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('1.2.3.4')).toBeNull();
    expect(parseVersion('1.2.3-beta.1')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
  });

  it('compares numerically', () => {
    expect(isNewer('0.1.20', '0.1.19')).toBe(true);
    expect(isNewer('v0.2.0', '0.1.99')).toBe(true);
    expect(isNewer('0.1.19', '0.1.19')).toBe(false);
    expect(isNewer('0.1.9', '0.1.19')).toBe(false);
    expect(isNewer('garbage', '0.1.19')).toBe(false);
  });
});

describe('links (mirror of desktop.rs)', () => {
  it('opens only repository pages', () => {
    expect(
      allowedExternalUrl('https://github.com/iazaran/orchevia/releases/latest'),
    ).toBe(true);
    expect(allowedExternalUrl('https://github.com/iazaran/orchevia')).toBe(true);
    expect(allowedExternalUrl('https://github.com/iazaran/orchevia-evil/releases')).toBe(
      false,
    );
    expect(allowedExternalUrl('https://example.com/iazaran/orchevia')).toBe(false);
    expect(allowedExternalUrl('https://github.com/iazaran/orchevia/a b')).toBe(false);
    expect(allowedExternalUrl('https://github.com/iazaran/orchevia/"$(x)"')).toBe(false);
    expect(allowedExternalUrl('file:///etc/passwd')).toBe(false);
  });
});

describe('latest release', () => {
  it('keeps repository links only', () => {
    const parsed = parseLatestRelease(release);
    expect(parsed?.version).toBe('0.2.0');
    expect(parsed?.assets.map((asset) => asset.name)).toEqual([
      'Orchevia-linux-x86_64.deb',
      'Orchevia-macos-arm64.dmg',
    ]);
    expect(
      parseLatestRelease({ ...release, html_url: 'https://example.com' }),
    ).toBeNull();
    expect(parseLatestRelease({ ...release, tag_name: 'nightly' })).toBeNull();
    expect(parseLatestRelease('nope')).toBeNull();
  });

  it('reports newer releases and failures', async () => {
    const newer = await fetchUpdateCheck('0.1.20', fakeFetch(200, release));
    expect(newer.updateAvailable).toBe(true);
    expect(newer.latest.version).toBe('0.2.0');
    const same = await fetchUpdateCheck('0.2.0', fakeFetch(200, release));
    expect(same.updateAvailable).toBe(false);
    await expect(fetchUpdateCheck('0.1.20', fakeFetch(404, {}))).rejects.toThrow(
      'No published release',
    );
    await expect(fetchUpdateCheck('0.1.20', fakeFetch(500, {}))).rejects.toThrow('500');
    const offline: typeof fetch = () => Promise.reject(new TypeError('offline'));
    await expect(fetchUpdateCheck('0.1.20', offline)).rejects.toThrow('Could not reach');
  });

  it('gives up on a body that stalls after the headers', async () => {
    vi.useFakeTimers();
    try {
      const stalled: typeof fetch = (_url, init) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => {
              controller.error(new DOMException('aborted', 'AbortError'));
            });
          },
        });
        return Promise.resolve(new Response(body, { status: 200 }));
      };
      const check = fetchUpdateCheck('0.1.20', stalled);
      const outcome = expect(check).rejects.toThrow("Could not read GitHub's answer");
      await vi.advanceTimersByTimeAsync(UPDATE_REQUEST_TIMEOUT_MS);
      await outcome;
    } finally {
      vi.useRealTimers();
    }
  });

  it('picks the installer that matches this copy', () => {
    const parsed = parseLatestRelease(release);
    if (parsed === null) throw new Error('release');
    const deb = { platform: 'linux', arch: 'x86_64', installKind: 'deb' };
    expect(assetFor(parsed, deb)?.name).toBe('Orchevia-linux-x86_64.deb');
    expect(
      assetFor(parsed, { platform: 'macos', arch: 'arm64', installKind: 'app' })?.name,
    ).toBe('Orchevia-macos-arm64.dmg');
    expect(
      assetFor(parsed, { platform: 'linux', arch: 'x86_64', installKind: 'appimage' }),
    ).toBeUndefined();
    expect(assetFor(parsed, null)).toBeUndefined();
    expect(installSteps(deb, 'Orchevia-linux-x86_64.deb')).toContain(
      'sudo apt install ~/Downloads/Orchevia-linux-x86_64.deb',
    );
    // A new DMG is quarantined again, and macOS asks for Open Anyway.
    expect(
      installSteps(
        { platform: 'macos', arch: 'arm64', installKind: 'app' },
        'Orchevia-macos-arm64.dmg',
      ),
    ).toContain('Open Anyway in System Settings → Privacy & Security');
    // From the apt repository: no download, apt upgrades it.
    const apt = { ...deb, installKind: 'apt' };
    expect(assetFor(parsed, apt)).toBeUndefined();
    expect(installSteps(apt)).toContain('sudo apt update && sudo apt upgrade');
  });
});
