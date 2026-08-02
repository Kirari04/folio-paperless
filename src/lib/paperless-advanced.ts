import type {
  PaperlessAiSuggestions,
  PaperlessAsyncOperationResult,
  PaperlessBulkCandidate,
  PaperlessBulkOperation,
  PaperlessBulkResult,
  PaperlessBulkSkippedItem,
  PaperlessCapabilities,
  PaperlessCapabilityResult,
  PaperlessCapabilityStatus,
  PaperlessCatalogEditByResource,
  PaperlessCatalogObject,
  PaperlessCatalogObjectByResource,
  PaperlessCatalogResource,
  PaperlessCorrespondent,
  PaperlessDocumentRepresentations,
  PaperlessDocumentType,
  PaperlessDuplicateSummary,
  PaperlessNormalizedTag,
  PaperlessOperationFailure,
  PaperlessOwnedObject,
  PaperlessPage,
  PaperlessPdfPageOperation,
  PaperlessPdfSourceMode,
  PaperlessPermissionMutation,
  PaperlessPermissionSet,
  PaperlessPermissionUpdateResult,
  PaperlessRepresentation,
  PaperlessRepresentationInfo,
  PaperlessSavedView,
  PaperlessSavedViewEdit,
  PaperlessSavedViewRule,
  PaperlessShareLink,
  PaperlessShareLinkExpiry,
  PaperlessStoragePath,
  PaperlessTag,
  PaperlessTagHierarchy,
  PaperlessTaskV10,
  PaperlessUnknownRulePolicy,
  PaperlessValidationError,
  PaperlessValidationResult,
} from '../types/paperless-advanced.ts';
import { PaperlessClient, PaperlessClientError, getPaperlessHeader } from './paperless-client.ts';
import { isFolioEditableSavedViewRule } from './saved-view-controller.ts';

const OPAQUE_SHARE_LINK_SLUG = /^[A-Za-z0-9_-]{1,256}$/;

const CATALOG_PATHS: Record<PaperlessCatalogResource, string> = {
  tags: '/api/tags/',
  correspondents: '/api/correspondents/',
  documentTypes: '/api/document_types/',
  storagePaths: '/api/storage_paths/',
};

const PERMISSION_RESOURCE_PATHS = {
  document: '/api/documents/',
  tag: '/api/tags/',
  correspondent: '/api/correspondents/',
  documentType: '/api/document_types/',
  storagePath: '/api/storage_paths/',
  savedView: '/api/saved_views/',
} as const;

type PermissionEditableResource = keyof typeof PERMISSION_RESOURCE_PATHS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function optionalString(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function idList(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isPositiveInteger))];
}

function canonicalIds(value: unknown) {
  return idList(value).sort((left, right) => left - right);
}

function assertPositiveId(id: number, label = 'ID') {
  if (!isPositiveInteger(id)) {
    throw new PaperlessClientError(`${label} must be a positive integer.`, {
      code: 'invalid-input',
    });
  }
}

function extraFields(raw: Record<string, unknown>, knownFields: readonly string[]) {
  const known = new Set(knownFields);
  return Object.freeze(
    Object.fromEntries(Object.entries(raw).filter(([key]) => !known.has(key))),
  );
}

function normalizePermissionSide(value: unknown) {
  if (!isRecord(value)) return { users: [], groups: [] };
  return {
    users: idList(value.users),
    groups: idList(value.groups),
  };
}

export function normalizePermissionSet(value: unknown): PaperlessPermissionSet {
  const record = isRecord(value) ? value : {};
  return {
    view: normalizePermissionSide(record.view),
    change: normalizePermissionSide(record.change),
  };
}

function canonicalPermissionSet(value: unknown): PaperlessPermissionSet {
  const permissions = normalizePermissionSet(value);
  return {
    view: {
      users: canonicalIds(permissions.view.users),
      groups: canonicalIds(permissions.view.groups),
    },
    change: {
      users: canonicalIds(permissions.change.users),
      groups: canonicalIds(permissions.change.groups),
    },
  };
}

function permissionSetsEqual(left: PaperlessPermissionSet, right: PaperlessPermissionSet) {
  return JSON.stringify(canonicalPermissionSet(left)) === JSON.stringify(canonicalPermissionSet(right));
}

function parseOwnedObject(raw: Record<string, unknown>): PaperlessOwnedObject {
  return {
    ownerId: isPositiveInteger(raw.owner) ? raw.owner : null,
    permissions: isRecord(raw.permissions) ? normalizePermissionSet(raw.permissions) : null,
    userCanChange: typeof raw.user_can_change === 'boolean' ? raw.user_can_change : null,
  };
}

function parseCatalogBase(raw: Record<string, unknown>) {
  if (!isPositiveInteger(raw.id) || typeof raw.name !== 'string') {
    throw new PaperlessClientError('Paperless returned an invalid catalog object.', {
      code: 'invalid-response',
      responseBody: raw,
    });
  }
  return {
    id: raw.id,
    slug: optionalString(raw.slug),
    name: raw.name,
    match: typeof raw.match === 'string' ? raw.match : '',
    matchingAlgorithm:
      typeof raw.matching_algorithm === 'string' || typeof raw.matching_algorithm === 'number'
        ? raw.matching_algorithm
        : null,
    isInsensitive: raw.is_insensitive === true,
    documentCount: optionalNumber(raw.document_count),
    ...parseOwnedObject(raw),
  };
}

const CATALOG_BASE_FIELDS = [
  'id',
  'slug',
  'name',
  'match',
  'matching_algorithm',
  'is_insensitive',
  'document_count',
  'owner',
  'permissions',
  'user_can_change',
  'set_permissions',
] as const;

function parsePaperlessTagNode(
  value: unknown,
  depth: number,
  budget: { remaining: number },
): PaperlessTag {
  if (depth > 64 || budget.remaining <= 0) {
    throw new PaperlessClientError('Paperless returned a tag hierarchy that is too large or deeply nested.', {
      code: 'invalid-response',
    });
  }
  budget.remaining -= 1;
  if (!isRecord(value)) {
    throw new PaperlessClientError('Paperless returned an invalid tag.', {
      code: 'invalid-response',
      responseBody: value,
    });
  }
  const children = Array.isArray(value.children)
    ? value.children.slice(0, 4_096).map((child) => parsePaperlessTagNode(child, depth + 1, budget))
    : [];
  return {
    kind: 'tag',
    ...parseCatalogBase(value),
    color: optionalString(value.color),
    textColor: optionalString(value.text_color),
    isInboxTag: value.is_inbox_tag === true,
    parentId: isPositiveInteger(value.parent) ? value.parent : null,
    children,
    extra: extraFields(value, [
      ...CATALOG_BASE_FIELDS,
      'color',
      'text_color',
      'is_inbox_tag',
      'parent',
      'children',
    ]),
  };
}

export function parsePaperlessTag(value: unknown): PaperlessTag {
  return parsePaperlessTagNode(value, 0, { remaining: 4_096 });
}

/**
 * Paperless 3 serializes recursive tag children independently from the
 * permission-filtered collection queryset. Treat only collection result IDs
 * as authorization evidence and remove nested objects that were not returned
 * as their own visible result. This also prevents a visible child from
 * exposing an invisible parent's identity through hierarchy/search state.
 */
export function restrictTagHierarchyToVisibleResults(tags: PaperlessTag[]): PaperlessTag[] {
  const visibleIds = new Set(tags.map((tag) => tag.id));
  const prune = (tag: PaperlessTag): PaperlessTag => ({
    ...tag,
    parentId: tag.parentId !== null && visibleIds.has(tag.parentId) ? tag.parentId : null,
    children: tag.children
      .filter((child) => visibleIds.has(child.id))
      .map(prune),
  });
  return tags.map(prune);
}

export function parsePaperlessCatalogObject<R extends PaperlessCatalogResource>(
  resource: R,
  value: unknown,
): PaperlessCatalogObjectByResource[R] {
  if (resource === 'tags') return parsePaperlessTag(value) as PaperlessCatalogObjectByResource[R];
  if (!isRecord(value)) {
    throw new PaperlessClientError('Paperless returned an invalid catalog object.', {
      code: 'invalid-response',
      responseBody: value,
    });
  }
  const base = parseCatalogBase(value);
  if (resource === 'correspondents') {
    return {
      kind: 'correspondent',
      ...base,
      lastCorrespondence: optionalString(value.last_correspondence),
      extra: extraFields(value, [...CATALOG_BASE_FIELDS, 'last_correspondence']),
    } as PaperlessCatalogObjectByResource[R];
  }
  if (resource === 'documentTypes') {
    return {
      kind: 'documentType',
      ...base,
      extra: extraFields(value, CATALOG_BASE_FIELDS),
    } as PaperlessCatalogObjectByResource[R];
  }
  return {
    kind: 'storagePath',
    ...base,
    path: typeof value.path === 'string' ? value.path : '',
    extra: extraFields(value, [...CATALOG_BASE_FIELDS, 'path']),
  } as PaperlessCatalogObjectByResource[R];
}

function normalizeName(value: string) {
  const name = value.trim();
  if (!name) {
    throw new PaperlessClientError('Name cannot be empty.', { code: 'invalid-input' });
  }
  return name;
}

function serializeCatalogEdit<R extends PaperlessCatalogResource>(
  resource: R,
  edit: PaperlessCatalogEditByResource[R],
) {
  const source = edit as Record<string, unknown>;
  const payload: Record<string, unknown> = {};
  if (typeof source.name === 'string') payload.name = normalizeName(source.name);
  if (typeof source.match === 'string') payload.match = source.match;
  if (source.matchingAlgorithm !== undefined) payload.matching_algorithm = source.matchingAlgorithm;
  if (typeof source.isInsensitive === 'boolean') payload.is_insensitive = source.isInsensitive;
  if (resource === 'tags') {
    if (source.color !== undefined) {
      if (typeof source.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(source.color)) {
        throw new PaperlessClientError('Tag colors must use #RRGGBB format.', {
          code: 'invalid-input',
        });
      }
      payload.color = source.color;
    }
    if (typeof source.isInboxTag === 'boolean') payload.is_inbox_tag = source.isInboxTag;
    if (source.parentId === null || isPositiveInteger(source.parentId)) payload.parent = source.parentId;
  }
  if (resource === 'storagePaths' && typeof source.path === 'string') payload.path = source.path;
  if (Object.keys(payload).length === 0) {
    throw new PaperlessClientError('No catalog changes were supplied.', { code: 'invalid-input' });
  }
  return payload;
}

