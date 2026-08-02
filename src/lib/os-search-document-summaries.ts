import type { SearchableDocumentSummary } from './os-search-privacy';
import type { DocumentItem } from '@/types/document';

export function revokeRemoteDocumentVisibility(
  documents: readonly DocumentItem[],
): DocumentItem[] {
  return documents.map((document) => (
    Number.isSafeInteger(document.remoteId) && document.remoteId! > 0
      ? { ...document, canView: false }
      : document
  ));
}

export function searchableSummariesForDocuments(
  profileId: string,
  documents: readonly DocumentItem[],
): SearchableDocumentSummary[] {
  return documents.flatMap((document) => {
    if (
      !Number.isSafeInteger(document.remoteId)
      || document.remoteId! < 1
      || document.canView !== true
    ) return [];
    return [{
      profileId,
      documentId: String(document.remoteId),
      title: document.title,
      updatedAt: document.modifiedAt ?? document.addedAt ?? document.added ?? document.created,
      canView: document.canView === true,
      deleted: Boolean(document.deletedAt),
    }];
  });
}
