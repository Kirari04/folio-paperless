import * as FileSystem from 'expo-file-system/legacy';

export const FOLIO_RELEASES_URL = 'https://github.com/Kirari04/folio-paperless/releases';
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

const GITHUB_LATEST_RELEASE_URL =
  'https://api.github.com/repos/Kirari04/folio-paperless/releases/latest';
const GITHUB_API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 15_000;
const UPDATE_DIRECTORY_NAME = 'folio-updates';
const CACHE_SCHEMA_VERSION = 1;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type GitHubAsset = {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
  digest?: unknown;
};

type GitHubRelease = {
  tag_name?: unknown;
  name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
};

export type FolioReleaseAsset = {
  name: string;
  downloadUrl: string;
  size: number;
  digestSha256: string | null;
};

export type FolioRelease = {
  version: string;
  tagName: string;
  title: string;
  notes: string;
  htmlUrl: string;
  publishedAt: string | null;
  apk: FolioReleaseAsset | null;
  checksumUrl: string | null;
};

export type DownloadedUpdate = {
  version: string;
  fileUri: string;
  digestSha256: string;
};

export type UpdateCache = {
  schemaVersion: number;
  checkedAt: number | null;
  etag: string | null;
  release: FolioRelease | null;
  remindAfter: number | null;
  downloaded: DownloadedUpdate | null;
};

export type LatestReleaseResult = {
  cache: UpdateCache;
  release: FolioRelease | null;
  fromCache: boolean;
};

export const EMPTY_UPDATE_CACHE: UpdateCache = {
  schemaVersion: CACHE_SCHEMA_VERSION,
  checkedAt: null,
  etag: null,
  release: null,
  remindAfter: null,
  downloaded: null,
};

export class FolioUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FolioUpdateError';
  }
}

export function parseStableVersion(version: string) {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) return null;

  const components = match.slice(1).map(Number);
  if (components.some((component) => component > 999)) return null;
  const [major, minor, patch] = components;
  return { major, minor, patch };
}

export function compareStableVersions(left: string, right: string) {
  const leftVersion = parseStableVersion(left);
  const rightVersion = parseStableVersion(right);
  if (!leftVersion || !rightVersion) {
    throw new FolioUpdateError('Folio received an invalid stable version from GitHub.');
  }

  for (const component of ['major', 'minor', 'patch'] as const) {
    if (leftVersion[component] !== rightVersion[component]) {
      return leftVersion[component] > rightVersion[component] ? 1 : -1;
    }
  }
  return 0;
}

export function versionCodeFor(version: string) {
  const parsed = parseStableVersion(version);
  if (!parsed) throw new FolioUpdateError(`Version ${version} cannot be installed by Folio.`);
  return parsed.major * 1_000_000 + parsed.minor * 1_000 + parsed.patch;
}

export function formatUpdateSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Unknown size';
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes >= 100 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
}

export function cleanReleaseNotes(notes: string) {
  const cleaned = notes
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!cleaned) return 'Polish, fixes, and improvements are included in this release.';
  return cleaned.length > 4_000 ? `${cleaned.slice(0, 3_997).trimEnd()}…` : cleaned;
}

export function getUpdateDirectoryUri() {
  if (!FileSystem.cacheDirectory) {
    throw new FolioUpdateError('Temporary storage is unavailable on this device.');
  }
  return `${FileSystem.cacheDirectory}${UPDATE_DIRECTORY_NAME}/`;
}

export async function ensureUpdateDirectory() {
  const directoryUri = getUpdateDirectoryUri();
  const info = await FileSystem.getInfoAsync(directoryUri);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(directoryUri, { intermediates: true });
  }
  return directoryUri;
}

export async function getUpdateFileUri(version: string) {
  const directoryUri = await ensureUpdateDirectory();
  return `${directoryUri}Folio-v${version}-android-universal.apk`;
}

export async function removeDownloadedUpdate(downloaded: DownloadedUpdate | null) {
  if (!downloaded?.fileUri) return;
  try {
    const info = await FileSystem.getInfoAsync(downloaded.fileUri);
    if (info.exists) await FileSystem.deleteAsync(downloaded.fileUri, { idempotent: true });
  } catch {
    // A cleared Android cache already has the desired result.
  }
}

