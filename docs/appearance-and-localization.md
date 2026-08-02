# Appearance and localization

Folio follows the device appearance and language by default. Users can override either setting in **Settings → Appearance & Language**. Preferences are stored locally under `folio.ui-preferences.v1`; changing them does not modify a Paperless profile or send anything to the server.

## Theme contract

Use semantic values from `src/constants/theme.ts` for application chrome. Base surfaces, text, borders, muted content, and danger states resolve for light and dark appearance on iOS, Android, and web. Keep document thumbnails and captured document content faithful to their source; theme only the controls and surfaces around them.

The native splash uses one dark, branded surface in both OS modes. This avoids a light native launch frame when a saved Dark override differs from a Light OS setting. The splash remains visible until persisted UI preferences have loaded and the root background has been applied. The shared React provider withholds application descendants during that interval, then publishes the stored theme and locale before their first visible render. System appearance and locale signals continue to update the provider while the app is running.

Avoid literal colors in screens and components. If a new visual role is required, add one semantic token with light and dark values, then use that token at call sites. Text placed on the lime accent uses `palette.black` so it remains legible in either appearance.

Automated contrast checks cover primary, secondary, status, and accent text at WCAG AA (4.5:1), plus visible control boundaries at 3:1, in both themes. React Native font scaling remains enabled. Text-bearing controls use minimum heights, wrapping, and scrollable sheets/screens so larger text can expand instead of being clipped.

## Translation contract

Application copy lives in `src/i18n/catalogs.ts`. English is the source catalog and runtime fallback; German is declared as `Record<TranslationKey, string>`, so TypeScript rejects a missing key. `tests/i18n-theme.test.mjs` also checks key parity, non-empty messages, matching interpolation placeholders, and every registered Folio-owned diagnostic in both runtime catalogs. Unknown Paperless/server messages remain verbatim.

When **System** language is selected, Folio walks the device locale list in the OS-defined preference order and uses the first supported language. If neither English nor German is present, it falls back to English. The matching full language tag (for example, `de-CH` rather than only `de`) drives `Intl` date, time, count, number, list, and file-size formatting.

Use `useI18n()` in React code:

```tsx
const { formatDate, formatNumber, t } = useI18n();

<Text>{t('library.countMany', { count: formatNumber(count) })}</Text>
<Text>{formatDate(timestamp, { dateStyle: 'medium' })}</Text>
```

Use `translateRuntime()` only in non-React runtime code such as authentication, persistent tasks, background sync, updater status, device notifications, and iOS widget snapshots. Headless background work reloads the persisted language before generating user-visible copy. Never translate server content, filenames, document titles, tags, release notes, or error text returned by Paperless: those values are untrusted user/server content and are presented unchanged only where appropriate.

Android widget resources live under `modules/folio-platform/android/src/main/res/values*`. iOS widget snapshots contain only a fixed, catalog-generated label set in addition to the already bounded count/state payload; they never contain profile names, document titles, credentials, or server addresses.

## Adding a language

1. Add the locale to `SupportedLocale`, `LanguagePreference`, and `catalogs`.
2. Add a complete catalog with the same keys and placeholders as English.
3. Add the language control label and option in Settings.
4. Add the locale to the `expo-localization` `supportedLocales` lists in `app.json`.
5. Add `assets/locales/<locale>.json` for the native app name and permission descriptions, then reference it from the top-level `locales` map.
6. Extend the locale-selection tests and run `npm test`, `npm run lint`, `npx tsc --noEmit`, and `npx expo config --type public`.

The implementation targets Expo SDK 57 and should be checked against the exact [Expo localization documentation](https://docs.expo.dev/versions/v57.0.0/sdk/localization/) and [app configuration reference](https://docs.expo.dev/versions/v57.0.0/config/app/) when native locale configuration changes.

## Release verification

Automated checks verify catalog parity, interpolation placeholders, fallback behavior, all registered Folio diagnostic mappings, persisted preference parsing, widget and notification copy, semantic contrast, and the native Expo locale configuration. A stateful React renderer test exercises the same provider and hook used by the app: it rerenders across system light/English and dark/German signals, applies independent user overrides, verifies locale-aware dates/counts/numbers/lists/file sizes, and proves that pre-hydration application content is absent before the stored dark/German state becomes the first visible render. Before release, repeat the following on physical Android and iOS devices because system settings, native widgets, accessibility text scaling, and process restarts cannot be fully simulated by the Node test suite:

1. Start in System appearance/language, switch the OS between light/dark and English/German while Folio is foregrounded, and confirm the visible screen updates without restarting.
2. Select each explicit Folio override, force-quit and relaunch, and confirm the splash transitions directly into the selected theme/language without a mismatched frame.
3. At the largest accessibility text size, navigate every tab and modal, complete profile setup and intake, and verify copy wraps, controls remain reachable, and no required action is clipped.
4. Trigger success/failure notifications and background work in both languages; confirm Folio-owned copy is localized while Paperless-provided error text remains unchanged.
5. Add the inbox widget in both system languages. Confirm protected states reveal no archive data, German Android resources render, iOS labels update after a Folio language change, and Quick Scan still requires the normal authentication gate.
