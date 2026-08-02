import {
  Bookmark,
  Check,
  CheckSquare2,
  Filter,
  FolderTree,
  LayoutGrid,
  List,
  MoreHorizontal,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react-native';
import { FlashList } from '@shopify/flash-list';
import type { ListRenderItemInfo } from '@shopify/flash-list';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Keyboard,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { AppShell } from '@/components/app-shell';
import { BulkActionSheet, type BulkActionRequest } from '@/components/bulk-action-sheet';
import { ChoiceSheet } from '@/components/choice-sheet';
import { DemoModeBanner } from '@/components/demo-mode-banner';
import { LibraryFilterSheet } from '@/components/library-filter-sheet';
import { LibrarySortSheet } from '@/components/library-sort-sheet';
import { MotionPressable as Pressable, hapticFeedback } from '@/components/motion';
import { PaperThumbnail } from '@/components/paper-thumbnail';
import { bottomNavHeight, fonts, maxContentWidth, palette, radii } from '@/constants/theme';
import { useApp } from '@/context/app-context';
import { useI18n, type TranslationKey } from '@/i18n';
import { presentRuntimeError } from '@/i18n/error-presentation';
import {
  cloneLibraryFilters,
  emptyLibraryFilters,
  libraryFilterCount,
  matchesLibraryFilters,
  savedViewToLibraryState,
  sortLibraryDocuments,
} from '@/lib/library-filters';
import {
  buildBulkCandidates,
  executeBulkDocumentOperation,
  selectShownDocuments,
  summarizeLibrarySelection,
  toggleStableSelection,
} from '@/lib/bulk-document-controller';
import {
  reconcileConfirmedBulkDocuments,
  reconcileConfirmedBulkThenRefresh,
} from '@/lib/bulk-document-reconciliation';
import { exportSelectedDocuments } from '@/lib/bulk-document-export';
import { selectBulkEligible } from '@/lib/paperless-advanced';
import {
  buildSavedViewEdit,
  folioSavedViewMode,
  hasUnsupportedSavedViewRules,
  paperlessSavedViewDisplayMode,
  reconcileLibraryFiltersWithCatalog,
  serializeLibrarySavedViewState,
  type PaperlessQueryRuleType,
} from '@/lib/saved-view-controller';
import { useNavigationRoute, useRouter } from '@/lib/router';
import { usePaperlessAdvanced } from '@/lib/use-paperless-advanced';
import {
  SavedViewEditorSheet,
  type SavedViewPresentationEdit,
} from '@/components/saved-view-editor-sheet';
import {
  DocumentItem,
  LibraryFilters,
  LibrarySortOrder,
  PaperlessCatalog,
  PaperlessSavedViewRule,
  PaperlessOption,
} from '@/types/document';
import type {
  PaperlessBulkOperation,
  PaperlessBulkResult,
} from '@/types/paperless-advanced';

export default function DocumentsRoute() {
  const route = useNavigationRoute();
  const { activeProfile, credentials } = useApp();
  const active = route.pathname === '/documents';
  return (
    <DocumentsScreen
      key={activeProfile?.id ?? credentials?.profileId ?? 'no-profile'}
      routeKey={active ? route.key : undefined}
      routeQuery={active ? route.params.q : undefined}
    />
  );
}

const DocumentsScreen = memo(function DocumentsScreen({
  routeKey,
  routeQuery,
}: {
  routeKey?: number;
  routeQuery?: string;
}) {
  const router = useRouter();
  const { formatNumber, t } = useI18n();
  const { width } = useWindowDimensions();
  const {
    connected,
    profileConfigured,
    credentials,
    activeProfile,
    documents,
    catalog,
    totalDocuments,
    isSyncing,
    online,
    refresh,
    publishSavedView,
    searchLibrary,
    trackPaperlessBulkOperation,
    reconcilePaperlessBulkOperation,
  } = useApp();
  const [queryState, setQueryState] = useState({
    acceptedRouteKey: routeKey,
    value: routeQuery || '',
  });
  const query = routeKey !== undefined && routeKey !== queryState.acceptedRouteKey
    ? routeQuery || ''
    : queryState.value;
  const setQuery = useCallback((value: string) => {
    setQueryState({ acceptedRouteKey: routeKey, value });
  }, [routeKey]);
  const [filters, setFilters] = useState(() => cloneLibraryFilters(emptyLibraryFilters));
  const [viewMode, setViewMode] = useState<'list' | 'grid' | null>(null);
  const [sortOrder, setSortOrder] = useState<LibrarySortOrder>('added-desc');
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [sortSheetOpen, setSortSheetOpen] = useState(false);
  const [activeSavedView, setActiveSavedView] = useState<string | null>(null);
  const [presetRefined, setPresetRefined] = useState(false);
  const [queryRuleType, setQueryRuleType] = useState<PaperlessQueryRuleType>(49);
  const [extraRules, setExtraRules] = useState<PaperlessSavedViewRule[]>([]);
  const [sourceRules, setSourceRules] = useState<PaperlessSavedViewRule[]>([]);
  const [sourceRuleStateSignature, setSourceRuleStateSignature] = useState<string | undefined>();
  const [savedViewExtra, setSavedViewExtra] = useState<Readonly<Record<string, unknown>>>({});
  const [savedViewPresentation, setSavedViewPresentation] = useState<{
    pageSize: number;
    displayMode?: string;
    displayFields: string[];
  } | undefined>();
  const [savedViewSort, setSavedViewSort] = useState<{
    sortField: string;
    sortReverse: boolean;
    projectedSortOrder: LibrarySortOrder;
  } | undefined>();
  const updateQuery = useCallback((value: string) => {
    setQuery(value);
    setQueryRuleType(49);
    if (activeSavedView) setPresetRefined(true);
  }, [activeSavedView, setQuery]);
  const [remoteResult, setRemoteResult] = useState<{
    documents: DocumentItem[];
    signature: string;
  } | null>(null);
  const [remoteState, setRemoteState] = useState<{
    message?: string;
    phase: 'loading' | 'ready' | 'error';
    signature: string;
  } | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const advanced = usePaperlessAdvanced();
  const savedViewDisplayFieldOptions = useMemo(() => [
    { value: 'title', label: t('savedViewEditor.fieldTitle') },
    { value: 'created', label: t('savedViewEditor.fieldCreated') },
    { value: 'added', label: t('savedViewEditor.fieldAdded') },
    { value: 'tag', label: t('savedViewEditor.fieldTags') },
    { value: 'correspondent', label: t('savedViewEditor.fieldCorrespondent') },
    { value: 'documenttype', label: t('savedViewEditor.fieldDocumentType') },
    { value: 'storagepath', label: t('savedViewEditor.fieldStoragePath') },
    { value: 'note', label: t('savedViewEditor.fieldNotes') },
    { value: 'owner', label: t('savedViewEditor.fieldOwner') },
    { value: 'shared', label: t('savedViewEditor.fieldShared') },
    { value: 'asn', label: t('savedViewEditor.fieldAsn') },
    { value: 'pagecount', label: t('savedViewEditor.fieldPageCount') },
    ...catalog.customFields.flatMap((field) => field.remoteId === undefined ? [] : [{
      value: `custom_field_${field.remoteId}`,
      label: field.name,
    }]),
  ], [catalog.customFields, t]);
  const [selectionActive, setSelectionActive] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResult, setBulkResult] = useState<Pick<PaperlessBulkResult, 'failed' | 'pending' | 'skipped' | 'succeeded'> | null>(null);
  const [lastBulkOperation, setLastBulkOperation] = useState<PaperlessBulkOperation | { kind: 'export'; representation: 'original' | 'archive' } | null>(null);
  const [choiceRequest, setChoiceRequest] = useState<BulkActionRequest | null>(null);
  const [savedViewEditor, setSavedViewEditor] = useState<{ mode: 'create'; initialName: string } | null>(null);
  const remoteRequestId = useRef(0);
  const bulkRunActive = useRef(false);
  const prewarmedFirstDocumentId = useRef<string | null>(null);
  const activeProfileId = activeProfile?.id ?? credentials?.profileId ?? null;
  const activeProfileIdRef = useRef(activeProfileId);

  useEffect(() => {
    const firstDocument = documents.find((document) => document.status !== 'processing');
    if (!firstDocument || prewarmedFirstDocumentId.current === firstDocument.id) return;
    const timer = setTimeout(() => {
      prewarmedFirstDocumentId.current = firstDocument.id;
      router.preload({ pathname: '/document/[id]', params: { id: firstDocument.id } });
    }, 450);
    return () => clearTimeout(timer);
  }, [documents, router]);

  const deferredQuery = useDeferredValue(query);
  const searchIndex = useMemo(
    () =>
      new Map(
        documents.map((document) => [
          document.id,
          [
            document.title,
            document.correspondent,
            document.documentType,
            document.excerpt,
            document.fullText,
            ...document.tags,
          ]
            .filter(Boolean)
            .join(' ')
            .toLocaleLowerCase(),
        ]),
      ),
    [documents],
  );
  const localDocuments = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();
    return documents.filter((document) => {
      if (!matchesLibraryFilters(document, filters)) return false;
      return !normalizedQuery || searchIndex.get(document.id)?.includes(normalizedQuery);
    });
  }, [deferredQuery, documents, filters, searchIndex]);
  const getLocalPreviewCount = useCallback((nextFilters: LibraryFilters) => {
    const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();
    return documents.reduce((count, document) => {
      if (!matchesLibraryFilters(document, nextFilters)) return count;
      if (normalizedQuery && !searchIndex.get(document.id)?.includes(normalizedQuery)) return count;
      return count + 1;
    }, 0);
  }, [deferredQuery, documents, searchIndex]);
  const activeFilterCount = libraryFilterCount(filters);
  const effectiveFilterCount = activeFilterCount + (extraRules.length ? 1 : 0);
  const remoteRequired = connected && (
    !!deferredQuery.trim() || activeFilterCount > 0 || extraRules.length > 0
  );
  const requestSignature = useMemo(
    () => JSON.stringify({
      profileId: activeProfileId,
      query: deferredQuery.trim(),
      queryRuleType,
      filters,
      extraRules,
      savedViewId: activeSavedView,
      savedViewModified: presetRefined,
    }),
    [activeProfileId, activeSavedView, deferredQuery, extraRules, filters, presetRefined, queryRuleType],
  );

  useEffect(() => {
    const requestId = ++remoteRequestId.current;
    if (!remoteRequired) return;

    const timer = setTimeout(() => {
      setRemoteState({ phase: 'loading', signature: requestSignature });
      void searchLibrary({
        query: deferredQuery.trim(),
        queryRuleType,
        filters,
        extraRules,
        savedViewId: activeSavedView ?? undefined,
        savedViewModified: presetRefined,
      })
        .then((result) => {
          if (remoteRequestId.current !== requestId) return;
          setRemoteResult({ documents: result.documents, signature: requestSignature });
          setRemoteState({ phase: 'ready', signature: requestSignature });
        })
        .catch((error) => {
          if (remoteRequestId.current !== requestId) return;
          setRemoteState({
            message: presentRuntimeError(error, t('library.refreshFilteredError')),
            phase: 'error',
            signature: requestSignature,
          });
          void hapticFeedback('error');
        });
    }, deferredQuery.trim() ? 320 : 30);
    return () => clearTimeout(timer);
  }, [activeSavedView, deferredQuery, extraRules, filters, presetRefined, queryRuleType, remoteRequired, requestSignature, retryKey, searchLibrary, t]);

  const remoteDocuments = remoteRequired && remoteResult?.signature === requestSignature
    ? remoteResult.documents
    : null;
  const remoteLoading = remoteRequired && remoteState?.signature === requestSignature
    && remoteState.phase === 'loading';
  const remoteError = remoteRequired && remoteState?.signature === requestSignature
    && remoteState.phase === 'error'
    ? remoteState.message || t('library.refreshFilteredError')
    : null;
  const filteredDocuments = useMemo(
    () => sortLibraryDocuments(remoteDocuments ?? localDocuments, sortOrder),
    [localDocuments, remoteDocuments, sortOrder],
  );
  const allKnownDocuments = useMemo(() => {
    const items = new Map(documents.map((document) => [document.id, document]));
    for (const document of remoteDocuments ?? []) items.set(document.id, document);
    return [...items.values()];
  }, [documents, remoteDocuments]);
  const selection = useMemo(
    () => summarizeLibrarySelection(selectedIds, filteredDocuments),
    [filteredDocuments, selectedIds],
  );
  const eligibleSelection = useMemo(
    () => selectBulkEligible(buildBulkCandidates(allKnownDocuments, selectedIds)).eligible,
    [allKnownDocuments, selectedIds],
  );
  const searchPending = query !== deferredQuery || remoteLoading;

  const exitSelection = useCallback(() => {
    setSelectionActive(false);
    setSelectedIds(new Set());
    setBulkOpen(false);
    setBulkResult(null);
  }, []);

  useEffect(() => {
    if (!selectionActive) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      exitSelection();
      return true;
    });
    return () => subscription.remove();
  }, [exitSelection, selectionActive]);

  useEffect(() => {
    if (!connected) return;
    const timer = setTimeout(() => {
      const selectedView = activeSavedView
        ? catalog.savedViews.find((view) => view.id === activeSavedView)
        : null;
      setFilters((current) => {
        const reconciled = reconcileLibraryFiltersWithCatalog(current, catalog);
        return JSON.stringify(reconciled) === JSON.stringify(current) ? current : reconciled;
      });
      if (selectedView && !presetRefined) {
        const newlyOpaque = savedViewToLibraryState(selectedView, catalog).extraRules;
        setExtraRules((current) => {
          const identities = new Set(current.map((rule) => JSON.stringify(rule)));
          const retained = [...current];
          for (const opaqueRule of newlyOpaque) {
            const identity = JSON.stringify(opaqueRule);
            if (!identities.has(identity)) {
              identities.add(identity);
              retained.push(opaqueRule);
            }
          }
          return retained.length === current.length ? current : retained;
        });
      } else if (activeSavedView) {
        setActiveSavedView(null);
        setPresetRefined(false);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [activeSavedView, catalog, connected, presetRefined]);

  function clearAll() {
    setQuery('');
    setFilters(cloneLibraryFilters(emptyLibraryFilters));
    setActiveSavedView(null);
    setPresetRefined(false);
    setExtraRules([]);
    setQueryRuleType(49);
    setSourceRules([]);
    setSourceRuleStateSignature(undefined);
    setSavedViewExtra({});
    setSavedViewPresentation(undefined);
    setSavedViewSort(undefined);
  }

  function updateFilters(next: LibraryFilters) {
    setFilters(cloneLibraryFilters(next));
    if (activeSavedView) setPresetRefined(true);
  }

  function selectSavedView(id: string) {
    if (id === activeSavedView) {
      clearAll();
      void hapticFeedback('selection');
      return;
    }
    const view = catalog.savedViews.find((item) => item.id === id);
    if (!view) return;
    const preset = savedViewToLibraryState(view, catalog);
    setActiveSavedView(id);
    setPresetRefined(false);
    setFilters(preset.filters);
    setQuery(preset.query);
    setQueryRuleType(preset.queryRuleType);
    setExtraRules(preset.extraRules);
    setSourceRules(preset.sourceRules);
    setSourceRuleStateSignature(preset.sourceRuleStateSignature);
    setSavedViewExtra(preset.savedViewExtra);
    setSavedViewPresentation(preset.savedViewPresentation);
    setSavedViewSort(preset.savedViewSort);
    setSortOrder(preset.sortOrder);
    setViewMode(folioSavedViewMode(view.displayMode));
    void hapticFeedback('selection');
  }

  function clearCriterion(key: FilterCriterionKey) {
    setFilters((current) => clearFilterCriterion(current, key));
    if (activeSavedView) setPresetRefined(true);
  }

  const thisYear = useMemo(() => {
    const year = new Date().getFullYear();
    return { after: `${year}-01-01`, before: `${year}-12-31` };
  }, []);

  function toggleQuickFilter(key: 'inbox' | 'untagged' | 'pdf' | 'year') {
    setFilters((current) => {
      if (key === 'inbox') {
        return { ...current, status: current.status === 'inbox' ? 'any' : 'inbox' };
      }
      if (key === 'untagged') {
        return { ...current, status: current.status === 'untagged' ? 'any' : 'untagged' };
      }
      if (key === 'pdf') {
        const active = current.mimeTypes.includes('application/pdf');
        return {
          ...current,
          mimeTypes: active
            ? current.mimeTypes.filter((value) => value !== 'application/pdf')
            : [...current.mimeTypes, 'application/pdf'],
        };
      }
      const active = current.createdAfter === thisYear.after && current.createdBefore === thisYear.before;
      return {
        ...current,
        createdAfter: active ? '' : thisYear.after,
        createdBefore: active ? '' : thisYear.before,
      };
    });
    if (activeSavedView) setPresetRefined(true);
  }

  const refreshLibrary = useCallback(async () => {
    try {
      await refresh();
      setRetryKey((current) => current + 1);
      return true;
    } catch (error) {
      setRemoteState({
        message: presentRuntimeError(error, t('library.refreshError')),
        phase: 'error',
        signature: requestSignature,
      });
      await hapticFeedback('error');
      return false;
    }
  }, [refresh, requestSignature, t]);

  const isWide = width > 620;
  const useGrid = viewMode ? viewMode === 'grid' : isWide;
  const openDocument = useCallback(
    (id: string) => router.push({ pathname: '/document/[id]', params: { id } }),
    [router],
  );
  const preloadDocument = useCallback(
    (id: string) => router.preload({ pathname: '/document/[id]', params: { id } }),
    [router],
  );
  const renderListDocument = useCallback(
    ({ index, item }: ListRenderItemInfo<DocumentItem>) =>
      <LibraryDocument
        column={index % 2 === 0 ? 'left' : 'right'}
        document={item}
        grid={false}
        onOpen={openDocument}
        onPreload={preloadDocument}
        onSelect={(id) => {
          setSelectionActive(true);
          setSelectedIds((current) => toggleStableSelection(current, id));
        }}
        selected={selectedIds.has(item.id)}
        selectionActive={selectionActive}
      />,
    [openDocument, preloadDocument, selectedIds, selectionActive],
  );
  const renderGridDocument = useCallback(
    ({ index, item }: ListRenderItemInfo<DocumentItem>) =>
      <LibraryDocument
        column={index % 2 === 0 ? 'left' : 'right'}
        document={item}
        grid
        onOpen={openDocument}
        onPreload={preloadDocument}
        onSelect={(id) => {
          setSelectionActive(true);
          setSelectedIds((current) => toggleStableSelection(current, id));
        }}
        selected={selectedIds.has(item.id)}
        selectionActive={selectionActive}
      />,
    [openDocument, preloadDocument, selectedIds, selectionActive],
  );
  const mimeTypes = useMemo(
    () => [...new Set(documents.map((document) => document.mimeType).filter((value): value is string => Boolean(value)))].sort(),
    [documents],
  );
  const criteria = useMemo(
    () => libraryCriteria(filters, catalog, t, formatNumber),
    [catalog, filters, formatNumber, t],
  );
  const narrowed = !!query.trim() || activeFilterCount > 0 || extraRules.length > 0;
  const openFilters = useCallback(() => {
    Keyboard.dismiss();
    setFilterSheetOpen(true);
  }, []);
  const openSort = useCallback(() => {
    Keyboard.dismiss();
    setSortSheetOpen(true);
  }, []);

  const runBulkOperation = useCallback(async (
    operation: PaperlessBulkOperation | { kind: 'export'; representation: 'original' | 'archive' },
    ids: ReadonlySet<string> = selectedIds,
  ) => {
    const operationProfileId = activeProfileId;
    if (bulkRunActive.current) return;
    if (advanced.phase !== 'ready') {
      Alert.alert(t('library.paperlessNotReady'), advanced.phase === 'error' ? advanced.error : t('library.discoveryRunning'));
      return;
    }
    if (!ids.size) return;
    bulkRunActive.current = true;
    setBulkBusy(true);
    setBulkResult(null);
    setLastBulkOperation(operation);
    try {
      if (operation.kind === 'export') {
        if (!credentials) throw new Error(t('library.connectExport'));
        if (!operationProfileId) throw new Error(t('library.connectExport'));
        const result = await exportSelectedDocuments({
          api: advanced.api,
          credentials,
          expectedProfileId: operationProfileId,
          executionGuard: () => activeProfileIdRef.current === operationProfileId,
          documents: allKnownDocuments,
          selectedIds: ids,
          representation: operation.representation,
        });
        if (activeProfileIdRef.current !== operationProfileId) return;
        setBulkResult({ ...result, pending: [] });
        const succeeded = new Set(result.succeeded);
        setSelectedIds((current) => new Set([...current].filter((id) => {
          const document = allKnownDocuments.find((item) => item.id === id);
          return !document?.remoteId || !succeeded.has(document.remoteId);
        })));
      } else {
        if (!operationProfileId) throw new Error(t('library.paperlessNotReady'));
        const result = await executeBulkDocumentOperation({
          api: advanced.api,
          expectedProfileId: operationProfileId,
          executionGuard: () => activeProfileIdRef.current === operationProfileId,
          documents: allKnownDocuments,
          selectedIds: ids,
          operation,
        });
        if (activeProfileIdRef.current !== operationProfileId) return;
        if (!result.supported) throw new Error(result.detail ?? t('library.bulkUnavailable'));
        setBulkResult(result.value);
        const bulkTargets = buildBulkCandidates(allKnownDocuments, ids).map((candidate) => ({
          localId: candidate.localId,
          ...(candidate.remoteId ? { remoteDocumentId: candidate.remoteId } : {}),
        }));
        await trackPaperlessBulkOperation({
          result: result.value,
          targets: bulkTargets,
        });
        if (result.value.succeeded.length) {
          const succeeded = new Set(result.value.succeeded);
          setSelectedIds((current) => new Set([...current].filter((id) => {
            const document = allKnownDocuments.find((item) => item.id === id);
            return !document?.remoteId || !succeeded.has(document.remoteId);
          })));
          try {
            await reconcileConfirmedBulkThenRefresh({
              refresh: refreshLibrary,
              reconcile: async () => {
                const reconciliation = await reconcilePaperlessBulkOperation({
                  expectedProfileId: operationProfileId,
                  result: result.value,
                  targets: bulkTargets,
                });
                if (!reconciliation || activeProfileIdRef.current !== operationProfileId) return;
                setRemoteResult((current) => current ? {
                  ...current,
                  documents: reconcileConfirmedBulkDocuments(current.documents, reconciliation),
                } : current);
              },
            });
          } catch (error) {
            if (activeProfileIdRef.current === operationProfileId) {
              Alert.alert(
                t('library.refreshError'),
                presentRuntimeError(error, t('library.refreshError')),
              );
            }
          }
        }
      }
      await hapticFeedback('confirm');
      setTimeout(() => setBulkOpen(true), 280);
    } catch (error) {
      Alert.alert(t('library.bulkFailed'), presentRuntimeError(error, t('library.paperlessActionFailed')));
      await hapticFeedback('error');
    } finally {
      bulkRunActive.current = false;
      if (activeProfileIdRef.current === operationProfileId) setBulkBusy(false);
    }
  }, [activeProfileId, advanced, allKnownDocuments, credentials, reconcilePaperlessBulkOperation, refreshLibrary, selectedIds, t, trackPaperlessBulkOperation]);

  function exactEligibility(ids: ReadonlySet<string> = selectedIds) {
    return selectBulkEligible(buildBulkCandidates(allKnownDocuments, ids)).eligible.length;
  }

  function confirmBulk(
    title: string,
    message: string,
    operation: PaperlessBulkOperation | { kind: 'export'; representation: 'original' | 'archive' },
    destructive = false,
  ) {
    const count = operation.kind === 'export'
      ? new Set(allKnownDocuments.filter((document) => (
        selectedIds.has(document.id)
        && !!document.remoteId
        && document.status !== 'processing'
        && !document.taskId
      )).map((document) => document.remoteId!)).size
      : exactEligibility();
    if (!count) {
      Alert.alert(t('library.nothingEligible'), t('library.nothingEligibleCopy'));
      return;
    }
    Alert.alert(title, `${message}\n\n${t('library.eligibleCount', { count: formatNumber(count) })}`, [
      { text: t('common.cancel'), style: 'cancel' },
      { text: destructive ? t('library.continue') : t('library.confirm'), style: destructive ? 'destructive' : 'default', onPress: () => void runBulkOperation(operation) },
    ]);
  }

  async function requestBulkAction(request: BulkActionRequest) {
    setBulkOpen(false);
    if (
      request.kind === 'tags'
      || request.kind === 'setCorrespondent'
      || request.kind === 'setDocumentType'
      || request.kind === 'setStoragePath'
      || request.kind === 'setOwner'
    ) {
      setChoiceRequest(request);
      return;
    }
    if (request.kind === 'file') {
      if (advanced.phase !== 'ready') return;
      try {
        const tags = await advanced.api.listCatalog('tags', 'page_size=1000');
        if (!tags.supported) throw new Error(tags.detail ?? t('library.tagsUnavailable'));
        const inboxTagIds = tags.value.results.filter((tag) => tag.isInboxTag).map((tag) => tag.id);
        if (!inboxTagIds.length) throw new Error(t('library.noInboxTag'));
        confirmBulk(t('library.fileSelectedTitle'), t('library.fileSelectedBody'), { kind: 'file', inboxTagIds });
      } catch (error) {
        Alert.alert(t('library.inboxTagUnavailable'), presentRuntimeError(error, t('library.inboxTagLoadError')));
      }
      return;
    }
    if (request.kind === 'reprocess') {
      confirmBulk(t('library.reprocessTitle'), t('library.reprocessBody'), { kind: 'reprocess' });
      return;
    }
    if (request.kind === 'trash') {
      confirmBulk(t('library.trashTitle'), t('library.trashBody'), { kind: 'trash' }, true);
      return;
    }
    if (request.kind !== 'export') return;
    const label = request.representation === 'archive' ? t('library.archiveFiles') : t('library.originalFiles');
    confirmBulk(
      t('library.exportTitle', { label }),
      t('library.exportBody'),
      request,
    );
  }

  async function applyChoice(options: PaperlessOption[]) {
    const request = choiceRequest;
    if (!request) return;
    const values = options.map((option) => option.remoteId).filter((id): id is number => id !== undefined);
    if (values.length !== options.length) throw new Error(t('library.selectedMissing'));
    if (request.kind === 'tags') {
      if (!values.length && request.mode !== 'replace') {
        throw new Error(t('library.chooseTag', { mode: request.mode }));
      }
      const operation: PaperlessBulkOperation = { kind: 'tags', mode: request.mode, tagIds: values };
      if (request.mode === 'replace') {
        confirmBulk(t('library.replaceTagsTitle'), t('library.replaceTagsBody'), operation, true);
      } else {
        await runBulkOperation(operation);
      }
      return;
    }
    if (request.kind === 'setCorrespondent' || request.kind === 'setDocumentType' || request.kind === 'setStoragePath' || request.kind === 'setOwner') {
      await runBulkOperation({ kind: request.kind, value: values[0] ?? null });
    }
  }

  function retryBulkFailures() {
    if (!lastBulkOperation || !bulkResult) return;
    const remoteFailures = new Set(bulkResult.failed.map((failure) => failure.remoteId).filter((id): id is number => !!id));
    const localFailures = new Set(bulkResult.failed.map((failure) => failure.localId).filter((id): id is string => !!id));
    const retryIds = new Set(allKnownDocuments.filter((document) => localFailures.has(document.id) || (!!document.remoteId && remoteFailures.has(document.remoteId))).map((document) => document.id));
    if (!retryIds.size) return;
    setSelectedIds(retryIds);
    void runBulkOperation(lastBulkOperation, retryIds);
  }

  async function saveCurrentView(name: string, presentation?: SavedViewPresentationEdit) {
    if (advanced.phase !== 'ready') throw new Error(t('library.paperlessNotReady'));
    if (!activeProfileId) throw new Error(t('library.paperlessNotReady'));
    const state = {
      query,
      queryRuleType,
      filters,
      sortOrder,
      catalog,
      extraRules,
      sourceRules,
      sourceRuleStateSignature,
      savedViewExtra,
      savedViewPresentation,
      savedViewSort,
      viewMode: useGrid ? 'grid' as const : 'list' as const,
    };
    const result = await advanced.api.createSavedView({
      ...buildSavedViewEdit(name, state),
      ...presentation,
    });
    if (!result.supported) throw new Error(result.detail ?? t('library.createViewUnavailable'));
    await publishSavedView(activeProfileId, result.value);
    await refreshLibrary();
    await hapticFeedback('confirm');
  }

  async function updateCurrentView() {
    if (advanced.phase !== 'ready' || !activeSavedView || !activeProfileId) return;
    const legacy = catalog.savedViews.find((view) => view.id === activeSavedView);
    if (!legacy?.remoteId) {
      Alert.alert(t('library.savedViewUnavailable'), t('library.savedViewMissingIdentity'));
      return;
    }
    if (extraRules.length) {
      Alert.alert(t('library.unsupportedRules'), t('library.unsupportedRulesCopy'));
      return;
    }
    try {
      const listed = await advanced.api.listSavedViews();
      if (!listed.supported) throw new Error(listed.detail ?? t('library.savedViewsUnavailable'));
      const current = listed.value.results.find((view) => view.id === legacy.remoteId);
      if (!current) throw new Error(t('library.savedViewMissing'));
      if (hasUnsupportedSavedViewRules(current.filterRules)) {
        Alert.alert(t('library.unsupportedRules'), t('library.manageUnsupportedRules'));
        return;
      }
      const edit = {
        ...serializeLibrarySavedViewState({
          query,
          queryRuleType,
          filters,
          sortOrder,
          catalog,
          extraRules,
          sourceRules,
          sourceRuleStateSignature,
          savedViewSort,
        }),
        displayMode: savedViewPresentation?.displayMode
          && folioSavedViewMode(savedViewPresentation.displayMode) === (useGrid ? 'grid' : 'list')
          ? savedViewPresentation.displayMode
          : paperlessSavedViewDisplayMode(useGrid ? 'grid' : 'list'),
      };
      const result = await advanced.api.updateSavedView(current, edit, { unknownRulePolicy: 'block' });
      if (!result.supported) throw new Error(result.detail ?? t('library.updateViewUnavailable'));
      setPresetRefined(false);
      await publishSavedView(activeProfileId, result.value);
      await refreshLibrary();
      await hapticFeedback('confirm');
    } catch (error) {
      Alert.alert(t('library.updateViewFailed'), presentRuntimeError(error, t('library.changeRejected')));
    }
  }

  const choiceOptions = choiceRequest?.kind === 'tags'
    ? catalog.tags
    : choiceRequest?.kind === 'setCorrespondent'
      ? catalog.correspondents
      : choiceRequest?.kind === 'setDocumentType'
        ? catalog.documentTypes
        : choiceRequest?.kind === 'setStoragePath'
          ? catalog.storagePaths
          : catalog.owners;
  const choiceTitle = choiceRequest?.kind === 'tags'
    ? t(choiceRequest.mode === 'add' ? 'library.addTagsChoice' : choiceRequest.mode === 'remove' ? 'library.removeTagsChoice' : 'library.replacementTagsChoice')
    : choiceRequest?.kind === 'setCorrespondent'
      ? t('bulk.correspondent')
      : choiceRequest?.kind === 'setDocumentType'
        ? t('bulk.documentType')
        : choiceRequest?.kind === 'setStoragePath'
          ? t('bulk.storagePath')
          : t('bulk.owner');

  const listHeader = (
    <View style={styles.listHeader}>
      {!profileConfigured && <DemoModeBanner />}
      <View style={styles.header}>
        {selectionActive ? (
          <>
            <View style={styles.selectionCopy}>
              <Text accessibilityLiveRegion="polite" style={styles.selectionTitle}>{t('library.selectedCount', { count: formatNumber(selection.selected) })}</Text>
              <Text style={styles.selectionMeta}>{selection.hiddenSelected ? t('library.shownHidden', { shown: formatNumber(selection.shownSelected), hidden: formatNumber(selection.hiddenSelected) }) : t('library.shownCount', { count: formatNumber(selection.shownSelected) })}</Text>
            </View>
            <View style={styles.headerTools}>
              <Pressable accessibilityLabel={t('library.selectShownLabel')} disabled={!selection.shown} onPress={() => setSelectedIds((current) => selectShownDocuments(current, filteredDocuments))} style={styles.selectTextButton}>
                <Text style={styles.selectText}>{t('library.selectShown')}</Text>
              </Pressable>
              <Pressable accessibilityLabel={t('library.exitSelection')} onPress={exitSelection} style={styles.headerIconButton}><X color={palette.ink} size={20} /></Pressable>
            </View>
          </>
        ) : (
          <>
            <Text style={styles.title}>{t('library.title')}</Text>
            <View style={styles.headerTools}>
              <Pressable accessibilityLabel={t('library.selectDocuments')} disabled={!filteredDocuments.length} onPress={() => setSelectionActive(true)} style={styles.selectTextButton}>
                <CheckSquare2 color={palette.ink} size={16} />
                <Text style={styles.selectText}>{t('library.select')}</Text>
              </Pressable>
              <View accessibilityRole="radiogroup" style={styles.viewToggle}>
                <Pressable
                  accessibilityLabel={t('library.listView')}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: !useGrid }}
                  onPress={() => {
                    setViewMode('list');
                    if (activeSavedView) setPresetRefined(true);
                  }}
                  style={[styles.toggleButton, !useGrid && styles.toggleButtonActive]}>
                  <List color={!useGrid ? palette.paper : palette.muted} size={18} />
                </Pressable>
                <Pressable
                  accessibilityLabel={t('library.gridView')}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: useGrid }}
                  onPress={() => {
                    setViewMode('grid');
                    if (activeSavedView) setPresetRefined(true);
                  }}
                  style={[styles.toggleButton, useGrid && styles.toggleButtonActive]}>
                  <LayoutGrid color={useGrid ? palette.paper : palette.muted} size={17} />
                </Pressable>
              </View>
            </View>
          </>
        )}
      </View>

      <View style={styles.search}>
        <Search color={palette.muted} size={19} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={updateQuery}
          accessibilityLabel={t('library.searchLabel')}
          placeholder={profileConfigured ? t('library.searchConnected') : t('library.searchDemo')}
          placeholderTextColor={palette.faint}
          returnKeyType="search"
          style={styles.searchInput}
          value={query}
        />
        <View style={styles.searchActions}>
          {searchPending && <ActivityIndicator color={palette.muted} size="small" />}
          {!!query && (
            <Pressable
              accessibilityLabel={t('library.clearSearch')}
              haptic="light"
              onPress={() => updateQuery('')}
              style={styles.iconButton}>
              <X color={palette.muted} size={18} />
            </Pressable>
          )}
          <Pressable
            accessibilityLabel={effectiveFilterCount
              ? t('library.openFiltersActive', { count: formatNumber(effectiveFilterCount) })
              : t('library.openFilters')}
            haptic="medium"
            onPress={openFilters}
            style={[styles.filterButton, effectiveFilterCount > 0 && styles.filterButtonActive]}>
            <Filter color={effectiveFilterCount ? palette.accentInk : palette.ink} size={18} />
            {!!effectiveFilterCount && (
              <View style={styles.filterBadge}>
                <Text style={styles.filterBadgeText}>{formatNumber(effectiveFilterCount)}</Text>
              </View>
            )}
          </Pressable>
        </View>
      </View>

      {connected && !selectionActive && (
        <ScrollView horizontal contentContainerStyle={styles.managementActions} showsHorizontalScrollIndicator={false}>
          {(narrowed || sortOrder !== 'added-desc') && (
            <Pressable accessibilityState={{ disabled: advanced.phase !== 'ready' }} disabled={advanced.phase !== 'ready'} onPress={() => {
              const currentName = catalog.savedViews.find((view) => view.id === activeSavedView)?.name;
              setSavedViewEditor({ mode: 'create', initialName: currentName ? t('savedViews.copyName', { name: currentName }) : query.trim() || t('library.mySavedView') });
            }} style={styles.managementButton}>
              <Save color={palette.ink} size={15} />
              <Text style={styles.managementButtonText}>{activeSavedView && presetRefined ? t('library.saveAsNew') : t('library.saveView')}</Text>
            </Pressable>
          )}
          {activeSavedView && presetRefined && (
            <Pressable accessibilityState={{ disabled: advanced.phase !== 'ready' }} disabled={advanced.phase !== 'ready'} onPress={() => void updateCurrentView()} style={styles.managementButtonStrong}>
              <Save color={palette.accentInk} size={15} />
              <Text style={styles.managementButtonStrongText}>{t('library.updateView')}</Text>
            </Pressable>
          )}
          <Pressable onPress={() => router.push('/saved-views')} style={styles.managementButton}>
            <Bookmark color={palette.ink} size={15} />
            <Text style={styles.managementButtonText}>{t('library.manageViews')}</Text>
          </Pressable>
          <Pressable onPress={() => router.push('/paperless-metadata')} style={styles.managementButton}>
            <FolderTree color={palette.ink} size={15} />
            <Text style={styles.managementButtonText}>{t('metadata.title')}</Text>
          </Pressable>
        </ScrollView>
      )}

      {!!catalog.savedViews.length && (
        <View style={styles.savedViewsBlock}>
          <View style={styles.savedViewsLabelRow}>
            <Bookmark color={palette.ink} size={15} />
            <Text style={styles.savedViewsLabel}>{t('library.savedPresets')}</Text>
          </View>
          <ScrollView
            horizontal
            contentContainerStyle={styles.savedViews}
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}>
            {catalog.savedViews.map((view) => {
              const active = activeSavedView === view.id;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  key={view.id}
                  onPress={() => selectSavedView(view.id)}
                  onLongPress={() => router.push({ pathname: '/saved-views', params: { id: view.remoteId } })}
                  accessibilityHint={t('library.manageViewHint')}
                  style={[styles.savedView, active && styles.savedViewActive]}>
                  <Text numberOfLines={1} style={[styles.savedViewText, active && styles.savedViewTextActive]}>
                    {view.name}{active && presetRefined ? ` · ${t('library.refined')}` : ''}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}

      <View style={styles.quickBlock}>
        <Text style={styles.quickLabel}>{t('library.quickFilters')}</Text>
        <ScrollView
          horizontal
          contentContainerStyle={styles.quickFilters}
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}>
          <QuickFilter
            active={false}
            icon
            label={t('library.allFilters')}
            onPress={openFilters}
          />
          <QuickFilter
            active={filters.status === 'inbox'}
            label={t('library.inbox')}
            onPress={() => toggleQuickFilter('inbox')}
          />
          <QuickFilter
            active={filters.status === 'untagged'}
            label={t('library.untagged')}
            onPress={() => toggleQuickFilter('untagged')}
          />
          <QuickFilter
            active={filters.mimeTypes.includes('application/pdf')}
            label={t('library.pdfs')}
            onPress={() => toggleQuickFilter('pdf')}
          />
          <QuickFilter
            active={filters.createdAfter === thisYear.after && filters.createdBefore === thisYear.before}
            label={t('library.thisYear')}
            onPress={() => toggleQuickFilter('year')}
          />
        </ScrollView>
      </View>

      {!!(criteria.length || extraRules.length) && (
        <View style={styles.appliedBlock}>
          <View style={styles.appliedHeader}>
            <Text style={styles.appliedLabel}>{t('library.applied')}</Text>
            <Pressable accessibilityLabel={t('library.clearAllFilters')} onPress={clearAll} style={styles.clearAllButton}>
              <Text style={styles.clearAllText}>{t('library.clearAll')}</Text>
            </Pressable>
          </View>
          <ScrollView
            horizontal
            contentContainerStyle={styles.appliedFilters}
            showsHorizontalScrollIndicator={false}>
            {!!extraRules.length && (
              <Pressable
                accessibilityLabel={extraRules.length === 1
                  ? t('library.removeAdvancedRuleOne')
                  : t('library.removeAdvancedRuleMany', { count: formatNumber(extraRules.length) })}
                onPress={() => {
                  setExtraRules([]);
                  if (activeSavedView) setPresetRefined(true);
                }}
                style={styles.appliedFilter}>
                <Text numberOfLines={1} style={styles.appliedFilterText}>
                  {t('library.advancedRules', { count: formatNumber(extraRules.length) })}
                </Text>
                <X color={palette.ink} size={13} />
              </Pressable>
            )}
            {criteria.map((criterion) => (
              <Pressable
                accessibilityLabel={t('library.removeFilter', { label: criterion.label })}
                key={criterion.key}
                onPress={() => clearCriterion(criterion.key)}
                style={styles.appliedFilter}>
                <Text numberOfLines={1} style={styles.appliedFilterText}>{criterion.label}</Text>
                <X color={palette.ink} size={13} />
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {!!activeSavedView && !!extraRules.length && (
        <View style={styles.unsupportedRules}>
          <Text style={styles.unsupportedRulesTitle}>{t('library.unsupportedRules')}</Text>
          <Text style={styles.unsupportedRulesCopy}>{t('library.unsupportedRulesCopy')}</Text>
        </View>
      )}

      {!!activeSavedView && !!extraRules.length && online === false && !!remoteDocuments && (
        <View accessibilityLiveRegion="polite" style={styles.unsupportedRules}>
          <Text style={styles.unsupportedRulesTitle}>{t('library.savedViewCached')}</Text>
          <Text style={styles.unsupportedRulesCopy}>{t('library.savedViewCachedCopy')}</Text>
        </View>
      )}

      {!!remoteError && (
        <View accessibilityLiveRegion="polite" style={styles.errorBanner}>
          <View style={styles.errorCopy}>
            <Text style={styles.errorTitle}>{t('library.localMatches')}</Text>
            <Text numberOfLines={2} style={styles.errorText}>{remoteError}</Text>
          </View>
          <Pressable onPress={() => setRetryKey((current) => current + 1)} style={styles.retryButton}>
            <RotateCcw color={palette.ink} size={15} />
            <Text style={styles.retryText}>{t('library.retry')}</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.resultHeader}>
        <Text accessibilityLiveRegion="polite" style={styles.resultCount}>
          {remoteLoading
            ? t('library.shownSearching', { shown: formatNumber(filteredDocuments.length) })
            : narrowed
              ? t(totalDocuments === 1 ? 'library.countOfOne' : 'library.countOfMany', {
                  shown: formatNumber(filteredDocuments.length),
                  total: formatNumber(totalDocuments),
                })
              : filteredDocuments.length === 1
                ? t('library.countOne')
                : t('library.countMany', { count: formatNumber(filteredDocuments.length) })}
        </Text>
        <Pressable
          accessibilityLabel={t('library.sortOrder', { order: librarySortLabel(t, sortOrder) })}
          haptic="light"
          onPress={openSort}
          style={styles.resultSortButton}>
          <SlidersHorizontal color={palette.muted} size={13} />
          <Text numberOfLines={1} style={styles.resultSort}>{librarySortLabel(t, sortOrder)}</Text>
        </Pressable>
      </View>
      {selectionActive && (
        <View style={styles.selectionBar}>
          <View style={styles.selectionBarCopy}>
            <Text style={styles.selectionBarTitle}>{t('library.eligibleShort', { count: formatNumber(eligibleSelection.length) })}</Text>
            <Text numberOfLines={2} style={styles.selectionBarMeta}>{t('library.skippedCopy')}</Text>
          </View>
          {!!selection.selected && (
            <Pressable onPress={() => setSelectedIds(new Set())} style={styles.clearSelectionButton}>
              <Text style={styles.clearSelectionText}>{t('library.clear')}</Text>
            </Pressable>
          )}
          <Pressable accessibilityLabel={t('library.openBulkActions')} accessibilityState={{ disabled: !selection.selected || advanced.phase !== 'ready' }} disabled={!selection.selected || advanced.phase !== 'ready'} onPress={() => { setBulkResult(null); setBulkOpen(true); }} style={[styles.bulkButton, (!selection.selected || advanced.phase !== 'ready') && styles.disabledButton]}>
            <MoreHorizontal color={palette.accentInk} size={18} />
            <Text style={styles.bulkButtonText}>{t('library.actions')}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );

  return (
    <AppShell scrollable={false} showDemoBanner={false}>
      <View style={styles.librarySurfaces}>
        {([false, true] as const).map((grid) => {
          const active = useGrid === grid;
          return (
            <View
              accessibilityElementsHidden={!active}
              importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
              key={grid ? 'grid' : 'list'}
              pointerEvents={active ? 'auto' : 'none'}
              style={[
                styles.librarySurface,
                { transform: [{ translateX: active ? 0 : width }] },
              ]}>
              <FlashList
                contentContainerStyle={styles.libraryContent}
                contentInsetAdjustmentBehavior="automatic"
                data={filteredDocuments}
                drawDistance={360}
                ItemSeparatorComponent={ResultSeparator}
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
                keyExtractor={documentKey}
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <View style={styles.emptyIcon}>
                      {narrowed
                        ? <Filter color={palette.accentInk} size={26} />
                        : <Search color={palette.accentInk} size={26} />}
                    </View>
                    <Text style={styles.emptyTitle}>
                      {narrowed ? t('library.noMatch') : t('library.empty')}
                    </Text>
                    <Text style={styles.emptyCopy}>
                      {narrowed
                        ? t('library.noMatchCopy')
                        : t('library.emptyCopy')}
                    </Text>
                    {narrowed && (
                      <View style={styles.emptyActions}>
                        <Pressable onPress={openFilters} style={styles.emptyPrimary}>
                          <Filter color={palette.accentInk} size={16} />
                          <Text style={styles.emptyPrimaryText}>{t('library.editFilters')}</Text>
                        </Pressable>
                        <Pressable onPress={clearAll} style={styles.emptySecondary}>
                          <Text style={styles.emptySecondaryText}>{t('library.clearAll')}</Text>
                        </Pressable>
                      </View>
                    )}
                  </View>
                }
                ListHeaderComponent={listHeader}
                maintainVisibleContentPosition={{ disabled: true }}
                numColumns={2}
                overrideItemLayout={grid ? singleColumnSpan : fullWidthSpan}
                refreshControl={
                  <RefreshControl
                    colors={[palette.ink]}
                    onRefresh={() => void refreshLibrary()}
                    refreshing={isSyncing}
                    tintColor={palette.ink}
                  />
                }
                renderItem={grid ? renderGridDocument : renderListDocument}
                scrollIndicatorInsets={{ bottom: bottomNavHeight }}
                showsVerticalScrollIndicator={false}
                style={styles.libraryList}
              />
            </View>
          );
        })}
      </View>
      <LibraryFilterSheet
        catalog={catalog}
        extraRuleCount={extraRules.length}
        filters={filters}
        getPreviewCount={getLocalPreviewCount}
        mimeTypes={mimeTypes}
        onApply={updateFilters}
        onClose={() => setFilterSheetOpen(false)}
        visible={filterSheetOpen}
      />
      <LibrarySortSheet
        onClose={() => setSortSheetOpen(false)}
        onSelect={(next) => {
          setSortOrder(next);
          if (activeSavedView) setPresetRefined(true);
        }}
        sortOrder={sortOrder}
        visible={sortSheetOpen}
      />
      <BulkActionSheet
        busy={bulkBusy}
        capabilities={advanced.phase === 'ready' ? advanced.capabilities : null}
        onClose={() => setBulkOpen(false)}
        onRequest={(request) => void requestBulkAction(request)}
        onRetryFailed={retryBulkFailures}
        result={bulkResult}
        selection={selection}
        visible={bulkOpen}
      />
      <ChoiceSheet
        allowNone={choiceRequest?.kind !== 'tags'}
        multiple={choiceRequest?.kind === 'tags'}
        onClose={() => setChoiceRequest(null)}
        onConfirm={applyChoice}
        options={choiceOptions}
        selectedIds={[]}
        title={choiceTitle}
        visible={!!choiceRequest}
      />
      {!!savedViewEditor && (
        <SavedViewEditorSheet
          displayFieldOptions={savedViewDisplayFieldOptions}
          initialName={savedViewEditor.initialName}
          initialPresentation={{
            displayMode: savedViewPresentation?.displayMode
              ?? paperlessSavedViewDisplayMode(useGrid ? 'grid' : 'list'),
            pageSize: savedViewPresentation?.pageSize ?? 50,
            displayFields: savedViewPresentation?.displayFields ?? [],
            ...(typeof savedViewExtra.show_on_dashboard === 'boolean'
              ? { showOnDashboard: savedViewExtra.show_on_dashboard }
              : {}),
            ...(typeof savedViewExtra.show_in_sidebar === 'boolean'
              ? { showInSidebar: savedViewExtra.show_in_sidebar }
              : {}),
          }}
          mode="create"
          onClose={() => setSavedViewEditor(null)}
          onSave={saveCurrentView}
          presentationCapabilities={{
            displayMode: advanced.phase === 'ready'
              && advanced.capabilities.features.savedViews.fields?.displayMode.supported === true,
            pageSize: advanced.phase === 'ready'
              && advanced.capabilities.features.savedViews.fields?.pageSize.supported === true,
            displayFields: advanced.phase === 'ready'
              && advanced.capabilities.features.savedViews.fields?.displayFields.supported === true,
            showOnDashboard: advanced.phase === 'ready'
              && advanced.capabilities.features.savedViews.fields?.showOnDashboard.supported === true,
            showInSidebar: advanced.phase === 'ready'
              && advanced.capabilities.features.savedViews.fields?.showInSidebar.supported === true,
          }}
          visible
        />
      )}
    </AppShell>
  );
});

type FilterCriterionKey =
  | 'status'
  | 'correspondents'
  | 'documentTypes'
  | 'tags'
  | 'storagePaths'
  | 'owners'
  | 'customFields'
  | 'mimeTypes'
  | 'created'
  | 'added'
  | 'modified'
  | 'archive';

type FilterCriterion = { key: FilterCriterionKey; label: string };
type Translator = (key: TranslationKey, values?: Record<string, string | number>) => string;

const sortTranslationKeys: Record<LibrarySortOrder, TranslationKey> = {
  'added-desc': 'sort.addedDesc',
  'added-asc': 'sort.addedAsc',
  'created-desc': 'sort.createdDesc',
  'created-asc': 'sort.createdAsc',
  'title-asc': 'sort.titleAsc',
  'title-desc': 'sort.titleDesc',
  'correspondent-asc': 'sort.correspondent',
  'document-type-asc': 'sort.documentType',
};

function librarySortLabel(t: Translator, sortOrder: LibrarySortOrder) {
  return t(sortTranslationKeys[sortOrder]);
}

function libraryCriteria(
  filters: LibraryFilters,
  catalog: PaperlessCatalog,
  t: Translator,
  formatNumber: (value: number) => string,
): FilterCriterion[] {
  const criteria: FilterCriterion[] = [];
  if (filters.status !== 'any') {
    criteria.push({
      key: 'status',
      label: t(filters.status === 'inbox'
        ? 'library.inbox'
        : filters.status === 'tagged'
          ? 'library.tagged'
          : 'library.untagged'),
    });
  }
  if (filters.correspondentIds.length || filters.correspondentMissing) {
    criteria.push({
      key: 'correspondents',
      label: selectionLabel(
        t('library.correspondent'),
        filters.correspondentIds,
        catalog.correspondents,
        filters.correspondentMode,
        filters.correspondentMissing,
        t,
        formatNumber,
      ),
    });
  }
  if (filters.documentTypeIds.length || filters.documentTypeMissing) {
    criteria.push({
      key: 'documentTypes',
      label: selectionLabel(
        t('library.type'),
        filters.documentTypeIds,
        catalog.documentTypes,
        filters.documentTypeMode,
        filters.documentTypeMissing,
        t,
        formatNumber,
      ),
    });
  }
  if (filters.tagIds.length) {
    const prefix = t(filters.tagMode === 'none'
      ? 'library.withoutTags'
      : filters.tagMode === 'all'
        ? 'library.allTags'
        : 'library.tags');
    criteria.push({ key: 'tags', label: optionLabel(prefix, filters.tagIds, catalog.tags, t, formatNumber) });
  }
  if (filters.storagePathIds.length || filters.storagePathMissing) {
    criteria.push({
      key: 'storagePaths',
      label: selectionLabel(
        t('library.storage'),
        filters.storagePathIds,
        catalog.storagePaths,
        filters.storagePathMode,
        filters.storagePathMissing,
        t,
        formatNumber,
      ),
    });
  }
  if (filters.ownerIds.length || filters.ownerMissing) {
    criteria.push({
      key: 'owners',
      label: selectionLabel(
        t('library.owner'),
        filters.ownerIds,
        catalog.owners,
        filters.ownerMode,
        filters.ownerMissing,
        t,
        formatNumber,
      ),
    });
  }
  if (filters.customFieldIds.length) {
    const options = catalog.customFields.map((field) => ({ id: field.id, name: field.name }));
    const prefix = t(filters.customFieldMode === 'none'
      ? 'library.withoutFields'
      : filters.customFieldMode === 'all'
        ? 'library.allFields'
        : 'library.fields');
    criteria.push({
      key: 'customFields',
      label: optionLabel(prefix, filters.customFieldIds, options, t, formatNumber),
    });
  }
  if (filters.mimeTypes.length) {
    criteria.push({
      key: 'mimeTypes',
      label: filters.mimeTypes.length === 1
        ? filters.mimeTypes[0] === 'application/pdf' ? t('library.pdfs') : filters.mimeTypes[0]
        : t('library.fileTypes', { count: formatNumber(filters.mimeTypes.length) }),
    });
  }
  if (filters.createdAfter || filters.createdBefore) {
    criteria.push({ key: 'created', label: dateLabel(t('library.documentDate'), filters.createdAfter, filters.createdBefore, t) });
  }
  if (filters.addedAfter || filters.addedBefore) {
    criteria.push({ key: 'added', label: dateLabel(t('library.added'), filters.addedAfter, filters.addedBefore, t) });
  }
  if (filters.modifiedAfter || filters.modifiedBefore) {
    criteria.push({ key: 'modified', label: dateLabel(t('library.modified'), filters.modifiedAfter, filters.modifiedBefore, t) });
  }
  if (filters.archiveSerialMin || filters.archiveSerialMax || filters.archiveSerialMissing) {
    criteria.push({
      key: 'archive',
      label: filters.archiveSerialMissing
        ? t('library.noArchiveSerial')
        : filters.archiveSerialMin && filters.archiveSerialMax
          ? t('library.archiveRange', { min: filters.archiveSerialMin, max: filters.archiveSerialMax })
          : filters.archiveSerialMin
            ? t('library.archiveAfter', { value: filters.archiveSerialMin })
            : t('library.archiveBefore', { value: filters.archiveSerialMax }),
    });
  }
  return criteria;
}

function optionLabel(
  prefix: string,
  ids: string[],
  options: { id: string; name: string; pathLabel?: string }[],
  t: Translator,
  formatNumber: (value: number) => string,
) {
  if (ids.length === 1) {
    const option = options.find((item) => item.id === ids[0]);
    return `${prefix} · ${option?.pathLabel || option?.name || t('library.oneSelected')}`;
  }
  return `${prefix} · ${formatNumber(ids.length)}`;
}

function selectionLabel(
  prefix: string,
  ids: string[],
  options: { id: string; name: string; pathLabel?: string }[],
  mode: 'include' | 'exclude',
  missing: boolean,
  t: Translator,
  formatNumber: (value: number) => string,
) {
  if (missing) {
    return mode === 'include'
      ? t('library.noneAssigned', { label: prefix.toLocaleLowerCase() })
      : t('library.assigned', { label: prefix });
  }
  return optionLabel(
    mode === 'exclude' ? t('library.exclude', { label: prefix.toLocaleLowerCase() }) : prefix,
    ids,
    options,
    t,
    formatNumber,
  );
}

function dateLabel(prefix: string, after: string, before: string, t: Translator) {
  if (after && before) return t('library.dateRange', { label: prefix, after, before });
  return after
    ? t('library.dateAfter', { label: prefix, date: after })
    : t('library.dateBefore', { label: prefix, date: before });
}

function clearFilterCriterion(filters: LibraryFilters, key: FilterCriterionKey): LibraryFilters {
  switch (key) {
    case 'status': return { ...filters, status: 'any' };
    case 'correspondents': return { ...filters, correspondentIds: [], correspondentMissing: false, correspondentMode: 'include' };
    case 'documentTypes': return { ...filters, documentTypeIds: [], documentTypeMissing: false, documentTypeMode: 'include' };
    case 'tags': return { ...filters, tagIds: [], tagMode: 'any' };
    case 'storagePaths': return { ...filters, storagePathIds: [], storagePathMissing: false, storagePathMode: 'include' };
    case 'owners': return { ...filters, ownerIds: [], ownerMissing: false, ownerMode: 'include' };
    case 'customFields': return { ...filters, customFieldIds: [], customFieldMode: 'any' };
    case 'mimeTypes': return { ...filters, mimeTypes: [] };
    case 'created': return { ...filters, createdAfter: '', createdBefore: '' };
    case 'added': return { ...filters, addedAfter: '', addedBefore: '' };
    case 'modified': return { ...filters, modifiedAfter: '', modifiedBefore: '' };
    case 'archive': return { ...filters, archiveSerialMin: '', archiveSerialMax: '', archiveSerialMissing: false };
  }
}

function QuickFilter({
  active,
  icon,
  label,
  onPress,
}: {
  active: boolean;
  icon?: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: active }}
      onPress={onPress}
      style={[styles.quickFilter, active && styles.quickFilterActive]}>
      {icon && <Filter color={active ? palette.paper : palette.ink} size={14} />}
      <Text style={[styles.quickFilterText, active && styles.quickFilterTextActive]}>{label}</Text>
    </Pressable>
  );
}

function fullWidthSpan(layout: { span?: number }) {
  layout.span = 2;
}

function singleColumnSpan(layout: { span?: number }) {
  layout.span = 1;
}

function documentKey(document: DocumentItem) {
  return document.id;
}

function ResultSeparator() {
  return <View style={styles.resultSeparator} />;
}

const LibraryDocument = memo(function LibraryDocument({
  column,
  document,
  grid,
  onOpen,
  onPreload,
  onSelect,
  selected,
  selectionActive,
}: {
  column: 'left' | 'right';
  document: DocumentItem;
  grid: boolean;
  onOpen: (id: string) => void;
  onPreload: (id: string) => void;
  onSelect: (id: string) => void;
  selected: boolean;
  selectionActive: boolean;
}) {
  const { formatDocumentDate, formatNumber, t } = useI18n();
  return (
    <Pressable
      accessibilityHint={selectionActive ? t('library.toggleSelectionHint') : t('library.openSelectHint', { details: t('library.openDetails') })}
      accessibilityLabel={document.title}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      haptic="light"
      onLongPress={() => onSelect(document.id)}
      onPress={() => selectionActive ? onSelect(document.id) : onOpen(document.id)}
      onPressIn={() => { if (!selectionActive) onPreload(document.id); }}
      style={[
        grid ? styles.gridCard : styles.listCard,
        grid && (column === 'left' ? styles.gridCardLeft : styles.gridCardRight),
        selected && styles.documentSelected,
      ]}>
      {selectionActive && (
        <View style={[styles.selectionCheck, selected && styles.selectionCheckActive]}>
          {selected && <Check color={palette.accentInk} size={14} strokeWidth={3} />}
        </View>
      )}
      <PaperThumbnail document={document} width={grid ? 112 : 68} />
      <View style={grid ? styles.gridBody : styles.listBody}>
        <Text numberOfLines={2} style={grid ? styles.gridTitle : styles.documentTitle}>
          {document.title}
        </Text>
        <Text numberOfLines={1} style={styles.documentMeta}>
          {grid ? document.correspondent : `${document.correspondent} · ${document.documentType}`}
        </Text>
        {grid ? (
          <Text style={styles.date}>{formatDocumentDate(document.addedAt ?? document.created)}</Text>
        ) : (
          <View style={styles.tags}>
            {!!document.duplicateDocumentIds?.length && (
              <View accessibilityLabel={t('document.duplicateCount', { count: formatNumber(document.duplicateDocumentIds.length) })} style={styles.duplicateTag}>
                <Text numberOfLines={1} style={styles.duplicateTagText}>{t('document.duplicatesBadge', { count: formatNumber(document.duplicateDocumentIds.length) })}</Text>
              </View>
            )}
            {document.tags.slice(0, 2).map((tag) => (
              <View key={tag} style={styles.tag}>
                <Text numberOfLines={1} style={styles.tagText}>{tag}</Text>
              </View>
            ))}
          </View>
        )}
      </View>
      {!grid && (
        <View style={styles.listAside}>
          <Text style={styles.date}>{formatDocumentDate(document.addedAt ?? document.created)}</Text>
          <Text style={styles.pages}>
            {t('library.pagesShort', { count: formatNumber(document.pageCount) })}
          </Text>
        </View>
      )}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  librarySurfaces: {
    flex: 1,
    width: '100%',
    overflow: 'hidden',
  },
  librarySurface: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  libraryList: {
    width: '100%',
  },
  libraryContent: {
    width: '100%',
    maxWidth: maxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: bottomNavHeight + 34,
  },
  listHeader: {
    width: '100%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginTop: 8,
    marginBottom: 22,
  },
  title: {
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 40,
    fontWeight: '600',
    letterSpacing: -1.3,
  },
  headerTools: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  headerIconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: palette.paper },
  selectTextButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, borderRadius: radii.sm, backgroundColor: palette.paper },
  selectText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 11, fontWeight: '900' },
  selectionCopy: { flex: 1, minWidth: 0 },
  selectionTitle: { color: palette.ink, fontFamily: fonts.serif, fontSize: 28, fontWeight: '700' },
  selectionMeta: { color: palette.muted, fontFamily: fonts.sans, fontSize: 10, fontWeight: '800', marginTop: 2 },
  viewToggle: {
    flexDirection: 'row',
    padding: 4,
    borderRadius: radii.md,
    backgroundColor: palette.paperStrong,
  },
  toggleButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  toggleButtonActive: {
    backgroundColor: palette.ink,
  },
  search: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingHorizontal: 15,
    borderRadius: radii.md,
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: palette.line,
  },
  searchInput: {
    flex: 1,
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 15,
  },
  searchActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  managementActions: { flexDirection: 'row', gap: 7, paddingRight: 9, marginTop: 10 },
  managementButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 11, borderRadius: radii.sm, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.paper },
  managementButtonText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900' },
  managementButtonStrong: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 11, borderRadius: radii.sm, backgroundColor: palette.lime },
  managementButtonStrongText: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900' },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15,
  },
  filterButton: {
    width: 46,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    backgroundColor: palette.canvas,
  },
  filterButtonActive: {
    backgroundColor: palette.lime,
  },
  filterBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
    borderRadius: 10,
    backgroundColor: palette.ink,
    borderWidth: 2,
    borderColor: palette.paper,
  },
  filterBadgeText: {
    color: palette.paper,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '900',
  },
  savedViewsBlock: {
    marginTop: 17,
  },
  savedViewsLabelRow: {
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  savedViewsLabel: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.65,
  },
  savedViews: {
    flexDirection: 'row',
    gap: 7,
    paddingRight: 8,
    marginTop: 7,
  },
  savedView: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: radii.sm,
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: palette.line,
  },
  savedViewActive: {
    backgroundColor: palette.ink,
    borderColor: palette.ink,
  },
  savedViewText: {
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '800',
  },
  savedViewTextActive: {
    color: palette.paper,
  },
  quickBlock: {
    marginTop: 16,
  },
  quickLabel: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.65,
  },
  quickFilters: {
    flexDirection: 'row',
    gap: 7,
    paddingRight: 8,
    marginTop: 8,
  },
  quickFilter: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 13,
    borderRadius: radii.pill,
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: palette.line,
  },
  quickFilterActive: {
    backgroundColor: palette.ink,
    borderColor: palette.ink,
  },
  quickFilterText: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '700',
  },
  quickFilterTextActive: {
    color: palette.paper,
  },
  appliedBlock: {
    marginTop: 14,
  },
  appliedHeader: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  appliedLabel: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.65,
  },
  clearAllButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  clearAllText: {
    color: palette.limeDark,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '900',
  },
  appliedFilters: {
    flexDirection: 'row',
    gap: 7,
    paddingRight: 8,
  },
  appliedFilter: {
    minHeight: 46,
    maxWidth: 260,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
    backgroundColor: palette.mint,
  },
  appliedFilterText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '800',
  },
  unsupportedRules: { padding: 12, marginTop: 10, borderRadius: radii.md, backgroundColor: palette.dangerSurface },
  unsupportedRulesTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 11, fontWeight: '900' },
  unsupportedRulesCopy: { color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 10, lineHeight: 15, marginTop: 3 },
  errorBanner: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 15,
    padding: 13,
    borderRadius: radii.md,
    backgroundColor: palette.dangerSurface,
  },
  errorCopy: {
    flex: 1,
    minWidth: 0,
  },
  errorTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '900',
  },
  errorText: {
    marginTop: 3,
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 10,
    lineHeight: 14,
  },
  retryButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 13,
    borderRadius: radii.sm,
    backgroundColor: palette.paper,
  },
  retryText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '900',
  },
  resultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 22,
    marginBottom: 12,
  },
  resultCount: {
    flex: 1,
    minWidth: 0,
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
    fontWeight: '800',
  },
  resultSort: {
    maxWidth: 142,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '700',
  },
  resultSortButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    marginLeft: 10,
    borderRadius: radii.sm,
    backgroundColor: palette.paperStrong,
  },
  resultSeparator: {
    height: 10,
  },
  selectionBar: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 9, padding: 11, marginTop: -4, marginBottom: 12, borderRadius: radii.lg, backgroundColor: palette.inverseSurface },
  selectionBarCopy: { flex: 1, minWidth: 0 },
  selectionBarTitle: { color: palette.onDark, fontFamily: fonts.sans, fontSize: 12, fontWeight: '900' },
  selectionBarMeta: { color: palette.cameraTextMuted, fontFamily: fonts.sans, fontSize: 9, lineHeight: 13, marginTop: 2 },
  clearSelectionButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  clearSelectionText: { color: palette.onDark, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900' },
  bulkButton: { minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13, borderRadius: radii.sm, backgroundColor: palette.lime },
  bulkButtonText: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 11, fontWeight: '900' },
  disabledButton: { opacity: 0.42 },
  listCard: {
    position: 'relative',
    height: 108,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    padding: 11,
    borderRadius: radii.lg,
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: palette.line,
  },
  listBody: {
    flex: 1,
    gap: 4,
  },
  documentTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 19,
    fontWeight: '800',
  },
  documentMeta: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 15,
  },
  tags: {
    flexDirection: 'row',
    gap: 5,
    marginTop: 2,
  },
  tag: {
    maxWidth: 88,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: radii.pill,
    backgroundColor: palette.canvas,
  },
  tagText: {
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '700',
  },
  listAside: {
    minWidth: 52,
    alignItems: 'flex-end',
    gap: 8,
  },
  date: {
    color: palette.faint,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '600',
  },
  pages: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
  },
  gridCard: {
    position: 'relative',
    minWidth: 0,
    minHeight: 246,
    padding: 12,
    gap: 5,
    borderRadius: radii.lg,
    backgroundColor: palette.paper,
  },
  documentSelected: { borderWidth: 2, borderColor: palette.limeDark, backgroundColor: palette.mint },
  selectionCheck: { position: 'absolute', zIndex: 3, top: 8, right: 8, width: 24, height: 24, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 2, borderColor: palette.lineStrong, backgroundColor: palette.paper },
  selectionCheckActive: { borderColor: palette.lime, backgroundColor: palette.lime },
  gridCardLeft: {
    marginRight: 5,
  },
  gridCardRight: {
    marginLeft: 5,
  },
  gridBody: {
    gap: 5,
  },
  duplicateTag: {
    maxWidth: 110,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.pill,
    backgroundColor: palette.dangerSurface,
  },
  duplicateTagText: {
    color: palette.danger,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '800',
  },
  gridTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '800',
    marginTop: 5,
  },
  empty: {
    alignItems: 'center',
    paddingTop: 18,
    paddingHorizontal: 28,
  },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: palette.lime,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 25,
    fontWeight: '600',
    marginTop: 12,
  },
  emptyCopy: {
    maxWidth: 300,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 4,
  },
  emptyActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  emptyPrimary: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 18,
    borderRadius: radii.md,
    backgroundColor: palette.lime,
  },
  emptyPrimaryText: {
    color: palette.accentInk,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '900',
  },
  emptySecondary: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    borderRadius: radii.md,
    backgroundColor: palette.paper,
  },
  emptySecondaryText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '900',
  },
  pressed: {
    opacity: 0.72,
    transform: [{ scale: 0.985 }],
  },
});
