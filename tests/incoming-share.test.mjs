import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { incomingShareCandidates, incomingShareSignature } from '../src/lib/incoming-share.ts';
import { DEFAULT_MAX_INTAKE_BYTES, stageIntakeBatch } from '../src/lib/intake.ts';

test('incoming share handoff keeps every supported file payload, including intentional duplicates', () => {
  const file = {
    contentUri: 'content://provider/42',
    contentType: 'file',
    contentMimeType: 'application/pdf',
    originalName: '../invoice.pdf',
    contentSize: 42,
  };
  const result = incomingShareCandidates([
    file,
    file,
    { ...file, contentUri: null, contentType: 'text' },
    { ...file, contentUri: 'content://provider/43', contentType: 'image', contentMimeType: 'image/png' },
  ]);
  assert.equal(result.length, 3);
  assert.equal(result[0].name, '../invoice.pdf');
  assert.equal(result[1].uri, result[0].uri);
  assert.equal(result[2].mimeType, 'image/png');
  assert.equal(incomingShareSignature(result), incomingShareSignature([...result]));
});

test('incoming share handoff never silently truncates payloads delivered by the OS', () => {
  const payloads = Array.from({ length: 25 }, (_, index) => ({
    contentUri: `file://${index}.pdf`,
    contentType: 'file',
    contentMimeType: 'application/pdf',
    originalName: `${index}.pdf`,
    contentSize: index + 1,
  }));
  assert.equal(incomingShareCandidates(payloads).length, 25);
  assert.equal(incomingShareCandidates(payloads, 20).length, 20);
});

test('Android text/plain shares become independent staged text candidates without exposing text in signatures', () => {
  const secretText = 'Account note: 1234';
  const candidates = incomingShareCandidates([{
    contentUri: null,
    contentType: 'text',
    contentMimeType: null,
    mimeType: 'text/plain',
    shareType: 'text',
    value: secretText,
    originalName: null,
    contentSize: null,
  }]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, 'shared-text-1.txt');
  assert.equal(candidates[0].mimeType, 'text/plain');
  assert.equal(candidates[0].textContent, secretText);
  assert.equal(candidates[0].size, new TextEncoder().encode(secretText).byteLength);
  assert.equal(incomingShareSignature(candidates).includes(secretText), false);
});

test('URI-backed text/plain attachments remain files rather than treating their URI as text', () => {
  const [candidate] = incomingShareCandidates([{
    contentUri: 'file:///private/expo-sharing-1.shared',
    contentType: 'text',
    contentMimeType: 'text/plain',
    mimeType: 'text/plain',
    shareType: 'text',
    value: 'content://provider/note',
    originalName: 'note.txt',
    contentSize: 42,
  }]);
  assert.equal(candidate.uri, 'file:///private/expo-sharing-1.shared');
  assert.equal(candidate.name, 'note.txt');
  assert.equal(candidate.textContent, undefined);
});

test('mixed native failure payloads retain valid siblings and surface each rejected item', async () => {
  const candidates = incomingShareCandidates([{
    contentUri: 'file:///private/valid.pdf',
    contentType: 'file',
    contentMimeType: 'application/pdf',
    originalName: 'valid.pdf',
    contentSize: 42,
  }, {
    contentUri: 'folio-share-failure://oversized/one',
    contentType: 'file',
    contentMimeType: 'application/pdf',
    originalName: 'oversized.pdf',
    contentSize: DEFAULT_MAX_INTAKE_BYTES + 1,
  }, {
    contentUri: 'folio-share-failure://unreadable/two',
    contentType: 'file',
    contentMimeType: 'application/pdf',
    originalName: 'unreadable.pdf',
    contentSize: null,
  }, {
    contentUri: 'folio-share-failure://unsupported/three',
    contentType: 'audio',
    contentMimeType: 'audio/mpeg',
    originalName: 'unsupported.mp3',
    contentSize: 12,
  }]);

  assert.deepEqual(candidates.map((candidate) => candidate.name), [
    'valid.pdf',
    'oversized.pdf',
    'unreadable.pdf',
    'unsupported.mp3',
  ]);

  let nextId = 0;
  const result = await stageIntakeBatch(candidates, {
    profileId: 'profile-a',
    source: 'share',
    id: () => `mixed-${nextId++}`,
    adapter: {
      async stage(candidate, stagedName) {
        if (candidate.uri.startsWith('folio-share-failure://')) {
          throw new Error('untrusted provider detail');
        }
        return {
          uri: `file:///private/${stagedName}`,
          name: stagedName,
          size: 42,
          mimeType: 'application/pdf',
        };
      },
      async remove() {},
    },
  });

  assert.deepEqual(result.accepted.map((item) => item.originalName), ['valid.pdf']);
  assert.deepEqual(result.rejected.map((item) => item.candidate.name), [
    'oversized.pdf',
    'unreadable.pdf',
    'unsupported.mp3',
  ]);
  assert.match(result.rejected[0].error.message, /250/);
});

