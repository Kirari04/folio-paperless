import { isValidIsoDate } from './validation.ts';
import { translateRuntime } from '../i18n/runtime.ts';
import type { PaperlessCatalog, PaperlessOption } from '../types/document.ts';
import type {
  ExplicitValue,
  IntakeSource,
  PersistentTask,
  UploadCustomFieldDraft,
  UploadMetadataDraft,
  UploadPreset,
} from '../types/tasks.ts';
import {
  UPLOAD_PRESET_SCHEMA_VERSION,
  defaultUploadMetadataDraft,
} from '../types/tasks.ts';

export type MultipartParameter = readonly [name: string, value: string];

export type UploadMetadataValidationIssue = {
  field: string;
  message: string;
};

export class UploadMetadataRepairError extends Error {
  readonly code = 'invalid-metadata' as const;
  readonly issues: readonly UploadMetadataValidationIssue[];

  constructor(issues: readonly UploadMetadataValidationIssue[]) {
    super(issues.map((issue) => issue.message).join(' '));
    this.name = 'UploadMetadataRepairError';
    this.issues = issues;
  }
}

export function assertUploadMetadataReferencesCurrent(
  draft: UploadMetadataDraft | undefined,
  catalog: PaperlessCatalog,
) {
  if (!draft) return;
  const issues = validateUploadMetadata(draft, { catalog });
  if (issues.length) throw new UploadMetadataRepairError(issues);
}

export type UploadMetadataValidationOptions = {
  catalog?: PaperlessCatalog;
  currentDocumentId?: number;
  workflowOverrideSupported?: boolean;
};

export const UPLOAD_METADATA_FIELD_KEYS = [
  'title',
  'created',
  'correspondent',
  'documentType',
  'tags',
  'storagePath',
  'archiveSerialNumber',
  'owner',
  'workflow',
  'customFields',
] as const satisfies readonly (keyof UploadMetadataDraft)[];

export function uploadMetadataFieldProvenance(
  current: UploadMetadataDraft,
  inherited: UploadMetadataDraft,
) {
  return UPLOAD_METADATA_FIELD_KEYS.reduce<{
    inherited: (keyof UploadMetadataDraft)[];
    overridden: (keyof UploadMetadataDraft)[];
  }>((result, field) => {
    const target = JSON.stringify(current[field]) === JSON.stringify(inherited[field])
      ? result.inherited
      : result.overridden;
    target.push(field);
    return result;
  }, { inherited: [], overridden: [] });
}

function isPositiveRemoteId(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0;
}

function remoteId(option: PaperlessOption, field: string) {
  if (!isPositiveRemoteId(option.remoteId)) {
    throw new Error(translateRuntime('uploadValidation.remoteUnavailable', { field }));
  }
  return option.remoteId!;
}

function appendOption(
  output: MultipartParameter[],
  key: string,
  field: ExplicitValue<PaperlessOption>,
) {
  if (field.state === 'value') output.push([key, String(remoteId(field.value, key))]);
}

export function serializeUploadMetadata(draft: UploadMetadataDraft): MultipartParameter[] {
  const issues = validateUploadMetadata(draft);
  if (issues.length) throw new Error(issues.map((issue) => issue.message).join(' '));

  const output: MultipartParameter[] = [];
  if (draft.title.state === 'value') output.push(['title', draft.title.value]);
  if (draft.created.state === 'value') output.push(['created', draft.created.value]);
  appendOption(output, 'correspondent', draft.correspondent);
  appendOption(output, 'document_type', draft.documentType);
  appendOption(output, 'storage_path', draft.storagePath);
  // Paperless 3.0.5's upload serializer accepts neither owner nor workflow.
  // Owner is applied and verified after processing yields a document ID;
  // workflow remains unavailable until a negotiated schema names an override.

  if (draft.tags.state === 'value') {
    for (const tag of draft.tags.value) output.push(['tags', String(remoteId(tag, 'tag'))]);
  }
  if (draft.archiveSerialNumber.state === 'value') {
    output.push(['archive_serial_number', String(draft.archiveSerialNumber.value)]);
  }

  const customFields = draft.customFields
    .filter((field) => field.value.state !== 'unset')
    .reduce<Record<string, unknown>>((values, field) => {
      if (!Number.isInteger(field.fieldRemoteId) || (field.fieldRemoteId ?? 0) <= 0) {
        throw new Error(translateRuntime('uploadValidation.customUnavailable', { id: field.fieldId }));
      }
      if (field.value.state === 'clear') values[String(field.fieldRemoteId)] = null;
      else if (field.value.state === 'value') values[String(field.fieldRemoteId)] = field.value.value;
      return values;
    }, {});
  if (Object.keys(customFields).length) {
    output.push(['custom_fields', JSON.stringify(customFields)]);
  }
  return output;
}

