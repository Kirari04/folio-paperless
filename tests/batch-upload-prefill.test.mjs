import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  MAX_SCAN_LINK_TAGS,
  parseScanLinkParameters,
  resolveScanLinkTags,
  scanLinkQueryValues,
} from '../src/lib/scan-prefill-link.ts';
import {
  UPLOAD_BATCH_PREFILL_TTL_MS,
  UploadBatchPrefillMemory,
  applyUploadBatchPrefill,
  clearUploadBatchPrefillFields,
  libraryFilterUploadBatchPrefill,
  tagsUploadBatchPrefill,
  uploadBatchPrefillFields,
  uploadBatchPrefillFromMetadata,
} from '../src/lib/upload-batch-prefill.ts';
import {
  parseExternalUrl,
  resolveExternalNavigation,
  serializeExternalRoute,
} from '../src/lib/external-routing.ts';
import { ExternalRoutingRuntime } from '../src/lib/external-routing-runtime.ts';
import { consumeCachedLinkingUrl } from '../src/lib/consumable-linking.ts';
import { defaultUploadMetadataDraft } from '../src/types/tasks.ts';

const appContextSource = await readFile(
  new URL('../src/context/app-context.tsx', import.meta.url),
  'utf8',
);
const intakeSource = await readFile(new URL('../src/app/intake.tsx', import.meta.url), 'utf8');
const scanSource = await readFile(new URL('../src/app/scan.tsx', import.meta.url), 'utf8');
const librarySource = await readFile(new URL('../src/app/documents.tsx', import.meta.url), 'utf8');

const READY = {
  bootstrap: 'ready',
  profileSelection: 'ready',
  biometric: 'unlocked',
  authenticated: true,
  activeProfileId: 'profile-a',
  knownProfileIds: ['profile-a', 'profile-b'],
};

const option = (remoteId, name) => ({ id: `remote-${remoteId}`, remoteId, name });

const catalogTags = [option(1, 'Inbox'), option(2, 'Tax 2026'), option(3, 'Insurance')];

function completedUpload() {
  return {
    ...defaultUploadMetadataDraft('Annex 3 scan'),
    created: { state: 'value', value: '2026-09-19' },
    correspondent: { state: 'value', value: option(7, 'Allianz') },
    documentType: { state: 'value', value: option(9, 'Contract') },
    tags: { state: 'value', value: [option(2, 'Tax 2026'), option(3, 'Insurance')] },
    storagePath: { state: 'value', value: option(4, 'Household/2026') },
    archiveSerialNumber: { state: 'value', value: 4_212 },
    customFields: [
      { fieldId: 'amount', fieldRemoteId: 10, dataType: 'integer', value: { state: 'value', value: 120 } },
      { fieldId: 'reviewed', fieldRemoteId: 11, dataType: 'boolean', value: { state: 'unset' } },
    ],
  };
}

test('a completed upload is remembered without its title or archive serial number', () => {
  const prefill = uploadBatchPrefillFromMetadata(completedUpload());

  assert.equal('title' in prefill, false);
  assert.equal('archiveSerialNumber' in prefill, false);
  assert.deepEqual(uploadBatchPrefillFields(prefill), [
    'created',
    'correspondent',
    'documentType',
    'tags',
    'storagePath',
    'customFields',
  ]);
  assert.deepEqual(prefill.customFields, [{
    fieldId: 'amount',
    fieldRemoteId: 10,
    dataType: 'integer',
    value: { state: 'value', value: 120 },
  }]);
});

test('the prefill fills a staged draft and never overwrites its own title or serial', () => {
  const staged = defaultUploadMetadataDraft('Annex 4 scan');
  const filled = applyUploadBatchPrefill(staged, uploadBatchPrefillFromMetadata(completedUpload()));

  assert.deepEqual(filled.title, { state: 'value', value: 'Annex 4 scan' });
  assert.deepEqual(filled.archiveSerialNumber, { state: 'unset' });
  assert.equal(filled.correspondent.value.remoteId, 7);
  assert.deepEqual(filled.tags.value.map((tag) => tag.remoteId), [2, 3]);
  assert.equal(filled.created.value, '2026-09-19');
});

test('an absent prefill field leaves the preset value in place instead of clearing it', () => {
  const fromPreset = {
    ...defaultUploadMetadataDraft('Annex 5 scan'),
    documentType: { state: 'value', value: option(9, 'Contract') },
    customFields: [
      { fieldId: 'reviewed', fieldRemoteId: 11, value: { state: 'value', value: true } },
    ],
  };
  const tagsOnly = tagsUploadBatchPrefill([option(2, 'Tax 2026')]);
  const filled = applyUploadBatchPrefill(fromPreset, tagsOnly);

  assert.equal(filled.documentType.value.remoteId, 9);
  assert.deepEqual(filled.customFields, fromPreset.customFields);
  assert.deepEqual(filled.tags.value.map((tag) => tag.remoteId), [2]);
});