function parsePage<T>(value: unknown, parser: (entry: unknown) => T): PaperlessPage<T> {
  if (Array.isArray(value)) {
    return { count: value.length, next: null, previous: null, results: value.map(parser) };
  }
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new PaperlessClientError('Paperless returned an invalid paginated response.', {
      code: 'invalid-response',
      responseBody: value,
    });
  }
  return {
    count: typeof value.count === 'number' ? value.count : value.results.length,
    next: optionalString(value.next),
    previous: optionalString(value.previous),
    results: value.results.map(parser),
  };
}

function nextPagePath(next: string, currentPath: string, collectionPath: string) {
  let target: URL;
  try {
    target = new URL(next, `https://paperless.invalid${currentPath}`);
  } catch {
    throw new PaperlessClientError('Paperless returned an invalid pagination address.', {
      code: 'invalid-response',
      responseBody: next,
    });
  }
  if (target.username || target.password) {
    throw new PaperlessClientError('Paperless returned an unsafe pagination address.', {
      code: 'unsafe-request-path',
      responseBody: next,
    });
  }
  // Reverse proxies may serialize an internal hostname or deployment prefix.
  // Discard both and retain only the configured API collection path.
  const apiIndex = target.pathname.indexOf('/api/');
  const path = apiIndex >= 0 ? target.pathname.slice(apiIndex) : target.pathname;
  if (path !== collectionPath) {
    throw new PaperlessClientError('Paperless pagination left the requested collection.', {
      code: 'unsafe-request-path',
      responseBody: next,
    });
  }
  return `${path}${target.search}`;
}

async function readAllPages<T>(
  client: PaperlessClient,
  initialPath: string,
  collectionPath: string,
  parser: (entry: unknown) => T,
  signal?: AbortSignal,
) {
  const results: T[] = [];
  const visited = new Set<string>();
  let path: string | null = initialPath;
  let pageCount = 0;
  while (path) {
    if (visited.has(path) || pageCount >= 100) {
      throw new PaperlessClientError('Paperless returned an unsafe pagination loop.', {
        code: 'invalid-response',
      });
    }
    visited.add(path);
    const response: { data: unknown } = await client.get<unknown>(path, signal);
    const page: PaperlessPage<T> = parsePage(response.data, parser);
    results.push(...page.results);
    pageCount += 1;
    path = page.next ? nextPagePath(page.next, path, collectionPath) : null;
  }
  return { count: results.length, next: null, previous: null, results } satisfies PaperlessPage<T>;
}

export function parsePaperlessSavedViewRule(value: unknown): PaperlessSavedViewRule {
  if (!isRecord(value) || !Number.isInteger(value.rule_type) || Number(value.rule_type) < 0) {
    throw new PaperlessClientError('Paperless returned an invalid saved-view rule.', {
      code: 'invalid-response',
      responseBody: value,
    });
  }
  const ruleType = Number(value.rule_type);
  return {
    ruleType,
    value: value.value === null || typeof value.value === 'string' ? value.value : String(value.value),
    known: isFolioEditableSavedViewRule(
      ruleType,
      value.value === null || typeof value.value === 'string' ? value.value : String(value.value),
    ),
    extra: extraFields(value, ['rule_type', 'value']),
  };
}

export function parsePaperlessSavedView(value: unknown): PaperlessSavedView {
  if (!isRecord(value) || !isPositiveInteger(value.id) || typeof value.name !== 'string') {
    throw new PaperlessClientError('Paperless returned an invalid saved view.', {
      code: 'invalid-response',
      responseBody: value,
    });
  }
  const filterRules = Array.isArray(value.filter_rules)
    ? value.filter_rules.map(parsePaperlessSavedViewRule)
    : [];
  return {
    id: value.id,
    name: value.name,
    sortField: optionalString(value.sort_field),
    sortReverse: value.sort_reverse === true,
    filterRules,
    pageSize: optionalNumber(value.page_size),
    displayMode: optionalString(value.display_mode),
    displayFields: Array.isArray(value.display_fields)
      ? value.display_fields.filter(
          (entry): entry is string | number => typeof entry === 'string' || typeof entry === 'number',
        )
      : null,
    showOnDashboard: typeof value.show_on_dashboard === 'boolean' ? value.show_on_dashboard : null,
    showInSidebar: typeof value.show_in_sidebar === 'boolean' ? value.show_in_sidebar : null,
    ...parseOwnedObject(value),
    extra: extraFields(value, [
      'id',
      'name',
      'sort_field',
      'sort_reverse',
      'filter_rules',
      'page_size',
      'display_mode',
      'display_fields',
      'owner',
      'permissions',
      'user_can_change',
      'set_permissions',
    ]),
  };
}

function serializeSavedViewRule(rule: PaperlessSavedViewRule) {
  return { ...rule.extra, rule_type: rule.ruleType, value: rule.value };
}

function ruleIdentity(rule: PaperlessSavedViewRule) {
  return JSON.stringify(serializeSavedViewRule(rule));
}

function isOpaqueSavedViewRule(rule: PaperlessSavedViewRule) {
  return !rule.known || Object.keys(rule.extra).length > 0;
}

export function buildSavedViewUpdate(
  current: PaperlessSavedView,
  edit: PaperlessSavedViewEdit,
  unknownRulePolicy: PaperlessUnknownRulePolicy = 'preserve',
): PaperlessCapabilityResult<Record<string, unknown>> {
  const payload: Record<string, unknown> = {};
  if (edit.name !== undefined) payload.name = normalizeName(edit.name);
  if (edit.sortField !== undefined) payload.sort_field = edit.sortField;
  if (edit.sortReverse !== undefined) payload.sort_reverse = edit.sortReverse;
  if (edit.pageSize !== undefined) payload.page_size = edit.pageSize;
  if (edit.displayMode !== undefined) payload.display_mode = edit.displayMode;
  if (edit.displayFields !== undefined) payload.display_fields = edit.displayFields;
  if (edit.showOnDashboard !== undefined) payload.show_on_dashboard = edit.showOnDashboard;
  if (edit.showInSidebar !== undefined) payload.show_in_sidebar = edit.showInSidebar;

  if (edit.filterRules !== undefined) {
    const unknown = current.filterRules.filter(isOpaqueSavedViewRule);
    if (unknown.length > 0 && unknownRulePolicy === 'block') {
      return {
        supported: false,
        reason: 'unknown-rules',
        detail: 'This view contains rules the client cannot edit safely.',
      };
    }
    const next = [...edit.filterRules];
    const identities = new Set(next.map(ruleIdentity));
    for (const rule of unknown) {
      if (!identities.has(ruleIdentity(rule))) next.push(rule);
    }
    payload.filter_rules = next.map(serializeSavedViewRule);
  }

  if (Object.keys(payload).length === 0) {
    return { supported: false, reason: 'invalid-input', detail: 'No saved-view changes supplied.' };
  }
  return { supported: true, value: payload };
}

function savedViewCreatePayload(edit: PaperlessSavedViewEdit & { name: string }) {
  const payload: Record<string, unknown> = {
    ...(edit.extra ?? {}),
    name: normalizeName(edit.name),
    filter_rules: (edit.filterRules ?? []).map(serializeSavedViewRule),
  };
  if (edit.sortField !== undefined) payload.sort_field = edit.sortField;
  if (edit.sortReverse !== undefined) payload.sort_reverse = edit.sortReverse;
  if (edit.pageSize !== undefined) payload.page_size = edit.pageSize;
  if (edit.displayMode !== undefined) payload.display_mode = edit.displayMode;
  if (edit.displayFields !== undefined) payload.display_fields = edit.displayFields;
  if (edit.showOnDashboard !== undefined) payload.show_on_dashboard = edit.showOnDashboard;
  if (edit.showInSidebar !== undefined) payload.show_in_sidebar = edit.showInSidebar;
  return payload;
}

function capability<T>(status: PaperlessCapabilityStatus, value: T): PaperlessCapabilityResult<T> {
  if (status.supported) return { supported: true, value };
  return { supported: false, reason: status.reason, detail: status.detail };
}

function skippedCandidate(
  candidate: PaperlessBulkCandidate,
  reason: PaperlessBulkSkippedItem['reason'],
): PaperlessBulkSkippedItem {
  return {
    localId: candidate.localId,
    remoteId: isPositiveInteger(candidate.remoteId) ? candidate.remoteId : null,
    reason,
  };
}

export function selectBulkEligible(candidates: PaperlessBulkCandidate[]) {
  const eligible: (PaperlessBulkCandidate & { remoteId: number })[] = [];
  const skipped: PaperlessBulkSkippedItem[] = [];
  const seen = new Set<number>();
  for (const candidate of candidates) {
    if (!isPositiveInteger(candidate.remoteId)) {
      skipped.push(skippedCandidate(candidate, 'not-remote'));
    } else if (!candidate.ready) {
      skipped.push(skippedCandidate(candidate, 'processing'));
    } else if (candidate.canEdit === false) {
      skipped.push(skippedCandidate(candidate, 'read-only'));
    } else if (seen.has(candidate.remoteId)) {
      skipped.push(skippedCandidate(candidate, 'duplicate-selection'));
    } else {
      seen.add(candidate.remoteId);
      eligible.push({ ...candidate, remoteId: candidate.remoteId });
    }
  }
  return { eligible, skipped };
}

function uniquePositiveIds(ids: number[], label: string) {
  if (!ids.every(isPositiveInteger)) {
    throw new PaperlessClientError(`${label} must contain positive integer IDs.`, {
      code: 'invalid-input',
    });
  }
  return [...new Set(ids)];
}

