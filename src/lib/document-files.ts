import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import {
  getPaperlessDocumentUrl,
  downloadPaperlessFileWithCredentials,
  paperlessCredentialFileHeaders,
  PaperlessApiError,
  usesNativeMutualTls,
} from '@/lib/paperless';
import { DocumentItem, PaperlessCredentials } from '@/types/document';
import { downloadFileWithinLimit } from '@/lib/bounded-file-download';
import { MAX_DOCUMENT_DOWNLOAD_BYTES, responseBlobWithinLimit } from '@/lib/download-policy';
import { ensureOwnedProfileRoot, profileDirectoryName } from '@/lib/profile-file-path-policy';
import {
  assertNativeProfileRootAllocationAllowed,
  nativeProfileRootStorage,
} from '@/lib/native-profile-root-storage';
import { translateRuntime } from '@/i18n/runtime';

const mimeExtensions: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/tiff': 'tiff',
  'text/plain': 'txt',
};

function safeFileName(document: DocumentItem) {
  const originalExtension = document.originalFileName?.match(/\.([a-z0-9]{1,8})$/i)?.[1];
  const extension = originalExtension || mimeExtensions[document.mimeType || ''] || 'pdf';
  const base = document.title
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 100) || `document-${document.remoteId}`;
  return `${base}.${extension}`;
}

function assertRemoteDocument(document: DocumentItem) {
  if (!document.remoteId) {
    throw new PaperlessApiError('Sample and local documents do not have a file to download.');
  }
  return document.remoteId;
}

function safeProfileSegment(credentials: PaperlessCredentials) {
  try {
    return profileDirectoryName(credentials.profileId ?? '');
  } catch {
    throw new PaperlessApiError('A stable connection profile is required for this export.');
  }
}

type DocumentExportOptions = {
  isProfileCurrent?: () => boolean;
};

function assertProfileCurrent(options?: DocumentExportOptions) {
  if (options?.isProfileCurrent && !options.isProfileCurrent()) {
    throw new PaperlessApiError('The connection profile changed before the export completed.');
  }
}

async function downloadToCache(
  credentials: PaperlessCredentials,
  document: DocumentItem,
  versionId?: number,
) {
  const remoteId = assertRemoteDocument(document);
  const fileName = safeFileName(document);
  const operationDirectory = new Directory(
    ensureOwnedProfileRoot(
      Paths.cache,
      safeProfileSegment(credentials),
      nativeProfileRootStorage,
    ),
    'exports',
    String(remoteId),
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  operationDirectory.create({ idempotent: false, intermediates: true });
  const destination = new File(operationDirectory, fileName);
  const requestUrl = getPaperlessDocumentUrl(credentials, remoteId, 'download', versionId);
  let result: { status: number };
  let downloadedUri = destination.uri;
  if (usesNativeMutualTls(credentials)) {
    result = await downloadPaperlessFileWithCredentials(credentials, requestUrl, destination.uri);
  } else {
    const download = await downloadFileWithinLimit({
      url: requestUrl,
      destination,
      headers: paperlessCredentialFileHeaders(credentials),
      maxBytes: MAX_DOCUMENT_DOWNLOAD_BYTES,
    });
    result = { status: 200 };
    downloadedUri = download.uri;
  }
  if (result.status < 200 || result.status >= 300) {
    if (destination.exists) destination.delete();
    throw new PaperlessApiError(`The document download failed with status ${result.status}.`);
  }
  if (!destination.exists || destination.size <= 0 || destination.size > MAX_DOCUMENT_DOWNLOAD_BYTES) {
    if (destination.exists) destination.delete();
    throw new PaperlessApiError('The document download is empty or exceeds Folio\'s safety limit.');
  }
  try {
    assertNativeProfileRootAllocationAllowed(safeProfileSegment(credentials));
  } catch {
    if (destination.exists) destination.delete();
    if (operationDirectory.exists) operationDirectory.delete();
    throw new PaperlessApiError('The connection profile was removed before the export completed.');
  }
  return {
    uri: downloadedUri,
    fileName,
    cleanup(delayMs = 0) {
      const remove = () => {
        if (destination.exists) destination.delete();
        if (operationDirectory.exists) operationDirectory.delete();
      };
      if (delayMs > 0) setTimeout(remove, delayMs);
      else remove();
    },
  };
}

async function downloadOnWeb(
  credentials: PaperlessCredentials,
  document: DocumentItem,
  versionId?: number,
  options?: DocumentExportOptions,
) {
  if (usesNativeMutualTls(credentials)) {
    throw new PaperlessApiError(
      'Mutual-TLS downloads are unavailable in browser builds; no credential-blind fallback was used.',
    );
  }
  const remoteId = assertRemoteDocument(document);
  const response = await fetch(getPaperlessDocumentUrl(credentials, remoteId, 'download', versionId), {
    headers: paperlessCredentialFileHeaders(credentials),
    redirect: 'manual',
  });
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new PaperlessApiError('Paperless redirected the authenticated download; Folio did not forward credentials.');
  }
  if (!response.ok) {
    throw new PaperlessApiError(`The document download failed with status ${response.status}.`);
  }
  const blob = await responseBlobWithinLimit(response, MAX_DOCUMENT_DOWNLOAD_BYTES);
  assertProfileCurrent(options);
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = safeFileName(document);
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function sharePaperlessDocument(
  credentials: PaperlessCredentials,
  document: DocumentItem,
  versionId?: number,
  options?: DocumentExportOptions,
) {
  if (Platform.OS === 'web') {
    await downloadOnWeb(credentials, document, versionId, options);
    return 'Download started';
  }

  const available = await Sharing.isAvailableAsync();
  if (!available) throw new PaperlessApiError('File sharing is not available on this device.');
  const file = await downloadToCache(credentials, document, versionId);
  try {
    assertProfileCurrent(options);
    await Sharing.shareAsync(file.uri, {
      dialogTitle: translateRuntime('fileActions.shareDialogTitle', { filename: document.title }),
      mimeType: document.mimeType || 'application/pdf',
    });
  } finally {
    file.cleanup(Platform.OS === 'android' ? 30 * 60 * 1000 : 0);
  }
  return 'Share sheet opened';
}

export async function savePaperlessDocument(
  credentials: PaperlessCredentials,
  document: DocumentItem,
  versionId?: number,
  options?: DocumentExportOptions,
) {
  if (Platform.OS === 'web') {
    await downloadOnWeb(credentials, document, versionId, options);
    return 'Download started';
  }

  const file = await downloadToCache(credentials, document, versionId);
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new PaperlessApiError('File export is not available on this device.');
  try {
    assertProfileCurrent(options);
    await Sharing.shareAsync(file.uri, {
      dialogTitle: translateRuntime('fileActions.saveDialogTitle', { filename: document.title }),
      mimeType: document.mimeType || 'application/pdf',
    });
  } finally {
    file.cleanup(Platform.OS === 'android' ? 30 * 60 * 1000 : 0);
  }
  return Platform.OS === 'ios'
    ? 'Choose “Save to Files” to finish'
    : 'Choose Files or a storage app to finish';
}
