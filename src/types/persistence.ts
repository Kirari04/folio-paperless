import type { DocumentItem, PaperlessCatalog } from './document.ts';
import type {
  PaperlessBulkResult,
  PaperlessCatalogObject,
  PaperlessCatalogResource,
} from './paperless-advanced.ts';
import type { PersistentBulkTaskTarget, PersistentTask, UploadPreset } from './tasks.ts';

export type BulkDocumentReconciliation = {
  result: PaperlessBulkResult;
  targets: PersistentBulkTaskTarget[];
  catalog: PaperlessCatalog;
  labels: {
    noCorrespondent: string;
    unknownCorrespondent: string;
    unsortedDocumentType: string;
    unknownDocumentType: string;
    automaticStoragePath: string;
    unknownStoragePath: string;
    unknownTag: string;
    reprocessing: string;
  };
};

export type ConfirmedCatalogMutation =
  | {
      kind: 'upsert';
      resource: PaperlessCatalogResource;
      object: PaperlessCatalogObject;
    }
  | {
      kind: 'delete';
      resource: PaperlessCatalogResource;
      remoteId: number;
    };

export type CatalogMutationLabels = {
  noCorrespondent: string;
  unsortedDocumentType: string;
  automaticStoragePath: string;
  unknownTag: string;
};

export type CachedWorkspace = {
  profileId: string;
  documents: DocumentItem[];
  catalog: PaperlessCatalog;
  totalDocuments: number;
  lastSyncedAt: string;
  lastFullSyncedAt?: string;
  syncState: 'current' | 'cached' | 'error';
  syncError?: string;
  /** Exact, profile-local server results for saved views whose rules may not be locally evaluable. */
  savedViewSnapshots?: Record<string, CachedSavedViewSnapshot>;
};

export type CachedSavedViewSnapshot = {
  viewId: string;
  viewFingerprint: string;
  documentIds: string[];
  totalDocuments: number;
  evaluatedAt: string;
};

export type CachedDocumentDetail = {
  profileId: string;
  documentId: string;
  document: DocumentItem;
  fetchedAt: string;
};

export type RouteAlias = {
  profileId: string;
  sourceId: string;
  targetId: string;
  createdAt: string;
};

export type CachedCapabilitySet = {
  profileId: string;
  fingerprint: string;
  value: unknown;
  discoveredAt: string;
};

export type OfflineFileRecord = {
  profileId: string;
  documentId: string;
  representation: 'original' | 'archive' | 'preview' | 'thumbnail';
  uri: string;
  /** Exact server-provided/display filename retained independently of the
   * opaque private-storage path. Older records may not have this metadata. */
  fileName?: string;
  /** Exact representation MIME type when Paperless supplied one. */
  mimeType?: string;
  byteSize: number;
  pinned: boolean;
  lastAccessedAt: string;
  createdAt: string;
};

export type TaskNotificationClaim = {
  profileId: string;
  taskId: string;
  dispatchId: string;
  leaseOwner: string;
  leaseExpiresAt: string;
  updatedAt: string;
};

export type ProfileDataCounts = {
  documents: number;
  tasks: number;
  presets: number;
  offlineFiles: number;
};

export type ProfileRemovalTombstone = {
  operationId: string;
  profileId: string;
  createdAt: string;
};

export type ProfileRemovalManifestRecord = {
  schemaVersion: 1;
  reference: string;
  operationId: string;
  profileId: string;
  createdAt: string;
  /** Non-secret, adapter-validated recovery data. This deliberately lives in
   * SQLite rather than the size-constrained protected key-value store. */
  data: unknown;
};

