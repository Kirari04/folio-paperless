import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertCompletedFileSize,
  assertDownloadProgressWithinLimit,
  assertPdfPreviewDescriptor,
  DownloadSafetyError,
  effectiveDownloadLimit,
  hasPdfHeader,
  MAX_DOCUMENT_DOWNLOAD_BYTES,
  MAX_PDF_PREVIEW_BYTES,
  responseBlobWithinLimit,
} from '../src/lib/download-policy.ts';

test('download budgets retain a storage reserve and enforce the lower safety ceiling', () => {
  assert.equal(effectiveDownloadLimit({
    maxBytes: 500,
    availableBytes: 1_000,
    reserveBytes: 200,
  }), 500);
  assert.equal(effectiveDownloadLimit({
    maxBytes: 900,
    availableBytes: 1_000,
    reserveBytes: 200,
  }), 800);
  assert.throws(
    () => effectiveDownloadLimit({ maxBytes: 900, availableBytes: 200, reserveBytes: 200 }),
    (error) => error instanceof DownloadSafetyError && error.code === 'storage-pressure',
  );
});

test('declared, streamed, and completed byte counts cannot exceed the cap', () => {
  assert.doesNotThrow(() => assertDownloadProgressWithinLimit(50, -1, 100));
  assert.throws(
    () => assertDownloadProgressWithinLimit(101, -1, 100),
    (error) => error instanceof DownloadSafetyError && error.code === 'file-too-large',
  );
  assert.throws(
    () => assertDownloadProgressWithinLimit(1, 101, 100),
    (error) => error instanceof DownloadSafetyError && error.code === 'file-too-large',
  );
  assert.doesNotThrow(() => assertCompletedFileSize(MAX_DOCUMENT_DOWNLOAD_BYTES, MAX_DOCUMENT_DOWNLOAD_BYTES));
  assert.throws(() => assertCompletedFileSize(0, MAX_DOCUMENT_DOWNLOAD_BYTES));
});

test('web response buffering enforces declared and streamed limits', async () => {
  const bounded = await responseBlobWithinLimit(new Response('1234', {
    headers: { 'content-type': 'text/plain' },
  }), 4);
  assert.equal(bounded.size, 4);
  await assert.rejects(
    responseBlobWithinLimit(new Response('12345'), 4),
    (error) => error instanceof DownloadSafetyError && error.code === 'file-too-large',
  );
  await assert.rejects(
    responseBlobWithinLimit(new Response('1', { headers: { 'content-length': '5' } }), 4),
    (error) => error instanceof DownloadSafetyError && error.code === 'file-too-large',
  );
});

test('PDF validation requires a bounded file and a header within the first 1024 bytes', () => {
  const ordinary = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  const prefixed = Uint8Array.from([0, 0, ...ordinary]);
  assert.equal(hasPdfHeader(ordinary), true);
  assert.equal(hasPdfHeader(prefixed), true);
  assert.doesNotThrow(() => assertPdfPreviewDescriptor({
    size: ordinary.length,
    headerBytes: ordinary,
  }));
  assert.throws(
    () => assertPdfPreviewDescriptor({
      size: MAX_PDF_PREVIEW_BYTES + 1,
      headerBytes: ordinary,
    }),
    (error) => error instanceof DownloadSafetyError && error.code === 'file-too-large',
  );
  assert.throws(
    () => assertPdfPreviewDescriptor({ size: 100, headerBytes: Uint8Array.from([1, 2, 3]) }),
    (error) => error instanceof DownloadSafetyError && error.code === 'invalid-pdf',
  );
});

