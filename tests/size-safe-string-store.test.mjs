import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  SECURE_STORE_CHUNK_VALUE_MAX_BYTES,
  SECURE_STORE_LOGICAL_VALUE_MAX_BYTES,
  SECURE_STORE_MAX_CHUNKS,
  SECURE_STORE_PHYSICAL_VALUE_MAX_BYTES,
  SizeSafeStringStore,
  sizeSafeStorePhysicalKeys,
} from '../src/lib/size-safe-string-store.ts';

class InjectedCrash extends Error {}

class LimitedBackend {
  constructor(values = new Map(), maxValueBytes = 1_900) {
    this.values = new Map(values);
    this.maxValueBytes = maxValueBytes;
    this.mutations = 0;
    this.mutationLog = [];
    this.failAtMutation = null;
    this.crashAfterMutation = null;
    this.crashed = false;
  }

  async getItem(key) {
    if (this.crashed) throw new InjectedCrash('simulated process death');
    return this.values.get(key) ?? null;
  }

  mutate(type, key, operation) {
    if (this.crashed) throw new InjectedCrash('simulated process death');
    this.mutations += 1;
    this.mutationLog.push([type, key]);
    if (this.failAtMutation === this.mutations) {
      throw new Error(`simulated ${type} failure at mutation ${this.mutations}`);
    }
    operation();
    if (this.crashAfterMutation === this.mutations) {
      this.crashed = true;
      throw new InjectedCrash(`simulated crash after mutation ${this.mutations}`);
    }
  }

  async setItem(key, value) {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > this.maxValueBytes) {
      throw new Error(`backend rejected ${bytes}-byte value`);
    }
    this.mutate('set', key, () => this.values.set(key, value));
  }

  async deleteItem(key) {
    this.mutate('delete', key, () => this.values.delete(key));
  }
}

function internalEntries(backend, key) {
  const pointer = sizeSafeStorePhysicalKeys(key).pointer;
  const root = pointer.slice(0, -2);
  return [...backend.values].filter(([physicalKey]) => physicalKey.startsWith(root));
}

function largePayloads() {
  const unicode = JSON.stringify({
    label: '日本語–Zürich–📄'.repeat(800),
    combining: 'e\u0301'.repeat(800),
  });
  const oidc = JSON.stringify({
    schemaVersion: 1,
    profileId: 'oidc-profile',
    oidc: {
      accessToken: `ey.${'a'.repeat(7_000)}.sig`,
      refreshToken: `refresh.${'β'.repeat(4_000)}`,
      idToken: `ey.${'i'.repeat(8_000)}.sig`,
    },
  });
  const customHeaders = JSON.stringify({
    schemaVersion: 1,
    profileId: 'header-profile',
    customHeaders: Object.fromEntries(
      ['authorization', 'remote-user', 'x-api-key', 'x-auth-token', 'x-forwarded-user', 'x-remote-user']
        .map((name, index) => [name, String(index).repeat(4_096)]),
    ),
  });
  const profileIndex = JSON.stringify({
    schemaVersion: 1,
    revision: 120,
    activeProfileId: 'profile-0',
    profiles: Array.from({ length: 120 }, (_, index) => ({
      id: `profile-${index}`,
      displayName: `Archive ${index} ${'界'.repeat(20)}`,
      serverUrl: `https://paper-${index}.example.test/paperless`,
      auth: { kind: 'token' },
      customHeaderNames: [],
      status: { code: 'available' },
      createdAt: '2026-08-02T10:00:00.000Z',
      updatedAt: '2026-08-02T10:00:00.000Z',
    })),
  });
  const notificationRegistry = JSON.stringify(Array.from({ length: 128 }, (_, index) => ({
    notificationId: `notification-${index}-${'n'.repeat(28)}`,
    profileId: `profile-${index % 8}`,
    payload: {
      version: 1,
      source: 'notification',
      profileId: `profile-${index % 8}`,
      route: `/documents/${index}`,
      nonce: 'opaque-only-not-document-content',
    },
    createdAt: '2026-08-02T10:00:00.000Z',
  })));
  return { unicode, oidc, customHeaders, profileIndex, notificationRegistry };
}

