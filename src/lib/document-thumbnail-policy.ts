/**
 * Folio paints a document card in one of two ways.
 *
 * - The illustrated card (`PaperThumbnail`) is drawn locally from metadata the
 *   app already holds. It needs no network and shows nothing of the paper.
 * - The real Paperless thumbnail (`/api/documents/{id}/thumb/`) shows the paper
 *   itself, which is how a person recognizes a document at a glance.
 *
 * The real image is a document preview, so it obeys the same rules as every
 * other preview in Folio: the "Real document previews" appearance setting, the
 * biometric lock that keeps previews private, and the presence of credentials.
 * This module owns those rules with no React, network, or platform dependency,
 * so the decision stays testable off-device.
 */

/** Only the fields of a `DocumentItem` the decision may read. */
export type DocumentThumbnailSubject = {
  remoteId?: number | null;
  canView?: boolean;
  deletedAt?: string | null;
  status?: 'inbox' | 'archived' | 'processing';
};

export type DocumentThumbnailAccess = {
  /** `preferences.realThumbnails`, already gated on the store being ready. */
  enabled: boolean;
  /** True while the lock screen or the privacy curtain must hide content. */
  contentPrivate: boolean;
  /** False in the demo workspace, where no server may be contacted. */
  hasCredentials: boolean;
};

/**
 * Whether this card may spend one authenticated request on its thumbnail.
 * Every `false` here means the illustrated card, and no network at all.
 */
export function allowsRealDocumentThumbnail(
  input: DocumentThumbnailAccess & { document: DocumentThumbnailSubject },
): boolean {
  if (!input.enabled || input.contentPrivate || !input.hasCredentials) return false;
  const { canView, deletedAt, remoteId, status } = input.document;
  // `canView` is set only once the active account has actually returned the
  // document; an explicit `false` means the token would be refused.
  if (canView === false) return false;
  // A document still being consumed has no server-rendered thumbnail yet, and a
  // trashed one is outside the queryset the thumbnail endpoint serves. Asking
  // would spend one request per card to earn a 404.
  if (status === 'processing' || (deletedAt ?? null) !== null) return false;
  return typeof remoteId === 'number' && Number.isSafeInteger(remoteId) && remoteId > 0;
}

export type DocumentThumbnailLoadState = 'pending' | 'ready' | 'failed';

export type DocumentThumbnailPresentation = 'illustration' | 'image';

/**
 * What the person sees right now. The illustrated card covers the image until
 * it has decoded, so a slow, offline, oversized, or rejected thumbnail never
 * leaves an empty frame behind.
 */
export function resolveDocumentThumbnailPresentation(input: {
  allowed: boolean;
  load: DocumentThumbnailLoadState;
}): DocumentThumbnailPresentation {
  return input.allowed && input.load === 'ready' ? 'image' : 'illustration';
}

export const DOCUMENT_THUMBNAIL_REPRESENTATION = 'thumb' as const;

/**
 * The server half of the cache identity. A stored profile can hold a URL this
 * runtime no longer parses; the raw value still separates two servers, which is
 * all the cache key needs it for.
 */
export function documentThumbnailServerOrigin(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin;
  } catch {
    return serverUrl.trim();
  }
}

/**
 * The identity of one cached thumbnail. The profile and the server origin are
 * part of it, so switching profiles or servers can never surface another
 * installation's document under the same document number.
 */
export function documentThumbnailCacheSeed(input: {
  profileKey: string;
  serverOrigin: string;
  documentId: number;
}): string {
  return [
    input.profileKey,
    input.serverOrigin,
    input.documentId,
    DOCUMENT_THUMBNAIL_REPRESENTATION,
  ].join('\n');
}

/**
 * Opaque cache filename for the mutual-TLS transport, which cannot hand headers
 * to the image loader and has to download the thumbnail itself. `lease`
 * distinguishes two mounts of the same document — the home stack and the
 * library can show one card twice — so neither deletes the other's file.
 */
export function documentThumbnailCacheFileName(digest: string, lease: string): string {
  return `folio-thumb-${digest.slice(0, 40)}-${lease}.img`;
}

/** Memory-cache key for the header-authenticated `expo-image` source. */
export function documentThumbnailImageCacheKey(input: {
  profileKey: string;
  documentId: number;
}): string {
  return `folio-thumb-${input.profileKey}-${input.documentId}`;
}
