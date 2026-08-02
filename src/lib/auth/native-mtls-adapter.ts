import type {
  AuthenticatedPaperlessRequest,
  PaperlessRequest,
} from '../paperless-client';
import {
  ProfileConnectionTestError,
  testPaperlessProfileConnection,
  type ProfileConnectionDetails,
} from './fetch-adapter.ts';
import { normalizeServerBaseUrl, type ClientIdentityMetadata } from './profile-store.ts';
import {
  NativeMtlsCapabilityError,
  assertUsableClientIdentity,
  validateServerRedirect,
  type AuthenticatedProfileSession,
  type NativeMtlsHttpResponse,
  type NativeMtlsTransport,
} from './session.ts';

export type NativeMtlsCapability = {
  available: boolean;
  platform: string;
  reason?: string;
};

export const NATIVE_MTLS_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

function utf8ByteLengthExceeds(value: string, maximumBytes: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) bytes += 1;
    else if (codeUnit <= 0x7ff) bytes += 2;
    else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > maximumBytes) return true;
  }
  return false;
}

export function assertBoundedNativeMtlsResponse(
  response: NativeMtlsHttpResponse,
  maximumBytes = NATIVE_MTLS_MAX_RESPONSE_BYTES,
): void {
  if (
    !response ||
    typeof response.body !== 'string' ||
    typeof response.responseUrl !== 'string' ||
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    typeof response.headers !== 'object' ||
    response.headers === null
  ) {
    throw new NativeMtlsCapabilityError(
      'client-identity-request-failed',
      'The certificate-aware native transport returned an invalid response.',
    );
  }
  if (utf8ByteLengthExceeds(response.body, maximumBytes)) {
    throw new NativeMtlsCapabilityError(
      'client-identity-request-failed',
      'The certificate-aware response exceeded Folio’s in-memory safety limit.',
    );
  }
}

function parseBody(value: string): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function responseHeaders(response: NativeMtlsHttpResponse): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value !== undefined) headers.append(name, value);
  }
  return headers;
}

/**
 * mTLS is meaningful only over HTTPS. Every native request is constrained to
 * the configured origin and base subpath before the OS identity can be used.
 */
export function assertNativeMtlsRequestUrl(serverUrl: string, requestUrl: string): string {
  const base = new URL(normalizeServerBaseUrl(serverUrl));
  if (base.protocol !== 'https:') {
    throw new NativeMtlsCapabilityError(
      'client-identity-origin-mismatch',
      'Mutual TLS requires an HTTPS Paperless server URL.',
    );
  }
  let target: URL;
  try {
    target = new URL(requestUrl);
  } catch {
    throw new NativeMtlsCapabilityError(
      'client-identity-origin-mismatch',
      'The mutual-TLS request URL is invalid.',
    );
  }
  const basePath = base.pathname.replace(/\/+$/, '');
  const targetInBasePath =
    basePath === '' || target.pathname === basePath || target.pathname.startsWith(`${basePath}/`);
  if (
    target.protocol !== 'https:' ||
    target.origin !== base.origin ||
    target.username ||
    target.password ||
    target.hash ||
    !targetInBasePath
  ) {
    throw new NativeMtlsCapabilityError(
      'client-identity-origin-mismatch',
      'Folio refused to present a client identity outside its saved HTTPS server and subpath.',
    );
  }
  return target.toString();
}

export function validateNativeMtlsResponseUrl(
  requestUrl: string,
  responseUrl: string,
): void {
  if (!responseUrl || responseUrl === requestUrl) return;
  try {
    validateServerRedirect(requestUrl, responseUrl);
  } catch {
    throw new NativeMtlsCapabilityError(
      'client-identity-origin-mismatch',
      'The server attempted an unsafe redirect while a client identity was active.',
    );
  }
  throw new NativeMtlsCapabilityError(
    'client-identity-origin-mismatch',
    'The native mutual-TLS transport does not follow redirects.',
  );
}

export function createNativeMtlsFetch(
  session: AuthenticatedProfileSession,
  serverUrl: string,
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const url = assertNativeMtlsRequestUrl(serverUrl, input);
    const method = (init.method ?? 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) {
      throw new NativeMtlsCapabilityError(
        'client-identity-request-failed',
        'The native mutual-TLS transport rejected an unsupported HTTP method.',
      );
    }
    if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
      throw new NativeMtlsCapabilityError(
        'client-identity-request-failed',
        'This mutual-TLS request body must be encoded before entering the native transport.',
      );
    }
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const nativeResponse = await session.request({
      url,
      method: method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS',
      headers,
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
    assertBoundedNativeMtlsResponse(nativeResponse);
    validateNativeMtlsResponseUrl(url, nativeResponse.responseUrl);
    return new Response(
      nativeResponse.status === 204 || nativeResponse.status === 205
        ? null
        : nativeResponse.body,
      {
        status: nativeResponse.status,
        headers: responseHeaders(nativeResponse),
      },
    );
  };
}

