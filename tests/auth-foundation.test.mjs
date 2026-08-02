import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  CONNECTION_PROFILE_INDEX_KEY,
  LEGACY_CREDENTIALS_KEY,
  PROFILE_REMOVAL_JOURNAL_KEY,
  PROFILE_PUBLICATION_JOURNAL_KEY,
  PROFILE_SECRET_KEY_PREFIX,
  ConnectionProfileRepository,
  ProfileRemovalJournalStore,
  ProfileSecretStore,
  connectionProfileAuthFingerprint,
  createConnectionProfile,
  migrateLegacyCredentials,
  normalizeServerBaseUrl,
  redactHeaders,
  reconcileManagedClientIdentities,
  recoverPendingProfileRemoval,
  recoverPendingProfilePublication,
  removeClientIdentityIfUnreferenced,
  removeProfileWithSecrets,
  validateCustomHeaders,
} from '../src/lib/auth/profile-store.ts';
import {
  InMemoryOidcAttemptStore,
  acceptApiToken,
  acquirePaperlessToken,
  assertUsableClientIdentity,
  consumeOidcCallback,
  createOidcAuthorizationAttempt,
  requireNativeMtlsTransport,
  validateOidcCallback,
  validateOidcDiscovery,
  validateOidcTokenResponse,
  validateServerRedirect,
} from '../src/lib/auth/session.ts';
import {
  decodeOidcBase64Url,
  selectOidcRs256Jwk,
} from '../src/lib/auth/oidc-rs256.ts';

class MemoryStore {
  values = new Map();
  failNextDelete = false;
  failNextWrite = false;

  async getItem(key) {
    return this.values.get(key) ?? null;
  }

  async setItem(key, value) {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('simulated write failure');
    }
    this.values.set(key, value);
  }

  async deleteItem(key) {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error('simulated delete failure');
    }
    this.values.delete(key);
  }
}

class SizeLimitedMemoryStore extends MemoryStore {
  constructor(maxValueBytes) {
    super();
    this.maxValueBytes = maxValueBytes;
  }

  async setItem(key, value) {
    if (Buffer.byteLength(value, 'utf8') > this.maxValueBytes) {
      throw new Error('protected value exceeds platform limit');
    }
    await super.setItem(key, value);
  }
}

class MemoryManifestStore {
  values = new Map();
  failNextDelete = false;

  async write(manifest) {
    this.values.set(manifest.reference, structuredClone(manifest));
  }

  async read(reference) {
    return structuredClone(this.values.get(reference) ?? null);
  }

  async delete(reference) {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error('simulated manifest delete failure');
    }
    this.values.delete(reference);
  }
}

function removalJournal(store, manifests = new MemoryManifestStore()) {
  return new ProfileRemovalJournalStore(store, manifests);
}

function profileDataRemoval(overrides = {}) {
  let committed = false;
  const calls = [];
  return {
    calls,
    async plan(profileId, operationId) {
      calls.push(['plan', profileId, operationId]);
      return { version: 1, profileId, operationId };
    },
    async stage(data) {
      calls.push(['stage', data.profileId]);
      await overrides.stage?.(data);
    },
    async commit(profileId, operationId, createdAt, data) {
      calls.push(['commit', profileId, operationId, createdAt, data.profileId]);
      await overrides.commit?.(data);
      committed = true;
    },
    async isCommitted(operationId) {
      calls.push(['isCommitted', operationId]);
      return overrides.isCommitted?.(operationId, committed) ?? committed;
    },
    async rollback(data) {
      calls.push(['rollback', data.profileId]);
      await overrides.rollback?.(data);
    },
    async finalize(operationId, data) {
      calls.push(['finalize', operationId, data.profileId]);
      await overrides.finalize?.(data);
      committed = false;
    },
  };
}

const NOW = '2026-08-02T10:00:00.000Z';

test('RS256 JWK selection rejects malformed or ambiguous public material', () => {
  const modulus = Buffer.alloc(256, 0x80).toString('base64url');
  assert.equal(selectOidcRs256Jwk({
    keys: [{ kid: 'key-a', kty: 'RSA', use: 'sig', alg: 'RS256', n: modulus, e: 'AQAB' }],
  }, 'key-a').e, 'AQAB');
  assert.throws(
    () => selectOidcRs256Jwk({
      keys: [{ kid: 'key-a', kty: 'RSA', use: 'sig', n: 'not+padded=', e: 'AQAB' }],
    }, 'key-a'),
    /base64url|signing key is invalid/,
  );
  assert.throws(
    () => selectOidcRs256Jwk({
      keys: [
        { kid: 'key-a', kty: 'RSA', n: modulus, e: 'AQAB' },
        { kid: 'key-a', kty: 'RSA', n: modulus, e: 'AQAB' },
      ],
    }, 'key-a'),
    /ambiguous/,
  );
  assert.throws(() => decodeOidcBase64Url('abc='), /Invalid base64url/);
});

function profile(id, displayName, serverUrl = 'https://paper.example.com/paperless') {
  return createConnectionProfile({
    id,
    displayName,
    serverUrl,
    auth: { kind: 'token' },
    now: NOW,
  });
}

function mtlsProfile(id, displayName, identityId = `identity-${id}`) {
  return createConnectionProfile({
    id,
    displayName,
    serverUrl: 'https://paper.example.com/paperless',
    auth: {
      kind: 'mutual-tls',
      identity: {
        identityId,
        subject: `CN=${displayName}`,
        issuer: 'CN=Test CA',
        expiresAt: '2027-08-02T10:00:00.000Z',
        hasPrivateKey: true,
        source: 'managed-native-identity',
      },
    },
    now: NOW,
  });
}

async function beginPublication(journal, replacement, options = {}) {
  return journal.begin({
    schemaVersion: 1,
    operationId: options.operationId ?? `publish-${replacement.id}`,
    replacementProfileId: replacement.id,
    oldProfileId: options.oldProfileId ?? null,
    intendedActive: options.intendedActive ?? true,
    createdAt: NOW,
    connectionFingerprint: connectionProfileAuthFingerprint(replacement),
    clientIdentityRef: options.clientIdentityRef ?? null,
  });
}

test('normalizes a Paperless base URL while preserving its subpath', () => {
  assert.equal(
    normalizeServerBaseUrl(' HTTPS://Paper.Example.COM:443/paperless/// '),
    'https://paper.example.com/paperless',
  );
  assert.throws(
    () => normalizeServerBaseUrl('https://user:secret@paper.example.com/'),
    (error) => error.code === 'credentials-in-server-url',
  );
  assert.throws(
    () => normalizeServerBaseUrl('https://paper.example.com/?token=secret'),
    (error) => error.code === 'invalid-server-url',
  );
});

test('connection fingerprints bind server, auth method, and custom-header identity only', () => {
  const original = profile('profile-a', 'Primary', 'https://paper.example.com/archive/');
  const fingerprint = connectionProfileAuthFingerprint(original);

  assert.equal(connectionProfileAuthFingerprint({
    ...original,
    displayName: 'Renamed',
    updatedAt: '2026-08-02T11:00:00.000Z',
    status: { code: 'offline' },
  }), fingerprint);
  assert.notEqual(connectionProfileAuthFingerprint({
    ...original,
    serverUrl: 'https://other.example.com/archive',
  }), fingerprint);
  assert.notEqual(connectionProfileAuthFingerprint({
    ...original,
    auth: { kind: 'paperless-credentials', username: 'alice' },
  }), fingerprint);
  assert.notEqual(connectionProfileAuthFingerprint({
    ...original,
    customHeaderNames: ['X-Api-Key'],
  }), fingerprint);
  assert.equal(
    connectionProfileAuthFingerprint({
      ...original,
      customHeaderNames: ['Remote-User', 'X-Api-Key'],
    }),
    connectionProfileAuthFingerprint({
      ...original,
      customHeaderNames: ['x-api-key', 'remote-user'],
    }),
  );
});