function failureFromError(
  error: unknown,
  candidate?: PaperlessBulkCandidate & { remoteId: number },
): PaperlessOperationFailure {
  if (error instanceof PaperlessClientError) {
    return {
      ...(candidate ? { localId: candidate.localId, remoteId: candidate.remoteId } : {}),
      status: error.status,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    ...(candidate ? { localId: candidate.localId, remoteId: candidate.remoteId } : {}),
    status: null,
    code: 'unknown-error',
    message: error instanceof Error ? error.message : 'Unknown Paperless error.',
    retryable: false,
  };
}

function looksLikeTaskId(value: string) {
  return /^[a-f0-9]{8}-[a-f0-9-]{20,}$/i.test(value) || /^task[-_:][a-z0-9._:-]+$/i.test(value);
}

export function extractTaskIds(body: unknown, headers?: Headers | Readonly<Record<string, string | undefined>>) {
  const result = new Set<string>();
  const add = (value: unknown, named = false) => {
    if (typeof value !== 'string') return;
    const normalized = value.trim();
    if (normalized && (named || looksLikeTaskId(normalized))) result.add(normalized);
  };
  if (typeof body === 'string') add(body);
  if (isRecord(body)) {
    add(body.task_id, true);
    if (Array.isArray(body.task_ids)) body.task_ids.forEach((entry) => add(entry, true));
    if (isRecord(body.result)) {
      add(body.result.task_id, true);
      if (Array.isArray(body.result.task_ids)) body.result.task_ids.forEach((entry) => add(entry, true));
    } else {
      add(body.result);
    }
  }
  const response = { headers };
  add(getPaperlessHeader(response, 'X-Task-Id'), true);
  const many = getPaperlessHeader(response, 'X-Task-Ids');
  if (many) many.split(',').forEach((entry) => add(entry, true));
  return [...result];
}

async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
) {
  const limit = Math.max(1, Math.min(8, Math.floor(concurrency)));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        await worker(values[index]);
      }
    }),
  );
}

function asyncResult(body: unknown, headers?: Headers | Readonly<Record<string, string | undefined>>): PaperlessAsyncOperationResult {
  const taskIds = extractTaskIds(body, headers);
  return {
    accepted: true,
    taskIds,
    taskCorrelation: taskIds.length > 0 ? 'response' : 'unavailable',
    response: body,
  };
}

export function serializeShareLinkExpiry(expiry: PaperlessShareLinkExpiry, now = new Date()) {
  if (expiry.kind === 'never') return null;
  if (expiry.kind === 'days') {
    const date = new Date(now.getTime() + expiry.days * 24 * 60 * 60 * 1000);
    return date.toISOString();
  }
  const date = expiry.at instanceof Date ? new Date(expiry.at) : new Date(expiry.at);
  if (Number.isNaN(date.getTime()) || date.getTime() <= now.getTime()) {
    throw new PaperlessClientError('Share-link expiration must be a valid future date.', {
      code: 'invalid-input',
    });
  }
  return date.toISOString();
}

function parseRepresentation(
  representation: PaperlessRepresentation,
  metadata: Record<string, unknown>,
): PaperlessRepresentationInfo {
  if (representation === 'original') {
    // Paperless always has an original file, but legacy documents may have a
    // null original_filename. Require metadata evidence instead of treating a
    // nullable display filename as the representation's availability flag.
    const available =
      typeof metadata.original_filename === 'string' ||
      typeof metadata.original_mime_type === 'string' ||
      typeof metadata.original_checksum === 'string' ||
      (typeof metadata.original_size === 'number' &&
        Number.isFinite(metadata.original_size) &&
        metadata.original_size >= 0);
    return {
      representation,
      available,
      filename: optionalString(metadata.original_filename),
      mimeType: optionalString(metadata.original_mime_type),
      size: optionalNumber(metadata.original_size),
      checksum: optionalString(metadata.original_checksum),
    };
  }
  const available = metadata.has_archive_version === true;
  return {
    representation,
    available,
    filename: available ? optionalString(metadata.archive_media_filename) : null,
    mimeType: available ? 'application/pdf' : null,
    size: available ? optionalNumber(metadata.archive_size) : null,
    checksum: available ? optionalString(metadata.archive_checksum) : null,
  };
}

export function parseDocumentRepresentations(
  documentId: number,
  value: unknown,
): PaperlessDocumentRepresentations {
  assertPositiveId(documentId, 'Document ID');
  if (!isRecord(value)) {
    throw new PaperlessClientError('Paperless returned invalid document metadata.', {
      code: 'invalid-response',
      responseBody: value,
    });
  }
  return {
    documentId,
    original: parseRepresentation('original', value),
    archive: parseRepresentation('archive', value),
  };
}

function parseShareLink(value: unknown, now = new Date()): PaperlessShareLink {
  if (
    !isRecord(value) ||
    !isPositiveInteger(value.id) ||
    typeof value.slug !== 'string' ||
    !OPAQUE_SHARE_LINK_SLUG.test(value.slug) ||
    !isPositiveInteger(value.document) ||
    (value.file_version !== 'original' && value.file_version !== 'archive') ||
    typeof value.created !== 'string' ||
    !Number.isFinite(Date.parse(value.created)) ||
    (value.expiration !== null &&
      (typeof value.expiration !== 'string' || !Number.isFinite(Date.parse(value.expiration))))
  ) {
    throw new PaperlessClientError('Paperless returned an invalid share link.', {
      code: 'invalid-response',
      responseBody: value,
    });
  }
  const expiration = value.expiration;
  return {
    id: value.id,
    created: value.created,
    expiration,
    slug: value.slug,
    documentId: value.document,
    fileVersion: value.file_version,
    expired: expiration !== null && new Date(expiration).getTime() <= now.getTime(),
    extra: extraFields(value, ['id', 'created', 'expiration', 'slug', 'document', 'file_version']),
  };
}

function mergeIds(left: number[], right: number[]) {
  return [...new Set([...left, ...right])];
}

export function mergePermissionSets(
  current: PaperlessPermissionSet,
  addition: PaperlessPermissionSet,
): PaperlessPermissionSet {
  return {
    view: {
      users: mergeIds(current.view.users, addition.view.users),
      groups: mergeIds(current.view.groups, addition.view.groups),
    },
    change: {
      users: mergeIds(current.change.users, addition.change.users),
      groups: mergeIds(current.change.groups, addition.change.groups),
    },
  };
}

export function planPermissionMutation(
  current: PaperlessOwnedObject,
  mutation: PaperlessPermissionMutation,
  context: {
    currentUserId: number | null;
    isSuperuser: boolean;
    currentUserGroupIds?: number[];
  },
): PaperlessCapabilityResult<{ owner: number | null; set_permissions: PaperlessPermissionSet }> {
  if (!current.permissions && mutation.mode === 'merge') {
    return {
      supported: false,
      reason: 'invalid-input',
      detail: 'Merge requires a full current permission read.',
    };
  }
  const owner = mutation.ownerId === undefined ? current.ownerId : mutation.ownerId;
  const permissions =
    mutation.mode === 'merge'
      ? mergePermissionSets(current.permissions!, mutation.permissions)
      : normalizePermissionSet(mutation.permissions);
  const userId = context.currentUserId;
  const groupIds = new Set(context.currentUserGroupIds?.filter(isPositiveInteger) ?? []);
  const hasDirectAccess = userId !== null && (
    permissions.view.users.includes(userId) || permissions.change.users.includes(userId)
  );
  const hasGroupAccess = permissions.view.groups.some((groupId) => groupIds.has(groupId))
    || permissions.change.groups.some((groupId) => groupIds.has(groupId));
  const retainsAccess =
    context.isSuperuser ||
    owner === null ||
    (userId !== null && owner === userId) ||
    hasDirectAccess ||
    hasGroupAccess;
  if (!retainsAccess && !mutation.confirmSelfLockout) {
    return {
      supported: false,
      reason: 'self-lockout',
      detail: 'This permission update may remove the current user’s object-level access.',
    };
  }
  return { supported: true, value: { owner, set_permissions: permissions } };
}

function permissionIdentityFromUiSettings(value: unknown) {
  if (!isRecord(value) || !isRecord(value.user)) return null;
  const user = value.user;
  if (!isPositiveInteger(user.id)) return null;
  return {
    currentUserId: user.id,
    isSuperuser: user.is_superuser === true,
    currentUserGroupIds: idList(user.groups),
  };
}

function safeDuplicateTitle(value: unknown) {
  if (typeof value !== 'string') return 'Untitled document';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 512) || 'Untitled document';
}

export function extractDuplicateSummaries(
  document: unknown,
  task?: unknown,
): PaperlessDuplicateSummary[] {
  const duplicates = new Map<number, PaperlessDuplicateSummary>();
  if (isRecord(document) && Array.isArray(document.duplicate_documents)) {
    for (const value of document.duplicate_documents) {
      if (!isRecord(value) || !isPositiveInteger(value.id)) continue;
      duplicates.set(value.id, {
        id: value.id,
        title: safeDuplicateTitle(value.title),
        deletedAt: optionalString(value.deleted_at),
        source: 'document',
      });
    }
  }
  if (isRecord(task)) {
    const result = isRecord(task.result_data) ? task.result_data : {};
    const duplicateId = isPositiveInteger(result.duplicate_of) ? result.duplicate_of : null;
    if (duplicateId && !duplicates.has(duplicateId)) {
      duplicates.set(duplicateId, {
        id: duplicateId,
        title: 'Existing document',
        deletedAt: null,
        source: 'task',
      });
    }
  }
  return [...duplicates.values()];
}

function safeSuggestionText(
  value: unknown,
  path: string,
  maxLength: number,
  warnings: PaperlessValidationError[],
) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    warnings.push({ path, code: 'control-characters', message: 'Suggestion contains control characters.' });
    return null;
  }
  if (text.length > maxLength) {
    warnings.push({ path, code: 'too-long', message: `Suggestion exceeds ${maxLength} characters.` });
    return null;
  }
  return text;
}