test('large Unicode, OIDC, header, profile-index, and notification values round trip below 2 KB', async () => {
  const backend = new LimitedBackend();
  const store = new SizeSafeStringStore(backend);

  for (const [name, payload] of Object.entries(largePayloads())) {
    assert.ok(Buffer.byteLength(payload, 'utf8') > SECURE_STORE_CHUNK_VALUE_MAX_BYTES);
    await store.setItem(`folio.test.${name}`, payload);
    assert.equal(await store.getItem(`folio.test.${name}`), payload);
  }

  assert.ok(backend.mutationLog.some(([type, key]) => type === 'set' && key.endsWith('.c.0')));
  for (const value of backend.values.values()) {
    assert.ok(
      Buffer.byteLength(value, 'utf8') <= SECURE_STORE_PHYSICAL_VALUE_MAX_BYTES,
      'every physical value stays below the conservative ceiling',
    );
  }
});

test('small raw values stay direct and oversized legacy raw values migrate on read', async () => {
  const backend = new LimitedBackend();
  const store = new SizeSafeStringStore(backend);
  const smallKey = 'folio.test.legacy-small';
  const largeKey = 'folio.test.legacy-large';
  const largeLegacy = `legacy-${'🔐'.repeat(900)}`;

  backend.values.set(smallKey, 'legacy token');
  backend.values.set(largeKey, largeLegacy);
  assert.equal(await store.getItem(smallKey), 'legacy token');
  assert.equal(backend.values.get(smallKey), 'legacy token');
  assert.equal(backend.values.has(sizeSafeStorePhysicalKeys(smallKey).pointer), false);

  assert.equal(await store.getItem(largeKey), largeLegacy);
  assert.equal(backend.values.has(largeKey), false);
  assert.ok(backend.values.has(sizeSafeStorePhysicalKeys(largeKey).pointer));
  assert.equal(await new SizeSafeStringStore(new LimitedBackend(backend.values)).getItem(largeKey), largeLegacy);
});

test('a proven pre-publication legacy migration failure returns the preserved raw value', async () => {
  const key = 'folio.test.legacy-best-effort';
  const legacy = `legacy-${'🔐'.repeat(900)}`;
  const backend = new LimitedBackend();
  backend.values.set(key, legacy);
  backend.failAtMutation = 1;

  assert.equal(await new SizeSafeStringStore(backend).getItem(key), legacy);
  assert.equal(backend.values.get(key), legacy);
  assert.equal(backend.values.has(sizeSafeStorePhysicalKeys(key).pointer), false);

  backend.failAtMutation = null;
  assert.equal(await new SizeSafeStringStore(backend).getItem(key), legacy);
  assert.equal(backend.values.has(key), false);
  assert.ok(backend.values.has(sizeSafeStorePhysicalKeys(key).pointer));
});

test('an ambiguous legacy publication outcome still fails closed', async () => {
  const key = 'folio.test.legacy-ambiguous';
  const legacy = `legacy-${'x'.repeat(8_000)}`;
  const probe = new LimitedBackend();
  probe.values.set(key, legacy);
  await new SizeSafeStringStore(probe).getItem(key);
  const pointerMutation = probe.mutationLog.findIndex(
    ([type, physicalKey]) => type === 'set' && physicalKey === sizeSafeStorePhysicalKeys(key).pointer,
  ) + 1;
  assert.ok(pointerMutation > 1);

  const backend = new LimitedBackend();
  backend.values.set(key, legacy);
  backend.crashAfterMutation = pointerMutation;
  await assert.rejects(
    new SizeSafeStringStore(backend).getItem(key),
    (error) => error?.code === 'corrupt-record',
  );
});