test('stores multiple stable profile IDs even when the server URL is shared', async () => {
  const store = new MemoryStore();
  const repository = new ConnectionProfileRepository(store);
  await repository.add(profile('profile-alice', 'Alice'));
  await repository.add(profile('profile-bob', 'Bob'));

  const snapshot = await repository.getSnapshot();
  assert.deepEqual(
    snapshot.profiles.map((item) => item.id),
    ['profile-alice', 'profile-bob'],
  );
  assert.equal(snapshot.activeProfileId, 'profile-alice');
  assert.equal(snapshot.schemaVersion, 1);
});

test('custom-header profile metadata cannot diverge from its authenticated header set', () => {
  assert.throws(
    () => createConnectionProfile({
      id: 'profile-headers',
      displayName: 'Proxy',
      serverUrl: 'https://paper.example.com',
      auth: { kind: 'custom-headers', headerNames: ['X-Api-Key'] },
      customHeaderNames: ['Remote-User'],
      now: NOW,
    }),
    (error) => error.code === 'custom-header-metadata-mismatch',
  );
  assert.doesNotThrow(() => createConnectionProfile({
    id: 'profile-headers',
    displayName: 'Proxy',
    serverUrl: 'https://paper.example.com',
    auth: { kind: 'custom-headers', headerNames: ['X-Api-Key', 'Remote-User'] },
    customHeaderNames: ['remote-user', 'x-api-key'],
    now: NOW,
  }));
});

test('serializes active-profile changes into one internally consistent index record', async () => {
  const store = new MemoryStore();
  const repository = new ConnectionProfileRepository(store);
  await repository.add(profile('profile-a', 'A'));
  await repository.add(profile('profile-b', 'B'));

  await Promise.all([
    repository.setActiveProfile('profile-b'),
    repository.rename('profile-a', 'Renamed A', '2026-08-02T10:01:00.000Z'),
  ]);

  const snapshot = await repository.getSnapshot();
  assert.equal(snapshot.activeProfileId, 'profile-b');
  assert.equal(snapshot.profiles.find((item) => item.id === 'profile-a').displayName, 'Renamed A');
  assert.equal(snapshot.revision, 4);

  const persisted = JSON.parse(store.values.get(CONNECTION_PROFILE_INDEX_KEY));
  assert.equal(persisted.activeProfileId, 'profile-b');
  assert.ok(persisted.profiles.some((item) => item.id === persisted.activeProfileId));
});

test('does not publish an active-profile change when its single index write fails', async () => {
  const store = new MemoryStore();
  const repository = new ConnectionProfileRepository(store);
  await repository.add(profile('profile-a', 'A'));
  await repository.add(profile('profile-b', 'B'));
  store.failNextWrite = true;

  await assert.rejects(() => repository.setActiveProfile('profile-b'), /simulated write failure/);
  assert.equal((await repository.getSnapshot()).activeProfileId, 'profile-a');
});

test('migrates legacy credentials to profile metadata and a separate secret record', async () => {
  const store = new MemoryStore();
  await store.setItem(
    LEGACY_CREDENTIALS_KEY,
    JSON.stringify({ serverUrl: 'https://paper.example.com/root/', token: 'legacy-token' }),
  );
  const repository = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);

  const migration = await migrateLegacyCredentials({
    legacyStore: store,
    profiles: repository,
    secrets,
    createProfileId: () => 'legacy-profile',
    now: () => NOW,
  });

  assert.equal(migration.created, true);
  assert.equal((await repository.getSnapshot()).activeProfileId, 'legacy-profile');
  assert.deepEqual(await secrets.read('legacy-profile'), {
    apiToken: 'legacy-token',
    connectionFingerprint: connectionProfileAuthFingerprint(migration.profile),
  });
  assert.equal(await store.getItem(LEGACY_CREDENTIALS_KEY), null);
  assert.doesNotMatch(store.values.get(CONNECTION_PROFILE_INDEX_KEY), /legacy-token/);
  assert.match(store.values.get(`${PROFILE_SECRET_KEY_PREFIX}legacy-profile`), /legacy-token/);
});

test('retries legacy cleanup idempotently without duplicating or overwriting the migrated profile', async () => {
  const store = new MemoryStore();
  await store.setItem(
    LEGACY_CREDENTIALS_KEY,
    JSON.stringify({ serverUrl: 'https://paper.example.com', token: 'legacy-token' }),
  );
  const repository = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const options = {
    legacyStore: store,
    profiles: repository,
    secrets,
    createProfileId: () => 'legacy-profile',
    now: () => NOW,
  };
  store.failNextDelete = true;

  await assert.rejects(() => migrateLegacyCredentials(options), /simulated delete failure/);
  await secrets.write('legacy-profile', { apiToken: 'new-valid-token' });
  const retry = await migrateLegacyCredentials(options);

  assert.equal(retry.created, false);
  assert.equal((await repository.getSnapshot()).profiles.length, 1);
  assert.deepEqual(await secrets.read('legacy-profile'), {
    apiToken: 'new-valid-token',
    connectionFingerprint: connectionProfileAuthFingerprint(retry.profile),
  });
  assert.equal(await store.getItem(LEGACY_CREDENTIALS_KEY), null);
});

test('legacy migration leaves the original credential untouched when the profile index cannot be written', async () => {
  const store = new MemoryStore();
  const legacy = JSON.stringify({
    serverUrl: 'https://paper.example.com',
    token: 'legacy-token',
  });
  await store.setItem(LEGACY_CREDENTIALS_KEY, legacy);
  const repository = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  store.failNextWrite = true;

  await assert.rejects(
    () => migrateLegacyCredentials({
      legacyStore: store,
      profiles: repository,
      secrets,
      createProfileId: () => 'legacy-profile',
      now: () => NOW,
    }),
    /simulated write failure/,
  );

  assert.deepEqual((await repository.getSnapshot()).profiles, []);
  assert.equal(await secrets.read('legacy-profile'), null);
  assert.equal(await store.getItem(LEGACY_CREDENTIALS_KEY), legacy);
});

test('legacy migration rolls profile metadata back when protected secret storage fails', async () => {
  const store = new MemoryStore();
  const legacy = JSON.stringify({
    serverUrl: 'https://paper.example.com',
    token: 'legacy-token',
  });
  await store.setItem(LEGACY_CREDENTIALS_KEY, legacy);
  const repository = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const originalSetItem = store.setItem.bind(store);
  let failSecretWrite = true;
  store.setItem = async (key, value) => {
    if (failSecretWrite && key === `${PROFILE_SECRET_KEY_PREFIX}legacy-profile`) {
      failSecretWrite = false;
      throw new Error('simulated protected-store write failure');
    }
    await originalSetItem(key, value);
  };

  await assert.rejects(
    () => migrateLegacyCredentials({
      legacyStore: store,
      profiles: repository,
      secrets,
      createProfileId: () => 'legacy-profile',
      now: () => NOW,
    }),
    /simulated protected-store write failure/,
  );

  const snapshot = await repository.getSnapshot();
  assert.deepEqual(snapshot.profiles, []);
  assert.equal(snapshot.activeProfileId, null);
  assert.equal(await secrets.read('legacy-profile'), null);
  assert.equal(await store.getItem(LEGACY_CREDENTIALS_KEY), legacy);
});

