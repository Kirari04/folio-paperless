import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ProfileConnectionTestError,
  classifyApiVersion,
  testPaperlessProfileConnection,
} from '../src/lib/auth/fetch-adapter.ts';
import {
  prepareConnectionProfile,
  persistPreparedConnectionProfile,
  preparedProfileRebindsAuthority,
} from '../src/lib/auth/profile-management.ts';
import {
  credentialsMatchStoredProfile,
  profileSecretsAuthorizeSameContext,
} from '../src/lib/auth/credential-authority.ts';
import {
  CONNECTION_PROFILE_INDEX_KEY,
  PROFILE_PUBLICATION_JOURNAL_KEY,
  PROFILE_SECRET_KEY_PREFIX,
  ConnectionProfileRepository,
  ManagedClientIdentityCoordinator,
  ProfileSecretStore,
  connectionProfileAuthFingerprint,
  createConnectionProfile,
  removeClientIdentityIfUnreferenced,
} from '../src/lib/auth/profile-store.ts';

const NOW = '2026-08-02T10:00:00.000Z';

class MemoryStore {
  values = new Map();

  async getItem(key) {
    return this.values.get(key) ?? null;
  }

  async setItem(key, value) {
    this.values.set(key, value);
  }

  async deleteItem(key) {
    this.values.delete(key);
  }
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('real connection test preserves the server subpath and classifies user, version, and permissions', async () => {
  const requests = [];
  const details = await testPaperlessProfileConnection(
    {
      serverUrl: 'https://paper.example.com/paperless/',
      token: 'api-token',
      customHeaders: { 'X-Api-Key': 'proxy-secret' },
    },
    {
      fetchImpl: async (url, init) => {
        requests.push({ url, init });
        if (url.endsWith('/api/ui_settings/')) {
          return jsonResponse({
            user: { username: 'alice', is_superuser: false },
            permissions: ['view_document'],
            settings: { app_title: 'Family archive' },
          }, 200, { 'X-Version': '2.16.3', 'X-Api-Version': '10' });
        }
        return jsonResponse({ count: 0, results: [] }, 200, {
          'X-Version': '2.16.3',
          'X-Api-Version': '10',
        });
      },
    },
  );

  assert.deepEqual(details, {
    apiVersion: '10',
    serverVersion: '2.16.3',
    appTitle: 'Family archive',
    username: 'alice',
    permissions: ['view_document'],
    isSuperuser: false,
  });
  assert.deepEqual(requests.map((request) => request.url), [
    'https://paper.example.com/paperless/api/documents/?page_size=1&truncate_content=true',
    'https://paper.example.com/paperless/api/ui_settings/',
  ]);
  assert.equal(requests[0].init.redirect, 'manual');
  assert.equal(requests[0].init.headers.Authorization, 'Token api-token');
  assert.equal(requests[0].init.headers['X-Api-Key'], 'proxy-secret');
});

test('connection test rejects non-allowlisted custom headers before the network sink', async () => {
  let requests = 0;
  await assert.rejects(
    () => testPaperlessProfileConnection(
      {
        serverUrl: 'https://paper.example.com',
        token: 'api-token',
        customHeaders: { Cookie: 'session=secret' },
      },
      {
        fetchImpl: async () => {
          requests += 1;
          return jsonResponse({ count: 0, results: [] });
        },
      },
    ),
    (error) => error.code === 'custom-header-not-allowed' && !error.message.includes('secret'),
  );
  assert.equal(requests, 0);
});

test('connection test distinguishes auth, permissions, TLS, redirects, and unsupported API', async () => {
  const credentials = { serverUrl: 'https://paper.example.com', token: 'token' };
  await assert.rejects(
    () => testPaperlessProfileConnection(credentials, {
      fetchImpl: async () => jsonResponse({}, 401),
    }),
    (error) => error instanceof ProfileConnectionTestError && error.code === 'authentication-failure',
  );
  await assert.rejects(
    () => testPaperlessProfileConnection(credentials, {
      fetchImpl: async () => jsonResponse({}, 403),
    }),
    (error) => error.code === 'insufficient-permissions',
  );
  await assert.rejects(
    () => testPaperlessProfileConnection(credentials, {
      fetchImpl: async () => {
        throw new Error('certificate verify failed');
      },
    }),
    (error) => error.code === 'tls-failure',
  );
  await assert.rejects(
    () => testPaperlessProfileConnection(credentials, {
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.com/api/' },
      }),
    }),
    (error) => error.code === 'unsafe-redirect',
  );
  assert.throws(() => classifyApiVersion('9'), (error) => error.code === 'unsupported-api');
});

