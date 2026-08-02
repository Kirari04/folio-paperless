import type { DocumentItem, PaperlessCatalog } from '../types/document.ts';
import type { CachedWorkspace, FolioRepository } from '../types/persistence.ts';
import {
  PERSISTED_TASK_SCHEMA_VERSION,
  type PersistentTask,
} from '../types/tasks.ts';
import { classifyTaskFailure, scheduleTaskRetry } from './task-policy.ts';
import { reconcileSavedViewSnapshots } from './saved-view-offline-cache.ts';
import { translateRuntime } from '../i18n/runtime.ts';

export type SyncTrigger =
  | 'cold-start'
  | 'manual'
  | 'foreground'
  | 'connectivity'
  | 'background';

export type SyncNetworkState = {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
};

export type WorkspaceSyncPhase =
  | 'empty'
  | 'cached'
  | 'syncing'
  | 'current'
  | 'offline'
  | 'error'
  | 'busy';

export type WorkspaceSyncSnapshot = {
  profileId: string;
  phase: WorkspaceSyncPhase;
  workspace: CachedWorkspace | null;
  trigger?: SyncTrigger;
  error?: string;
};

export type RemoteWorkspaceSyncRequest = {
  profileId: string;
  mode: 'full' | 'incremental';
  modifiedAfter?: string;
  overlapMs: number;
  signal?: AbortSignal;
};

export type RemoteFullWorkspace = {
  kind: 'full';
  documents: DocumentItem[];
  catalog: PaperlessCatalog;
  totalDocuments: number;
  syncedAt: string;
};

export type RemoteIncrementalWorkspace = {
  kind: 'incremental';
  upsertedDocuments: DocumentItem[];
  deletedDocumentIds: string[];
  catalog?: PaperlessCatalog;
  totalDocuments?: number;
  syncedAt: string;
  requiresFullReconciliation?: boolean;
};

export type RemoteWorkspaceSyncResult = RemoteFullWorkspace | RemoteIncrementalWorkspace;

export interface WorkspaceSyncTransport {
  fetchWorkspace(request: RemoteWorkspaceSyncRequest): Promise<RemoteWorkspaceSyncResult>;
}

export type OfflineSyncCoordinatorOptions = {
  repository: FolioRepository;
  transport: WorkspaceSyncTransport;
  now?: () => Date;
  overlapMs?: number;
  fullReconciliationIntervalMs?: number;
  foregroundRefreshAgeMs?: number;
  leaseMs?: number;
  executionGuard?: () => Promise<boolean> | boolean;
};

const DEFAULT_OVERLAP_MS = 5 * 60_000;
const DEFAULT_FULL_RECONCILIATION_MS = 24 * 60 * 60_000;
const DEFAULT_FOREGROUND_REFRESH_AGE_MS = 5 * 60_000;
const DEFAULT_LEASE_MS = 5 * 60_000;

class SyncLeaseLostError extends Error {
  constructor() {
    super('The workspace synchronization lease expired or changed owners.');
    this.name = 'SyncLeaseLostError';
  }
}

function networkUsable(network: SyncNetworkState) {
  return network.isConnected !== false && network.isInternetReachable !== false;
}