test('keeps secrets isolated and deleting one profile secret leaves the other intact', async () => {
  const store = new MemoryStore();
  const secrets = new ProfileSecretStore(store);
  await secrets.write('profile-a', { apiToken: 'token-a' });
  await secrets.write('profile-b', {
    apiToken: 'token-b',
    customHeaders: { 'X-Api-Key': 'proxy-secret' },
  });

  await secrets.delete('profile-a');
  assert.equal(await secrets.read('profile-a'), null);
  assert.deepEqual(await secrets.read('profile-b'), {
    apiToken: 'token-b',
    customHeaders: { 'x-api-key': 'proxy-secret' },
  });
  assert.equal(store.values.has(`${PROFILE_SECRET_KEY_PREFIX}profile-a`), false);
  assert.equal(store.values.has(`${PROFILE_SECRET_KEY_PREFIX}profile-b`), true);
});

test('rejects accidental password or OTP persistence in a profile secret record', async () => {
  const secrets = new ProfileSecretStore(new MemoryStore());
  await assert.rejects(
    () => secrets.write('profile-a', { apiToken: 'token', password: 'do-not-store' }),
    (error) => error.code === 'invalid-profile-secret',
  );
  await assert.rejects(
    () => secrets.write('profile-a', { otpCode: '123456' }),
    (error) => error.code === 'invalid-profile-secret',
  );
});

test('stores a large removal manifest outside the compact protected journal record', async () => {
  const store = new SizeLimitedMemoryStore(512);
  const manifests = new MemoryManifestStore();
  const journal = removalJournal(store, manifests);
  const largeManifest = {
    version: 1,
    profileId: 'profile-a',
    operationId: 'remove-profile-a',
    moves: Array.from({ length: 80 }, (_, index) => ({
      originalUri: `file:///private/profile-a/${index}/${'source'.repeat(16)}`,
      quarantineUri: `file:///private/quarantine/${index}/${'target'.repeat(16)}`,
    })),
  };

  await journal.begin({
    schemaVersion: 2,
    operationId: 'remove-profile-a',
    profileId: 'profile-a',
    policy: 'delete-cache-and-jobs',
    createdAt: NOW,
    data: largeManifest,
  });

  const protectedRaw = await store.getItem(PROFILE_REMOVAL_JOURNAL_KEY);
  assert.ok(Buffer.byteLength(protectedRaw, 'utf8') < 512);
  assert.doesNotMatch(protectedRaw, /originalUri|quarantineUri|private\/profile-a/);
  assert.deepEqual((await journal.read()).data, largeManifest);
  assert.deepEqual((await manifests.read('remove-profile-a')).data, largeManifest);
});

test('a manifest orphaned before protected journal publication does not block retry', async () => {
  const store = new MemoryStore();
  const manifests = new MemoryManifestStore();
  const journal = removalJournal(store, manifests);
  const removal = {
    schemaVersion: 2,
    operationId: 'remove-profile-a',
    profileId: 'profile-a',
    policy: 'delete-cache-and-jobs',
    createdAt: NOW,
    data: { version: 1, profileId: 'profile-a', operationId: 'remove-profile-a', moves: [] },
  };
  store.failNextWrite = true;
  manifests.failNextDelete = true;

  await assert.rejects(
    () => journal.begin(removal),
    (error) => error.code === 'profile-removal-manifest-cleanup-failed',
  );
  assert.equal(await store.getItem(PROFILE_REMOVAL_JOURNAL_KEY), null);
  assert.ok(await manifests.read(removal.operationId));

  await journal.begin(removal);
  assert.deepEqual((await journal.read()).data, removal.data);
});

test('fails closed when a referenced removal manifest is missing or corrupt', async () => {
  for (const corrupt of [false, true]) {
    const store = new MemoryStore();
    const manifests = new MemoryManifestStore();
    const journal = removalJournal(store, manifests);
    await journal.begin({
      schemaVersion: 2,
      operationId: 'remove-profile-a',
      profileId: 'profile-a',
      policy: 'delete-cache-and-jobs',
      createdAt: NOW,
      data: { version: 1, profileId: 'profile-a', operationId: 'remove-profile-a' },
    });
    if (corrupt) {
      manifests.values.set('remove-profile-a', {
        ...(await manifests.read('remove-profile-a')),
        profileId: 'profile-other',
      });
    } else {
      await manifests.delete('remove-profile-a');
    }
    await assert.rejects(
      () => journal.read(),
      (error) => error.code === (
        corrupt ? 'profile-removal-manifest-mismatch' : 'profile-removal-manifest-missing'
      ),
    );
  }
});

test('removes only the selected profile secret and requires an explicit data policy', async () => {
  const store = new MemoryStore();
  const repository = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const journal = removalJournal(store);
  await repository.add(profile('profile-a', 'A'));
  await repository.add(profile('profile-b', 'B'));
  await secrets.write('profile-a', { apiToken: 'token-a' });
  await secrets.write('profile-b', { apiToken: 'token-b' });
  const result = await removeProfileWithSecrets({
    profileId: 'profile-a',
    policy: 'retain-cache-and-jobs',
    profiles: repository,
    secrets,
    journal,
    createOperationId: () => 'remove-profile-a',
    now: () => NOW,
  });

  assert.equal(result.activeProfileId, 'profile-b');
  assert.equal(await secrets.read('profile-a'), null);
  assert.deepEqual(await secrets.read('profile-b'), { apiToken: 'token-b' });
  assert.equal(await store.getItem(PROFILE_REMOVAL_JOURNAL_KEY), null);
});

test('native client identity removal is reference-counted across profiles', async () => {
  const store = new MemoryStore();
  const repository = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const journal = removalJournal(store);
  await repository.add(profile('profile-a', 'A'));
  await repository.add(profile('profile-b', 'B'));
  await secrets.write('profile-a', { clientIdentityRef: 'shared-native-ref' });
  await secrets.write('profile-b', { clientIdentityRef: 'shared-native-ref' });
  const removed = [];

  assert.equal(
    await removeClientIdentityIfUnreferenced({
      clientIdentityRef: 'shared-native-ref',
      profiles: repository,
      secrets,
      removeClientIdentity: async (value) => removed.push(value),
    }),
    'still-referenced',
  );
  await removeProfileWithSecrets({
    profileId: 'profile-a',
    policy: 'retain-cache-and-jobs',
    profiles: repository,
    secrets,
    journal,
    createOperationId: () => 'remove-profile-a',
    now: () => NOW,
  });
  assert.equal(
    await removeClientIdentityIfUnreferenced({
      clientIdentityRef: 'shared-native-ref',
      profiles: repository,
      secrets,
      removeClientIdentity: async (value) => removed.push(value),
    }),
    'still-referenced',
  );
  await removeProfileWithSecrets({
    profileId: 'profile-b',
    policy: 'retain-cache-and-jobs',
    profiles: repository,
    secrets,
    journal,
    createOperationId: () => 'remove-profile-b',
    now: () => NOW,
  });
  assert.equal(
    await removeClientIdentityIfUnreferenced({
      clientIdentityRef: 'shared-native-ref',
      profiles: repository,
      secrets,
      removeClientIdentity: async (value) => removed.push(value),
    }),
    'removed',
  );
  assert.deepEqual(removed, ['shared-native-ref']);
});

