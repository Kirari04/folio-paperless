import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import {
  getPaperlessDocumentUrl,
  paperlessFileHeaders,
  PaperlessApiError,
} from '@/lib/paperless';
import { DocumentItem, PaperlessCredentials } from '@/types/document';

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

async function downloadToCache(
  credentials: PaperlessCredentials,
  document: DocumentItem,
  versionId?: number,
) {
  const remoteId = assertRemoteDocument(document);
  if (!FileSystem.cacheDirectory) throw new PaperlessApiError('No temporary storage is available.');
  const fileName = safeFileName(document);
  const destination = `${FileSystem.cacheDirectory}${encodeURIComponent(fileName)}`;
  const result = await FileSystem.downloadAsync(
    getPaperlessDocumentUrl(credentials, remoteId, 'download', versionId),
    destination,
    { headers: paperlessFileHeaders(credentials.token) },
  );
  if (result.status < 200 || result.status >= 300) {
    throw new PaperlessApiError(`The document download failed with status ${result.status}.`);
  }
  return { uri: result.uri, fileName };
}

async function downloadOnWeb(
  credentials: PaperlessCredentials,
  document: DocumentItem,
  versionId?: number,
) {
  const remoteId = assertRemoteDocument(document);
  const response = await fetch(getPaperlessDocumentUrl(credentials, remoteId, 'download', versionId), {
    headers: paperlessFileHeaders(credentials.token),
  });
  if (!response.ok) {
    throw new PaperlessApiError(`The document download failed with status ${response.status}.`);
  }
  const blob = await response.blob();
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
) {
  if (Platform.OS === 'web') {
    await downloadOnWeb(credentials, document, versionId);
    return 'Download started';
  }

  const available = await Sharing.isAvailableAsync();
  if (!available) throw new PaperlessApiError('File sharing is not available on this device.');
  const file = await downloadToCache(credentials, document, versionId);
  await Sharing.shareAsync(file.uri, {
    dialogTitle: `Share ${document.title}`,
    mimeType: document.mimeType || 'application/pdf',
  });
  return 'Share sheet opened';
}

export async function savePaperlessDocument(
  credentials: PaperlessCredentials,
  document: DocumentItem,
  versionId?: number,
) {
  if (Platform.OS === 'web') {
    await downloadOnWeb(credentials, document, versionId);
    return 'Download started';
  }

  const file = await downloadToCache(credentials, document, versionId);
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new PaperlessApiError('File export is not available on this device.');
  await Sharing.shareAsync(file.uri, {
    dialogTitle: `Save ${document.title}`,
    mimeType: document.mimeType || 'application/pdf',
  });
  return Platform.OS === 'ios'
    ? 'Choose “Save to Files” to finish'
    : 'Choose Files or a storage app to finish';
}
