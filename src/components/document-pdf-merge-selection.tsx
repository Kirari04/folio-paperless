import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import { Check, FileStack } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Text, View } from 'react-native';

import { MotionPressable as Pressable } from '@/components/motion';
import { createThemedStyleSheet, fonts, palette, radii } from '@/constants/theme';
import { useI18n } from '@/i18n';
import { translateRuntime } from '@/i18n/runtime';
import {
  downloadPaperlessFileWithCredentials,
  getPaperlessDocumentUrl,
  paperlessCredentialFileHeaders,
  usesNativeMutualTls,
} from '@/lib/paperless';
import { MAX_THUMBNAIL_DOWNLOAD_BYTES } from '@/lib/download-policy';
import { isChangeAuthorizedPdfMergeDocument } from '@/lib/paperless-advanced';
import type { DocumentItem, PaperlessCredentials } from '@/types/document';

type DocumentPdfMergeSelectionProps = {
  busy: boolean;
  credentials: PaperlessCredentials;
  currentDocument: DocumentItem;
  documents: readonly DocumentItem[];
  enabled: boolean;
  onMerge: (documentIds: number[]) => void;
};

export function DocumentPdfMergeSelection({
  busy,
  credentials,
  currentDocument,
  documents,
  enabled,
  onMerge,
}: DocumentPdfMergeSelectionProps) {
  const { formatNumber, t } = useI18n();
  const currentId = currentDocument.remoteId!;
  const [selectedIds, setSelectedIds] = useState<number[]>([currentId]);
  const candidates = useMemo(() => {
    const byId = new Map<number, DocumentItem>();
    for (const document of documents) {
      if (isChangeAuthorizedPdfMergeDocument(document)) byId.set(document.remoteId!, document);
    }
    if (isChangeAuthorizedPdfMergeDocument(currentDocument)) byId.set(currentId, currentDocument);
    return [...byId.values()].sort((left, right) => {
      if (left.remoteId === currentId) return -1;
      if (right.remoteId === currentId) return 1;
      return left.title.localeCompare(right.title);
    });
  }, [currentDocument, currentId, documents]);
  const selected = selectedIds.flatMap((id) => {
    const document = candidates.find((candidate) => candidate.remoteId === id);
    return document ? [document] : [];
  });
  const candidateIds = useMemo(
    () => new Set(candidates.map((candidate) => candidate.remoteId!)),
    [candidates],
  );
  const canSubmitMerge = enabled
    && !busy
    && selectedIds.length >= 2
    && selectedIds.every((documentId) => candidateIds.has(documentId));
  const headers = useMemo(() => paperlessCredentialFileHeaders(credentials), [credentials]);
  const profileKey = credentials.profileId || 'missing-profile';

  function toggleDocument(documentId: number) {
    if (documentId === currentId || !candidateIds.has(documentId)) return;
    setSelectedIds((current) => current.includes(documentId)
      ? current.filter((id) => id !== documentId)
      : [...current, documentId]);
  }

  function submitMerge() {
    if (!canSubmitMerge) return;
    onMerge([...selectedIds]);
  }

  return (
    <View style={styles.root}>
      <View style={styles.headingRow}>
        <FileStack color={palette.ink} size={18} />
        <View style={styles.flexCopy}>
          <Text style={styles.title}>{t('paperless3.mergeDocuments')}</Text>
          <Text style={styles.copy}>{t('paperless3.pageEditorMergeSelectHint')}</Text>
        </View>
      </View>

      <Text accessibilityLiveRegion="polite" style={styles.selectionCount}>
        {t('paperless3.pageEditorMergeSelectedCount', {
          count: formatNumber(selected.length),
        })}
      </Text>

      <FlatList
        contentContainerStyle={styles.rail}
        data={candidates}
        horizontal
        keyExtractor={(item) => String(item.remoteId)}
        renderItem={({ item }) => {
          const documentId = item.remoteId!;
          const order = selectedIds.indexOf(documentId);
          const checked = order >= 0;
          return (
            <Pressable
              accessibilityLabel={`${item.title}. ${t('paperless3.pageEditorDocumentId', { id: documentId })}`}
              accessibilityRole="checkbox"
              accessibilityState={{ checked, disabled: documentId === currentId }}
              onPress={() => toggleDocument(documentId)}
              style={[styles.document, checked && styles.documentSelected]}>
              <SecureDocumentThumbnail
                credentials={credentials}
                documentId={documentId}
                headers={headers}
                profileKey={profileKey}
                title={item.title}
              />
              <View style={[styles.order, checked && styles.orderSelected]}>
                {checked ? <Text style={styles.orderText}>{formatNumber(order + 1)}</Text> : null}
              </View>
              {checked && (
                <View style={styles.check}>
                  <Check color={palette.accentInk} size={15} />
                </View>
              )}
              <Text numberOfLines={2} style={styles.documentTitle}>{item.title}</Text>
              <Text style={styles.documentMeta}>
                {documentId === currentId
                  ? t('paperless3.pageEditorCurrentDocument')
                  : t('paperless3.pageEditorDocumentId', { id: documentId })}
              </Text>
            </Pressable>
          );
        }}
        showsHorizontalScrollIndicator={false}
      />

      <Pressable
        accessibilityRole="button"
        disabled={!canSubmitMerge}
        onPress={submitMerge}
        style={[
          styles.mergeButton,
          !canSubmitMerge && styles.disabled,
        ]}>
        <FileStack color={palette.accentInk} size={17} />
        <Text style={styles.mergeButtonText}>{t('paperless3.createMerged')}</Text>
      </Pressable>
    </View>
  );
}