test('managed identity reconciliation retains a reference shared by saved profiles', async () => {
  const store = new MemoryStore();
  const repository = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  await repository.add(profile('profile-a', 'A'));
  await repository.add(profile('profile-b', 'B'));
  await secrets.write('profile-a', { clientIdentityRef: 'ios-keychain:shared' });
  await secrets.write('profile-b', { clientIdentityRef: 'ios-keychain:shared' });
  const deleted = [];

  const result = await reconcileManagedClientIdentities({
    profiles: repository,
    secrets,
    listManagedClientIdentityRefs: async () => ['ios-keychain:shared'],
    removeClientIdentity: async (reference) => deleted.push(reference),
  });

  assert.deepEqual(result, { retained: ['ios-keychain:shared'], removed: [] });
  assert.deepEqual(deleted, []);
});

test('managed identity reconciliation deletes a native-reported orphan', async () => {
  const store = new MemoryStore();
  const deleted = [];

  const result = await reconcileManagedClientIdentities({
    profiles: new ConnectionProfileRepository(store),
    secrets: new ProfileSecretStore(store),
    listManagedClientIdentityRefs: async () => ['ios-keychain:orphan'],
    removeClientIdentity: async (reference) => deleted.push(reference),
  });

  assert.deepEqual(result, { retained: [], removed: ['ios-keychain:orphan'] });
  assert.deepEqual(deleted, ['ios-keychain:orphan']);
});

test('managed identity reconciliation fails closed when any profile secret inventory read fails', async () => {
  const store = new MemoryStore();
  const repository = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  await repository.add(profile('profile-a', 'A'));
  await repository.add(profile('profile-b', 'B'));
  await secrets.write('profile-a', { clientIdentityRef: 'ios-keychain:shared' });
  await secrets.write('profile-b', { clientIdentityRef: 'ios-keychain:other' });
  const getItem = store.getItem.bind(store);
  store.getItem = async (key) => {
    if (key === `${PROFILE_SECRET_KEY_PREFIX}profile-b`) {
      throw new Error('simulated inventory failure');
    }
    return getItem(key);
  };
  let listed = false;
  const deleted = [];

  await assert.rejects(
    () => reconcileManagedClientIdentities({
      profiles: repository,
      secrets,
      listManagedClientIdentityRefs: async () => {
        listed = true;
        return ['ios-keychain:orphan'];
      },
      removeClientIdentity: async (reference) => deleted.push(reference),
    }),
    /simulated inventory failure/,
  );
  assert.equal(listed, false);
  assert.deepEqual(deleted, []);
});

test('managed identity reconciliation fails closed for an mTLS profile with no durable reference', async () => {
  const store = new MemoryStore();
  const repository = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  await repository.add(createConnectionProfile({
    id: 'profile-mtls',
    displayName: 'mTLS',
    serverUrl: 'https://paper.example.com',
    auth: {
      kind: 'mutual-tls',
      identity: {
        identityId: 'identity-a',
        subject: 'CN=Alice',
        issuer: 'CN=CA',
        expiresAt: '2027-01-01T00:00:00.000Z',
        hasPrivateKey: true,
        source: 'managed-native-identity',
      },
    },
    now: NOW,
  }));
  let listed = false;
  const deleted = [];

  await assert.rejects(
    () => reconcileManagedClientIdentities({
      profiles: repository,
      secrets,
      listManagedClientIdentityRefs: async () => {
        listed = true;
        return ['ios-keychain:possibly-owned'];
      },
      removeClientIdentity: async (reference) => deleted.push(reference),
    }),
    (error) => error.code === 'incomplete-managed-identity-inventory',
  );
  assert.equal(listed, false);
  assert.deepEqual(deleted, []);
});

test('managed identity reconciliation retries a failed deletion on the next run', async () => {
  const store = new MemoryStore();
  let listCalls = 0;
  let deleteCalls = 0;
  const dependencies = {
    profiles: new ConnectionProfileRepository(store),
    secrets: new ProfileSecretStore(store),
    listManagedClientIdentityRefs: async () => {
      listCalls += 1;
      return ['ios-keychain:retry'];
    },
    removeClientIdentity: async () => {
      deleteCalls += 1;
      if (deleteCalls === 1) throw new Error('simulated Keychain deletion failure');
    },
  };

  await assert.rejects(
    () => reconcileManagedClientIdentities(dependencies),
    /simulated Keychain deletion failure/,
  );
  assert.deepEqual(
    await reconcileManagedClientIdentities(dependencies),
    { retained: [], removed: ['ios-keychain:retry'] },
  );
  assert.equal(listCalls, 2);
  assert.equal(deleteCalls, 2);
});

test('startup reconciliation reclaims an import lost to process death before profile save', async () => {
  const store = new MemoryStore();
  const deleted = [];

  // The prepared-profile cache is process memory. An iOS import can survive a
  // kill between a successful test and committing its reference to a profile.
  await reconcileManagedClientIdentities({
    profiles: new ConnectionProfileRepository(store),
    secrets: new ProfileSecretStore(store),
    listManagedClientIdentityRefs: async () => ['ios-keychain:prepared-before-kill'],
    removeClientIdentity: async (reference) => deleted.push(reference),
  });

  assert.deepEqual(deleted, ['ios-keychain:prepared-before-kill']);
});

test('publication recovery rolls back a journal written before replacement metadata', async () => {
  const store = new MemoryStore();
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const old = profile('profile-a', 'A');
  const other = profile('profile-b', 'B');
  const replacement = profile('profile-a-prime', 'A prime', 'https://new.example.com');
  await profiles.add(old, { makeActive: true });
  await profiles.add(other);
  await secrets.write(old.id, { apiToken: 'token-a' });
  await secrets.write(other.id, { apiToken: 'token-b' });
  await beginPublication(secrets.publicationJournal, replacement, {
    oldProfileId: old.id,
  });

  const recovery = await recoverPendingProfilePublication({
    profiles,
    secrets,
    removalJournal: removalJournal(store),
    dataRemoval: profileDataRemoval(),
  });

  assert.equal(recovery.kind, 'rolled-back');
  assert.equal(recovery.snapshot.activeProfileId, old.id);
  assert.deepEqual(recovery.snapshot.profiles.map(({ id }) => id), [old.id, other.id]);
  assert.deepEqual(await secrets.read(old.id), { apiToken: 'token-a' });
  assert.deepEqual(await secrets.read(other.id), { apiToken: 'token-b' });
  assert.equal(await secrets.publicationJournal.read(), null);
});

