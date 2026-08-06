import assert from 'node:assert/strict';
import test from 'node:test';

import {
  reconcilePendingUploadResults,
  requestForegroundUploadReconciliation,
} from '../src/lib/background-upload-reconciliation.ts';
import { MemoryFolioRepository } from '../src/lib/memory-repository.ts';
import {
  resolveCachedPreviewSource,
  resolvePreferredCachedPreviewSource,
} from '../src/lib/offline-preview-policy.ts';
import { presentSyncStatus } from '../src/lib/sync-status-presentation.ts';

function readyUpload(profileId, id, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    profileId,
    kind: 'upload',
    stage: 'ready',
    source: 'share',
    originalName: `${id}.pdf`,
    progress: 1,
    retryCount: 0,
    result: { remoteDocumentId: 42, routeDocumentId: 'remote-42' },
    createdAt: '2026-08-02T10:00:00.000Z',
    updatedAt: '2026-08-02T10:01:00.000Z',
    completedAt: '2026-08-02T10:01:00.000Z',
    ...overrides,
  };
}

test('a profile-scoped pinned file resolves without live capability discovery after cold start', () => {
  const file = {
    profileId: 'profile-a',
    documentId: 'remote-42',
    representation: 'archive',
    uri: 'file:///protected/profile-a/remote-42/archive.pdf',
    byteSize: 2048,
    pinned: true,
    lastAccessedAt: '2026-08-02T10:00:00.000Z',
    createdAt: '2026-08-01T10:00:00.000Z',
  };
  assert.deepEqual(resolveCachedPreviewSource({
    documentId: 'remote-42',
    expectedProfileId: 'profile-a',
    file,
    filename: 'archive.pdf',
    mimeType: 'application/pdf',
    representation: 'archive',
  }), {
    filename: 'archive.pdf',
    mimeType: 'application/pdf',
    representation: 'archive',
    uri: file.uri,
  });
  assert.equal(resolveCachedPreviewSource({
    documentId: 'remote-42', expectedProfileId: 'profile-b', file,
    filename: null, mimeType: null, representation: 'archive',
  }), null);
  assert.equal(resolveCachedPreviewSource({
    documentId: 'remote-42', expectedProfileId: 'profile-a', file,
    filename: null, mimeType: null, representation: 'archive', versionId: 9,
  }), null);
});

test('cold-start preview prefers a pinned representation and falls back only within the active profile', () => {
  const archive = {
    profileId: 'profile-a', documentId: 'remote-42', representation: 'archive',
    uri: 'file:///protected/profile-a/remote-42/archive.pdf', byteSize: 4096,
    pinned: true, lastAccessedAt: '2026-08-02T10:00:00.000Z', createdAt: '2026-08-01T10:00:00.000Z',
  };
  const original = {
    ...archive,
    representation: 'original',
    uri: 'file:///protected/profile-a/remote-42/original.pdf',
    byteSize: 2048,
    fileName: 'invoice.pdf',
    mimeType: 'application/pdf',
  };
  assert.deepEqual(resolvePreferredCachedPreviewSource({
    documentId: 'remote-42',
    expectedProfileId: 'profile-a',
    files: { archive, original },
    preference: 'original',
  }), {
    byteSize: 2048,
    filename: 'invoice.pdf',
    mimeType: 'application/pdf',
    representation: 'original',
    uri: original.uri,
  });
  assert.equal(resolvePreferredCachedPreviewSource({
    documentId: 'remote-42',
    expectedProfileId: 'profile-b',
    files: { archive, original },
    preference: 'original',
  }), null);
});

