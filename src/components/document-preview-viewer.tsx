import { Image } from 'expo-image';
import { File } from 'expo-file-system';
import { StatusBar } from 'expo-status-bar';
import {
  ChevronLeft,
  ChevronRight,
  FileWarning,
  Maximize2,
  RotateCcw,
  Search,
  X,
} from 'lucide-react-native';
import { useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  UIManager,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PdfRef, PdfSearchResult } from 'react-native-pdf';

import {
  MotionPressable as Pressable,
  useReducedMotion,
} from '@/components/motion';
import { fonts, palette, radii } from '@/constants/theme';
import { useI18n } from '@/i18n';
import { downloadPaperlessFileWithCredentials } from '@/lib/paperless';
import {
  type SearchablePdfPage,
  type ViewerSearchMatch,
  type ViewerSearchResult,
  validateNativePdfSearchEvent,
} from '@/lib/viewer-search';
import { viewerPreviewDirectory } from '@/lib/temporary-file-storage';
import { assertSafeTemporaryPathSegment } from '@/lib/temporary-file-policy';
import {
  assertSafePdfFile,
  downloadFileWithinLimit,
} from '@/lib/bounded-file-download';
import {
  assertCompletedFileSize,
  MAX_PDF_PREVIEW_BYTES,
  MAX_THUMBNAIL_DOWNLOAD_BYTES,
} from '@/lib/download-policy';
import { verifyDownloadedRepresentationFile } from '@/lib/document-representation-file';
import type { PaperlessRepresentation } from '@/types/paperless-advanced';

type PdfComponent = typeof import('react-native-pdf').default;

type DocumentPreviewViewerProps = {
  bindingKey: string;
  cacheKey: string;
  clientIdentityRef?: string;
  expectedChecksum?: string | null;
  expectedSize?: number | null;
  fallbackSource: {
    headers: Record<string, string>;
    uri: string;
  } | null;
  headers: Record<string, string>;
  mimeType?: string | null;
  onClose: () => void;
  offline?: boolean;
  pageCount: number;
  profileId: string;
  representation?: PaperlessRepresentation;
  serverUrl: string;
  searchPages?: readonly SearchablePdfPage[] | null;
  title: string;
  uri: string;
  visible: boolean;
};

