import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { OfflineFileCacheManager } from '../src/lib/offline-file-cache.ts';
import { OfflineSyncCoordinator } from '../src/lib/offline-sync.ts';
import { MemoryFolioRepository } from '../src/lib/memory-repository.ts';
import { emptyLibraryFilters } from '../src/lib/library-filters.ts';
import {
  createSavedViewSnapshot,
  filterSavedViewSnapshot,
  resolveSavedViewSnapshot,
} from '../src/lib/saved-view-offline-cache.ts';

const online = { isConnected: true, isInternetReachable: true };
const offline = { isConnected: false, isInternetReachable: false };
const nativeOfflineStorageSource = await readFile(
  new URL('../src/lib/offline-native-file-storage.ts', import.meta.url),
  'utf8',
);

function workspace(profileId, title = 'Cached', overrides = {}) {
  return {
    profileId,
    documents: [{ id: 'remote-1', title }],
    catalog: { tags: [] },
    totalDocuments: 1,
    lastSyncedAt: '2026-01-02T12:00:00.000Z',
    lastFullSyncedAt: '2026-01-02T00:00:00.000Z',
    syncState: 'current',
    ...overrides,
  };
}

function full(title, syncedAt = '2026-01-03T00:00:00.000Z') {
  return {
    kind: 'full',
    documents: [{ id: 'remote-1', title }],
    catalog: { tags: [] },
    totalDocuments: 1,
    syncedAt,
  };
}

test('cold start hydrates the cached workspace before the remote replacement', async () => {
  const repository = new MemoryFolioRepository();
  await repository.replaceWorkspace(workspace('profile-a'));
  const order = [];
  const coordinator = new OfflineSyncCoordinator({
    repository,
    now: () => new Date('2026-01-03T00:00:00.000Z'),
    transport: {
      async fetchWorkspace() {
        order.push('remote');
        return full('Fresh');
      },
    },
  });
  const result = await coordinator.hydrateThenSync({
    profileId: 'profile-a',
    workerId: 'foreground',
    network: online,
    onHydrated(snapshot) {
      order.push(`cache:${snapshot.workspace.documents[0].title}`);
    },
  });
  assert.deepEqual(order, ['cache:Cached', 'remote']);
  assert.equal(result.phase, 'current');
  assert.equal(result.workspace.documents[0].title, 'Fresh');
});

test('airplane-mode relaunch returns the persisted connected workspace and does not fetch', async () => {
  const repository = new MemoryFolioRepository();
  await repository.replaceWorkspace(workspace('profile-a'));
  let fetches = 0;
  const coordinator = new OfflineSyncCoordinator({
    repository,
    transport: { async fetchWorkspace() { fetches += 1; return full('Wrong'); } },
  });
  const result = await coordinator.hydrateThenSync({
    profileId: 'profile-a',
    workerId: 'relaunch',
    network: offline,
  });
  assert.equal(result.phase, 'offline');
  assert.equal(result.workspace.documents[0].title, 'Cached');
  assert.equal(fetches, 0);
});