test('username/password preparation persists only the acquired API token and handles OTP without retention', async () => {
  const captured = [];
  const prepared = await prepareConnectionProfile(
    {
      displayName: 'Alice',
      serverUrl: 'https://paper.example.com/subpath',
      auth: {
        kind: 'paperless-credentials',
        username: 'alice',
        password: 'password-secret',
        otpCode: '123456',
      },
    },
    {},
    {
      authHttpClient: {
        request: async (request) => {
          captured.push(request);
          return { status: 200, body: { token: 'acquired-token' } };
        },
      },
      testConnection: async () => ({
        apiVersion: '10',
        serverVersion: '2.16.3',
        username: 'alice',
        permissions: ['view_document'],
        isSuperuser: false,
      }),
    },
  );

  assert.deepEqual(prepared.secrets, { apiToken: 'acquired-token' });
  assert.equal(prepared.draft.auth.kind, 'paperless-credentials');
  assert.equal(prepared.draft.auth.username, 'alice');
  assert.doesNotMatch(JSON.stringify(prepared), /password-secret|123456/);
  assert.deepEqual(JSON.parse(captured[0].body), {
    username: 'alice',
    password: 'password-secret',
    code: '123456',
  });
});

test('OIDC cancellation leaves profile and secret repositories untouched', async () => {
  const store = new MemoryStore();
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const cancellation = Object.assign(new Error('OIDC sign-in was canceled.'), { code: 'canceled' });

  await assert.rejects(
    () => prepareConnectionProfile(
      {
        displayName: 'OIDC archive',
        serverUrl: 'https://paper.example.com',
        auth: {
          kind: 'oidc',
          issuer: 'https://id.example.com',
          clientId: 'folio',
          redirectUri: 'folio-paperless://oauth/callback',
          scopes: ['openid'],
          forceLogin: true,
        },
      },
      {},
      {
        authHttpClient: { request: async () => ({ status: 500 }) },
        testConnection: async () => assert.fail('connection test must not run after cancellation'),
        loginOidc: async () => {
          throw cancellation;
        },
      },
    ),
    (error) => error.code === 'canceled',
  );
  assert.equal((await profiles.getSnapshot()).profiles.length, 0);
  assert.equal(await secrets.read('oidc-profile'), null);
});

test('prepared profiles support multiple users on one URL and make removal ownership explicit', async () => {
  const store = new MemoryStore();
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const base = {
    connection: {
      apiVersion: '10',
      serverVersion: '2.16.3',
      permissions: ['view_document'],
      isSuperuser: false,
    },
    warnings: [],
  };
  const alice = {
    ...base,
    draft: {
      displayName: 'Alice',
      serverUrl: 'https://paper.example.com',
      auth: { kind: 'token' },
    },
    credentials: { serverUrl: 'https://paper.example.com', token: 'alice-token' },
    secrets: { apiToken: 'alice-token' },
  };
  const bob = {
    ...base,
    draft: {
      displayName: 'Bob',
      serverUrl: 'https://paper.example.com',
      auth: { kind: 'paperless-credentials', username: 'bob' },
    },
    credentials: { serverUrl: 'https://paper.example.com', token: 'bob-token' },
    secrets: { apiToken: 'bob-token' },
  };
  let id = 0;
  const dependencies = {
    profiles,
    secrets,
    createProfileId: () => `profile-${++id}`,
    now: () => NOW,
  };

  const aliceProfile = await persistPreparedConnectionProfile(alice, dependencies, { makeActive: true });
  const bobProfile = await persistPreparedConnectionProfile(bob, dependencies);
  const snapshot = await profiles.getSnapshot();

  assert.equal(snapshot.profiles.length, 2);
  assert.equal(snapshot.activeProfileId, aliceProfile.id);
  assert.equal(aliceProfile.serverUrl, bobProfile.serverUrl);
  assert.deepEqual(await secrets.read(aliceProfile.id), {
    apiToken: 'alice-token',
    connectionFingerprint: connectionProfileAuthFingerprint(aliceProfile),
  });
  assert.deepEqual(await secrets.read(bobProfile.id), {
    apiToken: 'bob-token',
    connectionFingerprint: connectionProfileAuthFingerprint(bobProfile),
  });
});

