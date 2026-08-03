import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  NativeOsSearchIndexAdapter,
  OsSearchUnsupportedError,
  verifyNativeOidcRs256,
} from '../src/lib/os-search-native-adapter.ts';
import { reconcileNativeOsSearch } from '../src/lib/os-search-runtime.ts';
import { buildOsSearchReconciliation } from '../src/lib/os-search-privacy.ts';
import { connectFolioShortcutDelivery } from '../src/lib/platform-native-shortcuts.ts';
import {
  revokeRemoteDocumentVisibility,
  searchableSummariesForDocuments,
} from '../src/lib/os-search-document-summaries.ts';
import { createNativeAndroidWidgetPayload } from '../src/lib/folio-android-widget.ts';
import { setRuntimeLocale } from '../src/i18n/runtime.ts';

const NOW = '2026-08-02T10:00:00.000Z';
const require = createRequire(import.meta.url);
const platformPlugin = require('../plugins/withFolioPlatformIntegrations.js');
const CAPABILITIES = {
  osSearch: { supported: true, engine: 'ios-core-spotlight', reason: null },
  shortcuts: { supported: true, transport: 'ios-app-delegate' },
};

class FakePlatformModule {
  capabilities = structuredClone(CAPABILITIES);
  accessStates = [];
  replacements = [];
  upserts = [];
  removals = [];
  removedProfiles = [];
  clears = 0;
  initialShortcut = null;
  initialUrl = null;
  shortcutListeners = new Set();
  urlListeners = new Set();
  oidcVerificationResult = false;

  async getCapabilitiesAsync() {
    return structuredClone(this.capabilities);
  }

  async setSearchAccessStateAsync(unlocked, clearOnBackground) {
    this.accessStates.push({ unlocked, clearOnBackground });
  }

  async replaceSearchIndexAsync(entries) {
    this.replacements.push(structuredClone(entries));
  }

  async upsertSearchEntriesAsync(entries) {
    this.upserts.push(structuredClone(entries));
  }

  async removeSearchEntriesAsync(identifiers) {
    this.removals.push([...identifiers]);
  }

  async removeSearchProfileAsync(profileId) {
    this.removedProfiles.push(profileId);
  }

  async clearSearchIndexAsync() {
    this.clears += 1;
  }

  async consumeInitialShortcutAsync() {
    const value = this.initialShortcut;
    this.initialShortcut = null;
    return value;
  }

  async consumeInitialUrlAsync() {
    const value = this.initialUrl;
    this.initialUrl = null;
    return value;
  }

  addListener(name, listener) {
    const listeners = name === 'onShortcut'
      ? this.shortcutListeners
      : name === 'onOpenUrl'
        ? this.urlListeners
        : null;
    assert.ok(listeners);
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  }

  emitShortcut(id) {
    for (const listener of this.shortcutListeners) listener({ id });
  }

  emitUrl(url) {
    for (const listener of this.urlListeners) listener({ url });
  }

  async verifyOidcRs256Async() {
    return this.oidcVerificationResult;
  }
}

function oneEntry() {
  return buildOsSearchReconciliation({
    policy: { enabled: true, metadata: 'document-title', maxItems: 10 },
    profileId: 'profile-a',
    unlocked: true,
    authenticated: true,
    currentEntries: [],
    documents: [{
      profileId: 'profile-a',
      documentId: 'doc-42',
      title: 'Annual report',
      updatedAt: NOW,
      canView: true,
      deleted: false,
    }],
  }).upsert[0];
}

test('native adapter emits only the allowlisted OS-search payload', async () => {
  const native = new FakePlatformModule();
  const adapter = new NativeOsSearchIndexAdapter(native);
  await adapter.replace([oneEntry()]);
  assert.deepEqual(native.replacements, [[{
    identifier: 'folio:profile-a:doc-42',
    profileId: 'profile-a',
    documentId: 'doc-42',
    displayTitle: 'Annual report',
    route: 'folio-paperless://document/doc-42?profile=profile-a',
    updatedAtEpochMs: Date.parse(NOW),
  }]]);
  const serialized = JSON.stringify(native.replacements);
  assert.equal(serialized.includes('keywords'), false);
  assert.equal(serialized.includes('server'), false);
  assert.equal(serialized.includes('content'), false);
});

