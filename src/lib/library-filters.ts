import {
  DocumentItem,
  LibraryFilters,
  LibrarySortOrder,
  PaperlessCatalog,
  PaperlessOption,
  PaperlessSavedView,
  PaperlessSavedViewRule,
} from '@/types/document';

export const emptyLibraryFilters: LibraryFilters = {
  status: 'any',
  correspondentIds: [],
  correspondentMode: 'include',
  correspondentMissing: false,
  documentTypeIds: [],
  documentTypeMode: 'include',
  documentTypeMissing: false,
  tagIds: [],
  tagMode: 'any',
  storagePathIds: [],
  storagePathMode: 'include',
  storagePathMissing: false,
  ownerIds: [],
  ownerMode: 'include',
  ownerMissing: false,
  customFieldIds: [],
  customFieldMode: 'any',
  mimeTypes: [],
  createdAfter: '',
  createdBefore: '',
  addedAfter: '',
  addedBefore: '',
  modifiedAfter: '',
  modifiedBefore: '',
  archiveSerialMin: '',
  archiveSerialMax: '',
  archiveSerialMissing: false,
};

export const librarySortLabels: Record<LibrarySortOrder, string> = {
  'added-desc': 'Recently added',
  'added-asc': 'Oldest added',
  'created-desc': 'Newest document date',
  'created-asc': 'Oldest document date',
  'title-asc': 'Title A–Z',
  'title-desc': 'Title Z–A',
  'correspondent-asc': 'Correspondent A–Z',
  'document-type-asc': 'Document type A–Z',
};

export function cloneLibraryFilters(filters: LibraryFilters): LibraryFilters {
  return {
    ...filters,
    correspondentIds: [...filters.correspondentIds],
    documentTypeIds: [...filters.documentTypeIds],
    tagIds: [...filters.tagIds],
    storagePathIds: [...filters.storagePathIds],
    ownerIds: [...filters.ownerIds],
    customFieldIds: [...filters.customFieldIds],
    mimeTypes: [...filters.mimeTypes],
  };
}

export function libraryFilterCount(filters: LibraryFilters) {
  return [
    filters.status !== 'any',
    filters.correspondentIds.length > 0 || filters.correspondentMissing,
    filters.documentTypeIds.length > 0 || filters.documentTypeMissing,
    filters.tagIds.length > 0,
    filters.storagePathIds.length > 0 || filters.storagePathMissing,
    filters.ownerIds.length > 0 || filters.ownerMissing,
    filters.customFieldIds.length > 0,
    filters.mimeTypes.length > 0,
    !!filters.createdAfter || !!filters.createdBefore,
    !!filters.addedAfter || !!filters.addedBefore,
    !!filters.modifiedAfter || !!filters.modifiedBefore,
    !!filters.archiveSerialMin || !!filters.archiveSerialMax || filters.archiveSerialMissing,
  ].filter(Boolean).length;
}

export function hasLibraryFilters(filters: LibraryFilters) {
  return libraryFilterCount(filters) > 0;
}

function matchesSelection(
  value: string | undefined,
  selectedIds: string[],
  mode: 'include' | 'exclude',
  includeMissing: boolean,
) {
  if (!selectedIds.length && !includeMissing) return true;
  const constrained = (!!value && selectedIds.includes(value)) || (!value && includeMissing);
  return mode === 'include' ? constrained : !constrained;
}

function matchesDateRange(value: string | undefined, after: string, before: string) {
  if (!after && !before) return true;
  if (!value) return false;
  const day = value.slice(0, 10);
  if (after && day < after) return false;
  if (before && day > before) return false;
  return true;
}

function matchesNumericRange(value: number | null | undefined, filters: LibraryFilters) {
  if (filters.archiveSerialMissing) return value === null || value === undefined;
  if (!filters.archiveSerialMin && !filters.archiveSerialMax) return true;
  if (value === null || value === undefined) return false;
  const min = Number(filters.archiveSerialMin);
  const max = Number(filters.archiveSerialMax);
  if (filters.archiveSerialMin && Number.isFinite(min) && value <= min) return false;
  if (filters.archiveSerialMax && Number.isFinite(max) && value >= max) return false;
  return true;
}