export function createNativeMtlsPaperlessRequest(
  session: AuthenticatedProfileSession,
  serverUrl: string,
): AuthenticatedPaperlessRequest {
  const baseUrl = normalizeServerBaseUrl(serverUrl);
  return async <T>(request: PaperlessRequest) => {
    const response = await createNativeMtlsFetch(session, baseUrl)(`${baseUrl}${request.path}`, {
      method: request.method,
      headers: request.headers,
      ...(request.json === undefined ? {} : { body: JSON.stringify(request.json) }),
      redirect: 'manual',
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return {
      status: response.status,
      headers: response.headers,
      data: parseBody(await response.text()) as T,
    };
  };
}

/**
 * Performs identity selection/reuse and the connection test through the same
 * native session that subsequent Paperless requests use.
 */
export async function prepareNativeMutualTls(
  input: {
    profileId: string;
    serverUrl: string;
    clientIdentityRef?: string;
    selectionMode?: 'reuse' | 'select' | 'import';
    releaseImportedIdentityIfUnused?: (clientIdentityRef: string) => Promise<void>;
    signal?: AbortSignal;
    now?: string;
  },
  transport: NativeMtlsTransport,
): Promise<{
  identity: ClientIdentityMetadata;
  clientIdentityRef: string;
  connection: ProfileConnectionDetails;
}> {
  const nativeTransport = await requireConfiguredNativeMtlsTransport(transport);
  if (input.signal?.aborted) {
    throw new NativeMtlsCapabilityError(
      'client-identity-request-canceled',
      'Client identity selection was canceled.',
    );
  }
  const existingIdentity = input.selectionMode !== 'select' && input.selectionMode !== 'import' && input.clientIdentityRef
    ? await nativeTransport.describeClientIdentity(input.clientIdentityRef)
    : null;
  const selected = input.selectionMode === 'import'
    ? await nativeTransport.importClientIdentity({ serverUrl: input.serverUrl })
    : existingIdentity && input.clientIdentityRef
    ? { identity: existingIdentity, clientIdentityRef: input.clientIdentityRef }
    : await nativeTransport.selectClientIdentity({
        serverUrl: input.serverUrl,
        ...(input.clientIdentityRef
          ? { suggestedClientIdentityRef: input.clientIdentityRef }
          : {}),
      });
  if (!selected) {
    throw new NativeMtlsCapabilityError(
      'client-identity-selection-canceled',
      'No client identity was selected.',
    );
  }
  let session: AuthenticatedProfileSession | null = null;
  let prepared = false;
  try {
    assertUsableClientIdentity(selected.identity, input.now ?? new Date().toISOString());
    session = await nativeTransport.openAuthenticatedSession({
      profileId: input.profileId,
      clientIdentityRef: selected.clientIdentityRef,
      serverUrl: input.serverUrl,
    });
    const connection = await testPaperlessProfileConnection(
      { serverUrl: input.serverUrl, token: '' },
      {
        fetchImpl: createNativeMtlsFetch(session, input.serverUrl),
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    prepared = true;
    return { ...selected, connection };
  } catch (error) {
    if (error instanceof NativeMtlsCapabilityError) {
      if (error.code === 'client-identity-expired') {
        throw new ProfileConnectionTestError(
          'client-identity-expired',
          error.message,
        );
      }
      if (error.code === 'client-identity-request-canceled') {
        throw new ProfileConnectionTestError('canceled', 'Connection test canceled.');
      }
    }
    throw error;
  } finally {
    await session?.dispose();
    if (
      !prepared &&
      input.selectionMode === 'import' &&
      input.releaseImportedIdentityIfUnused
    ) {
      // The caller owns profile reference counting. This cleans a newly
      // imported, failed test without deleting a duplicate identity that an
      // already-saved profile still uses.
      await input.releaseImportedIdentityIfUnused(selected.clientIdentityRef).catch(() => undefined);
    }
  }
}

/** There is deliberately no JavaScript certificate or private-key fallback. */
export async function inspectNativeMtlsCapability(
  transport?: NativeMtlsTransport | null,
  platform: string = typeof document === 'undefined' ? 'native' : 'web',
): Promise<NativeMtlsCapability> {
  if (platform === 'web') {
    return {
      available: false,
      platform: 'web',
      reason: 'Browser builds cannot select or bind an OS client identity.',
    };
  }
  if (!transport || !(await transport.isAvailable())) {
    return {
      available: false,
      platform,
      reason:
        'This build does not include the native OS-identity picker and certificate-aware transport.',
    };
  }
  return { available: true, platform };
}

export async function requireConfiguredNativeMtlsTransport(
  transport?: NativeMtlsTransport | null,
) {
  const capability = await inspectNativeMtlsCapability(transport);
  if (!capability.available || !transport) {
    throw new NativeMtlsCapabilityError(
      'native-mtls-transport-unavailable',
      capability.reason ?? 'Mutual TLS is unavailable on this build.',
    );
  }
  return transport;
}
