import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  ScrollView,
  Share,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  ClipboardCopy,
  Download,
  Eye,
  History,
  Link2,
  Printer,
  Share2,
  ShieldAlert,
  Trash2,
  WifiOff,
  X,
} from 'lucide-react-native';

import { MotionPressable as Pressable, useReducedMotion } from '@/components/motion';
import { createThemedStyleSheet, fonts, palette, radii, shadows } from '@/constants/theme';
import { useApp } from '@/context/app-context';
import { useI18n } from '@/i18n';
import { presentRuntimeError, presentRuntimeMessage } from '@/i18n/error-presentation';
import {
  buildPublicShareUrl,
  chooseRepresentation,
  loadRepresentationPreference,
  representationSupportsNativePrint,
  saveRepresentationPreference,
  selectRepresentation,
} from '@/lib/document-production';
import { documentFileActionContentState } from '@/lib/document-file-action-state';
import {
  copyPublicShareUrl,
  DocumentPlatformActionError,
  prepareExistingRepresentationFile,
  prepareRepresentationFile,
  printPreparedRepresentation,
  sharePreparedRepresentation,
} from '@/lib/document-platform-actions';
import { normalizeServerUrl } from '@/lib/paperless';
import { createPlatformStringStore } from '@/lib/platform-storage';
import { resolveCachedPreviewSource } from '@/lib/offline-preview-policy';
import { usePaperlessAdvanced } from '@/lib/use-paperless-advanced';
import type { DocumentItem, PaperlessCredentials } from '@/types/document';
import type {
  PaperlessDocumentRepresentations,
  PaperlessRepresentation,
  PaperlessShareLink,
  PaperlessShareLinkExpiry,
} from '@/types/paperless-advanced';
import type { OfflineFileRecord } from '@/types/persistence';

export type DocumentFileActionIntent = 'share' | 'save' | 'manage';

export type RepresentationPreviewRequest = {
  checksum: string | null;
  representation: PaperlessRepresentation;
  size: number | null;
  uri: string;
  filename: string | null;
  mimeType: string | null;
  offline: boolean;
};

type DocumentFileActionsProps = {
  credentials: PaperlessCredentials;
  document: DocumentItem;
  intent: DocumentFileActionIntent;
  onClose: () => void;
  onOpenPreview: (request: RepresentationPreviewRequest) => void;
  onToast: (message: string, error?: boolean) => void;
  versionId?: number;
  visible: boolean;
};

const representationPreferenceStore = createPlatformStringStore();

function expiryKey(expiry: PaperlessShareLinkExpiry) {
  return expiry.kind === 'days' ? `${expiry.days}-days` : expiry.kind;
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof DocumentPlatformActionError) return presentRuntimeMessage(error.message);
  return presentRuntimeError(error, fallback);
}