test('SDK 57 native share handoff allocates unique private files from untrusted names', () => {
  const patch = readFileSync(
    new URL('../patches/expo-sharing+57.0.8.patch', import.meta.url),
    'utf8',
  );
  assert.match(patch, /File\.createTempFile\([\s\S]{0,120}"expo-sharing-"[\s\S]{0,120}"\.shared"[\s\S]{0,120}incomingCacheDirectory\(context\)/);
  assert.match(patch, /containerURL\.appendingPathComponent\(UUID\(\)\.uuidString\)/);
  assert.match(patch, /ResolvingShareIntentDataParser\.clearResolvedFiles\(context\)/);
  assert.match(patch, /candidate\.path\.hasPrefix\(containerPath\)/);
  assert.match(patch, /\+\s+android\.util\.Log\.w\("ExpoSharing", "Unable to copy incoming shared content\."\)/);
  assert.match(patch, /\+\s+print\("Error copying a shared file"\)/);
});

test('SDK 57 native share copies are bounded before cache writes and retain provider failures', () => {
  const patch = readFileSync(
    new URL('../patches/expo-sharing+57.0.8.patch', import.meta.url),
    'utf8',
  );
  assert.match(patch, /MAX_INCOMING_SHARE_BYTES = 250L \* 1024L \* 1024L/);
  assert.match(
    patch,
    /if \(total > MAX_INCOMING_SHARE_BYTES - count\)[\s\S]{0,160}output\.write\(buffer, 0, count\)/,
  );
  assert.doesNotMatch(patch, /^\+.*input\.copyTo\(output\)/m);
  assert.match(patch, /file\.delete\(\)[\s\S]{0,100}copiedSize = MAX_INCOMING_SHARE_BYTES \+ 1/);

  assert.match(patch, /private let maxIncomingShareBytes = 250 \* 1024 \* 1024/);
  assert.match(patch, /provider\.loadInPlaceFileRepresentation\(forTypeIdentifier: identifier\)/);
  assert.match(
    patch,
    /if copied > maxBytes - chunk\.count[\s\S]{0,160}destination\.write\(contentsOf: chunk\)/,
  );
  assert.doesNotMatch(patch, /^\+.*saveDataToAppGroup/m);
  assert.match(patch, /results\.append\(await parseProvider\(provider\)\)/);
  assert.doesNotMatch(patch, /^\+.*if let payload = await parseProvider/m);
  assert.match(patch, /folio-share-failure:\/\/\\\(failure\.rawValue\)/);
  assert.doesNotMatch(patch, /sharing\.dataParsers\.ResolvingShareIntentDataParser/);
});

test('SDK 57 builds the patched expo-sharing native sources instead of precompiled artifacts', () => {
  const packageJson = JSON.parse(readFileSync(
    new URL('../package.json', import.meta.url),
    'utf8',
  ));
  assert.ok(packageJson.expo.autolinking.android.buildFromSource.includes('expo-sharing'));
  assert.ok(packageJson.expo.autolinking.ios.buildFromSource.includes('expo-sharing'));
});
