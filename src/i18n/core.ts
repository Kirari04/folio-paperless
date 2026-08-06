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

export function formatNumberForLocale(
  value: number,
  localeTag: string,
  options?: Intl.NumberFormatOptions,
) {
  if (typeof Intl.NumberFormat === 'function') {
    try {
      return new Intl.NumberFormat(localeTag, options).format(value);
    } catch {
      // Some constrained native runtimes expose Intl without every formatter.
    }
  }
  if (!Number.isFinite(value)) return String(value);
  const displayed = options?.style === 'percent' ? value * 100 : value;
  const maximumFractionDigits = options?.maximumFractionDigits;
  const number = typeof maximumFractionDigits === 'number'
    ? displayed.toFixed(maximumFractionDigits).replace(/\.0+$|(\.\d*?)0+$/, '$1')
    : String(displayed);
  return options?.style === 'percent' ? `${number}%` : number;
}

export function formatListForLocale(
  values: string[],
  localeTag: string,
  options?: Intl.ListFormatOptions,
) {
  if (typeof Intl.ListFormat === 'function') {
    try {
      return new Intl.ListFormat(localeTag, options).format(values);
    } catch {
      // A comma-separated fallback is unambiguous and never blocks the UI.
    }
  }
  return values.join(', ');
}

export function formatFileSizeForLocale(bytes: number, localeTag: string) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return `${formatNumberForLocale(0, localeTag)} B`;
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${formatNumberForLocale(value, localeTag, {
    maximumFractionDigits: unitIndex ? 1 : 0,
  })} ${units[unitIndex]}`;
}
