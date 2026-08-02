import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createElement, useCallback, useState } from 'react';
import { act, create } from 'react-test-renderer';

import { de, en } from '../src/i18n/catalogs.ts';
import {
  formatFileSizeForLocale,
  resolveColorScheme,
  resolveSupportedLocale,
  translate,
} from '../src/i18n/core.ts';
import { parseStoredUiPreferences } from '../src/i18n/preferences-policy.ts';
import { I18nRenderProvider, useI18n } from '../src/i18n/react-provider.ts';
import {
  formatRuntimeList,
  formatRuntimeNumber,
  setRuntimeLocale,
  translateRuntime,
} from '../src/i18n/runtime.ts';
import { themeHex } from '../src/constants/theme-colors.ts';
import { presentAuthError } from '../src/lib/auth/error-presentation.ts';
import {
  folioDiagnosticKeys,
  presentRuntimeMessage,
} from '../src/i18n/error-presentation.ts';
import { createNotificationContent } from '../src/lib/platform-notifications.ts';
import { createWidgetLabels } from '../src/lib/widget-privacy.ts';

const require = createRequire(import.meta.url);
const fixedNow = new Date('2026-08-02T10:15:00.000Z');
const englishLocales = [{ languageCode: 'en', languageTag: 'en-US' }];
const germanLocales = [{ languageCode: 'de', languageTag: 'de-DE' }];
const swissGermanLocales = [{ languageCode: 'de', languageTag: 'de-CH' }];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function I18nProbe() {
  const context = useI18n();
  return createElement(
    'folio-i18n-probe',
    {
      appearance: context.appearance,
      colorScheme: context.colorScheme,
      date: context.formatDate(fixedNow, { dateStyle: 'medium', timeZone: 'UTC' }),
      documentDate: context.formatDocumentDate(fixedNow),
      fileSize: context.formatFileSize(1.5 * 1024 * 1024),
      language: context.language,
      list: context.formatList(['Alpha', 'Beta', 'Gamma']),
      locale: context.locale,
      localeTag: context.localeTag,
      navigationLabel: context.t('nav.library'),
      number: context.formatNumber(12_345.6),
      runtimeDiagnostic: translateRuntime('syncStatus.error'),
      runtimeList: formatRuntimeList(['Alpha', 'Beta', 'Gamma']),
      runtimeNumber: formatRuntimeNumber(12_345.6),
      setAppearance: context.setAppearance,
      setLanguage: context.setLanguage,
    },
    context.t('home.taskCenterSummary', {
      active: context.formatNumber(12_345),
      failed: context.formatNumber(2),
    }),
  );
}

function StatefulI18nHarness({ systemLocales, systemScheme }) {
  const [settings, setSettings] = useState({ appearance: 'system', language: 'system' });
  const setAppearance = useCallback(async (appearance) => {
    setSettings((current) => ({ ...current, appearance }));
  }, []);
  const setLanguage = useCallback(async (language) => {
    setSettings((current) => ({ ...current, language }));
  }, []);
  return createElement(
    I18nRenderProvider,
    {
      now: () => fixedNow,
      ready: true,
      settings,
      setAppearance,
      setLanguage,
      systemLocales,
      systemScheme,
    },
    createElement(I18nProbe),
  );
}

function StartupI18nHarness({ ready, settings }) {
  return createElement(
    I18nRenderProvider,
    {
      now: () => fixedNow,
      ready,
      settings,
      setAppearance: async () => {},
      setLanguage: async () => {},
      systemLocales: englishLocales,
      systemScheme: 'light',
    },
    createElement(I18nProbe),
  );
}

function placeholders(message) {
  return [...message.matchAll(/{{(\w+)}}/g)].map((match) => match[1]).sort();
}

test('German and English catalogs have the same non-empty keys and placeholders', () => {
  assert.deepEqual(Object.keys(de).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) {
    assert.ok(en[key].trim(), `${key} is empty in English`);
    assert.ok(de[key].trim(), `${key} is empty in German`);
    assert.deepEqual(
      placeholders(de[key]),
      placeholders(en[key]),
      `${key} uses different interpolation placeholders`,
    );
  }
});

