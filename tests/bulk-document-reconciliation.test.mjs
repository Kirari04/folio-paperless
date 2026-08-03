import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commitConfirmedBulkReconciliation,
  confirmedBulkSucceededIds,
  reconcileConfirmedBulkDocuments,
  reconcileConfirmedBulkThenRefresh,
  reconcileConfirmedBulkWorkspace,
} from '../src/lib/bulk-document-reconciliation.ts';
import { MemoryFolioRepository } from '../src/lib/memory-repository.ts';

const catalog = {
  tags: [
    { id: 'remote-tag-3', remoteId: 3, name: 'Taxes' },
    { id: 'remote-tag-8', remoteId: 8, name: 'Inbox', isInboxTag: true },
    { id: 'remote-tag-9', remoteId: 9, name: 'Reviewed' },
  ],
  correspondents: [{ id: 'remote-correspondent-4', remoteId: 4, name: 'Acme' }],
  documentTypes: [{ id: 'remote-type-5', remoteId: 5, name: 'Invoice' }],
  storagePaths: [{ id: 'remote-storage-path-6', remoteId: 6, name: 'Archive' }],
  owners: [{ id: 'remote-owner-7', remoteId: 7, name: 'Ari' }],
  customFields: [],
  savedViews: [],
};

const labels = {
  noCorrespondent: 'No correspondent',
  unknownCorrespondent: 'Unknown correspondent',
  unsortedDocumentType: 'Unsorted',
  unknownDocumentType: 'Remote document',
  automaticStoragePath: 'Automatic',
  unknownStoragePath: 'Unknown storage path',
  unknownTag: '—',
  reprocessing: 'Reprocessing…',
};

function document(remoteId, overrides = {}) {
  return {
    id: `remote-${remoteId}`,
    remoteId,
    title: `Document ${remoteId}`,
    correspondent: 'Acme',
    correspondentId: 'remote-correspondent-4',
    documentType: 'Invoice',
    documentTypeId: 'remote-type-5',
    storagePath: 'Archive',
    storagePathId: 'remote-storage-path-6',
    owner: 'Ari',
    ownerId: 'remote-owner-7',
    created: '2026-01-01',
    added: '2026-01-02',
    pageCount: 1,
    fileSize: '1 KB',
    tags: ['Taxes', 'Inbox'],
    tagIds: ['remote-tag-3', 'remote-tag-8'],
    status: 'inbox',
    color: '#fff',
    accent: '#000',
    excerpt: '',
    source: 'remote',
    ...overrides,
  };
}

function result(operation, overrides = {}) {
  return {
    operation,
    accepted: true,
    pending: [],
    succeeded: [1],
    failed: [],
    skipped: [],
    requestCount: 1,
    taskIds: [],
    ...overrides,
  };
}

function reconciliation(operation, overrides = {}) {
  const nextResult = result(operation, overrides);
  return {
    result: nextResult,
    targets: [1, 2, 3].map((remoteDocumentId) => ({
      localId: `remote-${remoteDocumentId}`,
      remoteDocumentId,
    })),
    catalog,
    labels,
  };
}

function workspace(profileId, documents = [document(1), document(2), document(3)]) {
  return {
    profileId,
    documents,
    catalog,
    totalDocuments: documents.length,
    lastSyncedAt: '2026-08-02T12:00:00.000Z',
    syncState: 'error',
    syncError: 'refresh failed',
  };
}

