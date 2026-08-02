import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyUploadPreset,
  applyUploadMetadata,
  assertUploadMetadataReferencesCurrent,
  defaultPresetForSource,
  lastUsedCreatedDateForPreset,
  migrateUploadPreset,
  parseDocumentLinkInput,
  serializeUploadMetadata,
  stalePresetReferences,
  uploadMetadataFieldProvenance,
  validateUploadMetadata,
} from '../src/lib/upload-metadata.ts';
import { intakePermissionState } from '../src/lib/intake-permissions.ts';
import { defaultUploadMetadataDraft } from '../src/types/tasks.ts';

const option = (remoteId, name) => ({ id: `remote-${remoteId}`, remoteId, name });

test('document-link input preserves malformed members for explicit validation', () => {
  assert.deepEqual(parseDocumentLinkInput('4, 8'), [4, 8]);
  assert.equal(parseDocumentLinkInput('4, x'), '4, x');
  assert.equal(parseDocumentLinkInput('4, 0'), '4, 0');

  const draft = defaultUploadMetadataDraft();
  draft.customFields = [{
    fieldId: 'links',
    fieldRemoteId: 13,
    dataType: 'documentlink',
    value: { state: 'value', value: parseDocumentLinkInput('4, x') },
  }];
  assert.deepEqual(validateUploadMetadata(draft).map((issue) => issue.field), ['customFields.links']);
});

test('serializes repeated tags and preserves zero and false custom values', () => {
  const draft = {
    ...defaultUploadMetadataDraft('Receipt'),
    tags: { state: 'value', value: [option(1, 'Inbox'), option(2, 'Tax')] },
    customFields: [
      { fieldId: 'amount', fieldRemoteId: 10, value: { state: 'value', value: 0 } },
      { fieldId: 'reviewed', fieldRemoteId: 11, value: { state: 'value', value: false } },
    ],
  };

  const entries = serializeUploadMetadata(draft);
  assert.deepEqual(entries.filter(([name]) => name === 'tags'), [['tags', '1'], ['tags', '2']]);
  const customFields = JSON.parse(entries.find(([name]) => name === 'custom_fields')[1]);
  assert.equal(customFields['10'], 0);
  assert.equal(customFields['11'], false);
});

test('leaves unset fields out and represents explicit custom-field clearing', () => {
  const draft = {
    ...defaultUploadMetadataDraft(),
    customFields: [
      { fieldId: 'reviewed', fieldRemoteId: 11, value: { state: 'clear' } },
    ],
  };
  const entries = serializeUploadMetadata(draft);
  assert.equal(entries.some(([name]) => name === 'title'), false);
  assert.equal(JSON.parse(entries[0][1])['11'], null);
});

test('Paperless 3.0.5 upload serialization never sends unsupported owner or workflow fields', () => {
  const ownerDraft = {
    ...defaultUploadMetadataDraft('Owned document'),
    owner: { state: 'value', value: option(7, 'Selected owner') },
  };
  const ownerEntries = serializeUploadMetadata(ownerDraft);
  assert.equal(ownerEntries.some(([name]) => name === 'owner'), false);
  assert.equal(ownerEntries.some(([name]) => name === 'workflow'), false);

  const workflowDraft = {
    ...ownerDraft,
    workflow: { state: 'value', value: option(9, 'Unsupported override') },
  };
  assert.deepEqual(
    validateUploadMetadata(workflowDraft).map((issue) => issue.field),
    ['workflow'],
  );
  assert.throws(() => serializeUploadMetadata(workflowDraft), /workflow/i);
});

test('rejects invalid dates, ASNs, and local-only references', () => {
  const issues = validateUploadMetadata({
    ...defaultUploadMetadataDraft(),
    created: { state: 'value', value: '02/31/2026' },
    archiveSerialNumber: { state: 'value', value: 0 },
    owner: { state: 'value', value: { id: 'demo-owner', name: 'Demo' } },
  });
  assert.deepEqual(new Set(issues.map((issue) => issue.field)), new Set([
    'created',
    'archiveSerialNumber',
    'owner',
  ]));
});

test('rejects truthy invalid remote IDs and duplicate tags before serialization', () => {
  const issues = validateUploadMetadata({
    ...defaultUploadMetadataDraft(),
    correspondent: { state: 'value', value: option(-1, 'Deleted') },
    tags: { state: 'value', value: [option(3, 'One'), option(3, 'Duplicate')] },
  });
  assert.deepEqual(new Set(issues.map((issue) => issue.field)), new Set(['correspondent', 'tags']));
});

