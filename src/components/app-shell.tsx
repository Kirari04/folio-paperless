import { PropsWithChildren, ReactNode } from 'react';
import {
  RefreshControl,
  Platform,
  ScrollView,
  StyleProp,
  View,
  ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DemoModeBanner } from '@/components/demo-mode-banner';
import { createThemedStyleSheet, bottomNavHeight, maxContentWidth, palette } from '@/constants/theme';
import { useApp } from '@/context/app-context';

type AppShellProps = PropsWithChildren<{
  contentStyle?: StyleProp<ViewStyle>;
  onRefresh?: () => void;
  refreshing?: boolean;
  header?: ReactNode;
  safeTop?: boolean;
  scrollable?: boolean;
  showDemoBanner?: boolean;
  showNav?: boolean;
}>;

export function AppShell({
  children,
  contentStyle,
  onRefresh,
  refreshing = false,
  header,
  safeTop = true,
  scrollable = true,
  showDemoBanner = true,
  showNav = true,
}: AppShellProps) {
  const { profileConfigured } = useApp();

  return (
    <View style={styles.root}>
      <SafeAreaView edges={safeTop ? ['top'] : []} style={styles.safe}>
        {header}
        {scrollable ? (
          <ScrollView
            automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
            style={styles.scroll}
            contentInsetAdjustmentBehavior="automatic"
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            refreshControl={
              onRefresh ? (
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  tintColor={palette.ink}
                  colors={[palette.ink]}
                />
              ) : undefined
            }
            contentContainerStyle={[
              styles.scrollContent,
              !showNav && styles.scrollContentWithoutNav,
              contentStyle,
            ]}>
            {!profileConfigured && showDemoBanner && <DemoModeBanner />}
            {children}
          </ScrollView>
        ) : (
          <View style={[styles.staticContent, contentStyle]}>
            {!profileConfigured && showDemoBanner && <DemoModeBanner />}
            {children}
          </View>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = createThemedStyleSheet({
  root: {
    flex: 1,
    backgroundColor: palette.canvas,
  },
  safe: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
  },
  scroll: {
    width: '100%',
  },
  staticContent: {
    flex: 1,
    width: '100%',
  },
  scrollContent: {
    width: '100%',
    maxWidth: maxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: bottomNavHeight + 34,
  },
  scrollContentWithoutNav: {
    paddingBottom: 38,
  },
});
