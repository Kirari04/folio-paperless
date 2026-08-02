import { StatusBar } from 'expo-status-bar';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileStack,
  RotateCcw,
  RotateCw,
  Scissors,
  Trash2,
  X,
} from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  UIManager,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DocumentPdfMergeSelection } from '@/components/document-pdf-merge-selection';
import { MotionPressable as Pressable, useReducedMotion } from '@/components/motion';
import { fonts, palette, radii } from '@/constants/theme';
import { useI18n } from '@/i18n';
import {
  compilePdfEditorOperations,
  createPdfEditorPages,
  deletePdfEditorSelection,
  movePdfEditorSelection,
  pdfEditorOutputDocument,
  pdfEditorPlanChanged,
  rotatePdfEditorSelection,
  togglePdfEditorSplits,
  type PdfEditorPage,
} from '@/lib/document-production';
import { getPaperlessDocumentUrl } from '@/lib/paperless';
import {
  prepareSecurePdfPreview,
  type SecurePdfCacheLease,
} from '@/lib/secure-pdf-preview-cache';
import type { DocumentItem, PaperlessCredentials } from '@/types/document';
import type { PaperlessPdfPageOperation } from '@/types/paperless-advanced';

type PdfComponent = typeof import('react-native-pdf').default;

const MAX_EDITOR_PAGES = 10_000;

function editorPageCountHint(pageCount: number) {
  return Number.isSafeInteger(pageCount) && pageCount >= 1 && pageCount <= MAX_EDITOR_PAGES
    ? pageCount
    : 1;
}

export type PdfPageEditorApply = {
  operations: PaperlessPdfPageOperation[];
  hasSplits: boolean;
  removedPages: number;
};

type DocumentPdfPageEditorProps = {
  busy: boolean;
  credentials: PaperlessCredentials;
  document: DocumentItem;
  documents: readonly DocumentItem[];
  editEnabled: boolean;
  editUnavailableDetail?: string;
  mergeEnabled: boolean;
  onApply: (plan: PdfPageEditorApply) => void;
  onMerge: (documentIds: number[]) => void;
  splitEnabled: boolean;
};

