const supported = { supported: true, source: 'openapi' };

function crud({ update = true } = {}) {
  return {
    list: supported,
    retrieve: supported,
    create: supported,
    update: update ? supported : { supported: false, reason: 'endpoint-missing', source: 'openapi' },
    delete: supported,
  };
}

export function fullCapabilities(overrides = {}) {
  const resourcePermissions = {
    view: true,
    add: true,
    change: true,
    delete: true,
  };
  return {
    profileId: 'profile-a',
    discoveredAt: '2026-08-02T12:00:00.000Z',
    apiVersion: '10',
    serverVersion: '3.0.5',
    openApiVersion: '3.0.5',
    schemaAvailable: true,
    optionsAvailable: true,
    serverFingerprint: '10|3.0.5|3.0.5',
    permissions: {
      document: { ...resourcePermissions },
      tag: { ...resourcePermissions },
      correspondent: { ...resourcePermissions },
      documentType: { ...resourcePermissions },
      storagePath: { ...resourcePermissions },
      savedView: { ...resourcePermissions },
      customField: { ...resourcePermissions },
      user: { ...resourcePermissions },
      group: { ...resourcePermissions },
      shareLink: { ...resourcePermissions },
      currentUserId: 7,
      isSuperuser: false,
    },
    features: {
      bulkDocuments: supported,
      deleteDocuments: supported,
      reprocessDocuments: supported,
      savedViews: {
        ...crud(),
        fields: {
          pageSize: supported,
          displayMode: supported,
          displayFields: supported,
          showOnDashboard: supported,
          showInSidebar: supported,
        },
      },
      catalogs: {
        tags: crud(),
        correspondents: crud(),
        documentTypes: crud(),
        storagePaths: crud(),
      },
      documentMetadata: supported,
      shareLinks: crud({ update: false }),
      nestedTags: supported,
      fullPermissions: supported,
      duplicateDocuments: supported,
      aiSuggestions: supported,
      tasksV10: supported,
      pdf: {
        rotate: supported,
        merge: supported,
        edit: supported,
        removePassword: supported,
      },
    },
    ...overrides,
  };
}

export function openApiFixture() {
  const collection = (name) => ({
    get: { responses: { 200: { content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}List` } } } } } },
    post: { requestBody: { content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } } },
  });
  const detail = (name) => ({
    get: { responses: { 200: { content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } } } },
    patch: { requestBody: { content: { 'application/json': { schema: { $ref: `#/components/schemas/${name}` } } } } },
    delete: { responses: { 204: {} } },
  });
  return {
    openapi: '3.0.3',
    info: { version: '3.0.5' },
    paths: {
      '/api/documents/bulk_edit/': { post: {} },
      '/api/documents/delete/': { post: {} },
      '/api/documents/reprocess/': { post: {} },
      '/api/documents/rotate/': { post: {} },
      '/api/documents/merge/': { post: {} },
      '/api/documents/edit_pdf/': { post: {} },
      '/api/documents/remove_password/': { post: {} },
      '/api/documents/{id}/metadata/': { get: {} },
      '/api/documents/{id}/ai_suggestions/': { get: {} },
      '/api/documents/{id}/': detail('Document'),
      '/api/tasks/active/': { get: {} },
      '/api/saved_views/': collection('SavedView'),
      '/api/saved_views/{id}/': detail('SavedView'),
      '/api/tags/': collection('Tag'),
      '/api/tags/{id}/': detail('Tag'),
      '/api/correspondents/': collection('Correspondent'),
      '/api/correspondents/{id}/': detail('Correspondent'),
      '/api/document_types/': collection('DocumentType'),
      '/api/document_types/{id}/': detail('DocumentType'),
      '/api/storage_paths/': collection('StoragePath'),
      '/api/storage_paths/{id}/': detail('StoragePath'),
      '/api/share_links/': collection('ShareLink'),
      '/api/share_links/{id}/': {
        get: detail('ShareLink').get,
        delete: { responses: { 204: {} } },
      },
    },
    components: {
      schemas: {
        Document: {
          type: 'object',
          properties: { id: { type: 'integer' }, duplicate_documents: { type: 'array' }, permissions: { type: 'object' }, set_permissions: { type: 'object' } },
        },
        Tag: {
          type: 'object',
          properties: { id: { type: 'integer' }, parent: { type: 'integer' }, children: { type: 'array' } },
        },
        TagList: { type: 'object', properties: { results: { type: 'array', items: { $ref: '#/components/schemas/Tag' } } } },
        SavedView: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            page_size: { type: 'integer' },
            display_mode: { type: 'string' },
            display_fields: { type: 'array', items: { type: 'string' } },
            show_on_dashboard: { type: 'boolean' },
            show_in_sidebar: { type: 'boolean' },
          },
        },
        SavedViewList: { type: 'object', properties: { results: { type: 'array', items: { $ref: '#/components/schemas/SavedView' } } } },
        Correspondent: { type: 'object', properties: { id: { type: 'integer' } } },
        CorrespondentList: { type: 'object', properties: { results: { type: 'array' } } },
        DocumentType: { type: 'object', properties: { id: { type: 'integer' } } },
        DocumentTypeList: { type: 'object', properties: { results: { type: 'array' } } },
        StoragePath: { type: 'object', properties: { id: { type: 'integer' } } },
        StoragePathList: { type: 'object', properties: { results: { type: 'array' } } },
        ShareLink: { type: 'object', properties: { id: { type: 'integer' }, file_version: { type: 'string' } } },
        ShareLinkList: { type: 'object', properties: { results: { type: 'array' } } },
      },
    },
  };
}

