import { Check, CircleDollarSign, Link2, Search, Trash2 } from 'lucide-react-native';
import { useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
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
import { fonts, palette, radii } from '@/constants/theme';
import { isValidIsoDate } from '@/lib/validation';
import {
  DocumentItem,
  PaperlessCustomFieldDefinition,
  PaperlessCustomFieldValue,
} from '@/types/document';

type Props = {
  definition: PaperlessCustomFieldDefinition | null;
  documents: DocumentItem[];
  value?: PaperlessCustomFieldValue;
  onClose: () => void;
  onSave: (value: PaperlessCustomFieldValue) => Promise<void>;
  onRemove?: () => Promise<void>;
};

function textValue(value: PaperlessCustomFieldValue['value'] | undefined) {
  if (Array.isArray(value) || value === null || value === undefined || typeof value === 'boolean') return '';
  return String(value);
}

function keyboardFor(definition: PaperlessCustomFieldDefinition) {
  if (definition.dataType === 'integer') return 'number-pad' as const;
  if (['float', 'monetary'].includes(definition.dataType)) return 'decimal-pad' as const;
  if (definition.dataType === 'url') return 'url' as const;
  return 'default' as const;
}

function placeholderFor(definition: PaperlessCustomFieldDefinition) {
  if (definition.dataType === 'date') return 'YYYY-MM-DD';
  if (definition.dataType === 'url') return 'https://example.com';
  if (definition.dataType === 'monetary') {
    return definition.defaultCurrency ? `${definition.defaultCurrency}0.00` : '0.00';
  }
  return `Enter ${definition.name.toLocaleLowerCase()}`;
}

export function CustomFieldSheet({
  definition,
  documents,
  value,
  onClose,
  onSave,
  onRemove,
}: Props) {
  const sheetRef = useRef<KeyboardSheetHandle>(null);
  const inputRef = useRef<TextInput>(null);
  const [text, setText] = useState(textValue(value?.value));
  const [booleanValue, setBooleanValue] = useState(
    typeof value?.value === 'boolean' ? value.value : false,
  );
  const [selectedOption, setSelectedOption] = useState(
    typeof value?.value === 'string' ? value.value : '',
  );
  const [linkedIds, setLinkedIds] = useState<number[]>(
    Array.isArray(value?.value) ? value.value : [],
  );
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

  const linkedDocuments = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return documents
      .filter((document) => document.remoteId)
      .filter((document) => !normalized || `${document.title} ${document.correspondent}`
        .toLocaleLowerCase()
        .includes(normalized))
      .slice(0, 40);
  }, [documents, query]);

  if (!definition) return null;

  function parsedValue(): PaperlessCustomFieldValue['value'] {
    if (!definition) return null;
    const normalized = text.trim();
    if (definition.dataType === 'boolean') return booleanValue;
    if (definition.dataType === 'select') return selectedOption || null;
    if (definition.dataType === 'documentlink') return linkedIds;
    if (!normalized) return null;
    if (definition.dataType === 'date') {
      if (!isValidIsoDate(normalized)) {
        throw new Error('Use a valid date in YYYY-MM-DD format.');
      }
      return normalized;
    }
    if (definition.dataType === 'url') {
      try {
        new URL(normalized);
      } catch {
        throw new Error('Enter a complete URL, including https://.');
      }
      return normalized;
    }
    if (definition.dataType === 'integer') {
      if (!/^-?\d+$/.test(normalized)) throw new Error('Enter a whole number.');
      return Number(normalized);
    }
    if (definition.dataType === 'float') {
      const number = Number(normalized.replace(',', '.'));
      if (!Number.isFinite(number)) throw new Error('Enter a valid number.');
      return number;
    }
    if (definition.dataType === 'monetary') {
      if (/^[A-Z]{3}-?\d+(\.\d{1,2})?$/.test(normalized)) return normalized;
      const amount = normalized.replace(',', '.');
      if (!/^-?\d+(\.\d{1,2})?$/.test(amount)) {
        throw new Error('Enter an amount such as 86.40 or CHF86.40.');
      }
      return definition.defaultCurrency ? `${definition.defaultCurrency}${amount}` : amount;
    }
    return normalized;
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        fieldId: definition!.id,
        fieldRemoteId: definition!.remoteId,
        value: parsedValue(),
      });
      await hapticFeedback('confirm');
      sheetRef.current?.close();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not save this field.');
      await hapticFeedback('error');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!onRemove) return;
    setSaving(true);
    setError(null);
    try {
      await onRemove();
      await hapticFeedback('warning');
      sheetRef.current?.close();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not remove this field.');
      await hapticFeedback('error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <KeyboardSheet
      accessibilityLabel={`${definition.name} custom field editor`}
      onDismiss={onClose}
      onOpened={() => inputRef.current?.focus()}
      ref={sheetRef}
      subtitle={definition.dataType.replace('documentlink', 'Linked documents')}
      title={definition.name}
      visible>
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={styles.scroll}>
            {definition.dataType === 'boolean' ? (
              <View style={styles.booleanRow}>
                <View>
                  <Text style={styles.booleanTitle}>{booleanValue ? 'Yes' : 'No'}</Text>
                  <Text style={styles.booleanCopy}>Toggle this document value</Text>
                </View>
                <Switch
                  onValueChange={(next) => {
                    setBooleanValue(next);
                    void hapticFeedback('selection');
                  }}
                  trackColor={{ false: palette.lineStrong, true: palette.ink }}
                  thumbColor={booleanValue ? palette.lime : palette.paper}
                  value={booleanValue}
                />
              </View>
            ) : definition.dataType === 'select' ? (
              <View style={styles.options}>
                {definition.selectOptions.map((option) => {
                  const selected = selectedOption === option.id;
                  return (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                      key={option.id}
                      onPress={() => {
                        animateLayout();
                        setSelectedOption(option.id);
                      }}
                      style={[styles.option, selected && styles.optionSelected]}>
                      <Text style={styles.optionLabel}>{option.label}</Text>
                      {selected && <Check color={palette.ink} size={18} />}
                    </Pressable>
                  );
                })}
              </View>
            ) : definition.dataType === 'documentlink' ? (
              <View>
                <View style={styles.search}>
                  <Search color={palette.muted} size={18} />
                  <TextInput
                    onChangeText={setQuery}
                    placeholder="Find a document"
                    placeholderTextColor={palette.faint}
                    style={styles.searchInput}
                    value={query}
                  />
                </View>
                <View style={styles.options}>
                  {linkedDocuments.map((document) => {
                    const remoteId = document.remoteId!;
                    const selected = linkedIds.includes(remoteId);
                    return (
                      <Pressable
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: selected }}
                        key={document.id}
                        onPress={() => {
                          animateLayout();
                          setLinkedIds((current) => selected
                            ? current.filter((id) => id !== remoteId)
                            : [...current, remoteId]);
                        }}
                        style={[styles.option, selected && styles.optionSelected]}>
                        <Link2 color={palette.muted} size={16} />
                        <View style={styles.optionCopy}>
                          <Text numberOfLines={1} style={styles.optionLabel}>{document.title}</Text>
                          <Text numberOfLines={1} style={styles.optionMeta}>{document.correspondent}</Text>
                        </View>
                        {selected && <Check color={palette.ink} size={18} />}
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ) : (
              <View style={[styles.inputWrap, focused && styles.inputWrapFocused]}>
                {definition.dataType === 'monetary' && (
                  <CircleDollarSign color={palette.muted} size={19} />
                )}
                <TextInput
                  autoCapitalize={definition.dataType === 'url' ? 'none' : 'sentences'}
                  autoCorrect={!['url', 'integer', 'float', 'monetary'].includes(definition.dataType)}
                  keyboardType={keyboardFor(definition)}
                  multiline={definition.dataType === 'longtext'}
                  onBlur={() => setFocused(false)}
                  onChangeText={setText}
                  onFocus={() => setFocused(true)}
                  onSubmitEditing={definition.dataType === 'longtext' ? undefined : save}
                  placeholder={placeholderFor(definition)}
                  placeholderTextColor={palette.faint}
                  returnKeyType={definition.dataType === 'longtext' ? 'default' : 'done'}
                  ref={inputRef}
                  style={[styles.input, definition.dataType === 'longtext' && styles.longInput]}
                  submitBehavior={definition.dataType === 'longtext' ? 'newline' : 'blurAndSubmit'}
                  value={text}
                />
              </View>
            )}
      </ScrollView>

      {!!error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}

      <View style={styles.actions}>
        {!!onRemove && (
          <Pressable
            disabled={saving}
            haptic="warning"
            onPress={remove}
            style={styles.removeButton}>
            <Trash2 color={palette.danger} size={17} />
            <Text style={styles.removeText}>Remove</Text>
          </Pressable>
        )}
        <Pressable
          disabled={saving}
          haptic="none"
          onPress={save}
          style={styles.saveButton}>
          {saving ? <ActivityIndicator color={palette.ink} /> : <Check color={palette.ink} size={19} />}
          <Text style={styles.saveText}>Save field</Text>
        </Pressable>
      </View>
    </KeyboardSheet>
  );
}

const styles = StyleSheet.create({
  scroll: { flexShrink: 1 },
  body: { paddingTop: 16, paddingBottom: 8 },
  booleanRow: { minHeight: 76, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, borderRadius: radii.md, backgroundColor: palette.paper },
  booleanTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 15, fontWeight: '800' },
  booleanCopy: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, marginTop: 3 },
  inputWrap: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 15, borderRadius: radii.md, backgroundColor: palette.paper, borderWidth: 1, borderColor: palette.line },
  inputWrapFocused: { borderColor: palette.ink, borderWidth: 2 },
  input: { flex: 1, color: palette.ink, fontFamily: fonts.sans, fontSize: 15, paddingVertical: 14 },
  longInput: { minHeight: 128, textAlignVertical: 'top' },
  search: { height: 50, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, borderRadius: radii.md, backgroundColor: palette.paper, borderWidth: 1, borderColor: palette.line },
  searchInput: { flex: 1, color: palette.ink, fontFamily: fonts.sans, fontSize: 15 },
  options: { gap: 7, marginTop: 10 },
  option: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 9, borderRadius: radii.md, backgroundColor: palette.paper },
  optionSelected: { backgroundColor: palette.lime },
  optionCopy: { flex: 1 },
  optionLabel: { flex: 1, color: palette.ink, fontFamily: fonts.sans, fontSize: 13, fontWeight: '800' },
  optionMeta: { color: palette.muted, fontFamily: fonts.sans, fontSize: 10, marginTop: 2 },
  error: { color: palette.danger, fontFamily: fonts.sans, fontSize: 11, fontWeight: '700', lineHeight: 16, marginTop: 9, paddingHorizontal: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 12, paddingTop: 10, paddingBottom: 8, borderTopWidth: 1, borderColor: palette.line },
  removeButton: { height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingHorizontal: 16, borderRadius: radii.md, backgroundColor: '#F7E8E5' },
  removeText: { color: palette.danger, fontFamily: fonts.sans, fontSize: 12, fontWeight: '800' },
  saveButton: { flex: 1, height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radii.md, backgroundColor: palette.lime },
  saveText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 13, fontWeight: '900' },
});