test('normal failures before pointer publication preserve the old value and remove staging fragments', async () => {
  const key = 'folio.test.atomic-failure';
  const oldValue = `old-${'a'.repeat(7_000)}`;
  const newValue = `new-${'b'.repeat(9_000)}`;
  const established = new LimitedBackend();
  await new SizeSafeStringStore(established).setItem(key, oldValue);

  const probe = new LimitedBackend(established.values);
  await new SizeSafeStringStore(probe).setItem(key, newValue);
  const pointerMutation = probe.mutationLog.findIndex(
    ([type, physicalKey]) => type === 'set' && physicalKey === sizeSafeStorePhysicalKeys(key).pointer,
  ) + 1;
  assert.ok(pointerMutation > 2);

  for (let failurePoint = 1; failurePoint <= pointerMutation; failurePoint += 1) {
    const backend = new LimitedBackend(established.values);
    backend.failAtMutation = failurePoint;
    const store = new SizeSafeStringStore(backend);
    await assert.rejects(store.setItem(key, newValue));
    backend.failAtMutation = null;
    assert.equal(await store.getItem(key), oldValue, `failure ${failurePoint} kept old value`);
    const pointer = JSON.parse(backend.values.get(sizeSafeStorePhysicalKeys(key).pointer));
    const inactive = pointer.g === 'a' ? 'b' : 'a';
    assert.equal(backend.values.has(sizeSafeStorePhysicalKeys(key).manifest(inactive)), false);
  }
});

test('a crash at every publication mutation exposes exactly the complete old or new generation', async () => {
  const key = 'folio.test.atomic-crash';
  const oldValue = `old-${'å'.repeat(5_000)}`;
  const newValue = `new-${'📄'.repeat(3_000)}`;
  const established = new LimitedBackend();
  await new SizeSafeStringStore(established).setItem(key, oldValue);

  const probe = new LimitedBackend(established.values);
  await new SizeSafeStringStore(probe).setItem(key, newValue);
  const pointerMutation = probe.mutationLog.findIndex(
    ([type, physicalKey]) => type === 'set' && physicalKey === sizeSafeStorePhysicalKeys(key).pointer,
  ) + 1;

  for (let crashPoint = 1; crashPoint <= pointerMutation; crashPoint += 1) {
    const crashing = new LimitedBackend(established.values);
    crashing.crashAfterMutation = crashPoint;
    await assert.rejects(new SizeSafeStringStore(crashing).setItem(key, newValue));

    const restarted = new LimitedBackend(crashing.values);
    const visible = await new SizeSafeStringStore(restarted).getItem(key);
    assert.ok(
      visible === oldValue || visible === newValue,
      `crash ${crashPoint} returned a complete committed generation`,
    );
    assert.equal(
      visible,
      crashPoint >= pointerMutation ? newValue : oldValue,
      `pointer-last boundary at mutation ${pointerMutation}`,
    );
  }
});

test('raw-to-chunked and chunked-to-raw commit boundaries are also old-or-new', async () => {
  const key = 'folio.test.atomic-format-transition';
  const small = 'small-old-value';
  const large = `large-${'界'.repeat(2_000)}`;

  const rawEstablished = new LimitedBackend();
  await new SizeSafeStringStore(rawEstablished).setItem(key, small);
  const largeProbe = new LimitedBackend(rawEstablished.values);
  await new SizeSafeStringStore(largeProbe).setItem(key, large);
  const largePointerMutation = largeProbe.mutationLog.findIndex(
    ([type, physicalKey]) => type === 'set' && physicalKey === sizeSafeStorePhysicalKeys(key).pointer,
  ) + 1;
  for (const crashPoint of [1, largePointerMutation - 1, largePointerMutation]) {
    const crashing = new LimitedBackend(rawEstablished.values);
    crashing.crashAfterMutation = crashPoint;
    await assert.rejects(new SizeSafeStringStore(crashing).setItem(key, large));
    const visible = await new SizeSafeStringStore(new LimitedBackend(crashing.values)).getItem(key);
    assert.equal(visible, crashPoint >= largePointerMutation ? large : small);
  }

  const chunkedEstablished = new LimitedBackend();
  await new SizeSafeStringStore(chunkedEstablished).setItem(key, large);
  for (const [crashPoint, expected] of [[1, large], [2, small]]) {
    const crashing = new LimitedBackend(chunkedEstablished.values);
    crashing.crashAfterMutation = crashPoint;
    await assert.rejects(new SizeSafeStringStore(crashing).setItem(key, small));
    assert.equal(
      await new SizeSafeStringStore(new LimitedBackend(crashing.values)).getItem(key),
      expected,
    );
  }
});

