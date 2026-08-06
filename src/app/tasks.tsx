import {
  CheckCircle2,
  ChevronLeft,
  CircleAlert,
  Clock3,
  FileUp,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react-native';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MotionPressable as Pressable, hapticFeedback } from '@/components/motion';
import { createThemedStyleSheet, fonts, palette, radii, shadows } from '@/constants/theme';
import { useApp } from '@/context/app-context';
import { useI18n, type TranslationKey } from '@/i18n';
import { presentRuntimeError, presentRuntimeMessage } from '@/i18n/error-presentation';
import {
  groupTasksByBatch,
  summarizeBatch,
  summarizeBulkOutcomes,
  taskCancellationMeaning,
} from '@/lib/task-policy';
import { taskResultRouteId } from '@/lib/task-center';
import { useRouter } from '@/lib/router';
import type { PersistentTask } from '@/types/tasks';

type Translator = (key: TranslationKey, values?: Record<string, string | number>) => string;

function stageLabel(
  task: PersistentTask,
  t: Translator,
  formatNumber: (value: number) => string,
) {
  if (task.stage === 'preparing') return t('tasks.waitingMetadata');
  if (task.stage === 'queued') return t('tasks.queued');
  if (task.stage === 'uploading') {
    return t('tasks.uploading', { progress: formatNumber(Math.round(task.progress * 100)) });
  }
  if (task.stage === 'processing') return t('tasks.processing');
  if (task.stage === 'ready') return t('tasks.ready');
  if (task.stage === 'submission-uncertain') return t('tasks.needsAttention');
  if (task.stage === 'failed') {
    return task.error?.retryable ? t('tasks.retryScheduled') : t('tasks.needsAttention');
  }
  return t('tasks.canceled');
}

function statusIcon(task: PersistentTask) {
  if (task.stage === 'ready') return <CheckCircle2 color={palette.limeDark} size={21} />;
  if (task.stage === 'failed' || task.stage === 'submission-uncertain') {
    return <CircleAlert color={palette.danger} size={21} />;
  }
  if (task.stage === 'canceled') return <X color={palette.muted} size={21} />;
  if (task.stage === 'uploading' || task.stage === 'processing') {
    return <ActivityIndicator color={palette.ink} size="small" />;
  }
  return <Clock3 color={palette.muted} size={21} />;
}

export default function TaskCenterScreen() {
  const router = useRouter();
  const { formatDate, formatNumber, t } = useI18n();
  const {
    activeProfile,
    documents,
    tasks,
    retryTask,
    cancelTask,
    deleteTaskRecord,
    resolveMetadataConflict,
  } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const summary = useMemo(() => summarizeBatch(tasks), [tasks]);
  const multiFileBatches = useMemo(() => groupTasksByBatch(
    tasks,
    activeProfile?.id,
  ).filter((batch) => !!batch.batchId && batch.tasks.length > 1), [activeProfile?.id, tasks]);

  async function act(id: string, action: () => Promise<void>) {
    setBusy(id);
    setError(null);
    try {
      await action();
      await hapticFeedback('confirm');
    } catch (nextError) {
      setError(presentRuntimeError(nextError, t('tasks.actionError')));
      await hapticFeedback('error');
    } finally {
      setBusy(null);
    }
  }

  function confirmCancel(task: PersistentTask) {
    const accepted = taskCancellationMeaning(task) === 'acceptance-uncertain';
    Alert.alert(
      t(accepted ? 'tasks.stopTrackingTitle' : 'tasks.cancelQueuedTitle'),
      t(accepted ? 'tasks.stopTrackingBody' : 'tasks.cancelQueuedBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t(accepted ? 'tasks.stopTracking' : 'tasks.cancel'),
          style: 'destructive',
          onPress: () => void act(task.id, () => cancelTask(task.id)),
        },
      ],
    );
  }

  function confirmUncertainResubmission(task: PersistentTask) {
    Alert.alert(
      t('tasks.resubmitUncertainTitle'),
      t('tasks.resubmitUncertainBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('tasks.resubmitUncertainAction'),
          style: 'destructive',
          onPress: () => void act(task.id, () => retryTask(task.id, {
            userConfirmedDuplicateRisk: true,
          })),
        },
      ],
    );
  }

  function confirmMetadataConflict(task: PersistentTask, resolution: 'keep-local' | 'use-server') {
    Alert.alert(
      t(resolution === 'keep-local' ? 'tasks.conflictKeepTitle' : 'tasks.conflictServerTitle'),
      t(resolution === 'keep-local' ? 'tasks.conflictKeepBody' : 'tasks.conflictServerBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t(resolution === 'keep-local' ? 'tasks.keepLocal' : 'tasks.useServer'),
          style: resolution === 'keep-local' ? 'destructive' : 'default',
          onPress: () => void act(task.id, () => resolveMetadataConflict(task.id, resolution)),
        },
      ],
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.root}>
      <View style={styles.header}>
        <Pressable accessibilityLabel={t('tasks.back')} onPress={() => router.back()} style={styles.iconButton}>
          <ChevronLeft color={palette.ink} size={22} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.eyebrow}>{activeProfile?.displayName ?? t('tasks.localDemo')}</Text>
          <Text style={styles.title}>{t('tasks.title')}</Text>
        </View>
        <Pressable accessibilityLabel={t('tasks.addDocuments')} onPress={() => router.push('/scan')} style={styles.addButton}>
          <FileUp color={palette.accentInk} size={19} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.summary}>
          <View style={styles.metric}><Text style={styles.metricValue}>{formatNumber(summary.active)}</Text><Text style={styles.metricLabel}>{t('tasks.active')}</Text></View>
          <View style={styles.metric}><Text style={styles.metricValue}>{formatNumber(summary.failed)}</Text><Text style={styles.metricLabel}>{t('tasks.failed')}</Text></View>
          <View style={styles.metric}><Text style={styles.metricValue}>{formatNumber(summary.succeeded)}</Text><Text style={styles.metricLabel}>{t('tasks.complete')}</Text></View>
        </View>
        {multiFileBatches.map((batch) => (
          <View key={batch.key} style={styles.batchSummary}>
            <Text style={styles.batchTitle}>{t('tasks.batchTitle', { count: formatNumber(batch.tasks.length) })}</Text>
            <Text style={styles.batchCopy}>{t('tasks.batchSummary', {
              succeeded: formatNumber(batch.summary.succeeded),
              failed: formatNumber(batch.summary.failed),
              active: formatNumber(batch.summary.active),
              canceled: formatNumber(batch.summary.canceled),
            })}</Text>
          </View>
        ))}
        {!!error && <Text accessibilityLiveRegion="assertive" style={styles.error}>{error}</Text>}

        {!tasks.length ? (
          <View style={styles.empty}>
            <CheckCircle2 color={palette.limeDark} size={34} />
            <Text style={styles.emptyTitle}>{t('tasks.empty')}</Text>
            <Text style={styles.emptyCopy}>{t('tasks.emptyCopy')}</Text>
          </View>
        ) : tasks.map((task) => {
          const active = ['preparing', 'queued', 'uploading', 'processing'].includes(task.stage);
          const metadataConflict = task.kind === 'metadata-update'
            && task.error?.code === 'conflict'
            && !!task.metadataUpdate?.conflict;
          const cancellable = !metadataConflict && (
            active || task.stage === 'failed' || task.stage === 'submission-uncertain'
          );
          const submissionAttemptActive = task.stage === 'submission-uncertain'
            && !!task.leaseOwner
            && !!task.leaseExpiresAt;
          const terminal = ['ready', 'canceled'].includes(task.stage);
          const bulkSummary = task.result?.bulkOutcomes
            ? summarizeBulkOutcomes(task.result.bulkOutcomes)
            : null;
          const resultRouteId = taskResultRouteId(task);
          return (
            <View key={task.id} style={styles.taskCard}>
              <View style={styles.taskTop}>
                <View style={styles.statusIcon}>{statusIcon(task)}</View>
                <View style={styles.taskCopy}>
                  <Text numberOfLines={1} style={styles.taskName}>
                    {task.originalName || t(`tasks.kind.${task.kind}` as TranslationKey)}
                  </Text>
                  <Text style={styles.taskStage}>{t('tasks.stageDestination', {
                    stage: stageLabel(task, t, formatNumber),
                    destination: activeProfile?.displayName ?? t('tasks.localDemo'),
                  })}</Text>
                  {task.kind === 'upload' && (
                    <Text style={styles.taskMeta}>
                      {t('tasks.mimeType', {
                        mime: task.mimeType ?? t('fileActions.mimeUnavailable'),
                      })}
                    </Text>
                  )}
                </View>
                <Text style={styles.taskTime}>
                  {formatDate(task.updatedAt, { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </View>
              {task.stage === 'uploading' && (
                <View accessibilityLabel={t('tasks.percentUploaded', {
                  progress: formatNumber(Math.round(task.progress * 100)),
                })} accessibilityRole="progressbar" style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${Math.max(3, task.progress * 100)}%` }]} />
                </View>
              )}
              {!!task.error && <Text style={styles.taskError}>{presentRuntimeMessage(task.error.message)}</Text>}
              {!!task.result?.summary && (
                <Text style={styles.taskResult}>{presentRuntimeMessage(task.result.summary)}</Text>
              )}
              {!!bulkSummary && (
                <Text accessibilityLiveRegion="polite" style={styles.taskResult}>
                  {t('bulk.succeeded', { count: formatNumber(bulkSummary.succeeded) })} · {t('bulk.failed', { count: formatNumber(bulkSummary.failed) })} · {t('bulk.skipped', { count: formatNumber(bulkSummary.skipped) })} · {t('bulk.pending', { count: formatNumber(bulkSummary.pending) })}
                </Text>
              )}
              {!!task.result?.duplicateDocumentIds?.length && (
                <View accessibilityLiveRegion="polite" style={styles.duplicateResult}>
                  <CircleAlert color={palette.danger} size={16} />
                  <Text style={styles.duplicateResultText}>{t('tasks.duplicatesFound', { count: formatNumber(task.result.duplicateDocumentIds.length) })}</Text>
                </View>
              )}
              <View style={styles.actions}>
                {metadataConflict && (
                  <>
                    <Pressable disabled={busy === task.id} onPress={() => confirmMetadataConflict(task, 'use-server')} style={styles.actionButton}>
                      <Text style={styles.actionText}>{t('tasks.useServer')}</Text>
                    </Pressable>
                    <Pressable disabled={busy === task.id} onPress={() => confirmMetadataConflict(task, 'keep-local')} style={styles.reviewButton}>
                      <Text style={styles.reviewText}>{t('tasks.keepLocal')}</Text>
                    </Pressable>
                  </>
                )}
                {task.stage === 'preparing' && (
                  <Pressable onPress={() => router.push({ pathname: '/intake', params: { batchId: task.batchId } })} style={styles.actionButton}>
                    <Text style={styles.actionText}>{t('tasks.editMetadata')}</Text>
                  </Pressable>
                )}
                {task.stage === 'failed' && task.kind === 'upload' && !!task.batchId && !!task.localUri && (
                  <Pressable onPress={() => router.push({ pathname: '/intake', params: { batchId: task.batchId } })} style={styles.actionButton}>
                    <Text style={styles.actionText}>{t('tasks.editMetadata')}</Text>
                  </Pressable>
                )}
                {task.stage === 'failed' && task.error?.retryable && (
                  <Pressable disabled={busy === task.id} onPress={() => void act(task.id, () => retryTask(task.id))} style={styles.actionButton}>
                    <RotateCcw color={palette.accentInk} size={15} />
                    <Text style={styles.actionText}>{t('tasks.retryNow')}</Text>
                  </Pressable>
                )}
                {task.kind === 'upload'
                  && task.stage === 'submission-uncertain'
                  && !submissionAttemptActive && (
                  <Pressable
                    disabled={busy === task.id}
                    onPress={() => confirmUncertainResubmission(task)}
                    style={styles.reviewButton}>
                    <RotateCcw color={palette.danger} size={15} />
                    <Text style={styles.reviewText}>{t('tasks.resubmitUncertainAction')}</Text>
                  </Pressable>
                )}
                {!!resultRouteId && (
                  <Pressable onPress={() => router.push({ pathname: '/document/[id]', params: { id: resultRouteId } })} style={styles.actionButton}>
                    <Text style={styles.actionText}>{t('tasks.openResult')}</Text>
                  </Pressable>
                )}
                {!!task.result?.duplicateDocumentIds?.length && (
                  <Pressable
                    onPress={() => {
                      const firstDuplicate = documents.find((document) => document.remoteId === task.result?.duplicateDocumentIds?.[0]);
                      if (firstDuplicate) router.push({ pathname: '/document/[id]', params: { id: firstDuplicate.id } });
                      else router.push('/documents');
                    }}
                    style={styles.reviewButton}>
                    <Text style={styles.reviewText}>{t('tasks.reviewDuplicates')}</Text>
                  </Pressable>
                )}
                {cancellable && (
                  <Pressable disabled={busy === task.id} onPress={() => confirmCancel(task)} style={styles.cancelButton}>
                    <X color={palette.danger} size={15} />
                    <Text style={styles.cancelText}>
                      {taskCancellationMeaning(task) === 'acceptance-uncertain'
                        ? t('tasks.stopTracking')
                        : t('tasks.cancel')}
                    </Text>
                  </Pressable>
                )}
                {terminal && (
                  <Pressable disabled={busy === task.id} onPress={() => void act(task.id, () => deleteTaskRecord(task.id))} style={styles.removeButton}>
                    <Trash2 color={palette.muted} size={15} />
                    <Text style={styles.removeText}>{t('tasks.removeRecord')}</Text>
                  </Pressable>
                )}
              </View>
            </View>
          );
        })}
        <Text style={styles.disclaimer}>{t('tasks.disclaimer')}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = createThemedStyleSheet({
  root: { flex: 1, backgroundColor: palette.canvas },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 14 },
  headerCopy: { flex: 1 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: palette.paper },
  addButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: palette.lime },
  eyebrow: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  title: { color: palette.ink, fontFamily: fonts.serif, fontSize: 30, fontWeight: '700' },
  content: { width: '100%', maxWidth: 760, alignSelf: 'center', padding: 18, paddingBottom: 48, gap: 12 },
  summary: { flexDirection: 'row', padding: 15, borderRadius: radii.lg, backgroundColor: palette.paper },
  batchSummary: { gap: 3, padding: 13, borderRadius: radii.md, backgroundColor: palette.paperStrong },
  batchTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 12, fontWeight: '900' },
  batchCopy: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, lineHeight: 16 },
  metric: { flex: 1, alignItems: 'center', gap: 2 },
  metricValue: { color: palette.ink, fontFamily: fonts.serif, fontSize: 25, fontWeight: '700' },
  metricLabel: { color: palette.muted, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900', textTransform: 'uppercase' },
  taskCard: { padding: 15, gap: 11, borderRadius: radii.lg, backgroundColor: palette.paper, ...shadows.card },
  taskTop: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  statusIcon: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 15, backgroundColor: palette.paperStrong },
  taskCopy: { flex: 1, minWidth: 0 },
  taskName: { color: palette.ink, fontFamily: fonts.sans, fontSize: 14, fontWeight: '900' },
  taskStage: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, marginTop: 2 },
  taskMeta: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, marginTop: 2 },
  taskTime: { color: palette.faint, fontFamily: fonts.mono, fontSize: 10 },
  progressTrack: { height: 6, overflow: 'hidden', borderRadius: 99, backgroundColor: palette.line },
  progressFill: { height: '100%', borderRadius: 99, backgroundColor: palette.limeDark },
  taskError: { color: palette.danger, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  taskResult: { color: palette.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 17 },
  duplicateResult: { flexDirection: 'row', alignItems: 'center', gap: 7, padding: 10, borderRadius: radii.sm, backgroundColor: palette.dangerSurface },
  duplicateResultText: { flex: 1, color: palette.danger, fontFamily: fonts.sans, fontSize: 11, fontWeight: '800' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  actionButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, borderRadius: radii.sm, backgroundColor: palette.lime },
  actionText: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 11, fontWeight: '900' },
  reviewButton: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 12, borderRadius: radii.sm, borderWidth: 1, borderColor: palette.danger, backgroundColor: palette.dangerSurface },
  reviewText: { color: palette.danger, fontFamily: fonts.sans, fontSize: 11, fontWeight: '900' },
  cancelButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, borderRadius: radii.sm, backgroundColor: palette.dangerSurface },
  cancelText: { color: palette.danger, fontFamily: fonts.sans, fontSize: 11, fontWeight: '900' },
  removeButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, borderRadius: radii.sm, backgroundColor: palette.paperStrong },
  removeText: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, fontWeight: '900' },
  empty: { alignItems: 'center', gap: 8, padding: 30, borderRadius: radii.lg, backgroundColor: palette.paper },
  emptyTitle: { color: palette.ink, fontFamily: fonts.serif, fontSize: 23, fontWeight: '700' },
  emptyCopy: { maxWidth: 330, color: palette.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, textAlign: 'center' },
  error: { color: palette.danger, fontFamily: fonts.sans, fontSize: 13, fontWeight: '800' },
  disclaimer: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, lineHeight: 16, textAlign: 'center', paddingHorizontal: 18, paddingTop: 8 },
});
