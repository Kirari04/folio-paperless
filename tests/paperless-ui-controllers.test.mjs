import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildBulkCandidates,
  executeBulkDocumentOperation,
  selectShownDocuments,
  submitPersistentBulkTask,
  summarizeLibrarySelection,
  toggleStableSelection,
} from '../src/lib/bulk-document-controller.ts';
import {
  availableTagParents,
  buildSparseCatalogEdit,
  catalogObjectStableId,
  catalogObjectToOption,
  catalogUsageWarning,
  reconcileCatalogDocumentMutation,
  reconcileCatalogRename,
  reconcileCatalogWorkspaceMutation,
} from '../src/lib/catalog-management.ts';
import {
  appendPaperlessSavedViewRules,
  buildSavedViewEdit,
  folioSavedViewMode,
  hasUnsupportedSavedViewRules,
  serializeLibrarySavedViewState,
  paperlessSavedViewDisplayMode,
  reconcileLibraryFiltersWithCatalog,
} from '../src/lib/saved-view-controller.ts';
import { savedViewToLibraryState } from '../src/lib/library-filters.ts';

function document(id, remoteId, overrides = {}) {
  return {
    id,
    remoteId,
    title: id,
    correspondent: 'Acme',
    correspondentId: 'remote-correspondent-4',
    documentType: 'Invoice',
    documentTypeId: 'remote-type-5',
    storagePath: 'Archive',
    storagePathId: 'remote-storage-path-6',
    created: '2026-01-01',
    added: '2026-01-02',
    pageCount: 1,
    fileSize: '1 KB',
    tags: ['Taxes'],
    tagIds: ['remote-tag-3'],
    status: 'archived',
    color: '#fff',
    accent: '#000',
    excerpt: '',
    source: 'remote',
    ...overrides,
  };
}

const emptyFilters = {
  status: 'any',
  correspondentIds: [], correspondentMode: 'include', correspondentMissing: false,
  documentTypeIds: [], documentTypeMode: 'include', documentTypeMissing: false,
  tagIds: [], tagMode: 'any',
  storagePathIds: [], storagePathMode: 'include', storagePathMissing: false,
  ownerIds: [], ownerMode: 'include', ownerMissing: false,
  customFieldIds: [], customFieldMode: 'any', mimeTypes: [],
  createdAfter: '', createdBefore: '', addedAfter: '', addedBefore: '', modifiedAfter: '', modifiedBefore: '',
  archiveSerialMin: '', archiveSerialMax: '', archiveSerialMissing: false,
};

const catalog = {
  tags: [{ id: 'remote-tag-3', remoteId: 3, name: 'Taxes' }],
  correspondents: [{ id: 'remote-correspondent-4', remoteId: 4, name: 'Acme' }],
  documentTypes: [{ id: 'remote-type-5', remoteId: 5, name: 'Invoice' }],
  storagePaths: [{ id: 'remote-storage-path-6', remoteId: 6, name: 'Archive' }],
  owners: [{ id: 'remote-owner-7', remoteId: 7, name: 'Ari' }],
  customFields: [],
  savedViews: [],
};

test('library selection uses stable IDs and discloses selections hidden by filters', () => {
  let selected = toggleStableSelection(new Set(), 'remote-1');
  selected = selectShownDocuments(selected, [document('remote-2', 2), document('remote-3', 3)]);
  assert.deepEqual([...selected], ['remote-1', 'remote-2', 'remote-3']);
  assert.deepEqual(summarizeLibrarySelection(selected, [document('remote-2', 2)]), {
    selected: 3,
    shownSelected: 1,
    hiddenSelected: 2,
    shown: 1,
  });
  assert.deepEqual([...toggleStableSelection(selected, 'remote-2')], ['remote-1', 'remote-3']);
});

