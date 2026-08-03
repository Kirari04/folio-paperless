import type {
  PaperlessCapabilities,
  PaperlessCapabilityCacheEntry,
  PaperlessCapabilitySource,
  PaperlessCapabilityStatus,
  PaperlessCatalogResource,
  PaperlessCrudCapabilities,
  PaperlessPermissionAction,
  PaperlessPermissionMatrix,
  PaperlessPermissionResource,
  PaperlessPermissionState,
} from '../types/paperless-advanced.ts';
import { getPaperlessHeader, PaperlessClient } from './paperless-client.ts';

type OpenApiDocument = {
  openapi?: unknown;
  info?: { version?: unknown };
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
};

type UiSettingsResponse = {
  user?: { id?: unknown; is_superuser?: unknown };
  ai_enabled?: unknown;
  settings?: { ai_enabled?: unknown };
  permissions?: unknown;
};

type OptionObservation = {
  path: string;
  status: number;
  methods: Set<string>;
};

export type PaperlessCapabilityDiscoveryOptions = {
  now?: Date;
  signal?: AbortSignal;
  optionPaths?: string[];
};

const DEFAULT_OPTION_PATHS = [
  '/api/documents/bulk_edit/',
  '/api/saved_views/',
  '/api/tags/',
  '/api/correspondents/',
  '/api/document_types/',
  '/api/storage_paths/',
  '/api/share_links/',
  '/api/documents/rotate/',
  '/api/documents/merge/',
  '/api/documents/edit_pdf/',
  '/api/documents/remove_password/',
] as const;

const RESOURCE_PERMISSION_NAMES: Record<PaperlessPermissionResource, string> = {
  document: 'document',
  tag: 'tag',
  correspondent: 'correspondent',
  documentType: 'documenttype',
  storagePath: 'storagepath',
  savedView: 'savedview',
  customField: 'customfield',
  user: 'user',
  group: 'group',
  shareLink: 'sharelink',
};

const CATALOG_PATHS: Record<PaperlessCatalogResource, string> = {
  tags: '/api/tags/',
  correspondents: '/api/correspondents/',
  documentTypes: '/api/document_types/',
  storagePaths: '/api/storage_paths/',
};

