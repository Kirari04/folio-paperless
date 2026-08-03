import { catalogs, type TranslationKey } from './catalogs.ts';

export type AppearancePreference = 'system' | 'light' | 'dark';
export type LanguagePreference = 'system' | 'en' | 'de';
export type SupportedLocale = 'en' | 'de';
export type InterpolationValues = Record<string, string | number>;

export type LocaleDescriptor = {
  languageCode: string | null | undefined;
  languageTag: string | null | undefined;
};

function normalizedLanguageCode(value: string | null | undefined) {
  return value?.trim().toLocaleLowerCase().split(/[-_]/, 1)[0];
}

export function resolveSupportedLocale(
  preference: LanguagePreference,
  languageCodes: (string | null | undefined)[],
): SupportedLocale {
  if (preference !== 'system') return preference;
  for (const languageCode of languageCodes) {
    const normalized = normalizedLanguageCode(languageCode);
    if (normalized === 'en' || normalized === 'de') return normalized;
  }
  return 'en';
}

export function resolveLocaleTag(
  locale: SupportedLocale,
  locales: readonly LocaleDescriptor[],
) {
  return locales.find((entry) => normalizedLanguageCode(entry.languageCode) === locale)
    ?.languageTag?.trim() || locale;
}

export function resolveColorScheme(
  preference: AppearancePreference,
  systemScheme: 'light' | 'dark' | 'unspecified' | null | undefined,
): 'light' | 'dark' {
  return preference === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : preference;
}

export function interpolate(message: string, values?: InterpolationValues) {
  if (!values) return message;
  return message.replace(/{{(\w+)}}/g, (placeholder, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : placeholder,
  );
}

export function translate(
  locale: SupportedLocale,
  key: TranslationKey,
  values?: InterpolationValues,
) {
  return interpolate(catalogs[locale][key] ?? catalogs.en[key], values);
}

export function formatFileSizeForLocale(bytes: number, localeTag: string) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return `${new Intl.NumberFormat(localeTag).format(0)} B`;
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${new Intl.NumberFormat(localeTag, {
    maximumFractionDigits: unitIndex ? 1 : 0,
  }).format(value)} ${units[unitIndex]}`;
}
