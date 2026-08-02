import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  sanitizeIntakeFilename,
  stageIntakeBatch,
  stagedFileRetention,
  tasksReadyForStagingCleanup,
  validateIntakeCandidate,
  MAX_SHARED_TEXT_BYTES,
} from '../src/lib/intake.ts';

const nativeStagingSource = await readFile(
  new URL('../src/lib/file-staging.ts', import.meta.url),
  'utf8',
);
const nativeFenceSource = await readFile(
  new URL('../src/lib/native-profile-root-storage.ts', import.meta.url),
  'utf8',
);
const appContextSource = await readFile(
  new URL('../src/context/app-context.tsx', import.meta.url),
  'utf8',
);
const iosBackupAdapterSource = await readFile(
  new URL('../src/lib/sensitive-file-backup.ios.ts', import.meta.url),
  'utf8',
);
const iosPlatformModuleSource = await readFile(
  new URL('../modules/folio-platform/ios/FolioPlatformModule.swift', import.meta.url),
  'utf8',
);

test('sanitizes untrusted source filenames while retaining a display-safe name', () => {
  assert.equal(sanitizeIntakeFilename('../Invoice\u0000: 2026?.pdf'), 'Invoice- 2026-.pdf');
  assert.equal(sanitizeIntakeFilename('invoice\u202Efdp.exe'), 'invoicefdp.exe');
  assert.equal(sanitizeIntakeFilename('   '), 'shared-document');
});

test('rejects unsupported, empty, and over-limit candidates independently', () => {
  assert.equal(validateIntakeCandidate({ uri: 'x', name: 'x.exe', mimeType: 'application/x-msdownload' }).code, 'unsupported-file');
  assert.equal(validateIntakeCandidate({ uri: 'x', name: 'x.pdf', mimeType: 'application/pdf', size: 0 }).code, 'unsupported-file');
  assert.equal(validateIntakeCandidate({ uri: 'x', name: 'x.pdf', mimeType: 'application/pdf', size: 11 }, 10).code, 'unsupported-file');
  assert.equal(validateIntakeCandidate({ uri: 'x', name: 'x.pdf', mimeType: 'application/pdf', size: Number.NaN }).code, 'unsupported-file');
});

test('post-copy intake validation enforces the same hard limit and removes rejected output', async () => {
  const calls = [];
  const removed = [];
  const result = await stageIntakeBatch([
    { uri: 'content://mutable', name: 'mutable.pdf', mimeType: 'application/pdf', size: 10 },
  ], {
    profileId: 'profile-a',
    source: 'picker',
    maxBytes: 10,
    id: () => 'bounded-job',
    adapter: {
      async stage(candidate, stagedName, profileId, maxBytes) {
        calls.push({ candidate, stagedName, profileId, maxBytes });
        return {
          uri: 'file:///private/profile-a/staging/bounded-job.pdf',
          name: stagedName,
          size: 11,
          mimeType: candidate.mimeType,
        };
      },
      async remove(profileId, uri) { removed.push({ uri, profileId }); },
    },
  });

  assert.deepEqual(calls.map(({ profileId, maxBytes }) => ({ profileId, maxBytes })), [
    { profileId: 'profile-a', maxBytes: 10 },
  ]);
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0].error.code, 'unsupported-file');
  assert.deepEqual(removed, [{
    uri: 'file:///private/profile-a/staging/bounded-job.pdf',
    profileId: 'profile-a',
  }]);
});

