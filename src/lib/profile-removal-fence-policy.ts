import { profileDirectoryName } from './profile-file-path-policy.ts';
import { assertSafeTemporaryPathSegment } from './temporary-file-policy.ts';

export const NATIVE_PROFILE_REMOVAL_FENCE_DIRECTORY = 'profile-removal-fences';

export type NativeProfileRemovalFenceDisposition =
  | 'retain-after-profile-deletion'
  | 'remove-after-purge';

export type NativeProfileRemovalFence = {
  version: 1;
  operationId: string;
  profileId: string;
  disposition: NativeProfileRemovalFenceDisposition;
};

export function assertNativeProfileRemovalFenceDisposition(
  value: unknown,
): NativeProfileRemovalFenceDisposition {
  if (value !== 'retain-after-profile-deletion' && value !== 'remove-after-purge') {
    throw new Error('The profile file removal fence disposition is invalid.');
  }
  return value;
}

export function validateNativeProfileRemovalFence(
  value: unknown,
): NativeProfileRemovalFence {
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { profileId?: unknown }).profileId !== 'string' ||
    typeof (value as { operationId?: unknown }).operationId !== 'string'
  ) {
    throw new Error('The profile removal fence is invalid.');
  }
  const candidate = value as Record<string, unknown>;
  const profileId = profileDirectoryName(candidate.profileId as string);
  const operationId = assertSafeTemporaryPathSegment(
    candidate.operationId as string,
    'The profile removal operation ID',
  );
  const disposition = assertNativeProfileRemovalFenceDisposition(candidate.disposition);
  if (
    profileId !== candidate.profileId ||
    operationId !== candidate.operationId ||
    disposition !== candidate.disposition
  ) {
    throw new Error('The profile removal fence is invalid.');
  }
  return {
    version: 1,
    profileId,
    operationId,
    disposition,
  };
}

export function profileRemovalFencePathSegments(profileId: string) {
  return [
    'folio',
    NATIVE_PROFILE_REMOVAL_FENCE_DIRECTORY,
    `${profileDirectoryName(profileId)}.json`,
  ] as const;
}

export function profileRemovalFenceCandidateName(operationId: string) {
  const exactOperationId = assertSafeTemporaryPathSegment(
    operationId,
    'The profile removal operation ID',
  );
  return `.${exactOperationId}.fence-candidate`;
}

export function serializeNativeProfileRemovalFence(value: NativeProfileRemovalFence) {
  return JSON.stringify(validateNativeProfileRemovalFence(value));
}

export function parseNativeProfileRemovalFence(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('The profile removal fence is invalid.');
  }
  return validateNativeProfileRemovalFence(parsed);
}
