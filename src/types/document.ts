export type DocumentStatus = 'inbox' | 'archived' | 'processing';

export type PaperlessOption = {
  id: string;
  remoteId?: number;
  name: string;
  color?: string;
  /** Present for tag options when the visible catalog contains a valid parent. */
  parentRemoteId?: number;
  /** A display-only breadcrumb assembled exclusively from visible tag names. */
  pathLabel?: string;
  depth?: number;
  childRemoteIds?: number[];
  isInboxTag?: boolean;
};

export type PaperlessCreatableOptionKind = 'tag' | 'correspondent' | 'documentType';

export type PaperlessCreationCapabilities = Record<
  PaperlessCreatableOptionKind,
  boolean | null
> & {
  uploadDocument: boolean | null;
  assignOwner: boolean | null;
  /** True only when the negotiated post_document schema advertises an upload
   * workflow override. Paperless 3.0.5 does not expose one. */
  uploadWorkflowOverride: boolean | null;
};

export type PaperlessCustomFieldDataType =
  | 'string'
  | 'url'
  | 'date'
  | 'boolean'
  | 'integer'
  | 'float'
  | 'monetary'
  | 'documentlink'
  | 'select'
  | 'longtext';

export type PaperlessSelectOption = {
  id: string;
  label: string;
};

export type PaperlessCustomFieldDefinition = {
  id: string;
  remoteId?: number;
  name: string;
  dataType: PaperlessCustomFieldDataType;
  selectOptions: PaperlessSelectOption[];
  defaultCurrency?: string;
  documentCount?: number;
};

export type PaperlessCustomFieldValue = {
  fieldId: string;
  fieldRemoteId?: number;
  value: string | number | boolean | number[] | null;
};

export type PaperlessNote = {
  id: number | string;
  note: string;
  created: string;
  author: string;
};

export type PaperlessDocumentVersion = {
  id: number | string;
  added: string;
  versionLabel?: string | null;
  checksum?: string | null;
  isRoot: boolean;
};

export type PaperlessSavedViewRule = {
  ruleType: number;
  value: string | null;
  /** False when Folio cannot faithfully project this rule into its editor. */
  known?: boolean;
  /** Supplemental server fields retained for lossless duplicate/save-as-new. */
  extra?: Readonly<Record<string, unknown>>;
};

export type PaperlessSavedView = {
  id: string;
  remoteId?: number;
  name: string;
  sortField: string;
  sortReverse: boolean;
  filterRules: PaperlessSavedViewRule[];
  pageSize: number;
  displayMode?: string;
  displayFields: string[];
  /** Opaque presentation fields retained for lossless save-as-new. */
  extra?: Readonly<Record<string, unknown>>;
};

export type PaperlessOptionalWorkspaceResource =
  | 'correspondents'
  | 'documentTypes'
  | 'tags'
  | 'storagePaths'
  | 'owners'
  | 'customFields'
  | 'savedViews'
  | 'workflows';

export type PaperlessWorkspaceResourceCapability =
  | { available: true }
  | {
      available: false;
      reason: 'permission-denied' | 'endpoint-unavailable';
      status: 403 | 404 | 405;
    };

export type PaperlessWorkspaceResourceAvailability = {
  documents: { available: true };
} & Record<PaperlessOptionalWorkspaceResource, PaperlessWorkspaceResourceCapability>;

export type PaperlessCatalog = {
  correspondents: PaperlessOption[];
  documentTypes: PaperlessOption[];
  tags: PaperlessOption[];
  storagePaths: PaperlessOption[];
  owners: PaperlessOption[];
  workflows?: PaperlessOption[];
  customFields: PaperlessCustomFieldDefinition[];
  savedViews: PaperlessSavedView[];
  /** Present on live workspace catalogs so empty and permission-unavailable
   * resources remain distinguishable after the catalog enters app state. */
  resourceAvailability?: PaperlessWorkspaceResourceAvailability;
};

export type LibrarySelectionMode = 'include' | 'exclude';
export type LibraryTagMode = 'any' | 'all' | 'none';
export type LibraryCustomFieldMode = 'any' | 'all' | 'none';
export type LibraryStatusFilter = 'any' | 'inbox' | 'tagged' | 'untagged';

