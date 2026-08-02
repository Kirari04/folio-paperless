import type {
  PaperlessAiSuggestions,
  PaperlessDocumentRepresentations,
  PaperlessPdfPageOperation,
  PaperlessPermissionSet,
  PaperlessRepresentation,
  PaperlessRepresentationInfo,
  PaperlessShareLink,
} from '../types/paperless-advanced.ts';
import type {
  PaperlessCatalog,
  PaperlessCustomFieldDefinition,
  PaperlessOption,
} from '../types/document.ts';
import { normalizePermissionSet } from './paperless-advanced.ts';

export type RepresentationChoice = {
  selected: PaperlessRepresentation;
  info: PaperlessRepresentationInfo;
  alternatives: PaperlessRepresentation[];
};

export const REPRESENTATION_PREFERENCE_KEY = 'folio.document-representation-preference.v1';

export type RepresentationPreferenceStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
};

export type DocumentSecuritySnapshot = {
  ownerId: number | null;
  permissions: PaperlessPermissionSet;
  canChange: boolean | null;
};

export type AiSuggestionField =
  | 'title'
  | 'correspondent'
  | 'tags'
  | 'documentType'
  | 'storagePath'
  | 'date';

export type AiSuggestionDecision = 'pending' | 'accepted' | 'dismissed';
export type AiSuggestionDecisions = Record<AiSuggestionField, AiSuggestionDecision>;
export type AiCustomFieldSuggestionDecisions = Record<string, AiSuggestionDecision>;

export type CatalogScopedAiSuggestions = {
  value: PaperlessAiSuggestions;
  labels: Partial<Record<AiSuggestionField, string>>;
  acceptableFields: AiSuggestionField[];
  acceptableCustomFieldIds: string[];
  warnings: string[];
};

export type PdfEditorRotation = 0 | 90 | 180 | 270;

export type PdfEditorPage = {
  /** Stable identity from the source PDF. */
  sourcePage: number;
  rotation: PdfEditorRotation;
  /** Starts a new output document after this page when true. */
  splitAfter: boolean;
};