test('native adapter rejects policy-forbidden keywords and mismatched routes', async () => {
  const native = new FakePlatformModule();
  const adapter = new NativeOsSearchIndexAdapter(native);
  await assert.rejects(
    adapter.replace([{ ...oneEntry(), keywords: ['private'] }]),
    /keywords are not permitted/,
  );
  await assert.rejects(
    adapter.replace([{
      ...oneEntry(),
      route: { ...oneEntry().route, documentId: 'other' },
    }]),
    /route does not match/,
  );
  assert.equal(native.replacements.length, 0);
});

test('missing and unsupported native implementations are explicit', async () => {
  const missing = new NativeOsSearchIndexAdapter(null);
  assert.deepEqual((await missing.capabilities()).osSearch, {
    supported: false,
    engine: 'unsupported',
    reason: 'native-module-unavailable',
  });
  await assert.rejects(missing.replace([oneEntry()]), OsSearchUnsupportedError);

  const native = new FakePlatformModule();
  native.capabilities.osSearch = {
    supported: false,
    engine: 'unsupported',
    reason: 'android-appsearch-requires-api-31',
  };
  await assert.rejects(
    new NativeOsSearchIndexAdapter(native).replace([oneEntry()]),
    (error) => error instanceof OsSearchUnsupportedError
      && error.reason === 'android-appsearch-requires-api-31',
  );
});

test('runtime reconciliation clears while disabled, locked, or signed out', async () => {
  for (const state of [
    { enabled: false, unlocked: true, authenticated: true, reason: 'disabled' },
    { enabled: true, unlocked: false, authenticated: true, reason: 'locked' },
    { enabled: true, unlocked: true, authenticated: false, reason: 'signed-out' },
  ]) {
    const native = new FakePlatformModule();
    const adapter = new NativeOsSearchIndexAdapter(native);
    const result = await reconcileNativeOsSearch(adapter, {
      policy: { enabled: state.enabled, metadata: 'minimal', maxItems: 250 },
      profileId: 'profile-a',
      unlocked: state.unlocked,
      authenticated: state.authenticated,
      clearOnBackground: true,
      documents: [],
    });
    assert.deepEqual(result, { kind: 'cleared', reason: state.reason });
    assert.deepEqual(native.accessStates, [{ unlocked: false, clearOnBackground: true }]);
    assert.equal(native.clears, 1);
    assert.equal(native.replacements.length, 0);
  }
});

test('runtime replaces the whole active-profile snapshot after privacy filtering', async () => {
  const native = new FakePlatformModule();
  native.capabilities.osSearch.engine = 'android-platform-appsearch';
  const result = await reconcileNativeOsSearch(new NativeOsSearchIndexAdapter(native), {
    policy: { enabled: true, metadata: 'minimal', maxItems: 1 },
    profileId: 'profile-a',
    unlocked: true,
    authenticated: true,
    clearOnBackground: false,
    documents: [
      { profileId: 'profile-a', documentId: 'new', title: 'Secret title', updatedAt: NOW, canView: true, deleted: false },
      { profileId: 'profile-a', documentId: 'deleted', title: 'Deleted', updatedAt: '2026-08-01T10:00:00.000Z', canView: true, deleted: true },
      { profileId: 'profile-a', documentId: 'denied', title: 'Denied', updatedAt: '2026-07-31T10:00:00.000Z', canView: false, deleted: false },
      { profileId: 'profile-b', documentId: 'other', title: 'Other', updatedAt: NOW, canView: true, deleted: false },
    ],
  });
  assert.deepEqual(result, {
    kind: 'indexed',
    count: 1,
    engine: 'android-platform-appsearch',
  });
  assert.deepEqual(native.accessStates, [{ unlocked: true, clearOnBackground: false }]);
  assert.equal(native.replacements.length, 1);
  assert.equal(native.replacements[0].length, 1);
  assert.equal(native.replacements[0][0].displayTitle, 'Folio document');
  assert.equal(native.replacements[0][0].profileId, 'profile-a');
});

test('minimal OS-search metadata follows the active runtime locale', () => {
  setRuntimeLocale('de', 'de-CH');
  try {
    const plan = buildOsSearchReconciliation({
      policy: { enabled: true, metadata: 'minimal', maxItems: 1 },
      profileId: 'profile-a',
      unlocked: true,
      authenticated: true,
      documents: [
        {
          profileId: 'profile-a',
          documentId: 'doc-1',
          title: 'Must stay private',
          updatedAt: NOW,
          canView: true,
          deleted: false,
        },
      ],
      currentEntries: [],
    });
    assert.equal(plan.upsert[0].displayTitle, 'Folio-Dokument');
  } finally {
    setRuntimeLocale('en', 'en-US');
  }
});

