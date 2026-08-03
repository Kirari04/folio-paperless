import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PaperlessAdvancedApi,
  buildSavedViewUpdate,
  extractDuplicateSummaries,
  extractTaskIds,
  mergePermissionSets,
  normalizeNestedTags,
  parseDocumentRepresentations,
  parsePaperlessSavedView,
  parsePaperlessTag,
  parsePaperlessTaskV10,
  planPermissionMutation,
  restrictTagHierarchyToVisibleResults,
  selectChangeAuthorizedPdfMergeIds,
  selectBulkEligible,
  selectVisibleNestedTags,
  serializeShareLinkExpiry,
  validateAiSuggestions,
} from '../src/lib/paperless-advanced.ts';
import {
  PaperlessCapabilityCache,
  buildPaperlessPermissionMatrix,
  discoverPaperlessCapabilities,
} from '../src/lib/paperless-capabilities.ts';
import { PaperlessClient, PaperlessClientError } from '../src/lib/paperless-client.ts';
import {
  fullCapabilities,
  openApiFixture,
  paperless305ConsumeTaskFixture,
  paperless305PdfOperationAcceptedFixture,
  savedViewFixture,
  tagFixture,
} from './fixtures/paperless-advanced-fixtures.mjs';

function mockClient(handler, profileId = 'profile-a') {
  const requests = [];
  const client = new PaperlessClient({
    profileId,
    request: async (request) => {
      requests.push(request);
      return handler(request, requests);
    },
  });
  return { client, requests };
}

function pdfDetailForRequest(request, overrides = {}) {
  const match = request.method === 'GET' && request.path.match(/^\/api\/documents\/(\d+)\/$/);
  if (!match) return null;
  const id = Number(match[1]);
  return {
    status: 200,
    data: { id, owner: 7, user_can_change: true, ...overrides },
  };
}

const allPermissions = [
  'view_document',
  'add_document',
  'change_document',
  'delete_document',
  'view_tag',
  'add_tag',
  'change_tag',
  'delete_tag',
  'view_correspondent',
  'add_correspondent',
  'change_correspondent',
  'delete_correspondent',
  'view_documenttype',
  'add_documenttype',
  'change_documenttype',
  'delete_documenttype',
  'view_storagepath',
  'add_storagepath',
  'change_storagepath',
  'delete_storagepath',
  'view_savedview',
  'add_savedview',
  'change_savedview',
  'delete_savedview',
  'view_sharelink',
  'add_sharelink',
  'change_sharelink',
  'delete_sharelink',
];

