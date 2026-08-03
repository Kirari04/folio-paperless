import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUncorrelatedPdfOperationTask,
  createPersistentBulkOperationTask,
  createTrackedPaperlessOperationTask,
  acquireTaskLease,
  cancelTask,
  classifyTaskFailure,
  confirmUploadResubmission,
  groupTasksByBatch,
  isTaskRetryDue,
  nextAutomaticRetryAt,
  nextRetryStage,
  migratePersistentTask,
  normalizePersistentBulkOperation,
  prepareFailedBulkOutcomesForRetry,
  replacePendingBulkOutcomes,
  retryDelayMs,
  scheduleTaskRetry,
  summarizeBatch,
  transitionTask,
} from '../src/lib/task-policy.ts';

function task(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'job-1',
    profileId: 'profile-a',
    kind: 'upload',
    stage: 'queued',
    source: 'picker',
    progress: 0,
    retryCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('rejects impossible task transitions', () => {
  assert.throws(() => transitionTask(task(), 'ready'), /Invalid task transition/);
});

test('stores a task ID before retrying processing without re-uploading', () => {
  assert.equal(nextRetryStage(task({ stage: 'failed', paperlessTaskId: 'task-42' })), 'processing');
  assert.equal(nextRetryStage(task({ stage: 'failed' })), 'queued');
});

test('classifies retryable and permanent failures', () => {
  assert.equal(classifyTaskFailure(429, 'Slow down').retryable, true);
  assert.equal(classifyTaskFailure(503, 'Unavailable').retryable, true);
  assert.equal(classifyTaskFailure(401, 'Expired token').retryable, false);
  assert.equal(classifyTaskFailure(403, 'Forbidden').retryable, false);
  assert.equal(classifyTaskFailure(undefined, 'No such file').code, 'missing-file');
});

test('uses bounded exponential retry delays with deterministic jitter', () => {
  assert.equal(retryDelayMs(0, { jitter: 0, baseMs: 1000, maxMs: 4000 }), 1000);
  assert.equal(retryDelayMs(2, { jitter: 0, baseMs: 1000, maxMs: 4000 }), 4000);
  assert.equal(retryDelayMs(20, { jitter: 0, baseMs: 1000, maxMs: 4000 }), 4000);
});

test('stops scheduling retries after the bounded limit', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const scheduled = scheduleTaskRetry(
    task({ retryCount: 1 }),
    { code: 'network', message: 'offline', retryable: true },
    now,
    2,
  );
  assert.equal(scheduled.retryCount, 2);
  assert.equal(scheduled.error.retryable, true);
  assert.equal(isTaskRetryDue(scheduled, new Date('2027-01-01T00:00:00.000Z')), true);

  const terminal = scheduleTaskRetry(scheduled, scheduled.error, now, 2);
  assert.equal(terminal.retryCount, 3);
  assert.equal(terminal.error.retryable, false);
  assert.equal(terminal.nextAttemptAt, undefined);
});

test('leases prevent duplicate workers until expiry', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const leased = acquireTaskLease(task(), 'foreground', now, 1000);
  assert.equal(leased.leaseOwner, 'foreground');
  assert.equal(acquireTaskLease(leased, 'background', new Date(now.getTime() + 500)), null);
  assert.equal(
    acquireTaskLease(leased, 'background', new Date(now.getTime() + 1001)).leaseOwner,
    'background',
  );
});

test('canceling accepted work does not claim server cancellation', () => {
  const canceled = cancelTask(task({ stage: 'processing', paperlessTaskId: 'task-42' }));
  assert.equal(canceled.stage, 'canceled');
  assert.equal(canceled.cancellationDisposition, 'acceptance-uncertain');
  assert.match(canceled.result.summary, /could not be ruled out/);
});

test('only an unleased pre-upload task is classified as definitely local cancellation', () => {
  const local = cancelTask(task({ localUri: 'private://queued.pdf' }), new Date('2026-01-01T00:00:00Z'));
  const leased = cancelTask(task({
    localUri: 'private://leased.pdf',
    leaseOwner: 'worker',
    leaseExpiresAt: '2026-01-01T00:01:00Z',
  }), new Date('2026-01-01T00:00:00Z'));
  const uploading = cancelTask(task({ stage: 'uploading', localUri: 'private://active.pdf' }));
  assert.equal(local.cancellationDisposition, 'local');
  assert.equal(leased.cancellationDisposition, 'acceptance-uncertain');
  assert.equal(uploading.cancellationDisposition, 'acceptance-uncertain');
});