test('validates persisted custom-field schema constraints without dropping false or negative money', () => {
  const draft = defaultUploadMetadataDraft('Invoice');
  draft.customFields = [
    {
      fieldId: 'paid',
      fieldRemoteId: 10,
      dataType: 'boolean',
      value: { state: 'value', value: false },
    },
    {
      fieldId: 'total',
      fieldRemoteId: 11,
      dataType: 'monetary',
      defaultCurrency: 'CHF',
      value: { state: 'value', value: 'CHF-12.30' },
    },
    {
      fieldId: 'category',
      fieldRemoteId: 12,
      dataType: 'select',
      selectOptionIds: ['', 'travel'],
      value: { state: 'value', value: '' },
    },
    {
      fieldId: 'links',
      fieldRemoteId: 13,
      dataType: 'documentlink',
      value: { state: 'value', value: [4, 8] },
    },
  ];

  assert.deepEqual(validateUploadMetadata(draft), []);
  assert.deepEqual(
    Object.fromEntries(serializeUploadMetadata(draft)),
    {
      title: 'Invoice',
      custom_fields: JSON.stringify({
        10: false,
        11: 'CHF-12.30',
        12: '',
        13: [4, 8],
      }),
    },
  );

  draft.customFields[1].value = { state: 'value', value: 'CHF12.3' };
  draft.customFields[2].value = { state: 'value', value: 'deleted-option' };
  draft.customFields[3].value = { state: 'value', value: [4, 4, 0] };
  assert.deepEqual(
    validateUploadMetadata(draft).map((issue) => issue.field),
    ['customFields.total', 'customFields.category', 'customFields.links'],
  );
});

test('applies common batch metadata without replacing per-file titles', () => {
  const perFile = defaultUploadMetadataDraft('Invoice 104');
  const common = {
    tags: { state: 'value', value: [option(4, 'Business')] },
    documentType: { state: 'value', value: option(7, 'Invoice') },
  };
  const merged = applyUploadMetadata(perFile, common);
  assert.equal(merged.title.value, 'Invoice 104');
  assert.equal(merged.tags.value[0].remoteId, 4);
});

test('reports preset-inherited fields separately from per-file overrides', () => {
  const inherited = {
    ...defaultUploadMetadataDraft('Invoice'),
    tags: { state: 'value', value: [option(4, 'Business')] },
  };
  const current = {
    ...inherited,
    title: { state: 'value', value: 'Invoice 104' },
  };
  const provenance = uploadMetadataFieldProvenance(current, inherited);
  assert.deepEqual(provenance.overridden, ['title']);
  assert.equal(provenance.inherited.includes('tags'), true);
});

