import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  type PropsWithChildren,
} from 'react';

import type { TranslationKey } from './catalogs.ts';
import {
  formatFileSizeForLocale,
  resolveColorScheme,
  resolveLocaleTag,
  resolveSupportedLocale,
  translate,
  type AppearancePreference,
  type InterpolationValues,
  type LanguagePreference,
  type LocaleDescriptor,
  type SupportedLocale,
} from './core.ts';
import type { StoredUiPreferences } from './preferences-policy.ts';
import { setRuntimeLocale } from './runtime.ts';

export type UIContextValue = StoredUiPreferences & {
  ready: boolean;
  locale: SupportedLocale;
  localeTag: string;
  colorScheme: 'light' | 'dark';
  nativePaletteKey: string;
  setAppearance: (appearance: AppearancePreference) => Promise<void>;
  setLanguage: (language: LanguagePreference) => Promise<void>;
  t: (key: TranslationKey, values?: InterpolationValues) => string;
  formatDate: (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;
  formatDocumentDate: (value: Date | string | number) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatList: (values: string[], options?: Intl.ListFormatOptions) => string;
  formatFileSize: (bytes: number) => string;
};

type I18nRenderProviderProps = PropsWithChildren<{
  ready: boolean;
  settings: StoredUiPreferences;
  systemLocales: readonly LocaleDescriptor[];
  systemScheme: 'light' | 'dark' | 'unspecified' | null | undefined;
  nativePaletteRemountEnabled?: boolean;
  setAppearance: UIContextValue['setAppearance'];
  setLanguage: UIContextValue['setLanguage'];
  now?: () => Date;
}>;

const UIContext = createContext<UIContextValue | null>(null);
const currentDate = () => new Date();

/**
 * Platform-free React provider shared by the native persistence wrapper and
 * component tests. Children remain hidden until persisted settings are ready,
 * so no default-language or default-theme application frame can be shown.
 */
export function I18nRenderProvider({
  children,
  nativePaletteRemountEnabled = false,
  now = currentDate,
  ready,
  settings,
  setAppearance,
  setLanguage,
  systemLocales,
  systemScheme,
}: I18nRenderProviderProps) {
  const locale = resolveSupportedLocale(
    settings.language,
    systemLocales.map((entry) => entry.languageCode),
  );
  const localeTag = resolveLocaleTag(locale, systemLocales);
  const colorScheme = resolveColorScheme(settings.appearance, systemScheme);
  const nativePaletteKey = nativePaletteRemountEnabled
    ? colorScheme
    : 'static';

  // Runtime/background presenters must observe the same locale before any
  // newly visible descendant can create user-facing copy during this render.
  setRuntimeLocale(locale, localeTag);

  const t = useCallback(
    (key: TranslationKey, values?: InterpolationValues) => translate(locale, key, values),
    [locale],
  );
  const formatDate = useCallback(
    (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => {
      const date = value instanceof Date ? value : new Date(value);
      return Number.isNaN(date.getTime())
        ? String(value)
        : new Intl.DateTimeFormat(localeTag, options).format(date);
    },
    [localeTag],
  );
  const formatNumber = useCallback(
    (value: number, options?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat(localeTag, options).format(value),
    [localeTag],
  );
  const formatDocumentDate = useCallback((value: Date | string | number) => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const today = now();
    if (
      date.getFullYear() === today.getFullYear()
      && date.getMonth() === today.getMonth()
      && date.getDate() === today.getDate()
    ) {
      return t('common.todayAt', {
        time: new Intl.DateTimeFormat(localeTag, {
          hour: '2-digit',
          minute: '2-digit',
        }).format(date),
      });
    }
    return new Intl.DateTimeFormat(localeTag, {
      day: '2-digit',
      month: 'short',
      ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
    }).format(date);
  }, [localeTag, now, t]);
  const formatList = useCallback(
    (values: string[], options?: Intl.ListFormatOptions) =>
      new Intl.ListFormat(localeTag, options).format(values),
    [localeTag],
  );
  const formatFileSize = useCallback(
    (bytes: number) => formatFileSizeForLocale(bytes, localeTag),
    [localeTag],
  );

  const value = useMemo<UIContextValue>(() => {
    // System-mode changes still republish after the native useColorScheme
    // signal so semantic color consumers observe the updated OS appearance.
    void systemScheme;
    return {
      ...settings,
      ready,
      locale,
      localeTag,
      colorScheme,
      nativePaletteKey,
      setAppearance,
      setLanguage,
      t,
      formatDate,
      formatDocumentDate,
      formatNumber,
      formatList,
      formatFileSize,
    };
  }, [
    colorScheme,
    formatDate,
    formatDocumentDate,
    formatFileSize,
    formatList,
    formatNumber,
    locale,
    localeTag,
    nativePaletteKey,
    ready,
    setAppearance,
    setLanguage,
    settings,
    systemScheme,
    t,
  ]);

  return createElement(UIContext.Provider, { value }, ready ? children : null);
}

export function useI18n() {
  const context = useContext(UIContext);
  if (!context) throw new Error('useI18n must be used inside I18nProvider');
  return context;
}