test('editing with a failed test does not overwrite the previously valid profile secret', async () => {
  const store = new MemoryStore();
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const existing = createConnectionProfile({
    id: 'profile-a',
    displayName: 'Primary',
    serverUrl: 'https://paper.example.com',
    auth: { kind: 'token' },
    now: NOW,
  });
  await profiles.add(existing, { makeActive: true });
  await secrets.write(existing.id, { apiToken: 'known-good-token' });
  const existingSecrets = await secrets.read(existing.id);

  await assert.rejects(
    () => prepareConnectionProfile(
      {
        profileId: existing.id,
        displayName: 'Primary renamed',
        serverUrl: existing.serverUrl,
        auth: { kind: 'token', token: 'rejected-token' },
      },
      { existingProfile: existing, existingSecrets },
      {
        authHttpClient: { request: async () => ({ status: 500 }) },
        testConnection: async () => {
          throw new ProfileConnectionTestError(
            'authentication-failure',
            'Paperless rejected this authentication.',
          );
        },
      },
    ),
    (error) => error.code === 'authentication-failure',
  );
  assert.deepEqual(await secrets.read(existing.id), { apiToken: 'known-good-token' });
  assert.equal((await profiles.getSnapshot()).profiles[0].displayName, 'Primary');
});

test('failed authority-rebind persistence leaves the old ID, metadata, and secrets untouched', async () => {
  const store = new MemoryStore();
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const existing = createConnectionProfile({
    id: 'profile-a',
    displayName: 'Primary',
    serverUrl: 'https://paper.example.com/archive',
    auth: { kind: 'token' },
    now: NOW,
  });
  const previousSecrets = {
    apiToken: 'known-good-token',
    connectionFingerprint: connectionProfileAuthFingerprint(existing),
  };
  await profiles.add(existing, { makeActive: true });
  await secrets.write(existing.id, previousSecrets);

  const originalSetItem = store.setItem.bind(store);
  let failProfileWrite = true;
  store.setItem = async (key, value) => {
    if (failProfileWrite && key === CONNECTION_PROFILE_INDEX_KEY) {
      failProfileWrite = false;
      throw new Error('simulated profile index write failure');
    }
    await originalSetItem(key, value);
  };

  await assert.rejects(
    () => persistPreparedConnectionProfile({
      draft: {
        profileId: existing.id,
        displayName: 'Rebound profile',
        serverUrl: 'https://other.example.net/archive',
        auth: { kind: 'token' },
      },
      credentials: {
        profileId: existing.id,
        serverUrl: 'https://other.example.net/archive',
        token: 'replacement-token',
      },
      secrets: { apiToken: 'replacement-token' },
      connection: {
        apiVersion: '10',
        serverVersion: '2.16.3',
        username: 'alice',
        permissions: ['view_document'],
        isSuperuser: false,
      },
      warnings: [],
    }, {
      profiles,
      secrets,
      createProfileId: () => 'profile-replacement',
      now: () => '2026-08-02T10:01:00.000Z',
    }, { makeActive: true }),
    /simulated profile index write failure/,
  );

  const snapshot = await profiles.getSnapshot();
  assert.equal(snapshot.activeProfileId, existing.id);
  assert.equal(snapshot.profiles.length, 1);
  assert.equal(snapshot.profiles[0].displayName, existing.displayName);
  assert.equal(snapshot.profiles[0].serverUrl, existing.serverUrl);
  assert.deepEqual(await secrets.read(existing.id), previousSecrets);
  assert.equal(await secrets.read('profile-replacement'), null);
});