test('resetting clears exactly the prefilled fields and keeps the rest of the draft', () => {
  const prefill = uploadBatchPrefillFromMetadata(completedUpload());
  const filled = {
    ...applyUploadBatchPrefill(defaultUploadMetadataDraft('Annex 6 scan'), prefill),
    archiveSerialNumber: { state: 'value', value: 91 },
  };

  const cleared = clearUploadBatchPrefillFields(filled, uploadBatchPrefillFields(prefill));

  assert.deepEqual(cleared.title, { state: 'value', value: 'Annex 6 scan' });
  assert.deepEqual(cleared.archiveSerialNumber, { state: 'value', value: 91 });
  assert.deepEqual(cleared.correspondent, { state: 'unset' });
  assert.deepEqual(cleared.documentType, { state: 'unset' });
  assert.deepEqual(cleared.tags, { state: 'unset' });
  assert.deepEqual(cleared.storagePath, { state: 'unset' });
  assert.deepEqual(cleared.created, { state: 'unset' });
  assert.deepEqual(cleared.customFields, []);
});

test('the remembered upload is profile scoped, expires after an hour, and is forgettable', () => {
  const memory = new UploadBatchPrefillMemory();
  const start = Date.UTC(2026, 8, 19, 9, 0, 0);

  memory.rememberUpload('profile-a', completedUpload(), start);
  memory.rememberUpload('profile-b', {
    ...defaultUploadMetadataDraft(),
    tags: { state: 'value', value: [option(1, 'Inbox')] },
  }, start);

  const active = memory.read('profile-a', start + 59 * 60_000);
  assert.equal(active.origin, 'previous-upload');
  assert.equal(active.metadata.correspondent.value.remoteId, 7);
  assert.deepEqual(
    memory.read('profile-b', start).metadata.tags.value.map((tag) => tag.remoteId),
    [1],
  );
  assert.equal(memory.read('profile-c', start), null);

  assert.equal(memory.read('profile-a', start + UPLOAD_BATCH_PREFILL_TTL_MS), null);
  assert.equal(memory.read('profile-a', start + 59 * 60_000), null, 'an expired entry is dropped');

  memory.forget('profile-b');
  assert.equal(memory.read('profile-b', start), null);
});

test('an upload with nothing worth repeating leaves no prefill behind', () => {
  const memory = new UploadBatchPrefillMemory();
  const now = Date.now();

  memory.rememberUpload('profile-a', completedUpload(), now);
  assert.ok(memory.read('profile-a', now));

  // A title-only upload carries no batch intent, and replaces the stale one.
  assert.equal(
    memory.rememberUpload('profile-a', defaultUploadMetadataDraft('Just a title'), now),
    null,
  );
  assert.equal(memory.read('profile-a', now), null);
  assert.equal(memory.rememberUpload('profile-a', undefined, now), null);
});

test('a first upload borrows the tags of the library filter, and nothing else', () => {
  const fromTags = libraryFilterUploadBatchPrefill(['remote-2', 'remote-3'], catalogTags);
  assert.deepEqual(Object.keys(fromTags.metadata), ['tags']);
  assert.deepEqual(fromTags.metadata.tags.value.map((tag) => tag.remoteId), [2, 3]);
  assert.equal(fromTags.label, 'Tax 2026, Insurance');

  const fromSavedView = libraryFilterUploadBatchPrefill(['remote-2'], catalogTags, 'Tax folder');
  assert.equal(fromSavedView.label, 'Tax folder');

  assert.equal(libraryFilterUploadBatchPrefill([], catalogTags), null);
  assert.equal(libraryFilterUploadBatchPrefill(['remote-404'], catalogTags), null);
  assert.equal(
    libraryFilterUploadBatchPrefill(['local-tag'], [{ id: 'local-tag', name: 'Draft' }]),
    null,
    'a tag that does not exist on the server cannot be uploaded',
  );
});

