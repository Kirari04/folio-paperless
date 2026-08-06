import { Check, ChevronDown, ChevronRight, Plus, Search, X } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';

import { KeyboardSheet, KeyboardSheetHandle } from '@/components/keyboard-sheet';
import {
  MotionPressable as Pressable,
  animateLayout,
  hapticFeedback,
} from '@/components/motion';
import { createThemedStyleSheet, fonts, palette, radii } from '@/constants/theme';
import { useI18n } from '@/context/ui-preferences-context';
import { presentRuntimeError } from '@/i18n/error-presentation';
import { PaperlessOption } from '@/types/document';

type ChoiceSheetProps = {
  visible: boolean;
  title: string;
  options: PaperlessOption[];
  selectedIds: string[];
  multiple?: boolean;
  allowNone?: boolean;
  createLabel?: string;
  creationAllowed?: boolean | null;
  onClose: () => void;
  onConfirm: (selected: PaperlessOption[]) => Promise<void> | void;
  onCreate?: (name: string) => Promise<PaperlessOption>;
};

type BusyAction = 'create' | 'save' | null;

export function ChoiceSheet({
  visible,
  title,
  options,
  selectedIds,
  multiple = false,
  allowNone = false,
  createLabel,
  creationAllowed,
  onClose,
  onConfirm,
  onCreate,
}: ChoiceSheetProps) {
  const { t, formatNumber } = useI18n();
  const sheetRef = useRef<KeyboardSheetHandle>(null);
  const wasVisible = useRef(false);
  const [draftIds, setDraftIds] = useState(selectedIds);
  const [localOptions, setLocalOptions] = useState(options);
  const [query, setQuery] = useState('');
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [createdOptionName, setCreatedOptionName] = useState<string | null>(null);
  const [expandedTagIds, setExpandedTagIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (visible && !wasVisible.current) {
      setDraftIds(selectedIds);
      setLocalOptions(options);
      setQuery('');
      setBusyAction(null);
      setError(null);
      setCreatedOptionName(null);
      setExpandedTagIds(new Set(options.flatMap((option) => (
        option.remoteId && option.childRemoteIds?.length ? [option.remoteId] : []
      ))));
    }
    wasVisible.current = visible;
  }, [options, selectedIds, visible]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => {
    const hierarchical = localOptions.some((option) => option.pathLabel !== undefined);
    const sorted = hierarchical
      ? [...localOptions].sort((left, right) => (left.pathLabel || left.name).localeCompare(right.pathLabel || right.name))
      : localOptions;
    if (normalizedQuery) {
      return sorted.filter((option) => (
        option.name.toLocaleLowerCase().includes(normalizedQuery)
        || option.pathLabel?.toLocaleLowerCase().includes(normalizedQuery)
      ));
    }
    if (!hierarchical) return sorted;
    const byRemoteId = new Map(sorted.flatMap((option) => option.remoteId ? [[option.remoteId, option] as const] : []));
    return sorted.filter((option) => {
      let parentId = option.parentRemoteId;
      const visited = new Set<number>();
      while (parentId) {
        if (visited.has(parentId) || !expandedTagIds.has(parentId)) return false;
        visited.add(parentId);
        parentId = byRemoteId.get(parentId)?.parentRemoteId;
      }
      return true;
    });
  }, [expandedTagIds, localOptions, normalizedQuery]);
  const selectedOptions = useMemo(
    () => localOptions.filter((option) => draftIds.includes(option.id)),
    [draftIds, localOptions],
  );
  const hasExactMatch = localOptions.some(
    (option) => option.name.trim().toLocaleLowerCase() === normalizedQuery,
  );
  const canOfferCreation = !!onCreate && creationAllowed !== false;
  const canCreate = canOfferCreation && !!normalizedQuery && !hasExactMatch;
  const creationDenied = !!onCreate && creationAllowed === false;
  const saving = busyAction !== null;
  const canConfirm = multiple || allowNone || draftIds.length > 0;

  function toggle(option: PaperlessOption) {
    setError(null);
    animateLayout();
    if (!multiple) {
      setDraftIds([option.id]);
      return;
    }
    setDraftIds((current) => current.includes(option.id)
      ? current.filter((id) => id !== option.id)
      : [...current, option.id]);
  }

  async function confirm() {
    setBusyAction('save');
    setError(null);
    try {
      await onConfirm(localOptions.filter((option) => draftIds.includes(option.id)));
      await hapticFeedback('confirm');
      sheetRef.current?.close();
    } catch (nextError) {
      setError(presentRuntimeError(nextError, t('choice.saveError')));
      await hapticFeedback('error');
    } finally {
      setBusyAction(null);
    }
  }

  async function createOption() {
    const name = query.trim();
    if (!name || !onCreate || hasExactMatch || creationAllowed === false) return;
    setBusyAction('create');
    setError(null);
    try {
      const option = await onCreate(name);
      animateLayout();
      setLocalOptions((current) => current.some((item) => item.id === option.id)
        ? current
        : [option, ...current]);
      setDraftIds((current) => multiple
        ? [...new Set([...current, option.id])]
        : [option.id]);
      setCreatedOptionName(option.name);
      setQuery('');
      await hapticFeedback('confirm');
    } catch (nextError) {
      setError(presentRuntimeError(nextError, t('choice.createError')));
      await hapticFeedback('error');
    } finally {
      setBusyAction(null);
    }
  }

  const header = (
    <>
      {allowNone && !multiple && (
        <Pressable
          accessibilityRole="radio"
          accessibilityState={{ checked: !draftIds.length }}
          onPress={() => {
            animateLayout();
            setDraftIds([]);
          }}
          style={[styles.option, !draftIds.length && styles.optionSelected]}>
          <View style={styles.optionCopy}>
            <Text style={styles.optionName}>{t('choice.none')}</Text>
            <Text style={styles.optionMeta}>{t('choice.noneSubtitle')}</Text>
          </View>
          {!draftIds.length && <View style={styles.check}><Check color={palette.accentInk} size={16} /></View>}
        </Pressable>
      )}
      {canCreate && (
        <Pressable
          accessibilityHint={t('choice.createHint')}
          disabled={saving}
          haptic="none"
          onPress={createOption}
          style={styles.createOption}>
          <View style={styles.createIcon}>
            {busyAction === 'create'
              ? <ActivityIndicator color={palette.accentInk} size="small" />
              : <Plus color={palette.accentInk} size={18} />}
          </View>
          <View style={styles.optionCopy}>
            <Text numberOfLines={1} style={styles.createName}>
              {t('choice.create', { name: query.trim() })}
            </Text>
            <Text style={styles.optionMeta}>{t('choice.createSubtitle')}</Text>
          </View>
        </Pressable>
      )}
    </>
  );

  return (
    <KeyboardSheet
      accessibilityLabel={t('choice.selectionLabel', { title })}
      onDismiss={onClose}
      ref={sheetRef}
      subtitle={multiple ? t('choice.multipleSubtitle') : t('choice.singleSubtitle')}
      title={title}
      visible={visible}>
      <View style={styles.search}>
        <Search color={palette.muted} size={18} />
        <TextInput
          accessibilityLabel={t('choice.searchLabel', { title })}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(next) => {
            setQuery(next);
            if (error) setError(null);
          }}
          onSubmitEditing={canCreate ? createOption : undefined}
          placeholder={t('choice.searchPlaceholder', { title: title.toLocaleLowerCase() })}
          placeholderTextColor={palette.faint}
          returnKeyType={canCreate ? 'done' : 'search'}
          style={styles.searchInput}
          value={query}
        />
        {!!query && (
          <Pressable accessibilityLabel={t('choice.clearSearch')} haptic="light" onPress={() => setQuery('')} style={styles.clearSearch}>
            <X color={palette.muted} size={16} />
          </Pressable>
        )}
      </View>

      {canOfferCreation && !query && !createdOptionName && (
        <Text style={styles.createHint}>
          {createLabel
            ? t('choice.createNamedHint', { label: createLabel })
            : t('choice.createGenericHint')}
        </Text>
      )}

      {!!createdOptionName && !query && (
        <View accessibilityLiveRegion="polite" style={styles.createdBox}>
          <View style={styles.createdIcon}>
            <Check color={palette.accentInk} size={14} />
          </View>
          <Text style={styles.createdText}>
            {t('choice.created', { name: createdOptionName })}
          </Text>
        </View>
      )}

      {multiple && !!selectedOptions.length && (
        <View style={styles.selectedSection}>
          <Text style={styles.selectedCount}>
            {t('choice.selected', { count: formatNumber(selectedOptions.length) })}
          </Text>
          <ScrollView
            contentContainerStyle={styles.selectedChips}
            horizontal
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}>
            {selectedOptions.map((option) => (
              <Pressable
                accessibilityLabel={t('choice.removeOption', { name: option.pathLabel || option.name })}
                haptic="light"
                key={option.id}
                onPress={() => toggle(option)}
                style={styles.selectedChip}>
                {!!option.color && <View style={[styles.colorDot, { backgroundColor: option.color }]} />}
                <Text numberOfLines={1} style={styles.selectedChipText}>{option.pathLabel || option.name}</Text>
                <X color={palette.accentInk} size={13} />
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {!!error && (
        <View accessibilityLiveRegion="polite" style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <FlatList
        contentContainerStyle={styles.list}
        data={filtered}
        initialNumToRender={14}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(item) => item.id}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {canCreate || creationDenied ? t('choice.noExistingMatch') : t('choice.noMatches')}
            </Text>
            <Text style={styles.emptyCopy}>
              {canCreate
                ? t('choice.createAbove')
                : creationDenied
                  ? t('choice.creationDenied')
                  : t('choice.tryAnother')}
            </Text>
          </View>
        }
        ListHeaderComponent={header}
        removeClippedSubviews={Platform.OS === 'android'}
        renderItem={({ item }) => {
          const selected = draftIds.includes(item.id);
          const hasChildren = !!item.remoteId && !!item.childRemoteIds?.length;
          return (
            <Pressable
              accessibilityLabel={item.pathLabel || item.name}
              accessibilityRole={multiple ? 'checkbox' : 'radio'}
              accessibilityState={{ checked: selected }}
              onPress={() => toggle(item)}
              style={[styles.option, item.pathLabel && { paddingLeft: 10 + Math.min(item.depth ?? 0, 12) * 14 }, selected && styles.optionSelected]}>
              {hasChildren ? (
                <Pressable
                  accessibilityLabel={t(
                    expandedTagIds.has(item.remoteId!) ? 'choice.collapse' : 'choice.expand',
                    { name: item.pathLabel || item.name },
                  )}
                  onPress={(event) => {
                    event.stopPropagation();
                    setExpandedTagIds((current) => {
                      const next = new Set(current);
                      if (next.has(item.remoteId!)) next.delete(item.remoteId!);
                      else next.add(item.remoteId!);
                      return next;
                    });
                  }}
                  style={styles.disclosure}>
                  {expandedTagIds.has(item.remoteId!)
                    ? <ChevronDown color={palette.muted} size={16} />
                    : <ChevronRight color={palette.muted} size={16} />}
                </Pressable>
              ) : item.pathLabel ? <View style={styles.disclosure} /> : null}
              {!!item.color && <View style={[styles.colorDot, { backgroundColor: item.color }]} />}
              <View style={styles.optionCopy}>
                <Text numberOfLines={2} style={styles.optionName}>{item.name}</Text>
                {(!!item.pathLabel && item.pathLabel !== item.name || item.isInboxTag) && (
                  <Text numberOfLines={1} style={styles.optionMeta}>
                    {item.pathLabel !== item.name ? item.pathLabel : ''}{item.pathLabel !== item.name && item.isInboxTag ? ' · ' : ''}{item.isInboxTag ? t('choice.inboxTag') : ''}
                  </Text>
                )}
              </View>
              {selected && <View style={styles.check}><Check color={palette.accentInk} size={16} /></View>}
            </Pressable>
          );
        }}
        style={styles.listView}
        windowSize={7}
      />

      <View style={styles.footer}>
        <Pressable haptic="light" onPress={() => sheetRef.current?.close()} style={styles.cancelButton}>
          <Text style={styles.cancelText}>{t('common.cancel')}</Text>
        </Pressable>
        <Pressable
          disabled={saving || !canConfirm}
          haptic="none"
          onPress={confirm}
          style={[styles.saveButton, (saving || !canConfirm) && styles.disabled]}>
          {busyAction === 'save'
            ? <ActivityIndicator color={palette.accentInk} />
            : <Check color={palette.accentInk} size={19} />}
          <Text style={styles.saveButtonText}>
            {multiple
              ? t('choice.applySelected', { count: formatNumber(draftIds.length) })
              : t('choice.applySelection')}
          </Text>
        </Pressable>
      </View>
    </KeyboardSheet>
  );
}

const styles = createThemedStyleSheet({
  search: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
    paddingLeft: 14,
    paddingRight: 7,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: radii.md,
    backgroundColor: palette.paper,
  },
  searchInput: {
    flex: 1,
    minHeight: 40,
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 16,
  },
  clearSearch: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
  },
  createHint: {
    marginTop: 7,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 16,
  },
  createdBox: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginTop: 8,
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: radii.md,
    backgroundColor: palette.mint,
  },
  createdIcon: {
    width: 26,
    height: 26,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    backgroundColor: palette.lime,
  },
  createdText: {
    flex: 1,
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 16,
  },
  selectedSection: {
    marginTop: 12,
  },
  selectedCount: {
    marginBottom: 7,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  selectedChips: {
    gap: 7,
    paddingRight: 8,
  },
  selectedChip: {
    maxWidth: 190,
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: radii.pill,
    backgroundColor: palette.lime,
  },
  selectedChipText: {
    flexShrink: 1,
    color: palette.accentInk,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '800',
  },
  listView: {
    flexShrink: 1,
    marginTop: 8,
  },
  list: {
    gap: 7,
    paddingBottom: 8,
  },
  option: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'transparent',
    borderRadius: radii.md,
    backgroundColor: palette.paper,
  },
  optionSelected: {
    borderColor: palette.limeDark,
    backgroundColor: palette.mint,
  },
  optionCopy: {
    flex: 1,
    minWidth: 0,
  },
  optionName: {
    flex: 1,
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
    fontWeight: '700',
  },
  optionMeta: {
    marginTop: 3,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 15,
  },
  disclosure: {
    width: 28,
    height: 36,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  colorDot: {
    width: 10,
    height: 10,
    flexShrink: 0,
    borderRadius: 5,
  },
  check: {
    width: 28,
    height: 28,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: palette.lime,
  },
  createOption: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: palette.limeDark,
    borderRadius: radii.md,
    backgroundColor: palette.mint,
  },
  createIcon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    backgroundColor: palette.lime,
  },
  createName: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '900',
  },
  empty: {
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 30,
  },
  emptyTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
    fontWeight: '800',
  },
  emptyCopy: {
    marginTop: 4,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 11,
    textAlign: 'center',
  },
  errorBox: {
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radii.sm,
    backgroundColor: palette.dangerSurface,
  },
  errorText: {
    color: palette.danger,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 16,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingTop: 9,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderColor: palette.line,
  },
  cancelButton: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 17,
    paddingVertical: 12,
    borderRadius: radii.md,
    backgroundColor: palette.paper,
  },
  cancelText: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '800',
  },
  saveButton: {
    flex: 1,
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: radii.md,
    backgroundColor: palette.lime,
  },
  saveButtonText: {
    color: palette.accentInk,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '900',
  },
  disabled: {
    opacity: 0.45,
  },
});
