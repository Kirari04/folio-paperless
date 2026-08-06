import { ArrowLeft, RefreshCw, RotateCcw, Trash2 } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppShell } from '@/components/app-shell';
import { MotionPressable as Pressable, animateLayout, hapticFeedback } from '@/components/motion';
import { PaperThumbnail } from '@/components/paper-thumbnail';
import { createThemedStyleSheet, fonts, maxContentWidth, palette, radii } from '@/constants/theme';
import { useApp } from '@/context/app-context';
import { useI18n } from '@/context/ui-preferences-context';
import { presentRuntimeError } from '@/i18n/error-presentation';
import { useRouter } from '@/lib/router';
import { DocumentItem } from '@/types/document';

export default function TrashScreen() {
  const { activeProfile, credentials } = useApp();
  return <TrashContent key={activeProfile?.id ?? credentials?.profileId ?? 'no-profile'} />;
}

function TrashContent() {
  const router = useRouter();
  const { t, formatDate, formatNumber } = useI18n();
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
      setError(presentRuntimeError(nextError, t('trash.loadError')));
      await hapticFeedback('error');
    } finally {
      setLoading(false);
    }
  }, [loadTrash, t]);

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
      setError(presentRuntimeError(nextError, t('trash.restoreError')));
      await hapticFeedback('error');
    } finally {
      setBusyId(null);
    }
  }

  function confirmEmpty(ids?: string[]) {
    const count = ids?.length || documents.length;
    Alert.alert(
      count === 1 ? t('trash.deleteOneTitle') : t('trash.deleteManyTitle', { count: formatNumber(count) }),
      t('trash.deleteBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('trash.deleteForever'),
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
                setError(presentRuntimeError(nextError, t('trash.emptyError')));
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
          <Pressable accessibilityLabel={t('trash.goBack')} onPress={() => router.back()} style={styles.headerButton}>
            <ArrowLeft color={palette.ink} size={21} />
          </Pressable>
          <Text style={styles.headerTitle}>{t('trash.recentlyDeleted')}</Text>
          <Pressable accessibilityLabel={t('trash.refresh')} onPress={reload} style={styles.headerButton}>
            <RefreshCw color={palette.ink} size={19} />
          </Pressable>
        </View>
      </SafeAreaView>

      <AppShell contentStyle={styles.content} safeTop={false} showNav={false} showDemoBanner={false}>
        <View style={styles.intro}>
          <Text style={styles.title}>{t('trash.title')}</Text>
          <Text style={styles.copy}>
            {t('trash.intro')}
          </Text>
        </View>

        {!connected ? (
          <View style={styles.empty}>
            <Trash2 color={palette.ink} size={28} />
            <Text style={styles.emptyTitle}>{t('trash.needsServer')}</Text>
            <Text style={styles.emptyCopy}>{t('trash.connectServer')}</Text>
          </View>
        ) : loading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={palette.ink} />
            <Text style={styles.loadingText}>{t('trash.checking')}</Text>
          </View>
        ) : documents.length ? (
          <>
            <View style={styles.summary}>
              <Text style={styles.summaryText}>
                {documents.length === 1
                  ? t('trash.summaryOne')
                  : t('trash.summaryMany', { count: formatNumber(documents.length) })}
              </Text>
              <Pressable haptic="warning" onPress={() => confirmEmpty()}>
                <Text style={styles.emptyAll}>{t('trash.empty')}</Text>
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
                        ? formatDate(document.deletedAt)
                        : t('trash.recentlyDeleted')}
                    </Text>
                    <View style={styles.actions}>
                      <Pressable
                        disabled={busyId === document.id}
                        haptic="confirm"
                        onPress={() => restore(document)}
                        style={styles.restoreButton}>
                        {busyId === document.id
                          ? <ActivityIndicator color={palette.accentInk} size="small" />
                          : <RotateCcw color={palette.accentInk} size={15} />}
                        <Text style={styles.restoreText}>{t('trash.restore')}</Text>
                      </Pressable>
                      <Pressable
                        haptic="warning"
                        onPress={() => confirmEmpty([document.id])}
                        style={styles.eraseButton}>
                        <Trash2 color={palette.danger} size={15} />
                        <Text style={styles.eraseText}>{t('trash.erase')}</Text>
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
            <Text style={styles.emptyTitle}>{t('trash.nothing')}</Text>
            <Text style={styles.emptyCopy}>{t('trash.nothingCopy')}</Text>
          </View>
        )}

        {!!error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
      </AppShell>
    </View>
  );
}

const styles = createThemedStyleSheet({
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
  restoreText: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900' },
  eraseButton: { height: 34, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, borderRadius: radii.sm, backgroundColor: palette.rose },
  eraseText: { color: palette.danger, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900' },
  empty: { alignItems: 'center', paddingHorizontal: 30, paddingVertical: 52, borderRadius: radii.lg, backgroundColor: palette.paper },
  emptyTitle: { color: palette.ink, fontFamily: fonts.serif, fontSize: 23, fontWeight: '600', marginTop: 13 },
  emptyCopy: { maxWidth: 300, color: palette.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 6 },
  loading: { alignItems: 'center', paddingVertical: 56 },
  loadingText: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, marginTop: 11 },
  error: { color: palette.danger, fontFamily: fonts.sans, fontSize: 11, lineHeight: 16, marginTop: 14 },
});
