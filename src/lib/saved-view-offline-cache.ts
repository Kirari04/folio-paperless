import type {
  DocumentItem,
  PaperlessLibraryRequest,
  PaperlessSavedView,
} from '../types/document.ts';
import type { CachedSavedViewSnapshot } from '../types/persistence.ts';
import { matchesLibraryFilters } from './library-filters.ts';

export function savedViewFingerprint(view: PaperlessSavedView) {
  return JSON.stringify({
    id: view.id,
    remoteId: view.remoteId ?? null,
    // Supplemental fields on a future rule can change server semantics even
    // when its familiar rule type and value are unchanged. Include the exact
    // opaque payload so an old server-evaluated membership is never reused.
    filterRules: view.filterRules.map((rule) => ({
      ruleType: rule.ruleType,
      value: rule.value,
      known: rule.known ?? null,
      extra: rule.extra ?? {},
    })),
    sortField: view.sortField,
    sortReverse: view.sortReverse,
    pageSize: view.pageSize,
  });
}

export function createSavedViewSnapshot(
  view: PaperlessSavedView,
  documents: DocumentItem[],
  totalDocuments: number,
  evaluatedAt = new Date().toISOString(),
): CachedSavedViewSnapshot {
  return {
    viewId: view.id,
    viewFingerprint: savedViewFingerprint(view),
    documentIds: documents.map((document) => document.id),
    totalDocuments,
    evaluatedAt,
  };
}

export function resolveSavedViewSnapshot(
  snapshots: CachedWorkspaceSnapshots,
  view: PaperlessSavedView,
  currentDocuments: DocumentItem[],
) {
  const snapshot = snapshots?.[view.id];
  if (!snapshot || snapshot.viewFingerprint !== savedViewFingerprint(view)) return null;
  const current = new Map(currentDocuments.map((document) => [document.id, document]));
  return {
    ...structuredClone(snapshot),
    documents: snapshot.documentIds.flatMap((id) => {
      const document = current.get(id);
      return document ? [structuredClone(document)] : [];
    }),
  };
}

/** Applies refinements the client understands to an exact server-evaluated base membership. */
export function filterSavedViewSnapshot(
  snapshot: CachedSavedViewSnapshot & { documents: DocumentItem[] },
  request: PaperlessLibraryRequest,
) {
  const query = request.query.trim().toLocaleLowerCase();
  return snapshot.documents.filter((document) => {
    if (!matchesLibraryFilters(document, request.filters)) return false;
    if (!query) return true;
    return [
      document.title,
      document.correspondent,
      document.documentType,
      document.excerpt,
      document.fullText,
      ...document.tags,
    ].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
  });
}

type CachedWorkspaceSnapshots = Record<string, CachedSavedViewSnapshot> | undefined;

/** Refreshes cached rows with current metadata and removes documents no longer visible. */
export function reconcileSavedViewSnapshots(
  snapshots: CachedWorkspaceSnapshots,
  currentDocuments: DocumentItem[],
  allowedViewIds?: ReadonlySet<string>,
): Record<string, CachedSavedViewSnapshot> | undefined {
  if (!snapshots || !Object.keys(snapshots).length) return snapshots;
  const current = new Map(currentDocuments.map((document) => [document.id, document]));
  return Object.fromEntries(Object.entries(snapshots).flatMap(([viewId, snapshot]) => {
    if (allowedViewIds && !allowedViewIds.has(viewId)) return [];
    const documentIds = snapshot.documentIds.filter((id) => current.has(id));
    return [[viewId, { ...snapshot, documentIds, totalDocuments: documentIds.length }]];
  }));
}

export function mergeWorkspaceSavedViewSnapshots(
  current: { savedViewSnapshots?: Record<string, CachedSavedViewSnapshot> } | null | undefined,
  next: { documents: DocumentItem[]; catalog: { savedViews?: PaperlessSavedView[] }; savedViewSnapshots?: Record<string, CachedSavedViewSnapshot> },
) {
  const merged = { ...current?.savedViewSnapshots, ...next.savedViewSnapshots };
  const savedViews = next.catalog.savedViews;
  return reconcileSavedViewSnapshots(
    merged,
    next.documents,
    savedViews ? new Set(savedViews.map((view) => view.id)) : undefined,
  );
}