export async function downloadedUpdateExists(downloaded: DownloadedUpdate | null) {
  if (!downloaded?.fileUri) return false;
  try {
    const info = await FileSystem.getInfoAsync(downloaded.fileUri);
    return info.exists && !info.isDirectory && (info.size ?? 0) > 0;
  } catch {
    return false;
  }
}

function stateFileUri() {
  if (!FileSystem.documentDirectory) return null;
  return `${FileSystem.documentDirectory}${UPDATE_DIRECTORY_NAME}/state.json`;
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isNumberOrNull(value: unknown): value is number | null {
  return (typeof value === 'number' && Number.isFinite(value)) || value === null;
}

function parseRelease(value: unknown): FolioRelease | null {
  if (!value || typeof value !== 'object') return null;
  const release = value as Partial<FolioRelease>;
  if (
    typeof release.version !== 'string' ||
    !parseStableVersion(release.version) ||
    typeof release.tagName !== 'string' ||
    typeof release.title !== 'string' ||
    typeof release.notes !== 'string' ||
    typeof release.htmlUrl !== 'string' ||
    !isStringOrNull(release.publishedAt)
  ) {
    return null;
  }

  let apk: FolioReleaseAsset | null = null;
  if (release.apk && typeof release.apk === 'object') {
    const candidate = release.apk as Partial<FolioReleaseAsset>;
    if (
      typeof candidate.name === 'string' &&
      typeof candidate.downloadUrl === 'string' &&
      typeof candidate.size === 'number' &&
      isStringOrNull(candidate.digestSha256)
    ) {
      apk = {
        name: candidate.name,
        downloadUrl: candidate.downloadUrl,
        size: candidate.size,
        digestSha256: candidate.digestSha256,
      };
    }
  }

  return {
    version: release.version,
    tagName: release.tagName,
    title: release.title,
    notes: release.notes,
    htmlUrl: release.htmlUrl,
    publishedAt: release.publishedAt,
    apk,
    checksumUrl: isStringOrNull(release.checksumUrl) ? release.checksumUrl : null,
  };
}

export async function readUpdateCache(): Promise<UpdateCache> {
  const fileUri = stateFileUri();
  if (!fileUri) return EMPTY_UPDATE_CACHE;

  try {
    const info = await FileSystem.getInfoAsync(fileUri);
    if (!info.exists) return EMPTY_UPDATE_CACHE;
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(fileUri)) as Partial<UpdateCache>;
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) return EMPTY_UPDATE_CACHE;

    const downloaded = parsed.downloaded;
    const validDownloaded =
      downloaded &&
      typeof downloaded === 'object' &&
      typeof downloaded.version === 'string' &&
      typeof downloaded.fileUri === 'string' &&
      typeof downloaded.digestSha256 === 'string' &&
      SHA256_PATTERN.test(downloaded.digestSha256)
        ? downloaded
        : null;

    return {
      schemaVersion: CACHE_SCHEMA_VERSION,
      checkedAt: isNumberOrNull(parsed.checkedAt) ? parsed.checkedAt : null,
      etag: isStringOrNull(parsed.etag) ? parsed.etag : null,
      release: parseRelease(parsed.release),
      remindAfter: isNumberOrNull(parsed.remindAfter) ? parsed.remindAfter : null,
      downloaded: validDownloaded,
    };
  } catch {
    return EMPTY_UPDATE_CACHE;
  }
}

export async function writeUpdateCache(cache: UpdateCache) {
  const fileUri = stateFileUri();
  if (!fileUri) return;
  const directoryUri = fileUri.slice(0, fileUri.lastIndexOf('/') + 1);
  const info = await FileSystem.getInfoAsync(directoryUri);
  if (!info.exists) await FileSystem.makeDirectoryAsync(directoryUri, { intermediates: true });
  await FileSystem.writeAsStringAsync(fileUri, JSON.stringify(cache));
}

function assetFromGitHub(value: GitHubAsset): FolioReleaseAsset | null {
  if (
    typeof value.name !== 'string' ||
    typeof value.browser_download_url !== 'string' ||
    typeof value.size !== 'number'
  ) {
    return null;
  }

  const digest =
    typeof value.digest === 'string' && value.digest.startsWith('sha256:')
      ? value.digest.slice('sha256:'.length).toLocaleLowerCase()
      : null;

  return {
    name: value.name,
    downloadUrl: value.browser_download_url,
    size: value.size,
    digestSha256: digest && SHA256_PATTERN.test(digest) ? digest : null,
  };
}