test('applies source defaults with explicit title and created-date behavior', () => {
  const preset = {
    schemaVersion: 1,
    id: 'receipt',
    profileId: 'profile-a',
    name: 'Receipts',
    createdDateBehavior: 'today',
    filenameTitle: 'original',
    autoSubmit: false,
    defaultFor: ['share'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    metadata: {
      ...defaultUploadMetadataDraft('Preset title'),
      tags: { state: 'value', value: [option(6, 'Receipt')] },
    },
  };
  const other = { ...preset, id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' };

  assert.equal(defaultPresetForSource([other, preset], 'profile-a', 'share')?.id, 'receipt');
  assert.equal(defaultPresetForSource([preset], 'profile-b', 'share'), undefined);
  const applied = applyUploadPreset(defaultUploadMetadataDraft('sanitized name'), preset, {
    originalName: 'Quarterly report.final.PDF',
    today: '2026-08-02',
  });
  assert.deepEqual(applied.title, { state: 'value', value: 'Quarterly report.final' });
  assert.deepEqual(applied.created, { state: 'value', value: '2026-08-02' });
  assert.equal(applied.tags.value[0].remoteId, 6);
});

test('reports stale profile-scoped preset references for repair', () => {
  const now = '2026-01-01T00:00:00.000Z';
  const preset = {
    schemaVersion: 1,
    id: 'preset-1',
    profileId: 'profile-a',
    name: 'Receipts',
    createdDateBehavior: 'paperless',
    filenameTitle: 'sanitized',
    autoSubmit: false,
    createdAt: now,
    updatedAt: now,
    metadata: {
      ...defaultUploadMetadataDraft(),
      correspondent: { state: 'value', value: option(5, 'Shop') },
      tags: { state: 'value', value: [option(6, 'Receipt')] },
    },
  };
  assert.deepEqual(stalePresetReferences(preset, new Set([6])), ['correspondent']);
  assert.deepEqual(stalePresetReferences(preset, {
    correspondents: [],
    documentTypes: [],
    tags: [option(5, 'Same numeric ID, wrong resource'), option(6, 'Receipt')],
    storagePaths: [],
    owners: [],
    workflows: [],
    customFields: [],
    savedViews: [],
  }), ['correspondent']);
});

test('revalidates catalog type, select options, and current-document links', () => {
  const draft = defaultUploadMetadataDraft();
  draft.customFields = [
    {
      fieldId: 'category',
      fieldRemoteId: 20,
      dataType: 'select',
      selectOptionIds: ['old'],
      value: { state: 'value', value: 'old' },
    },
    {
      fieldId: 'links',
      fieldRemoteId: 21,
      dataType: 'documentlink',
      value: { state: 'value', value: [42] },
    },
  ];
  const catalog = {
    correspondents: [],
    documentTypes: [],
    tags: [],
    storagePaths: [],
    owners: [],
    workflows: [],
    customFields: [
      { id: 'category', remoteId: 20, name: 'Category', dataType: 'select', selectOptions: [{ id: 'new', label: 'New' }] },
      { id: 'links', remoteId: 21, name: 'Links', dataType: 'documentlink', selectOptions: [] },
    ],
    savedViews: [],
  };
  assert.deepEqual(
    validateUploadMetadata(draft, { catalog, currentDocumentId: 42 }).map((issue) => issue.field),
    ['customFields.category', 'customFields.links'],
  );
});

test('transport-time reference validation yields an explicit metadata repair error', () => {
  const draft = {
    ...defaultUploadMetadataDraft('Invoice'),
    correspondent: { state: 'value', value: option(5, 'Deleted supplier') },
  };
  const emptyCatalog = {
    correspondents: [], documentTypes: [], tags: [], storagePaths: [], owners: [], workflows: [], customFields: [], savedViews: [],
  };
  assert.throws(
    () => assertUploadMetadataReferencesCurrent(draft, emptyCatalog),
    (error) => error.code === 'invalid-metadata' && /correspondent/i.test(error.message),
  );
});

test('migrates legacy presets with durable defaults and rejects cross-profile reuse', () => {
  const migrated = migrateUploadPreset({
    id: 'legacy',
    profileId: 'profile-a',
    name: '  Receipts  ',
    metadata: { tags: { state: 'value', value: [option(6, 'Receipt')] } },
  }, 'profile-a');
  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.name, 'Receipts');
  assert.equal(migrated.createdDateBehavior, 'paperless');
  assert.deepEqual(migrated.defaultFor, []);
  assert.equal(migrated.metadata.title.state, 'unset');
  assert.equal(migrated.metadata.tags.value[0].remoteId, 6);
  assert.throws(() => migrateUploadPreset({ ...migrated, profileId: 'profile-b' }, 'profile-a'), /different connection/);
});

test('last-used preset dates survive restart through persisted queue history', () => {
  const makeTask = (id, presetId, value, updatedAt) => ({
    schemaVersion: 1,
    id,
    profileId: 'profile-a',
    kind: 'upload',
    stage: 'ready',
    source: 'picker',
    presetId,
    metadata: { ...defaultUploadMetadataDraft(), created: { state: 'value', value } },
    progress: 1,
    retryCount: 0,
    createdAt: updatedAt,
    updatedAt,
  });
  assert.equal(lastUsedCreatedDateForPreset([
    makeTask('newer-other', 'other', '2026-08-03', '2026-08-03T10:00:00Z'),
    makeTask('older', 'receipts', '2026-07-01', '2026-08-01T10:00:00Z'),
    makeTask('newer', 'receipts', '2026-08-02', '2026-08-02T10:00:00Z'),
    makeTask('invalid', 'receipts', '2026-02-31', '2026-08-04T10:00:00Z'),
  ], 'receipts'), '2026-08-02');
});

test('known upload and owner restrictions disable only the forbidden intake assignments', () => {
  assert.deepEqual(intakePermissionState({
    tag: null,
    correspondent: null,
    documentType: null,
    uploadDocument: false,
    assignOwner: true,
  }), {
    canUpload: false,
    canAssignOwner: false,
    canQuickCreate: { tag: false, correspondent: false, documentType: false },
  });
  assert.deepEqual(intakePermissionState({
    tag: null,
    correspondent: null,
    documentType: null,
    uploadDocument: true,
    assignOwner: false,
  }), {
    canUpload: true,
    canAssignOwner: false,
    canQuickCreate: { tag: false, correspondent: false, documentType: false },
  });
  assert.deepEqual(intakePermissionState({
    tag: null,
    correspondent: null,
    documentType: null,
    uploadDocument: null,
    assignOwner: null,
  }), {
    canUpload: true,
    canAssignOwner: true,
    canQuickCreate: { tag: false, correspondent: false, documentType: false },
  });
  assert.deepEqual(intakePermissionState({
    tag: true,
    correspondent: true,
    documentType: false,
    uploadDocument: true,
    assignOwner: true,
  }).canQuickCreate, { tag: true, correspondent: true, documentType: false });
});
