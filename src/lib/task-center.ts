import type { FolioRepository } from '../types/persistence.ts';
import type { PersistentTask } from '../types/tasks.ts';
import type { TranslationKey } from '../i18n/catalogs.ts';
import { translateRuntime } from '../i18n/runtime.ts';
import {
  cancelTask,
  confirmUploadResubmission,
  nextRetryStage,
  prepareFailedBulkOutcomesForRetry,
  summarizeBulkOutcomes,
} from './task-policy.ts';

export type TaskCenterCategory = 'active' | 'failed' | 'completed' | 'canceled';

export type TaskCenterProjection = {
  id: string;
  profileId: string;
  kind: PersistentTask['kind'];
  category: TaskCenterCategory;
  stage: PersistentTask['stage'];
  title: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
  latestError?: string;
  paperlessTaskId?: string;
  serverAcceptance: 'not-accepted' | 'accepted' | 'unknown';
  cancellationMeaning: 'cancel-local-work' | 'stop-local-tracking' | 'acceptance-uncertain' | null;
  actions: {
    retry: boolean;
    resubmit: boolean;
    cancel: boolean;
    deleteRecord: boolean;
    openResult: boolean;
  };
  resultRouteId?: string;
  remoteDocumentId?: number;
  bulkSummary?: ReturnType<typeof summarizeBulkOutcomes>;
};

export type TaskCenterSnapshot = {
  profileId: string;
  tasks: TaskCenterProjection[];
  counts: Record<TaskCenterCategory, number>;
};

export type TaskCenterActionResult =
  | { kind: 'updated'; task: PersistentTask; serverMayContinue: boolean }
  | { kind: 'deleted'; taskId: string }
  | { kind: 'not-found' }
  | { kind: 'not-allowed'; detail: string };

export interface LocalTaskCancellationPort {
  requestCancellation(task: PersistentTask): Promise<void> | void;
}

function category(task: PersistentTask): TaskCenterCategory {
  if (task.stage === 'failed' || task.stage === 'submission-uncertain') return 'failed';
  if (task.stage === 'ready') return 'completed';
  if (task.stage === 'canceled') return 'canceled';
  return 'active';
}

function serverAcceptance(task: PersistentTask): TaskCenterProjection['serverAcceptance'] {
  if (task.paperlessTaskId || task.stage === 'processing') return 'accepted';
  if (task.stage === 'uploading' || task.stage === 'submission-uncertain') return 'unknown';
  return 'not-accepted';
}

function title(task: PersistentTask) {
  return task.originalName
    ?? task.stagedName
    ?? translateRuntime(`tasks.kind.${task.kind}` as TranslationKey);
}

export function taskResultRouteId(task: PersistentTask) {
  // Paperless PDF endpoints can report a short-lived consume job document ID
  // even when the operation ultimately updates the original document. The
  // durable source identity is therefore the only safe route for PDF jobs.
  if (task.kind === 'pdf-operation' && task.documentId) return task.documentId;
  return task.result?.routeDocumentId
    ?? (task.result?.remoteDocumentId ? `remote-${task.result.remoteDocumentId}` : undefined);
}

export function projectTask(task: PersistentTask): TaskCenterProjection {
  const taskCategory = category(task);
  const acceptance = serverAcceptance(task);
  const active = taskCategory === 'active';
  const cancellable = active || taskCategory === 'failed';
  const resultRouteId = taskResultRouteId(task);
  const bulkSummary = task.result?.bulkOutcomes
    ? summarizeBulkOutcomes(task.result.bulkOutcomes)
    : undefined;
  const retryableBulkFailure = task.result?.bulkOutcomes?.some(
    (outcome) => outcome.state === 'failed' && outcome.error?.retryable === true,
  ) ?? false;
  const submissionAttemptActive = !!task.leaseOwner
    && !!task.leaseExpiresAt;
  return {
    id: task.id,
    profileId: task.profileId,
    kind: task.kind,
    category: taskCategory,
    stage: task.stage,
    title: title(task),
    progress: Math.max(0, Math.min(1, Number.isFinite(task.progress) ? task.progress : 0)),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    latestError: task.error?.message,
    paperlessTaskId: task.paperlessTaskId,
    serverAcceptance: acceptance,
    cancellationMeaning: !cancellable
      ? null
      : acceptance === 'accepted'
        ? 'stop-local-tracking'
        : acceptance === 'unknown'
          ? 'acceptance-uncertain'
          : 'cancel-local-work',
    actions: {
      retry: task.stage === 'failed'
        && (task.kind === 'bulk-operation' ? retryableBulkFailure : task.error?.retryable === true),
      resubmit: task.kind === 'upload'
        && task.stage === 'submission-uncertain'
        && !submissionAttemptActive,
      cancel: cancellable,
      deleteRecord: task.stage === 'ready' || task.stage === 'canceled',
      openResult: !!resultRouteId,
    },
    resultRouteId,
    remoteDocumentId: task.result?.remoteDocumentId,
    bulkSummary,
  };
}

