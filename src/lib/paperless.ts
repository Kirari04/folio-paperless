import { File, UploadType } from 'expo-file-system';
import { Platform } from 'react-native';

import {
  DocumentChanges,
  DocumentItem,
  LibraryFilters,
  PaperlessCatalog,
  PaperlessCreatableOptionKind,
  PaperlessCreationCapabilities,
  PaperlessConnectionInfo,
  PaperlessCredentials,
  PaperlessCustomFieldDataType,
  PaperlessCustomFieldDefinition,
  PaperlessCustomFieldValue,
  PaperlessDocumentVersion,
  PaperlessNote,
  PaperlessOption,
  PaperlessSavedView,
  PaperlessLibraryRequest,
  PaperlessSavedViewRule,
  PaperlessTrashWorkspace,
} from '@/types/document';

import { matchesLibraryFilters } from '@/lib/library-filters';
import { normalizePaperlessServerUrl, ServerUrlError } from '@/lib/server-url';

type ApiList<T> = {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
};

type ApiNamedItem = {
  id: number;
  name: string;
  color?: string;
};

type ApiUser = {
  id: number;
  username: string;
  first_name?: string;
  last_name?: string;
};

type ApiUiSettings = {
  user?: {
    is_superuser?: boolean;
  };
  permissions?: string[];
};

type ApiDocument = {
  id: number;
  title: string;
  correspondent: number | null;
  document_type: number | null;
  storage_path?: number | null;
  created: string;
  added: string;
  modified?: string;
  owner?: number | null;
  tags: number[];
  page_count?: number;
  original_file_size?: number;
  archived_file_size?: number;
  original_filename?: string;
  mime_type?: string;
  content?: string;
  user_can_change?: boolean;
  deleted_at?: string | null;
  archive_serial_number?: number | null;
  custom_fields?: { field: number; value: unknown }[];
  notes?: ApiNote[];
  versions?: ApiDocumentVersion[];
  root_document?: number | null;
};

type ApiCustomField = {
  id: number;
  name: string;
  data_type: PaperlessCustomFieldDataType;
  extra_data?: {
    select_options?: { id: string; label: string }[];
    default_currency?: string | null;
  };
  document_count?: number;
};

type ApiNote = {
  id: number;
  note: string;
  created: string;
  user?: {
    username?: string;
    first_name?: string;
    last_name?: string;
  } | null;
};

type ApiDocumentVersion = {
  id: number;
  added: string;
  version_label?: string | null;
  checksum?: string | null;
  is_root: boolean;
};

type ApiSavedView = {
  id: number;
  name: string;
  sort_field?: string;
  sort_reverse?: boolean;
  filter_rules?: { rule_type: number; value: string | null }[];
  page_size?: number;
  display_mode?: string;
  display_fields?: (string | number)[];
};

export type PaperlessWorkspace = {
  catalog: PaperlessCatalog;
  documents: DocumentItem[];
  totalDocuments: number;
};

export type PaperlessTask = {
  taskId: string;
  status: string;
  documentId?: number;
  message?: string;
};

type ApiTask = {
  task_id?: string;
  id?: string | number;
  status?: string;
  state?: string;
  related_document?: number | string | null;
  result?: unknown;
  message?: string;
  messages?: string[];
};

const API_VERSION = '10';
const REQUEST_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const cardColors = ['#C9E1EB', '#EDC7C1', '#D8D2F1', '#CDE8D4', '#F2B486', '#D8F678'];

type PaperlessUploadFile = {
  uri: string;
  name: string;
  mimeType?: string | null;
};

type PaperlessUploadOptions = {
  onProgress?: (progress: number) => void;
};

export class PaperlessApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'PaperlessApiError';
    this.status = status;
  }
}

export function normalizeServerUrl(value: string) {
  try {
    return normalizePaperlessServerUrl(value, { requireHttps: Platform.OS === 'ios' });
  } catch (error) {
    if (error instanceof ServerUrlError) throw new PaperlessApiError(error.message);
    throw error;
  }
}

export function paperlessHeaders(token: string): Record<string, string> {
  return {
    Accept: `application/json; version=${API_VERSION}`,
    Authorization: `Token ${token.trim()}`,
  };
}

export function paperlessFileHeaders(token: string): Record<string, string> {
  return {
    Accept: '*/*',
    Authorization: `Token ${token.trim()}`,
  };
}

export function getPaperlessDocumentUrl(
  credentials: PaperlessCredentials,
  remoteId: number,
  kind: 'download' | 'preview' | 'thumb' = 'download',
  versionId?: number,
) {
  const version = versionId ? `?version=${versionId}` : '';
  return `${normalizeServerUrl(credentials.serverUrl)}/api/documents/${remoteId}/${kind}/${version}`;
}

