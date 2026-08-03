import type {
  DocumentItem,
  PaperlessOption,
} from '../types/document.ts';
import type {
  BulkDocumentReconciliation,
  CachedWorkspace,
  FolioRepository,
} from '../types/persistence.ts';

function uniquePositiveIntegers(values: readonly number[]) {
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))];
}

/** Returns only outcomes which are unambiguously terminal successes. A
 * malformed/ambiguous adapter result fails closed when an ID also appears in
 * pending, failed, or skipped outcomes. */
export function confirmedBulkSucceededIds(
  reconciliation: BulkDocumentReconciliation,
) {
  if (!reconciliation.result.accepted) return [];
  const remoteIdsByLocalId = new Map<string, Set<number>>();
  const localIdsByRemoteId = new Map<number, Set<string>>();
  for (const target of reconciliation.targets) {
    const remoteId = target.remoteDocumentId;
    if (!remoteId || !Number.isSafeInteger(remoteId) || remoteId <= 0) continue;
    const remoteIds = remoteIdsByLocalId.get(target.localId) ?? new Set<number>();
    remoteIds.add(remoteId);
    remoteIdsByLocalId.set(target.localId, remoteIds);
    const localIds = localIdsByRemoteId.get(remoteId) ?? new Set<string>();
    localIds.add(target.localId);
    localIdsByRemoteId.set(remoteId, localIds);
  }

  // Treat every identifier carried by a non-success outcome as unresolved.
  // If an adapter ever returns contradictory local/remote identifiers, taking
  // their union fails closed instead of letting one side authorize a mutation.
  const unresolved = new Set(uniquePositiveIntegers(reconciliation.result.pending));
  const markUnresolved = (localId: string | undefined, remoteId: number | null | undefined) => {
    if (remoteId && Number.isSafeInteger(remoteId) && remoteId > 0) unresolved.add(remoteId);
    if (!localId) return;
    for (const correlatedRemoteId of remoteIdsByLocalId.get(localId) ?? []) {
      unresolved.add(correlatedRemoteId);
    }
  };
  for (const failure of reconciliation.result.failed) {
    markUnresolved(failure.localId, failure.remoteId);
  }
  for (const skipped of reconciliation.result.skipped) {
    markUnresolved(skipped.localId, skipped.remoteId);
  }

  return uniquePositiveIntegers(reconciliation.result.succeeded)
    .filter((remoteId) => {
      const localIds = localIdsByRemoteId.get(remoteId);
      if (!localIds || localIds.size !== 1 || unresolved.has(remoteId)) return false;
      const [localId] = localIds;
      return remoteIdsByLocalId.get(localId)?.size === 1;
    });
}

function catalogOption(options: readonly PaperlessOption[], remoteId: number) {
  return options.find((option) => option.remoteId === remoteId);
}

function existingRemoteOption(
  optionId: string | undefined,
  options: readonly PaperlessOption[],
) {
  if (!optionId) return undefined;
  return options.find((option) => option.id === optionId);
}

function isInboxTag(option: PaperlessOption | undefined, name: string) {
  return option?.isInboxTag === true || name.toLocaleLowerCase() === 'inbox';
}

function reconcileTags(
  document: DocumentItem,
  reconciliation: BulkDocumentReconciliation,
) {
  const operation = reconciliation.result.operation;
  if (operation.kind !== 'tags' && operation.kind !== 'file') return document;

  const existing = document.tagIds.map((id, index) => ({
    id,
    name: document.tags[index] ?? reconciliation.labels.unknownTag,
    option: existingRemoteOption(id, reconciliation.catalog.tags),
  }));
  const affectedRemoteIds = uniquePositiveIntegers(
    operation.kind === 'file' ? operation.inboxTagIds : operation.tagIds,
  );
  const affectedIds = new Set(affectedRemoteIds.map((remoteId) => (
    catalogOption(reconciliation.catalog.tags, remoteId)?.id ?? `remote-tag-${remoteId}`
  )));
  let next = existing;

  if (operation.kind === 'file' || operation.mode === 'remove') {
    next = existing.filter((tag) => !affectedIds.has(tag.id));
  } else {
    const requested = affectedRemoteIds.map((remoteId) => {
      const option = catalogOption(reconciliation.catalog.tags, remoteId);
      return option
        ? { id: option.id, name: option.name, option }
        : {
            id: `remote-tag-${remoteId}`,
            name: reconciliation.labels.unknownTag,
            option: undefined,
          };
    });
    if (operation.mode === 'replace') {
      next = requested;
    } else {
      const present = new Set(existing.map((tag) => tag.id));
      next = [...existing, ...requested.filter((tag) => !present.has(tag.id))];
    }
  }

  return {
    ...document,
    tags: next.map((tag) => tag.name),
    tagIds: next.map((tag) => tag.id),
    status: next.some((tag) => isInboxTag(tag.option, tag.name)) ? 'inbox' : 'archived',
  } satisfies DocumentItem;
}

function scalarOption(
  options: readonly PaperlessOption[],
  remoteId: number | null,
) {
  return remoteId === null ? undefined : catalogOption(options, remoteId);
}

function scalarStableId(
  option: PaperlessOption | undefined,
  remoteId: number | null,
  prefix: string,
) {
  return remoteId === null ? undefined : option?.id ?? `${prefix}-${remoteId}`;
}

/** Projects one confirmed synchronous Paperless mutation onto a summary. It
 * never changes a document whose remote ID is not an unambiguous success. */
