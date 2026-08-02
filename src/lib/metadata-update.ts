import type {
  DocumentChanges,
  DocumentItem,
  PaperlessCatalog,
  PaperlessOption,
} from '../types/document.ts';
import type {
  PersistentMetadataCustomField,
  PersistentMetadataField,
  PersistentMetadataOption,
  PersistentMetadataPatch,
  PersistentMetadataUpdate,
  PersistentTask,
} from '../types/tasks.ts';

const METADATA_FIELDS = [
  'title',
  'correspondent',
  'documentType',
  'tags',
  'created',
  'storagePath',
  'archiveSerialNumber',
  'customFields',
] as const satisfies readonly PersistentMetadataField[];

function positiveInteger(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maxLength: number, allowEmpty = false) {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const normalized = value.trim();
  if ((!allowEmpty && !normalized) || normalized.length > maxLength) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function sanitizeOption(value: PaperlessOption, label: string): PersistentMetadataOption {
  return {
    remoteId: positiveInteger(value.remoteId, `${label} ID`),
    name: boundedString(value.name, `${label} name`, 512),
  };
}

function sanitizeCustomFieldValue(
  value: PersistentMetadataCustomField['value'],
): PersistentMetadataCustomField['value'] {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('A custom-field number must be finite.');
    return value;
  }
  if (typeof value === 'string') return boundedString(value, 'Custom-field value', 16_384, true);
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => positiveInteger(item, 'Linked document ID')))]
      .sort((left, right) => left - right);
  }
  throw new Error('A custom-field value is invalid.');
}

function sanitizeCustomFields(
  fields: NonNullable<DocumentChanges['customFields']>,
): PersistentMetadataCustomField[] {
  const byId = new Map<number, PersistentMetadataCustomField>();
  for (const field of fields) {
    const fieldRemoteId = positiveInteger(field.fieldRemoteId, 'Custom-field ID');
    byId.set(fieldRemoteId, {
      fieldRemoteId,
      value: sanitizeCustomFieldValue(field.value),
    });
  }
  return [...byId.values()].sort((left, right) => left.fieldRemoteId - right.fieldRemoteId);
}

