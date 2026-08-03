import type { FolioRepository } from '../types/persistence.ts';
import type { PersistentTask } from '../types/tasks.ts';
import { translateRuntime } from '../i18n/runtime.ts';
import {
  classifyTaskFailure,
  nextRetryStage,
  prepareFailedBulkOutcomesForRetry,
  replacePendingBulkOutcomes,
  scheduleTaskRetry,
  transitionTask,
} from './task-policy.ts';

export type UploadQueueTransport = {
  validateUpload?(task: PersistentTask): Promise<void>;
  upload(
    task: PersistentTask,
    onProgress: (progress: number) => Promise<void> | void,
  ): Promise<string>;
  poll(task: PersistentTask): Promise<{
    documentId?: number;
    duplicateDocumentIds?: number[];
    summary?: string;
  }>;
  finalizeMetadata?(
    task: PersistentTask,
    result: { documentId?: number; duplicateDocumentIds?: number[]; summary?: string },
  ): Promise<void>;
  submitBulk?(task: PersistentTask): Promise<{
    paperlessTaskId?: string;
    summary?: string;
  }>;
};

export type UploadQueueWorkerResult =
  | { kind: 'idle' }
  | { kind: 'ready'; task: PersistentTask }
  | { kind: 'canceled'; task: PersistentTask }
  | { kind: 'failed'; task: PersistentTask };

// A native upload can legitimately run for five minutes before the transport
// timeout. Keep the lease longer than that request so a foreground/background
// overlap cannot re-upload the same bytes while the first request is alive.
// Restored workers wake at the persisted expiry and reclaim interrupted work.
export const UPLOAD_TASK_LEASE_MS = 7 * 60_000;

class TaskExecutionRevokedError extends Error {
  constructor() {
    super('The upload task lease or connection profile changed.');
    this.name = 'TaskExecutionRevokedError';
  }
}

function failureStatus(error: unknown) {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

function failureDuplicateDocumentIds(error: unknown) {
  if (!error || typeof error !== 'object' || !('duplicateDocumentIds' in error)) return [];
  const value = error.duplicateDocumentIds;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(
    (id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0,
  ))];
}

function classifiedQueueFailure(error: unknown, message: string) {
  if (
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'invalid-metadata'
  ) {
    return {
      code: 'invalid-metadata' as const,
      message,
      retryable: false,
    };
  }
  return classifyTaskFailure(failureStatus(error), message);
}

