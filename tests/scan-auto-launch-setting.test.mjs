import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const scanSource = readFileSync(new URL('../src/app/scan.tsx', import.meta.url), 'utf8');
const contextSource = readFileSync(new URL('../src/context/app-context.tsx', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('../src/app/settings.tsx', import.meta.url), 'utf8');
const catalogs = readFileSync(new URL('../src/i18n/catalogs.ts', import.meta.url), 'utf8');

test('the scan screen only auto-launches the scanner when the preference allows it', () => {
  assert.match(
    scanSource,
    /\|\| autoLaunchRef\.current\s*\n\s*\|\| isBootstrapping\s*\n\s*\|\| !preferences\.autoLaunchScanner\s*\n\s*\|\| profiles\.length > 1/,
  );
  assert.match(scanSource, /\[isBootstrapping, preferences\.autoLaunchScanner, profiles\.length, startSmartScan\]/);
});

test('the preference defaults to the historical behaviour and has a settings row on Android', () => {
  assert.match(contextSource, /autoLaunchScanner: true,/);
  assert.match(settingsSource, /Platform\.OS === 'android' && \(\s*\n\s*<SettingRow\s*\n\s*icon=\{ScanLine\}/);
  assert.match(settingsSource, /togglePreference\('autoLaunchScanner', value\)/);
  for (const key of ['settings.autoLaunchScannerTitle', 'settings.autoLaunchScannerSubtitle']) {
    assert.equal(catalogs.split(`'${key}':`).length - 1, 2, `${key} present in en and de`);
  }
});
