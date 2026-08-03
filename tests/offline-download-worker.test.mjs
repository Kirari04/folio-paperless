import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryFolioRepository } from '../src/lib/memory-repository.ts';
import { runNextOfflineDownload } from '../src/lib/offline-download-worker.ts';
import { dispatchTaskNotification } from '../src/lib/task-notification-outbox.ts';
import { cancelTask } from '../src/lib/task-policy.ts';

const NOW = new Date('2026-08-02T10:00:00.000Z');

function downloadTask(overrides = {}) {
  return {
    schemaVersion: 3,
    id: 'download-1',
    profileId: 'profile-a',
    kind: 'offline-download',
    stage: 'queued',
    source: 'unknown',
    originalName: 'letter.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    documentId: 'remote-42',
    offlineRepresentation: 'original',
    progress: 0,
    retryCount: 0,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function fileRecord() {
  return {
    profileId: 'profile-a',
    documentId: 'remote-42',
    representation: 'original',
    uri: 'file:///private/letter.bin',
    fileName: 'letter.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    byteSize: 128,
    pinned: true,
    lastAccessedAt: NOW.toISOString(),
    createdAt: NOW.toISOString(),
  };
}

test('restart reconciliation marks an already-committed offline file ready without downloading twice', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(downloadTask({ stage: 'uploading', progress: 0.8 }));
  let downloads = 0;
  const result = await runNextOfflineDownload({
    profileId: 'profile-a', workerId: 'restart-worker', repository, now: () => NOW,
    transport: {
      async resolve() { return fileRecord(); },
      async download() { downloads += 1; return fileRecord(); },
    },
  });
  assert.equal(result.kind, 'ready');
  assert.equal(downloads, 0);
  assert.equal((await repository.readTask('profile-a', 'download-1')).stage, 'ready');
});

test('durable leases deduplicate overlapping offline download workers', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(downloadTask());
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let downloads = 0;
  const transport = {
    async resolve() { return null; },
    async download(_task, { onProgress }) {
      downloads += 1;
      started();
      onProgress(0.5);
      await gate;
      return fileRecord();
    },
  };
  const first = runNextOfflineDownload({
    profileId: 'profile-a', workerId: 'worker-a', repository, transport, now: () => NOW,
  });
  await startedPromise;
  const second = await runNextOfflineDownload({
    profileId: 'profile-a', workerId: 'worker-b', repository, transport, now: () => NOW,
  });
  assert.equal(second.kind, 'idle');
  release();
  assert.equal((await first).kind, 'ready');
  assert.equal(downloads, 1);
});

test('retryable download failures stay durable and are not claimed across profiles', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(downloadTask());
  assert.equal((await runNextOfflineDownload({
    profileId: 'profile-b', workerId: 'wrong-profile', repository, now: () => NOW,
    transport: { async resolve() { return null; }, async download() { throw new Error('not called'); } },
  })).kind, 'idle');
  const result = await runNextOfflineDownload({
    profileId: 'profile-a', workerId: 'worker-a', repository, now: () => NOW,
    transport: {
      async resolve() { return null; },
      async download() { throw new Error('network connection unavailable'); },
    },
  });
  assert.equal(result.kind, 'failed');
  assert.equal(result.task.error.code, 'network');
  assert.equal(result.task.error.retryable, true);
  assert.ok(result.task.nextAttemptAt);
});

test('canceling an active offline transfer aborts locally and cannot be overwritten by its worker', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(downloadTask());
  let controller;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const run = runNextOfflineDownload({
    profileId: 'profile-a', workerId: 'worker-a', repository, now: () => NOW,
    onController(_task, next) { if (next) controller = next; },
    transport: {
      async resolve() { return null; },
      async download(_task, { signal }) {
        started();
        await new Promise((_, reject) => signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true }));
      },
    },
  });
  await startedPromise;
  const active = await repository.readTask('profile-a', 'download-1');
  const canceled = cancelTask(active, NOW);
  assert.equal(canceled.cancellationDisposition, 'local');
  await repository.writeTask(canceled);
  controller.abort();
  assert.equal((await run).kind, 'canceled');
  assert.equal((await repository.readTask('profile-a', 'download-1')).stage, 'canceled');
});

test('task notification outbox serializes foreground/background dispatch and reuses crash identifiers', async () => {
  const repository = new MemoryFolioRepository();
  const task = downloadTask({ kind: 'upload', stage: 'ready', completedAt: NOW.toISOString() });
  await repository.writeTask(task);
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const deliveries = [];
  const first = dispatchTaskNotification({
    repository, task, workerId: 'background', now: () => NOW,
    async notify(id) { deliveries.push(id); started(); await gate; },
  });
  await startedPromise;
  const competing = await dispatchTaskNotification({
    repository, task, workerId: 'foreground', now: () => NOW,
    async notify() { throw new Error('must not dispatch concurrently'); },
  });
  assert.equal(competing.kind, 'not-claimed');
  release();
  assert.equal((await first).kind, 'sent');
  assert.equal(deliveries.length, 1);
  assert.ok((await repository.readTask('profile-a', task.id)).notificationSentAt);

  const retryTask = downloadTask({ id: 'notification-retry', kind: 'upload', stage: 'ready' });
  await repository.writeTask(retryTask);
  let firstId;
  await assert.rejects(dispatchTaskNotification({
    repository, task: retryTask, workerId: 'background', now: () => NOW,
    async notify(id) { firstId = id; throw new Error('native handoff failed'); },
  }));
  let retryId;
  const retried = await dispatchTaskNotification({
    repository, task: retryTask, workerId: 'foreground', now: () => NOW,
    async notify(id) { retryId = id; },
  });
  assert.equal(retried.kind, 'sent');
  assert.equal(retryId, firstId);
});
