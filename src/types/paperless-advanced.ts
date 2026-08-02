export type PaperlessCapabilitySource =
  | 'openapi'
  | 'options'
  | 'ui-settings'
  | 'api-version-fallback'
  | 'runtime';

export type PaperlessUnsupportedReason =
  | 'not-discovered'
  | 'schema-unavailable'
  | 'endpoint-missing'
  | 'field-missing'
  | 'permission-unknown'
  | 'permission-denied'
  | 'runtime-disabled'
  | 'representation-unavailable'
  | 'invalid-input'
  | 'unknown-rules'
  | 'self-lockout'
  | 'requires-confirmation'
  | 'task-correlation-unavailable';

export type PaperlessCapabilityStatus =
  | {
      supported: true;
      source: PaperlessCapabilitySource;
      detail?: string;
    }
  | {
      supported: false;
      reason: PaperlessUnsupportedReason;
      source?: PaperlessCapabilitySource;
      detail?: string;
    };

export type PaperlessCapabilityResult<T> =
  | { supported: true; value: T }
  | {
      supported: false;
      reason: PaperlessUnsupportedReason;
      detail?: string;
    };

export type PaperlessPermissionState = boolean | 'unknown';
export type PaperlessPermissionAction = 'view' | 'add' | 'change' | 'delete';
export type PaperlessPermissionResource =
  | 'document'
  | 'tag'
  | 'correspondent'
  | 'documentType'
  | 'storagePath'
  | 'savedView'
  | 'customField'
  | 'user'
  | 'group'
  | 'shareLink';

export type PaperlessPermissionMatrix = Record<
  PaperlessPermissionResource,
  Record<PaperlessPermissionAction, PaperlessPermissionState>
> & {
  currentUserId: number | null;
  isSuperuser: boolean;
};

export type PaperlessCatalogResource =
  | 'tags'
  | 'correspondents'
  | 'documentTypes'
  | 'storagePaths';

export type PaperlessCrudCapabilities = {
  list: PaperlessCapabilityStatus;
  retrieve: PaperlessCapabilityStatus;
  create: PaperlessCapabilityStatus;
  update: PaperlessCapabilityStatus;
  delete: PaperlessCapabilityStatus;
};

export type PaperlessSavedViewFieldCapabilities = {
  pageSize: PaperlessCapabilityStatus;
  displayMode: PaperlessCapabilityStatus;
  displayFields: PaperlessCapabilityStatus;
  showOnDashboard: PaperlessCapabilityStatus;
  showInSidebar: PaperlessCapabilityStatus;
};

export type PaperlessCapabilities = {
  profileId: string;
  discoveredAt: string;
  apiVersion: string | null;
  serverVersion: string | null;
  openApiVersion: string | null;
  schemaAvailable: boolean;
  optionsAvailable: boolean;
  serverFingerprint: string;
  permissions: PaperlessPermissionMatrix;
  features: {
    bulkDocuments: PaperlessCapabilityStatus;
    deleteDocuments: PaperlessCapabilityStatus;
    reprocessDocuments: PaperlessCapabilityStatus;
    savedViews: PaperlessCrudCapabilities & {
      /** Writable fields observed in the negotiated saved-view PATCH schema. */
      fields?: PaperlessSavedViewFieldCapabilities;
    };
    catalogs: Record<PaperlessCatalogResource, PaperlessCrudCapabilities>;
    documentMetadata: PaperlessCapabilityStatus;
    shareLinks: PaperlessCrudCapabilities;
    nestedTags: PaperlessCapabilityStatus;
    fullPermissions: PaperlessCapabilityStatus;
    duplicateDocuments: PaperlessCapabilityStatus;
    aiSuggestions: PaperlessCapabilityStatus;
    tasksV10: PaperlessCapabilityStatus;
    pdf: {
      rotate: PaperlessCapabilityStatus;
      merge: PaperlessCapabilityStatus;
      edit: PaperlessCapabilityStatus;
      removePassword: PaperlessCapabilityStatus;
    };
  };
};

export type PaperlessCapabilityCacheEntry = {
  profileId: string;
  fetchedAt: number;
  expiresAt: number;
  serverFingerprint: string;
  capabilities: PaperlessCapabilities;
};

