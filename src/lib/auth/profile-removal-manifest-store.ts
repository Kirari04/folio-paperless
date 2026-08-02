import type { FolioRepository } from '@/types/persistence';

import type { ProfileRemovalManifestStore } from './profile-store';

/** Bridges the auth journal to the app's durable non-secret repository. */
export function createRepositoryProfileRemovalManifestStore(
  repository: Pick<
    FolioRepository,
    | 'writeProfileRemovalManifest'
    | 'readProfileRemovalManifest'
    | 'deleteProfileRemovalManifest'
  >,
): ProfileRemovalManifestStore {
  return {
    write: (manifest) => repository.writeProfileRemovalManifest(manifest),
    read: (reference) => repository.readProfileRemovalManifest(reference),
    delete: (reference) => repository.deleteProfileRemovalManifest(reference),
  };
}
