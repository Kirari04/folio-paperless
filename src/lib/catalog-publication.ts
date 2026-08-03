import type {
  PaperlessCatalogObject,
  PaperlessCatalogResource,
} from '../types/paperless-advanced.ts';
import type {
  CachedWorkspace,
  CatalogMutationLabels,
  FolioRepository,
} from '../types/persistence.ts';

/** Persists the exact server-returned object before any fallible GET refresh. */
export async function persistReturnedCatalogObject(
  repository: Pick<FolioRepository, 'reconcileCatalogMutation'>,
  profileId: string,
  resource: PaperlessCatalogResource,
  object: PaperlessCatalogObject,
  labels: CatalogMutationLabels,
): Promise<CachedWorkspace> {
  return repository.reconcileCatalogMutation(
    profileId,
    { kind: 'upsert', resource, object },
    labels,
  );
}

/** Persists a confirmed catalog DELETE before any fallible GET refresh. */
export async function persistDeletedCatalogObject(
  repository: Pick<FolioRepository, 'reconcileCatalogMutation'>,
  profileId: string,
  resource: PaperlessCatalogResource,
  remoteId: number,
  labels: CatalogMutationLabels,
): Promise<CachedWorkspace> {
  return repository.reconcileCatalogMutation(
    profileId,
    { kind: 'delete', resource, remoteId },
    labels,
  );
}
