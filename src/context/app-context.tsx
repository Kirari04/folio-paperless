import * as SecureStore from 'expo-secure-store';
import { File } from 'expo-file-system';
import NetInfo from '@react-native-community/netinfo';
import { AppState, Platform } from 'react-native';
import {
  PropsWithChildren,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { themeHex } from '@/constants/theme-colors';
import { demoDocuments } from '@/data/demo-documents';
import {
  dismissProfileNotifications,
  notifyUploadCompleted,
  requestProcessingNotificationPermission,
  requireBiometricSupport,
  setRuntimeNotificationPreferences,
} from '@/lib/device-features';
import { savePaperlessDocument, sharePaperlessDocument } from '@/lib/document-files';
import { submitPersistentBulkTask } from '@/lib/bulk-document-controller';
import {
  commitConfirmedBulkReconciliation,
  reconcileConfirmedBulkDocuments,
} from '@/lib/bulk-document-reconciliation';
import {
  addPaperlessNote,
  applyPaperlessUploadOwner,
  createPaperlessCatalogOption,
  deletePaperlessDocument,
  deletePaperlessNote,
  deletePaperlessVersion,
  downloadPaperlessFileWithCredentials,
  emptyPaperlessTrash,
  fetchPaperlessDocument,
  fetchPaperlessCreationCapabilities,
  fetchPaperlessLibraryDocuments,
  fetchPaperlessSavedViewDocuments,
  fetchPaperlessTrash,
  fetchPaperlessWorkspace,
  normalizeServerUrl,
  PaperlessApiError,
  paperlessCredentialFileHeaders,
  renamePaperlessVersion,
  reprocessPaperlessDocument,
  restorePaperlessTrash,
  testPaperlessConnection,
  updatePaperlessDocument,
  uploadPaperlessVersion,
  uploadToPaperless,
  usesNativeMutualTls,
  waitForPaperlessTask,
} from '@/lib/paperless';
import { revokeRemoteDocumentVisibility } from '@/lib/os-search-document-summaries';
import { downloadFileWithinLimit } from '@/lib/bounded-file-download';
import {
  MAX_DOCUMENT_DOWNLOAD_BYTES,
  MAX_PDF_PREVIEW_BYTES,
  MAX_THUMBNAIL_DOWNLOAD_BYTES,
} from '@/lib/download-policy';
import {
  commitNativeProfileFileRemoval,
  cleanupRetainedStagingFiles,
  migrateLegacyNativeProfileRoots,
  nativeIntakeStagingAdapter,
  planNativeProfileFileRemoval,
  recoverTemporaryNativeProfileFileRemovals,
  rollbackNativeProfileFileRemoval,
  stageNativeProfileFilesForRemoval,
  type NativeProfileFileRemovalManifest,
} from '@/lib/file-staging';
import { sanitizeIntakeFilename, stageIntakeBatch } from '@/lib/intake';
import {
  clearStagedFileReference,
  deleteTaskAfterStagedFileCleanup,
  StagedFileCleanupError,
} from '@/lib/task-staging-cleanup';
import {
  applyUploadMetadata,
  applyUploadPreset,
  assertUploadMetadataReferencesCurrent,
  defaultPresetForSource,
  lastUsedCreatedDateForPreset,
  validateUploadMetadata,
} from '@/lib/upload-metadata';
import {
  cancelTask as cancelPersistentTask,
  classifyTaskFailure,
  confirmUploadResubmission,
  createPersistentBulkOperationTask,
  createUncorrelatedPdfOperationTask,
  nextAutomaticRetryAt,
  prepareFailedBulkOutcomesForRetry,
  transitionTask,
} from '@/lib/task-policy';
import { drainUploadQueue } from '@/lib/upload-queue-worker';
import {
  AppPreferences,
  DocumentChanges,
  DocumentItem,
  PaperlessCatalog,
  PaperlessCreatableOptionKind,
  PaperlessCreationCapabilities,
  PaperlessConnectionInfo,
  PaperlessCredentials,
  PaperlessDocumentVersion,
  PaperlessNote,
  PaperlessOption,
  PaperlessLibraryRequest,
  PaperlessSavedView,
  PaperlessTrashWorkspace,
} from '@/types/document';
import type {
  IntakeBatchResult,
  IntakeCandidate,
  IntakeSource,
  PersistentBulkTaskTarget,
  PersistentTask,
  UploadMetadataDraft,
  UploadPreset,
} from '@/types/tasks';
import { PERSISTED_TASK_SCHEMA_VERSION } from '@/types/tasks';
import type {
  PaperlessBulkResult,
  PaperlessCatalogObject,
  PaperlessCatalogResource,
  PaperlessSavedView as RemotePaperlessSavedView,
} from '@/types/paperless-advanced';
import {
  matchesLibraryFilters,
  savedViewToLibraryState,
  sortLibraryDocuments,
} from '@/lib/library-filters';
import {
  createSavedViewSnapshot,
  filterSavedViewSnapshot,
  resolveSavedViewSnapshot,
} from '@/lib/saved-view-offline-cache';
import {
  catalogWithoutSavedView,
  catalogWithSavedView,
  persistDeletedSavedView,
  persistReturnedSavedView,
} from '@/lib/saved-view-publication';
import {
  persistDeletedCatalogObject,
  persistReturnedCatalogObject,
} from '@/lib/catalog-publication';
import { reconcileCatalogDocumentMutation } from '@/lib/catalog-management';
import {
  connectionProfileAuthFingerprint,
  ConnectionProfile,
  type ClientIdentityMetadata,
  ConnectionProfileRepository,
  type ProfileDataRemovalTransaction,
  ProfileRemovalJournalStore,
  ProfileSecretStore,
  createConnectionProfile,
  migrateLegacyCredentials,
  reconcileManagedClientIdentities,
  recoverPendingProfilePublication,
  recoverPendingProfileRemoval,
  removeClientIdentityIfUnreferenced,
  removeProfileWithSecrets,
} from '@/lib/auth/profile-store';
import {
  type ConnectionProfileDraft,
  type PreparedConnectionProfile,
  type ProfileOwnershipSummary,
  persistPreparedConnectionProfile,
  preparedProfileRebindsAuthority,
  prepareConnectionProfile,
} from '@/lib/auth/profile-management';
import {
  FetchAuthHttpClient,
  testPaperlessProfileConnection,
} from '@/lib/auth/fetch-adapter';
import {
  loginWithExpoOidc,
  revokeOidcSession,
} from '@/lib/auth/oidc-expo';
import { prepareNativeMutualTls } from '@/lib/auth/native-mtls-adapter';
import { getNativeMtlsTransport } from '@/lib/auth/native-mtls-module';
import { presentAuthError } from '@/lib/auth/error-presentation';
import {
  credentialsMatchStoredProfile,
} from '@/lib/auth/credential-authority';
import { createRepositoryProfileRemovalManifestStore } from '@/lib/auth/profile-removal-manifest-store';
import { createPlatformStringStore } from '@/lib/platform-storage';
import { getFolioRepository } from '@/lib/repository-provider';
import { registerFolioBackgroundWork } from '@/lib/background-runtime';
import { reconcilePendingUploadResults } from '@/lib/background-upload-reconciliation';
import { OfflineFileCacheManager, type OfflineCacheUsage } from '@/lib/offline-file-cache';
import { expoOfflineFileStorage } from '@/lib/offline-native-file-storage';
import type { BulkDocumentReconciliation, OfflineFileRecord } from '@/types/persistence';
import {
  assertDocumentReady,
  resolveDocumentAlias,
} from '@/lib/document-routing';
import { translateRuntime } from '@/i18n/runtime';
import { LatestProfileSwitchCoordinator } from '@/lib/profile-switch-coordinator';
import {
  MetadataUpdateController,
  type MetadataConflictResolution,
} from '@/lib/metadata-update-controller';
import { drainMetadataUpdates } from '@/lib/metadata-update-worker';
import { overlayPendingMetadataUpdates } from '@/lib/metadata-update';
import { OfflineSyncCoordinator, type SyncTrigger } from '@/lib/offline-sync';
import { drainOfflineDownloads } from '@/lib/offline-download-worker';
import { dispatchTaskNotification } from '@/lib/task-notification-outbox';

const PREFERENCES_KEY = 'folio.preferences';
const platformStore = createPlatformStringStore();
const connectionProfiles = new ConnectionProfileRepository(platformStore);
const profileSecrets = new ProfileSecretStore(platformStore);
const profilePublicationJournal = profileSecrets.publicationJournal;
const folioRepository = getFolioRepository();
const profileRemovalJournal = new ProfileRemovalJournalStore(
  platformStore,
  createRepositoryProfileRemovalManifestStore(folioRepository),
);
const authHttpClient = new FetchAuthHttpClient();
const profileDataRemovalTransaction: ProfileDataRemovalTransaction = {
  plan(profileId, operationId) {
    if (Platform.OS === 'web') {
      return {
        version: 2,
        profileId,
        operationId,
        fenceDisposition: 'retain-after-profile-deletion',
        fenceUri: '',
        moves: [],
      };
    }
    return planNativeProfileFileRemoval(
      profileId,
      'retain-after-profile-deletion',
      operationId,
    );
  },
  async stage(data) {
    if (Platform.OS === 'web') return;
    await stageNativeProfileFilesForRemoval(data as NativeProfileFileRemovalManifest);
  },
  async commit(profileId, operationId, createdAt, _data) {
    await folioRepository.deleteProfileDataAndWriteRemovalTombstone({
      profileId,
      operationId,
      createdAt,
    });
  },
  async isCommitted(operationId) {
    return (await folioRepository.readProfileRemovalTombstone(operationId)) !== null;
  },
  async rollback(data) {
    if (Platform.OS === 'web') return;
    await rollbackNativeProfileFileRemoval(data as NativeProfileFileRemovalManifest);
  },
  async finalize(_operationId, data) {
    if (Platform.OS !== 'web') {
      await commitNativeProfileFileRemoval(data as NativeProfileFileRemovalManifest);
    }
  },
};
const metadataUpdateController = new MetadataUpdateController(folioRepository);
const defaultPreferences: AppPreferences = {
  biometricLock: false,
  processingNotifications: false,
  notificationPrivacy: 'redacted',
  osSearchEnabled: false,
  osSearchMetadata: 'minimal',
  automaticCacheLimitBytes: 256 * 1024 * 1024,
};

async function cleanupProfileStaging(tasks: readonly PersistentTask[]) {
  if (Platform.OS === 'web') return;
  await cleanupRetainedStagingFiles({
    tasks,
    writeTask: (task) => folioRepository.writeTask(task),
  });
}

type ImportFile = {
  uri: string;
  name: string;
  mimeType?: string | null;
  pageCount?: number;
  size?: number | null;
  textContent?: string;
};

type ImportDocumentOptions = {
  onProgress?: (progress: number) => void;
  metadata?: UploadMetadataDraft;
  presetId?: string;
  source?: IntakeSource;
  deferSubmission?: boolean;
};

type IntakeRejectionNotice = {
  id: string;
  name: string;
  reason: string;
};

type IntakeRejectionBatchNotice = {
  batchId: string;
  profileId: string;
  acceptedCount: number;
  items: IntakeRejectionNotice[];
};

type AppIntakeBatchResult = IntakeBatchResult & {
  /** Present for connected intake even when every candidate was rejected. */
  batchId?: string;
};

type AppContextValue = {
  documents: DocumentItem[];
  inboxDocuments: DocumentItem[];
  catalog: PaperlessCatalog;
  totalDocuments: number;
  connected: boolean;
  /** A real profile owns the current cache even when its credentials require
   * reconnect. Network authority remains represented by `connected`. */
  profileConfigured: boolean;
  credentials: PaperlessCredentials | null;
  profiles: ConnectionProfile[];
  profileOwnership: Record<string, ProfileOwnershipSummary>;
  activeProfile: ConnectionProfile | null;
  connectionInfo: PaperlessConnectionInfo | null;
  creationCapabilities: PaperlessCreationCapabilities;
  isBootstrapping: boolean;
  isSyncing: boolean;
  lastSynced: string;
  syncState: 'demo' | 'cached' | 'syncing' | 'current' | 'offline' | 'error';
  online: boolean | null;
  connectionError: string | null;
  operationError: string | null;
  tasks: PersistentTask[];
  intakeRejectionBatches: IntakeRejectionBatchNotice[];
  uploadPresets: UploadPreset[];
  offlineUsage: OfflineCacheUsage | null;
  resolveDocumentId: (id: string) => string;
  preferences: AppPreferences;
  preferencesReady: boolean;
  clearOperationError: () => void;
  approveDocument: (id: string) => Promise<void>;
  deferDocument: (id: string) => void;
  connect: (credentials: PaperlessCredentials) => Promise<void>;
  testConnectionProfile: (
    draft: ConnectionProfileDraft,
    signal?: AbortSignal,
  ) => Promise<{
    preparationId: string;
    connection: PreparedConnectionProfile['connection'];
    warnings: PreparedConnectionProfile['warnings'];
    clientIdentity?: ClientIdentityMetadata;
  }>;
  discardConnectionProfileTest: (preparationId: string) => Promise<void>;
  saveConnectionProfile: (
    draft: ConnectionProfileDraft,
    preparationId?: string,
  ) => Promise<ConnectionProfile>;
  renameConnectionProfile: (profileId: string, displayName: string) => Promise<void>;
  revokeProfileOidc: (profileId: string) => Promise<{ revoked: boolean; logoutOpened: boolean }>;
  refreshProfileOwnership: () => Promise<void>;
  switchProfile: (profileId: string) => Promise<void>;
  removeProfile: (profileId: string, deleteData?: boolean) => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
  publishSavedView: (
    profileId: string,
    view: RemotePaperlessSavedView,
  ) => Promise<PaperlessSavedView>;
  publishSavedViewDeletion: (profileId: string, remoteId: number) => Promise<void>;
  publishCatalogObject: (
    profileId: string,
    resource: PaperlessCatalogResource,
    object: PaperlessCatalogObject,
  ) => Promise<void>;
  publishCatalogDeletion: (
    profileId: string,
    resource: PaperlessCatalogResource,
    remoteId: number,
  ) => Promise<void>;
  importDocument: (file: ImportFile, options?: ImportDocumentOptions) => Promise<void>;
  importDocuments: (files: ImportFile[], options?: ImportDocumentOptions) => Promise<AppIntakeBatchResult>;
  prepareDocuments: (files: ImportFile[], source?: IntakeSource) => Promise<AppIntakeBatchResult>;
  dismissIntakeRejectionBatch: (batchId: string) => void;
  updateUploadTask: (taskId: string, metadata: UploadMetadataDraft, presetId?: string) => Promise<void>;
  submitUploadTasks: (taskIds: string[]) => Promise<void>;
  retryDocumentProcessing: (id: string) => Promise<void>;
  retryTask: (
    taskId: string,
    options?: { userConfirmedDuplicateRisk?: boolean },
  ) => Promise<void>;
  cancelTask: (taskId: string) => Promise<void>;
  deleteTaskRecord: (taskId: string) => Promise<void>;
  resolveMetadataConflict: (
    taskId: string,
    resolution: MetadataConflictResolution,
  ) => Promise<void>;
  trackPaperlessPdfOperation: (input: {
    documentId: number;
    operation: string;
    paperlessTaskIds: string[];
  }) => Promise<string[]>;
  trackPaperlessBulkOperation: (input: {
    result: PaperlessBulkResult;
    targets: PersistentBulkTaskTarget[];
  }) => Promise<string[]>;
  reconcilePaperlessBulkOperation: (input: {
    expectedProfileId: string;
    result: PaperlessBulkResult;
    targets: PersistentBulkTaskTarget[];
  }) => Promise<BulkDocumentReconciliation | null>;
  saveUploadPreset: (preset: UploadPreset) => Promise<void>;
  deleteUploadPreset: (presetId: string) => Promise<void>;
  pinDocumentOffline: (
    id: string,
    representation?: 'original' | 'archive',
    metadata?: { fileName: string; mimeType: string },
  ) => Promise<void>;
  removeOfflineDocument: (id: string, representation: 'original' | 'archive') => Promise<void>;
  resolveOfflineDocument: (id: string, representation: 'original' | 'archive') => Promise<OfflineFileRecord | null>;
  clearEvictableCache: () => Promise<void>;
  removeAllPinnedFiles: () => Promise<void>;
  refreshOfflineUsage: () => Promise<void>;
  updateDocument: (id: string, changes: DocumentChanges) => Promise<void>;
  createCatalogOption: (
    kind: PaperlessCreatableOptionKind,
    name: string,
  ) => Promise<PaperlessOption>;
  deleteDocument: (id: string) => Promise<void>;
  reprocessDocument: (id: string) => Promise<void>;
  loadSavedView: (view: PaperlessSavedView) => Promise<DocumentItem[]>;
  searchLibrary: (request: PaperlessLibraryRequest) => Promise<{
    documents: DocumentItem[];
    totalDocuments: number;
  }>;
  loadTrash: () => Promise<PaperlessTrashWorkspace>;
  restoreTrash: (ids: string[]) => Promise<void>;
  emptyTrash: (ids?: string[]) => Promise<void>;
  addNote: (id: string, note: string) => Promise<void>;
  deleteNote: (id: string, noteId: number | string) => Promise<void>;
  uploadVersion: (id: string, file: ImportFile, label?: string) => Promise<void>;
  renameVersion: (id: string, versionId: number | string, label: string) => Promise<void>;
  deleteVersion: (id: string, versionId: number | string) => Promise<void>;
  shareDocument: (id: string, versionId?: number) => Promise<string>;
  saveDocument: (id: string, versionId?: number) => Promise<string>;
  updatePreference: <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => Promise<void>;
};

const AppContext = createContext<AppContextValue | null>(null);

const demoCreationCapabilities: PaperlessCreationCapabilities = {
  tag: true,
  correspondent: true,
  documentType: true,
  uploadDocument: true,
  assignOwner: true,
  uploadWorkflowOverride: false,
};

const unknownCreationCapabilities: PaperlessCreationCapabilities = {
  tag: null,
  correspondent: null,
  documentType: null,
  uploadDocument: null,
  assignOwner: null,
  uploadWorkflowOverride: false,
};

type DocumentDetailContextValue = {
  details: Record<string, DocumentItem>;
  version: number;
  loadDocumentDetails: (id: string) => Promise<DocumentItem | null>;
};

const DocumentDetailContext = createContext<DocumentDetailContextValue | null>(null);

function slug(value: string) {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function uniqueOptions(prefix: string, values: string[]): PaperlessOption[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b)).map((name) => ({
    id: `demo-${prefix}-${slug(name)}`,
    name,
  }));
}

