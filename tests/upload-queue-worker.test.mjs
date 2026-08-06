import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryFolioRepository } from '../src/lib/memory-repository.ts';
import { drainUploadQueue, runNextUploadTask } from '../src/lib/upload-queue-worker.ts';
import { cancelTask } from '../src/lib/task-policy.ts';

function queuedTask(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'job-1',
    profileId: 'profile-a',
    kind: 'upload',
    stage: 'queued',
    source: 'picker',
    localUri: 'private://file.pdf',
    progress: 0,
    retryCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('persists task ID before polling and reconciles the remote result', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask());
  const observed = [];
  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'foreground',
    repository,
    now: () => new Date('2026-01-01T00:00:01.000Z'),
    transport: {
      async upload(_task, progress) {
        await progress(0.5);
        return 'paperless-task-1';
      },
      async poll(task) {
        observed.push(task);
        return { documentId: 42 };
      },
    },
  });
  assert.equal(observed[0].paperlessTaskId, 'paperless-task-1');
  assert.equal(result.kind, 'ready');
  assert.equal(result.task.result.remoteDocumentId, 42);
});

test('post-upload metadata runs only after the remote identity is durable', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask());
  const finalized = [];
  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'foreground',
    repository,
    now: () => new Date('2026-01-01T00:00:01.000Z'),
    transport: {
      async upload() { return 'paperless-task-owner'; },
      async poll() { return { documentId: 52 }; },
      async finalizeMetadata(task, remote) {
        const persisted = await repository.readTask('profile-a', 'job-1');
        assert.equal(task.result.remoteDocumentId, 52);
        assert.equal(persisted.result.remoteDocumentId, 52);
        assert.equal(persisted.paperlessTaskId, 'paperless-task-owner');
        assert.equal(remote.documentId, 52);
        finalized.push(remote.documentId);
      },
    },
  });
  assert.deepEqual(finalized, [52]);
  assert.equal(result.kind, 'ready');
});

test('failed owner post-processing keeps the created document and staged draft repairable', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask({
    metadata: {
      title: { state: 'unset' }, created: { state: 'unset' },
      correspondent: { state: 'unset' }, documentType: { state: 'unset' },
      tags: { state: 'unset' }, storagePath: { state: 'unset' },
      archiveSerialNumber: { state: 'unset' },
      owner: { state: 'value', value: { id: 'remote-owner-7', remoteId: 7, name: 'Owner' } },
      workflow: { state: 'unset' }, customFields: [],
    },
  }));
  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'foreground',
    repository,
    now: () => new Date('2026-01-01T00:00:01.000Z'),
    transport: {
      async upload() { return 'paperless-task-owner-failed'; },
      async poll() { return { documentId: 53 }; },
      async finalizeMetadata() {
        const error = new Error('Paperless created the document, but owner assignment was forbidden.');
        error.status = 403;
        throw error;
      },
    },
  });
  assert.equal(result.kind, 'failed');
  assert.equal(result.task.error.code, 'permission');
  assert.equal(result.task.error.retryable, false);
  assert.equal(result.task.paperlessTaskId, 'paperless-task-owner-failed');
  assert.equal(result.task.result.remoteDocumentId, 53);
  assert.equal(result.task.localUri, 'private://file.pdf');
  assert.equal(result.task.metadata.owner.value.remoteId, 7);
});

test('restart recovery with a Paperless task ID never uploads again', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask({
    stage: 'processing',
    paperlessTaskId: 'paperless-task-1',
  }));
  let uploadCalls = 0;
  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'relaunch',
    repository,
    transport: {
      async upload() { uploadCalls += 1; return 'wrong'; },
      async poll() { return { documentId: 44 }; },
    },
  });
  assert.equal(uploadCalls, 0);
  assert.equal(result.task.result.remoteDocumentId, 44);
});

test('restart recovery never resubmits an interrupted upload with no durable Paperless task ID', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask({
    stage: 'uploading',
    progress: 0.4,
    leaseOwner: 'terminated-process',
    leaseExpiresAt: '2026-01-01T00:00:01.000Z',
  }));
  let uploadCalls = 0;
  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'relaunch',
    repository,
    now: () => new Date('2026-01-01T00:00:02.000Z'),
    transport: {
      async upload() { uploadCalls += 1; return 'paperless-task-after-restart'; },
      async poll() { return { documentId: 45 }; },
    },
  });
  assert.equal(uploadCalls, 0);
  assert.equal(result.kind, 'idle');
  const persisted = await repository.readTask('profile-a', 'job-1');
  assert.equal(persisted.stage, 'submission-uncertain');
  assert.equal(persisted.error.code, 'submission-uncertain');
  assert.equal(persisted.error.retryable, false);
});

