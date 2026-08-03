import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  DeferredExternalNavigationQueue,
  MAX_EXTERNAL_URL_LENGTH,
  isReservedAuthCallbackUrl,
  parseExternalUrl,
  resolveExternalNavigation,
  serializeExternalRoute,
} from '../src/lib/external-routing.ts';
import {
  consumeNotificationResponseIntoRuntime,
  ExternalRoutingRuntime,
} from '../src/lib/external-routing-runtime.ts';
import {
  consumeCachedLinkingUrl,
  consumeLinkingUrl,
} from '../src/lib/consumable-linking.ts';
import {
  NotificationRouteRegistry,
  createBackgroundNotificationEvents,
  createNotificationContent,
  createUploadCompletionNotificationEvent,
  parseLocalNotificationPreferences,
  parseNotificationRoutePayload,
} from '../src/lib/platform-notifications.ts';
import { routeForShortcut } from '../src/lib/platform-shortcuts.ts';
import {
  DEFAULT_OS_SEARCH_POLICY,
  buildOsSearchReconciliation,
} from '../src/lib/os-search-privacy.ts';
import {
  createWidgetSnapshot,
  parseWidgetSnapshot,
} from '../src/lib/widget-privacy.ts';
import {
  assertAndroidStoreManifestSource,
  findForbiddenStorePermissionDeclarations,
  findMissingStorePermissionBlockers,
} from '../scripts/assert-android-store-manifest.mjs';
import { assertNoGlobalStoreOnlyExclusion } from '../scripts/assert-autolinking-flavors.mjs';
import { allowsInAppApkUpdates } from '../src/lib/distribution.ts';

const require = createRequire(import.meta.url);
const platformPlugin = require('../plugins/withFolioPlatformIntegrations.js');
const distributionGuard = require('../plugins/withFolioDistributionGuard.js');
const appConfig = require('../app.config.js');
const deviceFeaturesSource = fs.readFileSync(
  new URL('../src/lib/device-features.ts', import.meta.url),
  'utf8',
);
const appContextSource = fs.readFileSync(
  new URL('../src/context/app-context.tsx', import.meta.url),
  'utf8',
);
const externalRoutingGatewaySource = fs.readFileSync(
  new URL('../src/components/external-routing-gateway.tsx', import.meta.url),
  'utf8',
);

const READY = {
  bootstrap: 'ready',
  profileSelection: 'ready',
  biometric: 'unlocked',
  authenticated: true,
  activeProfileId: 'profile-a',
  knownProfileIds: ['profile-a', 'profile-b'],
};
const NOW = '2026-08-02T10:00:00.000Z';

test('external URL parser accepts only the custom scheme and allowlisted shape', () => {
  const examples = [
    ['folio-paperless://home', 'home'],
    ['folio-paperless:///inbox?profile=profile-a', 'inbox'],
    ['folio-paperless:/scanner', 'scanner'],
    ['folio-paperless://search?q=annual%20report', 'search'],
    ['folio-paperless://document/doc-42?profile=profile-a', 'document'],
  ];
  for (const [url, kind] of examples) {
    const result = parseExternalUrl(url);
    assert.equal(result.accepted, true, url);
    assert.equal(result.route.kind, kind, url);
  }

  const rejected = [
    'https://folio.example/inbox',
    'folio-paperless://unknown',
    'folio-paperless://inbox#private',
    'folio-paperless://inbox?profile=a&profile=b',
    'folio-paperless://inbox?token=secret',
    'folio-paperless://document/doc-42',
    'folio-paperless://document/%2e%2e?profile=profile-a',
    `folio-paperless://search?q=${'x'.repeat(MAX_EXTERNAL_URL_LENGTH)}`,
  ];
  for (const url of rejected) assert.equal(parseExternalUrl(url).accepted, false, url);
});

test('OIDC callbacks are reserved for AuthSession and never become app navigation', () => {
  assert.equal(
    isReservedAuthCallbackUrl('folio-paperless://oauth/callback?code=opaque&state=opaque'),
    true,
  );
  assert.equal(isReservedAuthCallbackUrl('folio-paperless://oauth/other?code=opaque'), false);
  assert.equal(isReservedAuthCallbackUrl('https://oauth/callback?code=opaque'), false);
  assert.equal(isReservedAuthCallbackUrl('folio-paperless://oauth/callback#token'), false);
});

test('external routes serialize canonically without credentials or server data', () => {
  const route = {
    kind: 'document',
    source: 'notification',
    profileId: 'profile-a',
    documentId: 'doc-42',
  };
  assert.equal(
    serializeExternalRoute(route),
    'folio-paperless://document/doc-42?profile=profile-a',
  );
});

test('navigation waits for bootstrap, unlock, and an explicit profile switch', async () => {
  const route = parseExternalUrl('folio-paperless://document/doc-42?profile=profile-b').route;
  assert.deepEqual(
    await resolveExternalNavigation(route, { ...READY, bootstrap: 'pending' }),
    { kind: 'defer', reason: 'bootstrap' },
  );
  assert.deepEqual(
    await resolveExternalNavigation(route, { ...READY, biometric: 'locked' }),
    { kind: 'defer', reason: 'biometric-lock' },
  );
  assert.deepEqual(await resolveExternalNavigation(route, READY), {
    kind: 'defer',
    reason: 'profile-switch-required',
    requiredProfileId: 'profile-b',
  });
  const target = await resolveExternalNavigation(
    route,
    { ...READY, activeProfileId: 'profile-b' },
    async () => 'allowed',
  );
  assert.deepEqual(target, {
    kind: 'navigate',
    target: { pathname: '/document/[id]', params: { id: 'doc-42' } },
  });
});

