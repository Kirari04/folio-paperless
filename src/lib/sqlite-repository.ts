import * as SQLite from 'expo-sqlite';

import type {
  CachedCapabilitySet,
  CachedDocumentDetail,
  CachedWorkspace,
  BulkDocumentReconciliation,
  CatalogMutationLabels,
  ConfirmedCatalogMutation,
  FolioRepository,
  OfflineFileRecord,
  ProfileDataCounts,
  ProfileRemovalManifestRecord,
  ProfileRemovalTombstone,
  RouteAlias,
  TaskNotificationClaim,
} from '@/types/persistence';
import type { PersistentTask, UploadPreset } from '@/types/tasks';
import {
  FOLIO_DATABASE_MIGRATIONS,
  FOLIO_DATABASE_VERSION,
  migrationsAfter,
  parseStoredJson,
} from './database-schema';
import { acquireTaskLease, migratePersistentTask } from './task-policy';
import { migrateUploadPreset } from './upload-metadata';
import { mergeWorkspaceSavedViewSnapshots } from './saved-view-offline-cache';
import { overlayPendingMetadataUpdates } from './metadata-update';
import {
  reconcileConfirmedBulkDocument,
  reconcileConfirmedBulkWorkspace,
} from './bulk-document-reconciliation';
import {
  reconcileCatalogDocumentMutation,
  reconcileCatalogWorkspaceMutation,
} from './catalog-management';

type JsonRow = { payload_json: string };
type CountRow = { count: number };