test('changing the active locale re-runs native OS-search reconciliation', () => {
  const gatewaySource = fs.readFileSync(
    new URL('../src/components/os-search-runtime-gateway.tsx', import.meta.url),
    'utf8',
  );
  assert.match(gatewaySource, /const \{ localeTag \} = useI18n\(\)/);
  assert.match(
    gatewaySource,
    /\[\s*adapterPromise,[\s\S]*localeTag,[\s\S]*profileId,[\s\S]*\]/,
  );
});

test('iOS shortcut bridge consumes cold launch once and forwards warm events', async () => {
  const native = new FakePlatformModule();
  native.initialShortcut = 'search';
  const routes = [];
  const subscription = await connectFolioShortcutDelivery(native, (route) => routes.push(route));
  assert.equal(subscription.supported, true);
  assert.deepEqual(routes.map((route) => route.kind), ['search']);
  native.emitShortcut('inbox');
  native.emitShortcut('not-allowed');
  assert.deepEqual(routes.map((route) => route.kind), ['search', 'inbox']);
  subscription.remove();
  native.emitShortcut('quick-scan');
  assert.deepEqual(routes.map((route) => route.kind), ['search', 'inbox']);
});

test('iOS Spotlight handoff consumes cold and warm document activities below the lock', async () => {
  const native = new FakePlatformModule();
  native.initialUrl = 'folio-paperless://document/42?profile=profile-a';
  const routes = [];
  const subscription = await connectFolioShortcutDelivery(native, (route) => routes.push(route));
  assert.deepEqual(routes, [{
    kind: 'document',
    source: 'os-search',
    profileId: 'profile-a',
    documentId: '42',
  }]);
  native.emitUrl('folio-paperless://document/43?profile=profile-a');
  native.emitUrl('https://attacker.example/document/44?profile=profile-a');
  assert.deepEqual(routes.map((route) => route.documentId), ['42', '43']);
  subscription.remove();
  native.emitUrl('folio-paperless://document/44?profile=profile-a');
  assert.deepEqual(routes.map((route) => route.documentId), ['42', '43']);
});

test('native RS256 adapter preserves an invalid-signature result without handling claims', async () => {
  const native = new FakePlatformModule();
  assert.equal(await verifyNativeOidcRs256(native, {
    signingInput: 'header.payload',
    signatureBase64Url: 'signature',
    modulusBase64Url: 'modulus',
    exponentBase64Url: 'AQAB',
  }), false);
  native.oidcVerificationResult = true;
  assert.equal(await verifyNativeOidcRs256(native, {
    signingInput: 'header.payload',
    signatureBase64Url: 'signature',
    modulusBase64Url: 'modulus',
    exponentBase64Url: 'AQAB',
  }), true);
  await assert.rejects(
    () => verifyNativeOidcRs256(null, {
      signingInput: 'header.payload',
      signatureBase64Url: 'signature',
      modulusBase64Url: 'modulus',
      exponentBase64Url: 'AQAB',
    }),
    /native RS256 verifier is unavailable/,
  );
});