test('confirmed bulk projection covers tags, filing, scalar fields, reprocess, and trash', () => {
  const source = document(1);
  const project = (operation) => reconcileConfirmedBulkDocuments(
    [source],
    reconciliation(operation),
  );

  assert.deepEqual(project({ kind: 'tags', mode: 'add', tagIds: [9] })[0].tagIds,
    ['remote-tag-3', 'remote-tag-8', 'remote-tag-9']);
  assert.deepEqual(project({ kind: 'tags', mode: 'remove', tagIds: [3] })[0].tagIds,
    ['remote-tag-8']);
  assert.deepEqual(project({ kind: 'tags', mode: 'replace', tagIds: [9] })[0].tagIds,
    ['remote-tag-9']);

  const filed = project({ kind: 'file', inboxTagIds: [8] })[0];
  assert.deepEqual(filed.tagIds, ['remote-tag-3']);
  assert.equal(filed.status, 'archived');

  const correspondent = project({ kind: 'setCorrespondent', value: null })[0];
  assert.equal(correspondent.correspondent, 'No correspondent');
  assert.equal(correspondent.correspondentId, undefined);
  const documentType = project({ kind: 'setDocumentType', value: 5 })[0];
  assert.equal(documentType.documentTypeId, 'remote-type-5');
  const storagePath = project({ kind: 'setStoragePath', value: null })[0];
  assert.equal(storagePath.storagePath, 'Automatic');
  const owner = project({ kind: 'setOwner', value: null })[0];
  assert.equal(owner.owner, undefined);
  assert.equal(owner.ownerId, undefined);
  assert.equal(project({ kind: 'reprocess' })[0].suggestion, 'Reprocessing…');
  assert.deepEqual(project({ kind: 'trash' }), []);
});

test('partial results reconcile only unambiguous selected successes', () => {
  const documents = [document(1), document(2), document(3), document(4)];
  const input = reconciliation(
    { kind: 'tags', mode: 'add', tagIds: [9] },
    {
      succeeded: [1, 2, 3, 4],
      failed: [{
        localId: 'remote-2',
        status: 403,
        code: 'permission-denied',
        message: 'denied',
        retryable: false,
      }],
      skipped: [{ localId: 'remote-3', remoteId: 3, reason: 'read-only' }],
    },
  );
  const reconciled = reconcileConfirmedBulkDocuments(documents, input);

  assert.deepEqual(reconciled[0].tagIds, ['remote-tag-3', 'remote-tag-8', 'remote-tag-9']);
  assert.deepEqual(reconciled[1].tagIds, documents[1].tagIds);
  assert.deepEqual(reconciled[2].tagIds, documents[2].tagIds);
  // ID 4 was not part of the submitted target correlation and fails closed.
  assert.deepEqual(reconciled[3].tagIds, documents[3].tagIds);
});

test('contradictory and non-bijective outcome identifiers fail closed', () => {
  const contradictory = reconciliation(
    { kind: 'trash' },
    {
      succeeded: [1, 2],
      failed: [{
        localId: 'remote-1',
        remoteId: 2,
        status: 409,
        code: 'write-conflict',
        message: 'conflicting identifiers',
        retryable: true,
      }],
    },
  );
  assert.deepEqual(confirmedBulkSucceededIds(contradictory), []);

  const ambiguousTarget = {
    ...reconciliation({ kind: 'trash' }, { succeeded: [1] }),
    targets: [
      { localId: 'local-a', remoteDocumentId: 1 },
      { localId: 'local-b', remoteDocumentId: 1 },
    ],
  };
  assert.deepEqual(confirmedBulkSucceededIds(ambiguousTarget), []);
});

test('stale catalog projection retains exact remote metadata identities', () => {
  const staleCatalog = {
    ...reconciliation({ kind: 'tags', mode: 'replace', tagIds: [404] }),
    catalog: { ...catalog, tags: [] },
  };
  const tagged = reconcileConfirmedBulkDocuments([document(1)], staleCatalog)[0];
  assert.deepEqual(tagged.tagIds, ['remote-tag-404']);
  assert.deepEqual(tagged.tags, ['—']);

  const correspondent = reconcileConfirmedBulkDocuments(
    [document(1)],
    { ...staleCatalog, result: result({ kind: 'setCorrespondent', value: 405 }) },
  )[0];
  assert.equal(correspondent.correspondent, 'Unknown correspondent');
  assert.equal(correspondent.correspondentId, 'remote-correspondent-405');
});

test('asynchronous pending IDs are never projected as completed', () => {
  const documents = [document(1), document(2)];
  const input = reconciliation(
    { kind: 'trash' },
    { succeeded: [1, 2], pending: [2], taskIds: ['paperless-task'] },
  );
  assert.deepEqual(
    reconcileConfirmedBulkDocuments(documents, input).map((item) => item.remoteId),
    [2],
  );
});