test('PaperlessClient injects API v10 without handling raw credentials', async () => {
  const { client, requests } = mockClient(async () => ({ status: 200, data: { ok: true } }));
  const response = await client.post('/api/test/', { value: 1 });
  assert.deepEqual(response.data, { ok: true });
  assert.equal(requests[0].headers.Accept, 'application/json; version=10');
  assert.equal(requests[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(requests[0].json, { value: 1 });
  assert.equal('token' in requests[0], false);
});

test('PaperlessClient rejects external paths and normalizes HTTP errors', async () => {
  const { client } = mockClient(async () => ({ status: 429, data: { detail: 'Slow down' } }));
  await assert.rejects(client.get('https://other.example/api/'), /same-server absolute paths/);
  await assert.rejects(
    client.get('/api/documents/'),
    (error) =>
      error instanceof PaperlessClientError &&
      error.status === 429 &&
      error.retryable === true &&
      error.message === 'Slow down',
  );
});

test('permission discovery fails closed when UI settings are unavailable', () => {
  const matrix = buildPaperlessPermissionMatrix(null);
  assert.equal(matrix.tag.add, 'unknown');
  assert.equal(matrix.document.change, 'unknown');
  assert.equal(matrix.currentUserId, null);
});

test('unknown permissions preserve reads while bulk and catalog mutations fail closed', async () => {
  const { client } = mockClient(async (request) => {
    if (request.path === '/api/schema/') {
      return { status: 200, headers: { 'X-Api-Version': '10' }, data: openApiFixture() };
    }
    if (request.path === '/api/ui_settings/') return { status: 503, data: null };
    if (request.method === 'OPTIONS') {
      return { status: 200, headers: { Allow: 'GET, POST, PATCH, DELETE, OPTIONS' }, data: {} };
    }
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });
  const capabilities = await discoverPaperlessCapabilities(client);
  assert.equal(capabilities.features.catalogs.tags.list.supported, true);
  assert.deepEqual(capabilities.features.catalogs.tags.create, {
    supported: false,
    reason: 'permission-unknown',
    source: 'ui-settings',
  });
  assert.deepEqual(capabilities.features.bulkDocuments, {
    supported: false,
    reason: 'permission-unknown',
    source: 'ui-settings',
  });
  assert.deepEqual(capabilities.features.shareLinks.create, {
    supported: false,
    reason: 'permission-unknown',
    source: 'ui-settings',
  });
});

test('capability negotiation is schema-first, permission-aware, and runtime-aware', async () => {
  const { client } = mockClient(async (request) => {
    if (request.path === '/api/schema/') {
      return {
        status: 200,
        headers: { 'X-Api-Version': '10', 'X-Version': '3.0.5' },
        data: openApiFixture(),
      };
    }
    if (request.path === '/api/ui_settings/') {
      return {
        status: 200,
        headers: { 'X-Api-Version': '10', 'X-Version': '3.0.5' },
        data: {
          user: { id: 7, is_superuser: false },
          ai_enabled: false,
          permissions: allPermissions,
        },
      };
    }
    if (request.method === 'OPTIONS') {
      return { status: 200, headers: { Allow: 'GET, POST, PATCH, DELETE, OPTIONS' }, data: {} };
    }
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });

  const capabilities = await discoverPaperlessCapabilities(client, {
    now: new Date('2026-08-02T12:00:00Z'),
  });
  assert.equal(capabilities.profileId, 'profile-a');
  assert.equal(capabilities.apiVersion, '10');
  assert.equal(capabilities.serverFingerprint, '10|3.0.5|3.0.5');
  assert.equal(capabilities.features.nestedTags.supported, true);
  assert.equal(capabilities.features.duplicateDocuments.supported, true);
  assert.equal(capabilities.features.fullPermissions.supported, true);
  assert.deepEqual(capabilities.features.aiSuggestions, {
    supported: false,
    reason: 'runtime-disabled',
    source: 'runtime',
    detail: 'AI is disabled on this server.',
  });
  assert.equal(capabilities.features.shareLinks.create.supported, true);
  assert.equal(capabilities.features.shareLinks.update.supported, false);
  assert.equal(capabilities.features.pdf.edit.supported, true);
  assert.equal(capabilities.permissions.savedView.delete, true);
  assert.equal(capabilities.features.savedViews.fields.displayFields.supported, true);
  assert.equal(capabilities.features.savedViews.fields.showOnDashboard.supported, true);
});

test('saved-view presentation controls fail closed when PATCH fields are not advertised', async () => {
  const schema = openApiFixture();
  schema.components.schemas.SavedView.properties = { id: { type: 'integer' } };
  const { client } = mockClient(async (request) => {
    if (request.path === '/api/schema/') return { status: 200, data: schema };
    if (request.path === '/api/ui_settings/') {
      return { status: 200, data: { user: { id: 7 }, permissions: allPermissions } };
    }
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });

  const capabilities = await discoverPaperlessCapabilities(client, { optionPaths: [] });
  for (const status of Object.values(capabilities.features.savedViews.fields)) {
    assert.deepEqual(status, {
      supported: false,
      reason: 'field-missing',
      source: 'openapi',
    });
  }
});

test('OpenAPI property discovery stops at its traversal depth bound', async () => {
  let hiddenTagFields = {
    properties: {
      parent: { type: 'integer' },
      children: { type: 'array' },
    },
  };
  for (let depth = 0; depth < 40; depth += 1) {
    hiddenTagFields = { nested: hiddenTagFields };
  }
  const schema = {
    openapi: '3.0.3',
    info: { version: '3.0.5' },
    paths: { '/api/tags/': { get: hiddenTagFields } },
    components: { schemas: {} },
  };
  const { client } = mockClient(async (request) => {
    if (request.path === '/api/schema/') return { status: 200, data: schema };
    if (request.path === '/api/ui_settings/') {
      return { status: 200, data: { user: { id: 7 }, permissions: allPermissions } };
    }
    throw new Error(`Unexpected request ${request.method} ${request.path}`);
  });

  const capabilities = await discoverPaperlessCapabilities(client, { optionPaths: [] });

  assert.deepEqual(capabilities.features.nestedTags, {
    supported: false,
    reason: 'field-missing',
    source: 'openapi',
  });
});

test('capability cache isolates profiles, expiry, and connection bindings', () => {
  const cache = new PaperlessCapabilityCache();
  const capabilities = fullCapabilities();
  cache.set(capabilities, 1000, 5000, 'connection-a');
  assert.equal(cache.get('profile-b', 5001, 'connection-a'), null);
  assert.equal(cache.get('profile-a', 5001, 'connection-a')?.serverVersion, '3.0.5');
  assert.equal(cache.get('profile-a', 5001, 'connection-b'), null);
  cache.set(capabilities, 1000, 5000, 'connection-a');
  assert.equal(cache.get('profile-a', 6000), null);
});

test('advertised endpoint incompatibility invalidates cached capability state', async () => {
  let invalidations = 0;
  const { client } = mockClient(async (request) => {
    const detail = pdfDetailForRequest(request);
    if (detail) return detail;
    if (request.path.startsWith('/api/tasks/?')) return { status: 200, data: taskPage([]) };
    return { status: 405, data: { detail: 'Method not allowed after server upgrade' } };
  });
  const api = new PaperlessAdvancedApi(client, fullCapabilities(), {
    onCapabilityMismatch: () => { invalidations += 1; },
    taskCorrelationAttempts: 1,
    taskCorrelationDelayMs: 0,
  });
  await assert.rejects(
    api.rotateDocuments({ documentIds: [4], degrees: 90 }),
    (error) => error instanceof PaperlessClientError && error.status === 405,
  );
  assert.equal(invalidations, 1);
});

test('advertised schema response mismatch invalidates cached capability state', async () => {
  let invalidations = 0;
  const { client } = mockClient(async () => ({ status: 200, data: { future_shape: true } }));
  const api = new PaperlessAdvancedApi(client, fullCapabilities(), {
    onCapabilityMismatch: () => { invalidations += 1; },
  });
  await assert.rejects(api.listCatalog('tags'), /invalid paginated response/);
  assert.equal(invalidations, 1);
});

test('saved-view parsing and presentation-only updates preserve unknown data', () => {
  const saved = parsePaperlessSavedView(savedViewFixture);
  assert.equal(saved.filterRules[1].known, false);
  assert.deepEqual(saved.filterRules[1].extra, { future_option: 'preserve-me' });
  assert.equal(saved.showOnDashboard, true);
  assert.equal(saved.showInSidebar, false);
  assert.deepEqual(saved.extra, {
    show_on_dashboard: true,
    show_in_sidebar: false,
    future_presentation: { density: 'compact' },
  });

  const rename = buildSavedViewUpdate(saved, { name: ' Renamed ' });
  assert.deepEqual(rename, { supported: true, value: { name: 'Renamed' } });

  const presentation = buildSavedViewUpdate(saved, {
    displayFields: ['title', 'custom_field_4'],
    showOnDashboard: false,
    showInSidebar: true,
  });
  assert.deepEqual(presentation, { supported: true, value: {
    display_fields: ['title', 'custom_field_4'],
    show_on_dashboard: false,
    show_in_sidebar: true,
  } });

  const changed = buildSavedViewUpdate(saved, {
    filterRules: [{ ruleType: 6, value: '12', known: true, extra: {} }],
  });
  assert.equal(changed.supported, true);
  assert.deepEqual(changed.value.filter_rules, [
    { rule_type: 6, value: '12' },
    { future_option: 'preserve-me', rule_type: 999, value: 'future' },
  ]);

  const blocked = buildSavedViewUpdate(
    saved,
    { filterRules: [{ ruleType: 6, value: '12', known: true, extra: {} }] },
    'block',
  );
  assert.deepEqual(blocked, {
    supported: false,
    reason: 'unknown-rules',
    detail: 'This view contains rules the client cannot edit safely.',
  });
});

test('Paperless rules unsupported by the Folio editor remain opaque and lossless', () => {
  const saved = parsePaperlessSavedView({
    ...savedViewFixture,
    filter_rules: [
      { rule_type: 5, value: 'true' },
      { rule_type: 10, value: '2026', server_hint: 'created-year' },
    ],
  });
  assert.equal(saved.filterRules[0].known, true);
  assert.equal(saved.filterRules[1].known, false);

  const changed = buildSavedViewUpdate(saved, {
    filterRules: [{ ruleType: 5, value: 'false', known: true, extra: {} }],
  });
  assert.equal(changed.supported, true);
  assert.deepEqual(changed.value.filter_rules, [
    { rule_type: 5, value: 'false' },
    { server_hint: 'created-year', rule_type: 10, value: '2026' },
  ]);

  assert.deepEqual(buildSavedViewUpdate(
    saved,
    { filterRules: [{ ruleType: 5, value: 'false', known: true, extra: {} }] },
    'block',
  ), {
    supported: false,
    reason: 'unknown-rules',
    detail: 'This view contains rules the client cannot edit safely.',
  });
});

test('known server rules that Folio cannot represent stay protected', () => {
  const saved = parsePaperlessSavedView({
    ...savedViewFixture,
    filter_rules: [
      { rule_type: 5, value: 'false' },
      { rule_type: 18, value: 'false' },
      { rule_type: 48, value: 'title words' },
      { rule_type: 49, value: 'text words', future_hint: true },
    ],
  });
  assert.deepEqual(saved.filterRules.map((rule) => rule.known), [false, false, true, true]);
  const changed = buildSavedViewUpdate(saved, {
    filterRules: [{ ruleType: 48, value: 'changed', known: true, extra: {} }],
  });
  assert.equal(changed.supported, true);
  assert.deepEqual(changed.value.filter_rules, [
    { rule_type: 48, value: 'changed' },
    { rule_type: 5, value: 'false' },
    { rule_type: 18, value: 'false' },
    { future_hint: true, rule_type: 49, value: 'text words' },
  ]);
});

test('saved-view lists follow every safe pagination page', async () => {
  const first = { ...savedViewFixture, id: 1, name: 'First' };
  const second = { ...savedViewFixture, id: 2, name: 'Second' };
  const { client, requests } = mockClient(async (request) => {
    if (request.path.includes('page=2')) {
      return { status: 200, data: { count: 2, next: null, previous: 'ignored', results: [second] } };
    }
    return {
      status: 200,
      data: {
        count: 2,
        next: 'http://paperless-internal/prefix/api/saved_views/?page=2',
        previous: null,
        results: [first],
      },
    };
  });
  const api = new PaperlessAdvancedApi(client, fullCapabilities());
  const listed = await api.listSavedViews();
  assert.equal(listed.supported, true);
  assert.deepEqual(listed.value.results.map((view) => view.id), [1, 2]);
  assert.deepEqual(requests.map((request) => request.path), [
    '/api/saved_views/?page_size=100&ordering=name',
    '/api/saved_views/?page=2',
  ]);
  assert.deepEqual({ count: listed.value.count, next: listed.value.next, previous: listed.value.previous }, {
    count: 2, next: null, previous: null,
  });
});

test('saved-view pagination refuses endpoint changes and loops', async () => {
  const unsafeClient = mockClient(async () => ({
    status: 200,
    data: { count: 1, next: 'https://internal/api/tags/?page=2', previous: null, results: [savedViewFixture] },
  })).client;
  await assert.rejects(
    new PaperlessAdvancedApi(unsafeClient, fullCapabilities()).listSavedViews(),
    (error) => error instanceof PaperlessClientError && error.code === 'unsafe-request-path',
  );

  const loopClient = mockClient(async (request) => ({
    status: 200,
    data: { count: 1, next: request.path, previous: null, results: [savedViewFixture] },
  })).client;
  await assert.rejects(
    new PaperlessAdvancedApi(loopClient, fullCapabilities()).listSavedViews(),
    (error) => error instanceof PaperlessClientError && error.code === 'invalid-response',
  );

  const { client: endlessClient, requests } = mockClient(async (request) => {
    const current = Number(new URL(request.path, 'https://paperless.invalid').searchParams.get('page') ?? 1);
    return {
      status: 200,
      data: {
        count: 101,
        next: `/api/saved_views/?page=${current + 1}`,
        previous: null,
        results: [{ ...savedViewFixture, id: current }],
      },
    };
  });
  await assert.rejects(
    new PaperlessAdvancedApi(endlessClient, fullCapabilities()).listSavedViews(),
    (error) => error instanceof PaperlessClientError && error.code === 'invalid-response',
  );
  assert.equal(requests.length, 100);
});

test('saved-view CRUD serializes snake_case and losslessly duplicates rules', async () => {
  const saved = parsePaperlessSavedView(savedViewFixture);
  const { client, requests } = mockClient(async (request) => {
    if (request.method === 'POST') {
      return { status: 201, data: { ...savedViewFixture, id: 10, name: request.json.name, filter_rules: request.json.filter_rules } };
    }
    if (request.method === 'DELETE') return { status: 204, data: null };
    throw new Error('Unexpected request');
  });
  const api = new PaperlessAdvancedApi(client, fullCapabilities());
  const duplicate = await api.duplicateSavedView(saved, 'Copy', {
    displayFields: ['title', 'custom_field_12'],
    showOnDashboard: false,
    showInSidebar: true,
  });
  assert.equal(duplicate.supported, true);
  assert.equal(duplicate.value.name, 'Copy');
  assert.deepEqual(requests[0].json.filter_rules[1], {
    future_option: 'preserve-me',
    rule_type: 999,
    value: 'future',
  });
  assert.deepEqual(requests[0].json.future_presentation, { density: 'compact' });
  assert.deepEqual(requests[0].json.display_fields, ['title', 'custom_field_12']);
  assert.equal(requests[0].json.show_on_dashboard, false);
  assert.equal(requests[0].json.show_in_sidebar, true);
  const deleted = await api.deleteSavedView(9);
  assert.deepEqual(deleted, { supported: true, value: { deletedId: 9 } });
  assert.equal(requests[1].path, '/api/saved_views/9/');
});

test('catalog parser retains resource-specific fields and PATCH sends only edits', async () => {
  const parsed = parsePaperlessTag(tagFixture);
  assert.equal(parsed.color, '#aabbcc');
  assert.equal(parsed.children[0].parentId, 1);
  assert.deepEqual(parsed.extra, { server_extension: { retained: true } });

  let updatedTag = tagFixture;
  const { client, requests } = mockClient(async (request) => {
    if (request.method === 'PATCH') {
      updatedTag = { ...tagFixture, name: request.json.name, color: request.json.color };
      return { status: 200, data: updatedTag };
    }
    if (request.path === '/api/tags/1/') return { status: 200, data: updatedTag };
    if (request.path.startsWith('/api/tags/?')) {
      return { status: 200, data: { count: 1, next: null, previous: null, results: [updatedTag] } };
    }
    throw new Error(`Unexpected ${request.method} ${request.path}`);
  });
  const api = new PaperlessAdvancedApi(client, fullCapabilities());
  const updated = await api.updateCatalog('tags', 1, {
    name: ' Finance 2026 ',
    color: '#112233',
  });
  assert.equal(updated.supported, true);
  assert.equal(updated.value.name, 'Finance 2026');
  assert.deepEqual(requests[0].json, { name: 'Finance 2026', color: '#112233' });
  assert.equal('server_extension' in requests[0].json, false);
  assert.equal(requests[1].path, '/api/tags/1/');
  assert.match(requests[2].path, /^\/api\/tags\/\?/);
});

test('tag moves are accepted only after detail and hierarchy readback agree', async () => {
  const moved = { ...tagFixture.children[0], parent: 3, children: [] };
  const newParent = {
    ...tagFixture,
    id: 3,
    slug: 'archive',
    name: 'Archive',
    parent: null,
    children: [moved],
  };
  const { client, requests } = mockClient(async (request) => {
    if (request.method === 'PATCH') return { status: 200, data: moved };
    if (request.path === '/api/tags/2/') return { status: 200, data: moved };
    if (request.path.startsWith('/api/tags/?')) {
      return { status: 200, data: { count: 2, next: null, previous: null, results: [newParent, moved] } };
    }
    throw new Error(`Unexpected ${request.method} ${request.path}`);
  });
  const api = new PaperlessAdvancedApi(client, fullCapabilities());
  const result = await api.updateCatalog('tags', 2, { parentId: 3 });
  assert.equal(result.supported, true);
  assert.equal(result.value.parentId, 3);
  assert.deepEqual(requests.map((request) => request.path), [
    '/api/tags/2/',
    '/api/tags/2/',
    '/api/tags/?page_size=1000&ordering=name',
  ]);
});

test('new nested tags are returned only after hierarchy revalidation', async () => {
  const created = {
    ...tagFixture.children[0],
    id: 4,
    slug: 'receipts',
    name: 'Receipts',
    parent: 1,
    children: [],
  };
  const root = { ...tagFixture, children: [...tagFixture.children, created] };
  const { client } = mockClient(async (request) => {
    if (request.method === 'POST') return { status: 201, data: created };
    if (request.path === '/api/tags/4/') return { status: 200, data: created };
    if (request.path.startsWith('/api/tags/?')) {
      return {
        status: 200,
        data: {
          count: 3,
          next: null,
          previous: null,
          results: [root, tagFixture.children[0], created],
        },
      };
    }
    throw new Error(`Unexpected ${request.method} ${request.path}`);
  });
  const api = new PaperlessAdvancedApi(client, fullCapabilities());
  const result = await api.createCatalog('tags', {
    name: 'Receipts',
    color: '#ccbbaa',
    parentId: 1,
  });
  assert.equal(result.supported, true);
  assert.equal(result.value.id, 4);
  assert.equal(result.value.parentId, 1);
});

test('concurrently changed tag moves fail verification instead of flattening local state', async () => {
  const { client } = mockClient(async (request) => {
    if (request.method === 'PATCH') return { status: 200, data: { ...tagFixture, parent: 3 } };
    return { status: 200, data: tagFixture };
  });
  const api = new PaperlessAdvancedApi(client, fullCapabilities());
  await assert.rejects(
    api.updateCatalog('tags', 1, { parentId: 3 }),
    (error) => error instanceof PaperlessClientError && error.code === 'write-conflict',
  );
});

test('bulk eligibility skips non-remote, processing, read-only, and duplicate rows', () => {
  const selection = selectBulkEligible([
    { localId: 'local', ready: true },
    { localId: 'pending', remoteId: 2, ready: false },
    { localId: 'readonly', remoteId: 3, ready: true, canEdit: false },
    { localId: 'ready', remoteId: 4, ready: true, canEdit: true },
    { localId: 'duplicate', remoteId: 4, ready: true, canEdit: true },
  ]);
  assert.deepEqual(selection.eligible.map((item) => item.remoteId), [4]);
  assert.deepEqual(selection.skipped.map((item) => item.reason), [
    'not-remote',
    'processing',
    'read-only',
    'duplicate-selection',
  ]);
});

test('bulk add tags uses one server request and returns an exact eligibility summary', async () => {
  const { client, requests } = mockClient(async () => ({
    status: 200,
    data: { result: 'OK', task_id: 'task-bulk-1' },
  }));
  const api = new PaperlessAdvancedApi(client, fullCapabilities());
  const result = await api.bulkDocuments(
    [
      { localId: 'one', remoteId: 1, ready: true, canEdit: true },
      { localId: 'two', remoteId: 2, ready: true, canEdit: false },
      { localId: 'three', remoteId: 3, ready: true, canEdit: true },
    ],
    { kind: 'tags', mode: 'add', tagIds: [8, 8, 9] },
  );
  assert.equal(result.supported, true);
  assert.deepEqual(result.value.pending, [1, 3]);
  assert.deepEqual(result.value.succeeded, []);
  assert.deepEqual(result.value.skipped.map((item) => item.remoteId), [2]);
  assert.deepEqual(result.value.taskIds, ['task-bulk-1']);
  assert.deepEqual(requests[0].json, {
    documents: [1, 3],
    method: 'modify_tags',
    parameters: { add_tags: [8, 9], remove_tags: [] },
  });
});

test('bulk owner set uses bounded sparse PATCH plus readback and retains per-target failures', async () => {
  let active = 0;
  let maxActive = 0;
  const retainedPermissions = {
    view: { users: [7], groups: [2] },
    change: { users: [7], groups: [] },
  };
  const { client, requests } = mockClient(async (request) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    const id = Number(request.path.match(/^\/api\/documents\/(\d+)\/$/)?.[1]);
    if (request.method === 'PATCH' && id === 2) {
      return { status: 503, data: { detail: 'Busy' } };
    }
    if (request.method === 'GET' && id === 3) {
      // Transferring ownership commonly removes the caller's object access.
      return { status: 404, data: { detail: 'Not found' } };
    }
    return { status: 200, data: { id, owner: 12, permissions: retainedPermissions } };
  });
  const api = new PaperlessAdvancedApi(client, fullCapabilities());
  const result = await api.bulkDocuments(
    [1, 2, 3].map((id) => ({ localId: String(id), remoteId: id, ready: true, canEdit: true })),
    { kind: 'setOwner', value: 12 },
    { concurrency: 2 },
  );
  assert.equal(result.supported, true);
  assert.equal(maxActive, 2);
  assert.deepEqual(result.value.succeeded.sort(), [1, 3]);
  assert.equal(result.value.failed.length, 1);
  assert.equal(result.value.failed[0].remoteId, 2);
  assert.equal(result.value.failed[0].status, 503);
  assert.equal(result.value.failed[0].retryable, true);
  assert.equal(result.value.requestCount, 3);
  const patches = requests.filter((request) => request.method === 'PATCH');
  assert.equal(patches.length, 3);
  assert.equal(patches.every((request) => request.path.startsWith('/api/documents/')), true);
  assert.equal(patches.every((request) => JSON.stringify(request.json) === '{"owner":12}'), true);
  assert.equal(requests.some((request) => request.path === '/api/documents/bulk_edit/'), false);
  assert.equal(requests.some((request) => request.json && 'set_permissions' in request.json), false);
});

test('bulk owner clear requires independent canonical readback', async () => {
  const { client, requests } = mockClient(async (request) => {
    if (request.method === 'PATCH') return { status: 200, data: { id: 1, owner: null } };
    return {
      status: 200,
      data: {
        id: 1,
        owner: null,
        permissions: { view: { users: [7], groups: [] }, change: { users: [7], groups: [] } },
      },
    };
  });
  const api = new PaperlessAdvancedApi(client, fullCapabilities());
  const result = await api.bulkDocuments(
    [{ localId: 'one', remoteId: 1, ready: true, canEdit: true }],
    { kind: 'setOwner', value: null },
  );
  assert.equal(result.supported, true);
  assert.deepEqual(result.value.succeeded, [1]);
  assert.deepEqual(requests.map((request) => [request.method, request.path, request.json]), [
    ['PATCH', '/api/documents/1/', { owner: null }],
    ['GET', '/api/documents/1/', undefined],
  ]);
});

test('bulk reprocess result OK remains accepted but uncorrelated and never succeeds', async () => {
  const { client } = mockClient(async () => ({ status: 200, data: { result: 'OK' } }));
  const api = new PaperlessAdvancedApi(client, fullCapabilities());
  const result = await api.bulkDocuments(
    [1, 2].map((id) => ({ localId: String(id), remoteId: id, ready: true, canEdit: true })),
    { kind: 'reprocess' },
  );
  assert.equal(result.supported, true);
  assert.equal(result.value.accepted, true);
  assert.deepEqual(result.value.pending, [1, 2]);
  assert.deepEqual(result.value.succeeded, []);
  assert.deepEqual(result.value.failed, []);
  assert.deepEqual(result.value.taskIds, []);
});

test('bulk exact tag replacement uses bounded per-document PATCH and reports partial errors', async () => {
  let active = 0;
  let maxActive = 0;
  const { client } = mockClient(async (request) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    if (request.path === '/api/documents/2/') return { status: 503, data: { detail: 'Busy' } };
    return { status: 200, data: {} };
  });
  const api = new PaperlessAdvancedApi(client, fullCapabilities());
  const result = await api.bulkDocuments(
    [1, 2, 3, 4].map((id) => ({ localId: String(id), remoteId: id, ready: true, canEdit: true })),
    { kind: 'tags', mode: 'replace', tagIds: [7] },
    { concurrency: 2 },
  );
  assert.equal(result.supported, true);
  assert.equal(maxActive, 2);
  assert.deepEqual(result.value.succeeded.sort(), [1, 3, 4]);
  assert.equal(result.value.failed[0].remoteId, 2);
  assert.equal(result.value.failed[0].retryable, true);
  assert.equal(result.value.requestCount, 4);
});