function readableError(status: number, detail?: string) {
  if (status === 400) return detail || 'Paperless rejected this change. Check the entered values.';
  if (status === 401) return 'The API token was rejected. Create a new token in your Paperless profile.';
  if (status === 403) return 'This Paperless account does not have permission to perform that action.';
  if (status === 404) return 'This item no longer exists on the Paperless server.';
  if (status === 406) return 'This Paperless server does not support API version 10.';
  if (status === 413) return 'This file is larger than the upload limit configured for Paperless or its proxy.';
  if (status === 429) return 'Paperless is receiving too many requests. Wait a moment and try again.';
  if (status >= 500) return 'The Paperless server encountered an error. Try again in a moment.';
  return detail || `Paperless returned status ${status}.`;
}

function errorDetail(body: unknown) {
  if (typeof body === 'string') return body.trim() || undefined;
  if (Array.isArray(body)) return body.map(String).join(' ');
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const detail = record.detail || record.error || record.message || record.non_field_errors;
    if (Array.isArray(detail)) return detail.join(' ');
    if (typeof detail === 'string') return detail;
    const messages = Object.entries(record).flatMap(([field, value]) => {
      const label = field.replaceAll('_', ' ');
      if (Array.isArray(value)) return value.map((item) => `${label}: ${String(item)}`);
      if (typeof value === 'string' || typeof value === 'number') return [`${label}: ${value}`];
      return [];
    });
    return messages.length ? messages.join(' ') : undefined;
  }
  return undefined;
}

async function readError(response: Response) {
  try {
    return errorDetail(await response.json());
  } catch {
    return undefined;
  }
}

function readUploadError(body: string) {
  try {
    return errorDetail(JSON.parse(body));
  } catch {
    return errorDetail(body);
  }
}

function uploadFileError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/no such file|file.?not.?found|enoent|permission denied|could not read|cannot read/i.test(message)) {
    return new PaperlessApiError(
      'Folio can no longer read this file. Return to the scanner or picker and add it again.',
    );
  }
  if (/certificate|ssl|trust anchor|hostname.*verif/i.test(message)) {
    return new PaperlessApiError(
      'The secure connection to Paperless was rejected. Use a certificate trusted by this device and check that its hostname matches the server address.',
    );
  }
  return new PaperlessApiError(
    'The upload could not connect to Paperless. Check your connection and try again; the file was not removed.',
  );
}

async function uploadPaperlessMultipart<T>(
  credentials: PaperlessCredentials,
  path: string,
  file: PaperlessUploadFile,
  parameters: Record<string, string>,
  options: PaperlessUploadOptions = {},
) {
  let uploadFile: File;
  try {
    uploadFile = new File(file.uri);
    if (!uploadFile.exists) {
      throw new PaperlessApiError(
        'This file is no longer available on the device. Return to the scanner or picker and add it again.',
      );
    }
    if (uploadFile.size <= 0) {
      throw new PaperlessApiError('This file is empty and cannot be uploaded. Create or choose it again.');
    }
  } catch (error) {
    if (error instanceof PaperlessApiError) throw error;
    throw uploadFileError(error);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  const baseUrl = normalizeServerUrl(credentials.serverUrl);
  options.onProgress?.(0);

  try {
    const response = await uploadFile.upload(`${baseUrl}${path}`, {
      fieldName: 'document',
      headers: paperlessHeaders(credentials.token),
      httpMethod: 'POST',
      mimeType: file.mimeType || uploadFile.type || 'application/octet-stream',
      onProgress: ({ bytesSent, totalBytes }) => {
        if (totalBytes > 0) options.onProgress?.(Math.min(1, bytesSent / totalBytes));
      },
      parameters,
      sessionType: 'foreground',
      signal: controller.signal,
      uploadType: UploadType.MULTIPART,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new PaperlessApiError(
        readableError(response.status, readUploadError(response.body)),
        response.status,
      );
    }

    options.onProgress?.(1);
    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new PaperlessApiError(
        'Paperless received the file but returned an unexpected response. Check the Inbox before trying again.',
      );
    }
  } catch (error) {
    if (error instanceof PaperlessApiError) throw error;
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new PaperlessApiError(
        'Paperless did not reply before the upload timed out. Check the Inbox before trying again—the file may still be processing.',
      );
    }
    throw uploadFileError(error);
  } finally {
    clearTimeout(timeout);
  }
}