test('batch summaries preserve mixed results', () => {
  assert.deepEqual(
    summarizeBatch([
      task({ id: 'a', stage: 'ready' }),
      task({ id: 'b', stage: 'failed' }),
      task({ id: 'c', stage: 'processing' }),
      task({ id: 'd', stage: 'canceled' }),
    ]),
    { succeeded: 1, failed: 1, canceled: 1, active: 1 },
  );
});

test('batch grouping keeps mixed outcomes together and isolates profiles', () => {
  const groups = groupTasksByBatch([
    task({ id: 'a', batchId: 'share-1', stage: 'ready', updatedAt: '2026-01-01T00:00:01Z' }),
    task({ id: 'b', batchId: 'share-1', stage: 'failed', updatedAt: '2026-01-01T00:00:02Z' }),
    task({ id: 'c', batchId: 'share-1', profileId: 'profile-b', stage: 'ready' }),
    task({ id: 'single', stage: 'processing', updatedAt: '2026-01-01T00:00:03Z' }),
  ], 'profile-a');
  assert.equal(groups.length, 2);
  assert.equal(groups.find((group) => group.batchId === 'share-1').tasks.length, 2);
  assert.deepEqual(groups.find((group) => group.batchId === 'share-1').summary, {
    succeeded: 1,
    failed: 1,
    canceled: 0,
    active: 0,
  });
});

test('foreground retry wake-up survives restart, honors nextAttemptAt, and scopes profiles', () => {
  const restored = [
    task({
      id: 'later',
      stage: 'failed',
      error: { code: 'network', message: 'offline', retryable: true },
      nextAttemptAt: '2026-01-01T00:02:00Z',
    }),
    task({
      id: 'earlier',
      stage: 'failed',
      error: { code: 'server', message: 'retry', retryable: true },
      nextAttemptAt: '2026-01-01T00:01:00Z',
    }),
    task({
      id: 'other-profile',
      profileId: 'profile-b',
      stage: 'failed',
      error: { code: 'network', message: 'retry', retryable: true },
      nextAttemptAt: '2026-01-01T00:00:10Z',
    }),
    task({
      id: 'metadata-worker-owned',
      kind: 'metadata-update',
      stage: 'failed',
      error: { code: 'network', message: 'retry', retryable: true },
      nextAttemptAt: '2026-01-01T00:00:05Z',
    }),
  ].map((stored) => migratePersistentTask({ ...stored, schemaVersion: 4 }));
  assert.equal(
    nextAutomaticRetryAt(restored, 'profile-a', new Date('2026-01-01T00:00:00Z')),
    Date.parse('2026-01-01T00:01:00Z'),
  );
  assert.equal(
    nextAutomaticRetryAt(restored, 'profile-b', new Date('2026-01-01T00:00:00Z')),
    Date.parse('2026-01-01T00:00:10Z'),
  );
});

test('foreground wake-up does not schedule interrupted upload submission after lease expiry', () => {
  const restored = [
    task({
      id: 'interrupted-upload',
      stage: 'uploading',
      leaseOwner: 'terminated-process',
      leaseExpiresAt: '2026-01-01T00:07:00Z',
    }),
    task({
      id: 'other-profile-upload',
      profileId: 'profile-b',
      stage: 'uploading',
      leaseOwner: 'terminated-process',
      leaseExpiresAt: '2026-01-01T00:01:00Z',
    }),
  ].map((stored) => migratePersistentTask(stored));

  assert.equal(
    nextAutomaticRetryAt(restored, 'profile-a', new Date('2026-01-01T00:00:00Z')),
    undefined,
  );
  assert.equal(restored[0].stage, 'submission-uncertain');
  assert.equal(restored[0].error.retryable, false);
});