test('sync status policy distinguishes current, syncing, cached, offline, and error with last success', () => {
  const lastSynced = '2026-08-02T10:00:00.000Z';
  assert.deepEqual(presentSyncStatus({
    connected: true, lastSynced, online: false, syncState: 'current',
  }), {
    busy: false,
    lastSuccessfulSyncAt: lastSynced,
    messageKey: 'syncStatus.offlineLastSuccess',
    state: 'offline',
    tone: 'warning',
  });
  assert.equal(presentSyncStatus({
    connected: true, lastSynced, online: true, syncState: 'syncing',
  }).messageKey, 'syncStatus.syncingLastSuccess');
  assert.equal(presentSyncStatus({
    connected: true, lastSynced, online: true, syncState: 'cached',
  }).messageKey, 'syncStatus.cachedLastSuccess');
  assert.equal(presentSyncStatus({
    connected: true, lastSynced, online: true, syncState: 'error',
  }).messageKey, 'syncStatus.errorLastSuccess');
  assert.equal(presentSyncStatus({
    connected: true, lastSynced, online: true, syncState: 'current',
  }).messageKey, 'syncStatus.currentLastSuccess');
  assert.equal(presentSyncStatus({
    connected: true, lastSynced: 'not-a-date', online: false, syncState: 'offline',
  }).messageKey, 'syncStatus.offline');
});

test('background-ready upload handoff is durable, profile-isolated, and reconciled once', async () => {
  const repository = new MemoryFolioRepository();
  const taskA = readyUpload('profile-a', 'same-id');
  const crashWindowTask = readyUpload('profile-a', 'ready-before-marker', {
    createdAt: '2026-08-02T10:02:00.000Z',
  });
  const taskB = readyUpload('profile-b', 'same-id');
  await repository.writeTasks([taskA, crashWindowTask]);
  await repository.writeTask(taskB);

  const requested = await requestForegroundUploadReconciliation({
    profileId: 'profile-a',
    repository,
    task: taskA,
    now: () => new Date('2026-08-02T10:03:00.000Z'),
  });
  assert.equal(requested.foregroundReconciliationRequestedAt, '2026-08-02T10:03:00.000Z');
  assert.equal((await repository.readTask('profile-b', 'same-id')).foregroundReconciliationRequestedAt, undefined);

  const callbacks = [];
  const result = await reconcilePendingUploadResults({
    profileId: 'profile-a',
    repository,
    now: () => new Date('2026-08-02T10:04:00.000Z'),
    async reconcile(task) {
      callbacks.push(task.id);
      await repository.writeRouteAlias({
        profileId: task.profileId,
        sourceId: `task-${task.id}`,
        targetId: task.result.routeDocumentId,
        createdAt: '2026-08-02T10:04:00.000Z',
      });
      const latest = await repository.readTask(task.profileId, task.id);
      await repository.writeTask({ ...latest, notificationSentAt: '2026-08-02T10:04:00.000Z' });
    },
  });
  assert.deepEqual(callbacks, ['same-id', 'ready-before-marker']);
  assert.equal(result.reconciled.length, 2);
  const completed = await repository.readTask('profile-a', 'same-id');
  assert.equal(completed.notificationSentAt, '2026-08-02T10:04:00.000Z');
  assert.equal(completed.foregroundReconciledAt, '2026-08-02T10:04:00.000Z');
  assert.equal((await repository.readRouteAlias('profile-a', 'task-same-id')).targetId, 'remote-42');

  await reconcilePendingUploadResults({
    profileId: 'profile-a', repository,
    async reconcile() { throw new Error('must not run twice'); },
  });
  assert.equal((await repository.readTask('profile-b', 'same-id')).foregroundReconciledAt, undefined);
});

test('failed foreground reconciliation remains pending for a later safe retry', async () => {
  const repository = new MemoryFolioRepository();
  await repository.writeTask(readyUpload('profile-a', 'retry-me'));
  const first = await reconcilePendingUploadResults({
    profileId: 'profile-a', repository,
    async reconcile() { throw new Error('server temporarily unavailable'); },
  });
  assert.equal(first.failed[0].error, 'server temporarily unavailable');
  assert.equal((await repository.readTask('profile-a', 'retry-me')).foregroundReconciledAt, undefined);
  let retried = false;
  await reconcilePendingUploadResults({
    profileId: 'profile-a', repository,
    async reconcile() { retried = true; },
  });
  assert.equal(retried, true);
  assert.ok((await repository.readTask('profile-a', 'retry-me')).foregroundReconciledAt);
});
