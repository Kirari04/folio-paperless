import {
  ArrowLeft,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Hash,
  Layers3,
  Search,
  Tag,
  UserRound,
  X,
} from 'lucide-react-native';
import { ComponentType, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardTypeOptions,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ColorValue,
} from 'react-native';

import { KeyboardSheet, KeyboardSheetHandle } from '@/components/keyboard-sheet';
import { MotionPressable as Pressable, animateLayout, hapticFeedback } from '@/components/motion';
import { fonts, palette, radii } from '@/constants/theme';
import { useI18n, type TranslationKey } from '@/i18n';
import {
  cloneLibraryFilters,
  emptyLibraryFilters,
  isValidLibraryDate,
  libraryFilterCount,
} from '@/lib/library-filters';
import { selectedTagAncestorIds, selectTagFilterOptions } from '@/lib/tag-hierarchy';
import {
  LibraryFilters,
  LibrarySelectionMode,
  LibraryTagMode,
  PaperlessCatalog,
  PaperlessOption,
} from '@/types/document';

type ListFacet =
  | 'correspondents'
  | 'documentTypes'
  | 'tags'
  | 'storagePaths'
  | 'owners'
  | 'customFields'
  | 'mimeTypes';
type RangeFacet = 'created' | 'added' | 'modified' | 'archive';
type Facet = ListFacet | RangeFacet;

type LibraryFilterSheetProps = {
  catalog: PaperlessCatalog;
  extraRuleCount?: number;
  filters: LibraryFilters;
  getPreviewCount: (filters: LibraryFilters) => number;
  mimeTypes: string[];
  onApply: (filters: LibraryFilters) => void;
  onClose: () => void;
  visible: boolean;
};

type IconType = ComponentType<{ color?: ColorValue; size?: number }>;

const facetDetails: Record<Facet, { title: TranslationKey; subtitle: TranslationKey; icon: IconType }> = {
  correspondents: { title: 'filter.facet.correspondent', subtitle: 'filter.facet.correspondentCopy', icon: UserRound },
  documentTypes: { title: 'filter.facet.documentType', subtitle: 'filter.facet.documentTypeCopy', icon: Layers3 },
  tags: { title: 'filter.facet.tags', subtitle: 'filter.facet.tagsCopy', icon: Tag },
  storagePaths: { title: 'filter.facet.storagePath', subtitle: 'filter.facet.storagePathCopy', icon: Folder },
  owners: { title: 'filter.facet.owner', subtitle: 'filter.facet.ownerCopy', icon: UserRound },
  customFields: { title: 'filter.facet.customFields', subtitle: 'filter.facet.customFieldsCopy', icon: Layers3 },
  mimeTypes: { title: 'filter.facet.fileType', subtitle: 'filter.facet.fileTypeCopy', icon: FileText },
  created: { title: 'filter.facet.documentDate', subtitle: 'filter.facet.documentDateCopy', icon: CalendarDays },
  added: { title: 'filter.facet.dateAdded', subtitle: 'filter.facet.dateAddedCopy', icon: CalendarDays },
  modified: { title: 'filter.facet.dateModified', subtitle: 'filter.facet.dateModifiedCopy', icon: CalendarDays },
  archive: { title: 'filter.facet.archiveSerial', subtitle: 'filter.facet.archiveSerialCopy', icon: Hash },
};

