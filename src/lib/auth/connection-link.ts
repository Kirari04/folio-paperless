import { normalizeServerBaseUrl } from './profile-store.ts';
import { parseOidcIssuer } from './session.ts';

/**
 * `folio-paperless://connect` prefills the add-profile form from a link or QR
 * code an administrator distributes. The link carries public configuration
 * only: a server address, a sign-in method, and the OIDC client registration.
 * No secret is ever accepted, and nothing is stored until the person confirms
 * the form and the existing connection test succeeds.
 */
export const CONNECTION_LINK_HOSTNAME = 'connect' as const;

export const CONNECTION_LINK_QUERY_PARAMETERS = [
  'server',
  'auth',
  'issuer',
  'client_id',
  'name',
  'scopes',
] as const;

/**
 * Query names that would carry a credential. They are rejected with a
 * dedicated code so the person is told why instead of seeing a generic
 * "unsupported link" fallback.
 */
export const CONNECTION_LINK_SECRET_PARAMETERS = [
  'access_token',
  'api_key',
  'apikey',
  'api_token',
  'authorization',
  'bearer',
  'client_secret',
  'code',
  'credential',
  'credentials',
  'id_token',
  'key',
  'otp',
  'pass',
  'passcode',
  'password',
  'passwd',
  'refresh_token',
  'secret',
  'token',
  'totp',
] as const;

export const MAX_CONNECTION_LINK_NAME_LENGTH = 64;
export const MAX_CONNECTION_LINK_CLIENT_ID_LENGTH = 128;
export const MAX_CONNECTION_LINK_SCOPES_LENGTH = 200;
export const MAX_CONNECTION_LINK_SCOPES = 12;

export type ConnectionLinkAuthKeyword = 'token' | 'password' | 'oidc';

export type ConnectionLinkAuthKind = 'token' | 'paperless-credentials' | 'oidc';

export type ConnectionProfilePrefill = {
  serverUrl: string;
  authKind: ConnectionLinkAuthKind;
  displayName?: string;
  issuer?: string;
  clientId?: string;
  scopes?: readonly string[];
};

export type ConnectionLinkRejectionCode =
  | 'connect-secret-in-link'
  | 'connect-server-required'
  | 'connect-invalid-server'
  | 'connect-insecure-server'
  | 'connect-unsupported-auth'
  | 'connect-issuer-required'
  | 'connect-invalid-issuer'
  | 'connect-client-required'
  | 'connect-invalid-client'
  | 'connect-invalid-name'
  | 'connect-invalid-scopes';

export type ConnectionLinkParseResult =
  | { accepted: true; prefill: ConnectionProfilePrefill }
  | { accepted: false; code: ConnectionLinkRejectionCode };

const AUTH_KEYWORDS: Record<ConnectionLinkAuthKeyword, ConnectionLinkAuthKind> = {
  token: 'token',
  password: 'paperless-credentials',
  oidc: 'oidc',
};

const AUTH_KEYWORD_BY_KIND: Record<ConnectionLinkAuthKind, ConnectionLinkAuthKeyword> = {
  token: 'token',
  'paperless-credentials': 'password',
  oidc: 'oidc',
};

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
/** RFC 6749 scope-token: printable ASCII without space, quote, or backslash. */
const SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const CLIENT_ID_PATTERN = /^[\x21-\x7e]+$/;

/**
 * Plain HTTP stays available for the loopback and private-network addresses a
 * self-hosted Paperless uses during setup. Every routable host must use HTTPS,
 * because a link is an untrusted channel and a downgraded address would send
 * the credential the person types next over clear text.
 */
const PRIVATE_HOST_PATTERN = new RegExp(
  '^(?:' +
    'localhost' +
    '|127(?:\\.\\d{1,3}){3}' +
    '|10(?:\\.\\d{1,3}){3}' +
    '|192\\.168\\.\\d{1,3}\\.\\d{1,3}' +
    '|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}' +
    '|\\[?::1\\]?' +
    '|(?:[a-z0-9-]+\\.)+(?:local|internal|home|lan)' +
  ')$',
  'i',
);

export function isPrivateConnectionHost(hostname: string): boolean {
  return PRIVATE_HOST_PATTERN.test(hostname);
}

export function findConnectionLinkSecretParameter(
  keys: Iterable<string>,
): string | null {
  const secrets = new Set<string>(CONNECTION_LINK_SECRET_PARAMETERS);
  for (const key of keys) {
    if (secrets.has(key.trim().toLowerCase())) return key;
  }
  return null;
}

