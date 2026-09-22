import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DOCUMENT_THUMBNAIL_REPRESENTATION,
  allowsRealDocumentThumbnail,
  documentThumbnailCacheFileName,
  documentThumbnailCacheSeed,
  documentThumbnailImageCacheKey,
  documentThumbnailServerOrigin,
  resolveDocumentThumbnailPresentation,
} from '../src/lib/document-thumbnail-policy.ts';

const viewableDocument = {
  remoteId: 41,
  canView: true,
  deletedAt: null,
  status: 'archived',
};

function allows(overrides = {}) {
  return allowsRealDocumentThumbnail({
    enabled: true,
    contentPrivate: false,
    hasCredentials: true,
    document: viewableDocument,
    ...overrides,
  });
}

function presents(overrides = {}) {
  return resolveDocumentThumbnailPresentation({ allowed: true, load: 'ready', ...overrides });
}

test('a viewable document on a connected profile may show its real thumbnail', () => {
  assert.equal(allows(), true);
  assert.equal(presents(), 'image');
});

test('the appearance setting alone decides whether a request is ever made', () => {
  assert.equal(allows({ enabled: false }), false);
  assert.equal(presents({ allowed: false }), 'illustration');
});

test('a locked Folio never paints the paper, whatever the setting says', () => {
  assert.equal(allows({ contentPrivate: true }), false);
  assert.equal(allows({ contentPrivate: true, enabled: true }), false);
  assert.equal(presents({ allowed: false, load: 'ready' }), 'illustration');
});

test('the demo workspace has no server to ask', () => {
  assert.equal(allows({ hasCredentials: false }), false);
});

test('documents without a usable server thumbnail keep the illustrated card', () => {
  assert.equal(allows({ document: { ...viewableDocument, remoteId: undefined } }), false);
  assert.equal(allows({ document: { ...viewableDocument, remoteId: null } }), false);
  assert.equal(allows({ document: { ...viewableDocument, remoteId: 0 } }), false);
  assert.equal(allows({ document: { ...viewableDocument, remoteId: -3 } }), false);
  assert.equal(allows({ document: { ...viewableDocument, remoteId: 4.5 } }), false);
  assert.equal(allows({ document: { ...viewableDocument, canView: false } }), false);
  assert.equal(allows({ document: { ...viewableDocument, status: 'processing' } }), false);
  assert.equal(
    allows({ document: { ...viewableDocument, deletedAt: '2026-09-01T10:00:00Z' } }),
    false,
  );
  // A document Folio has not yet confirmed still gets its chance; `canView` is
  // only ever an explicit refusal.
  assert.equal(allows({ document: { remoteId: 41 } }), true);
});

test('a slow, failed, or oversized thumbnail leaves the illustrated card in place', () => {
  assert.equal(presents({ load: 'pending' }), 'illustration');
  assert.equal(presents({ load: 'failed' }), 'illustration');
});

test('the cache key is stable and scoped to the profile, the server, and the document', () => {
  const seed = documentThumbnailCacheSeed({
    profileKey: 'profile-a',
    serverOrigin: 'https://paper.example',
    documentId: 41,
  });
  assert.equal(seed, `profile-a\nhttps://paper.example\n41\n${DOCUMENT_THUMBNAIL_REPRESENTATION}`);
  assert.equal(
    seed,
    documentThumbnailCacheSeed({
      profileKey: 'profile-a',
      serverOrigin: 'https://paper.example',
      documentId: 41,
    }),
  );
  for (const other of [
    { profileKey: 'profile-b', serverOrigin: 'https://paper.example', documentId: 41 },
    { profileKey: 'profile-a', serverOrigin: 'https://other.example', documentId: 41 },
    { profileKey: 'profile-a', serverOrigin: 'https://paper.example', documentId: 42 },
  ]) {
    assert.notEqual(seed, documentThumbnailCacheSeed(other));
  }
  assert.equal(
    documentThumbnailImageCacheKey({ profileKey: 'profile-a', documentId: 41 }),
    'folio-thumb-profile-a-41',
  );
  assert.notEqual(
    documentThumbnailImageCacheKey({ profileKey: 'profile-b', documentId: 41 }),
    documentThumbnailImageCacheKey({ profileKey: 'profile-a', documentId: 41 }),
  );
});

test('an unparsable stored server URL still separates two servers', () => {
  assert.equal(documentThumbnailServerOrigin('https://paper.example/paperless'), 'https://paper.example');
  assert.equal(documentThumbnailServerOrigin('  not a url  '), 'not a url');
  assert.notEqual(documentThumbnailServerOrigin('one'), documentThumbnailServerOrigin('two'));
});

test('two mounts of one document own separate cache files', () => {
  const digest = 'a'.repeat(64);
  assert.equal(documentThumbnailCacheFileName(digest, '1'), `folio-thumb-${'a'.repeat(40)}-1.img`);
  assert.notEqual(
    documentThumbnailCacheFileName(digest, '1'),
    documentThumbnailCacheFileName(digest, '2'),
  );
});

test('the card renderer consults the policy instead of reimplementing it', async () => {
  const card = await readFile(
    new URL('../src/components/document-thumbnail.tsx', import.meta.url),
    'utf8',
  );
  assert.match(card, /allowsRealDocumentThumbnail\(\{/);
  assert.match(card, /contentPrivate: access\.contentPrivate/);
  assert.match(card, /enabled: access\.enabled/);
  assert.match(card, /hasCredentials: access\.hasCredentials/);
  assert.match(card, /if \(!allowed \|\| !access\.credentials/);
  assert.match(card, /fallback=\{illustration\}/);

  const context = await readFile(
    new URL('../src/context/document-thumbnail-context.tsx', import.meta.url),
    'utf8',
  );
  // Absent a provider, no card may reach the network or reveal a page.
  assert.match(context, /contentPrivate: true/);
  assert.match(context, /enabled: preferencesReady && preferences\.realThumbnails/);

  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /<DocumentThumbnailProvider contentPrivate=\{showLock\}>/);

  const shared = await readFile(
    new URL('../src/components/secure-document-thumbnail.tsx', import.meta.url),
    'utf8',
  );
  assert.match(shared, /maxBytes: MAX_THUMBNAIL_DOWNLOAD_BYTES/);
  assert.match(shared, /onError=\{\(\) => setState/);

  // The merge rail keeps using the one shared downloader.
  const merge = await readFile(
    new URL('../src/components/document-pdf-merge-selection.tsx', import.meta.url),
    'utf8',
  );
  assert.match(merge, /import \{ SecureDocumentThumbnail \}/);
  assert.doesNotMatch(merge, /downloadPaperlessFileWithCredentials/);
});

test('the appearance setting ships enabled and survives a preference blob without it', async () => {
  const context = await readFile(
    new URL('../src/context/app-context.tsx', import.meta.url),
    'utf8',
  );
  assert.match(context, /realThumbnails: true,/);
  assert.match(
    context,
    /typeof merged\.realThumbnails === 'boolean'\s*\?\s*merged\s*:\s*\{ \.\.\.merged, realThumbnails: defaultPreferences\.realThumbnails \}/,
  );
});
