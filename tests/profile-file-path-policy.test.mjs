import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertLegacyProfileRootsClaimable,
  assertUnambiguousLegacyProfileOwner,
  ensureOwnedProfileRoot,
  legacyProfileRootDirectoryOwner,
  legacyProfileDirectoryName,
  parseProfileDirectoryOwner,
  profileDirectoryCandidates,
  profileDirectoryName,
  serializeProfileDirectoryOwner,
} from '../src/lib/profile-file-path-policy.ts';
import {
  assertNativeProfileRemovalFenceDisposition,
  parseNativeProfileRemovalFence,
  profileRemovalFenceCandidateName,
  profileRemovalFencePathSegments,
  serializeNativeProfileRemovalFence,
  validateNativeProfileRemovalFence,
} from '../src/lib/profile-removal-fence-policy.ts';

const collidingLegacyIds = ['a.b', 'a-b', 'a--b'];

test('profile directory allocation preserves every validated ID exactly', () => {
  assert.deepEqual(collidingLegacyIds.map(profileDirectoryName), collidingLegacyIds);
  assert.equal(new Set(collidingLegacyIds.map(profileDirectoryName)).size, 3);
  assert.deepEqual(profileDirectoryCandidates('a.b'), [
    { kind: 'canonical', directoryName: 'a.b' },
    { kind: 'legacy', directoryName: 'a-b' },
  ]);
  assert.deepEqual(profileDirectoryCandidates('a-b'), [
    { kind: 'canonical', directoryName: 'a-b' },
  ]);
  assert.deepEqual(profileDirectoryCandidates('a--b'), [
    { kind: 'canonical', directoryName: 'a--b' },
    { kind: 'legacy', directoryName: 'a-b' },
  ]);
});

test('legacy normalized roots are recognized as colliding and never auto-assigned', () => {
  assert.deepEqual(collidingLegacyIds.map(legacyProfileDirectoryName), ['a-b', 'a-b', 'a-b']);
  for (const profileId of collidingLegacyIds) {
    assert.throws(
      () => assertUnambiguousLegacyProfileOwner(profileId, collidingLegacyIds),
      /ambiguous ownership/,
    );
  }
});

test('legacy migration requires the target to be the only configured possible owner', () => {
  assert.equal(assertUnambiguousLegacyProfileOwner('a.b', ['a.b']), 'a-b');
  assert.equal(assertUnambiguousLegacyProfileOwner('a-b', ['a-b']), 'a-b');
  assert.equal(assertUnambiguousLegacyProfileOwner('a--b', ['a--b']), 'a-b');
  assert.throws(
    () => assertUnambiguousLegacyProfileOwner('a.b', ['unrelated']),
    /ambiguous ownership/,
  );
});

test('ownership markers preserve the exact ID and reject malformed state', () => {
  for (const profileId of collidingLegacyIds) {
    assert.deepEqual(parseProfileDirectoryOwner(serializeProfileDirectoryOwner(profileId)), {
      version: 1,
      profileId,
    });
  }
  assert.throws(() => parseProfileDirectoryOwner('{'), /ownership marker is invalid/);
  assert.throws(
    () => parseProfileDirectoryOwner('{"version":1,"profileId":" a.b "}'),
    /ownership marker is invalid/,
  );
  assert.throws(
    () => parseProfileDirectoryOwner('{"version":1,"profileId":"../escape"}'),
    /Invalid profile storage identity/,
  );
});

test('profile removal fence paths preserve exact IDs under the documents-area namespace', () => {
  assert.deepEqual(profileRemovalFencePathSegments('a.b'), [
    'folio',
    'profile-removal-fences',
    'a.b.json',
  ]);
  assert.deepEqual(profileRemovalFencePathSegments('a-b'), [
    'folio',
    'profile-removal-fences',
    'a-b.json',
  ]);
  assert.equal(profileRemovalFenceCandidateName('remove-a.b'), '.remove-a.b.fence-candidate');
  assert.throws(() => profileRemovalFencePathSegments('../escape'), /Invalid profile storage identity/);
  assert.throws(() => profileRemovalFenceCandidateName('../escape'), /not safe/);
});

