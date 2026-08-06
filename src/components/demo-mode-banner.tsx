import { ArrowRight, FlaskConical } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { createThemedStyleSheet, fonts, palette, radii } from '@/constants/theme';
import { MotionPressable as Pressable } from '@/components/motion';
import { useI18n } from '@/context/ui-preferences-context';
import { useRouter } from '@/lib/router';

export function DemoModeBanner() {
  const router = useRouter();
  const { t } = useI18n();

  return (
    <Pressable
      accessibilityLabel={t('demo.accessibility')}
      accessibilityRole="button"
      onPress={() => router.push('/settings')}
      style={styles.banner}>
      <View style={styles.icon}>
        <FlaskConical color={palette.lime} size={17} strokeWidth={2.4} />
      </View>
      <View style={styles.copy}>
        <Text style={styles.title}>{t('demo.title')}</Text>
        <Text numberOfLines={1} style={styles.subtitle}>
          {t('demo.subtitle')}
        </Text>
      </View>
      <View style={styles.action}>
        <Text style={styles.actionText}>{t('demo.connect')}</Text>
        <ArrowRight color={palette.ink} size={14} strokeWidth={2.5} />
      </View>
    </Pressable>
  );
}

const styles = createThemedStyleSheet({
  banner: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 18,
    borderRadius: radii.md,
    backgroundColor: palette.lavender,
    borderWidth: 1,
    borderColor: palette.lineStrong,
  },
  icon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.accentInk,
  },
  copy: {
    flex: 1,
  },
  title: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1,
  },
  subtitle: {
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 2,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingLeft: 4,
  },
  actionText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '900',
  },
  pressed: {
    opacity: 0.78,
    transform: [{ scale: 0.99 }],
  },
});