test('bulk candidates retain per-item remote, processing, and permission eligibility', async () => {
  const documents = [
    document('ready', 1),
    document('processing', 2, { status: 'processing' }),
    document('readonly', 3, { canEdit: false }),
    document('local', undefined, { source: 'local' }),
  ];
  const selectedIds = new Set(documents.map((item) => item.id));
  assert.deepEqual(buildBulkCandidates(documents, selectedIds), [
    { localId: 'ready', remoteId: 1, ready: true, canEdit: undefined },
    { localId: 'processing', remoteId: 2, ready: false, canEdit: undefined },
    { localId: 'readonly', remoteId: 3, ready: true, canEdit: false },
    { localId: 'local', remoteId: null, ready: true, canEdit: undefined },
  ]);
  let received;
  const api = {
    client: { profileId: 'profile-a' },
    async bulkDocuments(candidates, operation, options) {
      received = { candidates, operation, options };
      return { supported: true, value: { operation, accepted: true, pending: [], succeeded: [1], failed: [], skipped: [], requestCount: 1, taskIds: [] } };
    },
  };
  await executeBulkDocumentOperation({
    api,
    expectedProfileId: 'profile-a',
    executionGuard: () => true,
    documents,
    selectedIds,
    operation: { kind: 'reprocess' },
  });
  assert.equal(received.options.concurrency, 1);
  assert.deepEqual(received.candidates.map((candidate) => candidate.remoteId), [1]);
});

test('bulk controller submits one eligible batch and retains asynchronous pending items', async () => {
  const documents = [1, 2, 3, 4].map((remoteId) => document(`remote-${remoteId}`, remoteId));
  let calls = 0;
  let received;
  const api = {
    client: { profileId: 'profile-a' },
    async bulkDocuments(candidates, operation, options) {
      calls += 1;
      received = { candidates, options };
      return {
        supported: true,
        value: {
          operation,
          accepted: true,
          pending: candidates.map((candidate) => candidate.remoteId),
          succeeded: [],
          failed: [],
          skipped: [],
          requestCount: 1,
          taskIds: ['paperless-bulk-task'],
        },
      };
    },
  };

  const result = await executeBulkDocumentOperation({
    api,
    expectedProfileId: 'profile-a',
    documents,
    selectedIds: new Set(documents.map((item) => item.id)),
    operation: { kind: 'tags', mode: 'add', tagIds: [7] },
  });

  assert.equal(calls, 1);
  assert.deepEqual(received.candidates.map((candidate) => candidate.remoteId), [1, 2, 3, 4]);
  assert.equal(received.options.concurrency, 3);
  assert.equal(result.supported, true);
  assert.deepEqual(result.value.pending, [1, 2, 3, 4]);
  assert.deepEqual(result.value.taskIds, ['paperless-bulk-task']);
});

test('durable bulk submission sends only pending failed targets', async () => {
  let body;
  const submission = await submitPersistentBulkTask({}, {
    schemaVersion: 2,
    id: 'bulk-retry',
    profileId: 'profile-a',
    batchId: 'bulk-batch',
    kind: 'bulk-operation',
    stage: 'queued',
    source: 'unknown',
    progress: 0,
    retryCount: 1,
    bulk: {
      operation: { kind: 'tags', mode: 'add', tagIds: [7] },
      targets: [
        { localId: 'one', remoteDocumentId: 1 },
        { localId: 'two', remoteDocumentId: 2 },
        { localId: 'three', remoteDocumentId: 3 },
        { localId: 'four', remoteDocumentId: 4 },
      ],
    },
    result: {
      bulkOutcomes: [
        { localId: 'one', remoteDocumentId: 1, state: 'succeeded' },
        { localId: 'two', remoteDocumentId: 2, state: 'pending' },
        { localId: 'three', remoteDocumentId: 3, state: 'skipped', skipReason: 'read-only' },
        { localId: 'four', remoteDocumentId: 4, state: 'pending' },
      ],
    },
    createdAt: '2026-08-02T12:00:00.000Z',
    updatedAt: '2026-08-02T12:01:00.000Z',
  }, {
    async request(_path, init) {
      body = JSON.parse(init.body);
      return {
        ok: true,
        status: 202,
        headers: new Headers(),
        async text() { return JSON.stringify({ task_id: 'paperless-retry-task' }); },
      };
    },
  });

  assert.deepEqual(body.documents, [2, 4]);
  assert.equal(submission.paperlessTaskId, 'paperless-retry-task');
});

