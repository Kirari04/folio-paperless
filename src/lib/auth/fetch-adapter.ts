import { normalizeServerBaseUrl, validateCustomHeaders } from './profile-store.ts';
import { NativeMtlsCapabilityError, validateServerRedirect } from './session.ts';

const PAPERLESS_API_VERSION = '10';
const DEFAULT_TIMEOUT_MS = 20_000;

export type ProfileRequestCredentials = {
  serverUrl: string;
  token: string;
  authorizationScheme?: 'Token' | 'Bearer';
  customHeaders?: Record<string, string>;
};

export type ProfileConnectionDetails = {
  apiVersion: string;
  serverVersion: string;
  appTitle?: string;
  username?: string;
  permissions: string[];
  isSuperuser: boolean;
};

export type ProfileConnectionTestErrorCode =
  | 'network-failure'
  | 'tls-failure'
  | 'client-identity-expired'
  | 'client-identity-unavailable'
  | 'unsafe-redirect'
  | 'unexpected-redirect'
  | 'authentication-failure'
  | 'insufficient-permissions'
  | 'unsupported-api'
  | 'invalid-response'
  | 'canceled';

export class ProfileConnectionTestError extends Error {
  readonly code: ProfileConnectionTestErrorCode;
  readonly retryable: boolean;

  constructor(code: ProfileConnectionTestErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'ProfileConnectionTestError';
    this.code = code;
    this.retryable = retryable;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function mergeHeaders(credentials: ProfileRequestCredentials): Record<string, string> {
  const entries = new Map<string, [string, string]>();
  const add = (name: string, value: string) =>
    entries.set(name.toLowerCase(), [name, value]);
  add('Accept', `application/json; version=${PAPERLESS_API_VERSION}`);
  if (credentials.token.trim()) {
    add(
      'Authorization',
      `${credentials.authorizationScheme ?? 'Token'} ${credentials.token.trim()}`,
    );
  }
  const customHeaders = credentials.customHeaders ?? {};
  validateCustomHeaders(customHeaders);
  for (const [name, value] of Object.entries(customHeaders)) {
    add(name.trim(), value);
  }
  return Object.fromEntries(entries.values());
}

function isTlsFailure(error: unknown) {
  const message = error instanceof Error ? error.message.toLocaleLowerCase() : '';
  return [
    'certificate',
    'cert ',
    'ssl',
    'tls',
    'hostname',
    'trust anchor',
  ].some((fragment) => message.includes(fragment));
}

function combineAbortSignals(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    },
  };
}

