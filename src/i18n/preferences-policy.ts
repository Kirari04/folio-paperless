import type { AppearancePreference, LanguagePreference } from './core.ts';

export type StoredUiPreferences = {
  appearance: AppearancePreference;
  language: LanguagePreference;
};

export const UI_PREFERENCES_STORAGE_KEY = 'folio.ui-preferences.v1';

export const defaultUiPreferences: StoredUiPreferences = {
  appearance: 'system',
  language: 'system',
};

function isAppearance(value: unknown): value is AppearancePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

function isLanguage(value: unknown): value is LanguagePreference {
  return value === 'system' || value === 'en' || value === 'de';
}

export function parseStoredUiPreferences(serialized: string | null): StoredUiPreferences {
  if (!serialized) return defaultUiPreferences;
  try {
    const parsed = JSON.parse(serialized) as Partial<StoredUiPreferences>;
    return {
      appearance: isAppearance(parsed.appearance) ? parsed.appearance : defaultUiPreferences.appearance,
      language: isLanguage(parsed.language) ? parsed.language : defaultUiPreferences.language,
    };
  } catch {
    return defaultUiPreferences;
  }
}
