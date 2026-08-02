import { getLocales } from 'expo-localization';
import * as SecureStore from 'expo-secure-store';

import { resolveLocaleTag, resolveSupportedLocale } from './core';
import {
  parseStoredUiPreferences,
  UI_PREFERENCES_STORAGE_KEY,
} from './preferences-policy';
import { setRuntimeLocale } from './runtime';

/** Restores the app-selected locale before headless work creates user-visible copy. */
export async function restoreNativeRuntimeLocale() {
  try {
    const serialized = await SecureStore.getItemAsync(UI_PREFERENCES_STORAGE_KEY);
    const preferences = parseStoredUiPreferences(serialized);
    const systemLocales = getLocales();
    const locale = resolveSupportedLocale(
      preferences.language,
      systemLocales.map((entry) => entry.languageCode),
    );
    setRuntimeLocale(locale, resolveLocaleTag(locale, systemLocales));
    return locale;
  } catch {
    setRuntimeLocale('en');
    return 'en' as const;
  }
}
