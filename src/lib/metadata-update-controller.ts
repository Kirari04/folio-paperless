import type { DocumentItem, DocumentChanges, PaperlessCatalog } from '../types/document.ts';
import type { FolioRepository } from '../types/persistence.ts';
import {
  PERSISTED_TASK_SCHEMA_VERSION,
  type PersistentMetadataPatch,
  type PersistentTask,
} from '../types/tasks.ts';
import {
  applyMetadataPatch,
  mergeMetadataPatches,
  metadataValuesForPatch,
  sanitizeMetadataPatch,
} from './metadata-update.ts';

export type MetadataConflictResolution = 'keep-local' | 'use-server';

function taskId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `metadata-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isUnresolvedMetadataTask(task: PersistentTask, documentId: string) {
  return task.kind === 'metadata-update'
    && task.metadataUpdate?.documentId === documentId
    && !['ready', 'canceled'].includes(task.stage);
}

export class MetadataUpdateController {
  private readonly repository: FolioRepository;
  private readonly now: () => Date;

  constructor(
    repository: FolioRepository,
    now: () => Date = () => new Date(),
  ) {
    this.repository = repository;
    this.now = now;
  }

  async enqueue(input: {
    profileId: string;
    document: DocumentItem;
    catalog: PaperlessCatalog;
    changes: DocumentChanges;
  }) {
    if (!input.document.remoteId) throw new Error('Only a cached Paperless document can be edited offline.');
    const nextPatch = sanitizeMetadataPatch(input.changes);
    const existing = (await this.repository.listTasks(input.profileId))
      .find((task) => isUnresolvedMetadataTask(task, input.document.id));
    const existingUpdate = existing?.metadataUpdate;
    if (existingUpdate?.conflict) {
      throw new Error('Resolve the existing metadata conflict before editing this document again.');
    }
    const timestamp = this.now().toISOString();
    const baselineValues = metadataValuesForPatch(input.document, nextPatch, input.catalog);
    const patch = existingUpdate
      ? mergeMetadataPatches(existingUpdate.patch, nextPatch)
      : nextPatch;
    const baseline = existingUpdate
      ? {
          ...existingUpdate.baseline,
          values: {
            ...baselineValues,
            ...existingUpdate.baseline.values,
          },
        }
      : { modifiedAt: input.document.modifiedAt, values: baselineValues };
    const task: PersistentTask = existing && existingUpdate
      ? {
          ...existing,
          schemaVersion: PERSISTED_TASK_SCHEMA_VERSION,
          stage: 'queued',
          progress: 0,
          retryCount: 0,
          error: undefined,
          nextAttemptAt: undefined,
          lastAttemptAt: undefined,
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          completedAt: undefined,
          updatedAt: timestamp,
          metadataUpdate: { ...existingUpdate, baseline, patch, conflict: undefined },
        }
      : {
          schemaVersion: PERSISTED_TASK_SCHEMA_VERSION,
          id: taskId(),
          profileId: input.profileId,
          kind: 'metadata-update',
          stage: 'queued',
          source: 'unknown',
          originalName: input.document.title,
          documentId: input.document.id,
          progress: 0,
          retryCount: 0,
          metadataUpdate: {
            documentId: input.document.id,
            remoteDocumentId: input.document.remoteId,
            baseline,
            patch,
          },
          createdAt: timestamp,
          updatedAt: timestamp,
        };
    const workspaceDocument = applyMetadataPatch(input.document, patch);
    const cachedDetail = await this.repository.readDocumentDetail(input.profileId, input.document.id);
    const detailDocument = cachedDetail
      ? applyMetadataPatch(cachedDetail.document, patch)
      : undefined;
    await this.repository.writeMetadataTask(task, workspaceDocument, detailDocument);
    return { task, document: workspaceDocument, detailDocument };
  }

  async retry(profileId: string, taskIdValue: string) {
    const task = await this.repository.readTask(profileId, taskIdValue);
    if (!task || task.kind !== 'metadata-update' || !task.metadataUpdate) {
      throw new Error('This metadata task is no longer available.');
    }
    if (task.metadataUpdate.conflict) {
      throw new Error('Choose whether to keep the local or server metadata first.');
    }
    if (task.stage !== 'failed' || task.error?.retryable !== true) {
      throw new Error('Only a retryable metadata failure can be retried.');
    }
    const workspace = await this.repository.readWorkspace(profileId);
    const document = workspace?.documents.find((item) => item.id === task.metadataUpdate!.documentId);
    if (!document) throw new Error('The cached document for this metadata task is unavailable.');
    const detail = await this.repository.readDocumentDetail(profileId, document.id);
    const retried: PersistentTask = {
      ...task,
      stage: 'queued',
      error: undefined,
      nextAttemptAt: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      completedAt: undefined,
      updatedAt: this.now().toISOString(),
    };
    await this.repository.writeMetadataTask(retried, document, detail?.document);
    return retried;
  }

  async resolveConflict(
    profileId: string,
    taskIdValue: string,
    resolution: MetadataConflictResolution,
  ) {
    const task = await this.repository.readTask(profileId, taskIdValue);
    const update = task?.metadataUpdate;
    if (!task || task.kind !== 'metadata-update' || !update?.conflict) {
      throw new Error('This metadata conflict is no longer available.');
    }
    const workspace = await this.repository.readWorkspace(profileId);
    const document = workspace?.documents.find((item) => item.id === update.documentId);
    if (!document) throw new Error('The cached document for this metadata conflict is unavailable.');
    const detail = await this.repository.readDocumentDetail(profileId, document.id);
    const timestamp = this.now().toISOString();
    if (resolution === 'keep-local') {
      const rebased: PersistentTask = {
        ...task,
        stage: 'queued',
        progress: 0,
        retryCount: 0,
        error: undefined,
        nextAttemptAt: undefined,
        lastAttemptAt: undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        completedAt: undefined,
        updatedAt: timestamp,
        metadataUpdate: {
          ...update,
          baseline: {
            modifiedAt: update.conflict.serverModifiedAt,
            values: update.conflict.serverValues,
          },
          conflict: undefined,
        },
      };
      await this.repository.writeMetadataTask(rebased, document, detail?.document);
      return { task: rebased, document, detailDocument: detail?.document };
    }
    const serverPatch: PersistentMetadataPatch = update.conflict.serverValues;
    const revertedDocument = applyMetadataPatch(document, serverPatch);
    const revertedDetail = detail ? applyMetadataPatch(detail.document, serverPatch) : undefined;
    const discarded: PersistentTask = {
      ...task,
      stage: 'canceled',
      cancelRequestedAt: timestamp,
      completedAt: timestamp,
      updatedAt: timestamp,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      result: { ...task.result, routeDocumentId: update.documentId, summary: 'Kept the server metadata.' },
    };
    await this.repository.writeMetadataTask(discarded, revertedDocument, revertedDetail);
    return { task: discarded, document: revertedDocument, detailDocument: revertedDetail };
  }

  async discard(profileId: string, taskIdValue: string) {
    const task = await this.repository.readTask(profileId, taskIdValue);
    const update = task?.metadataUpdate;
    if (!task || task.kind !== 'metadata-update' || !update) {
      throw new Error('This metadata task is no longer available.');
    }
    if (task.stage === 'ready' || task.stage === 'canceled') return { task };
    const workspace = await this.repository.readWorkspace(profileId);
    const document = workspace?.documents.find((item) => item.id === update.documentId);
    if (!document) throw new Error('The cached document for this metadata task is unavailable.');
    const detail = await this.repository.readDocumentDetail(profileId, document.id);
    const revertPatch = update.conflict?.serverValues ?? update.baseline.values;
    const revertedDocument = applyMetadataPatch(document, revertPatch);
    const revertedDetail = detail ? applyMetadataPatch(detail.document, revertPatch) : undefined;
    const timestamp = this.now().toISOString();
    const discarded: PersistentTask = {
      ...task,
      stage: 'canceled',
      cancelRequestedAt: timestamp,
      completedAt: timestamp,
      updatedAt: timestamp,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      result: { ...task.result, routeDocumentId: update.documentId, summary: 'Discarded the local metadata change.' },
    };
    await this.repository.writeMetadataTask(discarded, revertedDocument, revertedDetail);
    return { task: discarded, document: revertedDocument, detailDocument: revertedDetail };
  }
}