test('representations are version-scoped metadata-derived and never silently substituted', async () => {
  const representations = parseDocumentRepresentations(42, {
    original_filename: 'scan.jpg',
    original_mime_type: 'image/jpeg',
    original_size: 123,
    original_checksum: 'abc',
    has_archive_version: false,
  });
  assert.equal(representations.original.available, true);
  assert.equal(representations.archive.available, false);
  const { client, requests } = mockClient(async () => ({
    status: 200,
    data: {
      original_filename: 'historical-original.pdf',
      original_mime_type: 'application/pdf',
      original_size: 81,
      original_checksum: '1'.repeat(64),
      has_archive_version: true,
      archive_media_filename: 'historical-archive.pdf',
      archive_size: 72,
      archive_checksum: '2'.repeat(64),
    },
  }));
  const api = new PaperlessAdvancedApi(client, fullCapabilities());
  assert.deepEqual(api.representationDownloadPath(representations, 'archive'), {
    supported: false,
    reason: 'representation-unavailable',
    detail: 'archive representation is unavailable.',
  });
  assert.deepEqual(api.representationDownloadPath(representations, 'original', 9), {
    supported: true,
    value: '/api/documents/42/download/?original=true&version=9',
  });
  const historical = await api.getRepresentations(42, undefined, 9);
  assert.equal(requests[0].path, '/api/documents/42/metadata/?version=9');
  assert.equal(historical.supported, true);
  assert.equal(historical.value.archive.checksum, '2'.repeat(64));
  assert.deepEqual(api.representationDownloadPath(historical.value, 'archive', 9), {
    supported: true,
    value: '/api/documents/42/download/?original=false&version=9',
  });

  const legacyMetadata = parseDocumentRepresentations(43, {
    original_filename: null,
    original_mime_type: 'application/pdf',
    original_size: 456,
    original_checksum: 'legacy-checksum',
    has_archive_version: false,
  });
  assert.equal(legacyMetadata.original.available, true);
  assert.equal(legacyMetadata.original.filename, null);
});

