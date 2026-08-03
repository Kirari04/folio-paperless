import { Directory, File, FileMode, Paths } from 'expo-file-system';

import {
  MAX_SHARED_TEXT_BYTES,
  tasksReadyForStagingCleanup,
  type IntakeStagingAdapter,
} from './intake';
import {
  assertLegacyProfileRootsClaimable,
  ensureOwnedProfileRoot,
  isRecoverableEmptyProfileRoot,
  legacyProfileRootDirectoryOwner,
  legacyProfileDirectoryName,
  parseProfileDirectoryOwner,
  profileDirectoryCandidates,
  profileDirectoryName,
  profileRootDirectory,
  profileRootDirectoryOwner,
  profileRootOwnerFile,
  serializeProfileDirectoryOwner,
  type ProfileDirectoryCandidate,
} from './profile-file-path-policy';
import {
  assertNativeProfileRootAllocationAllowed,
  createNativeProfileRemovalFence,
  listNativeProfileRemovalFences,
  nativeProfileRemovalFenceUri,
  nativeProfileRootStorage,
  removeNativeProfileRemovalFence,
} from './native-profile-root-storage';
import {
  assertNativeProfileRemovalFenceDisposition,
  type NativeProfileRemovalFence,
  type NativeProfileRemovalFenceDisposition,
} from './profile-removal-fence-policy';
import { assertSafeTemporaryPathSegment } from './temporary-file-policy';
import { excludeSensitiveFileFromBackup } from './sensitive-file-backup';
import type { PersistentTask } from '../types/tasks';

export const COMPLETED_STAGING_RETENTION_MS = 24 * 60 * 60 * 1000;

function profileRoot(root: Directory, directoryName: string) {
  return profileRootDirectory(root, directoryName, nativeProfileRootStorage);
}

function profileOwnerFile(directory: Directory) {
  return profileRootOwnerFile(directory, nativeProfileRootStorage);
}

function directoryOwner(directory: Directory): string | null {
  return profileRootDirectoryOwner(directory, nativeProfileRootStorage);
}

function stagingDirectory(profileId: string) {
  const directory = new Directory(
    ensureOwnedProfileRoot(Paths.document, profileId, nativeProfileRootStorage),
    'staging',
  );
  if (!directory.exists) directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function canonicalFilePath(uri: string) {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'file:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('The staged file URI is invalid.');
  }
  return parsed.pathname;
}

export function assertProfileStagingUri(profileId: string, uri: string) {
  const candidate = canonicalFilePath(uri);
  const roots = profileDirectoryCandidates(profileId)
    .map(({ directoryName }) => profileRoot(Paths.document, directoryName))
    .filter((directory) => directory.exists && directoryOwner(directory) === profileDirectoryName(profileId))
    .map((directory) => canonicalFilePath(new Directory(directory, 'staging').uri).replace(/\/+$/, ''));
  if (!roots.some((root) => candidate.startsWith(`${root}/`))) {
    throw new Error('The staged file does not belong to this connection profile.');
  }
  return uri;
}

function boundedCopy(source: File, destination: File, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('The intake size limit is invalid.');
  if (!source.exists || source.size <= 0) throw new Error('The source file is no longer readable.');
  if (source.size > maxBytes) throw new Error('The source file exceeds the intake size limit.');
  const expectedSize = source.size;
  destination.create({ overwrite: true });
  const sourceHandle = source.open(FileMode.ReadOnly);
  const destinationHandle = destination.open(FileMode.Truncate);
  let copied = 0;
  try {
    while (true) {
      const bytes = sourceHandle.readBytes(64 * 1024);
      if (bytes.byteLength === 0) break;
      if (copied + bytes.byteLength > maxBytes) {
        throw new Error('The source file changed and exceeds the intake size limit.');
      }
      destinationHandle.writeBytes(bytes);
      copied += bytes.byteLength;
    }
  } finally {
    sourceHandle.close();
    destinationHandle.close();
  }
  if (copied !== expectedSize) throw new Error('The source file changed while it was secured.');
}

