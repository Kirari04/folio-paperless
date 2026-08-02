import { File, Paths } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
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
import { getNativeMtlsTransport } from '@/lib/auth/native-mtls-module';
import { assertNativeMtlsRequestUrl, validateNativeMtlsResponseUrl } from '@/lib/auth/native-mtls-adapter';
import { NativeMtlsCapabilityError } from '@/lib/auth/session';
import { serializeUploadMetadata } from '@/lib/upload-metadata';
import { buildVisibleTagOptions } from '@/lib/tag-hierarchy';
import {
  appendPaperlessSavedViewRules,
  isFolioEditableSavedViewRule,
} from '@/lib/saved-view-controller';
import { translateRuntime } from '../i18n/runtime.ts';
import type { UploadMetadataDraft } from '@/types/tasks';
import {
  DOWNLOAD_STORAGE_RESERVE_BYTES,
  effectiveDownloadLimit,
  MAX_DOCUMENT_DOWNLOAD_BYTES,
} from '@/lib/download-policy';

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
  parent?: number | null;
  children?: number[];
  is_inbox_tag?: boolean;
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
  duplicate_documents?: unknown;
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

type ApiSavedView = Record<string, unknown> & {
  id: number;
  name: string;
  sort_field?: string;
  sort_reverse?: boolean;
  filter_rules?: ({ rule_type: number; value: string | null } & Record<string, unknown>)[];
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
  duplicateDocumentIds?: number[];
  message?: string;
};

type ApiTask = {
  task_id?: string;
  id?: string | number;
  status?: string;
  status_display?: string;
  state?: string;
  related_document?: number | string | null;
  result?: unknown;
  result_data?: unknown;
  related_document_ids?: unknown;
  duplicate_document_ids?: unknown;
  duplicate_documents?: unknown;
  duplicates?: unknown;
  duplicate_of?: unknown;
  message?: string;
  messages?: string[];
};

const API_VERSION = '10';
const REQUEST_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
export const MAX_PAPERLESS_API_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_UPLOAD_RESPONSE_BYTES = 1024 * 1024;
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
  duplicateDocumentIds?: number[];

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

function mergeCredentialHeaders(
  base: Record<string, string>,
  customHeaders: Record<string, string> = {},
) {
  const merged = new Map<string, [string, string]>();
  Object.entries(base).forEach(([name, value]) => merged.set(name.toLocaleLowerCase(), [name, value]));
  Object.entries(customHeaders).forEach(([name, value]) => {
    merged.set(name.toLocaleLowerCase(), [name, value]);
  });
  return Object.fromEntries(merged.values());
}

export function paperlessRequestHeaders(
  credentials: PaperlessCredentials,
  accept = `application/json; version=${API_VERSION}`,
) {
  return mergeCredentialHeaders({
    Accept: accept,
    ...(credentials.token.trim()
      ? { Authorization: `${credentials.authorizationScheme ?? 'Token'} ${credentials.token.trim()}` }
      : {}),
  }, credentials.customHeaders);
}

export function paperlessFileHeaders(token: string): Record<string, string> {
  return {
    Accept: '*/*',
    Authorization: `Token ${token.trim()}`,
  };
}

export function paperlessCredentialFileHeaders(credentials: PaperlessCredentials) {
  return paperlessRequestHeaders(credentials, '*/*');
}

/**
 * Confines an authenticated file request to the configured Paperless origin
 * and installation subpath. This is intentionally separate from a generic
 * same-origin check: reverse proxies commonly host Paperless below a path, and
 * credentials must never be attached to a sibling application on that origin.
 */
export function assertPaperlessResourceUrl(serverUrl: string, requestUrl: string) {
  const base = new URL(normalizeServerUrl(serverUrl));
  let target: URL;
  try {
    target = new URL(requestUrl);
  } catch {
    throw new PaperlessApiError('Paperless returned an invalid file URL.');
  }
  const basePath = base.pathname.replace(/\/+$/, '');
  const targetInBasePath = basePath === ''
    || target.pathname === basePath
    || target.pathname.startsWith(`${basePath}/`);
  if (
    target.protocol !== base.protocol
    || !['http:', 'https:'].includes(target.protocol)
    || target.origin !== base.origin
    || target.username
    || target.password
    || target.hash
    || !targetInBasePath
  ) {
    throw new PaperlessApiError(
      'Folio refused to send Paperless credentials outside the configured server and subpath.',
    );
  }
  return target.toString();
}

