import { ChevronDown } from 'lucide-react-native';
import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { KeyboardSheet, type KeyboardSheetHandle } from '@/components/keyboard-sheet';
import { MotionPressable as Pressable } from '@/components/motion';
import { availableTagParents, buildSparseCatalogEdit } from '@/lib/catalog-management';
import { fonts, palette, radii } from '@/constants/theme';
import { useI18n } from '@/i18n';
import { presentRuntimeError } from '@/i18n/error-presentation';
import type { PaperlessCatalogEditByResource, PaperlessCatalogObject, PaperlessCatalogResource, PaperlessTag } from '@/types/paperless-advanced';

export type CatalogEditorValue = PaperlessCatalogEditByResource[PaperlessCatalogResource];

export function CatalogEditorSheet({
  item,
  nestedTagsSupported,
  onClose,
  onSave,
  resource,
  tags,
  visible,
}: {
  item: PaperlessCatalogObject | null;
  nestedTagsSupported: boolean;
  onClose: () => void;
  onSave: (edit: CatalogEditorValue) => Promise<void>;
  resource: PaperlessCatalogResource;
  tags: PaperlessTag[];
  visible: boolean;
}) {
  const ref = useRef<KeyboardSheetHandle>(null);
  const { t } = useI18n();
  const matchingAlgorithms = [
    { value: '0', label: t('catalogEditor.none') },
    { value: '1', label: t('catalogEditor.anyWord') },
    { value: '2', label: t('catalogEditor.allWords') },
    { value: '3', label: t('catalogEditor.exact') },
    { value: '4', label: t('catalogEditor.regex') },
    { value: '5', label: t('catalogEditor.fuzzy') },
    { value: '6', label: t('catalogEditor.auto') },
  ] as const;
  const [name, setName] = useState(item?.name ?? '');
  const [match, setMatch] = useState(item?.match ?? '');
  const [algorithm, setAlgorithm] = useState(
    item
      ? item.matchingAlgorithm === null || item.matchingAlgorithm === undefined
        ? ''
        : String(item.matchingAlgorithm)
      : '1',
  );
  const [insensitive, setInsensitive] = useState(item?.isInsensitive ?? false);
  const [color, setColor] = useState(item?.kind === 'tag' ? item.color ?? '' : '#4d7c0f');
  const [path, setPath] = useState(item?.kind === 'storagePath' ? item.path : '');
  const [parentId, setParentId] = useState<number | null>(item?.kind === 'tag' ? item.parentId : null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parentOptions = useMemo(() => availableTagParents(tags, item?.id ?? null), [item?.id, tags]);

  async function save() {
    if (!name.trim()) {
      setError(t('catalogEditor.nameRequired'));
      return;
    }
    const colorChanged = item?.kind !== 'tag' || color !== (item.color ?? '');
    if (resource === 'tags' && colorChanged && !/^#[0-9a-f]{6}$/i.test(color.trim())) {
      setError(t('catalogEditor.colorError'));
      return;
    }
    const pathChanged = item?.kind !== 'storagePath' || path !== item.path;
    if (resource === 'storagePaths' && pathChanged && !path.trim()) {
      setError(t('catalogEditor.pathRequired'));
      return;
    }
    const edit = buildSparseCatalogEdit(resource, item, {
      name,
      match,
      matchingAlgorithm: algorithm,
      isInsensitive: insensitive,
      color,
      path,
      parentId,
    }, nestedTagsSupported) as CatalogEditorValue;
    if (item && Object.keys(edit).length === 0) {
      ref.current?.close();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(edit);
      ref.current?.close();
    } catch (nextError) {
      setError(presentRuntimeError(nextError, t('catalogEditor.saveError')));
    } finally {
      setBusy(false);
    }
  }

  const label = resource === 'tags'
    ? t('catalogEditor.tag')
    : resource === 'correspondents'
      ? t('catalogEditor.correspondent')
      : resource === 'documentTypes'
        ? t('catalogEditor.documentType')
        : t('catalogEditor.storagePath');
  return (
    <KeyboardSheet
      accessibilityLabel={item ? t('catalogEditor.editLabel', { label }) : t('catalogEditor.createLabel', { label })}
      onDismiss={onClose}
      ref={ref}
      subtitle={t('catalogEditor.subtitle')}
      title={item ? t('catalogEditor.editTitle', { label }) : t('catalogEditor.newTitle', { label })}
      visible={visible}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Field label={t('catalogEditor.name')} onChangeText={setName} value={name} />
        {resource === 'tags' && <Field autoCapitalize="none" label={t('catalogEditor.color')} onChangeText={setColor} placeholder="#4d7c0f" value={color} />}
        {resource === 'storagePaths' && <Field autoCapitalize="none" label={t('catalogEditor.pathTemplate')} onChangeText={setPath} placeholder={t('catalogEditor.pathPlaceholder')} value={path} />}
        {resource === 'tags' && nestedTagsSupported && (
          <View>
            <Text style={styles.label}>{t('catalogEditor.parentTag')}</Text>
            <ScrollView horizontal contentContainerStyle={styles.parents} showsHorizontalScrollIndicator={false}>
              <Pressable accessibilityRole="radio" accessibilityState={{ checked: parentId === null }} onPress={() => setParentId(null)} style={[styles.parent, parentId === null && styles.parentActive]}>
                <Text style={[styles.parentText, parentId === null && styles.parentTextActive]}>{t('catalogEditor.noParent')}</Text>
              </Pressable>
              {parentOptions.map((tag) => (
                <Pressable accessibilityRole="radio" accessibilityState={{ checked: parentId === tag.id }} key={tag.id} onPress={() => setParentId(tag.id)} style={[styles.parent, parentId === tag.id && styles.parentActive]}>
                  <Text numberOfLines={1} style={[styles.parentText, parentId === tag.id && styles.parentTextActive]}>{tag.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        )}
        <View style={styles.advanced}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: advancedOpen }} onPress={() => setAdvancedOpen((current) => !current)} style={styles.advancedToggle}>
            <View style={styles.switchCopy}>
              <Text style={styles.advancedTitle}>{t('catalogEditor.advanced')}</Text>
              <Text numberOfLines={2} style={styles.advancedCopy}>{match ? t('catalogEditor.currentPattern', { match }) : t('catalogEditor.advancedCopy')}</Text>
            </View>
            <ChevronDown color={palette.ink} size={18} style={{ transform: [{ rotate: advancedOpen ? '180deg' : '0deg' }] }} />
          </Pressable>
          {advancedOpen && (
            <View style={styles.advancedFields}>
              <Field label={t('catalogEditor.matchPattern')} onChangeText={setMatch} value={match} />
              <View>
                <Text style={styles.label}>{t('catalogEditor.algorithm')}</Text>
                <View accessibilityRole="radiogroup" style={styles.algorithms}>
                  {!matchingAlgorithms.some((option) => option.value === algorithm) && (
                    <Pressable accessibilityRole="radio" accessibilityState={{ checked: true }} style={[styles.algorithm, styles.algorithmActive]}>
                      <Text style={[styles.algorithmText, styles.algorithmTextActive]}>{t('catalogEditor.serverAlgorithm', { algorithm: algorithm || t('metadata.notSet') })}</Text>
                    </Pressable>
                  )}
                  {matchingAlgorithms.map((option) => (
                    <Pressable accessibilityRole="radio" accessibilityState={{ checked: algorithm === option.value }} key={option.value} onPress={() => setAlgorithm(option.value)} style={[styles.algorithm, algorithm === option.value && styles.algorithmActive]}>
                      <Text style={[styles.algorithmText, algorithm === option.value && styles.algorithmTextActive]}>{option.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
              <View style={styles.switchRow}>
                <View style={styles.switchCopy}>
                  <Text style={styles.switchTitle}>{t('catalogEditor.ignoreCase')}</Text>
                  <Text style={styles.switchSubtitle}>{t('catalogEditor.ignoreCaseCopy')}</Text>
                </View>
                <Switch onValueChange={setInsensitive} trackColor={{ false: palette.lineStrong, true: palette.lime }} value={insensitive} />
              </View>
            </View>
          )}
        </View>
        {!!error && <Text accessibilityLiveRegion="assertive" style={styles.error}>{error}</Text>}
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || !name.trim() }} disabled={busy || !name.trim()} onPress={() => void save()} style={[styles.save, (busy || !name.trim()) && styles.disabled]}>
          {busy && <ActivityIndicator color={palette.accentInk} size="small" />}
          <Text style={styles.saveText}>{item ? t('editor.saveChanges') : t('catalogEditor.create', { label })}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardSheet>
  );
}

function Field({ autoCapitalize = 'sentences', label, onChangeText, placeholder, value }: { autoCapitalize?: 'none' | 'sentences'; label: string; onChangeText: (value: string) => void; placeholder?: string; value: string }) {
  return <View><Text style={styles.label}>{label.toLocaleUpperCase()}</Text><TextInput accessibilityLabel={label} autoCapitalize={autoCapitalize} autoCorrect={false} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={palette.faint} style={styles.input} value={value} /></View>;
}

const styles = StyleSheet.create({
  content: { gap: 14, paddingBottom: 24 },
  label: { color: palette.muted, fontFamily: fonts.sans, fontSize: 9, fontWeight: '900', letterSpacing: 0.65, marginBottom: 6 },
  input: { minHeight: 52, color: palette.ink, fontFamily: fonts.sans, fontSize: 14, paddingHorizontal: 14, borderRadius: radii.md, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.paper },
  parents: { gap: 7, paddingRight: 10 },
  parent: { minHeight: 44, maxWidth: 180, justifyContent: 'center', paddingHorizontal: 12, borderRadius: radii.pill, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.paper },
  parentActive: { backgroundColor: palette.ink, borderColor: palette.ink },
  parentText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 11, fontWeight: '800' },
  parentTextActive: { color: palette.paper },
  advanced: { padding: 14, borderRadius: radii.lg, backgroundColor: palette.paperStrong },
  advancedToggle: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10 },
  advancedFields: { gap: 12, paddingTop: 14 },
  advancedTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 13, fontWeight: '900' },
  advancedCopy: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, lineHeight: 16, marginTop: 2 },
  algorithms: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  algorithm: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 11, borderRadius: radii.pill, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.paper },
  algorithmActive: { borderColor: palette.ink, backgroundColor: palette.ink },
  algorithmText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 10, fontWeight: '800' },
  algorithmTextActive: { color: palette.paper },
  switchRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchCopy: { flex: 1 },
  switchTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 12, fontWeight: '900' },
  switchSubtitle: { color: palette.muted, fontFamily: fonts.sans, fontSize: 10, marginTop: 2 },
  error: { color: palette.danger, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  save: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radii.md, backgroundColor: palette.lime },
  saveText: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 13, fontWeight: '900' },
  disabled: { opacity: 0.45 },
});