const SAFE_FILENAME_CHARACTERS = /[\/:*?"<>|\u0000-\u001f\u007f]/g;
const OPAQUE_SLUG = /^[A-Za-z0-9_-]{1,256}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRepresentationPreference(value: unknown): PaperlessRepresentation | null {
  return value === 'archive' || value === 'original' ? value : null;
}

export async function loadRepresentationPreference(
  store: RepresentationPreferenceStore,
): Promise<PaperlessRepresentation | null> {
  try {
    const raw = await store.getItem(REPRESENTATION_PREFERENCE_KEY);
    const preference = parseRepresentationPreference(raw);
    if (raw !== null && preference === null) await store.deleteItem(REPRESENTATION_PREFERENCE_KEY);
    return preference;
  } catch {
    return null;
  }
}

export async function saveRepresentationPreference(
  store: RepresentationPreferenceStore,
  value: unknown,
): Promise<void> {
  const preference = parseRepresentationPreference(value);
  if (!preference) throw new Error('Representation preference must be archive or original.');
  await store.setItem(REPRESENTATION_PREFERENCE_KEY, preference);
}

export function chooseRepresentation(
  representations: PaperlessDocumentRepresentations,
  requested?: PaperlessRepresentation,
): RepresentationChoice | null {
  const available = (['archive', 'original'] as const).filter(
    (representation) => representations[representation].available,
  );
  if (!available.length) return null;
  const selected = requested && available.includes(requested) ? requested : available[0];
  return { selected, info: representations[selected], alternatives: available };
}

export function selectRepresentation(
  representations: PaperlessDocumentRepresentations,
  representation: PaperlessRepresentation,
): RepresentationChoice {
  const choice = chooseRepresentation(representations, representation);
  if (!choice || choice.selected !== representation) {
    throw new Error(`${representation === 'archive' ? 'Archive' : 'Original'} is unavailable. No other representation was substituted.`);
  }
  return choice;
}

export function safeRepresentationFilename(
  documentId: number,
  title: string,
  info: PaperlessRepresentationInfo,
) {
  const serverName = info.filename?.trim();
  const candidate = serverName || `${title || `document-${documentId}`}${info.representation === 'archive' ? '.pdf' : ''}`;
  const safe = candidate
    .replace(SAFE_FILENAME_CHARACTERS, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180);
  return safe || `document-${documentId}-${info.representation}${info.representation === 'archive' ? '.pdf' : ''}`;
}

export function representationLabel(info: PaperlessRepresentationInfo) {
  return info.representation === 'archive' ? 'Archive / searchable PDF' : 'Original upload';
}

export function representationSupportsNativePrint(
  info: Pick<PaperlessRepresentationInfo, 'filename' | 'mimeType'>,
  platform: string,
) {
  if (platform !== 'ios' && platform !== 'android') return false;
  const mimeType = info.mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? null;
  if (mimeType) return mimeType === 'application/pdf';
  return info.filename?.trim().toLowerCase().endsWith('.pdf') === true;
}

export function formatRepresentationBytes(size: number | null) {
  if (size === null || !Number.isFinite(size) || size < 0) return 'Size unavailable';
  if (size < 1_000) return `${size} B`;
  if (size < 1_000_000) return `${(size / 1_000).toFixed(1)} KB`;
  if (size < 1_000_000_000) return `${(size / 1_000_000).toFixed(1)} MB`;
  return `${(size / 1_000_000_000).toFixed(1)} GB`;
}

export function buildPublicShareUrl(serverUrl: string, link: Pick<PaperlessShareLink, 'slug'>) {
  if (!OPAQUE_SLUG.test(link.slug)) throw new Error('Paperless returned an unsafe public-link slug.');
  const base = new URL(serverUrl);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new Error('Public links require an HTTP or HTTPS Paperless server URL.');
  }
  base.username = '';
  base.password = '';
  base.search = '';
  base.hash = '';
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/share/${encodeURIComponent(link.slug)}`;
  return base.toString();
}

export function parseDocumentSecurity(value: unknown): DocumentSecuritySnapshot {
  if (!isRecord(value) || !isRecord(value.permissions)) {
    throw new Error('Paperless did not return full object permissions.');
  }
  return {
    ownerId: typeof value.owner === 'number' && Number.isSafeInteger(value.owner) && value.owner > 0
      ? value.owner
      : null,
    permissions: normalizePermissionSet(value.permissions),
    canChange: typeof value.user_can_change === 'boolean' ? value.user_can_change : null,
  };
}

export function emptyAiSuggestionDecisions(): AiSuggestionDecisions {
  return {
    title: 'pending',
    correspondent: 'pending',
    tags: 'pending',
    documentType: 'pending',
    storagePath: 'pending',
    date: 'pending',
  };
}

export function emptyAiCustomFieldSuggestionDecisions(
  suggestions: Pick<PaperlessAiSuggestions, 'customFields'>,
): AiCustomFieldSuggestionDecisions {
  return Object.fromEntries(
    Object.keys(suggestions.customFields).map((fieldId) => [fieldId, 'pending' as const]),
  );
}

function visibleSuggestedIds(ids: number[], options: PaperlessOption[]) {
  const byRemoteId = new Map(options.flatMap((option) => option.remoteId ? [[option.remoteId, option] as const] : []));
  const visible = ids.flatMap((id) => byRemoteId.has(id) ? [id] : []);
  const names = visible.map((id) => byRemoteId.get(id)!.name);
  const rejected = ids.filter((id) => !byRemoteId.has(id));
  return { visible, names, rejected };
}

function validIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function customFieldSuggestionIsValid(
  definition: PaperlessCustomFieldDefinition,
  value: unknown,
  currentDocumentId?: number,
) {
  if (value === null) return true;
  switch (definition.dataType) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'float':
      return typeof value === 'number' && Number.isFinite(value);
    case 'date':
      return typeof value === 'string' && validIsoDate(value);
    case 'monetary':
      return typeof value === 'string' && /^[A-Z]{3}-?(?:0|[1-9]\d*)\.\d{2}$/.test(value);
    case 'select':
      return typeof value === 'string'
        && definition.selectOptions.some((option) => option.id === value);
    case 'documentlink':
      return Array.isArray(value)
        && value.every((id) => Number.isSafeInteger(id) && Number(id) > 0)
        && new Set(value).size === value.length
        && (currentDocumentId === undefined || !value.includes(currentDocumentId));
    case 'url':
      if (typeof value !== 'string') return false;
      try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    case 'string':
    case 'longtext':
      return typeof value === 'string';
    default:
      return false;
  }
}

export function scopeAiSuggestionsToVisibleCatalog(
  suggestions: PaperlessAiSuggestions,
  catalog: PaperlessCatalog,
  canEdit: boolean,
  currentDocumentId?: number,
): CatalogScopedAiSuggestions {
  const correspondent = visibleSuggestedIds(suggestions.correspondentIds, catalog.correspondents);
  const tags = visibleSuggestedIds(suggestions.tagIds, catalog.tags);
  const documentType = visibleSuggestedIds(suggestions.documentTypeIds, catalog.documentTypes);
  const storagePath = visibleSuggestedIds(suggestions.storagePathIds, catalog.storagePaths);
  const customFieldsById = new Map(catalog.customFields.flatMap((field) => (
    field.remoteId ? [[String(field.remoteId), field] as const] : []
  )));
  const customFields: Record<string, unknown> = {};
  const rejectedCustomFields: string[] = [];
  const invalidCustomFields: string[] = [];
  for (const [id, value] of Object.entries(suggestions.customFields)) {
    const definition = customFieldsById.get(id);
    if (!definition) rejectedCustomFields.push(id);
    else if (!customFieldSuggestionIsValid(definition, value, currentDocumentId)) {
      invalidCustomFields.push(id);
    } else {
      customFields[id] = value;
    }
  }
  const warnings: string[] = [];
  const reportRejected = (label: string, ids: readonly (number | string)[]) => {
    if (ids.length) warnings.push(`${label} suggestion${ids.length === 1 ? '' : 's'} ${ids.join(', ')} are not visible to this account and cannot be accepted.`);
  };
  reportRejected('Correspondent', correspondent.rejected);
  reportRejected('Tag', tags.rejected);
  reportRejected('Document type', documentType.rejected);
  reportRejected('Storage path', storagePath.rejected);
  reportRejected('Custom field', rejectedCustomFields);
  if (invalidCustomFields.length) {
    warnings.push(`Custom field suggestion${invalidCustomFields.length === 1 ? '' : 's'} ${invalidCustomFields.join(', ')} did not match the visible field type and cannot be accepted.`);
  }
  if (!canEdit) warnings.unshift('This account does not have confirmed edit permission for this document. Suggestions are read-only.');
  if (correspondent.visible.length > 1) {
    warnings.push('Paperless returned multiple visible correspondents; accepting uses the first listed correspondent.');
  }
  const value: PaperlessAiSuggestions = {
    ...suggestions,
    correspondentIds: correspondent.visible,
    tagIds: tags.visible,
    documentTypeIds: documentType.visible,
    storagePathIds: storagePath.visible,
    customFields: Object.freeze(customFields),
  };
  const labels: Partial<Record<AiSuggestionField, string>> = {
    ...(correspondent.names.length ? { correspondent: correspondent.names.join(', ') } : {}),
    ...(tags.names.length ? { tags: tags.names.join(', ') } : {}),
    ...(documentType.names.length ? { documentType: documentType.names.join(', ') } : {}),
    ...(storagePath.names.length ? { storagePath: storagePath.names.join(', ') } : {}),
  };
  const acceptableFields: AiSuggestionField[] = canEdit ? [
    ...(value.title ? ['title' as const] : []),
    ...(value.correspondentIds.length ? ['correspondent' as const] : []),
    ...(value.tagIds.length ? ['tags' as const] : []),
    ...(value.documentTypeIds.length ? ['documentType' as const] : []),
    ...(value.storagePathIds.length ? ['storagePath' as const] : []),
    ...(value.dates.length ? ['date' as const] : []),
  ] : [];
  const acceptableCustomFieldIds = canEdit ? Object.keys(value.customFields) : [];
  return { value, labels, acceptableFields, acceptableCustomFieldIds, warnings };
}

export function buildAcceptedAiPatch(
  suggestions: PaperlessAiSuggestions,
  decisions: AiSuggestionDecisions,
  editedTitle?: string,
  customFieldDecisions: AiCustomFieldSuggestionDecisions = {},
) {
  const patch: Record<string, unknown> = {};
  if (decisions.title === 'accepted') {
    const title = (editedTitle ?? suggestions.title ?? '').trim();
    if (!title || title.length > 128 || /[\u0000-\u001f\u007f]/.test(title)) {
      throw new Error('Accepted title suggestions must contain 1–128 safe characters.');
    }
    patch.title = title;
  }
  if (decisions.correspondent === 'accepted' && suggestions.correspondentIds.length) {
    patch.correspondent = suggestions.correspondentIds[0];
  }
  if (decisions.tags === 'accepted' && suggestions.tagIds.length) patch.tags = suggestions.tagIds;
  if (decisions.documentType === 'accepted' && suggestions.documentTypeIds.length) {
    patch.document_type = suggestions.documentTypeIds[0];
  }
  if (decisions.storagePath === 'accepted' && suggestions.storagePathIds.length) {
    patch.storage_path = suggestions.storagePathIds[0];
  }
  if (decisions.date === 'accepted' && suggestions.dates.length) patch.created = suggestions.dates[0];
  const acceptedCustomFields = Object.entries(suggestions.customFields)
    .filter(([field]) => customFieldDecisions[field] === 'accepted');
  if (acceptedCustomFields.length) {
    patch.custom_fields = acceptedCustomFields.map(([field, value]) => ({
      field: Number(field),
      value,
    }));
  }
  if (!Object.keys(patch).length) throw new Error('Accept at least one validated suggestion before saving.');
  return patch;
}

function parsePageList(value: string, pageCount: number) {
  const pages = value.split(',').map((part) => Number(part.trim()));
  if (!pages.length || pages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > pageCount)) {
    throw new Error(`Enter comma-separated page numbers between 1 and ${pageCount}.`);
  }
  if (new Set(pages).size !== pages.length) throw new Error('Each page may appear only once.');
  return pages;
}

function assertPdfEditorPages(pages: readonly PdfEditorPage[]) {
  if (!pages.length) throw new Error('At least one page must remain.');
  const sourcePages = pages.map((page) => page.sourcePage);
  if (sourcePages.some((page) => !Number.isSafeInteger(page) || page < 1)) {
    throw new Error('The PDF page plan contains an invalid source page.');
  }
  if (new Set(sourcePages).size !== sourcePages.length) {
    throw new Error('The PDF page plan contains a duplicate source page.');
  }
}

export function createPdfEditorPages(pageCount: number): PdfEditorPage[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 10_000) {
    throw new Error('The PDF page count is outside the supported range.');
  }
  return Array.from({ length: pageCount }, (_, index) => ({
    sourcePage: index + 1,
    rotation: 0,
    splitAfter: false,
  }));
}

export function movePdfEditorSelection(
  pages: readonly PdfEditorPage[],
  selectedSourcePages: ReadonlySet<number>,
  direction: -1 | 1,
): PdfEditorPage[] {
  assertPdfEditorPages(pages);
  const next = [...pages];
  if (direction === -1) {
    for (let index = 1; index < next.length; index += 1) {
      if (selectedSourcePages.has(next[index].sourcePage)
        && !selectedSourcePages.has(next[index - 1].sourcePage)) {
        [next[index - 1], next[index]] = [next[index], next[index - 1]];
      }
    }
  } else {
    for (let index = next.length - 2; index >= 0; index -= 1) {
      if (selectedSourcePages.has(next[index].sourcePage)
        && !selectedSourcePages.has(next[index + 1].sourcePage)) {
        [next[index], next[index + 1]] = [next[index + 1], next[index]];
      }
    }
  }
  return next;
}

export function rotatePdfEditorSelection(
  pages: readonly PdfEditorPage[],
  selectedSourcePages: ReadonlySet<number>,
  degrees: -90 | 90,
): PdfEditorPage[] {
  assertPdfEditorPages(pages);
  return pages.map((page) => selectedSourcePages.has(page.sourcePage)
    ? {
        ...page,
        rotation: ((page.rotation + degrees + 360) % 360) as PdfEditorRotation,
      }
    : page);
}

export function deletePdfEditorSelection(
  pages: readonly PdfEditorPage[],
  selectedSourcePages: ReadonlySet<number>,
): PdfEditorPage[] {
  assertPdfEditorPages(pages);
  const next = pages.filter((page) => !selectedSourcePages.has(page.sourcePage));
  if (!next.length) throw new Error('At least one page must remain.');
  return next.map((page, index) => ({
    ...page,
    splitAfter: index < next.length - 1 && page.splitAfter,
  }));
}

export function togglePdfEditorSplits(
  pages: readonly PdfEditorPage[],
  selectedSourcePages: ReadonlySet<number>,
): PdfEditorPage[] {
  assertPdfEditorPages(pages);
  return pages.map((page, index) => ({
    ...page,
    splitAfter: index < pages.length - 1 && selectedSourcePages.has(page.sourcePage)
      ? !page.splitAfter
      : index < pages.length - 1 && page.splitAfter,
  }));
}

export function pdfEditorOutputDocument(pages: readonly PdfEditorPage[], index: number) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= pages.length) {
    throw new Error('The PDF page position is invalid.');
  }
  let outputDocument = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (pages[cursor].splitAfter) outputDocument += 1;
  }
  return outputDocument;
}

export function compilePdfEditorOperations(pages: readonly PdfEditorPage[]) {
  assertPdfEditorPages(pages);
  const hasSplits = pages.some((page, index) => index < pages.length - 1 && page.splitAfter);
  const operations: PaperlessPdfPageOperation[] = pages.map((page, index) => ({
    page: page.sourcePage,
    ...(page.rotation ? { rotate: page.rotation } : {}),
    ...(hasSplits ? { outputDocument: pdfEditorOutputDocument(pages, index) } : {}),
  }));
  return { operations, hasSplits };
}

export function pdfEditorPlanChanged(pages: readonly PdfEditorPage[], sourcePageCount: number) {
  assertPdfEditorPages(pages);
  return pages.length !== sourcePageCount || pages.some((page, index) => (
    page.sourcePage !== index + 1 || page.rotation !== 0 || page.splitAfter
  ));
}

export function planReorderPages(value: string, pageCount: number): PaperlessPdfPageOperation[] {
  const pages = parsePageList(value, pageCount);
  if (pages.length !== pageCount) throw new Error('Reordering must include every page exactly once.');
  return pages.map((page) => ({ page }));
}

export function planDeletePages(value: string, pageCount: number): PaperlessPdfPageOperation[] {
  const deleted = new Set(parsePageList(value, pageCount));
  if (deleted.size >= pageCount) throw new Error('At least one page must remain.');
  return Array.from({ length: pageCount }, (_, index) => index + 1)
    .filter((page) => !deleted.has(page))
    .map((page) => ({ page }));
}

export function planSplitPages(value: string, pageCount: number): PaperlessPdfPageOperation[] {
  const groups = value.split('|').map((group) => parsePageList(group, pageCount));
  if (groups.length < 2) throw new Error('Split pages into at least two groups separated by |.');
  const flattened = groups.flat();
  if (flattened.length !== pageCount || new Set(flattened).size !== pageCount) {
    throw new Error('Split groups must assign every page exactly once.');
  }
  return groups.flatMap((pages, outputDocument) =>
    pages.map((page) => ({ page, outputDocument })),
  );
}
