import { StatusBar } from 'expo-status-bar';
import { useIsFocused } from '@react-navigation/native';
import { createNativeStackNavigator, type NativeStackScreenProps } from '@react-navigation/native-stack';
import { LockKeyhole } from 'lucide-react-native';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import DocumentDetailScreen from '@/app/document/[id]';
import DocumentsScreen from '@/app/documents';
import HomeScreen from '@/app/index';
import InboxScreen from '@/app/inbox';
import ScanScreen from '@/app/scan';
import SettingsScreen from '@/app/settings';
import TrashScreen from '@/app/trash';
import { BottomNav } from '@/components/bottom-nav';
import { FolioLogo } from '@/components/folio-logo';
import { UpdateOverlay } from '@/components/update-overlay';
import {
  MotionPressable as Pressable,
  MotionProvider,
} from '@/components/motion';
import { fonts, palette, radii } from '@/constants/theme';
import { AppProvider, useApp } from '@/context/app-context';
import { UpdateProvider } from '@/context/update-context';
import { authenticateForFolio } from '@/lib/device-features';
import { NavigationProvider, useNavigationMotion } from '@/lib/router';
import type { RootStackParamList } from '@/lib/router';

const tabScreens = [
  { pathname: '/', Screen: memo(HomeScreen) },
  { pathname: '/documents', Screen: memo(DocumentsScreen) },
  { pathname: '/inbox', Screen: memo(InboxScreen) },
  { pathname: '/settings', Screen: memo(SettingsScreen) },
] as const;

type TabPath = (typeof tabScreens)[number]['pathname'];
const Stack = createNativeStackNavigator<RootStackParamList>();

function TabNavigator() {
  const { lastTab } = useNavigationMotion();

  return (
    <View style={styles.navigationRoot}>
      {tabScreens.map(({ pathname, Screen }) => {
        const active = lastTab === pathname;
        return (
          <View
            accessibilityElementsHidden={!active}
            importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
            key={pathname}
            pointerEvents={active ? 'auto' : 'none'}
            renderToHardwareTextureAndroid={active}
            shouldRasterizeIOS={active}
            style={[styles.tabScene, { zIndex: active ? 2 : 1 }]}>
            <Screen />
          </View>
        );
      })}
      <BottomNav activePathname={lastTab as TabPath} />
    </View>
  );
}

function DocumentRoute({ route }: NativeStackScreenProps<RootStackParamList, 'Document'>) {
  const active = useIsFocused();
  return (
    <DocumentDetailScreen
      active={active}
      documentFrom={route.params.from}
      documentId={route.params.id}
    />
  );
}

function AppNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        animation: 'default',
        animationMatchesGesture: true,
        contentStyle: { backgroundColor: palette.canvas },
        gestureEnabled: true,
        headerShown: false,
        statusBarStyle: 'dark',
      }}>
      <Stack.Screen component={TabNavigator} name="Tabs" />
      <Stack.Screen component={DocumentRoute} name="Document" />
      <Stack.Screen
        component={ScanScreen}
        name="Scan"
        options={{
          animation: 'slide_from_bottom',
          contentStyle: { backgroundColor: palette.black },
          presentation: 'fullScreenModal',
          statusBarStyle: 'light',
        }}
      />
      <Stack.Screen component={TrashScreen} name="Trash" />
    </Stack.Navigator>
  );
}

function PrivacyCurtain() {
  return (
    <View accessibilityViewIsModal style={styles.privacyCurtain}>
      <StatusBar style="light" />
      <FolioLogo inverse size={60} />
    </View>
  );
}

function ProtectedApp() {
  const { isBootstrapping, preferences, preferencesReady } = useApp();
  const [locked, setLocked] = useState(true);
  const [unlocking, setUnlocking] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const authenticating = useRef(false);
  const unlockAttempted = useRef(false);
  const lockEnabled = preferencesReady && preferences.biometricLock;
  const showLock = lockEnabled && locked;

  const unlock = useCallback(async () => {
    if (!lockEnabled || !appActive) return;
    authenticating.current = true;
    setUnlocking(true);
    try {
      if (await authenticateForFolio()) setLocked(false);
    } finally {
      authenticating.current = false;
      setUnlocking(false);
    }
  }, [appActive, lockEnabled]);

  useEffect(() => {
    if (appActive && showLock && !unlockAttempted.current) {
      unlockAttempted.current = true;
      void unlock();
    }
  }, [appActive, showLock, unlock]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const active = state === 'active';
      setAppActive(active);
      if (lockEnabled && !active) {
        setLocked(true);
        if (!authenticating.current) unlockAttempted.current = false;
      }
    });
    return () => subscription.remove();
  }, [lockEnabled]);

  if (isBootstrapping) {
    return (
      <View style={styles.loadingRoot}>
        <FolioLogo inverse size={62} />
        <ActivityIndicator color={palette.ink} style={styles.loadingIndicator} />
        <Text style={styles.loadingText}>Opening your folio…</Text>
      </View>
    );
  }

  return (
    <View style={styles.protectedRoot}>
      <View
        accessibilityElementsHidden={!appActive || showLock}
        importantForAccessibility={!appActive || showLock ? 'no-hide-descendants' : 'auto'}
        style={styles.protectedRoot}>
        <AppNavigator />
        {Platform.OS === 'android' && <UpdateOverlay />}
      </View>
      {!appActive ? (
        <PrivacyCurtain />
      ) : showLock ? (
        <View accessibilityViewIsModal style={styles.lockRoot}>
          <View style={styles.lockMark}>
            <LockKeyhole color={palette.lime} size={27} />
          </View>
          <Text style={styles.lockTitle}>Folio is locked</Text>
          <Text style={styles.lockCopy}>Use your device security to view document previews.</Text>
          <Pressable disabled={unlocking} onPress={unlock} style={styles.unlockButton}>
            {unlocking ? (
              <ActivityIndicator color={palette.ink} />
            ) : (
              <LockKeyhole color={palette.ink} size={18} />
            )}
            <Text style={styles.unlockText}>{unlocking ? 'Checking…' : 'Unlock Folio'}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <MotionProvider>
        <AppProvider>
          <UpdateProvider>
            <NavigationProvider>
              <StatusBar style="dark" />
              <View style={{ flex: 1, backgroundColor: palette.canvas }}>
                <ProtectedApp />
              </View>
            </NavigationProvider>
          </UpdateProvider>
        </AppProvider>
      </MotionProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  protectedRoot: {
    flex: 1,
  },
  navigationRoot: {
    flex: 1,
    backgroundColor: palette.canvas,
    overflow: 'hidden',
  },
  tabScene: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: palette.canvas,
  },
  loadingRoot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.canvas,
  },
  loadingIndicator: {
    marginTop: 24,
  },
  loadingText: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    marginTop: 10,
  },
  lockRoot: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 100,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    backgroundColor: palette.canvas,
  },
  privacyCurtain: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 110,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.ink,
  },
  lockMark: {
    width: 68,
    height: 68,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24,
    backgroundColor: palette.ink,
  },
  lockTitle: {
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 34,
    fontWeight: '600',
    marginTop: 22,
  },
  lockCopy: {
    maxWidth: 310,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    marginTop: 8,
  },
  unlockButton: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 22,
    borderRadius: radii.md,
    backgroundColor: palette.lime,
    marginTop: 24,
  },
  unlockText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 14,
    fontWeight: '900',
  },
});