export function matchesLibraryFilters(document: DocumentItem, filters: LibraryFilters) {
  if (filters.status === 'inbox' && document.status !== 'inbox') return false;
  if (filters.status === 'tagged' && !document.tagIds.length) return false;
  if (filters.status === 'untagged' && document.tagIds.length > 0) return false;

  if (!matchesSelection(
    document.correspondentId,
    filters.correspondentIds,
    filters.correspondentMode,
    filters.correspondentMissing,
  )) return false;
  if (!matchesSelection(
    document.documentTypeId,
    filters.documentTypeIds,
    filters.documentTypeMode,
    filters.documentTypeMissing,
  )) return false;
  if (!matchesSelection(
    document.storagePathId,
    filters.storagePathIds,
    filters.storagePathMode,
    filters.storagePathMissing,
  )) return false;
  if (!matchesSelection(
    document.ownerId,
    filters.ownerIds,
    filters.ownerMode,
    filters.ownerMissing,
  )) return false;

  if (filters.tagIds.length) {
    const matchingTags = filters.tagIds.filter((id) => document.tagIds.includes(id)).length;
    if (filters.tagMode === 'any' && matchingTags === 0) return false;
    if (filters.tagMode === 'all' && matchingTags !== filters.tagIds.length) return false;
    if (filters.tagMode === 'none' && matchingTags > 0) return false;
  }

  if (filters.customFieldIds.length) {
    const fieldIds = new Set((document.customFields || []).map((field) => field.fieldId));
    const matchingFields = filters.customFieldIds.filter((id) => fieldIds.has(id)).length;
    if (filters.customFieldMode === 'any' && matchingFields === 0) return false;
    if (filters.customFieldMode === 'all' && matchingFields !== filters.customFieldIds.length) return false;
    if (filters.customFieldMode === 'none' && matchingFields > 0) return false;
  }

  if (filters.mimeTypes.length && !filters.mimeTypes.includes(document.mimeType || '')) return false;
  if (!matchesDateRange(document.created, filters.createdAfter, filters.createdBefore)) return false;
  if (!matchesDateRange(document.addedAt || document.created, filters.addedAfter, filters.addedBefore)) return false;
  if (!matchesDateRange(document.modifiedAt, filters.modifiedAfter, filters.modifiedBefore)) return false;
  return matchesNumericRange(document.archiveSerialNumber, filters);
}

export function sortLibraryDocuments(documents: DocumentItem[], sortOrder: LibrarySortOrder) {
  return [...documents].sort((a, b) => {
    switch (sortOrder) {
      case 'added-asc':
        return dateValue(a.addedAt || a.created) - dateValue(b.addedAt || b.created);
      case 'created-desc':
        return dateValue(b.created) - dateValue(a.created);
      case 'created-asc':
        return dateValue(a.created) - dateValue(b.created);
      case 'title-asc':
        return a.title.localeCompare(b.title);
      case 'title-desc':
        return b.title.localeCompare(a.title);
      case 'correspondent-asc':
        return a.correspondent.localeCompare(b.correspondent) || a.title.localeCompare(b.title);
      case 'document-type-asc':
        return a.documentType.localeCompare(b.documentType) || a.title.localeCompare(b.title);
      case 'added-desc':
      default:
        return dateValue(b.addedAt || b.created) - dateValue(a.addedAt || a.created);
    }
  });
}

