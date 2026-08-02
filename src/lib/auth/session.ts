import type { ClientIdentityMetadata } from './profile-store';

export type AuthHttpRequest = {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  redirect: 'manual';
  signal?: AbortSignal;
};

export type AuthHttpResponse = {
  status: number;
  body?: unknown;
  headers?: Record<string, string | undefined>;
  responseUrl?: string;
};

export interface AuthHttpClient {
  request(request: AuthHttpRequest): Promise<AuthHttpResponse>;
}

export type AuthAcquisitionErrorCode =
  | 'invalid-token'
  | 'invalid-credentials'
  | 'otp-required'
  | 'otp-invalid'
  | 'rate-limited'
  | 'unsafe-redirect'
  | 'redirect-not-followed'
  | 'unexpected-response'
  | 'network-failure';

export class AuthAcquisitionError extends Error {
  readonly code: AuthAcquisitionErrorCode;
  readonly retryable: boolean;

  constructor(code: AuthAcquisitionErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'AuthAcquisitionError';
    this.code = code;
    this.retryable = retryable;
  }
}

export type RedirectValidationErrorCode =
  | 'invalid-redirect-url'
  | 'https-downgrade'
  | 'cross-origin-redirect';

export class RedirectValidationError extends Error {
  readonly code: RedirectValidationErrorCode;

  constructor(code: RedirectValidationErrorCode, message: string) {
    super(message);
    this.name = 'RedirectValidationError';
    this.code = code;
  }
}

function parseHttpUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new RedirectValidationError('invalid-redirect-url', `${field} is not a valid URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new RedirectValidationError(
      'invalid-redirect-url',
      `${field} must use the HTTPS or HTTP scheme.`,
    );
  }
  return url;
}

export function validateServerRedirect(
  requestUrl: string,
  redirectUrl: string,
  options: { allowedCrossOriginTargets?: readonly string[] } = {},
): string {
  const source = parseHttpUrl(requestUrl, 'Request URL');
  const target = parseHttpUrl(new URL(redirectUrl, source).toString(), 'Redirect URL');

  if (source.protocol === 'https:' && target.protocol !== 'https:') {
    throw new RedirectValidationError(
      'https-downgrade',
      'The server attempted to downgrade a secure HTTPS request to HTTP.',
    );
  }

  if (source.origin !== target.origin) {
    const allowed = new Set(
      (options.allowedCrossOriginTargets ?? []).map((value) => parseHttpUrl(value, 'Allowed origin').origin),
    );
    if (!allowed.has(target.origin)) {
      throw new RedirectValidationError(
        'cross-origin-redirect',
        'The server redirected authentication to an unapproved origin.',
      );
    }
  }
  return target.toString();
}

function normalizeServerUrl(value: string): string {
  const url = parseHttpUrl(value, 'Paperless server URL');
  if (url.username || url.password || url.search || url.hash) {
    throw new AuthAcquisitionError('unexpected-response', 'The Paperless server URL is invalid.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path === '/' ? '' : path}`;
}

export function acceptApiToken(token: string): { apiToken: string } {
  const value = token.trim();
  if (!value || /\s/.test(value)) {
    throw new AuthAcquisitionError('invalid-token', 'Enter a valid Paperless API token.');
  }
  return { apiToken: value };
}

function responseHeader(response: AuthHttpResponse, name: string): string | undefined {
  const match = Object.entries(response.headers ?? {}).find(
    ([headerName]) => headerName.toLowerCase() === name.toLowerCase(),
  );
  return match?.[1];
}

function collectErrorStrings(value: unknown, output: string[] = []): string[] {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length && visited < 512 && output.length < 64) {
    const next = pending.pop()!;
    visited += 1;
    if (typeof next.value === 'string') {
      output.push(next.value.slice(0, 2_048).toLowerCase());
    } else if (next.depth < 12 && Array.isArray(next.value)) {
      for (const item of next.value.slice(0, 128)) pending.push({ value: item, depth: next.depth + 1 });
    } else if (next.depth < 12 && typeof next.value === 'object' && next.value !== null) {
      for (const item of Object.values(next.value).slice(0, 128)) {
        pending.push({ value: item, depth: next.depth + 1 });
      }
    }
  }
  return output;
}