test('bulk mutation rejects mismatched and stale profile executions before the API sink', async () => {
  let calls = 0;
  const api = {
    client: { profileId: 'profile-b' },
    async bulkDocuments() {
      calls += 1;
      throw new Error('must not execute');
    },
  };
  const input = {
    api,
    expectedProfileId: 'profile-a',
    documents: [document('ready', 1)],
    selectedIds: new Set(['ready']),
    operation: { kind: 'reprocess' },
  };

  await assert.rejects(() => executeBulkDocumentOperation(input), /profile changed/);
  api.client.profileId = 'profile-a';
  await assert.rejects(
    () => executeBulkDocumentOperation({ ...input, executionGuard: () => false }),
    /profile changed/,
  );
  assert.equal(calls, 0);
});

test('bulk export binds both credential sources and rechecks lifecycle before file exposure', async () => {
  const [exportSource, screenSource] = await Promise.all([
    readFile(new URL('../src/lib/bulk-document-export.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/documents.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(exportSource, /input\.api\.client\.profileId !== input\.expectedProfileId/);
  assert.match(exportSource, /input\.credentials\.profileId !== input\.expectedProfileId/);
  assert.ok((exportSource.match(/input\.executionGuard\?\.\(\) === false/g) ?? []).length >= 3);
  assert.match(exportSource, /redirect: 'manual'[\s\S]*input\.executionGuard\?\.\(\) === false/);
  assert.match(exportSource, /input\.executionGuard\?\.\(\) === false[\s\S]*await sharePreparedRepresentation/);
  assert.match(screenSource, /expectedProfileId: operationProfileId/);
  assert.match(screenSource, /executionGuard: \(\) => activeProfileIdRef\.current === operationProfileId/);
});

test('PDF operation UI and submission mirror Paperless change, add, delete, and owner gates', async () => {
  const [selectionSource, workspaceSource, editorSource, advancedSource] = await Promise.all([
    readFile(new URL('../src/components/document-pdf-merge-selection.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/document-paperless3-workspace.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/document-pdf-page-editor.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/paperless-advanced.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(selectionSource, /isChangeAuthorizedPdfMergeDocument\(document\)/);
  assert.match(selectionSource, /selectedIds\.every\(\(documentId\) => candidateIds\.has\(documentId\)\)/);
  assert.match(selectionSource, /if \(!canSubmitMerge\) return;[\s\S]*onMerge\(\[\.\.\.selectedIds\]\)/);
  assert.match(workspaceSource, /capabilities\?\.permissions\.document\.change === true/);
  assert.match(workspaceSource, /pdfAccess\?\.canChange === true/);
  assert.match(workspaceSource, /pdfAccess\.ownerId === null[\s\S]*pdfAccess\.ownerId === capabilities\?\.permissions\.currentUserId/);
  assert.match(workspaceSource, /pdfSplitEnabled = pdfEditEnabled[\s\S]*permissions\.document\.add === true/);
  assert.match(workspaceSource, /pdfMergeEnabled = pdfChangeAuthorized[\s\S]*permissions\.document\.add === true/);
  assert.match(workspaceSource, /mergeEnabled=\{pdfMergeEnabled\}/);
  assert.match(workspaceSource, /splitEnabled=\{pdfSplitEnabled\}/);
  assert.match(editorSource, /compiled\.hasSplits && !splitEnabled/);
  assert.match(advancedSource, /mapConcurrent\(documentIds, 3,[\s\S]*user_can_change !== 'boolean'/);
  assert.match(advancedSource, /\['add', requirements\.add === true\]/);
  assert.match(advancedSource, /\['delete', requirements\.delete === true\]/);
  assert.match(advancedSource, /requirements\.owner && response\.data\.owner !== null/);
  assert.match(advancedSource, /objectPermissionDenied[\s\S]*reason: 'permission-denied'/);
});

test('saved-view serializer stores query, sort, filters, and lossless extra rules', () => {
  const filters = {
    ...emptyFilters,
    status: 'inbox',
    tagIds: ['remote-tag-3'],
    tagMode: 'all',
    correspondentIds: ['remote-correspondent-4'],
    ownerMissing: true,
    mimeTypes: ['application/pdf'],
    createdAfter: '2026-01-01',
  };
  const serialized = serializeLibrarySavedViewState({
    query: ' annual return ', filters, sortOrder: 'title-desc', catalog,
    extraRules: [{ ruleType: 999, value: 'future' }],
  });
  assert.equal(serialized.sortField, 'title');
  assert.equal(serialized.sortReverse, true);
  assert.deepEqual(serialized.filterRules.map((rule) => [rule.ruleType, rule.value, rule.known]), [
    [5, 'true', true],
    [6, '3', true],
    [26, '4', true],
    [34, 'true', true],
    [47, 'application/pdf', true],
    [44, '2026-01-01', true],
    [49, 'annual return', true],
    [999, 'future', false],
  ]);
  const edit = buildSavedViewEdit(' Taxes ', { query: '', filters: emptyFilters, sortOrder: 'added-desc', catalog });
  assert.equal(edit.name, 'Taxes');
  assert.equal(edit.displayMode, 'table');
  assert.deepEqual(edit.displayFields, ['title', 'created', 'tag']);
  assert.equal(paperlessSavedViewDisplayMode('grid'), 'smallCards');
  assert.equal(folioSavedViewMode('largeCards'), 'grid');
  assert.equal(hasUnsupportedSavedViewRules(serialized.filterRules), true);
});

test('saved-view query rule identities and known opaque booleans round-trip exactly', () => {
  for (const queryRuleType of [19, 20, 48, 49]) {
    const view = {
      id: `query-${queryRuleType}`,
      remoteId: queryRuleType,
      name: `Query ${queryRuleType}`,
      sortField: 'added',
      sortReverse: true,
      filterRules: [{ ruleType: queryRuleType, value: 'invoice:2026', known: true, extra: {} }],
      pageSize: 25,
      displayMode: 'largeCards',
      displayFields: ['title'],
      extra: { future_presentation: 'dense' },
    };
    const converted = savedViewToLibraryState(view, catalog);
    assert.equal(converted.query, 'invoice:2026');
    assert.equal(converted.queryRuleType, queryRuleType);
    assert.deepEqual(
      serializeLibrarySavedViewState({ ...converted, catalog }).filterRules,
      [{ ruleType: queryRuleType, value: 'invoice:2026', known: true, extra: {} }],
    );
    const copy = buildSavedViewEdit('Copy', { ...converted, catalog, viewMode: 'grid' });
    assert.equal(copy.displayMode, 'largeCards');
    assert.equal(copy.pageSize, 25);
    assert.deepEqual(copy.displayFields, ['title']);
    assert.deepEqual(copy.extra, { future_presentation: 'dense' });
  }

  const notInbox = savedViewToLibraryState({
    id: 'not-inbox', remoteId: 90, name: 'Not inbox', sortField: 'added', sortReverse: true,
    filterRules: [{ ruleType: 5, value: 'false', known: true, extra: {} }],
    pageSize: 50, displayMode: 'table', displayFields: [],
  }, catalog);
  assert.equal(notInbox.filters.status, 'any');
  assert.deepEqual(notInbox.extraRules.map(({ ruleType, value }) => [ruleType, value]), [[5, 'false']]);
  assert.equal(hasUnsupportedSavedViewRules(notInbox.extraRules), true);
  assert.deepEqual(
    serializeLibrarySavedViewState({ ...notInbox, catalog }).filterRules.map(({ ruleType, value, known }) => [ruleType, value, known]),
    [[5, 'false', false]],
  );

  const customSort = savedViewToLibraryState({
    id: 'custom-sort', remoteId: 92, name: 'Custom sort', sortField: 'custom_field_17', sortReverse: false,
    filterRules: [], pageSize: 50, displayMode: 'table', displayFields: [],
  }, catalog);
  assert.deepEqual(serializeLibrarySavedViewState({ ...customSort, catalog }), {
    filterRules: [], sortField: 'custom_field_17', sortReverse: false,
  });
});

test('saved-view execution uses the canonical Paperless map and fails closed on future rules', () => {
  const params = new URLSearchParams();
  appendPaperlessSavedViewRules(params, [
    { ruleType: 5, value: 'false' },
    { ruleType: 20, value: 'title:invoice' },
    { ruleType: 48, value: 'Annual report' },
  ]);
  assert.equal(params.get('is_in_inbox'), '0');
  assert.equal(params.get('query'), 'title:invoice');
  assert.equal(params.get('title_search'), 'Annual report');
  assert.throws(
    () => appendPaperlessSavedViewRules(new URLSearchParams(), [{ ruleType: 999, value: 'private' }]),
    /refused to show broader results/,
  );
  assert.throws(
    () => appendPaperlessSavedViewRules(new URLSearchParams(), [{
      ruleType: 49, value: 'private', extra: { future_constraint: true },
    }]),
    /unsupported fields/,
  );
});

test('invisible catalog references stay wholly opaque during unrelated refinements', () => {
  const converted = savedViewToLibraryState({
    id: 'partly-private', remoteId: 91, name: 'Private tag', sortField: 'added', sortReverse: true,
    filterRules: [
      { ruleType: 22, value: '3,999', known: true, extra: {} },
      { ruleType: 26, value: '4', known: true, extra: { server_hint: 'retain' } },
    ],
    pageSize: 50, displayMode: 'table', displayFields: [],
  }, catalog);
  assert.deepEqual(converted.filters.tagIds, []);
  assert.deepEqual(converted.filters.correspondentIds, []);
  assert.deepEqual(converted.extraRules.map(({ ruleType, value }) => [ruleType, value]), [
    [22, '3,999'],
    [26, '4'],
  ]);

  const serialized = serializeLibrarySavedViewState({
    ...converted,
    filters: { ...converted.filters, status: 'inbox' },
    catalog,
  });
  assert.deepEqual(serialized.filterRules.map(({ ruleType, value, extra }) => [ruleType, value, extra]), [
    [5, 'true', {}],
    [22, '3,999', {}],
    [26, '4', { server_hint: 'retain' }],
  ]);

  const repeated = savedViewToLibraryState({
    id: 'repeated-private', remoteId: 93, name: 'Repeated private', sortField: 'added', sortReverse: true,
    filterRules: [
      { ruleType: 22, value: '3', known: true, extra: {} },
      { ruleType: 22, value: '999', known: true, extra: {} },
    ],
    pageSize: 50, displayMode: 'table', displayFields: [],
  }, catalog);
  assert.deepEqual(repeated.filters.tagIds, []);
  assert.deepEqual(repeated.extraRules.map((rule) => rule.value), ['3', '999']);

  const allVisibleCatalog = {
    ...catalog,
    tags: [...catalog.tags, { id: 'remote-tag-8', remoteId: 8, name: 'Receipts' }],
  };
  const repeatedVisible = savedViewToLibraryState({
    id: 'repeated-visible', remoteId: 94, name: 'Repeated visible', sortField: 'added', sortReverse: true,
    filterRules: [
      { ruleType: 22, value: '3', known: true, extra: {} },
      { ruleType: 22, value: '8', known: true, extra: {} },
    ],
    pageSize: 50, displayMode: 'table', displayFields: [],
  }, allVisibleCatalog);
  assert.deepEqual(repeatedVisible.filters.tagIds, ['remote-tag-3', 'remote-tag-8']);
  const repeatedVisibleRefined = serializeLibrarySavedViewState({
    ...repeatedVisible,
    filters: { ...repeatedVisible.filters, status: 'inbox' },
    catalog: allVisibleCatalog,
  });
  assert.deepEqual(repeatedVisibleRefined.filterRules.map(({ ruleType, value }) => [ruleType, value]), [
    [5, 'true'], [22, '3,8'],
  ]);
});

test('legacy strict dates and exact ASNs round-trip without changing semantics', () => {
  const converted = savedViewToLibraryState({
    id: 'legacy-ranges',
    remoteId: 17,
    name: 'Legacy ranges',
    sortField: 'added',
    sortReverse: true,
    filterRules: [
      { ruleType: 8, value: '2026-03-10', known: true },
      { ruleType: 9, value: '2026-03-01', known: true },
      { ruleType: 13, value: '2024-03-01', known: true },
      { ruleType: 14, value: '2024-02-27', known: true },
      { ruleType: 2, value: '120', known: true },
    ],
    pageSize: 50,
    displayMode: 'table',
    displayFields: [],
  }, catalog);

  assert.equal(converted.filters.createdBefore, '2026-03-09');
  assert.equal(converted.filters.createdAfter, '2026-03-02');
  assert.equal(converted.filters.addedBefore, '2024-02-29');
  assert.equal(converted.filters.addedAfter, '2024-02-28');
  assert.equal(converted.filters.archiveSerialMin, '119');
  assert.equal(converted.filters.archiveSerialMax, '121');

  const serialized = serializeLibrarySavedViewState({ ...converted, catalog });
  assert.deepEqual(serialized.filterRules.map(({ ruleType, value }) => [ruleType, value]), [
    [8, '2026-03-10'],
    [9, '2026-03-01'],
    [13, '2024-03-01'],
    [14, '2024-02-27'],
    [2, '120'],
  ]);
});

test('modified strict date rules preserve inclusive Folio semantics after refinement', () => {
  const converted = savedViewToLibraryState({
    id: 'modified', remoteId: 18, name: 'Modified', sortField: 'added', sortReverse: true,
    filterRules: [
      { ruleType: 15, value: '2026-03-10', known: true, extra: {} },
      { ruleType: 16, value: '2026-03-01', known: true, extra: {} },
    ],
    pageSize: 50, displayMode: 'table', displayFields: [],
  }, catalog);
  assert.equal(converted.filters.modifiedBefore, '2026-03-09');
  assert.equal(converted.filters.modifiedAfter, '2026-03-02');
  const serialized = serializeLibrarySavedViewState({
    ...converted,
    filters: { ...converted.filters, status: 'inbox' },
    catalog,
  });
  assert.deepEqual(serialized.filterRules.map(({ ruleType, value }) => [ruleType, value]), [
    [5, 'true'],
    [15, '2026-03-10'],
    [16, '2026-03-01'],
  ]);
});

test('saved-view serializer refuses stale resource identities and ambiguous MIME filters', () => {
  assert.throws(() => serializeLibrarySavedViewState({
    query: '', filters: { ...emptyFilters, tagIds: ['removed-tag'] }, sortOrder: 'added-desc', catalog,
  }), /no longer available/);
  assert.throws(() => serializeLibrarySavedViewState({
    query: '', filters: { ...emptyFilters, mimeTypes: ['application/pdf', 'image/png'] }, sortOrder: 'added-desc', catalog,
  }), /one MIME type/);
});

test('catalog reconciliation removes deleted stable IDs without disturbing other filters', () => {
  const filters = {
    ...emptyFilters,
    tagIds: ['remote-tag-3', 'remote-tag-999'],
    correspondentIds: ['remote-correspondent-4'],
    ownerIds: ['remote-owner-999'],
    status: 'inbox',
  };
  const reconciled = reconcileLibraryFiltersWithCatalog(filters, catalog);
  assert.deepEqual(reconciled.tagIds, ['remote-tag-3']);
  assert.deepEqual(reconciled.correspondentIds, ['remote-correspondent-4']);
  assert.deepEqual(reconciled.ownerIds, []);
  assert.equal(reconciled.status, 'inbox');
});

test('catalog helpers keep stable IDs, usage warnings, and targeted rename reconciliation', () => {
  const tag = {
    id: 3, kind: 'tag', name: 'Tax 2026', slug: 'tax-2026', color: '#aabbcc', textColor: '#000000',
    isInboxTag: false, parentId: null, children: [], match: '', matchingAlgorithm: null,
    isInsensitive: false, documentCount: 2, ownerId: null, permissions: null, userCanChange: true, extra: {},
  };
  assert.equal(catalogObjectStableId('tags', 3), 'remote-tag-3');
  assert.equal(catalogObjectStableId('storagePaths', 6), 'remote-storage-path-6');
  assert.deepEqual(catalogObjectToOption('tags', tag), { id: 'remote-tag-3', remoteId: 3, name: 'Tax 2026', color: '#aabbcc', isInboxTag: false });
  assert.equal(catalogUsageWarning(tag), '2 documents currently use this item.');
  const documents = [document('remote-1', 1), document('remote-2', 2, { tagIds: ['remote-tag-9'], tags: ['Other'] })];
  const reconciled = reconcileCatalogRename(documents, 'tags', tag);
  assert.deepEqual(reconciled[0].tags, ['Tax 2026']);
  assert.deepEqual(reconciled[1].tags, ['Other']);
});

test('confirmed catalog deletions remove stable references without disturbing unrelated tags', () => {
  const labels = {
    noCorrespondent: 'No correspondent',
    unsortedDocumentType: 'Unsorted',
    automaticStoragePath: 'Automatic',
    unknownTag: 'Unknown tag',
  };
  let current = document('remote-1', 1, {
    tagIds: ['remote-tag-3', 'remote-tag-9'],
    tags: ['Tax', 'Other'],
  });
  current = reconcileCatalogDocumentMutation(current, {
    kind: 'delete', resource: 'tags', remoteId: 3,
  }, labels);
  assert.deepEqual(current.tagIds, ['remote-tag-9']);
  assert.deepEqual(current.tags, ['Other']);
  current = reconcileCatalogDocumentMutation(current, {
    kind: 'delete', resource: 'correspondents', remoteId: 4,
  }, labels);
  current = reconcileCatalogDocumentMutation(current, {
    kind: 'delete', resource: 'documentTypes', remoteId: 5,
  }, labels);
  current = reconcileCatalogDocumentMutation(current, {
    kind: 'delete', resource: 'storagePaths', remoteId: 6,
  }, labels);
  assert.equal(current.correspondentId, undefined);
  assert.equal(current.correspondent, 'No correspondent');
  assert.equal(current.documentTypeId, undefined);
  assert.equal(current.documentType, 'Unsorted');
  assert.equal(current.storagePathId, undefined);
  assert.equal(current.storagePath, 'Automatic');
});

test('confirmed tag mutations rebuild visible descendant paths and orphan deleted children safely', () => {
  const labels = {
    noCorrespondent: 'No correspondent',
    unsortedDocumentType: 'Unsorted',
    automaticStoragePath: 'Automatic',
    unknownTag: 'Unknown tag',
  };
  const workspace = {
    profileId: 'profile-a',
    documents: [],
    catalog: {
      ...catalog,
      tags: [
        { id: 'remote-tag-3', remoteId: 3, name: 'Finance', pathLabel: 'Finance', depth: 0, childRemoteIds: [9] },
        { id: 'remote-tag-9', remoteId: 9, name: 'Tax', parentRemoteId: 3, pathLabel: 'Finance / Tax', depth: 1, childRemoteIds: [] },
      ],
    },
    totalDocuments: 0,
    lastSyncedAt: '2026-08-02T00:00:00.000Z',
    syncState: 'current',
  };
  const renamed = reconcileCatalogWorkspaceMutation(workspace, {
    kind: 'upsert',
    resource: 'tags',
    object: {
      id: 3, kind: 'tag', name: 'Finance 2026', slug: 'finance-2026', color: null,
      textColor: null, isInboxTag: false, parentId: null, children: [], match: '',
      matchingAlgorithm: null, isInsensitive: false, documentCount: 0, ownerId: null,
      permissions: null, userCanChange: true, extra: {},
    },
  }, labels);
  assert.equal(renamed.catalog.tags.find((tag) => tag.remoteId === 9).pathLabel, 'Finance 2026 / Tax');

  const deleted = reconcileCatalogWorkspaceMutation(renamed, {
    kind: 'delete', resource: 'tags', remoteId: 3,
  }, labels);
  assert.deepEqual(deleted.catalog.tags, [{
    id: 'remote-tag-9', remoteId: 9, name: 'Tax', color: undefined,
    pathLabel: 'Tax', depth: 0, childRemoteIds: [], isInboxTag: false,
  }]);
});

test('catalog editor drafts are sparse for missing and unfamiliar server values', () => {
  const oddTag = {
    id: 8, kind: 'tag', name: 'Legacy', slug: 'legacy', color: null, textColor: null,
    isInboxTag: false, parentId: null, children: [], match: '', matchingAlgorithm: 'future-auto',
    isInsensitive: false, documentCount: null, ownerId: null, permissions: null, userCanChange: true,
    extra: { future_field: true },
  };
  const rename = buildSparseCatalogEdit('tags', oddTag, {
    name: 'Renamed', match: '', matchingAlgorithm: 'future-auto', isInsensitive: false,
    color: '', path: '', parentId: null,
  }, true);
  assert.deepEqual(rename, { name: 'Renamed' });

  const missingStorage = {
    id: 9, kind: 'storagePath', name: 'Archive', slug: null, path: '', match: '',
    matchingAlgorithm: null, isInsensitive: false, documentCount: 1, ownerId: null,
    permissions: null, userCanChange: true, extra: {},
  };
  assert.deepEqual(buildSparseCatalogEdit('storagePaths', missingStorage, {
    name: 'Archive 2', match: '', matchingAlgorithm: '', isInsensitive: false,
    color: '', path: '', parentId: null,
  }, false), { name: 'Archive 2' });
});

test('documents wiring resets manual queries to rule 49 and retains source rules for save-as-new', async () => {
  const source = await readFile(new URL('../src/app/documents.tsx', import.meta.url), 'utf8');
  assert.match(source, /const \[queryRuleType, setQueryRuleType\] = useState<PaperlessQueryRuleType>\(49\)/);
  assert.match(source, /const updateQuery = useCallback[\s\S]*setQueryRuleType\(49\)/);
  assert.match(source, /setQueryRuleType\(preset\.queryRuleType\)/);
  assert.match(source, /sourceRules,[\s\S]*sourceRuleStateSignature,[\s\S]*savedViewExtra,[\s\S]*savedViewPresentation/);
  assert.match(source, /const newlyOpaque = savedViewToLibraryState\(selectedView, catalog\)\.extraRules/);
});

test('tag parent choices exclude the current tag and all descendants', () => {
  const base = { kind: 'tag', slug: null, color: null, textColor: null, isInboxTag: false, children: [], match: '', matchingAlgorithm: null, isInsensitive: false, documentCount: 0, ownerId: null, permissions: null, userCanChange: true, extra: {} };
  const tags = [
    { ...base, id: 1, name: 'Root', parentId: null },
    { ...base, id: 2, name: 'Child', parentId: 1 },
    { ...base, id: 3, name: 'Grandchild', parentId: 2 },
    { ...base, id: 4, name: 'Other', parentId: null },
  ];
  assert.deepEqual(availableTagParents(tags, 2).map((tag) => tag.id), [1, 4]);
});