function safeSuggestionNames(
  value: unknown,
  path: string,
  warnings: PaperlessValidationError[],
) {
  if (!Array.isArray(value)) return [];
  if (value.length > 100) warnings.push({ path, code: 'too-many-values', message: 'Suggestion list was truncated.' });
  return value
    .slice(0, 100)
    .map((entry, index) => safeSuggestionText(entry, `${path}[${index}]`, 128, warnings))
    .filter((entry): entry is string => entry !== null);
}

const MAX_AI_SUGGESTION_VALUES = 100;

function safeSuggestionIds(
  value: unknown,
  path: string,
  warnings: PaperlessValidationError[],
) {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_AI_SUGGESTION_VALUES) {
    warnings.push({ path, code: 'too-many-values', message: 'Suggestion ID list was truncated.' });
  }
  return idList(value.slice(0, MAX_AI_SUGGESTION_VALUES));
}

function validIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function safeJsonValue(
  value: unknown,
  path: string,
  warnings: PaperlessValidationError[],
  depth = 0,
): unknown {
  if (depth > 4) {
    warnings.push({ path, code: 'too-deep', message: 'Custom-field suggestion is too deeply nested.' });
    return undefined;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return safeSuggestionText(value, path, 1000, warnings) ?? undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, 100)
      .map((entry, index) => safeJsonValue(entry, `${path}[${index}]`, warnings, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (!isRecord(value)) return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      warnings.push({ path: `${path}.${key}`, code: 'unsafe-key', message: 'Unsafe object key rejected.' });
      continue;
    }
    const safe = safeJsonValue(entry, `${path}.${key}`, warnings, depth + 1);
    if (safe !== undefined) output[key] = safe;
  }
  return output;
}

export function validateAiSuggestions(value: unknown): PaperlessValidationResult<PaperlessAiSuggestions> {
  if (!isRecord(value)) {
    return {
      valid: false,
      errors: [{ path: '$', code: 'invalid-payload', message: 'AI suggestion payload must be an object.' }],
    };
  }
  const warnings: PaperlessValidationError[] = [];
  const dateValues = safeSuggestionNames(value.dates, 'dates', warnings).filter((date) => {
    if (validIsoDate(date)) return true;
    warnings.push({ path: 'dates', code: 'invalid-date', message: `Rejected invalid date ${date}.` });
    return false;
  });
  const custom = safeJsonValue(value.custom_fields ?? {}, 'custom_fields', warnings);
  return {
    valid: true,
    warnings,
    value: {
      title: safeSuggestionText(value.title, 'title', 128, warnings),
      correspondentIds: safeSuggestionIds(value.correspondents, 'correspondents', warnings),
      proposedCorrespondents: safeSuggestionNames(value.suggested_correspondents, 'suggested_correspondents', warnings),
      tagIds: safeSuggestionIds(value.tags, 'tags', warnings),
      proposedTags: safeSuggestionNames(value.suggested_tags, 'suggested_tags', warnings),
      documentTypeIds: safeSuggestionIds(value.document_types, 'document_types', warnings),
      proposedDocumentTypes: safeSuggestionNames(value.suggested_document_types, 'suggested_document_types', warnings),
      storagePathIds: safeSuggestionIds(value.storage_paths, 'storage_paths', warnings),
      proposedStoragePaths: safeSuggestionNames(value.suggested_storage_paths, 'suggested_storage_paths', warnings),
      dates: dateValues,
      customFields: isRecord(custom) ? Object.freeze(custom) : Object.freeze({}),
    },
  };
}

export function isChangeAuthorizedPdfMergeDocument(document: {
  remoteId?: number;
  source: string;
  status: string;
  mimeType?: string;
  canEdit?: boolean;
}) {
  return isPositiveInteger(document.remoteId)
    && document.source === 'remote'
    && document.status !== 'processing'
    && document.canEdit === true
    && document.mimeType?.split(';', 1)[0].trim().toLocaleLowerCase() === 'application/pdf';
}

export function selectChangeAuthorizedPdfMergeIds(
  documents: readonly {
    remoteId?: number;
    source: string;
    status: string;
    mimeType?: string;
    canEdit?: boolean;
  }[],
  requestedIds: readonly number[],
) {
  const authorized = new Set(
    documents.flatMap((document) => (
      isChangeAuthorizedPdfMergeDocument(document) ? [document.remoteId!] : []
    )),
  );
  return requestedIds.filter((id, index) => (
    isPositiveInteger(id) && requestedIds.indexOf(id) === index && authorized.has(id)
  ));
}

export function normalizeNestedTags(
  tags: PaperlessTag[],
  maxDepth = 64,
): PaperlessValidationResult<PaperlessTagHierarchy> {
  const safeMaxDepth = Math.max(1, Math.min(256, Math.floor(maxDepth)));
  const errors: PaperlessValidationError[] = [];
  const records = new Map<number, Omit<PaperlessTag, 'children'> & { structuralParent: number | null }>();
  let visitedNodes = 0;

  const collect = (tag: PaperlessTag, structuralParent: number | null, trail: number[]) => {
    visitedNodes += 1;
    if (visitedNodes > 4_096) {
      errors.push({ path: 'tags', code: 'too-deep', message: 'The tag hierarchy exceeds the safe node limit.' });
      return;
    }
    if (trail.length + 1 > safeMaxDepth) {
      errors.push({ path: `tag.${tag.id}`, code: 'too-deep', message: `Tag depth exceeds ${safeMaxDepth}.` });
      return;
    }
    if (!isPositiveInteger(tag.id)) {
      errors.push({ path: trail.join('.'), code: 'invalid-id', message: 'Tag ID must be positive.' });
      return;
    }
    const explicitParent = tag.parentId;
    if (structuralParent !== null && explicitParent !== null && structuralParent !== explicitParent) {
      errors.push({
        path: `tag.${tag.id}.parent`,
        code: 'parent-conflict',
        message: 'Nested and explicit parent references disagree.',
      });
    }
    const parent = explicitParent ?? structuralParent;
    const existing = records.get(tag.id);
    if (existing && (existing.name !== tag.name || existing.parentId !== parent)) {
      errors.push({ path: `tag.${tag.id}`, code: 'duplicate-conflict', message: 'Duplicate tag definitions disagree.' });
    } else if (!existing) {
      const { children: _children, ...withoutChildren } = tag;
      records.set(tag.id, { ...withoutChildren, parentId: parent, structuralParent });
    }
    if (trail.includes(tag.id)) {
      errors.push({ path: `tag.${tag.id}`, code: 'cycle', message: 'Nested tag cycle detected.' });
      return;
    }
    for (const child of tag.children) collect(child, tag.id, [...trail, tag.id]);
  };
  tags.forEach((tag) => collect(tag, null, []));

  for (const tag of records.values()) {
    if (tag.parentId !== null && !records.has(tag.parentId)) {
      errors.push({
        path: `tag.${tag.id}.parent`,
        code: 'missing-parent',
        message: `Parent tag ${tag.parentId} is not visible in this response.`,
      });
    }
  }

  const state = new Map<number, 'visiting' | 'visited'>();
  const visit = (startId: number) => {
    if (state.get(startId) === 'visited') return;
    const chain: number[] = [];
    let id: number | null = startId;
    while (id !== null && records.has(id)) {
      if (state.get(id) === 'visiting') {
        errors.push({ path: `tag.${id}`, code: 'cycle', message: 'Tag parent cycle detected.' });
        break;
      }
      if (state.get(id) === 'visited') break;
      if (chain.length >= safeMaxDepth) {
        errors.push({ path: `tag.${id}`, code: 'too-deep', message: `Tag depth exceeds ${safeMaxDepth}.` });
        break;
      }
      state.set(id, 'visiting');
      chain.push(id);
      id = records.get(id)?.parentId ?? null;
    }
    chain.forEach((entry) => state.set(entry, 'visited'));
  };
  records.forEach((_tag, id) => visit(id));
  if (errors.length > 0) return { valid: false, errors };

  const childMap = new Map<number, number[]>();
  const roots: number[] = [];
  for (const tag of records.values()) {
    if (tag.parentId === null) roots.push(tag.id);
    else childMap.set(tag.parentId, [...(childMap.get(tag.parentId) ?? []), tag.id]);
  }

  const normalized = new Map<number, PaperlessNormalizedTag>();
  const build = (id: number, parentPath: string[]) => {
    const tag = records.get(id)!;
    const path = [...parentPath, tag.name];
    if (path.length > safeMaxDepth) {
      errors.push({ path: `tag.${id}`, code: 'too-deep', message: `Tag depth exceeds ${safeMaxDepth}.` });
      return;
    }
    const { structuralParent: _structuralParent, ...cleanTag } = tag;
    const childIds = [...(childMap.get(id) ?? [])];
    normalized.set(id, {
      ...cleanTag,
      childIds,
      path,
      pathLabel: path.join(' / '),
      depth: path.length - 1,
    });
    childIds.forEach((childId) => build(childId, path));
  };
  roots.forEach((id) => build(id, []));
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, value: { roots, byId: normalized }, warnings: [] };
}

export function selectVisibleNestedTags(
  hierarchy: PaperlessTagHierarchy,
  query: string,
  expandedIds: ReadonlySet<number>,
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery) {
    return [...hierarchy.byId.values()]
      .filter((tag) => tag.name.toLocaleLowerCase().includes(normalizedQuery)
        || tag.pathLabel.toLocaleLowerCase().includes(normalizedQuery))
      .sort((left, right) => left.pathLabel.localeCompare(right.pathLabel));
  }
  const rows: PaperlessNormalizedTag[] = [];
  const visit = (id: number) => {
    const tag = hierarchy.byId.get(id);
    if (!tag) return;
    rows.push(tag);
    if (expandedIds.has(id)) tag.childIds.forEach(visit);
  };
  hierarchy.roots.forEach(visit);
  return rows;
}

