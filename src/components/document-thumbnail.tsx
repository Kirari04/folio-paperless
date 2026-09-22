import { useMemo } from 'react';

import {
  PaperThumbnail,
  PAPER_THUMBNAIL_ASPECT_RATIO,
} from '@/components/paper-thumbnail';
import { SecureDocumentThumbnail } from '@/components/secure-document-thumbnail';
import { useDocumentThumbnailAccess } from '@/context/document-thumbnail-context';
import { allowsRealDocumentThumbnail } from '@/lib/document-thumbnail-policy';
import type { DocumentItem } from '@/types/document';

/**
 * A document card's picture: the real Paperless thumbnail when Folio is allowed
 * to show it, and the illustrated paper whenever it is not — while the image
 * loads, offline without a cached copy, in the demo workspace, behind the
 * biometric lock, on an error, or past the thumbnail size limit.
 *
 * `PaperThumbnail` stays available on its own for the places that are drawings
 * by nature: a document still being consumed, or the trash.
 */
export function DocumentThumbnail({
  document,
  width = 74,
}: {
  document: DocumentItem;
  width?: number;
}) {
  const access = useDocumentThumbnailAccess();
  const frame = useMemo(
    () => ({
      width,
      height: width * PAPER_THUMBNAIL_ASPECT_RATIO,
      borderRadius: width * 0.2,
      overflow: 'hidden' as const,
      backgroundColor: document.color,
    }),
    [document.color, width],
  );
  const illustration = <PaperThumbnail document={document} width={width} />;
  const allowed = allowsRealDocumentThumbnail({
    contentPrivate: access.contentPrivate,
    document,
    enabled: access.enabled,
    hasCredentials: access.hasCredentials,
  });

  if (!allowed || !access.credentials || document.remoteId === undefined) return illustration;

  return (
    <SecureDocumentThumbnail
      credentials={access.credentials}
      documentId={document.remoteId}
      fallback={illustration}
      style={frame}
      title={document.title}
    />
  );
}
