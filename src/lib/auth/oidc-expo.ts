import * as AuthSession from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import { translateRuntime } from '../../i18n/runtime.ts';

import {
  isNativeOidcRs256Available,
  verifyOidcRs256Natively,
} from './native-oidc-rs256';
import {
  decodeOidcBase64Url,
  selectOidcRs256Jwk,
} from './oidc-rs256';
import type { ConnectionProfile, ProfileSecrets, StoredOidcSecrets } from './profile-store';
import {
  type OidcAuthorizationAttempt,
  type OidcDiscoveryMetadata,
  type OidcIdTokenVerifier,
  type OidcTokenResponse,
  OidcValidationError,
  createOidcAuthorizationAttempt,
  validateOidcCallback,
  validateOidcDiscovery,
  validateOidcTokenResponse,
} from './session';
import type { OidcLoginResult } from './profile-management';

WebBrowser.maybeCompleteAuthSession();

type RuntimeDiscovery = OidcDiscoveryMetadata & {
  jwksUri: string;
  userInfoEndpoint?: string;
};

export type OidcRuntimeErrorCode =
  | 'unavailable'
  | 'canceled'
  | 'discovery-failed'
  | 'token-exchange-failed'
  | 'signature-verification-failed'
  | 'refresh-failed'
  | 'revocation-failed';

export class OidcRuntimeError extends Error {
  readonly code: OidcRuntimeErrorCode;
  readonly retryable: boolean;

  constructor(code: OidcRuntimeErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'OidcRuntimeError';
    this.code = code;
    this.retryable = retryable;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new OidcRuntimeError('discovery-failed', translateRuntime('authRuntime.discoveryFieldMissing', { field: label }));
  }
  return value.trim();
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}

function parseJwtPart(value: string): Record<string, unknown> {
  const decoded = new TextDecoder().decode(decodeOidcBase64Url(value));
  const parsed: unknown = JSON.parse(decoded);
  if (!isRecord(parsed)) throw new Error(translateRuntime('authRuntime.jwtInvalid'));
  return parsed;
}

function oidcDiscoveryUrl(issuer: string) {
  const normalized = issuer.trim().replace(/\/$/, '');
  return `${normalized}/.well-known/openid-configuration`;
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
  failureCode: OidcRuntimeErrorCode,
) {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: 'error' });
  } catch {
    throw new OidcRuntimeError(failureCode, translateRuntime('authRuntime.providerUnreachable'), true);
  }
  if (!response.ok) {
    throw new OidcRuntimeError(
      failureCode,
      translateRuntime('authRuntime.providerHttp', { status: response.status }),
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }
  try {
    return await response.json() as unknown;
  } catch {
    throw new OidcRuntimeError(failureCode, translateRuntime('authRuntime.providerJson'));
  }
}

export async function discoverOidc(
  issuer: string,
  signal?: AbortSignal,
): Promise<RuntimeDiscovery> {
  const raw = await fetchJson(
    oidcDiscoveryUrl(issuer),
    { headers: { accept: 'application/json' }, signal },
    'discovery-failed',
  );
  if (!isRecord(raw)) {
    throw new OidcRuntimeError('discovery-failed', translateRuntime('authRuntime.discoveryInvalid'));
  }
  const validated = validateOidcDiscovery(issuer, {
    issuer: requireString(raw.issuer, translateRuntime('authRuntime.issuer')),
    authorizationEndpoint: requireString(raw.authorization_endpoint, translateRuntime('authRuntime.authorizationEndpoint')),
    tokenEndpoint: requireString(raw.token_endpoint, translateRuntime('authRuntime.tokenEndpoint')),
    ...(typeof raw.revocation_endpoint === 'string'
      ? { revocationEndpoint: raw.revocation_endpoint }
      : {}),
    ...(typeof raw.end_session_endpoint === 'string'
      ? { endSessionEndpoint: raw.end_session_endpoint }
      : {}),
  });
  const jwksUri = requireString(raw.jwks_uri, translateRuntime('authRuntime.jwksEndpoint'));
  if (new URL(jwksUri).protocol !== 'https:') {
    throw new OidcRuntimeError('discovery-failed', translateRuntime('authRuntime.jwksHttps'));
  }
  return {
    ...validated,
    jwksUri,
    ...(typeof raw.userinfo_endpoint === 'string'
      ? { userInfoEndpoint: raw.userinfo_endpoint }
      : {}),
  };
}

