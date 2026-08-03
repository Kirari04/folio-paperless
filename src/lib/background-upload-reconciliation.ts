import type { FolioRepository } from '../types/persistence.ts';
import type { PersistentTask } from '../types/tasks.ts';
import { translateRuntime } from '../i18n/runtime.ts';

function isUploadResult(task: PersistentTask) {
  return task.kind === 'upload' || task.kind === 'paperless-processing';
}

export function needsForegroundUploadReconciliation(
  task: PersistentTask,
  profileId: string,
) {
  return task.profileId === profileId
    && task.stage === 'ready'
    && isUploadResult(task)
    && !task.foregroundReconciledAt;
}

/**
 * Records that a terminal background upload needs UI-owned work. The ready
 * task is already durable before this marker is written, so a process kill in
 * either order is recovered by the foreground sweep.
 */
export async function requestForegroundUploadReconciliation(input: {
  profileId: string;
  repository: FolioRepository;
  task: PersistentTask;
  now?: () => Date;
}) {
  if (!needsForegroundUploadReconciliation(input.task, input.profileId)) return input.task;
  const latest = await input.repository.readTask(input.profileId, input.task.id);
  if (!latest || !needsForegroundUploadReconciliation(latest, input.profileId)) return latest;
  const requested = {
    ...latest,
    foregroundReconciliationRequestedAt:
      latest.foregroundReconciliationRequestedAt ?? (input.now ?? (() => new Date()))().toISOString(),
  };
  await input.repository.writeTask(requested);
  return requested;
}

export type UploadReconciliationResult = {
  failed: { error: string; task: PersistentTask }[];
  reconciled: PersistentTask[];
};

/**
 * Replays foreground-only side effects for terminal uploads. The callback is
 * invoked before the completion marker, and the task is re-read afterwards so
 * notification fields written by the callback cannot be lost to a stale write.
 */
export async function reconcilePendingUploadResults(input: {
  profileId: string;
  repository: FolioRepository;
  reconcile: (task: PersistentTask) => Promise<void>;
  now?: () => Date;
  onTaskChange?: (task: PersistentTask) => Promise<void> | void;
}): Promise<UploadReconciliationResult> {
  const candidates = (await input.repository.listTasks(input.profileId))
    .filter((task) => needsForegroundUploadReconciliation(task, input.profileId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const reconciled: PersistentTask[] = [];
  const failed: UploadReconciliationResult['failed'] = [];

  for (const candidate of candidates) {
    try {
      await input.reconcile(candidate);
      const latest = await input.repository.readTask(input.profileId, candidate.id);
      if (!latest || !needsForegroundUploadReconciliation(latest, input.profileId)) continue;
      const completed = {
        ...latest,
        foregroundReconciledAt: (input.now ?? (() => new Date()))().toISOString(),
      };
      await input.repository.writeTask(completed);
      await input.onTaskChange?.(completed);
      reconciled.push(completed);
    } catch (error) {
      failed.push({
        task: candidate,
        error: error instanceof Error ? error.message : translateRuntime('taskRuntime.reconcileFailed'),
      });
    }
  }
  return { failed, reconciled };
}