function createDemoWorkspace() {
  const customFields = [
    {
      id: 'demo-custom-account',
      name: 'Account number',
      dataType: 'string' as const,
      selectOptions: [],
    },
    {
      id: 'demo-custom-review',
      name: 'Reviewed',
      dataType: 'boolean' as const,
      selectOptions: [],
    },
    {
      id: 'demo-custom-amount',
      name: 'Amount',
      dataType: 'monetary' as const,
      selectOptions: [],
      defaultCurrency: 'CHF',
    },
  ];
  const catalog: PaperlessCatalog = {
    correspondents: uniqueOptions('correspondent', demoDocuments.map((item) => item.correspondent)),
    documentTypes: uniqueOptions('type', demoDocuments.map((item) => item.documentType)),
    tags: uniqueOptions('tag', demoDocuments.flatMap((item) => item.tags)),
    storagePaths: [
      { id: 'demo-storage-personal', name: 'Personal archive' },
      { id: 'demo-storage-finance', name: 'Finance' },
    ],
    owners: [{ id: 'demo-owner-you', name: 'You' }],
    customFields,
    savedViews: [
      {
        id: 'demo-saved-inbox',
        name: 'Needs review',
        sortField: 'added',
        sortReverse: true,
        filterRules: [{ ruleType: 5, value: 'true' }],
        pageSize: 50,
        displayFields: ['title', 'created', 'tags'],
      },
    ],
  };
  const documents = demoDocuments.map((document, index) => ({
    ...document,
    correspondentId: catalog.correspondents.find((item) => item.name === document.correspondent)?.id,
    documentTypeId: catalog.documentTypes.find((item) => item.name === document.documentType)?.id,
    tagIds: document.tags
      .map((name) => catalog.tags.find((item) => item.name === name)?.id)
      .filter((id): id is string => Boolean(id)),
    fullText: document.excerpt,
    storagePath: index < 3 ? 'Personal archive' : 'Finance',
    storagePathId: index < 3 ? 'demo-storage-personal' : 'demo-storage-finance',
    archiveSerialNumber: 2026000 + index + 1,
    customFields: index === 0
      ? [
          { fieldId: 'demo-custom-account', value: '4582' },
          { fieldId: 'demo-custom-amount', value: 'CHF86.40' },
          { fieldId: 'demo-custom-review', value: false },
        ]
      : [],
    notes: index === 0
      ? [{ id: 'demo-note-1', note: 'Check the meter reading before filing.', created: new Date().toISOString(), author: 'You' }]
      : [],
    versions: [{
      id: `demo-version-${index}`,
      added: new Date(`${document.created}T12:00:00`).toISOString(),
      versionLabel: 'Original',
      isRoot: true,
    }],
  }));
  return { catalog, documents };
}

const demoWorkspace = createDemoWorkspace();
const emptyCatalog: PaperlessCatalog = {
  correspondents: [],
  documentTypes: [],
  tags: [],
  storagePaths: [],
  owners: [],
  customFields: [],
  savedViews: [],
};

async function saveStoredValue(key: string, value: unknown | null) {
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined') return;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
    return;
  }
  if (value === null) await SecureStore.deleteItemAsync(key);
  else await SecureStore.setItemAsync(key, JSON.stringify(value));
}

async function loadStoredValue<T>(key: string): Promise<T | null> {
  try {
    const stored =
      Platform.OS === 'web'
        ? typeof window === 'undefined'
          ? null
          : window.localStorage.getItem(key)
        : await SecureStore.getItemAsync(key);
    return stored ? (JSON.parse(stored) as T) : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown) {
  return presentAuthError(error);
}

function syncedLabel() {
  return new Date().toISOString();
}

function createProfileId() {
  return globalThis.crypto?.randomUUID?.() ?? `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function profileDisplayName(serverUrl: string) {
  try {
    const url = new URL(serverUrl);
    return url.pathname === '/' ? url.hostname : `${url.hostname}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return 'Paperless';
  }
}

