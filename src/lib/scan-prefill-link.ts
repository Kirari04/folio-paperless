import type { PaperlessOption } from '../types/document.ts';

/**
 * `folio-paperless://scan?tags=<list>` opens the scanner with the tags of a
 * batch already selected, so ten annexes of one folder can be scanned one
 * after another without retyping their destination. The link carries public
 * catalog references only: tag remote IDs, or tag names resolved against the
 * active profile's catalog. No secret is ever accepted, and nothing is stored
 * until the person confirms the upload sheet.
 */
export const SCAN_LINK_QUERY_PARAMETERS = ['tags'] as const;

/**
 * Query names that would carry a credential. They are rejected before the
 * allowlist so the person is told why, instead of seeing a generic
 * "unsupported link" fallback to Home.
 */
export const SCAN_LINK_SECRET_PARAMETERS = [
  'access_token',
  'api_key',
  'apikey',
  'api_token',
  'authorization',
  'bearer',
  'client_secret',
  'code',
  'credential',
  'credentials',
  'id_token',
  'key',
  'otp',
  'pass',
  'passcode',
  'password',
  'passwd',
  'refresh_token',
  'secret',
  'token',
  'totp',
] as const;

export const MAX_SCAN_LINK_TAGS = 16;
export const MAX_SCAN_LINK_TAG_LENGTH = 128;

/** A tag reference carried by a link: a Paperless remote ID, or a name. */
export type ScanLinkTagSelector =
  | { kind: 'remote-id'; remoteId: number }
  | { kind: 'name'; name: string };

export type ScanPrefillLink = {
  tags: readonly ScanLinkTagSelector[];
};

export type ScanLinkRejectionCode =
  | 'scan-secret-in-link'
  | 'scan-tags-required'
  | 'scan-invalid-tags';

export type ScanLinkParseResult =
  | { accepted: true; prefill: ScanPrefillLink }
  | { accepted: false; code: ScanLinkRejectionCode };

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const REMOTE_ID_PATTERN = /^[1-9]\d{0,8}$/;

export function findScanLinkSecretParameter(keys: Iterable<string>): string | null {
  const secrets = new Set<string>(SCAN_LINK_SECRET_PARAMETERS);
  for (const key of keys) {
    if (secrets.has(key.trim().toLowerCase())) return key;
  }
  return null;
}

/** Comparison form for a tag name, so a link may carry the printed label. */
export function normalizedTagName(name: string) {
  return name.normalize('NFKC').trim().toLocaleLowerCase();
}

function selectorIdentity(selector: ScanLinkTagSelector) {
  return selector.kind === 'remote-id'
    ? `id:${selector.remoteId}`
    : `name:${normalizedTagName(selector.name)}`;
}

export function parseScanLinkTags(
  raw: string,
): readonly ScanLinkTagSelector[] | ScanLinkRejectionCode {
  if (CONTROL_CHARACTER_PATTERN.test(raw)) return 'scan-invalid-tags';
  const tokens = raw.split(',').map((token) => token.normalize('NFKC').trim());
  if (!tokens.length || tokens.some((token) => !token)) return 'scan-tags-required';
  if (tokens.length > MAX_SCAN_LINK_TAGS) return 'scan-invalid-tags';
  if (tokens.some((token) => token.length > MAX_SCAN_LINK_TAG_LENGTH)) {
    return 'scan-invalid-tags';
  }
  const selectors: ScanLinkTagSelector[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const selector: ScanLinkTagSelector = REMOTE_ID_PATTERN.test(token)
      ? { kind: 'remote-id', remoteId: Number(token) }
      : { kind: 'name', name: token };
    const identity = selectorIdentity(selector);
    if (seen.has(identity)) continue;
    seen.add(identity);
    selectors.push(selector);
  }
  return selectors;
}

/**
 * Validates the query of a `folio-paperless://scan` link. The caller has
 * already restricted the query to {@link SCAN_LINK_QUERY_PARAMETERS} and
 * rejected duplicates, so only the values are checked here.
 */
export function parseScanLinkParameters(
  values: Readonly<Record<string, string>>,
): ScanLinkParseResult {
  if (findScanLinkSecretParameter(Object.keys(values))) {
    return { accepted: false, code: 'scan-secret-in-link' };
  }
  const raw = values.tags;
  if (raw === undefined) return { accepted: false, code: 'scan-tags-required' };
  if (!raw.trim()) return { accepted: false, code: 'scan-tags-required' };
  const tags = parseScanLinkTags(raw);
  if (typeof tags === 'string') return { accepted: false, code: tags };
  return { accepted: true, prefill: { tags } };
}

/** Canonical query of a scan prefill, used to serialize and fingerprint it. */
export function scanLinkQueryValues(prefill: ScanPrefillLink): Record<string, string> {
  return {
    tags: prefill.tags
      .map((tag) => (tag.kind === 'remote-id' ? String(tag.remoteId) : tag.name))
      .join(','),
  };
}

export type ResolvedScanLinkTags = {
  tags: PaperlessOption[];
  /** Selectors with no catalog match. They are ignored, never invented. */
  unresolved: string[];
};

/**
 * Resolves link selectors against the active profile's tag catalog. An unknown
 * tag is reported instead of being created: a link must not be able to write
 * to the catalog, and the profile that opens the link may not be the one the
 * link was written for.
 */
export function resolveScanLinkTags(
  prefill: ScanPrefillLink,
  catalogTags: readonly PaperlessOption[],
): ResolvedScanLinkTags {
  const tags: PaperlessOption[] = [];
  const unresolved: string[] = [];
  const claimed = new Set<number>();
  for (const selector of prefill.tags) {
    const match = selector.kind === 'remote-id'
      ? catalogTags.find((tag) => tag.remoteId === selector.remoteId)
      : catalogTags.find((tag) => normalizedTagName(tag.name) === normalizedTagName(selector.name));
    if (!match || match.remoteId === undefined) {
      unresolved.push(selector.kind === 'remote-id' ? String(selector.remoteId) : selector.name);
      continue;
    }
    if (claimed.has(match.remoteId)) continue;
    claimed.add(match.remoteId);
    tags.push(match);
  }
  return { tags, unresolved };
}