/** Keeps an invalid document-link draft verbatim so the editor can surface a
 * validation error instead of silently discarding malformed list members. */
export function parseDocumentLinkInput(value: string): string | number[] {
  const parts = value.split(',').map((part) => part.trim());
  if (
    parts.length > 0
    && parts.every((part) => /^[1-9]\d*$/.test(part))
  ) {
    const ids = parts.map(Number);
    if (ids.every((id) => Number.isSafeInteger(id))) return ids;
  }
  return value;
}

function validateCustomField(
  field: UploadCustomFieldDraft,
  options: UploadMetadataValidationOptions,
): UploadMetadataValidationIssue[] {
  if (field.value.state === 'unset') return [];
  const issue = (message: string): UploadMetadataValidationIssue[] => [{
    field: `customFields.${field.fieldId}`,
    message,
  }];
  if (!isPositiveRemoteId(field.fieldRemoteId)) {
    return issue(translateRuntime('uploadValidation.customStale', { id: field.fieldId }));
  }
  const currentDefinition = options.catalog?.customFields.find(
    (candidate) => candidate.remoteId === field.fieldRemoteId,
  );
  if (options.catalog && !currentDefinition) {
    return issue(translateRuntime('uploadValidation.customStale', { id: field.fieldId }));
  }
  if (currentDefinition && field.dataType && currentDefinition.dataType !== field.dataType) {
    return issue(translateRuntime('uploadValidation.customTypeChanged', { id: field.fieldId }));
  }
  if (field.value.state === 'clear' || field.value.value === null || !field.dataType) return [];
  const value = field.value.value;
  switch (field.dataType) {
    case 'boolean':
      if (typeof value !== 'boolean') return issue(translateRuntime('uploadValidation.boolean'));
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return issue(translateRuntime('uploadValidation.integer'));
      }
      break;
    case 'float':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return issue(translateRuntime('uploadValidation.number'));
      }
      break;
    case 'date':
      if (typeof value !== 'string' || !isValidIsoDate(value)) {
        return issue(translateRuntime('uploadValidation.date'));
      }
      break;
    case 'monetary':
      if (typeof value !== 'string' || !/^[A-Z]{3}-?(?:0|[1-9]\d*)\.\d{2}$/.test(value)) {
        return issue(translateRuntime('uploadValidation.monetary'));
      }
      break;
    case 'select':
      const selectOptionIds = currentDefinition?.selectOptions.map((option) => option.id)
        ?? field.selectOptionIds;
      if (
        typeof value !== 'string'
        || (selectOptionIds && !selectOptionIds.includes(value))
      ) {
        return issue(translateRuntime('uploadValidation.select'));
      }
      break;
    case 'documentlink':
      if (
        !Array.isArray(value)
        || value.some((id) => !Number.isSafeInteger(id) || id <= 0)
        || new Set(value).size !== value.length
        || (options.currentDocumentId !== undefined && value.includes(options.currentDocumentId))
      ) {
        return issue(translateRuntime('uploadValidation.documentLink'));
      }
      break;
    case 'url':
      try {
        if (typeof value !== 'string' || !['http:', 'https:'].includes(new URL(value).protocol)) {
          return issue(translateRuntime('uploadValidation.urlScheme'));
        }
      } catch {
        return issue(translateRuntime('uploadValidation.url'));
      }
      break;
    case 'string':
    case 'longtext':
      if (typeof value !== 'string') return issue(translateRuntime('uploadValidation.text'));
      break;
  }
  return [];
}