test('timeout after Paperless acceptance is durable and never automatically resubmitted', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask({ schemaVersion: 4 }));
  let uploadCalls = 0;
  let serverAcceptances = 0;
  const first = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'foreground',
    repository,
    now: () => new Date('2026-01-01T00:00:01.000Z'),
    transport: {
      async upload() {
        uploadCalls += 1;
        assert.equal(
          (await repository.readTask('profile-a', 'job-1')).stage,
          'submission-uncertain',
        );
        serverAcceptances += 1;
        throw new Error('Paperless did not reply before the upload timed out.');
      },
      async poll() { throw new Error('must not poll without a task ID'); },
    },
  });
  assert.equal(first.kind, 'failed');
  assert.equal(first.task.stage, 'submission-uncertain');
  assert.equal(first.task.error.code, 'submission-uncertain');
  assert.equal(first.task.error.retryable, false);
  assert.equal(first.task.nextAttemptAt, undefined);

  const restarted = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'relaunch',
    repository,
    now: () => new Date('2027-01-01T00:00:00.000Z'),
    transport: {
      async upload() { uploadCalls += 1; return 'duplicate-task'; },
      async poll() { throw new Error('must not poll'); },
    },
  });
  assert.equal(restarted.kind, 'idle');
  assert.equal(uploadCalls, 1);
  assert.equal(serverAcceptances, 1);
});

test('a crash snapshot at the pre-POST boundary remains stopped after lease expiry', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask({
    schemaVersion: 4,
    stage: 'submission-uncertain',
    leaseOwner: 'terminated-process',
    leaseExpiresAt: '2026-01-01T00:00:01.000Z',
  }));
  let uploadCalls = 0;
  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'relaunch',
    repository,
    now: () => new Date('2026-01-01T00:00:02.000Z'),
    transport: {
      async upload() { uploadCalls += 1; return 'must-not-submit'; },
      async poll() { throw new Error('must not poll'); },
    },
  });
  assert.equal(result.kind, 'idle');
  assert.equal(uploadCalls, 0);
  assert.equal((await repository.readTask('profile-a', 'job-1')).stage, 'submission-uncertain');
});

test('a shared asynchronous bulk task survives restart and completes every pending outcome', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask({
    schemaVersion: 2,
    id: 'bulk-shared',
    kind: 'bulk-operation',
    source: 'unknown',
    stage: 'processing',
    localUri: undefined,
    paperlessTaskId: 'paperless-bulk-shared',
    bulk: {
      operation: { kind: 'tags', mode: 'add', tagIds: [7] },
      targets: [
        { localId: 'one', remoteDocumentId: 1 },
        { localId: 'two', remoteDocumentId: 2 },
      ],
    },
    result: {
      bulkOutcomes: [
        {
          localId: 'one', remoteDocumentId: 1, state: 'pending',
          paperlessTaskId: 'paperless-bulk-shared',
        },
        {
          localId: 'two', remoteDocumentId: 2, state: 'pending',
          paperlessTaskId: 'paperless-bulk-shared',
        },
      ],
    },
  }));
  let uploadCalls = 0;
  let pollCalls = 0;

  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'bulk-relaunch',
    repository,
    transport: {
      async upload() { uploadCalls += 1; return 'wrong'; },
      async poll(task) {
        pollCalls += 1;
        assert.equal(task.paperlessTaskId, 'paperless-bulk-shared');
        return { summary: 'Bulk operation complete.' };
      },
    },
  });

  assert.equal(uploadCalls, 0);
  assert.equal(pollCalls, 1);
  assert.equal(result.kind, 'ready');
  assert.deepEqual(result.task.result.bulkOutcomes.map((outcome) => outcome.state), [
    'succeeded', 'succeeded',
  ]);
});

