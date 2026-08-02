import type { DocumentItem, PaperlessOption } from '@/types/document';
import type {
  PaperlessCatalogEditByResource,
  PaperlessCatalogObject,
  PaperlessCatalogResource,
  PaperlessMatchingAlgorithm,
  PaperlessTag,
} from '@/types/paperless-advanced';
import type {
  CachedWorkspace,
  CatalogMutationLabels,
  ConfirmedCatalogMutation,
} from '@/types/persistence';
import { buildVisibleTagOptions } from './tag-hierarchy.ts';

export const CATALOG_RESOURCE_LABELS: Record<PaperlessCatalogResource, string> = {
  tags: 'Tags',
  correspondents: 'Correspondents',
  documentTypes: 'Document types',
  storagePaths: 'Storage paths',
};

export type CatalogEditorDraft = {
  name: string;
  match: string;
  matchingAlgorithm: string;
  isInsensitive: boolean;
  color: string;
  path: string;
  parentId: number | null;
};

function editorAlgorithm(value: string): PaperlessMatchingAlgorithm | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  return /^\d+$/.test(normalized) ? Number(normalized) : normalized;
}

/** Produces a PATCH-safe edit: untouched absent or unfamiliar values stay absent. */
export function buildSparseCatalogEdit(
  resource: PaperlessCatalogResource,
  item: PaperlessCatalogObject | null,
  draft: CatalogEditorDraft,
  nestedTagsSupported: boolean,
): PaperlessCatalogEditByResource[PaperlessCatalogResource] {
  const edit: Record<string, unknown> = {};
  const name = draft.name.trim();
  if (!item || name !== item.name) edit.name = name;
  if (!item || draft.match !== item.match) edit.match = draft.match;

  const algorithm = editorAlgorithm(draft.matchingAlgorithm);
  const currentAlgorithm = item?.matchingAlgorithm ?? undefined;
  if (!item) {
    if (algorithm !== undefined) edit.matchingAlgorithm = algorithm;
  } else if (
    algorithm !== undefined
    && String(algorithm) !== String(currentAlgorithm)
  ) {
    edit.matchingAlgorithm = algorithm;
  }
  if (!item || draft.isInsensitive !== item.isInsensitive) {
    edit.isInsensitive = draft.isInsensitive;
  }

  if (resource === 'tags') {
    const current = item?.kind === 'tag' ? item : null;
    if (!current || draft.color !== (current.color ?? '')) edit.color = draft.color.trim();
    if (nestedTagsSupported && (!current || draft.parentId !== current.parentId)) {
      edit.parentId = draft.parentId;
    }
  }
  if (resource === 'storagePaths') {
    const current = item?.kind === 'storagePath' ? item : null;
    if (!current || draft.path !== current.path) edit.path = draft.path.trim();
  }
  return edit as PaperlessCatalogEditByResource[PaperlessCatalogResource];
}

export function catalogObjectStableId(resource: PaperlessCatalogResource, remoteId: number) {
  const prefixes: Record<PaperlessCatalogResource, string> = {
    tags: 'remote-tag',
    correspondents: 'remote-correspondent',
    documentTypes: 'remote-type',
    storagePaths: 'remote-storage-path',
  };
  return `${prefixes[resource]}-${remoteId}`;
}

export function catalogObjectToOption(
  resource: PaperlessCatalogResource,
  object: PaperlessCatalogObject,
): PaperlessOption {
  return {
    id: catalogObjectStableId(resource, object.id),
    remoteId: object.id,
    name: object.name,
    ...(object.kind === 'tag' ? {
      ...(object.color ? { color: object.color } : {}),
      isInboxTag: object.isInboxTag,
      ...(object.parentId !== null ? { parentRemoteId: object.parentId } : {}),
    } : {}),
  };
}

export function catalogUsageWarning(object: PaperlessCatalogObject) {
  if (object.documentCount === null) {
    return 'Usage is unavailable. Paperless may reject deletion while this item is referenced.';
  }
  if (object.documentCount === 0) return 'This item is not currently assigned to any documents.';
  return `${object.documentCount} document${object.documentCount === 1 ? '' : 's'} currently use this item.`;
}

