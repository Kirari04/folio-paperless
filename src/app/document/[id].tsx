import { Image } from 'expo-image';
import {
  ArrowLeft,
  CalendarDays,
  Check,
  ChevronRight,
  CircleAlert,
  Download,
  Edit3,
  FileText,
  FolderArchive,
  Maximize2,
  MoreHorizontal,
  RefreshCw,
  Share2,
  Sparkles,
  Tag,
  Trash2,
  UserRound,
} from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  Easing,
  Share,
  Text,
  View,
  type ColorValue,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppShell } from '@/components/app-shell';
import { ChoiceSheet } from '@/components/choice-sheet';
import { DocumentDeepSections } from '@/components/document-deep-sections';
import {
  DocumentFileActions,
  type DocumentFileActionIntent,
  type RepresentationPreviewRequest,
} from '@/components/document-file-actions';
import { DocumentPaperless3Workspace } from '@/components/document-paperless3-workspace';
import { DocumentPreviewViewer } from '@/components/document-preview-viewer';
import { viewerCacheFilename } from '@/lib/temporary-file-policy';
import { PaperThumbnail } from '@/components/paper-thumbnail';
import { TextEditSheet } from '@/components/text-edit-sheet';
import {
  MotionPressable as Pressable,
  animateLayout,
  hapticFeedback,
  useReducedMotion,
} from '@/components/motion';
import { createThemedStyleSheet, fonts, maxContentWidth, palette, radii, shadows } from '@/constants/theme';
import { useApp, useDocumentDetail } from '@/context/app-context';
import { useI18n } from '@/i18n';
import { presentRuntimeError, presentRuntimeMessage } from '@/i18n/error-presentation';
import {
  findRoutedDocument,
  isPendingDocument,
  taskIdFromPlaceholderId,
} from '@/lib/document-routing';
import {
  getPaperlessDocumentUrl,
  paperlessCredentialFileHeaders,
  usesNativeMutualTls,
} from '@/lib/paperless';
import { useLocalSearchParams, useRouter } from '@/lib/router';
import { isValidIsoDate } from '@/lib/validation';
import { deriveSearchablePdfPages } from '@/lib/viewer-search';
import type { PaperlessCredentials } from '@/types/document';

type PickerKind = 'correspondent' | 'documentType' | 'tags' | null;

type ToastState = {
  message: string;
  error?: boolean;
};

type DocumentDetailScreenProps = {
  active?: boolean;
  documentFrom?: string;
  documentId?: string;
};

const credentialBindingGenerations = new WeakMap<PaperlessCredentials, number>();
let nextCredentialBindingGeneration = 1;

function credentialBindingGeneration(credentials: PaperlessCredentials | null) {
  if (!credentials) return 0;
  const existing = credentialBindingGenerations.get(credentials);
  if (existing !== undefined) return existing;
  const generation = nextCredentialBindingGeneration++;
  credentialBindingGenerations.set(credentials, generation);
  return generation;
}

export default function DocumentDetailScreen(props: DocumentDetailScreenProps = {}) {
  const { activeProfile, credentials } = useApp();
  // Navigation intentionally retains same-ID document routes. Bind the retained
  // shell to the credential object by identity without putting secrets in a key.
  const profileBindingKey = `${activeProfile?.id ?? 'none'}:${credentialBindingGeneration(credentials)}`;
  return <ProfileBoundDocumentDetailScreen key={profileBindingKey} profileBindingKey={profileBindingKey} {...props} />;
}

