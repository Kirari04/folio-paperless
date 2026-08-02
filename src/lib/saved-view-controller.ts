import type {
  LibraryFilters,
  LibrarySortOrder,
  PaperlessCatalog,
  PaperlessOption,
  PaperlessSavedViewRule as LibrarySavedViewRule,
} from '@/types/document';
import type {
  PaperlessSavedViewEdit,
  PaperlessSavedViewRule,
} from '@/types/paperless-advanced';

export type LibrarySavedViewState = {
  query: string;
  filters: LibraryFilters;
  sortOrder: LibrarySortOrder;
  catalog: PaperlessCatalog;
  extraRules?: LibrarySavedViewRule[];
  queryRuleType?: PaperlessQueryRuleType;
  /** Exact remote rules used when the visible editor state is unchanged. */
  sourceRules?: LibrarySavedViewRule[];
  sourceRuleStateSignature?: string;
  /** Opaque saved-view fields retained for lossless save-as-new. */
  savedViewExtra?: Readonly<Record<string, unknown>>;
  savedViewPresentation?: {
    pageSize: number;
    displayMode?: string;
    displayFields: string[];
  };
  savedViewSort?: {
    sortField: string;
    sortReverse: boolean;
    projectedSortOrder: LibrarySortOrder;
  };
  viewMode?: 'list' | 'grid';
};

export type PaperlessQueryRuleType = 19 | 20 | 48 | 49;

export const PAPERLESS_SAVED_VIEW_RULE = {
  titleContains: 0,
  contentContains: 1,
  archiveSerialNumber: 2,
  correspondent: 3,
  documentType: 4,
  inbox: 5,
  tagsAll: 6,
  tagged: 7,
  createdBefore: 8,
  createdAfter: 9,
  createdYear: 10,
  createdMonth: 11,
  createdDay: 12,
  addedBefore: 13,
  addedAfter: 14,
  modifiedBefore: 15,
  modifiedAfter: 16,
  tagsNone: 17,
  archiveSerialMissing: 18,
  legacyText: 19,
  fullTextQuery: 20,
  moreLike: 21,
  tagsAny: 22,
  archiveSerialGreaterThan: 23,
  archiveSerialLessThan: 24,
  storagePath: 25,
  correspondentsAny: 26,
  correspondentsNone: 27,
  documentTypesAny: 28,
  documentTypesNone: 29,
  storagePathsAny: 30,
  storagePathsNone: 31,
  owner: 32,
  ownersAny: 33,
  ownerMissing: 34,
  ownersNone: 35,
  customFieldText: 36,
  sharedBy: 37,
  customFieldsAll: 38,
  customFieldsAny: 39,
  customFieldsNone: 40,
  hasCustomFields: 41,
  customFieldQuery: 42,
  createdTo: 43,
  createdFrom: 44,
  addedTo: 45,
  addedFrom: 46,
  mimeType: 47,
  simpleTitle: 48,
  simpleText: 49,
} as const;

export type PaperlessSavedViewRuleDefinition = {
  parameter: string;
  multi?: boolean;
  boolean?: boolean;
  nullParameter?: string;
};

/**
 * Canonical Paperless rule-number mapping. It mirrors Paperless-ngx's
 * SavedViewFilterRule model and src-ui filter-rule-type.ts.
 */
