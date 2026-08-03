import { Check } from 'lucide-react-native';
import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';

import { KeyboardSheet, type KeyboardSheetHandle } from '@/components/keyboard-sheet';
import { MotionPressable as Pressable } from '@/components/motion';
import { fonts, palette, radii } from '@/constants/theme';
import { useI18n } from '@/i18n';
import { presentRuntimeError } from '@/i18n/error-presentation';

export type SavedViewPresentationEdit = {
  displayMode?: string | null;
  pageSize?: number | null;
  displayFields?: (string | number)[] | null;
  showOnDashboard?: boolean;
  showInSidebar?: boolean;
};

export type SavedViewPresentationCapabilities = {
  displayMode?: boolean;
  pageSize?: boolean;
  displayFields?: boolean;
  showOnDashboard?: boolean;
  showInSidebar?: boolean;
};

export function SavedViewEditorSheet({
  initialName,
  initialPresentation,
  presentationCapabilities,
  displayFieldOptions = [],
  mode,
  onClose,
  onSave,
  unsupportedRules,
  visible,
}: {
  initialName: string;
  mode: 'create' | 'rename' | 'duplicate';
  onClose: () => void;
  onSave: (name: string, presentation?: SavedViewPresentationEdit) => Promise<void>;
  initialPresentation?: SavedViewPresentationEdit;
  presentationCapabilities?: SavedViewPresentationCapabilities;
  displayFieldOptions?: { value: string; label: string }[];
  unsupportedRules?: boolean;
  visible: boolean;
}) {
  const ref = useRef<KeyboardSheetHandle>(null);
  const { formatNumber, t } = useI18n();
  const displayModes = [
    { value: 'table', label: t('savedViewEditor.table') },
    { value: 'smallCards', label: t('savedViewEditor.smallCards') },
    { value: 'largeCards', label: t('savedViewEditor.largeCards') },
  ] as const;
  const [name, setName] = useState(initialName);
  const [displayMode, setDisplayMode] = useState(initialPresentation?.displayMode ?? 'table');
  const [pageSize, setPageSize] = useState(initialPresentation?.pageSize ? String(initialPresentation.pageSize) : '50');
  const [displayFields, setDisplayFields] = useState(
    (initialPresentation?.displayFields ?? []).map(String),
  );
  const [showOnDashboard, setShowOnDashboard] = useState(initialPresentation?.showOnDashboard ?? false);
  const [showInSidebar, setShowInSidebar] = useState(initialPresentation?.showInSidebar ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) {
      setError(t('savedViewEditor.nameRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const parsedPageSize = Number(pageSize);
      if (presentationCapabilities?.pageSize && (!Number.isInteger(parsedPageSize) || parsedPageSize < 1 || parsedPageSize > 1000)) {
        throw new Error(t('savedViewEditor.pageSizeError'));
      }
      const presentation: SavedViewPresentationEdit = {
        ...(presentationCapabilities?.displayMode ? { displayMode } : {}),
        ...(presentationCapabilities?.pageSize ? { pageSize: parsedPageSize } : {}),
        ...(presentationCapabilities?.displayFields ? { displayFields } : {}),
        ...(presentationCapabilities?.showOnDashboard ? { showOnDashboard } : {}),
        ...(presentationCapabilities?.showInSidebar ? { showInSidebar } : {}),
      };
      await onSave(name.trim(), Object.keys(presentation).length ? presentation : undefined);
      ref.current?.close();
    } catch (nextError) {
      setError(presentRuntimeError(nextError, t('savedViewEditor.saveError')));
    } finally {
      setBusy(false);
    }
  }

  const title = mode === 'create'
    ? t('savedViewEditor.createTitle')
    : mode === 'duplicate'
      ? t('savedViewEditor.duplicateTitle')
      : t('savedViewEditor.editTitle');
  const supportedDisplayFieldValues = useMemo(
    () => new Set(displayFieldOptions.map((option) => option.value)),
    [displayFieldOptions],
  );
  const opaqueDisplayFields = displayFields.filter((value) => !supportedDisplayFieldValues.has(value));
  const hasPresentationControls = Boolean(
    presentationCapabilities
    && Object.values(presentationCapabilities).some(Boolean),
  );
  return (
    <KeyboardSheet
      accessibilityLabel={title}
      onDismiss={onClose}
      ref={ref}
      subtitle={t('savedViewEditor.subtitle')}
      title={title}
      visible={visible}>
      {unsupportedRules && (
        <View style={styles.warning}>
          <Text style={styles.warningTitle}>{t('savedViewEditor.unsupportedTitle')}</Text>
          <Text style={styles.warningCopy}>
            {t('savedViewEditor.unsupportedCopy')}
          </Text>
        </View>
      )}
      <Text style={styles.label}>{t('savedViewEditor.name')}</Text>
      <TextInput
        accessibilityLabel={t('savedViewEditor.nameLabel')}
        autoCapitalize="sentences"
        autoCorrect
        autoFocus
        editable={!busy}
        maxLength={128}
        onChangeText={setName}
        onSubmitEditing={() => void save()}
        placeholder={t('savedViewEditor.namePlaceholder')}
        placeholderTextColor={palette.faint}
        returnKeyType="done"
        selectTextOnFocus={mode !== 'create'}
        style={styles.input}
        value={name}
      />
      {hasPresentationControls && (
        <View style={styles.presentation}>
          <Text style={styles.presentationTitle}>{t('savedViewEditor.presentation')}</Text>
          <Text style={styles.presentationCopy}>{t('savedViewEditor.presentationCopy', { count: formatNumber(displayFields.length) })}</Text>
          {presentationCapabilities?.displayMode && (
            <>
              <Text style={styles.label}>{t('savedViewEditor.displayMode')}</Text>
              <View accessibilityRole="radiogroup" style={styles.modeRow}>
                {!displayModes.some((option) => option.value === displayMode) && (
                  <Pressable accessibilityRole="radio" accessibilityState={{ checked: true }} style={[styles.mode, styles.modeActive]}>
                    <Text style={[styles.modeText, styles.modeTextActive]}>{t('savedViewEditor.serverMode', { mode: displayMode })}</Text>
                  </Pressable>
                )}
                {displayModes.map((option) => (
                  <Pressable accessibilityRole="radio" accessibilityState={{ checked: displayMode === option.value }} key={option.value} onPress={() => setDisplayMode(option.value)} style={[styles.mode, displayMode === option.value && styles.modeActive]}>
                    <Text style={[styles.modeText, displayMode === option.value && styles.modeTextActive]}>{option.label}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          )}
          {presentationCapabilities?.displayFields && (
            <>
              <Text style={styles.label}>{t('savedViewEditor.displayFields')}</Text>
              <View style={styles.modeRow}>
                {displayFieldOptions.map((option) => {
                  const selected = displayFields.includes(option.value);
                  return (
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: selected }}
                      key={option.value}
                      onPress={() => setDisplayFields((current) => selected
                        ? current.filter((value) => value !== option.value)
                        : [...current, option.value])}
                      style={[styles.mode, selected && styles.modeActive]}>
                      {selected && <Check color={palette.paper} size={13} />}
                      <Text style={[styles.modeText, selected && styles.modeTextActive]}>{option.label}</Text>
                    </Pressable>
                  );
                })}
                {opaqueDisplayFields.map((value) => (
                  <View key={value} style={[styles.mode, styles.modeLocked]}>
                    <Text style={styles.modeText}>{t('savedViewEditor.serverField', { field: value })}</Text>
                  </View>
                ))}
              </View>
              {!!opaqueDisplayFields.length && (
                <Text style={styles.presentationCopy}>{t('savedViewEditor.serverFieldsPreserved')}</Text>
              )}
            </>
          )}
          {presentationCapabilities?.pageSize && (
            <>
              <Text style={styles.label}>{t('savedViewEditor.pageSize')}</Text>
              <TextInput accessibilityLabel={t('savedViewEditor.pageSizeLabel')} editable={!busy} inputMode="numeric" onChangeText={setPageSize} placeholder="50" placeholderTextColor={palette.faint} style={styles.input} value={pageSize} />
            </>
          )}
          {presentationCapabilities?.showOnDashboard && (
            <BooleanField
              label={t('savedViewEditor.showOnDashboard')}
              onPress={() => setShowOnDashboard((current) => !current)}
              selected={showOnDashboard}
            />
          )}
          {presentationCapabilities?.showInSidebar && (
            <BooleanField
              label={t('savedViewEditor.showInSidebar')}
              onPress={() => setShowInSidebar((current) => !current)}
              selected={showInSidebar}
            />
          )}
        </View>
      )}
      {!!error && <Text accessibilityLiveRegion="assertive" style={styles.error}>{error}</Text>}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: busy || !name.trim() }}
        disabled={busy || !name.trim()}
        onPress={() => void save()}
        style={[styles.save, (busy || !name.trim()) && styles.disabled]}>
        {busy && <ActivityIndicator color={palette.accentInk} size="small" />}
        <Text style={styles.saveText}>{mode === 'duplicate' ? t('savedViewEditor.duplicate') : t('common.save')}</Text>
      </Pressable>
      <View style={styles.bottomSpace} />
    </KeyboardSheet>
  );
}

