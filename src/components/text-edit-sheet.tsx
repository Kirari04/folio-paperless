import { Check } from 'lucide-react-native';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardTypeOptions,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
} from 'react-native';

import { KeyboardSheet, KeyboardSheetHandle } from '@/components/keyboard-sheet';
import { MotionPressable as Pressable, hapticFeedback } from '@/components/motion';
import { fonts, palette, radii } from '@/constants/theme';
import { useI18n } from '@/context/ui-preferences-context';

type TextEditSheetProps = {
  autoCapitalize?: TextInputProps['autoCapitalize'];
  autoCorrect?: boolean;
  /** Stable profile/object/action identity. A change discards every retained editor state. */
  editorKey: string;
  helperText?: string;
  keyboardType?: KeyboardTypeOptions;
  label: string;
  maxLength?: number;
  multiline?: boolean;
  onClose: () => void;
  onSave: (value: string) => Promise<void> | void;
  placeholder?: string;
  required?: boolean;
  saveLabel?: string;
  subtitle?: string;
  title: string;
  validate?: (value: string) => string | null;
  value: string;
  visible: boolean;
};

export function TextEditSheet({
  editorKey,
  ...props
}: TextEditSheetProps) {
  return <TextEditSheetEditor key={editorKey} {...props} />;
}

function TextEditSheetEditor({
  autoCapitalize = 'sentences',
  autoCorrect = true,
  helperText,
  keyboardType = 'default',
  label,
  maxLength,
  multiline = false,
  onClose,
  onSave,
  placeholder,
  required = false,
  saveLabel,
  subtitle,
  title,
  validate,
  value,
  visible,
}: Omit<TextEditSheetProps, 'editorKey'>) {
  const { t } = useI18n();
  const sheetRef = useRef<KeyboardSheetHandle>(null);
  const inputRef = useRef<TextInput>(null);
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalized = draft.trim();
  const canSave = !saving && (!required || !!normalized) && draft !== value;

  async function save() {
    if (saving || draft === value) return;
    const validationError = required && !normalized
      ? t('editor.required', { label })
      : validate?.(draft) || null;
    if (validationError) {
      setError(validationError);
      await hapticFeedback('error');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      await hapticFeedback('confirm');
      sheetRef.current?.close();
    } catch (nextError) {
      setError(nextError instanceof Error
        ? nextError.message
        : t('editor.saveError', { label: label.toLocaleLowerCase() }));
      await hapticFeedback('error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <KeyboardSheet
      accessibilityLabel={t('editor.accessibility', { title })}
      maxHeight={multiline ? '82%' : '72%'}
      onDismiss={onClose}
      onOpened={() => inputRef.current?.focus()}
      ref={sheetRef}
      subtitle={subtitle}
      title={title}
      visible={visible}>
      <View style={styles.body}>
        <Text style={styles.label}>{label.toLocaleUpperCase()}</Text>
        <View style={[styles.inputWrap, focused && styles.inputWrapFocused, !!error && styles.inputWrapError]}>
          <TextInput
            accessibilityLabel={label}
            autoCapitalize={autoCapitalize}
            autoCorrect={autoCorrect}
            keyboardType={keyboardType}
            maxLength={maxLength}
            multiline={multiline}
            onBlur={() => setFocused(false)}
            onChangeText={(next) => {
              setDraft(next);
              if (error) setError(null);
            }}
            onFocus={() => setFocused(true)}
            onSubmitEditing={multiline ? undefined : save}
            placeholder={placeholder}
            placeholderTextColor={palette.faint}
            returnKeyType={multiline ? 'default' : 'done'}
            ref={inputRef}
            selectTextOnFocus={!multiline}
            style={[styles.input, multiline && styles.inputMultiline]}
            submitBehavior={multiline ? 'newline' : 'blurAndSubmit'}
            value={draft}
          />
        </View>
        {!!helperText && <Text style={styles.helper}>{helperText}</Text>}
        {!!error && (
          <View accessibilityLiveRegion="polite" style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
      </View>

      <View style={styles.footer}>
        <Pressable haptic="light" onPress={() => sheetRef.current?.close()} style={styles.cancelButton}>
          <Text style={styles.cancelText}>{t('common.cancel')}</Text>
        </Pressable>
        <Pressable
          disabled={!canSave}
          haptic="none"
          onPress={save}
          style={[styles.saveButton, !canSave && styles.disabled]}>
          {saving ? <ActivityIndicator color={palette.accentInk} /> : <Check color={palette.accentInk} size={18} />}
          <Text style={styles.saveText}>{saveLabel || t('editor.saveChanges')}</Text>
        </Pressable>
      </View>
    </KeyboardSheet>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingTop: 18,
  },
  label: {
    marginBottom: 8,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  inputWrap: {
    minHeight: 58,
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: radii.md,
    backgroundColor: palette.paper,
  },
  inputWrapFocused: {
    borderColor: palette.ink,
    borderWidth: 2,
  },
  inputWrapError: {
    borderColor: palette.danger,
  },
  input: {
    minHeight: 56,
    paddingHorizontal: 15,
    paddingVertical: 13,
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 16,
  },
  inputMultiline: {
    minHeight: 142,
    maxHeight: 220,
    textAlignVertical: 'top',
  },
  helper: {
    marginTop: 8,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 16,
  },
  errorBox: {
    marginTop: 11,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radii.sm,
    backgroundColor: palette.dangerSurface,
  },
  errorText: {
    color: palette.danger,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 17,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingTop: 16,
    paddingBottom: 8,
  },
  cancelButton: {
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
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
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radii.md,
    backgroundColor: palette.lime,
  },
  saveText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '900',
  },
  disabled: {
    opacity: 0.42,
  },
});
