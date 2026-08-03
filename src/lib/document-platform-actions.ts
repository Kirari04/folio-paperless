import * as Clipboard from 'expo-clipboard';
import { Directory, File, FileMode, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

import type { PaperlessAdvancedApi } from './paperless-advanced';
import {
  downloadPaperlessFileWithCredentials,
  normalizeServerUrl,
  paperlessCredentialFileHeaders,
  usesNativeMutualTls,
} from './paperless';
import {
  representationSupportsNativePrint,
  safeRepresentationFilename,
  selectRepresentation,
} from './document-production';
import { cleanupExpiredExportFiles } from './temporary-file-storage';
import { downloadFileWithinLimit } from './bounded-file-download';
import { MAX_DOCUMENT_DOWNLOAD_BYTES } from './download-policy';
import { translateRuntime } from '../i18n/runtime.ts';
import { assertProfileOfflineFileUri } from './offline-native-file-storage';
import { classifyPrintRejection } from './document-print-result.ts';
import { verifyDownloadedRepresentationFile } from './document-representation-file.ts';
import {
  RepresentationVerificationError,
  verifyRepresentationOrCleanup,
} from './document-representation-verification.ts';
import type { PaperlessCredentials } from '../types/document';
import type {
  PaperlessDocumentRepresentations,
  PaperlessRepresentation,
} from '../types/paperless-advanced';

export type DocumentPlatformActionStage =
  | 'download'
  | 'preparation'
  | 'canceled'
  | 'print'
  | 'share'
  | 'clipboard';

export class DocumentPlatformActionError extends Error {
  readonly stage: DocumentPlatformActionStage;

  constructor(stage: DocumentPlatformActionStage, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'DocumentPlatformActionError';
    this.stage = stage;
  }
}

export type PreparedRepresentationFile = {
  uri: string;
  filename: string;
  mimeType: string | null;
  representation: PaperlessRepresentation;
  byteSize: number;
  cleanup(delayMs?: number): void;
};

export function prepareExistingRepresentationFile(input: {
  byteSize: number;
  documentId: number;
  info: PaperlessDocumentRepresentations[PaperlessRepresentation];
  profileId: string;
  representation: PaperlessRepresentation;
  title: string;
  uri: string;
}): PreparedRepresentationFile {
  assertProfileOfflineFileUri(input.profileId, input.uri);
  const file = new File(input.uri);
  if (!file.exists || file.size <= 0) {
    throw new DocumentPlatformActionError(
      'preparation',
      translateRuntime('runtimeError.offlineFileUnavailable'),
    );
  }
  return {
    uri: file.uri,
    filename: safeRepresentationFilename(input.documentId, input.title, input.info),
    mimeType: input.info.mimeType,
    representation: input.representation,
    byteSize: file.size || input.byteSize,
    cleanup() {
      // Offline files are user-managed protected copies, not temporary exports.
    },
  };
}

function safeProfileDirectory(profileId: string) {
  const value = profileId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);
  if (!value) {
    throw new DocumentPlatformActionError(
      'preparation',
      translateRuntime('runtimeError.stableProfileId'),
    );
  }
  return value;
}

function isAbort(error: unknown, signal?: AbortSignal) {
  return signal?.aborted || (error instanceof Error && error.name === 'AbortError');
}