test('native staging contract streams under the cap and detects source mutation', () => {
  assert.match(nativeStagingSource, /const expectedSize = source\.size;/);
  assert.match(nativeStagingSource, /sourceHandle\.readBytes\(64 \* 1024\)/);
  assert.match(nativeStagingSource, /copied \+ bytes\.byteLength > maxBytes/);
  assert.match(nativeStagingSource, /if \(copied !== expectedSize\)/);
  assert.match(
    nativeStagingSource,
    /catch \(error\) \{[\s\S]*if \(destination\.exists\) destination\.delete\(\)/,
  );
  assert.match(nativeStagingSource, /candidate\.textContent !== undefined/);
  assert.match(nativeStagingSource, /Math\.min\(maxBytes, MAX_SHARED_TEXT_BYTES\)/);
  assert.match(nativeStagingSource, /destination\.write\(candidate\.textContent\)/);
});

test('native staging accepts only profile-contained canonical file URIs', () => {
  assert.match(nativeStagingSource, /parsed\.protocol !== 'file:'/);
  assert.match(
    nativeStagingSource,
    /parsed\.username \|\| parsed\.password \|\| parsed\.search \|\| parsed\.hash/,
  );
  assert.match(
    nativeStagingSource,
    /ensureOwnedProfileRoot\(Paths\.document, profileId, nativeProfileRootStorage\)/,
  );
  assert.match(nativeStagingSource, /profileRootDirectoryOwner\(directory, nativeProfileRootStorage\)/);
  assert.match(nativeStagingSource, /profileDirectoryCandidates\(profileId\)/);
  assert.match(
    nativeStagingSource,
    /directory\.exists && directoryOwner\(directory\) === profileDirectoryName\(profileId\)/,
  );
  assert.match(nativeStagingSource, /candidate\.startsWith\(`\$\{root\}\/`\)/);
  assert.match(
    nativeStagingSource,
    /assertProfileStagingUri\(profileId, uri\);\s*const file = new File\(uri\)/,
  );
  assert.match(nativeStagingSource, /await remove\(task\.profileId, task\.localUri!\)/);
});

test('iOS staging fails closed unless the private copy is excluded from backup', () => {
  assert.match(
    nativeStagingSource,
    /await excludeSensitiveFileFromBackup\(destination\.uri\)/,
  );
  assert.match(
    nativeStagingSource,
    /catch \(error\) \{[\s\S]*if \(destination\.exists\) destination\.delete\(\)/,
  );
  assert.match(iosBackupAdapterSource, /excludeFileFromBackupAsync/);
  assert.match(iosBackupAdapterSource, /Secure iOS staging protection is unavailable/);
  assert.match(iosPlatformModuleSource, /AsyncFunction\("excludeFileFromBackupAsync"\)/);
  assert.match(iosPlatformModuleSource, /\.appendingPathComponent\("profiles", isDirectory: true\)/);
  assert.match(iosPlatformModuleSource, /file\.path\.hasPrefix\(rootPath\)/);
  assert.match(iosPlatformModuleSource, /protection\.isExcludedFromBackup = true/);
  assert.match(iosPlatformModuleSource, /\.isExcludedFromBackupKey/);
});

test('native profile deletion is planned durably and is recoverable after restart', () => {
  assert.match(nativeStagingSource, /export type NativeProfileFileRemovalManifest = \{/);
  assert.match(nativeStagingSource, /version: 2;/);
  assert.match(nativeStagingSource, /fenceDisposition: NativeProfileRemovalFenceDisposition;/);
  assert.match(nativeStagingSource, /fenceUri: string;/);
  assert.match(nativeStagingSource, /originalUri: string;\s*quarantineUri: string;/);
  assert.match(nativeStagingSource, /sourceExisted: boolean;/);
  assert.match(nativeStagingSource, /export function planNativeProfileFileRemoval\(/);
  assert.match(nativeStagingSource, /profileDirectoryCandidates\(exactProfileId\)/);
  assert.match(nativeStagingSource, /new Directory\(Paths\.cache, 'folio-previews', temporaryProfileId\)/);
  assert.match(nativeStagingSource, /new Directory\(Paths\.cache, 'folio-exports', temporaryProfileId\)/);
  assert.match(nativeStagingSource, /await options\.persistPlan\?\.\(manifest\);/);
  const persist = nativeStagingSource.indexOf('await options.persistPlan?.(manifest);');
  const fence = nativeStagingSource.indexOf('createNativeProfileRemovalFence(manifestFence(manifest));');
  const firstMove = nativeStagingSource.indexOf('await original.move(quarantined);');
  assert.ok(persist >= 0 && firstMove > persist, 'the manifest is durable before the first move');
  assert.ok(fence > persist && firstMove > fence, 'the allocation fence exists before the first move');
  assert.match(nativeStagingSource, /export function recoverNativeProfileFileRemoval\(/);
  assert.match(nativeStagingSource, /export async function commitNativeProfileFileRemoval\(/);
  assert.match(nativeStagingSource, /if \(quarantined\.exists\) quarantined\.delete\(\);/);
  assert.doesNotMatch(
    nativeStagingSource.slice(nativeStagingSource.indexOf('export async function commitNativeProfileFileRemoval')),
    /catch\s*\{\s*\}/,
  );
  assert.match(nativeStagingSource, /export async function rollbackNativeProfileFileRemoval\(/);
  assert.match(nativeStagingSource, /await quarantined\.move\(original\)/);
});

test('native removal fences are documents-persistent, atomically published, and lifecycle scoped', () => {
  assert.match(nativeFenceSource, /new File\(\s*Paths\.document,/);
  assert.match(nativeFenceSource, /candidate\.write\(serializeNativeProfileRemovalFence\(fence\)\)/);
  assert.match(nativeFenceSource, /candidate\.moveSync\(destination\)/);
  assert.match(nativeFenceSource, /assertNativeProfileRootAllocationAllowed/);
  assert.match(nativeStagingSource, /fenceDisposition === 'remove-after-purge'/);
  assert.match(nativeStagingSource, /removeNativeProfileRemovalFence\(manifestFence\(manifest\)\)/);
  assert.match(nativeStagingSource, /deleteRecreatedProfileRemovalSources\(manifest\)/);
  assert.match(nativeStagingSource, /recoverTemporaryNativeProfileFileRemovals/);
  assert.match(
    appContextSource,
    /recoverTemporaryNativeProfileFileRemovals\([\s\S]*folioRepository\.deleteProfileData\(profileId\)/,
  );
});

test('legacy profile roots require an unambiguous reversible ownership migration', () => {
  assert.match(nativeStagingSource, /export async function migrateLegacyNativeProfileRoots\(/);
  assert.match(nativeStagingSource, /assertLegacyProfileRootsClaimable\(/);
  assert.match(nativeStagingSource, /isRecoverableEmptyProfileRoot\(directory, nativeProfileRootStorage\)/);
  assert.match(nativeStagingSource, /legacyProfileRootDirectoryOwner\(directory, nativeProfileRootStorage\)/);
  assert.match(nativeStagingSource, /const markerCreated = !marker\.exists;/);
  assert.match(nativeStagingSource, /marker\.write\(serializeProfileDirectoryOwner\(exactProfileId\)\)/);
  assert.match(nativeStagingSource, /async rollback\(\)[\s\S]*marker\.delete\(\)/);
});

test('native profile-removal rollback distinguishes durable roots from purgeable cache roots', () => {
  assert.match(
    nativeStagingSource,
    /label === 'cache'[\s\S]*label === 'cache-legacy'[\s\S]*label === 'previews'[\s\S]*label === 'exports'/,
  );
  assert.match(
    nativeStagingSource,
    /!original\.exists && !removalSourceMayBeEvicted\(move\.label\)/,
  );
  assert.match(
    nativeStagingSource,
    /isRecoverableEmptyProfileRoot\(directory, nativeProfileRootStorage\)[\s\S]*candidate\.kind === 'canonical'/,
  );
});

test('mixed batches preserve valid siblings', async () => {
  const removed = [];
  const adapter = {
    async stage(candidate, stagedName) {
      return {
        uri: `private://${stagedName}`,
        name: stagedName,
        size: candidate.name === 'empty.pdf' ? 0 : 42,
        mimeType: candidate.mimeType,
      };
    },
    async remove(_profileId, uri) { removed.push(uri); },
  };
  const ids = ['job-a', 'job-b'];
  const result = await stageIntakeBatch([
    { uri: 'content://ok', name: 'good.pdf', mimeType: 'application/pdf' },
    { uri: 'content://bad', name: 'script.exe', mimeType: 'application/x-msdownload' },
    { uri: 'content://empty', name: 'empty.pdf', mimeType: 'application/pdf' },
  ], {
    adapter,
    profileId: 'profile-a',
    source: 'share',
    id: () => ids.shift(),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].profileId, 'profile-a');
  assert.equal(result.accepted[0].originalName, 'good.pdf');
  assert.equal(result.rejected.length, 2);
  assert.equal(removed.length, 1);
});

test('staging failures do not expose provider paths or platform-owned messages', async () => {
  const result = await stageIntakeBatch([
    { uri: 'content://private-provider/statement', name: 'statement.pdf', mimeType: 'application/pdf' },
  ], {
    profileId: 'profile-a',
    source: 'share',
    id: () => 'job-private-error',
    adapter: {
      async stage() {
        throw new Error('Permission denied at /private/provider/customer-123/statement.pdf');
      },
      async remove() {},
    },
  });

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0].error.message, /statement\.pdf/);
  assert.doesNotMatch(result.rejected[0].error.message, /customer-123|private\/provider|Permission denied/);
});

test('preserves the exact source filename while using only a sanitized private name', async () => {
  const originalName = '../Invoice\u202E: 2026?.pdf';
  const result = await stageIntakeBatch([
    { uri: 'content://invoice', name: originalName, mimeType: 'application/pdf', size: 42 },
  ], {
    profileId: 'profile-a',
    source: 'share',
    id: () => 'job-exact',
    adapter: {
      async stage(candidate, stagedName) {
        assert.equal(candidate.name, originalName);
        assert.equal(stagedName, 'job-exact-Invoice- 2026-.pdf');
        return { uri: 'private://invoice', name: stagedName, size: 42, mimeType: 'application/pdf' };
      },
      async remove() {},
    },
  });
  assert.equal(result.accepted[0].originalName, originalName);
  assert.equal(result.accepted[0].stagedName, 'job-exact-Invoice- 2026-.pdf');
  assert.equal(result.accepted[0].metadata.title.value, 'Invoice- 2026-');
});

test('plain-text shares are bounded before staging', () => {
  const valid = validateIntakeCandidate({
    uri: 'folio-shared-text://one',
    name: 'shared-text.txt',
    mimeType: 'text/plain',
    textContent: 'Hello from Android',
  });
  const overLimit = validateIntakeCandidate({
    uri: 'folio-shared-text://large',
    name: 'large.txt',
    mimeType: 'text/plain',
    textContent: 'x'.repeat(MAX_SHARED_TEXT_BYTES + 1),
  });
  assert.equal(valid, null);
  assert.equal(overLimit.code, 'unsupported-file');
});

test('staging retention is conservative for unresolved work', () => {
  const base = { localUri: 'private://file' };
  assert.equal(stagedFileRetention({ ...base, stage: 'queued' }), 'retain');
  assert.equal(stagedFileRetention({ ...base, stage: 'failed' }), 'retain');
  assert.equal(stagedFileRetention({ ...base, stage: 'ready' }), 'delete-after-retention');
  assert.equal(stagedFileRetention({ ...base, stage: 'canceled', cancellationDisposition: 'local' }), 'delete-now');
  assert.equal(stagedFileRetention({ ...base, stage: 'canceled', cancellationDisposition: 'acceptance-uncertain' }), 'retain');
  assert.equal(stagedFileRetention({ ...base, stage: 'canceled' }), 'retain');
});

test('cleanup planning selects canceled and expired completed staging copies only', () => {
  const base = {
    schemaVersion: 1,
    profileId: 'profile-a',
    kind: 'upload',
    source: 'share',
    progress: 1,
    retryCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
  const cleaned = tasksReadyForStagingCleanup([
      { ...base, id: 'ready-old', stage: 'ready', localUri: 'private://ready', completedAt: '2026-08-01T00:00:00.000Z' },
      { ...base, id: 'canceled', stage: 'canceled', localUri: 'private://canceled', cancellationDisposition: 'local' },
      { ...base, id: 'uncertain', stage: 'canceled', localUri: 'private://uncertain', cancellationDisposition: 'acceptance-uncertain' },
      { ...base, id: 'failed', stage: 'failed', localUri: 'private://failed' },
      { ...base, id: 'ready-new', stage: 'ready', localUri: 'private://new', completedAt: '2026-08-02T11:30:00.000Z' },
    ], new Date('2026-08-02T12:00:00.000Z'));

  assert.deepEqual(cleaned.map((task) => task.id), ['ready-old', 'canceled']);
});
