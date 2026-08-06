import { Check } from 'lucide-react-native';
import { useRef } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { KeyboardSheet, KeyboardSheetHandle } from '@/components/keyboard-sheet';
import { MotionPressable as Pressable, hapticFeedback } from '@/components/motion';
import { createThemedStyleSheet, fonts, palette, radii } from '@/constants/theme';
import { useI18n } from '@/context/ui-preferences-context';
import type { TranslationKey } from '@/i18n/catalogs';
import { LibrarySortOrder } from '@/types/document';

const sortOptions: { id: LibrarySortOrder; label: TranslationKey; detail: TranslationKey }[] = [
  { id: 'added-desc', label: 'sort.addedDesc', detail: 'sort.addedDescDetail' },
  { id: 'added-asc', label: 'sort.addedAsc', detail: 'sort.addedAscDetail' },
  { id: 'created-desc', label: 'sort.createdDesc', detail: 'sort.createdDescDetail' },
  { id: 'created-asc', label: 'sort.createdAsc', detail: 'sort.createdAscDetail' },
  { id: 'title-asc', label: 'sort.titleAsc', detail: 'sort.titleAscDetail' },
  { id: 'title-desc', label: 'sort.titleDesc', detail: 'sort.titleDescDetail' },
  { id: 'correspondent-asc', label: 'sort.correspondent', detail: 'sort.correspondentDetail' },
  { id: 'document-type-asc', label: 'sort.documentType', detail: 'sort.documentTypeDetail' },
];

export function LibrarySortSheet({
  onClose,
  onSelect,
  sortOrder,
  visible,
}: {
  onClose: () => void;
  onSelect: (sortOrder: LibrarySortOrder) => void;
  sortOrder: LibrarySortOrder;
  visible: boolean;
}) {
  const sheetRef = useRef<KeyboardSheetHandle>(null);
  const { t } = useI18n();

  return (
    <KeyboardSheet
      accessibilityLabel={t('sort.accessibility')}
      maxHeight="86%"
      onDismiss={onClose}
      ref={sheetRef}
      subtitle={t('sort.subtitle')}
      title={t('sort.title')}
      visible={visible}>
      <ScrollView
        accessibilityRole="radiogroup"
        contentContainerStyle={styles.options}
        showsVerticalScrollIndicator={false}>
        {sortOptions.map((option) => {
          const active = option.id === sortOrder;
          return (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: active }}
              key={option.id}
              onPress={() => {
                onSelect(option.id);
                void hapticFeedback('selection');
                sheetRef.current?.close();
              }}
              style={[styles.option, active && styles.optionActive]}>
              <View style={styles.copy}>
                <Text style={styles.label}>{t(option.label)}</Text>
                <Text style={styles.detail}>{t(option.detail)}</Text>
              </View>
              {active && (
                <View style={styles.check}>
                  <Check color={palette.accentInk} size={17} />
                </View>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
    </KeyboardSheet>
  );
}

const styles = createThemedStyleSheet({
  options: { paddingTop: 16, paddingBottom: 8 },
  option: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 7,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: 'transparent',
    backgroundColor: palette.paper,
  },
  optionActive: { borderColor: palette.limeDark, backgroundColor: palette.mint },
  copy: { flex: 1, minWidth: 0 },
  label: { color: palette.ink, fontFamily: fonts.sans, fontSize: 13, fontWeight: '900' },
  detail: { marginTop: 3, color: palette.muted, fontFamily: fonts.sans, fontSize: 10 },
  check: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 11, backgroundColor: palette.lime },
});