export function validateUploadMetadata(
  draft: UploadMetadataDraft,
  options: UploadMetadataValidationOptions = {},
) {
  const issues: UploadMetadataValidationIssue[] = [];
  if (draft.title.state === 'value' && !draft.title.value.trim()) {
    issues.push({ field: 'title', message: translateRuntime('uploadValidation.titleWhitespace') });
  }
  if (draft.created.state === 'value' && !isValidIsoDate(draft.created.value)) {
    issues.push({ field: 'created', message: translateRuntime('uploadValidation.createdDate') });
  }
  if (
    draft.archiveSerialNumber.state === 'value'
    && (!Number.isInteger(draft.archiveSerialNumber.value) || draft.archiveSerialNumber.value <= 0)
  ) {
    issues.push({ field: 'archiveSerialNumber', message: translateRuntime('uploadValidation.asnPositive') });
  }
  if (draft.workflow.state !== 'unset' && options.workflowOverrideSupported !== true) {
    issues.push({ field: 'workflow', message: translateRuntime('uploadValidation.workflowUnsupported') });
  }

  const singleOptions: [string, ExplicitValue<PaperlessOption>, PaperlessOption[] | undefined][] = [
    ['correspondent', draft.correspondent, options.catalog?.correspondents],
    ['document type', draft.documentType, options.catalog?.documentTypes],
    ['storage path', draft.storagePath, options.catalog?.storagePaths],
    ['owner', draft.owner, options.catalog?.owners],
    ['workflow', draft.workflow, options.catalog?.workflows],
  ];
  for (const [name, field, visibleOptions] of singleOptions) {
    if (
      field.state === 'value'
      && (
        !isPositiveRemoteId(field.value.remoteId)
        || (visibleOptions && !visibleOptions.some((option) => option.remoteId === field.value.remoteId))
      )
    ) {
      issues.push({ field: name, message: translateRuntime('uploadValidation.referenceStale', { field: name }) });
    }
  }
  if (draft.tags.state === 'value') {
    const remoteIds = draft.tags.value.map((tag) => tag.remoteId);
    if (
      remoteIds.some((id) => !isPositiveRemoteId(id))
      || new Set(remoteIds).size !== remoteIds.length
      || (options.catalog && remoteIds.some(
        (id) => !options.catalog!.tags.some((tag) => tag.remoteId === id),
      ))
    ) {
      issues.push({ field: 'tags', message: translateRuntime('uploadValidation.tagsStale') });
    }
  }
  const customFieldIds = draft.customFields.map((field) => field.fieldRemoteId ?? field.fieldId);
  if (new Set(customFieldIds).size !== customFieldIds.length) {
    issues.push({ field: 'customFields', message: translateRuntime('uploadValidation.customDuplicate') });
  }
  for (const field of draft.customFields) issues.push(...validateCustomField(field, options));
  return issues;
}

function mergeExplicit<T>(base: ExplicitValue<T>, override?: ExplicitValue<T>) {
  return override ?? base;
}

export function applyUploadMetadata(
  base: UploadMetadataDraft,
  override: Partial<UploadMetadataDraft>,
): UploadMetadataDraft {
  return {
    title: mergeExplicit(base.title, override.title),
    created: mergeExplicit(base.created, override.created),
    correspondent: mergeExplicit(base.correspondent, override.correspondent),
    documentType: mergeExplicit(base.documentType, override.documentType),
    tags: mergeExplicit(base.tags, override.tags),
    storagePath: mergeExplicit(base.storagePath, override.storagePath),
    archiveSerialNumber: mergeExplicit(base.archiveSerialNumber, override.archiveSerialNumber),
    owner: mergeExplicit(base.owner, override.owner),
    workflow: mergeExplicit(base.workflow, override.workflow),
    customFields: override.customFields ?? base.customFields,
  };
}

export function defaultPresetForSource(
  presets: readonly UploadPreset[],
  profileId: string,
  source: IntakeSource,
) {
  if (source === 'unknown') return undefined;
  return presets
    .filter((preset) => preset.profileId === profileId && preset.defaultFor?.includes(source))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

export function lastUsedCreatedDateForPreset(
  tasks: readonly PersistentTask[],
  presetId: string,
) {
  const task = tasks
    .filter((candidate) => (
      candidate.presetId === presetId
      && candidate.metadata?.created.state === 'value'
      && isValidIsoDate(String(candidate.metadata.created.value))
    ))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  return task?.metadata?.created.state === 'value'
    ? String(task.metadata.created.value)
    : undefined;
}

export function applyUploadPreset(
  base: UploadMetadataDraft,
  preset: UploadPreset,
  options: { originalName: string; today?: string; lastUsedDate?: string },
) {
  const originalTitle = options.originalName
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\.[^.]+$/, '')
    .trim();
  const title = preset.filenameTitle === 'blank'
    ? { state: 'unset' as const }
    : preset.filenameTitle === 'original' && originalTitle
      ? { state: 'value' as const, value: originalTitle }
      : base.title;
  const created = preset.createdDateBehavior === 'today'
    ? { state: 'value' as const, value: options.today ?? new Date().toISOString().slice(0, 10) }
    : preset.createdDateBehavior === 'last-used'
      ? options.lastUsedDate
        ? { state: 'value' as const, value: options.lastUsedDate }
        : preset.metadata.created
      : { state: 'unset' as const };
  return applyUploadMetadata(base, { ...preset.metadata, title, created });
}