test('profile removal fence records require an explicit validated lifecycle disposition', () => {
  const permanent = {
    version: 1,
    operationId: 'remove-profile-a',
    profileId: 'profile-a',
    disposition: 'retain-after-profile-deletion',
  };
  assert.deepEqual(
    parseNativeProfileRemovalFence(serializeNativeProfileRemovalFence(permanent)),
    permanent,
  );
  assert.equal(
    assertNativeProfileRemovalFenceDisposition('remove-after-purge'),
    'remove-after-purge',
  );
  assert.throws(
    () => validateNativeProfileRemovalFence({ ...permanent, disposition: undefined }),
    /disposition is invalid/,
  );
  assert.throws(
    () => validateNativeProfileRemovalFence({ ...permanent, operationId: '../escape' }),
    /not safe/,
  );
  assert.throws(
    () => parseNativeProfileRemovalFence('{'),
    /fence is invalid/,
  );
});

test('legacy migration checks ambiguity only when an unmarked data root can be claimed', () => {
  assert.doesNotThrow(() => {
    assertLegacyProfileRootsClaimable('a.b', collidingLegacyIds, []);
  });
  assert.doesNotThrow(() => {
    assertLegacyProfileRootsClaimable('a-b', collidingLegacyIds, ['a-b', 'a-b']);
  });
  assert.doesNotThrow(() => {
    assertLegacyProfileRootsClaimable('a.b', collidingLegacyIds, ['a-b']);
  });
  assert.throws(
    () => assertLegacyProfileRootsClaimable('a.b', collidingLegacyIds, [null]),
    /ambiguous ownership/,
  );
  assert.throws(
    () => assertLegacyProfileRootsClaimable('a.b', collidingLegacyIds, ['a-b', null]),
    /conflicting ownership/,
  );
  assert.throws(
    () => assertLegacyProfileRootsClaimable('a-b', collidingLegacyIds, ['a.b']),
    /belongs to another profile/,
  );
});

class MemoryDirectory {
  constructor(state, path) {
    this.state = state;
    this.path = path.replace(/\/+$/, '');
  }

  get exists() { return this.state.directories.has(this.path); }

  create(options = {}) {
    if (this.exists && !options.idempotent) throw new Error('Directory already exists.');
    this.state.directories.add(this.path);
  }

  delete() {
    if (this.list().length > 0) throw new Error('Directory is not empty.');
    this.state.directories.delete(this.path);
  }

  list() {
    const prefix = `${this.path}/`;
    const entries = [];
    for (const path of this.state.files.keys()) {
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) entries.push(path);
    }
    for (const path of this.state.directories) {
      if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) entries.push(path);
    }
    return entries;
  }
}

class MemoryFile {
  constructor(directory, name) {
    this.parentDirectory = directory;
    this.path = `${directory.path}/${name}`;
  }

  get exists() { return this.parentDirectory.state.files.has(this.path); }

  create(options = {}) {
    if (this.exists && !options.overwrite) throw new Error('File already exists.');
    this.parentDirectory.state.files.set(this.path, '');
  }

  delete() { this.parentDirectory.state.files.delete(this.path); }
  textSync() { return this.parentDirectory.state.files.get(this.path); }
  write(value) { this.parentDirectory.state.files.set(this.path, value); }
}

const memoryStorage = {
  assertProfileRootAllocationAllowed(root, profileId) {
    root.state.fenceChecks += 1;
    root.state.onFenceCheck?.(root.state.fenceChecks, profileId);
    if (root.state.fencedProfiles.has(profileId)) {
      throw new Error('The connection profile is fenced for native file removal.');
    }
  },
  directory(root, ...segments) {
    return new MemoryDirectory(root.state, [root.path, ...segments].join('/'));
  },
  file(directory, name) { return new MemoryFile(directory, name); },
};

function memoryRoot() {
  const state = {
    directories: new Set(['/cache']),
    files: new Map(),
    fencedProfiles: new Set(),
    fenceChecks: 0,
    onFenceCheck: null,
  };
  return { state, root: new MemoryDirectory(state, '/cache') };
}

test('owned root allocation preserves exact IDs and writes the owner before use', () => {
  const { state, root } = memoryRoot();
  const directory = ensureOwnedProfileRoot(root, 'a.b', memoryStorage);
  assert.equal(directory.path, '/cache/folio/profiles/a.b');
  assert.deepEqual(
    parseProfileDirectoryOwner(state.files.get(`${directory.path}/.folio-profile-owner-v1`)),
    { version: 1, profileId: 'a.b' },
  );
  assert.equal(ensureOwnedProfileRoot(root, 'a.b', memoryStorage).path, directory.path);
});

