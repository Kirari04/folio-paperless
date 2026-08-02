import { Bookmark, ChevronLeft, CircleAlert, Copy, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SavedViewEditorSheet, type SavedViewPresentationEdit } from '@/components/saved-view-editor-sheet';
import { MotionPressable as Pressable, hapticFeedback } from '@/components/motion';
import { fonts, maxContentWidth, palette, radii } from '@/constants/theme';
import { useApp } from '@/context/app-context';
import { useI18n } from '@/i18n';
import { presentRuntimeError, presentRuntimeMessage } from '@/i18n/error-presentation';
import { hasUnsupportedSavedViewRules } from '@/lib/saved-view-controller';
import { usePaperlessAdvanced } from '@/lib/use-paperless-advanced';
import { useLocalSearchParams, useRouter } from '@/lib/router';
import type { PaperlessSavedView } from '@/types/paperless-advanced';

type Editor = { mode: 'rename' | 'duplicate'; view: PaperlessSavedView } | null;

export default function SavedViewsRoute() {
  const { activeProfile } = useApp();
  return <SavedViewsScreen key={activeProfile?.id ?? 'no-profile'} />;
}

function SavedViewsScreen() {
  const router = useRouter();
  const { formatNumber, t } = useI18n();
  const { id: focusedViewId } = useLocalSearchParams<{ id?: string }>();
  const {
    activeProfile,
    catalog,
    connected,
    connectionError,
    profileConfigured,
    publishSavedView,
    publishSavedViewDeletion,
    refresh,
  } = useApp();
  const advanced = usePaperlessAdvanced();
  const advancedApi = advanced.phase === 'ready' ? advanced.api : null;
  const advancedError = advanced.phase === 'error' ? advanced.error : null;
  const [views, setViews] = useState<PaperlessSavedView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor>(null);
  const requestEpoch = useRef(0);

  const reload = useCallback(async () => {
    if (!advancedApi) return;
    const epoch = requestEpoch.current;
    setLoading(true);
    setError(null);
    try {
      const result = await advancedApi.listSavedViews();
      if (!result.supported) throw new Error(result.detail ?? t('savedViews.unavailableServer'));
      if (epoch !== requestEpoch.current) return;
      setViews(result.value.results);
    } catch (nextError) {
      if (epoch !== requestEpoch.current) return;
      setError(presentRuntimeError(nextError, t('savedViews.loadError')));
    } finally {
      if (epoch === requestEpoch.current) setLoading(false);
    }
  }, [advancedApi, t]);

  useEffect(() => () => {
    requestEpoch.current += 1;
  }, []);

  useEffect(() => {
    if (!advancedApi) return;
    const timer = setTimeout(() => void reload(), 0);
    return () => clearTimeout(timer);
  }, [advancedApi, reload]);

  const capabilities = advanced.phase === 'ready' ? advanced.capabilities.features.savedViews : null;
  const displayFieldOptions = useMemo(() => [
    { value: 'title', label: t('savedViewEditor.fieldTitle') },
    { value: 'created', label: t('savedViewEditor.fieldCreated') },
    { value: 'added', label: t('savedViewEditor.fieldAdded') },
    { value: 'tag', label: t('savedViewEditor.fieldTags') },
    { value: 'correspondent', label: t('savedViewEditor.fieldCorrespondent') },
    { value: 'documenttype', label: t('savedViewEditor.fieldDocumentType') },
    { value: 'storagepath', label: t('savedViewEditor.fieldStoragePath') },
    { value: 'note', label: t('savedViewEditor.fieldNotes') },
    { value: 'owner', label: t('savedViewEditor.fieldOwner') },
    { value: 'shared', label: t('savedViewEditor.fieldShared') },
    { value: 'asn', label: t('savedViewEditor.fieldAsn') },
    { value: 'pagecount', label: t('savedViewEditor.fieldPageCount') },
    ...catalog.customFields.flatMap((field) => field.remoteId === undefined ? [] : [{
      value: `custom_field_${field.remoteId}`,
      label: field.name,
    }]),
  ], [catalog.customFields, t]);
  async function renameOrDuplicate(name: string, presentation?: SavedViewPresentationEdit) {
    if (!editor || advanced.phase !== 'ready' || !activeProfile) return;
    const epoch = requestEpoch.current;
    const result = editor.mode === 'duplicate'
      ? await advanced.api.duplicateSavedView(editor.view, name, presentation)
      : await advanced.api.updateSavedView(editor.view, { name, ...presentation }, { unknownRulePolicy: 'preserve' });
    if (!result.supported) throw new Error(result.detail ?? t('savedViews.changeUnavailable'));
    if (epoch !== requestEpoch.current) return;
    await publishSavedView(activeProfile.id, result.value);
    if (epoch !== requestEpoch.current) return;
    setViews((current) => editor.mode === 'duplicate'
      ? [...current, result.value].sort((a, b) => a.name.localeCompare(b.name))
      : current.map((item) => item.id === result.value.id ? result.value : item));
    await refresh().catch((nextError: unknown) => {
      if (epoch === requestEpoch.current) {
        setError(presentRuntimeError(nextError, t('savedViews.loadError')));
      }
    });
    await hapticFeedback('confirm');
  }

  function confirmDelete(view: PaperlessSavedView) {
    const epoch = requestEpoch.current;
    Alert.alert(
      t('savedViews.deleteTitle', { name: view.name }),
      t('savedViews.deleteBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            if (advanced.phase !== 'ready' || epoch !== requestEpoch.current) return;
            setError(null);
            advanced.api.deleteSavedView(view.id)
              .then(async (result) => {
                if (!result.supported) throw new Error(result.detail ?? t('savedViews.deleteUnavailable'));
                if (epoch !== requestEpoch.current) return;
                if (!activeProfile) return;
                await publishSavedViewDeletion(activeProfile.id, result.value.deletedId);
                if (epoch !== requestEpoch.current) return;
                setViews((current) => current.filter((item) => item.id !== view.id));
                await refresh().catch((nextError: unknown) => {
                  if (epoch === requestEpoch.current) {
                    setError(presentRuntimeError(nextError, t('savedViews.loadError')));
                  }
                });
                await hapticFeedback('warning');
              })
              .catch((nextError: unknown) => {
                if (epoch !== requestEpoch.current) return;
                setError(presentRuntimeError(nextError, t('savedViews.deleteError')));
              });
          },
        },
      ],
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.root}>
      <View style={styles.header}>
        <Pressable accessibilityLabel={t('savedViews.back')} onPress={() => router.back()} style={styles.iconButton}>
          <ChevronLeft color={palette.ink} size={22} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>PAPERLESS</Text>
          <Text style={styles.title}>{t('savedViews.title')}</Text>
        </View>
        <Pressable accessibilityLabel={t('savedViews.refresh')} onPress={() => void reload()} style={styles.iconButton}>
          <RefreshCw color={palette.ink} size={18} />
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl onRefresh={() => void reload()} refreshing={loading} tintColor={palette.ink} />}>
        <View style={styles.intro}>
          <Bookmark color={palette.accentInk} size={24} />
          <Text style={styles.introTitle}>{t('savedViews.introTitle')}</Text>
          <Text style={styles.copy}>{t('savedViews.introCopy')}</Text>
        </View>
        {!!error && !!views.length && (
          <View accessibilityLiveRegion="assertive" style={styles.errorBanner}>
            <CircleAlert color={palette.danger} size={17} />
            <Text style={styles.errorBannerText}>{error}</Text>
          </View>
        )}
        {!profileConfigured ? (
          <StateCard icon={<CircleAlert color={palette.muted} size={25} />} title={t('savedViews.connect')} copy={t('savedViews.demoUnavailable')} />
        ) : !connected ? (
          <StateCard icon={<CircleAlert color={palette.danger} size={25} />} title={t('savedViews.unavailable')} copy={connectionError ?? t('appError.authMissing')} />
        ) : advanced.phase === 'loading' || loading ? (
          <StateCard icon={<ActivityIndicator color={palette.ink} />} title={t('savedViews.loading')} copy={t('savedViews.checking')} />
        ) : error && !views.length || advancedError ? (
          <StateCard icon={<CircleAlert color={palette.danger} size={25} />} title={t('savedViews.unavailable')} copy={error ?? presentRuntimeMessage(advancedError!)} />
        ) : !views.length ? (
          <StateCard icon={<Plus color={palette.ink} size={25} />} title={t('savedViews.empty')} copy={t('savedViews.emptyCopy')} />
        ) : views.map((view) => {
          const unknown = hasUnsupportedSavedViewRules(view.filterRules);
          const editable = view.userCanChange !== false && capabilities?.update.supported === true;
          return (
            <View key={view.id} style={[styles.card, focusedViewId === String(view.id) && styles.cardFocused]}>
              <View style={styles.cardTop}>
                <View style={styles.savedIcon}><Bookmark color={palette.ink} size={17} /></View>
                <View style={styles.cardCopy}>
                  <Text numberOfLines={2} style={styles.cardTitle}>{view.name}</Text>
                  <Text style={styles.meta}>{t('savedViews.meta', { count: formatNumber(view.filterRules.length), sort: view.sortField || t('savedViews.defaultSort') })}</Text>
                </View>
              </View>
              {unknown && (
                <View style={styles.ruleWarning}>
                  <CircleAlert color={palette.danger} size={15} />
                  <Text style={styles.ruleWarningText}>{t('savedViews.ruleWarning')}</Text>
                </View>
              )}
              {view.userCanChange === false && <Text style={styles.readOnly}>{t('savedViews.readOnly')}</Text>}
              <View style={styles.actions}>
                <SmallAction disabled={!editable} icon={<Pencil color={palette.ink} size={15} />} label={t('savedViews.edit')} onPress={() => setEditor({ mode: 'rename', view })} />
                <SmallAction disabled={capabilities?.create.supported !== true} icon={<Copy color={palette.ink} size={15} />} label={t('savedViews.duplicate')} onPress={() => setEditor({ mode: 'duplicate', view })} />
                <SmallAction danger disabled={view.userCanChange === false || capabilities?.delete.supported !== true} icon={<Trash2 color={palette.danger} size={15} />} label={t('common.delete')} onPress={() => confirmDelete(view)} />
              </View>
            </View>
          );
        })}
      </ScrollView>
      {!!editor && (
        <SavedViewEditorSheet
          initialName={editor.mode === 'duplicate' ? t('savedViews.copyName', { name: editor.view.name }) : editor.view.name}
          displayFieldOptions={displayFieldOptions}
          initialPresentation={{
            displayMode: editor.view.displayMode,
            pageSize: editor.view.pageSize,
            displayFields: editor.view.displayFields,
            ...(editor.view.showOnDashboard !== null
              ? { showOnDashboard: editor.view.showOnDashboard }
              : {}),
            ...(editor.view.showInSidebar !== null
              ? { showInSidebar: editor.view.showInSidebar }
              : {}),
          }}
          mode={editor.mode}
          onClose={() => setEditor(null)}
          onSave={renameOrDuplicate}
          presentationCapabilities={{
            displayMode: capabilities?.fields?.displayMode.supported === true,
            pageSize: capabilities?.fields?.pageSize.supported === true,
            displayFields: capabilities?.fields?.displayFields.supported === true,
            showOnDashboard: capabilities?.fields?.showOnDashboard.supported === true,
            showInSidebar: capabilities?.fields?.showInSidebar.supported === true,
          }}
          unsupportedRules={hasUnsupportedSavedViewRules(editor.view.filterRules)}
          visible
        />
      )}
    </SafeAreaView>
  );
}