export interface FolioRepository {
  initialize(): Promise<void>;
  readWorkspace(profileId: string): Promise<CachedWorkspace | null>;
  replaceWorkspace(workspace: CachedWorkspace): Promise<void>;
  /** Atomically projects only confirmed synchronous bulk successes into the
   * latest snapshot for this exact profile. */
  reconcileBulkDocuments(
    profileId: string,
    reconciliation: BulkDocumentReconciliation,
  ): Promise<CachedWorkspace | null>;
  /** Atomically publishes one confirmed server saved-view mutation into its profile workspace. */
  upsertSavedView(profileId: string, view: import('./document.ts').PaperlessSavedView): Promise<void>;
  /** Atomically removes one confirmed server saved-view deletion and its exact offline snapshot. */
  deleteSavedView(profileId: string, remoteId: number): Promise<void>;
  /** Atomically projects a confirmed catalog mutation into cached summaries and details. */
  reconcileCatalogMutation(
    profileId: string,
    mutation: ConfirmedCatalogMutation,
    labels: CatalogMutationLabels,
  ): Promise<CachedWorkspace>;
  /** Atomically updates one saved-view snapshot without replacing a concurrent workspace sync. */
  writeSavedViewSnapshot(profileId: string, snapshot: CachedSavedViewSnapshot): Promise<void>;
  writeWorkspaceError(profileId: string, error: string): Promise<void>;
  readDocumentDetail(profileId: string, documentId: string): Promise<CachedDocumentDetail | null>;
  writeDocumentDetail(detail: CachedDocumentDetail): Promise<void>;
  listTasks(profileId: string): Promise<PersistentTask[]>;
  readTask(profileId: string, taskId: string): Promise<PersistentTask | null>;
  writeTask(task: PersistentTask): Promise<void>;
  /** Atomically persists an intake batch or writes none of it. */
  writeTasks(tasks: readonly PersistentTask[]): Promise<void>;
  claimTask(
    task: PersistentTask,
    workerId: string,
    now: Date,
    leaseMs?: number,
  ): Promise<PersistentTask | null>;
  /** Renews only the still-current owner's unexpired lease; never reclaims a completed or replaced task. */
  renewTaskLease(
    profileId: string,
    taskId: string,
    workerId: string,
    now: Date,
    leaseMs?: number,
  ): Promise<PersistentTask | null>;
  /** Atomically commits a workspace and terminal sync task only for the exact live lease. */
  commitWorkspaceSync(
    workspace: CachedWorkspace,
    expectedLease: PersistentTask,
    completedTask: PersistentTask,
    now: Date,
  ): Promise<boolean>;
  claimNextRunnableTask(
    profileId: string,
    workerId: string,
    now: Date,
    leaseMs?: number,
  ): Promise<PersistentTask | null>;
  /** Claims only queued/due metadata updates so upload workers never receive
   * metadata jobs and concurrent foreground triggers cannot send one twice. */
  claimNextMetadataTask(
    profileId: string,
    workerId: string,
    now: Date,
    leaseMs?: number,
  ): Promise<PersistentTask | null>;
  /** Claims queued, interrupted, or due offline downloads without exposing
   * them to upload workers. */
  claimNextOfflineDownloadTask(
    profileId: string,
    workerId: string,
    now: Date,
    leaseMs?: number,
  ): Promise<PersistentTask | null>;
  /** Compare-and-swap update for a task still owned by the exact live lease. */
  updateLeasedTask(
    expectedLease: PersistentTask,
    updatedTask: PersistentTask,
    now: Date,
  ): Promise<PersistentTask | null>;
  /** Atomically persists an optimistic metadata task and its cache projection. */
  writeMetadataTask(
    task: PersistentTask,
    workspaceDocument: DocumentItem,
    detailDocument?: DocumentItem,
  ): Promise<void>;
  /** Commits a metadata worker result only for the exact unexpired lease. */
  commitMetadataTask(
    expectedLease: PersistentTask,
    completedTask: PersistentTask,
    serverDocument: DocumentItem | null,
    now: Date,
  ): Promise<boolean>;
  deleteTask(profileId: string, taskId: string): Promise<void>;
  listPresets(profileId: string): Promise<UploadPreset[]>;
  writePreset(preset: UploadPreset): Promise<void>;
  deletePreset(profileId: string, presetId: string): Promise<void>;
  readRouteAlias(profileId: string, sourceId: string): Promise<RouteAlias | null>;
  listRouteAliases(profileId: string): Promise<RouteAlias[]>;
  writeRouteAlias(alias: RouteAlias): Promise<void>;
  listOfflineFiles(profileId: string): Promise<OfflineFileRecord[]>;
  writeOfflineFile(file: OfflineFileRecord): Promise<void>;
  deleteOfflineFile(profileId: string, documentId: string, representation: OfflineFileRecord['representation']): Promise<void>;
  /** A durable notification outbox prevents foreground/background completion
   * handlers from dispatching the same task notification concurrently. */
  claimTaskNotification(
    profileId: string,
    taskId: string,
    workerId: string,
    dispatchId: string,
    now: Date,
    leaseMs?: number,
  ): Promise<TaskNotificationClaim | null>;
  completeTaskNotification(
    claim: TaskNotificationClaim,
    now: Date,
  ): Promise<PersistentTask | null>;
  releaseTaskNotification(claim: TaskNotificationClaim, now: Date): Promise<boolean>;
  readCapabilities(profileId: string): Promise<CachedCapabilitySet | null>;
  writeCapabilities(capabilities: CachedCapabilitySet): Promise<void>;
  profileDataCounts(profileId: string): Promise<ProfileDataCounts>;
  deleteProfileData(profileId: string): Promise<void>;
  /** Deletes one profile's rows and records the removal decision atomically. */
  deleteProfileDataAndWriteRemovalTombstone(
    tombstone: ProfileRemovalTombstone,
  ): Promise<void>;
  writeProfileRemovalManifest(manifest: ProfileRemovalManifestRecord): Promise<void>;
  readProfileRemovalManifest(operationId: string): Promise<ProfileRemovalManifestRecord | null>;
  deleteProfileRemovalManifest(operationId: string): Promise<void>;
  readProfileRemovalTombstone(operationId: string): Promise<ProfileRemovalTombstone | null>;
}
