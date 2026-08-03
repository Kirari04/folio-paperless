import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import type { BackgroundRegistrationPort } from './background-sync';

export const expoBackgroundRegistrationPort: BackgroundRegistrationPort = {
  async availability() {
    try {
      const available = await TaskManager.isAvailableAsync();
      if (!available) return 'unavailable';
      const status = await BackgroundTask.getStatusAsync();
      return status === BackgroundTask.BackgroundTaskStatus.Available ? 'available' : 'restricted';
    } catch {
      return 'unavailable';
    }
  },
  isDefined(taskName) {
    return TaskManager.isTaskDefined(taskName);
  },
  isRegistered(taskName) {
    return TaskManager.isTaskRegisteredAsync(taskName);
  },
  register(taskName, minimumIntervalMinutes) {
    return BackgroundTask.registerTaskAsync(taskName, {
      minimumInterval: minimumIntervalMinutes,
    });
  },
  unregister(taskName) {
    return BackgroundTask.unregisterTaskAsync(taskName);
  },
};

export function defineExpoBackgroundTask(
  taskName: string,
  executor: () => Promise<'success' | 'failed'>,
) {
  if (TaskManager.isTaskDefined(taskName)) return;
  // Call this function from global module scope. TaskManager cannot define a
  // headless task from a mounted React component.
  TaskManager.defineTask(taskName, async () => {
    try {
      const result = await executor();
      return result === 'success'
        ? BackgroundTask.BackgroundTaskResult.Success
        : BackgroundTask.BackgroundTaskResult.Failed;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}
