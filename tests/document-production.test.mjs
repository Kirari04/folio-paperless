import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  buildAcceptedAiPatch,
  buildPublicShareUrl,
  chooseRepresentation,
  compilePdfEditorOperations,
  createPdfEditorPages,
  deletePdfEditorSelection,
  emptyAiCustomFieldSuggestionDecisions,
  emptyAiSuggestionDecisions,
  movePdfEditorSelection,
  loadRepresentationPreference,
  parseRepresentationPreference,
  parseDocumentSecurity,
  planDeletePages,
  planReorderPages,
  planSplitPages,
  representationSupportsNativePrint,
  rotatePdfEditorSelection,
  REPRESENTATION_PREFERENCE_KEY,
  safeRepresentationFilename,
  scopeAiSuggestionsToVisibleCatalog,
  saveRepresentationPreference,
  selectRepresentation,
  togglePdfEditorSplits,
} from '../src/lib/document-production.ts';
import {
  deriveSearchablePdfPages,
  searchPdfPages,
  validateNativePdfSearchEvent,
} from '../src/lib/viewer-search.ts';
import {
  assertSafeTemporaryPathSegment,
  isExpiredTemporaryFile,
  viewerCacheFilename,
} from '../src/lib/temporary-file-policy.ts';

const representations = {
  archive: {
    representation: 'archive',
    available: true,
    filename: 'return.pdf',
    mimeType: 'application/pdf',
    size: 2450,
    downloadPath: '/api/documents/8/download/?original=false',
    previewPath: '/api/documents/8/preview/',
  },
  original: {
    representation: 'original',
    available: false,
    filename: null,
    mimeType: null,
    size: null,
    downloadPath: null,
    previewPath: null,
  },
};

test('representation selection never silently substitutes a requested file', () => {
  assert.equal(selectRepresentation(representations, 'archive').info.filename, 'return.pdf');
  assert.throws(
    () => selectRepresentation(representations, 'original'),
    /unavailable.*No other representation was substituted/i,
  );
  assert.equal(
    safeRepresentationFilename(8, 'Tax / Return', { ...representations.archive, filename: '../Tax:Return?.pdf' }),
    '-Tax-Return-.pdf',
  );
});

test('native printing is offered only for an explicit PDF representation', () => {
  assert.equal(representationSupportsNativePrint(representations.archive, 'ios'), true);
  assert.equal(representationSupportsNativePrint(representations.archive, 'android'), true);
  assert.equal(representationSupportsNativePrint(representations.archive, 'web'), false);
  assert.equal(representationSupportsNativePrint({ filename: 'scan.pdf', mimeType: 'image/jpeg' }, 'ios'), false);
  assert.equal(representationSupportsNativePrint({ filename: 'scan.PDF', mimeType: null }, 'ios'), true);
  assert.equal(representationSupportsNativePrint({ filename: 'scan.bin', mimeType: null }, 'ios'), false);
  assert.equal(representationSupportsNativePrint({ filename: 'scan.pdf', mimeType: 'application/pdf; charset=binary' }, 'android'), true);
});

test('representation preference persists only a validated available enum', async () => {
  const values = new Map();
  const deleted = [];
  const store = {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
    async deleteItem(key) { deleted.push(key); values.delete(key); },
  };
  assert.equal(parseRepresentationPreference('archive'), 'archive');
  assert.equal(parseRepresentationPreference('original'), 'original');
  assert.equal(parseRepresentationPreference('preview'), null);
  assert.equal(parseRepresentationPreference({ representation: 'original' }), null);

  await saveRepresentationPreference(store, 'original');
  assert.equal(values.get(REPRESENTATION_PREFERENCE_KEY), 'original');
  assert.equal(await loadRepresentationPreference(store), 'original');
  await assert.rejects(saveRepresentationPreference(store, 'preview'), /archive or original/);

  values.set(REPRESENTATION_PREFERENCE_KEY, '{"token":"secret"}');
  assert.equal(await loadRepresentationPreference(store), null);
  assert.deepEqual(deleted, [REPRESENTATION_PREFERENCE_KEY]);

  const both = {
    ...representations,
    original: { ...representations.original, available: true },
  };
  assert.equal(chooseRepresentation(both, 'original').selected, 'original');
  assert.equal(chooseRepresentation(representations, 'original').selected, 'archive');
  assert.throws(
    () => selectRepresentation(representations, 'original'),
    /No other representation was substituted/,
  );
});