export function DocumentFileActions({
  credentials,
  document,
  intent,
  onClose,
  onOpenPreview,
  onToast,
  versionId,
  visible,
}: DocumentFileActionsProps) {
  const reducedMotion = useReducedMotion();
  const { formatDate, formatFileSize, formatNumber, t } = useI18n();
  const expiryChoices: { label: string; value: PaperlessShareLinkExpiry }[] = [
    { label: t('fileActions.never'), value: { kind: 'never' } },
    { label: t('fileActions.oneDay'), value: { kind: 'days', days: 1 } },
    { label: t('fileActions.sevenDays'), value: { kind: 'days', days: 7 } },
    { label: t('fileActions.thirtyDays'), value: { kind: 'days', days: 30 } },
    { label: t('fileActions.custom'), value: { kind: 'custom', at: '' } },
  ];
  const advanced = usePaperlessAdvanced();
  const {
    activeProfile,
    online,
    pinDocumentOffline,
    removeOfflineDocument,
    resolveOfflineDocument,
  } = useApp();
  const requestController = useRef<AbortController | null>(null);
  const [representations, setRepresentations] = useState<PaperlessDocumentRepresentations | null>(null);
  const [selected, setSelected] = useState<PaperlessRepresentation>('archive');
  const [links, setLinks] = useState<PaperlessShareLink[]>([]);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [expiry, setExpiry] = useState<PaperlessShareLinkExpiry>({ kind: 'days', days: 7 });
  const [customExpiry, setCustomExpiry] = useState('');
  const offlineScopeKey = `${activeProfile?.id ?? credentials.profileId ?? 'no-profile'}:${document.id}:${versionId ?? 'current'}`;
  const [offlineFileState, setOfflineFileState] = useState<{
    files: Partial<Record<PaperlessRepresentation, OfflineFileRecord>>;
    scopeKey: string;
  } | null>(null);
  const offlineFiles = offlineFileState?.scopeKey === offlineScopeKey ? offlineFileState.files : {};
  const offlineFilesResolved = offlineFileState?.scopeKey === offlineScopeKey;

  const selectedChoice = useMemo(
    () => representations ? chooseRepresentation(representations, selected) : null,
    [representations, selected],
  );
  const printSupported = selectedChoice
    ? representationSupportsNativePrint(selectedChoice.info, Platform.OS)
    : false;
  const shareCapabilities = advanced.phase === 'ready' ? advanced.capabilities.features.shareLinks : null;
  const advancedApi = advanced.phase === 'ready' ? advanced.api : null;
  const advancedCapabilities = advanced.phase === 'ready' ? advanced.capabilities : null;
  const actionPrompt = intent === 'share'
    ? t('fileActions.sharePrompt')
    : intent === 'save'
      ? t('fileActions.savePrompt')
      : t('fileActions.managePrompt');
  const offlineFile = versionId ? null : offlineFiles[selected] ?? null;
  const contentState = documentFileActionContentState({
    capabilityLoading: advanced.phase === 'loading',
    loading,
    offline: online === false && !versionId,
    offlineFilesResolved,
    hasRepresentations: !!representations,
    hasSelectedChoice: !!selectedChoice,
    hasLoadError: !!loadError && !representations,
  });

  const refreshData = useCallback(async () => {
    if (!advancedApi || !advancedCapabilities || !document.remoteId) return;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setLoading(true);
    setLoadError(null);
    setLinksError(null);
    try {
      const [result, preference] = await Promise.all([
        advancedApi.getRepresentations(document.remoteId, controller.signal, versionId),
        loadRepresentationPreference(representationPreferenceStore),
      ]);
      if (!result.supported) throw new Error(result.detail ?? t('fileActions.metadataUnavailable'));
      const initial = chooseRepresentation(result.value, preference ?? undefined);
      if (!initial) throw new Error(t('fileActions.noRepresentation'));
      setRepresentations(result.value);
      setSelected(initial.selected);
      if (!versionId && advancedCapabilities.features.shareLinks.list.supported) {
        try {
          const linkResult = await advancedApi.listShareLinks(document.remoteId, controller.signal);
          if (linkResult.supported) setLinks(linkResult.value);
          else setLinksError(linkResult.detail ?? t('fileActions.noLinkAccess'));
        } catch (error) {
          if (!controller.signal.aborted) {
            setLinks([]);
            setLinksError(errorMessage(error, t('fileActions.noLinkAccess')));
          }
        }
      } else {
        setLinks([]);
      }
    } catch (error) {
      if (!controller.signal.aborted) setLoadError(errorMessage(error, t('fileActions.actionFailed')));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [advancedApi, advancedCapabilities, document.remoteId, t, versionId]);

  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => void refreshData());
    return () => {
      cancelAnimationFrame(frame);
      requestController.current?.abort();
    };
  }, [refreshData, visible]);

  useEffect(() => {
    const remoteId = document.remoteId;
    if (!visible) return;
    if (!remoteId || versionId) return;
    let mounted = true;
    const expectedProfileId = activeProfile?.id ?? credentials.profileId ?? null;
    void Promise.allSettled([
      resolveOfflineDocument(document.id, 'archive'),
      resolveOfflineDocument(document.id, 'original'),
      loadRepresentationPreference(representationPreferenceStore),
    ]).then(([archiveResult, originalResult, preferenceResult]) => {
      if (!mounted) return;
      const archive = archiveResult.status === 'fulfilled'
        && archiveResult.value?.profileId === expectedProfileId
        ? archiveResult.value
        : null;
      const original = originalResult.status === 'fulfilled'
        && originalResult.value?.profileId === expectedProfileId
        ? originalResult.value
        : null;
      const preference = preferenceResult.status === 'fulfilled' ? preferenceResult.value : null;
      setOfflineFileState({
        files: { ...(archive ? { archive } : {}), ...(original ? { original } : {}) },
        scopeKey: offlineScopeKey,
      });
      if ((!advancedApi || online === false) && (archive || original)) {
        const localRepresentations: PaperlessDocumentRepresentations = {
          documentId: remoteId,
          archive: {
            representation: 'archive',
            available: !!archive,
            filename: archive ? archive.fileName ?? `${document.title || `document-${remoteId}`}.pdf` : null,
            mimeType: archive ? archive.mimeType ?? 'application/pdf' : null,
            size: archive?.byteSize ?? null,
            checksum: null,
          },
          original: {
            representation: 'original',
            available: !!original,
            filename: original ? original.fileName ?? document.originalFileName ?? `${document.title || `document-${remoteId}`}-original` : null,
            mimeType: original ? original.mimeType ?? document.mimeType ?? null : null,
            size: original?.byteSize ?? null,
            checksum: null,
          },
        };
        setRepresentations(localRepresentations);
        const initial = chooseRepresentation(localRepresentations, preference ?? undefined);
        if (initial) setSelected(initial.selected);
      }
    });
    return () => {
      mounted = false;
    };
  }, [
    advancedApi,
    activeProfile?.id,
    credentials.profileId,
    document.id,
    document.mimeType,
    document.originalFileName,
    document.remoteId,
    document.title,
    resolveOfflineDocument,
    online,
    offlineScopeKey,
    versionId,
    visible,
  ]);

  async function prepareAndRun(action: 'print' | 'share' | 'save') {
    if (!representations || !document.remoteId || busy) return;
    setBusy(action);
    setProgress(null);
    const controller = new AbortController();
    requestController.current = controller;
    let prepared: Awaited<ReturnType<typeof prepareRepresentationFile>> | null = null;
    let cleanupDelayMs = 0;
    try {
      if (offlineFile) {
        prepared = prepareExistingRepresentationFile({
          byteSize: offlineFile.byteSize,
          documentId: document.remoteId,
          info: selectRepresentation(representations, selected).info,
          profileId: credentials.profileId ?? advancedApi?.client.profileId ?? '',
          representation: selected,
          title: document.title,
          uri: offlineFile.uri,
        });
      } else {
        if (online === false) throw new Error(t('fileActions.notOffline'));
        if (!advancedApi) throw new Error(t('fileActions.reconnectDownload'));
        prepared = await prepareRepresentationFile({
          api: advancedApi,
          credentials,
          documentId: document.remoteId,
          title: document.title,
          representation: selected,
          representations,
          signal: controller.signal,
          onProgress: setProgress,
          versionId,
        });
      }
      if (action === 'print') {
        const printHandoff = await printPreparedRepresentation(prepared);
        cleanupDelayMs = printHandoff.cleanupDelayMs;
      }
      else await sharePreparedRepresentation(prepared);
      onToast(
        action === 'print'
          ? t('fileActions.printOpened', { representation: localizedRepresentation(selected) })
          : t(action === 'save' ? 'fileActions.exportOpened' : 'fileActions.shareOpened', { representation: localizedRepresentation(selected) }),
      );
    } catch (error) {
      onToast(errorMessage(error, t('fileActions.actionFailed')), true);
    } finally {
      prepared?.cleanup(cleanupDelayMs);
      setBusy(null);
      setProgress(null);
    }
  }

  function selectPreferredRepresentation(representation: PaperlessRepresentation) {
    if (!representations?.[representation].available) return;
    setSelected(representation);
    void saveRepresentationPreference(representationPreferenceStore, representation).catch(() => {
      // The explicit selection remains valid for this action even if the
      // non-sensitive convenience preference cannot be persisted.
    });
  }

  async function openPreview() {
    if (!document.remoteId) return;
    const representationInfo = representations?.[selected] ?? null;
    const cached = resolveCachedPreviewSource({
      documentId: document.id,
      expectedProfileId: credentials.profileId,
      file: offlineFile,
      filename: representationInfo?.filename ?? null,
      mimeType: representationInfo?.mimeType ?? (selected === 'archive' ? 'application/pdf' : null),
      representation: selected,
      versionId,
    });
    if (cached) {
      onOpenPreview({
        ...cached,
        checksum: representationInfo?.checksum ?? null,
        size: representationInfo?.size ?? null,
        offline: true,
      });
      onClose();
      return;
    }
    // Live capability discovery is needed only for a remote URL. A pinned
    // local file remains launchable during airplane-mode cold starts.
    if (advanced.phase !== 'ready' || !representations) return;
    const choice = selectRepresentation(representations, selected);
    if (online === false) {
      onToast(t('fileActions.downloadBeforeOffline', { representation: localizedRepresentation(selected) }), true);
      return;
    }
    const path = advanced.api.representationFilePath(representations, selected, 'preview', versionId);
    if (!path.supported) {
      onToast(path.detail ? presentRuntimeMessage(path.detail) : t('fileActions.previewUnavailable'), true);
      return;
    }
    onOpenPreview({
      checksum: choice.info.checksum,
      representation: selected,
      size: choice.info.size,
      uri: `${normalizeServerUrl(credentials.serverUrl)}${path.value}`,
      filename: choice.info.filename,
      mimeType: choice.info.mimeType,
      offline: false,
    });
    onClose();
  }

  async function toggleOffline() {
    if (versionId) {
      onToast(t('fileActions.historyOfflineBlocked'), true);
      return;
    }
    setBusy('offline');
    try {
      if (offlineFile) {
        await removeOfflineDocument(document.id, selected);
        setOfflineFileState((current) => {
          const next = current?.scopeKey === offlineScopeKey ? { ...current.files } : {};
          delete next[selected];
          return { files: next, scopeKey: offlineScopeKey };
        });
        onToast(t('fileActions.removedOffline', { representation: localizedRepresentation(selected) }));
      } else {
        if (online === false) throw new Error(t('fileActions.connectDownload'));
        const info = representations?.[selected];
        if (!info?.filename || !info.mimeType) throw new Error(t('fileActions.metadataUnavailable'));
        await pinDocumentOffline(document.id, selected, {
          fileName: info.filename,
          mimeType: info.mimeType,
        });
        const record = await resolveOfflineDocument(document.id, selected);
        setOfflineFileState((current) => ({
          files: {
            ...(current?.scopeKey === offlineScopeKey ? current.files : {}),
            ...(record ? { [selected]: record } : {}),
          },
          scopeKey: offlineScopeKey,
        }));
        onToast(t('fileActions.availableOffline', { representation: localizedRepresentation(selected) }));
      }
    } catch (error) {
      onToast(errorMessage(error, t('fileActions.actionFailed')), true);
    } finally {
      setBusy(null);
    }
  }

  async function createLink() {
    if (advanced.phase !== 'ready' || !representations || !document.remoteId) return;
    setBusy('create-link');
    try {
      const selectedExpiry = expiry.kind === 'custom'
        ? { kind: 'custom', at: customExpiry } as const
        : expiry;
      const result = await advanced.api.createShareLink({
        documentId: document.remoteId,
        representation: selected,
        representations,
        expiry: selectedExpiry,
      });
      if (!result.supported) throw new Error(result.detail ?? t('fileActions.linksUnsupported'));
      setLinks((current) => [result.value, ...current.filter((link) => link.id !== result.value.id)]);
      onToast(t('fileActions.linkCreated', { representation: localizedRepresentation(selected).toLocaleLowerCase() }));
    } catch (error) {
      onToast(errorMessage(error, t('fileActions.actionFailed')), true);
    } finally {
      setBusy(null);
    }
  }

  async function copyLink(link: PaperlessShareLink) {
    try {
      await copyPublicShareUrl(buildPublicShareUrl(credentials.serverUrl, link));
      onToast(t('fileActions.linkCopied'));
    } catch (error) {
      onToast(errorMessage(error, t('fileActions.actionFailed')), true);
    }
  }

  async function shareLink(link: PaperlessShareLink) {
    try {
      const url = buildPublicShareUrl(credentials.serverUrl, link);
      await Share.share({ message: url, url });
    } catch (error) {
      onToast(errorMessage(error, t('fileActions.actionFailed')), true);
    }
  }

  function confirmRevoke(link: PaperlessShareLink) {
    Alert.alert(
      t('fileActions.revokeTitle'),
      t('fileActions.revokeBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('fileActions.revoke'),
          style: 'destructive',
          onPress: () => {
            if (advanced.phase !== 'ready') return;
            setBusy(`revoke-${link.id}`);
            void advanced.api.revokeShareLink(link.id)
              .then((result) => {
                if (!result.supported) throw new Error(result.detail ?? t('fileActions.revokeUnsupported'));
                setLinks((current) => current.filter((item) => item.id !== link.id));
                onToast(t('fileActions.revoked'));
              })
              .catch((error) => onToast(errorMessage(error, t('fileActions.actionFailed')), true))
              .finally(() => setBusy(null));
          },
        },
      ],
    );
  }

  function localizedRepresentation(representation: PaperlessRepresentation) {
    return t(representation === 'archive' ? 'fileActions.archive' : 'fileActions.original');
  }

  return (
    <Modal
      animationType={reducedMotion ? 'none' : 'slide'}
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}>
      <View style={styles.root}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.title}>{t('fileActions.title')}</Text>
            <Text style={styles.subtitle}>{actionPrompt}</Text>
          </View>
          <Pressable accessibilityLabel={t('fileActions.close')} onPress={onClose} style={styles.close}>
            <X color={palette.ink} size={20} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {contentState === 'offline-unavailable' ? (
            <View accessibilityLiveRegion="polite" style={styles.centerState}>
              <WifiOff color={palette.danger} size={26} />
              <Text style={styles.stateTitle}>{t('fileActions.unavailable')}</Text>
              <Text style={styles.stateCopy}>{t('fileActions.offlineUnavailable')}</Text>
            </View>
          ) : contentState === 'loading' ? (
            <View accessibilityLiveRegion="polite" style={styles.centerState}>
              <ActivityIndicator color={palette.limeDark} />
              <Text style={styles.stateCopy}>{t('fileActions.loading')}</Text>
            </View>
          ) : contentState === 'unavailable' || !representations || !selectedChoice ? (
            <View style={styles.centerState}>
              <ShieldAlert color={palette.danger} size={26} />
              <Text style={styles.stateTitle}>{t('fileActions.unavailable')}</Text>
              <Text style={styles.stateCopy}>{loadError || (advanced.error ? presentRuntimeMessage(advanced.error) : t('fileActions.connect'))}</Text>
              <Pressable onPress={() => void refreshData()} style={styles.primaryButton}>
                <Text style={styles.primaryButtonText}>{t('common.retry')}</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <Text style={styles.sectionTitle}>{t('fileActions.representation')}</Text>
              {!!versionId && (
                <View style={styles.versionNotice}>
                  <History color={palette.inkSoft} size={17} />
                  <Text style={styles.versionNoticeText}>{t('fileActions.historicalVersion', { id: versionId })}</Text>
                </View>
              )}
              <View style={styles.representationList}>
                {(['archive', 'original'] as const).map((representation) => {
                  const info = representations[representation];
                  const active = selected === representation;
                  return (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ checked: active, disabled: !info.available }}
                      disabled={!info.available || !!busy}
                      key={representation}
                      onPress={() => selectPreferredRepresentation(representation)}
                      style={[styles.representation, active && styles.representationActive, !info.available && styles.disabled]}>
                      <View style={styles.radio}>{active && <View style={styles.radioDot} />}</View>
                      <View style={styles.representationCopy}>
                        <Text style={styles.representationTitle}>{localizedRepresentation(representation)}</Text>
                        <Text numberOfLines={2} style={styles.representationMeta}>
                          {info.available
                            ? t('fileActions.representationMeta', {
                                filename: info.filename || t('fileActions.filenameUnavailable'),
                                mime: info.mimeType || t('fileActions.mimeUnavailable'),
                                size: info.size === null ? t('common.notAvailable') : formatFileSize(info.size),
                              })
                            : t('fileActions.notProvided')}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>

              {online === false && !offlineFile && (
                <View style={styles.offlineWarning}>
                  <WifiOff color={palette.danger} size={17} />
                  <Text style={styles.offlineWarningText}>{t('fileActions.offlineUnavailable')}</Text>
                </View>
              )}

              <View style={styles.actionGrid}>
                <ActionButton disabled={!!busy || (online === false && !offlineFile)} icon={Eye} label={t('fileActions.preview')} onPress={() => void openPreview()} />
                <ActionButton disabled={!printSupported || !!busy || (online === false && !offlineFile)} icon={Printer} label={t('fileActions.print')} loading={busy === 'print'} onPress={() => void prepareAndRun('print')} />
                <ActionButton disabled={!!busy || (online === false && !offlineFile)} icon={Share2} label={t('fileActions.shareFile')} loading={busy === 'share'} onPress={() => void prepareAndRun('share')} />
                <ActionButton disabled={!!busy || (online === false && !offlineFile)} icon={Download} label={t('fileActions.exportSave')} loading={busy === 'save'} onPress={() => void prepareAndRun('save')} />
              </View>
              {!!busy && progress !== null && (
                <Text accessibilityLiveRegion="polite" style={styles.progress}>
                  {t('fileActions.downloading', { progress: formatNumber(Math.round(progress * 100)), representation: localizedRepresentation(selected) })}
                </Text>
              )}
              <Pressable disabled={!!busy || !!versionId || (online === false && !offlineFile)} onPress={() => void toggleOffline()} style={styles.offlineButton}>
                {busy === 'offline' ? <ActivityIndicator color={palette.ink} size="small" /> : offlineFile ? <Trash2 color={palette.ink} size={16} /> : <Download color={palette.ink} size={16} />}
                <Text style={styles.offlineButtonText}>{offlineFile ? t('fileActions.removeOffline') : t('fileActions.makeOffline')}</Text>
              </Pressable>

              <View style={styles.divider} />
              <Text style={styles.sectionTitle}>{t('fileActions.publicLinks')}</Text>
              {versionId ? (
                <Text style={styles.unavailableCopy}>{t('fileActions.historyLinks')}</Text>
              ) : !shareCapabilities?.create.supported && !shareCapabilities?.list.supported ? (
                <Text style={styles.unavailableCopy}>{advanced.phase === 'ready' ? t('fileActions.noLinkAccess') : t('fileActions.reconnectLinks')}</Text>
              ) : (
                <>
                  <View style={styles.bearerWarning}>
                    <ShieldAlert color={palette.danger} size={19} />
                    <Text style={styles.bearerWarningText}>{t('fileActions.bearerWarning', { representation: localizedRepresentation(selected).toLocaleLowerCase() })}</Text>
                  </View>
                  {shareCapabilities.create.supported && (
                    <>
                      <Text style={styles.fieldLabel}>{t('fileActions.expires')}</Text>
                      <View style={styles.expiryRow}>
                        {expiryChoices.map((choice) => (
                          <Pressable
                            key={choice.label}
                            onPress={() => setExpiry(choice.value)}
                            style={[styles.expiryChoice, expiryKey(expiry) === expiryKey(choice.value) && styles.expiryChoiceActive]}>
                            <Text style={[
                              styles.expiryText,
                              expiryKey(expiry) === expiryKey(choice.value) && styles.expiryTextActive,
                            ]}>{choice.label}</Text>
                          </Pressable>
                        ))}
                      </View>
                      {expiry.kind === 'custom' && (
                        <TextInput
                          autoCapitalize="none"
                          autoCorrect={false}
                          onChangeText={setCustomExpiry}
                          placeholder="2026-09-01T17:00:00+02:00"
                          placeholderTextColor={palette.faint}
                          style={styles.customExpiry}
                          value={customExpiry}
                        />
                      )}
                      <Pressable disabled={busy === 'create-link'} onPress={() => void createLink()} style={styles.createLinkButton}>
                        {busy === 'create-link' ? <ActivityIndicator color={palette.accentInk} size="small" /> : <Link2 color={palette.accentInk} size={17} />}
                        <Text style={styles.createLinkText}>{t('fileActions.createLink', { representation: localizedRepresentation(selected).toLocaleLowerCase() })}</Text>
                      </Pressable>
                    </>
                  )}

                  {shareCapabilities.list.supported && (
                    <View style={styles.linkList}>
                      {!!linksError && <Text style={styles.unavailableCopy}>{linksError}</Text>}
                      {!linksError && !links.length && <Text style={styles.unavailableCopy}>{t('fileActions.noLinks')}</Text>}
                      {links.map((link) => (
                        <View key={link.id} style={styles.linkRow}>
                          <View style={styles.linkCopy}>
                            <Text style={styles.linkTitle}>{link.fileVersion === 'archive' ? t('fileActions.archiveSearchable') : t('fileActions.originalUpload')}</Text>
                            <Text style={styles.linkMeta}>{link.expired ? t('fileActions.expired') : link.expiration ? t('fileActions.expiresAt', { date: formatDate(link.expiration, { dateStyle: 'medium', timeStyle: 'short' }) }) : t('fileActions.neverExpires')}</Text>
                          </View>
                          <Pressable accessibilityLabel={t('fileActions.copyLink')} disabled={link.expired} onPress={() => void copyLink(link)} style={styles.iconButton}>
                            <ClipboardCopy color={palette.ink} size={17} />
                          </Pressable>
                          <Pressable accessibilityLabel={t('fileActions.shareLink')} disabled={link.expired} onPress={() => void shareLink(link)} style={styles.iconButton}>
                            <Share2 color={palette.ink} size={17} />
                          </Pressable>
                          {shareCapabilities.delete.supported && (
                            <Pressable accessibilityLabel={t('fileActions.revokeLink')} onPress={() => confirmRevoke(link)} style={styles.iconButton}>
                              <Trash2 color={palette.danger} size={17} />
                            </Pressable>
                          )}
                        </View>
                      ))}
                    </View>
                  )}
                </>
              )}
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function ActionButton({ disabled, icon: Icon, label, loading, onPress }: { disabled?: boolean; icon: typeof Eye; label: string; loading?: boolean; onPress: () => void }) {
  return (
    <Pressable disabled={disabled || loading} onPress={onPress} style={[styles.actionButton, (disabled || loading) && styles.disabled]}>
      {loading ? <ActivityIndicator color={palette.ink} size="small" /> : <Icon color={palette.ink} size={19} />}
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

const styles = createThemedStyleSheet({
  root: { flex: 1, backgroundColor: palette.canvas },
  header: { minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 12, borderBottomWidth: 1, borderColor: palette.line },
  headerCopy: { flex: 1, minWidth: 0 },
  title: { color: palette.ink, fontFamily: fonts.serif, fontSize: 24, fontWeight: '600' },
  subtitle: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, lineHeight: 16, marginTop: 3 },
  close: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.paper },
  content: { width: '100%', maxWidth: 720, alignSelf: 'center', padding: 20, paddingBottom: 44 },
  centerState: { minHeight: 280, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  stateTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 17, fontWeight: '900', marginTop: 14 },
  stateCopy: { maxWidth: 380, color: palette.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 7 },
  primaryButton: { minHeight: 46, justifyContent: 'center', paddingHorizontal: 20, borderRadius: radii.sm, backgroundColor: palette.lime, marginTop: 18 },
  primaryButtonText: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 12, fontWeight: '900' },
  sectionTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 17, fontWeight: '900', marginBottom: 11 },
  representationList: { gap: 8 },
  representation: { minHeight: 74, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 13, borderRadius: radii.md, backgroundColor: palette.paper },
  representationActive: { backgroundColor: palette.mint },
  disabled: { opacity: 0.42 },
  radio: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: palette.ink },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: palette.ink },
  representationCopy: { flex: 1, minWidth: 0 },
  representationTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 13, fontWeight: '900' },
  representationMeta: { color: palette.muted, fontFamily: fonts.sans, fontSize: 10, lineHeight: 15, marginTop: 4 },
  actionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  actionButton: { minWidth: '47%', flexGrow: 1, minHeight: 54, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 12, borderRadius: radii.md, backgroundColor: palette.paper },
  actionText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 11, fontWeight: '800' },
  progress: { color: palette.limeDark, fontFamily: fonts.sans, fontSize: 11, fontWeight: '800', marginTop: 10 },
  offlineButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radii.md, backgroundColor: palette.paper, marginTop: 10 },
  offlineButtonText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 11, fontWeight: '800' },
  offlineWarning: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, padding: 12, borderRadius: radii.md, backgroundColor: palette.dangerSurface, marginTop: 12 },
  offlineWarningText: { flex: 1, color: palette.danger, fontFamily: fonts.sans, fontSize: 11, lineHeight: 16 },
  versionNotice: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, padding: 12, borderRadius: radii.md, backgroundColor: palette.paper, marginBottom: 10 },
  versionNoticeText: { flex: 1, color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 11, lineHeight: 16 },
  divider: { height: 1, backgroundColor: palette.line, marginVertical: 28 },
  unavailableCopy: { color: palette.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18 },
  bearerWarning: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 14, borderRadius: radii.md, backgroundColor: palette.dangerSurface },
  bearerWarningText: { flex: 1, color: palette.danger, fontFamily: fonts.sans, fontSize: 11, lineHeight: 17, fontWeight: '700' },
  fieldLabel: { color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 11, fontWeight: '900', marginTop: 18, marginBottom: 8 },
  expiryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  expiryChoice: { minHeight: 39, justifyContent: 'center', paddingHorizontal: 13, borderRadius: radii.pill, backgroundColor: palette.paper },
  expiryChoiceActive: { backgroundColor: palette.lime },
  expiryText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 10, fontWeight: '800' },
  expiryTextActive: { color: palette.accentInk },
  customExpiry: { minHeight: 48, color: palette.ink, fontFamily: fonts.sans, fontSize: 16, paddingHorizontal: 13, borderRadius: radii.md, backgroundColor: palette.paper, marginTop: 9 },
  createLinkButton: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: radii.md, backgroundColor: palette.lime, marginTop: 12 },
  createLinkText: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 11, fontWeight: '900' },
  linkList: { gap: 8, marginTop: 20 },
  linkRow: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 6, padding: 10, borderRadius: radii.md, backgroundColor: palette.paper, ...shadows.card },
  linkCopy: { flex: 1, minWidth: 0 },
  linkTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 11, fontWeight: '900' },
  linkMeta: { color: palette.muted, fontFamily: fonts.sans, fontSize: 9, marginTop: 3 },
  iconButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: palette.canvas },
});
