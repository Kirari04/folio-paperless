import type {
  DocumentItem,
  LibraryFilters,
  LibrarySortOrder,
  PaperlessCatalog,
  PaperlessOption,
  PaperlessSavedView,
  PaperlessSavedViewRule,
} from '../types/document.ts';
import {
  PAPERLESS_SAVED_VIEW_RULE,
  isFolioEditableSavedViewRule,
  savedViewRuleStateSignature,
  type PaperlessQueryRuleType,
} from './saved-view-controller.ts';

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

function localIds(options: PaperlessOption[], value: string | null) {
  const values = (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!values.length || values.some((entry) => !/^\d+$/.test(entry))) {
    return { complete: false, ids: [] as string[] };
  }
  const remoteIds = values.map(Number);
  if (remoteIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    return { complete: false, ids: [] as string[] };
  }
  const byRemoteId = new Map(
    options.flatMap((option) => option.remoteId === undefined ? [] : [[option.remoteId, option.id] as const]),
  );
  const ids = remoteIds.flatMap((id) => byRemoteId.has(id) ? [byRemoteId.get(id)!] : []);
  return { complete: ids.length === remoteIds.length, ids: [...new Set(ids)] };
}

function booleanRule(value: string | null) {
  return value === 'true' || value === '1';
}

function ruleDate(value: string | null) {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : '';
}