export type LibraryFilters = {
  status: LibraryStatusFilter;
  correspondentIds: string[];
  correspondentMode: LibrarySelectionMode;
  correspondentMissing: boolean;
  documentTypeIds: string[];
  documentTypeMode: LibrarySelectionMode;
  documentTypeMissing: boolean;
  tagIds: string[];
  tagMode: LibraryTagMode;
  storagePathIds: string[];
  storagePathMode: LibrarySelectionMode;
  storagePathMissing: boolean;
  ownerIds: string[];
  ownerMode: LibrarySelectionMode;
  ownerMissing: boolean;
  customFieldIds: string[];
  customFieldMode: LibraryCustomFieldMode;
  mimeTypes: string[];
  createdAfter: string;
  createdBefore: string;
  addedAfter: string;
  addedBefore: string;
  modifiedAfter: string;
  modifiedBefore: string;
  archiveSerialMin: string;
  archiveSerialMax: string;
  archiveSerialMissing: boolean;
};

export type LibrarySortOrder =
  | 'added-desc'
  | 'added-asc'
  | 'created-desc'
  | 'created-asc'
  | 'title-asc'
  | 'title-desc'
  | 'correspondent-asc'
  | 'document-type-asc';

export type PaperlessLibraryRequest = {
  query: string;
  queryRuleType?: 19 | 20 | 48 | 49;
  filters: LibraryFilters;
  extraRules?: PaperlessSavedViewRule[];
  /** Base saved view identity used only for exact profile-scoped offline snapshots. */
  savedViewId?: string;
  savedViewModified?: boolean;
};

export type DocumentItem = {
  id: string;
  remoteId?: number;
  taskId?: string;
  title: string;
  correspondent: string;
  correspondentId?: string;
  documentType: string;
  documentTypeId?: string;
  storagePath?: string;
  storagePathId?: string;
  created: string;
  added: string;
  addedAt?: string;
  pageCount: number;
  fileSize: string;
  /** Raw server-reported bytes used for locale-aware presentation. */
  fileSizeBytes?: number;
  tags: string[];
  tagIds: string[];
  status: DocumentStatus;
  color: string;
  accent: string;
  excerpt: string;
  fullText?: string;
  originalFileName?: string;
  mimeType?: string;
  modifiedAt?: string;
  owner?: string;
  ownerId?: string;
  /** True only after the active Paperless account returned this document. */
  canView?: boolean;
  canEdit?: boolean;
  deletedAt?: string | null;
  archiveSerialNumber?: number | null;
  customFields?: PaperlessCustomFieldValue[];
  notes?: PaperlessNote[];
  versions?: PaperlessDocumentVersion[];
  rootDocumentId?: number;
  processingError?: string;
  duplicateDocumentIds?: number[];
  suggestion?: string;
  source: 'demo' | 'remote' | 'local';
};

export type PaperlessCredentials = {
  serverUrl: string;
  token: string;
  profileId?: string;
  /** Opaque OS/native Keychain reference. It never contains certificate or key bytes. */
  clientIdentityRef?: string;
  authorizationScheme?: 'Token' | 'Bearer';
  customHeaders?: Record<string, string>;
};

export type PaperlessConnectionInfo = {
  apiVersion: string;
  serverVersion: string;
};

export type DocumentChanges = {
  title?: string;
  correspondent?: PaperlessOption | null;
  documentType?: PaperlessOption | null;
  tags?: PaperlessOption[];
  created?: string;
  storagePath?: PaperlessOption | null;
  archiveSerialNumber?: number | null;
  customFields?: PaperlessCustomFieldValue[];
};

export type PaperlessTrashWorkspace = {
  documents: DocumentItem[];
  totalDocuments: number;
};

export type AppPreferences = {
  biometricLock: boolean;
  processingNotifications: boolean;
  notificationPrivacy: 'redacted' | 'document-title';
  osSearchEnabled: boolean;
  osSearchMetadata: 'minimal' | 'document-title';
  automaticCacheLimitBytes: number;
};
