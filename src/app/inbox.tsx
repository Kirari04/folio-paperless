import {
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  Sparkles,
  WandSparkles,
} from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { AppShell } from '@/components/app-shell';
import { MotionPressable as Pressable, animateLayout, hapticFeedback } from '@/components/motion';
import { PaperThumbnail } from '@/components/paper-thumbnail';
import { fonts, palette, radii, shadows } from '@/constants/theme';
import { useApp } from '@/context/app-context';
import { isPendingDocument } from '@/lib/document-routing';
import { useRouter } from '@/lib/router';

export default function InboxScreen() {
  const router = useRouter();
  const { inboxDocuments, approveDocument, deferDocument, isSyncing, refresh } = useApp();
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const [filing, setFiling] = useState(false);
  const activeDocument = inboxDocuments[0];
  const activeDocumentPending = activeDocument ? isPendingDocument(activeDocument) : false;

  async function approve() {
    if (!activeDocument || activeDocumentPending) return;
    setFiling(true);
    try {
      animateLayout();
      await approveDocument(activeDocument.id);
      setToast({ message: `Filed “${activeDocument.title}”` });
      await hapticFeedback('confirm');
    } catch (error) {
      setToast({
        message: error instanceof Error ? error.message : 'Could not file this document.',
        error: true,
      });
      await hapticFeedback('error');
    } finally {
      setFiling(false);
      setTimeout(() => setToast(null), 3000);
    }
  }

  async function defer() {
    if (!activeDocument) return;
    animateLayout();
    deferDocument(activeDocument.id);
    setToast({ message: `Moved “${activeDocument.title}” to the end` });
    await hapticFeedback('selection');
    setTimeout(() => setToast(null), 2500);
  }

  return (
    <AppShell onRefresh={() => void refresh().catch(() => {})} refreshing={isSyncing}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>QUICK TRIAGE</Text>
          <Text style={styles.title}>Inbox</Text>
        </View>
        <View style={styles.countBadge}>
          <Text style={styles.count}>{inboxDocuments.length}</Text>
        </View>
      </View>

      {activeDocument ? (
        <>
          <View style={styles.progressRow}>
            <Text style={styles.progressLabel}>
              {activeDocument.processingError
                ? 'Processing needs attention'
                : activeDocumentPending
                  ? 'Processing upload'
                  : 'Ready to review'}
            </Text>
            <Text style={styles.progressCount}>{inboxDocuments.length} remaining</Text>
          </View>
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${Math.max(22, 100 / inboxDocuments.length)}%` },
              ]}
            />
          </View>

          <Pressable
            accessibilityHint={
              activeDocument.processingError
                ? 'Shows the processing problem and how to check again'
                : activeDocumentPending
                  ? 'Shows processing status; document actions become available when ready'
                  : 'Opens the document details and review actions'
            }
            accessibilityLabel={
              activeDocumentPending
                ? `View processing status for ${activeDocument.title}`
                : `Open ${activeDocument.title}`
            }
            onPressIn={() =>
              router.preload({
                pathname: '/document/[id]',
                params: { id: activeDocument.id, from: 'inbox' },
              })
            }
            onPress={() =>
              router.push({
                pathname: '/document/[id]',
                params: { id: activeDocument.id, from: 'inbox' },
              })
            }
            style={styles.reviewCard}>
            <View style={styles.previewArea}>
              <View style={styles.previewGlow} />
              <PaperThumbnail document={activeDocument} width={166} />
              <View style={styles.pageCount}>
                <Text style={styles.pageCountText}>
                  {activeDocument.pageCount} {activeDocument.pageCount === 1 ? 'PAGE' : 'PAGES'}
                </Text>
              </View>
            </View>

            <View style={styles.reviewBody}>
              <View style={styles.suggestionLabel}>
                {activeDocument.processingError ? (
                  <CircleAlert color={palette.danger} size={14} />
                ) : (
                  <WandSparkles color={palette.limeDark} size={14} />
                )}
                <Text
                  style={[
                    styles.suggestionLabelText,
                    activeDocument.processingError && styles.suggestionLabelError,
                  ]}>
                  {activeDocumentPending ? 'PAPERLESS STATUS' : 'FOLIO SUGGESTS'}
                </Text>
              </View>
              <Text style={styles.documentTitle}>{activeDocument.title}</Text>
              <Text style={styles.excerpt} numberOfLines={3}>
                {activeDocument.excerpt}
              </Text>

              <View style={styles.metadata}>
                <MetadataRow label="From" value={activeDocument.correspondent} />
                <MetadataRow label="Type" value={activeDocument.documentType} />
                <View style={styles.metadataRow}>
                  <Text style={styles.metadataLabel}>Tags</Text>
                  <View style={styles.tagRow}>
                    {activeDocument.tags.map((tag) => (
                      <View key={tag} style={styles.tag}>
                        <Text style={styles.tagText}>{tag}</Text>
                      </View>
                    ))}
                    {!activeDocument.tags.length && (
                      <Text style={styles.metadataValue}>No tags yet</Text>
                    )}
                  </View>
                </View>
              </View>

              {activeDocument.suggestion && (
                <View style={styles.reason}>
                  <Sparkles color={palette.inkSoft} size={15} />
                  <Text style={styles.reasonText}>{activeDocument.suggestion}</Text>
                </View>
              )}
            </View>
          </Pressable>

          <View style={styles.actions}>
            <Pressable
              accessibilityLabel={`Review ${activeDocument.title} later`}
              onPress={defer}
              style={styles.later}>
              <Clock3 color={palette.ink} size={18} />
              <Text style={styles.laterText}>Later</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={`File ${activeDocument.title}`}
              disabled={filing || activeDocumentPending}
              onPress={approve}
              style={[
                styles.fileButton,
                activeDocumentPending && styles.fileButtonDisabled,
              ]}>
              {filing || (activeDocumentPending && !activeDocument.processingError) ? (
                <ActivityIndicator color={palette.ink} size="small" />
              ) : activeDocument.processingError ? (
                <CircleAlert color={palette.danger} size={20} />
              ) : (
                <Check color={palette.ink} size={20} strokeWidth={2.6} />
              )}
              <Text style={styles.fileButtonText}>
                {activeDocument.processingError
                  ? 'Processing issue'
                  : activeDocumentPending
                    ? 'Processing…'
                    : 'Looks good · File it'}
              </Text>
            </Pressable>
          </View>

          {inboxDocuments.length > 1 && (
            <View style={styles.upNext}>
              <Text style={styles.upNextLabel}>UP NEXT</Text>
              <Pressable
                accessibilityLabel={
                  isPendingDocument(inboxDocuments[1])
                    ? `View processing status for ${inboxDocuments[1].title}`
                    : `Open ${inboxDocuments[1].title}`
                }
                onPressIn={() =>
                  router.preload({
                    pathname: '/document/[id]',
                    params: { id: inboxDocuments[1].id, from: 'inbox' },
                  })
                }
                onPress={() =>
                  router.push({
                    pathname: '/document/[id]',
                    params: { id: inboxDocuments[1].id, from: 'inbox' },
                  })
                }
                style={styles.nextCard}>
                <PaperThumbnail document={inboxDocuments[1]} width={48} />
                <View style={styles.nextBody}>
                  <Text numberOfLines={1} style={styles.nextTitle}>
                    {inboxDocuments[1].title}
                  </Text>
                  <Text style={styles.nextMeta}>{inboxDocuments[1].correspondent}</Text>
                </View>
                <ChevronRight color={palette.faint} size={18} />
              </Pressable>
            </View>
          )}
        </>
      ) : (
        <View style={styles.empty}>
          <View style={styles.emptyIcon}>
            <CheckCircle2 color={palette.ink} size={37} />
          </View>
          <Text style={styles.emptyTitle}>All clear</Text>
          <Text style={styles.emptyCopy}>
            Every document has a home. New scans and imports will wait for you here.
          </Text>
          <Pressable
            onPress={() => router.push('/scan')}
            style={styles.scanButton}>
            <Text style={styles.scanButtonText}>Scan something new</Text>
          </Pressable>
        </View>
      )}

      {!!toast && (
        <View style={[styles.toast, toast.error && styles.toastError]}>
          <CheckCircle2 color={toast.error ? palette.paper : palette.lime} size={18} />
          <Text numberOfLines={1} style={styles.toastText}>
            {toast.message}
          </Text>
        </View>
      )}
    </AppShell>
  );
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metadataRow}>
      <Text style={styles.metadataLabel}>{label}</Text>
      <Text style={styles.metadataValue}>{value}</Text>
      <ChevronRight color={palette.faint} size={15} />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  eyebrow: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  title: {
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 40,
    fontWeight: '600',
    letterSpacing: -1.3,
  },
  countBadge: {
    width: 39,
    height: 39,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: palette.ink,
  },
  count: {
    color: palette.paper,
    fontFamily: fonts.serif,
    fontSize: 19,
    fontWeight: '700',
  },
  progressRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 24,
  },
  progressLabel: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '700',
  },
  progressCount: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 11,
  },
  progressTrack: {
    height: 5,
    borderRadius: radii.pill,
    backgroundColor: palette.line,
    marginTop: 9,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radii.pill,
    backgroundColor: palette.limeDark,
  },
  reviewCard: {
    marginTop: 18,
    borderRadius: radii.lg,
    backgroundColor: palette.paper,
    overflow: 'hidden',
    ...shadows.card,
  },
  previewArea: {
    height: 190,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E8E4DB',
    overflow: 'hidden',
  },
  previewGlow: {
    position: 'absolute',
    width: 250,
    height: 250,
    borderRadius: 125,
    backgroundColor: '#F7F2E8',
  },
  pageCount: {
    position: 'absolute',
    right: 14,
    bottom: 13,
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(23,35,27,0.75)',
  },
  pageCountText: {
    color: palette.paper,
    fontFamily: fonts.sans,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
  reviewBody: {
    padding: 19,
  },
  suggestionLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  suggestionLabelText: {
    color: palette.limeDark,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1,
  },
  suggestionLabelError: {
    color: palette.danger,
  },
  documentTitle: {
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 25,
    lineHeight: 29,
    fontWeight: '600',
    marginTop: 8,
  },
  excerpt: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
  },
  metadata: {
    marginTop: 17,
    borderTopWidth: 1,
    borderColor: palette.line,
  },
  metadataRow: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    borderBottomWidth: 1,
    borderColor: palette.line,
  },
  metadataLabel: {
    width: 42,
    color: palette.faint,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '700',
  },
  metadataValue: {
    flex: 1,
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '700',
  },
  tagRow: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
  },
  tag: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radii.pill,
    backgroundColor: palette.canvas,
  },
  tagText: {
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '700',
  },
  reason: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    padding: 11,
    borderRadius: radii.sm,
    backgroundColor: '#F0EEE6',
    marginTop: 15,
  },
  reasonText: {
    flex: 1,
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '600',
  },
  actions: {
    flexDirection: 'row',
    gap: 9,
    marginTop: 13,
  },
  later: {
    height: 55,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingHorizontal: 17,
    borderRadius: radii.md,
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: palette.line,
  },
  laterText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '700',
  },
  fileButton: {
    flex: 1,
    height: 55,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radii.md,
    backgroundColor: palette.lime,
  },
  fileButtonDisabled: {
    opacity: 0.5,
  },
  fileButtonText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '900',
  },
  upNext: {
    marginTop: 26,
  },
  upNextLabel: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1.2,
    marginBottom: 9,
  },
  nextCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    padding: 10,
    borderRadius: radii.md,
    backgroundColor: '#E8E3D8',
  },
  nextBody: {
    flex: 1,
  },
  nextTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '800',
  },
  nextMeta: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    marginTop: 3,
  },
  empty: {
    alignItems: 'center',
    paddingHorizontal: 30,
    paddingTop: 110,
  },
  emptyIcon: {
    width: 86,
    height: 86,
    borderRadius: 43,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.lime,
  },
  emptyTitle: {
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 34,
    fontWeight: '600',
    marginTop: 20,
  },
  emptyCopy: {
    maxWidth: 320,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
    marginTop: 7,
  },
  scanButton: {
    paddingHorizontal: 20,
    paddingVertical: 13,
    borderRadius: radii.pill,
    backgroundColor: palette.ink,
    marginTop: 20,
  },
  scanButtonText: {
    color: palette.paper,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '800',
  },
  toast: {
    position: 'absolute',
    left: 36,
    right: 36,
    bottom: 105,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 15,
    paddingVertical: 13,
    borderRadius: radii.md,
    backgroundColor: palette.ink,
    ...shadows.lift,
  },
  toastError: {
    backgroundColor: palette.danger,
  },
  toastText: {
    flex: 1,
    color: palette.paper,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.75,
    transform: [{ scale: 0.985 }],
  },
});
