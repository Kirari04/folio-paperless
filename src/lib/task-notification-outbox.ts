import type { FolioRepository } from '../types/persistence.ts';
import type { PersistentTask } from '../types/tasks.ts';

function createDispatchId(task: PersistentTask) {
  return globalThis.crypto?.randomUUID?.()
    ?? `folio-${task.profileId}-${task.id}-${Date.now()}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 180);
}

/**
 * Claims one durable completion-notification outbox row. Foreground and
 * background callers may race, but only the lease owner dispatches. A crash
 * after scheduling reuses the persisted native identifier on retry, allowing
 * the OS notification request to replace rather than duplicate the delivery.
 */
export async function dispatchTaskNotification(input: {
  repository: FolioRepository;
  task: PersistentTask;
  workerId: string;
  now?: () => Date;
  notify(deliveryId: string): Promise<void>;
}) {
  const now = input.now ?? (() => new Date());
  const claim = await input.repository.claimTaskNotification(
    input.task.profileId,
    input.task.id,
    input.workerId,
    createDispatchId(input.task),
    now(),
  );
  if (!claim) return { kind: 'not-claimed' as const, task: input.task };
  try {
    await input.notify(claim.dispatchId);
    const completed = await input.repository.completeTaskNotification(claim, now());
    if (!completed) throw new Error('The notification outbox lease changed before completion.');
    return { kind: 'sent' as const, task: completed };
  } catch (error) {
    await input.repository.releaseTaskNotification(claim, now()).catch(() => false);
    throw error;
  }
}
