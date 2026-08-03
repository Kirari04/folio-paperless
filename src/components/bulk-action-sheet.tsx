import {
  Archive,
  CheckCircle2,
  Download,
  FolderInput,
  RefreshCcw,
  Tags,
  Trash2,
  UserRound,
  XCircle,
} from 'lucide-react-native';
import { useRef, type ReactNode } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { KeyboardSheet, type KeyboardSheetHandle } from '@/components/keyboard-sheet';
import { MotionPressable as Pressable } from '@/components/motion';
import { fonts, palette, radii } from '@/constants/theme';
import { useI18n } from '@/i18n';
import { presentRuntimeMessage } from '@/i18n/error-presentation';
import type { LibrarySelectionSummary } from '@/lib/bulk-document-controller';
import type {
  PaperlessBulkResult,
  PaperlessCapabilities,
  PaperlessCapabilityStatus,
  PaperlessRepresentation,
} from '@/types/paperless-advanced';

type BulkActionResult = Pick<PaperlessBulkResult, 'failed' | 'pending' | 'skipped' | 'succeeded'>;

export type BulkActionRequest =
  | { kind: 'tags'; mode: 'add' | 'remove' | 'replace' }
  | { kind: 'setCorrespondent' | 'setDocumentType' | 'setStoragePath' | 'setOwner' }
  | { kind: 'file' | 'reprocess' | 'trash' }
  | { kind: 'export'; representation: PaperlessRepresentation };

function enabled(status: PaperlessCapabilityStatus | undefined) {
  return status?.supported === true;
}

function ActionRow({
  danger,
  disabled,
  icon,
  label,
  onPress,
  subtitle,
}: {
  danger?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onPress: () => void;
  subtitle: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.action, disabled && styles.disabled]}>
      <View style={[styles.actionIcon, danger && styles.dangerIcon]}>{icon}</View>
      <View style={styles.actionCopy}>
        <Text style={[styles.actionLabel, danger && styles.dangerText]}>{label}</Text>
        <Text numberOfLines={2} style={styles.actionSubtitle}>{subtitle}</Text>
      </View>
    </Pressable>
  );
}

