import type {
  PersistentBulkItemOutcome,
  PersistentBulkTaskTarget,
  PersistentTask,
  PersistentTaskError,
  PersistentTaskStage,
} from '../types/tasks.ts';
import { PERSISTED_TASK_SCHEMA_VERSION } from '../types/tasks.ts';
import type { PaperlessBulkOperation } from '../types/paperless-advanced.ts';
import { translateRuntime } from '../i18n/runtime.ts';

const TERMINAL_STAGES = new Set<PersistentTaskStage>(['ready', 'canceled']);
const UNCLAIMABLE_STAGES = new Set<PersistentTaskStage>([
  ...TERMINAL_STAGES,
  'submission-uncertain',
]);
const transitions: Record<PersistentTaskStage, ReadonlySet<PersistentTaskStage>> = {
  preparing: new Set(['queued', 'failed', 'canceled']),
  queued: new Set(['uploading', 'submission-uncertain', 'processing', 'failed', 'canceled']),
  uploading: new Set(['submission-uncertain', 'processing', 'failed', 'canceled']),
  'submission-uncertain': new Set(['queued', 'processing', 'canceled']),
  processing: new Set(['ready', 'failed', 'canceled']),
  ready: new Set(),
  failed: new Set(['queued', 'processing', 'canceled']),
  canceled: new Set(),
};

export const DEFAULT_MAX_RETRIES = 6;
export const DEFAULT_BASE_BACKOFF_MS = 5_000;
export const DEFAULT_MAX_BACKOFF_MS = 15 * 60_000;

function positiveIds(values: readonly number[], label: string) {
  if (!values.every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error(`${label} must contain positive integer IDs.`);
  }
  return [...new Set(values)].sort((left, right) => left - right);
}

/** Produces the stable operation representation written to disk. Endpoint
 * method names and compatibility shims intentionally do not belong here. */
export function normalizePersistentBulkOperation(
  operation: PaperlessBulkOperation,
): PaperlessBulkOperation {
  if (operation.kind === 'tags') {
    return {
      kind: 'tags',
      mode: operation.mode,
      tagIds: positiveIds(operation.tagIds, 'Tag IDs'),
    };
  }
  if (operation.kind === 'file') {
    return {
      kind: 'file',
      inboxTagIds: positiveIds(operation.inboxTagIds, 'Inbox tag IDs'),
    };
  }
  if (
    operation.kind === 'setCorrespondent'
    || operation.kind === 'setDocumentType'
    || operation.kind === 'setStoragePath'
    || operation.kind === 'setOwner'
  ) {
    if (operation.value !== null && (!Number.isSafeInteger(operation.value) || operation.value <= 0)) {
      throw new Error('Bulk metadata IDs must be positive integers or null.');
    }
    return { kind: operation.kind, value: operation.value };
  }
  if (operation.kind === 'reprocess' || operation.kind === 'trash') {
    return { kind: operation.kind };
  }
  throw new Error('Unsupported persisted bulk operation.');
}