export const nativeIntakeStagingAdapter: IntakeStagingAdapter = {
  async stage(candidate, stagedName, profileId, maxBytes) {
    const destination = new File(stagingDirectory(profileId), stagedName);
    try {
      if (candidate.textContent !== undefined) {
        const size = new TextEncoder().encode(candidate.textContent).byteLength;
        if (size <= 0 || size > Math.min(maxBytes, MAX_SHARED_TEXT_BYTES)) {
          throw new Error('The shared text exceeds the intake size limit.');
        }
        destination.create({ overwrite: true });
        destination.write(candidate.textContent);
      } else {
        boundedCopy(new File(candidate.uri), destination, maxBytes);
      }
      await excludeSensitiveFileFromBackup(destination.uri);
    } catch (error) {
      if (destination.exists) destination.delete();
      throw error;
    }
    if (!destination.exists || destination.size <= 0 || destination.size > maxBytes) {
      if (destination.exists) destination.delete();
      throw new Error('The private copy could not be verified.');
    }
    try {
      assertNativeProfileRootAllocationAllowed(profileId);
    } catch (error) {
      if (destination.exists) destination.delete();
      throw error;
    }
    return {
      uri: destination.uri,
      name: destination.name,
      size: destination.size,
      mimeType: candidate.mimeType || destination.type || 'application/octet-stream',
    };
  },
  async remove(profileId, uri) {
    assertProfileStagingUri(profileId, uri);
    const file = new File(uri);
    if (file.exists) file.delete();
  },
};

export async function cleanupRetainedStagingFiles(options: {
  tasks: readonly PersistentTask[];
  writeTask(task: PersistentTask): Promise<void>;
  remove?(profileId: string, uri: string): Promise<void>;
  now?: Date;
  retentionMs?: number;
}) {
  const now = options.now ?? new Date();
  const retentionMs = options.retentionMs ?? COMPLETED_STAGING_RETENTION_MS;
  const remove = options.remove ?? nativeIntakeStagingAdapter.remove;
  const cleaned: string[] = [];
  for (const task of tasksReadyForStagingCleanup(options.tasks, now, retentionMs)) {
    await remove(task.profileId, task.localUri!);
    await options.writeTask({
      ...task,
      localUri: undefined,
      stagedName: undefined,
      updatedAt: now.toISOString(),
    });
    cleaned.push(task.id);
  }
  return cleaned;
}

export type LegacyNativeProfileRootMigration = {
  /** Roots whose durable ownership was established by this migration. */
  claimedRootUris: string[];
  /** Removes only the owner claims established by this migration. */
  rollback(): Promise<void>;
};

/**
 * Claims old lossy roots without changing their URI, so existing persisted
 * offline-file records remain usable. The complete saved profile set is
 * required to prove that the legacy name has exactly one possible owner.
 */
export async function migrateLegacyNativeProfileRoots(
  profileId: string,
  allKnownProfileIds: readonly string[],
): Promise<LegacyNativeProfileRootMigration> {
  const exactProfileId = profileDirectoryName(profileId);
  const legacyName = legacyProfileDirectoryName(exactProfileId);
  const markers: File[] = [];
  const roots = [Paths.document, Paths.cache];
  const existingDirectories: { directory: Directory; owner: string | null }[] = [];

  for (const root of roots) {
    const directory = profileRoot(root, legacyName);
    if (!directory.exists) continue;
    // An interrupted allocation with no profile data is recovered lazily by
    // the canonical writer and is not legacy data that migration can claim.
    if (isRecoverableEmptyProfileRoot(directory, nativeProfileRootStorage)) continue;
    existingDirectories.push({
      directory,
      owner: legacyProfileRootDirectoryOwner(directory, nativeProfileRootStorage),
    });
  }
  assertLegacyProfileRootsClaimable(
    exactProfileId,
    allKnownProfileIds,
    existingDirectories.map(({ owner }) => owner),
  );
  const unclaimedDirectories = existingDirectories
    .filter(({ owner }) => owner === null)
    .map(({ directory }) => directory);

  try {
    for (const directory of unclaimedDirectories) {
      const marker = profileOwnerFile(directory);
      const markerCreated = !marker.exists;
      if (markerCreated) marker.create({ overwrite: false });
      try {
        marker.write(serializeProfileDirectoryOwner(exactProfileId));
      } catch (error) {
        if (markerCreated && marker.exists) marker.delete();
        throw error;
      }
      markers.push(marker);
    }
  } catch (error) {
    for (const marker of markers.reverse()) {
      if (marker.exists) marker.delete();
    }
    throw error;
  }

  return {
    claimedRootUris: markers.map((marker) => marker.parentDirectory.uri),
    async rollback() {
      for (const marker of [...markers].reverse()) {
        if (!marker.exists) continue;
        const owner = parseProfileDirectoryOwner(marker.textSync()).profileId;
        if (owner !== exactProfileId) {
          throw new Error('The legacy profile storage ownership marker changed unexpectedly.');
        }
        marker.delete();
      }
    },
  };
}

