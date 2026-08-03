import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PAPERLESS_OPTIONAL_WORKSPACE_RESOURCES,
  negotiatePaperlessWorkspaceResources,
  resolvePaperlessDocumentStatus,
} from '../src/lib/paperless-workspace-capabilities.ts';

function statusError(status) {
  return Object.assign(new Error(`status ${status}`), { status });
}

function resourceRecord(create) {
  return Object.fromEntries(
    PAPERLESS_OPTIONAL_WORKSPACE_RESOURCES.map((resource) => [resource, create(resource)]),
  );
}

const paperlessSource = await readFile(new URL('../src/lib/paperless.ts', import.meta.url), 'utf8');

test('view-document-only access keeps documents and explicitly marks optional resources unavailable', async () => {
  const result = await negotiatePaperlessWorkspaceResources(
    async () => [{ id: 42, title: 'Visible document' }],
    resourceRecord(() => async () => { throw statusError(403); }),
    resourceRecord(() => []),
  );

  assert.deepEqual(result.documents, [{ id: 42, title: 'Visible document' }]);
  for (const resource of PAPERLESS_OPTIONAL_WORKSPACE_RESOURCES) {
    assert.deepEqual(result.optional[resource], []);
    assert.deepEqual(result.availability[resource], {
      available: false,
      reason: 'permission-denied',
      status: 403,
    });
  }
  assert.deepEqual(result.availability.documents, { available: true });
});

test('one missing catalog permission does not discard other optional resources', async () => {
  const loaders = resourceRecord((resource) => async () => [`visible:${resource}`]);
  loaders.customFields = async () => { throw statusError(403); };

  const result = await negotiatePaperlessWorkspaceResources(
    async () => ['document'],
    loaders,
    resourceRecord(() => []),
  );

  assert.deepEqual(result.documents, ['document']);
  assert.deepEqual(result.optional.customFields, []);
  assert.deepEqual(result.availability.customFields, {
    available: false,
    reason: 'permission-denied',
    status: 403,
  });
  assert.deepEqual(result.optional.savedViews, ['visible:savedViews']);
  assert.deepEqual(result.availability.savedViews, { available: true });
  assert.deepEqual(result.optional.tags, ['visible:tags']);
  assert.deepEqual(result.availability.tags, { available: true });
});

test('authentication and required-document failures still reject workspace loading', async () => {
  await assert.rejects(
    negotiatePaperlessWorkspaceResources(
      async () => ['document'],
      {
        ...resourceRecord((resource) => async () => [resource]),
        tags: async () => { throw statusError(401); },
      },
      resourceRecord(() => []),
    ),
    (error) => error.status === 401,
  );

  await assert.rejects(
    negotiatePaperlessWorkspaceResources(
      async () => { throw statusError(403); },
      resourceRecord((resource) => async () => [resource]),
      resourceRecord(() => []),
    ),
    (error) => error.status === 403,
  );
});

test('server-filtered inbox membership remains authoritative when tag details are private', () => {
  const invisibleInbox = new Set([42]);
  assert.equal(resolvePaperlessDocumentStatus(42, [], invisibleInbox), 'inbox');
  assert.equal(resolvePaperlessDocumentStatus(43, [], invisibleInbox), 'archived');
  assert.equal(resolvePaperlessDocumentStatus(42, [{
    id: 'remote-tag-7',
    remoteId: 7,
    name: 'Posteingang',
    isInboxTag: true,
  }]), 'inbox');
});

test('restricted catalogs preserve opaque document relationships without private labels', () => {
  assert.match(paperlessSource, /is_in_inbox: 'true'/);
  assert.match(paperlessSource, /params\.set\('is_in_inbox', 'true'\)/);
  assert.doesNotMatch(paperlessSource, /is_in_inbox(?:\s*:\s*|',\s*)'1'/);
  assert.match(paperlessSource, /fields: 'id'/);
  assert.match(paperlessSource, /tagIds: document\.tags\.map\(\(tagId\) => `remote-tag-\$\{tagId\}`\)/);
  assert.match(paperlessSource, /`remote-correspondent-\$\{document\.correspondent\}`/);
  assert.match(paperlessSource, /`remote-type-\$\{document\.document_type\}`/);
  assert.match(paperlessSource, /`remote-storage-path-\$\{document\.storage_path\}`/);
  assert.match(paperlessSource, /`remote-owner-\$\{document\.owner\}`/);
  assert.match(paperlessSource, /originalFileName: document\.original_file_name \?\? document\.original_filename/);
  assert.match(paperlessSource, /mapDocument\(document, catalog, inboxDocumentIds\)/);
  assert.doesNotMatch(paperlessSource, /name: `(?:Private|Unknown) tag/);
});
