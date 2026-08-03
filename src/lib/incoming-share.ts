import type { IntakeCandidate } from '../types/tasks.ts';
import { MAX_SHARED_TEXT_BYTES } from './intake.ts';

export type ResolvedIncomingShare = {
  contentUri: string | null;
  contentType: string | null;
  contentMimeType: string | null;
  mimeType?: string;
  shareType?: string;
  value?: string;
  originalName: string | null;
  contentSize: number | null;
};

export function incomingShareCandidates(
  payloads: ResolvedIncomingShare[],
  limit = Number.POSITIVE_INFINITY,
): IntakeCandidate[] {
  const candidates: IntakeCandidate[] = [];
  for (const [index, payload] of payloads.entries()) {
    if (candidates.length >= Math.max(0, limit)) break;
    const payloadMimeType = (payload.contentMimeType || payload.mimeType || 'text/plain')
      .split(';', 1)[0]
      .trim()
      .toLocaleLowerCase();
    if (
      (payload.contentType === 'text' || payload.shareType === 'text')
      && !payload.contentUri
      && payloadMimeType === 'text/plain'
      && typeof payload.value === 'string'
    ) {
      const size = new TextEncoder().encode(payload.value).byteLength;
      candidates.push({
        uri: `folio-shared-text://${index}/${textIdentity(payload.value)}`,
        name: payload.originalName || `shared-text-${index + 1}.txt`,
        mimeType: 'text/plain',
        size,
        textContent: payload.value,
      });
      continue;
    }
    // Preserve every URI-backed provider result. Unsupported media/web types
    // must reach the shared per-item validator as explicit rejections instead
    // of disappearing from mixed batches at this handoff boundary.
    if (!payload.contentUri) continue;
    candidates.push({
      uri: payload.contentUri,
      name: payload.originalName || `shared-document-${index + 1}`,
      mimeType: payload.contentMimeType || payload.mimeType,
      size: payload.contentSize,
    });
  }
  return candidates;
}

export function incomingShareSignature(candidates: IntakeCandidate[]) {
  return candidates
    .map((candidate) => `${candidate.uri}\u0000${candidate.size ?? ''}\u0000${candidate.mimeType ?? ''}\u0000${candidate.textContent === undefined ? '' : textIdentity(candidate.textContent)}`)
    .join('\u0001');
}

export function incomingSharePayloadSignature(payloads: ResolvedIncomingShare[]) {
  return payloads
    .map((payload) => [
      payload.contentType ?? '',
      payload.contentUri ?? '',
      payload.contentSize ?? '',
      payload.contentMimeType ?? payload.mimeType ?? '',
      payload.value === undefined ? '' : textIdentity(payload.value),
    ].join('\u0000'))
    .join('\u0001');
}

/** A non-reversible in-memory identity avoids placing sensitive shared text in
 * signatures while still distinguishing consecutive text shares. */
function textIdentity(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${new TextEncoder().encode(value).byteLength}:${(hash >>> 0).toString(16)}:${MAX_SHARED_TEXT_BYTES}`;
}