function failureStatus(error: unknown) {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

function syncTask(
  profileId: string,
  now: Date,
  trigger: SyncTrigger,
  previous?: PersistentTask | null,
): PersistentTask {
  const timestamp = now.toISOString();
  return {
    schemaVersion: PERSISTED_TASK_SCHEMA_VERSION,
    id: 'workspace-sync',
    profileId,
    kind: 'sync',
    stage: 'processing',
    source: 'unknown',
    originalName: `Workspace sync (${trigger})`,
    progress: 0,
    retryCount: previous?.retryCount ?? 0,
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
    lastAttemptAt: timestamp,
  };
}

function modifiedAfter(workspace: CachedWorkspace, overlapMs: number) {
  const watermark = Date.parse(workspace.lastSyncedAt);
  if (!Number.isFinite(watermark)) return undefined;
  return new Date(Math.max(0, watermark - overlapMs)).toISOString();
}

function needsFullSync(
  workspace: CachedWorkspace | null,
  now: Date,
  fullReconciliationIntervalMs: number,
) {
  if (!workspace?.lastFullSyncedAt) return true;
  const lastFull = Date.parse(workspace.lastFullSyncedAt);
  return !Number.isFinite(lastFull) || now.getTime() - lastFull >= fullReconciliationIntervalMs;
}

function mergeIncrementalWorkspace(
  current: CachedWorkspace,
  remote: RemoteIncrementalWorkspace,
): CachedWorkspace {
  const documents = new Map(current.documents.map((document) => [document.id, document]));
  for (const deletedId of remote.deletedDocumentIds) documents.delete(deletedId);
  for (const document of remote.upsertedDocuments) documents.set(document.id, document);
  const mergedDocuments = [...documents.values()];
  return {
    ...current,
    documents: mergedDocuments,
    catalog: remote.catalog ?? current.catalog,
    totalDocuments: remote.totalDocuments ?? documents.size,
    lastSyncedAt: remote.syncedAt,
    syncState: 'current',
    syncError: undefined,
    savedViewSnapshots: reconcileSavedViewSnapshots(current.savedViewSnapshots, mergedDocuments),
  };
}

function replaceFullWorkspace(
  profileId: string,
  remote: RemoteFullWorkspace,
  previous?: CachedWorkspace | null,
): CachedWorkspace {
  return {
    profileId,
    documents: remote.documents,
    catalog: remote.catalog,
    totalDocuments: remote.totalDocuments,
    lastSyncedAt: remote.syncedAt,
    lastFullSyncedAt: remote.syncedAt,
    syncState: 'current',
    savedViewSnapshots: reconcileSavedViewSnapshots(previous?.savedViewSnapshots, remote.documents),
  };
}

export class OfflineSyncCoordinator {
  private readonly options: OfflineSyncCoordinatorOptions;
  private readonly now: () => Date;
  private readonly overlapMs: number;
  private readonly fullReconciliationIntervalMs: number;
  private readonly foregroundRefreshAgeMs: number;
  private readonly leaseMs: number;

  constructor(options: OfflineSyncCoordinatorOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.overlapMs = Math.max(0, options.overlapMs ?? DEFAULT_OVERLAP_MS);
    this.fullReconciliationIntervalMs = Math.max(
      this.overlapMs,
      options.fullReconciliationIntervalMs ?? DEFAULT_FULL_RECONCILIATION_MS,
    );
    this.foregroundRefreshAgeMs = Math.max(
      0,
      options.foregroundRefreshAgeMs ?? DEFAULT_FOREGROUND_REFRESH_AGE_MS,
    );
    this.leaseMs = Math.max(30_000, options.leaseMs ?? DEFAULT_LEASE_MS);
  }

  async hydrate(profileId: string, network?: SyncNetworkState): Promise<WorkspaceSyncSnapshot> {
    const workspace = await this.options.repository.readWorkspace(profileId);
    if (!workspace) {
      return {
        profileId,
        phase: network && !networkUsable(network) ? 'offline' : 'empty',
        workspace: null,
      };
    }
    const cached = { ...workspace, syncState: 'cached' as const };
    return {
      profileId,
      phase: network && !networkUsable(network) ? 'offline' : 'cached',
      workspace: cached,
      ...(workspace.syncError ? { error: workspace.syncError } : {}),
    };
  }

  async hydrateThenSync(input: {
    profileId: string;
    workerId: string;
    network: SyncNetworkState;
    trigger?: SyncTrigger;
    signal?: AbortSignal;
    onHydrated?: (snapshot: WorkspaceSyncSnapshot) => Promise<void> | void;
  }) {
    const hydrated = await this.hydrate(input.profileId, input.network);
    await input.onHydrated?.(hydrated);
    if (!networkUsable(input.network)) return hydrated;
    return this.sync({ ...input, trigger: input.trigger ?? 'cold-start' });
  }

  async sync(input: {
    profileId: string;
    workerId: string;
    network: SyncNetworkState;
    trigger: SyncTrigger;
    forceFull?: boolean;
    signal?: AbortSignal;
  }): Promise<WorkspaceSyncSnapshot> {
    const cached = await this.options.repository.readWorkspace(input.profileId);
    if (!networkUsable(input.network)) {
      return {
        profileId: input.profileId,
        phase: 'offline',
        workspace: cached ? { ...cached, syncState: 'cached' } : null,
        trigger: input.trigger,
      };
    }
    if (
      input.trigger === 'foreground'
      && !input.forceFull
      && cached?.syncState === 'current'
    ) {
      const lastSyncedAt = Date.parse(cached.lastSyncedAt);
      if (
        Number.isFinite(lastSyncedAt)
        && this.now().getTime() - lastSyncedAt < this.foregroundRefreshAgeMs
      ) {
        return {
          profileId: input.profileId,
          phase: 'current',
          workspace: cached,
          trigger: input.trigger,
        };
      }
    }

    const startedAt = this.now();
    const previousTask = await this.options.repository.readTask(input.profileId, 'workspace-sync');
    if (this.options.executionGuard && !await this.options.executionGuard()) {
      return {
        profileId: input.profileId,
        phase: 'busy',
        workspace: cached ? { ...cached, syncState: 'cached' } : null,
        trigger: input.trigger,
      };
    }
    const claimed = await this.options.repository.claimTask(
      syncTask(input.profileId, startedAt, input.trigger, previousTask),
      input.workerId,
      startedAt,
      this.leaseMs,
    );
    if (!claimed) {
      return {
        profileId: input.profileId,
        phase: 'busy',
        workspace: cached ? { ...cached, syncState: 'cached' } : null,
        trigger: input.trigger,
      };
    }

    try {
      let currentLease = claimed;
      const renewLease = async () => {
        if (this.options.executionGuard && !await this.options.executionGuard()) {
          throw new SyncLeaseLostError();
        }
        const renewed = await this.options.repository.renewTaskLease(
          input.profileId,
          currentLease.id,
          input.workerId,
          this.now(),
          this.leaseMs,
        );
        if (!renewed) throw new SyncLeaseLostError();
        currentLease = renewed;
      };
      const full = input.forceFull || needsFullSync(
        cached,
        startedAt,
        this.fullReconciliationIntervalMs,
      );
      const requestedMode = full ? 'full' : 'incremental';
      await renewLease();
      let remote = await this.options.transport.fetchWorkspace({
        profileId: input.profileId,
        mode: requestedMode,
        ...(full || !cached ? {} : { modifiedAfter: modifiedAfter(cached, this.overlapMs) }),
        overlapMs: this.overlapMs,
        signal: input.signal,
      });
      await renewLease();
      if (requestedMode === 'full' && remote.kind !== 'full') {
        throw new Error('Paperless did not return the requested full workspace reconciliation.');
      }

      if (remote.kind === 'incremental' && remote.requiresFullReconciliation) {
        remote = await this.options.transport.fetchWorkspace({
          profileId: input.profileId,
          mode: 'full',
          overlapMs: this.overlapMs,
          signal: input.signal,
        });
        await renewLease();
        if (remote.kind !== 'full') {
          throw new Error('Paperless did not return the requested full workspace reconciliation.');
        }
      }

      if (!cached && remote.kind !== 'full') {
        throw new Error('Paperless returned an incremental response without a cached workspace.');
      }
      const workspace = remote.kind === 'full'
        ? replaceFullWorkspace(input.profileId, remote, cached)
        : mergeIncrementalWorkspace(cached!, remote);

      const commitTime = this.now();
      const completedAt = commitTime.toISOString();
      const completedTask = {
        ...currentLease,
        stage: 'ready',
        progress: 1,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        error: undefined,
        result: { summary: 'Workspace synchronized.' },
        updatedAt: completedAt,
        completedAt,
      } satisfies PersistentTask;
      // Lease validation, workspace replacement, and terminal task persistence
      // are one repository transaction. A reclaimed or expired worker cannot
      // commit in the gap between a renewal and these writes.
      const committed = await this.options.repository.commitWorkspaceSync(
        workspace,
        currentLease,
        completedTask,
        commitTime,
      );
      if (!committed) throw new SyncLeaseLostError();
      return {
        profileId: input.profileId,
        phase: 'current',
        workspace,
        trigger: input.trigger,
      };
    } catch (error) {
      if (error instanceof SyncLeaseLostError) {
        const retained = await this.options.repository.readWorkspace(input.profileId);
        return {
          profileId: input.profileId,
          phase: 'busy',
          workspace: retained ? { ...retained, syncState: 'cached' } : null,
          trigger: input.trigger,
        };
      }
      const message = error instanceof Error
        ? error.message
        : translateRuntime('taskRuntime.syncFailed');
      const failedAt = this.now();
      const failureLease = await this.options.repository.renewTaskLease(
        input.profileId,
        claimed.id,
        input.workerId,
        failedAt,
        this.leaseMs,
      );
      if (!failureLease) {
        const retained = await this.options.repository.readWorkspace(input.profileId);
        return {
          profileId: input.profileId,
          phase: 'busy',
          workspace: retained ? { ...retained, syncState: 'cached' } : null,
          trigger: input.trigger,
        };
      }
      const failure = classifyTaskFailure(failureStatus(error), message);
      await this.options.repository.writeTask(scheduleTaskRetry(failureLease, failure, failedAt));
      await this.options.repository.writeWorkspaceError(input.profileId, message);
      const retained = await this.options.repository.readWorkspace(input.profileId);
      return {
        profileId: input.profileId,
        phase: 'error',
        workspace: retained,
        trigger: input.trigger,
        error: message,
      };
    }
  }
}
