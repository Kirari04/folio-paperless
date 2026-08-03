import type { PaperlessRepresentation } from '../types/paperless-advanced.ts';

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

export type RepresentationVerificationFailure =
  | 'metadata-unverifiable'
  | 'size-mismatch'
  | 'checksum-mismatch';

export class RepresentationVerificationError extends Error {
  readonly code: RepresentationVerificationFailure;

  constructor(code: RepresentationVerificationFailure, message: string) {
    super(message);
    this.name = 'RepresentationVerificationError';
    this.code = code;
  }
}

export function expectedRepresentationChecksum(checksum: unknown) {
  return typeof checksum === 'string' && SHA256_PATTERN.test(checksum.trim())
    ? checksum.trim().toLocaleLowerCase()
    : null;
}

/**
 * Paperless 3.0.x silently returns the original when an archive is absent.
 * A selected representation is therefore trusted only after its SHA-256 is
 * matched to the version-scoped metadata. Size is checked as an additional
 * truncation/fallback signal, but is not sufficient proof of identity alone.
 */
export function verifyRepresentationDescriptor(input: {
  actualChecksum: string;
  actualSize: number;
  expectedChecksum: unknown;
  expectedSize: number | null;
  representation: PaperlessRepresentation;
}) {
  const expectedChecksum = expectedRepresentationChecksum(input.expectedChecksum);
  if (!expectedChecksum) {
    throw new RepresentationVerificationError(
      'metadata-unverifiable',
      `Paperless did not provide a verifiable SHA-256 for the selected ${input.representation} representation.`,
    );
  }
  if (
    input.expectedSize !== null
    && (!Number.isSafeInteger(input.expectedSize) || input.expectedSize < 0)
  ) {
    throw new RepresentationVerificationError(
      'metadata-unverifiable',
      `Paperless returned an invalid size for the selected ${input.representation} representation.`,
    );
  }
  if (input.expectedSize !== null && input.actualSize !== input.expectedSize) {
    throw new RepresentationVerificationError(
      'size-mismatch',
      `The downloaded ${input.representation} representation did not match its version-scoped size.`,
    );
  }
  if (input.actualChecksum.toLocaleLowerCase() !== expectedChecksum) {
    throw new RepresentationVerificationError(
      'checksum-mismatch',
      `The downloaded ${input.representation} representation did not match its version-scoped SHA-256.`,
    );
  }
}

export async function verifyRepresentationOrCleanup<T>(
  verification: () => Promise<T> | T,
  cleanup: () => void,
) {
  try {
    return await verification();
  } catch (error) {
    cleanup();
    throw error;
  }
}
