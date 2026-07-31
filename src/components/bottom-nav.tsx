import {
  Archive,
  Home,
  Inbox,
  Plus,
  Settings,
  type LucideIcon,
} from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { bottomNavHeight, fonts, maxContentWidth, palette, radii, shadows } from '@/constants/theme';
import { MotionPressable as Pressable, useReducedMotion } from '@/components/motion';
import { usePathname, useRouter } from '@/lib/router';

type NavItem = {
  label: string;
  href: '/' | '/documents' | '/inbox' | '/settings';
  icon: LucideIcon;
};

type TabPathname = NavItem['href'];

const items: NavItem[] = [
  { label: 'Home', href: '/', icon: Home },
  { label: 'Library', href: '/documents', icon: Archive },
  { label: 'Inbox', href: '/inbox', icon: Inbox },
  { label: 'Settings', href: '/settings', icon: Settings },
];

function isActive(pathname: string, href: NavItem['href']) {
  if (href === '/') return pathname === '/';
  return pathname.startsWith(href);
}

export function BottomNav({
  activePathname,
  visible = true,
}: {
  activePathname?: TabPathname;
  visible?: boolean;
}) {
  const currentPathname = usePathname();
  const pathname = activePathname || currentPathname;
  const router = useRouter();
  const insets = useSafeAreaInsets();

  return (
    <View
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      pointerEvents={visible ? 'box-none' : 'none'}
      style={[
        styles.positioner,
        { paddingBottom: Math.max(insets.bottom, 10) },
      ]}>
      <View style={styles.nav}>
        {items.slice(0, 2).map((item) => (
          <NavButton
            key={item.href}
            {...item}
            active={isActive(pathname, item.href)}
            onPress={() => {
              if (!isActive(pathname, item.href)) router.navigate(item.href);
            }}
          />
        ))}

        <Pressable
          accessibilityLabel="Scan a document"
          accessibilityRole="button"
          onPress={() => router.push('/scan')}
          style={styles.scanButton}>
          <Plus color={palette.ink} size={26} strokeWidth={2.5} />
        </Pressable>

        {items.slice(2).map((item) => (
          <NavButton
            key={item.href}
            {...item}
            active={isActive(pathname, item.href)}
            onPress={() => {
              if (!isActive(pathname, item.href)) router.navigate(item.href);
            }}
          />
        ))}
      </View>
    </View>
  );
}

function NavButton({
  label,
  icon: Icon,
  active,
  onPress,
}: NavItem & { active: boolean; onPress: () => void }) {
  const reducedMotion = useReducedMotion();
  const [selection] = useState(() => new Animated.Value(active ? 1 : 0));

  useEffect(() => {
    selection.stopAnimation();
    if (reducedMotion) {
      selection.setValue(active ? 1 : 0);
      return;
    }
    Animated.timing(selection, {
      toValue: active ? 1 : 0,
      duration: 145,
      easing: Easing.bezier(0.16, 1, 0.3, 1),
      useNativeDriver: true,
    }).start();
  }, [active, reducedMotion, selection]);

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={styles.navItem}>
      <View style={styles.iconWrap}>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.activePill,
            {
              opacity: selection,
              transform: [
                {
                  scaleX: selection.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.7, 1],
                  }),
                },
                {
                  scaleY: selection.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.82, 1],
                  }),
                },
              ],
            },
          ]}
        />
        <Icon color={active ? palette.paper : palette.faint} size={20} strokeWidth={active ? 2.4 : 2} />
      </View>
      <Text style={[styles.navLabel, active && styles.navLabelActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  positioner: {
    position: 'absolute',
    zIndex: 20,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    paddingHorizontal: 14,
  },
  nav: {
    width: '100%',
    maxWidth: maxContentWidth - 24,
    minHeight: bottomNavHeight - 12,
    borderRadius: radii.xl,
    backgroundColor: palette.ink,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 8,
    paddingVertical: 8,
    ...shadows.lift,
  },
  navItem: {
    flex: 1,
    minWidth: 56,
    alignItems: 'center',
    gap: 3,
    paddingVertical: 3,
  },
  iconWrap: {
    width: 34,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
  },
  activePill: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: '#334037',
    borderRadius: radii.pill,
  },
  navLabel: {
    color: palette.faint,
    fontSize: 10,
    fontFamily: fonts.sans,
    fontWeight: '600',
  },
  navLabelActive: {
    color: palette.paper,
  },
  scanButton: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: palette.lime,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 4,
    borderWidth: 4,
    borderColor: palette.ink,
    transform: [{ translateY: -10 }],
  },
  pressed: {
    opacity: 0.72,
    transform: [{ scale: 0.97 }],
  },
});
