import {
  Bookmark,
  Filter,
  LayoutGrid,
  List,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react-native';
import { FlashList } from '@shopify/flash-list';
import type { ListRenderItemInfo, ViewToken } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
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
import { DemoModeBanner } from '@/components/demo-mode-banner';
import { LibraryFilterSheet } from '@/components/library-filter-sheet';
import { LibrarySortSheet } from '@/components/library-sort-sheet';
import { MotionPressable as Pressable, hapticFeedback } from '@/components/motion';
import { PaperThumbnail } from '@/components/paper-thumbnail';
import { bottomNavHeight, fonts, maxContentWidth, palette, radii } from '@/constants/theme';
import { useApp } from '@/context/app-context';
import {
  cloneLibraryFilters,
  emptyLibraryFilters,
  libraryFilterCount,
  librarySortLabels,
  matchesLibraryFilters,
  savedViewToLibraryState,
  sortLibraryDocuments,
} from '@/lib/library-filters';
import { getPaperlessDocumentUrl, paperlessFileHeaders } from '@/lib/paperless';
import { useNavigationRoute, useRouter } from '@/lib/router';
import {
  DocumentItem,
  LibraryFilters,
  LibrarySortOrder,
  PaperlessCatalog,
  PaperlessSavedViewRule,
} from '@/types/document';

export default function DocumentsRoute() {
  const route = useNavigationRoute();
  const active = route.pathname === '/documents';
  return (
    <DocumentsScreen
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
  const { width } = useWindowDimensions();
  const {
    connected,
    credentials,
    documents,
    catalog,
    totalDocuments,
    isSyncing,
    refresh,
    searchLibrary,
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
  const [extraRules, setExtraRules] = useState<PaperlessSavedViewRule[]>([]);
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
  const credentialsRef = useRef(credentials);
  const remoteRequestId = useRef(0);
  const prefetchedDocumentIds = useRef(new Set<string>());
  const prewarmedFirstDocumentId = useRef<string | null>(null);

  useEffect(() => {
    credentialsRef.current = credentials;
    prefetchedDocumentIds.current.clear();
  }, [credentials]);

  useEffect(() => {
    const firstDocument = documents[0];
    if (!firstDocument || prewarmedFirstDocumentId.current === firstDocument.id) return;
    const timer = setTimeout(() => {
      prewarmedFirstDocumentId.current = firstDocument.id;
      router.preload({ pathname: '/document/[id]', params: { id: firstDocument.id } });
    }, 450);
    return () => clearTimeout(timer);
  }, [documents, router]);

  const prefetchVisiblePreviews = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<DocumentItem>[] }) => {
      const currentCredentials = credentialsRef.current;
      if (!currentCredentials) return;
      const nextDocuments = viewableItems
        .map((token) => token.item)
        .filter((document): document is DocumentItem => Boolean(
          document?.remoteId && !prefetchedDocumentIds.current.has(document.id),
        ));
      if (!nextDocuments.length) return;
      nextDocuments.forEach((document) => prefetchedDocumentIds.current.add(document.id));
      void Image.prefetch(
        nextDocuments.map((document) =>
          getPaperlessDocumentUrl(currentCredentials, document.remoteId!, 'thumb'),
        ),
        {
          cachePolicy: 'memory-disk',
          headers: paperlessFileHeaders(currentCredentials.token),
        },
      );
    },
    [],
  );

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
    () => JSON.stringify({ query: deferredQuery.trim(), filters, extraRules }),
    [deferredQuery, extraRules, filters],
  );

  useEffect(() => {
    const requestId = ++remoteRequestId.current;
    if (!remoteRequired) return;

    const timer = setTimeout(() => {
      setRemoteState({ phase: 'loading', signature: requestSignature });
      void searchLibrary({ query: deferredQuery.trim(), filters, extraRules })
        .then((result) => {
          if (remoteRequestId.current !== requestId) return;
          setRemoteResult({ documents: result.documents, signature: requestSignature });
          setRemoteState({ phase: 'ready', signature: requestSignature });
        })
        .catch((error) => {
          if (remoteRequestId.current !== requestId) return;
          setRemoteState({
            message: error instanceof Error
              ? error.message
              : 'Could not refresh these filtered results.',
            phase: 'error',
            signature: requestSignature,
          });
          void hapticFeedback('error');
        });
    }, deferredQuery.trim() ? 320 : 30);
    return () => clearTimeout(timer);
  }, [deferredQuery, extraRules, filters, remoteRequired, requestSignature, retryKey, searchLibrary]);

  const remoteDocuments = remoteRequired && remoteResult?.signature === requestSignature
    ? remoteResult.documents
    : null;
  const remoteLoading = remoteRequired && remoteState?.signature === requestSignature
    && remoteState.phase === 'loading';
  const remoteError = remoteRequired && remoteState?.signature === requestSignature
    && remoteState.phase === 'error'
    ? remoteState.message || 'Could not refresh these filtered results.'
    : null;
  const filteredDocuments = useMemo(
    () => sortLibraryDocuments(remoteDocuments ?? localDocuments, sortOrder),
    [localDocuments, remoteDocuments, sortOrder],
  );
  const searchPending = query !== deferredQuery || remoteLoading;

  function clearAll() {
    setQuery('');
    setFilters(cloneLibraryFilters(emptyLibraryFilters));
    setActiveSavedView(null);
    setPresetRefined(false);
    setExtraRules([]);
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
    setExtraRules(preset.extraRules);
    setSortOrder(preset.sortOrder);
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
    } catch (error) {
      setRemoteState({
        message: error instanceof Error ? error.message : 'Could not refresh the library.',
        phase: 'error',
        signature: requestSignature,
      });
      await hapticFeedback('error');
    }
  }, [refresh, requestSignature]);

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
      />,
    [openDocument, preloadDocument],
  );
  const renderGridDocument = useCallback(
    ({ index, item }: ListRenderItemInfo<DocumentItem>) =>
      <LibraryDocument
        column={index % 2 === 0 ? 'left' : 'right'}
        document={item}
        grid
        onOpen={openDocument}
        onPreload={preloadDocument}
      />,
    [openDocument, preloadDocument],
  );
  const mimeTypes = useMemo(
    () => [...new Set(documents.map((document) => document.mimeType).filter((value): value is string => Boolean(value)))].sort(),
    [documents],
  );
  const criteria = useMemo(() => libraryCriteria(filters, catalog), [catalog, filters]);
  const narrowed = !!query.trim() || activeFilterCount > 0 || extraRules.length > 0;
  const openFilters = useCallback(() => {
    Keyboard.dismiss();
    setFilterSheetOpen(true);
  }, []);
  const openSort = useCallback(() => {
    Keyboard.dismiss();
    setSortSheetOpen(true);
  }, []);

  const listHeader = (
    <View style={styles.listHeader}>
      {!connected && <DemoModeBanner />}
      <View style={styles.header}>
        <Text style={styles.title}>Library</Text>
        <View accessibilityRole="radiogroup" style={styles.viewToggle}>
          <Pressable
            accessibilityLabel="List view"
            accessibilityRole="radio"
            accessibilityState={{ checked: !useGrid }}
            onPress={() => setViewMode('list')}
            style={[styles.toggleButton, !useGrid && styles.toggleButtonActive]}>
            <List color={!useGrid ? palette.paper : palette.muted} size={18} />
          </Pressable>
          <Pressable
            accessibilityLabel="Grid view"
            accessibilityRole="radio"
            accessibilityState={{ checked: useGrid }}
            onPress={() => setViewMode('grid')}
            style={[styles.toggleButton, useGrid && styles.toggleButtonActive]}>
            <LayoutGrid color={useGrid ? palette.paper : palette.muted} size={17} />
          </Pressable>
        </View>
      </View>

      <View style={styles.search}>
        <Search color={palette.muted} size={19} />
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setQuery}
          accessibilityLabel="Search all documents"
          placeholder={connected ? 'Search every document' : 'Search titles, correspondents, tags…'}
          placeholderTextColor={palette.faint}
          returnKeyType="search"
          style={styles.searchInput}
          value={query}
        />
        <View style={styles.searchActions}>
          {searchPending && <ActivityIndicator color={palette.muted} size="small" />}
          {!!query && (
            <Pressable
              accessibilityLabel="Clear search"
              haptic="light"
              onPress={() => setQuery('')}
              style={styles.iconButton}>
              <X color={palette.muted} size={18} />
            </Pressable>
          )}
          <Pressable
            accessibilityLabel={`Open filters${effectiveFilterCount ? `, ${effectiveFilterCount} active` : ''}`}
            haptic="medium"
            onPress={openFilters}
            style={[styles.filterButton, effectiveFilterCount > 0 && styles.filterButtonActive]}>
            <Filter color={palette.ink} size={18} />
            {!!effectiveFilterCount && (
              <View style={styles.filterBadge}>
                <Text style={styles.filterBadgeText}>{effectiveFilterCount}</Text>
              </View>
            )}
          </Pressable>
        </View>
      </View>

      {!!catalog.savedViews.length && (
        <View style={styles.savedViewsBlock}>
          <View style={styles.savedViewsLabelRow}>
            <Bookmark color={palette.ink} size={15} />
            <Text style={styles.savedViewsLabel}>SAVED PRESETS</Text>
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
                  style={[styles.savedView, active && styles.savedViewActive]}>
                  <Text numberOfLines={1} style={[styles.savedViewText, active && styles.savedViewTextActive]}>
                    {view.name}{active && presetRefined ? ' · refined' : ''}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}

      <View style={styles.quickBlock}>
        <Text style={styles.quickLabel}>QUICK FILTERS</Text>
        <ScrollView
          horizontal
          contentContainerStyle={styles.quickFilters}
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}>
          <QuickFilter
            active={false}
            icon
            label="All filters"
            onPress={openFilters}
          />
          <QuickFilter
            active={filters.status === 'inbox'}
            label="Inbox"
            onPress={() => toggleQuickFilter('inbox')}
          />
          <QuickFilter
            active={filters.status === 'untagged'}
            label="Untagged"
            onPress={() => toggleQuickFilter('untagged')}
          />
          <QuickFilter
            active={filters.mimeTypes.includes('application/pdf')}
            label="PDFs"
            onPress={() => toggleQuickFilter('pdf')}
          />
          <QuickFilter
            active={filters.createdAfter === thisYear.after && filters.createdBefore === thisYear.before}
            label="This year"
            onPress={() => toggleQuickFilter('year')}
          />
        </ScrollView>
      </View>

      {!!(criteria.length || extraRules.length) && (
        <View style={styles.appliedBlock}>
          <View style={styles.appliedHeader}>
            <Text style={styles.appliedLabel}>APPLIED</Text>
            <Pressable accessibilityLabel="Clear all filters" onPress={clearAll} style={styles.clearAllButton}>
              <Text style={styles.clearAllText}>Clear all</Text>
            </Pressable>
          </View>
          <ScrollView
            horizontal
            contentContainerStyle={styles.appliedFilters}
            showsHorizontalScrollIndicator={false}>
            {!!extraRules.length && (
              <Pressable
                accessibilityLabel={`Remove ${extraRules.length} advanced preset ${extraRules.length === 1 ? 'rule' : 'rules'}`}
                onPress={() => {
                  setExtraRules([]);
                  if (activeSavedView) setPresetRefined(true);
                }}
                style={styles.appliedFilter}>
                <Text numberOfLines={1} style={styles.appliedFilterText}>
                  Advanced preset rules · {extraRules.length}
                </Text>
                <X color={palette.ink} size={13} />
              </Pressable>
            )}
            {criteria.map((criterion) => (
              <Pressable
                accessibilityLabel={`Remove ${criterion.label} filter`}
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

      {!!remoteError && (
        <View accessibilityLiveRegion="polite" style={styles.errorBanner}>
          <View style={styles.errorCopy}>
            <Text style={styles.errorTitle}>Showing local matches</Text>
            <Text numberOfLines={2} style={styles.errorText}>{remoteError}</Text>
          </View>
          <Pressable onPress={() => setRetryKey((current) => current + 1)} style={styles.retryButton}>
            <RotateCcw color={palette.ink} size={15} />
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.resultHeader}>
        <Text accessibilityLiveRegion="polite" style={styles.resultCount}>
          {remoteLoading
            ? `${filteredDocuments.length} shown · searching Paperless…`
            : narrowed
              ? `${filteredDocuments.length} of ${totalDocuments} ${totalDocuments === 1 ? 'document' : 'documents'}`
              : `${filteredDocuments.length} ${filteredDocuments.length === 1 ? 'document' : 'documents'}`}
        </Text>
        <Pressable
          accessibilityLabel={`Sort order: ${librarySortLabels[sortOrder]}`}
          haptic="light"
          onPress={openSort}
          style={styles.resultSortButton}>
          <SlidersHorizontal color={palette.muted} size={13} />
          <Text numberOfLines={1} style={styles.resultSort}>{librarySortLabels[sortOrder]}</Text>
        </Pressable>
      </View>
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
                        ? <Filter color={palette.ink} size={26} />
                        : <Search color={palette.ink} size={26} />}
                    </View>
                    <Text style={styles.emptyTitle}>
                      {narrowed ? 'No documents match' : 'Your library is empty'}
                    </Text>
                    <Text style={styles.emptyCopy}>
                      {narrowed
                        ? 'Adjust the active criteria or clear them to return to your full library.'
                        : 'Scanned and imported documents will appear here.'}
                    </Text>
                    {narrowed && (
                      <View style={styles.emptyActions}>
                        <Pressable onPress={openFilters} style={styles.emptyPrimary}>
                          <Filter color={palette.ink} size={16} />
                          <Text style={styles.emptyPrimaryText}>Edit filters</Text>
                        </Pressable>
                        <Pressable onPress={clearAll} style={styles.emptySecondary}>
                          <Text style={styles.emptySecondaryText}>Clear all</Text>
                        </Pressable>
                      </View>
                    )}
                  </View>
                }
                ListHeaderComponent={listHeader}
                maintainVisibleContentPosition={{ disabled: true }}
                numColumns={2}
                onViewableItemsChanged={prefetchVisiblePreviews}
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

function libraryCriteria(filters: LibraryFilters, catalog: PaperlessCatalog): FilterCriterion[] {
  const criteria: FilterCriterion[] = [];
  if (filters.status !== 'any') {
    criteria.push({
      key: 'status',
      label: filters.status === 'inbox' ? 'Inbox' : filters.status === 'tagged' ? 'Tagged' : 'Untagged',
    });
  }
  if (filters.correspondentIds.length || filters.correspondentMissing) {
    criteria.push({
      key: 'correspondents',
      label: selectionLabel(
        'Correspondent',
        filters.correspondentIds,
        catalog.correspondents,
        filters.correspondentMode,
        filters.correspondentMissing,
      ),
    });
  }
  if (filters.documentTypeIds.length || filters.documentTypeMissing) {
    criteria.push({
      key: 'documentTypes',
      label: selectionLabel(
        'Type',
        filters.documentTypeIds,
        catalog.documentTypes,
        filters.documentTypeMode,
        filters.documentTypeMissing,
      ),
    });
  }
  if (filters.tagIds.length) {
    const prefix = filters.tagMode === 'none' ? 'Without tags' : filters.tagMode === 'all' ? 'All tags' : 'Tags';
    criteria.push({ key: 'tags', label: optionLabel(prefix, filters.tagIds, catalog.tags) });
  }
  if (filters.storagePathIds.length || filters.storagePathMissing) {
    criteria.push({
      key: 'storagePaths',
      label: selectionLabel(
        'Storage',
        filters.storagePathIds,
        catalog.storagePaths,
        filters.storagePathMode,
        filters.storagePathMissing,
      ),
    });
  }
  if (filters.ownerIds.length || filters.ownerMissing) {
    criteria.push({
      key: 'owners',
      label: selectionLabel(
        'Owner',
        filters.ownerIds,
        catalog.owners,
        filters.ownerMode,
        filters.ownerMissing,
      ),
    });
  }
  if (filters.customFieldIds.length) {
    const options = catalog.customFields.map((field) => ({ id: field.id, name: field.name }));
    const prefix = filters.customFieldMode === 'none' ? 'Without fields' : filters.customFieldMode === 'all' ? 'All fields' : 'Fields';
    criteria.push({ key: 'customFields', label: optionLabel(prefix, filters.customFieldIds, options) });
  }
  if (filters.mimeTypes.length) {
    criteria.push({
      key: 'mimeTypes',
      label: filters.mimeTypes.length === 1
        ? filters.mimeTypes[0] === 'application/pdf' ? 'PDFs' : filters.mimeTypes[0]
        : `${filters.mimeTypes.length} file types`,
    });
  }
  if (filters.createdAfter || filters.createdBefore) {
    criteria.push({ key: 'created', label: dateLabel('Document date', filters.createdAfter, filters.createdBefore) });
  }
  if (filters.addedAfter || filters.addedBefore) {
    criteria.push({ key: 'added', label: dateLabel('Added', filters.addedAfter, filters.addedBefore) });
  }
  if (filters.modifiedAfter || filters.modifiedBefore) {
    criteria.push({ key: 'modified', label: dateLabel('Modified', filters.modifiedAfter, filters.modifiedBefore) });
  }
  if (filters.archiveSerialMin || filters.archiveSerialMax || filters.archiveSerialMissing) {
    criteria.push({
      key: 'archive',
      label: filters.archiveSerialMissing
        ? 'No archive serial'
        : filters.archiveSerialMin && filters.archiveSerialMax
          ? `Archive ${filters.archiveSerialMin}–${filters.archiveSerialMax}`
          : filters.archiveSerialMin
            ? `Archive >${filters.archiveSerialMin}`
            : `Archive <${filters.archiveSerialMax}`,
    });
  }
  return criteria;
}

function optionLabel(
  prefix: string,
  ids: string[],
  options: { id: string; name: string }[],
) {
  if (ids.length === 1) return `${prefix} · ${options.find((option) => option.id === ids[0])?.name || '1 selected'}`;
  return `${prefix} · ${ids.length}`;
}

function selectionLabel(
  prefix: string,
  ids: string[],
  options: { id: string; name: string }[],
  mode: 'include' | 'exclude',
  missing: boolean,
) {
  if (missing) return mode === 'include' ? `No ${prefix.toLocaleLowerCase()}` : `${prefix} assigned`;
  return optionLabel(mode === 'exclude' ? `Exclude ${prefix.toLocaleLowerCase()}` : prefix, ids, options);
}

function dateLabel(prefix: string, after: string, before: string) {
  if (after && before) return `${prefix} · ${after}–${before}`;
  return `${prefix} · ${after ? `after ${after}` : `before ${before}`}`;
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
}: {
  column: 'left' | 'right';
  document: DocumentItem;
  grid: boolean;
  onOpen: (id: string) => void;
  onPreload: (id: string) => void;
}) {
  return (
    <Pressable
      accessibilityHint="Opens document details"
      accessibilityLabel={document.title}
      accessibilityRole="button"
      haptic="light"
      onPress={() => onOpen(document.id)}
      onPressIn={() => onPreload(document.id)}
      style={[
        grid ? styles.gridCard : styles.listCard,
        grid && (column === 'left' ? styles.gridCardLeft : styles.gridCardRight),
      ]}>
      <PaperThumbnail document={document} width={grid ? 112 : 68} />
      <View style={grid ? styles.gridBody : styles.listBody}>
        <Text numberOfLines={2} style={grid ? styles.gridTitle : styles.documentTitle}>
          {document.title}
        </Text>
        <Text numberOfLines={1} style={styles.documentMeta}>
          {grid ? document.correspondent : `${document.correspondent} · ${document.documentType}`}
        </Text>
        {grid ? (
          <Text style={styles.date}>{document.added}</Text>
        ) : (
          <View style={styles.tags}>
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
          <Text style={styles.date}>{document.added}</Text>
          <Text style={styles.pages}>{document.pageCount} pp.</Text>
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
  viewToggle: {
    flexDirection: 'row',
    padding: 4,
    borderRadius: radii.md,
    backgroundColor: '#E6E1D6',
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
    backgroundColor: '#E8F2C5',
  },
  appliedFilterText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '800',
  },
  errorBanner: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 15,
    padding: 13,
    borderRadius: radii.md,
    backgroundColor: palette.rose,
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
    backgroundColor: '#E8E3D8',
  },
  resultSeparator: {
    height: 10,
  },
  listCard: {
    height: 108,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    padding: 11,
    borderRadius: radii.lg,
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: 'rgba(23,35,27,0.04)',
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
    minWidth: 0,
    minHeight: 246,
    padding: 12,
    gap: 5,
    borderRadius: radii.lg,
    backgroundColor: palette.paper,
  },
  gridCardLeft: {
    marginRight: 5,
  },
  gridCardRight: {
    marginLeft: 5,
  },
  gridBody: {
    gap: 5,
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
    color: palette.ink,
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