export type PaperlessPermissionSet = {
  view: {
    users: number[];
    groups: number[];
  };
  change: {
    users: number[];
    groups: number[];
  };
};

export type PaperlessOwnedObject = {
  ownerId: number | null;
  permissions: PaperlessPermissionSet | null;
  userCanChange: boolean | null;
};

export type PaperlessMatchingAlgorithm = number | string;

export type PaperlessCatalogBase = PaperlessOwnedObject & {
  id: number;
  slug: string | null;
  name: string;
  match: string;
  matchingAlgorithm: PaperlessMatchingAlgorithm | null;
  isInsensitive: boolean;
  documentCount: number | null;
  extra: Readonly<Record<string, unknown>>;
};

export type PaperlessTag = PaperlessCatalogBase & {
  kind: 'tag';
  color: string | null;
  textColor: string | null;
  isInboxTag: boolean;
  parentId: number | null;
  children: PaperlessTag[];
};

export type PaperlessCorrespondent = PaperlessCatalogBase & {
  kind: 'correspondent';
  lastCorrespondence: string | null;
};

export type PaperlessDocumentType = PaperlessCatalogBase & {
  kind: 'documentType';
};

export type PaperlessStoragePath = PaperlessCatalogBase & {
  kind: 'storagePath';
  path: string;
};

export type PaperlessCatalogObject =
  | PaperlessTag
  | PaperlessCorrespondent
  | PaperlessDocumentType
  | PaperlessStoragePath;

export type PaperlessTagEdit = {
  name?: string;
  color?: string;
  match?: string;
  matchingAlgorithm?: PaperlessMatchingAlgorithm;
  isInsensitive?: boolean;
  isInboxTag?: boolean;
  parentId?: number | null;
};

export type PaperlessCorrespondentEdit = {
  name?: string;
  match?: string;
  matchingAlgorithm?: PaperlessMatchingAlgorithm;
  isInsensitive?: boolean;
};

export type PaperlessDocumentTypeEdit = PaperlessCorrespondentEdit;

export type PaperlessStoragePathEdit = PaperlessCorrespondentEdit & {
  path?: string;
};

export type PaperlessCatalogEditByResource = {
  tags: PaperlessTagEdit;
  correspondents: PaperlessCorrespondentEdit;
  documentTypes: PaperlessDocumentTypeEdit;
  storagePaths: PaperlessStoragePathEdit;
};

export type PaperlessCatalogObjectByResource = {
  tags: PaperlessTag;
  correspondents: PaperlessCorrespondent;
  documentTypes: PaperlessDocumentType;
  storagePaths: PaperlessStoragePath;
};

export type PaperlessSavedViewRule = {
  ruleType: number;
  value: string | null;
  known: boolean;
  extra: Readonly<Record<string, unknown>>;
};

export type PaperlessSavedView = PaperlessOwnedObject & {
  id: number;
  name: string;
  sortField: string | null;
  sortReverse: boolean;
  filterRules: PaperlessSavedViewRule[];
  pageSize: number | null;
  displayMode: string | null;
  displayFields: (string | number)[] | null;
  showOnDashboard: boolean | null;
  showInSidebar: boolean | null;
  extra: Readonly<Record<string, unknown>>;
};

export type PaperlessSavedViewEdit = {
  name?: string;
  sortField?: string | null;
  sortReverse?: boolean;
  filterRules?: PaperlessSavedViewRule[];
  pageSize?: number | null;
  displayMode?: string | null;
  displayFields?: (string | number)[] | null;
  showOnDashboard?: boolean;
  showInSidebar?: boolean;
  /** Opaque presentation fields copied only for lossless create/duplicate. */
  extra?: Readonly<Record<string, unknown>>;
};

export type PaperlessUnknownRulePolicy = 'preserve' | 'block';

export type PaperlessPage<T> = {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
};

export type PaperlessBulkCandidate = {
  localId: string;
  remoteId?: number | null;
  ready: boolean;
  canEdit?: boolean | null;
  currentTagIds?: number[];
};

export type PaperlessBulkOperation =
  | { kind: 'tags'; mode: 'add' | 'remove' | 'replace'; tagIds: number[] }
  | {
      kind: 'setCorrespondent' | 'setDocumentType' | 'setStoragePath';
      value: number | null;
    }
  | { kind: 'setOwner'; value: number | null }
  | { kind: 'file'; inboxTagIds: number[] }
  | { kind: 'reprocess' }
  | { kind: 'trash' };

