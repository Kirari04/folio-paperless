import { useIsFocused } from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
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
import IntakeScreen from '@/app/intake';
import PaperlessMetadataScreen from '@/app/paperless-metadata';
import SavedViewsScreen from '@/app/saved-views';
import ScanScreen from '@/app/scan';
import SettingsScreen from '@/app/settings';
import TaskCenterScreen from '@/app/tasks';
import TrashScreen from '@/app/trash';
import { BottomNav } from '@/components/bottom-nav';
import { ExternalRoutingGateway } from '@/components/external-routing-gateway';
import { FolioLogo } from '@/components/folio-logo';
import { IncomingShareGateway } from '@/components/incoming-share-gateway';
import {
  MotionPressable as Pressable,
  MotionProvider,
} from '@/components/motion';
import { OsSearchRuntimeGateway } from '@/components/os-search-runtime-gateway';
import { UpdateOverlay } from '@/components/update-overlay';
import { fonts, palette, radii } from '@/constants/theme';
import { AppProvider, useApp } from '@/context/app-context';
import { UpdateProvider } from '@/context/update-context';
import { I18nProvider, useI18n } from '@/context/ui-preferences-context';
import {
  authenticateForFolio,
  dismissProfileNotifications,
  setRuntimeNotificationPrivacyLocked,
} from '@/lib/device-features';
import { IN_APP_APK_UPDATES_ENABLED } from '@/lib/distribution-runtime';
import { NavigationProvider, useNavigationMotion } from '@/lib/router';
import type { RootStackParamList } from '@/lib/router';
import { createWidgetSnapshot } from '@/lib/widget-privacy';

