import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  DEFAULT_SCAN_ENGINE_PREFERENCE,
  SCAN_ENGINE_PREFERENCES,
  chooseScanEngine,
  isScanEnginePreference,
  supportsFairScan,
} from '../src/lib/scan-engine.ts';
import {
  FAIRSCAN_FDROID_URL,
  FAIRSCAN_INTENT_ACTION,
  FAIRSCAN_PACKAGE_NAME,
  FAIRSCAN_UNAVAILABLE_CODE,
  isFairScanUnavailableRejection,
  parseFairScanResult,
} from '../src/lib/fairscan-contract.ts';

const require = createRequire(import.meta.url);
const platformPlugin = require('../plugins/withFolioPlatformIntegrations.js');

function decide(overrides) {
  return chooseScanEngine({
    platform: 'android',
    preference: 'auto',
    fairScanAvailable: false,
    builtInAvailable: false,
    ...overrides,
  });
}

test('automatic prefers FairScan so a scan needs no Google Play Services', () => {
  assert.deepEqual(
    decide({ fairScanAvailable: true, builtInAvailable: true }),
    { engine: 'fairscan' },
  );
});

test('automatic falls back to the built-in scanner when FairScan is absent', () => {
  assert.deepEqual(decide({ builtInAvailable: true }), { engine: 'builtin' });
});

test('automatic leaves the camera and the file picker when no engine answers', () => {
  assert.deepEqual(decide({}), { engine: null, reason: 'no-scan-engine' });
});

test('an explicit FairScan choice never falls back silently', () => {
  assert.deepEqual(
    decide({ preference: 'fairscan', builtInAvailable: true }),
    { engine: null, reason: 'fairscan-not-installed' },
  );
  assert.deepEqual(
    decide({ preference: 'fairscan', fairScanAvailable: true }),
    { engine: 'fairscan' },
  );
});

test('an explicit built-in choice ignores an installed FairScan', () => {
  assert.deepEqual(
    decide({ preference: 'builtin', fairScanAvailable: true, builtInAvailable: true }),
    { engine: 'builtin' },
  );
  assert.deepEqual(
    decide({ preference: 'builtin', fairScanAvailable: true }),
    { engine: null, reason: 'no-scan-engine' },
  );
});

test('FairScan is never chosen off Android, even when the preference asks for it', () => {
  assert.equal(supportsFairScan('ios'), false);
  assert.equal(supportsFairScan('web'), false);
  assert.equal(supportsFairScan('android'), true);
  assert.deepEqual(
    decide({ platform: 'ios', preference: 'auto', fairScanAvailable: true, builtInAvailable: true }),
    { engine: 'builtin' },
  );
  assert.deepEqual(
    decide({ platform: 'ios', preference: 'fairscan', fairScanAvailable: true, builtInAvailable: true }),
    { engine: null, reason: 'fairscan-not-installed' },
  );
});

test('a stored preference from another build is recognised or refused', () => {
  assert.deepEqual([...SCAN_ENGINE_PREFERENCES], ['auto', 'fairscan', 'builtin']);
  assert.equal(DEFAULT_SCAN_ENGINE_PREFERENCE, 'auto');
  for (const preference of SCAN_ENGINE_PREFERENCES) {
    assert.equal(isScanEnginePreference(preference), true);
  }
  for (const value of ['mlkit', '', null, undefined, 0, {}]) {
    assert.equal(isScanEnginePreference(value), false);
  }
});

test('a cancelled FairScan scan is an empty result, not a failure', () => {
  assert.equal(parseFairScanResult(null), null);
  assert.equal(parseFairScanResult(undefined), null);
});

test('only a PDF already copied into Folio storage is accepted', () => {
  assert.deepEqual(
    parseFairScanResult({ uri: 'file:///data/user/0/app.folio.paperless/cache/folio-scans/a.pdf', pageCount: 3 }),
    { uri: 'file:///data/user/0/app.folio.paperless/cache/folio-scans/a.pdf', pageCount: 3 },
  );
  // FairScan deletes the file behind its content URI, so a URI Folio does not
  // own means the native copy never happened.
  assert.throws(
    () => parseFairScanResult({ uri: 'content://org.fairscan.app.fileprovider/scan.pdf', pageCount: 1 }),
    /did not return a scanned PDF/,
  );
  assert.throws(() => parseFairScanResult({ uri: '', pageCount: 1 }), /did not return a scanned PDF/);
});

test('an unreadable page count never fails an otherwise valid scan', () => {
  for (const pageCount of [null, undefined, 0, -2, 1.5, Number.NaN, 'many']) {
    assert.deepEqual(
      parseFairScanResult({ uri: 'file:///cache/folio-scans/a.pdf', pageCount }),
      { uri: 'file:///cache/folio-scans/a.pdf', pageCount: null },
    );
  }
});

test('a missing-scanner rejection is told apart from a real scan failure', () => {
  assert.equal(isFairScanUnavailableRejection({ code: FAIRSCAN_UNAVAILABLE_CODE }), true);
  assert.equal(isFairScanUnavailableRejection({ code: 'ERR_FAIRSCAN_COPY' }), false);
  assert.equal(isFairScanUnavailableRejection(new Error('boom')), false);
  assert.equal(isFairScanUnavailableRejection(null), false);
});

test('the Android manifest declares the intent package visibility needs', () => {
  const manifest = platformPlugin.addAndroidScanEngineQueries({
    manifest: { $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' } },
  });
  assert.deepEqual(manifest.manifest.queries, [{
    intent: [{ action: [{ $: { 'android:name': FAIRSCAN_INTENT_ACTION } }] }],
  }]);

  // Prebuild runs the mod on every `expo prebuild`, so it has to be idempotent.
  const again = platformPlugin.addAndroidScanEngineQueries(manifest);
  assert.equal(again.manifest.queries[0].intent.length, 1);

  const existing = platformPlugin.addAndroidScanEngineQueries({
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      queries: [{ intent: [{ action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }] }] }],
    },
  });
  assert.equal(existing.manifest.queries[0].intent.length, 2);
});

test('the FairScan contract stays pinned to its documented action and package', () => {
  assert.equal(FAIRSCAN_PACKAGE_NAME, 'org.fairscan.app');
  assert.equal(FAIRSCAN_INTENT_ACTION, 'org.fairscan.app.action.SCAN_TO_PDF');
  assert.equal(platformPlugin.FAIRSCAN_SCAN_TO_PDF_ACTION, FAIRSCAN_INTENT_ACTION);
  assert.equal(FAIRSCAN_FDROID_URL, 'https://f-droid.org/packages/org.fairscan.app/');

  const nativeSource = fs.readFileSync(
    new URL(
      '../modules/folio-platform/android/src/main/java/app/folio/platform/FolioFairScanScanner.kt',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(nativeSource, /"org\.fairscan\.app\.action\.SCAN_TO_PDF"/);
  // The returned PDF has a short life, so it is copied before anything else.
  assert.match(nativeSource, /copyIntoPrivateCache/);
  assert.match(nativeSource, /context\.cacheDir/);
  assert.match(nativeSource, /Activity\.RESULT_CANCELED/);
  assert.match(nativeSource, new RegExp(FAIRSCAN_UNAVAILABLE_CODE));
});