test('rolling back an inactive rebind leaves unrelated active B unchanged', async () => {
  const store = new MemoryStore();
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const inactive = profile('profile-a', 'A');
  const active = profile('profile-b', 'B');
  const replacement = profile('profile-a-prime', 'A prime', 'https://new.example.com');
  await profiles.add(inactive);
  await profiles.add(active, { makeActive: true });
  await secrets.write(inactive.id, { apiToken: 'token-a' });
  await secrets.write(active.id, { apiToken: 'token-b' });
  await beginPublication(secrets.publicationJournal, replacement, {
    oldProfileId: inactive.id,
    intendedActive: false,
  });

  const recovery = await recoverPendingProfilePublication({
    profiles,
    secrets,
    removalJournal: removalJournal(store),
    dataRemoval: profileDataRemoval(),
  });

  assert.equal(recovery.kind, 'rolled-back');
  assert.equal(recovery.snapshot.activeProfileId, active.id);
  assert.deepEqual(recovery.snapshot.profiles.map(({ id }) => id), [inactive.id, active.id]);
});

test('publication recovery removes mTLS metadata without a secret and reclaims only its journaled identity', async () => {
  const store = new MemoryStore();
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const old = profile('profile-a', 'A');
  const replacement = mtlsProfile('profile-a-prime', 'A prime');
  await profiles.add(old, { makeActive: true });
  await secrets.write(old.id, { apiToken: 'token-a' });
  await beginPublication(secrets.publicationJournal, replacement, {
    oldProfileId: old.id,
    clientIdentityRef: 'ios-keychain:a-prime',
  });
  await profiles.add(replacement, { activateWhenFirst: false });
  const removed = [];

  const recovery = await recoverPendingProfilePublication({
    profiles,
    secrets,
    removalJournal: removalJournal(store),
    dataRemoval: profileDataRemoval(),
    removeClientIdentity: async (reference) => removed.push(reference),
  });

  assert.equal(recovery.kind, 'rolled-back');
  assert.equal(recovery.snapshot.activeProfileId, old.id);
  assert.deepEqual(recovery.snapshot.profiles.map(({ id }) => id), [old.id]);
  assert.deepEqual(removed, ['ios-keychain:a-prime']);
});

test('new mTLS metadata interrupted before its secret is rolled back without blocking later inventory', async () => {
  const store = new MemoryStore();
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const replacement = mtlsProfile('profile-new-mtls', 'New mTLS');
  await beginPublication(secrets.publicationJournal, replacement, {
    clientIdentityRef: 'ios-keychain:new-mtls',
  });
  await profiles.add(replacement, { activateWhenFirst: false });
  const removed = [];

  const recovery = await recoverPendingProfilePublication({
    profiles,
    secrets,
    removalJournal: removalJournal(store),
    dataRemoval: profileDataRemoval(),
    removeClientIdentity: async (reference) => removed.push(reference),
  });

  assert.equal(recovery.kind, 'rolled-back');
  assert.equal(recovery.snapshot.activeProfileId, null);
  assert.deepEqual(recovery.snapshot.profiles, []);
  assert.deepEqual(removed, ['ios-keychain:new-mtls']);
  assert.deepEqual(await reconcileManagedClientIdentities({
    profiles,
    secrets,
    listManagedClientIdentityRefs: async () => [],
    removeClientIdentity: async () => assert.fail('no native identity remains'),
  }), { retained: [], removed: [] });
});

test('fully published rebind removes only old A data and activates exact A prime instead of B', async () => {
  const store = new MemoryStore();
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const old = profile('profile-a', 'A');
  const other = profile('profile-b', 'B');
  const replacement = profile('profile-a-prime', 'A prime', 'https://new.example.com');
  await profiles.add(old, { makeActive: true });
  await profiles.add(other);
  await secrets.write(old.id, { apiToken: 'token-a' });
  await secrets.write(other.id, { apiToken: 'token-b' });
  await beginPublication(secrets.publicationJournal, replacement, {
    oldProfileId: old.id,
    operationId: 'rebind-a',
  });
  await profiles.add(replacement, { activateWhenFirst: false });
  await secrets.write(replacement.id, {
    apiToken: 'token-a-prime',
    connectionFingerprint: connectionProfileAuthFingerprint(replacement),
  });
  const dataRemoval = profileDataRemoval();

  const recovery = await recoverPendingProfilePublication({
    profiles,
    secrets,
    removalJournal: removalJournal(store),
    dataRemoval,
  });

  assert.equal(recovery.kind, 'completed');
  assert.equal(recovery.snapshot.activeProfileId, replacement.id);
  assert.deepEqual(recovery.snapshot.profiles.map(({ id }) => id), [other.id, replacement.id]);
  assert.equal(await secrets.read(old.id), null);
  assert.deepEqual(await secrets.read(other.id), { apiToken: 'token-b' });
  assert.deepEqual(await secrets.read(replacement.id), {
    apiToken: 'token-a-prime',
    connectionFingerprint: connectionProfileAuthFingerprint(replacement),
  });
  assert.deepEqual(
    dataRemoval.calls.filter(([name]) => name === 'commit').map(([, profileId]) => profileId),
    [old.id],
  );
  assert.equal(await secrets.publicationJournal.read(), null);
});

test('publication recovery corrects an old-removal fallback and is idempotent after activation', async () => {
  const store = new MemoryStore();
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const removals = removalJournal(store);
  const old = profile('profile-a', 'A');
  const other = profile('profile-b', 'B');
  const replacement = profile('profile-a-prime', 'A prime', 'https://new.example.com');
  await profiles.add(old, { makeActive: true });
  await profiles.add(other);
  await secrets.write(old.id, { apiToken: 'token-a' });
  await secrets.write(other.id, { apiToken: 'token-b' });
  await beginPublication(secrets.publicationJournal, replacement, { oldProfileId: old.id });
  await profiles.add(replacement, { activateWhenFirst: false });
  await secrets.write(replacement.id, {
    apiToken: 'token-a-prime',
    connectionFingerprint: connectionProfileAuthFingerprint(replacement),
  });
  await removeProfileWithSecrets({
    profileId: old.id,
    policy: 'retain-cache-and-jobs',
    profiles,
    secrets,
    journal: removals,
    createOperationId: () => 'independent-old-removal',
    now: () => NOW,
  });
  assert.equal((await profiles.getSnapshot()).activeProfileId, other.id);

  const first = await recoverPendingProfilePublication({
    profiles,
    secrets,
    removalJournal: removals,
    dataRemoval: profileDataRemoval(),
  });
  assert.equal(first.snapshot.activeProfileId, replacement.id);
  assert.equal((await recoverPendingProfilePublication({
    profiles,
    secrets,
    removalJournal: removals,
    dataRemoval: profileDataRemoval(),
  })).kind, 'none');
  assert.deepEqual(await secrets.read(other.id), { apiToken: 'token-b' });
});

test('journal clear failure after activation stays retryable across restart', async () => {
  const store = new MemoryStore();
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const replacement = profile('profile-new', 'New');
  await beginPublication(secrets.publicationJournal, replacement);
  await profiles.add(replacement, { activateWhenFirst: false });
  await secrets.write(replacement.id, {
    apiToken: 'token-new',
    connectionFingerprint: connectionProfileAuthFingerprint(replacement),
  });
  const originalDelete = store.deleteItem.bind(store);
  let failJournalClear = true;
  store.deleteItem = async (key) => {
    if (key === PROFILE_PUBLICATION_JOURNAL_KEY && failJournalClear) {
      failJournalClear = false;
      throw new Error('simulated publication journal clear failure');
    }
    await originalDelete(key);
  };
  const dependencies = {
    profiles,
    secrets,
    removalJournal: removalJournal(store),
    dataRemoval: profileDataRemoval(),
  };

  await assert.rejects(
    () => recoverPendingProfilePublication(dependencies),
    /journal clear failure/,
  );
  assert.equal((await profiles.getSnapshot()).activeProfileId, replacement.id);
  assert.ok(await secrets.publicationJournal.read());
  const restarted = await recoverPendingProfilePublication(dependencies);
  assert.equal(restarted.kind, 'completed');
  assert.equal(restarted.snapshot.activeProfileId, replacement.id);
  assert.equal(await secrets.publicationJournal.read(), null);
});