test('server-evaluated saved-view membership survives offline relaunch without overinclusive fallback', async () => {
  const repository = new MemoryFolioRepository();
  const currentDocuments = [
    {
      id: 'remote-1', remoteId: 1, title: 'Exact member', correspondent: 'ACME',
      documentType: 'Invoice', excerpt: '', fullText: '', tags: ['tax'], tagIds: [],
      created: '2026-01-01', added: '2026-01-01', status: 'archived', customFields: [],
    },
    {
      id: 'remote-2', remoteId: 2, title: 'Must not leak into view', correspondent: 'Other',
      documentType: 'Letter', excerpt: '', fullText: '', tags: [], tagIds: [],
      created: '2026-01-02', added: '2026-01-02', status: 'archived', customFields: [],
    },
  ];
  const view = {
    id: 'saved-9', remoteId: 9, name: 'Future rule', sortField: 'added', sortReverse: true,
    filterRules: [{ ruleType: 999, value: 'server-only' }], pageSize: 50, displayFields: [],
  };
  await repository.replaceWorkspace(workspace('profile-a', 'Cached', {
    documents: currentDocuments,
    totalDocuments: 2,
  }));
  await repository.writeSavedViewSnapshot(
    'profile-a',
    createSavedViewSnapshot(view, [currentDocuments[0]], 1, '2026-01-02T12:01:00.000Z'),
  );

  const persisted = await repository.readWorkspace('profile-a');
  const exact = resolveSavedViewSnapshot(persisted.savedViewSnapshots, view, persisted.documents);
  assert.deepEqual(exact.documents.map((document) => document.id), ['remote-1']);
  assert.deepEqual(filterSavedViewSnapshot(exact, {
    query: 'exact', filters: emptyLibraryFilters, extraRules: view.filterRules,
    savedViewId: view.id,
  }).map((document) => document.id), ['remote-1']);
  assert.deepEqual(filterSavedViewSnapshot(exact, {
    query: 'must not leak', filters: emptyLibraryFilters, extraRules: view.filterRules,
    savedViewId: view.id,
  }), []);
  assert.equal(resolveSavedViewSnapshot(persisted.savedViewSnapshots, {
    ...view, filterRules: [{ ruleType: 999, value: 'changed' }],
  }, persisted.documents), null, 'an edited server-only rule cannot reuse stale membership');
  assert.equal(resolveSavedViewSnapshot(persisted.savedViewSnapshots, {
    ...view,
    filterRules: [{
      ruleType: 999,
      value: 'server-only',
      extra: { future_semantics: 'changed' },
    }],
  }, persisted.documents), null, 'changed opaque rule fields cannot reuse stale membership');
});

test('workspace reconciliation refreshes saved-view rows and drops deleted or permission-revoked members', async () => {
  const repository = new MemoryFolioRepository();
  const oldDocuments = [
    { id: 'remote-1', title: 'Old member' },
    { id: 'remote-2', title: 'No longer visible' },
  ];
  await repository.replaceWorkspace(workspace('profile-a', 'Old', {
    documents: oldDocuments,
    savedViewSnapshots: {
      view: {
        viewId: 'view', viewFingerprint: 'fingerprint', documentIds: oldDocuments.map((item) => item.id),
        totalDocuments: 2, evaluatedAt: '2026-01-02T12:00:00.000Z',
      },
    },
  }));
  const coordinator = new OfflineSyncCoordinator({
    repository,
    transport: { async fetchWorkspace() { return full('Refreshed member'); } },
  });
  await coordinator.sync({
    profileId: 'profile-a', workerId: 'foreground', network: online, trigger: 'manual',
    forceFull: true,
  });
  const refreshed = await repository.readWorkspace('profile-a');
  assert.deepEqual(refreshed.savedViewSnapshots.view.documentIds, ['remote-1']);
  assert.equal(refreshed.savedViewSnapshots.view.totalDocuments, 1);
});

test('foreground refresh honors the age threshold while manual refresh remains immediate', async () => {
  const repository = new MemoryFolioRepository();
  await repository.replaceWorkspace(workspace('profile-a'));
  let fetches = 0;
  const coordinator = new OfflineSyncCoordinator({
    repository,
    now: () => new Date('2026-01-02T12:01:00.000Z'),
    foregroundRefreshAgeMs: 5 * 60_000,
    transport: { async fetchWorkspace() { fetches += 1; return full('Fresh'); } },
  });
  const foreground = await coordinator.sync({
    profileId: 'profile-a', workerId: 'foreground', network: online, trigger: 'foreground',
  });
  assert.equal(foreground.phase, 'current');
  assert.equal(fetches, 0);
  await coordinator.sync({
    profileId: 'profile-a', workerId: 'foreground', network: online, trigger: 'manual',
  });
  assert.equal(fetches, 1);
});