test('a scan link accepts tag IDs and tag names, deduplicated, and nothing else', () => {
  const byId = parseScanLinkParameters({ tags: '2,3' });
  assert.deepEqual(byId.prefill.tags, [
    { kind: 'remote-id', remoteId: 2 },
    { kind: 'remote-id', remoteId: 3 },
  ]);

  const byName = parseScanLinkParameters({ tags: 'Tax 2026, insurance , 2' });
  assert.deepEqual(byName.prefill.tags, [
    { kind: 'name', name: 'Tax 2026' },
    { kind: 'name', name: 'insurance' },
    { kind: 'remote-id', remoteId: 2 },
  ]);
  assert.deepEqual(
    parseScanLinkParameters({ tags: 'Tax 2026,tax 2026,2,2' }).prefill.tags.length,
    2,
  );
  assert.deepEqual(scanLinkQueryValues(byName.prefill), { tags: 'Tax 2026,insurance,2' });

  const rejected = [
    {},
    { tags: '' },
    { tags: '   ' },
    { tags: '2,,3' },
    { tags: '2,' },
    { tags: `2,${'x'.repeat(129)}` },
    { tags: Array.from({ length: MAX_SCAN_LINK_TAGS + 1 }, (_, index) => index + 1).join(',') },
    { tags: 'Tax\u00002026' },
  ];
  for (const values of rejected) {
    assert.equal(parseScanLinkParameters(values).accepted, false, JSON.stringify(values));
  }
});

test('a scan link carrying a credential is refused with its own reason', () => {
  for (const key of ['token', 'Token', 'password', 'api_key', 'client_secret', 'authorization']) {
    const result = parseScanLinkParameters({ tags: '2', [key]: 'opaque' });
    assert.equal(result.accepted, false, key);
    assert.equal(result.code, 'scan-secret-in-link', key);
  }
  const url = parseExternalUrl('folio-paperless://scan?tags=2&token=opaque');
  assert.equal(url.accepted, false);
  assert.equal(url.code, 'scan-secret-in-link');
  assert.equal(
    new ExternalRoutingRuntime().acceptUrl('folio-paperless://scan?tags=2&token=opaque').code,
    'scan-secret-in-link',
  );
});

test('link tags are resolved against the active catalog and unknown tags are ignored', () => {
  const { prefill } = parseScanLinkParameters({ tags: '2,Insurance,Bank,404' });
  const resolved = resolveScanLinkTags(prefill, catalogTags);

  assert.deepEqual(resolved.tags.map((tag) => tag.remoteId), [2, 3]);
  assert.deepEqual(resolved.unresolved, ['Bank', '404']);
  assert.deepEqual(
    resolveScanLinkTags(prefill, []).tags,
    [],
    'an empty catalog resolves nothing instead of inventing tags',
  );
  assert.deepEqual(
    resolveScanLinkTags({ tags: [{ kind: 'name', name: 'tax 2026' }] }, catalogTags)
      .tags.map((tag) => tag.remoteId),
    [2],
    'a name matches the printed label case-insensitively',
  );
  assert.deepEqual(
    resolveScanLinkTags(
      { tags: [{ kind: 'remote-id', remoteId: 5 }] },
      [{ id: 'local-5', name: 'Draft' }],
    ).unresolved,
    ['5'],
  );
});

test('the scan route carries a prefill without changing the plain scan route', async () => {
  const plain = parseExternalUrl('folio-paperless://scan');
  assert.equal(plain.route.kind, 'scanner');
  assert.equal(plain.route.prefill, undefined);
  assert.deepEqual(
    await resolveExternalNavigation(plain.route, READY),
    { kind: 'navigate', target: { pathname: '/scan' } },
  );

  const prefilled = parseExternalUrl('folio-paperless://scan?tags=2%2CInsurance');
  assert.equal(prefilled.accepted, true);
  assert.deepEqual(prefilled.route.prefill.tags, [
    { kind: 'remote-id', remoteId: 2 },
    { kind: 'name', name: 'Insurance' },
  ]);
  assert.equal(
    serializeExternalRoute(prefilled.route),
    'folio-paperless://scan?tags=2%2CInsurance',
  );
  assert.deepEqual(
    parseExternalUrl(serializeExternalRoute(prefilled.route)).route.prefill,
    prefilled.route.prefill,
    'serialize and parse round trip',
  );

  const decision = await resolveExternalNavigation(prefilled.route, READY);
  assert.deepEqual(decision, {
    kind: 'navigate',
    target: {
      pathname: '/scan',
      params: { prefill: 'folio-paperless://scan?tags=2%2CInsurance' },
    },
  });

  // Non-regression: the other public routes keep parsing and serializing.
  for (const [url, kind] of [
    ['folio-paperless://home', 'home'],
    ['folio-paperless://settings', 'settings'],
    ['folio-paperless://scanner', 'scanner'],
    ['folio-paperless://inbox?profile=profile-a', 'inbox'],
    ['folio-paperless://library', 'library'],
    ['folio-paperless://search?q=annual%20report', 'search'],
    ['folio-paperless://document/doc-42?profile=profile-a', 'document'],
  ]) {
    const result = parseExternalUrl(url);
    assert.equal(result.accepted, true, url);
    assert.equal(result.route.kind, kind, url);
  }
  assert.equal(
    serializeExternalRoute(parseExternalUrl('folio-paperless://search?q=tax').route),
    'folio-paperless://search?q=tax',
  );
  for (const url of [
    'folio-paperless://scan/extra?tags=2',
    'folio-paperless://scan?tags=2&tags=3',
    'folio-paperless://scan?profile=profile-a',
    'folio-paperless://scan?tags=2#private',
  ]) {
    assert.equal(parseExternalUrl(url).accepted, false, url);
  }
});