test('automatic bulk retry resubmits only retryable failed outcomes', async () => {
  const repository = new MemoryFolioRepository();
  const failure = { code: 'rate-limited', message: 'Slow down', retryable: true, status: 429 };
  await repository.writeTask(queuedTask({
    schemaVersion: 2,
    id: 'bulk-retry-subset',
    kind: 'bulk-operation',
    source: 'unknown',
    stage: 'failed',
    localUri: undefined,
    paperlessTaskId: 'terminal-bulk-attempt',
    error: failure,
    nextAttemptAt: '2026-01-01T00:00:00.000Z',
    bulk: {
      operation: { kind: 'tags', mode: 'add', tagIds: [7] },
      targets: [
        { localId: 'one', remoteDocumentId: 1 },
        { localId: 'two', remoteDocumentId: 2 },
        { localId: 'three', remoteDocumentId: 3 },
      ],
    },
    result: {
      bulkOutcomes: [
        { localId: 'one', remoteDocumentId: 1, state: 'succeeded' },
        {
          localId: 'two', remoteDocumentId: 2, state: 'failed',
          paperlessTaskId: 'terminal-bulk-attempt', error: failure,
        },
        { localId: 'three', remoteDocumentId: 3, state: 'skipped', skipReason: 'read-only' },
      ],
    },
  }));
  let submittedPendingIds;

  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'bulk-auto-retry',
    repository,
    now: () => new Date('2026-01-01T00:00:01.000Z'),
    transport: {
      async upload() { throw new Error('must not upload'); },
      async poll() { throw new Error('must not poll a synchronous retry'); },
      async submitBulk(task) {
        submittedPendingIds = task.result.bulkOutcomes
          .filter((outcome) => outcome.state === 'pending')
          .map((outcome) => outcome.remoteDocumentId);
        assert.equal(task.paperlessTaskId, undefined);
        return { summary: 'Retry complete.' };
      },
    },
  });

  assert.deepEqual(submittedPendingIds, [2]);
  assert.equal(result.kind, 'ready');
  assert.deepEqual(result.task.result.bulkOutcomes.map((outcome) => outcome.state), [
    'succeeded', 'succeeded', 'skipped',
  ]);
});

test('a durable PDF operation is claimed after restart and only polls its Paperless task', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask({
    id: 'pdf-1',
    kind: 'pdf-operation',
    source: 'unknown',
    stage: 'processing',
    localUri: undefined,
    paperlessTaskId: 'paperless-pdf-task-1',
    documentId: 'remote-44',
    result: { remoteDocumentId: 44 },
  }));
  let uploadCalls = 0;
  let pollCalls = 0;
  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'background-relaunch',
    repository,
    transport: {
      async upload() { uploadCalls += 1; return 'wrong'; },
      async poll(task) {
        pollCalls += 1;
        assert.equal(task.paperlessTaskId, 'paperless-pdf-task-1');
        return { documentId: 99, summary: 'PDF rotation complete.' };
      },
    },
  });
  assert.equal(uploadCalls, 0);
  assert.equal(pollCalls, 1);
  assert.equal(result.kind, 'ready');
  assert.equal(result.task.result.summary, 'PDF rotation complete.');
  assert.equal(result.task.result.remoteDocumentId, 44);
  assert.equal(result.task.result.routeDocumentId, undefined);
});

test('a failed PDF consume job remains a durable non-retryable Task Center failure', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask({
    id: 'pdf-failed',
    kind: 'pdf-operation',
    source: 'unknown',
    stage: 'processing',
    localUri: undefined,
    paperlessTaskId: 'paperless-pdf-failed',
    documentId: 'remote-44',
  }));
  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'after-restart',
    repository,
    transport: {
      async upload() { throw new Error('must not upload'); },
      async poll() { throw new Error('PDF consume failed while parsing the edited file.'); },
    },
  });
  assert.equal(result.kind, 'failed');
  assert.equal(result.task.error.code, 'processing-failed');
  assert.equal(result.task.error.retryable, false);
  assert.equal((await repository.readTask('profile-a', 'pdf-failed')).stage, 'failed');
});

test('concurrent PDF jobs are leased and completed exactly once', async () => {
  const repository = new MemoryFolioRepository();
  for (const [id, paperlessTaskId] of [['pdf-a', 'paperless-a'], ['pdf-b', 'paperless-b']]) {
    await repository.writeTask(queuedTask({
      id,
      kind: 'pdf-operation',
      source: 'unknown',
      stage: 'processing',
      localUri: undefined,
      paperlessTaskId,
    }));
  }
  const polled = [];
  const results = await drainUploadQueue({
    profileId: 'profile-a',
    workerId: 'concurrent',
    repository,
    concurrency: 2,
    transport: {
      async upload() { throw new Error('must not upload'); },
      async poll(task) {
        polled.push(task.paperlessTaskId);
        return { summary: `${task.paperlessTaskId} complete` };
      },
    },
  });
  assert.deepEqual(new Set(polled), new Set(['paperless-a', 'paperless-b']));
  assert.equal(polled.length, 2);
  assert.equal(results.filter((result) => result.kind === 'ready').length, 2);
});

