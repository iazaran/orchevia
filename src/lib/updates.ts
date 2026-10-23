/**
 * Update notices: ask GitHub for the latest Orchevia release and say when a
 * newer one is ready. The request carries nothing about the user; it can be
 * turned off in Environment → Updates. Nothing downloads or installs on its
 * own: the notice links to the matching installer and explains how to apply
 * it.
 */

export const REPOSITORY_URL = 'https://github.com/iazaran/orchevia';
export const RELEASES_URL = `${REPOSITORY_URL}/releases/latest`;
/** Signed apt repository published with the project site. */
export const APT_REPOSITORY_URL = 'https://iazaran.github.io/orchevia/apt';
export const LATEST_RELEASE_API =
  'https://api.github.com/repos/iazaran/orchevia/releases/latest';
/** `'0'` turns automatic checks off; unset or `'1'` means on. */
export const UPDATE_CHECK_SETTING = 'updates.check';
/** A version whose banner the user closed; the Inbox entry stays. */
export const UPDATE_DISMISSED_SETTING = 'updates.dismissedVersion';
/** Automatic checks: shortly after launch, then twice a day while running. */
export const UPDATE_FIRST_CHECK_DELAY_MS = 20_000;
export const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** One request, headers and body together. */
export const UPDATE_REQUEST_TIMEOUT_MS = 15_000;

/** Facts from the desktop shell (`desktop_info`). */
export interface DesktopInfo {
  /** `false` when the desktop shows no tray icons; absent when unknown. */
  trayAvailable?: boolean;
  platform: string;
  arch: string;
  /** `apt` (.deb kept up to date by the apt repository), `deb`, `appimage`,
   * `app` (macOS) or `unknown`. */
  installKind: string;
}

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface LatestRelease {
  version: string;
  url: string;
  publishedAt?: string;
  assets: ReleaseAsset[];
}

export interface UpdateCheck {
  current: string;
  latest: LatestRelease;
  updateAvailable: boolean;
  checkedAt: string;
}

/** `major.minor.patch` with an optional `v`; mirrors `updates::parse_version`. */
export function parseVersion(text: string): [number, number, number] | null {
  const trimmed = text.trim();
  const match = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(trimmed);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether `candidate` is a release newer than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

/** Only this repository's pages may be opened; mirrors `allowed_external_url`. */
export function allowedExternalUrl(url: string): boolean {
  if (!url.startsWith(REPOSITORY_URL)) return false;
  const rest = url.slice(REPOSITORY_URL.length);
  return (
    (rest === '' || rest.startsWith('/')) &&
    url.length <= 300 &&
    /^[A-Za-z0-9\-._~/:?=&#%+]+$/.test(url)
  );
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Validate GitHub's `releases/latest` answer; links must stay in the repository. */
export function parseLatestRelease(json: unknown): LatestRelease | null {
  if (typeof json !== 'object' || json === null) return null;
  const record = json as Record<string, unknown>;
  const tag = text(record.tag_name);
  const url = text(record.html_url);
  if (tag === undefined || parseVersion(tag) === null) return null;
  if (url === undefined || !allowedExternalUrl(url)) return null;
  const assets: ReleaseAsset[] = [];
  if (Array.isArray(record.assets)) {
    for (const asset of record.assets as unknown[]) {
      if (typeof asset !== 'object' || asset === null) continue;
      const entry = asset as Record<string, unknown>;
      const name = text(entry.name);
      const download = text(entry.browser_download_url);
      if (name !== undefined && download !== undefined && allowedExternalUrl(download))
        assets.push({ name, url: download });
    }
  }
  const release: LatestRelease = { version: tag.replace(/^v/, ''), url, assets };
  const published = text(record.published_at);
  if (published !== undefined) release.publishedAt = published;
  return release;
}

/** Ask GitHub for the latest release. One 15 s timeout covers the headers
 * and the body, so a stalled connection never leaves a check pending. */
export async function fetchUpdateCheck(
  current: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UpdateCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, UPDATE_REQUEST_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(LATEST_RELEASE_API, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller.signal,
      });
    } catch {
      throw new Error('Could not reach GitHub to check for updates.');
    }
    if (response.status === 404) throw new Error('No published release was found.');
    if (!response.ok)
      throw new Error(`GitHub answered ${String(response.status)} to the update check.`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("Could not read GitHub's answer to the update check.");
    }
    const latest = parseLatestRelease(body);
    if (latest === null) throw new Error('GitHub returned an unexpected release format.');
    return {
      current,
      latest,
      updateAvailable: isNewer(latest.version, current),
      checkedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The installer matching how this copy was installed, if the release has it.
 * apt installs need none: `apt upgrade` fetches the new version. */
export function assetFor(
  release: LatestRelease,
  desktop: DesktopInfo | null,
): ReleaseAsset | undefined {
  if (desktop === null || desktop.installKind === 'apt') return undefined;
  const name =
    desktop.platform === 'macos'
      ? `Orchevia-macos-${desktop.arch}.dmg`
      : desktop.platform === 'linux' && desktop.installKind === 'deb'
        ? `Orchevia-linux-${desktop.arch}.deb`
        : desktop.platform === 'linux' && desktop.installKind === 'appimage'
          ? `Orchevia-linux-${desktop.arch}.AppImage`
          : undefined;
  return name === undefined ? undefined : release.assets.find((a) => a.name === name);
}

/** How to apply the downloaded installer; data is kept in every case. */
export function installSteps(desktop: DesktopInfo | null, assetName?: string): string {
  const file = assetName ?? 'the installer';
  switch (desktop?.installKind) {
    case 'apt':
      return 'Update it with apt: sudo apt update && sudo apt upgrade. Restart Orchevia afterwards.';
    case 'deb':
      return `Quit Orchevia, then install it over the current version: sudo apt install ~/Downloads/${file}`;
    case 'appimage':
      return `Quit Orchevia, replace your current AppImage with ${file} and make it executable (chmod +x).`;
    case 'app':
      // Each download is quarantined again, and the build is not notarized.
      return `Quit Orchevia, open ${file} and drag Orchevia into Applications, replacing the old copy. If macOS blocks the first launch, close the warning and choose Open Anyway in System Settings → Privacy & Security (System Preferences → Security & Privacy on macOS 12 and earlier).`;
    default:
      return 'Download the installer for your system from the release page and install it over the current version.';
  }
}