export function reconcileConfirmedBulkDocument(
  document: DocumentItem,
  reconciliation: BulkDocumentReconciliation,
): DocumentItem | null {
  if (!document.remoteId || !confirmedBulkSucceededIds(reconciliation).includes(document.remoteId)) {
    return document;
  }
  const operation = reconciliation.result.operation;
  if (operation.kind === 'trash') return null;
  if (operation.kind === 'tags' || operation.kind === 'file') {
    return reconcileTags(document, reconciliation);
  }
  if (operation.kind === 'reprocess') {
    return { ...document, suggestion: reconciliation.labels.reprocessing };
  }
  if (operation.kind === 'setCorrespondent') {
    const option = scalarOption(reconciliation.catalog.correspondents, operation.value);
    return {
      ...document,
      correspondent: operation.value === null
        ? reconciliation.labels.noCorrespondent
        : option?.name ?? reconciliation.labels.unknownCorrespondent,
      correspondentId: scalarStableId(option, operation.value, 'remote-correspondent'),
    };
  }
  if (operation.kind === 'setDocumentType') {
    const option = scalarOption(reconciliation.catalog.documentTypes, operation.value);
    return {
      ...document,
      documentType: operation.value === null
        ? reconciliation.labels.unsortedDocumentType
        : option?.name ?? reconciliation.labels.unknownDocumentType,
      documentTypeId: scalarStableId(option, operation.value, 'remote-type'),
    };
  }
  if (operation.kind === 'setStoragePath') {
    const option = scalarOption(reconciliation.catalog.storagePaths, operation.value);
    return {
      ...document,
      storagePath: operation.value === null
        ? reconciliation.labels.automaticStoragePath
        : option?.name ?? reconciliation.labels.unknownStoragePath,
      storagePathId: scalarStableId(option, operation.value, 'remote-storage-path'),
    };
  }
  const option = scalarOption(reconciliation.catalog.owners, operation.value);
  return {
    ...document,
    owner: option?.name,
    ownerId: scalarStableId(option, operation.value, 'remote-owner'),
  };
}

export function reconcileConfirmedBulkDocuments(
  documents: readonly DocumentItem[],
  reconciliation: BulkDocumentReconciliation,
) {
  return documents.flatMap((document) => {
    const reconciled = reconcileConfirmedBulkDocument(document, reconciliation);
    return reconciled ? [reconciled] : [];
  });
}

/** Applies a confirmed result to one exact profile snapshot without changing
 * sync timestamps/state. Trash totals change only for accepted successes. */
export function reconcileConfirmedBulkWorkspace(
  workspace: CachedWorkspace,
  reconciliation: BulkDocumentReconciliation,
): CachedWorkspace {
  const succeededIds = confirmedBulkSucceededIds(reconciliation);
  if (!succeededIds.length) return workspace;
  const documents = reconcileConfirmedBulkDocuments(workspace.documents, reconciliation);
  const trashedIds = reconciliation.result.operation.kind === 'trash'
    ? new Set(succeededIds.map((remoteId) => `remote-${remoteId}`))
    : null;
  const savedViewSnapshots = trashedIds && workspace.savedViewSnapshots
    ? Object.fromEntries(Object.entries(workspace.savedViewSnapshots).map(([id, snapshot]) => {
        const documentIds = snapshot.documentIds.filter((documentId) => !trashedIds.has(documentId));
        return [id, {
          ...snapshot,
          documentIds,
          totalDocuments: Math.max(
            0,
            snapshot.totalDocuments - (snapshot.documentIds.length - documentIds.length),
          ),
        }];
      }))
    : workspace.savedViewSnapshots;
  const visibleTrashedCount = trashedIds
    ? succeededIds.filter((remoteId) => (
        workspace.documents.some((document) => document.remoteId === remoteId)
      )).length
    : 0;
  return {
    ...workspace,
    documents,
    totalDocuments: trashedIds
      ? Math.max(0, workspace.totalDocuments - visibleTrashedCount)
      : workspace.totalDocuments,
    ...(savedViewSnapshots ? { savedViewSnapshots } : {}),
  };
}

export type ConfirmedBulkReconciliationCommit =
  | { status: 'missing-workspace' | 'stale' }
  | { status: 'published'; workspace: CachedWorkspace };

/** Persists first and publishes second. The caller's guard binds publication
 * to its exact active profile/epoch; a stale completion may update only the
 * explicitly scoped profile cache and can never replace another live UI. */
export async function commitConfirmedBulkReconciliation(input: {
  repository: FolioRepository;
  profileId: string;
  reconciliation: BulkDocumentReconciliation;
  executionGuard: () => boolean;
  publish: (workspace: CachedWorkspace) => void;
}): Promise<ConfirmedBulkReconciliationCommit> {
  if (!input.executionGuard()) return { status: 'stale' };
  const workspace = await input.repository.reconcileBulkDocuments(
    input.profileId,
    input.reconciliation,
  );
  if (!workspace) return { status: 'missing-workspace' };
  if (!input.executionGuard()) return { status: 'stale' };
  input.publish(workspace);
  return { status: 'published', workspace };
}

/** Publishes the confirmed local projection first so a failed/busy refresh
 * cannot create a stale-library gap. A later successful refresh remains the
 * authoritative state and may supersede this projection. */
export async function reconcileConfirmedBulkThenRefresh(input: {
  refresh: () => Promise<boolean>;
  reconcile: () => Promise<void>;
}) {
  let reconciliationError: unknown;
  try {
    await input.reconcile();
  } catch (error) {
    reconciliationError = error;
  }
  const refreshed = await input.refresh();
  if (refreshed) return 'refreshed' as const;
  if (reconciliationError) throw reconciliationError;
  return 'reconciled' as const;
}