test('file-action chooser restores and saves one preference for preview, save, print, and share', () => {
  const source = fs.readFileSync(new URL('../src/components/document-file-actions.tsx', import.meta.url), 'utf8');
  assert.match(source, /loadRepresentationPreference\(representationPreferenceStore\)/);
  assert.match(source, /saveRepresentationPreference\(representationPreferenceStore, representation\)/);
  assert.match(source, /prepareAndRun\('print'\)/);
  assert.match(source, /prepareAndRun\('share'\)/);
  assert.match(source, /prepareAndRun\('save'\)/);
  assert.match(source, /representationFilePath\(representations, selected, 'preview'/);
});

test('public share URLs contain only the server origin/path and opaque Paperless slug', () => {
  const result = buildPublicShareUrl(
    'https://user:private-token@paperless.example/base/?auth=secret#fragment',
    { slug: 'opaque_123-ABC' },
  );
  assert.equal(result, 'https://paperless.example/base/share/opaque_123-ABC');
  assert.doesNotMatch(result, /private-token|auth=|fragment/);
  assert.throws(() => buildPublicShareUrl('https://paperless.example', { slug: '../documents/1' }), /unsafe/);
});

test('full-permission parsing normalizes owner and exact view/change subjects', () => {
  assert.deepEqual(parseDocumentSecurity({
    owner: 7,
    user_can_change: false,
    permissions: {
      view: { users: [9, 9, -1, '12'], groups: [3] },
      change: { users: [7], groups: [4, 4] },
    },
  }), {
    ownerId: 7,
    canChange: false,
    permissions: {
      view: { users: [9], groups: [3] },
      change: { users: [7], groups: [4] },
    },
  });
  assert.throws(() => parseDocumentSecurity({ permissions: null }), /full object permissions/);
});

test('AI patch applies only explicitly accepted validated fields', () => {
  const suggestions = {
    title: 'Quarterly return',
    correspondentIds: [4],
    tagIds: [2, 3],
    documentTypeIds: [6],
    storagePathIds: [8],
    dates: ['2026-07-31'],
    customFields: { 10: 'safe', 11: 42 },
    proposedTags: ['Untrusted new tag'],
    proposedCorrespondents: [],
    proposedDocumentTypes: [],
    proposedStoragePaths: [],
  };
  const decisions = { ...emptyAiSuggestionDecisions(), title: 'accepted', tags: 'accepted' };
  assert.deepEqual(buildAcceptedAiPatch(suggestions, decisions, 'Edited title'), {
    title: 'Edited title',
    tags: [2, 3],
  });
  assert.deepEqual(
    buildAcceptedAiPatch(
      suggestions,
      emptyAiSuggestionDecisions(),
      undefined,
      { 10: 'accepted', 11: 'dismissed' },
    ),
    { custom_fields: [{ field: 10, value: 'safe' }] },
  );
  assert.deepEqual(emptyAiCustomFieldSuggestionDecisions(suggestions), {
    10: 'pending',
    11: 'pending',
  });
  assert.throws(
    () => buildAcceptedAiPatch(suggestions, { ...emptyAiSuggestionDecisions(), title: 'accepted' }, 'unsafe\u0000title'),
    /safe characters/,
  );
  assert.throws(() => buildAcceptedAiPatch(suggestions, emptyAiSuggestionDecisions()), /Accept at least one/);
});

test('AI IDs invisible to the current catalog are untrusted and cannot be accepted', () => {
  const suggestions = {
    title: 'Visible title', correspondentIds: [4, 999], proposedCorrespondents: [],
    tagIds: [2, 404], proposedTags: [], documentTypeIds: [6, 600], proposedDocumentTypes: [],
    storagePathIds: [8, 800], proposedStoragePaths: [], dates: [], customFields: { 10: 'ok', 11: 'not-an-integer', 999: 'hidden' },
  };
  const catalog = {
    correspondents: [{ id: 'remote-correspondent-4', remoteId: 4, name: 'Acme' }],
    tags: [{ id: 'remote-tag-2', remoteId: 2, name: 'Taxes' }],
    documentTypes: [{ id: 'remote-type-6', remoteId: 6, name: 'Invoice' }],
    storagePaths: [{ id: 'remote-storage-path-8', remoteId: 8, name: 'Archive' }],
    owners: [], workflows: [], savedViews: [],
    customFields: [
      { id: 'remote-custom-10', remoteId: 10, name: 'Reference', dataType: 'string', selectOptions: [] },
      { id: 'remote-custom-11', remoteId: 11, name: 'Count', dataType: 'integer', selectOptions: [] },
    ],
  };
  const scoped = scopeAiSuggestionsToVisibleCatalog(suggestions, catalog, true);
  assert.deepEqual(scoped.value.correspondentIds, [4]);
  assert.deepEqual(scoped.value.tagIds, [2]);
  assert.deepEqual(scoped.value.documentTypeIds, [6]);
  assert.deepEqual(scoped.value.storagePathIds, [8]);
  assert.deepEqual(scoped.value.customFields, { 10: 'ok' });
  assert.deepEqual(scoped.acceptableCustomFieldIds, ['10']);
  assert.equal(scoped.labels.tags, 'Taxes');
  assert.match(scoped.warnings.join(' '), /999.*not visible|not visible.*999/);
  assert.match(scoped.warnings.join(' '), /11.*field type|field type.*11/);

  const readOnly = scopeAiSuggestionsToVisibleCatalog(suggestions, catalog, false);
  assert.deepEqual(readOnly.acceptableFields, []);
  assert.deepEqual(readOnly.acceptableCustomFieldIds, []);
  assert.match(readOnly.warnings[0], /read-only/);
});

test('PDF edit planners enforce exact page coverage and retain at least one page', () => {
  assert.deepEqual(planReorderPages('3,1,2', 3), [{ page: 3 }, { page: 1 }, { page: 2 }]);
  assert.deepEqual(planDeletePages('2', 3), [{ page: 1 }, { page: 3 }]);
  assert.deepEqual(planSplitPages('1,3|2', 3), [
    { page: 1, outputDocument: 0 },
    { page: 3, outputDocument: 0 },
    { page: 2, outputDocument: 1 },
  ]);
  assert.throws(() => planReorderPages('1,2', 3), /every page/);
  assert.throws(() => planDeletePages('1,2,3', 3), /one page must remain/);
  assert.throws(() => planSplitPages('1|1,2', 3), /every page exactly once/);
});

test('viewer search navigates only when OCR has trustworthy page boundaries', async () => {
  assert.equal(deriveSearchablePdfPages('page one\npage two', 2), null);
  assert.equal(deriveSearchablePdfPages('First TAX line\fSecond tax line', 2), null);
  const pages = [
    { page: 1, text: 'First TAX line', source: 'page-extraction' },
    { page: 2, text: 'Second tax line', source: 'page-extraction' },
  ];
  const result = await searchPdfPages(pages, 'tax');
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.matches.map((match) => match.page), [1, 2]);
  assert.equal(result.matches[0].snippetMatch, 'TAX');

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchPdfPages(pages, 'tax', controller.signal), { name: 'AbortError' });

  const untrusted = await searchPdfPages([{ page: 1, text: 'tax' }], 'tax');
  assert.equal(untrusted.status, 'no-searchable-text');
});