export function availableTagParents(tags: readonly PaperlessTag[], currentId: number | null) {
  if (currentId === null) return [...tags];
  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  return tags.filter((candidate) => {
    if (candidate.id === currentId) return false;
    const visited = new Set<number>();
    let parentId = candidate.parentId;
    while (parentId !== null && !visited.has(parentId)) {
      if (parentId === currentId) return false;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return true;
  });
}

export function reconcileCatalogRename(
  documents: readonly DocumentItem[],
  resource: PaperlessCatalogResource,
  object: PaperlessCatalogObject,
) {
  const stableId = catalogObjectStableId(resource, object.id);
  return documents.map((document) => {
    if (resource === 'correspondents' && document.correspondentId === stableId) {
      return { ...document, correspondent: object.name };
    }
    if (resource === 'documentTypes' && document.documentTypeId === stableId) {
      return { ...document, documentType: object.name };
    }
    if (resource === 'storagePaths' && document.storagePathId === stableId) {
      return { ...document, storagePath: object.name };
    }
    if (resource === 'tags' && document.tagIds.includes(stableId)) {
      return {
        ...document,
        tags: document.tags.map((name, index) => (
          document.tagIds[index] === stableId ? object.name : name
        )),
      };
    }
    return document;
  });
}

function withoutProperty<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

/** Projects only a mutation the server has already confirmed. */
export function reconcileCatalogDocumentMutation(
  document: DocumentItem,
  mutation: ConfirmedCatalogMutation,
  labels: CatalogMutationLabels,
): DocumentItem {
  const remoteId = mutation.kind === 'upsert' ? mutation.object.id : mutation.remoteId;
  const stableId = catalogObjectStableId(mutation.resource, remoteId);
  if (mutation.kind === 'upsert') {
    return reconcileCatalogRename([document], mutation.resource, mutation.object)[0];
  }
  if (mutation.resource === 'correspondents' && document.correspondentId === stableId) {
    return { ...withoutProperty(document, 'correspondentId'), correspondent: labels.noCorrespondent };
  }
  if (mutation.resource === 'documentTypes' && document.documentTypeId === stableId) {
    return { ...withoutProperty(document, 'documentTypeId'), documentType: labels.unsortedDocumentType };
  }
  if (mutation.resource === 'storagePaths' && document.storagePathId === stableId) {
    return { ...withoutProperty(document, 'storagePathId'), storagePath: labels.automaticStoragePath };
  }
  if (mutation.resource === 'tags' && document.tagIds.includes(stableId)) {
    const kept = document.tagIds.flatMap((id, index) => (
      id === stableId ? [] : [{ id, name: document.tags[index] ?? labels.unknownTag }]
    ));
    return {
      ...document,
      tagIds: kept.map((entry) => entry.id),
      tags: kept.map((entry) => entry.name),
    };
  }
  return document;
}

export function reconcileCatalogWorkspaceMutation(
  workspace: CachedWorkspace,
  mutation: ConfirmedCatalogMutation,
  labels: CatalogMutationLabels,
): CachedWorkspace {
  const resource = mutation.resource;
  const remoteId = mutation.kind === 'upsert' ? mutation.object.id : mutation.remoteId;
  const option = mutation.kind === 'upsert'
    ? catalogObjectToOption(resource, mutation.object)
    : null;
  const existing = workspace.catalog[resource] ?? [];
  const replacedOptions = option
    ? [...existing.filter((entry) => entry.remoteId !== remoteId && entry.id !== option.id), option]
    : existing.filter((entry) => entry.remoteId !== remoteId);
  const nextOptions = resource === 'tags'
    ? buildVisibleTagOptions(replacedOptions.flatMap((entry) => entry.remoteId === undefined ? [] : [{
        id: entry.remoteId,
        name: entry.name,
        ...(entry.color ? { color: entry.color } : {}),
        parent: entry.parentRemoteId ?? null,
        is_inbox_tag: entry.isInboxTag,
      }]))
    : replacedOptions.sort((left, right) => left.name.localeCompare(right.name));
  return {
    ...workspace,
    documents: workspace.documents.map((document) => (
      reconcileCatalogDocumentMutation(document, mutation, labels)
    )),
    catalog: { ...workspace.catalog, [resource]: nextOptions },
    // A confirmed deletion can change the result of any server-side rule.
    // Never serve a pre-deletion exact snapshot as authoritative offline data.
    ...(mutation.kind === 'delete' ? { savedViewSnapshots: {} } : {}),
  };
}