export function DocumentPdfPageEditor({
  busy,
  credentials,
  document,
  documents,
  editEnabled,
  editUnavailableDetail,
  mergeEnabled,
  onApply,
  onMerge,
  splitEnabled,
}: DocumentPdfPageEditorProps) {
  const { colorScheme, formatNumber, t } = useI18n();
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [PdfView, setPdfView] = useState<PdfComponent | null>(null);
  const [localUri, setLocalUri] = useState<string | null>(null);
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sourcePageCount, setSourcePageCount] = useState(() => editorPageCountHint(document.pageCount));
  const [pages, setPages] = useState<PdfEditorPage[]>(() => createPdfEditorPages(editorPageCountHint(document.pageCount)));
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const resolvedCount = useRef(false);
  const lease = useRef<SecurePdfCacheLease | null>(null);
  const nativePdfAvailable = Platform.OS !== 'web'
    && !!UIManager.getViewManagerConfig?.('RNPDFPdfView');
  const changed = useMemo(
    () => pdfEditorPlanChanged(pages, sourcePageCount),
    [pages, sourcePageCount],
  );
  const selectedCount = selectedPages.size;
  const compiled = useMemo(() => compilePdfEditorOperations(pages), [pages]);

  useEffect(() => {
    if (!open) return;
    resolvedCount.current = false;
    const resetFrame = requestAnimationFrame(() => {
      const pageCount = editorPageCountHint(document.pageCount);
      setSourcePageCount(pageCount);
      setPages(createPdfEditorPages(pageCount));
      setSelectedPages(new Set());
    });
    return () => cancelAnimationFrame(resetFrame);
  }, [document.id, document.pageCount, open]);

  useEffect(() => {
    if (!open || !nativePdfAvailable || !editEnabled) return;
    const controller = new AbortController();
    let mounted = true;
    const resetFrame = requestAnimationFrame(() => {
      setLocalUri(null);
      setLoadProgress(0);
      setLoadError(null);
    });
    lease.current?.dispose();
    lease.current = null;

    void Promise.all([
      import('react-native-pdf'),
      prepareSecurePdfPreview({
        credentials,
        documentId: document.remoteId!,
        uri: getPaperlessDocumentUrl(credentials, document.remoteId!, 'preview'),
        signal: controller.signal,
        onProgress: (progress) => {
          if (mounted) setLoadProgress(progress);
        },
      }),
    ])
      .then(([pdfModule, nextLease]) => {
        if (!mounted) {
          nextLease.dispose();
          return;
        }
        lease.current = nextLease;
        setPdfView(() => pdfModule.default);
        setLocalUri(nextLease.uri);
      })
      .catch((error) => {
        if (!mounted || (error instanceof Error && error.name === 'AbortError')) return;
        setLoadError(t('paperless3.pageEditorMalformedPdf'));
      });

    return () => {
      mounted = false;
      cancelAnimationFrame(resetFrame);
      controller.abort();
      lease.current?.dispose();
      lease.current = null;
    };
  }, [credentials, document.remoteId, editEnabled, nativePdfAvailable, open, retryKey, t]);

  function togglePage(sourcePage: number) {
    setSelectedPages((current) => {
      const next = new Set(current);
      if (next.has(sourcePage)) next.delete(sourcePage);
      else next.add(sourcePage);
      return next;
    });
  }

  function resetPlan(pageCount = sourcePageCount) {
    setPages(createPdfEditorPages(pageCount));
    setSelectedPages(new Set());
  }

  function resolveActualPageCount(numberOfPages: number) {
    if (resolvedCount.current || !Number.isSafeInteger(numberOfPages) || numberOfPages < 1) return;
    resolvedCount.current = true;
    if (numberOfPages > MAX_EDITOR_PAGES) {
      setLoadError(t('paperless3.pageEditorMalformedPdf'));
      return;
    }
    if (numberOfPages !== sourcePageCount) {
      setSourcePageCount(numberOfPages);
      resetPlan(numberOfPages);
    }
  }

  function deleteSelection() {
    if (!selectedCount) return;
    Alert.alert(
      t('paperless3.deletePagesTitle'),
      t('paperless3.deletePagesBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('paperless3.pageEditorDeleteSelected'),
          style: 'destructive',
          onPress: () => {
            setPages((current) => deletePdfEditorSelection(current, selectedPages));
            setSelectedPages(new Set());
          },
        },
      ],
    );
  }

  function applyPlan() {
    if (compiled.hasSplits && !splitEnabled) return;
    const submit = () => onApply({
      ...compiled,
      removedPages: sourcePageCount - pages.length,
    });
    if (pages.length < sourcePageCount) {
      Alert.alert(
        t('paperless3.deletePagesTitle'),
        t('paperless3.deletePagesBody'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('paperless3.pageEditorApply'), style: 'destructive', onPress: submit },
        ],
      );
      return;
    }
    submit();
  }

  return (
    <>
      <Pressable
        accessibilityRole="button"
        disabled={!editEnabled && !mergeEnabled}
        onPress={() => setOpen(true)}
        style={[styles.openButton, !editEnabled && !mergeEnabled && styles.disabled]}>
        <FileStack color={palette.accentInk} size={18} />
        <Text style={styles.openButtonText}>{t('paperless3.pageEditorOpen')}</Text>
      </Pressable>
      {!editEnabled && !!editUnavailableDetail && (
        <Text style={styles.unavailableDetail}>{editUnavailableDetail}</Text>
      )}

      <Modal
        animationType={reducedMotion ? 'none' : 'slide'}
        onRequestClose={() => setOpen(false)}
        presentationStyle="fullScreen"
        visible={open}>
        <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
        <View style={styles.modalRoot}>
          <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
            <View style={styles.flexCopy}>
              <Text style={styles.headerTitle}>{t('paperless3.pageEditorTitle')}</Text>
              <Text numberOfLines={1} style={styles.headerSubtitle}>{document.title}</Text>
            </View>
            <Pressable
              accessibilityLabel={t('paperless3.close')}
              onPress={() => setOpen(false)}
              style={styles.closeButton}>
              <X color={palette.ink} size={20} />
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 40 }]}
            keyboardShouldPersistTaps="handled">
            <Text style={styles.sectionTitle}>{t('paperless3.pageEditorTitle')}</Text>
            <Text style={styles.sectionCopy}>{t('paperless3.pageEditorSelectHint')}</Text>

            {!editEnabled ? (
              <View style={styles.stateBox}>
                <Text style={styles.stateTitle}>{t('paperless3.unavailable')}</Text>
                <Text style={styles.stateCopy}>{editUnavailableDetail || t('paperless3.notAdvertisedPdf')}</Text>
              </View>
            ) : !nativePdfAvailable ? (
              <View style={styles.stateBox}>
                <Text style={styles.stateTitle}>{t('paperless3.unavailable')}</Text>
                <Text style={styles.stateCopy}>{t('paperless3.pageEditorRendererUnavailable')}</Text>
              </View>
            ) : loadError ? (
              <View style={styles.stateBox}>
                <Text style={styles.stateTitle}>{loadError}</Text>
                <Pressable onPress={() => setRetryKey((key) => key + 1)} style={styles.retryButton}>
                  <RotateCcw color={palette.ink} size={16} />
                  <Text style={styles.retryText}>{t('common.retry')}</Text>
                </Pressable>
              </View>
            ) : !PdfView || !localUri ? (
              <View accessibilityLiveRegion="polite" style={styles.loadingState}>
                <ActivityIndicator color={palette.limeDark} size="large" />
                <Text style={styles.stateTitle}>{t('paperless3.pageEditorPreparing')}</Text>
                {loadProgress > 0 && (
                  <Text style={styles.stateCopy}>{formatNumber(Math.round(loadProgress * 100))}%</Text>
                )}
              </View>
            ) : pages.length ? (
              <>
                <View style={styles.selectionHeader}>
                  <Text accessibilityLiveRegion="polite" style={styles.selectionCount}>
                    {t('paperless3.pageEditorSelectedCount', {
                      count: formatNumber(selectedCount),
                    })}
                  </Text>
                  <Pressable
                    onPress={() => setSelectedPages(selectedCount === pages.length
                      ? new Set()
                      : new Set(pages.map((page) => page.sourcePage)))}
                    style={styles.selectButton}>
                    <Text style={styles.selectButtonText}>
                      {t(selectedCount === pages.length
                        ? 'paperless3.pageEditorDeselectAll'
                        : 'paperless3.pageEditorSelectAll')}
                    </Text>
                  </Pressable>
                </View>

                <FlatList
                  contentContainerStyle={styles.pageRail}
                  data={pages}
                  horizontal
                  initialNumToRender={4}
                  keyExtractor={(item) => String(item.sourcePage)}
                  maxToRenderPerBatch={3}
                  removeClippedSubviews
                  renderItem={({ item, index }) => {
                    const selected = selectedPages.has(item.sourcePage);
                    const outputDocument = pdfEditorOutputDocument(pages, index) + 1;
                    const quarterTurn = item.rotation === 90 || item.rotation === 270;
                    return (
                      <View style={styles.pageSlot}>
                        <Pressable
                          accessibilityLabel={`${t('paperless3.pageEditorOriginalPage', { page: formatNumber(item.sourcePage) })}. ${t('paperless3.pageEditorOutputDocument', { document: formatNumber(outputDocument) })}`}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: selected }}
                          onPress={() => togglePage(item.sourcePage)}
                          style={[styles.pageCard, selected && styles.pageCardSelected]}>
                          <View style={styles.thumbnailViewport}>
                            <View style={[
                              styles.thumbnailTransform,
                              {
                                transform: [
                                  { rotate: `${item.rotation}deg` },
                                  { scale: quarterTurn ? 0.74 : 1 },
                                ],
                              },
                            ]}>
                              <PdfView
                                enableAnnotationRendering={false}
                                enableDoubleTapZoom={false}
                                fitPolicy={2}
                                maxScale={1}
                                minScale={1}
                                onError={() => setLoadError(t('paperless3.pageEditorMalformedPdf'))}
                                onLoadComplete={resolveActualPageCount}
                                page={item.sourcePage}
                                renderActivityIndicator={() => (
                                  <ActivityIndicator color={palette.limeDark} size="small" />
                                )}
                                scrollEnabled={false}
                                singlePage
                                source={{ uri: localUri }}
                                style={styles.pdfThumbnail}
                                trustAllCerts={false}
                              />
                            </View>
                          </View>
                          <View style={[styles.pageBadge, selected && styles.pageBadgeSelected]}>
                            {selected ? <Check color={palette.accentInk} size={14} /> : (
                              <Text style={styles.pageBadgeText}>{formatNumber(index + 1)}</Text>
                            )}
                          </View>
                          <Text style={styles.pageLabel}>
                            {t('paperless3.pageEditorOriginalPage', { page: formatNumber(item.sourcePage) })}
                          </Text>
                          <Text style={styles.outputLabel}>
                            {t('paperless3.pageEditorOutputDocument', { document: formatNumber(outputDocument) })}
                          </Text>
                        </Pressable>
                        {item.splitAfter && (
                          <View style={styles.splitMarker}>
                            <Scissors color={palette.danger} size={14} />
                          </View>
                        )}
                      </View>
                    );
                  }}
                  showsHorizontalScrollIndicator={false}
                  windowSize={3}
                />

                <View style={styles.tools}>
                  <ToolButton disabled={!selectedCount} icon={ChevronLeft} label={t('paperless3.pageEditorMoveEarlier')} onPress={() => setPages((current) => movePdfEditorSelection(current, selectedPages, -1))} />
                  <ToolButton disabled={!selectedCount} icon={ChevronRight} label={t('paperless3.pageEditorMoveLater')} onPress={() => setPages((current) => movePdfEditorSelection(current, selectedPages, 1))} />
                  <ToolButton disabled={!selectedCount} icon={RotateCcw} label={t('paperless3.pageEditorRotateLeft')} onPress={() => setPages((current) => rotatePdfEditorSelection(current, selectedPages, -90))} />
                  <ToolButton disabled={!selectedCount} icon={RotateCw} label={t('paperless3.pageEditorRotateRight')} onPress={() => setPages((current) => rotatePdfEditorSelection(current, selectedPages, 90))} />
                  <ToolButton disabled={!selectedCount || !splitEnabled} icon={Scissors} label={t('paperless3.pageEditorSplitAfter')} onPress={() => setPages((current) => togglePdfEditorSplits(current, selectedPages))} />
                  <ToolButton destructive disabled={!selectedCount || selectedCount >= pages.length} icon={Trash2} label={t('paperless3.pageEditorDeleteSelected')} onPress={deleteSelection} />
                </View>

                <View style={styles.planNotice}>
                  <Text style={styles.planNoticeText}>
                    {t(compiled.hasSplits
                      ? 'paperless3.pageEditorCreateWarning'
                      : 'paperless3.pageEditorUpdateWarning')}
                  </Text>
                  <Text style={styles.cacheNotice}>{t('paperless3.pageEditorSecureCache')}</Text>
                </View>
                <View style={styles.planActions}>
                  <Pressable disabled={!changed || busy} onPress={() => resetPlan()} style={[styles.resetButton, (!changed || busy) && styles.disabled]}>
                    <Text style={styles.resetText}>{t('paperless3.pageEditorReset')}</Text>
                  </Pressable>
                  <Pressable disabled={!changed || busy || compiled.hasSplits && !splitEnabled} onPress={applyPlan} style={[styles.applyButton, (!changed || busy || compiled.hasSplits && !splitEnabled) && styles.disabled]}>
                    {busy ? <ActivityIndicator color={palette.accentInk} size="small" /> : <FileStack color={palette.accentInk} size={17} />}
                    <Text style={styles.applyText}>{t('paperless3.pageEditorApply')}</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <View style={styles.stateBox}>
                <Text style={styles.stateCopy}>{t('paperless3.pageEditorNoPages')}</Text>
              </View>
            )}

            <DocumentPdfMergeSelection
              busy={busy}
              credentials={credentials}
              currentDocument={document}
              documents={documents}
              enabled={mergeEnabled}
              onMerge={onMerge}
            />
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