test('authority rebind gets a fresh inactive ID while ordinary metadata edits retain their ID', async () => {
  const store = new MemoryStore();
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const existing = createConnectionProfile({
    id: 'profile-a',
    displayName: 'Primary',
    serverUrl: 'https://paper.example.com/archive',
    auth: { kind: 'token' },
    now: NOW,
  });
  const existingSecrets = {
    apiToken: 'alice-token',
    connectionFingerprint: connectionProfileAuthFingerprint(existing),
  };
  await profiles.add(existing, { makeActive: true });
  await secrets.write(existing.id, existingSecrets);
  let generatedIds = 0;
  const dependencies = {
    profiles,
    secrets,
    createProfileId: () => `profile-replacement-${++generatedIds}`,
    now: () => '2026-08-02T10:01:00.000Z',
  };
  const connection = {
    apiVersion: '10',
    serverVersion: '2.16.3',
    username: 'alice',
    permissions: ['view_document'],
    isSuperuser: false,
  };

  const renamed = await persistPreparedConnectionProfile({
    draft: {
      profileId: existing.id,
      displayName: 'Primary renamed',
      serverUrl: existing.serverUrl,
      auth: existing.auth,
    },
    credentials: { profileId: existing.id, serverUrl: existing.serverUrl, token: 'alice-token' },
    secrets: { apiToken: 'alice-token' },
    connection,
    warnings: [],
  }, dependencies, { makeActive: true });
  assert.equal(renamed.id, existing.id);
  assert.equal(generatedIds, 0);

  const reboundPreparation = {
    draft: {
      profileId: existing.id,
      displayName: 'Primary rebound',
      serverUrl: existing.serverUrl,
      auth: existing.auth,
    },
    credentials: { profileId: existing.id, serverUrl: existing.serverUrl, token: 'bob-token' },
    secrets: { apiToken: 'bob-token' },
    connection: { ...connection, username: 'bob' },
    warnings: [],
  };
  assert.equal(
    preparedProfileRebindsAuthority(renamed, await secrets.read(existing.id), reboundPreparation),
    true,
  );
  const replacement = await persistPreparedConnectionProfile(
    reboundPreparation,
    dependencies,
    { makeActive: true },
  );
  const snapshot = await profiles.getSnapshot();
  assert.equal(replacement.id, 'profile-replacement-1');
  assert.equal(snapshot.activeProfileId, existing.id, 'old ID stays active until journaled retirement');
  assert.deepEqual(snapshot.profiles.map((profile) => profile.id), [existing.id, replacement.id]);
  assert.deepEqual(await secrets.read(existing.id), {
    apiToken: 'alice-token',
    connectionFingerprint: connectionProfileAuthFingerprint(renamed),
  });
  assert.deepEqual(await secrets.read(replacement.id), {
    apiToken: 'bob-token',
    connectionFingerprint: connectionProfileAuthFingerprint(replacement),
  });
});

