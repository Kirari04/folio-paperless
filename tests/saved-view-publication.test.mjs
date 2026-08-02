import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { MemoryFolioRepository } from '../src/lib/memory-repository.ts';
import {
  persistDeletedSavedView,
  persistReturnedSavedView,
} from '../src/lib/saved-view-publication.ts';
import {
  persistDeletedCatalogObject,
  persistReturnedCatalogObject,
} from '../src/lib/catalog-publication.ts';

const emptyCatalog = () => ({
  correspondents: [],
  documentTypes: [],
  tags: [],
  storagePaths: [],
  owners: [],
  customFields: [],
  savedViews: [],
});

const remoteView = (overrides = {}) => ({
  id: 19,
  name: 'Receipts',
  sortField: 'created',
  sortReverse: true,
  filterRules: [{
    ruleType: 999,
    value: 'opaque-value',
    known: false,
    extra: { future_rule_flag: { enabled: true } },
  }],
  pageSize: 75,
  displayMode: 'tiles',
  displayFields: ['title', 7],
  showOnDashboard: true,
  showInSidebar: false,
  ownerId: 4,
  permissions: null,
  userCanChange: true,
  extra: { future_view_field: ['lossless', 3] },
  ...overrides,
});

async function seed(repository, profileId, savedViews = []) {
  await repository.replaceWorkspace({
    profileId,
    documents: [],
    catalog: { ...emptyCatalog(), savedViews },
    totalDocuments: 0,
    lastSyncedAt: '2026-08-02T10:00:00.000Z',
    syncState: 'current',
  });
}

test('create publishes the returned saved view durably before a failed refresh', async () => {
  const repository = new MemoryFolioRepository();
  await seed(repository, 'profile-a');
  await seed(repository, 'profile-b');

  const published = await persistReturnedSavedView(repository, 'profile-a', remoteView());
  await assert.rejects(async () => {
    throw new Error('GET /api/saved_views/ failed');
  });

  const profileA = await repository.readWorkspace('profile-a');
  const profileB = await repository.readWorkspace('profile-b');
  assert.deepEqual(profileA.catalog.savedViews, [published]);
  assert.deepEqual(profileB.catalog.savedViews, []);
  assert.equal(published.id, 'remote-saved-view-19');
  assert.deepEqual(published.extra, { future_view_field: ['lossless', 3] });
  assert.deepEqual(published.filterRules[0].extra, { future_rule_flag: { enabled: true } });
  assert.deepEqual(published.displayFields, ['title', '7']);
});

test('update reconciles the returned object durably before a failed refresh', async () => {
  const repository = new MemoryFolioRepository();
  const stale = {
    id: 'remote-saved-view-19',
    remoteId: 19,
    name: 'Old receipts',
    sortField: 'added',
    sortReverse: false,
    filterRules: [],
    pageSize: 50,
    displayFields: [],
    extra: { stale: true },
  };
  await repository.replaceWorkspace({
    profileId: 'profile-a',
    documents: [],
    catalog: { ...emptyCatalog(), savedViews: [stale] },
    totalDocuments: 0,
    lastSyncedAt: '2026-08-02T10:00:00.000Z',
    syncState: 'current',
    savedViewSnapshots: {
      [stale.id]: {
        viewId: stale.id,
        viewFingerprint: 'stale-membership',
        documentIds: ['remote-1'],
        totalDocuments: 1,
        evaluatedAt: '2026-08-02T10:00:00.000Z',
      },
    },
  });

  const returned = remoteView({
    name: 'Updated receipts',
    extra: { server_revision: 'etag-2', nested: { retained: true } },
  });
  const published = await persistReturnedSavedView(repository, 'profile-a', returned);
  await assert.rejects(async () => {
    throw new Error('workspace refresh failed');
  });

  const cached = (await repository.readWorkspace('profile-a')).catalog.savedViews;
  assert.equal(cached.length, 1);
  assert.deepEqual(cached[0], published);
  assert.equal(cached[0].name, 'Updated receipts');
  assert.deepEqual(cached[0].extra, returned.extra);
  const rehydrated = await repository.readWorkspace('profile-a');
  assert.equal(rehydrated.savedViewSnapshots[stale.id], undefined);
});

