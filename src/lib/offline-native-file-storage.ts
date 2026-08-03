import { Directory, File, Paths } from 'expo-file-system';

import type { OfflineFileStorage } from './offline-file-cache';
import {
  ensureOwnedProfileRoot,
  profileDirectoryCandidates,
  profileDirectoryName,
  profileRootDirectory,
  profileRootDirectoryOwner,
} from './profile-file-path-policy';
import {
  assertNativeProfileRootAllocationAllowed,
  nativeProfileRootAllocationIsFenced,
  nativeProfileRootStorage,
} from './native-profile-root-storage';
import { excludeSensitiveFileFromBackup } from './sensitive-file-backup';

function safeSegment(value: string, label: string) {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function ensureDirectory(root: Directory, ...segments: string[]) {
  const directory = new Directory(root, ...segments);
  if (!directory.exists) directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function profileRoot(root: Directory, profileId: string) {
  return profileRootDirectory(root, profileId, nativeProfileRootStorage);
}

function profileOwner(directory: Directory) {
  return profileRootDirectoryOwner(directory, nativeProfileRootStorage);
}

function canonicalFilePath(uri: string) {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'file:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('The offline file URI is invalid.');
  }
  return parsed.pathname;
}

export function assertProfileOfflineFileUri(profileId: string, uri: string) {
  const exactProfileId = profileDirectoryName(profileId);
  const candidate = canonicalFilePath(uri);
  const roots = [Paths.cache, Paths.document].flatMap((root) =>
    profileDirectoryCandidates(exactProfileId)
      .map(({ directoryName }) => profileRoot(root, directoryName))
      .filter((directory) => directory.exists && profileOwner(directory) === exactProfileId)
      .map((directory) => canonicalFilePath(directory.uri).replace(/\/+$/, '')),
  );
  if (!roots.some((root) => candidate.startsWith(`${root}/`))) {
    throw new Error('The offline file does not belong to this connection profile.');
  }
  return uri;
}

function assertCanonicalProfileOfflineFileUri(profileId: string, uri: string) {
  const exactProfileId = profileDirectoryName(profileId);
  const candidate = canonicalFilePath(uri);
  const roots = [Paths.cache, Paths.document]
    .map((root) => profileRoot(root, exactProfileId))
    .map((directory) => canonicalFilePath(directory.uri).replace(/\/+$/, ''));
  if (!roots.some((root) => candidate.startsWith(`${root}/`))) {
    throw new Error('The offline file is outside the canonical connection profile root.');
  }
  return uri;
}

function removeCanonicalFencedProfileFile(profileId: string, uri: string) {
  assertCanonicalProfileOfflineFileUri(profileId, uri);
  const file = new File(uri);
  if (file.exists) file.delete();
}

async function protectPersistentOfflineFile(uri: string) {
  const candidate = canonicalFilePath(uri);
  const documentRoot = canonicalFilePath(Paths.document.uri).replace(/\/+$/, '');
  if (!candidate.startsWith(`${documentRoot}/`)) return;
  const destination = new File(uri);
  try {
    await excludeSensitiveFileFromBackup(uri);
  } catch (error) {
    if (destination.exists) destination.delete();
    throw error;
  }
}

export const expoOfflineFileStorage: OfflineFileStorage = {
  allocate(input) {
    const profileId = profileDirectoryName(input.profileId);
    const documentId = safeSegment(input.documentId, 'Document ID');
    const operationId = safeSegment(input.operationId, 'Operation ID');
    const representation = safeSegment(input.representation, 'Representation');
    const temporaryDirectory = ensureDirectory(
      ensureOwnedProfileRoot(Paths.cache, profileId, nativeProfileRootStorage),
      'downloads',
    );
    const committedDirectory = ensureDirectory(
      ensureOwnedProfileRoot(
        input.pinned ? Paths.document : Paths.cache,
        profileId,
        nativeProfileRootStorage,
      ),
      input.pinned ? 'offline' : 'files',
    );
    return {
      temporaryUri: new File(
        temporaryDirectory,
        `${documentId}-${representation}-${operationId}.partial`,
      ).uri,
      committedUri: new File(
        committedDirectory,
        `${documentId}-${representation}-${operationId}.bin`,
      ).uri,
    };
  },

  async stat(profileId, uri) {
    if (nativeProfileRootAllocationIsFenced(profileId)) {
      removeCanonicalFencedProfileFile(profileId, uri);
      throw new Error('The connection profile is fenced for native file removal.');
    }
    assertProfileOfflineFileUri(profileId, uri);
    const file = new File(uri);
    return { exists: file.exists, byteSize: file.exists ? file.size : 0 };
  },

  async commit(profileId, temporaryUri, committedUri) {
    assertNativeProfileRootAllocationAllowed(profileId);
    assertProfileOfflineFileUri(profileId, temporaryUri);
    assertProfileOfflineFileUri(profileId, committedUri);
    const source = new File(temporaryUri);
    if (!source.exists || source.size <= 0) throw new Error('The temporary download is missing.');
    const destination = new File(committedUri);
    if (destination.exists) destination.delete();
    source.move(destination);
    try {
      await protectPersistentOfflineFile(committedUri);
      assertNativeProfileRootAllocationAllowed(profileId);
    } catch (error) {
      if (destination.exists) destination.delete();
      throw error;
    }
  },

  async copy(profileId, sourceUri, committedUri) {
    assertNativeProfileRootAllocationAllowed(profileId);
    assertProfileOfflineFileUri(profileId, sourceUri);
    assertProfileOfflineFileUri(profileId, committedUri);
    const source = new File(sourceUri);
    if (!source.exists || source.size <= 0) throw new Error('The offline file is missing.');
    const destination = new File(committedUri);
    if (destination.exists) destination.delete();
    source.copy(destination);
    if (!destination.exists || destination.size !== source.size) {
      if (destination.exists) destination.delete();
      throw new Error('The offline file copy could not be verified.');
    }
    try {
      await protectPersistentOfflineFile(committedUri);
      assertNativeProfileRootAllocationAllowed(profileId);
    } catch (error) {
      if (destination.exists) destination.delete();
      throw error;
    }
  },

  async remove(profileId, uri) {
    if (nativeProfileRootAllocationIsFenced(profileId)) {
      removeCanonicalFencedProfileFile(profileId, uri);
      return;
    }
    assertProfileOfflineFileUri(profileId, uri);
    const file = new File(uri);
    if (file.exists) file.delete();
  },

  async availableDiskBytes() {
    return Number.isFinite(Paths.availableDiskSpace) ? Paths.availableDiskSpace : null;
  },
};
