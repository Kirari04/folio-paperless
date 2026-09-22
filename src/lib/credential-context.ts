import { normalizePaperlessServerUrl } from './server-url.ts';
import type { PaperlessCredentials } from '@/types/document';

function normalizedCredentialHeaders(headers?: Record<string, string>) {
  return Object.entries(headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

/**
 * True when two credential objects address the same Paperless authority with
 * the same secrets. The app republishes a fresh credentials object on many
 * lifecycle events (foreground restore, cold-start hydration, a profile
 * snapshot reload) without any of these fields changing; consumers that key
 * caches or sessions on the credentials must compare by context, not by
 * object identity, or every such event looks like a new login.
 */
export function sameCredentialContext(
  left: PaperlessCredentials | null | undefined,
  right: PaperlessCredentials | null | undefined,
) {
  if (!left || !right) return left === right;
  try {
    return left.profileId === right.profileId
      && normalizePaperlessServerUrl(left.serverUrl) === normalizePaperlessServerUrl(right.serverUrl)
      && left.token === right.token
      && left.clientIdentityRef === right.clientIdentityRef
      && (left.authorizationScheme ?? 'Token') === (right.authorizationScheme ?? 'Token')
      && JSON.stringify(normalizedCredentialHeaders(left.customHeaders))
        === JSON.stringify(normalizedCredentialHeaders(right.customHeaders));
  } catch {
    return false;
  }
}
