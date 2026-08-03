const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Marker stored in every current profile root. Besides documenting ownership,
 * it prevents an exact ID such as `a-b` from silently adopting a pre-policy
 * directory that may have been written for `a.b` or `a--b`.
 */
export const PROFILE_DIRECTORY_OWNER_FILE = '.folio-profile-owner-v1';

export type ProfileDirectoryOwner = {
  version: 1;
  profileId: string;
};

export type ProfileDirectoryCandidate = {
  kind: 'canonical' | 'legacy';
  directoryName: string;
};

/**
 * The small filesystem surface needed to enforce profile-root ownership.
 * Keeping the native constructors behind an adapter lets this policy remain
 * usable in repository and Node tests without loading an Expo native module.
 */
export type ProfileRootDirectoryHandle = {
  readonly exists: boolean;
  create(options?: { idempotent?: boolean; intermediates?: boolean }): void;
  delete(): void;
  list(): readonly unknown[];
};

export type ProfileRootOwnerFileHandle<DirectoryHandle> = {
  readonly exists: boolean;
  readonly parentDirectory: DirectoryHandle;
  create(options?: { overwrite?: boolean }): void;
  delete(): void;
  textSync(): string;
  write(value: string): void;
};

export type ProfileRootStorageAdapter<
  DirectoryHandle extends ProfileRootDirectoryHandle,
  OwnerFileHandle extends ProfileRootOwnerFileHandle<DirectoryHandle>,
> = {
  /**
   * Synchronously rejects allocation while the profile has a durable native
   * removal fence. Native implementations must consult the documents area
   * even when `root` is the evictable cache directory.
   */
  assertProfileRootAllocationAllowed(root: DirectoryHandle, profileId: string): void;
  directory(root: DirectoryHandle, ...segments: string[]): DirectoryHandle;
  file(directory: DirectoryHandle, name: string): OwnerFileHandle;
};

/** Returns the validated profile ID unchanged for use as a path segment. */
export function profileDirectoryName(profileId: string): string {
  const exact = profileId.trim();
  if (!PROFILE_ID_PATTERN.test(exact) || exact === '.' || exact === '..') {
    throw new Error('Invalid profile storage identity.');
  }
  return exact;
}

/**
 * Reproduces the lossy directory naming used before the ownership policy.
 * This must never be used for a new allocation.
 */
export function legacyProfileDirectoryName(profileId: string): string {
  return profileDirectoryName(profileId).replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
}

export function profileDirectoryCandidates(profileId: string): ProfileDirectoryCandidate[] {
  const canonical = profileDirectoryName(profileId);
  const legacy = legacyProfileDirectoryName(canonical);
  return legacy === canonical
    ? [{ kind: 'canonical', directoryName: canonical }]
    : [
        { kind: 'canonical', directoryName: canonical },
        { kind: 'legacy', directoryName: legacy },
      ];
}

export function profileDirectoryOwner(profileId: string): ProfileDirectoryOwner {
  return { version: 1, profileId: profileDirectoryName(profileId) };
}

export function serializeProfileDirectoryOwner(profileId: string): string {
  return JSON.stringify(profileDirectoryOwner(profileId));
}

export function parseProfileDirectoryOwner(value: string): ProfileDirectoryOwner {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('The profile storage ownership marker is invalid.');
  }
  if (
    typeof parsed !== 'object' || parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { profileId?: unknown }).profileId !== 'string'
  ) {
    throw new Error('The profile storage ownership marker is invalid.');
  }
  const profileId = (parsed as { profileId: string }).profileId;
  const owner = profileDirectoryOwner(profileId);
  if (owner.profileId !== profileId) {
    throw new Error('The profile storage ownership marker is invalid.');
  }
  return owner;
}

/**
 * Proves which configured profile may claim a legacy normalized directory.
 * The caller must supply the complete saved profile ID set. Ambiguity is
 * rejected before any ownership marker is written.
 */