test('offline queue and coordinator fallbacks are localized in both catalogs', () => {
  assert.equal(en['taskRuntime.syncFailed'], 'Workspace synchronization failed.');
  assert.equal(de['taskRuntime.syncFailed'], 'Die Arbeitsbereichssynchronisierung ist fehlgeschlagen.');
  assert.match(en['appError.offlineMetadataMissing'], /filename and file type/);
  assert.match(de['appError.offlineMetadataMissing'], /Dateinamen und Dateityp/);
});

test('system locale selection falls back to English and honors German preferences', () => {
  assert.equal(resolveSupportedLocale('system', ['fr', 'it']), 'en');
  assert.equal(resolveSupportedLocale('system', ['fr', 'de']), 'de');
  assert.equal(resolveSupportedLocale('system', ['fr', 'en', 'de']), 'en');
  assert.equal(resolveSupportedLocale('system', ['fr', 'de', 'en']), 'de');
  assert.equal(resolveSupportedLocale('system', ['de-CH']), 'de');
  assert.equal(resolveSupportedLocale('en', ['de']), 'en');
  assert.equal(resolveSupportedLocale('de', ['en']), 'de');
});

test('representative screen copy interpolates in both supported languages', () => {
  assert.equal(
    translate('en', 'home.taskCenterSummary', { active: 3, failed: 1 }),
    '3 active · 1 failed',
  );
  assert.equal(
    translate('de', 'viewer.pageOf', { page: 2, count: 12 }),
    'Seite 2 von 12',
  );
  assert.equal(
    translate('de', 'detail.openPreviewOf', { title: 'Rechnung' }),
    'Vollständige Vorschau von Rechnung öffnen',
  );
});

test('the real provider reactively follows system theme and locale, then honors independent overrides', async () => {
  let renderer;
  await act(async () => {
    renderer = create(createElement(StatefulI18nHarness, {
      systemLocales: englishLocales,
      systemScheme: 'light',
    }));
  });

  let probe = renderer.root.findByType('folio-i18n-probe');
  assert.equal(probe.props.colorScheme, 'light');
  assert.equal(probe.props.locale, 'en');
  assert.equal(probe.props.localeTag, 'en-US');
  assert.equal(probe.props.navigationLabel, 'Library');
  assert.equal(probe.props.runtimeDiagnostic, 'Sync failed · no synchronized cache yet');
  assert.equal(probe.props.runtimeNumber, new Intl.NumberFormat('en-US').format(12_345.6));
  assert.equal(
    probe.props.runtimeList,
    new Intl.ListFormat('en-US').format(['Alpha', 'Beta', 'Gamma']),
  );
  assert.equal(probe.props.number, new Intl.NumberFormat('en-US').format(12_345.6));
  assert.equal(
    probe.props.date,
    new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(fixedNow),
  );
  assert.match(probe.props.documentDate, /^Today, /);
  assert.equal(probe.props.list, new Intl.ListFormat('en-US').format(['Alpha', 'Beta', 'Gamma']));
  assert.equal(probe.props.fileSize, '1.5 MB');
  assert.match(probe.children.join(''), /12,345 active · 2 failed/);

  await act(async () => {
    renderer.update(createElement(StatefulI18nHarness, {
      systemLocales: germanLocales,
      systemScheme: 'dark',
    }));
  });
  probe = renderer.root.findByType('folio-i18n-probe');
  assert.equal(probe.props.colorScheme, 'dark');
  assert.equal(probe.props.locale, 'de');
  assert.equal(probe.props.localeTag, 'de-DE');
  assert.equal(probe.props.navigationLabel, 'Bibliothek');
  assert.equal(
    probe.props.runtimeDiagnostic,
    'Synchronisierung fehlgeschlagen · noch kein synchronisierter Cache',
  );
  assert.equal(probe.props.runtimeNumber, new Intl.NumberFormat('de-DE').format(12_345.6));
  assert.equal(
    probe.props.runtimeList,
    new Intl.ListFormat('de-DE').format(['Alpha', 'Beta', 'Gamma']),
  );
  assert.equal(probe.props.number, new Intl.NumberFormat('de-DE').format(12_345.6));
  assert.equal(
    probe.props.date,
    new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeZone: 'UTC' }).format(fixedNow),
  );
  assert.match(probe.props.documentDate, /^Heute, /);
  assert.equal(probe.props.list, new Intl.ListFormat('de-DE').format(['Alpha', 'Beta', 'Gamma']));
  assert.equal(probe.props.fileSize, '1,5 MB');
  assert.match(probe.children.join(''), /12\.345 aktiv · 2 fehlgeschlagen/);

  await act(async () => {
    renderer.update(createElement(StatefulI18nHarness, {
      systemLocales: swissGermanLocales,
      systemScheme: 'dark',
    }));
  });
  probe = renderer.root.findByType('folio-i18n-probe');
  assert.equal(probe.props.locale, 'de');
  assert.equal(probe.props.localeTag, 'de-CH');
  assert.equal(probe.props.runtimeNumber, new Intl.NumberFormat('de-CH').format(12_345.6));
  assert.equal(
    probe.props.runtimeList,
    new Intl.ListFormat('de-CH').format(['Alpha', 'Beta', 'Gamma']),
  );

  await act(async () => {
    await probe.props.setAppearance('light');
    await probe.props.setLanguage('en');
  });
  probe = renderer.root.findByType('folio-i18n-probe');
  assert.equal(probe.props.appearance, 'light');
  assert.equal(probe.props.language, 'en');
  assert.equal(probe.props.colorScheme, 'light');
  assert.equal(probe.props.locale, 'en');

  await act(async () => {
    renderer.update(createElement(StatefulI18nHarness, {
      systemLocales: germanLocales,
      systemScheme: 'dark',
    }));
  });
  probe = renderer.root.findByType('folio-i18n-probe');
  assert.equal(probe.props.colorScheme, 'light');
  assert.equal(probe.props.locale, 'en');

  await act(async () => renderer.unmount());
});

