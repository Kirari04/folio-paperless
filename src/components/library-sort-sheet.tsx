import { Check } from 'lucide-react-native';
import { useRef } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { KeyboardSheet, KeyboardSheetHandle } from '@/components/keyboard-sheet';
import { MotionPressable as Pressable, hapticFeedback } from '@/components/motion';
import { fonts, palette, radii } from '@/constants/theme';
import { librarySortLabels } from '@/lib/library-filters';
import { LibrarySortOrder } from '@/types/document';

const sortOptions: { id: LibrarySortOrder; detail: string }[] = [
  { id: 'added-desc', detail: 'Documents received most recently' },
  { id: 'added-asc', detail: 'Documents received first' },
  { id: 'created-desc', detail: 'Newest date printed on the document' },
  { id: 'created-asc', detail: 'Oldest date printed on the document' },
  { id: 'title-asc', detail: 'Alphabetical by title' },
  { id: 'title-desc', detail: 'Reverse alphabetical by title' },
  { id: 'correspondent-asc', detail: 'Alphabetical by sender' },
  { id: 'document-type-asc', detail: 'Group by Paperless document type' },
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

  return (
    <KeyboardSheet
      accessibilityLabel="Library sort order"
      maxHeight="86%"
      onDismiss={onClose}
      ref={sheetRef}
      subtitle="Choose exactly how documents are ordered."
      title="Sort library"
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
                <Text style={styles.label}>{librarySortLabels[option.id]}</Text>
                <Text style={styles.detail}>{option.detail}</Text>
              </View>
              {active && (
                <View style={styles.check}>
                  <Check color={palette.ink} size={17} />
                </View>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
    </KeyboardSheet>
  );
}

const styles = StyleSheet.create({
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
  optionActive: { borderColor: palette.limeDark, backgroundColor: '#F3FAD8' },
  copy: { flex: 1, minWidth: 0 },
  label: { color: palette.ink, fontFamily: fonts.sans, fontSize: 13, fontWeight: '900' },
  detail: { marginTop: 3, color: palette.muted, fontFamily: fonts.sans, fontSize: 10 },
  check: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 11, backgroundColor: palette.lime },
});