test('incremental sync overlaps its watermark and reconciles updates and deletions', async () => {
  const repository = new MemoryFolioRepository();
  await repository.replaceWorkspace(workspace('profile-a', 'Old', {
    documents: [
      { id: 'remote-1', title: 'Old' },
      { id: 'remote-2', title: 'Delete me' },
    ],
    totalDocuments: 2,
  }));
  let request;
  const coordinator = new OfflineSyncCoordinator({
    repository,
    overlapMs: 5 * 60_000,
    now: () => new Date('2026-01-02T13:00:00.000Z'),
    transport: {
      async fetchWorkspace(value) {
        request = value;
        return {
          kind: 'incremental',
          upsertedDocuments: [
            { id: 'remote-1', title: 'Updated' },
            { id: 'remote-3', title: 'Added' },
          ],
          deletedDocumentIds: ['remote-2'],
          totalDocuments: 2,
          syncedAt: '2026-01-02T13:00:00.000Z',
        };
      },
    },
  });
  const result = await coordinator.sync({
    profileId: 'profile-a', workerId: 'foreground', network: online, trigger: 'manual',
  });
  assert.equal(request.mode, 'incremental');
  assert.equal(request.modifiedAfter, '2026-01-02T11:55:00.000Z');
  assert.deepEqual(result.workspace.documents.map((item) => item.title), ['Updated', 'Added']);
});

test('failed refresh preserves the last good profile cache and persists an actionable sync task', async () => {
  const repository = new MemoryFolioRepository();
  await repository.replaceWorkspace(workspace('profile-a', 'Retained'));
  const coordinator = new OfflineSyncCoordinator({
    repository,
    now: () => new Date('2026-01-03T00:00:00.000Z'),
    transport: { async fetchWorkspace() { throw new Error('network unavailable'); } },
  });
  const result = await coordinator.sync({
    profileId: 'profile-a', workerId: 'foreground', network: online, trigger: 'manual',
  });
  assert.equal(result.phase, 'error');
  assert.equal(result.workspace.documents[0].title, 'Retained');
  assert.equal(result.workspace.syncState, 'error');
  const task = await repository.readTask('profile-a', 'workspace-sync');
  assert.equal(task.stage, 'failed');
  assert.equal(task.error.retryable, true);
  await coordinator.sync({
    profileId: 'profile-a', workerId: 'foreground', network: online, trigger: 'connectivity',
  });
  assert.equal((await repository.readTask('profile-a', 'workspace-sync')).retryCount, 2);
  assert.equal(
    await repository.claimNextRunnableTask(
      'profile-a',
      'upload-worker',
      new Date('2027-01-01T00:00:00.000Z'),
    ),
    null,
  );
});

test('a periodic full reconciliation fails safely if the transport returns only a delta', async () => {
  const repository = new MemoryFolioRepository();
  await repository.replaceWorkspace(workspace('profile-a', 'Retained', { lastFullSyncedAt: undefined }));
  const coordinator = new OfflineSyncCoordinator({
    repository,
    transport: {
      async fetchWorkspace() {
        return {
          kind: 'incremental', upsertedDocuments: [], deletedDocumentIds: [],
          syncedAt: '2026-01-03T00:00:00.000Z',
        };
      },
    },
  });
  const result = await coordinator.sync({
    profileId: 'profile-a', workerId: 'foreground', network: online, trigger: 'manual',
  });
  assert.equal(result.phase, 'error');
  assert.equal(result.workspace.documents[0].title, 'Retained');
});

test('profile switches isolate identical document and sync task identities', async () => {
  const repository = new MemoryFolioRepository();
  const coordinator = new OfflineSyncCoordinator({
    repository,
    transport: { async fetchWorkspace(request) { return full(request.profileId); } },
  });
  await coordinator.sync({ profileId: 'profile-a', workerId: 'a', network: online, trigger: 'manual' });
  await coordinator.sync({ profileId: 'profile-b', workerId: 'b', network: online, trigger: 'manual' });
  assert.equal((await repository.readWorkspace('profile-a')).documents[0].title, 'profile-a');
  assert.equal((await repository.readWorkspace('profile-b')).documents[0].title, 'profile-b');
  assert.ok(await repository.readTask('profile-a', 'workspace-sync'));
  assert.ok(await repository.readTask('profile-b', 'workspace-sync'));
});