function parseScopes(raw: string): readonly string[] | ConnectionLinkRejectionCode {
  if (raw.length > MAX_CONNECTION_LINK_SCOPES_LENGTH) return 'connect-invalid-scopes';
  const scopes = [...new Set(raw.split(/[\s+]+/).filter(Boolean))];
  if (!scopes.length || scopes.length > MAX_CONNECTION_LINK_SCOPES) {
    return 'connect-invalid-scopes';
  }
  if (scopes.some((scope) => !SCOPE_TOKEN_PATTERN.test(scope))) {
    return 'connect-invalid-scopes';
  }
  return scopes;
}

/**
 * Validates the query of a `folio-paperless://connect` link. The caller has
 * already restricted the query to {@link CONNECTION_LINK_QUERY_PARAMETERS} and
 * rejected duplicates, so only the values are checked here.
 */
export function parseConnectionLinkParameters(
  values: Readonly<Record<string, string>>,
): ConnectionLinkParseResult {
  const secret = findConnectionLinkSecretParameter(Object.keys(values));
  if (secret) return { accepted: false, code: 'connect-secret-in-link' };

  const rawServer = values.server?.trim();
  if (!rawServer) return { accepted: false, code: 'connect-server-required' };

  let serverUrl: string;
  try {
    serverUrl = normalizeServerBaseUrl(rawServer);
  } catch {
    return { accepted: false, code: 'connect-invalid-server' };
  }
  const server = new URL(serverUrl);
  if (server.protocol === 'http:' && !isPrivateConnectionHost(server.hostname)) {
    return { accepted: false, code: 'connect-insecure-server' };
  }

  const keyword = (values.auth?.trim().toLowerCase() || 'token') as ConnectionLinkAuthKeyword;
  if (!Object.prototype.hasOwnProperty.call(AUTH_KEYWORDS, keyword)) {
    return { accepted: false, code: 'connect-unsupported-auth' };
  }
  const authKind = AUTH_KEYWORDS[keyword];

  const rawName = values.name?.trim();
  if (
    rawName !== undefined &&
    (!rawName ||
      rawName.length > MAX_CONNECTION_LINK_NAME_LENGTH ||
      CONTROL_CHARACTER_PATTERN.test(rawName))
  ) {
    return { accepted: false, code: 'connect-invalid-name' };
  }

  const prefill: ConnectionProfilePrefill = {
    serverUrl,
    authKind,
    ...(rawName ? { displayName: rawName } : {}),
  };

  if (authKind !== 'oidc') {
    if (values.issuer !== undefined || values.client_id !== undefined) {
      return { accepted: false, code: 'connect-unsupported-auth' };
    }
    if (values.scopes !== undefined) return { accepted: false, code: 'connect-invalid-scopes' };
    return { accepted: true, prefill };
  }

  const rawIssuer = values.issuer?.trim();
  if (!rawIssuer) return { accepted: false, code: 'connect-issuer-required' };
  let issuer: string;
  try {
    issuer = parseOidcIssuer(rawIssuer, 'OIDC issuer').toString().replace(/\/$/, '');
  } catch {
    return { accepted: false, code: 'connect-invalid-issuer' };
  }

  const clientId = values.client_id?.trim();
  if (!clientId) return { accepted: false, code: 'connect-client-required' };
  if (
    clientId.length > MAX_CONNECTION_LINK_CLIENT_ID_LENGTH ||
    !CLIENT_ID_PATTERN.test(clientId)
  ) {
    return { accepted: false, code: 'connect-invalid-client' };
  }

  if (values.scopes === undefined) {
    return { accepted: true, prefill: { ...prefill, issuer, clientId } };
  }
  const scopes = parseScopes(values.scopes);
  if (typeof scopes === 'string') return { accepted: false, code: scopes };
  return { accepted: true, prefill: { ...prefill, issuer, clientId, scopes } };
}

/** Canonical query of a prefill, used to serialize and fingerprint the route. */
export function connectionLinkQueryValues(
  prefill: ConnectionProfilePrefill,
): Record<string, string> {
  return {
    server: prefill.serverUrl,
    auth: AUTH_KEYWORD_BY_KIND[prefill.authKind],
    ...(prefill.issuer ? { issuer: prefill.issuer } : {}),
    ...(prefill.clientId ? { client_id: prefill.clientId } : {}),
    ...(prefill.displayName ? { name: prefill.displayName } : {}),
    ...(prefill.scopes?.length ? { scopes: [...prefill.scopes].join(' ') } : {}),
  };
}
