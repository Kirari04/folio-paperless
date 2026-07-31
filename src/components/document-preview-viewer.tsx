import { Image } from 'expo-image';
import { File, Paths } from 'expo-file-system';
import { StatusBar } from 'expo-status-bar';
import {
  ChevronLeft,
  ChevronRight,
  FileWarning,
  Maximize2,
  RotateCcw,
  X,
} from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Modal,
  Platform,
  StyleSheet,
  Text,
  UIManager,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PdfRef } from 'react-native-pdf';

import {
  MotionPressable as Pressable,
  useReducedMotion,
} from '@/components/motion';
import { fonts, palette, radii } from '@/constants/theme';

type PdfComponent = typeof import('react-native-pdf').default;

type DocumentPreviewViewerProps = {
  cacheKey: string;
  fallbackSource: {
    headers: Record<string, string>;
    uri: string;
  };
  headers: Record<string, string>;
  onClose: () => void;
  pageCount: number;
  title: string;
  uri: string;
  visible: boolean;
};

const viewerBackground = '#0B0F0C';
const viewerSurface = '#171D19';
const viewerMuted = '#AEB6B0';

export function DocumentPreviewViewer({
  cacheKey,
  fallbackSource,
  headers,
  onClose,
  pageCount: pageCountHint,
  title,
  uri,
  visible,
}: DocumentPreviewViewerProps) {
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const pdfRef = useRef<PdfRef | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [PdfView, setPdfView] = useState<PdfComponent | null>(null);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(Math.max(1, pageCountHint));
  const [loadError, setLoadError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [showFallback, setShowFallback] = useState(false);
  const [localPdfUri, setLocalPdfUri] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [hintOpacity] = useState(() => new Animated.Value(1));
  const nativePdfAvailable =
    Platform.OS !== 'web' && !!UIManager.getViewManagerConfig?.('RNPDFPdfView');

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
    if (!visible || !nativePdfAvailable) return;
    const controller = new AbortController();
    let mounted = true;
    let reportedProgress = -1;
    const destination = new File(Paths.cache, `${cacheKey}-preview.pdf`);

    const downloadFrame = requestAnimationFrame(() => {
      setLocalPdfUri(null);
      setDownloadProgress(null);
      void (async () => {
        try {
          const cacheAge = destination.lastModified
            ? Date.now() - destination.lastModified
            : Number.POSITIVE_INFINITY;
          if (destination.exists && destination.size > 1024 && cacheAge < 60 * 60 * 1000) {
            if (mounted) setLocalPdfUri(destination.uri);
            return;
          }

          const file = await File.downloadFileAsync(uri, destination, {
            headers,
            idempotent: true,
            signal: controller.signal,
            onProgress: ({ bytesWritten, totalBytes }) => {
              if (!mounted || totalBytes <= 0) return;
              const nextProgress = Math.min(1, bytesWritten / totalBytes);
              const roundedProgress = Math.floor(nextProgress * 20) / 20;
              if (roundedProgress === reportedProgress) return;
              reportedProgress = roundedProgress;
              setDownloadProgress(roundedProgress);
            },
          });
          if (!mounted) return;
          setDownloadProgress(1);
          setLocalPdfUri(file.uri);
        } catch (error) {
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
  }, [cacheKey, headers, nativePdfAvailable, retryKey, uri, visible]);

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

  function goToPage(nextPage: number) {
    const boundedPage = Math.min(pageCount, Math.max(1, nextPage));
    if (boundedPage === page) return;
    pdfRef.current?.setPage(boundedPage);
    setPage(boundedPage);
  }

  function retry() {
    setLoadError(false);
    setShowFallback(false);
    setLocalPdfUri(null);
    setRetryKey((key) => key + 1);
  }

  const usingFallback = showFallback || !nativePdfAvailable;

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
      <StatusBar style="light" />
      <View style={styles.root}>
        <View style={[styles.header, { top: insets.top }]}>
          <Pressable
            accessibilityLabel="Close document preview"
            haptic="light"
            onPress={onClose}
            style={styles.roundButton}>
            <X color={palette.paperStrong} size={21} />
          </Pressable>
          <View style={styles.titleBlock}>
            <Text numberOfLines={1} style={styles.title}>
              {title}
            </Text>
            <Text style={styles.pageMeta}>
              {usingFallback ? 'First-page preview' : `Page ${page} of ${pageCount}`}
            </Text>
          </View>
          <View style={styles.headerSpacer} />
        </View>

        <View
          accessibilityLabel={`Full preview of ${title}`}
          accessibilityViewIsModal
          style={[
            styles.stage,
            { marginTop: insets.top + 64, marginBottom: insets.bottom + 88 },
          ]}>
          {usingFallback ? (
            <FallbackPreview
              available={nativePdfAvailable}
              onRetry={retry}
              source={fallbackSource}
            />
          ) : PdfView && localPdfUri && !loadError ? (
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
                  <Text style={styles.loadingTitle}>Opening document</Text>
                  <Text style={styles.loadingCopy}>
                    {progress > 0 ? `${Math.round(progress * 100)}% downloaded` : 'Preparing preview…'}
                  </Text>
                </View>
              )}
              showsHorizontalScrollIndicator={false}
              showsVerticalScrollIndicator={false}
              source={{ uri: localPdfUri }}
              spacing={14}
              style={styles.pdf}
              trustAllCerts={false}
            />
          ) : loadError ? (
            <View style={styles.errorState}>
              <View style={styles.errorIcon}>
                <FileWarning color={palette.apricot} size={26} />
              </View>
              <Text style={styles.errorTitle}>Preview could not be opened</Text>
              <Text style={styles.errorCopy}>
                Paperless did not return a readable PDF. You can retry or open the first-page preview.
              </Text>
              <View style={styles.errorActions}>
                <Pressable haptic="light" onPress={retry} style={styles.retryButton}>
                  <RotateCcw color={palette.ink} size={17} />
                  <Text style={styles.retryText}>Try again</Text>
                </Pressable>
                <Pressable
                  haptic="light"
                  onPress={() => setShowFallback(true)}
                  style={styles.fallbackButton}>
                  <Maximize2 color={palette.paperStrong} size={17} />
                  <Text style={styles.fallbackText}>First page</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <View style={styles.loadingState}>
              <ActivityIndicator color={palette.lime} size="large" />
              <Text style={styles.loadingTitle}>Opening document</Text>
              <Text style={styles.loadingCopy}>
                {downloadProgress !== null && downloadProgress > 0
                  ? `${Math.round(downloadProgress * 100)}% downloaded`
                  : 'Preparing secure preview…'}
              </Text>
            </View>
          )}
        </View>

        {!usingFallback && !loadError && (
          <View style={[styles.footer, { bottom: insets.bottom }]}>
            <View style={styles.pageControls}>
              <Pressable
                accessibilityLabel="Previous page"
                disabled={page <= 1}
                haptic="selection"
                onPress={() => goToPage(page - 1)}
                style={[styles.pageButton, page <= 1 && styles.controlDisabled]}>
                <ChevronLeft color={palette.paperStrong} size={22} />
              </Pressable>
              <Text accessibilityLiveRegion="polite" style={styles.pageCount}>
                {page} / {pageCount}
              </Text>
              <Pressable
                accessibilityLabel="Next page"
                disabled={page >= pageCount}
                haptic="selection"
                onPress={() => goToPage(page + 1)}
                style={[styles.pageButton, page >= pageCount && styles.controlDisabled]}>
                <ChevronRight color={palette.paperStrong} size={22} />
              </Pressable>
            </View>
            <Animated.Text style={[styles.hint, { opacity: hintOpacity }]}>
              Pinch to zoom · Double-tap to zoom
            </Animated.Text>
          </View>
        )}
      </View>
    </Modal>
  );
}

function FallbackPreview({
  available,
  onRetry,
  source,
}: {
  available: boolean;
  onRetry: () => void;
  source: DocumentPreviewViewerProps['fallbackSource'];
}) {
  return (
    <View style={styles.fallbackStage}>
      <Image
        accessibilityLabel="First page of the document"
        cachePolicy="memory-disk"
        contentFit="contain"
        priority="high"
        source={source}
        style={styles.fallbackImage}
        transition={120}
      />
      <View style={styles.fallbackNotice}>
        <Text style={styles.fallbackNoticeTitle}>
          {available ? 'Showing the first page' : 'Full PDF viewer unavailable'}
        </Text>
        <Text style={styles.fallbackNoticeCopy}>
          {available
            ? 'The full PDF could not be rendered.'
            : 'Install the updated Folio development build for pages and native pinch zoom.'}
        </Text>
        {available && (
          <Pressable haptic="light" onPress={onRetry} style={styles.fallbackRetry}>
            <RotateCcw color={palette.paperStrong} size={15} />
            <Text style={styles.fallbackRetryText}>Retry PDF</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: viewerBackground,
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
    backgroundColor: viewerBackground,
  },
  roundButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: viewerSurface,
  },
  titleBlock: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 12,
  },
  title: {
    maxWidth: '100%',
    color: palette.paperStrong,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '800',
  },
  pageMeta: {
    color: viewerMuted,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '600',
    marginTop: 3,
  },
  headerSpacer: {
    width: 46,
  },
  stage: {
    zIndex: 1,
    flex: 1,
    overflow: 'hidden',
    backgroundColor: viewerSurface,
  },
  pdf: {
    flex: 1,
    width: '100%',
    backgroundColor: viewerSurface,
  },
  pdfLoader: {
    backgroundColor: viewerSurface,
  },
  loadingState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    backgroundColor: viewerSurface,
  },
  loadingTitle: {
    color: palette.paperStrong,
    fontFamily: fonts.sans,
    fontSize: 15,
    fontWeight: '800',
    marginTop: 18,
  },
  loadingCopy: {
    color: viewerMuted,
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
    backgroundColor: '#31251B',
  },
  errorTitle: {
    color: palette.paperStrong,
    fontFamily: fonts.sans,
    fontSize: 18,
    fontWeight: '900',
    marginTop: 20,
  },
  errorCopy: {
    maxWidth: 330,
    color: viewerMuted,
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
    color: palette.ink,
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
    backgroundColor: '#273029',
  },
  fallbackText: {
    color: palette.paperStrong,
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
    backgroundColor: viewerBackground,
  },
  pageControls: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.pill,
    backgroundColor: viewerSurface,
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
    color: palette.paperStrong,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
  },
  hint: {
    color: viewerMuted,
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
    backgroundColor: 'rgba(11,15,12,0.92)',
  },
  fallbackNoticeTitle: {
    color: palette.paperStrong,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '800',
  },
  fallbackNoticeCopy: {
    color: viewerMuted,
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
    backgroundColor: '#273029',
    marginTop: 12,
  },
  fallbackRetryText: {
    color: palette.paperStrong,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '800',
  },
});
