import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { MemoryFolioRepository } from '../src/lib/memory-repository.ts';
import { MetadataUpdateController } from '../src/lib/metadata-update-controller.ts';
import {
  applyMetadataPatch,
  sanitizeMetadataPatch,
} from '../src/lib/metadata-update.ts';
import { runNextMetadataUpdate } from '../src/lib/metadata-update-worker.ts';

const NOW = '2026-08-02T10:00:00.000Z';
const LATER = '2026-08-02T10:05:00.000Z';

const catalog = {
  correspondents: [{ id: 'remote-correspondent-2', remoteId: 2, name: 'Acme' }],
  documentTypes: [{ id: 'remote-type-3', remoteId: 3, name: 'Invoice' }],
  tags: [
    { id: 'remote-tag-4', remoteId: 4, name: 'Inbox' },
    { id: 'remote-tag-5', remoteId: 5, name: 'Finance' },
  ],
  storagePaths: [{ id: 'remote-storage-path-6', remoteId: 6, name: 'Archive' }],
  owners: [],
  customFields: [],
  savedViews: [],
};

function document(overrides = {}) {
  return {
    id: 'remote-1',
    remoteId: 1,
    title: 'Original',
    correspondent: 'Acme',
    correspondentId: 'remote-correspondent-2',
    documentType: 'Invoice',
    documentTypeId: 'remote-type-3',
    storagePath: 'Archive',
    storagePathId: 'remote-storage-path-6',
    created: '2026-08-01',
    added: NOW,
    modifiedAt: NOW,
    pageCount: 1,
    fileSize: '1 KB',
    tags: ['Inbox'],
    tagIds: ['remote-tag-4'],
    status: 'inbox',
    color: '#fff',
    accent: '#000',
    excerpt: 'Text',
    archiveSerialNumber: 8,
    customFields: [],
    canEdit: true,
    source: 'remote',
    ...overrides,
  };
}

async function repositoryWithWorkspace(profileId = 'profile-a', item = document()) {
  const repository = new MemoryFolioRepository();
  await repository.replaceWorkspace({
    profileId,
    documents: [item],
    catalog,
    totalDocuments: 1,
    lastSyncedAt: NOW,
    syncState: 'current',
  });
  return repository;
}

test('metadata patches contain only bounded remote identities and supported values', () => {
  const patch = sanitizeMetadataPatch({
    title: '  Quarterly report  ',
    tags: [
      { id: 'untrusted-local-id', remoteId: 5, name: ' Finance ' },
      { id: 'duplicate', remoteId: 5, name: 'Finance' },
    ],
    customFields: [{ fieldId: 'ignored', fieldRemoteId: 9, value: [3, 2, 3] }],
  });
  assert.deepEqual(patch, {
    title: 'Quarterly report',
    tags: [{ remoteId: 5, name: 'Finance' }],
    customFields: [{ fieldRemoteId: 9, value: [2, 3] }],
  });
  assert.throws(
    () => sanitizeMetadataPatch({ tags: [{ id: 'local', name: 'No remote identity' }] }),
    /positive integer/,
  );
});

test('offline metadata queue is durable, optimistic, coalesced, and profile scoped', async () => {
  const repository = await repositoryWithWorkspace();
  await repository.replaceWorkspace({
    profileId: 'profile-b', documents: [document()], catalog, totalDocuments: 1,
    lastSyncedAt: NOW, syncState: 'current',
  });
  const controller = new MetadataUpdateController(repository, () => new Date(NOW));
  const first = await controller.enqueue({
    profileId: 'profile-a', document: document(), catalog, changes: { title: 'Offline title' },
  });
  const second = await controller.enqueue({
    profileId: 'profile-a', document: first.document, catalog,
    changes: { tags: [catalog.tags[1]] },
  });
  assert.equal(second.task.id, first.task.id);
  assert.equal((await repository.listTasks('profile-a')).length, 1);
  assert.equal((await repository.readWorkspace('profile-a')).documents[0].title, 'Offline title');
  assert.deepEqual((await repository.readWorkspace('profile-a')).documents[0].tags, ['Finance']);
  assert.equal((await repository.readWorkspace('profile-b')).documents[0].title, 'Original');

  // A service/controller restart sees the same profile-local job and cache.
  const restarted = new MetadataUpdateController(repository, () => new Date(LATER));
  assert.equal((await repository.listTasks('profile-a'))[0].metadataUpdate.baseline.modifiedAt, NOW);
  await restarted.discard('profile-a', first.task.id);
  assert.equal((await repository.readWorkspace('profile-a')).documents[0].title, 'Original');
  assert.deepEqual((await repository.readWorkspace('profile-a')).documents[0].tags, ['Inbox']);
});

test('metadata worker checks the baseline, patches, reads back, and atomically updates cache', async () => {
  const repository = await repositoryWithWorkspace();
  const controller = new MetadataUpdateController(repository, () => new Date(NOW));
  await controller.enqueue({
    profileId: 'profile-a', document: document(), catalog, changes: { title: 'Updated' },
  });
  let remote = document();
  let updateCount = 0;
  const result = await runNextMetadataUpdate({
    profileId: 'profile-a', workerId: 'worker-a', repository, catalog,
    now: () => new Date(LATER),
    transport: {
      async read() { return remote; },
      async update(_id, changes) {
        updateCount += 1;
        remote = { ...applyMetadataPatch(remote, sanitizeMetadataPatch(changes)), modifiedAt: LATER };
      },
    },
  });
  assert.equal(result.kind, 'ready');
  assert.equal(updateCount, 1);
  assert.equal((await repository.readWorkspace('profile-a')).documents[0].title, 'Updated');
  assert.equal((await repository.listTasks('profile-a'))[0].stage, 'ready');
});

