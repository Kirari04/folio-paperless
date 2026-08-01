import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
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

import { palette } from '@/constants/theme';
import { demoDocuments } from '@/data/demo-documents';
import { notifyDocumentProcessed, requestProcessingNotificationPermission, requireBiometricSupport } from '@/lib/device-features';
import { savePaperlessDocument, sharePaperlessDocument } from '@/lib/document-files';
import {
  addPaperlessNote,
  createPaperlessTag,
  deletePaperlessDocument,
  deletePaperlessNote,
  deletePaperlessVersion,
  emptyPaperlessTrash,
  fetchPaperlessDocument,
  fetchPaperlessLibraryDocuments,
  fetchPaperlessSavedViewDocuments,
  fetchPaperlessTrash,
  fetchPaperlessWorkspace,
  renamePaperlessVersion,
  reprocessPaperlessDocument,
  restorePaperlessTrash,
  testPaperlessConnection,
  updatePaperlessDocument,
  uploadPaperlessVersion,
  uploadToPaperless,
  waitForPaperlessTask,
} from '@/lib/paperless';
import {
  AppPreferences,
  DocumentChanges,
  DocumentItem,
  PaperlessCatalog,
  PaperlessConnectionInfo,
  PaperlessCredentials,
  PaperlessDocumentVersion,
  PaperlessNote,
  PaperlessOption,
  PaperlessLibraryRequest,
  PaperlessSavedView,
  PaperlessTrashWorkspace,
} from '@/types/document';
import { matchesLibraryFilters } from '@/lib/library-filters';
import { resolveDocumentAlias } from '@/lib/document-routing';

const CREDENTIALS_KEY = 'folio.paperless.credentials';
const PREFERENCES_KEY = 'folio.preferences';
const defaultPreferences: AppPreferences = {
  biometricLock: false,
  processingNotifications: false,
};

type ImportFile = {
  uri: string;
  name: string;
  mimeType?: string | null;
  pageCount?: number;
};

type ImportDocumentOptions = {
  onProgress?: (progress: number) => void;
};

type AppContextValue = {
  documents: DocumentItem[];
  inboxDocuments: DocumentItem[];
  catalog: PaperlessCatalog;
  totalDocuments: number;
  connected: boolean;
  credentials: PaperlessCredentials | null;
  connectionInfo: PaperlessConnectionInfo | null;
  isBootstrapping: boolean;
  isSyncing: boolean;
  lastSynced: string;
  connectionError: string | null;
  operationError: string | null;
  resolveDocumentId: (id: string) => string;
  preferences: AppPreferences;
  preferencesReady: boolean;
  clearOperationError: () => void;
  approveDocument: (id: string) => Promise<void>;
  deferDocument: (id: string) => void;
  connect: (credentials: PaperlessCredentials) => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
  importDocument: (file: ImportFile, options?: ImportDocumentOptions) => Promise<void>;
  updateDocument: (id: string, changes: DocumentChanges) => Promise<void>;
  createTag: (name: string) => Promise<PaperlessOption>;
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
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}