export class TaskCenterService {
  private readonly repository: FolioRepository;
  private readonly cancellation?: LocalTaskCancellationPort;
  private readonly now: () => Date;

  constructor(
    repository: FolioRepository,
    cancellation?: LocalTaskCancellationPort,
    now: () => Date = () => new Date(),
  ) {
    this.repository = repository;
    this.cancellation = cancellation;
    this.now = now;
  }

  async snapshot(profileId: string): Promise<TaskCenterSnapshot> {
    const tasks = (await this.repository.listTasks(profileId)).map(projectTask);
    const counts: Record<TaskCenterCategory, number> = {
      active: 0,
      failed: 0,
      completed: 0,
      canceled: 0,
    };
    for (const task of tasks) counts[task.category] += 1;
    return { profileId, tasks, counts };
  }

  async retry(profileId: string, taskId: string): Promise<TaskCenterActionResult> {
    const task = await this.repository.readTask(profileId, taskId);
    if (!task) return { kind: 'not-found' };
    const retryableBulkFailure = task.kind === 'bulk-operation'
      && task.result?.bulkOutcomes?.some(
        (outcome) => outcome.state === 'failed' && outcome.error?.retryable === true,
      );
    if (task.stage !== 'failed' || (task.error?.retryable !== true && !retryableBulkFailure)) {
      return { kind: 'not-allowed', detail: translateRuntime('taskRuntime.retryOnly') };
    }
    const updatedAt = this.now().toISOString();
    const prepared = task.kind === 'bulk-operation'
      ? prepareFailedBulkOutcomesForRetry(task)
      : task;
    const retried: PersistentTask = {
      ...prepared,
      stage: nextRetryStage(prepared),
      error: undefined,
      nextAttemptAt: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      completedAt: undefined,
      updatedAt,
    };
    await this.repository.writeTask(retried);
    return { kind: 'updated', task: retried, serverMayContinue: false };
  }

  async resubmit(
    profileId: string,
    taskId: string,
    userConfirmedDuplicateRisk: boolean,
  ): Promise<TaskCenterActionResult> {
    const task = await this.repository.readTask(profileId, taskId);
    if (!task) return { kind: 'not-found' };
    if (task.kind !== 'upload' || task.stage !== 'submission-uncertain') {
      return { kind: 'not-allowed', detail: translateRuntime('taskRuntime.retryOnly') };
    }
    if (!userConfirmedDuplicateRisk) {
      return {
        kind: 'not-allowed',
        detail: 'Confirm that Paperless was checked and that resubmission may create a duplicate.',
      };
    }
    const resubmitted = confirmUploadResubmission(
      task,
      { userConfirmedDuplicateRisk },
      this.now(),
    );
    await this.repository.writeTask(resubmitted);
    return { kind: 'updated', task: resubmitted, serverMayContinue: true };
  }

  async cancel(profileId: string, taskId: string): Promise<TaskCenterActionResult> {
    const task = await this.repository.readTask(profileId, taskId);
    if (!task) return { kind: 'not-found' };
    if (task.stage === 'ready' || task.stage === 'canceled') {
      return { kind: 'not-allowed', detail: translateRuntime('taskRuntime.noLongerRunning') };
    }
    await this.cancellation?.requestCancellation(task);
    const acceptance = serverAcceptance(task);
    let canceled = cancelTask(task, this.now());
    if (acceptance === 'unknown') {
      canceled = {
        ...canceled,
        result: {
          ...canceled.result,
          summary: translateRuntime('taskRuntime.cancelUncertain'),
        },
      };
    }
    await this.repository.writeTask(canceled);
    return {
      kind: 'updated',
      task: canceled,
      serverMayContinue: acceptance !== 'not-accepted',
    };
  }

  async deleteRecord(profileId: string, taskId: string): Promise<TaskCenterActionResult> {
    const task = await this.repository.readTask(profileId, taskId);
    if (!task) return { kind: 'not-found' };
    if (task.stage !== 'ready' && task.stage !== 'canceled') {
      return {
        kind: 'not-allowed',
        detail: translateRuntime('taskRuntime.dismissTerminalOnly'),
      };
    }
    await this.repository.deleteTask(profileId, taskId);
    return { kind: 'deleted', taskId };
  }
}