export function stalePresetReferences(
  preset: UploadPreset,
  visibleReferences: ReadonlySet<number> | PaperlessCatalog,
) {
  const stale: string[] = [];
  const catalog = 'correspondents' in visibleReferences
    ? visibleReferences as PaperlessCatalog
    : undefined;
  const visibleRemoteIds = catalog
    ? undefined
    : visibleReferences as ReadonlySet<number>;
  const optionFields: [string, ExplicitValue<PaperlessOption>, PaperlessOption[] | undefined][] = [
    ['correspondent', preset.metadata.correspondent, catalog?.correspondents],
    ['documentType', preset.metadata.documentType, catalog?.documentTypes],
    ['storagePath', preset.metadata.storagePath, catalog?.storagePaths],
    ['owner', preset.metadata.owner, catalog?.owners],
    ['workflow', preset.metadata.workflow, catalog?.workflows],
  ];
  for (const [name, field, currentOptions] of optionFields) {
    if (
      field.state === 'value'
      && (
        !isPositiveRemoteId(field.value.remoteId)
        || (currentOptions
          ? !currentOptions.some((option) => option.remoteId === field.value.remoteId)
          : !visibleRemoteIds?.has(field.value.remoteId))
      )
    ) {
      stale.push(name);
    }
  }
  if (preset.metadata.tags.state === 'value') {
    preset.metadata.tags.value.forEach((tag) => {
      if (
        !isPositiveRemoteId(tag.remoteId)
        || (catalog
          ? !catalog.tags.some((option) => option.remoteId === tag.remoteId)
          : !visibleRemoteIds?.has(tag.remoteId))
      ) stale.push(`tag:${tag.name}`);
    });
  }
  preset.metadata.customFields.forEach((field) => {
    if (field.value.state === 'unset') return;
    const current = catalog?.customFields.find((item) => item.remoteId === field.fieldRemoteId);
    const selectedValue = field.value.state === 'value' ? field.value.value : undefined;
    const selectValueIsStale = current?.dataType === 'select'
      && typeof selectedValue === 'string'
      && !current.selectOptions.some((option) => option.id === selectedValue);
    if (
      !isPositiveRemoteId(field.fieldRemoteId)
      || (catalog && (
        !current
        || (field.dataType !== undefined && field.dataType !== current.dataType)
        || selectValueIsStale
      ))
      || (!catalog && !visibleRemoteIds?.has(field.fieldRemoteId))
    ) {
      stale.push(`customField:${field.fieldId}`);
    }
  });
  return stale;
}

export function migrateUploadPreset(value: unknown, expectedProfileId: string): UploadPreset {
  if (!value || typeof value !== 'object') throw new Error(translateRuntime('uploadValidation.presetInvalid'));
  const raw = value as Partial<UploadPreset> & { metadata?: Partial<UploadMetadataDraft> };
  if (raw.schemaVersion && raw.schemaVersion > UPLOAD_PRESET_SCHEMA_VERSION) {
    throw new Error(translateRuntime('uploadValidation.presetNewer'));
  }
  if (raw.profileId !== expectedProfileId) {
    throw new Error(translateRuntime('uploadValidation.presetProfile'));
  }
  if (!raw.id || !raw.name?.trim()) throw new Error(translateRuntime('uploadValidation.presetIdentity'));
  const fallback = defaultUploadMetadataDraft();
  const metadata: Partial<UploadMetadataDraft> = raw.metadata ?? {};
  const now = new Date(0).toISOString();
  return {
    schemaVersion: UPLOAD_PRESET_SCHEMA_VERSION,
    id: raw.id,
    profileId: expectedProfileId,
    name: raw.name.trim(),
    icon: raw.icon,
    color: raw.color,
    createdDateBehavior: ['paperless', 'today', 'last-used'].includes(raw.createdDateBehavior ?? '')
      ? raw.createdDateBehavior!
      : 'paperless',
    metadata: {
      ...fallback,
      ...metadata,
      customFields: Array.isArray(metadata.customFields) ? metadata.customFields : [],
    },
    filenameTitle: ['sanitized', 'original', 'blank'].includes(raw.filenameTitle ?? '')
      ? raw.filenameTitle!
      : 'sanitized',
    autoSubmit: raw.autoSubmit === true,
    defaultFor: Array.isArray(raw.defaultFor)
      ? [...new Set(raw.defaultFor.filter((source) => ['camera', 'picker', 'share'].includes(source)))] as UploadPreset['defaultFor']
      : [],
    createdAt: raw.createdAt || now,
    updatedAt: raw.updatedAt || raw.createdAt || now,
  };
}