test('authority comparisons reject stale token, OIDC, custom-header, and mTLS captures', () => {
  const authority = {
    apiToken: 'api-token-a',
    oidc: {
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
      idToken: 'id-a',
      expiresAt: '2026-08-02T11:00:00.000Z',
    },
    customHeaders: { 'x-api-key': 'header-a', 'remote-user': 'alice' },
    clientIdentityRef: 'identity-a',
  };
  assert.equal(profileSecretsAuthorizeSameContext(authority, structuredClone(authority)), true);
  for (const stale of [
    { ...authority, apiToken: 'api-token-b' },
    { ...authority, oidc: { ...authority.oidc, accessToken: 'access-b' } },
    { ...authority, oidc: { ...authority.oidc, refreshToken: 'refresh-b' } },
    { ...authority, customHeaders: { ...authority.customHeaders, 'x-api-key': 'header-b' } },
    { ...authority, clientIdentityRef: 'identity-b' },
  ]) {
    assert.equal(profileSecretsAuthorizeSameContext(authority, stale), false);
  }

  const tokenProfile = createConnectionProfile({
    id: 'profile-token',
    displayName: 'Token',
    serverUrl: 'https://paper.example.com',
    auth: { kind: 'token' },
    now: NOW,
  });
  assert.equal(credentialsMatchStoredProfile({
    profileId: tokenProfile.id,
    serverUrl: tokenProfile.serverUrl,
    token: 'api-token-a',
    authorizationScheme: 'Token',
  }, tokenProfile, { apiToken: 'api-token-a' }), true);
  assert.equal(credentialsMatchStoredProfile({
    profileId: tokenProfile.id,
    serverUrl: tokenProfile.serverUrl,
    token: 'api-token-a',
    authorizationScheme: 'Token',
  }, tokenProfile, { apiToken: 'api-token-b' }), false);

  const oidcProfile = {
    ...tokenProfile,
    id: 'profile-oidc',
    auth: {
      kind: 'oidc',
      issuer: 'https://issuer.example.com',
      clientId: 'folio',
      redirectUri: 'folio://oidc',
      scopes: ['openid'],
    },
  };
  assert.equal(credentialsMatchStoredProfile({
    profileId: oidcProfile.id,
    serverUrl: oidcProfile.serverUrl,
    token: 'access-a',
    authorizationScheme: 'Bearer',
  }, oidcProfile, { oidc: { accessToken: 'access-b' } }), false);

  const customProfile = {
    ...tokenProfile,
    id: 'profile-custom',
    auth: { kind: 'custom-headers', headerNames: ['x-api-key'] },
    customHeaderNames: ['x-api-key'],
  };
  assert.equal(credentialsMatchStoredProfile({
    profileId: customProfile.id,
    serverUrl: customProfile.serverUrl,
    token: '',
    authorizationScheme: 'Token',
    customHeaders: { 'x-api-key': 'header-a' },
  }, customProfile, { customHeaders: { 'x-api-key': 'header-b' } }), false);
});

test('failed new-profile metadata publication never writes a secret', async () => {
  const store = new MemoryStore();
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const originalSetItem = store.setItem.bind(store);
  let failProfileWrite = true;
  store.setItem = async (key, value) => {
    if (failProfileWrite && key === CONNECTION_PROFILE_INDEX_KEY) {
      failProfileWrite = false;
      throw new Error('simulated profile index write failure');
    }
    await originalSetItem(key, value);
  };

  await assert.rejects(
    () => persistPreparedConnectionProfile({
      draft: {
        displayName: 'New profile',
        serverUrl: 'https://paper.example.com',
        auth: { kind: 'token' },
      },
      credentials: { serverUrl: 'https://paper.example.com', token: 'new-token' },
      secrets: { apiToken: 'new-token' },
      connection: {
        apiVersion: '10',
        serverVersion: '2.16.3',
        permissions: ['view_document'],
        isSuperuser: false,
      },
      warnings: [],
    }, {
      profiles,
      secrets,
      createProfileId: () => 'profile-new',
      now: () => NOW,
    }, { makeActive: true }),
    /simulated profile index write failure/,
  );

  assert.deepEqual((await profiles.getSnapshot()).profiles, []);
  assert.equal(await secrets.read('profile-new'), null);
});

