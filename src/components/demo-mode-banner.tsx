import { ArrowRight, FlaskConical } from 'lucide-react-native';
import { StyleSheet, Text, View } from 'react-native';

import { fonts, palette, radii } from '@/constants/theme';
import { MotionPressable as Pressable } from '@/components/motion';
import { useRouter } from '@/lib/router';

export function DemoModeBanner() {
  const router = useRouter();

  return (
    <Pressable
      accessibilityLabel="Demo mode. Sample documents are shown. Connect a Paperless server."
      accessibilityRole="button"
      onPress={() => router.push('/settings')}
      style={styles.banner}>
      <View style={styles.icon}>
        <FlaskConical color={palette.lime} size={17} strokeWidth={2.4} />
      </View>
      <View style={styles.copy}>
        <Text style={styles.title}>DEMO MODE</Text>
        <Text numberOfLines={1} style={styles.subtitle}>
          You’re viewing sample documents
        </Text>
      </View>
      <View style={styles.action}>
        <Text style={styles.actionText}>Connect</Text>
        <ArrowRight color={palette.ink} size={14} strokeWidth={2.5} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 18,
    borderRadius: radii.md,
    backgroundColor: '#E7E2F6',
    borderWidth: 1,
    borderColor: '#D6CDEE',
  },
  icon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.ink,
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