function parseGitHubRelease(value: unknown): FolioRelease | null {
  if (!value || typeof value !== 'object') {
    throw new FolioUpdateError('GitHub returned an unreadable release response.');
  }
  const release = value as GitHubRelease;
  if (release.draft === true || release.prerelease === true) return null;
  if (typeof release.tag_name !== 'string') {
    throw new FolioUpdateError('The latest GitHub release has no version tag.');
  }

  const version = release.tag_name.startsWith('v')
    ? release.tag_name.slice(1)
    : release.tag_name;
  if (!parseStableVersion(version)) {
    throw new FolioUpdateError(`GitHub release ${release.tag_name} is not a stable Folio version.`);
  }

  const assets = Array.isArray(release.assets) ? (release.assets as GitHubAsset[]) : [];
  const apkName = `Folio-v${version}-android-universal.apk`;
  const apk = assets
    .map(assetFromGitHub)
    .find((asset): asset is FolioReleaseAsset => asset?.name === apkName) ?? null;
  const checksumAsset = assets.find(
    (asset) => asset.name === `${apkName}.sha256` && typeof asset.browser_download_url === 'string',
  );

  return {
    version,
    tagName: `v${version}`,
    title:
      typeof release.name === 'string' && release.name.trim()
        ? release.name.trim()
        : `Folio v${version}`,
    notes: cleanReleaseNotes(typeof release.body === 'string' ? release.body : ''),
    htmlUrl:
      typeof release.html_url === 'string' && release.html_url
        ? release.html_url
        : `${FOLIO_RELEASES_URL}/tag/v${version}`,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    apk,
    checksumUrl:
      checksumAsset && typeof checksumAsset.browser_download_url === 'string'
        ? checksumAsset.browser_download_url
        : null,
  };
}

function messageForRequestError(error: unknown) {
  if (error instanceof FolioUpdateError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') {
    return 'GitHub took too long to respond. Check your connection and try again.';
  }
  return 'Could not reach GitHub Releases. Check your connection and try again.';
}

export async function fetchLatestFolioRelease(
  cache: UpdateCache,
  force = false,
): Promise<LatestReleaseResult> {
  const now = Date.now();
  if (!force && cache.checkedAt && now - cache.checkedAt < UPDATE_CHECK_INTERVAL_MS) {
    return { cache, release: cache.release, fromCache: true };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    };
    if (cache.etag) headers['If-None-Match'] = cache.etag;

    const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
      headers,
      signal: controller.signal,
    });

    if (response.status === 304) {
      const nextCache = { ...cache, checkedAt: now };
      return { cache: nextCache, release: nextCache.release, fromCache: true };
    }
    if (response.status === 403 || response.status === 429) {
      throw new FolioUpdateError(
        'GitHub temporarily limited update checks. Folio will try again later.',
      );
    }
    if (response.status === 404) {
      throw new FolioUpdateError('No published Folio release is available on GitHub yet.');
    }
    if (!response.ok) {
      throw new FolioUpdateError(`GitHub could not check for updates (HTTP ${response.status}).`);
    }

    const latestRelease = parseGitHubRelease(await response.json());
    const nextCache: UpdateCache = {
      ...cache,
      checkedAt: now,
      etag: response.headers.get('etag'),
      release: latestRelease,
    };
    return { cache: nextCache, release: latestRelease, fromCache: false };
  } catch (error) {
    throw new FolioUpdateError(messageForRequestError(error));
  } finally {
    clearTimeout(timeout);
  }
}

export async function expectedReleaseSha256(release: FolioRelease) {
  if (release.apk?.digestSha256) return release.apk.digestSha256;
  if (!release.apk || !release.checksumUrl) {
    throw new FolioUpdateError('This release has no verifiable Android checksum.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(release.checksumUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new FolioUpdateError(`GitHub could not download the checksum (HTTP ${response.status}).`);
    }
    const checksum = (await response.text()).trim().split(/\s+/)[0]?.toLocaleLowerCase();
    if (!checksum || !SHA256_PATTERN.test(checksum)) {
      throw new FolioUpdateError('The release checksum is invalid.');
    }
    return checksum;
  } catch (error) {
    throw new FolioUpdateError(messageForRequestError(error));
  } finally {
    clearTimeout(timeout);
  }
}