function oidcSignatureVerifier(discovery: RuntimeDiscovery, signal?: AbortSignal): OidcIdTokenVerifier {
  return {
    async verify(idToken, expected) {
      const subtle = globalThis.crypto?.subtle;
      if (!subtle && !isNativeOidcRs256Available()) {
        throw new OidcRuntimeError(
          'unavailable',
          translateRuntime('authRuntime.verifierUnavailable'),
        );
      }
      const parts = idToken.split('.');
      if (parts.length !== 3) throw new Error(translateRuntime('authRuntime.identityNotJwt'));
      const protectedHeader = parseJwtPart(parts[0]);
      if (protectedHeader.alg !== 'RS256' || typeof protectedHeader.kid !== 'string') {
        throw new Error(translateRuntime('authRuntime.identityAlgorithm'));
      }
      const jwks = await fetchJson(
        discovery.jwksUri,
        { headers: { accept: 'application/json' }, signal },
        'signature-verification-failed',
      );
      const jwk = selectOidcRs256Jwk(jwks, protectedHeader.kid);
      const signingInput = `${parts[0]}.${parts[1]}`;
      const verified = subtle
        ? await (async () => {
            const key = await subtle.importKey(
              'jwk',
              jwk,
              { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
              false,
              ['verify'],
            );
            return subtle.verify(
              { name: 'RSASSA-PKCS1-v1_5' },
              key,
              ownedBytes(decodeOidcBase64Url(parts[2])),
              ownedBytes(new TextEncoder().encode(signingInput)),
            );
          })()
        : verifyOidcRs256Natively({
            signingInput,
            signatureBase64Url: parts[2],
            modulusBase64Url: jwk.n,
            exponentBase64Url: jwk.e,
          });
      if (!verified) throw new Error(translateRuntime('authRuntime.identitySignature'));
      const claims = parseJwtPart(parts[1]);
      if (claims.iss !== expected.issuer) throw new Error(translateRuntime('authRuntime.identityIssuer'));
      return claims as never;
    },
  };
}

export function isOidcSignatureVerificationAvailable(): boolean {
  return Boolean(globalThis.crypto?.subtle) || isNativeOidcRs256Available();
}

async function exchangeAuthorizationCode(
  discovery: RuntimeDiscovery,
  attempt: OidcAuthorizationAttempt,
  code: string,
  signal?: AbortSignal,
): Promise<OidcTokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: attempt.clientId,
    code,
    redirect_uri: attempt.redirectUri,
    code_verifier: attempt.codeVerifier,
  });
  const raw = await fetchJson(
    discovery.tokenEndpoint,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal,
    },
    'token-exchange-failed',
  );
  if (!isRecord(raw)) {
    throw new OidcRuntimeError('token-exchange-failed', translateRuntime('authRuntime.tokenResponseInvalid'));
  }
  return {
    accessToken: requireString(raw.access_token, translateRuntime('authRuntime.accessToken')),
    idToken: requireString(raw.id_token, translateRuntime('authRuntime.identityToken')),
    ...(typeof raw.refresh_token === 'string' ? { refreshToken: raw.refresh_token } : {}),
    ...(typeof raw.token_type === 'string' ? { tokenType: raw.token_type } : {}),
    ...(typeof raw.expires_in === 'number' ? { expiresIn: raw.expires_in } : {}),
  };
}

export function folioOidcRedirectUri() {
  return AuthSession.makeRedirectUri({
    scheme: 'folio-paperless',
    path: 'oauth/callback',
  });
}

export async function loginWithExpoOidc(
  input: {
    issuer: string;
    clientId: string;
    redirectUri: string;
    scopes: string[];
  },
  signal?: AbortSignal,
): Promise<OidcLoginResult> {
  if (!isOidcSignatureVerificationAvailable()) {
    throw new OidcRuntimeError(
      'unavailable',
      translateRuntime('authRuntime.signatureUnavailable'),
    );
  }
  const discovery = await discoverOidc(input.issuer, signal);
  const now = new Date();
  const start = await createOidcAuthorizationAttempt(
    {
      issuer: input.issuer,
      authorizationEndpoint: discovery.authorizationEndpoint,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      scopes: input.scopes,
      now: now.toISOString(),
    },
    {
      randomBytes: (length) => Crypto.getRandomBytes(length),
      sha256: async (value) =>
        new Uint8Array(await Crypto.digest(
          Crypto.CryptoDigestAlgorithm.SHA256,
          ownedBytes(value),
        )),
    },
  );
  if (signal?.aborted) throw new OidcRuntimeError('canceled', translateRuntime('authRuntime.signInCanceled'));
  const result = await WebBrowser.openAuthSessionAsync(
    start.authorizationUrl,
    input.redirectUri,
  );
  if (result.type !== 'success') {
    throw new OidcRuntimeError('canceled', translateRuntime('authRuntime.signInCanceled'));
  }
  const { code } = validateOidcCallback(start.attempt, result.url, {
    now: new Date().toISOString(),
  });
  const tokens = await exchangeAuthorizationCode(discovery, start.attempt, code, signal);
  const claims = await validateOidcTokenResponse(
    tokens,
    start.attempt,
    oidcSignatureVerifier(discovery, signal),
    { nowEpochSeconds: Math.floor(Date.now() / 1000) },
  ).catch((error) => {
    if (error instanceof OidcValidationError || error instanceof OidcRuntimeError) throw error;
    throw new OidcRuntimeError(
      'signature-verification-failed',
      translateRuntime('authRuntime.identityVerifyFailed'),
    );
  });
  return {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    idToken: tokens.idToken,
    ...(tokens.expiresIn
      ? { expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString() }
      : {}),
    subject: claims.sub,
  };
}

