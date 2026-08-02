import type {
  DocumentStatus,
  PaperlessOptionalWorkspaceResource,
  PaperlessOption,
  PaperlessWorkspaceResourceAvailability,
  PaperlessWorkspaceResourceCapability,
} from '../types/document.ts';

export const PAPERLESS_OPTIONAL_WORKSPACE_RESOURCES = [
  'correspondents',
  'documentTypes',
  'tags',
  'storagePaths',
  'owners',
  'customFields',
  'savedViews',
  'workflows',
] as const satisfies readonly PaperlessOptionalWorkspaceResource[];

/** Uses the server-filtered inbox queryset when supplied. This preserves the
 * user's visible inbox membership without exposing a tag they cannot list. */
export function resolvePaperlessDocumentStatus(
  documentId: number,
  resolvedTags: readonly PaperlessOption[],
  authoritativeInboxIds?: ReadonlySet<number>,
): DocumentStatus {
  if (authoritativeInboxIds) {
    return authoritativeInboxIds.has(documentId) ? 'inbox' : 'archived';
  }
  return resolvedTags.some((tag) => (
    tag.isInboxTag === true || tag.name.toLocaleLowerCase() === 'inbox'
  )) ? 'inbox' : 'archived';
}

type OptionalResourceLoaders<T extends Record<PaperlessOptionalWorkspaceResource, unknown>> = {
  [K in PaperlessOptionalWorkspaceResource]: () => Promise<T[K]>;
};

function unavailableCapability(error: unknown): PaperlessWorkspaceResourceCapability | null {
  if (!error || typeof error !== 'object') return null;
  const status = (error as { status?: unknown }).status;
  if (status === 403) {
    return { available: false, reason: 'permission-denied', status };
  }
  if (status === 404 || status === 405) {
    return { available: false, reason: 'endpoint-unavailable', status };
  }
  return null;
}

/**
 * Documents are the only required workspace resource. Paperless applies
 * document visibility to that queryset, while catalog endpoints have their
 * own permissions and may legitimately be unavailable to the same account.
 * Authentication, transport, and server failures still reject the load.
 */
export async function negotiatePaperlessWorkspaceResources<
  TDocuments,
  TOptional extends Record<PaperlessOptionalWorkspaceResource, unknown>,
>(
  loadDocuments: () => Promise<TDocuments>,
  optionalLoaders: OptionalResourceLoaders<TOptional>,
  unavailableValues: TOptional,
) {
  const [documents, optionalEntries] = await Promise.all([
    loadDocuments(),
    Promise.all(
      PAPERLESS_OPTIONAL_WORKSPACE_RESOURCES.map(async (resource) => {
        try {
          return [resource, await optionalLoaders[resource](), { available: true }] as const;
        } catch (error) {
          const capability = unavailableCapability(error);
          if (!capability) throw error;
          return [resource, unavailableValues[resource], capability] as const;
        }
      }),
    ),
  ]);
  const optional = {} as TOptional;
  const availability = {
    documents: { available: true },
  } as PaperlessWorkspaceResourceAvailability;
  for (const [resource, value, capability] of optionalEntries) {
    optional[resource] = value;
    availability[resource] = capability;
  }
  return { documents, optional, availability };
}