export const tagFixture = {
  id: 1,
  name: 'Finance',
  slug: 'finance',
  color: '#aabbcc',
  text_color: '#000000',
  match: 'finance',
  matching_algorithm: 1,
  is_insensitive: true,
  is_inbox_tag: false,
  parent: null,
  children: [
    {
      id: 2,
      name: 'Invoices',
      slug: 'invoices',
      color: '#ccbbaa',
      match: '',
      matching_algorithm: 0,
      is_insensitive: false,
      is_inbox_tag: false,
      parent: 1,
      children: [],
    },
  ],
  server_extension: { retained: true },
};

export const savedViewFixture = {
  id: 9,
  name: 'Inbox invoices',
  sort_field: 'created',
  sort_reverse: true,
  filter_rules: [
    { rule_type: 5, value: 'true' },
    { rule_type: 999, value: 'future', future_option: 'preserve-me' },
  ],
  page_size: 50,
  display_mode: 'table',
  display_fields: ['title', 'created'],
  show_on_dashboard: true,
  show_in_sidebar: false,
  owner: 7,
  permissions: { view: { users: [7], groups: [] }, change: { users: [7], groups: [] } },
  user_can_change: true,
  future_presentation: { density: 'compact' },
};

// Paperless-ngx 3.0.5 DocumentOperationPermissionMixin wraps the synchronous
// bulk-edit return value exactly this way for rotate/merge/edit_pdf.
export const paperless305PdfOperationAcceptedFixture = Object.freeze({ result: 'OK' });

export function paperless305ConsumeTaskFixture({
  id,
  filename,
  status = 'pending',
  owner = 7,
}) {
  return {
    id: Number(String(id).replace(/\D/g, '')) || 1,
    task_id: String(id),
    task_type: 'consume_file',
    trigger_source: 'api_upload',
    status,
    date_created: '2026-08-02T12:00:00Z',
    date_started: status === 'pending' ? null : '2026-08-02T12:00:01Z',
    date_done: ['success', 'failure', 'revoked'].includes(status)
      ? '2026-08-02T12:00:02Z'
      : null,
    duration_seconds: status === 'pending' ? null : 1,
    wait_time_seconds: status === 'pending' ? null : 1,
    input_data: { filename, mime_type: null },
    result_data: status === 'failure' ? { error_message: 'PDF parse failed' } : {},
    related_document_ids: [],
    acknowledged: false,
    owner,
  };
}
