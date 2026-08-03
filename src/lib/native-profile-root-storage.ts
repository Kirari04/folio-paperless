import { Directory, File, Paths } from 'expo-file-system';

import {
  type ProfileRootStorageAdapter,
} from './profile-file-path-policy';
import {
  parseNativeProfileRemovalFence,
  profileRemovalFenceCandidateName,
  profileRemovalFencePathSegments,
  serializeNativeProfileRemovalFence,
  validateNativeProfileRemovalFence,
  type NativeProfileRemovalFence,
} from './profile-removal-fence-policy';

export function nativeProfileRemovalFenceFile(profileId: string) {
  return new File(
    Paths.document,
    ...profileRemovalFencePathSegments(profileId),
  );
}

export function nativeProfileRemovalFenceUri(profileId: string) {
  return nativeProfileRemovalFenceFile(profileId).uri;
}

export function listNativeProfileRemovalFences(): NativeProfileRemovalFence[] {
  const directory = nativeProfileRemovalFenceFile('fence-probe').parentDirectory;
  if (!directory.exists) return [];
  return directory.list()
    .filter((entry): entry is File => entry instanceof File && entry.name.endsWith('.json'))
    .map((entry) => {
      const fence = parseNativeProfileRemovalFence(entry.textSync());
      if (entry.uri !== nativeProfileRemovalFenceFile(fence.profileId).uri) {
        throw new Error('The profile removal fence path is invalid.');
      }
      return fence;
    });
}

export function nativeProfileRootAllocationIsFenced(profileId: string): boolean {
  return nativeProfileRemovalFenceFile(profileId).exists;
}

export function assertNativeProfileRootAllocationAllowed(profileId: string): void {
  if (nativeProfileRootAllocationIsFenced(profileId)) {
    throw new Error('The connection profile is fenced for native file removal.');
  }
}

function assertSameFence(actual: NativeProfileRemovalFence, expected: NativeProfileRemovalFence) {
  if (
    actual.version !== expected.version ||
    actual.operationId !== expected.operationId ||
    actual.profileId !== expected.profileId ||
    actual.disposition !== expected.disposition
  ) {
    throw new Error('Another profile removal fence already exists.');
  }
}

/**
 * Publishes a complete fence with a same-volume synchronous rename. A crash
 * can leave an operation-specific candidate, but never a partially-written
 * live fence. The live fence exists before staging performs its first move.
 */
export function createNativeProfileRemovalFence(value: NativeProfileRemovalFence): void {
  const fence = validateNativeProfileRemovalFence(value);
  const destination = nativeProfileRemovalFenceFile(fence.profileId);
  if (destination.exists) {
    assertSameFence(parseNativeProfileRemovalFence(destination.textSync()), fence);
    return;
  }

  const directory = destination.parentDirectory;
  directory.create({ idempotent: true, intermediates: true });
  const candidate = new File(directory, profileRemovalFenceCandidateName(fence.operationId));
  try {
    if (candidate.exists) {
      assertSameFence(parseNativeProfileRemovalFence(candidate.textSync()), fence);
    } else {
      candidate.create({ overwrite: false });
      candidate.write(serializeNativeProfileRemovalFence(fence));
    }
    candidate.moveSync(destination);
  } catch (error) {
    if (destination.exists) {
      try {
        assertSameFence(parseNativeProfileRemovalFence(destination.textSync()), fence);
        return;
      } finally {
        if (candidate.exists) candidate.delete();
      }
    }
    if (candidate.exists) candidate.delete();
    throw error;
  }
}

/** Removes only the fence owned by this operation. */
export function removeNativeProfileRemovalFence(value: NativeProfileRemovalFence): void {
  const fence = validateNativeProfileRemovalFence(value);
  const file = nativeProfileRemovalFenceFile(fence.profileId);
  if (!file.exists) return;
  assertSameFence(parseNativeProfileRemovalFence(file.textSync()), fence);
  file.delete();
}

export const nativeProfileRootStorage: ProfileRootStorageAdapter<Directory, File> = {
  assertProfileRootAllocationAllowed(_root, profileId) {
    assertNativeProfileRootAllocationAllowed(profileId);
  },
  directory(root, ...segments) {
    return new Directory(root, ...segments);
  },
  file(directory, name) {
    return new File(directory, name);
  },
};
