import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import { Check, FileStack, Search, X } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Text, TextInput, View } from 'react-native';

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
import { isChangeAuthorizedPdfMergeDocument, rankPdfMergeCandidates } from '@/lib/paperless-advanced';
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
  const { formatDate, formatNumber, t } = useI18n();
  const currentId = currentDocument.remoteId!;
  const [selectedIds, setSelectedIds] = useState<number[]>([currentId]);
  const [query, setQuery] = useState('');
  const authorized = useMemo(() => {
    const byId = new Map<number, DocumentItem>();
    for (const document of documents) {
      if (isChangeAuthorizedPdfMergeDocument(document)) byId.set(document.remoteId!, document);
    }
    if (isChangeAuthorizedPdfMergeDocument(currentDocument)) byId.set(currentId, currentDocument);
    return byId;
  }, [currentDocument, currentId, documents]);
  const ranked = useMemo(
    () => rankPdfMergeCandidates(currentDocument, [...authorized.values()], query),
    [authorized, currentDocument, query],
  );
  // The current document stays first, and anything already picked stays visible even when the
  // search no longer matches it, so the chosen order can always be reviewed and undone.
  const candidates = useMemo(() => {
    const ordered = new Map<number, DocumentItem>();
    const current = authorized.get(currentId);
    if (current) ordered.set(currentId, current);
    for (const id of selectedIds) {
      const document = authorized.get(id);
      if (document) ordered.set(id, document);
    }
    for (const document of ranked) ordered.set(document.remoteId!, document);
    return [...ordered.values()];
  }, [authorized, currentId, ranked, selectedIds]);
  const selected = selectedIds.flatMap((id) => {
    const document = authorized.get(id);
    return document ? [document] : [];
  });
  const candidateIds = useMemo(() => new Set(authorized.keys()), [authorized]);
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

      <View style={styles.search}>
        <Search color={palette.muted} size={18} />
        <TextInput
          accessibilityLabel={t('paperless3.pageEditorMergeSearchLabel')}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          placeholder={t('paperless3.pageEditorMergeSearchPlaceholder')}
          placeholderTextColor={palette.faint}
          returnKeyType="search"
          style={styles.searchInput}
          value={query}
        />
        {!!query && (
          <Pressable accessibilityLabel={t('choice.clearSearch')} haptic="light" onPress={() => setQuery('')} style={styles.clearSearch}>
            <X color={palette.muted} size={16} />
          </Pressable>
        )}
      </View>

      {ranked.length === 0 && (
        <Text style={styles.empty}>
          {query ? t('paperless3.pageEditorMergeNoMatches') : t('paperless3.pageEditorMergeNoCandidates')}
        </Text>
      )}

      <FlatList
        contentContainerStyle={styles.rail}
        data={candidates}
        horizontal
        keyExtractor={(item) => String(item.remoteId)}
        keyboardShouldPersistTaps="handled"
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
              <Text numberOfLines={1} style={styles.documentMeta}>
                {documentId === currentId
                  ? t('paperless3.pageEditorCurrentDocument')
                  : [item.correspondent, item.created ? formatDate(item.created, { year: 'numeric', month: 'short' }) : '']
                    .filter(Boolean)
                    .join(' · ') || t('paperless3.pageEditorDocumentId', { id: documentId })}
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
  search: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 12,
    paddingLeft: 14,
    paddingRight: 7,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: radii.md,
    backgroundColor: palette.paper,
  },
  searchInput: {
    flex: 1,
    minHeight: 38,
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 15,
  },
  clearSearch: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
  },
  empty: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 12,
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