test('submission-uncertain upload requires explicit duplicate-risk confirmation before resubmission', () => {
  const uncertain = migratePersistentTask(task({
    schemaVersion: 4,
    stage: 'submission-uncertain',
    localUri: 'private://invoice.pdf',
    metadata: { title: { state: 'value', value: 'Edited invoice' } },
    error: {
      code: 'submission-uncertain',
      message: 'Check Paperless before submitting again.',
      retryable: false,
    },
  }));
  assert.throws(
    () => confirmUploadResubmission(uncertain, { userConfirmedDuplicateRisk: false }),
    /Explicit confirmation/,
  );
  assert.throws(
    () => confirmUploadResubmission({
      ...uncertain,
      leaseOwner: 'active-worker',
      leaseExpiresAt: '2026-01-01T00:03:00Z',
    }, { userConfirmedDuplicateRisk: true }, new Date('2026-01-01T00:02:00Z')),
    /still active/,
  );
  const resubmitted = confirmUploadResubmission(
    uncertain,
    { userConfirmedDuplicateRisk: true },
    new Date('2026-01-01T00:02:00Z'),
  );
  assert.equal(resubmitted.stage, 'queued');
  assert.equal(resubmitted.error, undefined);
  assert.equal(resubmitted.localUri, 'private://invoice.pdf');
  assert.equal(resubmitted.metadata.title.value, 'Edited invoice');
});

test('canceling submission-uncertain work retains bytes and reports possible server acceptance', () => {
  const canceled = cancelTask(task({
    schemaVersion: 4,
    stage: 'submission-uncertain',
    localUri: 'private://uncertain.pdf',
  }));
  assert.equal(canceled.stage, 'canceled');
  assert.equal(canceled.cancellationDisposition, 'acceptance-uncertain');
  assert.equal(canceled.localUri, 'private://uncertain.pdf');
  assert.match(canceled.result.summary, /could not be ruled out/);
});

test('uncorrelated PDF endpoints retain an honest non-retryable attention item', () => {
  const completed = createUncorrelatedPdfOperationTask({
    id: 'local-pdf-1',
    profileId: 'profile-a',
    documentId: 42,
    operation: 'Rotate pages',
    now: new Date('2026-08-02T12:00:00.000Z'),
  });
  assert.equal(completed.stage, 'failed');
  assert.equal(completed.paperlessTaskId, undefined);
  assert.equal(completed.result.remoteDocumentId, 42);
  assert.match(completed.result.summary, /could not be identified/);
  assert.equal(completed.error.retryable, false);
  assert.equal(completed.completedAt, undefined);
});

test('accepted bulk work stays processing until the Paperless task reaches a terminal state', () => {
  const pending = createTrackedPaperlessOperationTask({
    id: 'local-bulk-1',
    profileId: 'profile-a',
    paperlessTaskId: 'server-task-1',
    kind: 'bulk-operation',
    name: 'Reprocess',
    summary: 'Accepted for two documents.',
    now: new Date('2026-08-02T12:00:00.000Z'),
  });
  assert.equal(pending.stage, 'processing');
  assert.equal(pending.completedAt, undefined);
  assert.equal(pending.paperlessTaskId, 'server-task-1');
  assert.equal(pending.result.summary, 'Accepted for two documents.');
});

test('durable bulk tasks normalize their operation and retain exact target outcomes', () => {
  const pending = createPersistentBulkOperationTask({
    id: 'bulk-doc-42',
    profileId: 'profile-a',
    batchId: 'bulk-batch-1',
    name: 'Add tags',
    summary: 'Accepted',
    operation: { kind: 'tags', mode: 'add', tagIds: [9, 3, 9] },
    targets: [
      { localId: 'doc-local-42', remoteDocumentId: 42 },
      { localId: 'doc-local-43', remoteDocumentId: 43 },
    ],
    outcomes: [
      { localId: 'doc-local-42', remoteDocumentId: 42, state: 'pending' },
      { localId: 'doc-local-43', remoteDocumentId: 43, state: 'pending' },
    ],
    paperlessTaskId: 'server-task-42',
    now: new Date('2026-08-02T12:00:00.000Z'),
  });
  assert.equal(pending.schemaVersion, 4);
  assert.deepEqual(pending.bulk, {
    operation: { kind: 'tags', mode: 'add', tagIds: [3, 9] },
    targets: [
      { localId: 'doc-local-42', remoteDocumentId: 42 },
      { localId: 'doc-local-43', remoteDocumentId: 43 },
    ],
  });
  assert.deepEqual(pending.result.bulkOutcomes, [
    {
      localId: 'doc-local-42',
      remoteDocumentId: 42,
      state: 'pending',
      paperlessTaskId: 'server-task-42',
    },
    {
      localId: 'doc-local-43',
      remoteDocumentId: 43,
      state: 'pending',
      paperlessTaskId: 'server-task-42',
    },
  ]);

  const completed = replacePendingBulkOutcomes(pending, 'succeeded');
  assert.deepEqual(completed.result.bulkOutcomes.map((outcome) => outcome.state), [
    'succeeded', 'succeeded',
  ]);
});