function syncedLabel() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function applyDocumentChanges(document: DocumentItem, changes: DocumentChanges): DocumentItem {
  const tags = changes.tags;
  return {
    ...document,
    title: changes.title ?? document.title,
    correspondent:
      changes.correspondent === undefined
        ? document.correspondent
        : changes.correspondent?.name || 'No correspondent',
    correspondentId:
      changes.correspondent === undefined ? document.correspondentId : changes.correspondent?.id,
    documentType:
      changes.documentType === undefined
        ? document.documentType
        : changes.documentType?.name || 'Unsorted',
    documentTypeId:
      changes.documentType === undefined ? document.documentTypeId : changes.documentType?.id,
    storagePath:
      changes.storagePath === undefined
        ? document.storagePath
        : changes.storagePath?.name || 'Automatic',
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

export function AppProvider({ children }: PropsWithChildren) {
  const [documents, setDocuments] = useState<DocumentItem[]>(demoWorkspace.documents);
  const [documentDetails, setDocumentDetails] = useState<Record<string, DocumentItem>>({});
  const [documentDetailsVersion, setDocumentDetailsVersion] = useState(0);
  const documentDetailsRef = useRef(documentDetails);
  const [catalog, setCatalog] = useState<PaperlessCatalog>(demoWorkspace.catalog);
  const [totalDocuments, setTotalDocuments] = useState(demoWorkspace.documents.length);
  const [credentials, setCredentials] = useState<PaperlessCredentials | null>(null);
  const [connectionInfo, setConnectionInfo] = useState<PaperlessConnectionInfo | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState('demo mode');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [documentIdAliases, setDocumentIdAliases] = useState<Record<string, string>>({});
  const [preferences, setPreferences] = useState(defaultPreferences);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const pendingProcessedDocumentIds = useRef(new Set<string>());

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

  const loadRemoteWorkspace = useCallback(async (nextCredentials: PaperlessCredentials) => {
    const [workspace, info] = await Promise.all([
      fetchPaperlessWorkspace(nextCredentials),
      testPaperlessConnection(nextCredentials),
    ]);
    return { workspace, info };
  }, []);

  const sync = useCallback(
    async (nextCredentials: PaperlessCredentials) => {
      setIsSyncing(true);
      setConnectionError(null);
      try {
        const { workspace, info } = await loadRemoteWorkspace(nextCredentials);
        const workspaceDocumentIds = new Set(workspace.documents.map((document) => document.id));
        for (const id of pendingProcessedDocumentIds.current) {
          if (workspaceDocumentIds.has(id)) pendingProcessedDocumentIds.current.delete(id);
        }
        setDocuments((current) => [
          ...current.filter(
            (document) =>
              !workspaceDocumentIds.has(document.id) &&
              (document.status === 'processing' || pendingProcessedDocumentIds.current.has(document.id)),
          ),
          ...workspace.documents,
        ]);
        clearDocumentDetails();
        setCatalog(workspace.catalog);
        setTotalDocuments(workspace.totalDocuments);
        setConnectionInfo(info);
        setLastSynced(syncedLabel());
      } catch (error) {
        setConnectionError(errorMessage(error));
        throw error;
      } finally {
        setIsSyncing(false);
      }
    },
    [clearDocumentDetails, loadRemoteWorkspace],
  );

  useEffect(() => {
    let active = true;
    Promise.all([
      loadStoredValue<PaperlessCredentials>(CREDENTIALS_KEY),
      loadStoredValue<AppPreferences>(PREFERENCES_KEY),
    ]).then(([savedCredentials, savedPreferences]) => {
      if (!active) return;
      if (savedPreferences) setPreferences({ ...defaultPreferences, ...savedPreferences });
      setPreferencesReady(true);
      if (!savedCredentials) {
        setIsBootstrapping(false);
        return;
      }
      setCredentials(savedCredentials);
      sync(savedCredentials)
        .catch(() => {
          // Keep the last credentials available so the connection can be retried or corrected.
        })
        .finally(() => active && setIsBootstrapping(false));
    });
    return () => {
      active = false;
    };
  }, [sync]);

  const connect = useCallback(
    async (nextCredentials: PaperlessCredentials) => {
      setIsSyncing(true);
      setConnectionError(null);
      try {
        const { workspace, info } = await loadRemoteWorkspace(nextCredentials);
        await saveStoredValue(CREDENTIALS_KEY, nextCredentials);
        pendingProcessedDocumentIds.current.clear();
        setDocumentIdAliases({});
        setCredentials(nextCredentials);
        setDocuments(workspace.documents);
        clearDocumentDetails();
        setCatalog(workspace.catalog);
        setTotalDocuments(workspace.totalDocuments);
        setConnectionInfo(info);
        setLastSynced(syncedLabel());
      } catch (error) {
        setConnectionError(errorMessage(error));
        throw error;
      } finally {
        setIsSyncing(false);
      }
    },
    [clearDocumentDetails, loadRemoteWorkspace],
  );

  const disconnect = useCallback(async () => {
    await saveStoredValue(CREDENTIALS_KEY, null);
    pendingProcessedDocumentIds.current.clear();
    setDocumentIdAliases({});
    setCredentials(null);
    setConnectionInfo(null);
    setDocuments(demoWorkspace.documents);
    clearDocumentDetails();
    setCatalog(demoWorkspace.catalog);
    setTotalDocuments(demoWorkspace.documents.length);
    setConnectionError(null);
    setOperationError(null);
    setLastSynced('demo mode');
  }, [clearDocumentDetails]);

  const refresh = useCallback(async () => {
    if (!credentials) {
      setLastSynced('demo mode');
      return;
    }
    await sync(credentials);
  }, [credentials, sync]);

  const updateDocument = useCallback(
    async (id: string, changes: DocumentChanges) => {
      const original = documents.find((document) => document.id === id);
      if (!original) throw new Error('Document not found.');
      if (original.canEdit === false) throw new Error('Your Paperless account cannot edit this document.');

      const originalDetail = documentDetailsRef.current[id];

      setOperationError(null);
      updateCachedDocument(id, (document) => applyDocumentChanges(document, changes));
      setDocuments((current) =>
        current.map((document) =>
          document.id === id ? applyDocumentChanges(document, changes) : document,
        ),
      );

      if (!credentials || !original.remoteId) return;
      try {
        await updatePaperlessDocument(credentials, original.remoteId, changes);
      } catch (error) {
        if (originalDetail) {
          setDocumentDetails((current) => {
            const next = { ...current, [id]: originalDetail };
            documentDetailsRef.current = next;
            return next;
          });
        }
        setDocuments((current) =>
          current.map((document) => (document.id === id ? original : document)),
        );
        setOperationError(errorMessage(error));
        throw error;
      }
    },
    [credentials, documents, updateCachedDocument],
  );

  const approveDocument = useCallback(
    async (id: string) => {
      const document = documents.find((item) => item.id === id);
      if (!document || document.status === 'processing') return;
      const remainingTags = catalog.tags.filter(
        (tag) => document.tagIds.includes(tag.id) && tag.name.toLocaleLowerCase() !== 'inbox',
      );
      await updateDocument(id, { tags: remainingTags });
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
      if (!credentials || !document.remoteId) {
        const next = { ...documentDetailsRef.current, [id]: document };
        documentDetailsRef.current = next;
        setDocumentDetails(next);
        return document;
      }
      try {
        const detail = await fetchPaperlessDocument(credentials, document.remoteId, catalog);
        const next = { ...documentDetailsRef.current, [id]: detail };
        documentDetailsRef.current = next;
        setDocumentDetails(next);
        return detail;
      } catch (error) {
        setOperationError(errorMessage(error));
        throw error;
      }
    },
    [catalog, credentials, documents],
  );

  const createTag = useCallback(
    async (name: string) => {
      const normalized = name.trim();
      if (!normalized) throw new Error('Enter a tag name.');
      const existing = catalog.tags.find(
        (tag) => tag.name.toLocaleLowerCase() === normalized.toLocaleLowerCase(),
      );
      if (existing) return existing;

      try {
        const tag = credentials
          ? await createPaperlessTag(credentials, normalized)
          : { id: `local-tag-${Date.now()}`, name: normalized };
        setCatalog((current) => ({
          ...current,
          tags: [...current.tags, tag].sort((a, b) => a.name.localeCompare(b.name)),
        }));
        return tag;
      } catch (error) {
        setOperationError(errorMessage(error));
        throw error;
      }
    },
    [catalog.tags, credentials],
  );

  const deleteDocument = useCallback(
    async (id: string) => {
      const document = documents.find((item) => item.id === id);
      if (!document) return;
      setOperationError(null);
      try {
        if (credentials && document.remoteId) {
          await deletePaperlessDocument(credentials, document.remoteId);
        }
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
        setOperationError(errorMessage(error));
        throw error;
      }
    },
    [credentials, documents],
  );

  const reprocessDocument = useCallback(
    async (id: string) => {
      const document = documents.find((item) => item.id === id);
      if (!credentials || !document?.remoteId) {
        throw new Error('Only documents stored in Paperless can be reprocessed.');
      }
      try {
        await reprocessPaperlessDocument(credentials, document.remoteId);
        setDocuments((current) =>
          current.map((item) =>
            item.id === id
              ? { ...item, suggestion: 'Reprocessing in Paperless' }
              : item,
          ),
        );
      } catch (error) {
        setOperationError(errorMessage(error));
        throw error;
      }
    },
    [credentials, documents],
  );

  const loadSavedView = useCallback(
    async (view: PaperlessSavedView) => {
      if (credentials) {
        const result = await fetchPaperlessSavedViewDocuments(credentials, view, catalog);
        return result.documents;
      }
      return documents.filter((document) =>
        view.filterRules.every((rule) => {
          if (rule.ruleType === 5) return document.status === 'inbox';
          if ([0, 48].includes(rule.ruleType)) {
            return document.title.toLocaleLowerCase().includes((rule.value || '').toLocaleLowerCase());
          }
          if ([19, 49].includes(rule.ruleType)) {
            return `${document.title} ${document.excerpt}`
              .toLocaleLowerCase()
              .includes((rule.value || '').toLocaleLowerCase());
          }
          return true;
        }),
      );
    },
    [catalog, credentials, documents],
  );

  const searchLibrary = useCallback(
    async (request: PaperlessLibraryRequest) => {
      if (credentials) {
        const result = await fetchPaperlessLibraryDocuments(credentials, request, catalog);
        return { documents: result.documents, totalDocuments: result.totalDocuments };
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
    [catalog, credentials, documents],
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
      const document = documentDetailsRef.current[id] || documents.find((item) => item.id === id);
      const normalized = note.trim();
      if (!document) throw new Error('Document not found.');
      if (!normalized) throw new Error('Write a note before adding it.');
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
      updateCachedDocument(id, (item) => ({
        ...item,
        notes: [nextNote, ...(item.notes || [])],
      }));
    },
    [credentials, documents, updateCachedDocument],
  );

  const deleteNote = useCallback(
    async (id: string, noteId: number | string) => {
      const document = documentDetailsRef.current[id] || documents.find((item) => item.id === id);
      if (!document) throw new Error('Document not found.');
      if (credentials && document.remoteId) {
        await deletePaperlessNote(credentials, document.remoteId, noteId);
      }
      updateCachedDocument(id, (item) => ({
        ...item,
        notes: (item.notes || []).filter((note) => note.id !== noteId),
      }));
    },
    [credentials, documents, updateCachedDocument],
  );

  const uploadVersion = useCallback(
    async (id: string, file: ImportFile, label?: string) => {
      const document = documentDetailsRef.current[id] || documents.find((item) => item.id === id);
      if (!document) throw new Error('Document not found.');
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
      const next = { ...documentDetailsRef.current, [id]: detail };
      documentDetailsRef.current = next;
      setDocumentDetails(next);
    },
    [catalog, credentials, documents, updateCachedDocument],
  );

  const renameVersion = useCallback(
    async (id: string, versionId: number | string, label: string) => {
      const document = documentDetailsRef.current[id] || documents.find((item) => item.id === id);
      if (!document) throw new Error('Document not found.');
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
      const document = documentDetailsRef.current[id] || documents.find((item) => item.id === id);
      const version = document?.versions?.find((item) => item.id === versionId);
      if (!document || !version) throw new Error('Document version not found.');
      if (version.isRoot) throw new Error('The original version cannot be removed.');
      if (credentials && document.remoteId && typeof versionId === 'number') {
        await deletePaperlessVersion(
          credentials,
          document.rootDocumentId || document.remoteId,
          versionId,
        );
      }
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
      if (!document) throw new Error('Document not found.');
      if (!credentials || !document.remoteId) {
        throw new Error('Connect Paperless to share the original document file.');
      }
      try {
        return await sharePaperlessDocument(credentials, document, versionId);
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
      if (!document) throw new Error('Document not found.');
      if (!credentials || !document.remoteId) {
        throw new Error('Connect Paperless to download the original document file.');
      }
      try {
        return await savePaperlessDocument(credentials, document, versionId);
      } catch (error) {
        setOperationError(errorMessage(error));
        throw error;
      }
    },
    [credentials, documents],
  );

  const importDocument = useCallback(
    async (file: ImportFile, options?: ImportDocumentOptions) => {
      const title = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
      if (!credentials) {
        const localDocument: DocumentItem = {
          id: `local-${Date.now()}`,
          title,
          correspondent: 'Needs review',
          documentType: 'Unsorted',
          created: new Date().toISOString().slice(0, 10),
          added: 'Just now',
          pageCount: file.pageCount || 1,
          fileSize: 'New',
          tags: [],
          tagIds: [],
          status: 'inbox',
          color: palette.lime,
          accent: palette.limeDark,
          excerpt: 'Newly imported document. Review the metadata before filing it.',
          fullText: 'Newly imported document. Review the metadata before filing it.',
          suggestion: 'Ready for metadata review',
          source: 'local',
        };
        setDocuments((current) => [localDocument, ...current]);
        setTotalDocuments((current) => current + 1);
        return;
      }

      setOperationError(null);
      const taskId = await uploadToPaperless(credentials, file, title, options);
      const placeholderId = `task-${taskId}`;
      const placeholder: DocumentItem = {
        id: placeholderId,
        taskId,
        title,
        correspondent: 'Paperless is analyzing this file',
        documentType: 'Processing',
        created: new Date().toISOString().slice(0, 10),
        added: 'Just now',
        pageCount: file.pageCount || 1,
        fileSize: 'Uploading',
        tags: [],
        tagIds: [],
        status: 'processing',
        color: palette.lime,
        accent: palette.limeDark,
        excerpt: 'OCR, classification, and workflow rules are running on your server.',
        suggestion: 'Processing in Paperless',
        source: 'local',
      };
      setDocuments((current) => [placeholder, ...current]);

      void (async () => {
        try {
          const task = await waitForPaperlessTask(credentials, taskId);
          let processed: DocumentItem | null = null;
          if (task.documentId) {
            processed = {
              ...(await fetchPaperlessDocument(credentials, task.documentId, catalog)),
              taskId,
            };
          }
          if (processed) {
            pendingProcessedDocumentIds.current.add(processed.id);
            setDocumentIdAliases((current) => ({ ...current, [placeholderId]: processed.id }));
            setDocuments((current) => {
              const withoutPlaceholder = current.filter((item) => item.id !== placeholderId);
              return [processed, ...withoutPlaceholder];
            });
            void sync(credentials).catch(() => {
              // Preserve the freshly processed document until a later sync confirms it in the catalog.
            });
            setTotalDocuments((current) => current + 1);
          } else {
            setDocuments((current) =>
              current.map((item) =>
                item.id === placeholderId
                  ? {
                      ...item,
                      fileSize: 'Finalizing',
                      suggestion: 'Syncing the finished document',
                    }
                  : item,
              ),
            );
            await sync(credentials);
            setDocuments((current) => current.filter((item) => item.id !== placeholderId));
          }
          if (preferences.processingNotifications) await notifyDocumentProcessed(processed?.title || title);
        } catch (error) {
          const message = errorMessage(error);
          setDocuments((current) =>
            current.map((item) =>
              item.id === placeholderId
                ? {
                    ...item,
                    status: 'inbox',
                    documentType: 'Processing issue',
                    excerpt: message,
                    processingError: message,
                    suggestion: 'Tap refresh to check again',
                  }
                : item,
            ),
          );
          setOperationError(message);
        }
      })();
    },
    [catalog, credentials, preferences.processingNotifications, sync],
  );

  const updatePreference = useCallback(
    async <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => {
      if (key === 'biometricLock' && value) await requireBiometricSupport();
      if (key === 'processingNotifications' && value) {
        const granted = await requestProcessingNotificationPermission();
        if (!granted) throw new Error('Allow notifications in system settings to enable this option.');
      }
      const next = { ...preferences, [key]: value };
      setPreferences(next);
      await saveStoredValue(PREFERENCES_KEY, next);
    },
    [preferences],
  );

  const value = useMemo<AppContextValue>(
    () => ({
      documents,
      inboxDocuments: documents.filter((document) => document.status !== 'archived'),
      catalog,
      totalDocuments,
      connected: Boolean(credentials),
      credentials,
      connectionInfo,
      isBootstrapping,
      isSyncing,
      lastSynced,
      connectionError,
      operationError,
      resolveDocumentId,
      preferences,
      preferencesReady,
      clearOperationError: () => setOperationError(null),
      approveDocument,
      deferDocument,
      connect,
      disconnect,
      refresh,
      importDocument,
      updateDocument,
      createTag,
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
      catalog,
      connect,
      connectionError,
      connectionInfo,
      credentials,
      createTag,
      deferDocument,
      deleteDocument,
      disconnect,
      documents,
      importDocument,
      isBootstrapping,
      isSyncing,
      lastSynced,
      operationError,
      resolveDocumentId,
      preferences,
      preferencesReady,
      refresh,
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
      shareDocument,
      totalDocuments,
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