function dateValue(value: string | undefined) {
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function remoteIds(value: string | null) {
  return (value || '').split(',').map((entry) => Number(entry.trim())).filter(Number.isFinite);
}

function localIds(options: PaperlessOption[], value: string | null) {
  const ids = new Set(remoteIds(value));
  return options.filter((option) => option.remoteId !== undefined && ids.has(option.remoteId)).map((option) => option.id);
}

function booleanRule(value: string | null) {
  return value === 'true' || value === '1';
}

function ruleDate(value: string | null) {
  return value?.slice(0, 10) || '';
}

function sortFromSavedView(view: PaperlessSavedView): LibrarySortOrder {
  const reverse = view.sortReverse;
  switch (view.sortField.replace(/^-/, '')) {
    case 'created': return reverse ? 'created-desc' : 'created-asc';
    case 'title': return reverse ? 'title-desc' : 'title-asc';
    case 'correspondent':
    case 'correspondent__name': return 'correspondent-asc';
    case 'document_type':
    case 'document_type__name': return 'document-type-asc';
    case 'added':
    default: return reverse ? 'added-desc' : 'added-asc';
  }
}

export function savedViewToLibraryState(view: PaperlessSavedView, catalog: PaperlessCatalog) {
  const filters = cloneLibraryFilters(emptyLibraryFilters);
  const extraRules: PaperlessSavedViewRule[] = [];
  let query = '';

  for (const rule of view.filterRules) {
    switch (rule.ruleType) {
      case 5:
        filters.status = booleanRule(rule.value) ? 'inbox' : 'any';
        break;
      case 7:
        filters.status = booleanRule(rule.value) ? 'tagged' : 'untagged';
        break;
      case 6:
        filters.tagIds = localIds(catalog.tags, rule.value);
        filters.tagMode = 'all';
        break;
      case 17:
        filters.tagIds = localIds(catalog.tags, rule.value);
        filters.tagMode = 'none';
        break;
      case 22:
        filters.tagIds = localIds(catalog.tags, rule.value);
        filters.tagMode = 'any';
        break;
      case 3:
        if (rule.value === null) filters.correspondentMissing = true;
        else if (rule.value === '-1') {
          filters.correspondentMissing = true;
          filters.correspondentMode = 'exclude';
        }
        else filters.correspondentIds = localIds(catalog.correspondents, rule.value);
        break;
      case 26:
      case 27:
        filters.correspondentIds = localIds(catalog.correspondents, rule.value);
        filters.correspondentMode = rule.ruleType === 27 ? 'exclude' : 'include';
        break;
      case 4:
        if (rule.value === null) filters.documentTypeMissing = true;
        else if (rule.value === '-1') {
          filters.documentTypeMissing = true;
          filters.documentTypeMode = 'exclude';
        }
        else filters.documentTypeIds = localIds(catalog.documentTypes, rule.value);
        break;
      case 28:
      case 29:
        filters.documentTypeIds = localIds(catalog.documentTypes, rule.value);
        filters.documentTypeMode = rule.ruleType === 29 ? 'exclude' : 'include';
        break;
      case 25:
        if (rule.value === null) filters.storagePathMissing = true;
        else if (rule.value === '-1') {
          filters.storagePathMissing = true;
          filters.storagePathMode = 'exclude';
        }
        else filters.storagePathIds = localIds(catalog.storagePaths, rule.value);
        break;
      case 30:
      case 31:
        filters.storagePathIds = localIds(catalog.storagePaths, rule.value);
        filters.storagePathMode = rule.ruleType === 31 ? 'exclude' : 'include';
        break;
      case 32:
        if (rule.value === null) filters.ownerMissing = true;
        else filters.ownerIds = localIds(catalog.owners, rule.value);
        break;
      case 33:
      case 35:
        filters.ownerIds = localIds(catalog.owners, rule.value);
        filters.ownerMode = rule.ruleType === 35 ? 'exclude' : 'include';
        break;
      case 34:
        filters.ownerMissing = true;
        filters.ownerMode = booleanRule(rule.value) ? 'include' : 'exclude';
        break;
      case 38:
      case 39:
      case 40:
        filters.customFieldIds = localIds(
          catalog.customFields.map((field) => ({ id: field.id, remoteId: field.remoteId, name: field.name })),
          rule.value,
        );
        filters.customFieldMode = rule.ruleType === 38 ? 'all' : rule.ruleType === 40 ? 'none' : 'any';
        break;
      case 8: filters.createdBefore = ruleDate(rule.value); break;
      case 9: filters.createdAfter = ruleDate(rule.value); break;
      case 13: filters.addedBefore = ruleDate(rule.value); break;
      case 14: filters.addedAfter = ruleDate(rule.value); break;
      case 15: filters.modifiedBefore = ruleDate(rule.value); break;
      case 16: filters.modifiedAfter = ruleDate(rule.value); break;
      case 43: filters.createdBefore = ruleDate(rule.value); break;
      case 44: filters.createdAfter = ruleDate(rule.value); break;
      case 45: filters.addedBefore = ruleDate(rule.value); break;
      case 46: filters.addedAfter = ruleDate(rule.value); break;
      case 2:
        filters.archiveSerialMin = rule.value || '';
        filters.archiveSerialMax = rule.value || '';
        break;
      case 18:
        if (booleanRule(rule.value)) filters.archiveSerialMissing = true;
        else extraRules.push(rule);
        break;
      case 23: filters.archiveSerialMin = rule.value || ''; break;
      case 24: filters.archiveSerialMax = rule.value || ''; break;
      case 47: filters.mimeTypes = rule.value ? [rule.value] : []; break;
      case 19:
      case 20:
      case 49:
        if (!query) query = rule.value || '';
        else extraRules.push(rule);
        break;
      default:
        extraRules.push(rule);
    }
  }

  return { filters, query, extraRules, sortOrder: sortFromSavedView(view) };
}

export function isValidLibraryDate(value: string) {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function mimeTypeLabel(value: string) {
  const known: Record<string, string> = {
    'application/pdf': 'PDF',
    'image/jpeg': 'JPEG image',
    'image/png': 'PNG image',
    'image/tiff': 'TIFF image',
    'text/plain': 'Plain text',
  };
  return known[value] || value;
}