function BooleanField({ label, onPress, selected }: { label: string; onPress: () => void; selected: boolean }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={styles.booleanField}>
      <View style={[styles.checkBox, selected && styles.checkBoxActive]}>
        {selected && <Check color={palette.paper} size={14} />}
      </View>
      <Text style={styles.booleanLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  warning: { padding: 13, borderRadius: radii.md, backgroundColor: palette.dangerSurface, marginBottom: 14 },
  warningTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 12, fontWeight: '900' },
  warningCopy: { color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 11, lineHeight: 16, marginTop: 3 },
  label: { color: palette.muted, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900', letterSpacing: 0.6, marginBottom: 7 },
  input: { minHeight: 54, color: palette.ink, fontFamily: fonts.sans, fontSize: 15, paddingHorizontal: 15, borderRadius: radii.md, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.paper },
  presentation: { gap: 9, padding: 13, marginTop: 13, borderRadius: radii.lg, backgroundColor: palette.paperStrong },
  presentationTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 12, fontWeight: '900' },
  presentationCopy: { color: palette.muted, fontFamily: fonts.sans, fontSize: 10, lineHeight: 15, marginBottom: 3 },
  modeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  mode: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 11, borderRadius: radii.pill, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.paper },
  modeActive: { borderColor: palette.ink, backgroundColor: palette.ink },
  modeLocked: { borderStyle: 'dashed' },
  modeText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 10, fontWeight: '800' },
  modeTextActive: { color: palette.paper },
  error: { color: palette.danger, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17, marginTop: 9 },
  save: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 14, borderRadius: radii.md, backgroundColor: palette.lime },
  saveText: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 13, fontWeight: '900' },
  disabled: { opacity: 0.45 },
  booleanField: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4 },
  checkBox: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center', borderRadius: 7, borderWidth: 1, borderColor: palette.lineStrong, backgroundColor: palette.paper },
  checkBoxActive: { borderColor: palette.ink, backgroundColor: palette.ink },
  booleanLabel: { flex: 1, color: palette.ink, fontFamily: fonts.sans, fontSize: 12, fontWeight: '800' },
  bottomSpace: { height: 18 },
});