test('multiple adapter instances serialize a same-key generation change', async () => {
  const key = 'folio.test.multi-adapter';
  const physical = sizeSafeStorePhysicalKeys(key);
  const established = new LimitedBackend();
  await new SizeSafeStringStore(established).setItem(key, `old-${'o'.repeat(5_000)}`);

  let releaseFirst;
  let firstAtPointer;
  const firstAtPointerPromise = new Promise((resolve) => { firstAtPointer = resolve; });
  const releaseFirstPromise = new Promise((resolve) => { releaseFirst = resolve; });
  let secondEnteredBackend = false;

  class SharedControlledBackend {
    constructor(id) {
      this.id = id;
      this.values = established.values;
    }

    async getItem(physicalKey) {
      if (this.id === 'second') secondEnteredBackend = true;
      return this.values.get(physicalKey) ?? null;
    }

    async setItem(physicalKey, value) {
      if (this.id === 'second') secondEnteredBackend = true;
      if (this.id === 'first' && physicalKey === physical.pointer) {
        firstAtPointer();
        await releaseFirstPromise;
      }
      this.values.set(physicalKey, value);
    }

    async deleteItem(physicalKey) {
      if (this.id === 'second') secondEnteredBackend = true;
      this.values.delete(physicalKey);
    }
  }

  const firstValue = `first-${'1'.repeat(7_000)}`;
  const secondValue = `second-${'2'.repeat(9_000)}`;
  const firstWrite = new SizeSafeStringStore(new SharedControlledBackend('first'))
    .setItem(key, firstValue);
  await firstAtPointerPromise;
  const secondWrite = new SizeSafeStringStore(new SharedControlledBackend('second'))
    .setItem(key, secondValue);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondEnteredBackend, false, 'the second adapter waits before touching the namespace');

  releaseFirst();
  await Promise.all([firstWrite, secondWrite]);
  assert.equal(
    await new SizeSafeStringStore(new LimitedBackend(established.values)).getItem(key),
    secondValue,
  );
});

test('missing chunks and altered chunks or manifests fail closed', async () => {
  const key = 'folio.test.corruption';
  const value = `secret-${'界'.repeat(3_000)}`;
  const established = new LimitedBackend();
  await new SizeSafeStringStore(established).setItem(key, value);
  const physical = sizeSafeStorePhysicalKeys(key);
  const pointer = JSON.parse(established.values.get(physical.pointer));

  for (const corrupt of [
    (backend) => backend.values.delete(physical.chunk(pointer.g, 0)),
    (backend) => backend.values.set(physical.chunk(pointer.g, 0), 'tampered'),
    (backend) => {
      const manifest = JSON.parse(backend.values.get(physical.manifest(pointer.g)));
      backend.values.set(physical.manifest(pointer.g), JSON.stringify({ ...manifest, b: manifest.b + 1 }));
    },
    (backend) => backend.values.set(physical.manifest(pointer.g), '{bad json'),
  ]) {
    const backend = new LimitedBackend(established.values);
    corrupt(backend);
    await assert.rejects(
      new SizeSafeStringStore(backend).getItem(key),
      (error) => error?.code === 'corrupt-record',
    );
  }
});