test('queue draining stops before later tasks when its execution binding is revoked', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask({ id: 'job-1' }));
  await repository.writeTask(queuedTask({
    id: 'job-2',
    createdAt: '2026-01-01T00:00:01.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  }));
  let executionCurrent = true;
  let uploadCalls = 0;
  let pollCalls = 0;

  const results = await drainUploadQueue({
    profileId: 'profile-a',
    workerId: 'generation-bound',
    repository,
    concurrency: 1,
    executionGuard: () => executionCurrent,
    transport: {
      async upload() {
        uploadCalls += 1;
        executionCurrent = false;
        return 'accepted-by-revoked-connection';
      },
      async poll() {
        pollCalls += 1;
        return { documentId: 44 };
      },
    },
  });

  assert.equal(uploadCalls, 1);
  assert.equal(pollCalls, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].kind, 'failed');
  assert.equal((await repository.readTask('profile-a', 'job-2')).stage, 'queued');
});

test('a revoked execution binding is checked before claiming an upload task', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask());

  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'revoked-before-claim',
    repository,
    executionGuard: () => false,
    transport: {
      async upload() { throw new Error('must not upload'); },
      async poll() { throw new Error('must not poll'); },
    },
  });

  assert.deepEqual(result, { kind: 'idle' });
  assert.equal((await repository.readTask('profile-a', 'job-1')).leaseOwner, undefined);
});

test('duplicate candidates are persisted with a completed upload for review', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask({
    stage: 'processing',
    paperlessTaskId: 'paperless-task-duplicate',
  }));
  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'foreground',
    repository,
    transport: {
      async upload() { throw new Error('must not upload'); },
      async poll() { return { documentId: 44, duplicateDocumentIds: [3, 8] }; },
    },
  });
  assert.deepEqual(result.task.result.duplicateDocumentIds, [3, 8]);
});

test('a rejected duplicate remains a failed task with an actionable existing document', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask({
    stage: 'processing',
    paperlessTaskId: 'paperless-task-rejected-duplicate',
  }));
  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'foreground',
    repository,
    transport: {
      async upload() { throw new Error('must not upload'); },
      async poll() {
        const error = new Error('Not consuming: duplicate document.');
        error.duplicateDocumentIds = [12, 12];
        throw error;
      },
    },
  });
  assert.equal(result.kind, 'failed');
  assert.equal(result.task.error.code, 'processing-failed');
  assert.equal(result.task.error.retryable, false);
  assert.deepEqual(result.task.result.duplicateDocumentIds, [12]);
  assert.match(result.task.result.summary, /review/i);
});

test('permanent failures remain actionable without indefinite retry', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask());
  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'foreground',
    repository,
    transport: {
      async upload() {
        const error = new Error('Permission denied');
        error.status = 403;
        throw error;
      },
      async poll() { throw new Error('not reached'); },
    },
  });
  assert.equal(result.kind, 'failed');
  assert.equal(result.task.error.code, 'submission-uncertain');
  assert.equal(result.task.error.retryable, false);
  assert.equal(result.task.nextAttemptAt, undefined);
});

test('transport-time catalog validation fails into repair state before sending bytes', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask({
    originalName: 'Invoice.pdf',
    stagedName: 'job-1-Invoice.pdf',
  }));
  let uploadCalls = 0;
  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'foreground',
    repository,
    transport: {
      async validateUpload() {
        throw Object.assign(new Error('The correspondent was removed. Repair upload metadata.'), {
          code: 'invalid-metadata',
        });
      },
      async upload() { uploadCalls += 1; return 'must-not-upload'; },
      async poll() { throw new Error('must not poll'); },
    },
  });
  assert.equal(uploadCalls, 0);
  assert.equal(result.kind, 'failed');
  assert.equal(result.task.error.code, 'invalid-metadata');
  assert.equal(result.task.error.retryable, false);
  assert.equal(result.task.localUri, 'private://file.pdf');
  assert.equal((await repository.readTask('profile-a', 'job-1')).localUri, 'private://file.pdf');
});

test('a proven pre-submission network failure remains eligible for bounded automatic retry', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask({ schemaVersion: 4 }));
  let validationCalls = 0;
  let uploadCalls = 0;
  const transport = {
    async validateUpload() {
      validationCalls += 1;
      if (validationCalls === 1) throw new Error('Network offline during metadata validation.');
    },
    async upload() { uploadCalls += 1; return 'accepted-after-validation-retry'; },
    async poll() { return { documentId: 61 }; },
  };
  const first = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'foreground',
    repository,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    transport,
  });
  assert.equal(first.kind, 'failed');
  assert.equal(first.task.stage, 'failed');
  assert.equal(first.task.error.code, 'network');
  assert.equal(first.task.error.retryable, true);
  assert.equal(uploadCalls, 0);

  const retried = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'automatic-retry',
    repository,
    now: () => new Date('2027-01-01T00:00:00.000Z'),
    transport,
  });
  assert.equal(retried.kind, 'ready');
  assert.equal(uploadCalls, 1);
  assert.equal(retried.task.result.remoteDocumentId, 61);
});

