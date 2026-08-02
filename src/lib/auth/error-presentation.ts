import type { TranslationKey } from '../../i18n/catalogs.ts';
import { presentRuntimeMessage } from '../../i18n/error-presentation.ts';
import { translateRuntime } from '../../i18n/runtime.ts';

const AUTH_ERROR_KEYS: Readonly<Record<string, TranslationKey>> = {
  'invalid-token': 'profileError.invalidToken',
  'invalid-credentials': 'profileError.invalidCredentials',
  'authentication-failure': 'profileError.invalidCredentials',
  'otp-required': 'profileError.otpRequired',
  'otp-invalid': 'profileError.otpInvalid',
  'rate-limited': 'profileError.rateLimited',
  'unsafe-redirect': 'profileError.unsafeRedirect',
  'unexpected-redirect': 'profileError.unsafeRedirect',
  'redirect-not-followed': 'profileError.unsafeRedirect',
  'invalid-redirect-url': 'profileError.unsafeRedirect',
  'https-downgrade': 'profileError.unsafeRedirect',
  'cross-origin-redirect': 'profileError.unsafeRedirect',
  'unexpected-response': 'profileError.unexpectedResponse',
  'invalid-response': 'profileError.unexpectedResponse',
  'network-failure': 'profileError.network',
  'invalid-configuration': 'profileError.oidcConfiguration',
  'invalid-callback': 'profileError.oidcCallback',
  'state-mismatch': 'profileError.oidcCallback',
  'redirect-mismatch': 'profileError.oidcCallback',
  'nonce-mismatch': 'profileError.oidcCallback',
  'replayed-callback': 'profileError.oidcCallback',
  'expired-attempt': 'profileError.oidcExpired',
  'expired-id-token': 'profileError.oidcExpired',
  'provider-error': 'profileError.oidcProvider',
  'invalid-token-response': 'profileError.oidcToken',
  'issuer-mismatch': 'profileError.oidcVerification',
  'audience-mismatch': 'profileError.oidcVerification',
  unavailable: 'profileError.oidcVerification',
  'discovery-failed': 'profileError.oidcDiscovery',
  'token-exchange-failed': 'profileError.oidcToken',
  'signature-verification-failed': 'profileError.oidcVerification',
  'refresh-failed': 'profileError.oidcRefresh',
  'revocation-failed': 'profileError.oidcRevoke',
  'native-mtls-transport-unavailable': 'profileError.mtlsUnavailable',
  'client-identity-selection-canceled': 'profileError.mtlsCanceled',
  'client-identity-request-canceled': 'profileError.mtlsCanceled',
  'client-identity-not-found': 'profileError.mtlsMissing',
  'client-identity-unavailable': 'profileError.mtlsMissing',
  'client-identity-import-failed': 'profileError.mtlsImport',
  'client-identity-missing-private-key': 'profileError.mtlsPrivateKey',
  'client-identity-not-yet-valid': 'profileError.mtlsNotYetValid',
  'client-identity-expired': 'profileError.mtlsExpired',
  'client-identity-origin-mismatch': 'profileError.mtlsOrigin',
  'client-identity-request-failed': 'profileError.mtlsRequest',
  'tls-failure': 'profileError.tls',
  'insufficient-permissions': 'profileError.permissions',
  'unsupported-api': 'profileError.unsupportedApi',
  canceled: 'profileError.canceled',
  'invalid-profile': 'profileError.profileInvalid',
  'invalid-profile-index': 'profileError.profileInvalid',
  'duplicate-profile-id': 'profileError.profileInvalid',
  'invalid-profile-name': 'profileError.profileInvalid',
  'invalid-server-url': 'profileError.profileInvalid',
  'invalid-legacy-credentials': 'profileError.secretInvalid',
  'invalid-profile-secret': 'profileError.secretInvalid',
  'profile-not-found': 'profileError.profileMissing',
  'too-many-custom-headers': 'profileError.headers',
};

export function authErrorTranslationKey(error: unknown): TranslationKey | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return AUTH_ERROR_KEYS[String(error.code)] ?? null;
}

/** Localizes Folio-owned authentication failures while preserving unknown
 * provider/server errors verbatim as untrusted server-owned content. */
export function presentAuthError(error: unknown): string {
  const key = authErrorTranslationKey(error);
  if (key) return translateRuntime(key);
  return error instanceof Error
    ? presentRuntimeMessage(error.message)
    : translateRuntime('appError.generic');
}