test('a failed publication-journal write exposes no fresh metadata or secret', async () => {
  const store = new MemoryStore();
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const originalSetItem = store.setItem.bind(store);
  store.setItem = async (key, value) => {
    if (key === PROFILE_PUBLICATION_JOURNAL_KEY) {
      throw new Error('simulated publication journal failure');
    }
    await originalSetItem(key, value);
  };

  await assert.rejects(() => persistPreparedConnectionProfile({
    draft: {
      displayName: 'New profile',
      serverUrl: 'https://paper.example.com',
      auth: { kind: 'token' },
    },
    credentials: { serverUrl: 'https://paper.example.com', token: 'new-token' },
    secrets: { apiToken: 'new-token' },
    connection: {
      apiVersion: '10',
      serverVersion: '2.16.3',
      permissions: ['view_document'],
      isSuperuser: false,
    },
    warnings: [],
  }, {
    profiles,
    secrets,
    createProfileId: () => 'profile-new',
    now: () => NOW,
  }, { makeActive: true }), /publication journal failure/);

  assert.deepEqual((await profiles.getSnapshot()).profiles, []);
  assert.equal(await secrets.read('profile-new'), null);
});

test('new profiles publish an inactive metadata pointer before secrets and activate last', async () => {
  const store = new MemoryStore();
  const writes = [];
  let publicationRecord = '';
  const originalSetItem = store.setItem.bind(store);
  store.setItem = async (key, value) => {
    writes.push(key);
    if (key === PROFILE_PUBLICATION_JOURNAL_KEY) publicationRecord = value;
    await originalSetItem(key, value);
  };
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const profile = await persistPreparedConnectionProfile({
    draft: {
      displayName: 'New profile',
      serverUrl: 'https://paper.example.com',
      auth: { kind: 'token' },
    },
    credentials: { serverUrl: 'https://paper.example.com', token: 'new-token' },
    secrets: { apiToken: 'new-token' },
    connection: {
      apiVersion: '10',
      serverVersion: '2.16.3',
      permissions: ['view_document'],
      isSuperuser: false,
    },
    warnings: [],
  }, {
    profiles,
    secrets,
    createProfileId: () => 'profile-new',
    now: () => NOW,
  }, { makeActive: true });

  assert.deepEqual(writes, [
    PROFILE_PUBLICATION_JOURNAL_KEY,
    CONNECTION_PROFILE_INDEX_KEY,
    `${PROFILE_SECRET_KEY_PREFIX}profile-new`,
    CONNECTION_PROFILE_INDEX_KEY,
  ]);
  assert.equal((await profiles.getSnapshot()).activeProfileId, profile.id);
  assert.doesNotMatch(publicationRecord, /new-token|apiToken|customHeaders/);
});

test('a failed new-profile secret write removes its inactive metadata pointer', async () => {
  const store = new MemoryStore();
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const originalSetItem = store.setItem.bind(store);
  store.setItem = async (key, value) => {
    if (key === `${PROFILE_SECRET_KEY_PREFIX}profile-new`) {
      throw new Error('simulated protected-store failure');
    }
    await originalSetItem(key, value);
  };

  await assert.rejects(() => persistPreparedConnectionProfile({
    draft: {
      displayName: 'New profile',
      serverUrl: 'https://paper.example.com',
      auth: { kind: 'token' },
    },
    credentials: { serverUrl: 'https://paper.example.com', token: 'new-token' },
    secrets: { apiToken: 'new-token' },
    connection: {
      apiVersion: '10',
      serverVersion: '2.16.3',
      permissions: ['view_document'],
      isSuperuser: false,
    },
    warnings: [],
  }, {
    profiles,
    secrets,
    createProfileId: () => 'profile-new',
    now: () => NOW,
  }, { makeActive: true }), /simulated protected-store failure/);

  assert.deepEqual((await profiles.getSnapshot()).profiles, []);
  assert.equal((await profiles.getSnapshot()).activeProfileId, null);
});