test('failed-only bulk retry preserves successes and skipped targets', () => {
  const failure = { code: 'rate-limited', message: 'Slow down', retryable: true, status: 429 };
  const retried = prepareFailedBulkOutcomesForRetry(task({
    kind: 'bulk-operation',
    stage: 'failed',
    paperlessTaskId: 'terminal-server-task',
    error: failure,
    result: {
      bulkOutcomes: [
        { localId: 'one', remoteDocumentId: 1, state: 'succeeded' },
        {
          localId: 'two', remoteDocumentId: 2, state: 'failed',
          paperlessTaskId: 'terminal-server-task', error: failure,
        },
        { localId: 'three', state: 'skipped', skipReason: 'not-remote' },
      ],
    },
  }));
  assert.deepEqual(retried.result.bulkOutcomes.map((outcome) => outcome.state), [
    'succeeded', 'pending', 'skipped',
  ]);
  assert.equal(retried.stage, 'queued');
  assert.equal(retried.paperlessTaskId, undefined);
  assert.equal(retried.result.bulkOutcomes[1].paperlessTaskId, undefined);
});

test('bulk retry resumes polling an accepted task after transient connectivity loss', () => {
  const timeout = { code: 'timeout', message: 'Task is still processing', retryable: true };
  const retried = prepareFailedBulkOutcomesForRetry(task({
    kind: 'bulk-operation',
    stage: 'failed',
    paperlessTaskId: 'server-task-still-running',
    error: timeout,
    result: {
      bulkOutcomes: [
        {
          localId: 'one',
          remoteDocumentId: 1,
          state: 'failed',
          paperlessTaskId: 'server-task-still-running',
          error: timeout,
        },
      ],
    },
  }));

  assert.equal(retried.stage, 'processing');
  assert.equal(retried.paperlessTaskId, 'server-task-still-running');
  assert.equal(retried.result.bulkOutcomes[0].state, 'pending');
  assert.equal(retried.result.bulkOutcomes[0].paperlessTaskId, 'server-task-still-running');
});

test('schema v1 migration never invents a missing bulk operation payload', () => {
  const migrated = migratePersistentTask(task({
    schemaVersion: 1,
    kind: 'bulk-operation',
    paperlessTaskId: 'legacy-server-task',
  }));
  assert.equal(migrated.schemaVersion, 4);
  assert.equal(migrated.bulk, undefined);
  assert.deepEqual(normalizePersistentBulkOperation({
    kind: 'file', inboxTagIds: [8, 2, 8],
  }), { kind: 'file', inboxTagIds: [2, 8] });
});

test('schema migrations preserve exact original names and conservatively retain old canceled staging', () => {
  const originalName = '../Invoice\u202E?.pdf';
  const exact = migratePersistentTask(task({ schemaVersion: 2, originalName }));
  const legacyFallback = migratePersistentTask(task({
    schemaVersion: 2,
    id: 'legacy',
    originalName: undefined,
    stagedName: 'legacy-Invoice-.pdf',
  }));
  const canceled = migratePersistentTask(task({
    schemaVersion: 2,
    stage: 'canceled',
    localUri: 'private://unknown-acceptance.pdf',
  }));
  assert.equal(exact.originalName, originalName);
  assert.equal(legacyFallback.originalName, 'Invoice-.pdf');
  assert.equal(canceled.cancellationDisposition, 'acceptance-uncertain');
});
