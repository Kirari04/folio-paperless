import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { createThemedStyleSheet } from '@/constants/theme';
import { translateRuntime } from '@/i18n/runtime';
import {
  documentThumbnailCacheFileName,
  documentThumbnailCacheSeed,
  documentThumbnailImageCacheKey,
  documentThumbnailServerOrigin,
  resolveDocumentThumbnailPresentation,
  type DocumentThumbnailLoadState,
} from '@/lib/document-thumbnail-policy';
import { MAX_THUMBNAIL_DOWNLOAD_BYTES } from '@/lib/download-policy';
import {
  downloadPaperlessFileWithCredentials,
  getPaperlessDocumentUrl,
  paperlessCredentialFileHeaders,
  usesNativeMutualTls,
} from '@/lib/paperless';
import type { PaperlessCredentials } from '@/types/document';

export type SecureDocumentThumbnailProps = {
  credentials: PaperlessCredentials;
  documentId: number;
  /** Painted once the thumbnail cannot be shown at all. */
  fallback: ReactNode;
  /** Painted while the thumbnail is still on its way; defaults to `fallback`. */
  pendingFallback?: ReactNode;
  style?: StyleProp<ViewStyle>;
  title: string;
};

/** Distinguishes two live mounts of the same document's cache file. */
let nextThumbnailLease = 0;

/**
 * Shows one Paperless thumbnail without ever handing credentials to a renderer.
 *
 * A token connection lets `expo-image` fetch the URL with an `Authorization`
 * header and keep the bytes in its memory cache. A mutual-TLS connection cannot
 * do that — only the native session holds the client identity — so the image is
 * downloaded through that session into app-private cache storage, under a size
 * limit, and deleted as soon as this view goes away.
 *
 * The caller decides what stands in for the image: the merge rail uses a small
 * spinner, a document card uses its illustrated paper.
 */
export function SecureDocumentThumbnail({
  credentials,
  documentId,
  fallback,
  pendingFallback,
  style,
  title,
}: SecureDocumentThumbnailProps) {
  const nativeMutualTls = usesNativeMutualTls(credentials);
  const remoteUri = getPaperlessDocumentUrl(credentials, documentId, 'thumb');
  const profileKey = credentials.profileId || 'missing-profile';
  const serverOrigin = documentThumbnailServerOrigin(credentials.serverUrl);
  const headers = useMemo(() => paperlessCredentialFileHeaders(credentials), [credentials]);
  const identity = `${profileKey}\n${remoteUri}`;
  const [state, setState] = useState<{
    identity: string;
    load: DocumentThumbnailLoadState;
    localUri: string | null;
  }>({ identity, load: 'pending', localUri: null });

  // A recycled row can be handed another document; its predecessor's image must
  // not be shown for even one frame under the new title.
  if (state.identity !== identity) setState({ identity, load: 'pending', localUri: null });

  useEffect(() => {
    if (!nativeMutualTls) return;
    const controller = new AbortController();
    const lease = (nextThumbnailLease += 1).toString(36);
    let mounted = true;
    let localFile: File | null = null;
    void digestStringAsync(
      CryptoDigestAlgorithm.SHA256,
      documentThumbnailCacheSeed({ documentId, profileKey, serverOrigin }),
    ).then(async (digest) => {
      if (!mounted) return;
      const destination = new File(
        Paths.cache,
        documentThumbnailCacheFileName(digest, lease),
      );
      localFile = destination;
      const response = await downloadPaperlessFileWithCredentials(
        credentials,
        remoteUri,
        destination.uri,
        { signal: controller.signal, maxBytes: MAX_THUMBNAIL_DOWNLOAD_BYTES },
      );
      if (
        response.status < 200
        || response.status >= 300
        || !destination.exists
        || destination.size < 1
        || destination.size > MAX_THUMBNAIL_DOWNLOAD_BYTES
      ) {
        throw new Error(translateRuntime('runtimeError.thumbnailUnavailable'));
      }
      if (mounted) setState((current) => ({ ...current, localUri: destination.uri }));
      else if (destination.exists) destination.delete();
    }).catch((error) => {
      if (!mounted && localFile?.exists) localFile.delete();
      else if (!(error instanceof Error && error.name === 'AbortError')) {
        setState((current) => ({ ...current, load: 'failed' }));
      }
    });
    return () => {
      mounted = false;
      controller.abort();
      if (localFile?.exists) localFile.delete();
    };
  }, [credentials, documentId, nativeMutualTls, profileKey, remoteUri, serverOrigin]);

  const source = useMemo(
    () => state.localUri
      ? { uri: state.localUri }
      : {
        uri: remoteUri,
        headers,
        cacheKey: documentThumbnailImageCacheKey({ documentId, profileKey }),
      },
    [documentId, headers, profileKey, remoteUri, state.localUri],
  );
  const presentation = resolveDocumentThumbnailPresentation({
    allowed: true,
    load: state.load,
  });
  const readyForImage = state.load !== 'failed' && (!nativeMutualTls || state.localUri !== null);

  return (
    <View style={style}>
      {readyForImage && (
        <Image
          accessibilityLabel={title}
          cachePolicy={state.localUri ? 'none' : 'memory'}
          contentFit="cover"
          onError={() => setState((current) => ({ ...current, load: 'failed' }))}
          onLoad={() => setState((current) => ({ ...current, load: 'ready' }))}
          source={source}
          style={StyleSheet.absoluteFill}
        />
      )}
      {presentation === 'illustration' && (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.standIn]}>
          {state.load === 'failed' ? fallback : pendingFallback ?? fallback}
        </View>
      )}
    </View>
  );
}

const styles = createThemedStyleSheet({
  standIn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