export const PAPERLESS_SAVED_VIEW_RULE_MAP: Readonly<Record<number, PaperlessSavedViewRuleDefinition>> = {
  0: { parameter: 'title__icontains' },
  1: { parameter: 'content__icontains' },
  2: { parameter: 'archive_serial_number' },
  3: { parameter: 'correspondent__id', nullParameter: 'correspondent__isnull' },
  4: { parameter: 'document_type__id', nullParameter: 'document_type__isnull' },
  5: { parameter: 'is_in_inbox', boolean: true },
  6: { parameter: 'tags__id__all', multi: true },
  7: { parameter: 'is_tagged', boolean: true },
  8: { parameter: 'created__date__lt' },
  9: { parameter: 'created__date__gt' },
  10: { parameter: 'created__year' },
  11: { parameter: 'created__month' },
  12: { parameter: 'created__day' },
  13: { parameter: 'added__date__lt' },
  14: { parameter: 'added__date__gt' },
  15: { parameter: 'modified__date__lt' },
  16: { parameter: 'modified__date__gt' },
  17: { parameter: 'tags__id__none', multi: true },
  18: { parameter: 'archive_serial_number__isnull', boolean: true },
  19: { parameter: 'text' },
  20: { parameter: 'query' },
  21: { parameter: 'more_like_id' },
  22: { parameter: 'tags__id__in', multi: true },
  23: { parameter: 'archive_serial_number__gt' },
  24: { parameter: 'archive_serial_number__lt' },
  25: { parameter: 'storage_path__id', nullParameter: 'storage_path__isnull' },
  26: { parameter: 'correspondent__id__in', multi: true },
  27: { parameter: 'correspondent__id__none', multi: true },
  28: { parameter: 'document_type__id__in', multi: true },
  29: { parameter: 'document_type__id__none', multi: true },
  30: { parameter: 'storage_path__id__in', multi: true },
  31: { parameter: 'storage_path__id__none', multi: true },
  32: { parameter: 'owner__id' },
  33: { parameter: 'owner__id__in', multi: true },
  34: { parameter: 'owner__isnull', boolean: true },
  35: { parameter: 'owner__id__none', multi: true },
  36: { parameter: 'custom_fields__icontains' },
  37: { parameter: 'shared_by__id', multi: true },
  38: { parameter: 'custom_fields__id__all', multi: true },
  39: { parameter: 'custom_fields__id__in', multi: true },
  40: { parameter: 'custom_fields__id__none', multi: true },
  41: { parameter: 'has_custom_fields', boolean: true },
  42: { parameter: 'custom_field_query' },
  43: { parameter: 'created__date__lte' },
  44: { parameter: 'created__date__gte' },
  45: { parameter: 'added__date__lte' },
  46: { parameter: 'added__date__gte' },
  47: { parameter: 'mime_type' },
  48: { parameter: 'title_search' },
  49: { parameter: 'text' },
};

const EDITABLE_RULE_TYPES = new Set([
  2, 3, 4, 6, 7, 8, 9, 13, 14, 15, 16, 17,
  19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  32, 33, 34, 35, 38, 39, 40, 43, 44, 45, 46, 47, 48, 49,
]);

export function isFolioEditableSavedViewRule(ruleType: number, value: string | null) {
  if (ruleType === PAPERLESS_SAVED_VIEW_RULE.inbox) return value === 'true' || value === '1';
  if (ruleType === PAPERLESS_SAVED_VIEW_RULE.archiveSerialMissing) {
    return value === 'true' || value === '1';
  }
  if (ruleType === PAPERLESS_SAVED_VIEW_RULE.tagged || ruleType === PAPERLESS_SAVED_VIEW_RULE.ownerMissing) {
    return value === 'true' || value === '1' || value === 'false' || value === '0';
  }
  return EDITABLE_RULE_TYPES.has(ruleType);
}

export function appendPaperlessSavedViewRules(
  params: URLSearchParams,
  rules: readonly Pick<LibrarySavedViewRule, 'ruleType' | 'value' | 'extra'>[],
) {
  for (const savedRule of rules) {
    if (Object.keys(savedRule.extra ?? {}).length > 0) {
      throw new Error(
        `Paperless rule ${savedRule.ruleType} contains unsupported fields; Folio refused to show broader results.`,
      );
    }
    const mapping = PAPERLESS_SAVED_VIEW_RULE_MAP[savedRule.ruleType];
    if (!mapping) {
      throw new Error(
        `This saved view uses unsupported Paperless rule ${savedRule.ruleType}; Folio refused to show broader results.`,
      );
    }
    if (mapping.nullParameter && savedRule.value === null) {
      params.set(mapping.nullParameter, '1');
      continue;
    }
    if (mapping.nullParameter && savedRule.value === '-1') {
      params.set(mapping.nullParameter, '0');
      continue;
    }
    if (savedRule.value === null) continue;
    const value = mapping.boolean
      ? savedRule.value === 'true' || savedRule.value === '1' ? '1' : '0'
      : savedRule.value;
    if (mapping.multi && params.has(mapping.parameter)) {
      params.set(mapping.parameter, `${params.get(mapping.parameter)},${value}`);
    } else {
      params.set(mapping.parameter, value);
    }
  }
}

function serializedRuleIdentity(rule: Pick<LibrarySavedViewRule, 'ruleType' | 'value' | 'extra'>) {
  return JSON.stringify({ ...rule.extra, rule_type: rule.ruleType, value: rule.value });
}

export function savedViewRuleStateSignature(state: Pick<
  LibrarySavedViewState,
  'query' | 'filters' | 'extraRules' | 'queryRuleType'
>) {
  return JSON.stringify({
    query: state.query,
    filters: state.filters,
    queryRuleType: state.queryRuleType ?? PAPERLESS_SAVED_VIEW_RULE.simpleText,
    extraRules: (state.extraRules ?? []).map(serializedRuleIdentity),
  });
}

export function paperlessSavedViewDisplayMode(viewMode: 'list' | 'grid') {
  return viewMode === 'grid' ? 'smallCards' : 'table';
}