test('confirmed saved-view delete survives failed refresh and cache rehydration', async () => {
  const repository = new MemoryFolioRepository();
  const persisted = {
    id: 'remote-saved-view-19',
    remoteId: 19,
    name: 'Receipts',
    sortField: 'added',
    sortReverse: false,
    filterRules: [],
    pageSize: 50,
    displayFields: [],
  };
  await repository.replaceWorkspace({
    profileId: 'profile-a',
    documents: [],
    catalog: { ...emptyCatalog(), savedViews: [persisted] },
    totalDocuments: 0,
    lastSyncedAt: '2026-08-02T10:00:00.000Z',
    syncState: 'current',
    savedViewSnapshots: {
      [persisted.id]: {
        viewId: persisted.id,
        viewFingerprint: 'stale',
        documentIds: [],
        totalDocuments: 0,
        evaluatedAt: '2026-08-02T10:00:00.000Z',
      },
    },
  });

  await persistDeletedSavedView(repository, 'profile-a', 19);
  await assert.rejects(async () => { throw new Error('refresh failed'); });

  const rehydrated = await repository.readWorkspace('profile-a');
  assert.deepEqual(rehydrated.catalog.savedViews, []);
  assert.deepEqual(rehydrated.savedViewSnapshots, {});
});

const catalogLabels = {
  noCorrespondent: 'No correspondent',
  unsortedDocumentType: 'Unsorted',
  automaticStoragePath: 'Automatic',
  unknownTag: 'Unknown tag',
};

const correspondent = (name) => ({
  id: 4,
  kind: 'correspondent',
  name,
  slug: 'accounts',
  match: '',
  matchingAlgorithm: null,
  isInsensitive: false,
  documentCount: 1,
  ownerId: null,
  permissions: null,
  userCanChange: true,
  lastCorrespondence: null,
  extra: { serverRevision: name },
});

function cachedDocument() {
  return {
    id: 'remote-1',
    remoteId: 1,
    title: 'Invoice',
    correspondent: 'Old accounts',
    correspondentId: 'remote-correspondent-4',
    documentType: 'Unsorted',
    created: '2026-08-01',
    added: '2026-08-01',
    pageCount: 1,
    fileSize: '1 KB',
    tags: [],
    tagIds: [],
    status: 'archived',
    color: '#fff',
    accent: '#000',
    excerpt: '',
  };
}

test('catalog rename and delete publish summaries and details before failed refresh', async () => {
  const repository = new MemoryFolioRepository();
  const document = cachedDocument();
  await repository.replaceWorkspace({
    profileId: 'profile-a',
    documents: [document],
    catalog: {
      ...emptyCatalog(),
      correspondents: [{
        id: 'remote-correspondent-4', remoteId: 4, name: 'Old accounts',
      }],
    },
    totalDocuments: 1,
    lastSyncedAt: '2026-08-02T10:00:00.000Z',
    syncState: 'current',
    savedViewSnapshots: {
      cached: {
        viewId: 'remote-saved-view-2',
        viewFingerprint: 'before-delete',
        documentIds: ['remote-1'],
        totalDocuments: 1,
        evaluatedAt: '2026-08-02T10:00:00.000Z',
      },
    },
  });
  await repository.writeDocumentDetail({
    profileId: 'profile-a',
    documentId: document.id,
    document,
    fetchedAt: '2026-08-02T10:00:00.000Z',
  });

  await persistReturnedCatalogObject(
    repository,
    'profile-a',
    'correspondents',
    correspondent('Accounts payable'),
    catalogLabels,
  );
  await assert.rejects(async () => { throw new Error('refresh failed'); });

  let rehydrated = await repository.readWorkspace('profile-a');
  assert.deepEqual(rehydrated.catalog.correspondents, [{
    id: 'remote-correspondent-4', remoteId: 4, name: 'Accounts payable',
  }]);
  assert.equal(rehydrated.documents[0].correspondent, 'Accounts payable');
  assert.equal(rehydrated.documents[0].correspondentId, 'remote-correspondent-4');
  assert.equal((await repository.readDocumentDetail('profile-a', 'remote-1')).document.correspondent, 'Accounts payable');

  await persistDeletedCatalogObject(
    repository,
    'profile-a',
    'correspondents',
    4,
    catalogLabels,
  );
  await assert.rejects(async () => { throw new Error('refresh failed again'); });

  rehydrated = await repository.readWorkspace('profile-a');
  assert.deepEqual(rehydrated.catalog.correspondents, []);
  assert.equal(rehydrated.documents[0].correspondent, 'No correspondent');
  assert.equal(rehydrated.documents[0].correspondentId, undefined);
  assert.deepEqual(rehydrated.savedViewSnapshots, {});
  const detail = await repository.readDocumentDetail('profile-a', 'remote-1');
  assert.equal(detail.document.correspondent, 'No correspondent');
  assert.equal(detail.document.correspondentId, undefined);
});