export type NativeProfileFileRemovalLabel =
  | 'documents'
  | 'documents-legacy'
  | 'cache'
  | 'cache-legacy'
  | 'previews'
  | 'exports';

function removalSourceMayBeEvicted(label: NativeProfileFileRemovalLabel) {
  return label === 'cache' || label === 'cache-legacy' ||
    label === 'previews' || label === 'exports';
}

export type NativeProfileFileRemovalMove = {
  label: NativeProfileFileRemovalLabel;
  originalUri: string;
  quarantineUri: string;
  /** Whether the source was present when the durable plan was produced. */
  sourceExisted: boolean;
};

export type NativeProfileFileRemovalManifest = {
  version: 2;
  operationId: string;
  profileId: string;
  fenceDisposition: NativeProfileRemovalFenceDisposition;
  fenceUri: string;
  moves: NativeProfileFileRemovalMove[];
};

export type StagedNativeProfileFileRemoval = {
  /** JSON-safe descriptor that can be stored before any native path is moved. */
  manifest: NativeProfileFileRemovalManifest;
  /** Permanently removes the quarantined files and rejects on cleanup failure. */
  commit(): Promise<void>;
  /** Restores every moved directory to its original profile-scoped path. */
  rollback(): Promise<void>;
};

type RemovalSource = {
  label: NativeProfileFileRemovalLabel;
  root: Directory;
  directory: Directory;
};

function profileRemovalSources(profileId: string): RemovalSource[] {
  const exactProfileId = profileDirectoryName(profileId);
  const sources: RemovalSource[] = [];
  const addProfileRoots = (
    root: Directory,
    canonicalLabel: 'documents' | 'cache',
    legacyLabel: 'documents-legacy' | 'cache-legacy',
  ) => {
    for (const candidate of profileDirectoryCandidates(exactProfileId)) {
      const directory = profileRoot(root, candidate.directoryName);
      if (!directory.exists) {
        // Canonical paths are planned even while absent. This lets staging
        // catch a root allocated after the manifest was persisted but before
        // the fence was published. New allocators never create legacy roots.
        if (candidate.kind === 'canonical') {
          sources.push({ label: canonicalLabel, root, directory });
        }
        continue;
      }
      if (isRecoverableEmptyProfileRoot(directory, nativeProfileRootStorage)) {
        // An empty exact root is safe to remove; an empty legacy collision has
        // no profile data and must not block or be assigned to this profile.
        if (candidate.kind === 'canonical') {
          sources.push({ label: canonicalLabel, root, directory });
        }
        continue;
      }
      const owner = directoryOwner(directory);
      if (owner === exactProfileId) {
        sources.push({
          label: candidate.kind === 'canonical' ? canonicalLabel : legacyLabel,
          root,
          directory,
        });
      } else if (candidate.kind === 'canonical' || owner === null) {
        throw new Error(owner === null
          ? 'Legacy profile storage must be migrated before the profile can be removed.'
          : 'The profile storage directory belongs to another connection profile.');
      }
    }
  };
  addProfileRoots(Paths.document, 'documents', 'documents-legacy');
  addProfileRoots(Paths.cache, 'cache', 'cache-legacy');

  const temporaryProfileId = assertSafeTemporaryPathSegment(
    exactProfileId,
    'The connection profile ID',
  );
  sources.push(
    {
      label: 'previews',
      root: Paths.cache,
      directory: new Directory(Paths.cache, 'folio-previews', temporaryProfileId),
    },
    {
      label: 'exports',
      root: Paths.cache,
      directory: new Directory(Paths.cache, 'folio-exports', temporaryProfileId),
    },
  );
  return sources;
}

