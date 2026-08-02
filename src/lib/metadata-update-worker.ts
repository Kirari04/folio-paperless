import type {
  DocumentChanges,
  DocumentItem,
  PaperlessCatalog,
} from '../types/document.ts';
import type { FolioRepository } from '../types/persistence.ts';
import type { PersistentTask } from '../types/tasks.ts';
import {
  assertMetadataUpdate,
  conflictingMetadataFields,
  documentChangesFromMetadataPatch,
  metadataPatchMatches,
  metadataValuesForPatch,
} from './metadata-update.ts';
import { classifyTaskFailure, scheduleTaskRetry } from './task-policy.ts';

export type MetadataUpdateTransport = {
  read(remoteDocumentId: number): Promise<DocumentItem>;
  update(remoteDocumentId: number, changes: DocumentChanges): Promise<void>;
};

export type MetadataUpdateWorkerResult =
  | { kind: 'idle' }
  | { kind: 'ready'; task: PersistentTask; document: DocumentItem }
  | { kind: 'conflict'; task: PersistentTask }
  | { kind: 'failed'; task: PersistentTask }
  | { kind: 'revoked'; task: PersistentTask };

function statusFrom(error: unknown) {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

function released(task: PersistentTask, now: Date): PersistentTask {
  return {
    ...task,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    updatedAt: now.toISOString(),
  };
}

export async function runNextMetadataUpdate(options: {
  profileId: string;
  workerId: string;
  repository: FolioRepository;
  transport: MetadataUpdateTransport;
  catalog: PaperlessCatalog;
  now?: () => Date;
  executionGuard?: () => boolean | Promise<boolean>;
  onTaskChange?: (task: PersistentTask) => void | Promise<void>;
}): Promise<MetadataUpdateWorkerResult> {
  const now = options.now ?? (() => new Date());
  let lease = await options.repository.claimNextMetadataTask(
    options.profileId,
    options.workerId,
    now(),
  );
  if (!lease) return { kind: 'idle' };
  let task = lease;
  const executionIsCurrent = async () => !options.executionGuard || await options.executionGuard();
  const renew = async () => {
    if (!await executionIsCurrent()) return false;
    const next = await options.repository.renewTaskLease(
      lease!.profileId,
      lease!.id,
      options.workerId,
      now(),
    );
    if (!next) return false;
    lease = next;
    task = { ...task!, leaseOwner: next.leaseOwner, leaseExpiresAt: next.leaseExpiresAt };
    return true;
  };
  const commit = async (nextTask: PersistentTask, document: DocumentItem | null) => {
    if (!await executionIsCurrent()) return false;
    const committed = await options.repository.commitMetadataTask(lease!, nextTask, document, now());
    if (committed) await options.onTaskChange?.(nextTask);
    return committed;
  };

  try {
    const update = assertMetadataUpdate(task);
    if (!await renew()) return { kind: 'revoked', task };
    const serverDocument = await options.transport.read(update.remoteDocumentId);
    if (!await renew()) return { kind: 'revoked', task };
    const serverValues = metadataValuesForPatch(serverDocument, update.patch, options.catalog);

    // This also closes an ambiguous response window: if Paperless accepted a
    // previous PATCH but the readback failed, a restarted worker observes the
    // desired values and finishes without sending a second overwrite.
    if (metadataPatchMatches(serverValues, update.patch)) {
      const timestamp = now();
      const ready = released({
        ...task,
        stage: 'ready',
        progress: 1,
        error: undefined,
        nextAttemptAt: undefined,
        lastAttemptAt: timestamp.toISOString(),
        completedAt: timestamp.toISOString(),
        result: {
          ...task.result,
          remoteDocumentId: update.remoteDocumentId,
          routeDocumentId: update.documentId,
          summary: 'Metadata updated in Paperless.',
        },
        metadataUpdate: { ...update, conflict: undefined },
      }, timestamp);
      if (!await commit(ready, serverDocument)) return { kind: 'revoked', task };
      return { kind: 'ready', task: ready, document: serverDocument };
    }

    const revisionChanged = !update.baseline.modifiedAt
      || serverDocument.modifiedAt !== update.baseline.modifiedAt;
    const conflicts = revisionChanged
      ? conflictingMetadataFields(update.baseline.values, serverValues, update.patch)
      : [];
    if (conflicts.length) {
      const timestamp = now();
      const conflict = released({
        ...task,
        stage: 'failed',
        progress: 0,
        error: {
          code: 'conflict',
          message: 'Paperless changed the same metadata. Choose which version to keep.',
          retryable: false,
        },
        nextAttemptAt: undefined,
        lastAttemptAt: timestamp.toISOString(),
        metadataUpdate: {
          ...update,
          conflict: {
            detectedAt: timestamp.toISOString(),
            serverModifiedAt: serverDocument.modifiedAt,
            conflictingFields: conflicts,
            serverValues,
          },
        },
      }, timestamp);
      if (!await commit(conflict, null)) return { kind: 'revoked', task };
      return { kind: 'conflict', task: conflict };
    }

    await options.transport.update(
      update.remoteDocumentId,
      documentChangesFromMetadataPatch(update.patch),
    );
    if (!await renew()) return { kind: 'revoked', task };
    const readback = await options.transport.read(update.remoteDocumentId);
    if (!await renew()) return { kind: 'revoked', task };
    const readbackValues = metadataValuesForPatch(readback, update.patch, options.catalog);
    if (!metadataPatchMatches(readbackValues, update.patch)) {
      const timestamp = now();
      const conflict = released({
        ...task,
        stage: 'failed',
        progress: 0,
        error: {
          code: 'conflict',
          message: 'Paperless returned different metadata after the update. Review both versions.',
          retryable: false,
        },
        nextAttemptAt: undefined,
        lastAttemptAt: timestamp.toISOString(),
        metadataUpdate: {
          ...update,
          conflict: {
            detectedAt: timestamp.toISOString(),
            serverModifiedAt: readback.modifiedAt,
            conflictingFields: conflictingMetadataFields(update.patch, readbackValues, update.patch),
            serverValues: readbackValues,
          },
        },
      }, timestamp);
      if (!await commit(conflict, null)) return { kind: 'revoked', task };
      return { kind: 'conflict', task: conflict };
    }
    const timestamp = now();
    const ready = released({
      ...task,
      stage: 'ready',
      progress: 1,
      error: undefined,
      nextAttemptAt: undefined,
      lastAttemptAt: timestamp.toISOString(),
      completedAt: timestamp.toISOString(),
      result: {
        ...task.result,
        remoteDocumentId: update.remoteDocumentId,
        routeDocumentId: update.documentId,
        summary: 'Metadata updated in Paperless.',
      },
      metadataUpdate: { ...update, conflict: undefined },
    }, timestamp);
    if (!await commit(ready, readback)) return { kind: 'revoked', task };
    return { kind: 'ready', task: ready, document: readback };
  } catch (error) {
    const latest = await options.repository.readTask(task.profileId, task.id);
    if (latest?.stage === 'canceled') return { kind: 'revoked', task: latest };
    const message = error instanceof Error ? error.message : 'The metadata update failed.';
    const failed = released(scheduleTaskRetry(
      task,
      classifyTaskFailure(statusFrom(error), message),
      now(),
    ), now());
    if (!await commit(failed, null)) return { kind: 'revoked', task: latest ?? task };
    return { kind: 'failed', task: failed };
  }
}

export async function drainMetadataUpdates(options: {
  profileId: string;
  workerId: string;
  repository: FolioRepository;
  transport: MetadataUpdateTransport;
  catalog: PaperlessCatalog;
  executionGuard?: () => boolean | Promise<boolean>;
  onTaskChange?: (task: PersistentTask) => void | Promise<void>;
  onResult?: (result: Exclude<MetadataUpdateWorkerResult, { kind: 'idle' }>) => void | Promise<void>;
}) {
  const results: Exclude<MetadataUpdateWorkerResult, { kind: 'idle' }>[] = [];
  while (true) {
    const result = await runNextMetadataUpdate(options);
    if (result.kind === 'idle') break;
    results.push(result);
    await options.onResult?.(result);
    if (result.kind !== 'ready') break;
  }
  return results;
}