export async function acquirePaperlessToken(
  input: {
    serverUrl: string;
    username: string;
    password: string;
    otpCode?: string;
    signal?: AbortSignal;
  },
  client: AuthHttpClient,
): Promise<{ apiToken: string }> {
  const serverUrl = normalizeServerUrl(input.serverUrl);
  const username = input.username.trim();
  if (!username || !input.password) {
    throw new AuthAcquisitionError(
      'invalid-credentials',
      'A Paperless username and password are required.',
    );
  }
  if (input.otpCode !== undefined && !/^\d{6,10}$/.test(input.otpCode.trim())) {
    throw new AuthAcquisitionError('otp-invalid', 'Enter a valid one-time code.', true);
  }

  const requestUrl = `${serverUrl}/api/token/`;
  let response: AuthHttpResponse;
  try {
    response = await client.request({
      url: requestUrl,
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        username,
        password: input.password,
        ...(input.otpCode === undefined ? {} : { code: input.otpCode.trim() }),
      }),
      redirect: 'manual',
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch (error) {
    if (error instanceof AuthAcquisitionError) throw error;
    throw new AuthAcquisitionError(
      'network-failure',
      'Could not reach the Paperless authentication endpoint.',
      true,
    );
  }

  if (response.responseUrl && response.responseUrl !== requestUrl) {
    try {
      validateServerRedirect(requestUrl, response.responseUrl);
    } catch {
      throw new AuthAcquisitionError(
        'unsafe-redirect',
        'Paperless authentication was redirected to an unsafe destination.',
      );
    }
    throw new AuthAcquisitionError(
      'redirect-not-followed',
      'Paperless redirected the credential request. Confirm the server URL before retrying.',
    );
  }
  if (response.status >= 300 && response.status < 400) {
    const location = responseHeader(response, 'location');
    if (location) {
      try {
        validateServerRedirect(requestUrl, location);
      } catch {
        throw new AuthAcquisitionError(
          'unsafe-redirect',
          'Paperless authentication was redirected to an unsafe destination.',
        );
      }
    }
    throw new AuthAcquisitionError(
      'redirect-not-followed',
      'Paperless redirected the credential request. Confirm the server URL before retrying.',
    );
  }

  const errors = collectErrorStrings(response.body);
  if (errors.some((message) => message.includes('mfa code is required'))) {
    throw new AuthAcquisitionError(
      'otp-required',
      'This Paperless account requires a one-time code.',
      true,
    );
  }
  if (
    errors.some(
      (message) => message.includes('invalid mfa code') || message.includes('invalid otp'),
    )
  ) {
    throw new AuthAcquisitionError(
      'otp-invalid',
      'The one-time code is invalid or expired.',
      true,
    );
  }
  if (response.status === 401 || response.status === 403 || response.status === 400) {
    throw new AuthAcquisitionError(
      'invalid-credentials',
      'Paperless rejected the username or password.',
      true,
    );
  }
  if (response.status === 429) {
    throw new AuthAcquisitionError(
      'rate-limited',
      'Paperless temporarily limited login attempts. Try again later.',
      true,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new AuthAcquisitionError(
      'unexpected-response',
      'Paperless returned an unexpected authentication response.',
      true,
    );
  }
  if (
    typeof response.body !== 'object' ||
    response.body === null ||
    !('token' in response.body) ||
    typeof response.body.token !== 'string'
  ) {
    throw new AuthAcquisitionError(
      'unexpected-response',
      'Paperless did not return an API token.',
    );
  }
  return acceptApiToken(response.body.token);
}

export interface OidcCryptoAdapter {
  randomBytes(length: number): Uint8Array;
  sha256(value: Uint8Array): Promise<Uint8Array>;
}

export type OidcAuthorizationAttempt = {
  id: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  codeChallenge: string;
  createdAt: string;
};

export type OidcAuthorizationStart = {
  attempt: OidcAuthorizationAttempt;
  authorizationUrl: string;
};

export type OidcErrorCode =
  | 'invalid-configuration'
  | 'invalid-callback'
  | 'state-mismatch'
  | 'redirect-mismatch'
  | 'expired-attempt'
  | 'replayed-callback'
  | 'provider-error'
  | 'invalid-token-response'
  | 'issuer-mismatch'
  | 'audience-mismatch'
  | 'nonce-mismatch'
  | 'expired-id-token';

export class OidcValidationError extends Error {
  readonly code: OidcErrorCode;

  constructor(code: OidcErrorCode, message: string) {
    super(message);
    this.name = 'OidcValidationError';
    this.code = code;
  }
}

const BASE64_URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function encodeBase64Url(bytes: Uint8Array): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const value = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    result += BASE64_URL_ALPHABET[(value >>> 18) & 63];
    result += BASE64_URL_ALPHABET[(value >>> 12) & 63];
    if (second !== undefined) result += BASE64_URL_ALPHABET[(value >>> 6) & 63];
    if (third !== undefined) result += BASE64_URL_ALPHABET[value & 63];
  }
  return result;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function secureRandomToken(crypto: OidcCryptoAdapter, length: number): string {
  const bytes = crypto.randomBytes(length);
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new OidcValidationError(
      'invalid-configuration',
      'The authentication crypto provider returned invalid random data.',
    );
  }
  return encodeBase64Url(bytes);
}

function parseHttpsUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OidcValidationError('invalid-configuration', `${field} is invalid.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new OidcValidationError(
      'invalid-configuration',
      `${field} must be a secure HTTPS URL without embedded credentials.`,
    );
  }
  return url;
}

function parseOidcIssuer(value: string, field: string): URL {
  const url = parseHttpsUrl(value, field);
  if (url.search) {
    throw new OidcValidationError(
      'invalid-configuration',
      `${field} cannot contain a query or fragment.`,
    );
  }
  return url;
}

function validateRedirectUriConfiguration(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OidcValidationError('invalid-configuration', 'The OIDC redirect URI is invalid.');
  }
  const forbiddenSchemes = new Set(['javascript:', 'data:', 'file:', 'about:', 'blob:']);
  if (
    !url.protocol ||
    url.protocol === 'http:' ||
    forbiddenSchemes.has(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new OidcValidationError(
      'invalid-configuration',
      'The OIDC redirect URI cannot contain credentials, a query, or a fragment.',
    );
  }
  return url.toString();
}

export async function createOidcAuthorizationAttempt(
  input: {
    issuer: string;
    authorizationEndpoint: string;
    clientId: string;
    redirectUri: string;
    scopes?: readonly string[];
    now: string;
    extraParams?: Record<string, string>;
  },
  crypto: OidcCryptoAdapter,
): Promise<OidcAuthorizationStart> {
  const issuer = parseOidcIssuer(input.issuer, 'OIDC issuer').toString().replace(/\/$/, '');
  const authorizationEndpoint = parseHttpsUrl(
    input.authorizationEndpoint,
    'OIDC authorization endpoint',
  );
  const redirectUri = validateRedirectUriConfiguration(input.redirectUri);
  const clientId = input.clientId.trim();
  if (!clientId || !Number.isFinite(Date.parse(input.now))) {
    throw new OidcValidationError('invalid-configuration', 'OIDC client configuration is invalid.');
  }
  const scopes = [...new Set((input.scopes ?? ['openid']).map((scope) => scope.trim()).filter(Boolean))];
  if (!scopes.includes('openid')) scopes.unshift('openid');

  const codeVerifier = secureRandomToken(crypto, 32);
  const digest = await crypto.sha256(utf8(codeVerifier));
  if (!(digest instanceof Uint8Array) || digest.length !== 32) {
    throw new OidcValidationError(
      'invalid-configuration',
      'The authentication crypto provider returned an invalid SHA-256 digest.',
    );
  }

  const attempt: OidcAuthorizationAttempt = {
    id: secureRandomToken(crypto, 18),
    issuer,
    clientId,
    redirectUri,
    state: secureRandomToken(crypto, 32),
    nonce: secureRandomToken(crypto, 32),
    codeVerifier,
    codeChallenge: encodeBase64Url(digest),
    createdAt: input.now,
  };

  const reservedParams = new Set([
    'response_type',
    'client_id',
    'redirect_uri',
    'scope',
    'state',
    'nonce',
    'code_challenge',
    'code_challenge_method',
  ]);
  for (const key of Object.keys(input.extraParams ?? {})) {
    if (reservedParams.has(key.toLowerCase())) {
      throw new OidcValidationError(
        'invalid-configuration',
        `OIDC extra parameter ${key} cannot override a security parameter.`,
      );
    }
  }

  authorizationEndpoint.search = '';
  authorizationEndpoint.hash = '';
  authorizationEndpoint.searchParams.set('response_type', 'code');
  authorizationEndpoint.searchParams.set('client_id', clientId);
  authorizationEndpoint.searchParams.set('redirect_uri', redirectUri);
  authorizationEndpoint.searchParams.set('scope', scopes.join(' '));
  authorizationEndpoint.searchParams.set('state', attempt.state);
  authorizationEndpoint.searchParams.set('nonce', attempt.nonce);
  authorizationEndpoint.searchParams.set('code_challenge', attempt.codeChallenge);
  authorizationEndpoint.searchParams.set('code_challenge_method', 'S256');
  for (const [key, value] of Object.entries(input.extraParams ?? {})) {
    authorizationEndpoint.searchParams.set(key, value);
  }
  return { attempt, authorizationUrl: authorizationEndpoint.toString() };
}

function constantTimeStringEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function redirectEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OidcValidationError('invalid-callback', 'The OIDC callback URL is invalid.');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function validateOidcCallback(
  attempt: OidcAuthorizationAttempt,
  callbackUrl: string,
  options: { now: string; maxAgeMs?: number },
): { code: string } {
  let callback: URL;
  try {
    callback = new URL(callbackUrl);
  } catch {
    throw new OidcValidationError('invalid-callback', 'The OIDC callback URL is invalid.');
  }
  if (redirectEndpoint(callbackUrl) !== redirectEndpoint(attempt.redirectUri)) {
    throw new OidcValidationError(
      'redirect-mismatch',
      'The OIDC callback did not return to the registered redirect URI.',
    );
  }
  const createdAt = Date.parse(attempt.createdAt);
  const now = Date.parse(options.now);
  const maxAgeMs = options.maxAgeMs ?? 10 * 60 * 1000;
  if (!Number.isFinite(createdAt) || !Number.isFinite(now) || now < createdAt || now - createdAt > maxAgeMs) {
    throw new OidcValidationError('expired-attempt', 'The OIDC login attempt has expired.');
  }
  const states = callback.searchParams.getAll('state');
  if (states.length !== 1) {
    throw new OidcValidationError('state-mismatch', 'OIDC state validation failed.');
  }
  const state = states[0];
  if (!constantTimeStringEqual(state, attempt.state)) {
    throw new OidcValidationError('state-mismatch', 'OIDC state validation failed.');
  }
  const providerErrors = callback.searchParams.getAll('error');
  if (providerErrors.length > 1) {
    throw new OidcValidationError('invalid-callback', 'The OIDC callback is ambiguous.');
  }
  const providerError = providerErrors[0];
  if (providerError) {
    throw new OidcValidationError('provider-error', 'The identity provider rejected the login.');
  }
  const codes = callback.searchParams.getAll('code');
  if (codes.length !== 1 || !codes[0]) {
    throw new OidcValidationError(
      'invalid-callback',
      'The OIDC callback did not include an authorization code.',
    );
  }
  return { code: codes[0] };
}

export interface OidcAttemptStore {
  save(attempt: OidcAuthorizationAttempt): Promise<void>;
  get(attemptId: string): Promise<OidcAuthorizationAttempt | null>;
  consume(attemptId: string, expectedState: string): Promise<OidcAuthorizationAttempt | null>;
  delete(attemptId: string): Promise<void>;
}

export class InMemoryOidcAttemptStore implements OidcAttemptStore {
  private readonly attempts = new Map<string, OidcAuthorizationAttempt>();

  async save(attempt: OidcAuthorizationAttempt): Promise<void> {
    this.attempts.set(attempt.id, { ...attempt });
  }

  async get(attemptId: string): Promise<OidcAuthorizationAttempt | null> {
    const attempt = this.attempts.get(attemptId);
    return attempt ? { ...attempt } : null;
  }

  async consume(
    attemptId: string,
    expectedState: string,
  ): Promise<OidcAuthorizationAttempt | null> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || !constantTimeStringEqual(attempt.state, expectedState)) return null;
    this.attempts.delete(attemptId);
    return { ...attempt };
  }

  async delete(attemptId: string): Promise<void> {
    this.attempts.delete(attemptId);
  }
}

export async function consumeOidcCallback(
  store: OidcAttemptStore,
  attemptId: string,
  callbackUrl: string,
  options: { now: string; maxAgeMs?: number },
): Promise<{ attempt: OidcAuthorizationAttempt; code: string }> {
  const pending = await store.get(attemptId);
  if (!pending) {
    throw new OidcValidationError(
      'replayed-callback',
      'This OIDC callback was already handled or is no longer pending.',
    );
  }
  const result = validateOidcCallback(pending, callbackUrl, options);
  const consumed = await store.consume(attemptId, pending.state);
  if (!consumed) {
    throw new OidcValidationError(
      'replayed-callback',
      'This OIDC callback was already handled or is no longer pending.',
    );
  }
  return { attempt: consumed, code: result.code };
}

export type OidcTokenResponse = {
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  tokenType?: string;
  expiresIn?: number;
};

export type VerifiedOidcClaims = {
  iss: string;
  sub: string;
  aud: string | string[];
  nonce: string;
  exp: number;
  iat?: number;
  [claim: string]: unknown;
};

export interface OidcIdTokenVerifier {
  /** Must verify the JWT signature, allowed algorithm, and key trust before returning claims. */
  verify(
    idToken: string,
    expected: { issuer: string; audience: string },
  ): Promise<VerifiedOidcClaims>;
}

export async function validateOidcTokenResponse(
  response: OidcTokenResponse,
  attempt: OidcAuthorizationAttempt,
  verifier: OidcIdTokenVerifier,
  options: { nowEpochSeconds: number; clockSkewSeconds?: number },
): Promise<VerifiedOidcClaims> {
  if (
    !response.accessToken ||
    !response.idToken ||
    (response.tokenType !== undefined && response.tokenType.toLowerCase() !== 'bearer') ||
    (response.expiresIn !== undefined && (!Number.isFinite(response.expiresIn) || response.expiresIn <= 0))
  ) {
    throw new OidcValidationError(
      'invalid-token-response',
      'The identity provider returned an invalid token response.',
    );
  }
  const claims = await verifier.verify(response.idToken, {
    issuer: attempt.issuer,
    audience: attempt.clientId,
  }).catch(() => {
    throw new OidcValidationError(
      'invalid-token-response',
      'The OIDC identity token could not be verified.',
    );
  });
  if (
    typeof claims !== 'object' ||
    claims === null ||
    typeof claims.iss !== 'string' ||
    typeof claims.sub !== 'string' ||
    (typeof claims.aud !== 'string' &&
      (!Array.isArray(claims.aud) || claims.aud.some((audience) => typeof audience !== 'string'))) ||
    typeof claims.nonce !== 'string' ||
    typeof claims.exp !== 'number'
  ) {
    throw new OidcValidationError(
      'invalid-token-response',
      'The OIDC identity token contains invalid claims.',
    );
  }
  const expectedIssuer = attempt.issuer.replace(/\/$/, '');
  if (claims.iss.replace(/\/$/, '') !== expectedIssuer) {
    throw new OidcValidationError('issuer-mismatch', 'The OIDC issuer did not match the login request.');
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(attempt.clientId)) {
    throw new OidcValidationError(
      'audience-mismatch',
      'The OIDC token was not issued for this application.',
    );
  }
  if (
    (audience.length > 1 && typeof claims.azp !== 'string')
    || (claims.azp !== undefined
      && (typeof claims.azp !== 'string' || !constantTimeStringEqual(claims.azp, attempt.clientId)))
  ) {
    throw new OidcValidationError(
      'audience-mismatch',
      'The OIDC token authorized party did not match this application.',
    );
  }
  if (!constantTimeStringEqual(claims.nonce, attempt.nonce)) {
    throw new OidcValidationError('nonce-mismatch', 'OIDC nonce validation failed.');
  }
  const skew = options.clockSkewSeconds ?? 60;
  if (!Number.isFinite(claims.exp) || claims.exp < options.nowEpochSeconds - skew) {
    throw new OidcValidationError('expired-id-token', 'The OIDC identity token has expired.');
  }
  if (claims.iat !== undefined && claims.iat > options.nowEpochSeconds + skew) {
    throw new OidcValidationError(
      'invalid-token-response',
      'The OIDC identity token was issued in the future.',
    );
  }
  if (!claims.sub) {
    throw new OidcValidationError(
      'invalid-token-response',
      'The OIDC identity token is missing a subject.',
    );
  }
  return claims;
}

export type OidcDiscoveryMetadata = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  endSessionEndpoint?: string;
};

export function validateOidcDiscovery(
  expectedIssuer: string,
  discovery: OidcDiscoveryMetadata,
): OidcDiscoveryMetadata {
  const issuer = parseOidcIssuer(discovery.issuer, 'Discovered OIDC issuer')
    .toString()
    .replace(/\/$/, '');
  const expected = parseOidcIssuer(expectedIssuer, 'Expected OIDC issuer')
    .toString()
    .replace(/\/$/, '');
  if (issuer !== expected) {
    throw new OidcValidationError(
      'issuer-mismatch',
      'The discovered OIDC issuer did not match the configured issuer.',
    );
  }
  return {
    issuer,
    authorizationEndpoint: parseHttpsUrl(
      discovery.authorizationEndpoint,
      'OIDC authorization endpoint',
    ).toString(),
    tokenEndpoint: parseHttpsUrl(discovery.tokenEndpoint, 'OIDC token endpoint').toString(),
    ...(discovery.revocationEndpoint === undefined
      ? {}
      : {
          revocationEndpoint: parseHttpsUrl(
            discovery.revocationEndpoint,
            'OIDC revocation endpoint',
          ).toString(),
        }),
    ...(discovery.endSessionEndpoint === undefined
      ? {}
      : {
          endSessionEndpoint: parseHttpsUrl(
            discovery.endSessionEndpoint,
            'OIDC end-session endpoint',
          ).toString(),
        }),
  };
}

export interface OidcSessionLifecycle {
  begin(signal?: AbortSignal): Promise<OidcAuthorizationStart>;
  complete(callbackUrl: string, signal?: AbortSignal): Promise<OidcTokenResponse>;
  refresh(refreshToken: string, signal?: AbortSignal): Promise<OidcTokenResponse>;
  revoke(token: string, signal?: AbortSignal): Promise<void>;
  logout(idTokenHint?: string, signal?: AbortSignal): Promise<void>;
  cancel(): Promise<void>;
}

export interface AuthenticatedProfileSession {
  readonly profileId: string;
  getRequestHeaders(): Promise<Record<string, string>>;
  refreshIfNeeded(signal?: AbortSignal): Promise<void>;
  logout(signal?: AbortSignal): Promise<void>;
  request(request: NativeMtlsHttpRequest): Promise<NativeMtlsHttpResponse>;
  download(request: NativeMtlsDownloadRequest): Promise<NativeMtlsHttpResponse>;
  uploadMultipart(
    request: NativeMtlsMultipartUploadRequest,
  ): Promise<NativeMtlsHttpResponse>;
  dispose(): Promise<void>;
}

export type NativeMtlsCapabilityErrorCode =
  | 'native-mtls-transport-unavailable'
  | 'client-identity-selection-canceled'
  | 'client-identity-not-found'
  | 'client-identity-import-failed'
  | 'client-identity-missing-private-key'
  | 'client-identity-not-yet-valid'
  | 'client-identity-expired'
  | 'client-identity-origin-mismatch'
  | 'client-identity-request-canceled'
  | 'client-identity-request-failed';

export class NativeMtlsCapabilityError extends Error {
  readonly code: NativeMtlsCapabilityErrorCode;

  constructor(code: NativeMtlsCapabilityErrorCode, message: string) {
    super(message);
    this.name = 'NativeMtlsCapabilityError';
    this.code = code;
  }
}

export interface NativeMtlsTransport {
  isAvailable(): Promise<boolean>;
  /**
   * Returns only identities whose lifecycle is owned by this app. Android
   * KeyChain identities are system-owned, so its implementation returns none.
   */
  listManagedClientIdentityRefs(): Promise<string[]>;
  importClientIdentity(input: {
    serverUrl: string;
  }): Promise<{
    identity: ClientIdentityMetadata;
    clientIdentityRef: string;
  } | null>;
  selectClientIdentity(input: {
    serverUrl: string;
    suggestedClientIdentityRef?: string;
  }): Promise<{
    identity: ClientIdentityMetadata;
    clientIdentityRef: string;
  } | null>;
  describeClientIdentity(
    clientIdentityRef: string,
  ): Promise<ClientIdentityMetadata | null>;
  removeClientIdentity(clientIdentityRef: string): Promise<void>;
  openAuthenticatedSession(input: {
    profileId: string;
    clientIdentityRef: string;
    serverUrl: string;
  }): Promise<AuthenticatedProfileSession>;
}

export type NativeMtlsHttpRequest = {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};

export type NativeMtlsHttpResponse = {
  status: number;
  headers: Record<string, string | undefined>;
  responseUrl: string;
  body: string;
};

export type NativeMtlsDownloadRequest = Omit<NativeMtlsHttpRequest, 'body'> & {
  destinationUri: string;
  maxBytes: number;
  onProgress?: (fraction: number | null) => void;
};

export type NativeMtlsMultipartUploadRequest = Omit<NativeMtlsHttpRequest, 'body'> & {
  fileUri: string;
  fieldName: string;
  fileName: string;
  mimeType: string;
  parameters: readonly (readonly [string, string])[];
  onProgress?: (fraction: number | null) => void;
};

export function assertUsableClientIdentity(
  identity: ClientIdentityMetadata,
  now: string,
): void {
  if (!identity.hasPrivateKey) {
    throw new NativeMtlsCapabilityError(
      'client-identity-missing-private-key',
      'The selected client identity does not include a private key.',
    );
  }
  const nowTime = Date.parse(now);
  const notBefore = identity.notBefore === undefined ? null : Date.parse(identity.notBefore);
  const expiresAt = Date.parse(identity.expiresAt);
  if (!Number.isFinite(nowTime) || !Number.isFinite(expiresAt)) {
    throw new NativeMtlsCapabilityError(
      'client-identity-expired',
      'The selected client identity has invalid validity metadata.',
    );
  }
  if (notBefore !== null && (!Number.isFinite(notBefore) || nowTime < notBefore)) {
    throw new NativeMtlsCapabilityError(
      'client-identity-not-yet-valid',
      'The selected client certificate is not valid yet.',
    );
  }
  if (nowTime >= expiresAt) {
    throw new NativeMtlsCapabilityError(
      'client-identity-expired',
      'The selected client certificate has expired and must be replaced.',
    );
  }
}

export async function requireNativeMtlsTransport(
  transport: NativeMtlsTransport | null | undefined,
): Promise<NativeMtlsTransport> {
  if (!transport || !(await transport.isAvailable())) {
    throw new NativeMtlsCapabilityError(
      'native-mtls-transport-unavailable',
      'Mutual TLS requires a supported native client-identity transport on this platform.',
    );
  }
  return transport;
}