test('share-link expiry and creation serialize exact representation without app tokens', async () => {
  const now = new Date('2026-08-02T12:00:00Z');
  assert.equal(serializeShareLinkExpiry({ kind: 'never' }, now), null);
  assert.equal(serializeShareLinkExpiry({ kind: 'days', days: 7 }, now), '2026-08-09T12:00:00.000Z');
  assert.throws(
    () => serializeShareLinkExpiry({ kind: 'custom', at: '2026-08-01T00:00:00Z' }, now),
    /future date/,
  );

  const representations = parseDocumentRepresentations(42, {
    original_filename: 'source.pdf',
    original_mime_type: 'application/pdf',
    original_size: 100,
    has_archive_version: true,
    archive_media_filename: 'archive.pdf',
    archive_size: 80,
  });
  const { client, requests } = mockClient(async (request) => ({
    status: 201,
    data: {
      id: 5,
      created: now.toISOString(),
      expiration: request.json.expiration,
      slug: 'public-bearer-slug',
      document: 42,
      file_version: request.json.file_version,
    },
  }));
  const api = new PaperlessAdvancedApi(client, fullCapabilities());
  const result = await api.createShareLink(
    { documentId: 42, representation: 'archive', representations, expiry: { kind: 'days', days: 1 } },
    { now },
  );
  assert.equal(result.supported, true);
  assert.equal(result.value.fileVersion, 'archive');
  assert.deepEqual(requests[0].json, {
    document: 42,
    file_version: 'archive',
    expiration: '2026-08-03T12:00:00.000Z',
  });
  assert.equal(JSON.stringify(requests[0]).includes('Authorization'), false);

  const invalidVersion = new PaperlessAdvancedApi(
    mockClient(async () => ({
      status: 200,
      data: [{
        id: 6,
        created: now.toISOString(),
        expiration: null,
        slug: 'public-slug',
        document: 42,
        file_version: 'preview',
      }],
    })).client,
    fullCapabilities(),
  );
  await assert.rejects(
    invalidVersion.listShareLinks(42),
    (error) => error instanceof PaperlessClientError && error.code === 'invalid-response',
  );

  const wrongDocument = new PaperlessAdvancedApi(
    mockClient(async () => ({
      status: 200,
      data: [{
        id: 7,
        created: now.toISOString(),
        expiration: null,
        slug: 'other-document',
        document: 99,
        file_version: 'archive',
      }],
    })).client,
    fullCapabilities(),
  );
  await assert.rejects(
    wrongDocument.listShareLinks(42),
    /share link for another document/,
  );

  const mismatchedCreation = new PaperlessAdvancedApi(
    mockClient(async () => ({
      status: 201,
      data: {
        id: 8,
        created: now.toISOString(),
        expiration: null,
        slug: 'mismatched-representation',
        document: 42,
        file_version: 'original',
      },
    })).client,
    fullCapabilities(),
  );
  await assert.rejects(
    mismatchedCreation.createShareLink(
      { documentId: 42, representation: 'archive', representations, expiry: { kind: 'never' } },
      { now },
    ),
    /mismatched share-link metadata/,
  );
});