test('persistent task leasing deduplicates overlapping foreground and background sync', async () => {
  const repository = new MemoryFolioRepository();
  let release;
  let calls = 0;
  const transport = {
    fetchWorkspace() {
      calls += 1;
      return new Promise((resolve) => { release = () => resolve(full('Done')); });
    },
  };
  const foreground = new OfflineSyncCoordinator({ repository, transport });
  const background = new OfflineSyncCoordinator({ repository, transport });
  const first = foreground.sync({
    profileId: 'profile-a', workerId: 'foreground', network: online, trigger: 'manual',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await background.sync({
    profileId: 'profile-a', workerId: 'background', network: online, trigger: 'background',
  });
  assert.equal(second.phase, 'busy');
  assert.equal(calls, 1);
  release();
  assert.equal((await first).phase, 'current');
});

test('workspace sync renews its lease before remote work and before committing', async () => {
  const repository = new MemoryFolioRepository();
  const renewTaskLease = repository.renewTaskLease.bind(repository);
  const renewals = [];
  repository.renewTaskLease = async (...args) => {
    renewals.push({ profileId: args[0], taskId: args[1], workerId: args[2] });
    return renewTaskLease(...args);
  };
  const coordinator = new OfflineSyncCoordinator({
    repository,
    now: () => new Date('2026-01-03T00:00:00.000Z'),
    transport: { async fetchWorkspace() { return full('Renewed'); } },
  });

  const result = await coordinator.sync({
    profileId: 'profile-a', workerId: 'foreground', network: online, trigger: 'manual',
  });

  assert.equal(result.phase, 'current');
  assert.deepEqual(renewals, [
    { profileId: 'profile-a', taskId: 'workspace-sync', workerId: 'foreground' },
    { profileId: 'profile-a', taskId: 'workspace-sync', workerId: 'foreground' },
  ]);
});

test('workspace sync loss after fetch fences the stale worker from committing', async () => {
  const repository = new MemoryFolioRepository();
  await repository.replaceWorkspace(workspace('profile-a', 'Retained'));
  const renewTaskLease = repository.renewTaskLease.bind(repository);
  let renewalCount = 0;
  repository.renewTaskLease = async (...args) => {
    renewalCount += 1;
    if (renewalCount === 2) return null;
    return renewTaskLease(...args);
  };
  const coordinator = new OfflineSyncCoordinator({
    repository,
    now: () => new Date('2026-01-03T00:00:00.000Z'),
    transport: { async fetchWorkspace() { return full('Must not commit'); } },
  });

  const result = await coordinator.sync({
    profileId: 'profile-a',
    workerId: 'stale-worker',
    network: online,
    trigger: 'manual',
    forceFull: true,
  });

  assert.equal(renewalCount, 2);
  assert.equal(result.phase, 'busy');
  assert.equal(result.workspace.documents[0].title, 'Retained');
  assert.equal(result.workspace.syncState, 'cached');
  assert.equal((await repository.readWorkspace('profile-a')).documents[0].title, 'Retained');
});

test('workspace and terminal sync task commit reject a lease reclaimed after renewal', async () => {
  const repository = new MemoryFolioRepository();
  await repository.replaceWorkspace(workspace('profile-a', 'Retained'));
  const commitWorkspaceSync = repository.commitWorkspaceSync.bind(repository);
  repository.commitWorkspaceSync = async (...args) => {
    const expectedLease = args[1];
    await repository.writeTask({
      ...expectedLease,
      leaseOwner: 'replacement-worker',
      leaseExpiresAt: '2026-01-03T00:10:00.000Z',
      updatedAt: '2026-01-03T00:00:01.000Z',
    });
    return commitWorkspaceSync(...args);
  };
  const coordinator = new OfflineSyncCoordinator({
    repository,
    now: () => new Date('2026-01-03T00:00:00.000Z'),
    transport: { async fetchWorkspace() { return full('Must not commit'); } },
  });

  const result = await coordinator.sync({
    profileId: 'profile-a',
    workerId: 'stale-worker',
    network: online,
    trigger: 'manual',
    forceFull: true,
  });

  assert.equal(result.phase, 'busy');
  assert.equal(result.workspace.documents[0].title, 'Retained');
  assert.equal((await repository.readWorkspace('profile-a')).documents[0].title, 'Retained');
  assert.equal((await repository.readTask('profile-a', 'workspace-sync')).leaseOwner, 'replacement-worker');
});

test('native offline storage confines every operation to the selected profile roots', () => {
  assert.match(nativeOfflineStorageSource, /parsed\.protocol !== 'file:'/);
  assert.match(
    nativeOfflineStorageSource,
    /parsed\.username \|\| parsed\.password \|\| parsed\.search \|\| parsed\.hash/,
  );
  assert.match(nativeOfflineStorageSource, /const roots = \[Paths\.cache, Paths\.document\]/);
  assert.match(nativeOfflineStorageSource, /profileDirectoryCandidates\(exactProfileId\)/);
  assert.match(nativeOfflineStorageSource, /profileOwner\(directory\) === exactProfileId/);
  assert.match(nativeOfflineStorageSource, /candidate\.startsWith\(`\$\{root\}\/`\)/);
  assert.equal(
    nativeOfflineStorageSource.match(/assertProfileOfflineFileUri\(profileId,/g)?.length,
    6,
  );
});

test('native offline allocation preserves exact profile IDs and marks directory ownership', () => {
  assert.match(nativeOfflineStorageSource, /const profileId = profileDirectoryName\(input\.profileId\)/);
  assert.match(
    nativeOfflineStorageSource,
    /ensureOwnedProfileRoot\(Paths\.cache, profileId, nativeProfileRootStorage\)/,
  );
  assert.match(
    nativeOfflineStorageSource,
    /ensureOwnedProfileRoot\([\s\S]*input\.pinned \? Paths\.document : Paths\.cache,[\s\S]*profileId,[\s\S]*nativeProfileRootStorage/,
  );
  assert.match(nativeOfflineStorageSource, /profileRootDirectoryOwner\(directory, nativeProfileRootStorage\)/);
  assert.doesNotMatch(nativeOfflineStorageSource, /new Directory\(root, 'folio', 'profiles'/);
});

test('pinned iOS offline copies fail closed unless excluded from device backup', () => {
  assert.match(nativeOfflineStorageSource, /import \{ excludeSensitiveFileFromBackup \}/);
  assert.match(nativeOfflineStorageSource, /candidate\.startsWith\(`\$\{documentRoot\}\/`\)/);
  assert.equal(
    nativeOfflineStorageSource.match(/await protectPersistentOfflineFile\(committedUri\)/g)?.length,
    2,
  );
  assert.match(
    nativeOfflineStorageSource,
    /await excludeSensitiveFileFromBackup\(uri\);[\s\S]*if \(destination\.exists\) destination\.delete\(\);[\s\S]*throw error/,
  );
});

class MemoryFileStorage {
  files = new Map();
  available = 1024 * 1024;

  allocate({ profileId, documentId, representation, pinned, operationId }) {
    const root = pinned ? 'document' : 'cache';
    return {
      temporaryUri: `temp://${profileId}/${operationId}`,
      committedUri: `${root}://${profileId}/${documentId}/${representation}/${operationId}`,
    };
  }

  async stat(_profileId, uri) {
    return { exists: this.files.has(uri), byteSize: this.files.get(uri) ?? 0 };
  }

  async commit(_profileId, source, destination) {
    const size = this.files.get(source);
    if (!size) throw new Error('missing temp');
    this.files.delete(source);
    this.files.set(destination, size);
  }

  async copy(_profileId, source, destination) {
    const size = this.files.get(source);
    if (!size) throw new Error('missing source');
    this.files.set(destination, size);
    this.available -= size;
  }

  async remove(_profileId, uri) {
    const size = this.files.get(uri);
    if (size) this.available += size;
    this.files.delete(uri);
  }

  async availableDiskBytes() { return this.available; }
}

function cacheFixture({ quotaBytes = 100, reserveBytes = 0, size = 20 } = {}) {
  const repository = new MemoryFolioRepository();
  const storage = new MemoryFileStorage();
  let operation = 0;
  const downloader = {
    async expectedSize() { return size; },
    async download({ destinationUri, onProgress }) {
      storage.files.set(destinationUri, size);
      storage.available -= size;
      await onProgress?.(1);
    },
  };
  const manager = new OfflineFileCacheManager({
    repository,
    storage,
    downloader,
    quotaBytes,
    reserveBytes,
    now: () => new Date(`2026-01-01T00:00:0${operation}.000Z`),
    operationId: () => `operation-${operation++}`,
  });
  return { repository, storage, manager };
}

async function seedFile(repository, storage, file) {
  storage.files.set(file.uri, file.byteSize);
  await repository.writeOfflineFile(file);
}

function fileRecord(overrides = {}) {
  return {
    profileId: 'profile-a',
    documentId: 'remote-1',
    representation: 'preview',
    uri: 'cache://old',
    byteSize: 20,
    pinned: false,
    lastAccessedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('pinned originals use protected storage and survive automatic LRU cleanup', async () => {
  const { repository, storage, manager } = cacheFixture({ quotaBytes: 50, size: 40 });
  const pinned = await manager.download({
    profileId: 'profile-a', documentId: 'remote-1', representation: 'original', pinned: true,
  });
  assert.equal(pinned.kind, 'stored');
  assert.match(pinned.file.uri, /^document:/);
  await seedFile(repository, storage, fileRecord({
    documentId: 'remote-2', uri: 'cache://evict-me', byteSize: 30,
  }));
  await manager.download({
    profileId: 'profile-a', documentId: 'remote-3', representation: 'preview', pinned: false,
  });
  const files = await repository.listOfflineFiles('profile-a');
  assert.equal(files.some((file) => file.documentId === 'remote-1' && file.pinned), true);
  assert.equal(files.some((file) => file.documentId === 'remote-2'), false);
});

test('automatic refresh cannot demote an existing pinned representation', async () => {
  const { repository, storage, manager } = cacheFixture({ quotaBytes: 1, size: 40 });
  await seedFile(repository, storage, fileRecord({
    documentId: 'remote-1',
    representation: 'original',
    uri: 'document://protected-original',
    byteSize: 20,
    pinned: true,
  }));

  const refreshed = await manager.download({
    profileId: 'profile-a',
    documentId: 'remote-1',
    representation: 'original',
    pinned: false,
  });

  assert.equal(refreshed.kind, 'stored');
  assert.equal(refreshed.file.pinned, true);
  assert.match(refreshed.file.uri, /^document:/);
  assert.equal(storage.files.has('document://protected-original'), false);
  assert.equal((await repository.listOfflineFiles('profile-a'))[0].pinned, true);
});

test('automatic quota cleanup evicts least-recently-used files first', async () => {
  const { repository, storage, manager } = cacheFixture({ quotaBytes: 100, size: 50 });
  await seedFile(repository, storage, fileRecord({
    documentId: 'old', uri: 'cache://old', byteSize: 60, lastAccessedAt: '2026-01-01T00:00:00.000Z',
  }));
  await seedFile(repository, storage, fileRecord({
    documentId: 'new', uri: 'cache://new', byteSize: 30, lastAccessedAt: '2026-01-02T00:00:00.000Z',
  }));
  const result = await manager.download({
    profileId: 'profile-a', documentId: 'incoming', representation: 'thumbnail', pinned: false,
  });
  assert.equal(result.kind, 'stored');
  const ids = (await repository.listOfflineFiles('profile-a')).map((file) => file.documentId).sort();
  assert.deepEqual(ids, ['incoming', 'new']);
});

test('storage pressure is explicit and never evicts pinned files', async () => {
  const { repository, storage, manager } = cacheFixture({ quotaBytes: 100, reserveBytes: 20, size: 40 });
  storage.available = 50;
  await seedFile(repository, storage, fileRecord({
    documentId: 'pinned', representation: 'archive', uri: 'document://pinned', byteSize: 80, pinned: true,
  }));
  const result = await manager.download({
    profileId: 'profile-a', documentId: 'incoming', representation: 'preview', pinned: false,
  });
  assert.deepEqual(result, {
    kind: 'storage-pressure', requiredBytes: 40, availableBytes: 50, reserveBytes: 20,
  });
  assert.ok(await manager.resolve('profile-a', 'pinned', 'archive'));
});

test('offline file records survive manager restart and missing files are invalidated', async () => {
  const fixture = cacheFixture({ size: 25 });
  const stored = await fixture.manager.download({
    profileId: 'profile-a', documentId: 'remote-1', representation: 'archive', pinned: true,
  });
  const restarted = new OfflineFileCacheManager({
    repository: fixture.repository,
    storage: fixture.storage,
    downloader: { async download() { throw new Error('not called'); } },
    quotaBytes: 100,
  });
  assert.equal((await restarted.resolve('profile-a', 'remote-1', 'archive')).kind, 'available');
  fixture.storage.files.delete(stored.file.uri);
  assert.equal((await restarted.resolve('profile-a', 'remote-1', 'archive')).kind, 'missing');
  assert.equal((await fixture.repository.listOfflineFiles('profile-a')).length, 0);
});

test('cache usage excludes OS-evicted and size-mismatched files without racing repository cleanup', async () => {
  const { repository, storage, manager } = cacheFixture();
  await seedFile(repository, storage, fileRecord({
    documentId: 'available', uri: 'cache://available', byteSize: 20,
  }));
  await repository.writeOfflineFile(fileRecord({
    documentId: 'evicted', uri: 'cache://evicted', byteSize: 30,
  }));
  await seedFile(repository, storage, fileRecord({
    documentId: 'truncated', uri: 'cache://truncated', byteSize: 40,
  }));
  storage.files.set('cache://truncated', 5);

  assert.deepEqual(await manager.usage('profile-a'), {
    automaticBytes: 20,
    pinnedBytes: 0,
    totalBytes: 20,
    automaticFiles: 1,
    pinnedFiles: 0,
    pinnedDocuments: 0,
  });
  assert.equal(
    (await repository.listOfflineFiles('profile-a')).length,
    3,
    'usage reconciliation remains read-only so it cannot delete a concurrent replacement',
  );
});

test('pinned deletion requires confirmation and profile cache cleanup remains scoped', async () => {
  const { repository, storage, manager } = cacheFixture();
  await seedFile(repository, storage, fileRecord({
    documentId: 'a', representation: 'original', uri: 'document://a', pinned: true,
  }));
  await seedFile(repository, storage, fileRecord({
    profileId: 'profile-b', documentId: 'b', uri: 'cache://b', pinned: false,
  }));
  assert.equal((await manager.remove('profile-a', 'a', 'original')).kind, 'requires-confirmation');
  const cleared = await manager.clearEvictable('profile-a');
  assert.equal(cleared.removed.length, 0);
  assert.equal(cleared.usage.pinnedFiles, 1);
  assert.equal((await repository.listOfflineFiles('profile-b')).length, 1);
  assert.equal((await manager.remove('profile-a', 'a', 'original', true)).kind, 'not-downloaded');
});
