import type {
  PaperlessCustomFieldDataType,
  PaperlessCustomFieldValue,
  PaperlessOption,
} from './document.ts';
import type {
  PaperlessBulkOperation,
  PaperlessBulkSkipReason,
} from './paperless-advanced.ts';

export const PERSISTED_TASK_SCHEMA_VERSION = 4 as const;
export const UPLOAD_PRESET_SCHEMA_VERSION = 1 as const;

export type ExplicitValue<T> =
  | { state: 'unset' }
  | { state: 'clear' }
  | { state: 'value'; value: T };

export type UploadCustomFieldDraft = {
  fieldId: string;
  fieldRemoteId?: number;
  /** A persisted schema snapshot lets a queued draft remain safely
   * validateable if the live catalog changes before it is submitted. */
  dataType?: PaperlessCustomFieldDataType;
  selectOptionIds?: string[];
  defaultCurrency?: string;
  value: ExplicitValue<PaperlessCustomFieldValue['value']>;
};

export type UploadMetadataDraft = {
  title: ExplicitValue<string>;
  created: ExplicitValue<string>;
  correspondent: ExplicitValue<PaperlessOption>;
  documentType: ExplicitValue<PaperlessOption>;
  tags: ExplicitValue<PaperlessOption[]>;
  storagePath: ExplicitValue<PaperlessOption>;
  archiveSerialNumber: ExplicitValue<number>;
  owner: ExplicitValue<PaperlessOption>;
  workflow: ExplicitValue<PaperlessOption>;
  customFields: UploadCustomFieldDraft[];
};

export type UploadPresetCreatedDate = 'paperless' | 'today' | 'last-used';

export type UploadPreset = {
  schemaVersion: typeof UPLOAD_PRESET_SCHEMA_VERSION;
  id: string;
  profileId: string;
  name: string;
  icon?: string;
  color?: string;
  createdDateBehavior: UploadPresetCreatedDate;
  metadata: UploadMetadataDraft;
  filenameTitle: 'sanitized' | 'original' | 'blank';
  autoSubmit: boolean;
  defaultFor?: Exclude<IntakeSource, 'unknown'>[];
  createdAt: string;
  updatedAt: string;
};

export type IntakeSource = 'camera' | 'picker' | 'share' | 'unknown';

export type PersistentTaskKind =
  | 'upload'
  | 'paperless-processing'
  | 'offline-download'
  | 'metadata-update'
  | 'sync'
  | 'bulk-operation'
  | 'pdf-operation';

export type PersistentTaskStage =
  | 'preparing'
  | 'queued'
  | 'uploading'
  /** The document bytes may have reached Paperless, but no server task ID is
   * durable. This state is deliberately not runnable without confirmation. */
  | 'submission-uncertain'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'canceled';

export type PersistentTaskErrorCode =
  | 'network'
  | 'timeout'
  | 'submission-uncertain'
  | 'rate-limited'
  | 'server'
  | 'authentication'
  | 'permission'
  | 'missing-file'
  | 'unsupported-file'
  | 'invalid-metadata'
  | 'conflict'
  | 'processing-failed'
  | 'cleanup-failed'
  | 'unknown';

export type PersistentTaskError = {
  code: PersistentTaskErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
};

export type PersistentBulkTaskTarget = {
  /** Stable client-side identity retained even when the document is not remote. */
  localId: string;
  remoteDocumentId?: number;
};

export type PersistentBulkTaskPayload = {
  /** Normalized, transport-independent operation. It is deliberately distinct
   * from Paperless endpoint payloads so a retry can select the compatible API. */
  operation: PaperlessBulkOperation;
  /** Every durable item represented by this task. A shared asynchronous
   * Paperless job may own several targets without losing their stable IDs. */
  targets: PersistentBulkTaskTarget[];
};

export type PersistentBulkItemOutcome = PersistentBulkTaskTarget & {
  state: 'pending' | 'succeeded' | 'failed' | 'skipped';
  /** Accepted jobs may intentionally share one Paperless task ID. Terminal
   * retry preparation removes only the IDs belonging to the failed attempt. */
  paperlessTaskId?: string;
  error?: PersistentTaskError;
  skipReason?: PaperlessBulkSkipReason;
};