test('document access failures and unknown profiles fall back safely', async () => {
  const route = parseExternalUrl('folio-paperless://document/doc-42?profile=profile-a').route;
  const deleted = await resolveExternalNavigation(route, READY, async () => 'deleted');
  assert.equal(deleted.kind, 'fallback');
  assert.equal(deleted.reason, 'document-deleted');

  const unknown = await resolveExternalNavigation(
    { ...route, profileId: 'profile-unknown' },
    READY,
    async () => 'allowed',
  );
  assert.equal(unknown.kind, 'fallback');
  assert.equal(unknown.reason, 'profile-unavailable');
});

test('deferred routes are bounded, expire, deduplicate, and revoke by profile', async () => {
  const queue = new DeferredExternalNavigationQueue(2, 1_000);
  const routeA = parseExternalUrl('folio-paperless://inbox?profile=profile-a').route;
  const routeB = parseExternalUrl('folio-paperless://inbox?profile=profile-b').route;
  const search = parseExternalUrl('folio-paperless://search?q=invoices').route;
  queue.enqueue(routeA, 0);
  queue.enqueue(routeA, 1);
  assert.equal(queue.pending().length, 1);
  queue.enqueue(routeB, 2);
  queue.enqueue(search, 3);
  assert.deepEqual(queue.pending().map((route) => route.kind), ['inbox', 'search']);
  queue.clearProfile('profile-b');
  assert.deepEqual(queue.pending().map((route) => route.kind), ['search']);
  await queue.drain({ ...READY, biometric: 'locked' }, 2_000);
  assert.equal(queue.pending().length, 0);
});

test('routing runtime retains cold-start routes through bootstrap and unlock', async () => {
  let now = 100;
  const runtime = new ExternalRoutingRuntime(
    new DeferredExternalNavigationQueue(4, 10_000),
    () => now,
  );
  assert.equal(
    runtime.acceptUrl('folio-paperless://document/doc-42?profile=profile-a').accepted,
    true,
  );
  assert.equal(runtime.pending().length, 1);
  assert.deepEqual(await runtime.drain({ ...READY, bootstrap: 'pending' }), [{
    kind: 'defer',
    reason: 'bootstrap',
  }]);
  assert.equal(runtime.pending().length, 1);

  now = 200;
  assert.deepEqual(await runtime.drain(READY, async () => 'allowed'), [{
    kind: 'navigate',
    target: { pathname: '/document/[id]', params: { id: 'doc-42' } },
  }]);
  assert.equal(runtime.pending().length, 0);
});

test('routing runtime queues multiple warm events instead of overwriting one', async () => {
  const runtime = new ExternalRoutingRuntime(
    new DeferredExternalNavigationQueue(4, 10_000),
    () => 100,
  );
  runtime.acceptUrl('folio-paperless://inbox?profile=profile-a');
  runtime.acceptUrl('folio-paperless://search?q=annual');
  runtime.acceptRoute({ kind: 'scanner', source: 'shortcut' });
  assert.deepEqual(runtime.pending().map((route) => route.kind), ['inbox', 'search', 'scanner']);
  const decisions = await runtime.drain(READY);
  assert.deepEqual(decisions.map((decision) => decision.kind), [
    'navigate',
    'navigate',
    'navigate',
  ]);
  assert.equal(runtime.pending().length, 0);
  assert.deepEqual(runtime.acceptUrl('folio-paperless://oauth/callback?code=x&state=y'), {
    accepted: false,
    reason: 'auth-callback',
  });
  assert.equal(runtime.pending().length, 0);
});

test('Expo linking cache is cleared before a cold URL receives routing authority', () => {
  let cachedUrl = 'folio-paperless://inbox?profile=profile-a';
  const calls = [];
  const cache = {
    getLinkingURL() {
      calls.push('get');
      return cachedUrl;
    },
    clearInitialURL() {
      calls.push('clear');
      cachedUrl = null;
    },
  };

  assert.equal(consumeCachedLinkingUrl(cache, (url) => {
    calls.push(`consume:${url}`);
    assert.equal(cachedUrl, null);
  }), true);
  assert.deepEqual(calls, [
    'get',
    'clear',
    'consume:folio-paperless://inbox?profile=profile-a',
  ]);
  assert.equal(consumeCachedLinkingUrl(cache, () => assert.fail('replayed cold URL')), false);
});

test('identical warm URLs remain distinct events and each clears the native cache', () => {
  const calls = [];
  const cache = {
    getLinkingURL: () => null,
    clearInitialURL: () => calls.push('clear'),
  };
  const consume = (url) => calls.push(`consume:${url}`);
  consumeLinkingUrl('folio-paperless://search?q=annual', cache, consume);
  consumeLinkingUrl('folio-paperless://search?q=annual', cache, consume);
  assert.deepEqual(calls, [
    'clear',
    'consume:folio-paperless://search?q=annual',
    'clear',
    'consume:folio-paperless://search?q=annual',
  ]);
});

