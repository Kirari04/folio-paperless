export type DocumentStatus = 'inbox' | 'archived' | 'processing';

export type PaperlessOption = {
  id: string;
  remoteId?: number;
  name: string;
  color?: string;
};

export type PaperlessCreatableOptionKind = 'tag' | 'correspondent' | 'documentType';

export type PaperlessCreationCapabilities = Record<
  PaperlessCreatableOptionKind,
  boolean | null
>;

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
};

export type PaperlessCatalog = {
  correspondents: PaperlessOption[];
  documentTypes: PaperlessOption[];
  tags: PaperlessOption[];
  storagePaths: PaperlessOption[];
  owners: PaperlessOption[];
  customFields: PaperlessCustomFieldDefinition[];
  savedViews: PaperlessSavedView[];
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
  filters: LibraryFilters;
  extraRules?: PaperlessSavedViewRule[];
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
  canEdit?: boolean;
  deletedAt?: string | null;
  archiveSerialNumber?: number | null;
  customFields?: PaperlessCustomFieldValue[];
  notes?: PaperlessNote[];
  versions?: PaperlessDocumentVersion[];
  rootDocumentId?: number;
  processingError?: string;
  suggestion?: string;
  source: 'demo' | 'remote' | 'local';
};

export type PaperlessCredentials = {
  serverUrl: string;
  token: string;
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
};