test('delete tombstone keeps interrupted cleanup retryable and removes all secret fragments', async () => {
  const key = 'folio.test.delete-retry';
  const oldValue = `old-${'a'.repeat(8_000)}`;
  const stagedValue = `staged-${'b'.repeat(11_000)}`;
  const established = new LimitedBackend();
  await new SizeSafeStringStore(established).setItem(key, oldValue);

  // Leave an inactive staging manifest and chunks exactly as process death would.
  const stagingCrash = new LimitedBackend(established.values);
  stagingCrash.crashAfterMutation = 4;
  await assert.rejects(new SizeSafeStringStore(stagingCrash).setItem(key, stagedValue));

  const deleting = new LimitedBackend(stagingCrash.values);
  deleting.failAtMutation = 3;
  await assert.rejects(new SizeSafeStringStore(deleting).deleteItem(key));
  const tombstone = JSON.parse(deleting.values.get(sizeSafeStorePhysicalKeys(key).pointer));
  assert.equal(tombstone.s, 'd');
  deleting.failAtMutation = null;

  await new SizeSafeStringStore(deleting).deleteItem(key);
  assert.equal(await new SizeSafeStringStore(deleting).getItem(key), null);
  assert.deepEqual(internalEntries(deleting, key), []);
  assert.equal(deleting.values.has(key), false);
});

test('deletion full-sweeps chunks hidden by understated manifests and tombstones', async () => {
  const manifestKey = 'folio.test.delete-corrupt-manifest-count';
  const manifestBackend = new LimitedBackend();
  await new SizeSafeStringStore(manifestBackend).setItem(
    manifestKey,
    `secret-${'m'.repeat(8_000)}`,
  );
  const manifestPhysical = sizeSafeStorePhysicalKeys(manifestKey);
  const manifestPointer = JSON.parse(manifestBackend.values.get(manifestPhysical.pointer));
  const manifest = JSON.parse(
    manifestBackend.values.get(manifestPhysical.manifest(manifestPointer.g)),
  );
  assert.ok(manifest.n > 1);
  manifestBackend.values.set(
    manifestPhysical.manifest(manifestPointer.g),
    JSON.stringify({ ...manifest, n: 1, b: SECURE_STORE_CHUNK_VALUE_MAX_BYTES + 1 }),
  );
  await new SizeSafeStringStore(manifestBackend).deleteItem(manifestKey);
  assert.deepEqual(internalEntries(manifestBackend, manifestKey), []);

  const tombstoneKey = 'folio.test.delete-corrupt-tombstone-count';
  const tombstoneBackend = new LimitedBackend();
  await new SizeSafeStringStore(tombstoneBackend).setItem(
    tombstoneKey,
    `secret-${'t'.repeat(8_000)}`,
  );
  const tombstonePhysical = sizeSafeStorePhysicalKeys(tombstoneKey);
  tombstoneBackend.values.set(
    tombstonePhysical.pointer,
    JSON.stringify({ v: 1, s: 'd', a: 0, b: 0 }),
  );
  assert.equal(await new SizeSafeStringStore(tombstoneBackend).getItem(tombstoneKey), null);
  assert.deepEqual(internalEntries(tombstoneBackend, tombstoneKey), []);
});

test('a process death during delete leaves a tombstone and bounded cleanup map for restart', async () => {
  const key = 'folio.test.delete-crash';
  const backend = new LimitedBackend();
  await new SizeSafeStringStore(backend).setItem(key, `secret-${'s'.repeat(8_000)}`);
  const crashing = new LimitedBackend(backend.values);
  crashing.crashAfterMutation = 2;
  await assert.rejects(new SizeSafeStringStore(crashing).deleteItem(key));
  assert.equal(JSON.parse(crashing.values.get(sizeSafeStorePhysicalKeys(key).pointer)).s, 'd');

  const restarted = new LimitedBackend(crashing.values);
  assert.equal(await new SizeSafeStringStore(restarted).getItem(key), null);
  assert.deepEqual(internalEntries(restarted, key), []);
  assert.equal(restarted.values.has(key), false);
});

