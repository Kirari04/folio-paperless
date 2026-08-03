import type { ExternalRoute } from './external-routing';
import { formatRuntimeNumber, translateRuntime } from '../i18n/runtime.ts';

export const NOTIFICATION_ROUTE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_NOTIFICATION_PRIVACY = 'redacted' as const;
export const MAX_NOTIFICATION_ROUTE_HANDLES = 128;

export type NotificationPrivacy = 'redacted' | 'document-title';

export type LocalNotificationPreferences = {
  enabled: boolean;
  privacy: NotificationPrivacy;
};

export type NotificationRoutePayload =
  | {
      schemaVersion: typeof NOTIFICATION_ROUTE_SCHEMA_VERSION;
      kind: 'document-ready';
      profileId: string;
      documentId: string;
      issuedAt: string;
    }
  | {
      schemaVersion: typeof NOTIFICATION_ROUTE_SCHEMA_VERSION;
      kind: 'task-result';
      profileId: string;
      taskId: string;
      issuedAt: string;
    }
  | {
      schemaVersion: typeof NOTIFICATION_ROUTE_SCHEMA_VERSION;
      kind: 'inbox';
      profileId: string;
      issuedAt: string;
    }
  | {
      schemaVersion: typeof NOTIFICATION_ROUTE_SCHEMA_VERSION;
      kind: 'sync';
      profileId: string;
      issuedAt: string;
    };

export type NotificationRouteParseResult =
  | { accepted: true; payload: NotificationRoutePayload; route: ExternalRoute }
  | {
      accepted: false;
      code:
        | 'invalid-payload'
        | 'unsupported-schema'
        | 'unsupported-kind'
        | 'invalid-profile'
        | 'invalid-target'
        | 'invalid-date'
        | 'unexpected-field';
    };

export type LocalNotificationEvent =
  | {
      kind: 'document-ready';
      profileId: string;
      documentId: string;
      documentTitle?: string;
      issuedAt: string;
    }
  | {
      kind: 'task-result';
      profileId: string;
      taskId: string;
      succeeded: boolean;
      issuedAt: string;
    }
  | { kind: 'inbox'; profileId: string; inboxCount?: number; issuedAt: string }
  | { kind: 'sync'; profileId: string; succeeded: boolean; issuedAt: string };

export type SafeNotificationContent = {
  title: string;
  body: string;
  data: NotificationRoutePayload;
};

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read only the two notification fields needed by a headless worker. Unknown
 * or malformed stored settings fail closed and never enable disclosure. */
export function parseLocalNotificationPreferences(value: unknown): LocalNotificationPreferences {
  if (!isRecord(value)) return { enabled: false, privacy: DEFAULT_NOTIFICATION_PRIVACY };
  return {
    enabled: value.processingNotifications === true,
    privacy: value.notificationPrivacy === 'document-title'
      ? 'document-title'
      : DEFAULT_NOTIFICATION_PRIVACY,
  };
}

export function createUploadCompletionNotificationEvent(input: {
  profileId: string;
  taskId: string;
  canonicalDocumentId?: string | null;
  documentTitle?: string;
  issuedAt: string;
}): LocalNotificationEvent {
  return input.canonicalDocumentId
    ? {
        kind: 'document-ready',
        profileId: input.profileId,
        documentId: input.canonicalDocumentId,
        documentTitle: input.documentTitle,
        issuedAt: input.issuedAt,
      }
    : {
        kind: 'task-result',
        profileId: input.profileId,
        taskId: input.taskId,
        succeeded: true,
        issuedAt: input.issuedAt,
      };
}

export function createBackgroundNotificationEvents(input: {
  profileId: string;
  issuedAt: string;
  syncOutcome: 'completed' | 'busy' | 'failed';
  previousInboxCount: number | null;
  currentInboxCount: number | null;
}): LocalNotificationEvent[] {
  const events: LocalNotificationEvent[] = [];
  if (input.syncOutcome === 'failed') {
    events.push({
      kind: 'sync',
      profileId: input.profileId,
      succeeded: false,
      issuedAt: input.issuedAt,
    });
  }
  if (
    input.syncOutcome === 'completed'
    && input.previousInboxCount !== null
    && input.currentInboxCount !== null
    && Number.isSafeInteger(input.previousInboxCount)
    && Number.isSafeInteger(input.currentInboxCount)
    && input.previousInboxCount >= 0
    && input.currentInboxCount > input.previousInboxCount
  ) {
    events.push({
      kind: 'inbox',
      profileId: input.profileId,
      inboxCount: input.currentInboxCount,
      issuedAt: input.issuedAt,
    });
  }
  return events;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID_PATTERN.test(value);
}

function validIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function unknownFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).some((key) => !allowedSet.has(key));
}

export function parseNotificationRoutePayload(input: unknown): NotificationRouteParseResult {
  if (!isRecord(input)) return { accepted: false, code: 'invalid-payload' };
  if (input.schemaVersion !== NOTIFICATION_ROUTE_SCHEMA_VERSION) {
    return { accepted: false, code: 'unsupported-schema' };
  }
  if (!validOpaqueId(input.profileId)) return { accepted: false, code: 'invalid-profile' };
  if (!validIsoDate(input.issuedAt)) return { accepted: false, code: 'invalid-date' };

  const base = {
    schemaVersion: NOTIFICATION_ROUTE_SCHEMA_VERSION,
    profileId: input.profileId,
    issuedAt: input.issuedAt,
  };
  switch (input.kind) {
    case 'document-ready': {
      if (unknownFields(input, ['schemaVersion', 'kind', 'profileId', 'documentId', 'issuedAt'])) {
        return { accepted: false, code: 'unexpected-field' };
      }
      if (!validOpaqueId(input.documentId)) return { accepted: false, code: 'invalid-target' };
      const payload: NotificationRoutePayload = {
        ...base,
        kind: 'document-ready',
        documentId: input.documentId,
      };
      return {
        accepted: true,
        payload,
        route: {
          kind: 'document',
          source: 'notification',
          profileId: payload.profileId,
          documentId: payload.documentId,
        },
      };
    }
    case 'task-result': {
      if (unknownFields(input, ['schemaVersion', 'kind', 'profileId', 'taskId', 'issuedAt'])) {
        return { accepted: false, code: 'unexpected-field' };
      }
      if (!validOpaqueId(input.taskId)) return { accepted: false, code: 'invalid-target' };
      const payload: NotificationRoutePayload = {
        ...base,
        kind: 'task-result',
        taskId: input.taskId,
      };
      return {
        accepted: true,
        payload,
        route: {
          kind: 'tasks',
          source: 'notification',
          scope: { kind: 'profile', profileId: payload.profileId },
        },
      };
    }
    case 'inbox': {
      if (unknownFields(input, ['schemaVersion', 'kind', 'profileId', 'issuedAt'])) {
        return { accepted: false, code: 'unexpected-field' };
      }
      const payload: NotificationRoutePayload = { ...base, kind: 'inbox' };
      return {
        accepted: true,
        payload,
        route: {
          kind: 'inbox',
          source: 'notification',
          scope: { kind: 'profile', profileId: payload.profileId },
        },
      };
    }
    case 'sync': {
      if (unknownFields(input, ['schemaVersion', 'kind', 'profileId', 'issuedAt'])) {
        return { accepted: false, code: 'unexpected-field' };
      }
      const payload: NotificationRoutePayload = { ...base, kind: 'sync' };
      return {
        accepted: true,
        payload,
        route: {
          kind: 'library',
          source: 'notification',
          scope: { kind: 'profile', profileId: payload.profileId },
        },
      };
    }
    default:
      return { accepted: false, code: 'unsupported-kind' };
  }
}

function safeDocumentTitle(value: string | undefined): string | null {
  if (!value) return null;
  const title = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!title) return null;
  return title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title;
}

function payloadForEvent(event: LocalNotificationEvent): NotificationRoutePayload {
  switch (event.kind) {
    case 'document-ready':
      return {
        schemaVersion: NOTIFICATION_ROUTE_SCHEMA_VERSION,
        kind: 'document-ready',
        profileId: event.profileId,
        documentId: event.documentId,
        issuedAt: event.issuedAt,
      };
    case 'task-result':
      return {
        schemaVersion: NOTIFICATION_ROUTE_SCHEMA_VERSION,
        kind: 'task-result',
        profileId: event.profileId,
        taskId: event.taskId,
        issuedAt: event.issuedAt,
      };
    case 'inbox':
      return {
        schemaVersion: NOTIFICATION_ROUTE_SCHEMA_VERSION,
        kind: 'inbox',
        profileId: event.profileId,
        issuedAt: event.issuedAt,
      };
    case 'sync':
      return {
        schemaVersion: NOTIFICATION_ROUTE_SCHEMA_VERSION,
        kind: 'sync',
        profileId: event.profileId,
        issuedAt: event.issuedAt,
      };
  }
}