async function postTokenForm(
  endpoint: string,
  values: Record<string, string>,
  failureCode: OidcRuntimeErrorCode,
  signal?: AbortSignal,
) {
  return fetchJson(
    endpoint,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(values).toString(),
      signal,
    },
    failureCode,
  );
}

async function postFormAllowEmpty(
  endpoint: string,
  values: Record<string, string>,
  signal?: AbortSignal,
) {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(values).toString(),
      redirect: 'error',
      signal,
    });
  } catch {
    throw new OidcRuntimeError(
      'revocation-failed',
      translateRuntime('authRuntime.revokeUnreachable'),
      true,
    );
  }
  if (!response.ok) {
    throw new OidcRuntimeError(
      'revocation-failed',
      translateRuntime('authRuntime.revokeHttp', { status: response.status }),
      response.status === 408 || response.status === 429 || response.status >= 500,
    );
  }
}

export async function refreshOidcSession(
  profile: ConnectionProfile,
  oidc: StoredOidcSecrets,
  signal?: AbortSignal,
): Promise<StoredOidcSecrets> {
  if (profile.auth.kind !== 'oidc' || !oidc.refreshToken) return oidc;
  const expiresAt = oidc.expiresAt ? Date.parse(oidc.expiresAt) : Number.POSITIVE_INFINITY;
  if (expiresAt > Date.now() + 60_000) return oidc;
  const discovery = await discoverOidc(profile.auth.issuer, signal);
  const raw = await postTokenForm(
    discovery.tokenEndpoint,
    {
      grant_type: 'refresh_token',
      client_id: profile.auth.clientId,
      refresh_token: oidc.refreshToken,
    },
    'refresh-failed',
    signal,
  );
  if (!isRecord(raw) || typeof raw.access_token !== 'string' || !raw.access_token) {
    throw new OidcRuntimeError('refresh-failed', translateRuntime('authRuntime.refreshFailed'));
  }
  const expiresIn = typeof raw.expires_in === 'number' && raw.expires_in > 0
    ? raw.expires_in
    : undefined;
  return {
    accessToken: raw.access_token,
    refreshToken:
      typeof raw.refresh_token === 'string' && raw.refresh_token
        ? raw.refresh_token
        : oidc.refreshToken,
    ...(oidc.idToken ? { idToken: oidc.idToken } : {}),
    ...(expiresIn
      ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() }
      : {}),
  };
}

export async function revokeOidcSession(
  profile: ConnectionProfile,
  secrets: ProfileSecrets,
  options: { openLogout?: boolean; signal?: AbortSignal } = {},
) {
  if (profile.auth.kind !== 'oidc' || !secrets.oidc) {
    return { revoked: false, logoutOpened: false };
  }
  const discovery = await discoverOidc(profile.auth.issuer, options.signal);
  let revoked = false;
  const token = secrets.oidc.refreshToken ?? secrets.oidc.accessToken;
  if (discovery.revocationEndpoint && token) {
    await postFormAllowEmpty(
      discovery.revocationEndpoint,
      { token, client_id: profile.auth.clientId },
      options.signal,
    );
    revoked = true;
  }
  let logoutOpened = false;
  if (options.openLogout && discovery.endSessionEndpoint) {
    // Never put an ID/access/refresh token in a browser URL. URLs are exposed
    // to browser history, OS hand-off logs, proxies, and crash diagnostics.
    // Token revocation above is the authenticated sign-out operation; opening
    // the provider's allow-listed end-session endpoint is best-effort UI only.
    await WebBrowser.openBrowserAsync(discovery.endSessionEndpoint);
    logoutOpened = true;
  }
  return { revoked, logoutOpened };
}