void SplashScreen.preventAutoHideAsync().catch(() => {
  // The native splash may already be hidden in Expo Go or on web.
});

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
  const { colorScheme } = useI18n();

  return (
    <Stack.Navigator
      screenOptions={{
        animation: 'default',
        animationMatchesGesture: true,
        contentStyle: { backgroundColor: palette.canvas },
        gestureEnabled: true,
        headerShown: false,
        statusBarStyle: colorScheme === 'dark' ? 'light' : 'dark',
      }}>
      <Stack.Screen component={TabNavigator} name="Tabs" />
      <Stack.Screen component={DocumentRoute} name="Document" />
      <Stack.Screen
        component={ScanScreen}
        name="Scan"
        options={{
          animation: 'slide_from_bottom',
          contentStyle: { backgroundColor: palette.accentInk },
          presentation: 'fullScreenModal',
          statusBarStyle: 'light',
        }}
      />
      <Stack.Screen component={TrashScreen} name="Trash" />
      <Stack.Screen component={IntakeScreen} name="Intake" />
      <Stack.Screen component={TaskCenterScreen} name="Tasks" />
      <Stack.Screen component={SavedViewsScreen} name="SavedViews" />
      <Stack.Screen component={PaperlessMetadataScreen} name="PaperlessMetadata" />
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
  const {
    connected,
    inboxDocuments,
    isBootstrapping,
    preferences,
    preferencesReady,
    profiles,
  } = useApp();
  const { locale, t } = useI18n();
  const [locked, setLocked] = useState(true);
  const [unlocking, setUnlocking] = useState(false);
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const authenticating = useRef(false);
  const unlockAttempted = useRef(false);
  const lockGeneration = useRef(0);
  const widgetUpdateTail = useRef<Promise<void>>(Promise.resolve());
  const lockEnabled = preferencesReady && preferences.biometricLock;
  const showLock = lockEnabled && locked;

  const unlock = useCallback(async () => {
    if (!lockEnabled || !appActive) return;
    const generation = lockGeneration.current;
    authenticating.current = true;
    setUnlocking(true);
    try {
      if (
        (await authenticateForFolio()) &&
        generation === lockGeneration.current &&
        AppState.currentState === 'active'
      ) {
        setRuntimeNotificationPrivacyLocked(false);
        setLocked(false);
      }
    } finally {
      authenticating.current = false;
      if (generation === lockGeneration.current) setUnlocking(false);
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
        lockGeneration.current += 1;
        if (!authenticating.current) unlockAttempted.current = false;
        setRuntimeNotificationPrivacyLocked(true);
        setUnlocking(false);
        setLocked(true);
        void Promise.all(profiles.map((profile) => dismissProfileNotifications(profile.id)));
      }
    });
    return () => subscription.remove();
  }, [lockEnabled, profiles]);

  useEffect(() => {
    setRuntimeNotificationPrivacyLocked(showLock);
    if (showLock) {
      void Promise.all(profiles.map((profile) => dismissProfileNotifications(profile.id)));
    }
  }, [profiles, showLock]);

  useEffect(() => {
    if (Platform.OS === 'web' || isBootstrapping) return;
    const snapshot = createWidgetSnapshot({
      authenticated: connected,
      unlocked: !showLock,
      inboxCount: connected ? inboxDocuments.length : null,
      syncedAt: connected ? new Date().toISOString() : null,
    });
    widgetUpdateTail.current = widgetUpdateTail.current
      .catch(() => undefined)
      .then(async () => {
        if (Platform.OS === 'ios') {
          const { folioWidgetSnapshotAdapter } = await import('@/lib/folio-inbox-widget');
          await folioWidgetSnapshotAdapter.updateSnapshot(snapshot);
        } else {
          const { folioAndroidWidgetSnapshotAdapter } = await import('@/lib/folio-android-widget');
          await folioAndroidWidgetSnapshotAdapter.updateSnapshot(snapshot);
        }
      });
    void widgetUpdateTail.current.catch(() => {
      // Widget updates are best effort and remain serialized so redaction wins.
    });
  }, [connected, inboxDocuments.length, isBootstrapping, locale, showLock]);

  if (isBootstrapping) {
    return (
      <View style={styles.loadingRoot}>
        <FolioLogo inverse size={62} />
        <ActivityIndicator color={palette.ink} style={styles.loadingIndicator} />
        <Text style={styles.loadingText}>{t('app.opening')}</Text>
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
        {appActive && !showLock && (
          <>
            <ExternalRoutingGateway />
            <OsSearchRuntimeGateway />
            <IncomingShareGateway />
            {IN_APP_APK_UPDATES_ENABLED && <UpdateOverlay />}
          </>
        )}
      </View>
      {!appActive ? (
        <PrivacyCurtain />
      ) : showLock ? (
        <View accessibilityViewIsModal style={styles.lockRoot}>
          <View style={styles.lockMark}>
            <LockKeyhole color={palette.lime} size={27} />
          </View>
          <Text style={styles.lockTitle}>{t('app.lockedTitle')}</Text>
          <Text style={styles.lockCopy}>{t('app.lockedCopy')}</Text>
          <Pressable disabled={unlocking} onPress={unlock} style={styles.unlockButton}>
            {unlocking ? (
              <ActivityIndicator color={palette.accentInk} />
            ) : (
              <LockKeyhole color={palette.accentInk} size={18} />
            )}
            <Text style={styles.unlockText}>
              {unlocking ? t('app.checking') : t('app.unlock')}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function LocalizedApp() {
  const { colorScheme, nativePaletteKey, ready } = useI18n();

  useEffect(() => {
    if (ready) SplashScreen.hide();
  }, [ready]);

  if (!ready) return null;

  return (
    <SafeAreaProvider>
      <MotionProvider>
        <AppProvider>
          <UpdateProvider>
            <NavigationProvider>
              <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
              {/* Android resolves PlatformColor values when native views mount.
                  Recreate only the presentation tree after AppCompat finishes
                  its uiMode change; profile and durable app state stay above. */}
              <View
                key={nativePaletteKey}
                style={{ flex: 1, backgroundColor: palette.canvas }}>
                <ProtectedApp />
              </View>
            </NavigationProvider>
          </UpdateProvider>
        </AppProvider>
      </MotionProvider>
    </SafeAreaProvider>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <LocalizedApp />
    </I18nProvider>
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
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: radii.md,
    backgroundColor: palette.lime,
    marginTop: 24,
  },
  unlockText: {
    color: palette.accentInk,
    fontFamily: fonts.sans,
    fontSize: 14,
    fontWeight: '900',
  },
});