export function createNotificationContent(
  event: LocalNotificationEvent,
  privacy: NotificationPrivacy = DEFAULT_NOTIFICATION_PRIVACY,
): SafeNotificationContent {
  const parsed = parseNotificationRoutePayload(payloadForEvent(event));
  if (!parsed.accepted) throw new Error('Notification route metadata is invalid.');

  if (event.kind === 'document-ready') {
    const title = privacy === 'document-title' ? safeDocumentTitle(event.documentTitle) : null;
    return {
      title: title ?? translateRuntime('notifications.documentReadyTitle'),
      body: title
        ? translateRuntime('notifications.processingFinished')
        : translateRuntime('notifications.documentReadyBodyRedacted'),
      data: parsed.payload,
    };
  }
  if (event.kind === 'task-result') {
    return {
      title: event.succeeded
        ? translateRuntime('notifications.importCompleteTitle')
        : translateRuntime('notifications.importAttentionTitle'),
      body: event.succeeded
        ? translateRuntime('notifications.importCompleteBody')
        : translateRuntime('notifications.importAttentionBody'),
      data: parsed.payload,
    };
  }
  if (event.kind === 'inbox') {
    const count =
      privacy === 'document-title' && Number.isSafeInteger(event.inboxCount) && event.inboxCount! >= 0
        ? Math.min(event.inboxCount!, 999)
        : null;
    return {
      title: translateRuntime('notifications.inboxTitle'),
      body: count === null
        ? translateRuntime('notifications.inboxBody')
        : translateRuntime(count === 1 ? 'notifications.inboxOne' : 'notifications.inboxMany', {
            count: formatRuntimeNumber(count),
          }),
      data: parsed.payload,
    };
  }
  return {
    title: event.succeeded
      ? translateRuntime('notifications.syncCompleteTitle')
      : translateRuntime('notifications.syncAttentionTitle'),
    body: event.succeeded
      ? translateRuntime('notifications.syncCompleteBody')
      : translateRuntime('notifications.syncAttentionBody'),
    data: parsed.payload,
  };
}

export type NotificationRouteHandle = {
  notificationId: string;
  profileId: string;
  payload: NotificationRoutePayload;
  createdAt: string;
};

export interface NotificationRouteHandleStore {
  load(): Promise<NotificationRouteHandle[]>;
  save(handles: NotificationRouteHandle[]): Promise<void>;
}

export class NotificationRouteRegistry {
  private readonly store: NotificationRouteHandleStore;
  private readonly capacity: number;

  constructor(store: NotificationRouteHandleStore, capacity = MAX_NOTIFICATION_ROUTE_HANDLES) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 512) {
      throw new Error('Notification route capacity must be between 1 and 512.');
    }
    this.store = store;
    this.capacity = capacity;
  }

  async register(handle: NotificationRouteHandle): Promise<void> {
    if (!validOpaqueId(handle.notificationId)) {
      throw new Error('Notification handle is invalid.');
    }
    const parsed = parseNotificationRoutePayload(handle.payload);
    if (!parsed.accepted || parsed.payload.profileId !== handle.profileId || !validIsoDate(handle.createdAt)) {
      throw new Error('Notification route handle is invalid.');
    }
    const current = await this.store.load();
    const next = current
      .filter((item) => item.notificationId !== handle.notificationId)
      .concat({ ...handle, payload: parsed.payload })
      .slice(-this.capacity);
    await this.store.save(next);
  }

  async consume(notificationId: string): Promise<NotificationRoutePayload | null> {
    if (!validOpaqueId(notificationId)) return null;
    const current = await this.store.load();
    const handle = current.find((item) => item.notificationId === notificationId);
    await this.store.save(current.filter((item) => item.notificationId !== notificationId));
    if (!handle) return null;
    const parsed = parseNotificationRoutePayload(handle.payload);
    return parsed.accepted ? parsed.payload : null;
  }

  async revokeProfile(profileId: string): Promise<string[]> {
    if (!validOpaqueId(profileId)) return [];
    const current = await this.store.load();
    const revoked = current
      .filter((item) => item.profileId === profileId)
      .map((item) => item.notificationId);
    await this.store.save(current.filter((item) => item.profileId !== profileId));
    return revoked;
  }

  async handlesForProfile(profileId: string): Promise<string[]> {
    if (!validOpaqueId(profileId)) return [];
    return (await this.store.load())
      .filter((item) => item.profileId === profileId)
      .map((item) => item.notificationId);
  }

  async revokeIdentifiers(notificationIds: readonly string[]): Promise<void> {
    const ids = new Set(notificationIds.filter(validOpaqueId));
    if (!ids.size) return;
    const current = await this.store.load();
    await this.store.save(current.filter((item) => !ids.has(item.notificationId)));
  }
}