function defaultRemovalOperationId() {
  return assertSafeTemporaryPathSegment(
    `profile-removal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    'The profile removal operation ID',
  );
}

function quarantineRoot(root: Directory, operationId: string) {
  return new Directory(root, 'folio', 'profile-removal-quarantine', operationId);
}

function expectedRemovalSources(profileId: string): Map<NativeProfileFileRemovalLabel, RemovalSource> {
  const exactProfileId = profileDirectoryName(profileId);
  const candidates = profileDirectoryCandidates(exactProfileId);
  const byKind = new Map<ProfileDirectoryCandidate['kind'], string>(
    candidates.map((candidate) => [candidate.kind, candidate.directoryName]),
  );
  const expected: RemovalSource[] = [
    {
      label: 'documents',
      root: Paths.document,
      directory: profileRoot(Paths.document, byKind.get('canonical')!),
    },
    {
      label: 'cache',
      root: Paths.cache,
      directory: profileRoot(Paths.cache, byKind.get('canonical')!),
    },
    {
      label: 'previews',
      root: Paths.cache,
      directory: new Directory(Paths.cache, 'folio-previews', exactProfileId),
    },
    {
      label: 'exports',
      root: Paths.cache,
      directory: new Directory(Paths.cache, 'folio-exports', exactProfileId),
    },
  ];
  const legacy = byKind.get('legacy');
  if (legacy) {
    expected.push(
      {
        label: 'documents-legacy',
        root: Paths.document,
        directory: profileRoot(Paths.document, legacy),
      },
      {
        label: 'cache-legacy',
        root: Paths.cache,
        directory: profileRoot(Paths.cache, legacy),
      },
    );
  }
  return new Map(expected.map((source) => [source.label, source]));
}

function assertExpectedFileUri(actual: string, expected: string) {
  if (canonicalFilePath(actual) !== canonicalFilePath(expected)) {
    throw new Error('The profile file removal manifest is invalid.');
  }
}

function validateRemovalManifest(
  value: NativeProfileFileRemovalManifest,
): NativeProfileFileRemovalManifest {
  if (typeof value !== 'object' || value === null || value.version !== 2) {
    throw new Error('The profile file removal manifest is invalid.');
  }
  const profileId = profileDirectoryName(value.profileId);
  const operationId = assertSafeTemporaryPathSegment(
    value.operationId,
    'The profile removal operation ID',
  );
  const fenceDisposition = assertNativeProfileRemovalFenceDisposition(value.fenceDisposition);
  if (
    profileId !== value.profileId ||
    operationId !== value.operationId ||
    fenceDisposition !== value.fenceDisposition ||
    typeof value.fenceUri !== 'string' ||
    !Array.isArray(value.moves)
  ) {
    throw new Error('The profile file removal manifest is invalid.');
  }
  assertExpectedFileUri(value.fenceUri, nativeProfileRemovalFenceUri(profileId));
  const expected = expectedRemovalSources(profileId);
  const labels = new Set<NativeProfileFileRemovalLabel>();
  for (const move of value.moves) {
    if (typeof move !== 'object' || move === null || labels.has(move.label)) {
      throw new Error('The profile file removal manifest is invalid.');
    }
    const source = expected.get(move.label);
    if (
      !source ||
      typeof move.originalUri !== 'string' ||
      typeof move.quarantineUri !== 'string' ||
      typeof move.sourceExisted !== 'boolean'
    ) {
      throw new Error('The profile file removal manifest is invalid.');
    }
    assertExpectedFileUri(move.originalUri, source.directory.uri);
    assertExpectedFileUri(
      move.quarantineUri,
      new Directory(quarantineRoot(source.root, operationId), source.label).uri,
    );
    labels.add(move.label);
  }
  for (const required of ['documents', 'cache', 'previews', 'exports'] as const) {
    if (!labels.has(required)) {
      throw new Error('The profile file removal manifest is invalid.');
    }
  }
  return value;
}

/** Produces the exact descriptor to persist before the first filesystem move. */
export function planNativeProfileFileRemoval(
  profileId: string,
  fenceDisposition: NativeProfileRemovalFenceDisposition,
  operationId = defaultRemovalOperationId(),
): NativeProfileFileRemovalManifest {
  const exactProfileId = profileDirectoryName(profileId);
  const exactFenceDisposition = assertNativeProfileRemovalFenceDisposition(fenceDisposition);
  const exactOperationId = assertSafeTemporaryPathSegment(
    operationId,
    'The profile removal operation ID',
  );
  const moves = profileRemovalSources(exactProfileId)
    .map((source) => ({
      label: source.label,
      originalUri: source.directory.uri,
      quarantineUri: new Directory(
        quarantineRoot(source.root, exactOperationId),
        source.label,
      ).uri,
      sourceExisted: source.directory.exists,
    }));
  return validateRemovalManifest({
    version: 2,
    operationId: exactOperationId,
    profileId: exactProfileId,
    fenceDisposition: exactFenceDisposition,
    fenceUri: nativeProfileRemovalFenceUri(exactProfileId),
    moves,
  });
}

function manifestFence(manifest: NativeProfileFileRemovalManifest): NativeProfileRemovalFence {
  return {
    version: 1,
    operationId: manifest.operationId,
    profileId: manifest.profileId,
    disposition: manifest.fenceDisposition,
  };
}

function manifestQuarantineRoots(manifest: NativeProfileFileRemovalManifest) {
  const expected = expectedRemovalSources(manifest.profileId);
  return [...new Set(manifest.moves.map((move) => {
    const source = expected.get(move.label)!;
    return quarantineRoot(source.root, manifest.operationId).uri;
  }))].map((uri) => new Directory(uri));
}

function removalLabelIsProfileRoot(label: NativeProfileFileRemovalLabel) {
  return label === 'documents' || label === 'documents-legacy' ||
    label === 'cache' || label === 'cache-legacy';
}

function removalLabelIsLegacyProfileRoot(label: NativeProfileFileRemovalLabel) {
  return label === 'documents-legacy' || label === 'cache-legacy';
}

/**
 * Deletes roots recreated by writers that received a URI before the fence was
 * published. Exact canonical roots are dedicated to this profile; legacy
 * roots remain ownership-gated because their old names can collide.
 */
function deleteRecreatedProfileRemovalSources(manifest: NativeProfileFileRemovalManifest) {
  let cleanupFailed = false;
  for (const move of manifest.moves) {
    try {
      const original = new Directory(move.originalUri);
      if (!original.exists) continue;
      if (removalLabelIsLegacyProfileRoot(move.label) && !move.sourceExisted) continue;
      if (removalLabelIsProfileRoot(move.label)) {
        const marker = profileOwnerFile(original);
        if (marker.exists) {
          if (directoryOwner(original) !== manifest.profileId) {
            cleanupFailed = true;
            continue;
          }
        } else if (removalLabelIsLegacyProfileRoot(move.label)) {
          cleanupFailed = true;
          continue;
        }
      }
      original.delete();
    } catch {
      cleanupFailed = true;
    }
  }
  return !cleanupFailed;
}

function recoverableTemporaryRemovalManifest(
  fence: NativeProfileRemovalFence,
): NativeProfileFileRemovalManifest {
  const expected = expectedRemovalSources(fence.profileId);
  return validateRemovalManifest({
    version: 2,
    operationId: fence.operationId,
    profileId: fence.profileId,
    fenceDisposition: 'remove-after-purge',
    fenceUri: nativeProfileRemovalFenceUri(fence.profileId),
    moves: [...expected.values()].map((source) => ({
      label: source.label,
      originalUri: source.directory.uri,
      quarantineUri: new Directory(
        quarantineRoot(source.root, fence.operationId),
        source.label,
      ).uri,
      // Recovery cannot prove whether an absent original was moved. Commit
      // does not need that fact, and false keeps colliding legacy originals
      // untouched while their operation-owned quarantine is still purged.
      sourceExisted: false,
    })),
  });
}

/**
 * Completes a same-ID rebind that crashed after publishing its temporary
 * fence. Repository data is purged again before native quarantine cleanup;
 * both operations are idempotent, and the fence is released only afterward.
 */
export async function recoverTemporaryNativeProfileFileRemovals(options: {
  purgeProfileData(profileId: string): Promise<void>;
}): Promise<string[]> {
  const recovered: string[] = [];
  for (const fence of listNativeProfileRemovalFences()) {
    if (fence.disposition !== 'remove-after-purge') continue;
    await options.purgeProfileData(fence.profileId);
    await commitNativeProfileFileRemoval(recoverableTemporaryRemovalManifest(fence));
    recovered.push(fence.profileId);
  }
  return recovered;
}

export async function commitNativeProfileFileRemoval(
  value: NativeProfileFileRemovalManifest,
): Promise<void> {
  const manifest = validateRemovalManifest(value);
  let cleanupFailed = false;
  for (const move of manifest.moves) {
    try {
      const quarantined = new Directory(move.quarantineUri);
      if (quarantined.exists) quarantined.delete();
    } catch {
      cleanupFailed = true;
    }
  }
  for (const root of manifestQuarantineRoots(manifest)) {
    try {
      if (!root.exists) continue;
      if (root.list().length > 0) {
        cleanupFailed = true;
        continue;
      }
      root.delete();
    } catch {
      cleanupFailed = true;
    }
  }
  if (!deleteRecreatedProfileRemovalSources(manifest)) cleanupFailed = true;
  if (cleanupFailed) {
    throw new Error('The profile file quarantine could not be fully removed.');
  }
  if (manifest.fenceDisposition === 'remove-after-purge') {
    removeNativeProfileRemovalFence(manifestFence(manifest));
  }
}

export async function rollbackNativeProfileFileRemoval(
  value: NativeProfileFileRemovalManifest,
): Promise<void> {
  const manifest = validateRemovalManifest(value);
  let rollbackFailed = false;
  for (const move of [...manifest.moves].reverse()) {
    try {
      const original = new Directory(move.originalUri);
      const quarantined = new Directory(move.quarantineUri);
      if (!quarantined.exists) {
        if (move.sourceExisted && !original.exists && !removalSourceMayBeEvicted(move.label)) {
          rollbackFailed = true;
        }
        continue;
      }
      if (original.exists) {
        rollbackFailed = true;
        continue;
      }
      original.parentDirectory.create({ idempotent: true, intermediates: true });
      await quarantined.move(original);
    } catch {
      rollbackFailed = true;
    }
  }
  for (const root of manifestQuarantineRoots(manifest)) {
    try {
      if (!root.exists) continue;
      if (root.list().length > 0) {
        rollbackFailed = true;
        continue;
      }
      root.delete();
    } catch {
      rollbackFailed = true;
    }
  }
  if (rollbackFailed) {
    throw new Error('Profile file cleanup failed and could not be fully rolled back.');
  }
  try {
    removeNativeProfileRemovalFence(manifestFence(manifest));
  } catch {
    throw new Error('Profile file cleanup failed and could not remove its allocation fence.');
  }
}

export function recoverNativeProfileFileRemoval(
  value: NativeProfileFileRemovalManifest,
): StagedNativeProfileFileRemoval {
  const manifest = validateRemovalManifest(value);
  return {
    manifest,
    commit: () => commitNativeProfileFileRemoval(manifest),
    rollback: () => rollbackNativeProfileFileRemoval(manifest),
  };
}

export type StageNativeProfileFilesForRemovalOptions = {
  operationId?: string;
  /** Required when planning from a profile ID; ignored manifests are rejected. */
  fenceDisposition?: NativeProfileRemovalFenceDisposition;
  /** Must durably store the plan; it is awaited before any path is moved. */
  persistPlan?(manifest: NativeProfileFileRemovalManifest): Promise<void>;
};

/**
 * Moves all planned native directories to private quarantine. Passing a
 * persisted manifest resumes an interrupted staging attempt idempotently.
 */
export async function stageNativeProfileFilesForRemoval(
  input: string | NativeProfileFileRemovalManifest,
  options: StageNativeProfileFilesForRemovalOptions = {},
): Promise<StagedNativeProfileFileRemoval> {
  const manifest = typeof input === 'string'
    ? planNativeProfileFileRemoval(
        input,
        assertNativeProfileRemovalFenceDisposition(options.fenceDisposition),
        options.operationId,
      )
    : validateRemovalManifest(input);
  if (
    typeof input !== 'string' &&
    options.fenceDisposition !== undefined &&
    options.fenceDisposition !== manifest.fenceDisposition
  ) {
    throw new Error('The profile file removal fence disposition changed unexpectedly.');
  }
  await options.persistPlan?.(manifest);
  createNativeProfileRemovalFence(manifestFence(manifest));

  try {
    for (const move of manifest.moves) {
      const original = new Directory(move.originalUri);
      const quarantined = new Directory(move.quarantineUri);
      if (quarantined.exists) {
        if (original.exists) {
          throw new Error('A profile directory exists at both removal paths.');
        }
        continue;
      }
      if (!original.exists) {
        if (move.sourceExisted && !removalSourceMayBeEvicted(move.label)) {
          throw new Error('A planned profile directory disappeared before it could be staged.');
        }
        continue;
      }
      quarantined.parentDirectory.create({ idempotent: true, intermediates: true });
      await original.move(quarantined);
    }
  } catch (error) {
    await rollbackNativeProfileFileRemoval(manifest);
    throw error;
  }
  return recoverNativeProfileFileRemoval(manifest);
}
