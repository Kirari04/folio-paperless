import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearStagedFileReference,
  deleteTaskAfterStagedFileCleanup,
  StagedFileCleanupError,
} from '../src/lib/task-staging-cleanup.ts';
import { PERSISTED_TASK_SCHEMA_VERSION } from '../src/types/tasks.ts';

const NOW = new Date('2026-08-02T10:00:00.000Z');

function canceledUpload(overrides = {}) {
  return {
    schemaVersion: PERSISTED_TASK_SCHEMA_VERSION,
    id: 'upload-cleanup',
    profileId: 'profile-a',
    kind: 'upload',
    stage: 'canceled',
    source: 'picker',
    originalName: 'invoice.pdf',
    stagedName: 'upload-cleanup-invoice.pdf',
    localUri: 'file:///private/profile-a/staging/upload-cleanup-invoice.pdf',
    progress: 0,
    retryCount: 0,
    cancellationDisposition: 'local',
    createdAt: '2026-08-02T09:00:00.000Z',
    updatedAt: '2026-08-02T09:30:00.000Z',
    completedAt: '2026-08-02T09:30:00.000Z',
    ...overrides,
  };
}

test('cancellation cleanup failure keeps the staged URI in a retryable task state', async () => {
  const writes = [];
  await assert.rejects(
    clearStagedFileReference(canceledUpload(), {
      now: NOW,
      async remove() {
        throw new Error('simulated file deletion failure');
      },
      async writeTask(task) {
        writes.push(task);
      },
    }),
    (error) => error instanceof StagedFileCleanupError
      && error.task.localUri === canceledUpload().localUri
      && error.task.error?.code === 'cleanup-failed'
      && error.task.error.retryable === true,
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].localUri, canceledUpload().localUri);
  assert.equal(writes[0].stagedName, canceledUpload().stagedName);
});

test('record deletion failure retains the cleanup reference and never deletes the task', async () => {
  const writes = [];
  let taskDeleted = false;
  await assert.rejects(
    deleteTaskAfterStagedFileCleanup(canceledUpload(), {
      now: NOW,
      async remove() {
        throw new Error('simulated file deletion failure');
      },
      async writeTask(task) {
        writes.push(task);
      },
      async deleteTask() {
        taskDeleted = true;
      },
    }),
    (error) => error instanceof StagedFileCleanupError,
  );
  assert.equal(taskDeleted, false);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].localUri, canceledUpload().localUri);
  assert.equal(writes[0].error?.code, 'cleanup-failed');
});

test('successful cleanup clears the reference only after the file is removed', async () => {
  const events = [];
  const result = await clearStagedFileReference(canceledUpload({
    error: {
      code: 'cleanup-failed',
      message: 'Previous cleanup failed.',
      retryable: true,
    },
  }), {
    now: NOW,
    async remove() {
      events.push('remove');
    },
    async writeTask(task) {
      events.push(`write:${task.localUri ?? 'cleared'}`);
    },
  });
  assert.deepEqual(events, ['remove', 'write:cleared']);
  assert.equal(result.localUri, undefined);
  assert.equal(result.stagedName, undefined);
  assert.equal(result.error, undefined);
});
