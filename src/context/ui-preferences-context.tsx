import * as SecureStore from 'expo-secure-store';
import * as SystemUI from 'expo-system-ui';
import { useLocales } from 'expo-localization';
import {
  Appearance,
  Platform,
  useColorScheme,
} from 'react-native';
import {
  PropsWithChildren,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react';

import { prepareAndroidSemanticColors } from '@/constants/theme';
import { themeHex } from '@/constants/theme-colors';
import {
  resolveColorScheme,
  resolveSupportedLocale,
  type AppearancePreference,
  type LanguagePreference,
} from '@/i18n/core';
import {
  defaultUiPreferences,
  parseStoredUiPreferences,
  UI_PREFERENCES_STORAGE_KEY,
  type StoredUiPreferences,
} from '@/i18n/preferences-policy';
import { I18nRenderProvider } from '@/i18n/react-provider';
import { commitNativeAppearanceTransition } from '@/i18n/appearance-transition';

export type { AppearancePreference, LanguagePreference, SupportedLocale } from '@/i18n/core';
export { useI18n } from '@/i18n/react-provider';

type UISettings = StoredUiPreferences;
const defaults: UISettings = defaultUiPreferences;

async function loadSettings(): Promise<UISettings> {
  try {
    const stored = Platform.OS === 'web'
      ? typeof window === 'undefined'
        ? null
        : window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY)
      : await SecureStore.getItemAsync(UI_PREFERENCES_STORAGE_KEY);
    return parseStoredUiPreferences(stored);
  } catch {
    return defaults;
  }
}

function loadInitialSettings(): UISettings | null {
  if (Platform.OS !== 'web') return null;
  try {
    return typeof window === 'undefined'
      ? defaults
      : parseStoredUiPreferences(window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY));
  } catch {
    return defaults;
  }
}

async function applyNativeAppearance(settings: UISettings) {
  const requestedScheme = settings.appearance === 'system'
    ? 'unspecified'
    : settings.appearance;
  const currentScheme = Appearance.getColorScheme();

  if (
    Platform.OS === 'android'
    && requestedScheme !== 'unspecified'
    && currentScheme !== requestedScheme
  ) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        subscription.remove();
        resolve();
      };
      const subscription = Appearance.addChangeListener(({ colorScheme }) => {
        if (colorScheme === requestedScheme) finish();
      });
      const timeout = setTimeout(finish, 1_000);

      // AppCompat schedules this work on Android's UI thread. Publishing the
      // React preference before its configuration-change event leaves newly
      // mounted PlatformColor views holding the previous resource palette.
      Appearance.setColorScheme(requestedScheme);
    });
  } else {
    Appearance.setColorScheme(requestedScheme);
  }
  const colorScheme = resolveColorScheme(settings.appearance, Appearance.getColorScheme());
  await SystemUI.setBackgroundColorAsync(themeHex[colorScheme].canvas);
}

// SDK 57 recommends setting the root background outside React components.
// Starting this shared bootstrap during root-module evaluation also gives the
// stored override the full native-splash window in which to settle.
const nativeSettingsBootstrap = Platform.OS === 'web'
  ? null
  : loadSettings().then(async (stored) => {
    try {
      await applyNativeAppearance(stored);
    } catch {
      // A platform background failure must not strand the app on its splash.
    }
    return stored;
  });

async function saveSettings(settings: UISettings) {
  const serialized = JSON.stringify(settings);
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, serialized);
    }
    return;
  }
  await SecureStore.setItemAsync(UI_PREFERENCES_STORAGE_KEY, serialized);
}

function yieldToPresentationFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

export function I18nProvider({ children }: PropsWithChildren) {
  const systemScheme = useColorScheme();
  const systemLocales = useLocales();
  const [hydratedSettings, setHydratedSettings] = useState<UISettings | null>(loadInitialSettings);
  const settings = hydratedSettings ?? defaults;
  const ready = hydratedSettings !== null;

  useEffect(() => {
    if (Platform.OS === 'web' || hydratedSettings) return;
    let active = true;
    void nativeSettingsBootstrap!.then((stored) => {
      // The native splash remains visible until the shared bootstrap has
      // applied this stored override and its root background.
      if (active) setHydratedSettings(stored);
    });
    return () => {
      active = false;
    };
  }, [hydratedSettings]);

  const colorScheme = resolveColorScheme(settings.appearance, systemScheme);
  prepareAndroidSemanticColors(colorScheme);
  const locale = resolveSupportedLocale(
    settings.language,
    systemLocales.map((entry) => entry.languageCode),
  );

  useLayoutEffect(() => {
    if (Platform.OS === 'web' && ready && typeof document !== 'undefined') {
      document.documentElement.dataset.folioTheme = settings.appearance;
      document.documentElement.lang = locale;
    }
  }, [locale, ready, settings.appearance]);

  useEffect(() => {
    if (!ready || Platform.OS === 'web' || settings.appearance !== 'system') return;
    Appearance.setColorScheme('unspecified');
    void SystemUI.setBackgroundColorAsync(themeHex[colorScheme].canvas);
  }, [colorScheme, ready, settings.appearance]);

  const updateSettings = useCallback(async (next: UISettings) => {
    const previous = settings;
    setHydratedSettings(next);
    try {
      await saveSettings(next);
    } catch (error) {
      setHydratedSettings(previous);
      throw error;
    }
  }, [settings]);

  const setAppearance = useCallback(
    (appearance: AppearancePreference) => {
      const next = { ...settings, appearance };
      if (Platform.OS === 'web') return updateSettings(next);
      return commitNativeAppearanceTransition({
        previous: settings,
        next,
        applyNative: applyNativeAppearance,
        persist: saveSettings,
        publish: setHydratedSettings,
        yieldToPresentation: yieldToPresentationFrame,
      });
    },
    [settings, updateSettings],
  );
  const setLanguage = useCallback(
    (language: LanguagePreference) => updateSettings({ ...settings, language }),
    [settings, updateSettings],
  );

  return (
    <I18nRenderProvider
      ready={ready}
      settings={settings}
      setAppearance={setAppearance}
      setLanguage={setLanguage}
      systemLocales={systemLocales}
      systemScheme={systemScheme}>
      {children}
    </I18nRenderProvider>
  );
}