test('documents create and update paths publish the exact mutation result before refresh', async () => {
  const source = await readFile(new URL('../src/app/documents.tsx', import.meta.url), 'utf8');
  for (const functionName of ['saveCurrentView', 'updateCurrentView']) {
    const start = source.indexOf(`function ${functionName}`);
    const nextFunction = source.indexOf('\n  function ', start + 1);
    const body = source.slice(start, nextFunction < 0 ? source.length : nextFunction);
    const mutation = body.indexOf('const result = await advanced.api.');
    const publication = body.indexOf('await publishSavedView(activeProfileId, result.value)');
    const refresh = body.indexOf('await refreshLibrary()');
    assert.ok(start >= 0 && mutation >= 0, `${functionName} should perform a mutation`);
    assert.ok(mutation < publication, `${functionName} should publish the returned object`);
    assert.ok(publication < refresh, `${functionName} should publish before its fallible refresh`);
  }
});

test('management screens publish mutation results before their fallible refreshes', async () => {
  const savedViews = await readFile(new URL('../src/app/saved-views.tsx', import.meta.url), 'utf8');
  assert.ok(savedViews.indexOf('await publishSavedView(activeProfile.id, result.value)')
    < savedViews.indexOf('await refresh().catch'));
  assert.ok(savedViews.indexOf('await publishSavedViewDeletion(activeProfile.id, result.value.deletedId)')
    < savedViews.lastIndexOf('await refresh().catch'));

  const metadata = await readFile(new URL('../src/app/paperless-metadata.tsx', import.meta.url), 'utf8');
  assert.ok(metadata.indexOf('await publishCatalogObject(activeProfile.id, resource, result.value)')
    < metadata.indexOf('await refresh().catch'));
  assert.ok(metadata.indexOf('await publishCatalogDeletion(activeProfile.id, resource, result.value.deletedId)')
    < metadata.lastIndexOf('await refresh().catch'));
});

test('saved-view editor renders only negotiated presentation and visibility controls', async () => {
  const editor = await readFile(new URL('../src/components/saved-view-editor-sheet.tsx', import.meta.url), 'utf8');
  for (const field of [
    'displayMode',
    'displayFields',
    'pageSize',
    'showOnDashboard',
    'showInSidebar',
  ]) {
    assert.match(editor, new RegExp(`presentationCapabilities\\?\\.${field} &&`));
  }
  assert.match(editor, /opaqueDisplayFields\.map/);
  assert.match(editor, /serverFieldsPreserved/);
});

test('saved-view persistence fails explicitly when the profile has no workspace cache', async () => {
  const repository = new MemoryFolioRepository();
  await assert.rejects(
    persistReturnedSavedView(repository, 'missing-profile', remoteView()),
    /existing profile workspace/,
  );
});