test('hashed namespaces isolate keys during corruption and deletion', async () => {
  const backend = new LimitedBackend();
  const store = new SizeSafeStringStore(backend);
  const firstKey = 'folio.test.profile.alpha';
  const secondKey = 'folio.test.profile.alpha-extra';
  const first = `alpha-${'a'.repeat(5_000)}`;
  const second = `beta-${'b'.repeat(5_000)}`;
  await store.setItem(firstKey, first);
  await store.setItem(secondKey, second);
  assert.notEqual(
    sizeSafeStorePhysicalKeys(firstKey).pointer,
    sizeSafeStorePhysicalKeys(secondKey).pointer,
  );

  const firstPointer = JSON.parse(backend.values.get(sizeSafeStorePhysicalKeys(firstKey).pointer));
  backend.values.set(sizeSafeStorePhysicalKeys(firstKey).chunk(firstPointer.g, 0), 'corrupt');
  await assert.rejects(store.getItem(firstKey), (error) => error?.code === 'corrupt-record');
  assert.equal(await store.getItem(secondKey), second);
  await store.deleteItem(firstKey);
  assert.equal(await store.getItem(secondKey), second);
});

test('logical size, chunk count, physical size, and key grammar are bounded', async () => {
  const backend = new LimitedBackend();
  const store = new SizeSafeStringStore(backend);
  const maximum = 'x'.repeat(SECURE_STORE_LOGICAL_VALUE_MAX_BYTES);
  await store.setItem('folio.test.maximum', maximum);
  assert.equal(await store.getItem('folio.test.maximum'), maximum);
  assert.ok(internalEntries(backend, 'folio.test.maximum').length <= SECURE_STORE_MAX_CHUNKS + 2);
  assert.ok([...backend.values.values()].every(
    (value) => Buffer.byteLength(value, 'utf8') <= SECURE_STORE_PHYSICAL_VALUE_MAX_BYTES,
  ));

  const mutations = backend.mutations;
  await assert.rejects(
    store.setItem('folio.test.too-large', `${maximum}x`),
    (error) => error?.code === 'value-too-large',
  );
  assert.equal(backend.mutations, mutations);
  await assert.rejects(store.setItem('invalid/key', 'value'), (error) => error?.code === 'invalid-key');

  const maliciousKey = 'folio.test.malicious-count';
  const physical = sizeSafeStorePhysicalKeys(maliciousKey);
  backend.values.set(physical.pointer, JSON.stringify({ v: 1, s: 'p', g: 'a', h: '0'.repeat(64) }));
  backend.values.set(physical.manifest('a'), JSON.stringify({
    v: 1,
    s: 'r',
    g: 'a',
    n: SECURE_STORE_MAX_CHUNKS + 1,
    b: SECURE_STORE_CHUNK_VALUE_MAX_BYTES + 1,
    h: '0'.repeat(64),
  }));
  await assert.rejects(
    store.getItem(maliciousKey),
    (error) => error?.code === 'corrupt-record',
  );
});

