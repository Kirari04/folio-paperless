import { ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Edit3, FolderTree, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CatalogEditorSheet, type CatalogEditorValue } from '@/components/catalog-editor-sheet';
import { MotionPressable as Pressable, hapticFeedback } from '@/components/motion';
import { fonts, maxContentWidth, palette, radii } from '@/constants/theme';
import { useApp } from '@/context/app-context';
import { useI18n } from '@/i18n';
import { presentRuntimeError } from '@/i18n/error-presentation';
import { useRouter } from '@/lib/router';
import { usePaperlessAdvanced } from '@/lib/use-paperless-advanced';
import { normalizeNestedTags, selectVisibleNestedTags } from '@/lib/paperless-advanced';
import type {
  PaperlessCatalogObject,
  PaperlessCatalogResource,
  PaperlessNormalizedTag,
  PaperlessTag,
} from '@/types/paperless-advanced';

const resources: PaperlessCatalogResource[] = ['tags', 'correspondents', 'documentTypes', 'storagePaths'];

export default function PaperlessMetadataRoute() {
  const { activeProfile } = useApp();
  return <PaperlessMetadataScreen key={activeProfile?.id ?? 'no-profile'} />;
}

function PaperlessMetadataScreen() {
  const router = useRouter();
  const { formatNumber, t } = useI18n();
  const resourceLabels = useMemo<Record<PaperlessCatalogResource, string>>(() => ({
    tags: t('metadata.tags'),
    correspondents: t('metadata.correspondents'),
    documentTypes: t('metadata.documentTypes'),
    storagePaths: t('metadata.storagePaths'),
  }), [t]);
  const {
    activeProfile,
    connected,
    publishCatalogDeletion,
    publishCatalogObject,
    refresh,
  } = useApp();
  const advanced = usePaperlessAdvanced();
  const advancedApi = advanced.phase === 'ready' ? advanced.api : null;
  const advancedError = advanced.phase === 'error' ? advanced.error : null;
  const [resource, setResource] = useState<PaperlessCatalogResource>('tags');
  const [byResource, setByResource] = useState<Record<PaperlessCatalogResource, PaperlessCatalogObject[]>>({
    tags: [], correspondents: [], documentTypes: [], storagePaths: [],
  });
  const [loaded, setLoaded] = useState<Set<PaperlessCatalogResource>>(new Set());
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [expandedTags, setExpandedTags] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ item: PaperlessCatalogObject | null } | null>(null);
  const requestEpoch = useRef(0);

  const reload = useCallback(async (target = resource) => {
    if (!advancedApi) return;
    const epoch = requestEpoch.current;
    setLoading(true);
    setError(null);
    try {
      const result = await advancedApi.listCatalog(target, 'page_size=1000&ordering=name');
      if (!result.supported) throw new Error(result.detail ?? t('metadata.resourceUnavailable', { resource: resourceLabels[target] }));
      if (epoch !== requestEpoch.current) return;
      setByResource((current) => ({ ...current, [target]: result.value.results }));
      setLoaded((current) => new Set(current).add(target));
    } catch (nextError) {
      if (epoch !== requestEpoch.current) return;
      setError(presentRuntimeError(nextError, t('metadata.resourceLoadError', { resource: resourceLabels[target] })));
    } finally {
      if (epoch === requestEpoch.current) setLoading(false);
    }
  }, [advancedApi, resource, resourceLabels, t]);

  useEffect(() => () => {
    requestEpoch.current += 1;
  }, []);

  useEffect(() => {
    if (!advancedApi || loaded.has(resource)) return;
    const timer = setTimeout(() => void reload(resource), 0);
    return () => clearTimeout(timer);
  }, [advancedApi, loaded, reload, resource]);

  const current = byResource[resource];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const tagRoots = byResource.tags.filter((item): item is PaperlessTag => item.kind === 'tag');
  const tagHierarchyResult = useMemo(() => normalizeNestedTags(tagRoots), [tagRoots]);
  const tagHierarchy = tagHierarchyResult.valid ? tagHierarchyResult.value : null;
  const tags = useMemo(() => {
    const flattened = new Map<number, PaperlessTag>();
    const collect = (tag: PaperlessTag) => {
      if (flattened.has(tag.id)) return;
      flattened.set(tag.id, tag);
      tag.children.forEach(collect);
    };
    tagRoots.forEach(collect);
    return [...flattened.values()];
  }, [tagRoots]);
  const filtered = useMemo<(PaperlessCatalogObject | PaperlessNormalizedTag)[]>(() => {
    if (resource !== 'tags') {
      return normalizedQuery
        ? current.filter((item) => [
            item.name,
            item.match,
            item.kind === 'storagePath' ? item.path : '',
          ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery)))
        : current;
    }
    if (!tagHierarchy) return [];
    return selectVisibleNestedTags(tagHierarchy, normalizedQuery, expandedTags);
  }, [current, expandedTags, normalizedQuery, resource, tagHierarchy]);
  const capability = advanced.phase === 'ready' ? advanced.capabilities.features.catalogs[resource] : null;

  async function save(edit: CatalogEditorValue) {
    if (advanced.phase !== 'ready' || !editor || !activeProfile) throw new Error(t('metadata.notReady'));
    const epoch = requestEpoch.current;
    const item = editor.item;
    let result;
    if (resource === 'tags') {
      result = item
        ? await advanced.api.updateCatalog('tags', item.id, edit)
        : await advanced.api.createCatalog('tags', edit);
    } else if (resource === 'correspondents') {
      result = item
        ? await advanced.api.updateCatalog('correspondents', item.id, edit)
        : await advanced.api.createCatalog('correspondents', edit);
    } else if (resource === 'documentTypes') {
      result = item
        ? await advanced.api.updateCatalog('documentTypes', item.id, edit)
        : await advanced.api.createCatalog('documentTypes', edit);
    } else {
      result = item
        ? await advanced.api.updateCatalog('storagePaths', item.id, edit)
        : await advanced.api.createCatalog('storagePaths', edit);
    }
    if (!result.supported) throw new Error(result.detail ?? t('metadata.changeUnavailable'));
    if (epoch !== requestEpoch.current) return;
    await publishCatalogObject(activeProfile.id, resource, result.value);
    if (epoch !== requestEpoch.current) return;
    if (resource === 'tags') {
      // Tag writes are verified against a fresh server hierarchy by the API.
      // Render that readback rather than splicing one flat row into the tree.
      await reload('tags').catch((nextError: unknown) => {
        if (epoch === requestEpoch.current) {
          setError(presentRuntimeError(nextError, t('metadata.resourceLoadError', { resource: resourceLabels.tags })));
        }
      });
    } else {
      setByResource((state) => ({
        ...state,
        [resource]: item
          ? state[resource].map((existing) => existing.id === result.value.id ? result.value : existing)
          : [...state[resource], result.value].sort((a, b) => a.name.localeCompare(b.name)),
      }));
    }
    await refresh().catch((nextError: unknown) => {
      if (epoch === requestEpoch.current) {
        setError(presentRuntimeError(nextError, t('metadata.resourceLoadError', { resource: resourceLabels[resource] })));
      }
    });
    await hapticFeedback('confirm');
  }

  function confirmDelete(item: PaperlessCatalogObject) {
    const epoch = requestEpoch.current;
    Alert.alert(
      t('metadata.deleteTitle', { name: item.name }),
      `${usageWarning(item)} ${t('metadata.deleteBody')}`,
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            if (advanced.phase !== 'ready' || epoch !== requestEpoch.current) return;
            setError(null);
            advanced.api.deleteCatalog(resource, item.id)
              .then(async (result) => {
                if (!result.supported) throw new Error(result.detail ?? t('metadata.deleteUnavailable'));
                if (epoch !== requestEpoch.current) return;
                if (!activeProfile) return;
                await publishCatalogDeletion(activeProfile.id, resource, result.value.deletedId);
                if (epoch !== requestEpoch.current) return;
                if (resource === 'tags') await reload('tags').catch((nextError: unknown) => {
                  if (epoch === requestEpoch.current) {
                    setError(presentRuntimeError(nextError, t('metadata.resourceLoadError', { resource: resourceLabels.tags })));
                  }
                });
                else {
                  setByResource((state) => ({
                    ...state,
                    [resource]: state[resource].filter((entry) => entry.id !== item.id),
                  }));
                }
                await refresh().catch((nextError: unknown) => {
                  if (epoch === requestEpoch.current) {
                    setError(presentRuntimeError(nextError, t('metadata.resourceLoadError', { resource: resourceLabels[resource] })));
                  }
                });
                await hapticFeedback('warning');
              })
              .catch((nextError: unknown) => {
                if (epoch !== requestEpoch.current) return;
                setError(presentRuntimeError(nextError, t('metadata.deleteError')));
              });
          },
        },
      ],
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.root}>
      <View style={styles.header}>
        <Pressable accessibilityLabel={t('metadata.back')} onPress={() => router.back()} style={styles.iconButton}>
          <ChevronLeft color={palette.ink} size={22} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>PAPERLESS</Text>
          <Text style={styles.title}>{t('metadata.title')}</Text>
        </View>
        <Pressable accessibilityLabel={t('metadata.add', { resource: resourceLabels[resource] })} accessibilityState={{ disabled: capability?.create.supported !== true }} disabled={capability?.create.supported !== true} onPress={() => setEditor({ item: null })} style={[styles.addButton, capability?.create.supported !== true && styles.disabled]}>
          <Plus color={palette.accentInk} size={20} />
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl onRefresh={() => void reload(resource)} refreshing={loading} tintColor={palette.ink} />}>
        <View style={styles.intro}>
          <FolderTree color={palette.accentInk} size={24} />
          <Text style={styles.introTitle}>{t('metadata.introTitle')}</Text>
          <Text style={styles.introCopy}>{t('metadata.introCopy')}</Text>
        </View>
        <ScrollView horizontal contentContainerStyle={styles.tabs} showsHorizontalScrollIndicator={false}>
          {resources.map((value) => (
            <Pressable accessibilityRole="tab" accessibilityState={{ selected: resource === value }} key={value} onPress={() => { setResource(value); setQuery(''); setError(null); }} style={[styles.tab, resource === value && styles.tabActive]}>
              <Text style={[styles.tabText, resource === value && styles.tabTextActive]}>{resourceLabels[value]}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <View style={styles.search}>
          <Search color={palette.muted} size={17} />
          <TextInput accessibilityLabel={t('metadata.search', { resource: resourceLabels[resource] })} autoCapitalize="none" autoCorrect={false} onChangeText={setQuery} placeholder={t('metadata.search', { resource: resourceLabels[resource].toLocaleLowerCase() })} placeholderTextColor={palette.faint} style={styles.searchInput} value={query} />
          {!!query && <Pressable accessibilityLabel={t('metadata.clearSearch')} onPress={() => setQuery('')} style={styles.clearButton}><X color={palette.muted} size={16} /></Pressable>}
          <Pressable accessibilityLabel={t('metadata.refresh', { resource: resourceLabels[resource] })} onPress={() => void reload(resource)} style={styles.clearButton}><RefreshCw color={palette.ink} size={16} /></Pressable>
        </View>
        {resource === 'tags' && !tagHierarchyResult.valid && loaded.has('tags') && (
          <View accessibilityLiveRegion="assertive" style={styles.errorBanner}>
            <CircleAlert color={palette.danger} size={17} />
            <Text style={styles.errorBannerText}>{t('metadata.invalidHierarchy')}</Text>
          </View>
        )}
        {!!error && loaded.has(resource) && (
          <View accessibilityLiveRegion="assertive" style={styles.errorBanner}>
            <CircleAlert color={palette.danger} size={17} />
            <Text style={styles.errorBannerText}>{error}</Text>
          </View>
        )}
        {!connected ? (
          <State icon={<CircleAlert color={palette.muted} size={25} />} title={t('metadata.connect')} copy={t('metadata.demoUnavailable')} />
        ) : advanced.phase === 'loading' || loading && !loaded.has(resource) ? (
          <State icon={<ActivityIndicator color={palette.ink} />} title={t('metadata.loading')} copy={t('metadata.checking')} />
        ) : error && !loaded.has(resource) || advancedError ? (
          <State icon={<CircleAlert color={palette.danger} size={25} />} title={t('metadata.unavailable')} copy={error ?? advancedError!} />
        ) : !filtered.length ? (
          <State icon={<Search color={palette.muted} size={25} />} title={normalizedQuery ? t('metadata.noMatches') : t('metadata.noResource', { resource: resourceLabels[resource].toLocaleLowerCase() })} copy={normalizedQuery ? t('metadata.trySearch') : t('metadata.createFirst')} />
        ) : filtered.map((item) => {
          const editable = item.userCanChange !== false && capability?.update.supported === true;
          const normalizedTag = item.kind === 'tag' && 'pathLabel' in item
            ? item as PaperlessNormalizedTag
            : null;
          const rawItem = item.kind === 'tag'
            ? tags.find((tag) => tag.id === item.id) ?? null
            : item;
          const hasChildren = !!normalizedTag?.childIds.length;
          const expanded = expandedTags.has(item.id);
          return (
            <View key={item.id} style={[
              styles.card,
              normalizedTag && { marginLeft: Math.min(normalizedTag.depth * 14, 56) },
            ]}>
              {item.kind === 'tag' && <View accessibilityLabel={t('metadata.tagColor', { color: item.color ?? t('metadata.notSet') })} style={[styles.color, { backgroundColor: item.color ?? palette.lineStrong }]} />}
              {item.kind === 'tag' && (
                <Pressable
                  accessibilityLabel={hasChildren
                    ? t(expanded ? 'metadata.collapseTag' : 'metadata.expandTag', { name: item.name })
                    : undefined}
                  accessibilityRole={hasChildren ? 'button' : undefined}
                  accessibilityState={hasChildren ? { expanded } : undefined}
                  disabled={!hasChildren}
                  onPress={() => setExpandedTags((currentExpanded) => {
                    const next = new Set(currentExpanded);
                    if (next.has(item.id)) next.delete(item.id);
                    else next.add(item.id);
                    return next;
                  })}
                  style={styles.treeToggle}>
                  {hasChildren
                    ? expanded
                      ? <ChevronDown color={palette.ink} size={17} />
                      : <ChevronRight color={palette.ink} size={17} />
                    : <View style={styles.treeLeaf} />}
                </Pressable>
              )}
              <View style={styles.cardCopy}>
                <Text numberOfLines={2} style={styles.cardTitle}>{item.name}</Text>
                <Text numberOfLines={2} style={styles.meta}>
                  {normalizedTag?.pathLabel ?? (item.kind === 'storagePath' ? item.path : item.match ? t('metadata.matches', { match: item.match }) : t('metadata.noAutomaticMatch'))}
                </Text>
                <Text style={styles.usage}>{usageWarning(item)}</Text>
                {item.userCanChange === false && <Text style={styles.readOnly}>{t('metadata.readOnly')}</Text>}
              </View>
              <View style={styles.cardActions}>
                <Pressable accessibilityLabel={t('metadata.edit', { name: item.name })} accessibilityState={{ disabled: !editable }} disabled={!editable || !rawItem} onPress={() => rawItem && setEditor({ item: rawItem })} style={[styles.cardAction, (!editable || !rawItem) && styles.disabled]}><Edit3 color={palette.ink} size={16} /></Pressable>
                <Pressable accessibilityLabel={t('metadata.delete', { name: item.name })} accessibilityState={{ disabled: item.userCanChange === false || capability?.delete.supported !== true }} disabled={item.userCanChange === false || capability?.delete.supported !== true || !rawItem} onPress={() => rawItem && confirmDelete(rawItem)} style={[styles.cardAction, (item.userCanChange === false || capability?.delete.supported !== true || !rawItem) && styles.disabled]}><Trash2 color={palette.danger} size={16} /></Pressable>
              </View>
            </View>
          );
        })}
      </ScrollView>
      {!!editor && (
        <CatalogEditorSheet
          item={editor.item}
          nestedTagsSupported={advanced.phase === 'ready' && advanced.capabilities.features.nestedTags.supported}
          onClose={() => setEditor(null)}
          onSave={save}
          resource={resource}
          tags={tags}
          visible
        />
      )}
    </SafeAreaView>
  );

  function usageWarning(item: Pick<PaperlessCatalogObject, 'documentCount'>) {
    if (item.documentCount === null) return t('metadata.usageUnknown');
    if (item.documentCount === 0) return t('metadata.usageNone');
    return t('metadata.usageCount', { count: formatNumber(item.documentCount) });
  }
}

function State({ copy, icon, title }: { copy: string; icon: ReactNode; title: string }) {
  return <View style={styles.state}>{icon}<Text style={styles.stateTitle}>{title}</Text><Text style={styles.stateCopy}>{copy}</Text></View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.canvas },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 12 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: palette.paper },
  addButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: palette.lime },
  headerCopy: { flex: 1 },
  eyebrow: { color: palette.muted, fontFamily: fonts.sans, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  title: { color: palette.ink, fontFamily: fonts.serif, fontSize: 29, fontWeight: '700' },
  content: { width: '100%', maxWidth: maxContentWidth, alignSelf: 'center', padding: 18, paddingBottom: 48, gap: 11 },
  intro: { padding: 17, borderRadius: radii.lg, backgroundColor: palette.lime },
  introTitle: { color: palette.accentInk, fontFamily: fonts.serif, fontSize: 23, fontWeight: '700', marginTop: 8 },
  introCopy: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, marginTop: 3 },
  tabs: { gap: 7, paddingRight: 10 },
  tab: { minHeight: 46, justifyContent: 'center', paddingHorizontal: 13, borderRadius: radii.pill, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.paper },
  tabActive: { backgroundColor: palette.ink, borderColor: palette.ink },
  tabText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 11, fontWeight: '800' },
  tabTextActive: { color: palette.paper },
  search: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 5, borderRadius: radii.md, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.paper },
  searchInput: { flex: 1, color: palette.ink, fontFamily: fonts.sans, fontSize: 13 },
  clearButton: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 13 },
  errorBanner: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12, borderRadius: radii.md, backgroundColor: palette.dangerSurface },
  errorBannerText: { flex: 1, color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 11, lineHeight: 16 },
  state: { alignItems: 'center', padding: 28, borderRadius: radii.lg, backgroundColor: palette.paper },
  stateTitle: { color: palette.ink, fontFamily: fonts.serif, fontSize: 21, fontWeight: '700', marginTop: 9 },
  stateCopy: { maxWidth: 340, color: palette.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 4 },
  card: { minHeight: 90, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: radii.lg, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.paper },
  color: { width: 17, height: 54, borderRadius: radii.pill },
  treeToggle: { width: 32, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  treeLeaf: { width: 6, height: 6, borderRadius: 3, backgroundColor: palette.lineStrong },
  cardCopy: { flex: 1, minWidth: 0 },
  cardTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 14, fontWeight: '900' },
  meta: { color: palette.muted, fontFamily: fonts.sans, fontSize: 10, lineHeight: 15, marginTop: 2 },
  usage: { color: palette.faint, fontFamily: fonts.sans, fontSize: 9, marginTop: 4 },
  readOnly: { color: palette.danger, fontFamily: fonts.sans, fontSize: 9, fontWeight: '800', marginTop: 4 },
  cardActions: { flexDirection: 'row', gap: 5 },
  cardAction: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: palette.paperStrong },
  disabled: { opacity: 0.38 },
});