export function parsePaperlessTaskV10(value: unknown): PaperlessTaskV10 {
  if (!isRecord(value) || !isPositiveInteger(value.id) || typeof value.task_id !== 'string') {
    throw new PaperlessClientError('Paperless returned an invalid API v10 task.', {
      code: 'invalid-response',
      responseBody: value,
    });
  }
  return {
    id: value.id,
    taskId: value.task_id,
    taskType: typeof value.task_type === 'string' ? value.task_type : '',
    triggerSource: typeof value.trigger_source === 'string' ? value.trigger_source : '',
    status: typeof value.status === 'string' ? value.status : 'pending',
    dateCreated: optionalString(value.date_created),
    inputData: Object.freeze(isRecord(value.input_data) ? { ...value.input_data } : {}),
    resultData: Object.freeze(isRecord(value.result_data) ? { ...value.result_data } : {}),
    relatedDocumentIds: idList(value.related_document_ids),
    acknowledged: value.acknowledged === true,
    ownerId: isPositiveInteger(value.owner) ? value.owner : null,
  };
}

export type PaperlessAdvancedApiOptions = {
  /** Called when an advertised capability no longer matches the live server. */
  onCapabilityMismatch?: (error: PaperlessClientError) => void;
  taskCorrelationAttempts?: number;
  taskCorrelationDelayMs?: number;
};

export function isCapabilityMismatchError(error: unknown): error is PaperlessClientError {
  if (!(error instanceof PaperlessClientError)) return false;
  if (error.code === 'invalid-response') return true;
  if (error.status !== null && [401, 403, 404, 405, 406, 415].includes(error.status)) return true;
  if (error.status !== 400 && error.status !== 422) return false;
  return /api.?version|schema|unknown (?:field|parameter)|unexpected (?:field|parameter)|not supported/i
    .test(error.message);
}

type PdfTaskCorrelationPlan = {
  expectedFilenames: string[];
};

const DEFAULT_PDF_TASK_CORRELATION_ATTEMPTS = 4;
const DEFAULT_PDF_TASK_CORRELATION_DELAY_MS = 250;
const MAX_PDF_TASK_CORRELATION_ATTEMPTS = 10;
const MAX_PDF_TASK_CORRELATION_DELAY_MS = 2_000;

function pdfTaskFilename(task: PaperlessTaskV10) {
  const filename = task.inputData.filename;
  return typeof filename === 'string' ? filename : null;
}

function correlatePdfTasks(
  baselineTaskIds: ReadonlySet<string>,
  tasks: readonly PaperlessTaskV10[],
  expectedFilenames: readonly string[],
) {
  const candidates = tasks.filter((task) => (
    !baselineTaskIds.has(task.taskId)
    && task.taskType === 'consume_file'
    && task.triggerSource === 'api_upload'
  ));
  const taskIds: string[] = [];
  for (const expectedFilename of expectedFilenames) {
    const matches = candidates.filter((task) => pdfTaskFilename(task) === expectedFilename);
    // A filename alone is not an identity. Only a one-to-one post-snapshot
    // delta is safe enough to bind to a destructive operation.
    if (matches.length !== 1) return [];
    taskIds.push(matches[0].taskId);
  }
  return new Set(taskIds).size === expectedFilenames.length ? taskIds : [];
}

export class PaperlessAdvancedApi {
  readonly client: PaperlessClient;
  readonly capabilities: PaperlessCapabilities;
  private readonly options: PaperlessAdvancedApiOptions;
  private pdfOperationTail: Promise<void> = Promise.resolve();

  constructor(
    client: PaperlessClient,
    capabilities: PaperlessCapabilities,
    options: PaperlessAdvancedApiOptions = {},
  ) {
    if (client.profileId !== capabilities.profileId) {
      throw new Error('Paperless capabilities belong to a different connection profile.');
    }
    this.client = client;
    this.capabilities = capabilities;
    this.options = options;
  }