test('the size-safe adapter is wired only into the native platform branch', async () => {
  const source = await readFile(new URL('../src/lib/platform-storage.ts', import.meta.url), 'utf8');
  assert.match(source, /new SizeSafeStringStore\([\s\S]*new NativeSecureStoreBackend\(\),[\s\S]*new NativeProtectedStorageExclusiveCoordinator\(\)/);
  assert.match(source, /Platform\.OS === 'web' \? new WebStringStore\(\) : nativeSecureStringStore/);
  assert.match(source, /window\.localStorage\.setItem\(key, value\)/);
});

test('native protected-storage coordination is FIFO, lifecycle-safe, and fail-closed', async () => {
  const [sizeSafeStore, platformStorage, nativeBridge, android, ios] = await Promise.all([
    readFile(new URL('../src/lib/size-safe-string-store.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/platform-storage.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/folio-platform-native.ts', import.meta.url), 'utf8'),
    readFile(new URL(
      '../modules/folio-platform/android/src/main/java/app/folio/platform/FolioPlatformModule.kt',
      import.meta.url,
    ), 'utf8'),
    readFile(new URL('../modules/folio-platform/ios/FolioPlatformModule.swift', import.meta.url), 'utf8'),
  ]);

  assert.match(platformStorage, /try\s*\{[\s\S]*return await operation\(\);[\s\S]*\}\s*finally\s*\{[\s\S]*releaseProtectedStorageLeaseAsync/);
  assert.match(platformStorage, /native protected-storage coordinator is unavailable/);
  assert.match(platformStorage, /PROTECTED_STORAGE_LEASE_PATTERN\.test\(leaseId\)/);
  assert.match(sizeSafeStore, /const mutationQueues = new Map<string, Promise<void>>\(\)/);
  assert.match(sizeSafeStore, /exclusiveCoordinator\?\.runExclusive\(operation\)/);
  assert.match(nativeBridge, /acquireProtectedStorageLeaseAsync\(\): Promise<string>/);
  assert.match(nativeBridge, /releaseProtectedStorageLeaseAsync\(leaseId: string\): Promise<void>/);

  // Acquisition, release, invalid/wrong-owner release, and both teardown paths
  // are intentionally asserted for each native implementation. Promise
  // callbacks must remain outside the native critical sections.
  assert.match(android, /private object FolioProtectedStorageExclusiveCoordinator/);
  assert.match(android, /private val pending = ArrayDeque<Request>\(\)/);
  assert.match(android, /pending\.addLast\(request\)/);
  assert.match(android, /pending\.pollFirst\(\)/);
  assert.match(android, /registeredOwners/);
  assert.match(android, /PROTECTED_STORAGE_LEASE_PATTERN\.matches\(leaseId\)/);
  assert.match(android, /current\.ownerId == ownerId && current\.leaseId == leaseId/);
  assert.match(android, /active = null\s+takeNextLocked\(\)/);
  assert.match(android, /iterator\.remove\(\)[\s\S]*canceled\.add\(request\)/);
  assert.match(android, /if \(active\?\.ownerId == ownerId\)[\s\S]*granted = takeNextLocked\(\)/);
  assert.match(android, /\}\s+granted\?\.let \{ request -> request\.promise\.resolve\(request\.leaseId\) \}/);
  assert.match(android, /OnDestroy\s*\{[\s\S]*unregisterOwner\(protectedStorageOwnerId\)/);

  assert.match(ios, /static let shared = FolioProtectedStorageExclusiveCoordinator\(\)/);
  assert.match(ios, /private var pending: \[Request\] = \[\]/);
  assert.match(ios, /pending\.append\(request\)/);
  assert.match(ios, /pending\.removeFirst\(\)/);
  assert.match(ios, /registeredOwners/);
  assert.match(ios, /leaseId\.range\(of: folioProtectedStorageLeasePattern/);
  assert.match(ios, /current\.ownerId == ownerId, current\.leaseId == leaseId/);
  assert.match(ios, /active = nil\s+let granted = takeNextLocked\(\)\s+lock\.unlock\(\)\s+if let granted/);
  assert.match(ios, /pending\.removeAll[\s\S]*canceled\.append\(request\)/);
  assert.match(ios, /if active\?\.ownerId == ownerId[\s\S]*granted = takeNextLocked\(\)/);
  assert.match(ios, /lock\.unlock\(\)[\s\S]*request\.promise\.reject/);
  assert.match(ios, /OnDestroy\s*\{[\s\S]*unregisterOwner/);
});