export async function prepareRepresentationFile(input: {
  api: PaperlessAdvancedApi;
  credentials: PaperlessCredentials;
  documentId: number;
  title: string;
  representations: PaperlessDocumentRepresentations;
  representation: PaperlessRepresentation;
  signal?: AbortSignal;
  onProgress?: (fraction: number | null) => void;
  versionId?: number;
}): Promise<PreparedRepresentationFile> {
  cleanupExpiredExportFiles();
  if (
    !input.credentials.profileId
    || input.credentials.profileId !== input.api.client.profileId
  ) {
    throw new DocumentPlatformActionError(
      'preparation',
      translateRuntime('runtimeError.profileChangedFileAction'),
    );
  }
  if (input.representations.documentId !== input.documentId) {
    throw new DocumentPlatformActionError(
      'preparation',
      translateRuntime('runtimeError.representationMetadataMismatch'),
    );
  }
  const choice = selectRepresentation(input.representations, input.representation);
  const path = input.api.representationDownloadPath(
    input.representations,
    input.representation,
    input.versionId,
  );
  if (!path.supported) {
    throw new DocumentPlatformActionError(
      'preparation',
      path.detail ?? translateRuntime('runtimeError.representationUnavailable'),
    );
  }
  const baseFilename = safeRepresentationFilename(input.documentId, input.title, choice.info);
  const filename = input.versionId ? `version-${input.versionId}-${baseFilename}` : baseFilename;
  const directory = new Directory(
    Paths.cache,
    'folio-exports',
    safeProfileDirectory(input.api.client.profileId),
    String(input.documentId),
  );
  directory.create({ idempotent: true, intermediates: true });
  const operationDirectory = new Directory(
    directory,
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  operationDirectory.create({ idempotent: false, intermediates: false });
  const destination = new File(operationDirectory, filename);

  let file: File;
  try {
    const requestUrl = `${normalizeServerUrl(input.credentials.serverUrl)}${path.value}`;
    if (usesNativeMutualTls(input.credentials)) {
      const response = await downloadPaperlessFileWithCredentials(
        input.credentials,
        requestUrl,
        destination.uri,
        {
          signal: input.signal,
          onProgress: input.onProgress,
          maxBytes: MAX_DOCUMENT_DOWNLOAD_BYTES,
        },
      );
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Paperless returned HTTP ${response.status}.`);
      }
      file = new File(destination.uri);
    } else {
      file = await downloadFileWithinLimit({
        url: requestUrl,
        destination,
        headers: paperlessCredentialFileHeaders(input.credentials),
        signal: input.signal,
        maxBytes: MAX_DOCUMENT_DOWNLOAD_BYTES,
        onProgress: input.onProgress,
      });
    }
  } catch (error) {
    if (destination.exists) destination.delete();
    if (operationDirectory.exists) operationDirectory.delete();
    throw new DocumentPlatformActionError(
      isAbort(error, input.signal) ? 'canceled' : 'download',
      isAbort(error, input.signal)
        ? translateRuntime('runtimeError.downloadCanceled')
        : translateRuntime('runtimeError.representationDownload'),
      error,
    );
  }
  if (!file.exists || file.size <= 0) {
    if (file.exists) file.delete();
    if (operationDirectory.exists) operationDirectory.delete();
    throw new DocumentPlatformActionError(
      'preparation',
      translateRuntime('runtimeError.emptyFile'),
    );
  }
  try {
    await verifyRepresentationOrCleanup(
      () => verifyDownloadedRepresentationFile({
        checksum: choice.info.checksum,
        file,
        representation: input.representation,
        signal: input.signal,
        size: choice.info.size,
      }),
      () => {
        if (file.exists) file.delete();
        if (operationDirectory.exists) operationDirectory.delete();
      },
    );
  } catch (error) {
    throw new DocumentPlatformActionError(
      'preparation',
      translateRuntime(
        error instanceof RepresentationVerificationError
          && error.code === 'metadata-unverifiable'
          ? 'runtimeError.representationVerificationUnavailable'
          : 'runtimeError.representationVerificationFailed',
      ),
      error,
    );
  }

  return {
    uri: file.uri,
    filename,
    mimeType: choice.info.mimeType,
    representation: input.representation,
    byteSize: file.size,
    cleanup(delayMs = 0) {
      const remove = () => {
        if (file.exists) file.delete();
        if (operationDirectory.exists) operationDirectory.delete();
      };
      if (delayMs > 0) setTimeout(remove, delayMs);
      else remove();
    },
  };
}

function assertPdf(file: PreparedRepresentationFile) {
  if (!representationSupportsNativePrint(file, Platform.OS)) {
    throw new DocumentPlatformActionError(
      'preparation',
      translateRuntime(
        file.representation === 'archive'
          ? 'runtimeError.archiveNotPdf'
          : 'runtimeError.originalNotPdf',
      ),
    );
  }
  const nativeFile = new File(file.uri);
  const handle = nativeFile.open(FileMode.ReadOnly);
  try {
    const signature = new TextDecoder().decode(handle.readBytes(5));
    if (signature !== '%PDF-') {
      throw new DocumentPlatformActionError(
        'preparation',
        translateRuntime('runtimeError.invalidPdf'),
      );
    }
  } finally {
    handle.close();
  }
}

export async function printPreparedRepresentation(file: PreparedRepresentationFile) {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') {
    throw new DocumentPlatformActionError(
      'preparation',
      translateRuntime('runtimeError.printFailed'),
    );
  }
  assertPdf(file);
  try {
    await Print.printAsync({ uri: file.uri });
    return {
      // Expo's Android promise resolves when the dialog opens, before its adapter
      // necessarily reads the URI. Keep that one-time cache file alive briefly.
      cleanupDelayMs: Platform.OS === 'android' ? 30 * 60 * 1000 : 0,
    };
  } catch (error) {
    const stage = classifyPrintRejection(
      error,
      Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web',
    );
    throw new DocumentPlatformActionError(
      stage,
      translateRuntime(
        stage === 'canceled' ? 'runtimeError.printCanceled' : 'runtimeError.printFailed',
      ),
      error,
    );
  }
}

export async function sharePreparedRepresentation(file: PreparedRepresentationFile) {
  if (!(await Sharing.isAvailableAsync())) {
    throw new DocumentPlatformActionError(
      'share',
      translateRuntime('runtimeError.shareUnavailable'),
    );
  }
  try {
    await Sharing.shareAsync(file.uri, {
      dialogTitle: translateRuntime('fileActions.shareDialogTitle', { filename: file.filename }),
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    });
  } catch (error) {
    throw new DocumentPlatformActionError(
      'share',
      translateRuntime('runtimeError.shareSheet'),
      error,
    );
  }
}

export async function copyPublicShareUrl(url: string) {
  try {
    const copied = await Clipboard.setStringAsync(url);
    if (!copied) throw new Error('Clipboard rejected the value.');
  } catch (error) {
    throw new DocumentPlatformActionError(
      'clipboard',
      translateRuntime('runtimeError.publicLinkCopy'),
      error,
    );
  }
}