export function BulkActionSheet({
  busy,
  capabilities,
  onClose,
  onRequest,
  onRetryFailed,
  result,
  selection,
  visible,
}: {
  busy: boolean;
  capabilities: PaperlessCapabilities | null;
  onClose: () => void;
  onRequest: (request: BulkActionRequest) => void;
  onRetryFailed: () => void;
  result: BulkActionResult | null;
  selection: LibrarySelectionSummary;
  visible: boolean;
}) {
  const sheet = useRef<KeyboardSheetHandle>(null);
  const { formatNumber, t } = useI18n();
  const mutations = enabled(capabilities?.features.bulkDocuments)
    && capabilities?.permissions.document.change === true;
  const owner = capabilities?.permissions.document.change === true;
  const skipReason = (reason: string) => {
    if (reason === 'not-remote') return t('bulk.skipNotRemote');
    if (reason === 'processing') return t('bulk.skipProcessing');
    if (reason === 'read-only') return t('bulk.skipReadOnly');
    if (reason === 'duplicate-selection') return t('bulk.skipDuplicate');
    if (reason === 'missing-current-tags') return t('bulk.skipMissingTags');
    return reason;
  };
  return (
    <KeyboardSheet
      accessibilityLabel={t('bulk.accessibility')}
      onDismiss={onClose}
      ref={sheet}
      subtitle={selection.hiddenSelected
        ? t('bulk.selectionHidden', {
          selected: formatNumber(selection.selected),
          hidden: formatNumber(selection.hiddenSelected),
        })
        : t('bulk.selection', { count: formatNumber(selection.selected) })}
      title={t('bulk.title')}
      visible={visible}>
      {busy && (
        <View accessibilityLiveRegion="polite" style={styles.progress}>
          <ActivityIndicator color={palette.ink} />
          <Text style={styles.progressText}>{t('bulk.applying')}</Text>
        </View>
      )}
      {!!result && (
        <View accessibilityLiveRegion="polite" style={styles.summary}>
          <View style={styles.summaryRow}>
            {result.pending.length
              ? <ActivityIndicator color={palette.ink} size="small" />
              : result.failed.length
                ? <XCircle color={palette.danger} size={17} />
                : <CheckCircle2 color={palette.limeDark} size={17} />}
            <Text style={styles.summaryText}>{t('bulk.succeeded', { count: formatNumber(result.succeeded.length) })}</Text>
            <Text style={styles.summaryDot}>·</Text>
            <Text style={styles.summaryText}>{t('bulk.pending', { count: formatNumber(result.pending.length) })}</Text>
            <Text style={styles.summaryDot}>·</Text>
            <Text style={styles.summaryText}>{t('bulk.failed', { count: formatNumber(result.failed.length) })}</Text>
            <Text style={styles.summaryDot}>·</Text>
            <Text style={styles.summaryText}>{t('bulk.skipped', { count: formatNumber(result.skipped.length) })}</Text>
          </View>
          {!!result.failed.length && (
            <>
              <View style={styles.failureList}>
                {result.failed.slice(0, 3).map((failure, index) => (
                  <Text key={`${failure.localId ?? failure.remoteId ?? 'failure'}-${index}`} numberOfLines={2} style={styles.failureText}>
                    {failure.remoteId
                      ? t('bulk.documentFailure', {
                        id: failure.remoteId,
                        message: presentRuntimeMessage(failure.message),
                      })
                      : presentRuntimeMessage(failure.message)}
                  </Text>
                ))}
                {result.failed.length > 3 && <Text style={styles.failureText}>{t('bulk.moreFailures', { count: formatNumber(result.failed.length - 3) })}</Text>}
              </View>
              <Pressable
                accessibilityLabel={t('bulk.retryFailed')}
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={onRetryFailed}
                style={styles.retry}>
                <RefreshCcw color={palette.ink} size={15} />
                <Text style={styles.retryText}>{t('bulk.retryFailed')}</Text>
              </Pressable>
            </>
          )}
          {!!result.skipped.length && (
            <Text style={styles.summaryHint}>
              {t('bulk.notSent')}: {Object.entries(result.skipped.reduce<Record<string, number>>((counts, item) => ({
                ...counts,
                [item.reason]: (counts[item.reason] ?? 0) + 1,
              }), {})).map(([reason, count]) => `${formatNumber(count)} ${skipReason(reason)}`).join(' · ')}.
            </Text>
          )}
        </View>
      )}
      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        <Text style={styles.groupLabel}>{t('bulk.tagsGroup')}</Text>
        <ActionRow
          disabled={busy || !mutations}
          icon={<Tags color={palette.ink} size={18} />}
          label={t('bulk.addTags')}
          onPress={() => onRequest({ kind: 'tags', mode: 'add' })}
          subtitle={t('bulk.addTagsSubtitle')}
        />
        <ActionRow
          disabled={busy || !mutations}
          icon={<Tags color={palette.ink} size={18} />}
          label={t('bulk.removeTags')}
          onPress={() => onRequest({ kind: 'tags', mode: 'remove' })}
          subtitle={t('bulk.removeTagsSubtitle')}
        />
        <ActionRow
          danger
          disabled={busy || !mutations}
          icon={<XCircle color={palette.danger} size={18} />}
          label={t('bulk.replaceTags')}
          onPress={() => onRequest({ kind: 'tags', mode: 'replace' })}
          subtitle={t('bulk.replaceTagsSubtitle')}
        />

        <Text style={styles.groupLabel}>{t('bulk.metadataGroup')}</Text>
        <ActionRow disabled={busy || !mutations} icon={<FolderInput color={palette.ink} size={18} />} label={t('bulk.correspondent')} onPress={() => onRequest({ kind: 'setCorrespondent' })} subtitle={t('bulk.correspondentSubtitle')} />
        <ActionRow disabled={busy || !mutations} icon={<FolderInput color={palette.ink} size={18} />} label={t('bulk.documentType')} onPress={() => onRequest({ kind: 'setDocumentType' })} subtitle={t('bulk.documentTypeSubtitle')} />
        <ActionRow disabled={busy || !mutations} icon={<Archive color={palette.ink} size={18} />} label={t('bulk.storagePath')} onPress={() => onRequest({ kind: 'setStoragePath' })} subtitle={t('bulk.storagePathSubtitle')} />
        <ActionRow disabled={busy || !owner} icon={<UserRound color={palette.ink} size={18} />} label={t('bulk.owner')} onPress={() => onRequest({ kind: 'setOwner' })} subtitle={owner ? t('bulk.ownerSubtitle') : t('bulk.ownerUnavailable')} />

        <Text style={styles.groupLabel}>{t('bulk.workflowGroup')}</Text>
        <ActionRow disabled={busy || !mutations} icon={<Archive color={palette.ink} size={18} />} label={t('bulk.fileInbox')} onPress={() => onRequest({ kind: 'file' })} subtitle={t('bulk.fileInboxSubtitle')} />
        <ActionRow disabled={busy || !enabled(capabilities?.features.reprocessDocuments)} icon={<RefreshCcw color={palette.ink} size={18} />} label={t('bulk.reprocess')} onPress={() => onRequest({ kind: 'reprocess' })} subtitle={t('bulk.reprocessSubtitle')} />
        <ActionRow danger disabled={busy || !enabled(capabilities?.features.deleteDocuments)} icon={<Trash2 color={palette.danger} size={18} />} label={t('bulk.trash')} onPress={() => onRequest({ kind: 'trash' })} subtitle={t('bulk.trashSubtitle')} />

        <Text style={styles.groupLabel}>{t('bulk.exportGroup')}</Text>
        <ActionRow disabled={busy || !enabled(capabilities?.features.documentMetadata)} icon={<Download color={palette.ink} size={18} />} label={t('bulk.exportOriginals')} onPress={() => onRequest({ kind: 'export', representation: 'original' })} subtitle={t('bulk.exportOriginalsSubtitle')} />
        <ActionRow disabled={busy || !enabled(capabilities?.features.documentMetadata)} icon={<Download color={palette.ink} size={18} />} label={t('bulk.exportArchives')} onPress={() => onRequest({ kind: 'export', representation: 'archive' })} subtitle={t('bulk.exportArchivesSubtitle')} />
      </ScrollView>
    </KeyboardSheet>
  );
}

