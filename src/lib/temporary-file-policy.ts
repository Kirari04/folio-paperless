const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const TEMPORARY_FILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function assertSafeTemporaryPathSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!SAFE_PATH_SEGMENT.test(normalized) || normalized === '.' || normalized === '..') {
    throw new Error(`${label} is not safe for temporary storage.`);
  }
  return normalized;
}

export function viewerCacheFilename(input: {
  documentId: number;
  representation: 'archive' | 'original' | 'server';
  versionId?: number | null;
  detailsRevision: number;
}): string {
  if (!Number.isSafeInteger(input.documentId) || input.documentId <= 0) {
    throw new Error('The viewer cache needs a valid document ID.');
  }
  if (!Number.isSafeInteger(input.detailsRevision) || input.detailsRevision < 0) {
    throw new Error('The viewer cache needs a valid document revision.');
  }
  if (input.versionId != null && (!Number.isSafeInteger(input.versionId) || input.versionId <= 0)) {
    throw new Error('The viewer cache needs a valid version ID.');
  }
  return `document-${input.documentId}-${input.representation}-${input.versionId ?? 'current'}-${input.detailsRevision}-preview.pdf`;
}

export function isExpiredTemporaryFile(
  lastModified: number | null | undefined,
  now = Date.now(),
  maxAgeMs = TEMPORARY_FILE_MAX_AGE_MS,
): boolean {
  return typeof lastModified !== 'number' || !Number.isFinite(lastModified) ||
    lastModified <= 0 || now - lastModified > maxAgeMs;
}