async function request(
  credentials: PaperlessCredentials,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const baseUrl = normalizeServerUrl(credentials.serverUrl);
  const url = path.startsWith('http') ? path : `${baseUrl}${path}`;

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        ...paperlessHeaders(credentials.token),
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new PaperlessApiError(readableError(response.status, await readError(response)), response.status);
    }
    return response;
  } catch (error) {
    if (error instanceof PaperlessApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new PaperlessApiError('The Paperless server took too long to respond. Try again.');
    }
    throw new PaperlessApiError(
      Platform.OS === 'ios'
        ? 'Could not reach this Paperless server. Check local-network permission and use HTTPS with a certificate trusted by this device.'
        : 'Could not reach this Paperless server. Check the address, network, and HTTPS certificate.',
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function getJson<T>(credentials: PaperlessCredentials, path: string): Promise<T> {
  const response = await request(credentials, path);
  return response.json() as Promise<T>;
}

async function sendJson<T>(
  credentials: PaperlessCredentials,
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const response = await request(credentials, path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function safeNextPath(credentials: PaperlessCredentials, next: string) {
  const base = new URL(normalizeServerUrl(credentials.serverUrl));
  const target = new URL(next, base);
  // Reverse proxies commonly make Paperless serialize pagination URLs with its
  // internal hostname. We deliberately discard that origin and send only API
  // paths back to the server address the user trusted, so the token never
  // leaves the configured origin.
  if (!target.pathname.startsWith('/api/')) {
    throw new PaperlessApiError('Paperless returned an invalid pagination address.');
  }
  return `${target.pathname}${target.search}`;
}

async function getAllPages<T>(credentials: PaperlessCredentials, initialPath: string) {
  const results: T[] = [];
  let path: string | null = initialPath;
  let total = 0;
  let pageCount = 0;

  while (path) {
    const page: ApiList<T> = await getJson<ApiList<T>>(credentials, path);
    total = page.count;
    results.push(...page.results);
    path = page.next ? safeNextPath(credentials, page.next) : null;
    pageCount += 1;
    if (pageCount >= 100) {
      throw new PaperlessApiError('This library is too large to synchronize safely in one pass.');
    }
  }

  return { results, total };
}

function toOption(kind: string, item: ApiNamedItem): PaperlessOption {
  return {
    id: `remote-${kind}-${item.id}`,
    remoteId: item.id,
    name: item.name,
    color: item.color,
  };
}

function buildCatalog(
  correspondents: ApiNamedItem[],
  documentTypes: ApiNamedItem[],
  tags: ApiNamedItem[],
  storagePaths: ApiNamedItem[],
  owners: ApiUser[],
  customFields: ApiCustomField[],
  savedViews: ApiSavedView[],
): PaperlessCatalog {
  return {
    correspondents: correspondents.map((item) => toOption('correspondent', item)),
    documentTypes: documentTypes.map((item) => toOption('type', item)),
    tags: tags.map((item) => toOption('tag', item)),
    storagePaths: storagePaths.map((item) => toOption('storage-path', item)),
    owners: owners.map((owner) => ({
      id: `remote-owner-${owner.id}`,
      remoteId: owner.id,
      name: [owner.first_name, owner.last_name].filter(Boolean).join(' ') || owner.username,
    })),
    customFields: customFields.map(mapCustomFieldDefinition),
    savedViews: savedViews.map(mapSavedView),
  };
}

function mapCustomFieldDefinition(field: ApiCustomField): PaperlessCustomFieldDefinition {
  return {
    id: `remote-custom-field-${field.id}`,
    remoteId: field.id,
    name: field.name,
    dataType: field.data_type,
    selectOptions: field.extra_data?.select_options || [],
    defaultCurrency: field.extra_data?.default_currency || undefined,
    documentCount: field.document_count,
  };
}

function mapSavedView(view: ApiSavedView): PaperlessSavedView {
  return {
    id: `remote-saved-view-${view.id}`,
    remoteId: view.id,
    name: view.name,
    sortField: view.sort_field || 'added',
    sortReverse: Boolean(view.sort_reverse),
    filterRules: (view.filter_rules || []).map((rule) => ({
      ruleType: rule.rule_type,
      value: rule.value,
    })),
    pageSize: view.page_size || 50,
    displayMode: view.display_mode,
    displayFields: (view.display_fields || []).map(String),
  };
}

function mapNote(note: ApiNote): PaperlessNote {
  const fullName = [note.user?.first_name, note.user?.last_name].filter(Boolean).join(' ');
  return {
    id: note.id,
    note: note.note,
    created: note.created,
    author: fullName || note.user?.username || 'Paperless user',
  };
}

function mapVersion(version: ApiDocumentVersion): PaperlessDocumentVersion {
  return {
    id: version.id,
    added: version.added,
    versionLabel: version.version_label,
    checksum: version.checksum,
    isRoot: version.is_root,
  };
}

function formatBytes(bytes?: number) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAdded(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return `Today, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return date.toLocaleDateString([], {
    day: '2-digit',
    month: 'short',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
}

function mapDocument(document: ApiDocument, catalog: PaperlessCatalog): DocumentItem {
  const correspondent = catalog.correspondents.find((item) => item.remoteId === document.correspondent);
  const documentType = catalog.documentTypes.find((item) => item.remoteId === document.document_type);
  const storagePath = catalog.storagePaths.find((item) => item.remoteId === document.storage_path);
  const owner = catalog.owners.find((item) => item.remoteId === document.owner);
  const resolvedTags = document.tags
    .map((tagId) => catalog.tags.find((item) => item.remoteId === tagId))
    .filter((tag): tag is PaperlessOption => Boolean(tag));
  const content = document.content?.replace(/\s+/g, ' ').trim() || '';

  return {
    id: `remote-${document.id}`,
    remoteId: document.id,
    title: document.title || `Document ${document.id}`,
    correspondent: correspondent?.name || (document.correspondent ? 'Unknown correspondent' : 'No correspondent'),
    correspondentId: correspondent?.id,
    documentType: documentType?.name || (document.document_type ? 'Document' : 'Unsorted'),
    documentTypeId: documentType?.id,
    storagePath: storagePath?.name || (document.storage_path ? 'Unknown storage path' : 'Automatic'),
    storagePathId: storagePath?.id,
    created: document.created,
    added: formatAdded(document.added),
    addedAt: document.added,
    pageCount: document.page_count || 1,
    fileSize: formatBytes(document.archived_file_size || document.original_file_size),
    tags: resolvedTags.map((tag) => tag.name),
    tagIds: resolvedTags.map((tag) => tag.id),
    status: resolvedTags.some((tag) => tag.name.toLocaleLowerCase() === 'inbox')
      ? 'inbox'
      : 'archived',
    color: cardColors[document.id % cardColors.length],
    accent: '#354139',
    excerpt: content.slice(0, 220) || 'No extracted text',
    fullText: content || undefined,
    originalFileName: document.original_filename,
    mimeType: document.mime_type,
    modifiedAt: document.modified,
    owner: owner?.name,
    ownerId: owner?.id,
    canEdit: document.user_can_change !== false,
    deletedAt: document.deleted_at,
    archiveSerialNumber: document.archive_serial_number,
    customFields: (document.custom_fields || []).map((field): PaperlessCustomFieldValue => ({
      fieldId: `remote-custom-field-${field.field}`,
      fieldRemoteId: field.field,
      value: normalizeCustomFieldValue(field.value),
    })),
    notes: (document.notes || []).map(mapNote),
    versions: (document.versions || []).map(mapVersion),
    rootDocumentId: document.root_document || document.id,
    source: 'remote',
  };
}

export async function testPaperlessConnection(
  credentials: PaperlessCredentials,
): Promise<PaperlessConnectionInfo> {
  const response = await request(credentials, '/api/documents/?page_size=1&truncate_content=true');
  return {
    apiVersion: response.headers.get('X-Api-Version') || API_VERSION,
    serverVersion: response.headers.get('X-Version') || 'Unknown',
  };
}

export async function fetchPaperlessCreationCapabilities(
  credentials: PaperlessCredentials,
): Promise<PaperlessCreationCapabilities> {
  const settings = await getJson<ApiUiSettings>(credentials, '/api/ui_settings/');
  const permissions = new Set(settings.permissions || []);
  const canAdd = (permission: string) =>
    settings.user?.is_superuser === true || permissions.has(permission);

  return {
    tag: canAdd('add_tag'),
    correspondent: canAdd('add_correspondent'),
    documentType: canAdd('add_documenttype'),
  };
}

export async function fetchPaperlessWorkspace(
  credentials: PaperlessCredentials,
): Promise<PaperlessWorkspace> {
  const [
    documentsPage,
    correspondentsPage,
    documentTypesPage,
    tagsPage,
    storagePathsPage,
    ownersPage,
    customFieldsPage,
    savedViewsPage,
  ] = await Promise.all([
    getAllPages<ApiDocument>(
      credentials,
      '/api/documents/?page_size=100&ordering=-added&truncate_content=true',
    ),
    getAllPages<ApiNamedItem>(credentials, '/api/correspondents/?page_size=100&ordering=name'),
    getAllPages<ApiNamedItem>(credentials, '/api/document_types/?page_size=100&ordering=name'),
    getAllPages<ApiNamedItem>(credentials, '/api/tags/?page_size=100&ordering=name'),
    getAllPages<ApiNamedItem>(credentials, '/api/storage_paths/?page_size=100&ordering=name'),
    getAllPages<ApiUser>(credentials, '/api/users/?page_size=100&ordering=username')
      .catch(() => ({ results: [], total: 0 })),
    getAllPages<ApiCustomField>(credentials, '/api/custom_fields/?page_size=100&ordering=name'),
    getAllPages<ApiSavedView>(credentials, '/api/saved_views/?page_size=100&ordering=name'),
  ]);
  const catalog = buildCatalog(
    correspondentsPage.results,
    documentTypesPage.results,
    tagsPage.results,
    storagePathsPage.results,
    ownersPage.results,
    customFieldsPage.results,
    savedViewsPage.results,
  );

  return {
    catalog,
    documents: documentsPage.results.map((document) => mapDocument(document, catalog)),
    totalDocuments: documentsPage.total,
  };
}

export async function fetchPaperlessDocument(
  credentials: PaperlessCredentials,
  remoteId: number,
  catalog: PaperlessCatalog,
) {
  const document = await getJson<ApiDocument>(credentials, `/api/documents/${remoteId}/`);
  return mapDocument(document, catalog);
}

export async function updatePaperlessDocument(
  credentials: PaperlessCredentials,
  remoteId: number,
  changes: DocumentChanges,
) {
  const body: Record<string, unknown> = {};
  if (changes.title !== undefined) body.title = changes.title;
  if (changes.created !== undefined) body.created = changes.created;
  if (changes.correspondent !== undefined) body.correspondent = changes.correspondent?.remoteId ?? null;
  if (changes.documentType !== undefined) body.document_type = changes.documentType?.remoteId ?? null;
  if (changes.storagePath !== undefined) body.storage_path = changes.storagePath?.remoteId ?? null;
  if (changes.archiveSerialNumber !== undefined) {
    body.archive_serial_number = changes.archiveSerialNumber;
  }
  if (changes.customFields !== undefined) {
    body.custom_fields = changes.customFields.map((field) => ({
      field: field.fieldRemoteId,
      value: field.value,
    }));
  }
  if (changes.tags !== undefined) {
    body.tags = changes.tags
      .map((tag) => tag.remoteId)
      .filter((tagId): tagId is number => typeof tagId === 'number');
  }

  await sendJson<ApiDocument>(credentials, `/api/documents/${remoteId}/`, 'PATCH', body);
}

const creatableOptionConfig: Record<PaperlessCreatableOptionKind, {
  endpoint: string;
  noun: string;
  optionKind: string;
}> = {
  tag: { endpoint: '/api/tags/', noun: 'tag', optionKind: 'tag' },
  correspondent: {
    endpoint: '/api/correspondents/',
    noun: 'correspondent',
    optionKind: 'correspondent',
  },
  documentType: {
    endpoint: '/api/document_types/',
    noun: 'document type',
    optionKind: 'type',
  },
};

async function fetchPaperlessCreatableOptions(
  credentials: PaperlessCredentials,
  kind: PaperlessCreatableOptionKind,
) {
  const config = creatableOptionConfig[kind];
  const page = await getAllPages<ApiNamedItem>(
    credentials,
    `${config.endpoint}?page_size=100&ordering=name`,
  );
  return page.results.map((item) => toOption(config.optionKind, item));
}

export async function createPaperlessCatalogOption(
  credentials: PaperlessCredentials,
  kind: PaperlessCreatableOptionKind,
  name: string,
) {
  const config = creatableOptionConfig[kind];
  const normalized = name.trim();
  try {
    const item = await sendJson<ApiNamedItem>(credentials, config.endpoint, 'POST', {
      name: normalized,
    });
    return toOption(config.optionKind, item);
  } catch (error) {
    if (error instanceof PaperlessApiError && error.status === 400) {
      const options = await fetchPaperlessCreatableOptions(credentials, kind);
      const existing = options.find(
        (option) => option.name.trim().toLocaleLowerCase() === normalized.toLocaleLowerCase(),
      );
      if (existing) return existing;
      if (/unique|already exists|owner \/ name/i.test(error.message)) {
        throw new PaperlessApiError(
          `A ${config.noun} with this name already exists but is not available to this account.`,
          400,
        );
      }
    }
    throw error;
  }
}

export async function deletePaperlessDocument(credentials: PaperlessCredentials, remoteId: number) {
  await sendJson<void>(credentials, `/api/documents/${remoteId}/`, 'DELETE');
}

export async function reprocessPaperlessDocument(credentials: PaperlessCredentials, remoteId: number) {
  await sendJson<unknown>(credentials, '/api/documents/bulk_edit/', 'POST', {
    documents: [remoteId],
    method: 'reprocess',
    parameters: {},
  });
}

function normalizeCustomFieldValue(value: unknown): PaperlessCustomFieldValue['value'] {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is number => typeof item === 'number');
  }
  return String(value);
}

const savedViewRuleMap: Record<number, {
  parameter: string;
  multi?: boolean;
  boolean?: boolean;
  nullParameter?: string;
}> = {
    0: { parameter: 'title_search' },
    1: { parameter: 'content__icontains' },
    2: { parameter: 'archive_serial_number' },
    3: { parameter: 'correspondent__id', nullParameter: 'correspondent__isnull' },
    4: { parameter: 'document_type__id', nullParameter: 'document_type__isnull' },
    5: { parameter: 'is_in_inbox', boolean: true },
    6: { parameter: 'tags__id__all', multi: true },
    7: { parameter: 'is_tagged', boolean: true },
    8: { parameter: 'created__date__lt' },
    9: { parameter: 'created__date__gt' },
    10: { parameter: 'created__year' },
    11: { parameter: 'created__month' },
    12: { parameter: 'created__day' },
    13: { parameter: 'added__date__lt' },
    14: { parameter: 'added__date__gt' },
    15: { parameter: 'modified__date__lt' },
    16: { parameter: 'modified__date__gt' },
    17: { parameter: 'tags__id__none', multi: true },
    18: { parameter: 'archive_serial_number__isnull', boolean: true },
    19: { parameter: 'text' },
    20: { parameter: 'query' },
    21: { parameter: 'more_like_id' },
    22: { parameter: 'tags__id__in', multi: true },
    23: { parameter: 'archive_serial_number__gt' },
    24: { parameter: 'archive_serial_number__lt' },
    25: { parameter: 'storage_path__id', nullParameter: 'storage_path__isnull' },
    26: { parameter: 'correspondent__id__in', multi: true },
    27: { parameter: 'correspondent__id__none', multi: true },
    28: { parameter: 'document_type__id__in', multi: true },
    29: { parameter: 'document_type__id__none', multi: true },
    30: { parameter: 'storage_path__id__in', multi: true },
    31: { parameter: 'storage_path__id__none', multi: true },
    32: { parameter: 'owner__id' },
    33: { parameter: 'owner__id__in', multi: true },
    34: { parameter: 'owner__isnull', boolean: true },
    35: { parameter: 'owner__id__none', multi: true },
    36: { parameter: 'custom_fields__icontains' },
    37: { parameter: 'shared_by__id', multi: true },
    38: { parameter: 'custom_fields__id__all', multi: true },
    39: { parameter: 'custom_fields__id__in', multi: true },
    40: { parameter: 'custom_fields__id__none', multi: true },
    41: { parameter: 'has_custom_fields', boolean: true },
    42: { parameter: 'custom_field_query' },
    43: { parameter: 'created__date__lte' },
    44: { parameter: 'created__date__gte' },
    45: { parameter: 'added__date__lte' },
    46: { parameter: 'added__date__gte' },
    47: { parameter: 'mime_type' },
    48: { parameter: 'title_search' },
    49: { parameter: 'text' },
};

function appendSavedViewRules(params: URLSearchParams, rules: PaperlessSavedViewRule[]) {
  for (const rule of rules) {
    const mapping = savedViewRuleMap[rule.ruleType];
    if (!mapping) continue;
    if (mapping.nullParameter && rule.value === null) {
      params.set(mapping.nullParameter, '1');
      continue;
    }
    if (mapping.nullParameter && rule.value === '-1') {
      params.set(mapping.nullParameter, '0');
      continue;
    }
    if (rule.value === null) continue;
    const value = mapping.boolean
      ? rule.value === 'true' || rule.value === '1' ? '1' : '0'
      : rule.value;
    if (mapping.multi && params.has(mapping.parameter)) {
      params.set(mapping.parameter, `${params.get(mapping.parameter)},${value}`);
    } else {
      params.set(mapping.parameter, value);
    }
  }
}

function savedViewQuery(view: PaperlessSavedView) {
  const params = new URLSearchParams();
  appendSavedViewRules(params, view.filterRules);

  params.set('page_size', String(Math.max(view.pageSize, 100)));
  params.set('truncate_content', 'true');
  if (view.sortField) {
    params.set('ordering', `${view.sortReverse ? '-' : ''}${view.sortField}`);
  }
  return params.toString();
}

function selectedRemoteIds(ids: string[], options: PaperlessOption[]) {
  const selected = new Set(ids);
  return options
    .filter((option) => selected.has(option.id) && option.remoteId !== undefined)
    .map((option) => option.remoteId!);
}

function setIdFilter(
  params: URLSearchParams,
  ids: string[],
  options: PaperlessOption[],
  includeParameter: string,
  excludeParameter: string,
  mode: 'include' | 'exclude',
) {
  const remoteIds = selectedRemoteIds(ids, options);
  if (!remoteIds.length) return;
  params.set(mode === 'include' ? includeParameter : excludeParameter, remoteIds.join(','));
}

function appendLibraryFilters(
  params: URLSearchParams,
  filters: LibraryFilters,
  catalog: PaperlessCatalog,
) {
  if (filters.status === 'inbox') params.set('is_in_inbox', '1');
  if (filters.status === 'tagged') params.set('is_tagged', '1');
  if (filters.status === 'untagged') params.set('is_tagged', '0');

  if (filters.correspondentMissing) {
    params.set('correspondent__isnull', filters.correspondentMode === 'include' ? '1' : '0');
  } else {
    setIdFilter(
      params,
      filters.correspondentIds,
      catalog.correspondents,
      'correspondent__id__in',
      'correspondent__id__none',
      filters.correspondentMode,
    );
  }
  if (filters.documentTypeMissing) {
    params.set('document_type__isnull', filters.documentTypeMode === 'include' ? '1' : '0');
  } else {
    setIdFilter(
      params,
      filters.documentTypeIds,
      catalog.documentTypes,
      'document_type__id__in',
      'document_type__id__none',
      filters.documentTypeMode,
    );
  }
  if (filters.storagePathMissing) {
    params.set('storage_path__isnull', filters.storagePathMode === 'include' ? '1' : '0');
  } else {
    setIdFilter(
      params,
      filters.storagePathIds,
      catalog.storagePaths,
      'storage_path__id__in',
      'storage_path__id__none',
      filters.storagePathMode,
    );
  }
  if (filters.ownerMissing) {
    params.set('owner__isnull', filters.ownerMode === 'include' ? '1' : '0');
  } else {
    setIdFilter(
      params,
      filters.ownerIds,
      catalog.owners,
      'owner__id__in',
      'owner__id__none',
      filters.ownerMode,
    );
  }

  const tagIds = selectedRemoteIds(filters.tagIds, catalog.tags);
  if (tagIds.length) {
    params.set(
      filters.tagMode === 'all'
        ? 'tags__id__all'
        : filters.tagMode === 'none'
          ? 'tags__id__none'
          : 'tags__id__in',
      tagIds.join(','),
    );
  }

  const customFieldOptions = catalog.customFields.map((field) => ({
    id: field.id,
    remoteId: field.remoteId,
    name: field.name,
  }));
  const customFieldIds = selectedRemoteIds(filters.customFieldIds, customFieldOptions);
  if (customFieldIds.length) {
    params.set(
      filters.customFieldMode === 'all'
        ? 'custom_fields__id__all'
        : filters.customFieldMode === 'none'
          ? 'custom_fields__id__none'
          : 'custom_fields__id__in',
      customFieldIds.join(','),
    );
  }

  if (filters.mimeTypes.length === 1) params.set('mime_type', filters.mimeTypes[0]);
  if (filters.createdAfter) params.set('created__date__gte', filters.createdAfter);
  if (filters.createdBefore) params.set('created__date__lte', filters.createdBefore);
  if (filters.addedAfter) params.set('added__date__gte', filters.addedAfter);
  if (filters.addedBefore) params.set('added__date__lte', filters.addedBefore);
  if (filters.modifiedAfter) params.set('modified__date__gte', filters.modifiedAfter);
  if (filters.modifiedBefore) params.set('modified__date__lte', filters.modifiedBefore);
  if (filters.archiveSerialMissing) {
    params.set('archive_serial_number__isnull', '1');
  } else {
    if (filters.archiveSerialMin) params.set('archive_serial_number__gt', filters.archiveSerialMin);
    if (filters.archiveSerialMax) params.set('archive_serial_number__lt', filters.archiveSerialMax);
  }
}

function libraryQuery(request: PaperlessLibraryRequest, catalog: PaperlessCatalog) {
  const params = new URLSearchParams();
  appendSavedViewRules(params, request.extraRules || []);
  appendLibraryFilters(params, request.filters, catalog);
  if (request.query.trim()) params.set('query', request.query.trim());
  params.set('page_size', '100');
  params.set('truncate_content', 'true');
  return params.toString();
}

export async function fetchPaperlessLibraryDocuments(
  credentials: PaperlessCredentials,
  request: PaperlessLibraryRequest,
  catalog: PaperlessCatalog,
): Promise<PaperlessWorkspace> {
  const page = await getAllPages<ApiDocument>(
    credentials,
    `/api/documents/?${libraryQuery(request, catalog)}`,
  );
  const documents = page.results
    .map((document) => mapDocument(document, catalog))
    .filter((document) => matchesLibraryFilters(document, request.filters));
  return { catalog, documents, totalDocuments: documents.length };
}

export async function fetchPaperlessSavedViewDocuments(
  credentials: PaperlessCredentials,
  view: PaperlessSavedView,
  catalog: PaperlessCatalog,
) {
  const page = await getAllPages<ApiDocument>(credentials, `/api/documents/?${savedViewQuery(view)}`);
  return {
    documents: page.results.map((document) => mapDocument(document, catalog)),
    totalDocuments: page.total,
  };
}

export async function fetchPaperlessTrash(
  credentials: PaperlessCredentials,
  catalog: PaperlessCatalog,
): Promise<PaperlessTrashWorkspace> {
  const page = await getAllPages<ApiDocument>(
    credentials,
    '/api/trash/?page_size=100&ordering=-deleted_at&truncate_content=true',
  );
  return {
    documents: page.results.map((document) => mapDocument(document, catalog)),
    totalDocuments: page.total,
  };
}

export async function restorePaperlessTrash(credentials: PaperlessCredentials, remoteIds: number[]) {
  await sendJson(credentials, '/api/trash/', 'POST', { documents: remoteIds, action: 'restore' });
}

export async function emptyPaperlessTrash(credentials: PaperlessCredentials, remoteIds?: number[]) {
  await sendJson(credentials, '/api/trash/', 'POST', {
    ...(remoteIds ? { documents: remoteIds } : {}),
    action: 'empty',
  });
}

export async function addPaperlessNote(
  credentials: PaperlessCredentials,
  remoteId: number,
  note: string,
) {
  const result = await sendJson<ApiNote[]>(
    credentials,
    `/api/documents/${remoteId}/notes/`,
    'POST',
    { note },
  );
  const created = result.find((item) => item.note === note) || result[0];
  if (!created) throw new PaperlessApiError('Paperless saved the note but did not return it.');
  return mapNote(created);
}

export async function deletePaperlessNote(
  credentials: PaperlessCredentials,
  remoteId: number,
  noteId: number | string,
) {
  await sendJson<void>(
    credentials,
    `/api/documents/${remoteId}/notes/?id=${encodeURIComponent(String(noteId))}`,
    'DELETE',
  );
}

export async function uploadPaperlessVersion(
  credentials: PaperlessCredentials,
  remoteId: number,
  file: PaperlessUploadFile,
  versionLabel?: string,
  options?: PaperlessUploadOptions,
) {
  const parameters: Record<string, string> = {};
  if (versionLabel?.trim()) parameters.version_label = versionLabel.trim();
  const result = await uploadPaperlessMultipart<string>(
    credentials,
    `/api/documents/${remoteId}/update_version/`,
    file,
    parameters,
    options,
  );
  if (!result) throw new PaperlessApiError('Paperless accepted the version but returned no task ID.');
  return result;
}

export async function renamePaperlessVersion(
  credentials: PaperlessCredentials,
  rootId: number,
  versionId: number,
  versionLabel: string,
) {
  const result = await sendJson<ApiDocumentVersion>(
    credentials,
    `/api/documents/${rootId}/versions/${versionId}/`,
    'PATCH',
    { version_label: versionLabel.trim() },
  );
  return mapVersion(result);
}

export async function deletePaperlessVersion(
  credentials: PaperlessCredentials,
  rootId: number,
  versionId: number,
) {
  await sendJson(credentials, `/api/documents/${rootId}/versions/${versionId}/`, 'DELETE');
}

export async function uploadToPaperless(
  credentials: PaperlessCredentials,
  file: PaperlessUploadFile,
  title?: string,
  options?: PaperlessUploadOptions,
) {
  const parameters: Record<string, string> = {};
  if (title) parameters.title = title;
  const result = await uploadPaperlessMultipart<string | { task_id?: string; id?: string }>(
    credentials,
    '/api/documents/post_document/',
    file,
    parameters,
    options,
  );
  const taskId = typeof result === 'string' ? result : result.task_id || result.id;
  if (!taskId) throw new PaperlessApiError('Paperless accepted the file but returned no task ID.');
  return taskId;
}

function documentIdFromTask(task: ApiTask) {
  if (typeof task.related_document === 'number') return task.related_document;
  if (typeof task.related_document === 'string' && /^\d+$/.test(task.related_document)) {
    return Number(task.related_document);
  }
  if (task.result && typeof task.result === 'object') {
    const result = task.result as Record<string, unknown>;
    const candidate = result.document_id || result.document || result.related_document;
    if (typeof candidate === 'number') return candidate;
    if (typeof candidate === 'string' && /^\d+$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}

export async function fetchPaperlessTask(credentials: PaperlessCredentials, taskId: string) {
  const page = await getJson<ApiList<ApiTask>>(
    credentials,
    `/api/tasks/?task_id=${encodeURIComponent(taskId)}&page_size=1`,
  );
  const task = page.results[0];
  if (!task) return null;
  return {
    taskId: task.task_id || String(task.id || taskId),
    status: String(task.status || task.state || 'PENDING').toUpperCase(),
    documentId: documentIdFromTask(task),
    message: task.message || task.messages?.join(' '),
  } satisfies PaperlessTask;
}

export async function waitForPaperlessTask(
  credentials: PaperlessCredentials,
  taskId: string,
  options: { attempts?: number; intervalMs?: number } = {},
) {
  const attempts = options.attempts ?? 60;
  const intervalMs = options.intervalMs ?? 1_500;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const task = await fetchPaperlessTask(credentials, taskId);
    if (task?.status === 'SUCCESS') return task;
    if (task && ['FAILURE', 'FAILED', 'REVOKED'].includes(task.status)) {
      throw new PaperlessApiError(task.message || 'Paperless could not process this document.');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new PaperlessApiError(
    'Paperless is still processing this document. Pull to refresh in a moment.',
  );
}