export function usesNativeMutualTls(credentials: PaperlessCredentials) {
  return typeof credentials.clientIdentityRef === 'string' && credentials.clientIdentityRef.length > 0;
}

async function withNativeMtlsSession<T>(
  credentials: PaperlessCredentials,
  operation: (session: import('./auth/session').AuthenticatedProfileSession) => Promise<T>,
): Promise<T> {
  if (!usesNativeMutualTls(credentials)) {
    throw new NativeMtlsCapabilityError(
      'native-mtls-transport-unavailable',
      'This Paperless connection has no saved client identity.',
    );
  }
  if (!credentials.profileId?.trim()) {
    throw new NativeMtlsCapabilityError(
      'client-identity-request-failed',
      'A stable profile ID is required for a mutual-TLS request.',
    );
  }
  const transport = getNativeMtlsTransport();
  if (!transport || !(await transport.isAvailable())) {
    throw new NativeMtlsCapabilityError(
      'native-mtls-transport-unavailable',
      'This build has no certificate-aware native transport.',
    );
  }
  const session = await transport.openAuthenticatedSession({
    profileId: credentials.profileId,
    clientIdentityRef: credentials.clientIdentityRef!,
    serverUrl: credentials.serverUrl,
  });
  try {
    return await operation(session);
  } finally {
    await session.dispose();
  }
}

function responseFromNative(
  requestUrl: string,
  native: import('./auth/session').NativeMtlsHttpResponse,
) {
  validateNativeMtlsResponseUrl(requestUrl, native.responseUrl);
  return new Response(
    native.status === 204 || native.status === 205 ? null : native.body,
    { status: native.status, headers: native.headers as Record<string, string> },
  );
}

