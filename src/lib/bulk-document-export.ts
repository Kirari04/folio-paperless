import { Platform } from 'react-native';

import { prepareRepresentationFile, sharePreparedRepresentation } from './document-platform-actions';
import { safeRepresentationFilename } from './document-production';
import {
  normalizeServerUrl,
  paperlessCredentialFileHeaders,
  usesNativeMutualTls,
} from './paperless';
import type { PaperlessAdvancedApi } from './paperless-advanced';
import type { DocumentItem, PaperlessCredentials } from '../types/document';
import type {
  PaperlessBulkSkippedItem,
  PaperlessOperationFailure,
  PaperlessRepresentation,
} from '../types/paperless-advanced';
import { MAX_DOCUMENT_DOWNLOAD_BYTES, responseBlobWithinLimit } from './download-policy';

export type PaperlessBulkExportResult = {
  representation: PaperlessRepresentation;
  succeeded: number[];
  failed: PaperlessOperationFailure[];
  skipped: PaperlessBulkSkippedItem[];
};

function skipped(document: DocumentItem): PaperlessBulkSkippedItem | null {
  if (!document.remoteId) return { localId: document.id, remoteId: null, reason: 'not-remote' };
  if (document.status === 'processing' || document.taskId) {
    return { localId: document.id, remoteId: document.remoteId, reason: 'processing' };
  }
  return null;
}

async function downloadOnWeb(input: {
  credentials: PaperlessCredentials;
  filename: string;
  path: string;
  signal?: AbortSignal;
  executionGuard?: () => boolean;
}) {
  if (usesNativeMutualTls(input.credentials)) {
    throw new Error('Mutual-TLS export is unavailable in browser builds; no token-only fallback was used.');
  }
  const response = await fetch(`${normalizeServerUrl(input.credentials.serverUrl)}${input.path}`, {
    headers: paperlessCredentialFileHeaders(input.credentials),
    redirect: 'manual',
    signal: input.signal,
  });
  if (!response.ok) throw new Error(`Paperless returned HTTP ${response.status}.`);
  if (input.executionGuard?.() === false) throw new Error('The connection profile changed during export.');
  const blob = await responseBlobWithinLimit(response, MAX_DOCUMENT_DOWNLOAD_BYTES);
  const url = URL.createObjectURL(blob);
  try {
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = input.filename;
    anchor.rel = 'noopener';
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

export async function exportSelectedDocuments(input: {
  api: PaperlessAdvancedApi;
  credentials: PaperlessCredentials;
  expectedProfileId: string;
  executionGuard?: () => boolean;
  documents: readonly DocumentItem[];
  selectedIds: ReadonlySet<string>;
  representation: PaperlessRepresentation;
  signal?: AbortSignal;
}): Promise<PaperlessBulkExportResult> {
  if (
    input.api.client.profileId !== input.expectedProfileId
    || input.credentials.profileId !== input.expectedProfileId
    || input.executionGuard?.() === false
  ) throw new Error('The export inputs do not belong to the active connection profile.');
  const result: PaperlessBulkExportResult = {
    representation: input.representation,
    succeeded: [],
    failed: [],
    skipped: [],
  };
  const byId = new Map(input.documents.map((document) => [document.id, document]));
  const seenRemoteIds = new Set<number>();
  for (const localId of input.selectedIds) {
    if (input.signal?.aborted) break;
    const document = byId.get(localId);
    if (!document) {
      result.skipped.push({ localId, remoteId: null, reason: 'not-remote' });
      continue;
    }
    const skip = skipped(document);
    if (skip) {
      result.skipped.push(skip);
      continue;
    }
    const remoteId = document.remoteId!;
    if (seenRemoteIds.has(remoteId)) {
      result.skipped.push({ localId, remoteId, reason: 'duplicate-selection' });
      continue;
    }
    seenRemoteIds.add(remoteId);
    try {
      if (input.executionGuard?.() === false) throw new Error('The connection profile changed during export.');
      const representations = await input.api.getRepresentations(remoteId, input.signal);
      if (!representations.supported) throw new Error(representations.detail ?? 'Document metadata is unavailable.');
      const info = representations.value[input.representation];
      const path = input.api.representationDownloadPath(representations.value, input.representation);
      if (!path.supported) throw new Error(path.detail ?? 'This representation is unavailable.');
      if (Platform.OS === 'web') {
        await downloadOnWeb({
          credentials: input.credentials,
          filename: safeRepresentationFilename(remoteId, document.title, info),
          path: path.value,
          signal: input.signal,
          executionGuard: input.executionGuard,
        });
      } else {
        const file = await prepareRepresentationFile({
          api: input.api,
          credentials: input.credentials,
          documentId: remoteId,
          title: document.title,
          representations: representations.value,
          representation: input.representation,
          signal: input.signal,
        });
        try {
          if (input.executionGuard?.() === false) throw new Error('The connection profile changed during export.');
          await sharePreparedRepresentation(file);
        } finally {
          file.cleanup();
        }
      }
      result.succeeded.push(remoteId);
    } catch (error) {
      result.failed.push({
        localId,
        remoteId,
        status: null,
        code: error instanceof Error && error.name === 'AbortError' ? 'canceled' : 'export-failed',
        message: error instanceof Error ? error.message : 'The file could not be exported.',
        retryable: !input.signal?.aborted,
      });
    }
  }
  return result;
}