test('a cold-start scan link drains once, after the Expo cache has been cleared', async () => {
  let cachedUrl = 'folio-paperless://scan?tags=2';
  const calls = [];
  const cache = {
    getLinkingURL() {
      calls.push('get');
      return cachedUrl;
    },
    clearInitialURL() {
      calls.push('clear');
      cachedUrl = null;
    },
  };
  const runtime = new ExternalRoutingRuntime();

  assert.equal(consumeCachedLinkingUrl(cache, (url) => {
    calls.push(`consume:${url}`);
    assert.equal(cachedUrl, null, 'authority is granted only after the clear');
    assert.equal(runtime.acceptUrl(url, 'deep-link').accepted, true);
  }), true);
  assert.deepEqual(calls, ['get', 'clear', 'consume:folio-paperless://scan?tags=2']);

  const decisions = await runtime.drain(READY);
  assert.deepEqual(decisions, [{
    kind: 'navigate',
    target: { pathname: '/scan', params: { prefill: 'folio-paperless://scan?tags=2' } },
  }]);
  assert.deepEqual(runtime.pending(), [], 'a handled link is not replayed');
  assert.equal(consumeCachedLinkingUrl(cache, () => assert.fail('replayed cold URL')), false);
});

test('the batch memory is written when the person taps Send, not when Paperless finishes', () => {
  // Tying the memory to task completion made two quick scans behave differently
  // from two slow ones (device test, 2026-09-22): a hidden delay is not a rule.
  assert.match(
    appContextSource,
    /const lastSubmitted = submitted\.at\(-1\);\s*\n\s*if \(lastSubmitted\?\.kind === 'upload'\) \{\s*\n\s*uploadBatchPrefillMemory\.current\.rememberUpload\(profileId, lastSubmitted\.metadata\);/,
  );
  assert.equal(appContextSource.match(/rememberUpload\(/g).length, 1);
  assert.doesNotMatch(appContextSource, /result\.kind !== 'ready'[\s\S]{0,400}?rememberUpload\(/);
  assert.equal(appContextSource.match(/uploadBatchPrefillMemory\.current\.remember/g).length, 2);
});

test('the staged batch is prefilled through the existing intake metadata path', () => {
  assert.match(
    appContextSource,
    /const prefill = profileId \? resolveUploadBatchPrefill\(profileId\) : null;[\s\S]{0,400}?\.\.\.\(prefill \? \{ metadata: prefill\.metadata \} : \{\}\)/,
  );
  assert.match(
    appContextSource,
    /const remembered = uploadBatchPrefillMemory\.current\.read\(profileId\);[\s\S]{0,400}?libraryFilterUploadBatchPrefill\(filter\.tagIds, catalog\.tags, filter\.label\)/,
  );
  assert.match(appContextSource, /uploadBatchPrefillMemory\.current\.forget\(profileId\)/);
  assert.match(librarySource, /reportLibraryTagFilter\(filters\.tagIds\.length/);
});

test('the upload sheet says where its values came from and can clear exactly those', () => {
  assert.match(intakeSource, /const batchPrefill = batchId \? uploadBatchPrefills\[batchId\] : undefined/);
  assert.match(
    intakeSource,
    /batchPrefill\.origin === 'previous-upload' \|\| !batchPrefill\.label\s*\n\s*\? t\('intake\.prefillPrevious'\)\s*\n\s*: t\('intake\.prefillFromLabel'/,
  );
  assert.match(
    intakeSource,
    /clearUploadBatchPrefillFields\(existing, batchPrefill\.fields\)[\s\S]{0,300}?clearUploadBatchPrefill\(batchPrefill\.batchId\)/,
  );
  assert.match(intakeSource, /onPress=\{resetBatchPrefill\}/);
});

test('the scanner re-parses its link and can never create a tag from it', () => {
  assert.match(
    scanSource,
    /const parsed = parseExternalUrl\(prefillLink, 'deep-link'\);[\s\S]{0,300}?resolveScanLinkTags\(parsed\.route\.prefill, catalog\.tags\)/,
  );
  assert.match(scanSource, /consumedPrefillLink\.current === prefillLink/);
  assert.match(scanSource, /resolved\.unresolved\.length[\s\S]{0,200}?scan\.linkTagsUnknown/);
  assert.doesNotMatch(scanSource, /createCatalogOption/);
});