function StateCard({ copy, icon, title }: { copy: string; icon: React.ReactNode; title: string }) {
  return <View style={styles.state}>{icon}<Text style={styles.stateTitle}>{title}</Text><Text style={styles.stateCopy}>{copy}</Text></View>;
}

function SmallAction({ danger, disabled, icon, label, onPress }: { danger?: boolean; disabled?: boolean; icon: React.ReactNode; label: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.action, disabled && styles.disabled]}>{icon}<Text style={[styles.actionText, danger && styles.dangerText]}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.canvas },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 12 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: palette.paper },
  headerCopy: { flex: 1 },
  eyebrow: { color: palette.muted, fontFamily: fonts.sans, fontSize: 9, fontWeight: '900', letterSpacing: 1 },
  title: { color: palette.ink, fontFamily: fonts.serif, fontSize: 29, fontWeight: '700' },
  content: { width: '100%', maxWidth: maxContentWidth, alignSelf: 'center', padding: 18, paddingBottom: 48, gap: 11 },
  intro: { alignItems: 'flex-start', padding: 18, borderRadius: radii.lg, backgroundColor: palette.lime },
  introTitle: { color: palette.accentInk, fontFamily: fonts.serif, fontSize: 23, fontWeight: '700', marginTop: 9 },
  copy: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, marginTop: 3 },
  errorBanner: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, padding: 12, borderRadius: radii.md, backgroundColor: palette.dangerSurface },
  errorBannerText: { flex: 1, color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 11, lineHeight: 16 },
  state: { alignItems: 'center', padding: 28, borderRadius: radii.lg, backgroundColor: palette.paper },
  stateTitle: { color: palette.ink, fontFamily: fonts.serif, fontSize: 21, fontWeight: '700', marginTop: 10 },
  stateCopy: { maxWidth: 340, color: palette.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 4 },
  card: { padding: 15, borderRadius: radii.lg, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.paper },
  cardFocused: { borderWidth: 2, borderColor: palette.limeDark, backgroundColor: palette.mint },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  savedIcon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: palette.mint },
  cardCopy: { flex: 1, minWidth: 0 },
  cardTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 14, fontWeight: '900' },
  meta: { color: palette.muted, fontFamily: fonts.sans, fontSize: 10, marginTop: 3 },
  ruleWarning: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, padding: 10, borderRadius: radii.sm, backgroundColor: palette.dangerSurface, marginTop: 11 },
  ruleWarningText: { flex: 1, color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 10, lineHeight: 15 },
  readOnly: { color: palette.muted, fontFamily: fonts.sans, fontSize: 10, fontWeight: '800', marginTop: 9 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 11 },
  action: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, borderRadius: radii.sm, backgroundColor: palette.paperStrong },
  actionText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900' },
  dangerText: { color: palette.danger },
  disabled: { opacity: 0.4 },
});