function ProfileBoundDocumentDetailScreen({
  active = true,
  documentFrom,
  documentId,
  profileBindingKey,
}: DocumentDetailScreenProps & { profileBindingKey: string }) {
  const routeParams = useLocalSearchParams<{ id?: string; from?: string }>();
  const requestedId = documentId || routeParams.id || '';
  const from = documentFrom || routeParams.from;
  const router = useRouter();
  const { formatDocumentDate, formatFileSize, formatNumber, t } = useI18n();
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const {
    documents,
    credentials,
    activeProfile,
    catalog,
    creationCapabilities,
    isSyncing,
    approveDocument,
    updateDocument,
    createCatalogOption,
    deleteDocument,
    reprocessDocument,
    retryDocumentProcessing,
    refresh,
    resolveDocumentId,
    shareDocument: shareDocumentFile,
  } = useApp();
  const resolvedId = resolveDocumentId(requestedId);
  const listDocument = findRoutedDocument(documents, requestedId, resolvedId);
  const id = listDocument?.id || resolvedId;
  const {
    document: detailedDocument,
    loadDocumentDetails,
    version: documentDetailsVersion,
  } = useDocumentDetail(id);
  const document = detailedDocument || listDocument;
  const credentialsMatchActiveProfile = credentials === null
    || credentials.profileId === activeProfile?.id;
  const activeCredentials = credentialsMatchActiveProfile ? credentials : null;
  const requestedTaskId = taskIdFromPlaceholderId(requestedId);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(document?.title || '');
  const [created, setCreated] = useState(document?.created || '');
  const [editingDate, setEditingDate] = useState(false);
  const [expandedText, setExpandedText] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewRequest, setPreviewRequest] = useState<RepresentationPreviewRequest | null>(null);
  const [fileActions, setFileActions] = useState<DocumentFileActionIntent | null>(null);
  const [paperlessToolsOpen, setPaperlessToolsOpen] = useState(false);
  const [picker, setPicker] = useState<PickerKind>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<number | string | undefined>();
  const [previewReady, setPreviewReady] = useState(false);
  const [screenOpacity] = useState(() => new Animated.Value(0));
  const detailLoadSignature = useRef<string | null>(null);
  const presentedDocumentId = useRef({
    profileBindingKey,
    documentId: document?.id,
  });
  const closing = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewVersionId = typeof selectedVersionId === 'number' ? selectedVersionId : undefined;
  const canOpenPreview = previewReady && !!activeCredentials && !!document?.remoteId;
  const documentRefreshing = busyAction === 'refresh' || isSyncing;
  const credentialFileHeaders = useMemo(
    () => activeCredentials ? paperlessCredentialFileHeaders(activeCredentials) : {},
    [activeCredentials],
  );
  const previewCacheKey = document?.remoteId
    ? viewerCacheFilename({
        documentId: document.remoteId,
        representation: previewRequest?.representation || 'server',
        versionId: previewVersionId,
        detailsRevision: documentDetailsVersion,
      }).replace(/\.pdf$/, '')
    : 'unavailable';

  const closeDocument = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    if (reducedMotion) {
      router.back();
      return;
    }
    Animated.timing(screenOpacity, {
      toValue: 0,
      duration: 110,
      easing: Easing.bezier(0.4, 0, 1, 1),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) router.back();
      else closing.current = false;
    });
  }, [reducedMotion, router, screenOpacity]);

  function showToast(message: string, error = false) {
    animateLayout();
    setToast({ message, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => {
      animateLayout();
      setToast(null);
    }, error ? 3500 : 2200);
  }

  useEffect(() => {
    if (!active) return;
    closing.current = false;
    screenOpacity.stopAnimation();
    if (reducedMotion) {
      screenOpacity.setValue(1);
      return;
    }
    Animated.timing(screenOpacity, {
      toValue: 1,
      duration: 130,
      easing: Easing.bezier(0.16, 1, 0.3, 1),
      useNativeDriver: true,
    }).start();
  }, [active, reducedMotion, screenOpacity]);

  useEffect(() => {
    if (!active) return;
    const backSubscription = BackHandler.addEventListener('hardwareBackPress', () => {
      closeDocument();
      return true;
    });
    return () => {
      backSubscription.remove();
      screenOpacity.stopAnimation();
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, [active, closeDocument, screenOpacity]);

  useEffect(() => {
    if (!active || previewReady) return;
    let mounted = true;
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (!mounted) return;
        setPreviewReady(true);
      });
    });
    return () => {
      mounted = false;
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [active, previewReady]);

  useEffect(() => {
    const loadSignature = `${profileBindingKey}:${id}:${documentDetailsVersion}`;
    if (
      !active ||
      !previewReady ||
      !credentialsMatchActiveProfile ||
      !listDocument?.remoteId ||
      detailLoadSignature.current === loadSignature
    ) return;
    let mounted = true;
    detailLoadSignature.current = loadSignature;
    void loadDocumentDetails(id).catch((error) => {
      if (mounted) {
        showToast(presentRuntimeError(error, t('detail.metadataError')), true);
      }
    });
    return () => {
      mounted = false;
    };
  }, [active, credentialsMatchActiveProfile, documentDetailsVersion, id, listDocument?.remoteId, loadDocumentDetails, previewReady, profileBindingKey, t]);

  useEffect(() => {
    if (
      !document
      || (
        presentedDocumentId.current.profileBindingKey === profileBindingKey
        && presentedDocumentId.current.documentId === document.id
      )
    ) return;
    const finishedProcessing = Boolean(
      presentedDocumentId.current.profileBindingKey === profileBindingKey &&
        presentedDocumentId.current.documentId &&
        taskIdFromPlaceholderId(presentedDocumentId.current.documentId) &&
        !isPendingDocument(document),
    );
    presentedDocumentId.current = {
      profileBindingKey,
      documentId: document.id,
    };
    if (finishedProcessing) {
      animateLayout();
      showToast(t('detail.readyReview'));
    }
    setTitle(document.title);
    setCreated(document.created);
    setEditing(false);
    setEditingDate(false);
    setExpandedText(false);
    setPreviewFailed(false);
    setPreviewOpen(false);
    setPreviewRequest(null);
    setFileActions(null);
    setPaperlessToolsOpen(false);
    setPicker(null);
    setMoreOpen(false);
    setSelectedVersionId(undefined);
  }, [document, profileBindingKey, t]);

  useEffect(() => {
    if (!active || document || !requestedTaskId) return;
    router.replace('/inbox');
  }, [active, document, requestedTaskId, router]);

  if (!document && requestedTaskId) {
    return (
      <View accessibilityLiveRegion="polite" style={styles.notFound}>
        <ActivityIndicator color={palette.ink} size="large" />
        <Text style={styles.notFoundTitle}>{t('detail.finalizing')}</Text>
        <Text style={styles.transitionCopy}>{t('detail.finalizingCopy')}</Text>
      </View>
    );
  }

  if (!document) {
    return (
      <View style={styles.notFound}>
        <FileText color={palette.ink} size={34} />
        <Text style={styles.notFoundTitle}>{t('detail.notFound')}</Text>
        <Pressable onPress={() => router.replace('/documents')}>
          <Text style={styles.backLink}>{t('detail.backLibrary')}</Text>
        </Pressable>
      </View>
    );
  }

  async function shareDocument() {
    if (!document) return;
    setBusyAction('share');
    try {
      if (document.remoteId) {
        await shareDocumentFile(
          document.id,
          typeof selectedVersionId === 'number' ? selectedVersionId : undefined,
        );
      } else {
        await Share.share({
          title,
          message: `${title}\n${document.correspondent}\n\n${t('detail.sharedFrom')}`,
        });
      }
    } catch (error) {
      showToast(presentRuntimeError(error, t('detail.shareError')), true);
    } finally {
      setBusyAction(null);
    }
  }

  async function saveTitle(nextValue: string) {
    const nextTitle = nextValue.trim();
    setBusyAction('title');
    try {
      await updateDocument(id, { title: nextTitle });
      setTitle(nextTitle);
      showToast(t('detail.titleUpdated'));
    } catch (error) {
      const message = presentRuntimeError(error, t('detail.titleError'));
      showToast(message, true);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setBusyAction(null);
    }
  }

  async function saveCreatedDate(nextValue: string) {
    const nextCreated = nextValue.trim();
    setBusyAction('date');
    try {
      await updateDocument(id, { created: nextCreated });
      setCreated(nextCreated);
      showToast(t('detail.dateUpdated'));
    } catch (error) {
      const message = presentRuntimeError(error, t('detail.dateError'));
      showToast(message, true);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setBusyAction(null);
    }
  }

  async function toggleFullText() {
    if (expandedText) {
      setExpandedText(false);
      return;
    }
    setBusyAction('ocr');
    try {
      await loadDocumentDetails(id);
      setExpandedText(true);
    } catch (error) {
      showToast(presentRuntimeError(error, t('detail.textError')), true);
    } finally {
      setBusyAction(null);
    }
  }

  async function fileDocument() {
    if (!document) return;
    setBusyAction('file');
    try {
      await approveDocument(document.id);
      await hapticFeedback('confirm');
      router.replace('/inbox');
    } catch (error) {
      showToast(presentRuntimeError(error, t('detail.fileError')), true);
    } finally {
      setBusyAction(null);
    }
  }

  async function reprocess() {
    setMoreOpen(false);
    setBusyAction('reprocess');
    try {
      await reprocessDocument(id);
      showToast(t('detail.reprocessStarted'));
    } catch (error) {
      showToast(presentRuntimeError(error, t('detail.reprocessError')), true);
    } finally {
      setBusyAction(null);
    }
  }

  async function refreshDocument() {
    if (documentRefreshing) return;
    setMoreOpen(false);
    setBusyAction('refresh');
    setPreviewFailed(false);
    try {
      await refresh();
      const refreshedDocument = await loadDocumentDetails(id);
      if (refreshedDocument) {
        setTitle(refreshedDocument.title);
        setCreated(refreshedDocument.created);
        if (
          selectedVersionId !== undefined &&
          !refreshedDocument.versions?.some((version) => version.id === selectedVersionId)
        ) {
          setSelectedVersionId(undefined);
        }
      }
      showToast(t('detail.refreshed'));
    } catch (error) {
      showToast(presentRuntimeError(error, t('detail.refreshError')), true);
    } finally {
      setBusyAction(null);
    }
  }

  async function checkProcessing() {
    setBusyAction('processing-refresh');
    try {
      await retryDocumentProcessing(id);
    } catch (error) {
      showToast(presentRuntimeError(error, t('detail.processingCheckError')), true);
    } finally {
      setBusyAction(null);
    }
  }

  function confirmDelete() {
    setMoreOpen(false);
    Alert.alert(
      t('detail.deleteTitle'),
      t('detail.deleteBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            setBusyAction('delete');
            deleteDocument(id)
              .then(() => router.replace('/documents'))
              .catch((error) =>
                showToast(presentRuntimeError(error, t('detail.deleteError')), true),
              )
              .finally(() => setBusyAction(null));
          },
        },
      ],
    );
  }

  if (isPendingDocument(document)) {
    const processingFailed = Boolean(document.processingError);
    return (
      <Animated.View style={[styles.root, { opacity: screenOpacity }]}>
        <SafeAreaView edges={['top']} style={styles.safe}>
          <View style={styles.header}>
            <Pressable
              accessibilityLabel={t('detail.goBack')}
              onPress={closeDocument}
              style={styles.headerButton}>
              <ArrowLeft color={palette.ink} size={21} />
            </Pressable>
            <Text style={styles.headerTitle}>
              {processingFailed ? t('detail.processingIssue') : t('detail.processing')}
            </Text>
            <View style={styles.headerSpacer} />
          </View>
        </SafeAreaView>

        <AppShell contentStyle={styles.processingContent} safeTop={false} showNav={false}>
          <View
            accessibilityLabel={
              processingFailed
                ? t('detail.processingFailedLabel', { title: document.title })
                : t('detail.processingLabel', { title: document.title })
            }
            accessibilityLiveRegion="polite"
            style={styles.processingCard}>
            <View
              style={[
                styles.processingPreview,
                { backgroundColor: processingFailed ? palette.dangerSurface : document.color },
              ]}>
              <View style={styles.processingGlow} />
              <PaperThumbnail document={document} width={154} />
              <View
                style={[
                  styles.processingIndicator,
                  processingFailed && styles.processingIndicatorError,
                ]}>
                {processingFailed ? (
                  <CircleAlert color={palette.paper} size={23} />
                ) : (
                  <ActivityIndicator color={palette.ink} size="small" />
                )}
              </View>
            </View>

            <View style={styles.processingBody}>
              <Text style={styles.processingHeading}>
                {processingFailed
                  ? t('detail.processingAttention')
                  : t('detail.gettingReady')}
              </Text>
              <Text style={styles.processingCopy}>
                {processingFailed
                  ? t('detail.processingFailedCopy', { title: document.title })
                  : t('detail.processingCopy', { title: document.title })}
              </Text>

              <View style={styles.processingStatusRow}>
                {processingFailed ? (
                  <CircleAlert color={palette.danger} size={17} />
                ) : (
                  <ActivityIndicator color={palette.limeDark} size="small" />
                )}
                <Text
                  style={[
                    styles.processingStatusText,
                    processingFailed && styles.processingStatusTextError,
                  ]}>
                  {processingFailed
                    ? presentRuntimeMessage(document.processingError!)
                    : t('detail.processingInPaperless')}
                </Text>
              </View>

              <View style={styles.processingFacts}>
                <View style={styles.processingFact}>
                  <FileText color={palette.inkSoft} size={17} />
                  <Text style={styles.processingFactText}>
                    {document.pageCount === 1
                      ? t('detail.pageOne')
                      : t('detail.pageMany', { count: formatNumber(document.pageCount) })}
                  </Text>
                </View>
                <View style={styles.processingFactDivider} />
                <Text style={styles.processingFactText}>
                  {t('detail.uploaded', { date: formatDocumentDate(document.addedAt ?? document.created).toLocaleLowerCase() })}
                </Text>
              </View>

              {processingFailed && (
                <Pressable
                  accessibilityLabel={t('detail.checkStatus', { title: document.title })}
                  disabled={busyAction === 'processing-refresh'}
                  onPress={checkProcessing}
                  style={styles.processingRetry}>
                  {busyAction === 'processing-refresh' ? (
                    <ActivityIndicator color={palette.accentInk} size="small" />
                  ) : (
                    <RefreshCw color={palette.accentInk} size={18} />
                  )}
                  <Text style={styles.processingRetryText}>
                    {busyAction === 'processing-refresh' ? t('detail.checking') : t('detail.checkAgain')}
                  </Text>
                </Pressable>
              )}
            </View>
          </View>

          {!processingFailed && (
            <View style={styles.processingNote}>
              <Check color={palette.limeDark} size={17} />
              <Text style={styles.processingNoteText}>
                {t('detail.leaveProcessing')}
              </Text>
            </View>
          )}
        </AppShell>

        {!!toast && (
          <View
            accessibilityLiveRegion="polite"
            style={[styles.toast, toast.error && styles.toastError]}>
            {toast.error ? (
              <CircleAlert color={palette.paper} size={17} />
            ) : (
              <Check color={palette.lime} size={17} />
            )}
            <Text style={styles.toastText}>{toast.message}</Text>
          </View>
        )}
      </Animated.View>
    );
  }

  return (
    <Animated.View style={[styles.root, { opacity: screenOpacity }]}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <View style={styles.header}>
          <Pressable
            accessibilityLabel={t('detail.goBack')}
            onPress={closeDocument}
            style={styles.headerButton}>
            <ArrowLeft color={palette.ink} size={21} />
          </Pressable>
          <Text pointerEvents="none" style={[styles.headerTitle, styles.headerTitleCentered]}>
            {t('detail.document')}
          </Text>
          <View style={styles.headerActions}>
            <Pressable
              accessibilityHint={t('detail.refreshHint')}
              accessibilityLabel={t('detail.refresh')}
              disabled={documentRefreshing}
              onPress={refreshDocument}
              style={styles.headerButton}>
              {documentRefreshing ? (
                <ActivityIndicator color={palette.ink} size="small" />
              ) : (
                <RefreshCw color={palette.ink} size={20} />
              )}
            </Pressable>
            <Pressable
              accessibilityLabel={t('detail.moreActions')}
              onPress={() => setMoreOpen((open) => !open)}
              style={styles.headerButton}>
              <MoreHorizontal color={palette.ink} size={22} />
            </Pressable>
          </View>
        </View>
      </SafeAreaView>

      {moreOpen && (
        <View style={[styles.moreMenu, { top: insets.top + 51 }]}>
          <Pressable disabled={!document.remoteId} onPress={reprocess} style={styles.moreAction}>
            <RefreshCw color={palette.ink} size={17} />
            <View style={styles.moreCopy}>
              <Text style={styles.moreLabel}>{t('detail.reprocess')}</Text>
              <Text style={styles.moreMeta}>{t('detail.reprocessCopy')}</Text>
            </View>
          </Pressable>
          <Pressable
            disabled={!document.remoteId}
            onPress={() => {
              setMoreOpen(false);
              setPaperlessToolsOpen(true);
            }}
            style={styles.moreAction}>
            <Sparkles color={palette.ink} size={17} />
            <View style={styles.moreCopy}>
              <Text style={styles.moreLabel}>{t('detail.paperlessTools')}</Text>
              <Text style={styles.moreMeta}>{t('detail.paperlessToolsCopy')}</Text>
            </View>
          </Pressable>
          <Pressable onPress={confirmDelete} style={styles.moreAction}>
            <Trash2 color={palette.danger} size={17} />
            <View style={styles.moreCopy}>
              <Text style={[styles.moreLabel, styles.moreDanger]}>{t('detail.delete')}</Text>
              <Text style={styles.moreMeta}>{t('detail.deleteCopy')}</Text>
            </View>
          </Pressable>
        </View>
      )}

      <AppShell
        contentStyle={styles.content}
        onRefresh={() => void refreshDocument()}
        refreshing={documentRefreshing}
        safeTop={false}
        showNav={false}>
        <View style={styles.previewCard}>
          <Pressable
            accessibilityHint={t('detail.previewHint')}
            accessibilityLabel={t('detail.openPreviewOf', { title: document.title })}
            disabled={!canOpenPreview}
            haptic="medium"
            onPress={() => setFileActions('manage')}
            pressedScale={0.99}
            style={[styles.previewBackground, { backgroundColor: document.color }]}>
            {previewReady && !!activeCredentials && !!document.remoteId && !previewFailed
              && !usesNativeMutualTls(activeCredentials) ? (
              <Image
                accessibilityLabel={t('detail.previewOf', { title: document.title })}
                cachePolicy="memory-disk"
                contentFit="contain"
                onError={() => setPreviewFailed(true)}
                source={{
                  uri: getPaperlessDocumentUrl(
                    activeCredentials,
                    document.remoteId,
                    'thumb',
                    typeof selectedVersionId === 'number' ? selectedVersionId : undefined,
                  ),
                  headers: credentialFileHeaders,
                  cacheKey: `folio-thumbnail-${activeProfile?.id ?? 'none'}-${document.remoteId}-${String(selectedVersionId || 'current')}`,
                }}
                key={`${profileBindingKey}:${documentDetailsVersion}:${String(selectedVersionId || 'current')}`}
                style={styles.realPreview}
              />
            ) : (
            <View style={styles.previewPaper}>
              <View style={styles.previewPaperHeader}>
                <View style={[styles.previewLogo, { backgroundColor: document.accent }]} />
                <View>
                  <View style={[styles.previewLine, { width: 82 }]} />
                  <View style={[styles.previewLine, styles.previewLineLight, { width: 52 }]} />
                </View>
              </View>
              <Text style={[styles.previewKind, { color: document.accent }]}>
                {document.documentType.toUpperCase()}
              </Text>
              <View style={styles.previewTotal}>
                <View>
                  <View style={[styles.previewLine, { width: 115 }]} />
                  <View style={[styles.previewLine, styles.previewLineLight, { width: 90 }]} />
                </View>
                <View style={[styles.previewAmount, { backgroundColor: document.color }]} />
              </View>
              {Array.from({ length: 6 }).map((_, index) => (
                <View
                  key={index}
                  style={[
                    styles.previewLine,
                    styles.previewLineLight,
                    { width: `${88 - ((index * 9) % 33)}%` },
                  ]}
                />
              ))}
              <View style={[styles.previewFooter, { backgroundColor: document.accent }]} />
            </View>
            )}
            <View style={styles.previewBadge}>
              <Text style={styles.previewBadgeText}>
                {formatNumber(document.pageCount)}{' '}
                {document.pageCount === 1 ? t('detail.pageCaps') : t('detail.pagesCaps')}
              </Text>
            </View>
            {canOpenPreview && (
              <View pointerEvents="none" style={styles.previewExpand}>
                <Maximize2 color={palette.onDark} size={15} />
                <Text style={styles.previewExpandText}>{t('detail.openPreview')}</Text>
              </View>
            )}
          </Pressable>

          <View style={styles.quickActions}>
            <DocumentAction
              icon={Share2}
              label={t('detail.share')}
              loading={busyAction === 'share'}
              onPress={() => document.remoteId ? setFileActions('share') : void shareDocument()}
            />
            <DocumentAction
              disabled={!document.remoteId}
              icon={Download}
              label={t('detail.download')}
              loading={busyAction === 'download'}
              onPress={() => setFileActions('save')}
            />
            <DocumentAction
              disabled={document.canEdit === false}
              icon={Edit3}
              label={t('detail.edit')}
              onPress={() => setEditing(true)}
            />
          </View>
        </View>

        <View style={styles.titleBlock}>
          <Text style={styles.overline}>{document.documentType.toUpperCase()}</Text>
          <Pressable
            accessibilityHint={t('detail.titleEditorHint')}
            disabled={document.canEdit === false}
            onPress={() => setEditing(true)}
            style={styles.titleRow}>
            <Text style={styles.documentTitle}>{title}</Text>
            <Edit3 color={palette.faint} size={17} />
          </Pressable>
          <Text style={styles.documentSubtitle}>
            {document.correspondent} · {t('detail.added', {
              date: formatDocumentDate(document.addedAt ?? document.created).toLocaleLowerCase(),
            })}
          </Text>
        </View>

        {previewReady && <>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('detail.details')}</Text>
          <View style={styles.detailGroup}>
            <DetailRow
              icon={UserRound}
              label={t('detail.correspondent')}
              onPress={() => setPicker('correspondent')}
              value={document.correspondent}
              color={palette.sky}
            />
            <DetailRow
              icon={FileText}
              label={t('detail.documentType')}
              onPress={() => setPicker('documentType')}
              value={document.documentType}
              color={palette.apricot}
            />
            <DetailRow
              icon={CalendarDays}
              label={t('detail.created')}
              onPress={() => setEditingDate(true)}
              value={created}
              color={palette.lavender}
            />
            <DetailRow
              icon={FolderArchive}
              label={t('detail.file')}
              value={t(document.pageCount === 1 ? 'detail.fileMetaOne' : 'detail.fileMetaMany', {
                size: document.fileSizeBytes
                  ? formatFileSize(document.fileSizeBytes)
                  : document.fileSize,
                count: formatNumber(document.pageCount),
              })}
              color={palette.mint}
            />
          </View>
        </View>

        <DocumentDeepSections
          document={document}
          onSelectVersion={(versionId) => {
            setPreviewFailed(false);
            setSelectedVersionId(versionId);
          }}
          onToast={showToast}
          selectedVersionId={selectedVersionId}
        />

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('detail.tags')}</Text>
          <View style={styles.tagCard}>
            <View style={styles.tagIcon}>
              <Tag color={palette.accentInk} size={18} />
            </View>
            <View style={styles.tags}>
              {document.tags.map((tag, index) => {
                const option = catalog.tags.find((item) => item.id === document.tagIds[index]);
                return (
                <View key={document.tagIds[index] || tag} style={styles.tag}>
                  <Text style={styles.tagText}>{option?.pathLabel || tag}{option?.isInboxTag ? ` · ${t('nav.inbox')}` : ''}</Text>
                </View>
                );
              })}
              {!document.tags.length && <Text style={styles.noTags}>{t('detail.noTags')}</Text>}
              <Pressable onPress={() => setPicker('tags')} style={styles.addTag}>
                <Text style={styles.addTagText}>
                  {document.tags.length ? t('detail.editTags') : t('detail.addTags')}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('detail.extractedText')}</Text>
          <View style={styles.ocrCard}>
            <View style={styles.ocrHeader}>
              <Sparkles color={palette.limeDark} size={16} />
              <Text style={styles.ocrLabel}>{t('detail.ocrSearchable')}</Text>
            </View>
            <Text style={styles.ocrText}>
              {expandedText ? document.fullText || document.excerpt : document.excerpt}
            </Text>
            <Pressable disabled={busyAction === 'ocr'} onPress={toggleFullText}>
              <Text style={styles.readAll}>
                {busyAction === 'ocr'
                  ? t('detail.loadingText')
                  : expandedText
                    ? t('detail.showLess')
                    : t('detail.readFullText')}
              </Text>
            </Pressable>
          </View>
        </View>

        {from === 'inbox' && document.status === 'inbox' && (
          <Pressable
            disabled={busyAction === 'file'}
            onPress={fileDocument}
            style={styles.fileButton}>
            {busyAction === 'file' ? (
              <ActivityIndicator color={palette.accentInk} />
            ) : (
              <Check color={palette.accentInk} size={20} />
            )}
            <Text style={styles.fileButtonText}>{t('detail.fileIt')}</Text>
          </Pressable>
        )}
        </>}
      </AppShell>

      {picker === 'correspondent' && <ChoiceSheet
        allowNone
        createLabel={t('detail.createCorrespondent')}
        creationAllowed={creationCapabilities.correspondent}
        onClose={() => setPicker(null)}
        onConfirm={async (selected) => updateDocument(id, { correspondent: selected[0] || null })}
        onCreate={(name) => createCatalogOption('correspondent', name)}
        options={catalog.correspondents}
        selectedIds={document.correspondentId ? [document.correspondentId] : []}
        title={t('detail.correspondent')}
        visible
      />}
      {picker === 'documentType' && <ChoiceSheet
        allowNone
        createLabel={t('detail.createDocumentType')}
        creationAllowed={creationCapabilities.documentType}
        onClose={() => setPicker(null)}
        onConfirm={async (selected) => updateDocument(id, { documentType: selected[0] || null })}
        onCreate={(name) => createCatalogOption('documentType', name)}
        options={catalog.documentTypes}
        selectedIds={document.documentTypeId ? [document.documentTypeId] : []}
        title={t('detail.documentType')}
        visible
      />}
      {picker === 'tags' && <ChoiceSheet
        createLabel={t('detail.createTag')}
        creationAllowed={creationCapabilities.tag}
        multiple
        onClose={() => setPicker(null)}
        onConfirm={async (selected) => updateDocument(id, { tags: selected })}
        onCreate={(name) => createCatalogOption('tag', name)}
        options={catalog.tags}
        selectedIds={document.tagIds}
        title={t('detail.tags')}
        visible
      />}

      {editing && (
        <TextEditSheet
          editorKey={`${activeProfile?.id || 'none'}:${document.id}:title`}
          label={t('detail.documentTitle')}
          onClose={() => setEditing(false)}
          onSave={saveTitle}
          placeholder={t('detail.documentTitle')}
          required
          saveLabel={t('detail.saveTitle')}
          subtitle={t('detail.titleSubtitle')}
          title={t('detail.editTitle')}
          value={title}
          visible
        />
      )}
      {editingDate && (
        <TextEditSheet
          autoCapitalize="none"
          autoCorrect={false}
          editorKey={`${activeProfile?.id || 'none'}:${document.id}:created`}
          helperText={t('detail.dateHelper')}
          label={t('detail.createdDate')}
          maxLength={10}
          onClose={() => setEditingDate(false)}
          onSave={saveCreatedDate}
          placeholder={t('detail.datePlaceholder')}
          saveLabel={t('detail.saveDate')}
          subtitle={t('detail.dateSubtitle')}
          title={t('detail.editDate')}
          validate={(next) => {
            const normalized = next.trim();
            return isValidIsoDate(normalized) ? null : t('detail.dateValidation');
          }}
          value={created}
          visible
        />
      )}

      {!!activeCredentials && !!activeProfile && !!document.remoteId && (
        <DocumentPreviewViewer
          bindingKey={profileBindingKey}
          cacheKey={previewCacheKey}
          expectedChecksum={previewRequest?.checksum}
          expectedSize={previewRequest?.size}
          fallbackSource={previewRequest
            ? null
            : {
                uri: getPaperlessDocumentUrl(
                  activeCredentials,
                  document.remoteId,
                  'thumb',
                  previewVersionId,
                ),
                headers: credentialFileHeaders,
              }}
          headers={credentialFileHeaders}
          mimeType={previewRequest?.mimeType ?? 'application/pdf'}
          clientIdentityRef={activeCredentials.clientIdentityRef}
          key={`${profileBindingKey}:${previewCacheKey}:${previewRequest ? 'selected' : 'server'}`}
          serverUrl={activeCredentials.serverUrl}
          onClose={() => setPreviewOpen(false)}
          offline={previewRequest?.offline}
          pageCount={document.pageCount}
          profileId={activeProfile.id}
          representation={previewRequest?.representation}
          searchPages={previewVersionId ? null : deriveSearchablePdfPages(document.fullText, document.pageCount)}
          title={title}
          uri={previewRequest?.uri || getPaperlessDocumentUrl(
              activeCredentials,
              document.remoteId,
              'preview',
              previewVersionId,
            )}
          visible={previewOpen}
        />
      )}

      {!!activeCredentials && !!document.remoteId && !!fileActions && (
        <DocumentFileActions
          credentials={activeCredentials}
          document={document}
          intent={fileActions}
          onClose={() => setFileActions(null)}
          onOpenPreview={(request) => {
            setPreviewRequest(request);
            setPreviewFailed(false);
            setPreviewOpen(true);
          }}
          onToast={showToast}
          versionId={previewVersionId}
          visible
        />
      )}

      {!!document.remoteId && paperlessToolsOpen && (
        <DocumentPaperless3Workspace
          catalog={catalog}
          document={document}
          onClose={() => setPaperlessToolsOpen(false)}
          onNavigateDocument={(remoteId) => {
            setPaperlessToolsOpen(false);
            router.push({ pathname: '/document/[id]', params: { id: `remote-${remoteId}` } });
          }}
          onOpenTasks={() => {
            setPaperlessToolsOpen(false);
            router.push('/tasks');
          }}
          onRefresh={refreshDocument}
          onToast={showToast}
          visible
        />
      )}

      {!!toast && (
        <View accessibilityLiveRegion="polite" style={[styles.toast, toast.error && styles.toastError]}>
          {toast.error ? (
            <CircleAlert color={palette.paper} size={17} />
          ) : (
            <Check color={palette.lime} size={17} />
          )}
          <Text style={styles.toastText}>{toast.message}</Text>
        </View>
      )}
    </Animated.View>
  );
}