test('share-link revocation deletes only the explicitly selected server link', async () => {
  const { client, requests } = mockClient(async () => ({ status: 204, data: null }));
  const api = new PaperlessAdvancedApi(client, fullCapabilities());

  const result = await api.revokeShareLink(17);

  assert.deepEqual(result, { supported: true, value: { revokedId: 17 } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'DELETE');
  assert.equal(requests[0].path, '/api/share_links/17/');
  assert.equal(requests[0].json, undefined);
});

test('share-link capability mismatches invalidate the profile capability cache', async () => {
  let invalidations = 0;
  const { client } = mockClient(async () => ({
    status: 404,
    data: { detail: 'Share links are unavailable after a server change.' },
  }));
  const api = new PaperlessAdvancedApi(client, fullCapabilities(), {
    onCapabilityMismatch: () => { invalidations += 1; },
  });

  await assert.rejects(
    api.listShareLinks(42),
    (error) => error instanceof PaperlessClientError && error.status === 404,
  );
  assert.equal(invalidations, 1);
});

test('nested tags normalize paths and reject cycles or invisible parents', () => {
  const root = parsePaperlessTag(tagFixture);
  const childAgain = parsePaperlessTag(tagFixture.children[0]);
  const normalized = normalizeNestedTags([root, childAgain]);
  assert.equal(normalized.valid, true);
  assert.deepEqual(normalized.value.roots, [1]);
  assert.equal(normalized.value.byId.get(2).pathLabel, 'Finance / Invoices');
  assert.equal(normalized.value.byId.get(2).depth, 1);
  assert.deepEqual(selectVisibleNestedTags(normalized.value, '', new Set()).map((tag) => tag.id), [1]);
  assert.deepEqual(selectVisibleNestedTags(normalized.value, '', new Set([1])).map((tag) => tag.id), [1, 2]);
  assert.deepEqual(
    selectVisibleNestedTags(normalized.value, 'finance / invoices', new Set()).map((tag) => tag.id),
    [2],
  );

  const cyclic = normalizeNestedTags([
    parsePaperlessTag({ id: 1, name: 'A', parent: 2, children: [] }),
    parsePaperlessTag({ id: 2, name: 'B', parent: 1, children: [] }),
  ]);
  assert.equal(cyclic.valid, false);
  assert.equal(cyclic.errors.some((error) => error.code === 'cycle'), true);

  const missing = normalizeNestedTags([
    parsePaperlessTag({ id: 3, name: 'Private child', parent: 999, children: [] }),
  ]);
  assert.equal(missing.valid, false);
  assert.equal(missing.errors[0].code, 'missing-parent');
});

test('nested tag children require independent collection visibility before they can be exposed', async () => {
  const privateChild = {
    ...tagFixture.children[0],
    id: 99,
    slug: 'private-payroll',
    name: 'Private payroll',
    parent: 1,
    children: [],
  };
  const visibleChild = {
    ...tagFixture.children[0],
    id: 2,
    slug: 'invoices',
    name: 'Invoices',
    parent: 1,
    children: [],
  };
  const rootWithUnfilteredChildren = {
    ...tagFixture,
    children: [visibleChild, privateChild],
  };

  const parsed = [
    parsePaperlessTag(rootWithUnfilteredChildren),
    parsePaperlessTag(visibleChild),
  ];
  const restricted = restrictTagHierarchyToVisibleResults(parsed);
  assert.deepEqual(restricted[0].children.map((tag) => tag.id), [2]);
  assert.equal(JSON.stringify(restricted).includes('Private payroll'), false);

  const { client } = mockClient(async () => ({
    status: 200,
    data: { count: 2, next: null, previous: null, results: [rootWithUnfilteredChildren, visibleChild] },
  }));
  const result = await new PaperlessAdvancedApi(client, fullCapabilities()).listCatalog('tags');
  assert.equal(result.supported, true);
  assert.deepEqual(result.value.results[0].children.map((tag) => tag.id), [2]);
  const hierarchy = normalizeNestedTags(result.value.results);
  assert.equal(hierarchy.valid, true);
  assert.equal(hierarchy.value.byId.has(99), false);
  assert.equal(selectVisibleNestedTags(hierarchy.value, 'private payroll', new Set()).length, 0);
});

test('a visible tag whose parent is not independently visible becomes a safe root', () => {
  const visibleChild = parsePaperlessTag({
    id: 5,
    name: 'Visible child',
    parent: 999,
    children: [],
  });
  const restricted = restrictTagHierarchyToVisibleResults([visibleChild]);
  assert.equal(restricted[0].parentId, null);
  const hierarchy = normalizeNestedTags(restricted);
  assert.equal(hierarchy.valid, true);
  assert.deepEqual(hierarchy.value.roots, [5]);
});

test('tag parsing and normalization enforce bounded hierarchy traversal', () => {
  let deeplyNested = { id: 66, name: 'Tag 66', children: [] };
  for (let id = 65; id >= 1; id -= 1) {
    deeplyNested = { id, name: `Tag ${id}`, children: [deeplyNested] };
  }
  assert.throws(
    () => parsePaperlessTag(deeplyNested),
    (error) => error instanceof PaperlessClientError && error.code === 'invalid-response',
  );

  const tooManyTags = Array.from({ length: 4_097 }, (_entry, index) => ({
    id: index + 1,
    name: `Tag ${index + 1}`,
    parentId: null,
    children: [],
  }));
  const normalized = normalizeNestedTags(tooManyTags);
  assert.equal(normalized.valid, false);
  assert.equal(normalized.errors.some((error) => error.message.includes('safe node limit')), true);
});

test('permission merge is explicit and replacement guards object-level self-lockout', () => {
  const merged = mergePermissionSets(
    { view: { users: [7], groups: [1] }, change: { users: [7], groups: [] } },
    { view: { users: [8], groups: [1, 2] }, change: { users: [], groups: [2] } },
  );
  assert.deepEqual(merged, {
    view: { users: [7, 8], groups: [1, 2] },
    change: { users: [7], groups: [2] },
  });

  assert.deepEqual(mergePermissionSets(
    { view: { users: [], groups: [] }, change: { users: [], groups: [] } },
    { view: { users: [], groups: [] }, change: { users: [8], groups: [4] } },
  ), {
    view: { users: [8], groups: [4] },
    change: { users: [8], groups: [4] },
  });

  const current = {
    ownerId: 7,
    permissions: { view: { users: [], groups: [] }, change: { users: [], groups: [] } },
    userCanChange: true,
  };
  const mutation = {
    ownerId: 8,
    mode: 'replace',
    permissions: { view: { users: [8], groups: [] }, change: { users: [8], groups: [] } },
  };
  const blockedDespiteGlobalView = planPermissionMutation(
    current,
    mutation,
    { currentUserId: 7, isSuperuser: false, hasGlobalViewPermission: true },
  );
  assert.equal(blockedDespiteGlobalView.supported, false);
  assert.equal(blockedDespiteGlobalView.reason, 'self-lockout');

  const confirmed = planPermissionMutation(
    current,
    { ...mutation, confirmSelfLockout: true },
    { currentUserId: 7, isSuperuser: false },
  );
  assert.equal(confirmed.supported, true);

  const directChangeGrant = planPermissionMutation(
    current,
    { ...mutation, permissions: { ...mutation.permissions, change: { users: [7], groups: [] } } },
    { currentUserId: 7, isSuperuser: false },
  );
  assert.equal(directChangeGrant.supported, true);
  assert.deepEqual(directChangeGrant.value.set_permissions, {
    view: { users: [7, 8], groups: [] },
    change: { users: [7], groups: [] },
  });

  const inheritedGroupGrant = planPermissionMutation(
    current,
    { ...mutation, permissions: { ...mutation.permissions, view: { users: [8], groups: [3] } } },
    { currentUserId: 7, isSuperuser: false, currentUserGroupIds: [3] },
  );
  assert.equal(inheritedGroupGrant.supported, true);

  const unrelatedGroup = planPermissionMutation(
    current,
    { ...mutation, permissions: { ...mutation.permissions, view: { users: [8], groups: [3] } } },
    { currentUserId: 7, isSuperuser: false, currentUserGroupIds: [4] },
  );
  assert.equal(unrelatedGroup.supported, false);
  assert.equal(unrelatedGroup.reason, 'self-lockout');

  const unowned = planPermissionMutation(
    current,
    { ...mutation, ownerId: null },
    { currentUserId: 7, isSuperuser: false },
  );
  assert.equal(unowned.supported, true);
});

test('permission updates read full permissions back after the write', async () => {
  const capabilities = fullCapabilities();
  capabilities.permissions.document.view = false;
  const { client, requests } = mockClient(async (request) => {
    if (request.method === 'PATCH') return { status: 200, data: {} };
    return {
      status: 200,
      data: {
        id: 4,
        owner: 7,
        permissions: { view: { users: [8, 7], groups: [] }, change: { users: [7], groups: [] } },
        user_can_change: true,
      },
    };
  });
  const api = new PaperlessAdvancedApi(client, capabilities);
  const result = await api.updateObjectPermissions(
    'document',
    4,
    {
      ownerId: 7,
      permissions: { view: { users: [7], groups: [] }, change: { users: [7], groups: [] } },
      userCanChange: true,
    },
    {
      mode: 'merge',
      permissions: { view: { users: [8], groups: [] }, change: { users: [], groups: [] } },
    },
  );
  assert.equal(result.supported, true);
  assert.equal(result.value.verified, true);
  assert.deepEqual(requests[0].json.set_permissions.view.users, [7, 8]);
  assert.equal(requests[1].path, '/api/documents/4/?full_perms=true');
});

test('permission replacement canonicalizes change principals before submit and readback', async () => {
  const canonical = {
    view: { users: [8], groups: [4] },
    change: { users: [8], groups: [4] },
  };
  const { client, requests } = mockClient(async (request) => request.method === 'PATCH'
    ? { status: 200, data: {} }
    : {
        status: 200,
        data: { id: 4, owner: 7, permissions: canonical, user_can_change: true },
      });
  const api = new PaperlessAdvancedApi(client, fullCapabilities());
  const result = await api.updateObjectPermissions(
    'document',
    4,
    {
      ownerId: 7,
      permissions: { view: { users: [], groups: [] }, change: { users: [], groups: [] } },
      userCanChange: true,
    },
    {
      ownerId: 7,
      mode: 'replace',
      permissions: {
        view: { users: [], groups: [] },
        change: { users: [8], groups: [4] },
      },
    },
  );
  assert.equal(result.supported, true);
  assert.equal(result.value.verified, true);
  assert.deepEqual(result.value.permissions, canonical);
  assert.deepEqual(requests[0].json.set_permissions, canonical);
});

test('permission updates use current group membership when it is the retained access path', async () => {
  const capabilities = fullCapabilities();
  const { client, requests } = mockClient(async (request) => {
    if (request.path === '/api/ui_settings/') {
      return { status: 200, data: { user: { id: 7, is_superuser: false, groups: [3] } } };
    }
    if (request.method === 'PATCH') return { status: 200, data: {} };
    return {
      status: 200,
      data: {
        id: 4,
        owner: 8,
        permissions: {
          view: { users: [8], groups: [3] },
          change: { users: [8], groups: [] },
        },
        user_can_change: true,
      },
    };
  });
  const api = new PaperlessAdvancedApi(client, capabilities);
  const result = await api.updateObjectPermissions(
    'document',
    4,
    {
      ownerId: 7,
      permissions: { view: { users: [], groups: [] }, change: { users: [], groups: [] } },
      userCanChange: true,
    },
    {
      ownerId: 8,
      mode: 'replace',
      permissions: {
        view: { users: [8], groups: [3] },
        change: { users: [8], groups: [] },
      },
    },
  );
  assert.equal(result.supported, true);
  assert.deepEqual(requests.map((request) => [request.method, request.path]), [
    ['GET', '/api/ui_settings/'],
    ['PATCH', '/api/documents/4/'],
    ['GET', '/api/documents/4/?full_perms=true'],
  ]);
});

test('confirmed self-lockout reports an applied no-longer-readable mutation without blind retry', async () => {
  const capabilities = fullCapabilities();
  assert.equal(capabilities.permissions.document.view, true);
  const replacement = {
    ownerId: 8,
    mode: 'replace',
    permissions: {
      view: { users: [8], groups: [] },
      change: { users: [8], groups: [] },
    },
  };
  const { client, requests } = mockClient(async (request) => {
    if (request.path === '/api/ui_settings/') {
      return { status: 200, data: { user: { id: 7, is_superuser: false, groups: [] } } };
    }
    if (request.method === 'PATCH') return { status: 200, data: {} };
    if (request.path === '/api/documents/4/?full_perms=true') {
      return { status: 404, data: { detail: 'Not found' } };
    }
    return {
      status: 200,
      data: {
        id: 4,
        owner: 8,
        permissions: replacement.permissions,
        user_can_change: false,
      },
    };
  });
  const api = new PaperlessAdvancedApi(client, capabilities);
  const current = {
    ownerId: 7,
    permissions: { view: { users: [], groups: [] }, change: { users: [], groups: [] } },
    userCanChange: true,
  };

  const blocked = await api.updateObjectPermissions('document', 4, current, replacement);
  assert.deepEqual(blocked, {
    supported: false,
    reason: 'self-lockout',
    detail: 'This permission update may remove the current user’s object-level access.',
  });
  assert.equal(requests.some((request) => request.method === 'PATCH'), false);

  const confirmed = await api.updateObjectPermissions(
    'document',
    4,
    current,
    { ...replacement, confirmSelfLockout: true },
  );
  assert.equal(confirmed.supported, true);
  assert.equal(confirmed.value.verified, false);
  assert.equal(confirmed.value.ownerId, 8);
  assert.deepEqual(confirmed.value.permissions, replacement.permissions);
  assert.equal(requests.filter((request) => request.method === 'PATCH').length, 1);
  assert.equal(requests.filter((request) => request.path === '/api/documents/4/?full_perms=true').length, 1);
});

test('confirmed self-lockout still surfaces retryable readback failures', async () => {
  const replacement = {
    ownerId: 8,
    mode: 'replace',
    confirmSelfLockout: true,
    permissions: {
      view: { users: [8], groups: [] },
      change: { users: [8], groups: [] },
    },
  };
  const { client, requests } = mockClient(async (request) => {
    if (request.method === 'PATCH') return { status: 200, data: {} };
    return { status: 503, data: { detail: 'Temporarily unavailable' } };
  });
  const api = new PaperlessAdvancedApi(client, fullCapabilities());

  await assert.rejects(
    api.updateObjectPermissions(
      'document',
      4,
      {
        ownerId: 7,
        permissions: { view: { users: [], groups: [] }, change: { users: [], groups: [] } },
        userCanChange: true,
      },
      replacement,
    ),
    (error) => error instanceof PaperlessClientError && error.status === 503,
  );
  assert.equal(requests.filter((request) => request.method === 'PATCH').length, 1);
});

test('permission updates reject owner or canonical ACL readback mismatches', async (t) => {
  const requestedPermissions = {
    view: { users: [8, 7], groups: [3] },
    change: { users: [7], groups: [4] },
  };
  const runMismatch = async (readback) => {
    const { client } = mockClient(async (request) => request.method === 'PATCH'
      ? { status: 200, data: {} }
      : { status: 200, data: readback });
    const api = new PaperlessAdvancedApi(client, fullCapabilities());
    await assert.rejects(
      api.updateObjectPermissions(
        'document',
        4,
        { ownerId: 7, permissions: requestedPermissions, userCanChange: true },
        { ownerId: 7, mode: 'replace', permissions: requestedPermissions },
      ),
      (error) => error instanceof PaperlessClientError && error.code === 'permission-verification-failed',
    );
  };

  await t.test('owner mismatch', () => runMismatch({
    id: 4,
    owner: 8,
    permissions: requestedPermissions,
    user_can_change: true,
  }));
  await t.test('ACL mismatch', () => runMismatch({
    id: 4,
    owner: 7,
    permissions: {
      view: { users: [7, 8], groups: [3, 99] },
      change: { users: [7], groups: [4] },
    },
    user_can_change: true,
  }));
});

test('duplicate extraction never infers destructive resolution', () => {
  const duplicates = extractDuplicateSummaries(
    { duplicate_documents: [{ id: 2, title: 'Invoice\u0000evil', deleted_at: null }] },
    { result_data: { duplicate_of: 3 } },
  );
  assert.deepEqual(duplicates, [
    { id: 2, title: 'Invoice evil', deletedAt: null, source: 'document' },
    { id: 3, title: 'Existing document', deletedAt: null, source: 'task' },
  ]);
  assert.equal(duplicates.some((duplicate) => 'action' in duplicate), false);
});

test('hostile AI suggestions are bounded and validated without becoming metadata', () => {
  const payload = JSON.parse(
    '{"title":"' + 'x'.repeat(129) + '","tags":[1,-2,"3"],"suggested_tags":["Safe","Bad\\u0000Tag"],"dates":["2026-02-29","2026-02-28"],"custom_fields":{"__proto__":{"polluted":true},"4":"ok"}}',
  );
  const result = validateAiSuggestions(payload);
  assert.equal(result.valid, true);
  assert.equal(result.value.title, null);
  assert.deepEqual(result.value.tagIds, [1]);
  assert.deepEqual(result.value.proposedTags, ['Safe']);
  assert.deepEqual(result.value.dates, ['2026-02-28']);
  assert.deepEqual(result.value.customFields, { 4: 'ok' });
  assert.equal(result.warnings.some((warning) => warning.code === 'unsafe-key'), true);
  assert.equal(Object.prototype.polluted, undefined);

  const hostileIds = Array.from({ length: 150 }, (_entry, index) => index + 1);
  const bounded = validateAiSuggestions({
    correspondents: hostileIds,
    tags: hostileIds,
    document_types: hostileIds,
    storage_paths: hostileIds,
  });
  assert.equal(bounded.valid, true);
  assert.deepEqual(bounded.value.correspondentIds, hostileIds.slice(0, 100));
  assert.deepEqual(bounded.value.tagIds, hostileIds.slice(0, 100));
  assert.deepEqual(bounded.value.documentTypeIds, hostileIds.slice(0, 100));
  assert.deepEqual(bounded.value.storagePathIds, hostileIds.slice(0, 100));
  assert.deepEqual(
    bounded.warnings.filter((warning) => warning.code === 'too-many-values').map((warning) => warning.path),
    ['correspondents', 'tags', 'document_types', 'storage_paths'],
  );
});

test('AI capability mismatches invalidate the profile capability cache', async () => {
  let invalidations = 0;
  const { client, requests } = mockClient(async () => ({
    status: 404,
    data: { detail: 'Endpoint removed after upgrade' },
  }));
  const api = new PaperlessAdvancedApi(client, fullCapabilities(), {
    onCapabilityMismatch: () => { invalidations += 1; },
  });
  await assert.rejects(
    api.getAiSuggestions(42),
    (error) => error instanceof PaperlessClientError && error.status === 404,
  );
  assert.equal(invalidations, 1);
  assert.equal(requests[0].path, '/api/documents/42/ai_suggestions/');
});

test('document metadata capability mismatches invalidate the profile capability cache', async () => {
  let invalidations = 0;
  const { client } = mockClient(async () => ({
    status: 404,
    data: { detail: 'Endpoint removed after downgrade' },
  }));
  const api = new PaperlessAdvancedApi(client, fullCapabilities(), {
    onCapabilityMismatch: () => { invalidations += 1; },
  });
  await assert.rejects(
    api.getRepresentations(42),
    (error) => error instanceof PaperlessClientError && error.status === 404,
  );
  assert.equal(invalidations, 1);
});

test('PDF merge candidate selection requires explicit per-document change permission', () => {
  const base = {
    source: 'remote',
    status: 'archived',
    mimeType: 'application/pdf',
  };
  assert.deepEqual(selectChangeAuthorizedPdfMergeIds([
    { ...base, remoteId: 1, canEdit: true },
    { ...base, remoteId: 2, canEdit: false },
    { ...base, remoteId: 3 },
    { ...base, remoteId: 4, canEdit: true, status: 'processing' },
    { ...base, remoteId: 5, canEdit: true, mimeType: 'image/png' },
  ], [1, 2, 3, 4, 5]), [1]);
});

test('task v10 parser uses result_data and related_document_ids', () => {
  const task = parsePaperlessTaskV10({
    id: 11,
    task_id: 'uuid-11',
    task_type: 'consume_file',
    trigger_source: 'api_upload',
    status: 'success',
    date_created: '2026-08-02T12:00:00Z',
    input_data: { filename: 'scan.pdf' },
    result_data: { document_id: 44 },
    related_document_ids: [44],
    acknowledged: false,
    owner: 7,
  });
  assert.equal(task.resultData.document_id, 44);
  assert.equal(task.dateCreated, '2026-08-02T12:00:00Z');
  assert.deepEqual(task.relatedDocumentIds, [44]);
});

test('task ID extraction accepts explicit response fields but not inferred locations or result OK', () => {
  assert.deepEqual(extractTaskIds({ result: 'OK' }), []);
  assert.deepEqual(extractTaskIds({ task_id: 'celery-id' }), ['celery-id']);
  assert.deepEqual(extractTaskIds({ result: { task_ids: ['one', 'two'] } }), ['one', 'two']);
  assert.deepEqual(extractTaskIds(
    { result: 'OK' },
    { Location: '/api/tasks/task-from-location/' },
  ), []);
  assert.deepEqual(extractTaskIds({}, { 'X-Task-Id': 'task-from-header' }), ['task-from-header']);
});

test('PDF operations retain explicit response task IDs even when task-feed correlation is unavailable', async () => {
  const { client, requests } = mockClient(async (request) => {
    const detail = pdfDetailForRequest(request);
    if (detail) return detail;
    if (request.path.endsWith('/rotate/')) {
      return { status: 200, data: { result: 'OK', task_id: 'task-explicit' } };
    }
    throw new Error(`Unexpected ${request.method} ${request.path}`);
  });
  const api = new PaperlessAdvancedApi(client, fullCapabilities());

  const result = await api.rotateDocuments({ documentIds: [4], degrees: 90 });

  assert.equal(result.supported, true);
  assert.deepEqual(result.value.taskIds, ['task-explicit']);
  assert.equal(result.value.taskCorrelation, 'response');
  assert.equal(requests.filter((request) => request.path.startsWith('/api/tasks/?')).length, 1);
});

function serverTask(id, filename, status = 'pending') {
  return paperless305ConsumeTaskFixture({ id, filename, status });
}

function taskPage(tasks) {
  return { count: tasks.length, next: null, previous: null, results: [...tasks].reverse() };
}

test('Paperless 3 result OK correlates only exact one-to-one post-snapshot API task deltas', async () => {
  const tasks = [];
  const { client, requests } = mockClient(async (request) => {
    const detail = pdfDetailForRequest(request);
    if (detail) return detail;
    if (request.path.startsWith('/api/tasks/?')) return { status: 200, data: taskPage(tasks) };
    if (request.path.endsWith('/rotate/')) {
      tasks.push(serverTask('task-1', '4_rotated.pdf'));
      return { status: 200, data: paperless305PdfOperationAcceptedFixture };
    }
    if (request.path.endsWith('/edit_pdf/')) {
      tasks.push(serverTask('task-2', '4_edit_1.pdf'));
      tasks.push(serverTask('task-3', '4_edit_2.pdf'));
      return { status: 200, data: paperless305PdfOperationAcceptedFixture };
    }
    throw new Error(`Unexpected ${request.method} ${request.path}`);
  });
  const api = new PaperlessAdvancedApi(client, fullCapabilities(), {
    taskCorrelationAttempts: 1,
    taskCorrelationDelayMs: 0,
  });
  const rotated = await api.rotateDocuments({ documentIds: [4], degrees: 90 });
  assert.equal(rotated.supported, true);
  assert.deepEqual(rotated.value.taskIds, ['task-1']);
  assert.equal(rotated.value.taskCorrelation, 'task-feed');
  const rotateRequest = requests.find((request) => request.path.endsWith('/rotate/'));
  assert.deepEqual(rotateRequest.json, {
    documents: [4],
    degrees: 90,
    source_mode: 'latest_version',
  });

  const blocked = await api.editPdf({
    documentId: 4,
    operations: [{ page: 1 }],
    deleteOriginal: true,
  });
  assert.deepEqual(blocked, {
    supported: false,
    reason: 'requires-confirmation',
    detail: 'Deleting the source document requires confirmation.',
  });

  const invalidMerge = await api.mergeDocuments({
    documentIds: [4, 5],
    metadataDocumentId: 6,
  });
  assert.deepEqual(invalidMerge, {
    supported: false,
    reason: 'invalid-input',
    detail: 'The metadata source must be one of the documents being merged.',
  });
  const edited = await api.editPdf({
    documentId: 4,
    operations: [
      { page: 2, outputDocument: 0 },
      { page: 1, rotate: 90, outputDocument: 1 },
    ],
    includeMetadata: true,
  });
  assert.equal(edited.supported, true);
  assert.equal(edited.value.taskCorrelation, 'task-feed');
  assert.deepEqual(edited.value.taskIds, ['task-2', 'task-3']);
  const editRequest = requests.find((request) => request.path.endsWith('/edit_pdf/'));
  assert.deepEqual(editRequest.json.operations, [
    { page: 2, doc: 0 },
    { page: 1, rotate: 90, doc: 1 },
  ]);
  assert.equal(editRequest.path, '/api/documents/edit_pdf/');
  assert.equal(requests.filter((request) => request.path.startsWith('/api/tasks/?')).length, 4);
});

test('PDF merge submission rechecks change permission for every source document', async () => {
  const { client, requests } = mockClient(async (request) => {
    if (request.path === '/api/documents/4/') {
      return { status: 200, data: { id: 4, owner: 7, user_can_change: true } };
    }
    if (request.path === '/api/documents/5/') {
      return { status: 200, data: { id: 5, owner: 7, user_can_change: false } };
    }
    throw new Error(`Merge must not reach ${request.method} ${request.path}`);
  });
  const api = new PaperlessAdvancedApi(client, fullCapabilities());
  const denied = await api.mergeDocuments({
    documentIds: [4, 5],
    metadataDocumentId: 4,
  });
  assert.deepEqual(denied, {
    supported: false,
    reason: 'permission-denied',
    detail: 'PDF merge requires object-level change permission for every source document.',
  });
  assert.deepEqual(requests.map((request) => [request.method, request.path]), [
    ['GET', '/api/documents/4/'],
    ['GET', '/api/documents/5/'],
  ]);

  const globallyDeniedCapabilities = fullCapabilities();
  globallyDeniedCapabilities.permissions.document.change = false;
  const globallyDeniedClient = mockClient(async () => {
    throw new Error('Global denial must fail before document requests.');
  });
  const globallyDenied = await new PaperlessAdvancedApi(
    globallyDeniedClient.client,
    globallyDeniedCapabilities,
  ).mergeDocuments({ documentIds: [4, 5], metadataDocumentId: 4 });
  assert.deepEqual(globallyDenied, {
    supported: false,
    reason: 'permission-denied',
    detail: 'PDF merge requires global change permission for documents.',
  });
  assert.equal(globallyDeniedClient.requests.length, 0);
});

test('Paperless 3.0.5 PDF permission matrix is enforced before submission', async (t) => {
  const runCase = async ({ permissions = {}, detail = {}, isSuperuser = false, execute }) => {
    const capabilities = fullCapabilities();
    Object.assign(capabilities.permissions.document, permissions);
    capabilities.permissions.isSuperuser = isSuperuser;
    const { client, requests } = mockClient(async (request) => {
      const documentDetail = pdfDetailForRequest(request, detail);
      if (documentDetail) return documentDetail;
      if (request.path.startsWith('/api/tasks/?')) return { status: 200, data: taskPage([]) };
      if (request.method === 'POST') {
        return { status: 200, data: { result: 'OK', task_id: 'task-explicit' } };
      }
      throw new Error(`Unexpected ${request.method} ${request.path}`);
    });
    const result = await execute(new PaperlessAdvancedApi(client, capabilities));
    return {
      result,
      posts: requests.filter((request) => request.method === 'POST'),
      details: requests.filter((request) => /^\/api\/documents\/\d+\/$/.test(request.path)),
    };
  };

  await t.test('rotate requires change plus owner-or-unowned, but not add', async () => {
    const allowed = await runCase({
      permissions: { add: false },
      execute: (api) => api.rotateDocuments({ documentIds: [4], degrees: 90 }),
    });
    assert.equal(allowed.result.supported, true);
    assert.equal(allowed.posts.length, 1);

    const unowned = await runCase({
      permissions: { add: false },
      detail: { owner: null },
      execute: (api) => api.rotateDocuments({ documentIds: [4], degrees: 90 }),
    });
    assert.equal(unowned.result.supported, true);

    const wrongOwner = await runCase({
      detail: { owner: 8 },
      execute: (api) => api.rotateDocuments({ documentIds: [4], degrees: 90 }),
    });
    assert.equal(wrongOwner.result.supported, false);
    assert.equal(wrongOwner.result.reason, 'permission-denied');
    assert.equal(wrongOwner.posts.length, 0);
  });

  await t.test('merge requires add, and destructive merge additionally requires delete and ownership', async () => {
    const missingAdd = await runCase({
      permissions: { add: false },
      execute: (api) => api.mergeDocuments({ documentIds: [4, 5], metadataDocumentId: 4 }),
    });
    assert.equal(missingAdd.result.supported, false);
    assert.equal(missingAdd.result.reason, 'permission-denied');
    assert.equal(missingAdd.details.length, 0);

    const nonOwnerCreate = await runCase({
      detail: { owner: 8 },
      execute: (api) => api.mergeDocuments({ documentIds: [4, 5], metadataDocumentId: 4 }),
    });
    assert.equal(nonOwnerCreate.result.supported, true);

    const missingDelete = await runCase({
      permissions: { delete: false },
      execute: (api) => api.mergeDocuments({
        documentIds: [4, 5],
        metadataDocumentId: 4,
        deleteOriginals: true,
        confirmDestructive: true,
      }),
    });
    assert.equal(missingDelete.result.supported, false);
    assert.equal(missingDelete.result.reason, 'permission-denied');
    assert.equal(missingDelete.details.length, 0);

    const destructiveWrongOwner = await runCase({
      detail: { owner: 8 },
      execute: (api) => api.mergeDocuments({
        documentIds: [4, 5],
        metadataDocumentId: 4,
        deleteOriginals: true,
        confirmDestructive: true,
      }),
    });
    assert.equal(destructiveWrongOwner.result.supported, false);
    assert.equal(destructiveWrongOwner.result.reason, 'permission-denied');
  });

  await t.test('edit-in-place needs ownership while split/new-result also needs add and destructive new-result needs delete', async () => {
    const inPlace = await runCase({
      permissions: { add: false },
      execute: (api) => api.editPdf({
        documentId: 4,
        operations: [{ page: 1 }],
        updateDocument: true,
      }),
    });
    assert.equal(inPlace.result.supported, true);

    const splitWithoutAdd = await runCase({
      permissions: { add: false },
      execute: (api) => api.editPdf({
        documentId: 4,
        operations: [{ page: 1, outputDocument: 0 }, { page: 2, outputDocument: 1 }],
      }),
    });
    assert.equal(splitWithoutAdd.result.supported, false);
    assert.equal(splitWithoutAdd.result.reason, 'permission-denied');
    assert.equal(splitWithoutAdd.details.length, 0);

    const newResultWithoutDelete = await runCase({
      permissions: { delete: false },
      execute: (api) => api.editPdf({
        documentId: 4,
        operations: [{ page: 1 }],
        deleteOriginal: true,
        confirmDestructive: true,
      }),
    });
    assert.equal(newResultWithoutDelete.result.supported, false);
    assert.equal(newResultWithoutDelete.result.reason, 'permission-denied');

    const wrongOwner = await runCase({
      detail: { owner: 8 },
      execute: (api) => api.editPdf({ documentId: 4, operations: [{ page: 1 }] }),
    });
    assert.equal(wrongOwner.result.supported, false);
    assert.equal(wrongOwner.result.reason, 'permission-denied');
  });

  await t.test('password removal mirrors edit ownership/add/delete rules', async () => {
    const inPlace = await runCase({
      permissions: { add: false },
      execute: (api) => api.removePdfPassword({
        documentId: 4,
        password: 'secret',
        updateDocument: true,
      }),
    });
    assert.equal(inPlace.result.supported, true);

    const newResultWithoutAdd = await runCase({
      permissions: { add: false },
      execute: (api) => api.removePdfPassword({ documentId: 4, password: 'secret' }),
    });
    assert.equal(newResultWithoutAdd.result.supported, false);
    assert.equal(newResultWithoutAdd.result.reason, 'permission-denied');

    const wrongOwner = await runCase({
      detail: { owner: 8 },
      execute: (api) => api.removePdfPassword({
        documentId: 4,
        password: 'secret',
        updateDocument: true,
      }),
    });
    assert.equal(wrongOwner.result.supported, false);
    assert.equal(wrongOwner.result.reason, 'permission-denied');
  });

  await t.test('malformed or unconfirmed detail responses fail closed', async () => {
    const malformed = await runCase({
      detail: { owner: undefined },
      execute: (api) => api.rotateDocuments({ documentIds: [4], degrees: 90 }),
    });
    assert.equal(malformed.result.supported, false);
    assert.equal(malformed.result.reason, 'permission-unknown');
    assert.equal(malformed.posts.length, 0);

    const noObjectChange = await runCase({
      detail: { user_can_change: false },
      execute: (api) => api.rotateDocuments({ documentIds: [4], degrees: 90 }),
    });
    assert.equal(noObjectChange.result.supported, false);
    assert.equal(noObjectChange.result.reason, 'permission-denied');
  });

  await t.test('superusers follow the server bypass without object-detail preflight', async () => {
    const allowed = await runCase({
      permissions: { add: false, change: false, delete: false },
      isSuperuser: true,
      execute: (api) => api.mergeDocuments({
        documentIds: [4, 5],
        metadataDocumentId: 4,
        deleteOriginals: true,
        confirmDestructive: true,
      }),
    });
    assert.equal(allowed.result.supported, true);
    assert.equal(allowed.details.length, 0);
    assert.equal(allowed.posts.length, 1);
  });
});

test('PDF detail preflight bounds concurrent permission reads', async () => {
  let active = 0;
  let maxActive = 0;
  const { client } = mockClient(async (request) => {
    const detail = pdfDetailForRequest(request);
    if (detail) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return detail;
    }
    if (request.path.startsWith('/api/tasks/?')) return { status: 200, data: taskPage([]) };
    return { status: 200, data: { result: 'OK', task_id: 'task-explicit' } };
  });
  const result = await new PaperlessAdvancedApi(client, fullCapabilities()).rotateDocuments({
    documentIds: [1, 2, 3, 4, 5, 6, 7],
    degrees: 90,
  });
  assert.equal(result.supported, true);
  assert.equal(maxActive, 3);
});