test('canceling during upload records server acceptance without claiming server cancellation', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask());
  let pollCalls = 0;
  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'foreground',
    repository,
    transport: {
      async upload(task) {
        await repository.writeTask(cancelTask(task));
        return 'accepted-task';
      },
      async poll() { pollCalls += 1; return { documentId: 49 }; },
    },
  });
  assert.equal(result.kind, 'canceled');
  assert.equal(result.task.cancellationDisposition, 'acceptance-uncertain');
  assert.equal(result.task.paperlessTaskId, 'accepted-task');
  assert.match(result.task.result.summary, /server may continue/i);
  assert.equal(pollCalls, 0);
  const persisted = await repository.readTask('profile-a', 'job-1');
  assert.equal(persisted.stage, 'canceled');
  assert.equal(persisted.paperlessTaskId, 'accepted-task');
  assert.match(persisted.result.summary, /server may continue/i);
});

test('canceling during polling records a finished result without reviving the task', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask({
    stage: 'processing',
    paperlessTaskId: 'accepted-before-restart',
  }));
  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'foreground',
    repository,
    transport: {
      async upload() { throw new Error('must not upload'); },
      async poll(task) {
        await repository.writeTask(cancelTask(task));
        return { documentId: 49 };
      },
    },
  });

  assert.equal(result.kind, 'canceled');
  assert.equal(result.task.stage, 'canceled');
  assert.equal(result.task.result.remoteDocumentId, 49);
  assert.match(result.task.result.summary, /finished.*independently/i);
  const persisted = await repository.readTask('profile-a', 'job-1');
  assert.equal(persisted.stage, 'canceled');
  assert.equal(persisted.paperlessTaskId, 'accepted-before-restart');
  assert.equal(persisted.result.remoteDocumentId, 49);
});

test('canceled acceptance is not reconciled after the connection guard changes', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask());
  let connectionCurrent = true;
  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'foreground',
    repository,
    executionGuard: () => connectionCurrent,
    transport: {
      async upload(task) {
        await repository.writeTask(cancelTask(task));
        connectionCurrent = false;
        return 'accepted-on-old-connection';
      },
      async poll() { throw new Error('must not poll'); },
    },
  });

  assert.equal(result.kind, 'failed');
  const persisted = await repository.readTask('profile-a', 'job-1');
  assert.equal(persisted.stage, 'canceled');
  assert.equal(persisted.paperlessTaskId, undefined);
});

test('a stale worker cannot commit acceptance after another owner takes the lease', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask());
  const result = await runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'stale-worker',
    repository,
    onTaskChange: async (task) => {
      if (task.stage === 'submission-uncertain') {
        await repository.writeTask({
          ...task,
          leaseOwner: 'replacement-worker',
          leaseExpiresAt: '2099-01-01T00:00:00.000Z',
        });
      }
    },
    transport: {
      async upload() { return 'stale-acceptance'; },
      async poll() { throw new Error('must not poll'); },
    },
  });

  assert.equal(result.kind, 'failed');
  const persisted = await repository.readTask('profile-a', 'job-1');
  assert.equal(persisted.leaseOwner, 'replacement-worker');
  assert.equal(persisted.paperlessTaskId, undefined);
});

test('a profile deletion tombstone prevents an in-flight upload from resurrecting its task', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(queuedTask({ schemaVersion: 4 }));
  let signalUploadStarted;
  let releaseUpload;
  const uploadStarted = new Promise((resolve) => { signalUploadStarted = resolve; });
  const uploadResult = new Promise((resolve) => { releaseUpload = resolve; });

  const running = runNextUploadTask({
    profileId: 'profile-a',
    workerId: 'deletion-race',
    repository,
    transport: {
      async upload() {
        signalUploadStarted();
        return uploadResult;
      },
      async poll() { throw new Error('must not poll after profile deletion'); },
    },
  });

  await uploadStarted;
  await repository.deleteProfileDataAndWriteRemovalTombstone({
    operationId: 'remove-profile-a',
    profileId: 'profile-a',
    createdAt: '2026-01-01T00:00:02.000Z',
  });
  releaseUpload('accepted-during-profile-removal');

  const result = await running;
  assert.equal(result.kind, 'failed');
  assert.equal(await repository.readTask('profile-a', 'job-1'), null);
  await assert.rejects(
    repository.writeTask(queuedTask()),
    /profile has been removed/i,
  );
});