export function LibraryFilterSheet({
  catalog,
  extraRuleCount = 0,
  filters,
  getPreviewCount,
  mimeTypes,
  onApply,
  onClose,
  visible,
}: LibraryFilterSheetProps) {
  const { formatNumber, t } = useI18n();
  const sheetRef = useRef<KeyboardSheetHandle>(null);
  const wasVisible = useRef(false);
  const [draft, setDraft] = useState(() => cloneLibraryFilters(filters));
  const [facet, setFacet] = useState<Facet | null>(null);
  const [query, setQuery] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedTagIds, setExpandedTagIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (visible && !wasVisible.current) {
      setDraft(cloneLibraryFilters(filters));
      setFacet(null);
      setQuery('');
      setAdvancedOpen(libraryFilterCount(filters) > 4 || extraRuleCount > 0);
      setError(null);
      setExpandedTagIds(new Set());
    }
    wasVisible.current = visible;
  }, [extraRuleCount, filters, visible]);

  const activeCount = libraryFilterCount(draft);
  const previewCount = useMemo(() => getPreviewCount(draft), [draft, getPreviewCount]);

  function openFacet(next: Facet) {
    setQuery('');
    if (next === 'tags') {
      setExpandedTagIds(selectedTagAncestorIds(catalog.tags, draft.tagIds));
    }
    setFacet(next);
    animateLayout();
  }

  function apply() {
    const dateFields = [
      draft.createdAfter,
      draft.createdBefore,
      draft.addedAfter,
      draft.addedBefore,
      draft.modifiedAfter,
      draft.modifiedBefore,
    ];
    if (dateFields.some((value) => !isValidLibraryDate(value))) {
      setError(t('filter.invalidDate'));
      void hapticFeedback('error');
      return;
    }
    onApply(cloneLibraryFilters(draft));
    void hapticFeedback('confirm');
    sheetRef.current?.close();
  }

  const title = facet ? t(facetDetails[facet].title) : t('filter.title');
  const subtitle = facet
    ? t(facetDetails[facet].subtitle)
    : activeCount
      ? t('filter.summary', {
          filters: formatNumber(activeCount),
          matches: formatNumber(previewCount),
        })
      : t('filter.intro');

  return (
    <KeyboardSheet
      accessibilityLabel={t('filter.accessibility')}
      maxHeight="94%"
      onDismiss={onClose}
      ref={sheetRef}
      subtitle={subtitle}
      title={title}
      visible={visible}>
      {facet ? (
        <FacetEditor
          catalog={catalog}
          draft={draft}
          expandedTagIds={expandedTagIds}
          facet={facet}
          mimeTypes={mimeTypes}
          onBack={() => {
            setFacet(null);
            setQuery('');
            animateLayout();
          }}
          onChange={setDraft}
          query={query}
          setExpandedTagIds={setExpandedTagIds}
          setQuery={setQuery}
        />
      ) : (
        <>
          <ScrollView
            contentContainerStyle={styles.mainContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            <Text style={styles.sectionLabel}>{t('filter.status')}</Text>
            <View accessibilityRole="radiogroup" style={styles.segmentedWrap}>
              {([
                ['any', 'filter.any'],
                ['inbox', 'filter.inbox'],
                ['untagged', 'filter.untagged'],
                ['tagged', 'filter.tagged'],
              ] as const).map(([value, label]) => (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: draft.status === value }}
                  key={value}
                  onPress={() => setDraft((current) => ({ ...current, status: value }))}
                  style={[styles.segment, draft.status === value && styles.segmentActive]}>
                  <Text style={[styles.segmentText, draft.status === value && styles.segmentTextActive]}>
                    {t(label)}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={styles.sectionLabel}>{t('filter.documentDetails')}</Text>
            <View style={styles.rowGroup}>
              <FacetRow
                detail={facetDetails.correspondents}
                onPress={() => openFacet('correspondents')}
                value={selectionSummary(draft.correspondentIds.length, draft.correspondentMissing, draft.correspondentMode, t, formatNumber)}
              />
              <FacetRow
                detail={facetDetails.documentTypes}
                onPress={() => openFacet('documentTypes')}
                value={selectionSummary(draft.documentTypeIds.length, draft.documentTypeMissing, draft.documentTypeMode, t, formatNumber)}
              />
              <FacetRow
                detail={facetDetails.tags}
                onPress={() => openFacet('tags')}
                value={tagSummary(draft.tagIds.length, draft.tagMode, t, formatNumber)}
              />
              <FacetRow
                detail={facetDetails.storagePaths}
                last
                onPress={() => openFacet('storagePaths')}
                value={selectionSummary(draft.storagePathIds.length, draft.storagePathMissing, draft.storagePathMode, t, formatNumber)}
              />
            </View>

            <Text style={styles.sectionLabel}>{t('filter.dates')}</Text>
            <View style={styles.rowGroup}>
              <FacetRow
                detail={facetDetails.created}
                onPress={() => openFacet('created')}
                value={rangeSummary(draft.createdAfter, draft.createdBefore, t)}
              />
              <FacetRow
                detail={facetDetails.added}
                last
                onPress={() => openFacet('added')}
                value={rangeSummary(draft.addedAfter, draft.addedBefore, t)}
              />
            </View>

            <Pressable
              accessibilityState={{ expanded: advancedOpen }}
              onPress={() => {
                setAdvancedOpen((current) => !current);
                animateLayout();
              }}
              style={styles.advancedHeader}>
              <View>
                <Text style={styles.advancedTitle}>{t('filter.advanced')}</Text>
                <Text style={styles.advancedCopy}>{t('filter.advancedCopy')}</Text>
              </View>
              <ChevronRight
                color={palette.muted}
                size={19}
                style={{ transform: [{ rotate: advancedOpen ? '90deg' : '0deg' }] }}
              />
            </Pressable>

            {advancedOpen && (
              <View style={styles.rowGroup}>
                <FacetRow
                  detail={facetDetails.modified}
                  onPress={() => openFacet('modified')}
                  value={rangeSummary(draft.modifiedAfter, draft.modifiedBefore, t)}
                />
                <FacetRow
                  detail={facetDetails.archive}
                  onPress={() => openFacet('archive')}
                  value={archiveSummary(draft, t)}
                />
                <FacetRow
                  detail={facetDetails.mimeTypes}
                  onPress={() => openFacet('mimeTypes')}
                  value={countSummary(draft.mimeTypes.length, t, formatNumber)}
                />
                <FacetRow
                  detail={facetDetails.owners}
                  onPress={() => openFacet('owners')}
                  value={selectionSummary(draft.ownerIds.length, draft.ownerMissing, draft.ownerMode, t, formatNumber)}
                />
                <FacetRow
                  detail={facetDetails.customFields}
                  last
                  onPress={() => openFacet('customFields')}
                  value={tagSummary(draft.customFieldIds.length, draft.customFieldMode, t, formatNumber)}
                />
              </View>
            )}

            {!!extraRuleCount && (
              <View style={styles.presetNote}>
                <Text style={styles.presetNoteTitle}>{t('filter.presetTitle')}</Text>
                <Text style={styles.presetNoteCopy}>
                  {extraRuleCount === 1
                    ? t('filter.presetOne')
                    : t('filter.presetMany', { count: formatNumber(extraRuleCount) })}
                </Text>
              </View>
            )}

            {!!error && (
              <View accessibilityLiveRegion="polite" style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            )}
          </ScrollView>

          <View style={styles.footer}>
            <Pressable
              disabled={!activeCount}
              haptic="light"
              onPress={() => {
                setDraft(cloneLibraryFilters(emptyLibraryFilters));
                setError(null);
              }}
              style={[styles.resetButton, !activeCount && styles.disabled]}>
              <Text style={styles.resetText}>
                {extraRuleCount ? t('filter.resetFields') : t('filter.reset')}
              </Text>
            </Pressable>
            <Pressable haptic="none" onPress={apply} style={styles.applyButton}>
              <Check color={palette.accentInk} size={19} />
              <Text style={styles.applyText}>
                {previewCount === 0
                  ? t('filter.apply')
                  : previewCount === 1
                    ? t('filter.showOne')
                    : t('filter.showMany', { count: formatNumber(previewCount) })}
              </Text>
            </Pressable>
          </View>
        </>
      )}
    </KeyboardSheet>
  );
}

function FacetEditor({
  catalog,
  draft,
  expandedTagIds,
  facet,
  mimeTypes,
  onBack,
  onChange,
  query,
  setExpandedTagIds,
  setQuery,
}: {
  catalog: PaperlessCatalog;
  draft: LibraryFilters;
  expandedTagIds: Set<number>;
  facet: Facet;
  mimeTypes: string[];
  onBack: () => void;
  onChange: (filters: LibraryFilters) => void;
  query: string;
  setExpandedTagIds: (ids: Set<number> | ((current: Set<number>) => Set<number>)) => void;
  setQuery: (query: string) => void;
}) {
  const { formatNumber, t } = useI18n();
  if (facet === 'created' || facet === 'added' || facet === 'modified') {
    return <DateEditor draft={draft} facet={facet} onBack={onBack} onChange={onChange} />;
  }
  if (facet === 'archive') {
    return <ArchiveEditor draft={draft} onBack={onBack} onChange={onChange} />;
  }

  const listFacet = facet as ListFacet;
  const options = optionsForFacet(listFacet, catalog, mimeTypes, t, formatNumber);
  const normalized = query.trim().toLocaleLowerCase();
  const filtered = listFacet === 'tags'
    ? selectTagFilterOptions(options, query, expandedTagIds)
    : normalized
      ? options.filter((option) => option.name.toLocaleLowerCase().includes(normalized)
        || option.pathLabel?.toLocaleLowerCase().includes(normalized))
      : options;
  const selectedIds = idsForFacet(listFacet, draft);
  const supportsMissing = ['correspondents', 'documentTypes', 'storagePaths', 'owners'].includes(listFacet);
  const missing = missingForFacet(listFacet, draft);

  function toggle(id: string) {
    const nextIds = selectedIds.includes(id)
      ? selectedIds.filter((item) => item !== id)
      : [...selectedIds, id];
    onChange(setIdsForFacet(listFacet, draft, nextIds, nextIds.length ? false : missing));
    animateLayout();
  }

  return (
    <>
      <View style={styles.editorToolbar}>
        <Pressable accessibilityLabel={t('filter.back')} onPress={onBack} style={styles.backButton}>
          <ArrowLeft color={palette.ink} size={20} />
        </Pressable>
        <View style={styles.facetSearch}>
          <Search color={palette.muted} size={17} />
          <TextInput
            accessibilityLabel={t('filter.searchFacet', { title: t(facetDetails[facet].title).toLocaleLowerCase() })}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setQuery}
            placeholder={t('filter.searchFacet', { title: t(facetDetails[facet].title).toLocaleLowerCase() })}
            placeholderTextColor={palette.faint}
            style={styles.facetSearchInput}
            value={query}
          />
          {!!query && (
            <Pressable accessibilityLabel={t('filter.clearSearch')} onPress={() => setQuery('')} style={styles.clearSearch}>
              <X color={palette.muted} size={16} />
            </Pressable>
          )}
        </View>
      </View>

      {facet !== 'mimeTypes' && (
        <MatchModeControl draft={draft} facet={listFacet} onChange={onChange} />
      )}

      {listFacet === 'tags' && (
        <Text style={styles.tagSelectionScope}>{t('filter.tagSelectionScope')}</Text>
      )}

      <FlatList
        contentContainerStyle={styles.optionList}
        data={filtered}
        initialNumToRender={16}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => item.id}
        ListEmptyComponent={
          <View style={styles.optionEmpty}>
            <Text style={styles.optionEmptyTitle}>{t('filter.noMatches')}</Text>
            <Text style={styles.optionEmptyCopy}>{t('filter.noMatchesCopy')}</Text>
          </View>
        }
        ListHeaderComponent={supportsMissing ? (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: missing }}
            onPress={() => onChange(setIdsForFacet(listFacet, draft, [], !missing))}
            style={[styles.option, missing && styles.optionActive]}>
            <View style={styles.optionCopy}>
              <Text style={styles.optionName}>{t('filter.unassigned')}</Text>
              <Text style={styles.optionMeta}>
                {t('filter.notSet', { title: t(facetDetails[facet].title).toLocaleLowerCase() })}
              </Text>
            </View>
            {missing && <View style={styles.check}><Check color={palette.accentInk} size={16} /></View>}
          </Pressable>
        ) : null}
        renderItem={({ item }) => {
          const selected = selectedIds.includes(item.id);
          const hasChildren = listFacet === 'tags'
            && Number.isSafeInteger(item.remoteId)
            && (item.remoteId ?? 0) > 0
            && !!item.childRemoteIds?.length;
          const expanded = hasChildren && expandedTagIds.has(item.remoteId!);
          return (
            <Pressable
              accessibilityHint={hasChildren ? t('filter.parentOnlyHint') : undefined}
              accessibilityLabel={item.pathLabel || item.name}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: selected }}
              onPress={() => toggle(item.id)}
              style={[styles.option, item.pathLabel && { paddingLeft: 14 + Math.min(item.depth ?? 0, 12) * 14 }, selected && styles.optionActive]}>
              {listFacet === 'tags' ? (
                hasChildren && !normalized ? (
                  <Pressable
                    accessibilityLabel={t(expanded ? 'choice.collapse' : 'choice.expand', {
                      name: item.pathLabel || item.name,
                    })}
                    accessibilityRole="button"
                    accessibilityState={{ expanded }}
                    onPress={(event) => {
                      event.stopPropagation();
                      animateLayout();
                      setExpandedTagIds((current) => {
                        const next = new Set(current);
                        if (next.has(item.remoteId!)) next.delete(item.remoteId!);
                        else next.add(item.remoteId!);
                        return next;
                      });
                    }}
                    style={styles.tagDisclosure}>
                    {expanded
                      ? <ChevronDown color={palette.muted} size={16} />
                      : <ChevronRight color={palette.muted} size={16} />}
                  </Pressable>
                ) : <View style={styles.tagDisclosure} />
              ) : null}
              {!!item.color && <View style={[styles.colorDot, { backgroundColor: item.color }]} />}
              <View style={styles.optionCopy}>
                <Text numberOfLines={2} style={styles.optionName}>{item.name}</Text>
                {!!item.meta && <Text style={styles.optionMeta}>{item.meta}</Text>}
              </View>
              {selected && <View style={styles.check}><Check color={palette.accentInk} size={16} /></View>}
            </Pressable>
          );
        }}
        removeClippedSubviews={Platform.OS === 'android'}
        style={styles.optionListView}
        windowSize={7}
      />

      <View style={styles.editorFooter}>
        <Pressable onPress={onBack} style={styles.doneButton}>
          <Check color={palette.accentInk} size={18} />
          <Text style={styles.doneText}>
            {selectedIds.length || missing ? t('filter.keepSelection') : t('filter.done')}
          </Text>
        </Pressable>
      </View>
    </>
  );
}

