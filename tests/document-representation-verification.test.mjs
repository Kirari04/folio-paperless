import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { classifyPrintRejection } from '../src/lib/document-print-result.ts';
import {
  RepresentationVerificationError,
  verifyRepresentationDescriptor,
  verifyRepresentationOrCleanup,
} from '../src/lib/document-representation-verification.ts';
import { Sha256, sha256HexChunks } from '../src/lib/sha256.ts';

test('incremental SHA-256 matches the platform digest across chunk boundaries', () => {
  const value = new TextEncoder().encode('archive bytes '.repeat(20_000));
  const expected = createHash('sha256').update(value).digest('hex');
  const digest = new Sha256();
  for (let offset = 0; offset < value.length; offset += 997) {
    digest.update(value.subarray(offset, offset + 997));
  }
  assert.equal(digest.digestHex(), expected);
  assert.equal(sha256HexChunks([]), createHash('sha256').digest('hex'));
});

test('an absent-archive fallback cannot pass archive identity verification', () => {
  const archive = new TextEncoder().encode('%PDF-archive');
  const original = new TextEncoder().encode('%PDF-original');
  const archiveChecksum = createHash('sha256').update(archive).digest('hex');
  const originalChecksum = createHash('sha256').update(original).digest('hex');

  assert.throws(
    () => verifyRepresentationDescriptor({
      actualChecksum: originalChecksum,
      actualSize: original.length,
      expectedChecksum: archiveChecksum,
      expectedSize: archive.length,
      representation: 'archive',
    }),
    (error) => error instanceof RepresentationVerificationError
      && ['size-mismatch', 'checksum-mismatch'].includes(error.code),
  );
  assert.throws(
    () => verifyRepresentationDescriptor({
      actualChecksum: archiveChecksum,
      actualSize: archive.length,
      expectedChecksum: null,
      expectedSize: archive.length,
      representation: 'archive',
    }),
    (error) => error instanceof RepresentationVerificationError
      && error.code === 'metadata-unverifiable',
  );
});

test('checksum mismatch invokes cleanup before the failure escapes', async () => {
  let cleaned = false;
  await assert.rejects(
    verifyRepresentationOrCleanup(
      () => verifyRepresentationDescriptor({
        actualChecksum: 'a'.repeat(64),
        actualSize: 12,
        expectedChecksum: 'b'.repeat(64),
        expectedSize: 12,
        representation: 'archive',
      }),
      () => { cleaned = true; },
    ),
    (error) => error instanceof RepresentationVerificationError
      && error.code === 'checksum-mismatch',
  );
  assert.equal(cleaned, true);
});

test('print rejection classification distinguishes supported iOS cancellation only', () => {
  assert.equal(classifyPrintRejection({ code: 'ERR_PRINT_INCOMPLETE' }, 'ios'), 'canceled');
  assert.equal(classifyPrintRejection({ code: 'ERR_PRINTING_JOB_FAILED' }, 'ios'), 'print');
  assert.equal(classifyPrintRejection({ code: 'ERR_PRINT_INCOMPLETE' }, 'android'), 'print');
  assert.equal(classifyPrintRejection(new Error('Printing did not complete'), 'ios'), 'print');
});
