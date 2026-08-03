import { fetch as expoFetch } from 'expo/fetch';
import { File, FileMode, Paths } from 'expo-file-system';

import {
  assertCompletedFileSize,
  assertDownloadProgressWithinLimit,
  DOWNLOAD_STORAGE_RESERVE_BYTES,
  DownloadSafetyError,
  effectiveDownloadLimit,
  MAX_DOCUMENT_DOWNLOAD_BYTES,
  PDF_HEADER_SCAN_BYTES,
  assertPdfPreviewDescriptor,
} from './download-policy.ts';

export async function downloadFileWithinLimit(input: {
  url: string;
  destination: File;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  maxBytes?: number;
  reserveBytes?: number;
  onProgress?: (fraction: number | null) => void;
  /** Authenticated downloads must remain manual; verified public artifacts may opt into follow. */
  redirect?: 'manual' | 'follow';
}) {
  const limitBytes = effectiveDownloadLimit({
    maxBytes: input.maxBytes ?? MAX_DOCUMENT_DOWNLOAD_BYTES,
    availableBytes: Paths.availableDiskSpace,
    reserveBytes: input.reserveBytes ?? DOWNLOAD_STORAGE_RESERVE_BYTES,
  });
  if (input.destination.exists) input.destination.delete();
  let handle: ReturnType<File['open']> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const response = await expoFetch(input.url, {
      headers: input.headers,
      signal: input.signal,
      redirect: input.redirect ?? 'manual',
    });
    if (String(response.type) === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new Error('The authenticated file download was redirected and was not followed.');
    }
    if (!response.ok) throw new Error(`The file download failed with HTTP ${response.status}.`);
    const declared = Number(response.headers.get('content-length'));
    assertDownloadProgressWithinLimit(0, Number.isFinite(declared) ? declared : -1, limitBytes);
    if (!response.body) throw new Error('The file response did not contain a readable stream.');
    input.destination.create({ overwrite: true, intermediates: true });
    handle = input.destination.open(FileMode.Truncate);
    reader = response.body.getReader();
    let written = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      assertDownloadProgressWithinLimit(
        written + value.byteLength,
        Number.isFinite(declared) ? declared : -1,
        limitBytes,
      );
      handle.writeBytes(value);
      written += value.byteLength;
      input.onProgress?.(declared > 0 ? Math.min(1, written / declared) : null);
    }
    handle.close();
    handle = null;
    assertCompletedFileSize(input.destination.size, limitBytes);
    input.onProgress?.(1);
    return input.destination;
  } catch (error) {
    if (input.destination.exists) input.destination.delete();
    throw error;
  } finally {
    if (reader) {
      try { reader.releaseLock(); } catch { /* The stream may already have released its reader. */ }
    }
    handle?.close();
  }
}

export function assertSafePdfFile(file: File, maxBytes?: number) {
  if (!file.exists) {
    throw new DownloadSafetyError('invalid-pdf', 'The PDF preview file is unavailable.');
  }
  const handle = file.open(FileMode.ReadOnly);
  try {
    assertPdfPreviewDescriptor({
      size: file.size,
      headerBytes: handle.readBytes(Math.min(PDF_HEADER_SCAN_BYTES, file.size)),
      ...(maxBytes === undefined ? {} : { maxBytes }),
    });
  } finally {
    handle.close();
  }
  return file;
}