test('same-field remote edits become explicit non-retryable conflicts without overwriting', async () => {
  const repository = await repositoryWithWorkspace();
  const controller = new MetadataUpdateController(repository, () => new Date(NOW));
  const queued = await controller.enqueue({
    profileId: 'profile-a', document: document(), catalog, changes: { title: 'Local title' },
  });
  let updateCount = 0;
  let remote = document({ title: 'Server title', modifiedAt: LATER });
  const conflict = await runNextMetadataUpdate({
    profileId: 'profile-a', workerId: 'worker-a', repository, catalog,
    now: () => new Date('2026-08-02T10:06:00.000Z'),
    transport: {
      async read() { return remote; },
      async update() { updateCount += 1; },
    },
  });
  assert.equal(conflict.kind, 'conflict');
  assert.equal(updateCount, 0);
  assert.deepEqual(conflict.task.metadataUpdate.conflict.conflictingFields, ['title']);
  assert.equal(conflict.task.error.code, 'conflict');
  assert.equal(conflict.task.error.retryable, false);
  assert.equal((await repository.readWorkspace('profile-a')).documents[0].title, 'Local title');

  const resolved = await controller.resolveConflict('profile-a', queued.task.id, 'keep-local');
  assert.equal(resolved.task.stage, 'queued');
  assert.equal(resolved.task.metadataUpdate.baseline.modifiedAt, LATER);
  const applied = await runNextMetadataUpdate({
    profileId: 'profile-a', workerId: 'worker-b', repository, catalog,
    now: () => new Date('2026-08-02T10:07:00.000Z'),
    transport: {
      async read() { return remote; },
      async update(_id, changes) {
        updateCount += 1;
        remote = { ...applyMetadataPatch(remote, sanitizeMetadataPatch(changes)), modifiedAt: '2026-08-02T10:07:00.000Z' };
      },
    },
  });
  assert.equal(applied.kind, 'ready');
  assert.equal(remote.title, 'Local title');
});

test('unrelated remote field changes merge without a false conflict', async () => {
  const repository = await repositoryWithWorkspace();
  await new MetadataUpdateController(repository, () => new Date(NOW)).enqueue({
    profileId: 'profile-a', document: document(), catalog, changes: { title: 'Local title' },
  });
  let remote = document({ created: '2026-07-31', modifiedAt: LATER });
  const result = await runNextMetadataUpdate({
    profileId: 'profile-a', workerId: 'worker', repository, catalog,
    now: () => new Date('2026-08-02T10:06:00.000Z'),
    transport: {
      async read() { return remote; },
      async update(_id, changes) {
        remote = { ...applyMetadataPatch(remote, sanitizeMetadataPatch(changes)), modifiedAt: LATER };
      },
    },
  });
  assert.equal(result.kind, 'ready');
  assert.equal(remote.title, 'Local title');
  assert.equal(remote.created, '2026-07-31');
});

test('readback mismatch becomes a conflict instead of claiming success', async () => {
  const repository = await repositoryWithWorkspace();
  await new MetadataUpdateController(repository, () => new Date(NOW)).enqueue({
    profileId: 'profile-a', document: document(), catalog, changes: { title: 'Expected title' },
  });
  const result = await runNextMetadataUpdate({
    profileId: 'profile-a', workerId: 'worker', repository, catalog,
    now: () => new Date(LATER),
    transport: {
      async read() { return document(); },
      async update() {},
    },
  });
  assert.equal(result.kind, 'conflict');
  assert.equal(result.task.error.code, 'conflict');
  assert.deepEqual(result.task.metadataUpdate.conflict.conflictingFields, ['title']);
});

test('network failure stays durable and retryable without losing optimistic metadata', async () => {
  const repository = await repositoryWithWorkspace();
  const controller = new MetadataUpdateController(repository, () => new Date(NOW));
  const queued = await controller.enqueue({
    profileId: 'profile-a', document: document(), catalog, changes: { title: 'Offline title' },
  });
  const result = await runNextMetadataUpdate({
    profileId: 'profile-a', workerId: 'worker', repository, catalog,
    now: () => new Date(LATER),
    transport: {
      async read() { throw new Error('Network connection offline'); },
      async update() { throw new Error('should not update'); },
    },
  });
  assert.equal(result.kind, 'failed');
  assert.equal(result.task.error.code, 'network');
  assert.equal(result.task.error.retryable, true);
  assert.equal((await repository.readWorkspace('profile-a')).documents[0].title, 'Offline title');
  const retried = await controller.retry('profile-a', queued.task.id);
  assert.equal(retried.stage, 'queued');
});

test('only one metadata worker can claim a profile task', async () => {
  const repository = await repositoryWithWorkspace();
  await new MetadataUpdateController(repository, () => new Date(NOW)).enqueue({
    profileId: 'profile-a', document: document(), catalog, changes: { title: 'One worker' },
  });
  const now = new Date(LATER);
  const [one, two] = await Promise.all([
    repository.claimNextMetadataTask('profile-a', 'one', now),
    repository.claimNextMetadataTask('profile-a', 'two', now),
  ]);
  assert.equal([one, two].filter(Boolean).length, 1);
});

test('destructive document deletion is live-only and mutates UI only after server success', async () => {
  const source = await readFile(new URL('../src/context/app-context.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('const deleteDocument = useCallback');
  const end = source.indexOf('const reprocessDocument = useCallback', start);
  const deletion = source.slice(start, end);
  const liveGuard = deletion.indexOf("onlineRef.current === false");
  const remoteDelete = deletion.indexOf('await deletePaperlessDocument');
  const localMutation = deletion.indexOf('setDocuments((current) => current.filter');
  assert.ok(liveGuard >= 0 && liveGuard < remoteDelete);
  assert.ok(remoteDelete < localMutation);
});