test('trash reconciliation is idempotent and decrements only rows actually removed', () => {
  const input = reconciliation({ kind: 'trash' }, { succeeded: [1, 99] });
  input.targets.push({ localId: 'remote-99', remoteDocumentId: 99 });
  const initial = workspace('profile-a');
  const first = reconcileConfirmedBulkWorkspace(initial, input);
  const replay = reconcileConfirmedBulkWorkspace(first, input);

  assert.deepEqual(first.documents.map((item) => item.remoteId), [2, 3]);
  assert.equal(first.totalDocuments, 2);
  assert.deepEqual(replay, first);
});

test('failed immediate refresh commits and publishes the exact profile fallback', async () => {
  const repository = new MemoryFolioRepository();
  await repository.replaceWorkspace(workspace('profile-a'));
  const input = reconciliation({ kind: 'trash' });
  let published;

  const outcome = await reconcileConfirmedBulkThenRefresh({
    async refresh() { return false; },
    async reconcile() {
      const commit = await commitConfirmedBulkReconciliation({
        repository,
        profileId: 'profile-a',
        reconciliation: input,
        executionGuard: () => true,
        publish(next) { published = next; },
      });
      assert.equal(commit.status, 'published');
    },
  });

  assert.equal(outcome, 'reconciled');
  assert.deepEqual(published.documents.map((item) => item.remoteId), [2, 3]);
  assert.equal(published.totalDocuments, 2);
  const persisted = await repository.readWorkspace('profile-a');
  assert.deepEqual(persisted.documents.map((item) => item.remoteId), [2, 3]);
  assert.equal(persisted.totalDocuments, 2);
});

test('successful refresh runs after and supersedes the local reconciliation', async () => {
  const sequence = [];
  const outcome = await reconcileConfirmedBulkThenRefresh({
    async refresh() { sequence.push('refresh'); return true; },
    async reconcile() { sequence.push('reconcile'); },
  });
  assert.equal(outcome, 'refreshed');
  assert.deepEqual(sequence, ['reconcile', 'refresh']);
});

test('profile switch during persistence cannot publish into the new live epoch', async () => {
  const storage = new MemoryFolioRepository();
  await storage.replaceWorkspace(workspace('profile-a'));
  await storage.replaceWorkspace(workspace('profile-b', [document(9)]));
  let activeProfileId = 'profile-a';
  let publications = 0;
  const repository = {
    ...storage,
    async reconcileBulkDocuments(profileId, input) {
      const committed = await storage.reconcileBulkDocuments(profileId, input);
      activeProfileId = 'profile-b';
      return committed;
    },
  };

  const commit = await commitConfirmedBulkReconciliation({
    repository,
    profileId: 'profile-a',
    reconciliation: reconciliation({ kind: 'tags', mode: 'replace', tagIds: [9] }),
    executionGuard: () => activeProfileId === 'profile-a',
    publish() { publications += 1; },
  });

  assert.equal(commit.status, 'stale');
  assert.equal(publications, 0);
  assert.deepEqual((await storage.readWorkspace('profile-a')).documents[0].tagIds,
    ['remote-tag-9']);
  assert.deepEqual((await storage.readWorkspace('profile-b')).documents[0].tagIds,
    ['remote-tag-3', 'remote-tag-8']);
});

test('persistence failure leaves live state unpublished', async () => {
  const visible = workspace('profile-a');
  let publications = 0;
  await assert.rejects(() => commitConfirmedBulkReconciliation({
    repository: {
      async reconcileBulkDocuments() {
        throw new Error('disk full');
      },
    },
    profileId: 'profile-a',
    reconciliation: reconciliation({ kind: 'trash' }),
    executionGuard: () => true,
    publish() { publications += 1; },
  }), /disk full/);
  assert.equal(publications, 0);
  assert.deepEqual(visible.documents.map((item) => item.remoteId), [1, 2, 3]);
});
