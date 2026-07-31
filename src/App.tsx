import { StatusBar } from 'expo-status-bar';
import { LockKeyhole } from 'lucide-react-native';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
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
import {
  MotionPressable as Pressable,
  MotionProvider,
  MotionScreen,
} from '@/components/motion';
import { fonts, palette, radii } from '@/constants/theme';
import { AppProvider, useApp } from '@/context/app-context';
import { authenticateForFolio } from '@/lib/device-features';
import { NavigationProvider, useNavigationMotion, useNavigationRoute } from '@/lib/router';
import type { RoutePath } from '@/lib/router';

const tabScreens = [
  { pathname: '/', Screen: memo(HomeScreen) },
  { pathname: '/documents', Screen: memo(DocumentsScreen) },
  { pathname: '/inbox', Screen: memo(InboxScreen) },
  { pathname: '/settings', Screen: memo(SettingsScreen) },
] as const;

const tabPathnames = new Set<RoutePath>(tabScreens.map((screen) => screen.pathname));
type TabPath = (typeof tabScreens)[number]['pathname'];

function isTabPath(pathname: RoutePath): pathname is TabPath {
  return tabPathnames.has(pathname);
}

function CurrentScreen() {
  const route = useNavigationRoute();
  const { lastDocument, lastTab } = useNavigationMotion();
  const tabRoute = isTabPath(route.pathname) ? route.pathname : null;
  const isTabRoute = tabRoute !== null;
  const documentActive = route.pathname === '/document/[id]';

  let overlayScreen = null;
  switch (route.pathname) {
    case '/trash':
      overlayScreen = <TrashScreen />;
      break;
    case '/scan':
      overlayScreen = <ScanScreen />;
      break;
  }

  return (
    <View style={styles.navigationRoot}>
      {tabScreens.map(({ pathname, Screen }) => {
        const active = route.pathname === pathname;
        const visible = active || (!isTabRoute && lastTab === pathname);
        return (
          <View
            accessibilityElementsHidden={!visible}
            importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
            key={pathname}
            pointerEvents={active ? 'auto' : 'none'}
            renderToHardwareTextureAndroid={visible}
            shouldRasterizeIOS={visible}
            style={[styles.tabScene, { zIndex: visible ? 2 : 1 }]}>
            <Screen />
          </View>
        );
      })}
      {!isTabRoute && !documentActive && (
        <MotionScreen
          backgroundColor={
            route.pathname === '/scan'
              ? palette.black
              : route.pathname === '/document/[id]'
                ? 'transparent'
                : palette.canvas
          }
          key={route.key}>
          {overlayScreen}
        </MotionScreen>
      )}
      {!!lastDocument?.params.id && (
        <MotionScreen backgroundColor="transparent" visible={documentActive}>
          <DocumentDetailScreen
            active={documentActive}
            documentFrom={lastDocument.params.from}
            documentId={lastDocument.params.id}
            key={lastDocument.key}
          />
        </MotionScreen>
      )}
      <BottomNav activePathname={isTabRoute ? tabRoute : lastTab} visible={isTabRoute} />
    </View>
  );
}

function ProtectedApp() {
  const { isBootstrapping, preferences, preferencesReady } = useApp();
  const [locked, setLocked] = useState(true);
  const [unlocking, setUnlocking] = useState(false);
  const unlockAttempted = useRef(false);
  const lockEnabled = preferencesReady && preferences.biometricLock;
  const showLock = lockEnabled && locked;

  const unlock = useCallback(async () => {
    if (!lockEnabled) return;
    setUnlocking(true);
    try {
      if (await authenticateForFolio()) setLocked(false);
    } finally {
      setUnlocking(false);
    }
  }, [lockEnabled]);

  useEffect(() => {
    if (showLock && !unlockAttempted.current) {
      unlockAttempted.current = true;
      void unlock();
    }
  }, [showLock, unlock]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (lockEnabled && state === 'background') {
        unlockAttempted.current = false;
        setLocked(true);
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

  if (showLock) {
    return (
      <View style={styles.lockRoot}>
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
    );
  }

  return <CurrentScreen />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <MotionProvider>
        <AppProvider>
          <NavigationProvider>
            <StatusBar style="dark" />
            <View style={{ flex: 1, backgroundColor: palette.canvas }}>
              <ProtectedApp />
            </View>
          </NavigationProvider>
        </AppProvider>
      </MotionProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
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
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    backgroundColor: palette.canvas,
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
