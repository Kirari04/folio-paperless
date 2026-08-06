import { StatusBar } from 'expo-status-bar';
import { FileStack, X } from 'lucide-react-native';
import { useState } from 'react';
import { Modal, ScrollView, Text, View } from 'react-native';

import { DocumentPdfMergeSelection } from '@/components/document-pdf-merge-selection';
import { MotionPressable as Pressable, useReducedMotion } from '@/components/motion';
import { createThemedStyleSheet, fonts, palette, radii } from '@/constants/theme';
import { useI18n } from '@/i18n';
import type { DocumentItem, PaperlessCredentials } from '@/types/document';
import type { PaperlessPdfPageOperation } from '@/types/paperless-advanced';

type DocumentPdfPageEditorProps = {
  busy: boolean;
  credentials: PaperlessCredentials;
  document: DocumentItem;
  documents: readonly DocumentItem[];
  editEnabled: boolean;
  editUnavailableDetail?: string;
  mergeEnabled: boolean;
  onApply: (plan: {
    operations: PaperlessPdfPageOperation[];
    hasSplits: boolean;
    removedPages: number;
  }) => void;
  onMerge: (documentIds: number[]) => void;
  splitEnabled: boolean;
};

export function DocumentPdfPageEditor({
  busy,
  credentials,
  document,
  documents,
  editUnavailableDetail,
  mergeEnabled,
  onMerge,
}: DocumentPdfPageEditorProps) {
  const { colorScheme, t } = useI18n();
  const reducedMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} style={styles.openButton}>
        <FileStack color={palette.accentInk} size={18} />
        <Text style={styles.openButtonText}>{t('paperless3.pageEditorOpen')}</Text>
      </Pressable>
      <Modal
        animationType={reducedMotion ? 'none' : 'fade'}
        onRequestClose={() => setOpen(false)}
        presentationStyle="fullScreen"
        visible={open}>
        <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
        <View style={styles.root}>
          <View style={styles.header}>
            <View style={styles.flexCopy}>
              <Text style={styles.title}>{t('paperless3.pageEditorTitle')}</Text>
              <Text numberOfLines={1} style={styles.subtitle}>{document.title}</Text>
            </View>
            <Pressable accessibilityLabel={t('paperless3.close')} onPress={() => setOpen(false)} style={styles.close}>
              <X color={palette.ink} size={20} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.unavailable}>
              <Text style={styles.unavailableTitle}>{t('paperless3.unavailable')}</Text>
              <Text style={styles.unavailableCopy}>
                {editUnavailableDetail || t('paperless3.pageEditorRendererUnavailable')}
              </Text>
            </View>
            <DocumentPdfMergeSelection
              busy={busy}
              credentials={credentials}
              currentDocument={document}
              documents={documents}
              enabled={mergeEnabled}
              onMerge={onMerge}
            />
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

const styles = createThemedStyleSheet({
  root: { flex: 1, backgroundColor: palette.canvas },
  header: { minHeight: 74, flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18, borderBottomWidth: 1, borderColor: palette.line },
  flexCopy: { flex: 1, minWidth: 0 },
  title: { color: palette.ink, fontFamily: fonts.serif, fontSize: 23, fontWeight: '600' },
  subtitle: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, marginTop: 3 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: palette.paper },
  content: { width: '100%', maxWidth: 860, alignSelf: 'center', padding: 20, paddingBottom: 60 },
  openButton: { minHeight: 48, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: radii.md, backgroundColor: palette.lime, paddingHorizontal: 17 },
  openButtonText: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 11, fontWeight: '900' },
  unavailable: { padding: 18, borderRadius: radii.md, backgroundColor: palette.paper },
  unavailableTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 13, fontWeight: '900' },
  unavailableCopy: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, lineHeight: 17, marginTop: 5 },
});