export async function runNextUploadTask(options: {
  profileId: string;
  workerId: string;
  repository: FolioRepository;
  transport: UploadQueueTransport;
  now?: () => Date;
  executionGuard?: () => Promise<boolean> | boolean;
  onTaskChange?: (task: PersistentTask) => Promise<void> | void;
}): Promise<UploadQueueWorkerResult> {
  const now = options.now ?? (() => new Date());
  const executionIsCurrent = async () => (
    !options.executionGuard || await options.executionGuard()
  );
  if (!await executionIsCurrent()) return { kind: 'idle' };
  let task = await options.repository.claimNextRunnableTask(
    options.profileId,
    options.workerId,
    now(),
    UPLOAD_TASK_LEASE_MS,
  );
  if (!task) return { kind: 'idle' };
  let persistedTask = task;

  let acceptedPaperlessTaskId: string | undefined;
  let polledPaperlessTaskId: string | undefined;
  let completedPollResult: Awaited<ReturnType<UploadQueueTransport['poll']>> | undefined;
  const requireAuthority = async () => {
    if (!await executionIsCurrent()) {
      throw new TaskExecutionRevokedError();
    }
    const renewed = await options.repository.renewTaskLease(
      task!.profileId,
      task!.id,
      options.workerId,
      now(),
      UPLOAD_TASK_LEASE_MS,
    );
    if (!renewed) throw new TaskExecutionRevokedError();
    task = renewed;
    persistedTask = renewed;
  };
  const persistLeased = async (next: PersistentTask) => {
    const committed = await options.repository.updateLeasedTask(persistedTask, next, now());
    if (!committed) throw new TaskExecutionRevokedError();
    task = committed;
    persistedTask = committed;
    await options.onTaskChange?.(committed);
  };
  const reconcileCanceledTask = async (latest: PersistentTask) => {
    // Cancellation intentionally releases the lease, but an upload may already
    // have been accepted by Paperless. Allow only this monotonic terminal-state
    // reconciliation, and only while the connection binding is still current.
    if (
      latest.stage !== 'canceled'
      || latest.profileId !== task!.profileId
      || latest.id !== task!.id
      || !await executionIsCurrent()
    ) return null;
    if (
      acceptedPaperlessTaskId
      && latest.paperlessTaskId
      && latest.paperlessTaskId !== acceptedPaperlessTaskId
    ) {
      return null;
    }
    if (
      completedPollResult
      && (!polledPaperlessTaskId || latest.paperlessTaskId !== polledPaperlessTaskId)
    ) {
      return null;
    }
    let canceled = latest;
    if (completedPollResult) {
      canceled = {
        ...latest,
        cancellationDisposition: 'acceptance-uncertain',
        result: {
          ...latest.result,
          ...(completedPollResult.documentId ? {
            remoteDocumentId: completedPollResult.documentId,
          } : {}),
          summary: translateRuntime('taskRuntime.stoppedFinished'),
        },
        updatedAt: now().toISOString(),
      };
    } else if (acceptedPaperlessTaskId) {
      canceled = {
        ...latest,
        cancellationDisposition: 'acceptance-uncertain',
        paperlessTaskId: acceptedPaperlessTaskId,
        result: {
          ...latest.result,
          summary: translateRuntime('taskRuntime.stoppedAfterUpload'),
        },
        updatedAt: now().toISOString(),
      };
    }
    if (canceled !== latest) {
      try {
        await options.repository.writeTask(canceled);
      } catch {
        // A committed profile removal is irreversible. Never resurrect its
        // task merely to record a late remote acceptance or poll result.
        return null;
      }
    }
    await options.onTaskChange?.(canceled);
    return canceled;
  };

  try {
    await requireAuthority();
    if (task.stage === 'failed') {
      task = prepareFailedBulkOutcomesForRetry(task);
      task = {
        ...transitionTask(task, nextRetryStage(task), now()),
        error: undefined,
        nextAttemptAt: undefined,
      };
      await persistLeased(task);
      await requireAuthority();
    }
    if (!task.paperlessTaskId) {
      if (task.kind === 'upload') {
        await options.transport.validateUpload?.(task);
        // Validation may make a network request. Re-check cancellation,
        // profile binding, and lease ownership before any bytes are sent.
        await requireAuthority();
      }
      if (task.kind === 'bulk-operation') {
        task = transitionTask(task, 'uploading', now());
        await persistLeased(task);
        if (!options.transport.submitBulk) {
          throw new Error('This build cannot resubmit a persisted bulk operation.');
        }
        const submission = await options.transport.submitBulk(task);
        acceptedPaperlessTaskId = submission.paperlessTaskId;
        await requireAuthority();
        task = {
          ...transitionTask(task, 'processing', now()),
          progress: 1,
          ...(acceptedPaperlessTaskId ? { paperlessTaskId: acceptedPaperlessTaskId } : {}),
          error: undefined,
        };
        if (acceptedPaperlessTaskId) {
          task = {
            ...task,
            result: {
              ...task.result,
              bulkOutcomes: task.result?.bulkOutcomes?.map((outcome) => (
                outcome.state === 'pending'
                  ? { ...outcome, paperlessTaskId: acceptedPaperlessTaskId }
                  : outcome
              )),
            },
          };
        } else {
          completedPollResult = { summary: submission.summary };
        }
        await persistLeased(task);
      } else {
        if (!task.localUri) throw new Error(translateRuntime('taskRuntime.stagedMissing'));
        // Paperless creates the only correlation ID. Persist the ambiguous
        // boundary before invoking the transport so process death or a lost
        // response can never turn into an automatic second POST.
        task = transitionTask(
          task,
          task.kind === 'upload' ? 'submission-uncertain' : 'uploading',
          now(),
        );
        await persistLeased(task);
        await requireAuthority();
        let progressTail = Promise.resolve();
        acceptedPaperlessTaskId = await options.transport.upload(task, (progress) => {
          progressTail = progressTail.then(async () => {
            await requireAuthority();
            task = {
              ...task!,
              progress: Math.max(0, Math.min(1, progress)),
              updatedAt: now().toISOString(),
            };
            await persistLeased(task);
          });
          return progressTail;
        });
        await progressTail;
        await requireAuthority();
        const latestAfterUpload = await options.repository.readTask(task.profileId, task.id);
        if (latestAfterUpload?.stage === 'canceled') {
          const canceled = await reconcileCanceledTask(latestAfterUpload);
          if (!canceled) throw new TaskExecutionRevokedError();
          task = canceled;
          return { kind: 'canceled', task };
        }
        task = {
          ...transitionTask(task, 'processing', now()),
          paperlessTaskId: acceptedPaperlessTaskId,
          progress: 1,
          error: undefined,
        };
        // Persist the Paperless task identity before any polling. A restart from
        // this point can only poll and will never upload the bytes again.
        await persistLeased(task);
      }
    } else if (task.stage !== 'processing') {
      task = transitionTask(task, nextRetryStage(task), now());
      await persistLeased(task);
    }

    if (task.paperlessTaskId) {
      polledPaperlessTaskId = task.paperlessTaskId;
      completedPollResult = await options.transport.poll(task);
    }
    if (!completedPollResult) throw new Error('Paperless did not return a bulk result or task ID.');
    await requireAuthority();
    const latestAfterPoll = await options.repository.readTask(task.profileId, task.id);
    if (latestAfterPoll?.stage === 'canceled') {
      const canceled = await reconcileCanceledTask(latestAfterPoll);
      if (!canceled) throw new TaskExecutionRevokedError();
      task = canceled;
      return { kind: 'canceled', task };
    }
    if (
      completedPollResult.documentId
      && (task.kind === 'upload' || task.kind === 'paperless-processing')
    ) {
      task = {
        ...task,
        result: {
          ...task.result,
          remoteDocumentId: completedPollResult.documentId,
          routeDocumentId: `remote-${completedPollResult.documentId}`,
          ...(completedPollResult.duplicateDocumentIds
            ? { duplicateDocumentIds: completedPollResult.duplicateDocumentIds }
            : {}),
          ...(completedPollResult.summary ? { summary: completedPollResult.summary } : {}),
        },
        updatedAt: now().toISOString(),
      };
      // Persist the confirmed remote identity before post-processing. If an
      // owner PATCH or readback fails, the task becomes an honest repair state
      // without losing either the staged file or the created document.
      await persistLeased(task);
      await options.transport.finalizeMetadata?.(task, completedPollResult);
      await requireAuthority();
    }
    task = {
      ...transitionTask(task, 'ready', now()),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      error: undefined,
      result: {
        ...task.result,
        ...(completedPollResult.documentId ? {
          remoteDocumentId: completedPollResult.documentId,
          routeDocumentId: `remote-${completedPollResult.documentId}`,
        } : {}),
        ...(completedPollResult.duplicateDocumentIds
          ? { duplicateDocumentIds: completedPollResult.duplicateDocumentIds }
          : {}),
        ...(completedPollResult.summary ? { summary: completedPollResult.summary } : {}),
      },
    };
    task = replacePendingBulkOutcomes(task, 'succeeded');
    await persistLeased(task);
    return { kind: 'ready', task };
  } catch (error) {
    const latest = await options.repository.readTask(task.profileId, task.id);
    if (latest?.stage === 'canceled') {
      const canceled = await reconcileCanceledTask(latest);
      if (canceled) return { kind: 'canceled', task: canceled };
    }
    if (error instanceof TaskExecutionRevokedError) {
      return { kind: 'failed', task: latest ?? task };
    }
    const message = error instanceof Error ? error.message : translateRuntime('taskRuntime.uploadFailed');
    const classified = classifiedQueueFailure(error, message);
    if (
      task.kind === 'upload'
      && task.stage === 'submission-uncertain'
      && !task.paperlessTaskId
    ) {
      const failedAt = now().toISOString();
      task = {
        ...task,
        error: {
          code: 'submission-uncertain',
          message,
          retryable: false,
          ...(classified.status ? { status: classified.status } : {}),
        },
        retryCount: task.retryCount + 1,
        lastAttemptAt: failedAt,
        nextAttemptAt: undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: failedAt,
      };
    } else {
      task = scheduleTaskRetry(task, classified, now());
    }
    task = replacePendingBulkOutcomes(task, 'failed', task.error);
    const duplicateDocumentIds = failureDuplicateDocumentIds(error);
    if (duplicateDocumentIds.length) {
      task = {
        ...task,
        result: {
          ...task.result,
          duplicateDocumentIds,
          summary: translateRuntime('taskRuntime.duplicateReview'),
        },
      };
    }
    try {
      await persistLeased(task);
    } catch (persistError) {
      if (persistError instanceof TaskExecutionRevokedError) {
        return {
          kind: 'failed',
          task: await options.repository.readTask(task.profileId, task.id) ?? task,
        };
      }
      throw persistError;
    }
    return { kind: 'failed', task };
  }
}

export async function drainUploadQueue(options: {
  profileId: string;
  workerId: string;
  repository: FolioRepository;
  transport: UploadQueueTransport;
  concurrency?: number;
  onResult?: (result: Exclude<UploadQueueWorkerResult, { kind: 'idle' }>) => Promise<void> | void;
  onTaskChange?: (task: PersistentTask) => Promise<void> | void;
  executionGuard?: () => Promise<boolean> | boolean;
}) {
  const concurrency = Math.max(1, Math.min(3, options.concurrency ?? 2));
  const results: Exclude<UploadQueueWorkerResult, { kind: 'idle' }>[] = [];
  await Promise.all(Array.from({ length: concurrency }, async (_, index) => {
    while (true) {
      const result = await runNextUploadTask({
        ...options,
        workerId: `${options.workerId}-${index}`,
      });
      if (result.kind === 'idle') return;
      results.push(result);
      await options.onResult?.(result);
      // A retryable failure is scheduled for later and should not busy-loop.
      if (result.kind === 'failed') return;
    }
  }));
  return results;
}