export function assertUnambiguousLegacyProfileOwner(
  profileId: string,
  allKnownProfileIds: readonly string[],
): string {
  const exact = profileDirectoryName(profileId);
  const legacyName = legacyProfileDirectoryName(exact);
  const owners = new Set(
    allKnownProfileIds
      .map(profileDirectoryName)
      .filter((candidate) => legacyProfileDirectoryName(candidate) === legacyName),
  );
  if (!owners.has(exact) || owners.size !== 1) {
    throw new Error('The legacy profile storage directory has ambiguous ownership.');
  }
  return legacyName;
}

/** Builds a profile root without allocating it. New callers should never
 * construct `folio/profiles` directly, so every creator shares this policy. */
export function profileRootDirectory<
  DirectoryHandle extends ProfileRootDirectoryHandle,
  OwnerFileHandle extends ProfileRootOwnerFileHandle<DirectoryHandle>,
>(
  root: DirectoryHandle,
  directoryName: string,
  storage: ProfileRootStorageAdapter<DirectoryHandle, OwnerFileHandle>,
): DirectoryHandle {
  return storage.directory(root, 'folio', 'profiles', profileDirectoryName(directoryName));
}

export function profileRootOwnerFile<
  DirectoryHandle extends ProfileRootDirectoryHandle,
  OwnerFileHandle extends ProfileRootOwnerFileHandle<DirectoryHandle>,
>(
  directory: DirectoryHandle,
  storage: ProfileRootStorageAdapter<DirectoryHandle, OwnerFileHandle>,
): OwnerFileHandle {
  return storage.file(directory, PROFILE_DIRECTORY_OWNER_FILE);
}

export function profileRootDirectoryOwner<
  DirectoryHandle extends ProfileRootDirectoryHandle,
  OwnerFileHandle extends ProfileRootOwnerFileHandle<DirectoryHandle>,
>(
  directory: DirectoryHandle,
  storage: ProfileRootStorageAdapter<DirectoryHandle, OwnerFileHandle>,
): string | null {
  const marker = profileRootOwnerFile(directory, storage);
  if (!marker.exists) return null;
  return parseProfileDirectoryOwner(marker.textSync()).profileId;
}

/**
 * Reads a legacy owner marker during migration. A zero-length marker is the
 * recoverable residue of marker.create succeeding before marker.write; it is
 * still unclaimed and must pass the complete ambiguity proof before reuse.
 */
export function legacyProfileRootDirectoryOwner<
  DirectoryHandle extends ProfileRootDirectoryHandle,
  OwnerFileHandle extends ProfileRootOwnerFileHandle<DirectoryHandle>,
>(
  directory: DirectoryHandle,
  storage: ProfileRootStorageAdapter<DirectoryHandle, OwnerFileHandle>,
): string | null {
  const marker = profileRootOwnerFile(directory, storage);
  if (!marker.exists) return null;
  const value = marker.textSync();
  if (value === '') return null;
  return parseProfileDirectoryOwner(value).profileId;
}

/**
 * Detects the two interruption residues that contain no profile data: an
 * empty root created before its marker, or a root containing only a marker
 * file that was created but not written. Non-empty/corrupt roots stay strict.
 */
export function isRecoverableEmptyProfileRoot<
  DirectoryHandle extends ProfileRootDirectoryHandle,
  OwnerFileHandle extends ProfileRootOwnerFileHandle<DirectoryHandle>,
>(
  directory: DirectoryHandle,
  storage: ProfileRootStorageAdapter<DirectoryHandle, OwnerFileHandle>,
): boolean {
  if (!directory.exists) return false;
  const marker = profileRootOwnerFile(directory, storage);
  const entries = directory.list();
  if (!marker.exists) return entries.length === 0;
  return entries.length === 1 && marker.textSync() === '';
}

/** Claims only a canonical root proven to contain no profile data. */
export function recoverEmptyCanonicalProfileRoot<
  DirectoryHandle extends ProfileRootDirectoryHandle,
  OwnerFileHandle extends ProfileRootOwnerFileHandle<DirectoryHandle>,