export function sanitizeMetadataPatch(changes: DocumentChanges): PersistentMetadataPatch {
  const patch: PersistentMetadataPatch = {};
  if (changes.title !== undefined) patch.title = boundedString(changes.title, 'Title', 1024);
  if (changes.created !== undefined) {
    const created = boundedString(changes.created, 'Created date', 10);
    const parsed = new Date(`${created}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(created)
      || !Number.isFinite(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== created
    ) {
      throw new Error('Created date must use YYYY-MM-DD.');
    }
    patch.created = created;
  }
  if (changes.correspondent !== undefined) {
    patch.correspondent = changes.correspondent
      ? sanitizeOption(changes.correspondent, 'Correspondent')
      : null;
  }
  if (changes.documentType !== undefined) {
    patch.documentType = changes.documentType
      ? sanitizeOption(changes.documentType, 'Document type')
      : null;
  }
  if (changes.storagePath !== undefined) {
    patch.storagePath = changes.storagePath
      ? sanitizeOption(changes.storagePath, 'Storage path')
      : null;
  }
  if (changes.tags !== undefined) {
    const byId = new Map<number, PersistentMetadataOption>();
    for (const tag of changes.tags) {
      const normalized = sanitizeOption(tag, 'Tag');
      byId.set(normalized.remoteId, normalized);
    }
    patch.tags = [...byId.values()].sort((left, right) => left.remoteId - right.remoteId);
  }
  if (changes.archiveSerialNumber !== undefined) {
    patch.archiveSerialNumber = changes.archiveSerialNumber === null
      ? null
      : positiveInteger(changes.archiveSerialNumber, 'Archive serial number');
  }
  if (changes.customFields !== undefined) patch.customFields = sanitizeCustomFields(changes.customFields);
  if (!Object.keys(patch).length) throw new Error('A metadata update must change at least one field.');
  if (JSON.stringify(patch).length > 64 * 1024) throw new Error('The metadata update is too large.');
  return patch;
}

function optionForDocument(
  id: string | undefined,
  options: readonly PaperlessOption[],
): PersistentMetadataOption | null {
  const option = options.find((candidate) => candidate.id === id);
  return option?.remoteId
    ? { remoteId: option.remoteId, name: option.name }
    : null;
}

export function metadataValuesForPatch(
  document: DocumentItem,
  patch: PersistentMetadataPatch,
  catalog: PaperlessCatalog,
): PersistentMetadataPatch {
  const values: PersistentMetadataPatch = {};
  if ('title' in patch) values.title = document.title.trim();
  if ('created' in patch) values.created = document.created;
  if ('correspondent' in patch) {
    values.correspondent = optionForDocument(document.correspondentId, catalog.correspondents);
  }
  if ('documentType' in patch) {
    values.documentType = optionForDocument(document.documentTypeId, catalog.documentTypes);
  }
  if ('storagePath' in patch) {
    values.storagePath = optionForDocument(document.storagePathId, catalog.storagePaths);
  }
  if ('tags' in patch) {
    values.tags = document.tagIds
      .map((id) => optionForDocument(id, catalog.tags))
      .filter((option): option is PersistentMetadataOption => option !== null)
      .sort((left, right) => left.remoteId - right.remoteId);
  }
  if ('archiveSerialNumber' in patch) {
    values.archiveSerialNumber = document.archiveSerialNumber ?? null;
  }
  if ('customFields' in patch) {
    values.customFields = (document.customFields ?? [])
      .filter((field): field is typeof field & { fieldRemoteId: number } => !!field.fieldRemoteId)
      .map((field) => ({
        fieldRemoteId: field.fieldRemoteId,
        value: sanitizeCustomFieldValue(field.value),
      }))
      .sort((left, right) => left.fieldRemoteId - right.fieldRemoteId);
  }
  return values;
}

function optionToDocumentId(kind: 'correspondent' | 'type' | 'storage-path' | 'tag', remoteId: number) {
  return `remote-${kind}-${remoteId}`;
}

export function documentChangesFromMetadataPatch(patch: PersistentMetadataPatch): DocumentChanges {
  const changes: DocumentChanges = {};
  if ('title' in patch) changes.title = patch.title;
  if ('created' in patch) changes.created = patch.created;
  if ('archiveSerialNumber' in patch) changes.archiveSerialNumber = patch.archiveSerialNumber;
  if ('correspondent' in patch) changes.correspondent = patch.correspondent
    ? { ...patch.correspondent, id: optionToDocumentId('correspondent', patch.correspondent.remoteId) }
    : null;
  if ('documentType' in patch) changes.documentType = patch.documentType
    ? { ...patch.documentType, id: optionToDocumentId('type', patch.documentType.remoteId) }
    : null;
  if ('storagePath' in patch) changes.storagePath = patch.storagePath
    ? { ...patch.storagePath, id: optionToDocumentId('storage-path', patch.storagePath.remoteId) }
    : null;
  if ('tags' in patch) changes.tags = patch.tags?.map((tag) => ({
    ...tag,
    id: optionToDocumentId('tag', tag.remoteId),
  }));
  if ('customFields' in patch) changes.customFields = patch.customFields?.map((field) => ({
    fieldId: `remote-custom-field-${field.fieldRemoteId}`,
    fieldRemoteId: field.fieldRemoteId,
    value: field.value,
  }));
  return changes;
}

export function applyMetadataPatch(
  document: DocumentItem,
  patch: PersistentMetadataPatch,
): DocumentItem {
  const changes = documentChangesFromMetadataPatch(patch);
  const tags = changes.tags;
  return {
    ...document,
    title: changes.title ?? document.title,
    created: changes.created ?? document.created,
    correspondent: changes.correspondent === undefined
      ? document.correspondent
      : changes.correspondent?.name ?? 'No correspondent',
    correspondentId: changes.correspondent === undefined
      ? document.correspondentId
      : changes.correspondent?.id,
    documentType: changes.documentType === undefined
      ? document.documentType
      : changes.documentType?.name ?? 'Unsorted',
    documentTypeId: changes.documentType === undefined
      ? document.documentTypeId
      : changes.documentType?.id,
    storagePath: changes.storagePath === undefined
      ? document.storagePath
      : changes.storagePath?.name ?? 'Automatic',
    storagePathId: changes.storagePath === undefined
      ? document.storagePathId
      : changes.storagePath?.id,
    tags: tags?.map((tag) => tag.name) ?? document.tags,
    tagIds: tags?.map((tag) => tag.id) ?? document.tagIds,
    archiveSerialNumber: changes.archiveSerialNumber === undefined
      ? document.archiveSerialNumber
      : changes.archiveSerialNumber,
    customFields: changes.customFields ?? document.customFields,
    status: tags
      ? tags.some((tag) => tag.name.toLocaleLowerCase() === 'inbox') ? 'inbox' : 'archived'
      : document.status,
  };
}

function canonical(value: unknown) {
  return JSON.stringify(value);
}

export function metadataPatchMatches(
  values: PersistentMetadataPatch,
  expected: PersistentMetadataPatch,
) {
  return METADATA_FIELDS
    .filter((field) => field in expected)
    .every((field) => canonical(values[field]) === canonical(expected[field]));
}

export function conflictingMetadataFields(
  baseline: PersistentMetadataPatch,
  server: PersistentMetadataPatch,
  patch: PersistentMetadataPatch,
): PersistentMetadataField[] {
  return METADATA_FIELDS
    .filter((field) => field in patch)
    .filter((field) => canonical(baseline[field]) !== canonical(server[field]));
}

export function mergeMetadataPatches(
  previous: PersistentMetadataPatch,
  next: PersistentMetadataPatch,
) {
  return { ...previous, ...next };
}

export function overlayPendingMetadataUpdates(
  documents: readonly DocumentItem[],
  tasks: readonly PersistentTask[],
) {
  const patches = new Map<string, PersistentMetadataPatch>();
  for (const task of [...tasks].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    if (
      task.kind === 'metadata-update'
      && !['ready', 'canceled'].includes(task.stage)
      && task.metadataUpdate
    ) patches.set(task.metadataUpdate.documentId, task.metadataUpdate.patch);
  }
  return documents.map((document) => {
    const patch = patches.get(document.id);
    return patch ? applyMetadataPatch(document, patch) : document;
  });
}

export function assertMetadataUpdate(task: PersistentTask): PersistentMetadataUpdate {
  if (task.kind !== 'metadata-update' || !task.metadataUpdate) {
    throw new Error('The durable task does not contain a metadata update.');
  }
  const update = task.metadataUpdate;
  if (!update.documentId || !Number.isSafeInteger(update.remoteDocumentId) || update.remoteDocumentId <= 0) {
    throw new Error('The durable metadata target is invalid.');
  }
  // Re-sanitize data read from disk so a corrupt or older record cannot send
  // arbitrary object keys to the API transport.
  const patch = sanitizeMetadataPatch(documentChangesFromMetadataPatch(update.patch));
  return { ...update, patch };
}
