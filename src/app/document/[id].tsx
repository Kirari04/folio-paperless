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
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  Easing,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppShell } from '@/components/app-shell';
import { ChoiceSheet } from '@/components/choice-sheet';
import { DocumentDeepSections } from '@/components/document-deep-sections';
import { DocumentPreviewViewer } from '@/components/document-preview-viewer';
import { PaperThumbnail } from '@/components/paper-thumbnail';
import { TextEditSheet } from '@/components/text-edit-sheet';
import {
  MotionPressable as Pressable,
  animateLayout,
  hapticFeedback,
  useReducedMotion,
} from '@/components/motion';
import { fonts, maxContentWidth, palette, radii, shadows } from '@/constants/theme';
import { useApp, useDocumentDetail } from '@/context/app-context';
import {
  findRoutedDocument,
  isPendingDocument,
  taskIdFromPlaceholderId,
} from '@/lib/document-routing';
import { getPaperlessDocumentUrl, paperlessFileHeaders } from '@/lib/paperless';
import { useLocalSearchParams, useRouter } from '@/lib/router';
import { isValidIsoDate } from '@/lib/validation';

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

export default function DocumentDetailScreen({
  active = true,
  documentFrom,
  documentId,
}: DocumentDetailScreenProps = {}) {
  const routeParams = useLocalSearchParams<{ id?: string; from?: string }>();
  const requestedId = documentId || routeParams.id || '';
  const from = documentFrom || routeParams.from;
  const router = useRouter();
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const {
    documents,
    credentials,
    catalog,
    approveDocument,
    updateDocument,
    createTag,
    deleteDocument,
    reprocessDocument,
    retryDocumentProcessing,
    resolveDocumentId,
    shareDocument: shareDocumentFile,
    saveDocument,
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
  const requestedTaskId = taskIdFromPlaceholderId(requestedId);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(document?.title || '');
  const [created, setCreated] = useState(document?.created || '');
  const [editingDate, setEditingDate] = useState(false);
  const [expandedText, setExpandedText] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [picker, setPicker] = useState<PickerKind>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<number | string | undefined>();
  const [previewReady, setPreviewReady] = useState(false);
  const [screenOpacity] = useState(() => new Animated.Value(0));
  const detailLoadSignature = useRef<string | null>(null);
  const presentedDocumentId = useRef(document?.id);
  const closing = useRef(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewVersionId = typeof selectedVersionId === 'number' ? selectedVersionId : undefined;
  const canOpenPreview = previewReady && !!credentials && !!document?.remoteId;

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
    const loadSignature = `${id}:${documentDetailsVersion}`;
    if (
      !active ||
      !previewReady ||
      !listDocument?.remoteId ||
      detailLoadSignature.current === loadSignature
    ) return;
    let mounted = true;
    detailLoadSignature.current = loadSignature;
    void loadDocumentDetails(id).catch((error) => {
      if (mounted) {
        showToast(error instanceof Error ? error.message : 'Could not load document metadata.', true);
      }
    });
    return () => {
      mounted = false;
    };
  }, [active, documentDetailsVersion, id, listDocument?.remoteId, loadDocumentDetails, previewReady]);

  useEffect(() => {
    if (!document || presentedDocumentId.current === document.id) return;
    const finishedProcessing = Boolean(
      presentedDocumentId.current &&
        taskIdFromPlaceholderId(presentedDocumentId.current) &&
        !isPendingDocument(document),
    );
    presentedDocumentId.current = document.id;
    if (finishedProcessing) {
      animateLayout();
      showToast('Document ready to review');
    }
    setTitle(document.title);
    setCreated(document.created);
    setEditing(false);
    setEditingDate(false);
    setExpandedText(false);
    setPreviewFailed(false);
    setPreviewOpen(false);
    setPicker(null);
    setMoreOpen(false);
    setSelectedVersionId(undefined);
  }, [document]);

  useEffect(() => {
    if (!active || document || !requestedTaskId) return;
    router.replace('/inbox');
  }, [active, document, requestedTaskId, router]);

  if (!document && requestedTaskId) {
    return (
      <View accessibilityLiveRegion="polite" style={styles.notFound}>
        <ActivityIndicator color={palette.ink} size="large" />
        <Text style={styles.notFoundTitle}>Finalizing document</Text>
        <Text style={styles.transitionCopy}>Syncing the finished file with your inbox…</Text>
      </View>
    );
  }

  if (!document) {
    return (
      <View style={styles.notFound}>
        <FileText color={palette.ink} size={34} />
        <Text style={styles.notFoundTitle}>Document not found</Text>
        <Pressable onPress={() => router.replace('/documents')}>
          <Text style={styles.backLink}>Back to library</Text>
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
          message: `${title}\n${document.correspondent}\n\nShared from Folio for Paperless.`,
        });
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not share this document.', true);
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
      showToast('Title updated');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not update the title.';
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
      showToast('Created date updated');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not update the date.';
      showToast(message, true);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setBusyAction(null);
    }
  }

  async function downloadDocument() {
    setBusyAction('download');
    try {
      showToast(await saveDocument(
        id,
        typeof selectedVersionId === 'number' ? selectedVersionId : undefined,
      ));
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not download this document.', true);
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
      showToast(error instanceof Error ? error.message : 'Could not load the full text.', true);
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
      showToast(error instanceof Error ? error.message : 'Could not file this document.', true);
    } finally {
      setBusyAction(null);
    }
  }

  async function reprocess() {
    setMoreOpen(false);
    setBusyAction('reprocess');
    try {
      await reprocessDocument(id);
      showToast('Reprocessing started in Paperless');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not reprocess this document.', true);
    } finally {
      setBusyAction(null);
    }
  }

  async function checkProcessing() {
    setBusyAction('processing-refresh');
    try {
      await retryDocumentProcessing(id);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not check processing status.', true);
    } finally {
      setBusyAction(null);
    }
  }

  function confirmDelete() {
    setMoreOpen(false);
    Alert.alert(
      'Delete document?',
      'Paperless will move this document to Recently deleted, where it can be restored until the trash is emptied.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            setBusyAction('delete');
            deleteDocument(id)
              .then(() => router.replace('/documents'))
              .catch((error) =>
                showToast(error instanceof Error ? error.message : 'Could not delete this document.', true),
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
              accessibilityLabel="Go back"
              onPress={closeDocument}
              style={styles.headerButton}>
              <ArrowLeft color={palette.ink} size={21} />
            </Pressable>
            <Text style={styles.headerTitle}>
              {processingFailed ? 'Processing issue' : 'Processing'}
            </Text>
            <View style={styles.headerSpacer} />
          </View>
        </SafeAreaView>

        <AppShell contentStyle={styles.processingContent} safeTop={false} showNav={false}>
          <View
            accessibilityLabel={
              processingFailed
                ? `Processing failed for ${document.title}`
                : `${document.title} is processing in Paperless`
            }
            accessibilityLiveRegion="polite"
            style={styles.processingCard}>
            <View
              style={[
                styles.processingPreview,
                { backgroundColor: processingFailed ? palette.rose : document.color },
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
                  ? 'Processing needs attention'
                  : 'Getting your document ready'}
              </Text>
              <Text style={styles.processingCopy}>
                {processingFailed
                  ? `Paperless could not finish “${document.title}”.`
                  : `Paperless is running OCR, classification, and workflows for “${document.title}”.`}
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
                  {processingFailed ? document.processingError : 'Processing in Paperless'}
                </Text>
              </View>

              <View style={styles.processingFacts}>
                <View style={styles.processingFact}>
                  <FileText color={palette.inkSoft} size={17} />
                  <Text style={styles.processingFactText}>
                    {document.pageCount} {document.pageCount === 1 ? 'page' : 'pages'}
                  </Text>
                </View>
                <View style={styles.processingFactDivider} />
                <Text style={styles.processingFactText}>Uploaded {document.added.toLowerCase()}</Text>
              </View>

              {processingFailed && (
                <Pressable
                  accessibilityLabel={`Check processing status for ${document.title}`}
                  disabled={busyAction === 'processing-refresh'}
                  onPress={checkProcessing}
                  style={styles.processingRetry}>
                  {busyAction === 'processing-refresh' ? (
                    <ActivityIndicator color={palette.ink} size="small" />
                  ) : (
                    <RefreshCw color={palette.ink} size={18} />
                  )}
                  <Text style={styles.processingRetryText}>
                    {busyAction === 'processing-refresh' ? 'Checking…' : 'Check again'}
                  </Text>
                </Pressable>
              )}
            </View>
          </View>

          {!processingFailed && (
            <View style={styles.processingNote}>
              <Check color={palette.limeDark} size={17} />
              <Text style={styles.processingNoteText}>
                You can leave this screen. Processing continues in the background.
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
            accessibilityLabel="Go back"
            onPress={closeDocument}
            style={styles.headerButton}>
            <ArrowLeft color={palette.ink} size={21} />
          </Pressable>
          <Text style={styles.headerTitle}>Document</Text>
          <Pressable
            accessibilityLabel="More document actions"
            onPress={() => setMoreOpen((open) => !open)}
            style={styles.headerButton}>
            <MoreHorizontal color={palette.ink} size={22} />
          </Pressable>
        </View>
      </SafeAreaView>

      {moreOpen && (
        <View style={[styles.moreMenu, { top: insets.top + 51 }]}>
          <Pressable disabled={!document.remoteId} onPress={reprocess} style={styles.moreAction}>
            <RefreshCw color={palette.ink} size={17} />
            <View style={styles.moreCopy}>
              <Text style={styles.moreLabel}>Reprocess</Text>
              <Text style={styles.moreMeta}>Run OCR and workflows again</Text>
            </View>
          </Pressable>
          <Pressable onPress={confirmDelete} style={styles.moreAction}>
            <Trash2 color={palette.danger} size={17} />
            <View style={styles.moreCopy}>
              <Text style={[styles.moreLabel, styles.moreDanger]}>Delete</Text>
              <Text style={styles.moreMeta}>Remove this document permanently</Text>
            </View>
          </Pressable>
        </View>
      )}

      <AppShell contentStyle={styles.content} safeTop={false} showNav={false}>
        <View style={styles.previewCard}>
          <Pressable
            accessibilityHint="Opens the full document with page navigation and zoom controls"
            accessibilityLabel={`Open full preview of ${document.title}`}
            disabled={!canOpenPreview}
            haptic="medium"
            onPress={() => setPreviewOpen(true)}
            pressedScale={0.99}
            style={[styles.previewBackground, { backgroundColor: document.color }]}>
            {previewReady && !!credentials && !!document.remoteId && !previewFailed ? (
              <Image
                accessibilityLabel={`Preview of ${document.title}`}
                cachePolicy="memory-disk"
                contentFit="contain"
                onError={() => setPreviewFailed(true)}
                source={{
                  uri: getPaperlessDocumentUrl(
                    credentials,
                    document.remoteId,
                    'thumb',
                    typeof selectedVersionId === 'number' ? selectedVersionId : undefined,
                  ),
                  headers: paperlessFileHeaders(credentials.token),
                }}
                key={String(selectedVersionId || 'current')}
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
                {document.pageCount} {document.pageCount === 1 ? 'PAGE' : 'PAGES'}
              </Text>
            </View>
            {canOpenPreview && (
              <View pointerEvents="none" style={styles.previewExpand}>
                <Maximize2 color={palette.paperStrong} size={15} />
                <Text style={styles.previewExpandText}>Open preview</Text>
              </View>
            )}
          </Pressable>

          <View style={styles.quickActions}>
            <DocumentAction
              icon={Share2}
              label="Share"
              loading={busyAction === 'share'}
              onPress={shareDocument}
            />
            <DocumentAction
              disabled={!document.remoteId}
              icon={Download}
              label="Download"
              loading={busyAction === 'download'}
              onPress={downloadDocument}
            />
            <DocumentAction
              disabled={document.canEdit === false}
              icon={Edit3}
              label="Edit"
              onPress={() => setEditing(true)}
            />
          </View>
        </View>

        <View style={styles.titleBlock}>
          <Text style={styles.overline}>{document.documentType.toUpperCase()}</Text>
          <Pressable
            accessibilityHint="Opens a keyboard-safe title editor"
            disabled={document.canEdit === false}
            onPress={() => setEditing(true)}
            style={styles.titleRow}>
            <Text style={styles.documentTitle}>{title}</Text>
            <Edit3 color={palette.faint} size={17} />
          </Pressable>
          <Text style={styles.documentSubtitle}>
            {document.correspondent} · Added {document.added.toLowerCase()}
          </Text>
        </View>

        {previewReady && <>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Details</Text>
          <View style={styles.detailGroup}>
            <DetailRow
              icon={UserRound}
              label="Correspondent"
              onPress={() => setPicker('correspondent')}
              value={document.correspondent}
              color={palette.sky}
            />
            <DetailRow
              icon={FileText}
              label="Document type"
              onPress={() => setPicker('documentType')}
              value={document.documentType}
              color={palette.apricot}
            />
            <DetailRow
              icon={CalendarDays}
              label="Created"
              onPress={() => setEditingDate(true)}
              value={created}
              color={palette.lavender}
            />
            <DetailRow
              icon={FolderArchive}
              label="File"
              value={`${document.fileSize} · ${document.pageCount} pages`}
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
          <Text style={styles.sectionTitle}>Tags</Text>
          <View style={styles.tagCard}>
            <View style={styles.tagIcon}>
              <Tag color={palette.ink} size={18} />
            </View>
            <View style={styles.tags}>
              {document.tags.map((tag) => (
                <View key={tag} style={styles.tag}>
                  <Text style={styles.tagText}>{tag}</Text>
                </View>
              ))}
              {!document.tags.length && <Text style={styles.noTags}>No tags assigned</Text>}
              <Pressable onPress={() => setPicker('tags')} style={styles.addTag}>
                <Text style={styles.addTagText}>{document.tags.length ? 'Edit tags' : '+ Add tags'}</Text>
              </Pressable>
            </View>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Extracted text</Text>
          <View style={styles.ocrCard}>
            <View style={styles.ocrHeader}>
              <Sparkles color={palette.limeDark} size={16} />
              <Text style={styles.ocrLabel}>OCR · SEARCHABLE</Text>
            </View>
            <Text style={styles.ocrText}>
              {expandedText ? document.fullText || document.excerpt : document.excerpt}
            </Text>
            <Pressable disabled={busyAction === 'ocr'} onPress={toggleFullText}>
              <Text style={styles.readAll}>
                {busyAction === 'ocr' ? 'Loading full text…' : expandedText ? 'Show less' : 'Read full text'}
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
              <ActivityIndicator color={palette.ink} />
            ) : (
              <Check color={palette.ink} size={20} />
            )}
            <Text style={styles.fileButtonText}>Looks good · File it</Text>
          </Pressable>
        )}
        </>}
      </AppShell>

      {picker === 'correspondent' && <ChoiceSheet
        allowNone
        onClose={() => setPicker(null)}
        onConfirm={async (selected) => updateDocument(id, { correspondent: selected[0] || null })}
        options={catalog.correspondents}
        selectedIds={document.correspondentId ? [document.correspondentId] : []}
        title="Correspondent"
        visible
      />}
      {picker === 'documentType' && <ChoiceSheet
        allowNone
        onClose={() => setPicker(null)}
        onConfirm={async (selected) => updateDocument(id, { documentType: selected[0] || null })}
        options={catalog.documentTypes}
        selectedIds={document.documentTypeId ? [document.documentTypeId] : []}
        title="Document type"
        visible
      />}
      {picker === 'tags' && <ChoiceSheet
        createLabel="Create a new tag"
        multiple
        onClose={() => setPicker(null)}
        onConfirm={async (selected) => updateDocument(id, { tags: selected })}
        onCreate={createTag}
        options={catalog.tags}
        selectedIds={document.tagIds}
        title="Tags"
        visible
      />}

      {editing && (
        <TextEditSheet
          label="Document title"
          onClose={() => setEditing(false)}
          onSave={saveTitle}
          placeholder="Document title"
          required
          saveLabel="Save title"
          subtitle="Give this document a clear, searchable name."
          title="Edit title"
          value={title}
          visible
        />
      )}
      {editingDate && (
        <TextEditSheet
          autoCapitalize="none"
          autoCorrect={false}
          helperText="Paperless stores this as the document's original date."
          label="Created date"
          maxLength={10}
          onClose={() => setEditingDate(false)}
          onSave={saveCreatedDate}
          placeholder="YYYY-MM-DD"
          saveLabel="Save date"
          subtitle="Use the ISO format YYYY-MM-DD."
          title="Edit created date"
          validate={(next) => {
            const normalized = next.trim();
            return isValidIsoDate(normalized) ? null : 'Use a valid date in YYYY-MM-DD format.';
          }}
          value={created}
          visible
        />
      )}

      {!!credentials && !!document.remoteId && (
        <DocumentPreviewViewer
          cacheKey={`folio-${document.remoteId}-${previewVersionId || 'current'}`}
          fallbackSource={{
            uri: getPaperlessDocumentUrl(
              credentials,
              document.remoteId,
              'thumb',
              previewVersionId,
            ),
            headers: paperlessFileHeaders(credentials.token),
          }}
          headers={paperlessFileHeaders(credentials.token)}
          onClose={() => setPreviewOpen(false)}
          pageCount={document.pageCount}
          title={title}
          uri={getPaperlessDocumentUrl(
            credentials,
            document.remoteId,
            'preview',
            previewVersionId,
          )}
          visible={previewOpen}
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
  color: string;
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

const styles = StyleSheet.create({
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
    backgroundColor: 'rgba(255,253,248,0.52)',
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
    color: palette.ink,
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
    backgroundColor: 'rgba(23,35,27,0.78)',
  },
  previewBadgeText: {
    color: palette.paper,
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
    backgroundColor: 'rgba(23,35,27,0.84)',
  },
  previewExpandText: {
    color: palette.paperStrong,
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
    color: palette.ink,
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