test('failed Paperless PDF jobs are correlated so Task Center can surface their terminal failure', async () => {
  const tasks = [];
  const { client, requests } = mockClient(async (request) => {
    const detail = pdfDetailForRequest(request);
    if (detail) return detail;
    if (request.path.startsWith('/api/tasks/?')) return { status: 200, data: taskPage(tasks) };
    tasks.push(serverTask('task-41', '4_rotated.pdf', 'failure'));
    return { status: 200, data: paperless305PdfOperationAcceptedFixture };
  });
  const api = new PaperlessAdvancedApi(client, fullCapabilities(), {
    taskCorrelationAttempts: 1,
    taskCorrelationDelayMs: 0,
  });
  const result = await api.rotateDocuments({ documentIds: [4], degrees: 90 });
  assert.equal(result.supported, true);
  assert.deepEqual(result.value.taskIds, ['task-41']);
  assert.equal(result.value.taskCorrelation, 'task-feed');
  assert.equal(requests.filter((request) => request.path.startsWith('/api/tasks/?')).length, 2);
});

test('concurrent identical PDF edits serialize snapshots and bind distinct task deltas', async () => {
  const tasks = [];
  let sequence = 0;
  const { client } = mockClient(async (request) => {
    const detail = pdfDetailForRequest(request);
    if (detail) return detail;
    if (request.path.startsWith('/api/tasks/?')) return { status: 200, data: taskPage(tasks) };
    sequence += 1;
    tasks.push(serverTask(`task-${sequence}`, '4_rotated.pdf'));
    return { status: 200, data: paperless305PdfOperationAcceptedFixture };
  });
  const api = new PaperlessAdvancedApi(client, fullCapabilities(), {
    taskCorrelationAttempts: 1,
    taskCorrelationDelayMs: 0,
  });
  const [first, second] = await Promise.all([
    api.rotateDocuments({ documentIds: [4], degrees: 90 }),
    api.rotateDocuments({ documentIds: [4], degrees: 180 }),
  ]);
  assert.deepEqual(first.value.taskIds, ['task-1']);
  assert.deepEqual(second.value.taskIds, ['task-2']);
  assert.equal(first.value.taskCorrelation, 'task-feed');
  assert.equal(second.value.taskCorrelation, 'task-feed');
});

