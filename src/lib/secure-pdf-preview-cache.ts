import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';

import {
  assertPaperlessResourceUrl,
  downloadPaperlessFileWithCredentials,
  paperlessCredentialFileHeaders,
  usesNativeMutualTls,
} from './paperless';
import type { PaperlessCredentials } from '../types/document';
import { assertSafePdfFile, downloadFileWithinLimit } from './bounded-file-download.ts';
import { MAX_PDF_PREVIEW_BYTES } from './download-policy.ts';
import { ensureOwnedProfileRoot, profileDirectoryName } from './profile-file-path-policy.ts';
import {
  assertNativeProfileRootAllocationAllowed,
  nativeProfileRootStorage,
} from './native-profile-root-storage.ts';

const EDITOR_CACHE_TTL_MS = 30 * 60 * 1000;

export type SecurePdfCacheRequest = {
  credentials: PaperlessCredentials;
  documentId: number;
  uri: string;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
};

export type SecurePdfCacheLease = {
  uri: string;
  dispose: () => void;
};

/**
 * Downloads one authenticated PDF into app-private cache storage. The opaque
 * filename is profile-scoped, and renderers receive only the local URI — never
 * credentials. Every lease is short-lived and deletes its file on release.
 */
export async function prepareSecurePdfPreview(
  request: SecurePdfCacheRequest,
): Promise<SecurePdfCacheLease> {
  let profileId: string;
  try {
    profileId = profileDirectoryName(request.credentials.profileId ?? '');
  } catch {
    throw new Error('A stable connection profile is required for PDF previews.');
  }
  if (!Number.isSafeInteger(request.documentId) || request.documentId < 1) {
    throw new Error('A valid Paperless document is required for PDF previews.');
  }
  const sourceUrl = assertPaperlessResourceUrl(request.credentials.serverUrl, request.uri);

  const digest = await digestStringAsync(
    CryptoDigestAlgorithm.SHA256,
    `${profileId}\n${request.credentials.serverUrl}\n${request.documentId}\n${sourceUrl}`,
  );
  const editorDirectory = new Directory(
    ensureOwnedProfileRoot(Paths.cache, profileId, nativeProfileRootStorage),
    'pdf-editor',
  );
  editorDirectory.create({ idempotent: true, intermediates: true });
  const destination = new File(editorDirectory, `${digest.slice(0, 40)}.pdf`);
  const cacheAge = destination.lastModified
    ? Date.now() - destination.lastModified
    : Number.POSITIVE_INFINITY;

  if (destination.exists && cacheAge <= EDITOR_CACHE_TTL_MS) {
    try {
      assertSafePdfFile(destination, MAX_PDF_PREVIEW_BYTES);
      assertNativeProfileRootAllocationAllowed(profileId);
      return {
        uri: destination.uri,
        dispose: () => {
          if (destination.exists) destination.delete();
        },
      };
    } catch {
      if (destination.exists) destination.delete();
    }
  }

  const temporary = new File(
    editorDirectory,
    `transfer-${digest.slice(0, 20)}-${Date.now().toString(36)}.pdf`,
  );
  try {
    let downloaded: File;
    if (usesNativeMutualTls(request.credentials)) {
      const response = await downloadPaperlessFileWithCredentials(
        request.credentials,
        sourceUrl,
        temporary.uri,
        {
          signal: request.signal,
          maxBytes: MAX_PDF_PREVIEW_BYTES,
          onProgress: (progress) => {
            if (progress !== null) request.onProgress?.(progress);
          },
        },
      );
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Paperless returned HTTP ${response.status}.`);
      }
      downloaded = assertSafePdfFile(new File(temporary.uri), MAX_PDF_PREVIEW_BYTES);
    } else {
      downloaded = await downloadFileWithinLimit({
        url: sourceUrl,
        destination: temporary,
        headers: paperlessCredentialFileHeaders(request.credentials),
        signal: request.signal,
        maxBytes: MAX_PDF_PREVIEW_BYTES,
        onProgress: (progress) => {
          if (progress !== null) request.onProgress?.(progress);
        },
      });
    }
    assertSafePdfFile(downloaded, MAX_PDF_PREVIEW_BYTES);
    if (destination.exists) destination.delete();
    await downloaded.move(destination);
    assertNativeProfileRootAllocationAllowed(profileId);
    return {
      uri: destination.uri,
      dispose: () => {
        if (destination.exists) destination.delete();
      },
    };
  } catch (error) {
    if (temporary.exists) temporary.delete();
    if (destination.exists) destination.delete();
    if (editorDirectory.exists && editorDirectory.list().length === 0) editorDirectory.delete();
    throw error;
  }
}