export async function downloadPaperlessFileWithCredentials(
  credentials: PaperlessCredentials,
  requestUrl: string,
  destinationUri: string,
  options: {
    signal?: AbortSignal;
    onProgress?: (fraction: number | null) => void;
    maxBytes?: number;
  } = {},
) {
  const url = assertNativeMtlsRequestUrl(credentials.serverUrl, requestUrl);
  const maxBytes = effectiveDownloadLimit({
    maxBytes: options.maxBytes ?? MAX_DOCUMENT_DOWNLOAD_BYTES,
    availableBytes: Paths.availableDiskSpace,
    reserveBytes: DOWNLOAD_STORAGE_RESERVE_BYTES,
  });
  return withNativeMtlsSession(credentials, async (session) => {
    const response = await session.download({
      url,
      method: 'GET',
      headers: paperlessCredentialFileHeaders(credentials),
      destinationUri,
      maxBytes,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    validateNativeMtlsResponseUrl(url, response.responseUrl);
    return response;
  });
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

export async function readPaperlessResponseTextWithinLimit(
  response: Pick<Response, 'body' | 'headers' | 'text'>,
  maxBytes = MAX_PAPERLESS_API_RESPONSE_BYTES,
) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PaperlessApiError('Paperless returned a response that exceeds Folio\'s safety limit.');
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new PaperlessApiError('Paperless returned a response that exceeds Folio\'s safety limit.');
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PaperlessApiError('Paperless returned a response that exceeds Folio\'s safety limit.');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

function configuredPaperlessRequestUrl(credentials: PaperlessCredentials, path: string) {
  const baseUrl = normalizeServerUrl(credentials.serverUrl);
  const base = new URL(baseUrl);
  const target = /^https?:/i.test(path) ? new URL(path) : new URL(`${baseUrl}${path}`);
  const apiPrefix = `${base.pathname.replace(/\/+$/, '')}/api/`.replace(/^\/\//, '/');
  if (
    (!/^https?:/i.test(path) && !path.startsWith('/api/'))
    || target.origin !== base.origin
    || !target.pathname.startsWith(apiPrefix)
    || target.username
    || target.password
  ) {
    throw new PaperlessApiError('Folio refused a Paperless request outside the configured API origin.');
  }
  return target.toString();
}

function uploadFileError(error: unknown) {
  if (error instanceof NativeMtlsCapabilityError) {
    return paperlessNativeMtlsError(error);
  }
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

function paperlessNativeMtlsError(error: NativeMtlsCapabilityError) {
  switch (error.code) {
    case 'client-identity-expired':
      return new PaperlessApiError(
        'The saved client certificate has expired. Select a replacement in connection settings.',
      );
    case 'client-identity-not-yet-valid':
      return new PaperlessApiError(
        'The saved client certificate is not valid yet. Check the device clock or select a replacement.',
      );
    case 'client-identity-not-found':
    case 'client-identity-missing-private-key':
      return new PaperlessApiError(
        'The saved client identity is no longer available. Select or import a replacement in connection settings.',
      );
    case 'native-mtls-transport-unavailable':
      return new PaperlessApiError(
        'This build cannot make certificate-aware requests. Use a supported native build.',
      );
    case 'client-identity-origin-mismatch':
      return new PaperlessApiError(
        'Folio refused to present the client identity outside the saved HTTPS server.',
      );
    case 'client-identity-selection-canceled':
    case 'client-identity-request-canceled':
      return new PaperlessApiError('The certificate-aware request was canceled.');
    case 'client-identity-import-failed':
      return new PaperlessApiError(
        'The client identity could not be imported. Check the PKCS#12 file and password.',
      );
    case 'client-identity-request-failed':
      return new PaperlessApiError(
        'The certificate-aware request failed. Check the client identity and server TLS configuration.',
      );
  }
}

async function uploadPaperlessMultipart<T>(
  credentials: PaperlessCredentials,
  path: string,
  file: PaperlessUploadFile,
  parameters: Record<string, string>,
  options: PaperlessUploadOptions = {},
) {
  return uploadPaperlessFormData<T>(credentials, path, file, Object.entries(parameters), options);
}

async function uploadPaperlessFormData<T>(
  credentials: PaperlessCredentials,
  path: string,
  file: PaperlessUploadFile,
  parameters: readonly (readonly [string, string])[],
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
  const form = new FormData();
  form.append('document', uploadFile as unknown as Blob, file.name);
  for (const [name, value] of parameters) form.append(name, value);
  options.onProgress?.(0);

  try {
    if (usesNativeMutualTls(credentials)) {
      const requestUrl = `${normalizeServerUrl(credentials.serverUrl)}${path}`;
      const response = await withNativeMtlsSession(credentials, (session) =>
        session.uploadMultipart({
          url: assertNativeMtlsRequestUrl(credentials.serverUrl, requestUrl),
          method: 'POST',
          headers: paperlessRequestHeaders(credentials),
          fileUri: uploadFile.uri,
          fieldName: 'document',
          fileName: file.name,
          mimeType: file.mimeType || uploadFile.type || 'application/octet-stream',
          parameters,
          signal: controller.signal,
          onProgress: (fraction) => options.onProgress?.(fraction ?? 0),
        }),
      );
      validateNativeMtlsResponseUrl(requestUrl, response.responseUrl);
      if (new TextEncoder().encode(response.body).byteLength > MAX_UPLOAD_RESPONSE_BYTES) {
        throw new PaperlessApiError('Paperless returned an oversized upload response.');
      }
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
    }
    // expo/fetch streams native File instances without materializing the whole
    // upload in JavaScript. Fetch does not currently expose upload byte events,
    // so the durable task reports an honest indeterminate uploading state.
    const response = await expoFetch(`${normalizeServerUrl(credentials.serverUrl)}${path}`, {
      method: 'POST',
      headers: paperlessRequestHeaders(credentials),
      body: form,
      redirect: 'manual',
      signal: controller.signal,
    });
    const body = await readPaperlessResponseTextWithinLimit(response, MAX_UPLOAD_RESPONSE_BYTES);
    if (!response.ok) {
      throw new PaperlessApiError(readableError(response.status, readUploadError(body)), response.status);
    }
    options.onProgress?.(1);
    try {
      return JSON.parse(body) as T;
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

export async function requestPaperlessRawResponse(
  credentials: PaperlessCredentials,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (init.signal?.aborted) controller.abort();
  else init.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const url = configuredPaperlessRequestUrl(credentials, path);

  try {
    const headerInput = new Headers(paperlessRequestHeaders(credentials));
    new Headers(init.headers).forEach((value, name) => headerInput.set(name, value));
    const headers: Record<string, string> = {};
    new Headers(headerInput).forEach((value, name) => {
      headers[name] = value;
    });
    const response = usesNativeMutualTls(credentials)
      ? await withNativeMtlsSession(credentials, async (session) => {
          const method = (init.method ?? 'GET').toUpperCase();
          if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) {
            throw new PaperlessApiError('This request uses an unsupported HTTP method.');
          }
          if (init.body !== undefined && typeof init.body !== 'string') {
            throw new PaperlessApiError('This request body cannot use the native mutual-TLS transport.');
          }
          const requestUrl = assertNativeMtlsRequestUrl(credentials.serverUrl, url);
          const native = await session.request({
            url: requestUrl,
            method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS',
            headers,
            ...(typeof init.body === 'string' ? { body: init.body } : {}),
            signal: controller.signal,
          });
          return responseFromNative(requestUrl, native);
        })
      : await fetch(url, {
          ...init,
          redirect: 'manual',
          signal: controller.signal,
          headers,
        });
    if (!usesNativeMutualTls(credentials)) {
      if (response.status >= 300 && response.status < 400) {
        throw new PaperlessApiError('Paperless redirected an authenticated API request; Folio did not forward credentials.');
      }
      if (response.url) configuredPaperlessRequestUrl(credentials, response.url);
    }
    if (response.status === 204 || response.status === 205 || init.method?.toUpperCase() === 'HEAD') {
      return response;
    }
    const body = await readPaperlessResponseTextWithinLimit(response);
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    if (error instanceof PaperlessApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new PaperlessApiError('The Paperless server took too long to respond. Try again.');
    }
    if (error instanceof NativeMtlsCapabilityError) {
      throw paperlessNativeMtlsError(error);
    }
    throw new PaperlessApiError(
      Platform.OS === 'ios'
        ? 'Could not reach this Paperless server. Check local-network permission and use HTTPS with a certificate trusted by this device.'
        : 'Could not reach this Paperless server. Check the address, network, and HTTPS certificate.',
    );
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', abort);
  }
}

export async function requestPaperlessResponse(
  credentials: PaperlessCredentials,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await requestPaperlessRawResponse(credentials, path, init);
  if (!response.ok) {
    throw new PaperlessApiError(
      readableError(response.status, await readError(response)),
      response.status,
    );
  }
  return response;
}

async function getJson<T>(credentials: PaperlessCredentials, path: string): Promise<T> {
  const response = await requestPaperlessResponse(credentials, path);
  return response.json() as Promise<T>;
}

async function sendJson<T>(
  credentials: PaperlessCredentials,
  path: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const response = await requestPaperlessResponse(credentials, path, {
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
  const basePath = base.pathname.replace(/\/+$/, '');
  const apiPrefix = `${basePath}/api/`.replace(/^\/\//, '/');
  if (!target.pathname.startsWith(apiPrefix)) {
    throw new PaperlessApiError('Paperless returned an invalid pagination address.');
  }
  return `${target.pathname.slice(basePath.length)}${target.search}`;
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
  workflows: ApiNamedItem[] = [],
): PaperlessCatalog {
  return {
    correspondents: correspondents.map((item) => toOption('correspondent', item)),
    documentTypes: documentTypes.map((item) => toOption('type', item)),
    tags: buildVisibleTagOptions(tags),
    storagePaths: storagePaths.map((item) => toOption('storage-path', item)),
    owners: owners.map((owner) => ({
      id: `remote-owner-${owner.id}`,
      remoteId: owner.id,
      name: [owner.first_name, owner.last_name].filter(Boolean).join(' ') || owner.username,
    })),
    workflows: workflows.map((item) => toOption('workflow', item)),
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
  const {
    id,
    name,
    sort_field: sortField,
    sort_reverse: sortReverse,
    filter_rules: filterRules,
    page_size: pageSize,
    display_mode: displayMode,
    display_fields: displayFields,
    ...extra
  } = view;
  return {
    id: `remote-saved-view-${id}`,
    remoteId: id,
    name,
    sortField: sortField || 'added',
    sortReverse: Boolean(sortReverse),
    filterRules: (filterRules || []).map((rule) => {
      const { rule_type: ruleType, value, ...extra } = rule;
      return {
        ruleType,
        value,
        known: isFolioEditableSavedViewRule(ruleType, value),
        extra: Object.freeze(extra),
      };
    }),
    pageSize: pageSize || 50,
    displayMode,
    displayFields: (displayFields || []).map(String),
    extra: Object.freeze(extra),
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

function mapDocument(document: ApiDocument, catalog: PaperlessCatalog): DocumentItem {
  const correspondent = catalog.correspondents.find((item) => item.remoteId === document.correspondent);
  const documentType = catalog.documentTypes.find((item) => item.remoteId === document.document_type);
  const storagePath = catalog.storagePaths.find((item) => item.remoteId === document.storage_path);
  const owner = catalog.owners.find((item) => item.remoteId === document.owner);
  const resolvedTags = document.tags
    .map((tagId) => catalog.tags.find((item) => item.remoteId === tagId))
    .filter((tag): tag is PaperlessOption => Boolean(tag));
  const content = document.content?.replace(/\s+/g, ' ').trim() || '';
  const fileSizeBytes = document.archived_file_size || document.original_file_size;

  return {
    id: `remote-${document.id}`,
    remoteId: document.id,
    title: document.title || translateRuntime('document.remoteTitle', { id: document.id }),
    correspondent: correspondent?.name || (document.correspondent
      ? translateRuntime('document.unknownCorrespondent')
      : translateRuntime('document.noCorrespondent')),
    correspondentId: correspondent?.id,
    documentType: documentType?.name || (document.document_type
      ? translateRuntime('document.remoteGenericType')
      : translateRuntime('document.unsorted')),
    documentTypeId: documentType?.id,
    storagePath: storagePath?.name || (document.storage_path
      ? translateRuntime('document.unknownStoragePath')
      : translateRuntime('document.automatic')),
    storagePathId: storagePath?.id,
    created: document.created,
    added: document.added,
    addedAt: document.added,
    pageCount: document.page_count || 1,
    fileSize: formatBytes(fileSizeBytes),
    ...(fileSizeBytes ? { fileSizeBytes } : {}),
    tags: resolvedTags.map((tag) => tag.name),
    tagIds: resolvedTags.map((tag) => tag.id),
    status: resolvedTags.some((tag) => tag.name.toLocaleLowerCase() === 'inbox')
      ? 'inbox'
      : 'archived',
    color: cardColors[document.id % cardColors.length],
    accent: '#354139',
    excerpt: content.slice(0, 220) || translateRuntime('document.noExtractedText'),
    fullText: content || undefined,
    originalFileName: document.original_filename,
    mimeType: document.mime_type,
    modifiedAt: document.modified,
    owner: owner?.name,
    ownerId: owner?.id,
    // Paperless applies view permissions to the documents queryset. Presence
    // in this authenticated response is the authoritative visibility signal;
    // older cached rows without this field fail closed in OS search.
    canView: true,
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
    ...(positiveIntegerIds(document.duplicate_documents).length
      ? { duplicateDocumentIds: positiveIntegerIds(document.duplicate_documents) }
      : {}),
  };
}

export async function testPaperlessConnection(
  credentials: PaperlessCredentials,
): Promise<PaperlessConnectionInfo> {
  const response = await requestPaperlessResponse(credentials, '/api/documents/?page_size=1&truncate_content=true');
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
    uploadDocument: canAdd('add_document'),
    // Assigning an arbitrary owner changes document ownership and is more
    // privileged than merely creating a document. Fail closed only when the
    // server explicitly reports the permission absent.
    assignOwner: canAdd('change_document'),
    // Paperless 3.0.5's documented PostDocumentSerializer has no workflow
    // override field. Keep this false until schema negotiation discovers and
    // names an actual supported multipart parameter.
    uploadWorkflowOverride: false,
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
    workflowsPage,
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
    getAllPages<ApiNamedItem>(credentials, '/api/workflows/?page_size=100&ordering=name')
      .catch(() => ({ results: [], total: 0 })),
  ]);
  const catalog = buildCatalog(
    correspondentsPage.results,
    documentTypesPage.results,
    tagsPage.results,
    storagePathsPage.results,
    ownersPage.results,
    customFieldsPage.results,
    savedViewsPage.results,
    workflowsPage.results,
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

/** Paperless 3.0.5 always assigns API uploads to the requesting user and does
 * not accept `owner` in PostDocumentSerializer. Apply an explicitly requested
 * owner only after consumption produced a real document, then verify it with
 * an independent read so the queue never claims metadata the server ignored. */
export async function applyPaperlessUploadOwner(
  credentials: PaperlessCredentials,
  remoteId: number,
  metadata: UploadMetadataDraft | undefined,
  capabilities: PaperlessCreationCapabilities,
) {
  const requestedOwner = metadata?.owner;
  if (!requestedOwner || requestedOwner.state === 'unset') return false;
  if (capabilities.assignOwner !== true) {
    throw new PaperlessApiError(
      translateRuntime('runtimeError.uploadOwnerPermission'),
      403,
    );
  }
  const ownerId = requestedOwner.state === 'clear'
    ? null
    : requestedOwner.value.remoteId;
  if (ownerId !== null && (!Number.isSafeInteger(ownerId) || (ownerId ?? 0) <= 0)) {
    throw new PaperlessApiError(translateRuntime('runtimeError.uploadOwnerStale'), 409);
  }
  await sendJson<ApiDocument>(credentials, `/api/documents/${remoteId}/`, 'PATCH', {
    owner: ownerId,
  });
  const verified = await getJson<ApiDocument>(credentials, `/api/documents/${remoteId}/`);
  if ((verified.owner ?? null) !== ownerId) {
    throw new PaperlessApiError(translateRuntime('runtimeError.uploadOwnerReadback'), 409);
  }
  return true;
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

function appendSavedViewRules(params: URLSearchParams, rules: PaperlessSavedViewRule[]) {
  appendPaperlessSavedViewRules(params, rules);
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
  if (request.query.trim()) {
    appendSavedViewRules(params, [{
      ruleType: request.queryRuleType ?? 49,
      value: request.query.trim(),
      known: true,
      extra: {},
    }]);
  }
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
  metadata?: string | UploadMetadataDraft,
  options?: PaperlessUploadOptions,
) {
  const parameters = typeof metadata === 'string'
    ? (metadata ? [['title', metadata] as const] : [])
    : metadata
      ? serializeUploadMetadata(metadata)
      : [];
  const result = await uploadPaperlessFormData<string | { task_id?: string; id?: string }>(
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
  if (task.result_data && typeof task.result_data === 'object') {
    const result = task.result_data as Record<string, unknown>;
    const candidate = result.document_id || result.document || result.related_document;
    if (typeof candidate === 'number') return candidate;
    if (typeof candidate === 'string' && /^\d+$/.test(candidate)) return Number(candidate);
  }
  return undefined;
}

function positiveIntegerIds(value: unknown): number[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return values.flatMap((entry) => {
    const candidate = entry && typeof entry === 'object'
      ? (entry as Record<string, unknown>).id
      : entry;
    if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0) {
      return [candidate];
    }
    if (typeof candidate === 'string' && /^\d+$/.test(candidate)) {
      const parsed = Number(candidate);
      return Number.isSafeInteger(parsed) && parsed > 0 ? [parsed] : [];
    }
    return [];
  });
}

function duplicateDocumentIdsFromTask(task: ApiTask, documentId?: number) {
  const records = [task, task.result, task.result_data]
    .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'));
  const ids = records.flatMap((record) => [
    ...positiveIntegerIds(record.duplicate_document_ids),
    ...positiveIntegerIds(record.duplicate_documents),
    ...positiveIntegerIds(record.duplicates),
    ...positiveIntegerIds(record.duplicate_of),
  ]);
  return [...new Set(ids)].filter((id) => id !== documentId);
}

function taskMessage(task: ApiTask) {
  if (task.message) return task.message;
  if (task.messages?.length) return task.messages.join(' ');
  if (task.result_data && typeof task.result_data === 'object') {
    const result = task.result_data as Record<string, unknown>;
    for (const candidate of [result.reason, result.error_message]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    if (positiveIntegerIds(result.duplicate_of).length) {
      return 'Paperless identified this file as a duplicate of an existing document.';
    }
  }
  return task.status_display;
}

export async function fetchPaperlessTask(credentials: PaperlessCredentials, taskId: string) {
  const page = await getJson<ApiList<ApiTask>>(
    credentials,
    `/api/tasks/?task_id=${encodeURIComponent(taskId)}&page_size=1`,
  );
  const task = page.results[0];
  if (!task) return null;
  const documentId = documentIdFromTask(task);
  const duplicateDocumentIds = duplicateDocumentIdsFromTask(task, documentId);
  return {
    taskId: task.task_id || String(task.id || taskId),
    status: String(task.status || task.state || 'PENDING').toUpperCase(),
    documentId,
    ...(duplicateDocumentIds.length ? { duplicateDocumentIds } : {}),
    message: taskMessage(task),
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
      const error = new PaperlessApiError(
        task.message || translateRuntime('runtimeError.paperlessProcess'),
      );
      error.duplicateDocumentIds = task.duplicateDocumentIds;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new PaperlessApiError(
    translateRuntime('runtimeError.paperlessStillProcessing'),
  );
}