export type PaperlessBulkSkipReason =
  | 'not-remote'
  | 'processing'
  | 'read-only'
  | 'duplicate-selection'
  | 'missing-current-tags';

export type PaperlessBulkSkippedItem = {
  localId: string;
  remoteId: number | null;
  reason: PaperlessBulkSkipReason;
};

export type PaperlessOperationFailure = {
  localId?: string;
  remoteId?: number;
  status: number | null;
  code: string;
  message: string;
  retryable: boolean;
};

export type PaperlessBulkResult = {
  operation: PaperlessBulkOperation;
  accepted: boolean;
  /** Documents accepted by an asynchronous Paperless task but not yet
   * confirmed complete. These must never be presented as successes. */
  pending: number[];
  succeeded: number[];
  failed: PaperlessOperationFailure[];
  skipped: PaperlessBulkSkippedItem[];
  requestCount: number;
  taskIds: string[];
};

export type PaperlessRepresentation = 'original' | 'archive';

export type PaperlessRepresentationInfo = {
  representation: PaperlessRepresentation;
  available: boolean;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  checksum: string | null;
};

export type PaperlessDocumentRepresentations = {
  documentId: number;
  original: PaperlessRepresentationInfo;
  archive: PaperlessRepresentationInfo;
};

export type PaperlessShareLink = {
  id: number;
  created: string;
  expiration: string | null;
  slug: string;
  documentId: number;
  fileVersion: PaperlessRepresentation;
  expired: boolean;
  extra: Readonly<Record<string, unknown>>;
};

export type PaperlessShareLinkExpiry =
  | { kind: 'never' }
  | { kind: 'days'; days: 1 | 7 | 30 }
  | { kind: 'custom'; at: string | Date };

export type PaperlessNormalizedTag = Omit<PaperlessTag, 'children'> & {
  childIds: number[];
  path: string[];
  pathLabel: string;
  depth: number;
};

export type PaperlessTagHierarchy = {
  roots: number[];
  byId: ReadonlyMap<number, PaperlessNormalizedTag>;
};

export type PaperlessValidationError = {
  path: string;
  code: string;
  message: string;
};

export type PaperlessValidationResult<T> =
  | { valid: true; value: T; warnings: PaperlessValidationError[] }
  | { valid: false; errors: PaperlessValidationError[] };

export type PaperlessPermissionMutation = {
  ownerId?: number | null;
  permissions: PaperlessPermissionSet;
  mode: 'merge' | 'replace';
  confirmSelfLockout?: boolean;
};

export type PaperlessPermissionUpdateResult = {
  ownerId: number | null;
  permissions: PaperlessPermissionSet;
  verified: boolean;
};

export type PaperlessDuplicateSummary = {
  id: number;
  title: string;
  deletedAt: string | null;
  source: 'document' | 'task';
};

export type PaperlessAiSuggestions = {
  title: string | null;
  correspondentIds: number[];
  proposedCorrespondents: string[];
  tagIds: number[];
  proposedTags: string[];
  documentTypeIds: number[];
  proposedDocumentTypes: string[];
  storagePathIds: number[];
  proposedStoragePaths: string[];
  dates: string[];
  customFields: Readonly<Record<string, unknown>>;
};

export type PaperlessPdfSourceMode = 'latest_version' | 'explicit_selection';

export type PaperlessPdfPageOperation = {
  page: number;
  rotate?: number;
  outputDocument?: number;
};

export type PaperlessAsyncOperationResult = {
  accepted: true;
  taskIds: string[];
  taskCorrelation: 'response' | 'task-feed' | 'unavailable';
  response: unknown;
};

export type PaperlessTaskV10 = {
  id: number;
  taskId: string;
  taskType: string;
  triggerSource: string;
  status: 'pending' | 'started' | 'success' | 'failure' | 'revoked' | string;
  dateCreated: string | null;
  inputData: Readonly<Record<string, unknown>>;
  resultData: Readonly<Record<string, unknown>>;
  relatedDocumentIds: number[];
  acknowledged: boolean;
  ownerId: number | null;
};