type ActionIcon = typeof Share2;

function DocumentAction({
  icon: Icon,
  label,
  onPress,
  disabled = false,
  loading = false,
}: {
  icon: ActionIcon;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  return (
    <Pressable
      disabled={disabled || loading}
      onPress={onPress}
      style={[
        styles.action,
        disabled && styles.actionDisabled,
      ]}>
      {loading ? <ActivityIndicator color={palette.ink} size="small" /> : <Icon color={palette.ink} size={19} />}
      <Text style={styles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

function DetailRow({
  icon: Icon,
  label,
  value,
  color,
  onPress,
}: {
  icon: ActionIcon;
  label: string;
  value: string;
  color: ColorValue;
  onPress?: () => void;
}) {
  return (
    <Pressable disabled={!onPress} onPress={onPress} style={styles.detailRow}>
      <View style={[styles.detailIcon, { backgroundColor: color }]}>
        <Icon color={palette.ink} size={18} />
      </View>
      <View style={styles.detailCopy}>
        <Text style={styles.detailLabel}>{label}</Text>
        <Text style={styles.detailValue}>{value}</Text>
      </View>
      {!!onPress && <ChevronRight color={palette.faint} size={17} />}
    </Pressable>
  );
}

const styles = createThemedStyleSheet({
  root: {
    flex: 1,
    backgroundColor: palette.canvas,
  },
  safe: {
    backgroundColor: palette.canvas,
  },
  header: {
    width: '100%',
    maxWidth: maxContentWidth,
    alignSelf: 'center',
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    position: 'relative',
    paddingHorizontal: 20,
  },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: palette.line,
  },
  headerSpacer: {
    width: 40,
    height: 40,
  },
  headerTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '800',
  },
  headerTitleCentered: {
    position: 'absolute',
    left: 112,
    right: 112,
    textAlign: 'center',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  moreMenu: {
    position: 'absolute',
    zIndex: 20,
    top: 51,
    right: 20,
    width: 260,
    padding: 7,
    borderRadius: radii.md,
    backgroundColor: palette.paper,
    ...shadows.lift,
  },
  moreAction: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingHorizontal: 11,
    borderRadius: radii.sm,
  },
  moreCopy: {
    flex: 1,
  },
  moreLabel: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '800',
  },
  moreDanger: {
    color: palette.danger,
  },
  moreMeta: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    lineHeight: 14,
    marginTop: 2,
  },
  content: {
    paddingTop: 6,
  },
  processingContent: {
    paddingTop: 8,
  },
  processingCard: {
    overflow: 'hidden',
    borderRadius: radii.lg,
    backgroundColor: palette.paper,
    ...shadows.card,
  },
  processingPreview: {
    height: 286,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  processingGlow: {
    position: 'absolute',
    width: 290,
    height: 290,
    borderRadius: 145,
    backgroundColor: palette.paperScrim,
  },
  processingIndicator: {
    position: 'absolute',
    right: 20,
    bottom: 18,
    width: 45,
    height: 45,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 23,
    backgroundColor: palette.paper,
    ...shadows.card,
  },
  processingIndicatorError: {
    backgroundColor: palette.danger,
  },
  processingBody: {
    paddingHorizontal: 22,
    paddingTop: 24,
    paddingBottom: 22,
  },
  processingHeading: {
    maxWidth: 520,
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 29,
    lineHeight: 35,
    fontWeight: '600',
    letterSpacing: -0.6,
  },
  processingCopy: {
    maxWidth: 560,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 10,
  },
  processingStatusRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: 22,
  },
  processingStatusText: {
    flex: 1,
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '800',
  },
  processingStatusTextError: {
    color: palette.danger,
  },
  processingFacts: {
    minHeight: 49,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderTopWidth: 1,
    borderColor: palette.line,
    marginTop: 21,
    paddingTop: 17,
  },
  processingFact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  processingFactDivider: {
    width: 1,
    height: 18,
    backgroundColor: palette.lineStrong,
  },
  processingFactText: {
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '700',
  },
  processingRetry: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    borderRadius: radii.md,
    backgroundColor: palette.lime,
    marginTop: 23,
  },
  processingRetryText: {
    color: palette.accentInk,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '900',
  },
  processingNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: 18,
    paddingHorizontal: 6,
  },
  processingNoteText: {
    flex: 1,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
  },
  previewCard: {
    overflow: 'hidden',
    borderRadius: radii.lg,
    backgroundColor: palette.paper,
    ...shadows.card,
  },
  previewBackground: {
    height: 390,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 25,
  },
  realPreview: {
    width: '100%',
    height: '100%',
  },
  previewPaper: {
    width: 245,
    maxWidth: '82%',
    aspectRatio: 0.72,
    padding: 24,
    backgroundColor: palette.paperStrong,
    borderRadius: 5,
    transform: [{ rotate: '-1deg' }],
    ...shadows.card,
  },
  previewPaperHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  previewLogo: {
    width: 24,
    height: 24,
    borderRadius: 7,
  },
  previewLine: {
    height: 5,
    borderRadius: radii.pill,
    backgroundColor: palette.inkSoft,
    marginBottom: 6,
  },
  previewLineLight: {
    height: 4,
    backgroundColor: palette.line,
  },
  previewKind: {
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1,
    marginTop: 35,
    marginBottom: 20,
  },
  previewTotal: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  previewAmount: {
    width: 50,
    height: 24,
    borderRadius: 5,
  },
  previewFooter: {
    height: 8,
    width: '38%',
    borderRadius: radii.pill,
    marginTop: 'auto',
  },
  previewBadge: {
    position: 'absolute',
    right: 14,
    bottom: 13,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: palette.inverseScrim,
  },
  previewBadgeText: {
    color: palette.onDark,
    fontFamily: fonts.sans,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  previewExpand: {
    position: 'absolute',
    top: 13,
    right: 14,
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
    backgroundColor: palette.inverseScrim,
  },
  previewExpandText: {
    color: palette.onDark,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '800',
  },
  quickActions: {
    height: 70,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
  },
  action: {
    flex: 1,
    alignItems: 'center',
    gap: 5,
    borderRightWidth: 1,
    borderColor: palette.line,
  },
  actionDisabled: {
    opacity: 0.38,
  },
  actionLabel: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '700',
  },
  titleBlock: {
    marginTop: 26,
  },
  overline: {
    color: palette.limeDark,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginTop: 5,
  },
  documentTitle: {
    flexShrink: 1,
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 29,
    lineHeight: 34,
    fontWeight: '600',
    letterSpacing: -0.6,
  },
  documentSubtitle: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    marginTop: 7,
  },
  editTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 5,
  },
  titleInput: {
    flex: 1,
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 25,
    fontWeight: '600',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderColor: palette.ink,
  },
  saveTitle: {
    width: 40,
    height: 40,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.lime,
  },
  section: {
    marginTop: 29,
  },
  sectionTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 17,
    fontWeight: '900',
    marginBottom: 11,
  },
  detailGroup: {
    paddingHorizontal: 14,
    borderRadius: radii.lg,
    backgroundColor: palette.paper,
  },
  detailRow: {
    minHeight: 65,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    borderBottomWidth: 1,
    borderColor: palette.line,
  },
  detailIcon: {
    width: 36,
    height: 36,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dateEditRow: {
    minHeight: 65,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: 1,
    borderColor: palette.line,
  },
  dateInput: {
    flex: 1,
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
    fontWeight: '700',
    paddingVertical: 9,
  },
  dateSave: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: palette.lime,
  },
  detailCopy: {
    flex: 1,
  },
  detailLabel: {
    color: palette.faint,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '700',
  },
  detailValue: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '700',
    marginTop: 3,
  },
  tagCard: {
    minHeight: 70,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    padding: 14,
    borderRadius: radii.lg,
    backgroundColor: palette.paper,
  },
  tagIcon: {
    width: 38,
    height: 38,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.lime,
  },
  tags: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  tag: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: palette.canvas,
  },
  tagText: {
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '700',
  },
  noTags: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 11,
    alignSelf: 'center',
  },
  addTag: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: palette.lineStrong,
  },
  addTagText: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '700',
  },
  ocrCard: {
    padding: 17,
    borderRadius: radii.lg,
    backgroundColor: palette.paper,
  },
  ocrHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  ocrLabel: {
    color: palette.limeDark,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.9,
  },
  ocrText: {
    color: palette.inkSoft,
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: 19,
    marginTop: 13,
  },
  readAll: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '900',
    marginTop: 13,
  },
  fileButton: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radii.md,
    backgroundColor: palette.lime,
    marginTop: 26,
  },
  fileButtonText: {
    color: palette.accentInk,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '900',
  },
  toast: {
    position: 'absolute',
    left: 36,
    right: 36,
    bottom: 105,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: radii.md,
    backgroundColor: palette.ink,
    ...shadows.lift,
  },
  toastError: {
    backgroundColor: palette.danger,
  },
  toastText: {
    color: palette.paper,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '700',
  },
  notFound: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.canvas,
  },
  notFoundTitle: {
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 25,
    marginTop: 13,
  },
  transitionCopy: {
    maxWidth: 300,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 7,
    textAlign: 'center',
  },
  backLink: {
    color: palette.limeDark,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '800',
    marginTop: 12,
  },
  pressed: {
    opacity: 0.74,
    transform: [{ scale: 0.985 }],
  },
});