test('mTLS preparation persists only safe certificate metadata and an opaque native reference', async () => {
  let ordinaryConnectionTests = 0;
  const prepared = await prepareConnectionProfile(
    {
      profileId: 'profile-mtls',
      displayName: 'Client certificate',
      serverUrl: 'https://paper.example.com/archive',
      auth: { kind: 'mutual-tls' },
    },
    {},
    {
      authHttpClient: { request: async () => ({ status: 500 }) },
      testConnection: async () => {
        ordinaryConnectionTests += 1;
        throw new Error('ordinary fetch must not run');
      },
      prepareMutualTls: async () => ({
        identity: {
          identityId: 'identity-a',
          subject: 'CN=Alice',
          issuer: 'CN=CA',
          notBefore: '2026-01-01T00:00:00.000Z',
          expiresAt: '2027-01-01T00:00:00.000Z',
          fingerprintSha256: 'AA:BB',
          hasPrivateKey: true,
          source: 'os-credential-store',
        },
        clientIdentityRef: 'opaque-native-ref',
        connection: {
          apiVersion: '10',
          serverVersion: '2.16.3',
          permissions: ['view_document'],
          isSuperuser: false,
        },
      }),
    },
  );

  assert.equal(ordinaryConnectionTests, 0);
  assert.deepEqual(prepared.secrets, { clientIdentityRef: 'opaque-native-ref' });
  assert.equal(prepared.draft.auth.kind, 'mutual-tls');
  assert.equal(prepared.draft.auth.identity.subject, 'CN=Alice');
  assert.doesNotMatch(JSON.stringify(prepared), /private.?key.?bytes|pkcs12|password/i);
});

test('identity cleanup waits for fresh mTLS metadata and secret publication', async () => {
  const store = new MemoryStore();
  const profiles = new ConnectionProfileRepository(store);
  const secrets = new ProfileSecretStore(store);
  const coordinator = new ManagedClientIdentityCoordinator();
  let releaseMetadata;
  const metadataMayFinish = new Promise((resolve) => { releaseMetadata = resolve; });
  let metadataPublished;
  const metadataWasPublished = new Promise((resolve) => { metadataPublished = resolve; });
  const originalSetItem = store.setItem.bind(store);
  let pauseMetadata = true;
  store.setItem = async (key, value) => {
    await originalSetItem(key, value);
    if (
      pauseMetadata
      && key === CONNECTION_PROFILE_INDEX_KEY
      && value.includes('profile-mtls')
    ) {
      pauseMetadata = false;
      metadataPublished();
      await metadataMayFinish;
    }
  };
  const identity = {
    identityId: 'identity-mtls',
    subject: 'CN=Alice',
    issuer: 'CN=Test CA',
    expiresAt: '2027-08-02T10:00:00.000Z',
    hasPrivateKey: true,
    source: 'managed-native-identity',
  };
  const publication = persistPreparedConnectionProfile({
    draft: {
      displayName: 'mTLS',
      serverUrl: 'https://paper.example.com',
      auth: { kind: 'mutual-tls', identity },
    },
    credentials: { serverUrl: 'https://paper.example.com', token: '' },
    secrets: { clientIdentityRef: 'ios-keychain:alice' },
    connection: {
      apiVersion: '10',
      serverVersion: '2.16.3',
      permissions: ['view_document'],
      isSuperuser: false,
    },
    warnings: [],
  }, {
    profiles,
    secrets,
    identityCoordinator: coordinator,
    createProfileId: () => 'profile-mtls',
    now: () => NOW,
  });
  await metadataWasPublished;
  const deleted = [];
  const cleanup = removeClientIdentityIfUnreferenced({
    clientIdentityRef: 'ios-keychain:alice',
    profiles,
    secrets,
    coordinator,
    removeClientIdentity: async (reference) => deleted.push(reference),
  });
  await Promise.resolve();
  assert.deepEqual(deleted, []);
  releaseMetadata();

  await publication;
  assert.equal(await cleanup, 'still-referenced');
  assert.deepEqual(deleted, []);
  assert.equal((await profiles.getSnapshot()).profiles[0].id, 'profile-mtls');
  assert.equal((await secrets.read('profile-mtls')).clientIdentityRef, 'ios-keychain:alice');
});
