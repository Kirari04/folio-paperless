type RoutableDocument = {
  id: string;
  taskId?: string;
};

type PendingDocument = {
  status: string;
  taskId?: string;
  remoteId?: number;
};

const processingActionError =
  'This document is still processing in Paperless. Wait until it is ready before making changes.';

export function taskIdFromPlaceholderId(id: string) {
  return id.startsWith('task-') ? id.slice(5) : null;
}

export function resolveDocumentAlias(id: string, aliases: Record<string, string>) {
  const seen = new Set<string>();
  let resolvedId = id;

  while (aliases[resolvedId] && !seen.has(resolvedId)) {
    seen.add(resolvedId);
    resolvedId = aliases[resolvedId];
  }

  return resolvedId;
}

export function findRoutedDocument<T extends RoutableDocument>(
  documents: T[],
  requestedId: string,
  resolvedId: string,
) {
  const taskId = taskIdFromPlaceholderId(requestedId);
  return documents.find(
    (document) => document.id === resolvedId || (taskId && document.taskId === taskId),
  );
}

export function isPendingDocument(document: PendingDocument) {
  return document.status === 'processing' || Boolean(document.taskId && !document.remoteId);
}

export function assertDocumentReady(document: PendingDocument) {
  if (isPendingDocument(document)) throw new Error(processingActionError);
}
