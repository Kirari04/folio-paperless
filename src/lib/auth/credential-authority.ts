import type { PaperlessCredentials } from '../../types/document.ts';
import {
  normalizeServerBaseUrl,
  type ConnectionProfile,
  type ProfileSecrets,
  type StoredOidcSecrets,
} from './profile-store.ts';

function credentialHeadersMatch(
  left?: Readonly<Record<string, string>>,
  right?: Readonly<Record<string, string>>,
) {
  const leftEntries = Object.entries(left ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName));
  const rightEntries = Object.entries(right ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([name, value], index) => (
      name === rightEntries[index]?.[0] && value === rightEntries[index]?.[1]
    ));
}

function oidcSecretsMatch(left?: StoredOidcSecrets, right?: StoredOidcSecrets) {
  if (!left || !right) return left === right;
  return left.accessToken === right.accessToken
    && left.refreshToken === right.refreshToken
    && left.idToken === right.idToken
    && left.expiresAt === right.expiresAt;
}

/**
 * Compares authority-bearing values directly in memory. It deliberately does
 * not serialize, hash, log, or persist an additional derivative of a secret.
 */
export function profileSecretsAuthorizeSameContext(
  left: ProfileSecrets | null,
  right: ProfileSecrets | null,
) {
  if (!left || !right) return left === right;
  return left.apiToken === right.apiToken
    && oidcSecretsMatch(left.oidc, right.oidc)
    && left.clientIdentityRef === right.clientIdentityRef
    && credentialHeadersMatch(left.customHeaders, right.customHeaders);
}

/** Ensures captured request credentials still describe the current authority. */
export function credentialsMatchStoredProfile(
  credentials: PaperlessCredentials,
  profile: ConnectionProfile,
  secrets: ProfileSecrets,
) {
  let sameServer = false;
  try {
    sameServer = normalizeServerBaseUrl(credentials.serverUrl)
      === normalizeServerBaseUrl(profile.serverUrl);
  } catch {
    return false;
  }
  if (credentials.profileId !== profile.id || !sameServer) return false;

  if (profile.auth.kind === 'mutual-tls') {
    return credentials.token === ''
      && credentials.clientIdentityRef === secrets.clientIdentityRef
      && credentials.authorizationScheme === undefined
      && credentialHeadersMatch(credentials.customHeaders, undefined);
  }

  const token = secrets.apiToken ?? secrets.oidc?.accessToken ?? '';
  const customHeaders = secrets.customHeaders;
  if (!token && Object.keys(customHeaders ?? {}).length === 0) return false;
  return credentials.clientIdentityRef === undefined
    && credentials.token === token
    && (credentials.authorizationScheme ?? 'Token') === (secrets.oidc ? 'Bearer' : 'Token')
    && credentialHeadersMatch(credentials.customHeaders, customHeaders);
}
