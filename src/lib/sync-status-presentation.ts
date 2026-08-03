import type { TranslationKey } from '../i18n/catalogs.ts';

export type WorkspaceSyncState =
  | 'demo'
  | 'cached'
  | 'syncing'
  | 'current'
  | 'offline'
  | 'error';

export type SyncStatusTone = 'neutral' | 'success' | 'progress' | 'warning' | 'danger';

export type SyncStatusPresentation = {
  busy: boolean;
  lastSuccessfulSyncAt?: string;
  messageKey: TranslationKey;
  state: WorkspaceSyncState;
  tone: SyncStatusTone;
};

function validTimestamp(value: string | null | undefined) {
  return value && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** Produces one honest, accessible status model shared by Home and Settings. */
export function presentSyncStatus(input: {
  connected: boolean;
  lastSynced: string | null | undefined;
  online: boolean | null;
  syncState: WorkspaceSyncState;
}): SyncStatusPresentation {
  const lastSuccessfulSyncAt = validTimestamp(input.lastSynced);
  const state = !input.connected || input.syncState === 'demo'
    ? 'demo'
    : input.syncState === 'syncing'
      ? 'syncing'
      : input.online === false || input.syncState === 'offline'
        ? 'offline'
        : input.syncState;

  if (state === 'demo') {
    return { busy: false, messageKey: 'syncStatus.demo', state, tone: 'neutral' };
  }
  if (state === 'syncing') {
    return {
      busy: true,
      ...(lastSuccessfulSyncAt ? { lastSuccessfulSyncAt } : {}),
      messageKey: lastSuccessfulSyncAt ? 'syncStatus.syncingLastSuccess' : 'syncStatus.syncing',
      state,
      tone: 'progress',
    };
  }
  if (state === 'offline') {
    return {
      busy: false,
      ...(lastSuccessfulSyncAt ? { lastSuccessfulSyncAt } : {}),
      messageKey: lastSuccessfulSyncAt ? 'syncStatus.offlineLastSuccess' : 'syncStatus.offline',
      state,
      tone: 'warning',
    };
  }
  if (state === 'error') {
    return {
      busy: false,
      ...(lastSuccessfulSyncAt ? { lastSuccessfulSyncAt } : {}),
      messageKey: lastSuccessfulSyncAt ? 'syncStatus.errorLastSuccess' : 'syncStatus.error',
      state,
      tone: 'danger',
    };
  }
  if (state === 'cached') {
    return {
      busy: false,
      ...(lastSuccessfulSyncAt ? { lastSuccessfulSyncAt } : {}),
      messageKey: lastSuccessfulSyncAt ? 'syncStatus.cachedLastSuccess' : 'syncStatus.cached',
      state,
      tone: 'warning',
    };
  }
  return {
    busy: false,
    ...(lastSuccessfulSyncAt ? { lastSuccessfulSyncAt } : {}),
    messageKey: lastSuccessfulSyncAt ? 'syncStatus.currentLastSuccess' : 'syncStatus.current',
    state: 'current',
    tone: 'success',
  };
}
