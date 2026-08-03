import type { OfflineFileRecord, FolioRepository } from '../types/persistence.ts';
import type { PersistentTask } from '../types/tasks.ts';
import { classifyTaskFailure, scheduleTaskRetry } from './task-policy.ts';
import { translateRuntime } from '../i18n/runtime.ts';

export type OfflineDownloadTransport = {
  resolve(task: PersistentTask): Promise<OfflineFileRecord | null>;
  download(
    task: PersistentTask,
    options: {
      signal: AbortSignal;
      onProgress: (progress: number) => void;
    },
  ): Promise<OfflineFileRecord>;
};

export type OfflineDownloadWorkerResult =
  | { kind: 'idle' }
  | { kind: 'ready'; task: PersistentTask; file: OfflineFileRecord }
  | { kind: 'failed'; task: PersistentTask }
  | { kind: 'canceled'; task: PersistentTask }
  | { kind: 'revoked'; task: PersistentTask };

class OfflineDownloadLeaseLostError extends Error {
  constructor() {
    super(translateRuntime('taskRuntime.offlineLeaseLost'));
    this.name = 'OfflineDownloadLeaseLostError';
  }
}

function failureStatus(error: unknown) {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

export async function runNextOfflineDownload(options: {
  profileId: string;
  workerId: string;
  repository: FolioRepository;
  transport: OfflineDownloadTransport;
  now?: () => Date;
  executionGuard?: () => boolean | Promise<boolean>;
  onTaskChange?: (task: PersistentTask) => void | Promise<void>;
  onController?: (task: PersistentTask, controller: AbortController | null) => void;
}): Promise<OfflineDownloadWorkerResult> {
  const now = options.now ?? (() => new Date());
  let task = await options.repository.claimNextOfflineDownloadTask(
    options.profileId,
    options.workerId,
    now(),
  );
  if (!task) return { kind: 'idle' };
  const controller = new AbortController();
  options.onController?.(task, controller);

  const executionIsCurrent = async () => !options.executionGuard || await options.executionGuard();
  const persistWithFreshLease = async (
    update: (lease: PersistentTask, timestamp: Date) => PersistentTask,
  ) => {
    if (!await executionIsCurrent()) throw new OfflineDownloadLeaseLostError();
    const timestamp = now();
    const lease = await options.repository.renewTaskLease(
      task!.profileId,
      task!.id,
      options.workerId,
      timestamp,
    );
    if (!lease) throw new OfflineDownloadLeaseLostError();
    const next = update(lease, timestamp);
    const committed = await options.repository.updateLeasedTask(lease, next, timestamp);
    if (!committed) throw new OfflineDownloadLeaseLostError();
    task = committed;
    await options.onTaskChange?.(committed);
    return committed;
  };

  try {
    if (!task.documentId || !task.offlineRepresentation) {
      throw new Error(translateRuntime('appError.offlineRepresentationMissing'));
    }
    await persistWithFreshLease((lease, timestamp) => ({
      ...lease,
      stage: 'uploading',
      progress: Math.max(0, Math.min(lease.progress, 0.99)),
      error: undefined,
      nextAttemptAt: undefined,
      lastAttemptAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
    }));

    // Recovery for the crash window after the file record was committed but
    // before its task reached ready. This prevents a second network transfer.
    let file = await options.transport.resolve(task);
    if (!file) {
      let progressTail = Promise.resolve();
      let lastProgress = task.progress;
      file = await options.transport.download(task, {
        signal: controller.signal,
        onProgress(progress) {
          const bounded = Math.max(0, Math.min(0.99, progress));
          if (bounded <= lastProgress || bounded - lastProgress < 0.01) return;
          lastProgress = bounded;
          progressTail = progressTail.then(async () => {
            if (controller.signal.aborted) return;
            await persistWithFreshLease((lease, timestamp) => ({
              ...lease,
              stage: 'uploading',
              progress: bounded,
              updatedAt: timestamp.toISOString(),
            }));
          }).catch(() => controller.abort());
        },
      });
      await progressTail;
      if (controller.signal.aborted) throw new OfflineDownloadLeaseLostError();
    }

    const ready = await persistWithFreshLease((lease, timestamp) => ({
      ...lease,
      stage: 'ready',
      progress: 1,
      error: undefined,
      nextAttemptAt: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      completedAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
      result: {
        ...lease.result,
        routeDocumentId: lease.documentId,
        summary: translateRuntime('taskRuntime.offlineAvailable', {
          representation: translateRuntime(lease.offlineRepresentation === 'archive'
            ? 'fileActions.archive'
            : 'fileActions.original').toLocaleLowerCase(),
        }),
      },
    }));
    return { kind: 'ready', task: ready, file };
  } catch (error) {
    const latest = await options.repository.readTask(task.profileId, task.id);
    if (latest?.stage === 'canceled') return { kind: 'canceled', task: latest };
    if (error instanceof OfflineDownloadLeaseLostError || controller.signal.aborted) {
      return { kind: 'revoked', task: latest ?? task };
    }
    const message = error instanceof Error
      ? error.message
      : translateRuntime('taskRuntime.offlineStoreFailed');
    try {
      const failed = await persistWithFreshLease((lease, timestamp) => scheduleTaskRetry(
        lease,
        classifyTaskFailure(failureStatus(error), message),
        timestamp,
      ));
      return { kind: 'failed', task: failed };
    } catch (commitError) {
      const retained = await options.repository.readTask(task.profileId, task.id);
      if (retained?.stage === 'canceled') return { kind: 'canceled', task: retained };
      if (commitError instanceof OfflineDownloadLeaseLostError) {
        return { kind: 'revoked', task: retained ?? task };
      }
      throw commitError;
    }
  } finally {
    options.onController?.(task, null);
  }
}

export async function drainOfflineDownloads(options: {
  profileId: string;
  workerId: string;
  repository: FolioRepository;
  transport: OfflineDownloadTransport;
  executionGuard?: () => boolean | Promise<boolean>;
  onTaskChange?: (task: PersistentTask) => void | Promise<void>;
  onController?: (task: PersistentTask, controller: AbortController | null) => void;
  onResult?: (result: Exclude<OfflineDownloadWorkerResult, { kind: 'idle' }>) => void | Promise<void>;
}) {
  const results: Exclude<OfflineDownloadWorkerResult, { kind: 'idle' }>[] = [];
  while (true) {
    const result = await runNextOfflineDownload(options);
    if (result.kind === 'idle') break;
    results.push(result);
    await options.onResult?.(result);
    if (result.kind !== 'ready') break;
  }
  return results;
}
