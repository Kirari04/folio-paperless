import { CircleAlert } from 'lucide-react-native';
import { ScrollView, Text, View } from 'react-native';

import { MotionPressable as Pressable } from '@/components/motion';
import { createThemedStyleSheet, fonts, palette, radii } from '@/constants/theme';
import { useI18n } from '@/i18n';

export type IntakeRejectionListItem = {
  id: string;
  name: string;
  reason: string;
};

export function IntakeRejectionList({
  acceptedCount,
  items,
  onChooseMore,
  onDismiss,
  onRetry,
  scrollable = false,
}: {
  acceptedCount: number;
  items: IntakeRejectionListItem[];
  onChooseMore?: () => void;
  onDismiss?: () => void;
  onRetry?: () => void;
  scrollable?: boolean;
}) {
  const { formatNumber, t } = useI18n();
  const total = acceptedCount + items.length;

  if (!items.length) return null;

  return (
    <View accessibilityLiveRegion="assertive" style={styles.alert}>
      <View style={styles.headingRow}>
        <View style={styles.icon}>
          <CircleAlert color={palette.danger} size={19} />
        </View>
        <View style={styles.headingCopy}>
          <Text style={styles.title}>
            {t(acceptedCount ? 'intake.someFilesRejected' : 'intake.noFilesAccepted')}
          </Text>
          <Text style={styles.summary}>
            {t('intake.rejectionSummary', {
              rejected: formatNumber(items.length),
              total: formatNumber(total),
            })}
          </Text>
        </View>
      </View>
      {scrollable ? (
        <ScrollView
          contentContainerStyle={styles.files}
          nestedScrollEnabled
          showsVerticalScrollIndicator
          style={styles.fileScroller}>
          {items.map((item) => (
            <View key={item.id} style={styles.fileRow}>
              <Text selectable style={styles.fileName}>{item.name}</Text>
              <Text selectable style={styles.reason}>{item.reason}</Text>
            </View>
          ))}
        </ScrollView>
      ) : (
        <View style={styles.files}>
          {items.map((item) => (
            <View key={item.id} style={styles.fileRow}>
              <Text selectable style={styles.fileName}>{item.name}</Text>
              <Text selectable style={styles.reason}>{item.reason}</Text>
            </View>
          ))}
        </View>
      )}
      {(onChooseMore || onDismiss || onRetry) && (
        <View style={styles.actions}>
          {!!onRetry && (
            <Pressable onPress={onRetry} style={styles.primaryAction}>
              <Text style={styles.primaryActionText}>{t('share.retryStaging')}</Text>
            </Pressable>
          )}
          {!!onChooseMore && (
            <Pressable onPress={onChooseMore} style={styles.primaryAction}>
              <Text style={styles.primaryActionText}>{t('intake.chooseOtherFiles')}</Text>
            </Pressable>
          )}
          {!!onDismiss && (
            <Pressable onPress={onDismiss} style={styles.secondaryAction}>
              <Text style={styles.secondaryActionText}>{t('intake.dismissRejections')}</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

const styles = createThemedStyleSheet({
  alert: {
    gap: 12,
    padding: 15,
    borderRadius: radii.lg,
    backgroundColor: palette.dangerSurface,
  },
  headingRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 11 },
  icon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    backgroundColor: palette.paper,
  },
  headingCopy: { flex: 1, minWidth: 0 },
  title: { color: palette.danger, fontFamily: fonts.sans, fontSize: 14, fontWeight: '900' },
  summary: { marginTop: 3, color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18 },
  files: { gap: 1, overflow: 'hidden', borderRadius: radii.sm, backgroundColor: palette.line },
  fileScroller: { maxHeight: 260, borderRadius: radii.sm },
  fileRow: { gap: 3, padding: 11, backgroundColor: palette.paper },
  fileName: { color: palette.ink, fontFamily: fonts.sans, fontSize: 12, fontWeight: '900' },
  reason: { color: palette.danger, fontFamily: fonts.sans, fontSize: 11, lineHeight: 17 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  primaryAction: {
    minHeight: 46,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: radii.md,
    backgroundColor: palette.lime,
  },
  primaryActionText: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 12, fontWeight: '900' },
  secondaryAction: { minHeight: 46, justifyContent: 'center', paddingHorizontal: 10 },
  secondaryActionText: { color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 12, fontWeight: '800' },
});