async function requestJson(
  fetchImpl: FetchLike,
  requestUrl: string,
  credentials: ProfileRequestCredentials,
  signal?: AbortSignal,
): Promise<{ response: Response; body: unknown }> {
  // Validate and normalize caller-supplied headers before entering the network
  // error boundary so configuration errors stay actionable and no request is sent.
  const headers = mergeHeaders(credentials);
  const abort = combineAbortSignals(signal, DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(requestUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: abort.signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new ProfileConnectionTestError('canceled', 'Connection test canceled.');
    }
    if (error instanceof NativeMtlsCapabilityError) {
      if (error.code === 'client-identity-expired') {
        throw new ProfileConnectionTestError(
          'client-identity-expired',
          'The selected client certificate has expired and must be replaced.',
        );
      }
      if (error.code === 'client-identity-request-canceled') {
        throw new ProfileConnectionTestError('canceled', 'Connection test canceled.');
      }
      if (
        error.code === 'client-identity-not-found' ||
        error.code === 'client-identity-missing-private-key' ||
        error.code === 'native-mtls-transport-unavailable'
      ) {
        throw new ProfileConnectionTestError(
          'client-identity-unavailable',
          'The saved client identity is no longer available. Select a replacement.',
        );
      }
    }
    if (isTlsFailure(error)) {
      throw new ProfileConnectionTestError(
        'tls-failure',
        'The server certificate or TLS connection could not be verified.',
        true,
      );
    }
    throw new ProfileConnectionTestError(
      'network-failure',
      'Could not reach this Paperless server. Check the address and network.',
      true,
    );
  } finally {
    abort.dispose();
  }

  const effectiveUrl = response.url || requestUrl;
  if (effectiveUrl !== requestUrl) {
    try {
      validateServerRedirect(requestUrl, effectiveUrl);
    } catch {
      throw new ProfileConnectionTestError(
        'unsafe-redirect',
        'The server redirected the connection test to an unsafe destination.',
      );
    }
    throw new ProfileConnectionTestError(
      'unexpected-redirect',
      'The server redirected this API request. Verify the saved base URL and subpath.',
      true,
    );
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (location) {
      try {
        validateServerRedirect(requestUrl, location);
      } catch {
        throw new ProfileConnectionTestError(
          'unsafe-redirect',
          'The server redirected the connection test to an unsafe destination.',
        );
      }
    }
    throw new ProfileConnectionTestError(
      'unexpected-redirect',
      'The server redirected this API request. Verify the saved base URL and subpath.',
      true,
    );
  }
  if (response.status === 401) {
    throw new ProfileConnectionTestError(
      'authentication-failure',
      'Paperless rejected this authentication. Check the selected method and credentials.',
      true,
    );
  }
  if (response.status === 403) {
    throw new ProfileConnectionTestError(
      'insufficient-permissions',
      'This Paperless account cannot read the required API resources.',
      true,
    );
  }
  if (response.status === 406) {
    throw new ProfileConnectionTestError(
      'unsupported-api',
      `This server does not support Paperless API version ${PAPERLESS_API_VERSION}.`,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ProfileConnectionTestError(
      'invalid-response',
      `Paperless returned HTTP ${response.status} while testing the connection.`,
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ProfileConnectionTestError(
      'invalid-response',
      'Paperless returned a response that was not valid JSON.',
    );
  }
  return { response, body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function header(response: Response, name: string) {
  return optionalString(response.headers.get(name));
}

export function classifyApiVersion(value: string | undefined): string {
  const version = value ?? PAPERLESS_API_VERSION;
  const major = version.match(/^\d+/)?.[0];
  if (major !== PAPERLESS_API_VERSION) {
    throw new ProfileConnectionTestError(
      'unsupported-api',
      `This server exposes Paperless API ${version}; Folio requires API ${PAPERLESS_API_VERSION}.`,
    );
  }
  return version;
}

export async function testPaperlessProfileConnection(
  credentials: ProfileRequestCredentials,
  options: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<ProfileConnectionDetails> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const serverUrl = normalizeServerBaseUrl(credentials.serverUrl);
  const normalizedCredentials = { ...credentials, serverUrl };
  const documentsUrl = `${serverUrl}/api/documents/?page_size=1&truncate_content=true`;
  const settingsUrl = `${serverUrl}/api/ui_settings/`;
  const documents = await requestJson(fetchImpl, documentsUrl, normalizedCredentials, options.signal);
  if (!isRecord(documents.body) || !Array.isArray(documents.body.results)) {
    throw new ProfileConnectionTestError(
      'invalid-response',
      'The documents endpoint did not return the expected Paperless API shape.',
    );
  }

  const settings = await requestJson(fetchImpl, settingsUrl, normalizedCredentials, options.signal);
  if (!isRecord(settings.body)) {
    throw new ProfileConnectionTestError(
      'invalid-response',
      'The user settings endpoint did not return the expected Paperless API shape.',
    );
  }
  const user = isRecord(settings.body.user) ? settings.body.user : {};
  const appSettings = isRecord(settings.body.settings) ? settings.body.settings : {};
  const permissions = Array.isArray(settings.body.permissions)
    ? settings.body.permissions.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    apiVersion: classifyApiVersion(
      header(documents.response, 'x-api-version') ?? header(settings.response, 'x-api-version'),
    ),
    serverVersion:
      header(documents.response, 'x-version') ??
      header(settings.response, 'x-version') ??
      'Unknown',
    ...(optionalString(appSettings.app_title ?? settings.body.app_title) === undefined
      ? {}
      : { appTitle: optionalString(appSettings.app_title ?? settings.body.app_title) }),
    ...(optionalString(user.username) === undefined
      ? {}
      : { username: optionalString(user.username) }),
    permissions,
    isSuperuser: user.is_superuser === true,
  };
}

export class FetchAuthHttpClient {
  private readonly fetchImpl: FetchLike;

  constructor(fetchImpl: FetchLike = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async request(request: {
    url: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    redirect: 'manual';
    signal?: AbortSignal;
  }) {
    const response = await this.fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: request.redirect,
      signal: request.signal,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    return {
      status: response.status,
      body,
      headers,
      responseUrl: response.url || request.url,
    };
  }
}