export class SQLiteFolioRepository implements FolioRepository {
  private databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly databaseName = 'folio.db') {}

  private database() {
    this.databasePromise ??= SQLite.openDatabaseAsync(this.databaseName);
    return this.databasePromise;
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const queued = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private exclusiveMutation(
    database: SQLite.SQLiteDatabase,
    mutation: (transaction: SQLite.SQLiteDatabase) => Promise<void>,
  ) {
    return this.enqueueMutation(() => database.withExclusiveTransactionAsync(mutation));
  }

  private queuedRunAsync(source: string, ...params: SQLite.SQLiteBindValue[]) {
    return this.enqueueMutation(async () => (
      (await this.database()).runAsync(source, ...params)
    ));
  }

  async initialize() {
    const database = await this.database();
    await database.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    const row = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    const currentVersion = row?.user_version ?? 0;
    for (const migration of migrationsAfter(currentVersion)) {
      await this.exclusiveMutation(database, async (transaction) => {
        await transaction.execAsync(migration.sql);
        await transaction.execAsync(`PRAGMA user_version = ${migration.version}`);
      });
    }
  }

  async readWorkspace(profileId: string) {
    const row = await (await this.database()).getFirstAsync<JsonRow>(
      'SELECT payload_json FROM workspaces WHERE profile_id = ?',
      profileId,
    );
    return row ? parseStoredJson<CachedWorkspace>(row.payload_json, 'workspace') : null;
  }

  async replaceWorkspace(workspace: CachedWorkspace) {
    const database = await this.database();
    await this.exclusiveMutation(database, async (transaction) => {
      const currentRow = await transaction.getFirstAsync<JsonRow>(
        'SELECT payload_json FROM workspaces WHERE profile_id = ?',
        workspace.profileId,
      );
      const current = currentRow
        ? parseStoredJson<CachedWorkspace>(currentRow.payload_json, 'workspace')
        : null;
      const pendingRows = await transaction.getAllAsync<JsonRow>(
        `SELECT payload_json FROM persistent_tasks
         WHERE profile_id = ? AND kind = 'metadata-update' AND stage NOT IN ('ready', 'canceled')`,
        workspace.profileId,
      );
      const pendingTasks = pendingRows.map((row) => (
        migratePersistentTask(parseStoredJson<unknown>(row.payload_json, 'metadata task'))
      ));
      const nextWorkspace = {
        ...workspace,
        documents: overlayPendingMetadataUpdates(workspace.documents, pendingTasks),
        savedViewSnapshots: mergeWorkspaceSavedViewSnapshots(current, workspace),
      };
      await transaction.runAsync(
        `INSERT INTO workspaces (
          profile_id, payload_json, last_synced_at, sync_state, sync_error
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(profile_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          last_synced_at = excluded.last_synced_at,
          sync_state = excluded.sync_state,
          sync_error = excluded.sync_error`,
        workspace.profileId,
        JSON.stringify(nextWorkspace),
        nextWorkspace.lastSyncedAt,
        nextWorkspace.syncState,
        nextWorkspace.syncError ?? null,
      );
    });
  }

  async reconcileBulkDocuments(
    profileId: string,
    reconciliation: BulkDocumentReconciliation,
  ) {
    const database = await this.database();
    let committed: CachedWorkspace | null = null;
    await this.exclusiveMutation(database, async (transaction) => {
      const row = await transaction.getFirstAsync<JsonRow>(
        'SELECT payload_json FROM workspaces WHERE profile_id = ?',
        profileId,
      );
      if (!row) return;
      const workspace = parseStoredJson<CachedWorkspace>(row.payload_json, 'workspace');
      const nextWorkspace = reconcileConfirmedBulkWorkspace(workspace, reconciliation);
      await transaction.runAsync(
        `UPDATE workspaces SET payload_json = ?, last_synced_at = ?, sync_state = ?, sync_error = ?
         WHERE profile_id = ?`,
        JSON.stringify(nextWorkspace),
        nextWorkspace.lastSyncedAt,
        nextWorkspace.syncState,
        nextWorkspace.syncError ?? null,
        profileId,
      );
      const detailRows = await transaction.getAllAsync<JsonRow & { document_id: string }>(
        'SELECT document_id, payload_json FROM document_details WHERE profile_id = ?',
        profileId,
      );
      for (const detailRow of detailRows) {
        const detail = parseStoredJson<CachedDocumentDetail>(detailRow.payload_json, 'document detail');
        const document = reconcileConfirmedBulkDocument(detail.document, reconciliation);
        if (!document) {
          await transaction.runAsync(
            'DELETE FROM document_details WHERE profile_id = ? AND document_id = ?',
            profileId,
            detailRow.document_id,
          );
        } else if (document !== detail.document) {
          await transaction.runAsync(
            `UPDATE document_details SET payload_json = ?
             WHERE profile_id = ? AND document_id = ?`,
            JSON.stringify({ ...detail, document }),
            profileId,
            detailRow.document_id,
          );
        }
      }
      committed = nextWorkspace;
    });
    return committed;
  }

  async upsertSavedView(profileId: string, view: import('@/types/document').PaperlessSavedView) {
    const database = await this.database();
    await this.exclusiveMutation(database, async (transaction) => {
      const row = await transaction.getFirstAsync<JsonRow>(
        'SELECT payload_json FROM workspaces WHERE profile_id = ?',
        profileId,
      );
      if (!row) throw new Error('A saved-view mutation requires an existing profile workspace.');
      const workspace = parseStoredJson<CachedWorkspace>(row.payload_json, 'workspace');
      const updated = {
        ...workspace,
        catalog: {
          ...workspace.catalog,
          savedViews: [
            ...(workspace.catalog.savedViews ?? []).filter(
              (item) => item.remoteId !== view.remoteId && item.id !== view.id,
            ),
            view,
          ].sort((left, right) => left.name.localeCompare(right.name)),
        },
        savedViewSnapshots: Object.fromEntries(
          Object.entries(workspace.savedViewSnapshots ?? {}).filter(
            ([key, snapshot]) => key !== view.id && snapshot.viewId !== view.id,
          ),
        ),
      };
      await transaction.runAsync(
        `UPDATE workspaces SET payload_json = ?, last_synced_at = ?, sync_state = ?, sync_error = ?
         WHERE profile_id = ?`,
        JSON.stringify(updated),
        updated.lastSyncedAt,
        updated.syncState,
        updated.syncError ?? null,
        profileId,
      );
    });
  }

  async deleteSavedView(profileId: string, remoteId: number) {
    const database = await this.database();
    await this.exclusiveMutation(database, async (transaction) => {
      const row = await transaction.getFirstAsync<JsonRow>(
        'SELECT payload_json FROM workspaces WHERE profile_id = ?',
        profileId,
      );
      if (!row) throw new Error('A saved-view mutation requires an existing profile workspace.');
      const workspace = parseStoredJson<CachedWorkspace>(row.payload_json, 'workspace');
      const deletedIds = new Set(
        workspace.catalog.savedViews
          .filter((view) => view.remoteId === remoteId)
          .map((view) => view.id),
      );
      const updated = {
        ...workspace,
        catalog: {
          ...workspace.catalog,
          savedViews: workspace.catalog.savedViews.filter((view) => view.remoteId !== remoteId),
        },
        savedViewSnapshots: Object.fromEntries(
          Object.entries(workspace.savedViewSnapshots ?? {}).filter(
            ([key, snapshot]) => !deletedIds.has(key) && !deletedIds.has(snapshot.viewId),
          ),
        ),
      };
      await transaction.runAsync(
        `UPDATE workspaces SET payload_json = ?, last_synced_at = ?, sync_state = ?, sync_error = ?
         WHERE profile_id = ?`,
        JSON.stringify(updated),
        updated.lastSyncedAt,
        updated.syncState,
        updated.syncError ?? null,
        profileId,
      );
    });
  }

  async reconcileCatalogMutation(
    profileId: string,
    mutation: ConfirmedCatalogMutation,
    labels: CatalogMutationLabels,
  ) {
    const database = await this.database();
    let committed: CachedWorkspace | null = null;
    await this.exclusiveMutation(database, async (transaction) => {
      const row = await transaction.getFirstAsync<JsonRow>(
        'SELECT payload_json FROM workspaces WHERE profile_id = ?',
        profileId,
      );
      if (!row) throw new Error('A catalog mutation requires an existing profile workspace.');
      const workspace = parseStoredJson<CachedWorkspace>(row.payload_json, 'workspace');
      const updated = reconcileCatalogWorkspaceMutation(workspace, mutation, labels);
      await transaction.runAsync(
        `UPDATE workspaces SET payload_json = ?, last_synced_at = ?, sync_state = ?, sync_error = ?
         WHERE profile_id = ?`,
        JSON.stringify(updated),
        updated.lastSyncedAt,
        updated.syncState,
        updated.syncError ?? null,
        profileId,
      );
      const detailRows = await transaction.getAllAsync<JsonRow & { document_id: string }>(
        'SELECT document_id, payload_json FROM document_details WHERE profile_id = ?',
        profileId,
      );
      for (const detailRow of detailRows) {
        const detail = parseStoredJson<CachedDocumentDetail>(detailRow.payload_json, 'document detail');
        const reconciled = reconcileCatalogDocumentMutation(detail.document, mutation, labels);
        await transaction.runAsync(
          `UPDATE document_details SET payload_json = ?
           WHERE profile_id = ? AND document_id = ?`,
          JSON.stringify({ ...detail, document: reconciled }),
          profileId,
          detailRow.document_id,
        );
      }
      committed = updated;
    });
    if (!committed) throw new Error('The catalog mutation did not commit.');
    return committed;
  }

  async writeSavedViewSnapshot(profileId: string, snapshot: import('@/types/persistence').CachedSavedViewSnapshot) {
    const database = await this.database();
    await this.exclusiveMutation(database, async (transaction) => {
      const row = await transaction.getFirstAsync<JsonRow>(
        'SELECT payload_json FROM workspaces WHERE profile_id = ?',
        profileId,
      );
      if (!row) throw new Error('A saved-view snapshot requires an existing profile workspace.');
      const workspace = parseStoredJson<CachedWorkspace>(row.payload_json, 'workspace');
      const updated = {
        ...workspace,
        savedViewSnapshots: { ...workspace.savedViewSnapshots, [snapshot.viewId]: snapshot },
      };
      await transaction.runAsync(
        `UPDATE workspaces SET payload_json = ?, last_synced_at = ?, sync_state = ?, sync_error = ?
         WHERE profile_id = ?`,
        JSON.stringify(updated),
        updated.lastSyncedAt,
        updated.syncState,
        updated.syncError ?? null,
        profileId,
      );
    });
  }

  async writeWorkspaceError(profileId: string, error: string) {
    const database = await this.database();
    await this.exclusiveMutation(database, async (transaction) => {
      const row = await transaction.getFirstAsync<JsonRow>(
        'SELECT payload_json FROM workspaces WHERE profile_id = ?',
        profileId,
      );
      if (!row) return;
      const current = parseStoredJson<CachedWorkspace>(row.payload_json, 'workspace');
      const updated = { ...current, syncState: 'error' as const, syncError: error };
      await transaction.runAsync(
        `UPDATE workspaces SET payload_json = ?, sync_state = ?, sync_error = ?
         WHERE profile_id = ?`,
        JSON.stringify(updated),
        updated.syncState,
        updated.syncError,
        profileId,
      );
    });
  }

  async readDocumentDetail(profileId: string, documentId: string) {
    const row = await (await this.database()).getFirstAsync<JsonRow>(
      'SELECT payload_json FROM document_details WHERE profile_id = ? AND document_id = ?',
      profileId,
      documentId,
    );
    return row ? parseStoredJson<CachedDocumentDetail>(row.payload_json, 'document detail') : null;
  }

  async writeDocumentDetail(detail: CachedDocumentDetail) {
    await this.queuedRunAsync(
      `INSERT INTO document_details (profile_id, document_id, payload_json, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, document_id) DO UPDATE SET
         payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`,
      detail.profileId,
      detail.documentId,
      JSON.stringify(detail),
      detail.fetchedAt,
    );
  }

  async listTasks(profileId: string) {
    const rows = await (await this.database()).getAllAsync<JsonRow>(
      'SELECT payload_json FROM persistent_tasks WHERE profile_id = ? ORDER BY updated_at DESC',
      profileId,
    );
    return rows.map((row) => migratePersistentTask(parseStoredJson<unknown>(row.payload_json, 'task')));
  }

  async readTask(profileId: string, taskId: string) {
    const row = await (await this.database()).getFirstAsync<JsonRow>(
      'SELECT payload_json FROM persistent_tasks WHERE profile_id = ? AND task_id = ?',
      profileId,
      taskId,
    );
    return row ? migratePersistentTask(parseStoredJson<unknown>(row.payload_json, 'task')) : null;
  }

  async writeTask(task: PersistentTask) {
    const result = await this.queuedRunAsync(
      `INSERT INTO persistent_tasks (
         profile_id, task_id, kind, stage, next_attempt_at, lease_owner,
         lease_expires_at, updated_at, payload_json
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM profile_removal_tombstones WHERE profile_id = ?
         )
       ON CONFLICT(profile_id, task_id) DO UPDATE SET
         kind = excluded.kind,
         stage = excluded.stage,
         next_attempt_at = excluded.next_attempt_at,
         lease_owner = excluded.lease_owner,
         lease_expires_at = excluded.lease_expires_at,
         updated_at = excluded.updated_at,
         payload_json = excluded.payload_json`,
      task.profileId,
      task.id,
      task.kind,
      task.stage,
      task.nextAttemptAt ?? null,
      task.leaseOwner ?? null,
      task.leaseExpiresAt ?? null,
      task.updatedAt,
      JSON.stringify(task),
      task.profileId,
    );
    if (result.changes !== 1) {
      throw new Error('The connection profile is being removed.');
    }
  }

  async writeTasks(tasks: readonly PersistentTask[]) {
    if (!tasks.length) return;
    const profileId = tasks[0].profileId;
    if (tasks.some((task) => task.profileId !== profileId)) {
      throw new Error('A task batch cannot cross connection profiles.');
    }
    const database = await this.database();
    await this.exclusiveMutation(database, async (transaction) => {
      const removal = await transaction.getFirstAsync<{ operation_id: string }>(
        'SELECT operation_id FROM profile_removal_tombstones WHERE profile_id = ?',
        profileId,
      );
      if (removal) throw new Error('The connection profile is being removed.');
      for (const task of tasks) {
        await transaction.runAsync(
          `INSERT INTO persistent_tasks (
             profile_id, task_id, kind, stage, next_attempt_at, lease_owner,
             lease_expires_at, updated_at, payload_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(profile_id, task_id) DO UPDATE SET
             kind = excluded.kind,
             stage = excluded.stage,
             next_attempt_at = excluded.next_attempt_at,
             lease_owner = excluded.lease_owner,
             lease_expires_at = excluded.lease_expires_at,
             updated_at = excluded.updated_at,
             payload_json = excluded.payload_json`,
          task.profileId,
          task.id,
          task.kind,
          task.stage,
          task.nextAttemptAt ?? null,
          task.leaseOwner ?? null,
          task.leaseExpiresAt ?? null,
          task.updatedAt,
          JSON.stringify(task),
        );
      }
    });
  }

  async claimTask(
    task: PersistentTask,
    workerId: string,
    now: Date,
    leaseMs = 2 * 60_000,
  ) {
    const database = await this.database();
    let claimed: PersistentTask | null = null;
    await this.exclusiveMutation(database, async (transaction) => {
      const removal = await transaction.getFirstAsync<{ operation_id: string }>(
        'SELECT operation_id FROM profile_removal_tombstones WHERE profile_id = ?',
        task.profileId,
      );
      if (removal) return;
      const row = await transaction.getFirstAsync<JsonRow>(
        'SELECT payload_json FROM persistent_tasks WHERE profile_id = ? AND task_id = ?',
        task.profileId,
        task.id,
      );
      const existing = row ? migratePersistentTask(parseStoredJson<unknown>(row.payload_json, 'task')) : null;
      const existingExpiry = existing?.leaseExpiresAt ? Date.parse(existing.leaseExpiresAt) : 0;
      if (existing?.leaseOwner && existing.leaseOwner !== workerId && existingExpiry > now.getTime()) {
        return;
      }
      const leased = acquireTaskLease(
        { ...task, createdAt: existing?.createdAt ?? task.createdAt },
        workerId,
        now,
        leaseMs,
      );
      if (!leased) return;
      await transaction.runAsync(
        `INSERT INTO persistent_tasks (
           profile_id, task_id, kind, stage, next_attempt_at, lease_owner,
           lease_expires_at, updated_at, payload_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, task_id) DO UPDATE SET
           kind = excluded.kind,
           stage = excluded.stage,
           next_attempt_at = excluded.next_attempt_at,
           lease_owner = excluded.lease_owner,
           lease_expires_at = excluded.lease_expires_at,
           updated_at = excluded.updated_at,
           payload_json = excluded.payload_json`,
        leased.profileId,
        leased.id,
        leased.kind,
        leased.stage,
        leased.nextAttemptAt ?? null,
        leased.leaseOwner ?? null,
        leased.leaseExpiresAt ?? null,
        leased.updatedAt,
        JSON.stringify(leased),
      );
      claimed = leased;
    });
    return claimed;
  }

  async renewTaskLease(
    profileId: string,
    taskId: string,
    workerId: string,
    now: Date,
    leaseMs = 2 * 60_000,
  ) {
    const database = await this.database();
    let renewed: PersistentTask | null = null;
    await this.exclusiveMutation(database, async (transaction) => {
      const removal = await transaction.getFirstAsync<{ operation_id: string }>(
        'SELECT operation_id FROM profile_removal_tombstones WHERE profile_id = ?',
        profileId,
      );
      if (removal) return;
      const row = await transaction.getFirstAsync<JsonRow>(
        'SELECT payload_json FROM persistent_tasks WHERE profile_id = ? AND task_id = ?',
        profileId,
        taskId,
      );
      const existing = row ? migratePersistentTask(parseStoredJson<unknown>(row.payload_json, 'task')) : null;
      const expiry = existing?.leaseExpiresAt ? Date.parse(existing.leaseExpiresAt) : 0;
      if (!existing || existing.leaseOwner !== workerId || expiry <= now.getTime()) return;
      renewed = {
        ...existing,
        leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
        updatedAt: now.toISOString(),
      };
      await transaction.runAsync(
        `UPDATE persistent_tasks
         SET lease_expires_at = ?, updated_at = ?, payload_json = ?
         WHERE profile_id = ? AND task_id = ?`,
        renewed.leaseExpiresAt ?? null,
        renewed.updatedAt,
        JSON.stringify(renewed),
        profileId,
        taskId,
      );
    });
    return renewed;
  }

  async commitWorkspaceSync(
    workspace: CachedWorkspace,
    expectedLease: PersistentTask,
    completedTask: PersistentTask,
    now: Date,
  ) {
    if (
      workspace.profileId !== expectedLease.profileId
      || completedTask.profileId !== expectedLease.profileId
      || completedTask.id !== expectedLease.id
      || completedTask.stage !== 'ready'
    ) throw new Error('A workspace sync commit must retain one profile, task, and terminal state.');
    const database = await this.database();
    let committed = false;
    await this.exclusiveMutation(database, async (transaction) => {
      const removal = await transaction.getFirstAsync<{ operation_id: string }>(
        'SELECT operation_id FROM profile_removal_tombstones WHERE profile_id = ?',
        expectedLease.profileId,
      );
      if (removal) return;
      const row = await transaction.getFirstAsync<JsonRow>(
        'SELECT payload_json FROM persistent_tasks WHERE profile_id = ? AND task_id = ?',
        expectedLease.profileId,
        expectedLease.id,
      );
      const existing = row ? migratePersistentTask(parseStoredJson<unknown>(row.payload_json, 'task')) : null;
      const expiry = existing?.leaseExpiresAt ? Date.parse(existing.leaseExpiresAt) : 0;
      if (
        !existing
        || !expectedLease.leaseOwner
        || existing.leaseOwner !== expectedLease.leaseOwner
        || existing.leaseExpiresAt !== expectedLease.leaseExpiresAt
        || existing.updatedAt !== expectedLease.updatedAt
        || expiry <= now.getTime()
      ) return;
      const workspaceRow = await transaction.getFirstAsync<JsonRow>(
        'SELECT payload_json FROM workspaces WHERE profile_id = ?',
        workspace.profileId,
      );
      const currentWorkspace = workspaceRow
        ? parseStoredJson<CachedWorkspace>(workspaceRow.payload_json, 'workspace')
        : null;
      const pendingRows = await transaction.getAllAsync<JsonRow>(
        `SELECT payload_json FROM persistent_tasks
         WHERE profile_id = ? AND kind = 'metadata-update' AND stage NOT IN ('ready', 'canceled')`,
        workspace.profileId,
      );
      const pendingTasks = pendingRows.map((pendingRow) => (
        migratePersistentTask(parseStoredJson<unknown>(pendingRow.payload_json, 'metadata task'))
      ));
      const committedWorkspace = {
        ...workspace,
        documents: overlayPendingMetadataUpdates(workspace.documents, pendingTasks),
        savedViewSnapshots: mergeWorkspaceSavedViewSnapshots(currentWorkspace, workspace),
      };
      await transaction.runAsync(
        `INSERT INTO workspaces (
          profile_id, payload_json, last_synced_at, sync_state, sync_error
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(profile_id) DO UPDATE SET
          payload_json = excluded.payload_json,
          last_synced_at = excluded.last_synced_at,
          sync_state = excluded.sync_state,
          sync_error = excluded.sync_error`,
        workspace.profileId,
        JSON.stringify(committedWorkspace),
        committedWorkspace.lastSyncedAt,
        committedWorkspace.syncState,
        committedWorkspace.syncError ?? null,
      );
      await transaction.runAsync(
        `UPDATE persistent_tasks
         SET kind = ?, stage = ?, next_attempt_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?, payload_json = ?
         WHERE profile_id = ? AND task_id = ?`,
        completedTask.kind,
        completedTask.stage,
        completedTask.nextAttemptAt ?? null,
        completedTask.updatedAt,
        JSON.stringify(completedTask),
        completedTask.profileId,
        completedTask.id,
      );
      committed = true;
    });
    return committed;
  }

  async claimNextRunnableTask(
    profileId: string,
    workerId: string,
    now: Date,
    leaseMs = 2 * 60_000,
  ) {
    const database = await this.database();
    let claimed: PersistentTask | null = null;
    await this.exclusiveMutation(database, async (transaction) => {
      const removal = await transaction.getFirstAsync<{ operation_id: string }>(
        'SELECT operation_id FROM profile_removal_tombstones WHERE profile_id = ?',
        profileId,
      );
      if (removal) return;
      const rows = await transaction.getAllAsync<JsonRow>(
        `SELECT payload_json FROM persistent_tasks
         WHERE profile_id = ?
           AND kind IN ('upload', 'paperless-processing', 'pdf-operation', 'bulk-operation')
           AND (
             stage IN ('queued', 'uploading', 'processing')
             OR (stage = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
           )
           AND (lease_expires_at IS NULL OR lease_expires_at <= ? OR lease_owner = ?)
         ORDER BY updated_at ASC`,
        profileId,
        now.toISOString(),
        now.toISOString(),
        workerId,
      );
      for (const row of rows) {
        const task = migratePersistentTask(parseStoredJson<unknown>(row.payload_json, 'task'));
        const leased = acquireTaskLease(task, workerId, now, leaseMs);
        // A legacy payload can migrate to a non-runnable stage while its
        // denormalized column still matches the query. Skip it so one safe,
        // uncertain upload cannot starve unrelated queued work.
        if (!leased) continue;
        const result = await transaction.runAsync(
          `UPDATE persistent_tasks
           SET lease_owner = ?, lease_expires_at = ?, updated_at = ?, payload_json = ?
           WHERE profile_id = ? AND task_id = ?
             AND (lease_expires_at IS NULL OR lease_expires_at <= ? OR lease_owner = ?)`,
          leased.leaseOwner!,
          leased.leaseExpiresAt!,
          leased.updatedAt,
          JSON.stringify(leased),
          profileId,
          leased.id,
          now.toISOString(),
          workerId,
        );
        if (result.changes === 1) {
          claimed = leased;
          break;
        }
      }
    });
    return claimed;
  }

  async claimNextMetadataTask(
    profileId: string,
    workerId: string,
    now: Date,
    leaseMs = 2 * 60_000,
  ) {
    const database = await this.database();
    let claimed: PersistentTask | null = null;
    await this.exclusiveMutation(database, async (transaction) => {
      const removal = await transaction.getFirstAsync<{ operation_id: string }>(
        'SELECT operation_id FROM profile_removal_tombstones WHERE profile_id = ?',
        profileId,
      );
      if (removal) return;
      const row = await transaction.getFirstAsync<JsonRow>(
        `SELECT payload_json FROM persistent_tasks
         WHERE profile_id = ? AND kind = 'metadata-update'
           AND (
             stage = 'queued'
             OR (stage = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
           )
           AND (lease_expires_at IS NULL OR lease_expires_at <= ? OR lease_owner = ?)
         ORDER BY updated_at ASC LIMIT 1`,
        profileId,
        now.toISOString(),
        now.toISOString(),
        workerId,
      );
      if (!row) return;
      const task = migratePersistentTask(parseStoredJson<unknown>(row.payload_json, 'metadata task'));
      const leased = acquireTaskLease(task, workerId, now, leaseMs);
      if (!leased) return;
      const result = await transaction.runAsync(
        `UPDATE persistent_tasks
         SET lease_owner = ?, lease_expires_at = ?, updated_at = ?, payload_json = ?
         WHERE profile_id = ? AND task_id = ?
           AND (lease_expires_at IS NULL OR lease_expires_at <= ? OR lease_owner = ?)`,
        leased.leaseOwner!,
        leased.leaseExpiresAt!,
        leased.updatedAt,
        JSON.stringify(leased),
        profileId,
        leased.id,
        now.toISOString(),
        workerId,
      );
      if (result.changes === 1) claimed = leased;
    });
    return claimed;
  }

  async claimNextOfflineDownloadTask(
    profileId: string,
    workerId: string,
    now: Date,
    leaseMs = 2 * 60_000,
  ) {
    const database = await this.database();
    let claimed: PersistentTask | null = null;
    await this.exclusiveMutation(database, async (transaction) => {
      const removal = await transaction.getFirstAsync<{ operation_id: string }>(
        'SELECT operation_id FROM profile_removal_tombstones WHERE profile_id = ?',
        profileId,
      );
      if (removal) return;
      const row = await transaction.getFirstAsync<JsonRow>(
        `SELECT payload_json FROM persistent_tasks
         WHERE profile_id = ? AND kind = 'offline-download'
           AND (
             stage IN ('queued', 'uploading')
             OR (stage = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
           )
           AND (lease_expires_at IS NULL OR lease_expires_at <= ? OR lease_owner = ?)
         ORDER BY updated_at ASC LIMIT 1`,
        profileId,
        now.toISOString(),
        now.toISOString(),
        workerId,
      );
      if (!row) return;
      const task = migratePersistentTask(parseStoredJson<unknown>(row.payload_json, 'offline download task'));
      const leased = acquireTaskLease(task, workerId, now, leaseMs);
      if (!leased) return;
      const result = await transaction.runAsync(
        `UPDATE persistent_tasks
         SET lease_owner = ?, lease_expires_at = ?, updated_at = ?, payload_json = ?
         WHERE profile_id = ? AND task_id = ?
           AND (lease_expires_at IS NULL OR lease_expires_at <= ? OR lease_owner = ?)`,
        leased.leaseOwner!,
        leased.leaseExpiresAt!,
        leased.updatedAt,
        JSON.stringify(leased),
        profileId,
        leased.id,
        now.toISOString(),
        workerId,
      );
      if (result.changes === 1) claimed = leased;
    });
    return claimed;
  }

  async updateLeasedTask(
    expectedLease: PersistentTask,
    updatedTask: PersistentTask,
    now: Date,
  ) {
    if (
      expectedLease.profileId !== updatedTask.profileId
      || expectedLease.id !== updatedTask.id
      || expectedLease.kind !== updatedTask.kind
    ) throw new Error('A leased task update must retain its profile, identity, and kind.');
    const database = await this.database();
    let committed: PersistentTask | null = null;
    await this.exclusiveMutation(database, async (transaction) => {
      const removal = await transaction.getFirstAsync<{ operation_id: string }>(
        'SELECT operation_id FROM profile_removal_tombstones WHERE profile_id = ?',
        expectedLease.profileId,
      );
      if (removal) return;
      const row = await transaction.getFirstAsync<JsonRow>(
        'SELECT payload_json FROM persistent_tasks WHERE profile_id = ? AND task_id = ?',
        expectedLease.profileId,
        expectedLease.id,
      );
      const existing = row
        ? migratePersistentTask(parseStoredJson<unknown>(row.payload_json, 'leased task'))
        : null;
      const expiry = existing?.leaseExpiresAt ? Date.parse(existing.leaseExpiresAt) : 0;
      if (
        !existing
        || !expectedLease.leaseOwner
        || existing.leaseOwner !== expectedLease.leaseOwner
        || existing.leaseExpiresAt !== expectedLease.leaseExpiresAt
        || existing.updatedAt !== expectedLease.updatedAt
        || expiry <= now.getTime()
      ) return;
      const result = await transaction.runAsync(
        `UPDATE persistent_tasks
         SET kind = ?, stage = ?, next_attempt_at = ?, lease_owner = ?,
             lease_expires_at = ?, updated_at = ?, payload_json = ?
         WHERE profile_id = ? AND task_id = ?`,
        updatedTask.kind,
        updatedTask.stage,
        updatedTask.nextAttemptAt ?? null,
        updatedTask.leaseOwner ?? null,
        updatedTask.leaseExpiresAt ?? null,
        updatedTask.updatedAt,
        JSON.stringify(updatedTask),
        updatedTask.profileId,
        updatedTask.id,
      );
      if (result.changes === 1) committed = updatedTask;
    });
    return committed;
  }

  async writeMetadataTask(
    task: PersistentTask,
    workspaceDocument: import('@/types/document').DocumentItem,
    detailDocument?: import('@/types/document').DocumentItem,
  ) {
    if (task.kind !== 'metadata-update' || task.metadataUpdate?.documentId !== workspaceDocument.id) {
      throw new Error('A metadata cache mutation must match its durable task target.');
    }
    const database = await this.database();
    await this.exclusiveMutation(database, async (transaction) => {
      const row = await transaction.getFirstAsync<JsonRow>(
        'SELECT payload_json FROM workspaces WHERE profile_id = ?',
        task.profileId,
      );
      if (!row) throw new Error('A metadata update requires a cached profile document.');
      const workspace = parseStoredJson<CachedWorkspace>(row.payload_json, 'workspace');
      if (!workspace.documents.some((document) => document.id === workspaceDocument.id)) {
        throw new Error('A metadata update requires a cached profile document.');
      }
      const updatedWorkspace = {
        ...workspace,
        documents: workspace.documents.map((document) => (
          document.id === workspaceDocument.id ? workspaceDocument : document
        )),
      };
      await transaction.runAsync(
        `UPDATE workspaces SET payload_json = ?, last_synced_at = ?, sync_state = ?, sync_error = ?
         WHERE profile_id = ?`,
        JSON.stringify(updatedWorkspace),
        updatedWorkspace.lastSyncedAt,
        updatedWorkspace.syncState,
        updatedWorkspace.syncError ?? null,
        task.profileId,
      );
      if (detailDocument) {
        await transaction.runAsync(
          `INSERT INTO document_details (profile_id, document_id, payload_json, fetched_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(profile_id, document_id) DO UPDATE SET
             payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`,
          task.profileId,
          detailDocument.id,
          JSON.stringify({
            profileId: task.profileId,
            documentId: detailDocument.id,
            document: detailDocument,
            fetchedAt: task.updatedAt,
          } satisfies CachedDocumentDetail),
          task.updatedAt,
        );
      }
      await transaction.runAsync(
        `INSERT INTO persistent_tasks (
           profile_id, task_id, kind, stage, next_attempt_at, lease_owner,
           lease_expires_at, updated_at, payload_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(profile_id, task_id) DO UPDATE SET
           kind = excluded.kind, stage = excluded.stage,
           next_attempt_at = excluded.next_attempt_at, lease_owner = excluded.lease_owner,
           lease_expires_at = excluded.lease_expires_at, updated_at = excluded.updated_at,
           payload_json = excluded.payload_json`,
        task.profileId,
        task.id,
        task.kind,
        task.stage,
        task.nextAttemptAt ?? null,
        task.leaseOwner ?? null,
        task.leaseExpiresAt ?? null,
        task.updatedAt,
        JSON.stringify(task),
      );
    });
  }

  async commitMetadataTask(
    expectedLease: PersistentTask,
    completedTask: PersistentTask,
    serverDocument: import('@/types/document').DocumentItem | null,
    now: Date,
  ) {
    if (
      expectedLease.kind !== 'metadata-update'
      || completedTask.kind !== 'metadata-update'
      || expectedLease.profileId !== completedTask.profileId
      || expectedLease.id !== completedTask.id
    ) throw new Error('A metadata task commit must retain one profile and task.');
    const database = await this.database();
    let committed = false;
    await this.exclusiveMutation(database, async (transaction) => {
      const removal = await transaction.getFirstAsync<{ operation_id: string }>(
        'SELECT operation_id FROM profile_removal_tombstones WHERE profile_id = ?',
        expectedLease.profileId,
      );
      if (removal) return;
      const row = await transaction.getFirstAsync<JsonRow>(
        'SELECT payload_json FROM persistent_tasks WHERE profile_id = ? AND task_id = ?',
        expectedLease.profileId,
        expectedLease.id,
      );
      const existing = row
        ? migratePersistentTask(parseStoredJson<unknown>(row.payload_json, 'metadata task'))
        : null;
      const expiry = existing?.leaseExpiresAt ? Date.parse(existing.leaseExpiresAt) : 0;
      if (
        !existing
        || !expectedLease.leaseOwner
        || existing.leaseOwner !== expectedLease.leaseOwner
        || existing.leaseExpiresAt !== expectedLease.leaseExpiresAt
        || existing.updatedAt !== expectedLease.updatedAt
        || expiry <= now.getTime()
      ) return;
      if (serverDocument) {
        const workspaceRow = await transaction.getFirstAsync<JsonRow>(
          'SELECT payload_json FROM workspaces WHERE profile_id = ?',
          expectedLease.profileId,
        );
        if (workspaceRow) {
          const workspace = parseStoredJson<CachedWorkspace>(workspaceRow.payload_json, 'workspace');
          const updatedWorkspace = {
            ...workspace,
            documents: workspace.documents.map((document) => (
              document.id === serverDocument.id ? serverDocument : document
            )),
          };
          await transaction.runAsync(
            `UPDATE workspaces SET payload_json = ?, last_synced_at = ?, sync_state = ?, sync_error = ?
             WHERE profile_id = ?`,
            JSON.stringify(updatedWorkspace),
            updatedWorkspace.lastSyncedAt,
            updatedWorkspace.syncState,
            updatedWorkspace.syncError ?? null,
            expectedLease.profileId,
          );
        }
        await transaction.runAsync(
          `INSERT INTO document_details (profile_id, document_id, payload_json, fetched_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(profile_id, document_id) DO UPDATE SET
             payload_json = excluded.payload_json, fetched_at = excluded.fetched_at`,
          expectedLease.profileId,
          serverDocument.id,
          JSON.stringify({
            profileId: expectedLease.profileId,
            documentId: serverDocument.id,
            document: serverDocument,
            fetchedAt: completedTask.updatedAt,
          } satisfies CachedDocumentDetail),
          completedTask.updatedAt,
        );
      }
      const result = await transaction.runAsync(
        `UPDATE persistent_tasks
         SET kind = ?, stage = ?, next_attempt_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ?, payload_json = ?
         WHERE profile_id = ? AND task_id = ?`,
        completedTask.kind,
        completedTask.stage,
        completedTask.nextAttemptAt ?? null,
        completedTask.updatedAt,
        JSON.stringify(completedTask),
        completedTask.profileId,
        completedTask.id,
      );
      committed = result.changes === 1;
    });
    return committed;
  }

  async deleteTask(profileId: string, taskId: string) {
    await this.queuedRunAsync(
      'DELETE FROM persistent_tasks WHERE profile_id = ? AND task_id = ?',
      profileId,
      taskId,
    );
  }

  async listPresets(profileId: string) {
    const rows = await (await this.database()).getAllAsync<JsonRow>(
      'SELECT payload_json FROM upload_presets WHERE profile_id = ? ORDER BY updated_at DESC',
      profileId,
    );
    return rows.map((row) => migrateUploadPreset(
      parseStoredJson<unknown>(row.payload_json, 'upload preset'),
      profileId,
    ));
  }

  async writePreset(preset: UploadPreset) {
    await this.queuedRunAsync(
      `INSERT INTO upload_presets (profile_id, preset_id, updated_at, payload_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, preset_id) DO UPDATE SET
         updated_at = excluded.updated_at, payload_json = excluded.payload_json`,
      preset.profileId,
      preset.id,
      preset.updatedAt,
      JSON.stringify(preset),
    );
  }

  async deletePreset(profileId: string, presetId: string) {
    await this.queuedRunAsync(
      'DELETE FROM upload_presets WHERE profile_id = ? AND preset_id = ?',
      profileId,
      presetId,
    );
  }

  async readRouteAlias(profileId: string, sourceId: string) {
    const row = await (await this.database()).getFirstAsync<{
      profile_id: string;
      source_id: string;
      target_id: string;
      created_at: string;
    }>('SELECT * FROM route_aliases WHERE profile_id = ? AND source_id = ?', profileId, sourceId);
    return row ? {
      profileId: row.profile_id,
      sourceId: row.source_id,
      targetId: row.target_id,
      createdAt: row.created_at,
    } satisfies RouteAlias : null;
  }

  async writeRouteAlias(alias: RouteAlias) {
    await this.queuedRunAsync(
      `INSERT INTO route_aliases (profile_id, source_id, target_id, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, source_id) DO UPDATE SET
         target_id = excluded.target_id, created_at = excluded.created_at`,
      alias.profileId,
      alias.sourceId,
      alias.targetId,
      alias.createdAt,
    );
  }

  async listRouteAliases(profileId: string) {
    const rows = await (await this.database()).getAllAsync<{
      profile_id: string;
      source_id: string;
      target_id: string;
      created_at: string;
    }>('SELECT * FROM route_aliases WHERE profile_id = ?', profileId);
    return rows.map((row) => ({
      profileId: row.profile_id,
      sourceId: row.source_id,
      targetId: row.target_id,
      createdAt: row.created_at,
    }));
  }

  async listOfflineFiles(profileId: string) {
    const rows = await (await this.database()).getAllAsync<{
      profile_id: string;
      document_id: string;
      representation: OfflineFileRecord['representation'];
      uri: string;
      file_name: string | null;
      mime_type: string | null;
      byte_size: number;
      pinned: number;
      last_accessed_at: string;
      created_at: string;
    }>('SELECT * FROM offline_files WHERE profile_id = ?', profileId);
    return rows.map((row) => ({
      profileId: row.profile_id,
      documentId: row.document_id,
      representation: row.representation,
      uri: row.uri,
      ...(row.file_name ? { fileName: row.file_name } : {}),
      ...(row.mime_type ? { mimeType: row.mime_type } : {}),
      byteSize: row.byte_size,
      pinned: row.pinned === 1,
      lastAccessedAt: row.last_accessed_at,
      createdAt: row.created_at,
    }));
  }

  async writeOfflineFile(file: OfflineFileRecord) {
    await this.queuedRunAsync(
      `INSERT INTO offline_files (
         profile_id, document_id, representation, uri, byte_size, pinned,
         last_accessed_at, created_at, file_name, mime_type
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, document_id, representation) DO UPDATE SET
         uri = excluded.uri, byte_size = excluded.byte_size, pinned = excluded.pinned,
         last_accessed_at = excluded.last_accessed_at,
         file_name = excluded.file_name, mime_type = excluded.mime_type`,
      file.profileId,
      file.documentId,
      file.representation,
      file.uri,
      file.byteSize,
      file.pinned ? 1 : 0,
      file.lastAccessedAt,
      file.createdAt,
      file.fileName ?? null,
      file.mimeType ?? null,
    );
  }

  async deleteOfflineFile(
    profileId: string,
    documentId: string,
    representation: OfflineFileRecord['representation'],
  ) {
    await this.queuedRunAsync(
      `DELETE FROM offline_files
       WHERE profile_id = ? AND document_id = ? AND representation = ?`,
      profileId,
      documentId,
      representation,
    );
  }

  async claimTaskNotification(
    profileId: string,
    taskId: string,
    workerId: string,
    dispatchId: string,
    now: Date,
    leaseMs = 60_000,
  ) {
    const database = await this.database();
    let claim: TaskNotificationClaim | null = null;
    await this.exclusiveMutation(database, async (transaction) => {
      const removal = await transaction.getFirstAsync<{ operation_id: string }>(
        'SELECT operation_id FROM profile_removal_tombstones WHERE profile_id = ?',
        profileId,
      );
      if (removal) return;
      const taskRow = await transaction.getFirstAsync<JsonRow>(
        'SELECT payload_json FROM persistent_tasks WHERE profile_id = ? AND task_id = ?',
        profileId,
        taskId,
      );
      const task = taskRow
        ? migratePersistentTask(parseStoredJson<unknown>(taskRow.payload_json, 'notification task'))
        : null;
      if (!task || task.notificationSentAt) return;
      const existing = await transaction.getFirstAsync<{
        dispatch_id: string;
        state: string;
        lease_owner: string | null;
        lease_expires_at: string | null;
        updated_at: string;
      }>(
        `SELECT dispatch_id, state, lease_owner, lease_expires_at, updated_at
         FROM task_notification_outbox WHERE profile_id = ? AND task_id = ?`,
        profileId,
        taskId,
      );
      const expiry = existing?.lease_expires_at ? Date.parse(existing.lease_expires_at) : 0;
      if (
        existing?.state === 'sent'
        || (existing?.lease_owner && existing.lease_owner !== workerId && expiry > now.getTime())
      ) return;
      claim = {
        profileId,
        taskId,
        dispatchId: existing?.dispatch_id ?? dispatchId,
        leaseOwner: workerId,
        leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
        updatedAt: now.toISOString(),
      };
      await transaction.runAsync(
        `INSERT INTO task_notification_outbox (
           profile_id, task_id, dispatch_id, state, lease_owner, lease_expires_at, updated_at
         ) VALUES (?, ?, ?, 'pending', ?, ?, ?)
         ON CONFLICT(profile_id, task_id) DO UPDATE SET
           lease_owner = excluded.lease_owner,
           lease_expires_at = excluded.lease_expires_at,
           updated_at = excluded.updated_at`,
        profileId,
        taskId,
        claim.dispatchId,
        claim.leaseOwner,
        claim.leaseExpiresAt,
        claim.updatedAt,
      );
    });
    return claim;
  }

  async completeTaskNotification(claim: TaskNotificationClaim, now: Date) {
    const database = await this.database();
    let completed: PersistentTask | null = null;
    await this.exclusiveMutation(database, async (transaction) => {
      const removal = await transaction.getFirstAsync<{ operation_id: string }>(
        'SELECT operation_id FROM profile_removal_tombstones WHERE profile_id = ?',
        claim.profileId,
      );
      if (removal) return;
      const outbox = await transaction.getFirstAsync<{
        dispatch_id: string;
        state: string;
        lease_owner: string | null;
        lease_expires_at: string | null;
        updated_at: string;
      }>(
        `SELECT dispatch_id, state, lease_owner, lease_expires_at, updated_at
         FROM task_notification_outbox WHERE profile_id = ? AND task_id = ?`,
        claim.profileId,
        claim.taskId,
      );
      const expiry = outbox?.lease_expires_at ? Date.parse(outbox.lease_expires_at) : 0;
      if (
        !outbox
        || outbox.state !== 'pending'
        || outbox.dispatch_id !== claim.dispatchId
        || outbox.lease_owner !== claim.leaseOwner
        || outbox.lease_expires_at !== claim.leaseExpiresAt
        || outbox.updated_at !== claim.updatedAt
        || expiry <= now.getTime()
      ) return;
      const taskRow = await transaction.getFirstAsync<JsonRow>(
        'SELECT payload_json FROM persistent_tasks WHERE profile_id = ? AND task_id = ?',
        claim.profileId,
        claim.taskId,
      );
      if (!taskRow) return;
      const task = migratePersistentTask(parseStoredJson<unknown>(taskRow.payload_json, 'notification task'));
      completed = { ...task, notificationSentAt: now.toISOString() };
      await transaction.runAsync(
        'UPDATE persistent_tasks SET payload_json = ? WHERE profile_id = ? AND task_id = ?',
        JSON.stringify(completed),
        claim.profileId,
        claim.taskId,
      );
      await transaction.runAsync(
        `UPDATE task_notification_outbox
         SET state = 'sent', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE profile_id = ? AND task_id = ?`,
        now.toISOString(),
        claim.profileId,
        claim.taskId,
      );
    });
    return completed;
  }

  async releaseTaskNotification(claim: TaskNotificationClaim, now: Date) {
    const result = await this.queuedRunAsync(
      `UPDATE task_notification_outbox
       SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE profile_id = ? AND task_id = ? AND state = 'pending'
         AND dispatch_id = ? AND lease_owner = ? AND lease_expires_at = ? AND updated_at = ?
         AND NOT EXISTS (
           SELECT 1 FROM profile_removal_tombstones WHERE profile_id = ?
         )`,
      now.toISOString(),
      claim.profileId,
      claim.taskId,
      claim.dispatchId,
      claim.leaseOwner,
      claim.leaseExpiresAt,
      claim.updatedAt,
      claim.profileId,
    );
    return result.changes === 1;
  }

  async readCapabilities(profileId: string) {
    const row = await (await this.database()).getFirstAsync<JsonRow>(
      'SELECT payload_json FROM capabilities WHERE profile_id = ?',
      profileId,
    );
    return row ? parseStoredJson<CachedCapabilitySet>(row.payload_json, 'capabilities') : null;
  }

  async writeCapabilities(capabilities: CachedCapabilitySet) {
    await this.queuedRunAsync(
      `INSERT INTO capabilities (profile_id, fingerprint, discovered_at, payload_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         discovered_at = excluded.discovered_at,
         payload_json = excluded.payload_json`,
      capabilities.profileId,
      capabilities.fingerprint,
      capabilities.discoveredAt,
      JSON.stringify(capabilities),
    );
  }

  async profileDataCounts(profileId: string): Promise<ProfileDataCounts> {
    const database = await this.database();
    const workspace = await this.readWorkspace(profileId);
    const count = async (table: 'persistent_tasks' | 'upload_presets' | 'offline_files') => {
      const row = await database.getFirstAsync<CountRow>(
        `SELECT COUNT(*) AS count FROM ${table} WHERE profile_id = ?`,
        profileId,
      );
      return row?.count ?? 0;
    };
    return {
      documents: workspace?.documents.length ?? 0,
      tasks: await count('persistent_tasks'),
      presets: await count('upload_presets'),
      offlineFiles: await count('offline_files'),
    };
  }

  async deleteProfileData(profileId: string) {
    const database = await this.database();
    await this.exclusiveMutation(database, async (transaction) => {
      for (const table of [
        'workspaces',
        'document_details',
        'persistent_tasks',
        'route_aliases',
        'upload_presets',
        'offline_files',
        'task_notification_outbox',
        'capabilities',
      ] as const) {
        await transaction.runAsync(`DELETE FROM ${table} WHERE profile_id = ?`, profileId);
      }
    });
  }

  async deleteProfileDataAndWriteRemovalTombstone(tombstone: ProfileRemovalTombstone) {
    const database = await this.database();
    await this.exclusiveMutation(database, async (transaction) => {
      for (const table of [
        'workspaces',
        'document_details',
        'persistent_tasks',
        'route_aliases',
        'upload_presets',
        'offline_files',
        'task_notification_outbox',
        'capabilities',
      ] as const) {
        await transaction.runAsync(
          `DELETE FROM ${table} WHERE profile_id = ?`,
          tombstone.profileId,
        );
      }
      await transaction.runAsync(
        `INSERT INTO profile_removal_tombstones (
           operation_id, profile_id, created_at, payload_json
         ) VALUES (?, ?, ?, ?)`,
        tombstone.operationId,
        tombstone.profileId,
        tombstone.createdAt,
        '{}',
      );
    });
  }

  async writeProfileRemovalManifest(manifest: ProfileRemovalManifestRecord) {
    const database = await this.database();
    await this.exclusiveMutation(database, async (transaction) => {
      const removal = await transaction.getFirstAsync<{ operation_id: string }>(
        'SELECT operation_id FROM profile_removal_tombstones WHERE profile_id = ?',
        manifest.profileId,
      );
      if (removal) throw new Error('The connection profile has been removed.');
      // If a process died after persisting a manifest but before publishing its
      // protected journal pointer, a later removal can safely replace that
      // uncommitted orphan. Committed tombstones are permanent authority fences.
      await transaction.runAsync(
        `DELETE FROM profile_removal_manifests
         WHERE profile_id = ? AND operation_id NOT IN (
             SELECT operation_id FROM profile_removal_tombstones
           )`,
        manifest.profileId,
      );
      await transaction.runAsync(
        `INSERT INTO profile_removal_manifests (
           operation_id, profile_id, created_at, schema_version, payload_json
         ) VALUES (?, ?, ?, ?, ?)`,
        manifest.operationId,
        manifest.profileId,
        manifest.createdAt,
        manifest.schemaVersion,
        JSON.stringify(manifest.data),
      );
    });
  }

  async readProfileRemovalManifest(operationId: string) {
    const row = await (await this.database()).getFirstAsync<{
      operation_id: string;
      profile_id: string;
      created_at: string;
      schema_version: number;
      payload_json: string;
    }>(
      `SELECT operation_id, profile_id, created_at, schema_version, payload_json
       FROM profile_removal_manifests WHERE operation_id = ?`,
      operationId,
    );
    return row ? {
      schemaVersion: row.schema_version,
      reference: row.operation_id,
      operationId: row.operation_id,
      profileId: row.profile_id,
      createdAt: row.created_at,
      data: parseStoredJson<unknown>(row.payload_json, 'profile removal manifest'),
    } as ProfileRemovalManifestRecord : null;
  }

  async deleteProfileRemovalManifest(operationId: string) {
    await this.queuedRunAsync(
      'DELETE FROM profile_removal_manifests WHERE operation_id = ?',
      operationId,
    );
  }

  async readProfileRemovalTombstone(operationId: string) {
    const row = await (await this.database()).getFirstAsync<{
      operation_id: string;
      profile_id: string;
      created_at: string;
      payload_json: string;
    }>(
      `SELECT operation_id, profile_id, created_at, payload_json
       FROM profile_removal_tombstones WHERE operation_id = ?`,
      operationId,
    );
    return row ? {
      operationId: row.operation_id,
      profileId: row.profile_id,
      createdAt: row.created_at,
    } satisfies ProfileRemovalTombstone : null;
  }
}

export function assertDatabaseSchemaComplete() {
  const latest = FOLIO_DATABASE_MIGRATIONS.at(-1)?.version ?? 0;
  if (latest !== FOLIO_DATABASE_VERSION) {
    throw new Error(`Database migration ${latest} does not match version ${FOLIO_DATABASE_VERSION}.`);
  }
}