test('owned root allocation recovers only empty interrupted canonical allocations', () => {
  for (const interruptedAfterMarkerCreate of [false, true]) {
    const { state, root } = memoryRoot();
    const canonicalPath = '/cache/folio/profiles/a-b';
    state.directories.add(canonicalPath);
    if (interruptedAfterMarkerCreate) {
      state.files.set(`${canonicalPath}/.folio-profile-owner-v1`, '');
    }
    assert.doesNotThrow(() => ensureOwnedProfileRoot(root, 'a-b', memoryStorage));
    assert.deepEqual(
      parseProfileDirectoryOwner(state.files.get(`${canonicalPath}/.folio-profile-owner-v1`)),
      { version: 1, profileId: 'a-b' },
    );
  }

  const { state, root } = memoryRoot();
  const canonicalPath = '/cache/folio/profiles/a-b';
  state.directories.add(canonicalPath);
  state.files.set(`${canonicalPath}/data.bin`, 'profile data');
  assert.throws(
    () => ensureOwnedProfileRoot(root, 'a-b', memoryStorage),
    /must be migrated/,
  );
});

test('owned root allocation does not adopt a non-empty colliding legacy root', () => {
  const { state, root } = memoryRoot();
  state.directories.add('/cache/folio/profiles/a-b');
  state.files.set('/cache/folio/profiles/a-b/data.bin', 'legacy profile data');
  assert.throws(
    () => ensureOwnedProfileRoot(root, 'a.b', memoryStorage),
    /must be migrated/,
  );
});

test('a persistent profile fence rejects cache-root allocation before it creates paths', () => {
  const { state, root } = memoryRoot();
  state.fencedProfiles.add('profile-a');

  assert.throws(
    () => ensureOwnedProfileRoot(root, 'profile-a', memoryStorage),
    /fenced for native file removal/,
  );
  assert.equal(state.directories.has('/cache/folio/profiles/profile-a'), false);
  assert.equal(state.files.size, 0);
});

test('a fence published during allocation rejects and removes the unreturned empty root', () => {
  const { state, root } = memoryRoot();
  state.onFenceCheck = (count, profileId) => {
    if (count === 2) state.fencedProfiles.add(profileId);
  };

  assert.throws(
    () => ensureOwnedProfileRoot(root, 'profile-a', memoryStorage),
    /fenced for native file removal/,
  );
  assert.equal(state.directories.has('/cache/folio/profiles/profile-a'), false);
  assert.equal(state.files.has('/cache/folio/profiles/profile-a/.folio-profile-owner-v1'), false);
});

test('legacy migration retries an empty crash-residue marker but rejects malformed markers', () => {
  const { state, root } = memoryRoot();
  const legacy = memoryStorage.directory(root, 'folio', 'profiles', 'a-b');
  legacy.create();
  state.files.set(`${legacy.path}/data.bin`, 'legacy profile data');
  state.files.set(`${legacy.path}/.folio-profile-owner-v1`, '');
  assert.equal(legacyProfileRootDirectoryOwner(legacy, memoryStorage), null);
  assert.throws(
    () => assertLegacyProfileRootsClaimable('a.b', collidingLegacyIds, [null]),
    /ambiguous ownership/,
  );

  state.files.set(`${legacy.path}/.folio-profile-owner-v1`, '{');
  assert.throws(
    () => legacyProfileRootDirectoryOwner(legacy, memoryStorage),
    /ownership marker is invalid/,
  );
});

test('every native canonical profile-root creator uses the shared ownership policy', async () => {
  const sources = await Promise.all([
    '../src/lib/file-staging.ts',
    '../src/lib/offline-native-file-storage.ts',
    '../src/lib/document-files.ts',
    '../src/lib/secure-pdf-preview-cache.ts',
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));

  for (const source of sources) {
    assert.match(source, /ensureOwnedProfileRoot\(/);
    assert.doesNotMatch(source, /new Directory\([^;]{0,240}['"]folio['"][^;]{0,120}['"]profiles['"]/s);
  }
});
