import { applyUploadMetadata } from './upload-metadata.ts';
import type { PaperlessOption } from '../types/document.ts';
import type { UploadMetadataDraft } from '../types/tasks.ts';

/**
 * Scanning happens in batches: ten annexes of one folder reach Paperless with
 * the same correspondent, the same document type, and the same tags. The
 * upload sheet therefore opens filled in like the previous successful upload
 * of the same connection profile, says so, and offers to clear it.
 *
 * The memory is deliberately weak. It lives in memory only, so it disappears
 * with the process, and it expires an hour after the upload it describes: a
 * batch is contiguous, and a document scanned the next morning belongs to
 * another one.
 */
export const UPLOAD_BATCH_PREFILL_TTL_MS = 60 * 60 * 1_000;

/**
 * Fields a batch prefill may carry. A title belongs to one piece of paper, and
 * an archive serial number must stay unique in Paperless, so neither is ever
 * copied from the previous upload. The exclusion is a type, not a convention.
 */
export type UploadBatchPrefillField = Exclude<
  keyof UploadMetadataDraft,
  'title' | 'archiveSerialNumber'
>;

export const UPLOAD_BATCH_PREFILL_FIELDS = [
  'created',
  'correspondent',
  'documentType',
  'tags',
  'storagePath',
  'owner',
  'workflow',
  'customFields',
] as const satisfies readonly UploadBatchPrefillField[];

export type UploadBatchPrefillMetadata = Partial<
  Pick<UploadMetadataDraft, UploadBatchPrefillField>
>;

export type UploadBatchPrefillOrigin =
  /** The previous successful upload of this connection profile. */
  | 'previous-upload'
  /** The tags of the library filter or saved view in view, first upload only. */
  | 'library-filter'
  /** A `folio-paperless://scan?tags=…` link that opened the scanner. */
  | 'link';

export type UploadBatchPrefill = {
  profileId: string;
  origin: UploadBatchPrefillOrigin;
  /** Tag or saved-view label shown by a filter or link prefill. */
  label?: string;
  metadata: UploadBatchPrefillMetadata;
  recordedAt: number;
};

/** Recent staged batches whose prefill the upload sheet can still describe. */
export const MAX_TRACKED_UPLOAD_BATCH_PREFILLS = 8;

export type AppliedUploadBatchPrefill = {
  batchId: string;
  origin: UploadBatchPrefillOrigin;
  label?: string;
  /** What the sheet actually filled in, so "Reset" clears exactly that. */
  fields: readonly UploadBatchPrefillField[];
};

function carriesValue(
  metadata: UploadBatchPrefillMetadata,
  field: UploadBatchPrefillField,
): boolean {
  if (field === 'customFields') {
    return !!metadata.customFields?.some((entry) => entry.value.state !== 'unset');
  }
  const value = metadata[field];
  if (!value || value.state === 'unset') return false;
  if (field === 'tags' && value.state === 'value') {
    return Array.isArray(value.value) && value.value.length > 0;
  }
  return true;
}

/** The fields of a prefill that actually carry something to fill in. */
export function uploadBatchPrefillFields(
  metadata: UploadBatchPrefillMetadata,
): UploadBatchPrefillField[] {
  return UPLOAD_BATCH_PREFILL_FIELDS.filter((field) => carriesValue(metadata, field));
}

export function isUploadBatchPrefillEmpty(metadata: UploadBatchPrefillMetadata) {
  return uploadBatchPrefillFields(metadata).length === 0;
}

/**
 * Keeps only the fields worth repeating from a completed upload. Absent fields
 * are left out rather than written as `unset`, so a source-default preset
 * still owns the fields the previous upload did not fill in.
 */
export function uploadBatchPrefillFromMetadata(
  metadata: UploadMetadataDraft,
): UploadBatchPrefillMetadata {
  const prefill: UploadBatchPrefillMetadata = {};
  for (const field of UPLOAD_BATCH_PREFILL_FIELDS) {
    if (!carriesValue(metadata, field)) continue;
    if (field === 'customFields') {
      prefill.customFields = metadata.customFields
        .filter((entry) => entry.value.state !== 'unset')
        .map((entry) => ({ ...entry }));
      continue;
    }
    Object.assign(prefill, { [field]: metadata[field] });
  }
  return prefill;
}