function shiftRuleDate(value: string | null, days: number) {
  const date = ruleDate(value);
  if (!isValidLibraryDate(date)) return '';
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function shiftIntegerRule(value: string | null, amount: number) {
  if (!value || !/^-?\d+$/.test(value.trim())) return '';
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return '';
  return String(parsed + amount);
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

function savedViewProjectionGroup(ruleType: number) {
  if ([5, 7].includes(ruleType)) return 'status';
  if ([6, 17, 22].includes(ruleType)) return 'tags';
  if ([3, 26, 27].includes(ruleType)) return 'correspondent';
  if ([4, 28, 29].includes(ruleType)) return 'documentType';
  if ([25, 30, 31].includes(ruleType)) return 'storagePath';
  if ([32, 33, 34, 35].includes(ruleType)) return 'owner';
  if ([38, 39, 40].includes(ruleType)) return 'customFields';
  if ([8, 43].includes(ruleType)) return 'createdBefore';
  if ([9, 44].includes(ruleType)) return 'createdAfter';
  if ([13, 45].includes(ruleType)) return 'addedBefore';
  if ([14, 46].includes(ruleType)) return 'addedAfter';
  if (ruleType === 15) return 'modifiedBefore';
  if (ruleType === 16) return 'modifiedAfter';
  if (ruleType === 47) return 'mimeType';
  if ([19, 20, 48, 49].includes(ruleType)) return 'query';
  return null;
}

export function savedViewToLibraryState(view: PaperlessSavedView, catalog: PaperlessCatalog) {
  const filters = cloneLibraryFilters(emptyLibraryFilters);
  const extraRules: PaperlessSavedViewRule[] = [];
  let query = '';
  let queryRuleType: PaperlessQueryRuleType = PAPERLESS_SAVED_VIEW_RULE.simpleText;
  const queryRuleCount = view.filterRules.filter((rule) => [
    PAPERLESS_SAVED_VIEW_RULE.legacyText,
    PAPERLESS_SAVED_VIEW_RULE.fullTextQuery,
    PAPERLESS_SAVED_VIEW_RULE.simpleTitle,
    PAPERLESS_SAVED_VIEW_RULE.simpleText,
  ].includes(rule.ruleType as PaperlessQueryRuleType)).length;
  const projectionGroupRuleTypes = new Map<string, Set<number>>();
  const projectionGroupRules = new Map<string, PaperlessSavedViewRule[]>();
  for (const savedRule of view.filterRules) {
    const group = savedViewProjectionGroup(savedRule.ruleType);
    if (group) {
      const types = projectionGroupRuleTypes.get(group) ?? new Set<number>();
      types.add(savedRule.ruleType);
      projectionGroupRuleTypes.set(group, types);
      projectionGroupRules.set(group, [...(projectionGroupRules.get(group) ?? []), savedRule]);
    }
  }
  const archiveRules = view.filterRules.filter((rule) => [2, 18, 23, 24].includes(rule.ruleType));
  const archiveRuleTypes = new Set(archiveRules.map((rule) => rule.ruleType));
  const archiveProjectionUnsafe = archiveRules.length > 0 && (
    archiveRuleTypes.size !== archiveRules.length
    || (archiveRules.length > 1 && archiveRules.some((rule) => rule.ruleType === 2 || rule.ruleType === 18))
  );

  const retainOpaque = (rule: PaperlessSavedViewRule) => {
    extraRules.push({
      ...rule,
      extra: { ...(rule.extra ?? {}) },
    });
  };
  const projectedIds = (rule: PaperlessSavedViewRule, options: PaperlessOption[]) => {
    const resolved = localIds(options, rule.value);
    if (!resolved.complete) {
      retainOpaque(rule);
      return null;
    }
    return resolved.ids;
  };
  const mergedIds = (current: string[], next: string[]) => [...new Set([...current, ...next])];
  const multiRuleOptions = (ruleType: number) => {
    if ([6, 17, 22].includes(ruleType)) return catalog.tags;
    if ([26, 27].includes(ruleType)) return catalog.correspondents;
    if ([28, 29].includes(ruleType)) return catalog.documentTypes;
    if ([30, 31].includes(ruleType)) return catalog.storagePaths;
    if ([33, 35].includes(ruleType)) return catalog.owners;
    if ([38, 39, 40].includes(ruleType)) {
      return catalog.customFields.map((field) => ({ id: field.id, remoteId: field.remoteId, name: field.name }));
    }
    return null;
  };
  const unsafeProjectionGroups = new Set(
    [...projectionGroupRules].flatMap(([group, rules]) => {
      if (rules.length < 2) return [];
      const types = projectionGroupRuleTypes.get(group)!;
      const options = types.size === 1 ? multiRuleOptions(rules[0].ruleType) : null;
      const safelyMergeable = options !== null && rules.every((savedRule) => (
        isFolioEditableSavedViewRule(savedRule.ruleType, savedRule.value)
        && Object.keys(savedRule.extra ?? {}).length === 0
        && localIds(options, savedRule.value).complete
      ));
      return safelyMergeable ? [] : [group];
    }),
  );

  for (const rule of view.filterRules) {
    const projectionGroup = savedViewProjectionGroup(rule.ruleType);
    if (
      (projectionGroup && unsafeProjectionGroups.has(projectionGroup))
      || (archiveProjectionUnsafe && [2, 18, 23, 24].includes(rule.ruleType))
    ) {
      retainOpaque(rule);
      continue;
    }
    // Supplemental fields may affect a newer server's interpretation. Keep
    // the entire rule opaque instead of applying only the familiar subset.
    if (
      !isFolioEditableSavedViewRule(rule.ruleType, rule.value)
      || Object.keys(rule.extra ?? {}).length > 0
    ) {
      retainOpaque(rule);
      continue;
    }
    switch (rule.ruleType) {
      case 5:
        filters.status = 'inbox';
        break;
      case 7:
        filters.status = booleanRule(rule.value) ? 'tagged' : 'untagged';
        break;
      case 6: {
        const ids = projectedIds(rule, catalog.tags);
        if (!ids) break;
        filters.tagIds = mergedIds(filters.tagIds, ids);
        filters.tagMode = 'all';
        break;
      }
      case 17: {
        const ids = projectedIds(rule, catalog.tags);
        if (!ids) break;
        filters.tagIds = mergedIds(filters.tagIds, ids);
        filters.tagMode = 'none';
        break;
      }
      case 22: {
        const ids = projectedIds(rule, catalog.tags);
        if (!ids) break;
        filters.tagIds = mergedIds(filters.tagIds, ids);
        filters.tagMode = 'any';
        break;
      }
      case 3:
        if (rule.value === null) filters.correspondentMissing = true;
        else if (rule.value === '-1') {
          filters.correspondentMissing = true;
          filters.correspondentMode = 'exclude';
        }
        else {
          const ids = projectedIds(rule, catalog.correspondents);
          if (ids) filters.correspondentIds = ids;
        }
        break;
      case 26:
      case 27: {
        const ids = projectedIds(rule, catalog.correspondents);
        if (!ids) break;
        filters.correspondentIds = mergedIds(filters.correspondentIds, ids);
        filters.correspondentMode = rule.ruleType === 27 ? 'exclude' : 'include';
        break;
      }
      case 4:
        if (rule.value === null) filters.documentTypeMissing = true;
        else if (rule.value === '-1') {
          filters.documentTypeMissing = true;
          filters.documentTypeMode = 'exclude';
        }
        else {
          const ids = projectedIds(rule, catalog.documentTypes);
          if (ids) filters.documentTypeIds = ids;
        }
        break;
      case 28:
      case 29: {
        const ids = projectedIds(rule, catalog.documentTypes);
        if (!ids) break;
        filters.documentTypeIds = mergedIds(filters.documentTypeIds, ids);
        filters.documentTypeMode = rule.ruleType === 29 ? 'exclude' : 'include';
        break;
      }
      case 25:
        if (rule.value === null) filters.storagePathMissing = true;
        else if (rule.value === '-1') {
          filters.storagePathMissing = true;
          filters.storagePathMode = 'exclude';
        }
        else {
          const ids = projectedIds(rule, catalog.storagePaths);
          if (ids) filters.storagePathIds = ids;
        }
        break;
      case 30:
      case 31: {
        const ids = projectedIds(rule, catalog.storagePaths);
        if (!ids) break;
        filters.storagePathIds = mergedIds(filters.storagePathIds, ids);
        filters.storagePathMode = rule.ruleType === 31 ? 'exclude' : 'include';
        break;
      }
      case 32:
        if (rule.value === null) filters.ownerMissing = true;
        else {
          const ids = projectedIds(rule, catalog.owners);
          if (ids) filters.ownerIds = ids;
        }
        break;
      case 33:
      case 35: {
        const ids = projectedIds(rule, catalog.owners);
        if (!ids) break;
        filters.ownerIds = mergedIds(filters.ownerIds, ids);
        filters.ownerMode = rule.ruleType === 35 ? 'exclude' : 'include';
        break;
      }
      case 34:
        filters.ownerMissing = true;
        filters.ownerMode = booleanRule(rule.value) ? 'include' : 'exclude';
        break;
      case 38:
      case 39:
      case 40: {
        const ids = projectedIds(
          rule,
          catalog.customFields.map((field) => ({ id: field.id, remoteId: field.remoteId, name: field.name })),
        );
        if (!ids) break;
        filters.customFieldIds = mergedIds(filters.customFieldIds, ids);
        filters.customFieldMode = rule.ruleType === 38 ? 'all' : rule.ruleType === 40 ? 'none' : 'any';
        break;
      }
      // Legacy rules 8/9/13/14 are strict (< and >), while Folio's range
      // editor and the current Paperless 43–46 rules are inclusive. Moving a
      // date-only boundary by one day preserves the predicate when a legacy
      // saved view is edited and written back.
      case 8: {
        const date = shiftRuleDate(rule.value, -1);
        if (date) filters.createdBefore = date;
        else retainOpaque(rule);
        break;
      }
      case 9: {
        const date = shiftRuleDate(rule.value, 1);
        if (date) filters.createdAfter = date;
        else retainOpaque(rule);
        break;
      }
      case 13: {
        const date = shiftRuleDate(rule.value, -1);
        if (date) filters.addedBefore = date;
        else retainOpaque(rule);
        break;
      }
      case 14: {
        const date = shiftRuleDate(rule.value, 1);
        if (date) filters.addedAfter = date;
        else retainOpaque(rule);
        break;
      }
      case 15: {
        const date = shiftRuleDate(rule.value, -1);
        if (date) filters.modifiedBefore = date;
        else retainOpaque(rule);
        break;
      }
      case 16: {
        const date = shiftRuleDate(rule.value, 1);
        if (date) filters.modifiedAfter = date;
        else retainOpaque(rule);
        break;
      }
      case 43: {
        const date = ruleDate(rule.value);
        if (isValidLibraryDate(date) && date) filters.createdBefore = date;
        else retainOpaque(rule);
        break;
      }
      case 44: {
        const date = ruleDate(rule.value);
        if (isValidLibraryDate(date) && date) filters.createdAfter = date;
        else retainOpaque(rule);
        break;
      }
      case 45: {
        const date = ruleDate(rule.value);
        if (isValidLibraryDate(date) && date) filters.addedBefore = date;
        else retainOpaque(rule);
        break;
      }
      case 46: {
        const date = ruleDate(rule.value);
        if (isValidLibraryDate(date) && date) filters.addedAfter = date;
        else retainOpaque(rule);
        break;
      }
      case 2:
        // ASNs are integers. The open interval (n - 1, n + 1) is exactly
        // equivalent to Paperless' legacy equality rule for n.
        filters.archiveSerialMin = shiftIntegerRule(rule.value, -1);
        filters.archiveSerialMax = shiftIntegerRule(rule.value, 1);
        if (!filters.archiveSerialMin || !filters.archiveSerialMax) extraRules.push(rule);
        break;
      case 18:
        filters.archiveSerialMissing = true;
        break;
      case 23:
        if (rule.value && /^-?\d+$/.test(rule.value)) filters.archiveSerialMin = rule.value;
        else retainOpaque(rule);
        break;
      case 24:
        if (rule.value && /^-?\d+$/.test(rule.value)) filters.archiveSerialMax = rule.value;
        else retainOpaque(rule);
        break;
      case 47:
        if (rule.value) filters.mimeTypes = [rule.value];
        else retainOpaque(rule);
        break;
      case 19:
      case 20:
      case 48:
      case 49:
        if (queryRuleCount === 1) {
          if (rule.value) {
            query = rule.value;
            queryRuleType = rule.ruleType;
          } else retainOpaque(rule);
        } else retainOpaque(rule);
        break;
      default:
        retainOpaque(rule);
    }
  }

  const state = {
    filters,
    query,
    queryRuleType,
    extraRules,
    sortOrder: sortFromSavedView(view),
  };
  return {
    ...state,
    sourceRules: view.filterRules.map((rule) => ({ ...rule, extra: { ...(rule.extra ?? {}) } })),
    sourceRuleStateSignature: savedViewRuleStateSignature(state),
    savedViewExtra: { ...(view.extra ?? {}) },
    savedViewPresentation: {
      pageSize: view.pageSize,
      displayMode: view.displayMode,
      displayFields: [...view.displayFields],
    },
    savedViewSort: {
      sortField: view.sortField,
      sortReverse: view.sortReverse,
      projectedSortOrder: state.sortOrder,
    },
  };
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
