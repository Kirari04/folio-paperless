import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  configureBestEffortBackgroundSync,
  evaluateBackgroundConstraints,
  MINIMUM_BACKGROUND_INTERVAL_MINUTES,
  runBestEffortBackgroundCycle,
} from '../src/lib/background-sync.ts';

const online = { isConnected: true, isInternetReachable: true };
const backgroundRuntimeSource = await readFile(
  new URL('../src/lib/background-runtime.ts', import.meta.url),
  'utf8',
);

test('background uploads revalidate durable metadata against the live profile catalog', () => {
  assert.match(backgroundRuntimeSource, /async validateUpload\(task\)/);
  assert.match(backgroundRuntimeSource, /const liveCatalog = await liveUploadCatalog\(\)/);
  assert.match(backgroundRuntimeSource, /assertUploadMetadataReferencesCurrent\(task\.metadata, liveCatalog\)/);
});

test('background upload completion does not require owner capabilities without an owner override', () => {
  assert.match(
    backgroundRuntimeSource,
    /const requestedOwner = task\.metadata\?\.owner;[\s\S]*if \(!requestedOwner \|\| requestedOwner\.state === 'unset'\) return;[\s\S]*const capabilities = await liveCreationCapabilities\(\)/,
  );
});

test('background work fails closed throughout a pending profile removal', () => {
  assert.match(
    backgroundRuntimeSource,
    /const profileRemovalJournal = new ProfileRemovalJournalStore\([\s\S]*store,[\s\S]*createRepositoryProfileRemovalManifestStore\(repository\)/,
  );
  assert.match(
    backgroundRuntimeSource,
    /async function credentialsForBackground[\s\S]*if \(await profileRemovalPending\(\)\) return null;[\s\S]*const secret = await secrets\.read\(profileId\);[\s\S]*if \(await profileRemovalPending\(\)\) return null;/,
  );
  assert.match(
    backgroundRuntimeSource,
    /const executionGuard = async \(\) => \{[\s\S]*if \(await profileRemovalPending\(\)\) return false;[\s\S]*const before = await profiles\.getSnapshot\(\);[\s\S]*const currentSecrets = await secrets\.read\(profileId\);[\s\S]*const after = await profiles\.getSnapshot\(\);[\s\S]*after\.revision !== before\.revision[\s\S]*if \(await profileRemovalPending\(\)\) return false;/,
  );
  assert.match(
    backgroundRuntimeSource,
    /await repository\.initialize\(\);[\s\S]*if \(await profileRemovalPending\(\)\) return 'failed' as const;[\s\S]*profiles\.getSnapshot\(\)/,
  );
});

test('background work never replays a legacy identity-provider token to Paperless', () => {
  assert.match(
    backgroundRuntimeSource,
    /if \(secret\.oidc\) return null;[\s\S]*const token = secret\.apiToken \?\? '';[\s\S]*authorizationScheme: 'Token'/,
  );
  assert.doesNotMatch(backgroundRuntimeSource, /secret\.oidc\?\.accessToken/);
  assert.doesNotMatch(backgroundRuntimeSource, /authorizationScheme: secret\.oidc \? 'Bearer'/);
});

test('background registration clamps Android minimum interval and never promises a schedule', async () => {
  const registrations = [];
  const port = {
    async availability() { return 'available'; },
    isDefined() { return true; },
    async isRegistered() { return false; },
    async register(name, interval) { registrations.push({ name, interval }); },
    async unregister() {},
  };
  const result = await configureBestEffortBackgroundSync({
    port, taskName: 'folio-background-sync', minimumIntervalMinutes: 1,
  });
  assert.equal(result.minimumIntervalMinutes, MINIMUM_BACKGROUND_INTERVAL_MINUTES);
  assert.equal(result.exactSchedule, false);
  assert.deepEqual(registrations, [{ name: 'folio-background-sync', interval: 15 }]);
});

test('registration fails closed when TaskManager global definition is absent', async () => {
  const result = await configureBestEffortBackgroundSync({
    taskName: 'folio-background-sync',
    port: {
      async availability() { return 'available'; },
      isDefined() { return false; },
      async isRegistered() { return false; },
      async register() { throw new Error('must not run'); },
      async unregister() {},
    },
  });
  assert.equal(result.kind, 'not-defined');
});

test('background work defers for restricted platforms, offline state, disk pressure, or expiry', () => {
  assert.equal(evaluateBackgroundConstraints({
    availability: 'restricted', network: online, availableDiskBytes: null, reserveBytes: 0,
  }).reason, 'platform-restricted');
  assert.equal(evaluateBackgroundConstraints({
    availability: 'available',
    network: { isConnected: false, isInternetReachable: false },
    availableDiskBytes: null,
    reserveBytes: 0,
  }).reason, 'offline');
  assert.equal(evaluateBackgroundConstraints({
    availability: 'available', network: online, availableDiskBytes: 9, reserveBytes: 10,
  }).reason, 'storage-pressure');
  assert.equal(evaluateBackgroundConstraints({
    availability: 'available', network: online, availableDiskBytes: 100, reserveBytes: 10, deadlineAt: 5,
  }, 5).reason, 'deadline-expired');
});

test('background cycle isolates profile failures and avoids duplicate profile runs', async () => {
  const calls = [];
  const result = await runBestEffortBackgroundCycle({
    constraints: {
      availability: 'available', network: online, availableDiskBytes: null, reserveBytes: 0,
    },
    profileIds: ['profile-a', 'profile-a', 'profile-b'],
    async runProfile(profileId) {
      calls.push(profileId);
      if (profileId === 'profile-b') throw new Error('Server unavailable');
      return { outcome: 'completed' };
    },
  });
  assert.deepEqual(calls, ['profile-a', 'profile-b']);
  assert.equal(result.kind, 'failed');
  assert.deepEqual(result.profiles.map((profile) => profile.outcome), ['completed', 'failed']);
});

test('deadline-truncated background work is deferred rather than reported complete', async () => {
  const times = [0, 0, 2];
  const result = await runBestEffortBackgroundCycle({
    constraints: {
      availability: 'available', network: online, availableDiskBytes: null, reserveBytes: 0,
      deadlineAt: 1,
    },
    profileIds: ['profile-a', 'profile-b'],
    now: () => times.shift() ?? 2,
    async runProfile() { return { outcome: 'completed' }; },
  });
  assert.equal(result.kind, 'deferred');
  assert.equal(result.reason, 'deadline-expired');
  assert.equal(result.profiles.length, 1);
});