/** A prefill that carries tags only, for a library filter or a scan link. */
export function tagsUploadBatchPrefill(
  tags: readonly PaperlessOption[],
): UploadBatchPrefillMetadata {
  return tags.length ? { tags: { state: 'value', value: [...tags] } } : {};
}

/**
 * The first upload of a session has no previous one. When the library is
 * filtered by tags, or shows a saved view, those tags are the best available
 * intent. Only the tags are taken: a filter may legitimately mix
 * correspondents and document types, so nothing else can be inferred from it.
 */
export function libraryFilterUploadBatchPrefill(
  tagIds: readonly string[],
  catalogTags: readonly PaperlessOption[],
  label?: string,
): { metadata: UploadBatchPrefillMetadata; label?: string } | null {
  const tags = tagIds
    .map((id) => catalogTags.find((tag) => tag.id === id))
    .filter((tag): tag is PaperlessOption => !!tag && tag.remoteId !== undefined);
  if (!tags.length) return null;
  return {
    metadata: tagsUploadBatchPrefill(tags),
    label: label?.trim() || tags.map((tag) => tag.name).join(', '),
  };
}

/**
 * Fills a staged draft in. The prefill cannot reach the title or the archive
 * serial number, so both keep the value the staging step computed.
 */
export function applyUploadBatchPrefill(
  base: UploadMetadataDraft,
  metadata: UploadBatchPrefillMetadata,
): UploadMetadataDraft {
  return applyUploadMetadata(base, metadata);
}

/** Restores the prefilled fields of a draft to their unfilled state. */
export function clearUploadBatchPrefillFields(
  draft: UploadMetadataDraft,
  fields: readonly UploadBatchPrefillField[],
): UploadMetadataDraft {
  const next = { ...draft };
  for (const field of fields) {
    if (field === 'customFields') next.customFields = [];
    else Object.assign(next, { [field]: { state: 'unset' } });
  }
  return next;
}

/**
 * The remembered upload of each connection profile. A profile never reads
 * another profile's batch, and an entry older than the time-to-live is dropped
 * on read rather than being refreshed by the read.
 */
export class UploadBatchPrefillMemory {
  private readonly entries = new Map<string, UploadBatchPrefill>();
  private readonly ttlMs: number;

  constructor(ttlMs = UPLOAD_BATCH_PREFILL_TTL_MS) {
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000) {
      throw new Error('The batch prefill lifetime must be at least one second.');
    }
    this.ttlMs = ttlMs;
  }

  remember(
    entry: Omit<UploadBatchPrefill, 'recordedAt'>,
    now = Date.now(),
  ): UploadBatchPrefill | null {
    if (!entry.profileId || isUploadBatchPrefillEmpty(entry.metadata)) {
      this.entries.delete(entry.profileId);
      return null;
    }
    const remembered: UploadBatchPrefill = { ...entry, recordedAt: now };
    this.entries.set(entry.profileId, remembered);
    return remembered;
  }

  /** Records a completed upload. Only a success reaches this method. */
  rememberUpload(
    profileId: string,
    metadata: UploadMetadataDraft | undefined,
    now = Date.now(),
  ) {
    if (!metadata) return null;
    return this.remember({
      profileId,
      origin: 'previous-upload',
      metadata: uploadBatchPrefillFromMetadata(metadata),
    }, now);
  }

  rememberTags(
    profileId: string,
    tags: readonly PaperlessOption[],
    options: { origin: UploadBatchPrefillOrigin; label?: string },
    now = Date.now(),
  ) {
    return this.remember({
      profileId,
      origin: options.origin,
      ...(options.label ? { label: options.label } : {}),
      metadata: tagsUploadBatchPrefill(tags),
    }, now);
  }

  read(profileId: string, now = Date.now()): UploadBatchPrefill | null {
    const entry = this.entries.get(profileId);
    if (!entry) return null;
    if (now - entry.recordedAt >= this.ttlMs) {
      this.entries.delete(profileId);
      return null;
    }
    return entry;
  }

  forget(profileId: string) {
    this.entries.delete(profileId);
  }

  clear() {
    this.entries.clear();
  }
}