function normalizedCredentialHeaders(headers?: Record<string, string>) {
  return Object.entries(headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

function credentialContextsMatch(
  left: PaperlessCredentials,
  right: PaperlessCredentials,
) {
  try {
    return left.profileId === right.profileId
      && normalizeServerUrl(left.serverUrl) === normalizeServerUrl(right.serverUrl)
      && left.token === right.token
      && left.clientIdentityRef === right.clientIdentityRef
      && (left.authorizationScheme ?? 'Token') === (right.authorizationScheme ?? 'Token')
      && JSON.stringify(normalizedCredentialHeaders(left.customHeaders))
        === JSON.stringify(normalizedCredentialHeaders(right.customHeaders));
  } catch {
    return false;
  }
}

async function credentialsForProfile(
  profile: ConnectionProfile,
  options: { refreshOidc?: boolean } = {},
): Promise<PaperlessCredentials> {
  void options;
  let secrets = await profileSecrets.read(profile.id);
  if (!secrets) throw new Error(translateRuntime('appError.authMissing'));
  const fingerprint = connectionProfileAuthFingerprint(profile);
  if (!secrets.connectionFingerprint) {
    secrets = { ...secrets, connectionFingerprint: fingerprint };
    await profileSecrets.write(profile.id, secrets);
  } else if (secrets.connectionFingerprint !== fingerprint) {
    throw new Error(translateRuntime('appError.authMissing'));
  }
  if (profile.auth.kind === 'mutual-tls') {
    if (!secrets.clientIdentityRef) throw new Error(translateRuntime('appError.mtlsRequired'));
    return {
      profileId: profile.id,
      serverUrl: profile.serverUrl,
      token: '',
      clientIdentityRef: secrets.clientIdentityRef,
    };
  }
  if (profile.auth.kind === 'oidc') {
    if (secrets.oidc || !secrets.apiToken) {
      // Pre-exchange profiles contain an IdP token, not Paperless authority.
      // Keep the legacy secret intact for explicit, reversible reconnect or
      // local sign-out, but never construct a Bearer request from it.
      throw new Error(translateRuntime('profiles.oidcReconnect'));
    }
  } else if (secrets.oidc) {
    throw new Error(translateRuntime('appError.authMissing'));
  }
  const token = secrets.apiToken ?? '';
  if (!token && !Object.keys(secrets.customHeaders ?? {}).length) {
    throw new Error(translateRuntime('appError.authUnusable'));
  }
  return {
    profileId: profile.id,
    serverUrl: profile.serverUrl,
    token,
    authorizationScheme: 'Token',
    customHeaders: secrets.customHeaders,
  };
}

async function loadProfileOwnership(
  savedProfiles: readonly ConnectionProfile[],
): Promise<Record<string, ProfileOwnershipSummary>> {
  const entries = await Promise.all(savedProfiles.map(async (profile) => {
    const [counts, files] = await Promise.all([
      folioRepository.profileDataCounts(profile.id),
      folioRepository.listOfflineFiles(profile.id),
    ]);
    const automatic = files.filter((file) => !file.pinned);
    const pinned = files.filter((file) => file.pinned);
    const automaticBytes = automatic.reduce((total, file) => total + file.byteSize, 0);
    const pinnedBytes = pinned.reduce((total, file) => total + file.byteSize, 0);
    return [profile.id, {
      profileId: profile.id,
      ...counts,
      automaticBytes,
      pinnedBytes,
      totalBytes: automaticBytes + pinnedBytes,
      pinnedDocuments: new Set(pinned.map((file) => file.documentId)).size,
    }] as const;
  }));
  return Object.fromEntries(entries);
}

function catalogOptionsForKind(
  catalog: PaperlessCatalog,
  kind: PaperlessCreatableOptionKind,
) {
  if (kind === 'tag') return catalog.tags;
  if (kind === 'correspondent') return catalog.correspondents;
  return catalog.documentTypes;
}

function addCatalogOption(
  catalog: PaperlessCatalog,
  kind: PaperlessCreatableOptionKind,
  option: PaperlessOption,
) {
  const key = kind === 'tag'
    ? 'tags'
    : kind === 'correspondent'
      ? 'correspondents'
      : 'documentTypes';
  const options = catalog[key];
  if (options.some((item) => item.id === option.id)) return catalog;
  return {
    ...catalog,
    [key]: [...options, option].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function applyDocumentChanges(document: DocumentItem, changes: DocumentChanges): DocumentItem {
  const tags = changes.tags;
  return {
    ...document,
    title: changes.title ?? document.title,
    correspondent:
      changes.correspondent === undefined
        ? document.correspondent
        : changes.correspondent?.name || translateRuntime('document.noCorrespondent'),
    correspondentId:
      changes.correspondent === undefined ? document.correspondentId : changes.correspondent?.id,
    documentType:
      changes.documentType === undefined
        ? document.documentType
        : changes.documentType?.name || translateRuntime('document.unsorted'),
    documentTypeId:
      changes.documentType === undefined ? document.documentTypeId : changes.documentType?.id,
    storagePath:
      changes.storagePath === undefined
        ? document.storagePath
        : changes.storagePath?.name || translateRuntime('document.automatic'),
    storagePathId:
      changes.storagePath === undefined ? document.storagePathId : changes.storagePath?.id,
    tags: tags?.map((tag) => tag.name) ?? document.tags,
    tagIds: tags?.map((tag) => tag.id) ?? document.tagIds,
    created: changes.created ?? document.created,
    archiveSerialNumber:
      changes.archiveSerialNumber === undefined
        ? document.archiveSerialNumber
        : changes.archiveSerialNumber,
    customFields: changes.customFields ?? document.customFields,
    status: tags
      ? tags.some((tag) => tag.name.toLocaleLowerCase() === 'inbox')
        ? 'inbox'
        : 'archived'
      : document.status,
  };
}

function mimeTypeForImport(file: ImportFile) {
  if (file.mimeType) return file.mimeType;
  const extension = file.name.split('.').pop()?.toLocaleLowerCase();
  return ({
    pdf: 'application/pdf',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    heic: 'image/heic',
    heif: 'image/heif',
    txt: 'text/plain',
  } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream';
}

const webIntakeStagingAdapter = {
  async stage(
    candidate: IntakeCandidate,
    stagedName: string,
    _profileId: string,
    maxBytes: number,
  ) {
    if (candidate.textContent !== undefined) {
      const bytes = new TextEncoder().encode(candidate.textContent).byteLength;
      if (bytes <= 0 || bytes > maxBytes) {
        throw new Error(translateRuntime('appError.webFileUnavailable'));
      }
      return {
        uri: URL.createObjectURL(new Blob([candidate.textContent], { type: 'text/plain' })),
        name: stagedName,
        size: bytes,
        mimeType: 'text/plain',
      };
    }
    const response = await fetch(candidate.uri);
    if (!response.ok) throw new Error(translateRuntime('appError.webFileUnavailable'));
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(translateRuntime('appError.webFileUnavailable'));
    }
    if (!response.body) throw new Error(translateRuntime('appError.webFileUnavailable'));
    const reader = response.body.getReader();
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error(translateRuntime('appError.webFileUnavailable'));
        }
      }
    } finally {
      reader.releaseLock();
    }
    return {
      uri: candidate.uri,
      name: stagedName,
      size,
      mimeType: candidate.mimeType || response.headers.get('content-type') || 'application/octet-stream',
    };
  },
  async remove(_profileId: string, _uri: string) {},
};

function titleForTask(task: PersistentTask) {
  return task.metadata?.title.state === 'value'
    ? task.metadata.title.value
    : (task.originalName || translateRuntime('taskRuntime.queuedDocument')).replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
}

function taskPlaceholder(task: PersistentTask): DocumentItem {
  const failed = task.stage === 'failed' || task.stage === 'submission-uncertain';
  const canceled = task.stage === 'canceled';
  const title = titleForTask(task);
  return {
    id: `task-${task.id}`,
    taskId: task.paperlessTaskId || task.id,
    title,
    correspondent: failed ? translateRuntime('taskRuntime.uploadNeedsAttention') : translateRuntime('taskRuntime.analyzing'),
    documentType: canceled ? translateRuntime('taskRuntime.canceled') : failed ? translateRuntime('taskRuntime.processingIssue') : translateRuntime('taskRuntime.processing'),
    created: new Date(task.createdAt).toISOString().slice(0, 10),
    added: translateRuntime('taskRuntime.queuedAt'),
    pageCount: 1,
    fileSize: task.stage === 'uploading'
      ? `${Math.round(task.progress * 100)}%`
      : task.stage === 'queued'
        ? translateRuntime('taskRuntime.queued')
        : task.stage === 'processing'
          ? translateRuntime('taskRuntime.processing')
          : failed
            ? translateRuntime('taskRuntime.failed')
            : translateRuntime('taskRuntime.pending'),
    tags: [],
    tagIds: [],
    status: canceled ? 'archived' : failed ? 'inbox' : 'processing',
    color: themeHex.light.lime,
    accent: themeHex.light.limeDark,
    excerpt: task.error?.message || translateRuntime('taskRuntime.persisted'),
    processingError: task.error?.message,
    suggestion: failed
      ? task.error?.retryable ? translateRuntime('taskRuntime.retryScheduled') : translateRuntime('taskRuntime.review')
      : task.stage === 'queued' ? translateRuntime('taskRuntime.waitingUpload') : translateRuntime('taskRuntime.processingPaperless'),
    source: 'local',
  };
}

function taskUsesLibraryPlaceholder(task: PersistentTask) {
  return task.kind === 'upload' || task.kind === 'paperless-processing';
}

function offlineRepresentationUrl(
  credentials: PaperlessCredentials,
  documentId: string,
  representation: OfflineFileRecord['representation'],
) {
  const remoteId = Number(documentId.replace(/^remote-/, ''));
  if (!Number.isInteger(remoteId) || remoteId <= 0) throw new Error(translateRuntime('appError.remoteOnlyOffline'));
  const action = representation === 'thumbnail' ? 'thumb' : representation === 'preview' ? 'preview' : 'download';
  const query = representation === 'original' ? '?original=true' : '';
  return `${normalizeServerUrl(credentials.serverUrl)}/api/documents/${remoteId}/${action}/${query}`;
}

function createOfflineManager(credentials: PaperlessCredentials, quotaBytes: number) {
  return new OfflineFileCacheManager({
    repository: folioRepository,
    storage: expoOfflineFileStorage,
    quotaBytes,
    downloader: {
      async expectedSize(input) {
        // The native mTLS transport deliberately does not expose credentialed
        // HEAD requests. The completed download supplies its verified size.
        if (usesNativeMutualTls(credentials)) return null;
        try {
          const response = await fetch(offlineRepresentationUrl(
            credentials,
            input.documentId,
            input.representation,
          ), {
            method: 'HEAD',
            headers: paperlessCredentialFileHeaders(credentials),
            redirect: 'manual',
            signal: input.signal,
          });
          const size = Number(response.headers.get('content-length'));
          return response.ok && Number.isFinite(size) && size > 0 ? size : null;
        } catch {
          return null;
        }
      },
      async download(input) {
        const requestUrl = offlineRepresentationUrl(
          credentials,
          input.documentId,
          input.representation,
        );
        if (usesNativeMutualTls(credentials)) {
          const response = await downloadPaperlessFileWithCredentials(
            credentials,
            requestUrl,
            input.destinationUri,
            {
              signal: input.signal,
              maxBytes: input.representation === 'thumbnail'
                ? MAX_THUMBNAIL_DOWNLOAD_BYTES
                : input.representation === 'preview'
                  ? MAX_PDF_PREVIEW_BYTES
                  : MAX_DOCUMENT_DOWNLOAD_BYTES,
              onProgress: (progress) => {
                if (progress !== null) void input.onProgress?.(progress);
              },
            },
          );
          if (response.status < 200 || response.status >= 300) {
            const destination = new File(input.destinationUri);
            if (destination.exists) destination.delete();
            throw new Error(translateRuntime('appError.paperlessHttp', { status: response.status }));
          }
          return;
        }
        await downloadFileWithinLimit({
          url: requestUrl,
          destination: new File(input.destinationUri),
          headers: paperlessCredentialFileHeaders(credentials),
          signal: input.signal,
          maxBytes: MAX_DOCUMENT_DOWNLOAD_BYTES,
          onProgress: (progress) => {
            if (progress !== null) void input.onProgress?.(progress);
          },
        });
      },
    },
  });
}

export function AppProvider({ children }: PropsWithChildren) {
  const [documents, setDocuments] = useState<DocumentItem[]>(demoWorkspace.documents);
  const [documentDetails, setDocumentDetails] = useState<Record<string, DocumentItem>>({});
  const [documentDetailsVersion, setDocumentDetailsVersion] = useState(0);
  const documentDetailsRef = useRef(documentDetails);
  const [catalog, setCatalog] = useState<PaperlessCatalog>(demoWorkspace.catalog);
  const [totalDocuments, setTotalDocuments] = useState(demoWorkspace.documents.length);
  const [credentials, setCredentials] = useState<PaperlessCredentials | null>(null);
  const [networkCredentialsReady, setNetworkCredentialsReady] = useState(false);
  const [profiles, setProfiles] = useState<ConnectionProfile[]>([]);
  const [profileOwnership, setProfileOwnership] = useState<Record<string, ProfileOwnershipSummary>>({});
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [connectionInfo, setConnectionInfo] = useState<PaperlessConnectionInfo | null>(null);
  const [creationCapabilities, setCreationCapabilities] =
    useState<PaperlessCreationCapabilities>(demoCreationCapabilities);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState('');
  const [syncState, setSyncState] = useState<AppContextValue['syncState']>('demo');
  const [online, setOnline] = useState<boolean | null>(null);
  const onlineRef = useRef<boolean | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<PersistentTask[]>([]);
  const [intakeRejectionBatches, setIntakeRejectionBatches] =
    useState<IntakeRejectionBatchNotice[]>([]);
  const [uploadPresets, setUploadPresets] = useState<UploadPreset[]>([]);
  const [offlineUsage, setOfflineUsage] = useState<OfflineCacheUsage | null>(null);
  const [documentIdAliases, setDocumentIdAliases] = useState<Record<string, string>>({});
  const [preferences, setPreferences] = useState(defaultPreferences);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const pendingProcessedDocumentIds = useRef(new Set<string>());
  const activeProfileIdRef = useRef<string | null>(null);
  const profileGeneration = useRef(0);
  const foregroundCredentialBinding = useRef<{
    generation: number;
    credentials: PaperlessCredentials;
  } | null>(null);
  const profileSwitches = useRef(new LatestProfileSwitchCoordinator());
  const runningQueues = useRef(new Set<string>());
  const offlineQueueRuns = useRef(new Map<string, Promise<void>>());
  const offlineDownloadControllers = useRef(new Map<string, AbortController>());
  const importProgressCallbacks = useRef(new Map<string, (progress: number) => void>());
  const preparedProfileTests = useRef(new Map<string, {
    prepared: PreparedConnectionProfile;
    expiresAt: number;
  }>());
  const lastAutomaticSyncAt = useRef<number | null>(null);
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null;

  const dismissIntakeRejectionBatch = useCallback((batchId: string) => {
    setIntakeRejectionBatches((current) => current.filter((batch) => batch.batchId !== batchId));
  }, []);

  useEffect(() => {
    activeProfileIdRef.current = activeProfileId;
  }, [activeProfileId]);

  const publishCredentials = useCallback((
    nextCredentials: PaperlessCredentials | null,
    options: { networkReady?: boolean } = {},
  ) => {
    foregroundCredentialBinding.current = nextCredentials
      ? { generation: profileGeneration.current, credentials: nextCredentials }
      : null;
    setNetworkCredentialsReady(!!nextCredentials && options.networkReady !== false);
    setCredentials(nextCredentials);
  }, []);

  const refreshProfileOwnership = useCallback(async () => {
    setProfileOwnership(await loadProfileOwnership(profiles));
  }, [profiles]);

  useEffect(() => {
    let active = true;
    void loadProfileOwnership(profiles)
      .then((summary) => {
        if (active) setProfileOwnership(summary);
      })
      .catch(() => {
        if (active) setProfileOwnership({});
      });
    return () => {
      active = false;
    };
  }, [profiles]);

  const resolveDocumentId = useCallback(
    (id: string) => resolveDocumentAlias(id, documentIdAliases),
    [documentIdAliases],
  );

  const updateCachedDocument = useCallback(
    (id: string, update: (document: DocumentItem) => DocumentItem) => {
      setDocumentDetails((current) => {
        const document = current[id];
        if (!document) return current;
        const next = { ...current, [id]: update(document) };
        documentDetailsRef.current = next;
        return next;
      });
    },
    [],
  );

  const clearDocumentDetails = useCallback(() => {
    documentDetailsRef.current = {};
    setDocumentDetails({});
    setDocumentDetailsVersion((current) => current + 1);
  }, []);

  const publishProfileRevocation = useCallback((
    removedProfileId: string,
    snapshot: { profiles: ConnectionProfile[]; activeProfileId: string | null },
  ) => {
    setProfiles(snapshot.profiles);
    if (activeProfileIdRef.current !== removedProfileId) return;
    // This callback runs immediately after the durable delete decision and
    // before fallible secret/quarantine cleanup. No foreground work may keep
    // using credentials for the removed authority namespace.
    profileGeneration.current += 1;
    activeProfileIdRef.current = null;
    setActiveProfileId(null);
    publishCredentials(null);
    pendingProcessedDocumentIds.current.clear();
    setDocumentIdAliases({});
    setTasks([]);
    setUploadPresets([]);
    setDocuments(demoWorkspace.documents);
    setCatalog(demoWorkspace.catalog);
    setTotalDocuments(demoWorkspace.documents.length);
    setConnectionInfo(null);
    setCreationCapabilities(demoCreationCapabilities);
    setLastSynced('demo mode');
    setSyncState('demo');
    clearDocumentDetails();
  }, [clearDocumentDetails, publishCredentials]);

  const loadRemoteWorkspace = useCallback(async (nextCredentials: PaperlessCredentials) => {
    const [workspace, info, nextCreationCapabilities] = await Promise.all([
      fetchPaperlessWorkspace(nextCredentials),
      testPaperlessConnection(nextCredentials),
      fetchPaperlessCreationCapabilities(nextCredentials)
        .catch(() => unknownCreationCapabilities),
    ]);
    return { workspace, info, creationCapabilities: nextCreationCapabilities };
  }, []);

  const sync = useCallback(
    async (
      nextCredentials: PaperlessCredentials,
      profileId = nextCredentials.profileId ?? activeProfileIdRef.current,
      trigger: SyncTrigger = 'manual',
    ) => {
      if (!profileId) throw new Error(translateRuntime('appError.selectProfileSync'));
      const generation = profileGeneration.current;
      setIsSyncing(true);
      setSyncState('syncing');
      setConnectionError(null);
      let remoteFailure: unknown;
      try {
        let nextInfo: PaperlessConnectionInfo | null = null;
        let nextCreationCapabilities = unknownCreationCapabilities;
        const executionGuard = () => {
          const binding = foregroundCredentialBinding.current;
          return generation === profileGeneration.current
            && activeProfileIdRef.current === profileId
            && binding?.generation === generation
            && credentialContextsMatch(binding.credentials, nextCredentials);
        };
        const coordinator = new OfflineSyncCoordinator({
          repository: folioRepository,
          executionGuard,
          transport: {
            async fetchWorkspace() {
              try {
                const [workspace, info, capabilities] = await Promise.all([
                  fetchPaperlessWorkspace(nextCredentials),
                  testPaperlessConnection(nextCredentials),
                  fetchPaperlessCreationCapabilities(nextCredentials)
                    .catch(() => unknownCreationCapabilities),
                ]);
                nextInfo = info;
                nextCreationCapabilities = capabilities;
                return {
                  kind: 'full' as const,
                  ...workspace,
                  syncedAt: new Date().toISOString(),
                };
              } catch (error) {
                remoteFailure = error;
                throw error;
              }
            },
          },
        });
        const result = await coordinator.sync({
          profileId,
          workerId: `foreground-sync-${generation}-${Date.now()}`,
          network: {
            isConnected: onlineRef.current,
            isInternetReachable: onlineRef.current,
          },
          trigger,
        });
        if (!executionGuard()) return;
        if (result.phase === 'busy') {
          setSyncState(result.workspace ? 'cached' : 'syncing');
          return;
        }
        if (result.phase === 'offline') {
          setSyncState('offline');
          return;
        }
        if (result.phase === 'error') {
          throw remoteFailure ?? new Error(result.error || translateRuntime('taskRuntime.syncFailed'));
        }
        const committedWorkspace = await folioRepository.readWorkspace(profileId);
        if (!committedWorkspace || !executionGuard()) return;
        const [profileTasks, profilePresets] = await Promise.all([
          folioRepository.listTasks(profileId),
          folioRepository.listPresets(profileId),
        ]);
        if (!executionGuard()) return;
        const workspaceDocumentIds = new Set(committedWorkspace.documents.map((document) => document.id));
        const visibleWorkspaceDocuments = overlayPendingMetadataUpdates(
          committedWorkspace.documents,
          profileTasks,
        );
        for (const id of pendingProcessedDocumentIds.current) {
          if (workspaceDocumentIds.has(id)) pendingProcessedDocumentIds.current.delete(id);
        }
        setTasks(profileTasks);
        setUploadPresets(profilePresets);
        setDocuments((current) => [
          ...profileTasks
            .filter((task) => taskUsesLibraryPlaceholder(task) && !['ready', 'canceled'].includes(task.stage))
            .map(taskPlaceholder),
          ...current.filter(
            (document) =>
              !document.id.startsWith('task-') &&
              !workspaceDocumentIds.has(document.id) &&
              pendingProcessedDocumentIds.current.has(document.id),
          ),
          ...visibleWorkspaceDocuments,
        ]);
        clearDocumentDetails();
        setCatalog(committedWorkspace.catalog);
        setTotalDocuments(committedWorkspace.totalDocuments);
        if (nextInfo) setConnectionInfo(nextInfo);
        setCreationCapabilities(nextCreationCapabilities);
        setLastSynced(committedWorkspace.lastSyncedAt);
        setSyncState('current');
      } catch (error) {
        if (generation !== profileGeneration.current || activeProfileIdRef.current !== profileId) return;
        const message = errorMessage(error);
        const authorizationLost = error instanceof PaperlessApiError
          && (error.status === 401 || error.status === 403);
        if (authorizationLost) {
          const cached = await folioRepository.readWorkspace(profileId).catch(() => null);
          if (cached) {
            await folioRepository.replaceWorkspace({
              ...cached,
              documents: revokeRemoteDocumentVisibility(cached.documents),
              syncState: 'error',
              syncError: message,
            }).catch(() => undefined);
          }
        } else {
          await folioRepository.writeWorkspaceError(profileId, message).catch(() => undefined);
        }
        if (generation !== profileGeneration.current || activeProfileIdRef.current !== profileId) return;
        if (authorizationLost) {
          setDocuments((current) => revokeRemoteDocumentVisibility(current));
          clearDocumentDetails();
        }
        setConnectionError(message);
        setSyncState(onlineRef.current === false ? 'offline' : 'error');
        throw error;
      } finally {
        if (generation === profileGeneration.current) setIsSyncing(false);
      }
    },
    [clearDocumentDetails],
  );

  const publishTask = useCallback((task: PersistentTask) => {
    if (activeProfileIdRef.current !== task.profileId) return;
    setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
    importProgressCallbacks.current.get(task.id)?.(task.progress);
    if (!taskUsesLibraryPlaceholder(task)) return;
    if (task.stage === 'ready' || task.stage === 'canceled') {
      importProgressCallbacks.current.delete(task.id);
      setDocuments((current) => current.filter((item) => item.id !== `task-${task.id}`));
      return;
    }
    const placeholder = taskPlaceholder(task);
    setDocuments((current) => [
      placeholder,
      ...current.filter((item) => item.id !== placeholder.id),
    ]);
  }, []);

  const reconcileReadyUpload = useCallback(async (
    task: PersistentTask,
    taskCredentials: PaperlessCredentials,
    executionGuard: () => Promise<boolean>,
  ) => {
    const requireCurrentExecution = async () => {
      if (!await executionGuard()) {
        throw new Error(translateRuntime('runtimeError.profileChangedReconciliation'));
      }
    };
    await requireCurrentExecution();
    const remoteId = task.result?.remoteDocumentId;
    const placeholderId = `task-${task.id}`;
    const notifyCompletion = async (canonicalDocumentId?: string, title?: string) => {
      if (!preferences.processingNotifications || task.notificationSentAt) return;
      await requireCurrentExecution();
      try {
        const delivery = await dispatchTaskNotification({
          repository: folioRepository,
          task,
          workerId: `foreground-notification-${profileGeneration.current}`,
          async notify(deliveryId) {
            await requireCurrentExecution();
            await notifyUploadCompleted({
              profileId: task.profileId,
              taskId: task.id,
              canonicalDocumentId,
              title,
              privacy: preferences.notificationPrivacy,
              deliveryId,
            });
          },
        });
        await requireCurrentExecution();
        if (delivery.kind === 'sent') publishTask(delivery.task);
      } catch {
        // Notification delivery is best effort and must never roll back a
        // successfully reconciled Paperless task.
      }
    };
    if (!remoteId) {
      await requireCurrentExecution();
      await sync(taskCredentials, task.profileId).catch(() => undefined);
      await requireCurrentExecution();
      setDocuments((current) => current.filter((item) => item.id !== placeholderId));
      await notifyCompletion();
      await requireCurrentExecution();
      return;
    }

    const targetId = `remote-${remoteId}`;
    await requireCurrentExecution();
    await folioRepository.writeRouteAlias({
      profileId: task.profileId,
      sourceId: placeholderId,
      targetId,
      createdAt: new Date().toISOString(),
    });
    await requireCurrentExecution();
    const processed = {
      ...(await fetchPaperlessDocument(taskCredentials, remoteId, catalog)),
      taskId: task.paperlessTaskId,
      ...(task.result?.duplicateDocumentIds?.length
        ? { duplicateDocumentIds: task.result.duplicateDocumentIds }
        : {}),
    };
    await requireCurrentExecution();
    pendingProcessedDocumentIds.current.add(processed.id);
    setDocumentIdAliases((current) => ({ ...current, [placeholderId]: processed.id }));
    setDocuments((current) => {
      const alreadyPresent = current.some((item) => item.id === processed.id);
      if (!alreadyPresent) setTotalDocuments((count) => count + 1);
      return [processed, ...current.filter((item) => item.id !== placeholderId && item.id !== processed.id)];
    });
    await notifyCompletion(processed.id, processed.title);
    await requireCurrentExecution();
    void sync(taskCredentials, task.profileId).catch(() => {
      // Keep the task result visible until a later foreground sync confirms it.
    });
  }, [catalog, preferences.notificationPrivacy, preferences.processingNotifications, publishTask, sync]);

  const runUploadQueue = useCallback(async (
    profileId: string,
    taskCredentials: PaperlessCredentials,
  ) => {
    const credentialBinding = foregroundCredentialBinding.current;
    if (
      !credentialBinding
      || credentialBinding.generation !== profileGeneration.current
      || !credentialContextsMatch(credentialBinding.credentials, taskCredentials)
    ) return;
    const generation = credentialBinding.generation;
    const queueKey = `${profileId}:${generation}`;
    if (runningQueues.current.has(queueKey)) return;
    runningQueues.current.add(queueKey);
    let executionGuard: (() => Promise<boolean>) | null = null;
    try {
      const initialSnapshot = await connectionProfiles.getSnapshot();
      const initialProfile = initialSnapshot.profiles.find((profile) => profile.id === profileId);
      if (!initialProfile) return;
      const connectionFingerprint = connectionProfileAuthFingerprint(initialProfile);
      const credentialBindingIsCurrent = () => {
        const currentBinding = foregroundCredentialBinding.current;
        return generation === profileGeneration.current
          && activeProfileIdRef.current === profileId
          && currentBinding?.generation === generation
          && credentialContextsMatch(currentBinding.credentials, taskCredentials);
      };
      executionGuard = async () => {
        if (!credentialBindingIsCurrent()) return false;
        try {
          const before = await connectionProfiles.getSnapshot();
          const currentProfile = before.profiles.find((profile) => profile.id === profileId);
          if (
            before.activeProfileId !== profileId
            || !currentProfile
            || connectionProfileAuthFingerprint(currentProfile) !== connectionFingerprint
          ) return false;
          const currentSecrets = await profileSecrets.read(profileId);
          const after = await connectionProfiles.getSnapshot();
          if (
            !credentialBindingIsCurrent()
            || after.revision !== before.revision
            || after.activeProfileId !== profileId
            || !currentSecrets
          ) return false;
          const verifiedProfile = after.profiles.find((profile) => profile.id === profileId);
          return !!verifiedProfile
            && connectionProfileAuthFingerprint(verifiedProfile) === connectionFingerprint
            && currentSecrets.connectionFingerprint === connectionFingerprint
            && credentialsMatchStoredProfile(taskCredentials, verifiedProfile, currentSecrets);
        } catch {
          return false;
        }
      };
      if (!await executionGuard()) return;
      let liveUploadCatalogPromise: Promise<PaperlessCatalog> | null = null;
      let liveCreationCapabilitiesPromise: Promise<PaperlessCreationCapabilities> | null = null;
      const liveUploadCatalog = () => {
        liveUploadCatalogPromise ??= fetchPaperlessWorkspace(taskCredentials)
          .then((workspace) => workspace.catalog)
          .catch((error) => {
            liveUploadCatalogPromise = null;
            throw error;
          });
        return liveUploadCatalogPromise;
      };
      const liveCreationCapabilities = () => {
        liveCreationCapabilitiesPromise ??= fetchPaperlessCreationCapabilities(taskCredentials)
          .catch((error) => {
            liveCreationCapabilitiesPromise = null;
            throw error;
          });
        return liveCreationCapabilitiesPromise;
      };
      await drainUploadQueue({
        profileId,
        workerId: `foreground-${Date.now()}`,
        repository: folioRepository,
        concurrency: 2,
        executionGuard,
        transport: {
          async validateUpload(task) {
            if (!await executionGuard!()) {
              throw new Error(translateRuntime('runtimeError.profileChangedUpload'));
            }
            const liveCatalog = await liveUploadCatalog();
            if (!await executionGuard!()) {
              throw new Error(translateRuntime('runtimeError.profileChangedUpload'));
            }
            assertUploadMetadataReferencesCurrent(task.metadata, liveCatalog);
          },
          async upload(task, onProgress) {
            if (!await executionGuard!()) {
              throw new Error(translateRuntime('runtimeError.profileChangedUpload'));
            }
            if (Platform.OS !== 'web') {
              const stagedFile = new File(task.localUri!);
              if (!stagedFile.exists || stagedFile.size <= 0) {
                throw new Error(translateRuntime('appError.stagedMissing'));
              }
              if (task.byteSize && stagedFile.size !== task.byteSize) {
                throw new Error(translateRuntime('appError.stagedChanged'));
              }
            }
            return uploadToPaperless(taskCredentials, {
              uri: task.localUri!,
              name: task.stagedName || task.originalName || 'document',
              mimeType: task.mimeType,
            }, task.metadata, { onProgress: (progress) => void onProgress(progress) });
          },
          async poll(task) {
            if (!await executionGuard!()) {
              throw new Error(translateRuntime('runtimeError.profileChangedPolling'));
            }
            if (!task.paperlessTaskId) throw new Error(translateRuntime('appError.taskIdentityMissing'));
            const result = await waitForPaperlessTask(taskCredentials, task.paperlessTaskId);
            return {
              documentId: result.documentId,
              duplicateDocumentIds: result.duplicateDocumentIds,
              summary: result.message || translateRuntime('taskRuntime.paperlessFinished'),
            };
          },
          async finalizeMetadata(task, result) {
            if (!result.documentId || !await executionGuard!()) {
              throw new Error(translateRuntime('runtimeError.profileChangedReconciliation'));
            }
            const requestedOwner = task.metadata?.owner;
            if (!requestedOwner || requestedOwner.state === 'unset') return;
            const capabilities = await liveCreationCapabilities();
            if (!await executionGuard!()) {
              throw new Error(translateRuntime('runtimeError.profileChangedReconciliation'));
            }
            await applyPaperlessUploadOwner(
              taskCredentials,
              result.documentId,
              task.metadata,
              capabilities,
            );
            if (!await executionGuard!()) {
              throw new Error(translateRuntime('runtimeError.profileChangedReconciliation'));
            }
          },
          async submitBulk(task) {
            if (!await executionGuard!()) {
              throw new Error(translateRuntime('runtimeError.profileChangedBulkRetry'));
            }
            return submitPersistentBulkTask(taskCredentials, task);
          },
        },
        onTaskChange: async (task) => {
          if (await executionGuard!()) publishTask(task);
        },
        onResult: async (result) => {
          if (result.kind !== 'ready' || !await executionGuard!()) return;
          if (result.task.kind === 'pdf-operation' || result.task.kind === 'bulk-operation') {
            await sync(taskCredentials, result.task.profileId).catch(() => undefined);
          }
        },
      });
      // A ready upload may have been completed by the OS worker while React
      // was not mounted. Replaying from durable tasks also closes the crash
      // window between a foreground terminal write and its UI side effects.
      if (!await executionGuard()) return;
      await reconcilePendingUploadResults({
        profileId,
        repository: folioRepository,
        reconcile: (task) => reconcileReadyUpload(task, taskCredentials, executionGuard!),
        onTaskChange: async (task) => {
          if (await executionGuard!()) publishTask(task);
        },
      });
    } finally {
      runningQueues.current.delete(queueKey);
      if (executionGuard && await executionGuard()) {
        const refreshedTasks = await folioRepository.listTasks(profileId);
        if (await executionGuard()) setTasks(refreshedTasks);
      }
    }
  }, [publishTask, reconcileReadyUpload, sync]);

  const runMetadataQueue = useCallback(async (
    profileId: string,
    taskCredentials: PaperlessCredentials,
  ) => {
    const binding = foregroundCredentialBinding.current;
    if (
      !binding
      || binding.generation !== profileGeneration.current
      || !credentialContextsMatch(binding.credentials, taskCredentials)
      || onlineRef.current === false
    ) return;
    const generation = binding.generation;
    const queueKey = `metadata:${profileId}:${generation}`;
    if (runningQueues.current.has(queueKey)) return;
    runningQueues.current.add(queueKey);
    const executionGuard = async () => {
      const current = foregroundCredentialBinding.current;
      if (
        generation !== profileGeneration.current
        || activeProfileIdRef.current !== profileId
        || current?.generation !== generation
        || !credentialContextsMatch(current.credentials, taskCredentials)
      ) return false;
      const before = await connectionProfiles.getSnapshot();
      const profile = before.profiles.find((candidate) => candidate.id === profileId);
      if (!profile || before.activeProfileId !== profileId) return false;
      const secrets = await profileSecrets.read(profileId);
      const after = await connectionProfiles.getSnapshot();
      return !!secrets
        && after.revision === before.revision
        && after.activeProfileId === profileId
        && connectionProfileAuthFingerprint(profile) === secrets.connectionFingerprint
        && credentialsMatchStoredProfile(taskCredentials, profile, secrets);
    };
    try {
      if (!await executionGuard()) return;
      await drainMetadataUpdates({
        profileId,
        workerId: `metadata-foreground-${Date.now()}`,
        repository: folioRepository,
        catalog,
        executionGuard,
        transport: {
          read: (remoteDocumentId) => fetchPaperlessDocument(
            taskCredentials,
            remoteDocumentId,
            catalog,
          ),
          update: (remoteDocumentId, changes) => updatePaperlessDocument(
            taskCredentials,
            remoteDocumentId,
            changes,
          ),
        },
        onTaskChange: async (task) => {
          if (await executionGuard()) publishTask(task);
        },
        onResult: async (result) => {
          if (result.kind !== 'ready' || !await executionGuard()) return;
          setDocuments((current) => current.map((document) => (
            document.id === result.document.id ? result.document : document
          )));
          setDocumentDetails((current) => {
            if (!current[result.document.id]) return current;
            const next = { ...current, [result.document.id]: result.document };
            documentDetailsRef.current = next;
            return next;
          });
        },
      });
    } finally {
      runningQueues.current.delete(queueKey);
      if (await executionGuard()) {
        const refreshedTasks = await folioRepository.listTasks(profileId);
        if (await executionGuard()) setTasks(refreshedTasks);
      }
    }
  }, [catalog, publishTask]);

  const runOfflineDownloadQueue = useCallback(async (
    profileId: string,
    taskCredentials: PaperlessCredentials,
  ) => {
    const binding = foregroundCredentialBinding.current;
    if (
      !binding
      || binding.generation !== profileGeneration.current
      || !credentialContextsMatch(binding.credentials, taskCredentials)
      || onlineRef.current === false
    ) return;
    const generation = binding.generation;
    const queueKey = `offline-download:${profileId}:${generation}`;
    const existingRun = offlineQueueRuns.current.get(queueKey);
    if (existingRun) return existingRun;
    const executionGuard = async () => {
      const current = foregroundCredentialBinding.current;
      if (
        generation !== profileGeneration.current
        || activeProfileIdRef.current !== profileId
        || current?.generation !== generation
        || !credentialContextsMatch(current.credentials, taskCredentials)
      ) return false;
      const before = await connectionProfiles.getSnapshot();
      const profile = before.profiles.find((candidate) => candidate.id === profileId);
      if (!profile || before.activeProfileId !== profileId) return false;
      const secrets = await profileSecrets.read(profileId);
      const after = await connectionProfiles.getSnapshot();
      return !!secrets
        && after.revision === before.revision
        && after.activeProfileId === profileId
        && connectionProfileAuthFingerprint(profile) === secrets.connectionFingerprint
        && credentialsMatchStoredProfile(taskCredentials, profile, secrets);
    };
    const run = (async () => {
      const manager = createOfflineManager(
        taskCredentials,
        preferences.automaticCacheLimitBytes,
      );
      try {
      if (!await executionGuard()) return;
      await drainOfflineDownloads({
        profileId,
        workerId: `offline-foreground-${Date.now()}`,
        repository: folioRepository,
        executionGuard,
        transport: {
          async resolve(task) {
            if (!task.documentId || !task.offlineRepresentation) return null;
            const existing = await manager.resolve(
              task.profileId,
              task.documentId,
              task.offlineRepresentation,
            );
            return existing.kind === 'available' ? existing.file : null;
          },
          async download(task, options) {
            if (!task.documentId || !task.offlineRepresentation) {
              throw new Error(translateRuntime('appError.offlineRepresentationMissing'));
            }
            const result = await manager.download({
              profileId: task.profileId,
              documentId: task.documentId,
              representation: task.offlineRepresentation,
              pinned: true,
              fileName: task.originalName,
              mimeType: task.mimeType,
              signal: options.signal,
              onProgress: options.onProgress,
            });
            if (result.kind === 'stored') return result.file;
            const detail = 'detail' in result
              ? result.detail
              : result.kind === 'quota-exceeded'
                ? translateRuntime('taskRuntime.offlineQuota')
                : result.kind === 'storage-pressure'
                  ? translateRuntime('taskRuntime.offlineStorage')
                  : translateRuntime('taskRuntime.offlineStoreFailed');
            throw new Error(detail);
          },
        },
        onController(task, controller) {
          const key = `${task.profileId}\u0000${task.id}`;
          if (controller) offlineDownloadControllers.current.set(key, controller);
          else offlineDownloadControllers.current.delete(key);
        },
        onTaskChange: async (task) => {
          if (await executionGuard()) publishTask(task);
        },
        onResult: async (result) => {
          if (result.kind === 'ready' && await executionGuard()) {
            setOfflineUsage(await manager.usage(profileId));
          }
        },
      });
      } finally {
        if (await executionGuard()) {
          const refreshedTasks = await folioRepository.listTasks(profileId);
          if (await executionGuard()) setTasks(refreshedTasks);
        }
      }
    })();
    offlineQueueRuns.current.set(queueKey, run);
    try {
      await run;
    } finally {
      if (offlineQueueRuns.current.get(queueKey) === run) {
        offlineQueueRuns.current.delete(queueKey);
      }
    }
  }, [preferences.automaticCacheLimitBytes, publishTask]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const savedPreferences = await loadStoredValue<AppPreferences>(PREFERENCES_KEY);
        if (!active) return;
        const restoredPreferences = savedPreferences
          ? { ...defaultPreferences, ...savedPreferences }
          : defaultPreferences;
        setRuntimeNotificationPreferences(
          restoredPreferences.processingNotifications,
          restoredPreferences.notificationPrivacy,
        );
        if (savedPreferences) setPreferences(restoredPreferences);
        setPreferencesReady(true);

        await folioRepository.initialize();
        await recoverPendingProfileRemoval({
          profiles: connectionProfiles,
          secrets: profileSecrets,
          journal: profileRemovalJournal,
          dataRemoval: profileDataRemovalTransaction,
        });
        const mtlsTransport = getNativeMtlsTransport();
        await recoverPendingProfilePublication({
          profiles: connectionProfiles,
          secrets: profileSecrets,
          publicationJournal: profilePublicationJournal,
          removalJournal: profileRemovalJournal,
          dataRemoval: profileDataRemovalTransaction,
          ...(mtlsTransport
            ? {
                removeClientIdentity: (reference: string) =>
                  mtlsTransport.removeClientIdentity(reference),
              }
            : {}),
        });
        if (Platform.OS !== 'web') {
          await recoverTemporaryNativeProfileFileRemovals({
            purgeProfileData: (profileId) => folioRepository.deleteProfileData(profileId),
          });
        }
        void registerFolioBackgroundWork().catch(() => {
          // Background scheduling is best effort; foreground work remains authoritative.
        });
        await migrateLegacyCredentials({
          legacyStore: platformStore,
          profiles: connectionProfiles,
          secrets: profileSecrets,
          createProfileId,
          now: () => new Date().toISOString(),
        });
        const snapshot = await connectionProfiles.getSnapshot();
        if (mtlsTransport) {
          // Prepared profile tests live only in process memory, while an iOS
          // Keychain import can survive a kill before its reference is saved.
          // Enumeration also makes swallowed removal/rebind deletion failures
          // retryable. Inventory failures delete nothing; cleanup failures are
          // retried from the same native inventory on the next startup.
          await reconcileManagedClientIdentities({
            profiles: connectionProfiles,
            secrets: profileSecrets,
            listManagedClientIdentityRefs: () =>
              mtlsTransport.listManagedClientIdentityRefs(),
            removeClientIdentity: (reference) =>
              mtlsTransport.removeClientIdentity(reference),
          }).catch(() => undefined);
        }
        if (Platform.OS !== 'web') {
          const profileIds = snapshot.profiles.map((profile) => profile.id);
          for (const profile of snapshot.profiles) {
            await migrateLegacyNativeProfileRoots(profile.id, profileIds);
          }
        }
        if (!active) return;
        setProfiles(snapshot.profiles);
        setActiveProfileId(snapshot.activeProfileId);
        activeProfileIdRef.current = snapshot.activeProfileId;
        if (!snapshot.activeProfileId) return;

        const profile = snapshot.profiles.find((item) => item.id === snapshot.activeProfileId);
        if (!profile) return;
        // Hydrate only local repository state first. In particular, OIDC
        // credential validation and legacy reconnect detection must not hide
        // the last good workspace on a cold offline launch.
        const [cached, aliases, savedTasks, savedPresets] = await Promise.all([
          folioRepository.readWorkspace(profile.id),
          folioRepository.listRouteAliases(profile.id),
          folioRepository.listTasks(profile.id),
          folioRepository.listPresets(profile.id),
        ]);
        if (!active) return;
        profileGeneration.current += 1;
        setDocumentIdAliases(Object.fromEntries(aliases.map((alias) => [alias.sourceId, alias.targetId])));
        setTasks(savedTasks);
        void cleanupProfileStaging(savedTasks);
        setUploadPresets(savedPresets);
        setDocuments([
          ...savedTasks
            .filter((task) => taskUsesLibraryPlaceholder(task) && !['ready', 'canceled'].includes(task.stage))
            .map(taskPlaceholder),
          ...(cached?.documents ?? []),
        ]);
        setCatalog(cached?.catalog ?? emptyCatalog);
        setTotalDocuments(cached?.totalDocuments ?? 0);
        setLastSynced(cached?.lastSyncedAt ?? '');
        setSyncState(cached ? 'cached' : 'syncing');
        setIsBootstrapping(false);

        let cachedCredentials: PaperlessCredentials;
        try {
          cachedCredentials = await credentialsForProfile(profile, { refreshOidc: false });
        } catch (error) {
          if (active) {
            setConnectionError(errorMessage(error));
            setSyncState(onlineRef.current === false ? 'offline' : cached ? 'error' : 'syncing');
          }
          return;
        }
        if (!active) return;
        publishCredentials(cachedCredentials, { networkReady: false });
        let refreshedCredentials: PaperlessCredentials;
        try {
          refreshedCredentials = await credentialsForProfile(profile);
        } catch (error) {
          if (active) {
            setConnectionError(errorMessage(error));
            setSyncState(onlineRef.current === false ? 'offline' : cached ? 'error' : 'syncing');
          }
          return;
        }
        if (!active) return;
        publishCredentials(refreshedCredentials);
        await sync(refreshedCredentials, profile.id, 'cold-start').catch(() => {
          // Cache-first hydration remains available when the profile is offline.
        });
      } catch (error) {
        if (active) setConnectionError(errorMessage(error));
      } finally {
        if (active) {
          setPreferencesReady(true);
          setIsBootstrapping(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [publishCredentials, sync]);

  useEffect(() => {
    const profileId = credentials?.profileId;
    if (!profileId || isBootstrapping || !networkCredentialsReady) return;
    void runUploadQueue(profileId, credentials);
    void runMetadataQueue(profileId, credentials);
    void runOfflineDownloadQueue(profileId, credentials);
  }, [credentials, isBootstrapping, networkCredentialsReady, runMetadataQueue, runOfflineDownloadQueue, runUploadQueue]);

  useEffect(() => {
    const profileId = credentials?.profileId;
    if (!profileId || isBootstrapping || !networkCredentialsReady) return;
    const retryAt = nextAutomaticRetryAt(tasks, profileId);
    if (retryAt === undefined) return;
    const timer = setTimeout(() => {
      if (AppState.currentState === 'active' && onlineRef.current !== false) {
        void runUploadQueue(profileId, credentials);
        void runMetadataQueue(profileId, credentials);
        void runOfflineDownloadQueue(profileId, credentials);
      }
    }, Math.max(0, retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [credentials, isBootstrapping, networkCredentialsReady, runMetadataQueue, runOfflineDownloadQueue, runUploadQueue, tasks]);

  const prepareNetworkCredentials = useCallback(async (
    currentCredentials: PaperlessCredentials,
  ) => {
    if (networkCredentialsReady) return currentCredentials;
    const profileId = currentCredentials.profileId;
    if (!profileId || activeProfileIdRef.current !== profileId) return null;
    const snapshot = await connectionProfiles.getSnapshot();
    const profile = snapshot.profiles.find((candidate) => candidate.id === profileId);
    if (!profile || snapshot.activeProfileId !== profileId) return null;
    const refreshed = await credentialsForProfile(profile);
    if (activeProfileIdRef.current !== profileId) return null;
    publishCredentials(refreshed);
    return refreshed;
  }, [networkCredentialsReady, publishCredentials]);

  useEffect(() => {
    let previouslyReachable: boolean | null = null;
    const networkSubscription = NetInfo.addEventListener((state) => {
      const reachable = state.isConnected !== false && state.isInternetReachable !== false;
      onlineRef.current = reachable;
      setOnline(reachable);
      if (!reachable && credentials) setSyncState('offline');
      if (reachable && previouslyReachable === false && credentials) {
        lastAutomaticSyncAt.current = Date.now();
        void prepareNetworkCredentials(credentials).then((readyCredentials) => {
          if (!readyCredentials) return;
          void sync(readyCredentials, readyCredentials.profileId, 'connectivity').catch(() => undefined);
          if (readyCredentials.profileId) {
            void runUploadQueue(readyCredentials.profileId, readyCredentials);
            void runMetadataQueue(readyCredentials.profileId, readyCredentials);
            void runOfflineDownloadQueue(readyCredentials.profileId, readyCredentials);
          }
        }).catch((error) => setConnectionError(errorMessage(error)));
      }
      previouslyReachable = reachable;
    });
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && credentials) {
        void prepareNetworkCredentials(credentials).then((readyCredentials) => {
          if (!readyCredentials) return;
          if (readyCredentials.profileId) {
            void runUploadQueue(readyCredentials.profileId, readyCredentials);
            void runMetadataQueue(readyCredentials.profileId, readyCredentials);
            void runOfflineDownloadQueue(readyCredentials.profileId, readyCredentials);
          }
          if (Date.now() - (lastAutomaticSyncAt.current ?? 0) >= 5 * 60_000) {
            lastAutomaticSyncAt.current = Date.now();
            void sync(readyCredentials, readyCredentials.profileId, 'foreground').catch(() => undefined);
          }
        }).catch((error) => setConnectionError(errorMessage(error)));
      }
    });
    return () => {
      networkSubscription();
      appStateSubscription.remove();
    };
  }, [credentials, prepareNetworkCredentials, runMetadataQueue, runOfflineDownloadQueue, runUploadQueue, sync]);

  const connect = useCallback(
    async (nextCredentials: PaperlessCredentials) => {
      const generation = profileGeneration.current;
      const expectedActiveProfileId = activeProfileIdRef.current;
      let rollbackLocalPersistence: (() => Promise<void>) | null = null;
      setIsSyncing(true);
      setConnectionError(null);
      try {
        const { workspace, info, creationCapabilities: nextCreationCapabilities } =
          await loadRemoteWorkspace(nextCredentials);
        if (
          generation !== profileGeneration.current
          || expectedActiveProfileId !== activeProfileIdRef.current
        ) return;
        const now = new Date().toISOString();
        const profile = activeProfile
          ? {
              ...activeProfile,
              displayName: activeProfile.displayName || profileDisplayName(nextCredentials.serverUrl),
              serverUrl: nextCredentials.serverUrl,
              auth: { kind: 'token' as const },
              server: { version: info.serverVersion },
              status: { code: 'available' as const, checkedAt: now, summary: translateRuntime('profiles.connected') },
              lastSuccessfulConnectionAt: now,
              updatedAt: now,
            }
          : createConnectionProfile({
              id: createProfileId(),
              displayName: profileDisplayName(nextCredentials.serverUrl),
              serverUrl: nextCredentials.serverUrl,
              auth: { kind: 'token' },
              now,
            });
        const beforeSnapshot = await connectionProfiles.getSnapshot();
        const previousSecrets = activeProfile ? await profileSecrets.read(profile.id) : null;
        let freshPublicationOperationId: string | null = null;
        rollbackLocalPersistence = async () => {
          try {
            if (activeProfile) await connectionProfiles.update(activeProfile);
            else await connectionProfiles.remove(profile.id);
            if (beforeSnapshot.activeProfileId && beforeSnapshot.activeProfileId !== profile.id) {
              await connectionProfiles.setActiveProfile(beforeSnapshot.activeProfileId);
            }
          } finally {
            if (previousSecrets) await profileSecrets.write(profile.id, previousSecrets);
            else await profileSecrets.delete(profile.id);
            if (freshPublicationOperationId) {
              await profilePublicationJournal.clear(freshPublicationOperationId).catch(() => undefined);
            }
          }
        };
        const nextSecrets = {
          apiToken: nextCredentials.token,
          connectionFingerprint: connectionProfileAuthFingerprint(profile),
        };
        if (activeProfile) {
          await profileSecrets.write(profile.id, nextSecrets);
          const snapshot = await connectionProfiles.update(profile);
          if (snapshot.activeProfileId !== profile.id) {
            await connectionProfiles.setActiveProfile(profile.id);
          }
        } else {
          freshPublicationOperationId = `profile-publication-${globalThis.crypto?.randomUUID?.()
            ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
          await profilePublicationJournal.begin({
            schemaVersion: 1,
            operationId: freshPublicationOperationId,
            replacementProfileId: profile.id,
            oldProfileId: null,
            intendedActive: true,
            createdAt: now,
            connectionFingerprint: nextSecrets.connectionFingerprint,
            clientIdentityRef: null,
          });
          await connectionProfiles.add(profile, {
            makeActive: false,
            activateWhenFirst: false,
          });
          await profileSecrets.write(profile.id, nextSecrets);
          await connectionProfiles.setActiveProfile(profile.id);
          await profilePublicationJournal.clear(freshPublicationOperationId);
          freshPublicationOperationId = null;
        }
        const persistedCredentials = { ...nextCredentials, profileId: profile.id };
        const [profileTasks, profilePresets] = await Promise.all([
          folioRepository.listTasks(profile.id),
          folioRepository.listPresets(profile.id),
        ]);
        const finalProfileSnapshot = await connectionProfiles.getSnapshot();
        await folioRepository.replaceWorkspace({
          profileId: profile.id,
          documents: workspace.documents,
          catalog: workspace.catalog,
          totalDocuments: workspace.totalDocuments,
          lastSyncedAt: now,
          syncState: 'current',
        });
        rollbackLocalPersistence = null;
        profileGeneration.current += 1;
        activeProfileIdRef.current = profile.id;
        setProfiles(finalProfileSnapshot.profiles);
        setActiveProfileId(profile.id);
        pendingProcessedDocumentIds.current.clear();
        setDocumentIdAliases({});
        publishCredentials(persistedCredentials);
        setTasks(profileTasks);
        setUploadPresets(profilePresets);
        setDocuments([
          ...profileTasks
            .filter((task) => taskUsesLibraryPlaceholder(task) && !['ready', 'canceled'].includes(task.stage))
            .map(taskPlaceholder),
          ...workspace.documents,
        ]);
        clearDocumentDetails();
        setCatalog(workspace.catalog);
        setTotalDocuments(workspace.totalDocuments);
        setConnectionInfo(info);
        setCreationCapabilities(nextCreationCapabilities);
        setLastSynced(syncedLabel());
        setSyncState('current');
      } catch (error) {
        await rollbackLocalPersistence?.().catch(() => undefined);
        setConnectionError(errorMessage(error));
        throw error;
      } finally {
        setIsSyncing(false);
      }
    },
    [activeProfile, clearDocumentDetails, loadRemoteWorkspace, publishCredentials],
  );

  const disconnect = useCallback(async () => {
    if (activeProfileIdRef.current) {
      const removedProfileId = activeProfileIdRef.current;
      profileGeneration.current += 1;
      const removedSecrets = await profileSecrets.read(removedProfileId);
      await dismissProfileNotifications(removedProfileId);
      await removeProfileWithSecrets({
        profileId: removedProfileId,
        policy: 'delete-cache-and-jobs',
        profiles: connectionProfiles,
        secrets: profileSecrets,
        journal: profileRemovalJournal,
        dataRemoval: profileDataRemovalTransaction,
        onProfileRevoked: (snapshot) => publishProfileRevocation(removedProfileId, snapshot),
      });
      if (removedSecrets?.clientIdentityRef) {
        const transport = getNativeMtlsTransport();
        if (transport) {
          await removeClientIdentityIfUnreferenced({
            clientIdentityRef: removedSecrets.clientIdentityRef,
            profiles: connectionProfiles,
            secrets: profileSecrets,
            removeClientIdentity: (reference) => transport.removeClientIdentity(reference),
          }).catch(() => undefined);
        }
      }
    }
    profileGeneration.current += 1;
    const snapshot = await connectionProfiles.getSnapshot();
    setProfiles(snapshot.profiles);
    setActiveProfileId(snapshot.activeProfileId);
    activeProfileIdRef.current = snapshot.activeProfileId;
    pendingProcessedDocumentIds.current.clear();
    setDocumentIdAliases({});
    setConnectionInfo(null);
    clearDocumentDetails();
    setConnectionError(null);
    setOperationError(null);
    const nextProfile = snapshot.profiles.find((profile) => profile.id === snapshot.activeProfileId);
    if (nextProfile) {
      const [nextCredentials, cached, aliases, nextTasks, nextPresets] = await Promise.all([
        credentialsForProfile(nextProfile),
        folioRepository.readWorkspace(nextProfile.id),
        folioRepository.listRouteAliases(nextProfile.id),
        folioRepository.listTasks(nextProfile.id),
        folioRepository.listPresets(nextProfile.id),
      ]);
      publishCredentials(nextCredentials);
      setTasks(nextTasks);
      setUploadPresets(nextPresets);
      setDocuments([
        ...nextTasks.filter((task) => taskUsesLibraryPlaceholder(task) && !['ready', 'canceled'].includes(task.stage)).map(taskPlaceholder),
        ...(cached?.documents ?? []),
      ]);
      setCatalog(cached?.catalog ?? emptyCatalog);
      setTotalDocuments(cached?.totalDocuments ?? 0);
      setDocumentIdAliases(Object.fromEntries(aliases.map((alias) => [alias.sourceId, alias.targetId])));
      setCreationCapabilities(unknownCreationCapabilities);
      setLastSynced(cached?.lastSyncedAt ?? '');
      setSyncState(cached ? 'cached' : 'syncing');
      await sync(nextCredentials, nextProfile.id).catch(() => undefined);
    } else {
      publishCredentials(null);
      setTasks([]);
      setUploadPresets([]);
      setCreationCapabilities(demoCreationCapabilities);
      setDocuments(demoWorkspace.documents);
      setCatalog(demoWorkspace.catalog);
      setTotalDocuments(demoWorkspace.documents.length);
      setLastSynced('demo mode');
      setSyncState('demo');
    }
  }, [clearDocumentDetails, publishCredentials, publishProfileRevocation, sync]);

  const switchProfile = useCallback(async (profileId: string) => {
    const requestId = profileSwitches.current.begin();
    const currentSnapshot = await connectionProfiles.getSnapshot();
    const profile = currentSnapshot.profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error(translateRuntime('appError.profileNotFound'));

    const [nextCredentials, cached, aliases, nextTasks, nextPresets] = await Promise.all([
      credentialsForProfile(profile),
      folioRepository.readWorkspace(profileId),
      folioRepository.listRouteAliases(profileId),
      folioRepository.listTasks(profileId),
      folioRepository.listPresets(profileId),
    ]);
    const committed = await profileSwitches.current.commitIfLatest(requestId, async () => {
      const snapshot = await connectionProfiles.setActiveProfile(profileId);
      profileGeneration.current += 1;
      activeProfileIdRef.current = profileId;
      setProfiles(snapshot.profiles);
      setActiveProfileId(profileId);
      publishCredentials(nextCredentials);
      setDocumentIdAliases(Object.fromEntries(aliases.map((alias) => [alias.sourceId, alias.targetId])));
      setTasks(nextTasks);
      setUploadPresets(nextPresets);
      setDocuments([
        ...nextTasks.filter((task) => taskUsesLibraryPlaceholder(task) && !['ready', 'canceled'].includes(task.stage)).map(taskPlaceholder),
        ...(cached?.documents ?? []),
      ]);
      setCatalog(cached?.catalog ?? emptyCatalog);
      setTotalDocuments(cached?.totalDocuments ?? 0);
      setLastSynced(cached?.lastSyncedAt ?? '');
      setSyncState(cached ? 'cached' : 'syncing');
      setIsSyncing(false);
      setConnectionError(null);
      setOperationError(null);
      pendingProcessedDocumentIds.current.clear();
      clearDocumentDetails();
    });
    if (!committed) return;
    await sync(nextCredentials, profileId).catch(() => {
      // The selected profile remains active with its last good cache while offline.
    });
  }, [clearDocumentDetails, publishCredentials, sync]);

  const prepareProfileDraft = useCallback(async (
    draft: ConnectionProfileDraft,
    signal?: AbortSignal,
  ) => {
    if (Platform.OS === 'web' && draft.auth.kind !== 'token') {
      throw new Error(translateRuntime('appError.webTokenOnly'));
    }
    const existingProfile = draft.profileId
      ? profiles.find((profile) => profile.id === draft.profileId) ?? null
      : null;
    const existingSecrets = existingProfile
      ? await profileSecrets.read(existingProfile.id)
      : null;
    return prepareConnectionProfile(
      draft,
      { existingProfile, existingSecrets, signal },
      {
        authHttpClient,
        testConnection: (nextCredentials, nextSignal) =>
          testPaperlessProfileConnection(nextCredentials, { signal: nextSignal }),
        loginOidc: (input, nextSignal) => loginWithExpoOidc(input, nextSignal),
        prepareMutualTls: async (input, nextSignal) => {
          const transport = getNativeMtlsTransport();
          if (!transport) throw new Error(translateRuntime('appError.mtlsUnavailable'));
          const savedReference = input.clientIdentityRef ?? existingSecrets?.clientIdentityRef;
          return prepareNativeMutualTls({
            profileId: input.profileId ?? createProfileId(),
            serverUrl: input.serverUrl,
            ...(input.identityAction === 'select' || input.identityAction === 'import'
              ? {}
              : savedReference ? { clientIdentityRef: savedReference } : {}),
            selectionMode: input.identityAction ?? 'reuse',
            releaseImportedIdentityIfUnused: (clientIdentityRef) =>
              removeClientIdentityIfUnreferenced({
                clientIdentityRef,
                profiles: connectionProfiles,
                secrets: profileSecrets,
                removeClientIdentity: (reference) => transport.removeClientIdentity(reference),
              }).then(() => undefined),
            ...(nextSignal ? { signal: nextSignal } : {}),
          }, transport);
        },
      },
    );
  }, [profiles]);

  const discardConnectionProfileTest = useCallback(async (preparationId: string) => {
    const cached = preparedProfileTests.current.get(preparationId);
    preparedProfileTests.current.delete(preparationId);
    const reference = cached?.prepared.secrets.clientIdentityRef;
    if (!reference) return;
    const transport = getNativeMtlsTransport();
    if (!transport) return;
    await removeClientIdentityIfUnreferenced({
      clientIdentityRef: reference,
      profiles: connectionProfiles,
      secrets: profileSecrets,
      removeClientIdentity: (clientIdentityRef) => transport.removeClientIdentity(clientIdentityRef),
    }).catch(() => undefined);
  }, []);

  const testConnectionProfile = useCallback(async (
    draft: ConnectionProfileDraft,
    signal?: AbortSignal,
  ) => {
    const now = Date.now();
    const expired = [...preparedProfileTests.current]
      .filter(([, value]) => value.expiresAt <= now)
      .map(([id]) => id);
    await Promise.all(expired.map(discardConnectionProfileTest));
    const prepared = await prepareProfileDraft(draft, signal);
    const preparationId = globalThis.crypto?.randomUUID?.() ??
      `profile-test-${now}-${Math.random().toString(36).slice(2)}`;
    preparedProfileTests.current.set(preparationId, {
      prepared,
      expiresAt: now + 10 * 60_000,
    });
    return {
      preparationId,
      connection: prepared.connection,
      warnings: prepared.warnings,
      ...(prepared.draft.auth.kind === 'mutual-tls'
        ? { clientIdentity: prepared.draft.auth.identity }
        : {}),
    };
  }, [discardConnectionProfileTest, prepareProfileDraft]);

  const saveConnectionProfile = useCallback(async (
    draft: ConnectionProfileDraft,
    preparationId?: string,
  ) => {
    const cached = preparationId ? preparedProfileTests.current.get(preparationId) : undefined;
    if (cached && cached.expiresAt <= Date.now()) {
      await discardConnectionProfileTest(preparationId!);
      throw new Error(translateRuntime('appError.profileTestExpired'));
    }
    const prepared = cached?.prepared ?? await prepareProfileDraft(draft);
    const activate = !draft.profileId || draft.profileId === activeProfileIdRef.current;
    const previousProfile = draft.profileId
      ? (await connectionProfiles.getSnapshot()).profiles.find((profile) => profile.id === draft.profileId)
      : undefined;
    const previousForegroundBinding = foregroundCredentialBinding.current;
    // Finish read-only authority capture before invalidating the foreground
    // epoch. A read failure therefore leaves the existing binding untouched;
    // every fallible step after the bump is covered by the catch below.
    const previousSecrets = draft.profileId ? await profileSecrets.read(draft.profileId) : null;
    const connectionRebound = !!previousProfile
      && preparedProfileRebindsAuthority(previousProfile, previousSecrets, prepared);
    if (activate) profileGeneration.current += 1;
    let profile: ConnectionProfile | undefined;
    let oldDurablyRevoked = false;
    let publicationCompleted = false;
    try {
      profile = await persistPreparedConnectionProfile(
        prepared,
        {
          profiles: connectionProfiles,
          secrets: profileSecrets,
          publicationJournal: profilePublicationJournal,
          createProfileId,
          now: () => new Date().toISOString(),
        },
        { makeActive: activate },
      );
      if (previousProfile && connectionRebound) {
        if (profile.id === previousProfile.id) {
          throw new Error('A changed connection authority must receive a fresh profile ID.');
        }
        await dismissProfileNotifications(previousProfile.id);
        const transport = getNativeMtlsTransport();
        const completion = await recoverPendingProfilePublication({
          profiles: connectionProfiles,
          secrets: profileSecrets,
          publicationJournal: profilePublicationJournal,
          removalJournal: profileRemovalJournal,
          dataRemoval: profileDataRemovalTransaction,
          ...(transport
            ? { removeClientIdentity: (reference: string) => transport.removeClientIdentity(reference) }
            : {}),
          onProfileRevoked: (snapshot) => {
            oldDurablyRevoked = true;
            publishProfileRevocation(previousProfile.id, snapshot);
          },
        });
        if (completion.kind !== 'completed') {
          throw new Error('The replacement connection publication could not be completed.');
        }
      }
      publicationCompleted = true;
    } catch (error) {
      // Storage can report failure after a complete replacement or activation.
      // Retry the durable journal once before restoring foreground authority.
      try {
        const transport = getNativeMtlsTransport();
        const recovery = await recoverPendingProfilePublication({
          profiles: connectionProfiles,
          secrets: profileSecrets,
          publicationJournal: profilePublicationJournal,
          removalJournal: profileRemovalJournal,
          dataRemoval: profileDataRemovalTransaction,
          ...(transport
            ? { removeClientIdentity: (reference: string) => transport.removeClientIdentity(reference) }
            : {}),
          ...(previousProfile
            ? {
                onProfileRevoked: (snapshot: Awaited<ReturnType<typeof connectionProfiles.getSnapshot>>) => {
                  oldDurablyRevoked = true;
                  publishProfileRevocation(previousProfile.id, snapshot);
                },
              }
            : {}),
        });
        if (recovery.kind === 'completed' && recovery.replacementProfileId) {
          profile = recovery.snapshot.profiles.find(
            (candidate) => candidate.id === recovery.replacementProfileId,
          );
          publicationCompleted = !!profile;
        }
      } catch {
        // Durable journals retain the exact recovery work for startup.
      }
      if (!publicationCompleted || !profile) {
        const durableSnapshot = await connectionProfiles.getSnapshot().catch(() => null);
        const oldForegroundProfileId = previousForegroundBinding?.credentials.profileId;
        const canRestoreOldForeground = activate
          && !oldDurablyRevoked
          && !!durableSnapshot
          && !!oldForegroundProfileId
          && durableSnapshot.activeProfileId === oldForegroundProfileId
          && durableSnapshot.profiles.some((candidate) => candidate.id === oldForegroundProfileId);
        if (canRestoreOldForeground && previousForegroundBinding && durableSnapshot) {
          activeProfileIdRef.current = oldForegroundProfileId ?? null;
          setProfiles(durableSnapshot.profiles);
          setActiveProfileId(oldForegroundProfileId ?? null);
          publishCredentials(previousForegroundBinding.credentials);
        } else if (activate) {
          // A durable old-authority revocation must never inherit the prior
          // credential into this new foreground generation.
          publishCredentials(null);
          if (durableSnapshot) {
            activeProfileIdRef.current = durableSnapshot.activeProfileId;
            setProfiles(durableSnapshot.profiles);
            setActiveProfileId(durableSnapshot.activeProfileId);
          }
        }
        throw error;
      }
    }
    if (!profile) throw new Error('Connection publication did not produce a replacement profile.');
    if (preparationId) preparedProfileTests.current.delete(preparationId);
    if (
      previousSecrets?.clientIdentityRef
      && previousSecrets.clientIdentityRef !== prepared.secrets.clientIdentityRef
    ) {
      const transport = getNativeMtlsTransport();
      if (transport) {
        await removeClientIdentityIfUnreferenced({
          clientIdentityRef: previousSecrets.clientIdentityRef,
          profiles: connectionProfiles,
          secrets: profileSecrets,
          removeClientIdentity: (reference) => transport.removeClientIdentity(reference),
        }).catch(() => undefined);
      }
    }
    try {
      const snapshot = await connectionProfiles.getSnapshot();
      setProfiles(snapshot.profiles);
      if (activate) await switchProfile(profile.id);
    } catch (error) {
      // Persistence already succeeded. Fence all previously captured
      // credentials if UI/workspace activation fails; never re-authorize an
      // older secret merely to mask a post-publication failure.
      publishCredentials(null);
      const durableSnapshot = await connectionProfiles.getSnapshot().catch(() => null);
      if (durableSnapshot) {
        activeProfileIdRef.current = durableSnapshot.activeProfileId;
        setProfiles(durableSnapshot.profiles);
        setActiveProfileId(durableSnapshot.activeProfileId);
      }
      throw error;
    }
    return profile;
  }, [
    discardConnectionProfileTest,
    prepareProfileDraft,
    publishCredentials,
    publishProfileRevocation,
    switchProfile,
  ]);

  const renameConnectionProfile = useCallback(async (
    profileId: string,
    displayName: string,
  ) => {
    const snapshot = await connectionProfiles.rename(
      profileId,
      displayName,
      new Date().toISOString(),
    );
    setProfiles(snapshot.profiles);
  }, []);

  const revokeProfileOidc = useCallback(async (profileId: string) => {
    const snapshot = await connectionProfiles.getSnapshot();
    const profile = snapshot.profiles.find((item) => item.id === profileId);
    if (!profile || profile.auth.kind !== 'oidc') {
      throw new Error(translateRuntime('appError.notOidc'));
    }
    const secrets = await profileSecrets.read(profileId);
    if (!secrets || (!secrets.apiToken && !secrets.oidc)) {
      throw new Error(translateRuntime('appError.oidcSignedOut'));
    }
    let result = { revoked: false, logoutOpened: false };
    if (secrets.oidc) {
      // Legacy IdP revocation is best effort. A provider outage must never
      // prevent the user from durably removing local Paperless authority.
      result = await revokeOidcSession(profile, secrets, { openLogout: true })
        .catch(() => result);
    }
    const {
      apiToken: _apiToken,
      oidc: _oidc,
      ...remainingSecrets
    } = secrets;
    await profileSecrets.write(profileId, remainingSecrets);
    if (activeProfileIdRef.current === profileId) {
      profileGeneration.current += 1;
      publishCredentials(null);
      setConnectionError(translateRuntime('profiles.oidcReconnect'));
      setSyncState('error');
    }
    const now = new Date().toISOString();
    const currentSnapshot = await connectionProfiles.getSnapshot();
    const currentProfile = currentSnapshot.profiles.find((item) => item.id === profileId);
    if (!currentProfile || currentProfile.auth.kind !== 'oidc') {
      return result;
    }
    const updated: ConnectionProfile = {
      ...currentProfile,
      status: {
        code: 'authentication-error',
        checkedAt: now,
        summary: translateRuntime('profiles.oidcSignedOut'),
      },
      updatedAt: now,
    };
    const next = await connectionProfiles.update(updated);
    setProfiles(next.profiles);
    return result;
  }, [publishCredentials]);

  const removeProfile = useCallback(async (profileId: string, deleteData = true) => {
    const profile = profiles.find((item) => item.id === profileId);
    const wasActive = activeProfileIdRef.current === profileId;
    if (wasActive) profileGeneration.current += 1;
    const removedSecrets = profile ? await profileSecrets.read(profileId) : null;
    if (profile?.auth.kind === 'oidc') {
      const secrets = await profileSecrets.read(profileId);
      if (secrets?.oidc) {
        await revokeOidcSession(profile, secrets).catch(() => undefined);
      }
    }
    await dismissProfileNotifications(profileId);
    const snapshot = await removeProfileWithSecrets({
      profileId,
      policy: deleteData ? 'delete-cache-and-jobs' : 'retain-cache-and-jobs',
      profiles: connectionProfiles,
      secrets: profileSecrets,
      journal: profileRemovalJournal,
      ...(deleteData ? { dataRemoval: profileDataRemovalTransaction } : {}),
      onProfileRevoked: (next) => publishProfileRevocation(profileId, next),
    });
    if (removedSecrets?.clientIdentityRef) {
      const transport = getNativeMtlsTransport();
      if (transport) {
        await removeClientIdentityIfUnreferenced({
          clientIdentityRef: removedSecrets.clientIdentityRef,
          profiles: connectionProfiles,
          secrets: profileSecrets,
          removeClientIdentity: (reference) => transport.removeClientIdentity(reference),
        }).catch(() => undefined);
      }
    }
    if (!wasActive) return;
    if (snapshot.activeProfileId) await switchProfile(snapshot.activeProfileId);
  }, [profiles, publishProfileRevocation, switchProfile]);

  const refresh = useCallback(async () => {
    if (!credentials) {
      setLastSynced('demo mode');
      return;
    }
    const readyCredentials = await prepareNetworkCredentials(credentials);
    if (!readyCredentials) return;
    await sync(readyCredentials);
  }, [credentials, prepareNetworkCredentials, sync]);

  const publishSavedView = useCallback(async (
    profileId: string,
    remoteView: RemotePaperlessSavedView,
  ) => {
    const view = await persistReturnedSavedView(folioRepository, profileId, remoteView);
    if (activeProfileIdRef.current !== profileId) {
      throw new Error('The active Paperless profile changed before the saved view could be published.');
    }
    setCatalog((current) => catalogWithSavedView(current, view));
    return view;
  }, []);

  const publishSavedViewDeletion = useCallback(async (
    profileId: string,
    remoteId: number,
  ) => {
    await persistDeletedSavedView(folioRepository, profileId, remoteId);
    if (activeProfileIdRef.current !== profileId) {
      throw new Error('The active Paperless profile changed before the saved view could be published.');
    }
    setCatalog((current) => catalogWithoutSavedView(current, remoteId));
  }, []);

  const catalogMutationLabels = useCallback(() => ({
    noCorrespondent: translateRuntime('document.noCorrespondent'),
    unsortedDocumentType: translateRuntime('document.unsorted'),
    automaticStoragePath: translateRuntime('document.automatic'),
    unknownTag: '—',
  }), []);

  const publishCatalogMutation = useCallback(async (
    profileId: string,
    mutation: { resource: PaperlessCatalogResource; object: PaperlessCatalogObject }
      | { resource: PaperlessCatalogResource; remoteId: number },
  ) => {
    const labels = catalogMutationLabels();
    const workspace = 'object' in mutation
      ? await persistReturnedCatalogObject(
          folioRepository,
          profileId,
          mutation.resource,
          mutation.object,
          labels,
        )
      : await persistDeletedCatalogObject(
          folioRepository,
          profileId,
          mutation.resource,
          mutation.remoteId,
          labels,
        );
    if (activeProfileIdRef.current !== profileId) {
      throw new Error('The active Paperless profile changed before the catalog mutation could be published.');
    }
    setCatalog(workspace.catalog);
    setDocuments(workspace.documents);
    setTotalDocuments(workspace.totalDocuments);
    setDocumentDetails((current) => {
      const confirmedMutation = 'object' in mutation
        ? { kind: 'upsert' as const, resource: mutation.resource, object: mutation.object }
        : { kind: 'delete' as const, resource: mutation.resource, remoteId: mutation.remoteId };
      const next = Object.fromEntries(Object.entries(current).map(([id, document]) => [
        id,
        reconcileCatalogDocumentMutation(document, confirmedMutation, labels),
      ]));
      documentDetailsRef.current = next;
      return next;
    });
  }, [catalogMutationLabels]);

  const publishCatalogObject = useCallback((
    profileId: string,
    resource: PaperlessCatalogResource,
    object: PaperlessCatalogObject,
  ) => publishCatalogMutation(profileId, { resource, object }), [publishCatalogMutation]);

  const publishCatalogDeletion = useCallback((
    profileId: string,
    resource: PaperlessCatalogResource,
    remoteId: number,
  ) => publishCatalogMutation(profileId, { resource, remoteId }), [publishCatalogMutation]);

  const updateDocument = useCallback(
    async (id: string, changes: DocumentChanges) => {
      const operationProfileId = credentials?.profileId ?? activeProfileIdRef.current;
      const original = documents.find((document) => document.id === id);
      if (!original) throw new Error(translateRuntime('appError.documentNotFound'));
      assertDocumentReady(original);
      if (original.canEdit === false) throw new Error(translateRuntime('appError.documentReadOnly'));
      setOperationError(null);
      if (!operationProfileId || !original.remoteId) {
        updateCachedDocument(id, (document) => applyDocumentChanges(document, changes));
        setDocuments((current) => current.map((document) => (
          document.id === id ? applyDocumentChanges(document, changes) : document
        )));
        return;
      }
      try {
        const queued = await metadataUpdateController.enqueue({
          profileId: operationProfileId,
          document: original,
          catalog,
          changes,
        });
        if (activeProfileIdRef.current !== operationProfileId) return;
        publishTask(queued.task);
        setDocuments((current) => current.map((document) => (
          document.id === id ? queued.document : document
        )));
        if (queued.detailDocument) {
          setDocumentDetails((current) => {
            const next = { ...current, [id]: queued.detailDocument! };
            documentDetailsRef.current = next;
            return next;
          });
        }
        if (credentials && networkCredentialsReady && onlineRef.current !== false) {
          void runMetadataQueue(operationProfileId, credentials);
        }
      } catch (error) {
        if (activeProfileIdRef.current === operationProfileId) setOperationError(errorMessage(error));
        throw error;
      }
    },
    [catalog, credentials, documents, networkCredentialsReady, publishTask, runMetadataQueue, updateCachedDocument],
  );

  const approveDocument = useCallback(
    async (id: string) => {
      const operationProfileId = activeProfileIdRef.current;
      const document = documents.find((item) => item.id === id);
      if (!document) return;
      assertDocumentReady(document);
      const remainingTags = catalog.tags.filter(
        (tag) => document.tagIds.includes(tag.id) && tag.name.toLocaleLowerCase() !== 'inbox',
      );
      await updateDocument(id, { tags: remainingTags });
      if (activeProfileIdRef.current !== operationProfileId) return;
      setDocuments((current) =>
        current.map((item) => (item.id === id ? { ...item, status: 'archived' } : item)),
      );
    },
    [catalog.tags, documents, updateDocument],
  );

  const deferDocument = useCallback((id: string) => {
    setDocuments((current) => {
      const deferred = current.find((document) => document.id === id);
      if (!deferred) return current;
      return [...current.filter((document) => document.id !== id), deferred];
    });
  }, []);

  const loadDocumentDetails = useCallback(
    async (id: string) => {
      const cached = documentDetailsRef.current[id];
      if (cached) return cached;
      const document = documents.find((item) => item.id === id);
      if (!document) return null;
      const profileId = activeProfileIdRef.current;
      const persisted = profileId
        ? await folioRepository.readDocumentDetail(profileId, id).catch(() => null)
        : null;
      if (!credentials || !document.remoteId) {
        const offlineDocument = persisted?.document ?? document;
        const next = { ...documentDetailsRef.current, [id]: offlineDocument };
        documentDetailsRef.current = next;
        setDocumentDetails(next);
        return offlineDocument;
      }
      try {
        const detail = await fetchPaperlessDocument(credentials, document.remoteId, catalog);
        if (profileId) {
          await folioRepository.writeDocumentDetail({
            profileId,
            documentId: id,
            document: detail,
            fetchedAt: new Date().toISOString(),
          });
        }
        if (activeProfileIdRef.current !== profileId) return detail;
        const next = { ...documentDetailsRef.current, [id]: detail };
        documentDetailsRef.current = next;
        setDocumentDetails(next);
        return detail;
      } catch (error) {
        if (activeProfileIdRef.current !== profileId) throw error;
        if (persisted) {
          const next = { ...documentDetailsRef.current, [id]: persisted.document };
          documentDetailsRef.current = next;
          setDocumentDetails(next);
          setOperationError(errorMessage(error));
          return persisted.document;
        }
        setOperationError(errorMessage(error));
        throw error;
      }
    },
    [catalog, credentials, documents],
  );

  const createCatalogOption = useCallback(
    async (kind: PaperlessCreatableOptionKind, name: string) => {
      const operationProfileId = credentials?.profileId ?? activeProfileIdRef.current;
      const normalized = name.trim();
      const noun = translateRuntime(kind === 'documentType'
        ? 'catalogEditor.documentType'
        : kind === 'correspondent'
          ? 'catalogEditor.correspondent'
          : 'catalogEditor.tag');
      if (!normalized) throw new Error(translateRuntime('appError.catalogName', { kind: noun }));
      const existing = catalogOptionsForKind(catalog, kind).find(
        (option) => option.name.toLocaleLowerCase() === normalized.toLocaleLowerCase(),
      );
      if (existing) return existing;

      try {
        const option = credentials
          ? await createPaperlessCatalogOption(credentials, kind, normalized)
          : { id: `local-${kind}-${Date.now()}`, name: normalized };
        if (activeProfileIdRef.current !== operationProfileId) return option;
        setCatalog((current) => addCatalogOption(current, kind, option));
        return option;
      } catch (error) {
        if (activeProfileIdRef.current !== operationProfileId) throw error;
        const message = error instanceof Error && 'status' in error && error.status === 403
          ? translateRuntime('appError.catalogPermission', {
              kind: translateRuntime(kind === 'documentType'
                ? 'metadata.documentTypes'
                : kind === 'correspondent'
                  ? 'metadata.correspondents'
                  : 'metadata.tags').toLocaleLowerCase(),
            })
          : errorMessage(error);
        setOperationError(message);
        throw new Error(message);
      }
    },
    [catalog, credentials],
  );

  const deleteDocument = useCallback(
    async (id: string) => {
      const document = documents.find((item) => item.id === id);
      const operationProfileId = credentials?.profileId ?? activeProfileIdRef.current;
      if (!document) return;
      assertDocumentReady(document);
      if (!credentials || !networkCredentialsReady || !document.remoteId || onlineRef.current === false) {
        throw new Error(translateRuntime('appError.deleteLiveOnly'));
      }
      setOperationError(null);
      try {
        await deletePaperlessDocument(credentials, document.remoteId);
        if (activeProfileIdRef.current !== operationProfileId) return;
        setDocumentDetails((current) => {
          if (!current[id]) return current;
          const next = { ...current };
          delete next[id];
          documentDetailsRef.current = next;
          return next;
        });
        setDocuments((current) => current.filter((item) => item.id !== id));
        setTotalDocuments((current) => Math.max(0, current - 1));
      } catch (error) {
        if (activeProfileIdRef.current !== operationProfileId) throw error;
        setOperationError(errorMessage(error));
        throw error;
      }
    },
    [credentials, documents, networkCredentialsReady],
  );

  const reprocessDocument = useCallback(
    async (id: string) => {
      const document = documents.find((item) => item.id === id);
      const operationProfileId = credentials?.profileId ?? activeProfileIdRef.current;
      if (!document) throw new Error(translateRuntime('appError.documentNotFound'));
      assertDocumentReady(document);
      if (!credentials || !document.remoteId) {
        throw new Error(translateRuntime('appError.remoteOnlyReprocess'));
      }
      try {
        await reprocessPaperlessDocument(credentials, document.remoteId);
        if (activeProfileIdRef.current !== operationProfileId) return;
        setDocuments((current) =>
          current.map((item) =>
            item.id === id
              ? { ...item, suggestion: translateRuntime('taskRuntime.reprocessing') }
              : item,
          ),
        );
      } catch (error) {
        if (activeProfileIdRef.current !== operationProfileId) throw error;
        setOperationError(errorMessage(error));
        throw error;
      }
    },
    [credentials, documents],
  );

  const loadSavedView = useCallback(
    async (view: PaperlessSavedView) => {
      const profileId = credentials?.profileId ?? activeProfileIdRef.current;
      if (credentials && online) {
        try {
          const result = await fetchPaperlessSavedViewDocuments(credentials, view, catalog);
          if (profileId) {
            await folioRepository.writeSavedViewSnapshot(
              profileId,
              createSavedViewSnapshot(view, result.documents, result.totalDocuments),
            ).catch(() => undefined);
          }
          return result.documents;
        } catch {
          // Fall back to the last complete workspace when the server becomes
          // unreachable after connectivity was reported as available.
        }
      }
      const state = savedViewToLibraryState(view, catalog);
      if (state.extraRules.length) {
        if (profileId) {
          const cached = await folioRepository.readWorkspace(profileId).catch(() => null);
          const snapshot = resolveSavedViewSnapshot(
            cached?.savedViewSnapshots,
            view,
            cached?.documents ?? [],
          );
          if (snapshot) return snapshot.documents;
        }
        throw new Error(translateRuntime('appError.savedViewOfflineRules'));
      }
      const query = state.query.trim().toLocaleLowerCase();
      const filtered = documents.filter((document) => {
        if (!matchesLibraryFilters(document, state.filters)) return false;
        if (!query) return true;
        return [
          document.title,
          document.correspondent,
          document.documentType,
          document.excerpt,
          document.fullText,
          ...document.tags,
        ].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
      });
      return sortLibraryDocuments(filtered, state.sortOrder);
    },
    [catalog, credentials, documents, online],
  );

  const searchLibrary = useCallback(
    async (request: PaperlessLibraryRequest) => {
      const profileId = credentials?.profileId ?? activeProfileIdRef.current;
      const savedView = request.savedViewId
        ? catalog.savedViews.find((view) => view.id === request.savedViewId) ?? null
        : null;
      if (credentials && online) {
        try {
          const result = await fetchPaperlessLibraryDocuments(credentials, request, catalog);
          if (profileId && savedView && !request.savedViewModified) {
            await folioRepository.writeSavedViewSnapshot(
              profileId,
              createSavedViewSnapshot(
                savedView,
                result.documents,
                result.totalDocuments,
              ),
            ).catch(() => undefined);
          }
          return { documents: result.documents, totalDocuments: result.totalDocuments };
        } catch {
          // Continue with cached metadata for transient network/server errors.
        }
      }

      if (request.extraRules?.length) {
        if (profileId && savedView) {
          const cached = await folioRepository.readWorkspace(profileId).catch(() => null);
          const snapshot = resolveSavedViewSnapshot(
            cached?.savedViewSnapshots,
            savedView,
            cached?.documents ?? [],
          );
          if (snapshot) {
            const filtered = filterSavedViewSnapshot(snapshot, request);
            return { documents: filtered, totalDocuments: filtered.length };
          }
        }
        throw new Error(translateRuntime('appError.savedViewLiveRules'));
      }

      const normalizedQuery = request.query.trim().toLocaleLowerCase();
      const filtered = documents.filter((document) => {
        if (!matchesLibraryFilters(document, request.filters)) return false;
        if (!normalizedQuery) return true;
        return [
          document.title,
          document.correspondent,
          document.documentType,
          document.excerpt,
          document.fullText,
          ...document.tags,
        ]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      });
      return { documents: filtered, totalDocuments: filtered.length };
    },
    [catalog, credentials, documents, online],
  );

  const loadTrash = useCallback(async () => {
    if (!credentials) return { documents: [], totalDocuments: 0 };
    return fetchPaperlessTrash(credentials, catalog);
  }, [catalog, credentials]);

  const restoreTrash = useCallback(
    async (ids: string[]) => {
      if (!credentials) return;
      const remoteIds = ids
        .map((id) => Number(id.replace('remote-', '')))
        .filter((id) => Number.isInteger(id));
      await restorePaperlessTrash(credentials, remoteIds);
      await sync(credentials);
    },
    [credentials, sync],
  );

  const emptyTrash = useCallback(
    async (ids?: string[]) => {
      if (!credentials) return;
      const remoteIds = ids
        ?.map((id) => Number(id.replace('remote-', '')))
        .filter((id) => Number.isInteger(id));
      await emptyPaperlessTrash(credentials, remoteIds);
    },
    [credentials],
  );

  const addNote = useCallback(
    async (id: string, note: string) => {
      const operationProfileId = credentials?.profileId ?? activeProfileIdRef.current;
      const document = documentDetailsRef.current[id] || documents.find((item) => item.id === id);
      const normalized = note.trim();
      if (!document) throw new Error(translateRuntime('appError.documentNotFound'));
      assertDocumentReady(document);
      if (!normalized) throw new Error(translateRuntime('appError.noteEmpty'));
      let nextNote: PaperlessNote;
      if (credentials && document.remoteId) {
        nextNote = await addPaperlessNote(credentials, document.remoteId, normalized);
      } else {
        nextNote = {
          id: `local-note-${Date.now()}`,
          note: normalized,
          created: new Date().toISOString(),
          author: 'You',
        };
      }
      if (activeProfileIdRef.current !== operationProfileId) return;
      updateCachedDocument(id, (item) => ({
        ...item,
        notes: [nextNote, ...(item.notes || [])],
      }));
    },
    [credentials, documents, updateCachedDocument],
  );

  const deleteNote = useCallback(
    async (id: string, noteId: number | string) => {
      const operationProfileId = credentials?.profileId ?? activeProfileIdRef.current;
      const document = documentDetailsRef.current[id] || documents.find((item) => item.id === id);
      if (!document) throw new Error(translateRuntime('appError.documentNotFound'));
      assertDocumentReady(document);
      if (credentials && document.remoteId) {
        await deletePaperlessNote(credentials, document.remoteId, noteId);
      }
      if (activeProfileIdRef.current !== operationProfileId) return;
      updateCachedDocument(id, (item) => ({
        ...item,
        notes: (item.notes || []).filter((note) => note.id !== noteId),
      }));
    },
    [credentials, documents, updateCachedDocument],
  );

  const uploadVersion = useCallback(
    async (id: string, file: ImportFile, label?: string) => {
      const operationProfileId = credentials?.profileId ?? activeProfileIdRef.current;
      const document = documentDetailsRef.current[id] || documents.find((item) => item.id === id);
      if (!document) throw new Error(translateRuntime('appError.documentNotFound'));
      assertDocumentReady(document);
      if (!credentials || !document.remoteId) {
        const version: PaperlessDocumentVersion = {
          id: `local-version-${Date.now()}`,
          added: new Date().toISOString(),
          versionLabel: label?.trim() || file.name,
          isRoot: false,
        };
        updateCachedDocument(id, (item) => ({
          ...item,
          versions: [version, ...(item.versions || [])],
        }));
        return;
      }
      const taskId = await uploadPaperlessVersion(credentials, document.remoteId, file, label);
      await waitForPaperlessTask(credentials, taskId);
      const detail = await fetchPaperlessDocument(credentials, document.remoteId, catalog);
      if (activeProfileIdRef.current !== operationProfileId) return;
      const next = { ...documentDetailsRef.current, [id]: detail };
      documentDetailsRef.current = next;
      setDocumentDetails(next);
    },
    [catalog, credentials, documents, updateCachedDocument],
  );

  const renameVersion = useCallback(
    async (id: string, versionId: number | string, label: string) => {
      const operationProfileId = credentials?.profileId ?? activeProfileIdRef.current;
      const document = documentDetailsRef.current[id] || documents.find((item) => item.id === id);
      if (!document) throw new Error(translateRuntime('appError.documentNotFound'));
      assertDocumentReady(document);
      let versionLabel = label.trim();
      if (credentials && document.remoteId && typeof versionId === 'number') {
        const updated = await renamePaperlessVersion(
          credentials,
          document.rootDocumentId || document.remoteId,
          versionId,
          versionLabel,
        );
        versionLabel = updated.versionLabel || '';
      }
      if (activeProfileIdRef.current !== operationProfileId) return;
      updateCachedDocument(id, (item) => ({
        ...item,
        versions: (item.versions || []).map((version) =>
          version.id === versionId ? { ...version, versionLabel } : version,
        ),
      }));
    },
    [credentials, documents, updateCachedDocument],
  );

  const deleteVersion = useCallback(
    async (id: string, versionId: number | string) => {
      const operationProfileId = credentials?.profileId ?? activeProfileIdRef.current;
      const document = documentDetailsRef.current[id] || documents.find((item) => item.id === id);
      if (!document) throw new Error(translateRuntime('appError.documentNotFound'));
      assertDocumentReady(document);
      const version = document.versions?.find((item) => item.id === versionId);
      if (!version) throw new Error(translateRuntime('appError.versionNotFound'));
      if (version.isRoot) throw new Error(translateRuntime('appError.rootVersionDelete'));
      if (credentials && document.remoteId && typeof versionId === 'number') {
        await deletePaperlessVersion(
          credentials,
          document.rootDocumentId || document.remoteId,
          versionId,
        );
      }
      if (activeProfileIdRef.current !== operationProfileId) return;
      updateCachedDocument(id, (item) => ({
        ...item,
        versions: (item.versions || []).filter((entry) => entry.id !== versionId),
      }));
    },
    [credentials, documents, updateCachedDocument],
  );

  const shareDocument = useCallback(
    async (id: string, versionId?: number) => {
      const document = documents.find((item) => item.id === id);
      if (!document) throw new Error(translateRuntime('appError.documentNotFound'));
      assertDocumentReady(document);
      if (!credentials || !document.remoteId) {
        throw new Error(translateRuntime('appError.connectShare'));
      }
      const operationProfileId = credentials.profileId;
      try {
        return await sharePaperlessDocument(credentials, document, versionId, {
          isProfileCurrent: () => activeProfileIdRef.current === operationProfileId,
        });
      } catch (error) {
        setOperationError(errorMessage(error));
        throw error;
      }
    },
    [credentials, documents],
  );

  const saveDocument = useCallback(
    async (id: string, versionId?: number) => {
      const document = documents.find((item) => item.id === id);
      if (!document) throw new Error(translateRuntime('appError.documentNotFound'));
      assertDocumentReady(document);
      if (!credentials || !document.remoteId) {
        throw new Error(translateRuntime('appError.connectDownload'));
      }
      const operationProfileId = credentials.profileId;
      try {
        return await savePaperlessDocument(credentials, document, versionId, {
          isProfileCurrent: () => activeProfileIdRef.current === operationProfileId,
        });
      } catch (error) {
        setOperationError(errorMessage(error));
        throw error;
      }
    },
    [credentials, documents],
  );

  const importDocuments = useCallback(
    async (files: ImportFile[], options: ImportDocumentOptions = {}): Promise<AppIntakeBatchResult> => {
      if (!files.length) return { accepted: [], rejected: [] };
      setOperationError(null);

      const profileId = credentials?.profileId ?? activeProfileIdRef.current;
      if (!profileId) {
        const now = Date.now();
        const localDocuments = files.map((file, index): DocumentItem => ({
          id: `local-${now}-${index}`,
          title: file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '),
          correspondent: translateRuntime('taskRuntime.localNeedsReview'),
          documentType: translateRuntime('taskRuntime.localUnsorted'),
          created: new Date().toISOString().slice(0, 10),
          added: translateRuntime('taskRuntime.localJustNow'),
          pageCount: file.pageCount || 1,
          fileSize: translateRuntime('taskRuntime.localNew'),
          tags: [],
          tagIds: [],
          status: 'inbox',
          color: themeHex.light.lime,
          accent: themeHex.light.limeDark,
          excerpt: translateRuntime('taskRuntime.localImportCopy'),
          fullText: translateRuntime('taskRuntime.localImportCopy'),
          suggestion: translateRuntime('taskRuntime.localMetadataReady'),
          source: 'local',
        }));
        setDocuments((current) => [...localDocuments, ...current]);
        setTotalDocuments((current) => current + localDocuments.length);
        return { accepted: [], rejected: [] };
      }

      const batchId = globalThis.crypto?.randomUUID?.() ?? `batch-${Date.now()}`;
      const staged = await stageIntakeBatch(
        files.map((file) => ({
          uri: file.uri,
          name: file.name,
          mimeType: mimeTypeForImport(file),
          size: file.size,
          textContent: file.textContent,
        })),
        {
          adapter: Platform.OS === 'web' ? webIntakeStagingAdapter : nativeIntakeStagingAdapter,
          profileId,
          source: options.source ?? 'picker',
        },
      );
      const selectedPreset = options.presetId
        ? uploadPresets.find((preset) => preset.id === options.presetId && preset.profileId === profileId)
        : undefined;
      const lastUsedPresetDate = selectedPreset?.createdDateBehavior === 'last-used'
        ? lastUsedCreatedDateForPreset(
            await folioRepository.listTasks(profileId),
            selectedPreset.id,
          )
        : undefined;
      const accepted = staged.accepted.map((task) => {
        const presetMetadata = selectedPreset
          ? applyUploadPreset(task.metadata!, selectedPreset, {
              originalName: task.originalName ?? '',
              lastUsedDate: lastUsedPresetDate,
            })
          : task.metadata!;
        return {
          ...task,
          stage: options.deferSubmission ? 'preparing' as const : task.stage,
          batchId,
          presetId: selectedPreset?.id,
          metadata: options.metadata
            ? applyUploadMetadata(presetMetadata, {
                ...options.metadata,
                title: options.metadata.title.state === 'unset'
                  ? presetMetadata.title
                  : options.metadata.title,
              })
            : presetMetadata,
        };
      });
      const rejectionTimestamp = new Date().toISOString();
      const rejectedTasks = staged.rejected.map((item, index): PersistentTask => ({
        schemaVersion: PERSISTED_TASK_SCHEMA_VERSION,
        id: globalThis.crypto?.randomUUID?.() ?? `${batchId}-rejected-${index}`,
        profileId,
        batchId,
        kind: 'upload',
        stage: 'failed',
        source: options.source ?? 'picker',
        originalName: item.candidate.name,
        byteSize: Number.isSafeInteger(item.candidate.size) && (item.candidate.size ?? 0) > 0
          ? item.candidate.size ?? undefined
          : undefined,
        mimeType: mimeTypeForImport(item.candidate),
        progress: 0,
        retryCount: 0,
        error: {
          ...item.error,
          // No private copy exists, so an automatic queue retry cannot recover
          // this item. The source must be selected or shared again.
          retryable: false,
        },
        createdAt: rejectionTimestamp,
        updatedAt: rejectionTimestamp,
      }));
      const durableTasks = [...accepted, ...rejectedTasks];
      try {
        await folioRepository.writeTasks(durableTasks);
      } catch (error) {
        const staging = Platform.OS === 'web'
          ? webIntakeStagingAdapter
          : nativeIntakeStagingAdapter;
        await Promise.all(accepted.map((task) => task.localUri
          ? staging.remove(task.profileId, task.localUri).catch(() => undefined)
          : Promise.resolve()));
        throw error;
      }
      if (accepted[0] && options.onProgress) {
        importProgressCallbacks.current.set(accepted[0].id, options.onProgress);
      }
      setTasks((current) => [
        ...durableTasks,
        ...current.filter((task) => !durableTasks.some((next) => (
          next.id === task.id
        ))),
      ]);
      setDocuments((current) => [
        ...accepted.map(taskPlaceholder),
        ...current,
      ]);
      if (staged.rejected.length) {
        const rejectionNotice: IntakeRejectionBatchNotice = {
          batchId,
          profileId,
          acceptedCount: accepted.length,
          items: staged.rejected.map((item, index) => ({
            id: `${batchId}-${index}`,
            name: sanitizeIntakeFilename(item.candidate.name),
            reason: item.error.message,
          })),
        };
        setIntakeRejectionBatches((current) => [
          rejectionNotice,
          ...current.filter((batch) => batch.batchId !== batchId),
        ].slice(0, 12));
        setOperationError(staged.rejected.map((item) => item.error.message).join(' '));
      }
      if (!options.deferSubmission && credentials?.profileId === profileId) {
        void runUploadQueue(profileId, credentials);
      }
      return { ...staged, accepted, batchId };
    },
    [credentials, runUploadQueue, uploadPresets],
  );

  const importDocument = useCallback(
    async (file: ImportFile, options?: ImportDocumentOptions) => {
      const result = await importDocuments([file], options);
      if (result.rejected[0]) throw new Error(result.rejected[0].error.message);
    },
    [importDocuments],
  );

  const prepareDocuments = useCallback(
    async (files: ImportFile[], source: IntakeSource = 'picker') => {
      const profileId = credentials?.profileId ?? activeProfileIdRef.current;
      const preset = profileId
        ? defaultPresetForSource(uploadPresets, profileId, source)
        : undefined;
      return importDocuments(files, {
        source,
        deferSubmission: true,
        presetId: preset?.id,
      });
    },
    [credentials?.profileId, importDocuments, uploadPresets],
  );

  const updateUploadTask = useCallback(async (
    taskId: string,
    metadata: UploadMetadataDraft,
    presetId?: string,
  ) => {
    const profileId = activeProfileIdRef.current;
    if (!profileId) throw new Error(translateRuntime('appError.selectProfileMetadata'));
    const stored = await folioRepository.readTask(profileId, taskId.replace(/^task-/, ''));
    if (!stored) throw new Error(translateRuntime('appError.draftMissing'));
    if (!['preparing', 'failed', 'queued'].includes(stored.stage)) {
      throw new Error(translateRuntime('appError.metadataAccepted'));
    }
    // Persist incomplete editor drafts too. Validation belongs to submission,
    // otherwise a partially typed date or number would be lost on restart.
    const next = {
      ...stored,
      metadata,
      presetId,
      updatedAt: new Date().toISOString(),
    };
    await folioRepository.writeTask(next);
    publishTask(next);
  }, [publishTask]);

  const submitUploadTasks = useCallback(async (taskIds: string[]) => {
    if (!credentials) throw new Error(translateRuntime('appError.connectSubmit'));
    const profileId = credentials.profileId ?? activeProfileIdRef.current;
    if (!profileId) throw new Error(translateRuntime('appError.selectProfileSubmit'));
    const submitted: PersistentTask[] = [];
    for (const rawId of taskIds) {
      const stored = await folioRepository.readTask(profileId, rawId.replace(/^task-/, ''));
      if (!stored) throw new Error(translateRuntime('appError.draftMissing'));
      const issues = stored.metadata ? validateUploadMetadata(stored.metadata, { catalog }) : [];
      if (issues.length) throw new Error(issues.map((issue) => issue.message).join(' '));
      if (stored.stage !== 'preparing' && stored.stage !== 'failed') continue;
      const next = {
        ...transitionTask(stored, stored.paperlessTaskId ? 'processing' : 'queued'),
        error: undefined,
        nextAttemptAt: undefined,
      };
      await folioRepository.writeTask(next);
      publishTask(next);
      submitted.push(next);
    }
    if (submitted.length) void runUploadQueue(profileId, credentials);
  }, [catalog, credentials, publishTask, runUploadQueue]);

  const refreshOfflineUsage = useCallback(async () => {
    const profileId = activeProfileIdRef.current;
    if (!profileId || !credentials) {
      setOfflineUsage(null);
      return;
    }
    setOfflineUsage(await createOfflineManager(
      credentials,
      preferences.automaticCacheLimitBytes,
    ).usage(profileId));
  }, [credentials, preferences.automaticCacheLimitBytes]);

  const pinDocumentOffline = useCallback(async (
    id: string,
    representation: 'original' | 'archive' = 'archive',
    metadata?: { fileName: string; mimeType: string },
  ) => {
    if (!credentials) throw new Error(translateRuntime('appError.connectOffline'));
    const profileId = credentials.profileId ?? activeProfileIdRef.current;
    const document = documents.find((item) => item.id === id);
    if (!profileId || !document?.remoteId) throw new Error(translateRuntime('appError.remoteOnlyOffline'));
    const fileName = metadata?.fileName.trim();
    const mimeType = metadata?.mimeType.trim();
    if (!fileName || !mimeType) {
      throw new Error(translateRuntime('appError.offlineMetadataMissing'));
    }
    const unresolved = (await folioRepository.listTasks(profileId)).find((candidate) => (
      candidate.kind === 'offline-download'
      && candidate.documentId === document.id
      && candidate.offlineRepresentation === representation
      && !['ready', 'canceled'].includes(candidate.stage)
    ));
    if (unresolved?.stage === 'failed' && unresolved.error?.retryable !== true) {
      throw new Error(unresolved.error?.message || translateRuntime('taskRuntime.offlineStoreFailed'));
    }
    const timestamp = new Date().toISOString();
    const task: PersistentTask = unresolved
      ? {
          ...unresolved,
          stage: unresolved.stage === 'failed' ? 'queued' : unresolved.stage,
          originalName: fileName,
          mimeType,
          error: unresolved.stage === 'failed' ? undefined : unresolved.error,
          nextAttemptAt: unresolved.stage === 'failed' ? undefined : unresolved.nextAttemptAt,
          updatedAt: timestamp,
        }
      : {
      schemaVersion: PERSISTED_TASK_SCHEMA_VERSION,
      id: globalThis.crypto?.randomUUID?.() ?? `offline-${Date.now()}`,
      profileId,
      kind: 'offline-download',
      stage: 'queued',
      source: 'unknown',
      originalName: fileName,
      mimeType,
      documentId: document.id,
      offlineRepresentation: representation,
      progress: 0,
      retryCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await folioRepository.writeTask(task);
    publishTask(task);
    await runOfflineDownloadQueue(profileId, credentials);
    const completed = await folioRepository.readTask(profileId, task.id);
    if (completed?.stage === 'failed') throw new Error(completed.error?.message || translateRuntime('taskRuntime.offlineStoreFailed'));
    if (completed?.stage !== 'ready') throw new Error(translateRuntime('appError.offlineDownloadPending'));
  }, [credentials, documents, publishTask, runOfflineDownloadQueue]);

  const removeOfflineDocument = useCallback(async (
    id: string,
    representation: 'original' | 'archive',
  ) => {
    const profileId = activeProfileIdRef.current;
    if (!profileId || !credentials) return;
    const result = await createOfflineManager(
      credentials,
      preferences.automaticCacheLimitBytes,
    ).remove(profileId, id, representation, true);
    if (result.kind === 'remove-failed') throw new Error(result.detail);
    await refreshOfflineUsage();
  }, [credentials, preferences.automaticCacheLimitBytes, refreshOfflineUsage]);

  const resolveOfflineDocument = useCallback(async (
    id: string,
    representation: 'original' | 'archive',
  ) => {
    const profileId = activeProfileIdRef.current;
    if (!profileId || !credentials) return null;
    const result = await createOfflineManager(
      credentials,
      preferences.automaticCacheLimitBytes,
    ).resolve(profileId, id, representation);
    return result.kind === 'available' ? result.file : null;
  }, [credentials, preferences.automaticCacheLimitBytes]);

  const clearEvictableCache = useCallback(async () => {
    const profileId = activeProfileIdRef.current;
    if (!profileId || !credentials) return;
    const result = await createOfflineManager(
      credentials,
      preferences.automaticCacheLimitBytes,
    ).clearEvictable(profileId);
    setOfflineUsage(result.usage);
    if (result.failed.length) throw new Error(result.failed[0].message);
  }, [credentials, preferences.automaticCacheLimitBytes]);

  const removeAllPinnedFiles = useCallback(async () => {
    const profileId = activeProfileIdRef.current;
    if (!profileId || !credentials) return;
    const result = await createOfflineManager(
      credentials,
      preferences.automaticCacheLimitBytes,
    ).removeAllPinned(profileId, true);
    if (result.kind === 'removed') {
      setOfflineUsage(result.result.usage);
      if (result.result.failed.length) throw new Error(result.result.failed[0].message);
    }
  }, [credentials, preferences.automaticCacheLimitBytes]);

  const retryTask = useCallback(async (
    taskId: string,
    options?: { userConfirmedDuplicateRisk?: boolean },
  ) => {
    if (!credentials) throw new Error(translateRuntime('appError.connectRetry'));
    const profileId = credentials.profileId ?? activeProfileIdRef.current;
    if (!profileId) throw new Error(translateRuntime('appError.selectProfileRetry'));
    const id = taskId.replace(/^task-/, '');
    const stored = await folioRepository.readTask(profileId, id);
    if (!stored) throw new Error(translateRuntime('appError.taskMissing'));
    const readyCredentials = await prepareNetworkCredentials(credentials);
    if (!readyCredentials) throw new Error(translateRuntime('appError.connectRetry'));
    if (stored.kind === 'upload' && stored.stage === 'submission-uncertain') {
      const next = confirmUploadResubmission(stored, {
        userConfirmedDuplicateRisk: options?.userConfirmedDuplicateRisk === true,
      });
      await folioRepository.writeTask(next);
      publishTask(next);
      void runUploadQueue(profileId, readyCredentials);
      return;
    }
    if (stored.kind === 'metadata-update') {
      const retried = await metadataUpdateController.retry(profileId, id);
      publishTask(retried);
      void runMetadataQueue(profileId, readyCredentials);
      return;
    }
    if (stored.kind === 'offline-download') {
      if (stored.stage !== 'failed' || stored.error?.retryable !== true) {
        throw new Error(translateRuntime('appError.retryDownloadOnly'));
      }
      const next = {
        ...transitionTask(stored, 'queued'),
        error: undefined,
        nextAttemptAt: undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
      };
      await folioRepository.writeTask(next);
      publishTask(next);
      await runOfflineDownloadQueue(profileId, readyCredentials);
      const completed = await folioRepository.readTask(profileId, next.id);
      if (completed?.stage === 'failed') {
        throw new Error(completed.error?.message || translateRuntime('taskRuntime.offlineStoreFailed'));
      }
      return;
    }
    if (stored.stage !== 'failed') {
      if (stored.stage === 'queued' || stored.stage === 'processing') {
        void runUploadQueue(profileId, readyCredentials);
        return;
      }
      throw new Error(translateRuntime('appError.retryTaskOnly'));
    }
    if (stored.error && !stored.error.retryable && stored.error.code === 'missing-file') {
      throw new Error(translateRuntime('appError.uploadCopyMissing'));
    }
    const retrySource = prepareFailedBulkOutcomesForRetry(stored);
    const next = {
      ...transitionTask(retrySource, retrySource.paperlessTaskId ? 'processing' : 'queued'),
      error: undefined,
      nextAttemptAt: undefined,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
    };
    await folioRepository.writeTask(next);
    publishTask(next);
    void runUploadQueue(profileId, readyCredentials);
  }, [credentials, prepareNetworkCredentials, publishTask, runMetadataQueue, runOfflineDownloadQueue, runUploadQueue]);

  const cancelTask = useCallback(async (taskId: string) => {
    const profileId = activeProfileIdRef.current;
    if (!profileId) throw new Error(translateRuntime('appError.selectProfileCancel'));
    const id = taskId.replace(/^task-/, '');
    const stored = await folioRepository.readTask(profileId, id);
    if (!stored) throw new Error(translateRuntime('appError.taskMissing'));
    if (stored.kind === 'metadata-update') {
      const discarded = await metadataUpdateController.discard(profileId, id);
      publishTask(discarded.task);
      if (discarded.document) {
        setDocuments((current) => current.map((document) => (
          document.id === discarded.document!.id ? discarded.document! : document
        )));
      }
      if (discarded.detailDocument) {
        setDocumentDetails((current) => {
          const next = { ...current, [discarded.detailDocument!.id]: discarded.detailDocument! };
          documentDetailsRef.current = next;
          return next;
        });
      }
      return;
    }
    let canceled = cancelPersistentTask(stored);
    await folioRepository.writeTask(canceled);
    if (stored.kind === 'offline-download') {
      offlineDownloadControllers.current.get(`${stored.profileId}\u0000${stored.id}`)?.abort();
      if (stored.documentId && stored.offlineRepresentation) {
        const cachedFile = (await folioRepository.listOfflineFiles(stored.profileId)).find((file) => (
          file.documentId === stored.documentId
          && file.representation === stored.offlineRepresentation
        ));
        if (cachedFile) {
          await expoOfflineFileStorage.remove(stored.profileId, cachedFile.uri).catch(() => undefined);
          await folioRepository.deleteOfflineFile(
            stored.profileId,
            stored.documentId,
            stored.offlineRepresentation,
          );
          await refreshOfflineUsage();
        }
      }
    }
    if (canceled.cancellationDisposition === 'local' && canceled.localUri) {
      const staging = Platform.OS === 'web'
        ? webIntakeStagingAdapter
        : nativeIntakeStagingAdapter;
      try {
        canceled = await clearStagedFileReference(canceled, {
          remove: staging.remove,
          writeTask: (task) => folioRepository.writeTask(task),
        });
      } catch (error) {
        publishTask(error instanceof StagedFileCleanupError ? error.task : canceled);
        throw error;
      }
    }
    publishTask(canceled);
  }, [publishTask, refreshOfflineUsage]);

  const resolveMetadataConflict = useCallback(async (
    taskId: string,
    resolution: MetadataConflictResolution,
  ) => {
    const profileId = activeProfileIdRef.current;
    if (!profileId) throw new Error(translateRuntime('appError.selectProfileMetadata'));
    const resolved = await metadataUpdateController.resolveConflict(
      profileId,
      taskId.replace(/^task-/, ''),
      resolution,
    );
    publishTask(resolved.task);
    if (resolved.document) {
      setDocuments((current) => current.map((document) => (
        document.id === resolved.document!.id ? resolved.document! : document
      )));
    }
    if (resolved.detailDocument) {
      setDocumentDetails((current) => {
        const next = { ...current, [resolved.detailDocument!.id]: resolved.detailDocument! };
        documentDetailsRef.current = next;
        return next;
      });
    }
    if (
      resolution === 'keep-local'
      && credentials
      && networkCredentialsReady
      && onlineRef.current !== false
    ) {
      void runMetadataQueue(profileId, credentials);
    }
  }, [credentials, networkCredentialsReady, publishTask, runMetadataQueue]);

  const deleteTaskRecord = useCallback(async (taskId: string) => {
    const profileId = activeProfileIdRef.current;
    if (!profileId) throw new Error(translateRuntime('appError.selectProfileHistory'));
    const id = taskId.replace(/^task-/, '');
    const stored = await folioRepository.readTask(profileId, id);
    if (!stored) return;
    if (!['ready', 'canceled'].includes(stored.stage)) {
      throw new Error(translateRuntime('appError.terminalDeleteOnly'));
    }
    if (stored.localUri) {
      const staging = Platform.OS === 'web'
        ? webIntakeStagingAdapter
        : nativeIntakeStagingAdapter;
      try {
        await deleteTaskAfterStagedFileCleanup(stored, {
          remove: staging.remove,
          writeTask: (task) => folioRepository.writeTask(task),
          deleteTask: (taskProfileId, taskRecordId) => (
            folioRepository.deleteTask(taskProfileId, taskRecordId)
          ),
        });
      } catch (error) {
        if (error instanceof StagedFileCleanupError) publishTask(error.task);
        throw error;
      }
    } else {
      await folioRepository.deleteTask(profileId, id);
    }
    setTasks((current) => current.filter((task) => task.id !== id));
  }, [publishTask]);

  const saveUploadPreset = useCallback(async (preset: UploadPreset) => {
    const profileId = activeProfileIdRef.current;
    if (!profileId || preset.profileId !== profileId) {
      throw new Error(translateRuntime('appError.presetProfile'));
    }
    const normalized = { ...preset, name: preset.name.trim(), updatedAt: new Date().toISOString() };
    if (!normalized.name) throw new Error(translateRuntime('intake.presetNameError'));
    await folioRepository.writePreset(normalized);
    setUploadPresets((current) => [
      normalized,
      ...current.filter((item) => item.id !== normalized.id),
    ].sort((left, right) => left.name.localeCompare(right.name)));
  }, []);

  const deleteUploadPreset = useCallback(async (presetId: string) => {
    const profileId = activeProfileIdRef.current;
    if (!profileId) throw new Error(translateRuntime('appError.selectProfilePreset'));
    await folioRepository.deletePreset(profileId, presetId);
    setUploadPresets((current) => current.filter((preset) => preset.id !== presetId));
  }, []);

  const trackPaperlessPdfOperation = useCallback(async (input: {
    documentId: number;
    operation: string;
    paperlessTaskIds: string[];
  }) => {
    if (!credentials) throw new Error(translateRuntime('appError.connectPdf'));
    const profileId = credentials.profileId ?? activeProfileIdRef.current;
    if (!profileId || !Number.isSafeInteger(input.documentId) || input.documentId <= 0) {
      throw new Error(translateRuntime('appError.pdfIdentity'));
    }
    const operation = input.operation
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    if (!operation) throw new Error(translateRuntime('appError.pdfName'));
    const taskIds = [...new Set(input.paperlessTaskIds.map((id) => id.trim()))];
    if (taskIds.some((id) => !/^[A-Za-z0-9._:-]{1,256}$/.test(id))) {
      throw new Error(translateRuntime('appError.pdfTaskUnsafe'));
    }

    const existing = await folioRepository.listTasks(profileId);
    const localIds: string[] = [];
    if (!taskIds.length) {
      // Paperless accepted the request, but no unique background job could be
      // identified. Persist an attention item and never claim completion or
      // manufacture an ID: repeating a PDF operation may be destructive.
      const task = createUncorrelatedPdfOperationTask({
        id: globalThis.crypto?.randomUUID?.() ?? `pdf-${Date.now()}-uncorrelated`,
        profileId,
        documentId: input.documentId,
        operation,
        summary: translateRuntime('taskRuntime.pdfUncorrelated', { operation }),
      });
      await folioRepository.writeTask(task);
      publishTask(task);
      return [task.id];
    }
    for (const paperlessTaskId of taskIds) {
      const duplicate = existing.find((task) => (
        task.kind === 'pdf-operation' && task.paperlessTaskId === paperlessTaskId
      ));
      if (duplicate) {
        localIds.push(duplicate.id);
        continue;
      }
      const timestamp = new Date().toISOString();
      const task: PersistentTask = {
        schemaVersion: PERSISTED_TASK_SCHEMA_VERSION,
        id: globalThis.crypto?.randomUUID?.() ?? `pdf-${Date.now()}-${localIds.length}`,
        profileId,
        kind: 'pdf-operation',
        stage: 'processing',
        source: 'unknown',
        originalName: operation,
        documentId: `remote-${input.documentId}`,
        progress: 1,
        paperlessTaskId,
        retryCount: 0,
        result: {
          remoteDocumentId: input.documentId,
          routeDocumentId: `remote-${input.documentId}`,
          summary: translateRuntime('taskRuntime.pdfAccepted', { operation }),
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await folioRepository.writeTask(task);
      publishTask(task);
      localIds.push(task.id);
    }
    void runUploadQueue(profileId, credentials);
    return localIds;
  }, [credentials, publishTask, runUploadQueue]);

  const trackPaperlessBulkOperation = useCallback(async (input: {
    result: PaperlessBulkResult;
    targets: PersistentBulkTaskTarget[];
  }) => {
    if (!credentials) throw new Error(translateRuntime('appError.connectBulk'));
    const profileId = credentials.profileId ?? activeProfileIdRef.current;
    if (!profileId) throw new Error(translateRuntime('appError.selectProfileBulk'));
    const operationKey = input.result.operation.kind === 'tags'
      ? input.result.operation.mode === 'add' ? 'bulk.addTags'
        : input.result.operation.mode === 'remove' ? 'bulk.removeTags'
          : 'bulk.replaceTags'
      : input.result.operation.kind === 'setCorrespondent' ? 'bulk.correspondent'
        : input.result.operation.kind === 'setDocumentType' ? 'bulk.documentType'
          : input.result.operation.kind === 'setStoragePath' ? 'bulk.storagePath'
            : input.result.operation.kind === 'setOwner' ? 'bulk.owner'
              : input.result.operation.kind === 'file' ? 'bulk.fileInbox'
                : input.result.operation.kind === 'reprocess' ? 'bulk.reprocess'
                  : 'bulk.trash';
    const operationName = translateRuntime(operationKey);
    const existing = await folioRepository.listTasks(profileId);
    const targetForRemote = (remoteDocumentId: number) => input.targets.find(
      (target) => target.remoteDocumentId === remoteDocumentId,
    ) ?? { localId: `remote-${remoteDocumentId}`, remoteDocumentId };
    const batchId = globalThis.crypto?.randomUUID?.() ?? `bulk-batch-${Date.now()}`;
    const taskInputs: Parameters<typeof createPersistentBulkOperationTask>[0][] = [];

    input.result.succeeded.forEach((remoteDocumentId) => {
      const target = targetForRemote(remoteDocumentId);
      taskInputs.push({
        id: globalThis.crypto?.randomUUID?.() ?? `bulk-${Date.now()}-${taskInputs.length}`,
        profileId,
        batchId,
        name: operationName,
        summary: operationName,
        operation: input.result.operation,
        targets: [target],
        outcomes: [{ ...target, state: 'succeeded' }],
      });
    });
    input.result.failed.forEach((failure) => {
      const target = failure.localId
        ? input.targets.find((candidate) => candidate.localId === failure.localId)
        : failure.remoteId ? targetForRemote(failure.remoteId) : undefined;
      if (!target) return;
      const classified = classifyTaskFailure(failure.status ?? undefined, failure.message);
      const error = { ...classified, retryable: failure.retryable };
      taskInputs.push({
        id: globalThis.crypto?.randomUUID?.() ?? `bulk-${Date.now()}-${taskInputs.length}`,
        profileId,
        batchId,
        name: operationName,
        summary: failure.message,
        operation: input.result.operation,
        targets: [target],
        outcomes: [{ ...target, state: 'failed', error }],
        error,
      });
    });
    input.result.skipped.forEach((skipped) => {
      const target = input.targets.find((candidate) => candidate.localId === skipped.localId)
        ?? {
          localId: skipped.localId,
          ...(skipped.remoteId ? { remoteDocumentId: skipped.remoteId } : {}),
        };
      taskInputs.push({
        id: globalThis.crypto?.randomUUID?.() ?? `bulk-${Date.now()}-${taskInputs.length}`,
        profileId,
        batchId,
        name: operationName,
        summary: skipped.reason,
        operation: input.result.operation,
        targets: [target],
        outcomes: [{ ...target, state: 'skipped', skipReason: skipped.reason }],
      });
    });
    const pendingTargets = input.result.pending.map(targetForRemote);
    const validTaskIds = input.result.taskIds.filter(
      (id, index, taskIds) => /^[A-Za-z0-9._:-]{1,256}$/.test(id)
        && taskIds.indexOf(id) === index,
    );
    const allTaskIdsAreValidAndUnique = validTaskIds.length === input.result.taskIds.length;
    if (pendingTargets.length && allTaskIdsAreValidAndUnique && validTaskIds.length === 1) {
      const paperlessTaskId = validTaskIds[0];
      taskInputs.push({
        id: globalThis.crypto?.randomUUID?.() ?? `bulk-${Date.now()}-${taskInputs.length}`,
        profileId,
        batchId,
        name: operationName,
        summary: translateRuntime('taskRuntime.bulkAccepted', {
          operation: operationName,
          count: pendingTargets.length,
        }),
        operation: input.result.operation,
        targets: pendingTargets,
        outcomes: pendingTargets.map((target) => ({
          ...target,
          state: 'pending' as const,
          paperlessTaskId,
        })),
        paperlessTaskId,
      });
    } else {
      const correlationError = {
        code: 'unknown' as const,
        message: 'Paperless accepted this operation but did not return a safely correlated task ID. Its outcome cannot be safely retried.',
        retryable: false,
      };
      pendingTargets.forEach((target) => {
        taskInputs.push({
          id: globalThis.crypto?.randomUUID?.() ?? `bulk-${Date.now()}-${taskInputs.length}`,
          profileId,
          batchId,
          name: operationName,
          summary: correlationError.message,
          operation: input.result.operation,
          targets: [target],
          outcomes: [{ ...target, state: 'failed', error: correlationError }],
          error: correlationError,
        });
      });
    }

    const persistedPaperlessTaskIds = new Set(existing
      .filter((task) => task.kind === 'bulk-operation' && !!task.paperlessTaskId)
      .map((task) => task.paperlessTaskId));
    const tasks = taskInputs.filter((candidate) => {
      if (!candidate.paperlessTaskId) return true;
      if (persistedPaperlessTaskIds.has(candidate.paperlessTaskId)) return false;
      persistedPaperlessTaskIds.add(candidate.paperlessTaskId);
      return true;
    }).map(createPersistentBulkOperationTask);
    await folioRepository.writeTasks(tasks);
    tasks.forEach(publishTask);
    if (tasks.some((task) => task.stage === 'processing')) {
      void runUploadQueue(profileId, credentials);
    }
    return tasks.map((task) => task.id);
  }, [credentials, publishTask, runUploadQueue]);

  const reconcilePaperlessBulkOperation = useCallback(async (input: {
    expectedProfileId: string;
    result: PaperlessBulkResult;
    targets: PersistentBulkTaskTarget[];
  }) => {
    const generation = profileGeneration.current;
    const executionGuard = () => (
      generation === profileGeneration.current
      && activeProfileIdRef.current === input.expectedProfileId
    );
    if (!executionGuard()) return null;
    const reconciliation: BulkDocumentReconciliation = {
      result: input.result,
      targets: input.targets,
      catalog,
      labels: {
        noCorrespondent: translateRuntime('document.noCorrespondent'),
        unknownCorrespondent: translateRuntime('document.unknownCorrespondent'),
        unsortedDocumentType: translateRuntime('document.unsorted'),
        unknownDocumentType: translateRuntime('document.remoteGenericType'),
        automaticStoragePath: translateRuntime('document.automatic'),
        unknownStoragePath: translateRuntime('document.unknownStoragePath'),
        unknownTag: '—',
        reprocessing: translateRuntime('taskRuntime.reprocessing'),
      },
    };
    const commit = await commitConfirmedBulkReconciliation({
      repository: folioRepository,
      profileId: input.expectedProfileId,
      reconciliation,
      executionGuard,
      publish(workspace) {
        setDocuments((current) => executionGuard()
          ? reconcileConfirmedBulkDocuments(current, reconciliation)
          : current);
        setDocumentDetails((current) => {
          if (!executionGuard()) return current;
          const next = Object.fromEntries(Object.entries(current).flatMap(([id, document]) => {
            const reconciled = reconcileConfirmedBulkDocuments([document], reconciliation)[0];
            return reconciled ? [[id, reconciled]] : [];
          }));
          documentDetailsRef.current = next;
          return next;
        });
        setTotalDocuments((current) => executionGuard() ? workspace.totalDocuments : current);
      },
    });
    if (commit.status === 'missing-workspace') {
      throw new Error('The active profile has no cached workspace for bulk reconciliation.');
    }
    return commit.status === 'published' ? reconciliation : null;
  }, [catalog]);

  const retryDocumentProcessing = useCallback(
    async (id: string) => retryTask(id),
    [retryTask],
  );

  useEffect(() => {
    void refreshOfflineUsage().catch(() => setOfflineUsage(null));
  }, [refreshOfflineUsage]);

  const updatePreference = useCallback(
    async <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => {
      if (key === 'biometricLock' && value) await requireBiometricSupport();
      if (key === 'processingNotifications' && value) {
        const granted = await requestProcessingNotificationPermission();
        if (!granted) throw new Error(translateRuntime('appError.notificationPermission'));
      }
      if (
        key === 'automaticCacheLimitBytes'
        && (typeof value !== 'number' || !Number.isFinite(value) || value < 16 * 1024 * 1024)
      ) {
        throw new Error(translateRuntime('appError.cacheLimitMin'));
      }
      const next = { ...preferences, [key]: value };
      setRuntimeNotificationPreferences(
        next.processingNotifications,
        next.notificationPrivacy,
      );
      setPreferences(next);
      await saveStoredValue(PREFERENCES_KEY, next);
      if (
        (key === 'processingNotifications' && value === false)
        || (key === 'notificationPrivacy' && value === 'redacted')
        || (key === 'biometricLock' && value === true)
      ) {
        await Promise.all(profiles.map((profile) => dismissProfileNotifications(profile.id)));
      }
      if (key === 'automaticCacheLimitBytes' && credentials?.profileId) {
        const manager = createOfflineManager(credentials, value as number);
        setOfflineUsage(await manager.trimToQuota(credentials.profileId));
      }
    },
    [credentials, preferences, profiles],
  );

  const value = useMemo<AppContextValue>(
    () => ({
      documents,
      inboxDocuments: documents.filter((document) => document.status !== 'archived'),
      catalog,
      totalDocuments,
      connected: Boolean(credentials),
      profileConfigured: Boolean(activeProfile),
      credentials,
      profiles,
      profileOwnership,
      activeProfile,
      connectionInfo,
      creationCapabilities,
      isBootstrapping,
      isSyncing,
      lastSynced,
      syncState,
      online,
      connectionError,
      operationError,
      tasks,
      intakeRejectionBatches,
      uploadPresets,
      offlineUsage,
      resolveDocumentId,
      preferences,
      preferencesReady,
      clearOperationError: () => setOperationError(null),
      approveDocument,
      deferDocument,
      connect,
      testConnectionProfile,
      discardConnectionProfileTest,
      saveConnectionProfile,
      renameConnectionProfile,
      revokeProfileOidc,
      refreshProfileOwnership,
      switchProfile,
      removeProfile,
      disconnect,
      refresh,
      publishSavedView,
      publishSavedViewDeletion,
      publishCatalogObject,
      publishCatalogDeletion,
      importDocument,
      importDocuments,
      prepareDocuments,
      dismissIntakeRejectionBatch,
      updateUploadTask,
      submitUploadTasks,
      retryDocumentProcessing,
      retryTask,
      cancelTask,
      deleteTaskRecord,
      resolveMetadataConflict,
      trackPaperlessPdfOperation,
      trackPaperlessBulkOperation,
      reconcilePaperlessBulkOperation,
      saveUploadPreset,
      deleteUploadPreset,
      pinDocumentOffline,
      removeOfflineDocument,
      resolveOfflineDocument,
      clearEvictableCache,
      removeAllPinnedFiles,
      refreshOfflineUsage,
      updateDocument,
      createCatalogOption,
      deleteDocument,
      reprocessDocument,
      loadSavedView,
      searchLibrary,
      loadTrash,
      restoreTrash,
      emptyTrash,
      addNote,
      deleteNote,
      uploadVersion,
      renameVersion,
      deleteVersion,
      shareDocument,
      saveDocument,
      updatePreference,
    }),
    [
      approveDocument,
      activeProfile,
      catalog,
      connect,
      discardConnectionProfileTest,
      connectionError,
      connectionInfo,
      creationCapabilities,
      credentials,
      createCatalogOption,
      deferDocument,
      deleteDocument,
      disconnect,
      documents,
      dismissIntakeRejectionBatch,
      importDocument,
      importDocuments,
      prepareDocuments,
      updateUploadTask,
      submitUploadTasks,
      isBootstrapping,
      isSyncing,
      lastSynced,
      syncState,
      online,
      operationError,
      offlineUsage,
      resolveDocumentId,
      preferences,
      preferencesReady,
      profiles,
      profileOwnership,
      refresh,
      publishSavedView,
      publishSavedViewDeletion,
      publishCatalogObject,
      publishCatalogDeletion,
      refreshProfileOwnership,
      retryDocumentProcessing,
      retryTask,
      cancelTask,
      deleteTaskRecord,
      resolveMetadataConflict,
      trackPaperlessPdfOperation,
      trackPaperlessBulkOperation,
      reconcilePaperlessBulkOperation,
      saveUploadPreset,
      deleteUploadPreset,
      pinDocumentOffline,
      removeOfflineDocument,
      resolveOfflineDocument,
      clearEvictableCache,
      removeAllPinnedFiles,
      refreshOfflineUsage,
      reprocessDocument,
      loadSavedView,
      searchLibrary,
      loadTrash,
      restoreTrash,
      emptyTrash,
      addNote,
      deleteNote,
      uploadVersion,
      renameVersion,
      deleteVersion,
      saveDocument,
      saveConnectionProfile,
      shareDocument,
      switchProfile,
      testConnectionProfile,
      removeProfile,
      renameConnectionProfile,
      revokeProfileOidc,
      totalDocuments,
      tasks,
      intakeRejectionBatches,
      uploadPresets,
      updateDocument,
      updatePreference,
    ],
  );

  const detailValue = useMemo<DocumentDetailContextValue>(
    () => ({ details: documentDetails, version: documentDetailsVersion, loadDocumentDetails }),
    [documentDetails, documentDetailsVersion, loadDocumentDetails],
  );

  return (
    <AppContext.Provider value={value}>
      <DocumentDetailContext.Provider value={detailValue}>
        {children}
      </DocumentDetailContext.Provider>
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used inside AppProvider');
  return context;
}

export function useDocumentDetail(id: string) {
  const context = useContext(DocumentDetailContext);
  if (!context) throw new Error('useDocumentDetail must be used inside AppProvider');
  return {
    document: context.details[id],
    version: context.version,
    loadDocumentDetails: context.loadDocumentDetails,
  };
}
