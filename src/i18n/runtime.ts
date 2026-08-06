import { catalogs, type TranslationKey } from './catalogs.ts';
import { formatListForLocale, formatNumberForLocale } from './core.ts';

type RuntimeLocale = keyof typeof catalogs;
type InterpolationValues = Record<string, string | number>;

// The provider synchronously publishes the resolved system/user locale on
// every render. Keeping this module platform-free also lets persistence and
// validation code run in background/Node contexts without importing native UI
// modules; English is the safe pre-provider fallback.
let runtimeLocale: RuntimeLocale = 'en';
let runtimeLocaleTag = 'en';

function validRuntimeLocaleTag(locale: RuntimeLocale, value: string | undefined): string {
  if (!value) return locale;
  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    return canonical?.toLocaleLowerCase().split('-', 1)[0] === locale ? canonical : locale;
  } catch {
    return locale;
  }
}

export function setRuntimeLocale(locale: RuntimeLocale, localeTag: string = locale) {
  runtimeLocale = locale;
  runtimeLocaleTag = validRuntimeLocaleTag(locale, localeTag);
}

export function translateRuntime(key: TranslationKey, values?: InterpolationValues) {
  const message = catalogs[runtimeLocale][key];
  if (!values) return message;
  return message.replace(/{{(\w+)}}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : placeholder,
  );
}

export function formatRuntimeNumber(value: number, options?: Intl.NumberFormatOptions) {
  return formatNumberForLocale(value, runtimeLocaleTag, options);
}

export function formatRuntimeList(values: string[], options?: Intl.ListFormatOptions) {
  return formatListForLocale(values, runtimeLocaleTag, options);
}