function SecureDocumentThumbnail({
  credentials,
  documentId,
  headers,
  profileKey,
  title,
}: {
  credentials: PaperlessCredentials;
  documentId: number;
  headers: Record<string, string>;
  profileKey: string;
  title: string;
}) {
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const nativeMutualTls = usesNativeMutualTls(credentials);
  const remoteUri = getPaperlessDocumentUrl(credentials, documentId, 'thumb');

  useEffect(() => {
    if (!nativeMutualTls) return;
    const controller = new AbortController();
    let mounted = true;
    let localFile: File | null = null;
    void digestStringAsync(
      CryptoDigestAlgorithm.SHA256,
      `${profileKey}\n${new URL(credentials.serverUrl).origin}\n${documentId}\nthumb`,
    ).then(async (digest) => {
      if (!mounted) return;
      const destination = new File(Paths.cache, `folio-merge-thumb-${digest.slice(0, 40)}.img`);
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
      if (mounted) setLocalUri(destination.uri);
      else if (destination.exists) destination.delete();
    }).catch((error) => {
      if (!mounted && localFile?.exists) localFile.delete();
      else if (!(error instanceof Error && error.name === 'AbortError')) setFailed(true);
    });
    return () => {
      mounted = false;
      controller.abort();
      if (localFile?.exists) localFile.delete();
    };
  }, [credentials, documentId, nativeMutualTls, profileKey, remoteUri]);

  if (failed) {
    return <View accessibilityLabel={title} style={styles.thumbnailPlaceholder}><FileStack color={palette.muted} size={22} /></View>;
  }
  if (nativeMutualTls && !localUri) {
    return <View style={styles.thumbnailPlaceholder}><ActivityIndicator color={palette.limeDark} size="small" /></View>;
  }
  return (
    <Image
      accessibilityLabel={title}
      cachePolicy={localUri ? 'none' : 'memory'}
      contentFit="cover"
      source={localUri ? { uri: localUri } : {
        uri: remoteUri,
        headers,
        cacheKey: `folio-merge-${profileKey}-${documentId}`,
      }}
      style={styles.thumbnail}
    />
  );
}

const styles = createThemedStyleSheet({
  root: {
    marginTop: 24,
    paddingTop: 20,
    borderTopWidth: 1,
    borderColor: palette.line,
  },
  headingRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  flexCopy: { flex: 1, minWidth: 0 },
  title: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
    fontWeight: '900',
  },
  copy: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 17,
    marginTop: 4,
  },
  selectionCount: {
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '800',
    marginTop: 14,
  },
  rail: { gap: 10, paddingVertical: 12, paddingRight: 20 },
  document: {
    width: 132,
    minHeight: 188,
    overflow: 'hidden',
    borderRadius: radii.md,
    borderWidth: 2,
    borderColor: palette.line,
    backgroundColor: palette.paper,
  },
  documentSelected: { borderColor: palette.limeDark },
  thumbnail: {
    width: '100%',
    height: 126,
    backgroundColor: palette.viewerSurface,
  },
  thumbnailPlaceholder: {
    width: '100%',
    height: 126,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.viewerSurface,
  },
  order: {
    position: 'absolute',
    top: 8,
    left: 8,
    width: 27,
    height: 27,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: palette.inverseScrim,
  },
  orderSelected: { backgroundColor: palette.lime },
  orderText: {
    color: palette.accentInk,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '900',
  },
  check: { position: 'absolute', top: 8, right: 8, width: 27, height: 27, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: palette.lime },
  documentTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '900',
    lineHeight: 15,
    marginTop: 9,
    paddingHorizontal: 9,
  },
  documentMeta: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 9,
    marginTop: 3,
    paddingHorizontal: 9,
    paddingBottom: 10,
  },
  mergeButton: {
    minHeight: 46,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radii.md,
    backgroundColor: palette.lime,
    paddingHorizontal: 16,
  },
  mergeButtonText: {
    color: palette.accentInk,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '900',
  },
  disabled: { opacity: 0.45 },
});