export function DocumentPreviewViewer({
  bindingKey,
  cacheKey,
  clientIdentityRef,
  expectedChecksum,
  expectedSize,
  fallbackSource,
  headers,
  mimeType,
  onClose,
  offline = false,
  pageCount: pageCountHint,
  profileId,
  representation,
  serverUrl,
  title,
  uri,
  visible,
}: DocumentPreviewViewerProps) {
  const { colorScheme, formatNumber, t } = useI18n();
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const pdfRef = useRef<PdfRef | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchOriginPage = useRef(1);
  const [PdfView, setPdfView] = useState<PdfComponent | null>(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(Math.max(1, pageCountHint));
  const [loadError, setLoadError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [showFallback, setShowFallback] = useState(false);
  const [preparedPreview, setPreparedPreview] = useState<{
    bindingKey: string;
    uri: string;
  } | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState<ViewerSearchResult | null>(null);
  const [nativeSearching, setNativeSearching] = useState(false);
  const [activeMatch, setActiveMatch] = useState(0);
  const [hintOpacity] = useState(() => new Animated.Value(1));
  const nativePdfAvailable =
    Platform.OS !== 'web' && !!UIManager.getViewManagerConfig?.('RNPDFPdfView');
  const normalizedMimeType = mimeType?.split(';', 1)[0]?.trim().toLocaleLowerCase() ?? null;
  const previewKind = normalizedMimeType === null || normalizedMimeType === 'application/pdf'
    ? 'pdf'
    : normalizedMimeType.startsWith('image/') && normalizedMimeType !== 'image/svg+xml'
      ? 'image'
      : 'unsupported';
  const localPreviewUri = preparedPreview?.bindingKey === bindingKey
    ? preparedPreview.uri
    : null;

  useEffect(() => {
    if (!visible || !nativePdfAvailable || PdfView) return;
    let mounted = true;
    void import('react-native-pdf')
      .then((module) => {
        if (mounted) setPdfView(() => module.default);
      })
      .catch(() => {
        if (mounted) setLoadError(true);
      });
    return () => {
      mounted = false;
    };
  }, [PdfView, nativePdfAvailable, visible]);

  useEffect(() => {
    if (
      !visible
      || previewKind === 'unsupported'
      || (previewKind === 'pdf' && !nativePdfAvailable)
    ) return;
    const controller = new AbortController();
    let mounted = true;
    let reportedProgress = -1;
    const destination = new File(
      viewerPreviewDirectory(profileId),
      `${assertSafeTemporaryPathSegment(cacheKey, 'The viewer cache key')}.${previewKind === 'pdf' ? 'pdf' : 'image'}`,
    );
    const maxBytes = previewKind === 'pdf'
      ? MAX_PDF_PREVIEW_BYTES
      : MAX_THUMBNAIL_DOWNLOAD_BYTES;
    const verifySafePreviewFile = async (file: File) => {
      if (previewKind === 'pdf') assertSafePdfFile(file, maxBytes);
      else assertCompletedFileSize(file.size, maxBytes);
      if (!offline && representation) {
        await verifyDownloadedRepresentationFile({
          checksum: expectedChecksum,
          file,
          representation,
          signal: controller.signal,
          size: expectedSize ?? null,
        });
      }
      return file;
    };

    const downloadFrame = requestAnimationFrame(() => {
      setPreparedPreview(null);
      setDownloadProgress(null);
      setSearchOpen(false);
      setSearchQuery('');
      setSearchResult(null);
      setNativeSearching(false);
      setActiveMatch(0);
      void (async () => {
        try {
          if (offline) {
            const downloadedFile = new File(uri);
            if (!downloadedFile.exists) throw new Error(t('viewer.offlineFileMissing'));
            await verifySafePreviewFile(downloadedFile);
            if (mounted) setPreparedPreview({ bindingKey, uri: downloadedFile.uri });
            return;
          }
          const cacheAge = destination.lastModified
            ? Date.now() - destination.lastModified
            : Number.POSITIVE_INFINITY;
          if (destination.exists && destination.size > 1024 && cacheAge < 60 * 60 * 1000) {
            try {
              await verifySafePreviewFile(destination);
              if (mounted) setPreparedPreview({ bindingKey, uri: destination.uri });
              return;
            } catch {
              destination.delete();
            }
          }

          let file: File;
          if (clientIdentityRef) {
            const response = await downloadPaperlessFileWithCredentials(
              {
                profileId,
                serverUrl,
                token: '',
                clientIdentityRef,
              },
              uri,
              destination.uri,
              {
                signal: controller.signal,
                maxBytes,
                onProgress: (nextProgress) => {
                  if (!mounted || nextProgress === null) return;
                  const roundedProgress = Math.floor(nextProgress * 20) / 20;
                  if (roundedProgress === reportedProgress) return;
                  reportedProgress = roundedProgress;
                  setDownloadProgress(roundedProgress);
                },
              },
            );
            if (response.status < 200 || response.status >= 300) {
              throw new Error(`Paperless returned HTTP ${response.status}.`);
            }
            file = await verifySafePreviewFile(new File(destination.uri));
          } else {
            file = await downloadFileWithinLimit({
              url: uri,
              destination,
              headers,
              signal: controller.signal,
              maxBytes,
              onProgress: (nextProgress) => {
                if (!mounted || nextProgress === null) return;
                const roundedProgress = Math.floor(nextProgress * 20) / 20;
                if (roundedProgress === reportedProgress) return;
                reportedProgress = roundedProgress;
                setDownloadProgress(roundedProgress);
              },
            });
            await verifySafePreviewFile(file);
          }
          if (!mounted) return;
          setDownloadProgress(1);
          setPreparedPreview({ bindingKey, uri: file.uri });
        } catch (error) {
          if (!offline && destination.exists) destination.delete();
          if (!mounted || (error instanceof Error && error.name === 'AbortError')) return;
          setLoadError(true);
        }
      })();
    });

    return () => {
      mounted = false;
      cancelAnimationFrame(downloadFrame);
      controller.abort();
    };
  }, [bindingKey, cacheKey, clientIdentityRef, expectedChecksum, expectedSize, headers, nativePdfAvailable, offline, previewKind, profileId, representation, retryKey, serverUrl, t, uri, visible]);

  useEffect(() => {
    if (!visible) return;
    const resetFrame = requestAnimationFrame(() => {
      setPage(1);
      setPageCount(Math.max(1, pageCountHint));
      setLoadError(false);
      setShowFallback(false);
      setDownloadProgress(null);
    });
    hintOpacity.stopAnimation();
    hintOpacity.setValue(1);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => {
      if (reducedMotion) {
        hintOpacity.setValue(0);
        return;
      }
      Animated.timing(hintOpacity, {
        duration: 240,
        toValue: 0,
        useNativeDriver: true,
      }).start();
    }, 4200);
    return () => {
      cancelAnimationFrame(resetFrame);
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
  }, [cacheKey, hintOpacity, pageCountHint, reducedMotion, visible]);

  const goToPage = useCallback((nextPage: number) => {
    const boundedPage = Math.min(pageCount, Math.max(1, nextPage));
    pdfRef.current?.setPage(boundedPage);
    setPage((currentPage) => currentPage === boundedPage ? currentPage : boundedPage);
  }, [pageCount]);

  const trimmedSearchQuery = searchQuery.trim();
  const deferredSearchQuery = useDeferredValue(trimmedSearchQuery);
  const nativeSearchQuery = visible && searchOpen && previewKind === 'pdf' && localPreviewUri && trimmedSearchQuery
    ? deferredSearchQuery
    : '';
  const searchBusy = !!trimmedSearchQuery
    && (nativeSearching || nativeSearchQuery !== trimmedSearchQuery);

  const handleNativeSearchResult = useCallback((payload: PdfSearchResult) => {
    const result = validateNativePdfSearchEvent(payload, nativeSearchQuery, { pageCount });
    if (!result || !searchOpen) return;
    if (result.status === 'idle') {
      setNativeSearching(false);
      setSearchResult(null);
      return;
    }
    if (result.status === 'searching') {
      setNativeSearching(true);
      setSearchResult(null);
      setActiveMatch(0);
      return;
    }
    setNativeSearching(false);
    setActiveMatch(0);
    if (result.status === 'unavailable') {
      setSearchResult({
        status: 'no-searchable-text',
        query: result.query,
        matches: [],
        truncated: false,
      });
      return;
    }
    const ready: ViewerSearchResult = {
      status: 'ready',
      query: result.query,
      matches: result.matches,
      truncated: result.truncated,
    };
    setSearchResult(ready);
    if (ready.matches.length) goToPage(ready.matches[0].page);
  }, [goToPage, nativeSearchQuery, pageCount, searchOpen]);

  function retry() {
    setLoadError(false);
    setShowFallback(false);
    setPreparedPreview(null);
    setRetryKey((key) => key + 1);
  }

  function selectMatch(nextIndex: number) {
    if (searchResult?.status !== 'ready' || !searchResult.matches.length) return;
    const count = searchResult.matches.length;
    const index = (nextIndex + count) % count;
    setActiveMatch(index);
    goToPage(searchResult.matches[index].page);
  }

  function closeSearch() {
    setSearchOpen(false);
    setNativeSearching(false);
    goToPage(searchOriginPage.current);
  }

  function toggleSearch() {
    if (searchOpen) {
      closeSearch();
      return;
    }
    searchOriginPage.current = page;
    setSearchOpen(true);
  }

  const usingFallback = previewKind === 'unsupported'
    || (previewKind === 'pdf' && (showFallback || !nativePdfAvailable));
  return (
    <Modal
      animationType={reducedMotion ? 'none' : 'fade'}
      hardwareAccelerated
      navigationBarTranslucent
      onRequestClose={onClose}
      presentationStyle="fullScreen"
      statusBarTranslucent
      transparent={false}
      visible={visible}>
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
      <View style={styles.root}>
        <View style={[styles.header, { top: insets.top }]}>
          <Pressable
            accessibilityLabel={t('viewer.close')}
            haptic="light"
            onPress={onClose}
            style={styles.roundButton}>
            <X color={palette.ink} size={21} />
          </Pressable>
          <View style={styles.titleBlock}>
            <Text numberOfLines={1} style={styles.title}>
              {title}
            </Text>
            <Text style={styles.pageMeta}>
              {usingFallback || previewKind !== 'pdf'
                ? t('viewer.firstPagePreview')
                : t('viewer.pageOf', {
                    page: formatNumber(page),
                    count: formatNumber(pageCount),
                  })}
            </Text>
          </View>
          <Pressable
            accessibilityLabel={t('viewer.findDocument')}
            disabled={usingFallback || previewKind !== 'pdf'}
            onPress={toggleSearch}
            style={[
              styles.roundButton,
              (usingFallback || previewKind !== 'pdf') && styles.controlDisabled,
            ]}>
            <Search color={palette.ink} size={20} />
          </Pressable>
        </View>

        {searchOpen && !usingFallback && previewKind === 'pdf' && (
          <View style={[styles.searchPanel, { top: insets.top + 66 }]}>
            <View style={styles.searchInputRow}>
              <Search color={palette.muted} size={17} />
              <TextInput
                accessibilityLabel={t('viewer.findText')}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                maxLength={160}
                onChangeText={setSearchQuery}
                placeholder={t('viewer.findPlaceholder')}
                placeholderTextColor={palette.faint}
                returnKeyType="search"
                style={styles.searchInput}
                value={searchQuery}
              />
              <Pressable accessibilityLabel={t('viewer.closeSearch')} onPress={closeSearch}>
                <X color={palette.inkSoft} size={18} />
              </Pressable>
            </View>
            <ViewerSearchStatus
              activeIndex={activeMatch}
              busy={searchBusy}
              onNext={() => selectMatch(activeMatch + 1)}
              onPrevious={() => selectMatch(activeMatch - 1)}
              result={trimmedSearchQuery ? searchResult : null}
            />
          </View>
        )}

        <View
          accessibilityLabel={t('viewer.fullPreview', { title })}
          accessibilityViewIsModal
          style={[
            styles.stage,
            {
              marginTop: insets.top + (
                searchOpen && !usingFallback && previewKind === 'pdf' ? 226 : 64
              ),
              marginBottom: insets.bottom + 88,
            },
          ]}>
          {usingFallback ? (
            <FallbackPreview
              available={nativePdfAvailable}
              clientIdentityRef={clientIdentityRef}
              offline={offline}
              onRetry={retry}
              representationSupported={previewKind !== 'unsupported'}
              source={fallbackSource}
            />
          ) : previewKind === 'image' && localPreviewUri && !loadError ? (
            <Image
              accessibilityLabel={t('viewer.fullPreview', { title })}
              contentFit="contain"
              source={{ uri: localPreviewUri }}
              style={styles.pdf}
            />
          ) : PdfView && localPreviewUri && !loadError ? (
            <PdfView
              enableAnnotationRendering
              enableDoubleTapZoom
              enablePaging={false}
              fitPolicy={0}
              horizontal={false}
              key={`${cacheKey}-${retryKey}`}
              maxScale={5}
              minScale={1}
              onError={() => setLoadError(true)}
              onPdfSearchResult={handleNativeSearchResult}
              onLoadComplete={(numberOfPages) => {
                setPageCount(Math.max(1, numberOfPages));
                setPage(1);
              }}
              onPageChanged={(nextPage, numberOfPages) => {
                setPage(nextPage);
                setPageCount(Math.max(1, numberOfPages));
              }}
              progressContainerStyle={styles.pdfLoader}
              ref={pdfRef}
              renderActivityIndicator={(progress) => (
                <View style={styles.loadingState}>
                  <ActivityIndicator color={palette.lime} size="large" />
                  <Text style={styles.loadingTitle}>{t('viewer.opening')}</Text>
                  <Text style={styles.loadingCopy}>
                    {progress > 0
                      ? t('viewer.downloaded', {
                          progress: formatNumber(Math.round(progress * 100)),
                        })
                      : t('viewer.preparing')}
                  </Text>
                </View>
              )}
              showsHorizontalScrollIndicator={false}
              showsVerticalScrollIndicator={false}
              searchCurrentIndex={activeMatch}
              searchQuery={searchOpen ? nativeSearchQuery : ''}
              source={{ uri: localPreviewUri }}
              spacing={14}
              style={styles.pdf}
              trustAllCerts={false}
            />
          ) : loadError ? (
            <View style={styles.errorState}>
              <View style={styles.errorIcon}>
                <FileWarning color={palette.apricot} size={26} />
              </View>
              <Text style={styles.errorTitle}>{t('viewer.errorTitle')}</Text>
              <Text style={styles.errorCopy}>{t('viewer.errorCopy')}</Text>
              <View style={styles.errorActions}>
                <Pressable haptic="light" onPress={retry} style={styles.retryButton}>
                  <RotateCcw color={palette.ink} size={17} />
                  <Text style={styles.retryText}>{t('common.retry')}</Text>
                </Pressable>
                {!offline && !clientIdentityRef && (
                  <Pressable
                    haptic="light"
                    onPress={() => setShowFallback(true)}
                    style={styles.fallbackButton}>
                    <Maximize2 color={palette.ink} size={17} />
                    <Text style={styles.fallbackText}>{t('viewer.firstPage')}</Text>
                  </Pressable>
                )}
              </View>
            </View>
          ) : (
            <View style={styles.loadingState}>
              <ActivityIndicator color={palette.lime} size="large" />
              <Text style={styles.loadingTitle}>{t('viewer.opening')}</Text>
              <Text style={styles.loadingCopy}>
                {downloadProgress !== null && downloadProgress > 0
                  ? t('viewer.downloaded', {
                      progress: formatNumber(Math.round(downloadProgress * 100)),
                    })
                  : t('viewer.preparingSecure')}
              </Text>
            </View>
          )}
        </View>

        {previewKind === 'pdf' && !usingFallback && !loadError && (
          <View style={[styles.footer, { bottom: insets.bottom }]}>
            <View style={styles.pageControls}>
              <Pressable
                accessibilityLabel={t('viewer.previousPage')}
                disabled={page <= 1}
                haptic="selection"
                onPress={() => goToPage(page - 1)}
                style={[styles.pageButton, page <= 1 && styles.controlDisabled]}>
                <ChevronLeft color={palette.ink} size={22} />
              </Pressable>
              <Text accessibilityLiveRegion="polite" style={styles.pageCount}>
                {formatNumber(page)} / {formatNumber(pageCount)}
              </Text>
              <Pressable
                accessibilityLabel={t('viewer.nextPage')}
                disabled={page >= pageCount}
                haptic="selection"
                onPress={() => goToPage(page + 1)}
                style={[styles.pageButton, page >= pageCount && styles.controlDisabled]}>
                <ChevronRight color={palette.ink} size={22} />
              </Pressable>
            </View>
            <Animated.Text style={[styles.hint, { opacity: hintOpacity }]}>
              {t('viewer.zoomHint')}
            </Animated.Text>
          </View>
        )}
      </View>
    </Modal>
  );
}

function ViewerSearchStatus({
  activeIndex,
  busy,
  onNext,
  onPrevious,
  result,
}: {
  activeIndex: number;
  busy: boolean;
  onNext: () => void;
  onPrevious: () => void;
  result: ViewerSearchResult | null;
}) {
  const { formatNumber, t } = useI18n();
  if (busy) {
    return <Text accessibilityLiveRegion="polite" style={styles.searchHelp}>{t('viewer.searching')}</Text>;
  }
  if (!result || result.status === 'empty-query') {
    return <Text style={styles.searchHelp}>{t('viewer.searchHelp')}</Text>;
  }
  if (result.status === 'no-searchable-text') {
    return (
      <View accessibilityLiveRegion="polite">
        <Text style={styles.searchUnavailable}>{t('viewer.searchUnavailable')}</Text>
        <Text style={styles.searchSourceUnavailable}>{t('viewer.searchSourceUnavailable')}</Text>
      </View>
    );
  }
  if (!result.matches.length) {
    return (
      <Text accessibilityLiveRegion="polite" style={styles.searchHelp}>
        {t('viewer.noMatches')}
      </Text>
    );
  }
  const match: ViewerSearchMatch = result.matches[activeIndex] ?? result.matches[0];
  return (
    <View style={styles.searchResult}>
      <Text accessibilityLiveRegion="polite" style={styles.searchCount}>
        {t('viewer.matchStatus', {
          current: formatNumber(activeIndex + 1),
          total: formatNumber(result.matches.length),
          page: formatNumber(match.page),
          truncated: result.truncated
            ? t('viewer.firstMatches', { count: formatNumber(2000) })
            : '',
        })}
      </Text>
      <Text numberOfLines={2} style={styles.searchSnippet}>
        {match.snippetBefore}
        <Text style={styles.searchHighlight}>{match.snippetMatch}</Text>
        {match.snippetAfter}
      </Text>
      <View style={styles.searchNavigation}>
        <Pressable accessibilityLabel={t('viewer.previousMatch')} onPress={onPrevious} style={styles.searchNavButton}>
          <ChevronLeft color={palette.ink} size={19} />
        </Pressable>
        <Pressable accessibilityLabel={t('viewer.nextMatch')} onPress={onNext} style={styles.searchNavButton}>
          <ChevronRight color={palette.ink} size={19} />
        </Pressable>
      </View>
    </View>
  );
}

function FallbackPreview({
  available,
  clientIdentityRef,
  offline,
  onRetry,
  representationSupported,
  source,
}: {
  available: boolean;
  clientIdentityRef?: string;
  offline: boolean;
  onRetry: () => void;
  representationSupported: boolean;
  source: DocumentPreviewViewerProps['fallbackSource'];
}) {
  const { t } = useI18n();
  if (!representationSupported || !source) {
    return (
      <View style={styles.fallbackStage}>
        <View style={styles.fallbackNotice}>
          <Text style={styles.fallbackNoticeTitle}>{t('viewer.representationUnsupported')}</Text>
          <Text style={styles.fallbackNoticeCopy}>{t('viewer.representationUnsupportedCopy')}</Text>
        </View>
      </View>
    );
  }
  if (offline) {
    return (
      <View style={styles.fallbackStage}>
        <View style={styles.fallbackNotice}>
          <Text style={styles.fallbackNoticeTitle}>{t('viewer.offlineRendererUnavailable')}</Text>
          <Text style={styles.fallbackNoticeCopy}>{t('viewer.offlineRendererUnavailableCopy')}</Text>
        </View>
      </View>
    );
  }
  if (clientIdentityRef) {
    return (
      <View style={styles.fallbackStage}>
        <View style={styles.fallbackNotice}>
          <Text style={styles.fallbackNoticeTitle}>{t('viewer.mtlsRendererRequired')}</Text>
          <Text style={styles.fallbackNoticeCopy}>{t('viewer.mtlsRendererRequiredCopy')}</Text>
          {available && (
            <Pressable haptic="light" onPress={onRetry} style={styles.fallbackRetry}>
              <RotateCcw color={palette.onDark} size={15} />
              <Text style={styles.fallbackRetryText}>{t('viewer.retryPdf')}</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }
  return (
    <View style={styles.fallbackStage}>
      <Image
        accessibilityLabel={t('viewer.firstPageAccessibility')}
        cachePolicy="memory-disk"
        contentFit="contain"
        priority="high"
        source={source}
        style={styles.fallbackImage}
        transition={120}
      />
      <View style={styles.fallbackNotice}>
        <Text style={styles.fallbackNoticeTitle}>
          {available ? t('viewer.showingFirst') : t('viewer.unavailable')}
        </Text>
        <Text style={styles.fallbackNoticeCopy}>
          {available
            ? t('viewer.renderError')
            : t('viewer.installBuild')}
        </Text>
        {available && (
          <Pressable haptic="light" onPress={onRetry} style={styles.fallbackRetry}>
            <RotateCcw color={palette.onDark} size={15} />
            <Text style={styles.fallbackRetryText}>{t('viewer.retryPdf')}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: palette.canvas,
  },
  header: {
    position: 'absolute',
    zIndex: 100,
    elevation: 100,
    top: 0,
    right: 0,
    left: 0,
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    backgroundColor: palette.canvas,
  },
  roundButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.paper,
  },
  titleBlock: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  title: {
    maxWidth: '100%',
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '800',
  },
  pageMeta: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '600',
    marginTop: 3,
  },
  headerSpacer: {
    width: 46,
  },
  searchPanel: {
    position: 'absolute',
    zIndex: 90,
    elevation: 90,
    right: 12,
    left: 12,
    minHeight: 120,
    padding: 12,
    borderRadius: radii.md,
    backgroundColor: palette.paper,
  },
  searchInputRow: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 12,
    borderRadius: radii.sm,
    backgroundColor: palette.canvas,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 16,
    paddingVertical: 8,
  },
  searchHelp: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 10,
  },
  searchUnavailable: {
    color: palette.danger,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 10,
  },
  searchSourceUnavailable: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 9,
    lineHeight: 14,
    marginTop: 3,
  },
  searchResult: {
    position: 'relative',
    minHeight: 90,
    paddingTop: 9,
    paddingRight: 78,
  },
  searchCount: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '800',
  },
  searchSnippet: {
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 4,
  },
  searchHighlight: {
    color: palette.accentInk,
    backgroundColor: palette.lime,
    fontWeight: '900',
  },
  searchNavigation: {
    position: 'absolute',
    top: 10,
    right: 0,
    flexDirection: 'row',
    gap: 4,
  },
  searchNavButton: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 11,
    backgroundColor: palette.canvas,
  },
  stage: {
    zIndex: 1,
    flex: 1,
    overflow: 'hidden',
    backgroundColor: palette.viewerSurface,
  },
  pdf: {
    flex: 1,
    width: '100%',
    backgroundColor: palette.viewerSurface,
  },
  pdfLoader: {
    backgroundColor: palette.viewerSurface,
  },
  loadingState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    backgroundColor: palette.viewerSurface,
  },
  loadingTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 15,
    fontWeight: '800',
    marginTop: 18,
  },
  loadingCopy: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 11,
    marginTop: 7,
  },
  errorState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 34,
  },
  errorIcon: {
    width: 58,
    height: 58,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.dangerSurface,
  },
  errorTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 18,
    fontWeight: '900',
    marginTop: 20,
  },
  errorCopy: {
    maxWidth: 330,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: 9,
  },
  errorActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 24,
  },
  retryButton: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 17,
    borderRadius: radii.sm,
    backgroundColor: palette.lime,
  },
  retryText: {
    color: palette.accentInk,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '800',
  },
  fallbackButton: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 17,
    borderRadius: radii.sm,
    backgroundColor: palette.paper,
  },
  fallbackText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '800',
  },
  footer: {
    position: 'absolute',
    zIndex: 100,
    elevation: 100,
    right: 0,
    bottom: 0,
    left: 0,
    height: 88,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 8,
    paddingBottom: 6,
    backgroundColor: palette.canvas,
  },
  pageControls: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.pill,
    backgroundColor: palette.paper,
  },
  pageButton: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlDisabled: {
    opacity: 0.28,
  },
  pageCount: {
    minWidth: 72,
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
  },
  hint: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '600',
    marginTop: 7,
  },
  fallbackStage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 18,
  },
  fallbackImage: {
    width: '100%',
    height: '100%',
  },
  fallbackNotice: {
    position: 'absolute',
    right: 18,
    bottom: 18,
    left: 18,
    padding: 14,
    borderRadius: radii.md,
    backgroundColor: palette.inverseScrim,
  },
  fallbackNoticeTitle: {
    color: palette.onDark,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '800',
  },
  fallbackNoticeCopy: {
    color: palette.onDark,
    fontFamily: fonts.sans,
    fontSize: 10,
    lineHeight: 15,
    marginTop: 4,
  },
  fallbackRetry: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    alignSelf: 'flex-start',
    paddingHorizontal: 13,
    borderRadius: radii.sm,
    backgroundColor: palette.inverseSurface,
    marginTop: 12,
  },
  fallbackRetryText: {
    color: palette.onDark,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '800',
  },
});