test('deep links drain synchronously after consuming the SDK 57 native cache', () => {
  const acceptDeepLink = externalRoutingGatewaySource.slice(
    externalRoutingGatewaySource.indexOf('const acceptDeepLink'),
    externalRoutingGatewaySource.indexOf('// Subscribe first'),
  );
  assert.match(
    acceptDeepLink,
    /runtime\.current\.acceptUrl\(input, 'deep-link'\)[\s\S]*if \(accepted\.accepted\) \{\s*drainExternalRoutes\(\)/,
  );
  assert.match(
    acceptDeepLink,
    /acceptRoute\(\{ kind: 'home', source: 'deep-link' \}\);\s*drainExternalRoutes\(\)/,
  );
  assert.doesNotMatch(acceptDeepLink, /requestAnimationFrame|scheduleDrain/);
});

test('notification contents are redacted by default and metadata is strict', () => {
  const notification = createNotificationContent({
    kind: 'document-ready',
    profileId: 'profile-a',
    documentId: 'doc-42',
    documentTitle: 'Payroll 2026',
    issuedAt: NOW,
  });
  const serialized = JSON.stringify(notification);
  assert.equal(serialized.includes('Payroll'), false);
  assert.equal(serialized.includes('server'), false);

  assert.equal(
    parseNotificationRoutePayload({ ...notification.data, serverUrl: 'https://secret.example' })
      .accepted,
    false,
  );
  const parsed = parseNotificationRoutePayload(notification.data);
  assert.equal(parsed.accepted, true);
  assert.equal(parsed.route.kind, 'document');
});

test('upload completions target a canonical document or profile-scoped Task Center', async () => {
  const documentEvent = createUploadCompletionNotificationEvent({
    profileId: 'profile-a',
    taskId: 'task-42',
    canonicalDocumentId: 'remote-42',
    documentTitle: 'Private title',
    issuedAt: NOW,
  });
  const documentContent = createNotificationContent(documentEvent);
  assert.equal(JSON.stringify(documentContent).includes('Private title'), false);
  assert.deepEqual(parseNotificationRoutePayload(documentContent.data).route, {
    kind: 'document',
    source: 'notification',
    profileId: 'profile-a',
    documentId: 'remote-42',
  });

  const taskEvent = createUploadCompletionNotificationEvent({
    profileId: 'profile-a',
    taskId: 'task-42',
    issuedAt: NOW,
  });
  const parsedTask = parseNotificationRoutePayload(createNotificationContent(taskEvent).data);
  assert.equal(parsedTask.accepted, true);
  assert.equal(parsedTask.route.kind, 'tasks');
  assert.deepEqual(await resolveExternalNavigation(parsedTask.route, READY), {
    kind: 'navigate',
    target: { pathname: '/tasks' },
  });
  assert.deepEqual(
    await resolveExternalNavigation(parsedTask.route, { ...READY, activeProfileId: 'profile-b' }),
    { kind: 'defer', reason: 'profile-switch-required', requiredProfileId: 'profile-a' },
  );
  assert.equal(parseExternalUrl('folio-paperless://tasks?profile=profile-a').accepted, false);
});

test('background notification policy fails closed and emits only actionable inbox/sync events', () => {
  assert.deepEqual(parseLocalNotificationPreferences(null), {
    enabled: false,
    privacy: 'redacted',
  });
  assert.deepEqual(parseLocalNotificationPreferences({
    processingNotifications: true,
    notificationPrivacy: 'document-title',
    token: 'must-be-ignored',
  }), {
    enabled: true,
    privacy: 'document-title',
  });
  assert.deepEqual(createBackgroundNotificationEvents({
    profileId: 'profile-a', issuedAt: NOW, syncOutcome: 'busy',
    previousInboxCount: 2, currentInboxCount: 3,
  }), []);
  assert.deepEqual(createBackgroundNotificationEvents({
    profileId: 'profile-a', issuedAt: NOW, syncOutcome: 'completed',
    previousInboxCount: null, currentInboxCount: 20,
  }), []);
  assert.deepEqual(createBackgroundNotificationEvents({
    profileId: 'profile-a', issuedAt: NOW, syncOutcome: 'completed',
    previousInboxCount: 2, currentInboxCount: 3,
  }), [{ kind: 'inbox', profileId: 'profile-a', inboxCount: 3, issuedAt: NOW }]);
  assert.deepEqual(createBackgroundNotificationEvents({
    profileId: 'profile-a', issuedAt: NOW, syncOutcome: 'failed',
    previousInboxCount: 3, currentInboxCount: 3,
  }), [{ kind: 'sync', profileId: 'profile-a', succeeded: false, issuedAt: NOW }]);
});

test('production background work schedules allowlisted upload, inbox, and sync notifications', () => {
  const source = fs.readFileSync(new URL('../src/lib/background-runtime.ts', import.meta.url), 'utf8');
  assert.match(source, /notifyUploadCompleted\(/);
  assert.match(source, /notifyTaskResult\(/);
  assert.match(source, /createBackgroundNotificationEvents\(/);
  assert.match(source, /notifyLocalEvent\(event, notificationPreferences\.privacy\)/);
  assert.match(source, /dispatchTaskNotification\(\{/);
  assert.match(source, /async notify\(deliveryId\)/);
  assert.match(source, /deliveryId,/);
  assert.doesNotMatch(source, /markTaskNotificationSent\(/);
});

test('background credentials remain bound to unchanged metadata and captured secret authority', () => {
  const source = fs.readFileSync(new URL('../src/lib/background-runtime.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(after\.revision !== before\.revision\) return null/);
  assert.match(source, /if \(secret\.connectionFingerprint !== fingerprint\) return null/);
  assert.match(
    source,
    /connectionProfileAuthFingerprint\(profile\) !== connectionFingerprint[\s\S]*after\.revision !== before\.revision[\s\S]*connectionProfileAuthFingerprint\(currentProfile\) !== connectionFingerprint[\s\S]*currentSecrets\.connectionFingerprint === connectionFingerprint[\s\S]*profileSecretsAuthorizeSameContext\(authoritySecrets, currentSecrets\)[\s\S]*credentialsMatchStoredProfile\(credentials, currentProfile, currentSecrets\)/,
  );
  assert.match(source, /authoritySecrets: secret/);
  assert.match(source, /async upload\(task, onProgress\) \{[\s\S]*if \(!await executionGuard\(\)\)/);
  assert.match(source, /async poll\(task\) \{[\s\S]*if \(!await executionGuard\(\)\)/);
  assert.match(source, /new OfflineSyncCoordinator\(\{[\s\S]*executionGuard,/);
  assert.match(source, /drainUploadQueue\(\{[\s\S]*executionGuard,/);
});

test('startup repairs publication before identity enumeration and foreground rebind failures respect revocation', () => {
  const removalRecovery = appContextSource.indexOf('await recoverPendingProfileRemoval({');
  const publicationRecovery = appContextSource.indexOf('await recoverPendingProfilePublication({');
  const identityReconciliation = appContextSource.indexOf('await reconcileManagedClientIdentities({');
  assert.ok(removalRecovery >= 0);
  assert.ok(removalRecovery < publicationRecovery);
  assert.ok(publicationRecovery < identityReconciliation);

  const saveStart = appContextSource.indexOf('const saveConnectionProfile = useCallback');
  const saveEnd = appContextSource.indexOf('const renameConnectionProfile = useCallback', saveStart);
  const saveSource = appContextSource.slice(saveStart, saveEnd);
  assert.match(saveSource, /const previousForegroundBinding = foregroundCredentialBinding\.current/);
  const authorityRead = saveSource.indexOf('const previousSecrets =');
  const generationBump = saveSource.indexOf('if (activate) profileGeneration.current += 1');
  const persistence = saveSource.indexOf('await persistPreparedConnectionProfile');
  assert.ok(authorityRead >= 0 && authorityRead < generationBump);
  assert.ok(generationBump < persistence);
  assert.match(saveSource, /let oldDurablyRevoked = false/);
  assert.match(saveSource, /!oldDurablyRevoked[\s\S]*publishCredentials\(previousForegroundBinding\.credentials\)/);
  assert.match(saveSource, /oldDurablyRevoked = true[\s\S]*publishProfileRevocation/);
  assert.match(saveSource, /publishCredentials\(null\)/);
});

test('notification route handles are consumed once and revocable per profile', async () => {
  let handles = [];
  const registry = new NotificationRouteRegistry({
    async load() {
      return structuredClone(handles);
    },
    async save(next) {
      handles = structuredClone(next);
    },
  });
  const payload = createNotificationContent({
    kind: 'inbox',
    profileId: 'profile-a',
    issuedAt: NOW,
  }).data;
  await registry.register({ notificationId: 'notification-1', profileId: 'profile-a', payload, createdAt: NOW });
  assert.deepEqual(await registry.consume('notification-1'), payload);
  assert.equal(await registry.consume('notification-1'), null);
  await registry.register({ notificationId: 'notification-2', profileId: 'profile-a', payload, createdAt: NOW });
  assert.deepEqual(await registry.revokeProfile('profile-a'), ['notification-2']);
  assert.equal(handles.length, 0);
});

test('profile notification cleanup revokes persisted routing authority before OS best effort', () => {
  const cleanup = deviceFeaturesSource.slice(
    deviceFeaturesSource.indexOf('export async function dismissProfileNotifications'),
    deviceFeaturesSource.indexOf('export async function requireBiometricSupport'),
  );
  assert.ok(cleanup.indexOf('revokeProfile(profileId)') >= 0);
  assert.ok(cleanup.indexOf('revokeProfile(profileId)') < cleanup.indexOf("import('expo-notifications')"));
  assert.match(cleanup, /Promise\.allSettled/);
  assert.doesNotMatch(cleanup, /revokeIdentifiers/);
});

test('notification ingress clears Expo state, consumes its registered handle once, and rejects tampering', async () => {
  const payload = createNotificationContent({
    kind: 'inbox',
    profileId: 'profile-a',
    issuedAt: NOW,
  }).data;
  const runtime = new ExternalRoutingRuntime(
    new DeferredExternalNavigationQueue(4, 10_000),
    () => 100,
  );
  const calls = [];
  let available = payload;
  const dependencies = {
    defaultActionIdentifier: 'default',
    clearLastResponse() {
      calls.push('clear');
    },
    async consumeHandle(identifier) {
      calls.push(`consume:${identifier}`);
      const current = available;
      available = null;
      return current;
    },
  };
  const accepted = await consumeNotificationResponseIntoRuntime({
    notificationId: 'notification-1',
    actionIdentifier: 'default',
    data: { ...payload },
  }, dependencies, runtime);
  assert.equal(accepted.accepted, true);
  assert.deepEqual(calls, ['clear', 'consume:notification-1']);
  assert.equal(runtime.pending().length, 1);

  const replay = await consumeNotificationResponseIntoRuntime({
    notificationId: 'notification-1',
    actionIdentifier: 'default',
    data: payload,
  }, dependencies, runtime);
  assert.deepEqual(replay, { accepted: false, reason: 'unknown-handle' });

  available = payload;
  const tampered = await consumeNotificationResponseIntoRuntime({
    notificationId: 'notification-2',
    actionIdentifier: 'default',
    data: { ...payload, profileId: 'profile-b' },
  }, dependencies, runtime);
  assert.deepEqual(tampered, { accepted: false, reason: 'payload-mismatch' });
  assert.deepEqual(runtime.pending().map((route) => route.kind), ['inbox']);
});

test('static shortcuts expose only Quick Scan, Inbox, and Search', () => {
  assert.equal(routeForShortcut('quick-scan').route.kind, 'scanner');
  assert.equal(routeForShortcut('inbox').route.kind, 'inbox');
  assert.equal(routeForShortcut('search').route.kind, 'search');
  assert.equal(routeForShortcut('document').accepted, false);
  assert.equal(routeForShortcut({ id: 'search' }).accepted, false);
});

test('OS search is opt-in, bounded, permission-filtered, and contains no secret fields', () => {
  const current = [{
    identifier: 'folio:profile-a:old',
    profileId: 'profile-a',
    documentId: 'old',
    displayTitle: 'Old title',
    keywords: [],
    updatedAt: NOW,
    route: { kind: 'document', source: 'os-search', profileId: 'profile-a', documentId: 'old' },
  }];
  const disabled = buildOsSearchReconciliation({
    policy: DEFAULT_OS_SEARCH_POLICY,
    profileId: 'profile-a',
    unlocked: true,
    authenticated: true,
    documents: [],
    currentEntries: current,
  });
  assert.equal(disabled.reason, 'disabled');
  assert.deepEqual(disabled.removeIdentifiers, ['folio:profile-a:old']);

  const plan = buildOsSearchReconciliation({
    policy: { enabled: true, metadata: 'document-title', maxItems: 1 },
    profileId: 'profile-a',
    unlocked: true,
    authenticated: true,
    documents: [
      { profileId: 'profile-a', documentId: 'new', title: 'Invoice\u0000 42', updatedAt: '2026-08-03T10:00:00Z', canView: true, deleted: false, ocr: 'secret', serverUrl: 'https://secret.example' },
      { profileId: 'profile-a', documentId: 'hidden', title: 'Hidden', updatedAt: '2026-08-04T10:00:00Z', canView: false, deleted: false },
      { profileId: 'profile-b', documentId: 'other', title: 'Other', updatedAt: '2026-08-05T10:00:00Z', canView: true, deleted: false },
    ],
    currentEntries: [],
  });
  assert.equal(plan.upsert.length, 1);
  assert.equal(plan.upsert[0].displayTitle, 'Invoice 42');
  assert.equal(JSON.stringify(plan).includes('secret'), false);
  assert.deepEqual(plan.upsert[0].keywords, []);
});

test('widget snapshots stay locked without protected state and reject extra fields', () => {
  const locked = createWidgetSnapshot({
    authenticated: true,
    unlocked: false,
    inboxCount: 12,
    syncedAt: NOW,
  });
  assert.deepEqual(locked, {
    schemaVersion: 1,
    state: 'locked',
    inboxCount: null,
    syncedAt: null,
    quickScanRoute: 'folio-paperless://scan',
    labels: {
      locked: 'Locked',
      inbox: 'Inbox',
      openScan: 'Open Folio · Quick Scan',
      inboxItem: 'Inbox item · Quick Scan',
      inboxItems: 'Inbox items · Quick Scan',
    },
  });
  assert.equal(JSON.stringify(locked).includes('profile'), false);
  assert.equal(parseWidgetSnapshot({ ...locked, server: 'secret' }), null);
  assert.equal(
    createWidgetSnapshot({ authenticated: true, unlocked: true, inboxCount: 5_000, syncedAt: NOW })
      .inboxCount,
    999,
  );
});

test('config plugin emits three matching native shortcuts', () => {
  const android = platformPlugin.createAndroidShortcutsXml('app.folio.paperless');
  const ios = platformPlugin.createIosShortcutItems();
  assert.equal((android.match(/<shortcut\n/g) ?? []).length, 3);
  for (const route of [
    'folio-paperless://scan',
    'folio-paperless://inbox',
    'folio-paperless://search',
  ]) {
    assert.equal(android.includes(route), true);
    assert.equal(ios.some((item) => item.UIApplicationShortcutItemUserInfo.route === route), true);
  }
});

test('config plugin supplies Android defaults for every cross-platform locale key', () => {
  const defaults = platformPlugin.createAndroidLocaleFallbackStringsXml();
  const shortcuts = platformPlugin.createAndroidShortcutStringsXml();
  for (const localePath of ['../assets/locales/en.json', '../assets/locales/de.json']) {
    const locale = JSON.parse(fs.readFileSync(new URL(localePath, import.meta.url), 'utf8'));
    for (const key of Object.keys(locale.android)) {
      assert.match(`${defaults}\n${shortcuts}`, new RegExp(`name=["']${key}["']`));
    }
  }
});

test('store autolinking guard excludes updater and development-client modules per platform', () => {
  const settings = `
plugins {
  id("com.facebook.react.settings")
  id("expo-autolinking-settings")
}
extensions.configure(com.facebook.react.ReactSettingsExtension) { ex ->
  ex.autolinkLibrariesFromCommand(expoAutolinking.rnConfigCommand)
}
expoAutolinking.useExpoModules()
`;
  const guarded = distributionGuard.applyStoreAutolinkingGradleGuard(settings);
  assert.match(guarded, /expoAutolinking\.exclude = folioStoreAutolinkingExclusions/);
  for (const packageName of distributionGuard.STORE_AUTOLINKING_EXCLUSIONS) {
    assert.match(guarded, new RegExp(`"${packageName}"`));
  }
  assert.match(guarded, /containsAll\(folioStoreAutolinkingExclusions\)/);
  assert.ok(
    guarded.indexOf('expoAutolinking.exclude') < guarded.indexOf('extensions.configure'),
  );
  assert.equal(distributionGuard.applyStoreAutolinkingGradleGuard(guarded), guarded);
  assert.doesNotThrow(() => distributionGuard.assertStoreAutolinkingGradleGuard(guarded));
  assert.throws(
    () => distributionGuard.assertStoreAutolinkingGradleGuard(settings),
    /does not fail closed/,
  );

  const podfile = `
target 'Folio' do
  use_expo_modules!
end
`;
  const guardedPodfile = distributionGuard.applyStorePodfileAutolinkingGuard(podfile);
  for (const packageName of distributionGuard.STORE_AUTOLINKING_EXCLUSIONS) {
    assert.match(guardedPodfile, new RegExp(`"${packageName}"`));
  }
  assert.match(guardedPodfile, /use_expo_modules!\(exclude:/);
  assert.equal(
    distributionGuard.applyStorePodfileAutolinkingGuard(guardedPodfile),
    guardedPodfile,
  );
  assert.doesNotThrow(() =>
    distributionGuard.assertStorePodfileAutolinkingGuard(guardedPodfile));
  assert.throws(
    () => distributionGuard.assertStorePodfileAutolinkingGuard(podfile),
    /does not fail closed/,
  );

  const androidManifest = {
    manifest: {
      application: [{
        activity: [{
          'intent-filter': [{
            data: [
              { $: { 'android:scheme': 'folio-paperless' } },
              { $: { 'android:scheme': 'exp+folio-paperless' } },
            ],
          }],
        }],
      }],
    },
  };
  distributionGuard.removeDevelopmentClientAndroidSchemes(androidManifest);
  assert.equal(JSON.stringify(androidManifest).includes('exp+'), false);
  assert.equal(JSON.stringify(androidManifest).includes('folio-paperless'), true);
  assert.doesNotThrow(() =>
    distributionGuard.assertNoDevelopmentClientAndroidScheme(androidManifest));

  const infoPlist = {
    CFBundleURLTypes: [{
      CFBundleURLSchemes: ['folio-paperless', 'exp+folio-paperless'],
    }],
    NSBonjourServices: ['_expo._tcp', '_folio._tcp'],
    NSLocalNetworkUsageDescription:
      'Expo Dev Launcher uses the local network to discover development servers.',
    EXDevMenuShowsAtLaunch: true,
  };
  distributionGuard.removeDevelopmentClientInfoPlist(infoPlist);
  assert.deepEqual(infoPlist.CFBundleURLTypes[0].CFBundleURLSchemes, ['folio-paperless']);
  assert.deepEqual(infoPlist.NSBonjourServices, ['_folio._tcp']);
  assert.equal(infoPlist.NSLocalNetworkUsageDescription, undefined);
  assert.equal(infoPlist.EXDevMenuShowsAtLaunch, undefined);
  assert.doesNotThrow(() => distributionGuard.assertNoDevelopmentClientInfoPlist(infoPlist));

  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  assert.doesNotThrow(() => assertNoGlobalStoreOnlyExclusion(packageJson));
});

test('store manifest guard replaces forbidden permissions with durable merge blockers', () => {
  const manifest = {
    manifest: {
      'uses-permission': [
        { $: { 'android:name': 'android.permission.REQUEST_INSTALL_PACKAGES' } },
        { $: { 'android:name': 'android.permission.INTERNET' } },
      ],
      'uses-permission-sdk-23': [
        { $: { 'android:name': 'android.permission.WRITE_EXTERNAL_STORAGE' } },
        { $: { 'android:name': 'android.permission.POST_NOTIFICATIONS' } },
      ],
    },
  };
  const guarded = distributionGuard.removeForbiddenStorePermissions(manifest);
  const blockers = guarded.manifest['uses-permission'].filter(
    (entry) => entry.$['tools:node'] === 'remove',
  );
  assert.deepEqual(
    guarded.manifest['uses-permission']
      .filter((entry) => entry.$['tools:node'] !== 'remove')
      .map((entry) => entry.$['android:name']),
    ['android.permission.INTERNET'],
  );
  assert.deepEqual(
    blockers.map((entry) => entry.$['android:name']),
    distributionGuard.FORBIDDEN_STORE_PERMISSIONS,
  );
  assert.deepEqual(
    guarded.manifest['uses-permission-sdk-23'].map((entry) => entry.$['android:name']),
    ['android.permission.POST_NOTIFICATIONS'],
  );
  assert.doesNotThrow(() => distributionGuard.assertNoForbiddenStorePermissions(guarded));
  assert.throws(
    () => distributionGuard.assertNoForbiddenStorePermissions({ manifest: {} }),
    /missing manifest merge blockers/,
  );
});

test('post-prebuild store manifest audit recognizes both permission element aliases', () => {
  const source = `
    <manifest xmlns:android="http://schemas.android.com/apk/res/android">
      <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
      <uses-permission-sdk-23 android:name='android.permission.WRITE_EXTERNAL_STORAGE' />
    </manifest>
  `;
  assert.deepEqual(findForbiddenStorePermissionDeclarations(source), [
    { element: 'uses-permission', permission: 'android.permission.REQUEST_INSTALL_PACKAGES' },
    { element: 'uses-permission-sdk-23', permission: 'android.permission.WRITE_EXTERNAL_STORAGE' },
  ]);
  assert.throws(
    () => assertAndroidStoreManifestSource(source),
    /uses-permission-sdk-23: android\.permission\.WRITE_EXTERNAL_STORAGE/,
  );
  const blockedSource = `
    <manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">
      <uses-permission android:name="android.permission.INTERNET" />
      ${distributionGuard.FORBIDDEN_STORE_PERMISSIONS.map(
        (permission) => `<uses-permission android:name="${permission}" tools:node="remove" />`,
      ).join('\n')}
    </manifest>
  `;
  assert.deepEqual(findMissingStorePermissionBlockers(blockedSource), []);
  assert.doesNotThrow(() => assertAndroidStoreManifestSource(blockedSource));
  assert.doesNotThrow(() => assertAndroidStoreManifestSource(`
    <manifest xmlns:android="http://schemas.android.com/apk/res/android">
      <uses-permission android:name="android.permission.INTERNET" />
    </manifest>
  `, 'merged AndroidManifest.xml', { requireBlockers: false }));
});

test('EAS verifies the generated store autolinking guard after Android prebuild only', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    new URL('../package.json', import.meta.url),
    'utf8',
  ));
  const hook = fs.readFileSync(
    new URL('../scripts/eas-build-post-install.mjs', import.meta.url),
    'utf8',
  );
  const verifier = fs.readFileSync(
    new URL('../scripts/prepare-store-autolinking.mjs', import.meta.url),
    'utf8',
  );
  assert.equal(
    packageJson.scripts['eas-build-post-install'],
    'node scripts/eas-build-post-install.mjs',
  );
  assert.match(hook, /EAS_BUILD_PLATFORM === 'android'/);
  assert.match(hook, /FOLIO_DISTRIBUTION === 'store'/);
  assert.match(hook, /import\('\.\/prepare-store-autolinking\.mjs'\)/);
  assert.match(hook, /assertAndroidStoreManifestFile/);
  assert.match(verifier, /assertStoreAutolinkingGradleGuard/);
  assert.match(
    verifier,
    /resolveNativeModules\('android', \{ excludeStoreOnlyModules: true \}\)/,
  );
  assert.doesNotMatch(verifier, /writeFileSync/);
});

test('app config keeps GitHub updater capability out of the store flavor', () => {
  const original = process.env.FOLIO_DISTRIBUTION;
  try {
    process.env.FOLIO_DISTRIBUTION = 'github';
    const github = appConfig.createConfig();
    process.env.FOLIO_DISTRIBUTION = 'store';
    const store = appConfig.createConfig();
    assert.equal(github.extra.supportsInAppApkUpdates, true);
    assert.equal(store.extra.supportsInAppApkUpdates, false);
    assert.equal(github.plugins.some((plugin) => (
      Array.isArray(plugin) ? plugin[0] : plugin
    ) === './plugins/withFolioDistributionGuard'), false);
    assert.equal(store.plugins.some((plugin) => (
      Array.isArray(plugin) ? plugin[0] : plugin
    ) === './plugins/withFolioDistributionGuard'), true);
    assert.equal(
      store.android.permissions.includes('android.permission.REQUEST_INSTALL_PACKAGES'),
      false,
    );
    for (const permission of [
      'android.permission.REQUEST_INSTALL_PACKAGES',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
    ]) {
      assert.equal(store.android.permissions.includes(permission), false);
      assert.equal(store.android.blockedPermissions.includes(permission), true);
    }
    assert.equal(store.ios.associatedDomains, undefined);
    assert.equal(store.android.intentFilters, undefined);
  } finally {
    if (original === undefined) delete process.env.FOLIO_DISTRIBUTION;
    else process.env.FOLIO_DISTRIBUTION = original;
  }
});

test('runtime updater capability fails closed and store UI is not mounted', () => {
  assert.equal(allowsInAppApkUpdates(undefined), false);
  assert.equal(allowsInAppApkUpdates({ supportsInAppApkUpdates: true }), false);
  assert.equal(allowsInAppApkUpdates({
    folioDistribution: 'store',
    supportsInAppApkUpdates: true,
  }), false);
  assert.equal(allowsInAppApkUpdates({
    folioDistribution: 'github',
    supportsInAppApkUpdates: false,
  }), false);
  assert.equal(allowsInAppApkUpdates({
    folioDistribution: 'github',
    supportsInAppApkUpdates: true,
  }), true);

  const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const settingsSource = fs.readFileSync(
    new URL('../src/app/settings.tsx', import.meta.url),
    'utf8',
  );
  const updateContextSource = fs.readFileSync(
    new URL('../src/context/update-context.tsx', import.meta.url),
    'utf8',
  );
  const nativeUpdaterSource = fs.readFileSync(
    new URL('../src/lib/folio-updater-native.ts', import.meta.url),
    'utf8',
  );
  assert.match(appSource, /IN_APP_APK_UPDATES_ENABLED && <UpdateOverlay \/>/);
  assert.match(
    settingsSource,
    /IN_APP_APK_UPDATES_ENABLED && \([\s\S]*settings\.softwareUpdates/,
  );
  assert.match(updateContextSource, /if \(!IN_APP_APK_UPDATES_ENABLED\)/);
  assert.match(updateContextSource, /support: 'distribution-disabled'/);
  assert.doesNotMatch(
    nativeUpdaterSource,
    /const updaterModule = requireOptionalNativeModule/,
  );
  assert.match(
    nativeUpdaterSource,
    /export function getFolioUpdaterModule\(\)[\s\S]*requireOptionalNativeModule/,
  );
});

test('store artifact audit validates packaged config and scans compiled payloads', () => {
  const workflow = fs.readFileSync(
    new URL('../.github/workflows/store-release.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /unzip -p "\$artifact" 'base\/\*'/);
  assert.match(
    workflow,
    /-x 'base\/assets\/app\.config' 'base\/assets\/index\.android\.bundle'/,
  );
  assert.match(workflow, /config\.extra\?\.folioDistribution !== 'store'/);
  assert.match(workflow, /config\.extra\?\.supportsInAppApkUpdates !== false/);
  assert.match(workflow, /forbidden\.some\(\(permission\) => permissions\.includes\(permission\)\)/);
  assert.match(workflow, /forbidden\.some\(\(permission\) => !blocked\.includes\(permission\)\)/);
  assert.match(workflow, /base\/manifest\/AndroidManifest\.xml/);
  assert.match(workflow, /uses-permission-sdk-23/);
  assert.doesNotMatch(workflow, /Store JavaScript contains a forbidden Android permission/);
  assert.match(workflow, /! -name 'main\.jsbundle'/);
  assert.match(workflow, /FolioUpdater\|folio\[-_\.\]\?updater/);
  assert.match(workflow, /expo\\\.modules\\\.dev\(launcher\|menu\)/);
  assert.match(workflow, /expo\[-_\.\]\?dev\[-_\.\]\?/);
});

test('EAS store profiles require an AAB and a real iOS device archive', () => {
  const eas = JSON.parse(fs.readFileSync(new URL('../eas.json', import.meta.url), 'utf8'));
  assert.equal(eas.build['store-android'].android.buildType, 'app-bundle');
  assert.equal(eas.build['store-android'].distribution, 'store');
  assert.equal(eas.build['store-ios'].ios.simulator, false);
  assert.equal(eas.build['store-ios'].distribution, 'store');
});

test('store listings include localized release notes and reviewed privacy disclosures', () => {
  const manifest = JSON.parse(fs.readFileSync(
    new URL('../store/metadata/manifest.json', import.meta.url),
    'utf8',
  ));
  const privacy = JSON.parse(fs.readFileSync(
    new URL('../store/privacy-disclosures.json', import.meta.url),
    'utf8',
  ));
  assert.deepEqual(manifest.locales, ['en-US', 'de-DE']);
  for (const locale of manifest.locales) {
    const app = JSON.parse(fs.readFileSync(
      new URL(`../store/metadata/${locale}/app.json`, import.meta.url),
      'utf8',
    ));
    const notes = fs.readFileSync(
      new URL(`../store/metadata/${locale}/release-notes.txt`, import.meta.url),
      'utf8',
    );
    assert.match(app.privacyPolicyUrl, /^https:\/\//);
    assert.match(app.supportUrl, /^https:\/\//);
    assert.ok(notes.trim().length >= 80);
  }
  assert.equal(privacy.remotePushEnabled, false);
  assert.equal(privacy.developerTracking, false);
  assert.equal(privacy.storeConsoleReviewRequired, true);
});