>(
  directory: DirectoryHandle,
  profileId: string,
  storage: ProfileRootStorageAdapter<DirectoryHandle, OwnerFileHandle>,
): boolean {
  if (!isRecoverableEmptyProfileRoot(directory, storage)) return false;
  const exactProfileId = profileDirectoryName(profileId);
  const marker = profileRootOwnerFile(directory, storage);
  const markerCreated = !marker.exists;
  try {
    if (markerCreated) marker.create({ overwrite: false });
    marker.write(serializeProfileDirectoryOwner(exactProfileId));
  } catch (error) {
    if (markerCreated && marker.exists) marker.delete();
    throw error;
  }
  return true;
}

/**
 * Returns the exact canonical root, creating its durable owner marker as part
 * of the allocation. Unmarked pre-policy roots must be claimed explicitly by
 * migration before any staging, offline, or export writer can use them.
 */
export function ensureOwnedProfileRoot<
  DirectoryHandle extends ProfileRootDirectoryHandle,
  OwnerFileHandle extends ProfileRootOwnerFileHandle<DirectoryHandle>,
>(
  root: DirectoryHandle,
  profileId: string,
  storage: ProfileRootStorageAdapter<DirectoryHandle, OwnerFileHandle>,
): DirectoryHandle {
  const exactProfileId = profileDirectoryName(profileId);
  storage.assertProfileRootAllocationAllowed(root, exactProfileId);
  const directory = profileRootDirectory(root, exactProfileId, storage);
  if (directory.exists) {
    recoverEmptyCanonicalProfileRoot(directory, exactProfileId, storage);
    const owner = profileRootDirectoryOwner(directory, storage);
    if (owner !== exactProfileId) {
      throw new Error(owner === null
        ? 'Legacy profile storage must be migrated before it can be accessed.'
        : 'The profile storage directory belongs to another connection profile.');
    }
    storage.assertProfileRootAllocationAllowed(root, exactProfileId);
    return directory;
  }

  const legacy = profileDirectoryCandidates(exactProfileId)
    .find((candidate) => candidate.kind === 'legacy');
  if (legacy) {
    const legacyDirectory = profileRootDirectory(root, legacy.directoryName, storage);
    if (
      legacyDirectory.exists &&
      !isRecoverableEmptyProfileRoot(legacyDirectory, storage) &&
      profileRootDirectoryOwner(legacyDirectory, storage) === null
    ) {
      throw new Error('Legacy profile storage must be migrated before it can be accessed.');
    }
  }

  directory.create({ idempotent: false, intermediates: true });
  const marker = profileRootOwnerFile(directory, storage);
  let markerCreated = false;
  try {
    marker.create({ overwrite: false });
    markerCreated = true;
    marker.write(serializeProfileDirectoryOwner(exactProfileId));
    // A fence may have appeared in another native runtime after the first
    // check. Do not hand a newly-created root to the stale allocator.
    storage.assertProfileRootAllocationAllowed(root, exactProfileId);
  } catch (error) {
    if (markerCreated && marker.exists) marker.delete();
    if (directory.exists && directory.list().length === 0) directory.delete();
    throw error;
  }
  return directory;
}

/**
 * Validates the ownership states found at existing legacy roots. Ambiguity is
 * relevant only when migration would actually claim an unmarked directory.
 */
export function assertLegacyProfileRootsClaimable(
  profileId: string,
  allKnownProfileIds: readonly string[],
  existingOwners: readonly (string | null)[],
): void {
  const exactProfileId = profileDirectoryName(profileId);
  const legacyName = legacyProfileDirectoryName(exactProfileId);
  const hasForeignOwner = existingOwners.some(
    (owner) => owner !== null && owner !== exactProfileId,
  );

  if (legacyName === exactProfileId && hasForeignOwner) {
    throw new Error('The profile storage directory belongs to another profile.');
  }
  if (!existingOwners.includes(null)) return;
  if (hasForeignOwner) {
    throw new Error('The legacy profile storage roots have conflicting ownership.');
  }
  assertUnambiguousLegacyProfileOwner(exactProfileId, allKnownProfileIds);
}