test('corrupt publication journals fail closed without changing profiles or secrets', async () => {
  const store = new MemoryStore();
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const saved = profile('profile-a', 'A');
  await profiles.add(saved, { makeActive: true });
  await secrets.write(saved.id, { apiToken: 'token-a' });
  store.values.set(PROFILE_PUBLICATION_JOURNAL_KEY, JSON.stringify({
    schemaVersion: 1,
    operationId: 'publish-a',
    replacementProfileId: 'profile-new',
    oldProfileId: saved.id,
    intendedActive: true,
    createdAt: NOW,
    connectionFingerprint: '{}',
    clientIdentityRef: null,
    apiToken: 'must-not-be-accepted',
  }));

  await assert.rejects(
    () => recoverPendingProfilePublication({
      profiles,
      secrets,
      removalJournal: removalJournal(store),
      dataRemoval: profileDataRemoval(),
    }),
    (error) => error.code === 'invalid-profile-publication-journal',
  );
  assert.equal((await profiles.getSnapshot()).activeProfileId, saved.id);
  assert.deepEqual(await secrets.read(saved.id), { apiToken: 'token-a' });
  assert.ok(await store.getItem(PROFILE_PUBLICATION_JOURNAL_KEY));
});

test('direct identity cleanup fails closed when any mTLS profile is incomplete', async () => {
  const store = new MemoryStore();
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  await profiles.add(mtlsProfile('profile-mtls', 'mTLS'), { makeActive: true });
  const deleted = [];

  await assert.rejects(
    () => removeClientIdentityIfUnreferenced({
      clientIdentityRef: 'ios-keychain:possibly-owned',
      profiles,
      secrets,
      removeClientIdentity: async (reference) => deleted.push(reference),
    }),
    (error) => error.code === 'incomplete-managed-identity-inventory',
  );
  assert.deepEqual(deleted, []);
});

test('restores a profile secret if removing its metadata fails', async () => {
  const store = new MemoryStore();
  const repository = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const journal = removalJournal(store);
  await repository.add(profile('profile-a', 'A'));
  await secrets.write('profile-a', { apiToken: 'token-a' });
  store.failNextWrite = true;

  await assert.rejects(
    () =>
      removeProfileWithSecrets({
        profileId: 'profile-a',
        policy: 'retain-cache-and-jobs',
        profiles: repository,
        secrets,
        journal,
        createOperationId: () => 'remove-profile-a',
        now: () => NOW,
      }),
    /simulated write failure/,
  );

  assert.equal((await repository.getSnapshot()).activeProfileId, 'profile-a');
  assert.deepEqual(await secrets.read('profile-a'), { apiToken: 'token-a' });
});

test('startup finishes a committed removal when protected secret deletion was interrupted', async () => {
  const store = new MemoryStore();
  const repository = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const journal = removalJournal(store);
  const dataRemoval = profileDataRemoval();
  await repository.add(profile('profile-a', 'A'));
  await secrets.write('profile-a', { apiToken: 'token-a' });
  store.failNextDelete = true;

  let revokedSnapshot = null;
  await assert.rejects(
    () => removeProfileWithSecrets({
      profileId: 'profile-a',
      policy: 'delete-cache-and-jobs',
      profiles: repository,
      secrets,
      journal,
      dataRemoval,
      createOperationId: () => 'remove-profile-a',
      now: () => NOW,
      onProfileRevoked: (snapshot) => { revokedSnapshot = snapshot; },
    }),
    (error) => error.code === 'profile-removal-cleanup-pending'
      && /simulated delete failure/.test(error.cause?.message ?? ''),
  );

  assert.equal(revokedSnapshot.activeProfileId, null);
  assert.equal(revokedSnapshot.profiles.length, 0);
  assert.equal((await repository.getSnapshot()).activeProfileId, null);
  assert.deepEqual(await secrets.read('profile-a'), { apiToken: 'token-a' });
  assert.ok(await journal.read());

  const recovery = await recoverPendingProfileRemoval({
    profiles: repository,
    secrets,
    journal,
    dataRemoval,
  });
  assert.equal(recovery.kind, 'completed');
  assert.equal(await secrets.read('profile-a'), null);
  assert.equal(await journal.read(), null);
  assert.ok(dataRemoval.calls.some(([name]) => name === 'finalize'));
});

test('startup restores quarantined files when profile data deletion did not commit', async () => {
  const store = new MemoryStore();
  const repository = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const journal = removalJournal(store);
  const dataRemoval = profileDataRemoval();
  await repository.add(profile('profile-a', 'A'));
  await secrets.write('profile-a', { apiToken: 'token-a' });
  await journal.begin({
    schemaVersion: 1,
    operationId: 'remove-profile-a',
    profileId: 'profile-a',
    policy: 'delete-cache-and-jobs',
    createdAt: NOW,
    data: { version: 1, profileId: 'profile-a', operationId: 'remove-profile-a' },
  });

  const recovery = await recoverPendingProfileRemoval({
    profiles: repository,
    secrets,
    journal,
    dataRemoval,
  });

  assert.equal(recovery.kind, 'rolled-back');
  assert.equal(recovery.snapshot.activeProfileId, 'profile-a');
  assert.deepEqual(await secrets.read('profile-a'), { apiToken: 'token-a' });
  assert.equal(await journal.read(), null);
  assert.ok(dataRemoval.calls.some(([name]) => name === 'rollback'));
  assert.ok(!dataRemoval.calls.some(([name]) => name === 'finalize'));
});

test('failed quarantine deletion remains journaled and is retried on startup', async () => {
  const store = new MemoryStore();
  const repository = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const journal = removalJournal(store);
  let failFinalize = true;
  const dataRemoval = profileDataRemoval({
    finalize: async () => {
      if (failFinalize) {
        failFinalize = false;
        throw new Error('simulated quarantine unlink failure');
      }
    },
  });
  await repository.add(profile('profile-a', 'A'));
  await secrets.write('profile-a', { apiToken: 'token-a' });

  let revokedSnapshot = null;
  await assert.rejects(
    () => removeProfileWithSecrets({
      profileId: 'profile-a',
      policy: 'delete-cache-and-jobs',
      profiles: repository,
      secrets,
      journal,
      dataRemoval,
      createOperationId: () => 'remove-profile-a',
      now: () => NOW,
      onProfileRevoked: (snapshot) => { revokedSnapshot = snapshot; },
    }),
    (error) => error.code === 'profile-removal-cleanup-pending'
      && /simulated quarantine unlink failure/.test(error.cause?.message ?? ''),
  );
  assert.equal(revokedSnapshot.activeProfileId, null);
  assert.equal(revokedSnapshot.profiles.length, 0);
  assert.equal((await repository.getSnapshot()).profiles.length, 0);
  assert.equal(await secrets.read('profile-a'), null);
  assert.ok(await journal.read());

  const recovery = await recoverPendingProfileRemoval({
    profiles: repository,
    secrets,
    journal,
    dataRemoval,
  });
  assert.equal(recovery.kind, 'completed');
  assert.equal(await journal.read(), null);
  assert.equal(dataRemoval.calls.filter(([name]) => name === 'finalize').length, 2);
});

