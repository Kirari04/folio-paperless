import { ArrowLeft, RefreshCw, RotateCcw, Trash2 } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppShell } from '@/components/app-shell';
import { MotionPressable as Pressable, animateLayout, hapticFeedback } from '@/components/motion';
import { PaperThumbnail } from '@/components/paper-thumbnail';
import { fonts, maxContentWidth, palette, radii } from '@/constants/theme';
import { useApp } from '@/context/app-context';
import { useRouter } from '@/lib/router';
import { DocumentItem } from '@/types/document';

export default function TrashScreen() {
  const router = useRouter();
  const { connected, loadTrash, restoreTrash, emptyTrash } = useApp();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loadTrash();
      setDocuments(result.documents);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not load deleted documents.');
      await hapticFeedback('error');
    } finally {
      setLoading(false);
    }
  }, [loadTrash]);

  useEffect(() => {
    const timer = setTimeout(() => void reload(), 0);
    return () => clearTimeout(timer);
  }, [reload]);

  async function restore(document: DocumentItem) {
    setBusyId(document.id);
    setError(null);
    try {
      await restoreTrash([document.id]);
      animateLayout();
      setDocuments((current) => current.filter((item) => item.id !== document.id));
      await hapticFeedback('confirm');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Could not restore this document.');
      await hapticFeedback('error');
    } finally {
      setBusyId(null);
    }
  }

  function confirmEmpty(ids?: string[]) {
    const count = ids?.length || documents.length;
    Alert.alert(
      count === 1 ? 'Delete permanently?' : `Delete ${count} documents permanently?`,
      'Paperless will erase the selected files and their metadata. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete forever',
          style: 'destructive',
          onPress: () => {
            setBusyId(ids?.[0] || 'all');
            emptyTrash(ids)
              .then(async () => {
                animateLayout();
                setDocuments((current) => ids
                  ? current.filter((item) => !ids.includes(item.id))
                  : []);
                await hapticFeedback('warning');
              })
              .catch(async (nextError) => {
                setError(nextError instanceof Error ? nextError.message : 'Could not empty the trash.');
                await hapticFeedback('error');
              })
              .finally(() => setBusyId(null));
          },
        },
      ],
    );
  }

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top']} style={styles.safe}>
        <View style={styles.header}>
          <Pressable accessibilityLabel="Go back" onPress={() => router.back()} style={styles.headerButton}>
            <ArrowLeft color={palette.ink} size={21} />
          </Pressable>
          <Text style={styles.headerTitle}>Recently deleted</Text>
          <Pressable accessibilityLabel="Refresh trash" onPress={reload} style={styles.headerButton}>
            <RefreshCw color={palette.ink} size={19} />
          </Pressable>
        </View>
      </SafeAreaView>

      <AppShell contentStyle={styles.content} safeTop={false} showNav={false} showDemoBanner={false}>
        <View style={styles.intro}>
          <Text style={styles.title}>Trash</Text>
          <Text style={styles.copy}>
            Restore something you still need, or permanently erase it from Paperless.
          </Text>
        </View>

        {!connected ? (
          <View style={styles.empty}>
            <Trash2 color={palette.ink} size={28} />
            <Text style={styles.emptyTitle}>Trash needs a server</Text>
            <Text style={styles.emptyCopy}>Connect Paperless in Settings to see deleted documents.</Text>
          </View>
        ) : loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={palette.ink} />
            <Text style={styles.loadingText}>Checking recently deleted documents…</Text>
          </View>
        ) : documents.length ? (
          <>
            <View style={styles.summary}>
              <Text style={styles.summaryText}>{documents.length} deleted {documents.length === 1 ? 'document' : 'documents'}</Text>
              <Pressable haptic="warning" onPress={() => confirmEmpty()}>
                <Text style={styles.emptyAll}>Empty trash</Text>
              </Pressable>
            </View>
            <View style={styles.list}>
              {documents.map((document) => (
                <View key={document.id} style={styles.documentRow}>
                  <PaperThumbnail document={document} width={58} />
                  <View style={styles.documentCopy}>
                    <Text numberOfLines={2} style={styles.documentTitle}>{document.title}</Text>
                    <Text numberOfLines={1} style={styles.documentMeta}>
                      {document.correspondent} · {document.deletedAt
                        ? new Date(document.deletedAt).toLocaleDateString()
                        : 'Recently deleted'}
                    </Text>
                    <View style={styles.actions}>
                      <Pressable
                        disabled={busyId === document.id}
                        haptic="confirm"
                        onPress={() => restore(document)}
                        style={styles.restoreButton}>
                        {busyId === document.id
                          ? <ActivityIndicator color={palette.ink} size="small" />
                          : <RotateCcw color={palette.ink} size={15} />}
                        <Text style={styles.restoreText}>Restore</Text>
                      </Pressable>
                      <Pressable
                        haptic="warning"
                        onPress={() => confirmEmpty([document.id])}
                        style={styles.eraseButton}>
                        <Trash2 color={palette.danger} size={15} />
                        <Text style={styles.eraseText}>Erase</Text>
                      </Pressable>
                    </View>
                  </View>
                </View>
              ))}
            </View>
          </>
        ) : (
          <View style={styles.empty}>
            <Trash2 color={palette.ink} size={28} />
            <Text style={styles.emptyTitle}>Nothing to recover</Text>
            <Text style={styles.emptyCopy}>Deleted documents will appear here before Paperless removes them.</Text>
          </View>
        )}

        {!!error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
      </AppShell>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.canvas },
  safe: { backgroundColor: palette.canvas },
  header: { width: '100%', maxWidth: maxContentWidth, alignSelf: 'center', height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20 },
  headerButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.paper, borderWidth: 1, borderColor: palette.line },
  headerTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 13, fontWeight: '800' },
  content: { paddingTop: 14 },
  intro: { marginBottom: 22 },
  title: { color: palette.ink, fontFamily: fonts.serif, fontSize: 36, fontWeight: '600', letterSpacing: -0.8 },
  copy: { maxWidth: 380, color: palette.muted, fontFamily: fonts.sans, fontSize: 13, lineHeight: 20, marginTop: 6 },
  summary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 11 },
  summaryText: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, fontWeight: '700' },
  emptyAll: { color: palette.danger, fontFamily: fonts.sans, fontSize: 11, fontWeight: '900' },
  list: { gap: 9 },
  documentRow: { flexDirection: 'row', gap: 13, padding: 13, borderRadius: radii.lg, backgroundColor: palette.paper },
  documentCopy: { flex: 1, minWidth: 0 },
  documentTitle: { color: palette.ink, fontFamily: fonts.serif, fontSize: 17, lineHeight: 21, fontWeight: '600' },
  documentMeta: { color: palette.muted, fontFamily: fonts.sans, fontSize: 10, marginTop: 4 },
  actions: { flexDirection: 'row', gap: 7, marginTop: 11 },
  restoreButton: { height: 34, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, borderRadius: radii.sm, backgroundColor: palette.lime },
  restoreText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900' },
  eraseButton: { height: 34, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, borderRadius: radii.sm, backgroundColor: '#F7E8E5' },
  eraseText: { color: palette.danger, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900' },
  empty: { alignItems: 'center', paddingHorizontal: 30, paddingVertical: 52, borderRadius: radii.lg, backgroundColor: palette.paper },
  emptyTitle: { color: palette.ink, fontFamily: fonts.serif, fontSize: 23, fontWeight: '600', marginTop: 13 },
  emptyCopy: { maxWidth: 300, color: palette.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 6 },
  loading: { alignItems: 'center', paddingVertical: 56 },
  loadingText: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, marginTop: 11 },
  error: { color: palette.danger, fontFamily: fonts.sans, fontSize: 11, lineHeight: 16, marginTop: 14 },
});