function ToolButton({
  destructive,
  disabled,
  icon: Icon,
  label,
  onPress,
}: {
  destructive?: boolean;
  disabled: boolean;
  icon: typeof Check;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.toolButton, destructive && styles.toolButtonDestructive, disabled && styles.disabled]}>
      <Icon color={destructive ? palette.danger : palette.ink} size={17} />
      <Text style={[styles.toolText, destructive && styles.toolTextDestructive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  openButton: {
    minHeight: 48,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    borderRadius: radii.md,
    backgroundColor: palette.lime,
    paddingHorizontal: 17,
  },
  openButtonText: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 11, fontWeight: '900' },
  unavailableDetail: { color: palette.muted, fontFamily: fonts.sans, fontSize: 10, lineHeight: 16, marginTop: 7 },
  disabled: { opacity: 0.42 },
  modalRoot: { flex: 1, backgroundColor: palette.canvas },
  header: {
    minHeight: 78,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 18,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.canvas,
  },
  flexCopy: { flex: 1, minWidth: 0 },
  headerTitle: { color: palette.ink, fontFamily: fonts.serif, fontSize: 23, fontWeight: '600' },
  headerSubtitle: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, marginTop: 3 },
  closeButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: palette.paper },
  content: { width: '100%', maxWidth: 860, alignSelf: 'center', padding: 20 },
  sectionTitle: { color: palette.ink, fontFamily: fonts.serif, fontSize: 25, fontWeight: '600' },
  sectionCopy: { maxWidth: 620, color: palette.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 19, marginTop: 6 },
  stateBox: { minHeight: 128, justifyContent: 'center', padding: 18, borderRadius: radii.md, backgroundColor: palette.paper, marginTop: 16 },
  loadingState: { minHeight: 180, alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: 16 },
  stateTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 13, fontWeight: '900', textAlign: 'center' },
  stateCopy: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, lineHeight: 17, marginTop: 5, textAlign: 'center' },
  retryButton: { minHeight: 42, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 14, borderRadius: radii.md, backgroundColor: palette.canvas, marginTop: 14 },
  retryText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900' },
  selectionHeader: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16 },
  selectionCount: { flex: 1, color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 11, fontWeight: '800' },
  selectButton: { minHeight: 38, justifyContent: 'center', borderRadius: radii.pill, backgroundColor: palette.paper, paddingHorizontal: 13 },
  selectButtonText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 9, fontWeight: '900' },
  pageRail: { gap: 12, paddingVertical: 8, paddingRight: 20 },
  pageSlot: { width: 138, flexDirection: 'row' },
  pageCard: { width: 128, overflow: 'hidden', borderRadius: radii.md, borderWidth: 2, borderColor: palette.line, backgroundColor: palette.paper },
  pageCardSelected: { borderColor: palette.limeDark, backgroundColor: palette.limeSurface },
  thumbnailViewport: { height: 164, overflow: 'hidden', backgroundColor: palette.viewerSurface },
  thumbnailTransform: { width: '100%', height: '100%' },
  pdfThumbnail: { width: '100%', height: '100%', backgroundColor: palette.viewerSurface },
  pageBadge: { position: 'absolute', top: 8, left: 8, minWidth: 27, height: 27, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: palette.inverseScrim, paddingHorizontal: 5 },
  pageBadgeSelected: { backgroundColor: palette.lime },
  pageBadgeText: { color: palette.onDark, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900' },
  pageLabel: { color: palette.ink, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900', marginTop: 9, paddingHorizontal: 9 },
  outputLabel: { color: palette.muted, fontFamily: fonts.sans, fontSize: 8, marginTop: 3, paddingHorizontal: 9, paddingBottom: 10 },
  splitMarker: { position: 'absolute', zIndex: 4, top: 0, right: -3, width: 18, height: 208, alignItems: 'center', justifyContent: 'center', borderRadius: radii.pill, backgroundColor: palette.dangerSurface },
  tools: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 13 },
  toolButton: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: radii.md, backgroundColor: palette.paper, paddingHorizontal: 12 },
  toolButtonDestructive: { backgroundColor: palette.dangerSurface },
  toolText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 9, fontWeight: '900' },
  toolTextDestructive: { color: palette.danger },
  planNotice: { padding: 13, borderRadius: radii.md, backgroundColor: palette.paper, marginTop: 16 },
  planNoticeText: { color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 10, lineHeight: 16 },
  cacheNotice: { color: palette.muted, fontFamily: fonts.sans, fontSize: 9, lineHeight: 14, marginTop: 6 },
  planActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 12 },
  resetButton: { minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: radii.md, backgroundColor: palette.paper, paddingHorizontal: 16 },
  resetText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900' },
  applyButton: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radii.md, backgroundColor: palette.lime, paddingHorizontal: 16 },
  applyText: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900' },
});