function MatchModeControl({
  draft,
  facet,
  onChange,
}: {
  draft: LibraryFilters;
  facet: ListFacet;
  onChange: (filters: LibraryFilters) => void;
}) {
  const { t } = useI18n();
  const tagLike = facet === 'tags' || facet === 'customFields';
  const values = tagLike
    ? ([['any', 'filter.matchAny'], ['all', 'filter.matchAll'], ['none', 'filter.matchNone']] as const)
    : ([['include', 'filter.include'], ['exclude', 'filter.exclude']] as const);
  const current = modeForFacet(facet, draft);
  return (
    <View accessibilityRole="radiogroup" style={styles.modeControl}>
      {values.map(([value, label]) => (
        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ checked: current === value }}
          key={value}
          onPress={() => onChange(setModeForFacet(facet, draft, value))}
          style={[styles.modeButton, current === value && styles.modeButtonActive]}>
          <Text style={[styles.modeText, current === value && styles.modeTextActive]}>{t(label)}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function DateEditor({
  draft,
  facet,
  onBack,
  onChange,
}: {
  draft: LibraryFilters;
  facet: 'created' | 'added' | 'modified';
  onBack: () => void;
  onChange: (filters: LibraryFilters) => void;
}) {
  const { t } = useI18n();
  const { after, before } = dateValues(draft, facet);
  const today = new Date();
  const year = today.getFullYear();
  const presets = [
    { label: t('filter.anyTime'), after: '', before: '' },
    { label: t('filter.last7Days'), after: daysAgo(6), before: localDate(today) },
    { label: t('filter.last30Days'), after: daysAgo(29), before: localDate(today) },
    { label: t('filter.thisYear'), after: `${year}-01-01`, before: `${year}-12-31` },
  ];

  return (
    <>
      <Pressable accessibilityLabel={t('filter.back')} onPress={onBack} style={styles.rangeBack}>
        <ArrowLeft color={palette.ink} size={20} />
        <Text style={styles.rangeBackText}>{t('filter.allFilters')}</Text>
      </Pressable>
      <ScrollView contentContainerStyle={styles.rangeContent} keyboardShouldPersistTaps="handled">
        <Text style={styles.sectionLabel}>{t('filter.quickRange')}</Text>
        <View style={styles.presetGrid}>
          {presets.map((preset) => {
            const selected = preset.after === after && preset.before === before;
            return (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                key={preset.label}
                onPress={() => onChange(setDateValues(draft, facet, preset.after, preset.before))}
                style={[styles.presetButton, selected && styles.presetButtonActive]}>
                <Text style={[styles.presetText, selected && styles.presetTextActive]}>{preset.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.sectionLabel}>{t('filter.customRange')}</Text>
        <View style={styles.rangeInputs}>
          <LabeledInput
            keyboardType="number-pad"
            label={t('filter.from')}
            onChange={(value) => onChange(setDateValues(draft, facet, formatDateInput(value), before))}
            placeholder={t('filter.datePlaceholder')}
            value={after}
          />
          <LabeledInput
            keyboardType="number-pad"
            label={t('filter.until')}
            onChange={(value) => onChange(setDateValues(draft, facet, after, formatDateInput(value)))}
            placeholder={t('filter.datePlaceholder')}
            value={before}
          />
        </View>
        <Text style={styles.rangeHint}>{t('filter.boundaries')}</Text>
      </ScrollView>
      <View style={styles.editorFooter}>
        <Pressable onPress={onBack} style={styles.doneButton}>
          <Check color={palette.accentInk} size={18} />
          <Text style={styles.doneText}>{t('filter.keepRange')}</Text>
        </Pressable>
      </View>
    </>
  );
}

function ArchiveEditor({
  draft,
  onBack,
  onChange,
}: {
  draft: LibraryFilters;
  onBack: () => void;
  onChange: (filters: LibraryFilters) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <Pressable accessibilityLabel={t('filter.back')} onPress={onBack} style={styles.rangeBack}>
        <ArrowLeft color={palette.ink} size={20} />
        <Text style={styles.rangeBackText}>{t('filter.allFilters')}</Text>
      </Pressable>
      <ScrollView contentContainerStyle={styles.rangeContent} keyboardShouldPersistTaps="handled">
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: draft.archiveSerialMissing }}
          onPress={() => onChange({
            ...draft,
            archiveSerialMissing: !draft.archiveSerialMissing,
            archiveSerialMin: '',
            archiveSerialMax: '',
          })}
          style={[styles.option, draft.archiveSerialMissing && styles.optionActive]}>
          <View style={styles.optionCopy}>
            <Text style={styles.optionName}>{t('filter.withoutArchive')}</Text>
            <Text style={styles.optionMeta}>{t('filter.withoutArchiveCopy')}</Text>
          </View>
          {draft.archiveSerialMissing && <View style={styles.check}><Check color={palette.accentInk} size={16} /></View>}
        </Pressable>
        <Text style={styles.sectionLabel}>{t('filter.numberRange')}</Text>
        <View style={styles.rangeInputs}>
          <LabeledInput
            disabled={draft.archiveSerialMissing}
            keyboardType="number-pad"
            label={t('filter.greaterThan')}
            onChange={(value) => onChange({ ...draft, archiveSerialMin: digitsOnly(value), archiveSerialMissing: false })}
            placeholder={t('filter.example100')}
            value={draft.archiveSerialMin}
          />
          <LabeledInput
            disabled={draft.archiveSerialMissing}
            keyboardType="number-pad"
            label={t('filter.lessThan')}
            onChange={(value) => onChange({ ...draft, archiveSerialMax: digitsOnly(value), archiveSerialMissing: false })}
            placeholder={t('filter.example500')}
            value={draft.archiveSerialMax}
          />
        </View>
      </ScrollView>
      <View style={styles.editorFooter}>
        <Pressable onPress={onBack} style={styles.doneButton}>
          <Check color={palette.accentInk} size={18} />
          <Text style={styles.doneText}>{t('filter.keepRange')}</Text>
        </Pressable>
      </View>
    </>
  );
}

function LabeledInput({
  disabled,
  keyboardType,
  label,
  onChange,
  placeholder,
  value,
}: {
  disabled?: boolean;
  keyboardType: KeyboardTypeOptions;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  return (
    <View style={[styles.labeledInput, disabled && styles.disabled]}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TextInput
        editable={!disabled}
        keyboardType={keyboardType}
        maxLength={10}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={palette.faint}
        style={styles.rangeInput}
        value={value}
      />
    </View>
  );
}

function FacetRow({
  detail,
  last,
  onPress,
  value,
}: {
  detail: { title: TranslationKey; subtitle: TranslationKey; icon: IconType };
  last?: boolean;
  onPress: () => void;
  value: string;
}) {
  const { t } = useI18n();
  const Icon = detail.icon;
  const active = value !== t('filter.any');
  return (
    <Pressable onPress={onPress} style={[styles.facetRow, !last && styles.facetRowBorder]}>
      <View style={[styles.facetIcon, active && styles.facetIconActive]}>
        <Icon color={active ? palette.accentInk : palette.ink} size={18} />
      </View>
      <View style={styles.facetCopy}>
        <Text style={styles.facetTitle}>{t(detail.title)}</Text>
        <Text numberOfLines={1} style={styles.facetSubtitle}>{t(detail.subtitle)}</Text>
      </View>
      <Text numberOfLines={1} style={[styles.facetValue, active && styles.facetValueActive]}>{value}</Text>
      <ChevronRight color={palette.faint} size={18} />
    </Pressable>
  );
}

type FacetOption = PaperlessOption & { meta?: string };

function optionsForFacet(
  facet: ListFacet,
  catalog: PaperlessCatalog,
  mimeTypes: string[],
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
  formatNumber: (value: number) => string,
): FacetOption[] {
  switch (facet) {
    case 'correspondents': return catalog.correspondents;
    case 'documentTypes': return catalog.documentTypes;
    case 'tags': return catalog.tags.map((tag) => ({
      ...tag,
      ...((tag.pathLabel && tag.pathLabel !== tag.name) || tag.isInboxTag ? {
        meta: `${tag.pathLabel && tag.pathLabel !== tag.name ? tag.pathLabel : ''}${tag.pathLabel && tag.pathLabel !== tag.name && tag.isInboxTag ? ' · ' : ''}${tag.isInboxTag ? t('filter.inboxTag') : ''}`,
      } : {}),
    }));
    case 'storagePaths': return catalog.storagePaths;
    case 'owners': return catalog.owners;
    case 'customFields':
      return catalog.customFields.map((field) => ({
        id: field.id,
        remoteId: field.remoteId,
        name: field.name,
        meta: field.documentCount === undefined
          ? field.dataType
          : t(field.documentCount === 1 ? 'filter.documentOne' : 'filter.documentMany', {
              type: field.dataType,
              count: formatNumber(field.documentCount),
            }),
      }));
    case 'mimeTypes': return mimeTypes.map((mimeType) => ({
      id: mimeType,
      name: localizedMimeTypeLabel(mimeType, t),
      meta: mimeType,
    }));
  }
}

function localizedMimeTypeLabel(
  value: string,
  t: (key: TranslationKey) => string,
) {
  const known: Record<string, TranslationKey> = {
    'application/pdf': 'library.pdfs',
    'image/jpeg': 'filter.mimeJpeg',
    'image/png': 'filter.mimePng',
    'image/tiff': 'filter.mimeTiff',
    'text/plain': 'filter.mimeText',
  };
  return known[value] ? t(known[value]) : value;
}

function idsForFacet(facet: ListFacet, filters: LibraryFilters) {
  switch (facet) {
    case 'correspondents': return filters.correspondentIds;
    case 'documentTypes': return filters.documentTypeIds;
    case 'tags': return filters.tagIds;
    case 'storagePaths': return filters.storagePathIds;
    case 'owners': return filters.ownerIds;
    case 'customFields': return filters.customFieldIds;
    case 'mimeTypes': return filters.mimeTypes;
  }
}

function setIdsForFacet(facet: ListFacet, filters: LibraryFilters, ids: string[], missing = false): LibraryFilters {
  switch (facet) {
    case 'correspondents': return { ...filters, correspondentIds: ids, correspondentMissing: missing };
    case 'documentTypes': return { ...filters, documentTypeIds: ids, documentTypeMissing: missing };
    case 'tags': return { ...filters, tagIds: ids };
    case 'storagePaths': return { ...filters, storagePathIds: ids, storagePathMissing: missing };
    case 'owners': return { ...filters, ownerIds: ids, ownerMissing: missing };
    case 'customFields': return { ...filters, customFieldIds: ids };
    case 'mimeTypes': return { ...filters, mimeTypes: ids };
  }
}

function missingForFacet(facet: ListFacet, filters: LibraryFilters) {
  switch (facet) {
    case 'correspondents': return filters.correspondentMissing;
    case 'documentTypes': return filters.documentTypeMissing;
    case 'storagePaths': return filters.storagePathMissing;
    case 'owners': return filters.ownerMissing;
    default: return false;
  }
}

function modeForFacet(facet: ListFacet, filters: LibraryFilters) {
  switch (facet) {
    case 'correspondents': return filters.correspondentMode;
    case 'documentTypes': return filters.documentTypeMode;
    case 'tags': return filters.tagMode;
    case 'storagePaths': return filters.storagePathMode;
    case 'owners': return filters.ownerMode;
    case 'customFields': return filters.customFieldMode;
    case 'mimeTypes': return 'include';
  }
}

function setModeForFacet(
  facet: ListFacet,
  filters: LibraryFilters,
  mode: LibrarySelectionMode | LibraryTagMode,
): LibraryFilters {
  switch (facet) {
    case 'correspondents': return { ...filters, correspondentMode: mode as LibrarySelectionMode };
    case 'documentTypes': return { ...filters, documentTypeMode: mode as LibrarySelectionMode };
    case 'tags': return { ...filters, tagMode: mode as LibraryTagMode };
    case 'storagePaths': return { ...filters, storagePathMode: mode as LibrarySelectionMode };
    case 'owners': return { ...filters, ownerMode: mode as LibrarySelectionMode };
    case 'customFields': return { ...filters, customFieldMode: mode as LibraryTagMode };
    case 'mimeTypes': return filters;
  }
}

function dateValues(filters: LibraryFilters, facet: 'created' | 'added' | 'modified') {
  if (facet === 'created') return { after: filters.createdAfter, before: filters.createdBefore };
  if (facet === 'added') return { after: filters.addedAfter, before: filters.addedBefore };
  return { after: filters.modifiedAfter, before: filters.modifiedBefore };
}

function setDateValues(
  filters: LibraryFilters,
  facet: 'created' | 'added' | 'modified',
  after: string,
  before: string,
) {
  if (facet === 'created') return { ...filters, createdAfter: after, createdBefore: before };
  if (facet === 'added') return { ...filters, addedAfter: after, addedBefore: before };
  return { ...filters, modifiedAfter: after, modifiedBefore: before };
}

function localDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function daysAgo(days: number) {
  const value = new Date();
  value.setDate(value.getDate() - days);
  return localDate(value);
}

function digitsOnly(value: string) {
  return value.replace(/\D/g, '');
}

function formatDateInput(value: string) {
  const digits = digitsOnly(value).slice(0, 8);
  if (digits.length <= 4) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`;
}

type Translator = (key: TranslationKey, values?: Record<string, string | number>) => string;

function countSummary(count: number, t: Translator, formatNumber: (value: number) => string) {
  return count ? t('filter.selected', { count: formatNumber(count) }) : t('filter.any');
}

function selectionSummary(
  count: number,
  missing: boolean,
  mode: LibrarySelectionMode,
  t: Translator,
  formatNumber: (value: number) => string,
) {
  if (missing) return mode === 'include' ? t('filter.unassigned') : t('filter.assignedOnly');
  if (!count) return t('filter.any');
  return t(mode === 'exclude' ? 'filter.excludeCount' : 'filter.includeCount', {
    count: formatNumber(count),
  });
}

function tagSummary(
  count: number,
  mode: LibraryTagMode,
  t: Translator,
  formatNumber: (value: number) => string,
) {
  if (!count) return t('filter.any');
  return t(mode === 'any' ? 'filter.anyOf' : mode === 'all' ? 'filter.allOf' : 'filter.noneOf', {
    count: formatNumber(count),
  });
}

function rangeSummary(after: string, before: string, t: Translator) {
  if (!after && !before) return t('filter.any');
  if (after && before) return `${after} – ${before}`;
  return after ? t('filter.after', { date: after }) : t('filter.before', { date: before });
}

function archiveSummary(filters: LibraryFilters, t: Translator) {
  if (filters.archiveSerialMissing) return t('filter.unassigned');
  if (!filters.archiveSerialMin && !filters.archiveSerialMax) return t('filter.any');
  if (filters.archiveSerialMin && filters.archiveSerialMax) {
    return `${filters.archiveSerialMin} – ${filters.archiveSerialMax}`;
  }
  return filters.archiveSerialMin ? `>${filters.archiveSerialMin}` : `<${filters.archiveSerialMax}`;
}

const styles = StyleSheet.create({
  mainContent: { paddingTop: 16, paddingBottom: 18 },
  sectionLabel: {
    marginTop: 18,
    marginBottom: 8,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  segmentedWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  segment: {
    minHeight: 48,
    minWidth: 76,
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.paper,
  },
  segmentActive: { borderColor: palette.ink, backgroundColor: palette.ink },
  segmentText: { color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 12, fontWeight: '800' },
  segmentTextActive: { color: palette.paper },
  rowGroup: { overflow: 'hidden', borderRadius: radii.md, backgroundColor: palette.paper },
  facetRow: { minHeight: 70, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 13, gap: 11 },
  facetRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line },
  facetIcon: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 13, backgroundColor: palette.canvas },
  facetIconActive: { backgroundColor: palette.lime },
  facetCopy: { flex: 1, minWidth: 0 },
  facetTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 13, fontWeight: '800' },
  facetSubtitle: { marginTop: 3, color: palette.muted, fontFamily: fonts.sans, fontSize: 10 },
  facetValue: { maxWidth: 128, color: palette.faint, fontFamily: fonts.sans, fontSize: 10, fontWeight: '700' },
  facetValueActive: { color: palette.inkSoft },
  advancedHeader: { minHeight: 68, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18, paddingHorizontal: 4 },
  advancedTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 15, fontWeight: '900' },
  advancedCopy: { marginTop: 3, color: palette.muted, fontFamily: fonts.sans, fontSize: 10 },
  presetNote: { marginTop: 14, padding: 14, borderRadius: radii.md, backgroundColor: palette.paperStrong },
  presetNoteTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 12, fontWeight: '900' },
  presetNoteCopy: { marginTop: 4, color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 10, lineHeight: 15 },
  errorBox: { marginTop: 14, padding: 12, borderRadius: radii.sm, backgroundColor: palette.dangerSurface },
  errorText: { color: palette.danger, fontFamily: fonts.sans, fontSize: 11, lineHeight: 16, fontWeight: '700' },
  footer: { flexDirection: 'row', gap: 10, paddingTop: 12, paddingBottom: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  resetButton: { minHeight: 52, minWidth: 92, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, borderRadius: radii.md, backgroundColor: palette.paper },
  resetText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 13, fontWeight: '900' },
  applyButton: { minHeight: 52, flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radii.md, backgroundColor: palette.lime },
  applyText: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 13, fontWeight: '900' },
  disabled: { opacity: 0.42 },
  editorToolbar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 13, paddingBottom: 10 },
  backButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 17, backgroundColor: palette.paper },
  facetSearch: { height: 48, flex: 1, flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 13, borderRadius: radii.md, backgroundColor: palette.paper, borderWidth: 1, borderColor: palette.line },
  facetSearchInput: { flex: 1, color: palette.ink, fontFamily: fonts.sans, fontSize: 13 },
  clearSearch: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  modeControl: { flexDirection: 'row', gap: 6, padding: 4, marginBottom: 8, borderRadius: radii.md, backgroundColor: palette.paperStrong },
  modeButton: { minHeight: 42, flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  modeButtonActive: { backgroundColor: palette.paper },
  modeText: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, fontWeight: '800' },
  modeTextActive: { color: palette.ink },
  tagSelectionScope: { marginBottom: 10, color: palette.muted, fontFamily: fonts.sans, fontSize: 11, lineHeight: 16 },
  optionListView: { flexShrink: 1 },
  optionList: { paddingBottom: 12 },
  option: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 7, paddingHorizontal: 13, paddingVertical: 8, borderRadius: radii.md, backgroundColor: palette.paper, borderWidth: 1, borderColor: 'transparent' },
  optionActive: { borderColor: palette.limeDark, backgroundColor: palette.paperStrong },
  optionCopy: { flex: 1, minWidth: 0 },
  optionName: { color: palette.ink, fontFamily: fonts.sans, fontSize: 13, fontWeight: '800' },
  optionMeta: { marginTop: 3, color: palette.muted, fontFamily: fonts.sans, fontSize: 10 },
  tagDisclosure: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  colorDot: { width: 10, height: 10, borderRadius: 5 },
  check: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: palette.lime },
  optionEmpty: { alignItems: 'center', paddingVertical: 42 },
  optionEmptyTitle: { color: palette.ink, fontFamily: fonts.serif, fontSize: 22, fontWeight: '600' },
  optionEmptyCopy: { marginTop: 6, color: palette.muted, fontFamily: fonts.sans, fontSize: 11 },
  editorFooter: { paddingTop: 10, paddingBottom: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line },
  doneButton: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radii.md, backgroundColor: palette.lime },
  doneText: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 13, fontWeight: '900' },
  rangeBack: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 9, alignSelf: 'flex-start', marginTop: 8, paddingHorizontal: 10, borderRadius: radii.sm },
  rangeBackText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 12, fontWeight: '800' },
  rangeContent: { paddingBottom: 20 },
  presetGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  presetButton: { minHeight: 48, width: '48%', flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, borderRadius: radii.md, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.paper },
  presetButtonActive: { borderColor: palette.ink, backgroundColor: palette.ink },
  presetText: { color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 11, fontWeight: '800' },
  presetTextActive: { color: palette.paper },
  rangeInputs: { flexDirection: 'row', gap: 10 },
  labeledInput: { flex: 1, minWidth: 0, paddingHorizontal: 13, paddingTop: 9, borderRadius: radii.md, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.paper },
  inputLabel: { color: palette.muted, fontFamily: fonts.sans, fontSize: 9, fontWeight: '900' },
  rangeInput: { minHeight: 42, color: palette.ink, fontFamily: fonts.sans, fontSize: 13, fontWeight: '700' },
  rangeHint: { marginTop: 9, color: palette.muted, fontFamily: fonts.sans, fontSize: 10 },
});