test('rolls profile metadata and secrets back when scoped data cleanup fails', async () => {
  const store = new MemoryStore();
  const repository = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const journal = removalJournal(store);
  const dataRemoval = profileDataRemoval({
    commit: async () => {
      throw new Error('simulated atomic data cleanup failure');
    },
  });
  await repository.add(profile('profile-a', 'A'));
  await repository.add(profile('profile-b', 'B'));
  await secrets.write('profile-a', { apiToken: 'token-a' });
  await secrets.write('profile-b', { apiToken: 'token-b' });

  await assert.rejects(
    () => removeProfileWithSecrets({
      profileId: 'profile-a',
      policy: 'delete-cache-and-jobs',
      profiles: repository,
      secrets,
      journal,
      dataRemoval,
      createOperationId: () => 'remove-profile-a',
      now: () => NOW,
    }),
    /simulated atomic data cleanup failure/,
  );

  const snapshot = await repository.getSnapshot();
  assert.deepEqual(snapshot.profiles.map((item) => item.id), ['profile-a', 'profile-b']);
  assert.equal(snapshot.activeProfileId, 'profile-a');
  assert.deepEqual(await secrets.read('profile-a'), { apiToken: 'token-a' });
  assert.deepEqual(await secrets.read('profile-b'), { apiToken: 'token-b' });
  assert.equal(await journal.read(), null);
  assert.ok(dataRemoval.calls.some(([name]) => name === 'rollback'));
});

test('refuses delete-data profile removal without a scoped cleanup adapter', async () => {
  const store = new MemoryStore();
  const repository = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const journal = removalJournal(store);
  await repository.add(profile('profile-a', 'A'));
  await secrets.write('profile-a', { apiToken: 'token-a' });

  await assert.rejects(
    () =>
      removeProfileWithSecrets({
        profileId: 'profile-a',
        policy: 'delete-cache-and-jobs',
        profiles: repository,
        secrets,
        journal,
        createOperationId: () => 'remove-profile-a',
        now: () => NOW,
      }),
    (error) => error.code === 'connection-cleanup-required',
  );
  assert.deepEqual(await secrets.read('profile-a'), { apiToken: 'token-a' });
});

test('allowlists custom headers, warns on Authorization, and redacts every value', () => {
  const result = validateCustomHeaders({
    Authorization: 'Bearer proxy-token',
    'X-Api-Key': 'api-key',
  });
  assert.deepEqual({ ...result.headers }, {
    authorization: 'Bearer proxy-token',
    'x-api-key': 'api-key',
  });
  assert.deepEqual(result.warnings, ['authorization-overrides-profile-auth']);
  assert.deepEqual(redactHeaders(result.headers), {
    authorization: '[REDACTED]',
    'x-api-key': '[REDACTED]',
  });
  assert.throws(
    () => validateCustomHeaders({ Cookie: 'session=secret' }),
    (error) => error.code === 'custom-header-not-allowed' && !error.message.includes('session=secret'),
  );
  assert.throws(
    () => validateCustomHeaders({ 'X-Api-Key': 'secret\r\nX-Evil: yes' }),
    (error) => error.code === 'invalid-custom-header-value' && !error.message.includes('secret'),
  );
});

test('builds isolated token headers and applies a custom Authorization override explicitly', async () => {
  const secrets = new ProfileSecretStore(new MemoryStore());
  await secrets.write('profile-a', {
    apiToken: 'paperless-token',
    customHeaders: { Authorization: 'Bearer proxy-token' },
  });

  const result = await secrets.requestHeaders('profile-a');
  assert.deepEqual(result.headers, { authorization: 'Bearer proxy-token' });
  assert.deepEqual(result.warnings, ['authorization-overrides-profile-auth']);
});

test('never builds a Paperless authorization header from a legacy IdP token', async () => {
  const secrets = new ProfileSecretStore(new MemoryStore());
  await secrets.write('profile-oidc', {
    oidc: { accessToken: 'oidc-access-token', idToken: 'oidc-id-token' },
  });
  await secrets.write('profile-token', { apiToken: 'paperless-token' });

  assert.deepEqual((await secrets.requestHeaders('profile-oidc')).headers, {});
  assert.deepEqual((await secrets.requestHeaders('profile-token')).headers, {
    authorization: 'Token paperless-token',
  });
});

test('accepts a manually supplied API token without retaining surrounding input', () => {
  assert.deepEqual(acceptApiToken('  abc123  '), { apiToken: 'abc123' });
  assert.throws(() => acceptApiToken('not a token'), (error) => error.code === 'invalid-token');
});

test('acquires a Paperless token with password and OTP using the documented code field', async () => {
  let captured;
  const result = await acquirePaperlessToken(
    {
      serverUrl: 'https://paper.example.com/subpath/',
      username: 'alice',
      password: 'password-secret',
      otpCode: '123456',
    },
    {
      request: async (request) => {
        captured = request;
        return { status: 200, body: { token: 'api-token' } };
      },
    },
  );

  assert.deepEqual(result, { apiToken: 'api-token' });
  assert.equal(captured.url, 'https://paper.example.com/subpath/api/token/');
  assert.equal(captured.redirect, 'manual');
  assert.deepEqual(JSON.parse(captured.body), {
    username: 'alice',
    password: 'password-secret',
    code: '123456',
  });
  assert.doesNotMatch(JSON.stringify(result), /password-secret|123456/);
});

test('classifies required and invalid Paperless MFA codes without echoing server details', async () => {
  await assert.rejects(
    () =>
      acquirePaperlessToken(
        { serverUrl: 'https://paper.example.com', username: 'alice', password: 'secret' },
        {
          request: async () => ({
            status: 400,
            body: { non_field_errors: ['MFA code is required'] },
          }),
        },
      ),
    (error) => error.code === 'otp-required' && error.retryable,
  );
  await assert.rejects(
    () =>
      acquirePaperlessToken(
        {
          serverUrl: 'https://paper.example.com',
          username: 'alice',
          password: 'secret',
          otpCode: '123456',
        },
        {
          request: async () => ({
            status: 400,
            body: { non_field_errors: ['Invalid MFA code: 123456'] },
          }),
        },
      ),
    (error) => error.code === 'otp-invalid' && !error.message.includes('123456'),
  );
});

test('never replays a credential POST across a redirect', async () => {
  await assert.rejects(
    () =>
      acquirePaperlessToken(
        { serverUrl: 'https://paper.example.com', username: 'alice', password: 'secret' },
        {
          request: async () => ({
            status: 302,
            headers: { Location: 'https://evil.example.com/steal' },
          }),
        },
      ),
    (error) => error.code === 'unsafe-redirect',
  );
});

test('rejects HTTPS downgrade and unapproved cross-origin redirects', () => {
  assert.throws(
    () => validateServerRedirect('https://paper.example.com/api/', 'http://paper.example.com/api/'),
    (error) => error.code === 'https-downgrade',
  );
  assert.throws(
    () => validateServerRedirect('https://paper.example.com/api/', 'https://other.example.com/api/'),
    (error) => error.code === 'cross-origin-redirect',
  );
  assert.equal(
    validateServerRedirect('https://paper.example.com/api/', '/paperless/api/'),
    'https://paper.example.com/paperless/api/',
  );
});