const styles = StyleSheet.create({
  progress: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, borderRadius: radii.sm, backgroundColor: palette.paper },
  progressText: { flex: 1, color: palette.ink, fontFamily: fonts.sans, fontSize: 13, fontWeight: '700' },
  summary: { padding: 14, borderRadius: radii.md, backgroundColor: palette.paper, borderWidth: 1, borderColor: palette.line, marginBottom: 10 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  summaryText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 12, fontWeight: '800' },
  summaryDot: { color: palette.muted, fontFamily: fonts.sans, fontSize: 12 },
  summaryHint: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, lineHeight: 16, marginTop: 9 },
  failureList: { gap: 4, marginTop: 9 },
  failureText: { color: palette.danger, fontFamily: fonts.sans, fontSize: 10, lineHeight: 14 },
  retry: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7, alignSelf: 'flex-start', marginTop: 6 },
  retryText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 12, fontWeight: '900' },
  list: { paddingBottom: 28 },
  groupLabel: { color: palette.muted, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900', letterSpacing: 0.7, marginTop: 16, marginBottom: 5 },
  action: { minHeight: 68, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.line },
  actionIcon: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: palette.paperStrong },
  dangerIcon: { backgroundColor: palette.dangerSurface },
  actionCopy: { flex: 1, minWidth: 0 },
  actionLabel: { color: palette.ink, fontFamily: fonts.sans, fontSize: 14, fontWeight: '900' },
  dangerText: { color: palette.danger },
  actionSubtitle: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, lineHeight: 16, marginTop: 3 },
  disabled: { opacity: 0.42 },
});