  private async capabilityRequest<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (isCapabilityMismatchError(error)) this.options.onCapabilityMismatch?.(error);
      throw error;
    }
  }

  private async serializePdfOperation<T>(operation: () => Promise<T>, signal?: AbortSignal) {
    let release!: () => void;
    const previous = this.pdfOperationTail;
    this.pdfOperationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      return await operation();
    } finally {
      release();
    }
  }

  private async readPdfTaskFeed(signal?: AbortSignal): Promise<PaperlessTaskV10[] | null> {
    try {
      const response = await this.client.get<unknown>(
        '/api/tasks/?page_size=100&ordering=-date_created&task_type=consume_file&trigger_source=api_upload',
        signal,
      );
      return parsePage(response.data, parsePaperlessTaskV10).results;
    } catch {
      // Some otherwise-authorized accounts cannot enumerate tasks. PDF edits
      // may still be accepted; callers must retain an explicit uncorrelated
      // attention item instead of treating task-feed access as operation failure.
      return null;
    }
  }

  private async waitForPdfTaskCorrelation(
    baselineTaskIds: ReadonlySet<string>,
    expectedFilenames: readonly string[],
    signal?: AbortSignal,
  ) {
    const attempts = Math.max(1, Math.min(
      MAX_PDF_TASK_CORRELATION_ATTEMPTS,
      Math.floor(this.options.taskCorrelationAttempts ?? DEFAULT_PDF_TASK_CORRELATION_ATTEMPTS),
    ));
    const delayMs = Math.max(0, Math.min(
      MAX_PDF_TASK_CORRELATION_DELAY_MS,
      Math.floor(this.options.taskCorrelationDelayMs ?? DEFAULT_PDF_TASK_CORRELATION_DELAY_MS),
    ));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const tasks = await this.readPdfTaskFeed(signal);
      if (!tasks) return [];
      const taskIds = correlatePdfTasks(baselineTaskIds, tasks, expectedFilenames);
      if (taskIds.length === expectedFilenames.length) return taskIds;
      if (attempt + 1 < attempts && delayMs > 0 && !signal?.aborted) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return [];
  }

  private async runPdfOperation(
    plan: PdfTaskCorrelationPlan,
    request: () => Promise<{ data: unknown; headers?: Headers | Readonly<Record<string, string | undefined>> }>,
    signal?: AbortSignal,
  ): Promise<PaperlessAsyncOperationResult> {
    return this.serializePdfOperation(async () => {
      const baseline = await this.readPdfTaskFeed(signal);
      const response = await this.capabilityRequest(request);
      const direct = asyncResult(response.data, response.headers);
      if (direct.taskIds.length > 0 || !baseline || signal?.aborted) return direct;
      const taskIds = await this.waitForPdfTaskCorrelation(
        new Set(baseline.map((task) => task.taskId)),
        plan.expectedFilenames,
        signal,
      );
      return taskIds.length === plan.expectedFilenames.length
        ? { ...direct, taskIds, taskCorrelation: 'task-feed' }
        : direct;
    }, signal);
  }

  private async preflightPdfOperationPermissions(
    documentIds: number[],
    requirements: {
      operation: string;
      add?: boolean;
      delete?: boolean;
      owner?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<PaperlessCapabilityResult<true>> {
    if (this.capabilities.permissions.isSuperuser) return { supported: true, value: true };

    const requiredGlobalPermissions = [
      ['change', true],
      ['add', requirements.add === true],
      ['delete', requirements.delete === true],
    ] as const;
    for (const [action, required] of requiredGlobalPermissions) {
      if (!required) continue;
      const permission = this.capabilities.permissions.document[action];
      if (permission !== true) {
        return {
          supported: false,
          reason: permission === false ? 'permission-denied' : 'permission-unknown',
          detail: `${requirements.operation} requires global ${action} permission for documents.`,
        };
      }
    }

    let objectPermissionDenied = false;
    let objectPermissionUnknown = false;
    const currentUserId = this.capabilities.permissions.currentUserId;
    await mapConcurrent(documentIds, 3, async (documentId) => {
      try {
        const response = await this.client.get<unknown>(`/api/documents/${documentId}/`, signal);
        if (
          !isRecord(response.data)
          || response.data.id !== documentId
          || typeof response.data.user_can_change !== 'boolean'
          || (response.data.owner !== null && !isPositiveInteger(response.data.owner))
        ) {
          objectPermissionUnknown = true;
          return;
        }
        if (response.data.user_can_change !== true) {
          objectPermissionDenied = true;
          return;
        }
        if (requirements.owner && response.data.owner !== null) {
          if (currentUserId === null) objectPermissionUnknown = true;
          else if (response.data.owner !== currentUserId) objectPermissionDenied = true;
        }
      } catch (error) {
        if (
          error instanceof PaperlessClientError
          && (error.status === 401 || error.status === 403 || error.status === 404)
        ) {
          objectPermissionDenied = true;
          return;
        }
        throw error;
      }
    });
    if (objectPermissionDenied) {
      return {
        supported: false,
        reason: 'permission-denied',
        detail: requirements.owner
          ? `${requirements.operation} requires change permission and ownership of every source document.`
          : `${requirements.operation} requires object-level change permission for every source document.`,
      };
    }
    if (objectPermissionUnknown) {
      return {
        supported: false,
        reason: 'permission-unknown',
        detail: `Paperless did not confirm the owner and change permission for every ${requirements.operation.toLocaleLowerCase()} source document.`,
      };
    }
    return { supported: true, value: true };
  }

  async listCatalog<R extends PaperlessCatalogResource>(
    resource: R,
    query = 'page_size=100&ordering=name',
    signal?: AbortSignal,
  ): Promise<PaperlessCapabilityResult<PaperlessPage<PaperlessCatalogObjectByResource[R]>>> {
    const gate = capability(this.capabilities.features.catalogs[resource].list, true);
    if (!gate.supported) return gate;
    const value = await this.capabilityRequest(() => readAllPages(
      this.client,
      `${CATALOG_PATHS[resource]}?${query}`,
      CATALOG_PATHS[resource],
      (entry) => parsePaperlessCatalogObject(resource, entry),
      signal,
    ));
    if (resource !== 'tags') return { supported: true, value };
    const tags = restrictTagHierarchyToVisibleResults(value.results as PaperlessTag[]);
    return {
      supported: true,
      value: { ...value, results: tags } as PaperlessPage<PaperlessCatalogObjectByResource[R]>,
    };
  }

  async getCatalog<R extends PaperlessCatalogResource>(
    resource: R,
    id: number,
    signal?: AbortSignal,
  ): Promise<PaperlessCapabilityResult<PaperlessCatalogObjectByResource[R]>> {
    const gate = capability(this.capabilities.features.catalogs[resource].retrieve, true);
    if (!gate.supported) return gate;
    assertPositiveId(id);
    const value = await this.capabilityRequest(async () => {
      const response = await this.client.get<unknown>(`${CATALOG_PATHS[resource]}${id}/`, signal);
      const parsed = parsePaperlessCatalogObject(resource, response.data);
      if (resource !== 'tags') return parsed;
      // A detail response is not evidence that recursively embedded children
      // or ancestors are visible to this account. Full hierarchy consumers use
      // listCatalog(), where the collection queryset supplies that evidence.
      const restricted = restrictTagHierarchyToVisibleResults([parsed as PaperlessTag])[0];
      return restricted as PaperlessCatalogObjectByResource[R];
    });
    return { supported: true, value };
  }

  private async verifyCatalogWrite<R extends PaperlessCatalogResource>(
    resource: R,
    id: number,
    edit: PaperlessCatalogEditByResource[R],
    signal?: AbortSignal,
  ): Promise<PaperlessCatalogObjectByResource[R]> {
    const readback = await this.client.get<unknown>(`${CATALOG_PATHS[resource]}${id}/`, signal);
    const parsed = parsePaperlessCatalogObject(resource, readback.data);
    const expected = edit as Record<string, unknown>;
    const actual = parsed as PaperlessCatalogObject & { parentId?: number | null };
    const conflict = (
      (typeof expected.name === 'string' && actual.name !== expected.name.trim())
      || (typeof expected.match === 'string' && actual.match !== expected.match)
      || (expected.matchingAlgorithm !== undefined
        && String(actual.matchingAlgorithm) !== String(expected.matchingAlgorithm))
      || (typeof expected.isInsensitive === 'boolean'
        && actual.isInsensitive !== expected.isInsensitive)
      || (resource === 'tags' && expected.parentId !== undefined
        && actual.parentId !== expected.parentId)
      || (resource === 'tags' && typeof expected.color === 'string'
        && actual.kind === 'tag'
        && actual.color?.toLocaleLowerCase() !== expected.color.toLocaleLowerCase())
      || (resource === 'tags' && typeof expected.isInboxTag === 'boolean'
        && actual.kind === 'tag'
        && actual.isInboxTag !== expected.isInboxTag)
      || (resource === 'storagePaths' && typeof expected.path === 'string'
        && actual.kind === 'storagePath'
        && actual.path !== expected.path)
    );
    if (conflict) {
      throw new PaperlessClientError(
        'Paperless changed the catalog object concurrently. Reload before editing it again.',
        { code: 'write-conflict', responseBody: readback.data },
      );
    }
    if (resource === 'tags') {
      const hierarchyPage = await readAllPages(
        this.client,
        '/api/tags/?page_size=1000&ordering=name',
        '/api/tags/',
        parsePaperlessTag,
        signal,
      );
      const visibleTags = restrictTagHierarchyToVisibleResults(hierarchyPage.results);
      const hierarchy = normalizeNestedTags(visibleTags);
      if (!hierarchy.valid || !hierarchy.value.byId.has(id)) {
        throw new PaperlessClientError(
          'Paperless returned an unsafe tag hierarchy after the write.',
          {
            code: 'invalid-response',
            responseBody: hierarchy.valid ? undefined : hierarchy.errors,
          },
        );
      }
      const verified = hierarchy.value.byId.get(id)!;
      if (expected.parentId !== undefined && verified.parentId !== expected.parentId) {
        throw new PaperlessClientError(
          'The tag move was changed concurrently. Reload the hierarchy before retrying.',
          { code: 'write-conflict' },
        );
      }
      return visibleTags.find((tag) => tag.id === id) as PaperlessCatalogObjectByResource[R];
    }
    return parsed;
  }

  async createCatalog<R extends PaperlessCatalogResource>(
    resource: R,
    edit: PaperlessCatalogEditByResource[R],
    signal?: AbortSignal,
  ): Promise<PaperlessCapabilityResult<PaperlessCatalogObjectByResource[R]>> {
    const gate = capability(this.capabilities.features.catalogs[resource].create, true);
    if (!gate.supported) return gate;
    const value = await this.capabilityRequest(async () => {
      const response = await this.client.post<unknown>(
        CATALOG_PATHS[resource],
        serializeCatalogEdit(resource, edit),
        signal,
      );
      const created = parsePaperlessCatalogObject(resource, response.data);
      return this.verifyCatalogWrite(resource, created.id, edit, signal);
    });
    return { supported: true, value };
  }

  async updateCatalog<R extends PaperlessCatalogResource>(
    resource: R,
    id: number,
    edit: PaperlessCatalogEditByResource[R],
    signal?: AbortSignal,
  ): Promise<PaperlessCapabilityResult<PaperlessCatalogObjectByResource[R]>> {
    const gate = capability(this.capabilities.features.catalogs[resource].update, true);
    if (!gate.supported) return gate;
    assertPositiveId(id);
    const value = await this.capabilityRequest(async () => {
      await this.client.patch<unknown>(
        `${CATALOG_PATHS[resource]}${id}/`,
        serializeCatalogEdit(resource, edit),
        signal,
      );
      return this.verifyCatalogWrite(resource, id, edit, signal);
    });
    return { supported: true, value };
  }

  async deleteCatalog<R extends PaperlessCatalogResource>(
    resource: R,
    id: number,
    signal?: AbortSignal,
  ): Promise<PaperlessCapabilityResult<{ deletedId: number }>> {
    const gate = capability(this.capabilities.features.catalogs[resource].delete, true);
    if (!gate.supported) return gate;
    assertPositiveId(id);
    await this.capabilityRequest(() =>
      this.client.delete(`${CATALOG_PATHS[resource]}${id}/`, signal));
    return { supported: true, value: { deletedId: id } };
  }

  async listSavedViews(signal?: AbortSignal): Promise<PaperlessCapabilityResult<PaperlessPage<PaperlessSavedView>>> {
    const gate = capability(this.capabilities.features.savedViews.list, true);
    if (!gate.supported) return gate;
    const value = await this.capabilityRequest(() => readAllPages(
      this.client,
      '/api/saved_views/?page_size=100&ordering=name',
      '/api/saved_views/',
      parsePaperlessSavedView,
      signal,
    ));
    return { supported: true, value };
  }

  async createSavedView(
    edit: PaperlessSavedViewEdit & { name: string },
    signal?: AbortSignal,
  ): Promise<PaperlessCapabilityResult<PaperlessSavedView>> {
    const gate = capability(this.capabilities.features.savedViews.create, true);
    if (!gate.supported) return gate;
    const response = await this.client.post<unknown>('/api/saved_views/', savedViewCreatePayload(edit), signal);
    return { supported: true, value: parsePaperlessSavedView(response.data) };
  }

  async updateSavedView(
    current: PaperlessSavedView,
    edit: PaperlessSavedViewEdit,
    options: { unknownRulePolicy?: PaperlessUnknownRulePolicy; signal?: AbortSignal } = {},
  ): Promise<PaperlessCapabilityResult<PaperlessSavedView>> {
    const gate = capability(this.capabilities.features.savedViews.update, true);
    if (!gate.supported) return gate;
    const mutation = buildSavedViewUpdate(current, edit, options.unknownRulePolicy);
    if (!mutation.supported) return mutation;
    const response = await this.client.patch<unknown>(
      `/api/saved_views/${current.id}/`,
      mutation.value,
      options.signal,
    );
    return { supported: true, value: parsePaperlessSavedView(response.data) };
  }

  async duplicateSavedView(
    current: PaperlessSavedView,
    name: string,
    presentation: Pick<
      PaperlessSavedViewEdit,
      | 'pageSize'
      | 'displayMode'
      | 'displayFields'
      | 'showOnDashboard'
      | 'showInSidebar'
    > = {},
    signal?: AbortSignal,
  ): Promise<PaperlessCapabilityResult<PaperlessSavedView>> {
    return this.createSavedView(
      {
        name,
        sortField: current.sortField,
        sortReverse: current.sortReverse,
        filterRules: current.filterRules,
        pageSize: current.pageSize,
        displayMode: current.displayMode,
        displayFields: current.displayFields,
        extra: current.extra,
        ...presentation,
      },
      signal,
    );
  }

  async deleteSavedView(id: number, signal?: AbortSignal): Promise<PaperlessCapabilityResult<{ deletedId: number }>> {
    const gate = capability(this.capabilities.features.savedViews.delete, true);
    if (!gate.supported) return gate;
    assertPositiveId(id);
    await this.client.delete(`/api/saved_views/${id}/`, signal);
    return { supported: true, value: { deletedId: id } };
  }

  async bulkDocuments(
    candidates: PaperlessBulkCandidate[],
    operation: PaperlessBulkOperation,
    options: { concurrency?: number; signal?: AbortSignal } = {},
  ): Promise<PaperlessCapabilityResult<PaperlessBulkResult>> {
    const { eligible, skipped } = selectBulkEligible(candidates);
    if (eligible.length === 0) {
      return {
        supported: true,
        value: { operation, accepted: false, pending: [], succeeded: [], failed: [], skipped, requestCount: 0, taskIds: [] },
      };
    }

    if (operation.kind === 'tags' && operation.mode === 'replace') {
      const gate = capability(this.capabilities.permissions.document.change === true
        ? ({ supported: true, source: 'ui-settings' } satisfies PaperlessCapabilityStatus)
        : ({ supported: false, reason: this.capabilities.permissions.document.change === false ? 'permission-denied' : 'permission-unknown', source: 'ui-settings' } satisfies PaperlessCapabilityStatus), true);
      if (!gate.supported) return gate;
      const tags = uniquePositiveIds(operation.tagIds, 'Tag IDs');
      const succeeded: number[] = [];
      const failed: PaperlessOperationFailure[] = [];
      await mapConcurrent(eligible, options.concurrency ?? 3, async (candidate) => {
        try {
          await this.client.patch(`/api/documents/${candidate.remoteId}/`, { tags }, options.signal);
          succeeded.push(candidate.remoteId);
        } catch (error) {
          failed.push(failureFromError(error, candidate));
        }
      });
      return {
        supported: true,
        value: {
          operation,
          accepted: succeeded.length > 0,
          pending: [],
          succeeded,
          failed,
          skipped,
          requestCount: eligible.length,
          taskIds: [],
        },
      };
    }

    const status =
      operation.kind === 'trash'
        ? this.capabilities.features.deleteDocuments
        : operation.kind === 'reprocess'
          ? this.capabilities.features.reprocessDocuments
          : this.capabilities.features.bulkDocuments;
    const gate = capability(status, true);
    if (!gate.supported) return gate;

    const documentIds = eligible.map((candidate) => candidate.remoteId);
    let path = '/api/documents/bulk_edit/';
    let payload: Record<string, unknown>;
    if (operation.kind === 'trash' || operation.kind === 'reprocess') {
      path = operation.kind === 'trash' ? '/api/documents/delete/' : '/api/documents/reprocess/';
      payload = { documents: documentIds };
    } else if (operation.kind === 'tags') {
      const tags = uniquePositiveIds(operation.tagIds, 'Tag IDs');
      payload = {
        documents: documentIds,
        method: 'modify_tags',
        parameters: {
          add_tags: operation.mode === 'add' ? tags : [],
          remove_tags: operation.mode === 'remove' ? tags : [],
        },
      };
    } else if (operation.kind === 'file') {
      payload = {
        documents: documentIds,
        method: 'modify_tags',
        parameters: { add_tags: [], remove_tags: uniquePositiveIds(operation.inboxTagIds, 'Inbox tag IDs') },
      };
    } else if (operation.kind === 'setOwner') {
      if (operation.value !== null) assertPositiveId(operation.value, 'Owner ID');
      payload = {
        documents: documentIds,
        method: 'set_permissions',
        parameters: {
          owner: operation.value,
          set_permissions: { view: { users: [], groups: [] }, change: { users: [], groups: [] } },
          merge: true,
        },
      };
    } else {
      if (operation.value !== null) assertPositiveId(operation.value);
      const methods = {
        setCorrespondent: 'set_correspondent',
        setDocumentType: 'set_document_type',
        setStoragePath: 'set_storage_path',
      } as const;
      const fields = {
        setCorrespondent: 'correspondent',
        setDocumentType: 'document_type',
        setStoragePath: 'storage_path',
      } as const;
      payload = {
        documents: documentIds,
        method: methods[operation.kind],
        parameters: { [fields[operation.kind]]: operation.value },
      };
    }

    try {
      const response = await this.client.post<unknown>(path, payload, options.signal);
      const taskIds = extractTaskIds(response.data, response.headers);
      return {
        supported: true,
        value: {
          operation,
          accepted: true,
          pending: taskIds.length ? documentIds : [],
          succeeded: taskIds.length ? [] : documentIds,
          failed: [],
          skipped,
          requestCount: 1,
          taskIds,
        },
      };
    } catch (error) {
      return {
        supported: true,
        value: {
          operation,
          accepted: false,
          pending: [],
          succeeded: [],
          failed: eligible.map((candidate) => failureFromError(error, candidate)),
          skipped,
          requestCount: 1,
          taskIds: [],
        },
      };
    }
  }

  async getRepresentations(
    documentId: number,
    signal?: AbortSignal,
    versionId?: number,
  ): Promise<PaperlessCapabilityResult<PaperlessDocumentRepresentations>> {
    const gate = capability(this.capabilities.features.documentMetadata, true);
    if (!gate.supported) return gate;
    assertPositiveId(documentId, 'Document ID');
    const params = new URLSearchParams();
    if (versionId !== undefined) {
      assertPositiveId(versionId, 'Version ID');
      params.set('version', String(versionId));
    }
    const query = params.toString();
    const response = await this.capabilityRequest(() => this.client.get<unknown>(
      `/api/documents/${documentId}/metadata/${query ? `?${query}` : ''}`,
      signal,
    ));
    return { supported: true, value: parseDocumentRepresentations(documentId, response.data) };
  }

  representationDownloadPath(
    representations: PaperlessDocumentRepresentations,
    representation: PaperlessRepresentation,
    versionId?: number,
  ): PaperlessCapabilityResult<string> {
    return this.representationFilePath(representations, representation, 'download', versionId);
  }

  representationFilePath(
    representations: PaperlessDocumentRepresentations,
    representation: PaperlessRepresentation,
    action: 'download' | 'preview',
    versionId?: number,
  ): PaperlessCapabilityResult<string> {
    const info = representations[representation];
    if (!info.available) {
      return {
        supported: false,
        reason: 'representation-unavailable',
        detail: `${representation} representation is unavailable.`,
      };
    }
    const params = new URLSearchParams();
    // Paperless otherwise defaults to archive and silently falls back to the
    // original when no archive exists. Always make the user's choice explicit;
    // callers still verify the returned bytes against version-scoped metadata.
    params.set('original', representation === 'original' ? 'true' : 'false');
    if (versionId !== undefined) {
      assertPositiveId(versionId, 'Version ID');
      params.set('version', String(versionId));
    }
    const query = params.toString();
    return {
      supported: true,
      value: `/api/documents/${representations.documentId}/${action}/${query ? `?${query}` : ''}`,
    };
  }

  async listShareLinks(
    documentId: number,
    signal?: AbortSignal,
  ): Promise<PaperlessCapabilityResult<PaperlessShareLink[]>> {
    const gate = capability(this.capabilities.features.shareLinks.list, true);
    if (!gate.supported) return gate;
    assertPositiveId(documentId, 'Document ID');
    const response = await this.capabilityRequest(() =>
      this.client.get<unknown>(`/api/documents/${documentId}/share_links/`, signal));
    const values = Array.isArray(response.data)
      ? response.data
      : isRecord(response.data) && Array.isArray(response.data.results)
        ? response.data.results
        : null;
    if (!values) {
      throw new PaperlessClientError('Paperless returned an invalid share-link list.', {
        code: 'invalid-response',
        responseBody: response.data,
      });
    }
    const links = values.map((entry) => parseShareLink(entry));
    if (links.some((link) => link.documentId !== documentId)) {
      throw new PaperlessClientError('Paperless returned a share link for another document.', {
        code: 'invalid-response',
        responseBody: response.data,
      });
    }
    return { supported: true, value: links };
  }

  async createShareLink(
    input: {
      documentId: number;
      representation: PaperlessRepresentation;
      representations: PaperlessDocumentRepresentations;
      expiry: PaperlessShareLinkExpiry;
    },
    options: { now?: Date; signal?: AbortSignal } = {},
  ): Promise<PaperlessCapabilityResult<PaperlessShareLink>> {
    const gate = capability(this.capabilities.features.shareLinks.create, true);
    if (!gate.supported) return gate;
    assertPositiveId(input.documentId, 'Document ID');
    if (input.representations.documentId !== input.documentId) {
      return { supported: false, reason: 'invalid-input', detail: 'Representation metadata belongs to another document.' };
    }
    if (!input.representations[input.representation].available) {
      return { supported: false, reason: 'representation-unavailable' };
    }
    const response = await this.capabilityRequest(() =>
      this.client.post<unknown>(
        '/api/share_links/',
        {
          document: input.documentId,
          file_version: input.representation,
          expiration: serializeShareLinkExpiry(input.expiry, options.now),
        },
        options.signal,
      ));
    const link = parseShareLink(response.data, options.now);
    if (link.documentId !== input.documentId || link.fileVersion !== input.representation) {
      throw new PaperlessClientError('Paperless returned mismatched share-link metadata.', {
        code: 'invalid-response',
        responseBody: response.data,
      });
    }
    return { supported: true, value: link };
  }

  async revokeShareLink(id: number, signal?: AbortSignal): Promise<PaperlessCapabilityResult<{ revokedId: number }>> {
    const gate = capability(this.capabilities.features.shareLinks.delete, true);
    if (!gate.supported) return gate;
    assertPositiveId(id, 'Share-link ID');
    await this.capabilityRequest(() =>
      this.client.delete(`/api/share_links/${id}/`, signal));
    return { supported: true, value: { revokedId: id } };
  }

  async updateObjectPermissions(
    resource: PermissionEditableResource,
    id: number,
    current: PaperlessOwnedObject,
    mutation: PaperlessPermissionMutation,
    signal?: AbortSignal,
  ): Promise<PaperlessCapabilityResult<PaperlessPermissionUpdateResult>> {
    const featureGate = capability(this.capabilities.features.fullPermissions, true);
    if (!featureGate.supported) return featureGate;
    assertPositiveId(id);
    const permission = this.capabilities.permissions[resource].change;
    if (permission !== true) {
      return {
        supported: false,
        reason: permission === false ? 'permission-denied' : 'permission-unknown',
      };
    }
    let plan = planPermissionMutation(current, mutation, {
      currentUserId: this.capabilities.permissions.currentUserId,
      isSuperuser: this.capabilities.permissions.isSuperuser,
    });
    if (!plan.supported && plan.reason === 'self-lockout' && !mutation.confirmSelfLockout) {
      try {
        const identityResponse = await this.client.get<unknown>('/api/ui_settings/', signal);
        const identity = permissionIdentityFromUiSettings(identityResponse.data);
        if (identity) plan = planPermissionMutation(current, mutation, identity);
      } catch {
        // Group membership is only supplementary evidence. If it cannot be
        // refreshed, retain the fail-closed self-lockout decision.
      }
    }
    if (!plan.supported) return plan;
    const path = `${PERMISSION_RESOURCE_PATHS[resource]}${id}/`;
    await this.client.patch(path, plan.value, signal);
    const verified = await this.client.get<unknown>(`${path}?full_perms=true`, signal);
    if (!isRecord(verified.data)) {
      throw new PaperlessClientError('Paperless returned invalid permissions after update.', {
        code: 'invalid-response',
        responseBody: verified.data,
      });
    }
    const parsed = parseOwnedObject(verified.data);
    if (!parsed.permissions) {
      throw new PaperlessClientError('Paperless did not return full permissions after update.', {
        code: 'permission-readback-missing',
      });
    }
    if (
      parsed.ownerId !== plan.value.owner
      || !permissionSetsEqual(parsed.permissions, plan.value.set_permissions)
    ) {
      throw new PaperlessClientError('Paperless permission readback did not match the requested owner and ACL.', {
        code: 'permission-verification-failed',
        responseBody: verified.data,
      });
    }
    const canonicalPermissions = canonicalPermissionSet(parsed.permissions);
    return {
      supported: true,
      value: { ownerId: parsed.ownerId, permissions: canonicalPermissions, verified: true },
    };
  }

  async getAiSuggestions(
    documentId: number,
    signal?: AbortSignal,
  ): Promise<PaperlessCapabilityResult<PaperlessValidationResult<PaperlessAiSuggestions>>> {
    const gate = capability(this.capabilities.features.aiSuggestions, true);
    if (!gate.supported) return gate;
    assertPositiveId(documentId, 'Document ID');
    try {
      const response = await this.capabilityRequest(() =>
        this.client.get<unknown>(`/api/documents/${documentId}/ai_suggestions/`, signal));
      return { supported: true, value: validateAiSuggestions(response.data) };
    } catch (error) {
      if (error instanceof PaperlessClientError && error.status === 400) {
        return { supported: false, reason: 'runtime-disabled', detail: error.message };
      }
      throw error;
    }
  }

  async rotateDocuments(input: {
    documentIds: number[];
    degrees: number;
    sourceMode?: PaperlessPdfSourceMode;
    signal?: AbortSignal;
  }): Promise<PaperlessCapabilityResult<PaperlessAsyncOperationResult>> {
    const gate = capability(this.capabilities.features.pdf.rotate, true);
    if (!gate.supported) return gate;
    const documents = uniquePositiveIds(input.documentIds, 'Document IDs');
    if (documents.length === 0 || !Number.isInteger(input.degrees) || input.degrees === 0) {
      return { supported: false, reason: 'invalid-input', detail: 'Rotation requires documents and a non-zero integer angle.' };
    }
    const permissionGate = await this.preflightPdfOperationPermissions(
      documents,
      { operation: 'PDF rotation', owner: true },
      input.signal,
    );
    if (!permissionGate.supported) return permissionGate;
    const value = await this.runPdfOperation(
      { expectedFilenames: documents.map((id) => `${id}_rotated.pdf`) },
      () => this.client.post<unknown>('/api/documents/rotate/', {
        documents,
        degrees: input.degrees,
        source_mode: input.sourceMode ?? 'latest_version',
      }, input.signal),
      input.signal,
    );
    return { supported: true, value };
  }

  async mergeDocuments(input: {
    documentIds: number[];
    metadataDocumentId?: number | null;
    deleteOriginals?: boolean;
    archiveFallback?: boolean;
    sourceMode?: PaperlessPdfSourceMode;
    confirmDestructive?: boolean;
    signal?: AbortSignal;
  }): Promise<PaperlessCapabilityResult<PaperlessAsyncOperationResult>> {
    const gate = capability(this.capabilities.features.pdf.merge, true);
    if (!gate.supported) return gate;
    const documents = uniquePositiveIds(input.documentIds, 'Document IDs');
    if (documents.length < 2) return { supported: false, reason: 'invalid-input', detail: 'Merge requires at least two documents.' };
    if (input.deleteOriginals && !input.confirmDestructive) {
      return { supported: false, reason: 'requires-confirmation', detail: 'Deleting source documents requires confirmation.' };
    }
    if (input.metadataDocumentId != null) {
      assertPositiveId(input.metadataDocumentId, 'Metadata document ID');
      if (!documents.includes(input.metadataDocumentId)) {
        return {
          supported: false,
          reason: 'invalid-input',
          detail: 'The metadata source must be one of the documents being merged.',
        };
      }
    }
    const permissionGate = await this.preflightPdfOperationPermissions(
      documents,
      {
        operation: 'PDF merge',
        add: true,
        delete: input.deleteOriginals === true,
        owner: input.deleteOriginals === true,
      },
      input.signal,
    );
    if (!permissionGate.supported) return permissionGate;
    const value = await this.runPdfOperation(
      { expectedFilenames: [`${documents.join('_').slice(0, 100)}_merged.pdf`] },
      () => this.client.post<unknown>('/api/documents/merge/', {
        documents,
        metadata_document_id: input.metadataDocumentId ?? null,
        delete_originals: input.deleteOriginals ?? false,
        archive_fallback: input.archiveFallback ?? false,
        source_mode: input.sourceMode ?? 'latest_version',
      }, input.signal),
      input.signal,
    );
    return { supported: true, value };
  }

  async editPdf(input: {
    documentId: number;
    operations: PaperlessPdfPageOperation[];
    deleteOriginal?: boolean;
    updateDocument?: boolean;
    includeMetadata?: boolean;
    sourceMode?: PaperlessPdfSourceMode;
    confirmDestructive?: boolean;
    signal?: AbortSignal;
  }): Promise<PaperlessCapabilityResult<PaperlessAsyncOperationResult>> {
    const gate = capability(this.capabilities.features.pdf.edit, true);
    if (!gate.supported) return gate;
    assertPositiveId(input.documentId, 'Document ID');
    if (input.operations.length === 0) return { supported: false, reason: 'invalid-input', detail: 'At least one page operation is required.' };
    if (input.deleteOriginal && !input.confirmDestructive) {
      return { supported: false, reason: 'requires-confirmation', detail: 'Deleting the source document requires confirmation.' };
    }
    const operations = input.operations.map((operation, index) => {
      if (!isPositiveInteger(operation.page)) {
        throw new PaperlessClientError(`Page operation ${index} has an invalid page.`, { code: 'invalid-input' });
      }
      if (operation.rotate !== undefined && !Number.isInteger(operation.rotate)) {
        throw new PaperlessClientError(`Page operation ${index} has an invalid rotation.`, { code: 'invalid-input' });
      }
      if (operation.outputDocument !== undefined && (!Number.isInteger(operation.outputDocument) || operation.outputDocument < 0)) {
        throw new PaperlessClientError(`Page operation ${index} has an invalid output document.`, { code: 'invalid-input' });
      }
      return {
        page: operation.page,
        ...(operation.rotate !== undefined ? { rotate: operation.rotate } : {}),
        ...(operation.outputDocument !== undefined ? { doc: operation.outputDocument } : {}),
      };
    });
    if (input.updateDocument && operations.some((operation) => (operation.doc ?? 0) > 0)) {
      return { supported: false, reason: 'invalid-input', detail: 'A new version cannot contain multiple output documents.' };
    }
    const outputCount = input.updateDocument
      ? 1
      : Math.max(...operations.map((operation) => operation.doc ?? 0)) + 1;
    const permissionGate = await this.preflightPdfOperationPermissions(
      [input.documentId],
      {
        operation: outputCount > 1 ? 'PDF split' : 'PDF edit',
        add: input.updateDocument !== true,
        delete: input.deleteOriginal === true && input.updateDocument !== true,
        owner: true,
      },
      input.signal,
    );
    if (!permissionGate.supported) return permissionGate;
    const expectedFilenames = input.updateDocument
      ? [`${input.documentId}_edited.pdf`]
      : Array.from(
          { length: outputCount },
          (_unused, index) => `${input.documentId}_edit_${index + 1}.pdf`,
        );
    const value = await this.runPdfOperation(
      { expectedFilenames },
      () => this.client.post<unknown>('/api/documents/edit_pdf/', {
        documents: [input.documentId],
        operations,
        delete_original: input.deleteOriginal ?? false,
        update_document: input.updateDocument ?? false,
        include_metadata: input.includeMetadata ?? true,
        source_mode: input.sourceMode ?? 'latest_version',
      }, input.signal),
      input.signal,
    );
    return { supported: true, value };
  }

  async removePdfPassword(input: {
    documentId: number;
    password: string;
    deleteOriginal?: boolean;
    updateDocument?: boolean;
    includeMetadata?: boolean;
    sourceMode?: PaperlessPdfSourceMode;
    confirmDestructive?: boolean;
    signal?: AbortSignal;
  }): Promise<PaperlessCapabilityResult<PaperlessAsyncOperationResult>> {
    const gate = capability(this.capabilities.features.pdf.removePassword, true);
    if (!gate.supported) return gate;
    assertPositiveId(input.documentId, 'Document ID');
    if (!input.password) return { supported: false, reason: 'invalid-input', detail: 'A PDF password is required.' };
    if (input.deleteOriginal && !input.confirmDestructive) {
      return { supported: false, reason: 'requires-confirmation' };
    }
    const permissionGate = await this.preflightPdfOperationPermissions(
      [input.documentId],
      {
        operation: 'PDF password removal',
        add: input.updateDocument !== true,
        delete: input.deleteOriginal === true && input.updateDocument !== true,
        owner: true,
      },
      input.signal,
    );
    if (!permissionGate.supported) return permissionGate;
    const value = await this.runPdfOperation(
      { expectedFilenames: [`${input.documentId}_unprotected.pdf`] },
      () => this.client.post<unknown>('/api/documents/remove_password/', {
        documents: [input.documentId],
        password: input.password,
        delete_original: input.deleteOriginal ?? false,
        update_document: input.updateDocument ?? false,
        include_metadata: input.includeMetadata ?? true,
        source_mode: input.sourceMode ?? 'latest_version',
      }, input.signal),
      input.signal,
    );
    return { supported: true, value };
  }
}

export type {
  PaperlessCatalogObject,
  PaperlessCorrespondent,
  PaperlessDocumentType,
  PaperlessNormalizedTag,
  PaperlessRepresentationInfo,
  PaperlessStoragePath,
};