test('appearance resolution covers system, light, and dark rendering modes', () => {
  assert.equal(resolveColorScheme('system', 'dark'), 'dark');
  assert.equal(resolveColorScheme('system', null), 'light');
  assert.equal(resolveColorScheme('light', 'dark'), 'light');
  assert.equal(resolveColorScheme('dark', 'light'), 'dark');
});

test('stored appearance and language survive restart and corrupt values fail safe', () => {
  assert.deepEqual(parseStoredUiPreferences('{"appearance":"dark","language":"de"}'), {
    appearance: 'dark',
    language: 'de',
  });
  assert.deepEqual(parseStoredUiPreferences('{"appearance":"sepia","language":"fr"}'), {
    appearance: 'system',
    language: 'system',
  });
  assert.deepEqual(parseStoredUiPreferences('{'), {
    appearance: 'system',
    language: 'system',
  });
});

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(left, right) {
  const [bright, dark] = [relativeLuminance(left), relativeLuminance(right)].sort((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
}

test('semantic accent surfaces retain WCAG AA text contrast in both themes', () => {
  for (const mode of ['light', 'dark']) {
    for (const accent of ['mint', 'apricot', 'lavender', 'sky', 'rose']) {
      assert.ok(
        contrast(themeHex[mode].ink, themeHex[mode][accent]) >= 4.5,
        `${mode} ink on ${accent} must retain 4.5:1 contrast`,
      );
    }
  }
});

test('semantic application surfaces, statuses, and control boundaries retain AA contrast', () => {
  for (const mode of ['light', 'dark']) {
    for (const surface of ['canvas', 'paper', 'paperStrong']) {
      assert.ok(contrast(themeHex[mode].ink, themeHex[mode][surface]) >= 4.5);
    }
    for (const surface of ['canvas', 'paper']) {
      assert.ok(contrast(themeHex[mode].muted, themeHex[mode][surface]) >= 4.5);
    }
    assert.ok(contrast(themeHex[mode].faint, themeHex[mode].paper) >= 4.5);
    assert.ok(contrast(themeHex[mode].danger, themeHex[mode].dangerSurface) >= 4.5);
    assert.ok(contrast(themeHex[mode].limeDark, themeHex[mode].limeSurface) >= 4.5);
    assert.ok(
      contrast(themeHex[mode].lineStrong, themeHex[mode].paper) >= 3,
      `${mode} control boundary must retain 3:1 non-text contrast`,
    );
  }
});

test('Android semantic colors have exact light and night resources', async () => {
  const integrations = require('../plugins/withFolioPlatformIntegrations.js');
  const themeSource = await readFile(new URL('../src/constants/theme.ts', import.meta.url), 'utf8');
  assert.match(themeSource, /PlatformColor\(`@color\/folio_\$\{name\.replaceAll\('-', '_'\)\}`\)/);
  assert.doesNotMatch(themeSource, /\?(?:android:)?attr\//);

  for (const mode of ['light', 'dark']) {
    const expected = Object.fromEntries(Object.entries(integrations.ANDROID_THEME_COLORS[mode])
      .map(([name, value]) => [name.replaceAll('_', ''), value]));
    const actual = Object.fromEntries([
      'canvas', 'paper', 'paperStrong', 'ink', 'inkSoft', 'muted', 'faint', 'line',
      'lineStrong', 'lime', 'limeSurface', 'limeDark', 'mint', 'apricot', 'lavender',
      'sky', 'rose', 'danger', 'dangerSurface', 'viewerSurface',
    ].map((name) => [name.replaceAll('_', '').toLocaleLowerCase(), themeHex[mode][name]]));
    assert.deepEqual(
      Object.fromEntries(Object.entries(expected).map(([name, value]) => [name.toLocaleLowerCase(), value])),
      actual,
    );
    const xml = integrations.createAndroidThemeColorsXml(integrations.ANDROID_THEME_COLORS[mode]);
    for (const [name, value] of Object.entries(integrations.ANDROID_THEME_COLORS[mode])) {
      assert.match(xml, new RegExp(`<color name="folio_${name}">${value}</color>`));
    }
  }
});

test('known Folio authentication errors localize while unknown server text stays unchanged', () => {
  setRuntimeLocale('de');
  assert.equal(
    presentAuthError(Object.assign(new Error('English implementation detail'), { code: 'otp-required' })),
    'Dieses Paperless-Konto benötigt einen Einmalcode.',
  );
  assert.equal(
    presentAuthError(Object.assign(new Error('English headless detail'), { code: 'headless-unavailable' })),
    'Dieser Paperless-Server unterstützt keine OIDC-Anmeldung für Apps. Verwende ein API-Token oder aktualisiere Paperless.',
  );
  assert.equal(presentAuthError(new Error('Paperless custom policy response')), 'Paperless custom policy response');
  setRuntimeLocale('en');
});

test('known Folio service diagnostics localize while Paperless text stays unchanged', () => {
  setRuntimeLocale('de');
  const diagnostics = [
    [
      'Paperless returned a malformed PDF preview.',
      'Paperless hat eine fehlerhafte PDF-Vorschau zurückgegeben.',
    ],
    [
      'The connection profile changed during upload reconciliation.',
      'Das Verbindungsprofil hat sich während des Upload-Abgleichs geändert.',
    ],
    [
      'The connection profile changed before the bulk operation started.',
      'Das Verbindungsprofil hat sich vor Beginn der Sammelaktion geändert.',
    ],
    [
      'The selected representation could not be downloaded.',
      'Die ausgewählte Darstellung konnte nicht geladen werden.',
    ],
    [
      'The system share sheet could not be opened.',
      'Das Teilen-Menü des Systems konnte nicht geöffnet werden.',
    ],
    [
      'Paperless is still processing this document. Pull to refresh in a moment.',
      'Paperless verarbeitet dieses Dokument noch. Aktualisiere die Ansicht in Kürze.',
    ],
    [
      'This document is still processing in Paperless. Wait until it is ready before making changes.',
      'Dieses Dokument wird noch in Paperless verarbeitet. Warte, bis es bereit ist, bevor du Änderungen vornimmst.',
    ],
    [
      'The active profile has no cached workspace for bulk reconciliation.',
      'Das aktive Profil hat keinen zwischengespeicherten Arbeitsbereich für den Sammelabgleich.',
    ],
  ];
  for (const [message, expected] of diagnostics) {
    assert.equal(presentRuntimeMessage(message), expected);
  }
  assert.equal(
    translate('de', 'fileActions.shareDialogTitle', { filename: 'Q3_report.pdf' }),
    'Q3_report.pdf teilen',
  );
  assert.equal(
    translate('de', 'fileActions.saveDialogTitle', { filename: 'Q3_report.pdf' }),
    'Q3_report.pdf speichern',
  );
  assert.equal(
    presentRuntimeMessage('Suggestion exceeds 128 characters.'),
    'Der Vorschlag überschreitet 128 Zeichen.',
  );
  assert.equal(
    presentRuntimeMessage('Parent tag 42 is not visible in this response.'),
    'Das übergeordnete Schlagwort 42 ist in dieser Antwort nicht sichtbar.',
  );
  assert.equal(
    presentRuntimeMessage('Correspondent suggestions 7, 9 are not visible to this account and cannot be accepted.'),
    'Vorschläge für Korrespondenzpartner 7, 9 sind für dieses Konto nicht sichtbar und können nicht akzeptiert werden.',
  );
  assert.equal(
    presentRuntimeMessage('The document download failed with status 403.'),
    'Der Dokumentdownload ist mit Status 403 fehlgeschlagen.',
  );
  assert.equal(
    presentRuntimeMessage('Document type name must be text.'),
    'Dokumenttypname muss Text enthalten.',
  );
  assert.equal(
    presentRuntimeMessage('This saved view uses unsupported Paperless rule 42; Folio refused to show broader results.'),
    'Diese gespeicherte Ansicht verwendet die nicht unterstützte Paperless-Regel 42; Folio hat es abgelehnt, umfassendere Ergebnisse anzuzeigen.',
  );
  assert.equal(
    presentRuntimeMessage('Paperless administrator-defined response'),
    'Paperless administrator-defined response',
  );
  setRuntimeLocale('en');
});

test('every registered Folio-owned diagnostic resolves through both complete catalogs', () => {
  assert.ok(Object.keys(folioDiagnosticKeys).length >= 100);
  for (const locale of ['en', 'de']) {
    setRuntimeLocale(locale);
    for (const [diagnostic, key] of Object.entries(folioDiagnosticKeys)) {
      const expected = translate(locale, key);
      assert.ok(expected.trim(), `${locale} ${key} must not be empty`);
      assert.equal(
        presentRuntimeMessage(diagnostic),
        expected,
        `${locale} does not present ${key} through the active runtime catalog`,
      );
    }
  }
  setRuntimeLocale('en');
});

test('app-generated notification copy follows the active locale', () => {
  setRuntimeLocale('de');
  const notification = createNotificationContent({
    kind: 'inbox',
    profileId: 'profile-one',
    inboxCount: 12,
    issuedAt: '2026-08-02T10:00:00.000Z',
  }, 'document-title');
  assert.equal(notification.title, 'Eingang aktualisiert');
  assert.equal(notification.body, '12 Elemente in deinem Eingang.');
  setRuntimeLocale('en');
});

test('privacy-bounded iOS widget labels follow the active locale', () => {
  setRuntimeLocale('de');
  assert.deepEqual(createWidgetLabels(), {
    locked: 'Gesperrt',
    inbox: 'Eingang',
    openScan: 'Folio öffnen · Schnellscan',
    inboxItem: 'Eingangselement · Schnellscan',
    inboxItems: 'Eingangselemente · Schnellscan',
  });
  setRuntimeLocale('en');
});

test('Android widget resources have complete English and German label parity', async () => {
  const paths = ['values', 'values-de'].map((directory) =>
    new URL(`../modules/folio-platform/android/src/main/res/${directory}/folio_widget_strings.xml`, import.meta.url));
  const [english, german] = await Promise.all(paths.map((path) => readFile(path, 'utf8')));
  const names = (source) => [...source.matchAll(/<string name="([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(names(german), names(english));
  assert.match(german, /Gesperrt/);
  assert.match(german, /Schnellscan/);
});

test('Android widget copy remains visible under large text and longer translations', async () => {
  const layout = await readFile(
    new URL('../modules/folio-platform/android/src/main/res/layout/folio_inbox_widget.xml', import.meta.url),
    'utf8',
  );
  for (const id of ['folio_widget_primary', 'folio_widget_secondary']) {
    const field = layout.match(new RegExp(`<TextView\\s+android:id="@\\+id/${id}"[\\s\\S]*?\\/>`))?.[0] ?? '';
    assert.match(field, /android:layout_width="match_parent"/);
    assert.match(field, /android:autoSizeTextType="uniform"/);
    assert.match(field, /android:maxLines="2"/);
    assert.doesNotMatch(field, /android:maxLines="1"/);
  }
});

test('native shortcut and widget metadata have complete English and German catalogs', async () => {
  const [english, german] = await Promise.all(
    ['en', 'de'].map((locale) => readFile(
      new URL(`../assets/locales/${locale}.json`, import.meta.url),
      'utf8',
    ).then(JSON.parse)),
  );
  for (const platform of ['ios', 'android']) {
    assert.deepEqual(Object.keys(german[platform]).sort(), Object.keys(english[platform]).sort());
  }
  assert.deepEqual(
    Object.keys(german.ios['Localizable.strings']).sort(),
    Object.keys(english.ios['Localizable.strings']).sort(),
  );
  assert.equal(german.android.folio_quick_scan_short, 'Schnellscan');
  assert.equal(german.ios['Localizable.strings'].folio_search_long, 'Dokumente durchsuchen');
  assert.equal(german.ios['Localizable.strings'].folio_widget_display_name, 'Folio-Eingang');
  const integrations = require('../plugins/withFolioPlatformIntegrations.js');
  const appleStrings = integrations.createAppleStringsFile(
    german.ios['Localizable.strings'],
  );
  assert.match(appleStrings, /"folio_widget_display_name" = "Folio-Eingang";/);
  assert.match(appleStrings, /"folio_quick_scan_short" = "Schnellscan";/);
});

test('high-risk presentation paths do not regress to known hard-coded English copy', async () => {
  const paths = [
    '../src/app/intake.tsx',
    '../src/components/choice-sheet.tsx',
    '../src/components/document-pdf-merge-selection.tsx',
    '../src/components/library-filter-sheet.tsx',
    '../src/lib/platform-notifications.ts',
    '../src/context/update-context.tsx',
    '../src/context/app-context.tsx',
    '../src/lib/bulk-document-controller.ts',
    '../src/lib/document-platform-actions.ts',
    '../src/lib/paperless.ts',
  ];
  const sources = await Promise.all(paths.map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
  const source = sources.join('\n');
  for (const literal of [
    ' · Inherited:',
    ' · Manual overrides:',
    "'Inbox tag'",
    "'Import complete'",
    "'Sync complete'",
    "'The update could not be completed. Try again.'",
    "'The connection profile changed during upload reconciliation.'",
    "'The connection profile changed before upload.'",
    "'The connection profile changed before task polling.'",
    "'The connection profile changed before the bulk operation started.'",
    "'The connection profile changed before the bulk retry.'",
    "'The selected representation could not be downloaded.'",
    "'The system share sheet could not be opened.'",
    "'Paperless is still processing this document. Pull to refresh in a moment.'",
    "'Paperless did not return a document thumbnail.'",
  ]) {
    assert.equal(source.includes(literal), false, `presentation source contains ${literal}`);
  }
});

test('human-facing counts and page numbers flow through the active locale formatter', async () => {
  const paths = [
    '../src/components/bulk-action-sheet.tsx',
    '../src/app/saved-views.tsx',
    '../src/app/paperless-metadata.tsx',
    '../src/components/document-card.tsx',
    '../src/components/saved-view-editor-sheet.tsx',
    '../src/app/inbox.tsx',
    '../src/components/document-pdf-page-editor.tsx',
  ];
  const source = (await Promise.all(
    paths.map((path) => readFile(new URL(path, import.meta.url), 'utf8')),
  )).join('\n');
  for (const unformatted of [
    'count: selection.selected',
    'count: result.succeeded.length',
    'count: result.pending.length',
    'count: result.failed.length',
    'count: result.skipped.length',
    'count: view.filterRules.length',
    'count: item.documentCount',
    'count: document.duplicateDocumentIds.length',
    'count: activeDocument.duplicateDocumentIds.length',
    'count: initialPresentation.displayFieldCount',
    'page: item.sourcePage',
    'document: outputDocument',
  ]) {
    assert.equal(source.includes(unformatted), false, `presentation source contains ${unformatted}`);
  }
  const germanCount = new Intl.NumberFormat('de').format(12_345);
  assert.equal(translate('de', 'bulk.selection', { count: germanCount }), '12.345 ausgewählt');
  assert.equal(
    translate('de', 'metadata.usageCount', { count: germanCount }),
    'Dieser Eintrag wird derzeit von 12.345 Dokumenten verwendet.',
  );
});

test('stored appearance and locale are the first visible provider render before splash hiding', async () => {
  let renderer;
  await act(async () => {
    renderer = create(createElement(StartupI18nHarness, {
      ready: false,
      settings: { appearance: 'system', language: 'system' },
    }));
  });
  assert.equal(renderer.toJSON(), null, 'pre-hydration application content must stay hidden');

  await act(async () => {
    renderer.update(createElement(StartupI18nHarness, {
      ready: true,
      settings: { appearance: 'dark', language: 'de' },
    }));
  });
  const firstVisibleProbe = renderer.root.findByType('folio-i18n-probe');
  assert.equal(firstVisibleProbe.props.colorScheme, 'dark');
  assert.equal(firstVisibleProbe.props.locale, 'de');
  assert.equal(firstVisibleProbe.props.navigationLabel, 'Bibliothek');
  assert.equal(
    firstVisibleProbe.props.runtimeDiagnostic,
    'Synchronisierung fehlgeschlagen · noch kein synchronisierter Cache',
  );
  await act(async () => renderer.unmount());

  const providerSource = await readFile(
    new URL('../src/context/ui-preferences-context.tsx', import.meta.url),
    'utf8',
  );
  const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const applyStoredAppearance = providerSource.indexOf('await applyNativeAppearance(stored)');
  const publishReadyPreferences = providerSource.indexOf(
    'setHydratedSettings(stored)',
    applyStoredAppearance,
  );
  assert.ok(applyStoredAppearance >= 0);
  assert.ok(publishReadyPreferences > applyStoredAppearance);
  assert.match(providerSource, /useState<UISettings \| null>\(loadInitialSettings\)/);
  assert.match(providerSource, /useLayoutEffect\(\(\) => \{[\s\S]*dataset\.folioTheme/);
  assert.match(appSource, /SplashScreen\.preventAutoHideAsync\(\)/);
  assert.match(appSource, /if \(ready\) SplashScreen\.hide\(\)/);
});

test('file sizes use locale-aware decimal separators', () => {
  assert.equal(formatFileSizeForLocale(1.5 * 1024 * 1024, 'en'), '1.5 MB');
  assert.equal(formatFileSizeForLocale(1.5 * 1024 * 1024, 'de'), '1,5 MB');
});

test('remote document details retain raw bytes for locale-aware file-size display', async () => {
  const paperlessSource = await readFile(
    new URL('../src/lib/paperless.ts', import.meta.url),
    'utf8',
  );
  const detailSource = await readFile(
    new URL('../src/app/document/[id].tsx', import.meta.url),
    'utf8',
  );
  assert.match(paperlessSource, /\.\.\.\(fileSizeBytes \? \{ fileSizeBytes \} : \{\}\)/);
  assert.match(detailSource, /formatFileSize\(document\.fileSizeBytes\)/);
});

test('Expo config declares automatic appearance, native locales, and incoming share support', async () => {
  const staticConfig = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8')).expo;
  const dynamicConfig = require('../app.config.js')();
  const pluginNames = dynamicConfig.plugins.map((plugin) => Array.isArray(plugin) ? plugin[0] : plugin);
  const sharing = dynamicConfig.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-sharing',
  );
  const splash = dynamicConfig.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen',
  );
  const widgets = dynamicConfig.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-widgets',
  );

  assert.equal(staticConfig.userInterfaceStyle, 'automatic');
  assert.equal(staticConfig.ios.infoPlist.CFBundleAllowMixedLocalizations, true);
  assert.deepEqual(Object.keys(staticConfig.locales).sort(), ['de', 'en']);
  assert.ok(pluginNames.includes('expo-localization'));
  assert.ok(pluginNames.includes('expo-system-ui'));
  assert.ok(pluginNames.includes('expo-sqlite'));
  assert.ok(pluginNames.includes('expo-background-task'));
  assert.ok(pluginNames.includes('expo-widgets'));
  // A theme-neutral dark brand splash avoids a light launch frame when the
  // saved Folio override is Dark but the OS itself is Light. React content is
  // still withheld until the exact persisted theme has been restored.
  assert.equal(splash[1].backgroundColor, themeHex.dark.canvas);
  assert.equal(splash[1].dark.backgroundColor, themeHex.dark.canvas);
  assert.equal(sharing[1].ios.activationRule.supportsFileWithMaxCount, 20);
  assert.equal(sharing[1].ios.activationRule.supportsImageWithMaxCount, 20);
  assert.equal(sharing[1].ios.activationRule.supportsText, true);
  assert.deepEqual(sharing[1].android.singleShareMimeTypes, sharing[1].android.multipleShareMimeTypes);
  assert.ok(sharing[1].android.singleShareMimeTypes.includes('text/plain'));
  assert.equal(widgets[1].widgets[0].displayName, 'folio_widget_display_name');
  assert.equal(widgets[1].widgets[0].description, 'folio_widget_description');
});
