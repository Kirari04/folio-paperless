import { File, FileMode } from 'expo-file-system';

import type { PaperlessRepresentation } from '../types/paperless-advanced.ts';
import {
  verifyRepresentationDescriptor,
} from './document-representation-verification.ts';
import { Sha256 } from './sha256.ts';

const HASH_CHUNK_BYTES = 64 * 1024;

export async function verifyDownloadedRepresentationFile(input: {
  checksum: unknown;
  file: File;
  representation: PaperlessRepresentation;
  signal?: AbortSignal;
  size: number | null;
}) {
  const digest = new Sha256();
  const handle = input.file.open(FileMode.ReadOnly);
  try {
    let remaining = input.file.size;
    let chunks = 0;
    while (remaining > 0) {
      if (input.signal?.aborted) {
        const error = new Error('Representation verification was canceled.');
        error.name = 'AbortError';
        throw error;
      }
      const bytes = handle.readBytes(Math.min(HASH_CHUNK_BYTES, remaining));
      if (bytes.byteLength === 0) throw new Error('The downloaded file could not be read completely.');
      digest.update(bytes);
      remaining -= bytes.byteLength;
      chunks += 1;
      if (chunks % 64 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  } finally {
    handle.close();
  }
  verifyRepresentationDescriptor({
    actualChecksum: digest.digestHex(),
    actualSize: input.file.size,
    expectedChecksum: input.checksum,
    expectedSize: input.size,
    representation: input.representation,
  });
  return input.file;
}
