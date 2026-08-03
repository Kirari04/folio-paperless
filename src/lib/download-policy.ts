export const MAX_DOCUMENT_DOWNLOAD_BYTES = 512 * 1024 * 1024;
export const MAX_PDF_PREVIEW_BYTES = 256 * 1024 * 1024;
export const MAX_THUMBNAIL_DOWNLOAD_BYTES = 32 * 1024 * 1024;
export const DOWNLOAD_STORAGE_RESERVE_BYTES = 64 * 1024 * 1024;
export const PDF_HEADER_SCAN_BYTES = 1_024;

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

export class DownloadSafetyError extends Error {
  readonly code: 'invalid-limit' | 'storage-pressure' | 'file-too-large' | 'invalid-pdf';

  constructor(
    code: DownloadSafetyError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'DownloadSafetyError';
    this.code = code;
  }
}

export function effectiveDownloadLimit(input: {
  maxBytes: number;
  availableBytes: number | null;
  reserveBytes?: number;
}) {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) {
    throw new DownloadSafetyError('invalid-limit', 'The file download limit is invalid.');
  }
  const reserveBytes = input.reserveBytes ?? DOWNLOAD_STORAGE_RESERVE_BYTES;
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0) {
    throw new DownloadSafetyError('invalid-limit', 'The storage reserve is invalid.');
  }
  if (input.availableBytes === null || !Number.isFinite(input.availableBytes)) {
    return input.maxBytes;
  }
  const diskBudget = Math.floor(input.availableBytes) - reserveBytes;
  if (diskBudget < 1) {
    throw new DownloadSafetyError(
      'storage-pressure',
      'The file cannot be downloaded while device storage is low.',
    );
  }
  return Math.min(input.maxBytes, diskBudget);
}

export function assertDownloadProgressWithinLimit(
  bytesWritten: number,
  totalBytes: number,
  limitBytes: number,
) {
  if (
    !Number.isFinite(bytesWritten)
    || bytesWritten < 0
    || bytesWritten > limitBytes
    || (totalBytes > 0 && totalBytes > limitBytes)
  ) {
    throw new DownloadSafetyError(
      'file-too-large',
      'The file exceeds Folio\'s per-file safety limit.',
    );
  }
}

export function assertCompletedFileSize(size: number, limitBytes: number) {
  if (!Number.isFinite(size) || size <= 0 || size > limitBytes) {
    throw new DownloadSafetyError(
      'file-too-large',
      'The downloaded file is empty or exceeds Folio\'s per-file safety limit.',
    );
  }
}

/** Buffers a web response only within an explicit byte budget. */
export async function responseBlobWithinLimit(response: Response, limitBytes: number) {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) {
    throw new DownloadSafetyError('invalid-limit', 'The response size limit is invalid.');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limitBytes) {
    throw new DownloadSafetyError('file-too-large', 'The file exceeds Folio\'s per-file safety limit.');
  }
  if (!response.body) {
    throw new DownloadSafetyError('file-too-large', 'The file response did not contain a bounded stream.');
  }
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel();
        throw new DownloadSafetyError('file-too-large', 'The file exceeds Folio\'s per-file safety limit.');
      }
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      chunks.push(copy.buffer);
    }
  } finally {
    reader.releaseLock();
  }
  assertCompletedFileSize(total, limitBytes);
  return new Blob(chunks, {
    type: response.headers.get('content-type') ?? 'application/octet-stream',
  });
}

export function hasPdfHeader(bytes: Uint8Array) {
  const scanLength = Math.min(bytes.length, PDF_HEADER_SCAN_BYTES);
  for (let offset = 0; offset <= scanLength - PDF_SIGNATURE.length; offset += 1) {
    if (PDF_SIGNATURE.every((byte, index) => bytes[offset + index] === byte)) return true;
  }
  return false;
}

export function assertPdfPreviewDescriptor(input: {
  size: number;
  headerBytes: Uint8Array;
  maxBytes?: number;
}) {
  assertCompletedFileSize(input.size, input.maxBytes ?? MAX_PDF_PREVIEW_BYTES);
  if (!hasPdfHeader(input.headerBytes)) {
    throw new DownloadSafetyError('invalid-pdf', 'Paperless returned a malformed PDF preview.');
  }
}