test('native sources keep system visibility and lock revocation wired', () => {
  const android = fs.readFileSync(
    new URL('../modules/folio-platform/android/src/main/java/app/folio/platform/FolioPlatformModule.kt', import.meta.url),
    'utf8',
  );
  const iosModule = fs.readFileSync(
    new URL('../modules/folio-platform/ios/FolioPlatformModule.swift', import.meta.url),
    'utf8',
  );
  const iosSubscriber = fs.readFileSync(
    new URL('../modules/folio-platform/ios/FolioPlatformAppDelegateSubscriber.swift', import.meta.url),
    'utf8',
  );
  const iosState = fs.readFileSync(
    new URL('../modules/folio-platform/ios/FolioPlatformState.swift', import.meta.url),
    'utf8',
  );
  const iosOidc = fs.readFileSync(
    new URL('../modules/folio-platform/ios/FolioPlatformOidc.swift', import.meta.url),
    'utf8',
  );
  assert.match(android, /setSchemaTypeDisplayedBySystem\(SCHEMA_TYPE, true\)/);
  assert.match(android, /Build\.VERSION_CODES\.S/);
  assert.match(android, /OnActivityEntersBackground/);
  assert.match(android, /CLEANUP_PENDING_KEY/);
  assert.match(android, /attempt < 2/);
  assert.match(android, /searchAccessGeneration/);
  assert.match(android, /SCHEMA_TYPE = "builtin:WebPage"/);
  assert.match(android, /PROPERTY_ROUTE = "url"/);
  assert.match(android, /setPropertyString\(PROPERTY_ROUTE, entry\.route\)/);
  assert.match(android, /validDocumentRoute\(entry\.route, profileId, documentId\)/);
  assert.doesNotMatch(iosModule, /attributes\.contentURL/);
  assert.match(iosModule, /private let index = folioSearchIndex/);
  assert.match(iosState, /protectionClass: \.complete/);
  assert.match(iosState, /cleanupPendingKey/);
  assert.match(iosState, /mayWrite\(generation expectedGeneration/);
  assert.match(iosSubscriber, /folioSearchIndex\.deleteAllSearchableItems/);
  assert.match(iosSubscriber, /clearProtectedSearchIndex\(attempt: attempt \+ 1\)/);
  assert.match(iosModule, /clearAfterStaleWrite/);
  assert.doesNotMatch(iosSubscriber, /CSSearchableIndex\.default/);
  assert.match(iosSubscriber, /didFinishLaunchingWithOptions/);
  assert.match(iosSubscriber, /performActionFor shortcutItem/);
  assert.match(iosSubscriber, /CSSearchableItemActionType/);
  assert.match(iosSubscriber, /CSSearchableItemActivityIdentifier/);
  assert.match(iosSubscriber, /FolioOpenUrlRegistry\.shared\.deliver/);
  assert.match(iosSubscriber, /applicationDidEnterBackground/);
  assert.match(android, /Signature\.getInstance\("SHA256withRSA"\)/);
  assert.match(iosOidc, /rsaSignatureMessagePKCS1v15SHA256/);
  assert.doesNotMatch(android, /Log\./);
  assert.doesNotMatch(iosOidc, /print\(/);
});

test('Android AppSearch fences asynchronous puts and keeps stale cleanup fail closed', () => {
  const android = fs.readFileSync(
    new URL('../modules/folio-platform/android/src/main/java/app/folio/platform/FolioPlatformModule.kt', import.meta.url),
    'utf8',
  );
  const putDocuments = android.slice(
    android.indexOf('private fun putDocuments('),
    android.indexOf('private fun clearAfterStaleWrite('),
  );
  const staleCleanup = android.slice(
    android.indexOf('private fun clearAfterStaleWrite('),
    android.indexOf('private fun removeAll('),
  );
  const cleanupCompletion = android.slice(
    android.indexOf('private fun completeCleanupIfCurrent('),
    android.indexOf('private fun unsupportedReason('),
  );

  assert.match(android, /private val searchAccessLock = Any\(\)/);
  assert.match(android, /private fun beginSearchWrite\(\): Long\?/);
  assert.match(android, /private fun mayWrite\(expectedGeneration: Long\)/);
  assert.match(putDocuments, /expectedGeneration: Long/);
  assert.equal(
    [...putDocuments.matchAll(/!mayWrite\(expectedGeneration\)/g)].length,
    3,
    'writes must be fenced before put and after both AppSearch callback outcomes',
  );
  assert.match(putDocuments, /clearAfterStaleWrite\(promise\)/);
  assert.match(staleCleanup, /val cleanupGeneration = markCleanupNeeded\(\)/);
  assert.match(staleCleanup, /clearAllSearch\(/);
  assert.match(staleCleanup, /Folio remains locked and OS search cleanup is pending/);
  assert.match(
    cleanupCompletion,
    /if \(searchAccessGeneration\.get\(\) != generation\) return@synchronized[\s\S]*putBoolean\(CLEANUP_PENDING_KEY, false\)/,
  );
});

test('Android static shortcut labels are linkable string resources', () => {
  const shortcuts = platformPlugin.createAndroidShortcutsXml('app.folio.paperless');
  const strings = platformPlugin.createAndroidShortcutStringsXml();
  const ios = platformPlugin.createIosShortcutItems();
  assert.match(shortcuts, /android:shortcutShortLabel="@string\/folio_quick_scan_short"/);
  assert.match(shortcuts, /android:shortcutLongLabel="@string\/folio_search_long"/);
  assert.match(strings, /<string name="folio_quick_scan_short">Quick Scan<\/string>/);
  assert.match(strings, /<string name="folio_search_long">Search documents<\/string>/);
  assert.equal(ios[0].UIApplicationShortcutItemTitle, 'folio_quick_scan_short');
  assert.equal(ios[2].UIApplicationShortcutItemSubtitle, 'folio_search_long');
});

test('iOS share-extension staging receives complete-until-first-unlock protection', () => {
  const hardened = platformPlugin.hardenIosShareEntitlements(`<?xml version="1.0"?>
<plist version="1.0">
  <dict>
    <key>com.apple.security.application-groups</key>
    <array><string>group.app.folio.paperless.share</string></array>
  </dict>
</plist>`);
  assert.match(
    hardened,
    /<key>com\.apple\.developer\.default-data-protection<\/key>\s*<string>NSFileProtectionCompleteUntilFirstUserAuthentication<\/string>/,
  );
  assert.equal(platformPlugin.hardenIosShareEntitlements(hardened), hardened);
  assert.throws(
    () => platformPlugin.hardenIosShareEntitlements('<plist/>'),
    /malformed iOS share-extension entitlements/,
  );
});

test('iOS share-extension source contract rejects path-bearing copy errors', () => {
  const unsafe = 'catch {\n      print("Error copying file: \\(error)")\n    }';
  assert.throws(
    () => platformPlugin.hardenIosShareController(unsafe),
    /path-bearing copy-error log/,
  );
  const hardened = [
    'catch { print("Error copying a shared file") }',
    ...platformPlugin.IOS_SHARE_CONTROLLER_REQUIRED_MARKERS,
  ].join('\n');
  assert.equal(platformPlugin.hardenIosShareController(hardened), hardened);
  assert.throws(
    () => platformPlugin.hardenIosShareController(
      'catch { print("Error copying a shared file") }',
    ),
    /bounded per-item source contract changed/,
  );
  assert.throws(
    () => platformPlugin.hardenIosShareController('catch { return nil }'),
    /source contract changed/,
  );

  const pluginSource = fs.readFileSync(
    new URL('../plugins/withFolioPlatformIntegrations.js', import.meta.url),
    'utf8',
  );
  assert.match(pluginSource, /withFinalizedMod/);
  assert.match(pluginSource, /expo-sharing-extension/);
});

test('runtime gateway indexes stable remote identities and no local placeholders', () => {
  const documents = [{
    id: 'remote-42',
    remoteId: 42,
    title: 'Annual report',
    modifiedAt: NOW,
    added: '2026-08-01T10:00:00.000Z',
    canView: true,
    deletedAt: null,
  }, {
    id: 'upload-pending',
    title: 'Pending upload',
    added: NOW,
    canView: true,
    deletedAt: null,
  }, {
    id: 'remote-43',
    remoteId: 43,
    title: 'Trash',
    added: NOW,
    canView: true,
    deletedAt: NOW,
  }, {
    id: 'remote-44',
    remoteId: 44,
    title: 'Revoked',
    added: NOW,
    canView: false,
    deletedAt: null,
  }, {
    id: 'remote-45',
    remoteId: 45,
    title: 'Legacy unverified cache',
    added: NOW,
    deletedAt: null,
  }];
  assert.deepEqual(searchableSummariesForDocuments('profile-a', documents), [{
    profileId: 'profile-a',
    documentId: '42',
    title: 'Annual report',
    updatedAt: NOW,
    canView: true,
    deleted: false,
  }, {
    profileId: 'profile-a',
    documentId: '43',
    title: 'Trash',
    updatedAt: NOW,
    canView: true,
    deleted: true,
  }]);
});

test('authorization loss revokes persisted remote visibility without mutating local intake rows', () => {
  const local = { id: 'local-1', title: 'Staged', source: 'local' };
  const revoked = revokeRemoteDocumentVisibility([{
    id: 'remote-42',
    remoteId: 42,
    title: 'Previously visible',
    canView: true,
  }, local]);
  assert.equal(revoked[0].canView, false);
  assert.equal(revoked[1], local);
  assert.deepEqual(searchableSummariesForDocuments('profile-a', revoked), []);
});

test('Android widget bridge strips timestamps, routes, and all document metadata', () => {
  assert.deepEqual(createNativeAndroidWidgetPayload({
    schemaVersion: 1,
    state: 'ready',
    inboxCount: 12,
    syncedAt: NOW,
    quickScanRoute: 'folio-paperless://scan',
  }), { state: 'ready', inboxCount: 12 });
  assert.deepEqual(createNativeAndroidWidgetPayload({
    schemaVersion: 1,
    state: 'locked',
    inboxCount: null,
    syncedAt: null,
    quickScanRoute: 'folio-paperless://scan',
  }), { state: 'locked', inboxCount: null });
});