export function normalizePersistentBulkTargets(
  targets: readonly PersistentBulkTaskTarget[],
) {
  const normalized: PersistentBulkTaskTarget[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const localId = target.localId.trim();
    if (!localId) throw new Error('A bulk target requires a stable local ID.');
    if (
      target.remoteDocumentId !== undefined
      && (!Number.isSafeInteger(target.remoteDocumentId) || target.remoteDocumentId <= 0)
    ) throw new Error('A remote bulk target ID must be a positive integer.');
    const key = target.remoteDocumentId ? `remote-${target.remoteDocumentId}` : `local-${localId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      localId,
      ...(target.remoteDocumentId ? { remoteDocumentId: target.remoteDocumentId } : {}),
    });
  }
  if (!normalized.length) throw new Error('A bulk task requires at least one target.');
  return normalized;
}

export function summarizeBulkOutcomes(outcomes: readonly PersistentBulkItemOutcome[]) {
  return outcomes.reduce(
    (summary, outcome) => {
      summary[outcome.state] += 1;
      return summary;
    },
    { pending: 0, succeeded: 0, failed: 0, skipped: 0 },
  );
}

export function replacePendingBulkOutcomes(
  task: PersistentTask,
  state: 'succeeded' | 'failed',
  error?: PersistentTaskError,
): PersistentTask {
  if (task.kind !== 'bulk-operation' || !task.result?.bulkOutcomes) return task;
  return {
    ...task,
    result: {
      ...task.result,
      bulkOutcomes: task.result.bulkOutcomes.map((outcome) => (
        outcome.state !== 'pending'
          ? outcome
          : {
              ...outcome,
              state,
              ...(state === 'failed' && error ? { error } : {}),
            }
      )),
    },
  };
}

export function prepareFailedBulkOutcomesForRetry(task: PersistentTask): PersistentTask {
  if (task.kind !== 'bulk-operation' || !task.result?.bulkOutcomes) return task;
  const hasRetryableFailure = task.result.bulkOutcomes.some(
    (outcome) => outcome.state === 'failed' && outcome.error?.retryable === true,
  );
  if (!hasRetryableFailure) return task;
  const resumesAcceptedTask = !!task.paperlessTaskId
    && (task.error?.code === 'network' || task.error?.code === 'timeout');
  return {
    ...task,
    stage: resumesAcceptedTask ? 'processing' : 'queued',
    error: undefined,
    nextAttemptAt: undefined,
    completedAt: undefined,
    // A terminal Paperless task ID identifies the failed attempt. Clearing it
    // is what makes the queue submit the failed subset instead of polling the
    // same terminal task again after a restart or manual retry. Connectivity
    // and still-processing failures retain it so accepted work is only polled.
    paperlessTaskId: resumesAcceptedTask ? task.paperlessTaskId : undefined,
    result: {
      ...task.result,
      bulkOutcomes: task.result.bulkOutcomes.map((outcome) => (
        outcome.state === 'failed' && outcome.error?.retryable === true
          ? {
              ...outcome,
              state: 'pending' as const,
              error: undefined,
              paperlessTaskId: resumesAcceptedTask ? outcome.paperlessTaskId : undefined,
            }
          : outcome
      )),
    },
  };
}

export function createPersistentBulkOperationTask(input: {
  id: string;
  profileId: string;
  batchId: string;
  name: string;
  summary: string;
  operation: PaperlessBulkOperation;
  targets: readonly PersistentBulkTaskTarget[];
  outcomes: readonly PersistentBulkItemOutcome[];
  paperlessTaskId?: string;
  error?: PersistentTaskError;
  now?: Date;
}): PersistentTask {
  const timestamp = (input.now ?? new Date()).toISOString();
  const targets = normalizePersistentBulkTargets(input.targets);
  const operation = normalizePersistentBulkOperation(input.operation);
  const paperlessTaskId = input.paperlessTaskId?.trim();
  if (paperlessTaskId !== undefined && !/^[A-Za-z0-9._:-]{1,256}$/.test(paperlessTaskId)) {
    throw new Error('A persisted Paperless task ID is invalid.');
  }
  const targetByIdentity = new Map(targets.map((target) => [
    target.remoteDocumentId ? `remote-${target.remoteDocumentId}` : `local-${target.localId}`,
    target,
  ]));
  const outcomeByIdentity = new Map<string, PersistentBulkItemOutcome>();
  for (const candidate of input.outcomes) {
    const normalized = normalizePersistentBulkTargets([candidate])[0];
    const identity = normalized.remoteDocumentId
      ? `remote-${normalized.remoteDocumentId}`
      : `local-${normalized.localId}`;
    const target = targetByIdentity.get(identity);
    if (!target) throw new Error('A bulk outcome must belong to the persisted target set.');
    if (target.localId !== normalized.localId) {
      throw new Error('A bulk outcome must retain its target local ID.');
    }
    if (outcomeByIdentity.has(identity)) throw new Error('A bulk target requires exactly one outcome.');
    const outcomeTaskId = candidate.paperlessTaskId?.trim();
    if (outcomeTaskId !== undefined && !/^[A-Za-z0-9._:-]{1,256}$/.test(outcomeTaskId)) {
      throw new Error('A bulk outcome Paperless task ID is invalid.');
    }
    if (
      candidate.state === 'pending'
      && paperlessTaskId
      && outcomeTaskId
      && outcomeTaskId !== paperlessTaskId
    ) throw new Error('A pending bulk outcome must retain the shared Paperless task ID.');
    outcomeByIdentity.set(identity, {
      ...target,
      state: candidate.state,
      ...(candidate.state === 'pending' && paperlessTaskId
        ? { paperlessTaskId }
        : outcomeTaskId ? { paperlessTaskId: outcomeTaskId } : {}),
      ...(candidate.error ? { error: candidate.error } : {}),
      ...(candidate.skipReason ? { skipReason: candidate.skipReason } : {}),
    });
  }
  const outcomes = targets.map((target) => {
    const identity = target.remoteDocumentId
      ? `remote-${target.remoteDocumentId}`
      : `local-${target.localId}`;
    const outcome = outcomeByIdentity.get(identity);
    if (!outcome) throw new Error('A bulk target requires exactly one outcome.');
    return outcome;
  });
  const hasPending = outcomes.some((outcome) => outcome.state === 'pending');
  const hasFailed = outcomes.some((outcome) => outcome.state === 'failed');
  const stage: PersistentTaskStage = hasPending
    ? paperlessTaskId ? 'processing' : 'queued'
    : hasFailed ? 'failed' : 'ready';
  const onlyTarget = targets.length === 1 ? targets[0] : undefined;
  const onlyOutcome = outcomes.length === 1 ? outcomes[0] : undefined;
  const taskError = input.error ?? outcomes.find((outcome) => outcome.state === 'failed')?.error;
  return {
    schemaVersion: PERSISTED_TASK_SCHEMA_VERSION,
    id: input.id,
    profileId: input.profileId,
    batchId: input.batchId,
    kind: 'bulk-operation',
    stage,
    source: 'unknown',
    originalName: input.name,
    ...(onlyTarget?.remoteDocumentId ? { documentId: `remote-${onlyTarget.remoteDocumentId}` } : {}),
    progress: stage === 'ready' || stage === 'processing' ? 1 : 0,
    ...(paperlessTaskId ? { paperlessTaskId } : {}),
    bulk: { operation, targets },
    retryCount: 0,
    ...(taskError ? { error: taskError } : {}),
    result: {
      ...(onlyTarget?.remoteDocumentId ? {
        remoteDocumentId: onlyTarget.remoteDocumentId,
        ...(onlyOutcome?.state === 'succeeded' && operation.kind !== 'trash'
          ? { routeDocumentId: `remote-${onlyTarget.remoteDocumentId}` }
          : {}),
      } : {}),
      summary: input.summary,
      bulkOutcomes: outcomes,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(stage === 'ready' ? { completedAt: timestamp } : {}),
  };
}

/** JSON payload migration. Version 1 bulk tasks did not retain enough data to
 * reconstruct an operation or its full target set, so migration preserves the
 * honest historical record without inventing a retry payload. */
export function migratePersistentTask(value: unknown): PersistentTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored task data is invalid.');
  }
  const task = value as Omit<PersistentTask, 'schemaVersion'> & { schemaVersion?: number };
  if (![1, 2, 3, PERSISTED_TASK_SCHEMA_VERSION].includes(task.schemaVersion ?? -1)) {
    throw new Error(`Unsupported persisted task schema version ${String(task.schemaVersion)}.`);
  }
  const legacySchemaVersion = task.schemaVersion ?? -1;
  const interruptedSubmission = task.kind === 'upload'
    && !task.paperlessTaskId
    && (
      task.stage === 'uploading'
      || (
        legacySchemaVersion < PERSISTED_TASK_SCHEMA_VERSION
        && task.stage === 'failed'
        && (task.error?.code === 'network' || task.error?.code === 'timeout')
      )
    );
  const uncertainLeaseExpired = task.stage === 'submission-uncertain'
    && !!task.leaseOwner
    && (!task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) <= Date.now());
  const stagedFallback = !task.originalName && task.stagedName
    ? task.stagedName.startsWith(`${task.id}-`)
      ? task.stagedName.slice(task.id.length + 1)
      : task.stagedName
    : undefined;
  return {
    ...task,
    schemaVersion: PERSISTED_TASK_SCHEMA_VERSION,
    ...(task.originalName ? {} : stagedFallback ? { originalName: stagedFallback } : {}),
    // Old canceled records do not retain the pre-cancel stage. Preserve their
    // bytes conservatively instead of assuming Paperless never saw them.
    ...(task.stage === 'canceled' && task.localUri && !task.cancellationDisposition
      ? { cancellationDisposition: 'acceptance-uncertain' as const }
      : {}),
    ...(interruptedSubmission ? {
      stage: 'submission-uncertain' as const,
      error: {
        code: 'submission-uncertain' as const,
        message: task.error?.message
          ?? 'The upload was interrupted after submission may have started. Check Paperless before submitting it again.',
        retryable: false,
      },
      nextAttemptAt: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    } : {}),
    ...(uncertainLeaseExpired ? {
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    } : {}),
  } as PersistentTask;
}

export function createUncorrelatedPdfOperationTask(input: {
  id: string;
  profileId: string;
  documentId: number;
  operation: string;
  summary?: string;
  now?: Date;
}): PersistentTask {
  const timestamp = (input.now ?? new Date()).toISOString();
  return {
    schemaVersion: PERSISTED_TASK_SCHEMA_VERSION,
    id: input.id,
    profileId: input.profileId,
    kind: 'pdf-operation',
    stage: 'failed',
    source: 'unknown',
    originalName: input.operation,
    documentId: `remote-${input.documentId}`,
    progress: 0,
    retryCount: 0,
    result: {
      remoteDocumentId: input.documentId,
      routeDocumentId: `remote-${input.documentId}`,
      summary: input.summary ?? translateRuntime('taskRuntime.pdfUncorrelated', { operation: input.operation }),
    },
    error: {
      code: 'unknown',
      message: input.summary ?? translateRuntime('taskRuntime.pdfUncorrelated', { operation: input.operation }),
      retryable: false,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createTrackedPaperlessOperationTask(input: {
  id: string;
  profileId: string;
  paperlessTaskId: string;
  kind: 'bulk-operation' | 'pdf-operation';
  name: string;
  summary: string;
  documentId?: number;
  now?: Date;
}): PersistentTask {
  const timestamp = (input.now ?? new Date()).toISOString();
  return {
    schemaVersion: PERSISTED_TASK_SCHEMA_VERSION,
    id: input.id,
    profileId: input.profileId,
    kind: input.kind,
    stage: 'processing',
    source: 'unknown',
    originalName: input.name,
    ...(input.documentId ? { documentId: `remote-${input.documentId}` } : {}),
    progress: 1,
    paperlessTaskId: input.paperlessTaskId,
    retryCount: 0,
    result: {
      ...(input.documentId ? { remoteDocumentId: input.documentId } : {}),
      summary: input.summary,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function canTransitionTask(from: PersistentTaskStage, to: PersistentTaskStage) {
  return from === to || transitions[from].has(to);
}

export function transitionTask(
  task: PersistentTask,
  stage: PersistentTaskStage,
  now = new Date(),
): PersistentTask {
  if (!canTransitionTask(task.stage, stage)) {
    throw new Error(translateRuntime('taskRuntime.invalidTransition', { from: task.stage, to: stage }));
  }

  return {
    ...task,
    stage,
    updatedAt: now.toISOString(),
    completedAt: TERMINAL_STAGES.has(stage) ? now.toISOString() : undefined,
  };
}

export function classifyTaskFailure(status?: number, message = ''): PersistentTaskError {
  const normalized = message.toLocaleLowerCase();
  if (status === 401) {
    return { code: 'authentication', message, retryable: false, status };
  }
  if (status === 403) return { code: 'permission', message, retryable: false, status };
  if (status === 409) return { code: 'conflict', message, retryable: false, status };
  if (status === 404) return { code: 'missing-file', message, retryable: false, status };
  if (status === 429) return { code: 'rate-limited', message, retryable: true, status };
  if (status && status >= 500) return { code: 'server', message, retryable: true, status };
  if (/timed? out|timeout|aborterror|still processing|task.*pending/.test(normalized)) {
    return { code: 'timeout', message, retryable: true, status };
  }
  if (/network|connection|offline|dns|socket/.test(normalized)) {
    return { code: 'network', message, retryable: true, status };
  }
  if (/no such file|not found|missing|unreadable|permission denied/.test(normalized)) {
    return { code: 'missing-file', message, retryable: false, status };
  }
  if (/unsupported|mime|file type|empty file|too large/.test(normalized)) {
    return { code: 'unsupported-file', message, retryable: false, status };
  }
  if (/processing|consume|duplicate|ocr|archive/.test(normalized)) {
    return { code: 'processing-failed', message, retryable: false, status };
  }
  return { code: 'unknown', message, retryable: false, status };
}

export function retryDelayMs(
  retryCount: number,
  options: {
    baseMs?: number;
    maxMs?: number;
    jitter?: number;
    random?: () => number;
  } = {},
) {
  const baseMs = options.baseMs ?? DEFAULT_BASE_BACKOFF_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_BACKOFF_MS;
  const jitter = Math.max(0, Math.min(1, options.jitter ?? 0.2));
  const random = options.random ?? Math.random;
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, retryCount));
  const jitterMultiplier = 1 - jitter + random() * jitter * 2;
  return Math.max(baseMs, Math.round(exponential * jitterMultiplier));
}

export function scheduleTaskRetry(
  task: PersistentTask,
  error: PersistentTaskError,
  now = new Date(),
  maxRetries = DEFAULT_MAX_RETRIES,
): PersistentTask {
  const retryCount = task.retryCount + 1;
  const canRetry = error.retryable && retryCount <= maxRetries;
  return {
    ...task,
    stage: 'failed',
    error: { ...error, retryable: canRetry },
    retryCount,
    lastAttemptAt: now.toISOString(),
    nextAttemptAt: canRetry
      ? new Date(now.getTime() + retryDelayMs(task.retryCount)).toISOString()
      : undefined,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    updatedAt: now.toISOString(),
  };
}

export function nextRetryStage(task: PersistentTask): PersistentTaskStage {
  return task.paperlessTaskId ? 'processing' : 'queued';
}

/** Clears an ambiguous upload submission only after an owning UI has obtained
 * explicit confirmation. Paperless does not accept a client idempotency key,
 * so callers must warn that this can create a duplicate before invoking it. */
export function confirmUploadResubmission(
  task: PersistentTask,
  confirmation: { userConfirmedDuplicateRisk: boolean },
  now = new Date(),
): PersistentTask {
  if (
    task.kind !== 'upload'
    || task.stage !== 'submission-uncertain'
    || task.paperlessTaskId
  ) {
    throw new Error('Only an upload with uncertain server acceptance can be explicitly resubmitted.');
  }
  if (confirmation.userConfirmedDuplicateRisk !== true) {
    throw new Error('Explicit confirmation is required because resubmission may create a duplicate.');
  }
  const leaseExpiry = task.leaseExpiresAt ? Date.parse(task.leaseExpiresAt) : 0;
  if (task.leaseOwner && leaseExpiry > now.getTime()) {
    throw new Error('The original upload attempt is still active and cannot be resubmitted.');
  }
  return {
    ...transitionTask(task, 'queued', now),
    progress: 0,
    error: undefined,
    nextAttemptAt: undefined,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    completedAt: undefined,
  };
}

export function isTaskRetryDue(task: PersistentTask, now = new Date()) {
  return task.stage === 'failed'
    && !!task.error?.retryable
    && (!task.nextAttemptAt || Date.parse(task.nextAttemptAt) <= now.getTime());
}

/** Selects the next retry wake-up for the active connection. This pure policy
 * is intentionally independent from React so restart and profile isolation can
 * be tested without relying on a screen lifecycle. */
export function nextAutomaticRetryAt(
  tasks: readonly PersistentTask[],
  profileId: string,
  now = new Date(),
) {
  let earliest: number | undefined;
  for (const task of tasks) {
    if (
      task.profileId === profileId
      && ['upload', 'paperless-processing', 'pdf-operation', 'bulk-operation'].includes(task.kind)
      && ['queued', 'uploading', 'processing'].includes(task.stage)
    ) {
      const leaseExpiry = task.leaseExpiresAt ? Date.parse(task.leaseExpiresAt) : now.getTime();
      const wakeAt = Number.isFinite(leaseExpiry) ? Math.max(now.getTime(), leaseExpiry) : now.getTime();
      earliest = earliest === undefined ? wakeAt : Math.min(earliest, wakeAt);
      continue;
    }
    if (
      task.profileId === profileId
      && task.kind === 'offline-download'
      && ['queued', 'uploading'].includes(task.stage)
    ) {
      const leaseExpiry = task.leaseExpiresAt ? Date.parse(task.leaseExpiresAt) : now.getTime();
      const wakeAt = Number.isFinite(leaseExpiry) ? Math.max(now.getTime(), leaseExpiry) : now.getTime();
      earliest = earliest === undefined ? wakeAt : Math.min(earliest, wakeAt);
      continue;
    }
    if (
      task.profileId !== profileId
      || !['upload', 'paperless-processing', 'pdf-operation', 'bulk-operation', 'offline-download'].includes(task.kind)
      || task.stage !== 'failed'
      || task.error?.retryable !== true
    ) continue;
    const retryAt = task.nextAttemptAt ? Date.parse(task.nextAttemptAt) : now.getTime();
    if (!Number.isFinite(retryAt)) continue;
    earliest = earliest === undefined ? retryAt : Math.min(earliest, retryAt);
  }
  return earliest;
}

export function acquireTaskLease(
  task: PersistentTask,
  owner: string,
  now = new Date(),
  leaseMs = 2 * 60_000,
): PersistentTask | null {
  const existingExpiry = task.leaseExpiresAt ? Date.parse(task.leaseExpiresAt) : 0;
  if (task.leaseOwner && task.leaseOwner !== owner && existingExpiry > now.getTime()) return null;
  if (UNCLAIMABLE_STAGES.has(task.stage)) return null;
  return {
    ...task,
    leaseOwner: owner,
    leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function taskCancellationMeaning(
  task: PersistentTask,
  now = new Date(),
): 'local' | 'acceptance-uncertain' {
  // Offline downloads have no server-side mutation to accept. Aborting their
  // local transfer is always an honest local cancellation, even while leased.
  if (task.kind === 'offline-download') return 'local';
  const leaseExpiry = task.leaseExpiresAt ? Date.parse(task.leaseExpiresAt) : 0;
  const hasActiveWorker = !!task.leaseOwner && leaseExpiry > now.getTime();
  const definitelyLocal = !task.paperlessTaskId
    && !hasActiveWorker
    && ['preparing', 'queued', 'failed'].includes(task.stage);
  return definitelyLocal ? 'local' : 'acceptance-uncertain';
}

export function cancelTask(task: PersistentTask, now = new Date()): PersistentTask {
  if (task.stage === 'ready' || task.stage === 'canceled') return task;
  const cancellationDisposition = taskCancellationMeaning(task, now);
  return {
    ...task,
    stage: 'canceled',
    cancelRequestedAt: now.toISOString(),
    completedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    cancellationDisposition,
    result: cancellationDisposition === 'acceptance-uncertain'
      ? {
          ...task.result,
          summary: translateRuntime('taskRuntime.cancelUncertain'),
        }
      : task.result,
  };
}

export function summarizeBatch(tasks: readonly PersistentTask[]) {
  return tasks.reduce(
    (summary, task) => {
      if (task.stage === 'ready') summary.succeeded += 1;
      else if (task.stage === 'failed' || task.stage === 'submission-uncertain') summary.failed += 1;
      else if (task.stage === 'canceled') summary.canceled += 1;
      else summary.active += 1;
      return summary;
    },
    { succeeded: 0, failed: 0, canceled: 0, active: 0 },
  );
}

export function groupTasksByBatch(
  tasks: readonly PersistentTask[],
  profileId?: string,
) {
  const groups = new Map<string, PersistentTask[]>();
  for (const task of tasks) {
    if (profileId && task.profileId !== profileId) continue;
    const key = task.batchId ? `batch:${task.batchId}` : `task:${task.id}`;
    const group = groups.get(key) ?? [];
    group.push(task);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, batchTasks]) => {
      const sortedTasks = batchTasks.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      return {
        key,
        batchId: sortedTasks[0].batchId,
        tasks: sortedTasks,
        summary: summarizeBatch(sortedTasks),
        updatedAt: sortedTasks.reduce(
          (latest, task) => task.updatedAt.localeCompare(latest) > 0 ? task.updatedAt : latest,
          sortedTasks[0].updatedAt,
        ),
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