export function folioSavedViewMode(displayMode: string | null | undefined): 'list' | 'grid' {
  return displayMode === 'smallCards' || displayMode === 'largeCards' ? 'grid' : 'list';
}

function rule(ruleType: number, value: string | null): PaperlessSavedViewRule {
  return { ruleType, value, known: true, extra: {} };
}

function shiftDate(value: string, days: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return value;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function selectedRemoteIds(ids: string[], options: { id: string; remoteId?: number }[], _label: string) {
  const selected = new Set(ids);
  const matching = options.filter((option) => selected.has(option.id));
  if (matching.length !== selected.size || matching.some((option) => option.remoteId === undefined)) {
    throw new Error('A selected saved-view filter item is no longer available on Paperless.');
  }
  return matching.map((option) => option.remoteId!).join(',');
}

function appendResourceRules(
  output: PaperlessSavedViewRule[],
  input: {
    ids: string[];
    options: PaperlessOption[];
    mode: 'include' | 'exclude';
    missing: boolean;
    includeRule: number;
    excludeRule: number;
    nullRule: number;
    label: string;
  },
) {
  if (input.missing) {
    output.push(rule(input.nullRule, input.mode === 'include' ? null : '-1'));
    return;
  }
  if (input.ids.length) {
    output.push(rule(
      input.mode === 'include' ? input.includeRule : input.excludeRule,
      selectedRemoteIds(input.ids, input.options, input.label),
    ));
  }
}

function savedViewSort(sortOrder: LibrarySortOrder) {
  switch (sortOrder) {
    case 'added-asc': return { sortField: 'added', sortReverse: false };
    case 'created-desc': return { sortField: 'created', sortReverse: true };
    case 'created-asc': return { sortField: 'created', sortReverse: false };
    case 'title-asc': return { sortField: 'title', sortReverse: false };
    case 'title-desc': return { sortField: 'title', sortReverse: true };
    case 'correspondent-asc': return { sortField: 'correspondent__name', sortReverse: false };
    case 'document-type-asc': return { sortField: 'document_type__name', sortReverse: false };
    case 'added-desc':
    default: return { sortField: 'added', sortReverse: true };
  }
}

function serializedSavedViewSort(state: Pick<LibrarySavedViewState, 'sortOrder' | 'savedViewSort'>) {
  if (state.savedViewSort?.projectedSortOrder === state.sortOrder) {
    return {
      sortField: state.savedViewSort.sortField,
      sortReverse: state.savedViewSort.sortReverse,
    };
  }
  return savedViewSort(state.sortOrder);
}

export function serializeLibrarySavedViewState(
  state: LibrarySavedViewState,
): Pick<PaperlessSavedViewEdit, 'filterRules' | 'sortField' | 'sortReverse'> {
  if (
    state.sourceRules
    && state.sourceRuleStateSignature
    && savedViewRuleStateSignature(state) === state.sourceRuleStateSignature
  ) {
    return {
      ...serializedSavedViewSort(state),
      filterRules: state.sourceRules.map((source) => ({
        ruleType: source.ruleType,
        value: source.value,
        known: source.known !== false && isFolioEditableSavedViewRule(source.ruleType, source.value),
        extra: { ...(source.extra ?? {}) },
      })),
    };
  }
  const { filters, catalog } = state;
  const rules: PaperlessSavedViewRule[] = [];
  if (filters.status === 'inbox') rules.push(rule(5, 'true'));
  if (filters.status === 'tagged') rules.push(rule(7, 'true'));
  if (filters.status === 'untagged') rules.push(rule(7, 'false'));

  if (filters.tagIds.length) {
    const ruleTypes = { all: 6, none: 17, any: 22 } as const;
    rules.push(rule(
      ruleTypes[filters.tagMode],
      selectedRemoteIds(filters.tagIds, catalog.tags, 'Tags'),
    ));
  }
  appendResourceRules(rules, {
    ids: filters.correspondentIds,
    options: catalog.correspondents,
    mode: filters.correspondentMode,
    missing: filters.correspondentMissing,
    includeRule: 26,
    excludeRule: 27,
    nullRule: 3,
    label: 'Correspondents',
  });
  appendResourceRules(rules, {
    ids: filters.documentTypeIds,
    options: catalog.documentTypes,
    mode: filters.documentTypeMode,
    missing: filters.documentTypeMissing,
    includeRule: 28,
    excludeRule: 29,
    nullRule: 4,
    label: 'Document types',
  });
  appendResourceRules(rules, {
    ids: filters.storagePathIds,
    options: catalog.storagePaths,
    mode: filters.storagePathMode,
    missing: filters.storagePathMissing,
    includeRule: 30,
    excludeRule: 31,
    nullRule: 25,
    label: 'Storage paths',
  });
  if (filters.ownerMissing) {
    rules.push(rule(34, filters.ownerMode === 'include' ? 'true' : 'false'));
  } else if (filters.ownerIds.length) {
    rules.push(rule(
      filters.ownerMode === 'include' ? 33 : 35,
      selectedRemoteIds(filters.ownerIds, catalog.owners, 'Owners'),
    ));
  }

  if (filters.customFieldIds.length) {
    const customFields = catalog.customFields.map((field) => ({ id: field.id, remoteId: field.remoteId }));
    const ruleTypes = { all: 38, any: 39, none: 40 } as const;
    rules.push(rule(
      ruleTypes[filters.customFieldMode],
      selectedRemoteIds(filters.customFieldIds, customFields, 'Custom fields'),
    ));
  }
  if (filters.mimeTypes.length > 1) {
    throw new Error('Paperless saved views can store one MIME type filter at a time.');
  }
  if (filters.mimeTypes[0]) rules.push(rule(47, filters.mimeTypes[0]));
  if (filters.createdBefore) rules.push(rule(43, filters.createdBefore));
  if (filters.createdAfter) rules.push(rule(44, filters.createdAfter));
  if (filters.addedBefore) rules.push(rule(45, filters.addedBefore));
  if (filters.addedAfter) rules.push(rule(46, filters.addedAfter));
  // Paperless's modified rules are strict; Folio's date range UI is inclusive.
  if (filters.modifiedBefore) rules.push(rule(15, shiftDate(filters.modifiedBefore, 1)));
  if (filters.modifiedAfter) rules.push(rule(16, shiftDate(filters.modifiedAfter, -1)));
  if (filters.archiveSerialMissing) rules.push(rule(18, 'true'));
  else {
    if (filters.archiveSerialMin) rules.push(rule(23, filters.archiveSerialMin));
    if (filters.archiveSerialMax) rules.push(rule(24, filters.archiveSerialMax));
  }
  if (state.query.trim()) {
    rules.push(rule(state.queryRuleType ?? PAPERLESS_SAVED_VIEW_RULE.simpleText, state.query.trim()));
  }
  const identities = new Set(rules.map(serializedRuleIdentity));
  for (const extra of state.extraRules ?? []) {
    const retained = {
      ruleType: extra.ruleType,
      value: extra.value,
      known: extra.known !== false && isFolioEditableSavedViewRule(extra.ruleType, extra.value),
      extra: { ...(extra.extra ?? {}) },
    };
    const identity = serializedRuleIdentity(retained);
    if (!identities.has(identity)) {
      rules.push(retained);
      identities.add(identity);
    }
  }
  return { ...serializedSavedViewSort(state), filterRules: rules };
}

export function buildSavedViewEdit(
  name: string,
  state: LibrarySavedViewState,
): PaperlessSavedViewEdit & { name: string } {
  const normalized = name.trim();
  if (!normalized) throw new Error('Enter a saved-view name.');
  const viewMode = state.viewMode ?? 'list';
  const sourcePresentation = state.savedViewPresentation;
  const preserveSourceMode = sourcePresentation?.displayMode
    && folioSavedViewMode(sourcePresentation.displayMode) === viewMode;
  return {
    name: normalized,
    ...serializeLibrarySavedViewState(state),
    pageSize: sourcePresentation?.pageSize ?? 50,
    displayMode: preserveSourceMode
      ? sourcePresentation.displayMode
      : paperlessSavedViewDisplayMode(viewMode),
    displayFields: sourcePresentation?.displayFields ?? ['title', 'created', 'tag'],
    ...(state.savedViewExtra ? { extra: { ...state.savedViewExtra } } : {}),
  };
}

export function hasUnsupportedSavedViewRules(rules: PaperlessSavedViewRule[]) {
  return rules.some((item) => (
    item.known === false
    || !isFolioEditableSavedViewRule(item.ruleType, item.value)
    || Object.keys(item.extra ?? {}).length > 0
  ));
}

export function reconcileLibraryFiltersWithCatalog(
  filters: LibraryFilters,
  catalog: PaperlessCatalog,
): LibraryFilters {
  const retained = (ids: string[], options: { id: string }[]) => {
    const available = new Set(options.map((option) => option.id));
    return ids.filter((id) => available.has(id));
  };
  return {
    ...filters,
    correspondentIds: retained(filters.correspondentIds, catalog.correspondents),
    documentTypeIds: retained(filters.documentTypeIds, catalog.documentTypes),
    tagIds: retained(filters.tagIds, catalog.tags),
    storagePathIds: retained(filters.storagePathIds, catalog.storagePaths),
    ownerIds: retained(filters.ownerIds, catalog.owners),
    customFieldIds: retained(filters.customFieldIds, catalog.customFields),
  };
}
