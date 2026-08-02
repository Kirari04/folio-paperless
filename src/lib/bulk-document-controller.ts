import type { DocumentItem, PaperlessCredentials } from '@/types/document';
import type { PersistentTask } from '@/types/tasks';
import { translateRuntime } from '../i18n/runtime.ts';
import type {
  PaperlessBulkCandidate,
  PaperlessBulkOperation,
  PaperlessBulkResult,
  PaperlessCapabilityResult,
} from '@/types/paperless-advanced';
import {
  extractTaskIds,
  selectBulkEligible,
  type PaperlessAdvancedApi,
} from './paperless-advanced.ts';

export type LibrarySelectionSummary = {
  selected: number;
  shownSelected: number;
  hiddenSelected: number;
  shown: number;
};

export function toggleStableSelection(selectedIds: ReadonlySet<string>, id: string) {
  const next = new Set(selectedIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function selectShownDocuments(
  selectedIds: ReadonlySet<string>,
  shownDocuments: readonly DocumentItem[],
) {
  const next = new Set(selectedIds);
  for (const document of shownDocuments) next.add(document.id);
  return next;
}

export function summarizeLibrarySelection(
  selectedIds: ReadonlySet<string>,
  shownDocuments: readonly DocumentItem[],
): LibrarySelectionSummary {
  const shownIds = new Set(shownDocuments.map((document) => document.id));
  const shownSelected = [...selectedIds].filter((id) => shownIds.has(id)).length;
  return {
    selected: selectedIds.size,
    shownSelected,
    hiddenSelected: selectedIds.size - shownSelected,
    shown: shownDocuments.length,
  };
}

export function buildBulkCandidates(
  documents: readonly DocumentItem[],
  selectedIds: ReadonlySet<string>,
): PaperlessBulkCandidate[] {
  const byId = new Map(documents.map((document) => [document.id, document]));
  return [...selectedIds].map((localId) => {
    const document = byId.get(localId);
    return {
      localId,
      remoteId: document?.remoteId ?? null,
      ready: document?.status !== 'processing' && !document?.taskId,
      canEdit: document?.canEdit,
    };
  });
}

export async function executeBulkDocumentOperation(input: {
  api: PaperlessAdvancedApi;
  expectedProfileId: string;
  executionGuard?: () => boolean;
  documents: readonly DocumentItem[];
  selectedIds: ReadonlySet<string>;
  operation: PaperlessBulkOperation;
  signal?: AbortSignal;
}): Promise<PaperlessCapabilityResult<PaperlessBulkResult>> {
  if (input.api.client.profileId !== input.expectedProfileId || input.executionGuard?.() === false) {
    throw new Error(translateRuntime('runtimeError.profileChangedBulk'));
  }
  const selection = selectBulkEligible(buildBulkCandidates(input.documents, input.selectedIds));
  if (!selection.eligible.length) {
    return {
      supported: true,
      value: {
        operation: input.operation,
        accepted: false,
        pending: [],
        succeeded: [],
        failed: [],
        skipped: selection.skipped,
        requestCount: 0,
        taskIds: [],
      },
    };
  }

  // The advanced adapter uses the Paperless bulk endpoint when it exists and
  // applies its own bounded concurrency only for per-document fallbacks such as
  // exact tag replacement. Keeping the whole eligible set together therefore
  // preserves the server's one-request bulk behavior.
  const result = await input.api.bulkDocuments(
    selection.eligible,
    input.operation,
    { concurrency: Math.min(3, selection.eligible.length), signal: input.signal },
  );
  if (!result.supported) return result;

  const value = result.value;
  if (
    input.operation.kind !== 'reprocess'
    || value.taskIds.length
    || !value.succeeded.length
  ) {
    return {
      supported: true,
      value: { ...value, skipped: [...selection.skipped, ...value.skipped] },
    };
  }

  const eligibleByRemoteId = new Map(selection.eligible.map((candidate) => [candidate.remoteId, candidate]));
  return {
    supported: true,
    value: {
      ...value,
      succeeded: [],
      failed: value.succeeded.map((remoteId) => {
        const candidate = eligibleByRemoteId.get(remoteId);
        return {
          ...(candidate ? { localId: candidate.localId } : {}),
          remoteId,
          status: null,
          code: 'task-correlation-unavailable',
          message: 'Paperless accepted reprocessing but did not expose its task ID. The terminal outcome cannot be verified.',
          retryable: false,
        };
      }),
      skipped: [...selection.skipped, ...value.skipped],
    },
  };
}

export function failedBulkSelection(result: PaperlessBulkResult) {
  return new Set(
    result.failed
      .map((failure) => failure.localId)
      .filter((id): id is string => !!id)
      .concat(
        result.failed
          .filter((failure) => !failure.localId && failure.remoteId)
          .map((failure) => `remote-${failure.remoteId}`),
      ),
  );
}

function persistedBulkRequest(operation: PaperlessBulkOperation, remoteDocumentIds: readonly number[]) {
  if (operation.kind === 'tags' && operation.mode === 'replace') {
    if (remoteDocumentIds.length !== 1) {
      throw new Error('Exact tag replacement retries require one failed document per durable task.');
    }
    return {
      path: `/api/documents/${remoteDocumentIds[0]}/`,
      method: 'PATCH',
      body: { tags: operation.tagIds },
    } as const;
  }
  if (operation.kind === 'trash' || operation.kind === 'reprocess') {
    return {
      path: operation.kind === 'trash' ? '/api/documents/delete/' : '/api/documents/reprocess/',
      method: 'POST',
      body: { documents: remoteDocumentIds },
    } as const;
  }
  if (operation.kind === 'tags') {
    return {
      path: '/api/documents/bulk_edit/',
      method: 'POST',
      body: {
        documents: remoteDocumentIds,
        method: 'modify_tags',
        parameters: {
          add_tags: operation.mode === 'add' ? operation.tagIds : [],
          remove_tags: operation.mode === 'remove' ? operation.tagIds : [],
        },
      },
    } as const;
  }
  if (operation.kind === 'file') {
    return {
      path: '/api/documents/bulk_edit/',
      method: 'POST',
      body: {
        documents: remoteDocumentIds,
        method: 'modify_tags',
        parameters: { add_tags: [], remove_tags: operation.inboxTagIds },
      },
    } as const;
  }
  if (operation.kind === 'setOwner') {
    return {
      path: '/api/documents/bulk_edit/',
      method: 'POST',
      body: {
        documents: remoteDocumentIds,
        method: 'set_permissions',
        parameters: {
          owner: operation.value,
          set_permissions: { view: { users: [], groups: [] }, change: { users: [], groups: [] } },
          merge: true,
        },
      },
    } as const;
  }
  const methods = {
    setCorrespondent: 'set_correspondent',
    setDocumentType: 'set_document_type',
    setStoragePath: 'set_storage_path',
  } as const;
  const fields = {
    setCorrespondent: 'correspondent',
    setDocumentType: 'document_type',
    setStoragePath: 'storage_path',
  } as const;
  return {
    path: '/api/documents/bulk_edit/',
    method: 'POST',
    body: {
      documents: remoteDocumentIds,
      method: methods[operation.kind],
      parameters: { [fields[operation.kind]]: operation.value },
    },
  } as const;
}

/** Resubmits only the failed targets retained by a durable bulk task. Succeeded
 * and skipped outcomes are never included in the retry payload. */
export async function submitPersistentBulkTask(
  credentials: PaperlessCredentials,
  task: PersistentTask,
  options: {
    request?: (
      path: string,
      init: RequestInit,
    ) => Promise<Pick<Response, 'ok' | 'status' | 'headers' | 'text'>>;
  } = {},
): Promise<{ paperlessTaskId?: string; summary: string }> {
  if (task.kind !== 'bulk-operation' || !task.bulk) {
    throw new Error('This task has no persisted bulk retry payload.');
  }
  const pending = task.result?.bulkOutcomes?.filter((outcome) => outcome.state === 'pending') ?? [];
  const remoteDocumentIds = pending.map((outcome) => outcome.remoteDocumentId);
  if (
    !remoteDocumentIds.length
    || remoteDocumentIds.some((remoteId) => (
      !Number.isSafeInteger(remoteId) || (remoteId ?? 0) <= 0
    ))
    || new Set(remoteDocumentIds).size !== remoteDocumentIds.length
  ) {
    throw new Error('A bulk retry requires unique failed remote targets.');
  }
  const request = persistedBulkRequest(task.bulk.operation, remoteDocumentIds as number[]);
  const requestImplementation = options.request ?? (async (path: string, init: RequestInit) => {
    const { requestPaperlessRawResponse } = await import('./paperless.ts');
    return requestPaperlessRawResponse(credentials, path, init);
  });
  const response = await requestImplementation(request.path, {
    method: request.method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request.body),
  });
  const bodyText = await response.text();
  let body: unknown = bodyText;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    // Keep the bounded response text for the server error below.
  }
  if (!response.ok) {
    const detail = body && typeof body === 'object' && 'detail' in body
      && typeof body.detail === 'string'
      ? body.detail
      : bodyText || `Paperless rejected the bulk retry (${response.status}).`;
    throw Object.assign(new Error(detail), { status: response.status });
  }
  const taskIds = extractTaskIds(body, response.headers);
  if (taskIds.length > 1) {
    throw new Error('Paperless accepted the retry but returned multiple task IDs for one batch. The outcomes are not safely correlated.');
  }
  if (task.bulk.operation.kind === 'reprocess' && taskIds.length === 0) {
    throw new Error('Paperless accepted reprocessing but did not expose its task ID. The terminal outcome cannot be verified or safely retried.');
  }
  return {
    ...(taskIds[0] ? { paperlessTaskId: taskIds[0] } : {}),
    summary: taskIds[0] ? 'Paperless accepted the retry.' : 'Paperless completed the operation.',
  };
}