test('ambiguous same-filename post-snapshot task deltas remain explicitly uncorrelated', async () => {
  const tasks = [];
  const { client } = mockClient(async (request) => {
    const detail = pdfDetailForRequest(request);
    if (detail) return detail;
    if (request.path.startsWith('/api/tasks/?')) return { status: 200, data: taskPage(tasks) };
    tasks.push(serverTask('task-51', '4_rotated.pdf'));
    tasks.push(serverTask('task-52', '4_rotated.pdf'));
    return { status: 200, data: paperless305PdfOperationAcceptedFixture };
  });
  const api = new PaperlessAdvancedApi(client, fullCapabilities(), {
    taskCorrelationAttempts: 1,
    taskCorrelationDelayMs: 0,
  });
  const result = await api.rotateDocuments({ documentIds: [4], degrees: 90 });
  assert.deepEqual(result.value.taskIds, []);
  assert.equal(result.value.taskCorrelation, 'unavailable');
});

test('result OK without a uniquely matching task remains explicitly uncorrelated', async () => {
  const { client } = mockClient(async (request) => {
    const detail = pdfDetailForRequest(request);
    if (detail) return detail;
    if (request.path.startsWith('/api/tasks/?')) return { status: 200, data: taskPage([]) };
    return { status: 200, data: paperless305PdfOperationAcceptedFixture };
  });
  const api = new PaperlessAdvancedApi(client, fullCapabilities(), {
    taskCorrelationAttempts: 1,
    taskCorrelationDelayMs: 0,
  });
  const result = await api.rotateDocuments({ documentIds: [4], degrees: 90 });
  assert.equal(result.supported, true);
  assert.deepEqual(result.value.taskIds, []);
  assert.equal(result.value.taskCorrelation, 'unavailable');
});

test('profile mismatch prevents cross-server advanced operations', () => {
  const { client } = mockClient(async () => ({ status: 200, data: {} }), 'profile-b');
  assert.throws(
    () => new PaperlessAdvancedApi(client, fullCapabilities()),
    /different connection profile/,
  );
});