const oidcCrypto = {
  nextByte: 1,
  randomBytes(length) {
    const bytes = new Uint8Array(length);
    bytes.fill(this.nextByte++);
    return bytes;
  },
  async sha256(value) {
    return new Uint8Array(createHash('sha256').update(value).digest());
  },
};

test('creates OIDC authorization code requests with S256 PKCE, state, and nonce', async () => {
  oidcCrypto.nextByte = 1;
  const start = await createOidcAuthorizationAttempt(
    {
      issuer: 'https://idp.example.com/',
      authorizationEndpoint: 'https://idp.example.com/oauth/authorize',
      clientId: 'folio-mobile',
      redirectUri: 'folio://oauth/callback',
      scopes: ['profile'],
      now: NOW,
    },
    oidcCrypto,
  );
  const url = new URL(start.authorizationUrl);

  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), start.attempt.state);
  assert.equal(url.searchParams.get('nonce'), start.attempt.nonce);
  assert.equal(url.searchParams.get('scope'), 'openid profile');
  const expectedChallenge = createHash('sha256')
    .update(start.attempt.codeVerifier)
    .digest('base64url');
  assert.equal(start.attempt.codeChallenge, expectedChallenge);
});

test('validates OIDC callback redirect and state and consumes it only once', async () => {
  oidcCrypto.nextByte = 10;
  const { attempt } = await createOidcAuthorizationAttempt(
    {
      issuer: 'https://idp.example.com',
      authorizationEndpoint: 'https://idp.example.com/authorize',
      clientId: 'folio',
      redirectUri: 'folio://oauth/callback',
      now: NOW,
    },
    oidcCrypto,
  );
  const store = new InMemoryOidcAttemptStore();
  await store.save(attempt);
  const callback = `folio://oauth/callback?code=auth-code&state=${attempt.state}`;

  const result = await consumeOidcCallback(store, attempt.id, callback, {
    now: '2026-08-02T10:05:00.000Z',
  });
  assert.equal(result.code, 'auth-code');
  await assert.rejects(
    () =>
      consumeOidcCallback(store, attempt.id, callback, {
        now: '2026-08-02T10:05:01.000Z',
      }),
    (error) => error.code === 'replayed-callback',
  );
  assert.throws(
    () =>
      validateOidcCallback(
        attempt,
        `folio://wrong/callback?code=x&state=${attempt.state}`,
        { now: '2026-08-02T10:05:00.000Z' },
      ),
    (error) => error.code === 'redirect-mismatch',
  );
  assert.throws(
    () =>
      validateOidcCallback(attempt, 'folio://oauth/callback?code=x&state=wrong', {
        now: '2026-08-02T10:05:00.000Z',
      }),
    (error) => error.code === 'state-mismatch',
  );
  assert.throws(
    () => validateOidcCallback(
      attempt,
      `folio://oauth/callback?code=x&state=${attempt.state}&state=${attempt.state}`,
      { now: '2026-08-02T10:05:00.000Z' },
    ),
    (error) => error.code === 'state-mismatch',
  );
  assert.throws(
    () => validateOidcCallback(
      attempt,
      `folio://oauth/callback?code=x&code=y&state=${attempt.state}`,
      { now: '2026-08-02T10:05:00.000Z' },
    ),
    (error) => error.code === 'invalid-callback',
  );
});

test('validates discovered issuer and verified ID-token issuer, audience, nonce, and expiry', async () => {
  const discovery = validateOidcDiscovery('https://idp.example.com', {
    issuer: 'https://idp.example.com/',
    authorizationEndpoint: 'https://login.example.com/authorize',
    tokenEndpoint: 'https://login.example.com/token',
  });
  assert.equal(discovery.issuer, 'https://idp.example.com');
  assert.throws(
    () => validateOidcDiscovery('https://idp.example.com?tenant=other', {
      issuer: 'https://idp.example.com?tenant=other',
      authorizationEndpoint: 'https://login.example.com/authorize',
      tokenEndpoint: 'https://login.example.com/token',
    }),
    (error) => error.code === 'invalid-configuration',
  );

  const attempt = {
    id: 'attempt',
    issuer: 'https://idp.example.com',
    clientId: 'folio',
    redirectUri: 'folio://oauth/callback',
    state: 'state',
    nonce: 'nonce',
    codeVerifier: 'verifier',
    codeChallenge: 'challenge',
    createdAt: NOW,
  };
  const claims = {
    iss: 'https://idp.example.com',
    sub: 'alice',
    aud: ['another-client', 'folio'],
    azp: 'folio',
    nonce: 'nonce',
    exp: 2_000_000_000,
  };
  const verifier = { verify: async () => claims };

  assert.equal(
    (
      await validateOidcTokenResponse(
        { accessToken: 'access', idToken: 'signed-jwt', tokenType: 'Bearer' },
        attempt,
        verifier,
        { nowEpochSeconds: 1_800_000_000 },
      )
    ).sub,
    'alice',
  );
  await assert.rejects(
    () =>
      validateOidcTokenResponse(
        { accessToken: 'access', idToken: 'signed-jwt' },
        { ...attempt, nonce: 'different' },
        verifier,
        { nowEpochSeconds: 1_800_000_000 },
      ),
    (error) => error.code === 'nonce-mismatch',
  );
  for (const azp of [undefined, 'another-client', 42]) {
    await assert.rejects(
      () => validateOidcTokenResponse(
        { accessToken: 'access', idToken: 'signed-jwt' },
        attempt,
        { verify: async () => ({ ...claims, azp }) },
        { nowEpochSeconds: 1_800_000_000 },
      ),
      (error) => error.code === 'audience-mismatch',
    );
  }
  assert.equal((await validateOidcTokenResponse(
    { accessToken: 'access', idToken: 'signed-jwt' },
    attempt,
    { verify: async () => ({ ...claims, aud: 'folio', azp: undefined }) },
    { nowEpochSeconds: 1_800_000_000 },
  )).sub, 'alice');
});

test('reports explicit mTLS identity and native-transport capability errors', async () => {
  assert.throws(
    () =>
      assertUsableClientIdentity(
        {
          identityId: 'identity-a',
          subject: 'CN=Alice',
          issuer: 'CN=CA',
          expiresAt: '2026-08-01T00:00:00.000Z',
          hasPrivateKey: true,
        },
        NOW,
      ),
    (error) => error.code === 'client-identity-expired',
  );
  assert.throws(
    () =>
      assertUsableClientIdentity(
        {
          identityId: 'identity-a',
          subject: 'CN=Alice',
          issuer: 'CN=CA',
          expiresAt: '2027-08-01T00:00:00.000Z',
          hasPrivateKey: false,
        },
        NOW,
      ),
    (error) => error.code === 'client-identity-missing-private-key',
  );
  await assert.rejects(
    () => requireNativeMtlsTransport(null),
    (error) => error.code === 'native-mtls-transport-unavailable',
  );
  await assert.rejects(
    () => requireNativeMtlsTransport({ isAvailable: async () => false }),
    (error) => error.code === 'native-mtls-transport-unavailable',
  );
});