export type PersistentTaskResult = {
  remoteDocumentId?: number;
  routeDocumentId?: string;
  duplicateDocumentIds?: number[];
  summary?: string;
  bulkOutcomes?: PersistentBulkItemOutcome[];
};

export type PersistentMetadataOption = {
  remoteId: number;
  name: string;
};

export type PersistentMetadataCustomField = {
  fieldRemoteId: number;
  value: string | number | boolean | number[] | null;
};

/** Only fields with an explicit key are changed. Values contain no catalog
 * objects, local-only IDs, functions, or undefined values. */
export type PersistentMetadataPatch = {
  title?: string;
  correspondent?: PersistentMetadataOption | null;
  documentType?: PersistentMetadataOption | null;
  tags?: PersistentMetadataOption[];
  created?: string;
  storagePath?: PersistentMetadataOption | null;
  archiveSerialNumber?: number | null;
  customFields?: PersistentMetadataCustomField[];
};

export type PersistentMetadataField = keyof PersistentMetadataPatch;

export type PersistentMetadataUpdate = {
  documentId: string;
  remoteDocumentId: number;
  baseline: {
    /** Paperless' last-modified value observed when the local edit began. */
    modifiedAt?: string;
    /** Original values for precisely the fields present in `patch`. */
    values: PersistentMetadataPatch;
  };
  patch: PersistentMetadataPatch;
  conflict?: {
    detectedAt: string;
    serverModifiedAt?: string;
    conflictingFields: PersistentMetadataField[];
    /** Current server values for the edited fields, used by explicit discard
     * or overwrite resolution even if the device goes offline again. */
    serverValues: PersistentMetadataPatch;
  };
};

export type PersistentTask = {
  schemaVersion: typeof PERSISTED_TASK_SCHEMA_VERSION;
  id: string;
  profileId: string;
  batchId?: string;
  kind: PersistentTaskKind;
  stage: PersistentTaskStage;
  source: IntakeSource;
  /** Exact source-provided filename. Display metadata only; never a path. */
  originalName?: string;
  /** Sanitized, collision-resistant filename in profile-private storage. */
  stagedName?: string;
  localUri?: string;
  byteSize?: number;
  mimeType?: string;
  documentId?: string;
  offlineRepresentation?: 'original' | 'archive' | 'preview' | 'thumbnail';
  metadata?: UploadMetadataDraft;
  presetId?: string;
  progress: number;
  paperlessTaskId?: string;
  bulk?: PersistentBulkTaskPayload;
  metadataUpdate?: PersistentMetadataUpdate;
  retryCount: number;
  nextAttemptAt?: string;
  lastAttemptAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  cancelRequestedAt?: string;
  /** `local` proves no active worker or server task existed when canceled.
   * `acceptance-uncertain` stops local tracking while retaining staged bytes. */
  cancellationDisposition?: 'local' | 'acceptance-uncertain';
  error?: PersistentTaskError;
  result?: PersistentTaskResult;
  notificationSentAt?: string;
  /** Written by a background worker when a ready upload still needs
   * foreground-only alias, hydration, and notification side effects. */
  foregroundReconciliationRequestedAt?: string;
  /** Written only after those foreground side effects complete successfully. */
  foregroundReconciledAt?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type IntakeCandidate = {
  uri: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
  /** Plain text shares have no readable content URI; staging writes this
   * bounded value into a profile-private text file. */
  textContent?: string;
};

export type IntakeRejection = {
  candidate: IntakeCandidate;
  error: PersistentTaskError;
};

export type IntakeBatchResult = {
  accepted: PersistentTask[];
  rejected: IntakeRejection[];
};

export function unsetValue<T>(): ExplicitValue<T> {
  return { state: 'unset' };
}

export function defaultUploadMetadataDraft(title?: string): UploadMetadataDraft {
  return {
    title: title ? { state: 'value', value: title } : unsetValue(),
    created: unsetValue(),
    correspondent: unsetValue(),
    documentType: unsetValue(),
    tags: unsetValue(),
    storagePath: unsetValue(),
    archiveSerialNumber: unsetValue(),
    owner: unsetValue(),
    workflow: unsetValue(),
    customFields: [],
  };
}