test('native PDF search accepts only current bounded page-aware renderer events', () => {
  const event = validateNativePdfSearchEvent({
    status: 'ready',
    query: 'tax',
    truncated: false,
    matches: [{
      page: 2,
      start: 14,
      end: 17,
      snippetBefore: 'Annual ',
      snippetMatch: 'tax',
      snippetAfter: ' return',
    }],
  }, ' tax ', { pageCount: 2 });
  assert.equal(event?.status, 'ready');
  assert.equal(event?.matches[0].page, 2);
  assert.equal(validateNativePdfSearchEvent({ ...event, query: 'stale' }, 'tax', { pageCount: 2 }), null);
  assert.equal(validateNativePdfSearchEvent(event, 'tax\nreturn', { pageCount: 2 }), null);
  assert.equal(validateNativePdfSearchEvent({
    ...event,
    matches: [{ ...event.matches[0], page: 0 }],
  }, 'tax', { pageCount: 2 }), null);
  assert.equal(validateNativePdfSearchEvent({
    ...event,
    matches: [{ ...event.matches[0], page: 3 }],
  }, 'tax', { pageCount: 2 }), null);
});

test('visual PDF page plans compile reorder, rotation, deletion, and split state', () => {
  let pages = createPdfEditorPages(4);
  pages = movePdfEditorSelection(pages, new Set([3]), -1);
  pages = rotatePdfEditorSelection(pages, new Set([3]), 90);
  pages = deletePdfEditorSelection(pages, new Set([2]));
  pages = togglePdfEditorSplits(pages, new Set([3]));
  assert.deepEqual(pages, [
    { sourcePage: 1, rotation: 0, splitAfter: false },
    { sourcePage: 3, rotation: 90, splitAfter: true },
    { sourcePage: 4, rotation: 0, splitAfter: false },
  ]);
  assert.deepEqual(compilePdfEditorOperations(pages), {
    hasSplits: true,
    operations: [
      { page: 1, outputDocument: 0 },
      { page: 3, rotate: 90, outputDocument: 0 },
      { page: 4, outputDocument: 1 },
    ],
  });
  assert.throws(
    () => deletePdfEditorSelection(pages, new Set([1, 3, 4])),
    /one page must remain/i,
  );
});

test('viewer cache paths are profile scoped by the caller and reject traversal', () => {
  assert.equal(assertSafeTemporaryPathSegment('profile-a_1', 'profile'), 'profile-a_1');
  assert.throws(() => assertSafeTemporaryPathSegment('../profile-a', 'profile'), /not safe/);
  assert.throws(() => assertSafeTemporaryPathSegment('profile/a', 'profile'), /not safe/);
  assert.equal(viewerCacheFilename({
    documentId: 42,
    representation: 'archive',
    versionId: 7,
    detailsRevision: 3,
  }), 'document-42-archive-7-3-preview.pdf');
});

test('temporary viewer and export files expire conservatively', () => {
  const now = Date.UTC(2026, 7, 2);
  assert.equal(isExpiredTemporaryFile(now - 1_000, now, 10_000), false);
  assert.equal(isExpiredTemporaryFile(now - 10_001, now, 10_000), true);
  assert.equal(isExpiredTemporaryFile(null, now, 10_000), true);
});
