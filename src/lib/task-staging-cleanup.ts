import { translateRuntime } from '../i18n/runtime.ts';
import type { PersistentTask } from '../types/tasks.ts';

type StagedFileCleanupOptions = {
  remove(profileId: string, uri: string): Promise<void>;
  writeTask(task: PersistentTask): Promise<void>;
  now?: Date;
};

type StagedFileDeletionOptions = StagedFileCleanupOptions & {
  deleteTask(profileId: string, taskId: string): Promise<void>;
};

export class StagedFileCleanupError extends Error {
  readonly code = 'staged-file-cleanup-failed';
  readonly task: PersistentTask;

  constructor(task: PersistentTask) {
    super(task.error?.message ?? translateRuntime('taskRuntime.stagedCleanupFailed'));
    this.name = 'StagedFileCleanupError';
    this.task = task;
  }
}

function withCleanupFailure(task: PersistentTask, now = new Date()): PersistentTask {
  return {
    ...task,
    error: {
      code: 'cleanup-failed',
      message: translateRuntime('taskRuntime.stagedCleanupFailed'),
      retryable: true,
    },
    updatedAt: now.toISOString(),
  };
}

async function retainCleanupFailure(
  task: PersistentTask,
  options: StagedFileCleanupOptions,
): Promise<never> {
  const retained = withCleanupFailure(task, options.now);
  await options.writeTask(retained);
  throw new StagedFileCleanupError(retained);
}

export async function clearStagedFileReference(
  task: PersistentTask,
  options: StagedFileCleanupOptions,
) {
  if (!task.localUri) return task;
  try {
    await options.remove(task.profileId, task.localUri);
  } catch {
    return retainCleanupFailure(task, options);
  }
  const cleared: PersistentTask = {
    ...task,
    localUri: undefined,
    stagedName: undefined,
    error: task.error?.code === 'cleanup-failed' ? undefined : task.error,
    updatedAt: (options.now ?? new Date()).toISOString(),
  };
  await options.writeTask(cleared);
  return cleared;
}

export async function deleteTaskAfterStagedFileCleanup(
  task: PersistentTask,
  options: StagedFileDeletionOptions,
) {
  if (task.localUri) {
    try {
      await options.remove(task.profileId, task.localUri);
    } catch {
      return retainCleanupFailure(task, options);
    }
  }
  await options.deleteTask(task.profileId, task.id);
}