const CATALOG_PERMISSIONS: Record<PaperlessCatalogResource, PaperlessPermissionResource> = {
  tags: 'tag',
  correspondents: 'correspondent',
  documentTypes: 'documentType',
  storagePaths: 'storagePath',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePath(path: string) {
  const withoutQuery = path.split('?')[0];
  return withoutQuery.endsWith('/') ? withoutQuery : `${withoutQuery}/`;
}

function findPath(schema: OpenApiDocument | null, requestedPath: string) {
  if (!schema?.paths) return null;
  const normalized = normalizePath(requestedPath);
  const match = Object.entries(schema.paths).find(([path]) => normalizePath(path) === normalized);
  return match?.[1] ?? null;
}

function schemaHasOperation(
  schema: OpenApiDocument | null,
  path: string,
  method: string,
) {
  return Boolean(findPath(schema, path)?.[method.toLowerCase()]);
}

function resolveSchemaReference(
  value: unknown,
  document: OpenApiDocument,
  visited: Set<string>,
): unknown {
  if (!isRecord(value) || typeof value.$ref !== 'string') return value;
  const reference = value.$ref;
  if (visited.has(reference)) return null;
  visited.add(reference);
  const prefix = '#/components/schemas/';
  if (!reference.startsWith(prefix)) return null;
  return document.components?.schemas?.[reference.slice(prefix.length)] ?? null;
}

function schemaNodeContainsProperty(
  value: unknown,
  property: string,
  document: OpenApiDocument,
  visitedReferences = new Set<string>(),
  visitedObjects = new Set<object>(),
): boolean {
  const pending: { node: unknown; depth: number }[] = [{ node: value, depth: 0 }];
  let visited = 0;
  while (pending.length && visited < 4_096) {
    const { node, depth } = pending.pop()!;
    if (depth > 32) continue;
    const resolved = resolveSchemaReference(node, document, visitedReferences);
    if (!resolved || typeof resolved !== 'object' || visitedObjects.has(resolved)) continue;
    visitedObjects.add(resolved);
    visited += 1;
    if (Array.isArray(resolved)) {
      for (const entry of resolved.slice(0, 512)) pending.push({ node: entry, depth: depth + 1 });
      continue;
    }
    const record = resolved as Record<string, unknown>;
    if (isRecord(record.properties) && property in record.properties) return true;
    for (const entry of Object.values(record).slice(0, 512)) {
      pending.push({ node: entry, depth: depth + 1 });
    }
  }
  return false;
}

function operationContainsProperty(
  schema: OpenApiDocument | null,
  path: string,
  method: string,
  property: string,
) {
  if (!schema) return false;
  const operation = findPath(schema, path)?.[method.toLowerCase()];
  return schemaNodeContainsProperty(operation, property, schema);
}

function savedViewFieldStatus(
  schema: OpenApiDocument | null,
  property: string,
): PaperlessCapabilityStatus {
  if (operationContainsProperty(schema, '/api/saved_views/{id}/', 'patch', property)) {
    return supported('openapi');
  }
  return schema
    ? unsupported('field-missing', 'openapi')
    : unsupported('schema-unavailable');
}

function parseAllowHeader(value: string | null) {
  return new Set(
    (value ?? '')
      .split(',')
      .map((method) => method.trim().toUpperCase())
      .filter(Boolean),
  );
}

function optionMethods(data: unknown, allowHeader: string | null) {
  const methods = parseAllowHeader(allowHeader);
  if (isRecord(data) && isRecord(data.actions)) {
    for (const method of Object.keys(data.actions)) methods.add(method.toUpperCase());
  }
  return methods;
}

function optionHas(
  observations: OptionObservation[],
  path: string,
  method: string,
) {
  const normalized = normalizePath(path);
  return observations.some(
    (observation) =>
      normalizePath(observation.path) === normalized &&
      observation.status >= 200 &&
      observation.status < 300 &&
      observation.methods.has(method.toUpperCase()),
  );
}

function supported(source: PaperlessCapabilitySource, detail?: string): PaperlessCapabilityStatus {
  return detail ? { supported: true, source, detail } : { supported: true, source };
}

function unsupported(
  reason: Extract<PaperlessCapabilityStatus, { supported: false }>['reason'],
  source?: PaperlessCapabilitySource,
  detail?: string,
): PaperlessCapabilityStatus {
  return {
    supported: false,
    reason,
    ...(source ? { source } : {}),
    ...(detail ? { detail } : {}),
  };
}

function endpointStatus(
  schema: OpenApiDocument | null,
  observations: OptionObservation[],
  apiVersion: string | null,
  path: string,
  method: string,
  documentedV10Fallback = false,
): PaperlessCapabilityStatus {
  if (schemaHasOperation(schema, path, method)) return supported('openapi');
  if (optionHas(observations, path, method)) return supported('options');
  if (schema) return unsupported('endpoint-missing', 'openapi');
  if (documentedV10Fallback && apiVersion === '10') {
    return supported('api-version-fallback', 'Documented by the Paperless API v10 contract.');
  }
  return unsupported('schema-unavailable');
}

function unknownPermissionMatrix(): PaperlessPermissionMatrix {
  const actions: PaperlessPermissionAction[] = ['view', 'add', 'change', 'delete'];
  const resources = Object.keys(RESOURCE_PERMISSION_NAMES) as PaperlessPermissionResource[];
  const result = {} as PaperlessPermissionMatrix;
  for (const resource of resources) {
    result[resource] = Object.fromEntries(
      actions.map((action) => [action, 'unknown']),
    ) as Record<PaperlessPermissionAction, PaperlessPermissionState>;
  }
  result.currentUserId = null;
  result.isSuperuser = false;
  return result;
}

export function buildPaperlessPermissionMatrix(data: unknown): PaperlessPermissionMatrix {
  const matrix = unknownPermissionMatrix();
  if (!isRecord(data)) return matrix;
  const response = data as UiSettingsResponse;
  const user = isRecord(response.user) ? response.user : null;
  matrix.currentUserId = typeof user?.id === 'number' ? user.id : null;
  matrix.isSuperuser = user?.is_superuser === true;
  const permissionValues = Array.isArray(response.permissions)
    ? response.permissions.filter((entry): entry is string => typeof entry === 'string')
    : null;

  if (!permissionValues && !matrix.isSuperuser) return matrix;
  const permissionSet = new Set(permissionValues ?? []);
  const actions: PaperlessPermissionAction[] = ['view', 'add', 'change', 'delete'];
  for (const [resource, serverName] of Object.entries(RESOURCE_PERMISSION_NAMES) as [
    PaperlessPermissionResource,
    string,
  ][]) {
    for (const action of actions) {
      matrix[resource][action] =
        matrix.isSuperuser || permissionSet.has(`${action}_${serverName}`);
    }
  }
  return matrix;
}

function permissionAware(
  status: PaperlessCapabilityStatus,
  permission: PaperlessPermissionState,
  mutation: boolean,
) {
  if (!status.supported) return status;
  if (permission === false) return unsupported('permission-denied', 'ui-settings');
  if (permission === 'unknown' && mutation) {
    return unsupported('permission-unknown', 'ui-settings');
  }
  return status;
}

function crudCapabilities(
  schema: OpenApiDocument | null,
  observations: OptionObservation[],
  apiVersion: string | null,
  path: string,
  permission: Record<PaperlessPermissionAction, PaperlessPermissionState>,
  documentedV10Fallback = false,
): PaperlessCrudCapabilities {
  return {
    list: permissionAware(
      endpointStatus(schema, observations, apiVersion, path, 'get', documentedV10Fallback),
      permission.view,
      false,
    ),
    retrieve: permissionAware(
      endpointStatus(
        schema,
        observations,
        apiVersion,
        `${path}{id}/`,
        'get',
        documentedV10Fallback,
      ),
      permission.view,
      false,
    ),
    create: permissionAware(
      endpointStatus(schema, observations, apiVersion, path, 'post', documentedV10Fallback),
      permission.add,
      true,
    ),
    update: permissionAware(
      endpointStatus(
        schema,
        observations,
        apiVersion,
        `${path}{id}/`,
        'patch',
        documentedV10Fallback,
      ),
      permission.change,
      true,
    ),
    delete: permissionAware(
      endpointStatus(
        schema,
        observations,
        apiVersion,
        `${path}{id}/`,
        'delete',
        documentedV10Fallback,
      ),
      permission.delete,
      true,
    ),
  };
}

function asOpenApiDocument(value: unknown): OpenApiDocument | null {
  if (!isRecord(value) || !isRecord(value.paths)) return null;
  return value as OpenApiDocument;
}

export async function discoverPaperlessCapabilities(
  client: PaperlessClient,
  options: PaperlessCapabilityDiscoveryOptions = {},
): Promise<PaperlessCapabilities> {
  const now = options.now ?? new Date();
  const schemaResponse = await client.raw<unknown>('/api/schema/', {
    signal: options.signal,
  });
  const schema =
    schemaResponse.status >= 200 && schemaResponse.status < 300
      ? asOpenApiDocument(schemaResponse.data)
      : null;

  const uiResponse = await client.raw<unknown>('/api/ui_settings/', {
    signal: options.signal,
  });
  const uiSettings =
    uiResponse.status >= 200 && uiResponse.status < 300 ? uiResponse.data : null;
  const permissions = buildPaperlessPermissionMatrix(uiSettings);

  const observations = await Promise.all(
    (options.optionPaths ?? [...DEFAULT_OPTION_PATHS]).map(async (path) => {
      const response = await client.raw<unknown>(path, {
        method: 'OPTIONS',
        signal: options.signal,
      });
      return {
        path,
        status: response.status,
        methods: optionMethods(response.data, getPaperlessHeader(response, 'Allow')),
      } satisfies OptionObservation;
    }),
  );

  const apiVersion =
    getPaperlessHeader(schemaResponse, 'X-Api-Version') ??
    getPaperlessHeader(uiResponse, 'X-Api-Version');
  const serverVersion =
    getPaperlessHeader(schemaResponse, 'X-Version') ?? getPaperlessHeader(uiResponse, 'X-Version');
  const openApiVersion = typeof schema?.info?.version === 'string' ? schema.info.version : null;
  const serverFingerprint = [apiVersion ?? 'unknown-api', serverVersion ?? 'unknown-server', openApiVersion ?? 'unknown-schema'].join('|');

  const catalogs = {} as Record<PaperlessCatalogResource, PaperlessCrudCapabilities>;
  for (const resource of Object.keys(CATALOG_PATHS) as PaperlessCatalogResource[]) {
    catalogs[resource] = crudCapabilities(
      schema,
      observations,
      apiVersion,
      CATALOG_PATHS[resource],
      permissions[CATALOG_PERMISSIONS[resource]],
    );
  }

  let nestedTags: PaperlessCapabilityStatus;
  if (
    operationContainsProperty(schema, '/api/tags/', 'get', 'parent') &&
    operationContainsProperty(schema, '/api/tags/', 'get', 'children')
  ) {
    nestedTags = supported('openapi');
  } else if (schema) {
    nestedTags = unsupported('field-missing', 'openapi');
  } else {
    nestedTags = unsupported('schema-unavailable');
  }

  let duplicateDocuments: PaperlessCapabilityStatus;
  if (operationContainsProperty(schema, '/api/documents/{id}/', 'get', 'duplicate_documents')) {
    duplicateDocuments = supported('openapi');
  } else if (schema) {
    duplicateDocuments = unsupported('field-missing', 'openapi');
  } else {
    duplicateDocuments = unsupported('schema-unavailable');
  }

  let fullPermissions: PaperlessCapabilityStatus;
  if (
    operationContainsProperty(schema, '/api/documents/{id}/', 'get', 'permissions') &&
    operationContainsProperty(schema, '/api/documents/{id}/', 'patch', 'set_permissions')
  ) {
    fullPermissions = supported('openapi');
  } else if (schema) {
    fullPermissions = unsupported('field-missing', 'openapi');
  } else if (apiVersion === '10') {
    fullPermissions = supported('api-version-fallback', 'Documented Paperless object permissions contract.');
  } else {
    fullPermissions = unsupported('schema-unavailable');
  }

  let aiSuggestions = endpointStatus(
    schema,
    observations,
    apiVersion,
    '/api/documents/{id}/ai_suggestions/',
    'get',
  );
  if (
    isRecord(uiSettings)
    && (
      uiSettings.ai_enabled === false
      || isRecord(uiSettings.settings) && uiSettings.settings.ai_enabled === false
    )
  ) {
    aiSuggestions = unsupported('runtime-disabled', 'runtime', 'AI is disabled on this server.');
  }
  aiSuggestions = permissionAware(
    aiSuggestions,
    permissions.document.change,
    true,
  );

  return {
    profileId: client.profileId,
    discoveredAt: now.toISOString(),
    apiVersion,
    serverVersion,
    openApiVersion,
    schemaAvailable: schema !== null,
    optionsAvailable: observations.some(
      (entry) => entry.status >= 200 && entry.status < 300,
    ),
    serverFingerprint,
    permissions,
    features: {
      bulkDocuments: permissionAware(
        endpointStatus(
          schema,
          observations,
          apiVersion,
          '/api/documents/bulk_edit/',
          'post',
        ),
        permissions.document.change,
        true,
      ),
      deleteDocuments: permissionAware(
        endpointStatus(
          schema,
          observations,
          apiVersion,
          '/api/documents/delete/',
          'post',
          true,
        ),
        permissions.document.delete,
        true,
      ),
      reprocessDocuments: permissionAware(
        endpointStatus(
          schema,
          observations,
          apiVersion,
          '/api/documents/reprocess/',
          'post',
          true,
        ),
        permissions.document.change,
        true,
      ),
      savedViews: {
        ...crudCapabilities(
          schema,
          observations,
          apiVersion,
          '/api/saved_views/',
          permissions.savedView,
        ),
        fields: {
          pageSize: savedViewFieldStatus(schema, 'page_size'),
          displayMode: savedViewFieldStatus(schema, 'display_mode'),
          displayFields: savedViewFieldStatus(schema, 'display_fields'),
          showOnDashboard: savedViewFieldStatus(schema, 'show_on_dashboard'),
          showInSidebar: savedViewFieldStatus(schema, 'show_in_sidebar'),
        },
      },
      catalogs,
      documentMetadata: endpointStatus(
        schema,
        observations,
        apiVersion,
        '/api/documents/{id}/metadata/',
        'get',
      ),
      shareLinks: {
        ...crudCapabilities(
          schema,
          observations,
          apiVersion,
          '/api/share_links/',
          permissions.shareLink,
        ),
        // Paperless lists links through a document action guarded by that
        // document's object-level change permission. Global share-link model
        // permissions do not predict whether this per-document GET succeeds.
        list: endpointStatus(
          schema,
          observations,
          apiVersion,
          '/api/documents/{id}/share_links/',
          'get',
        ),
      },
      nestedTags,
      fullPermissions,
      duplicateDocuments,
      aiSuggestions,
      tasksV10: endpointStatus(
        schema,
        observations,
        apiVersion,
        '/api/tasks/active/',
        'get',
        true,
      ),
      pdf: {
        rotate: permissionAware(
          endpointStatus(
            schema,
            observations,
            apiVersion,
            '/api/documents/rotate/',
            'post',
            true,
          ),
          permissions.document.change,
          true,
        ),
        merge: permissionAware(
          endpointStatus(
            schema,
            observations,
            apiVersion,
            '/api/documents/merge/',
            'post',
            true,
          ),
          permissions.document.add,
          true,
        ),
        edit: permissionAware(
          endpointStatus(
            schema,
            observations,
            apiVersion,
            '/api/documents/edit_pdf/',
            'post',
            true,
          ),
          permissions.document.change,
          true,
        ),
        removePassword: permissionAware(
          endpointStatus(
            schema,
            observations,
            apiVersion,
            '/api/documents/remove_password/',
            'post',
            true,
          ),
          permissions.document.change,
          true,
        ),
      },
    },
  };
}

export class PaperlessCapabilityCache {
  private readonly entries = new Map<string, PaperlessCapabilityCacheEntry>();

  get(profileId: string, now = Date.now(), serverFingerprint?: string) {
    const entry = this.entries.get(profileId);
    if (!entry || entry.expiresAt <= now) {
      if (entry) this.entries.delete(profileId);
      return null;
    }
    if (serverFingerprint && entry.serverFingerprint !== serverFingerprint) {
      this.entries.delete(profileId);
      return null;
    }
    return entry.capabilities;
  }

  set(
    capabilities: PaperlessCapabilities,
    ttlMs = 15 * 60 * 1000,
    now = Date.now(),
    connectionFingerprint = capabilities.serverFingerprint,
  ) {
    const entry: PaperlessCapabilityCacheEntry = {
      profileId: capabilities.profileId,
      fetchedAt: now,
      expiresAt: now + Math.max(0, ttlMs),
      serverFingerprint: connectionFingerprint,
      capabilities,
    };
    this.entries.set(capabilities.profileId, entry);
    return entry;
  }

  invalidate(profileId: string) {
    this.entries.delete(profileId);
  }

  clear() {
    this.entries.clear();
  }
}