test('all app-owned network file downloads use the bounded transport', async () => {
  const files = await Promise.all([
    '../src/components/document-preview-viewer.tsx',
    '../src/context/app-context.tsx',
    '../src/lib/document-files.ts',
    '../src/lib/document-platform-actions.ts',
    '../src/lib/secure-pdf-preview-cache.ts',
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  const combined = files.join('\n');
  assert.doesNotMatch(combined, /File\.downloadFileAsync|FileSystem\.downloadAsync/);
  const boundedTransport = await readFile(
    new URL('../src/lib/bounded-file-download.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(boundedTransport, /createDownloadTask/);
  assert.match(boundedTransport, /fetch as expoFetch/);
  assert.match(boundedTransport, /redirect: input\.redirect \?\? 'manual'/);
  assert.match(boundedTransport, /response\.body\.getReader\(\)/);
  assert.match(boundedTransport, /open\(FileMode\.Truncate\)/);
  assert.match(combined, /downloadFileWithinLimit/);
  assert.match(files[0], /assertSafePdfFile/);
  assert.match(files[4], /assertSafePdfFile/);
});

test('native mTLS downloads receive the exact file budget after reserving free storage', async () => {
  const [paperless, session, binding, android, iosModule, iosTransfer] = await Promise.all([
    readFile(new URL('../src/lib/paperless.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/auth/session.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/auth/native-mtls-module.ts', import.meta.url), 'utf8'),
    readFile(new URL('../modules/folio-mtls/android/src/main/java/app/folio/mtls/FolioMtlsModule.kt', import.meta.url), 'utf8'),
    readFile(new URL('../modules/folio-mtls/ios/FolioMtlsModule.swift', import.meta.url), 'utf8'),
    readFile(new URL('../modules/folio-mtls/ios/FolioMtlsTransfer.swift', import.meta.url), 'utf8'),
  ]);

  assert.match(paperless, /effectiveDownloadLimit\(\{[\s\S]*availableBytes: Paths\.availableDiskSpace/);
  assert.match(paperless, /session\.download\(\{[\s\S]*maxBytes/);
  assert.match(session, /NativeMtlsDownloadRequest[\s\S]*maxBytes: number/);
  assert.match(binding, /maxBytes: request\.maxBytes/);
  assert.match(android, /val maxBytes = request\.maxBytes\.toLong\(\)/);
  assert.match(android, /completed <= maxBytes/);
  assert.match(iosModule, /\.download\(destination, Int64\(record\.maxBytes\)\)/);
  assert.match(iosTransfer, /downloadTask\.response as\? HTTPURLResponse/);
  assert.match(iosTransfer, /case \.download\(_, let requestedMaximum\)/);
  assert.match(iosTransfer, /Int64\(downloadedSize\) <= maximum/);
});

test('authenticated Paperless API requests remain on the configured origin and reject redirects', async () => {
  const source = await readFile(new URL('../src/lib/paperless.ts', import.meta.url), 'utf8');

  assert.match(source, /target\.origin !== base\.origin/);
  assert.match(source, /!target\.pathname\.startsWith\(apiPrefix\)/);
  assert.match(source, /target\.username[\s\S]*target\.password/);
  assert.match(source, /redirect: 'manual'/);
  assert.match(source, /response\.status >= 300 && response\.status < 400/);
  assert.match(source, /if \(response\.url\) configuredPaperlessRequestUrl\(credentials, response\.url\)/);
});

test('core and advanced Paperless response parsing retain bounded source contracts', async () => {
  const [coreSource, advancedSource] = await Promise.all([
    readFile(new URL('../src/lib/paperless.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/use-paperless-advanced.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(coreSource, /MAX_PAPERLESS_API_RESPONSE_BYTES = 32 \* 1024 \* 1024/);
  assert.match(coreSource, /declared > maxBytes/);
  assert.match(coreSource, /response\.body\.getReader\(\)/);
  assert.match(coreSource, /total \+= value\.byteLength/);
  assert.match(coreSource, /if \(total > maxBytes\)[\s\S]*reader\.cancel\(\)/);
  assert.match(coreSource, /readPaperlessResponseTextWithinLimit\(response\)/);

  assert.match(advancedSource, /redirect: 'manual' as const/);
  assert.match(advancedSource, /requestPaperlessRawResponse\(credentials, path, init\)/);
  assert.match(advancedSource, /new TextEncoder\(\)\.encode\(text\)\.byteLength > 32 \* 1024 \* 1024/);
  assert.match(advancedSource, /byteLength > 32 \* 1024 \* 1024[\s\S]*parseResponseBody\(text\)/);
  assert.doesNotMatch(advancedSource, /cacheBinding[\s\S]{0,300}credentials\.(?:token|customHeaders)/);
  assert.match(advancedSource, /cacheBinding[\s\S]{0,300}credentialGeneration/);
  assert.match(advancedSource, /return \(\) => \{[\s\S]*capabilityCache\.invalidate\(profileId\)/);
});

test('single-document exports are profile-scoped, bounded, redirect-safe, and lifecycle-guarded', async () => {
  const [fileSource, contextSource] = await Promise.all([
    readFile(new URL('../src/lib/document-files.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/context/app-context.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(fileSource, /profileDirectoryName\(credentials\.profileId \?\? ''\)/);
  assert.match(fileSource, /ensureOwnedProfileRoot\([\s\S]*Paths\.cache,[\s\S]*safeProfileSegment\(credentials\),[\s\S]*nativeProfileRootStorage/);
  assert.match(fileSource, /'exports',[\s\S]*String\(remoteId\)/);
  assert.match(fileSource, /globalThis\.crypto\?\.randomUUID/);
  assert.match(fileSource, /redirect: 'manual'/);
  assert.match(fileSource, /responseBlobWithinLimit\(response, MAX_DOCUMENT_DOWNLOAD_BYTES\);\s*assertProfileCurrent\(options\);/);
  assert.ok((fileSource.match(/assertProfileCurrent\(options\);/g) ?? []).length >= 3);
  assert.ok((fileSource.match(/file\.cleanup\(/g) ?? []).length >= 2);
  assert.ok((contextSource.match(/isProfileCurrent: \(\) => activeProfileIdRef\.current === operationProfileId/g) ?? []).length >= 2);
});

test('bulk web exports stream within the file budget before browser download', async () => {
  const source = await readFile(new URL('../src/lib/bulk-document-export.ts', import.meta.url), 'utf8');
  assert.match(source, /redirect: 'manual'/);
  assert.match(source, /responseBlobWithinLimit\(response, MAX_DOCUMENT_DOWNLOAD_BYTES\)/);
  assert.doesNotMatch(source, /response\.blob\(\)/);
  assert.match(source, /executionGuard\?\.\(\) === false/);
});

test('updater input stays on the Folio GitHub release path and within file and size bounds', async () => {
  const [updateSource, overlaySource, updateContextSource] = await Promise.all([
    readFile(new URL('../src/lib/app-updates.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/update-overlay.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/context/update-context.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(updateSource, /url\.protocol !== 'https:'/);
  assert.match(updateSource, /url\.hostname\.toLocaleLowerCase\(\) !== 'github\.com'/);
  assert.match(updateSource, /!url\.pathname\.startsWith\(RELEASE_PATH_PREFIX\)/);
  assert.match(updateSource, /candidate\.protocol === 'file:'/);
  assert.match(updateSource, /candidate\.pathname\.startsWith\(root\.pathname\.endsWith\('\/'\)/);
  assert.ok((updateSource.match(/updateFileUriIsContained\(downloaded\.fileUri\)/g) ?? []).length >= 3);
  assert.match(updateSource, /candidate\.size <= MAX_APK_UPDATE_BYTES/);
  assert.match(updateSource, /value\.size > MAX_APK_UPDATE_BYTES/);
  assert.match(updateContextSource, /redirect: 'follow'/);
  assert.match(updateSource, /Number\.isSafeInteger\(candidate\.size\)/);
  assert.match(updateSource, /Number\.isSafeInteger\(value\.size\)/);
  assert.match(overlaySource, /Linking\.openURL\(trustedFolioReleaseUrl\(updates\.release\?\.htmlUrl\)\)/);
});
