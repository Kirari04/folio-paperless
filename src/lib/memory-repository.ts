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
} from '../types/persistence.ts';
import type { PersistentTask, UploadPreset } from '../types/tasks.ts';
import { acquireTaskLease, isTaskRetryDue, migratePersistentTask } from './task-policy.ts';
import { mergeWorkspaceSavedViewSnapshots } from './saved-view-offline-cache.ts';
import { overlayPendingMetadataUpdates } from './metadata-update.ts';
import {
  reconcileConfirmedBulkDocument,
  reconcileConfirmedBulkWorkspace,
} from './bulk-document-reconciliation.ts';
import {
  reconcileCatalogDocumentMutation,
  reconcileCatalogWorkspaceMutation,
} from './catalog-management.ts';

function scoped(profileId: string, id: string) {
  return `${profileId}\u0000${id}`;
}

export class MemoryFolioRepository implements FolioRepository {
  private workspaces = new Map<string, CachedWorkspace>();
  private details = new Map<string, CachedDocumentDetail>();
  private tasks = new Map<string, PersistentTask>();
  private presets = new Map<string, UploadPreset>();
  private aliases = new Map<string, RouteAlias>();
  private files = new Map<string, OfflineFileRecord>();
  private notificationOutbox = new Map<string, TaskNotificationClaim & { state: 'pending' | 'sent' }>();
  private capabilities = new Map<string, CachedCapabilitySet>();
  private profileRemovalTombstones = new Map<string, ProfileRemovalTombstone>();
  private profileRemovalManifests = new Map<string, ProfileRemovalManifestRecord>();
  private claimTail: Promise<void> = Promise.resolve();

  private isProfileRemoved(profileId: string) {
    return [...this.profileRemovalTombstones.values()].some(
      (tombstone) => tombstone.profileId === profileId,
    );
  }

  private assertProfileWritable(profileId: string) {
    if (this.isProfileRemoved(profileId)) {
      throw new Error('The connection profile has been removed.');
    }
  }

  private deleteProfileDataNow(profileId: string) {
    this.workspaces.delete(profileId);
    this.capabilities.delete(profileId);
    for (const [key, value] of this.details) if (value.profileId === profileId) this.details.delete(key);
    for (const [key, value] of this.tasks) if (value.profileId === profileId) this.tasks.delete(key);
    for (const [key, value] of this.presets) if (value.profileId === profileId) this.presets.delete(key);
    for (const [key, value] of this.aliases) if (value.profileId === profileId) this.aliases.delete(key);
    for (const [key, value] of this.files) if (value.profileId === profileId) this.files.delete(key);
    for (const [key, value] of this.notificationOutbox) {
      if (value.profileId === profileId) this.notificationOutbox.delete(key);
    }
  }

  async initialize() {}

  async readWorkspace(profileId: string) {
    return structuredClone(this.workspaces.get(profileId) ?? null);
  }

  async replaceWorkspace(workspace: CachedWorkspace) {
    this.assertProfileWritable(workspace.profileId);
    const current = this.workspaces.get(workspace.profileId);
    const pendingTasks = [...this.tasks.values()].filter((task) => task.profileId === workspace.profileId);
    this.workspaces.set(workspace.profileId, structuredClone({
      ...workspace,
      documents: overlayPendingMetadataUpdates(workspace.documents, pendingTasks),
      savedViewSnapshots: mergeWorkspaceSavedViewSnapshots(current, workspace),
    }));
  }

  async reconcileBulkDocuments(
    profileId: string,
    reconciliation: BulkDocumentReconciliation,
  ) {
    this.assertProfileWritable(profileId);
    const workspace = this.workspaces.get(profileId);
    if (!workspace) return null;
    const nextWorkspace = reconcileConfirmedBulkWorkspace(workspace, reconciliation);
    const nextDetails = new Map(this.details);
    for (const [key, detail] of nextDetails) {
      if (detail.profileId !== profileId) continue;
      const document = reconcileConfirmedBulkDocument(detail.document, reconciliation);
      if (!document) nextDetails.delete(key);
      else nextDetails.set(key, { ...detail, document });
    }
    // Workspace and detail changes form one synchronous in-memory critical section.
    this.workspaces.set(profileId, structuredClone(nextWorkspace));
    this.details = new Map([...nextDetails].map(([key, detail]) => [key, structuredClone(detail)]));
    return structuredClone(nextWorkspace);
  }

  async upsertSavedView(profileId: string, view: import('../types/document.ts').PaperlessSavedView) {
    this.assertProfileWritable(profileId);
    const workspace = this.workspaces.get(profileId);
    if (!workspace) throw new Error('A saved-view mutation requires an existing profile workspace.');
    this.workspaces.set(profileId, structuredClone({
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
    }));
  }

  async deleteSavedView(profileId: string, remoteId: number) {
    this.assertProfileWritable(profileId);
    const workspace = this.workspaces.get(profileId);
    if (!workspace) throw new Error('A saved-view mutation requires an existing profile workspace.');
    const deletedIds = new Set(
      workspace.catalog.savedViews
        .filter((view) => view.remoteId === remoteId)
        .map((view) => view.id),
    );
    this.workspaces.set(profileId, structuredClone({
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
    }));
  }

  async reconcileCatalogMutation(
    profileId: string,
    mutation: ConfirmedCatalogMutation,
    labels: CatalogMutationLabels,
  ) {
    this.assertProfileWritable(profileId);
    const workspace = this.workspaces.get(profileId);
    if (!workspace) throw new Error('A catalog mutation requires an existing profile workspace.');
    const nextWorkspace = reconcileCatalogWorkspaceMutation(workspace, mutation, labels);
    const nextDetails = new Map(this.details);
    for (const [key, detail] of nextDetails) {
      if (detail.profileId !== profileId) continue;
      nextDetails.set(key, {
        ...detail,
        document: reconcileCatalogDocumentMutation(detail.document, mutation, labels),
      });
    }
    this.workspaces.set(profileId, structuredClone(nextWorkspace));
    this.details = new Map([...nextDetails].map(([key, detail]) => [key, structuredClone(detail)]));
    return structuredClone(nextWorkspace);
  }

  async writeSavedViewSnapshot(profileId: string, snapshot: import('../types/persistence.ts').CachedSavedViewSnapshot) {
    this.assertProfileWritable(profileId);
    const workspace = this.workspaces.get(profileId);
    if (!workspace) throw new Error('A saved-view snapshot requires an existing profile workspace.');
    this.workspaces.set(profileId, structuredClone({
      ...workspace,
      savedViewSnapshots: { ...workspace.savedViewSnapshots, [snapshot.viewId]: snapshot },
    }));
  }

  async writeWorkspaceError(profileId: string, error: string) {
    this.assertProfileWritable(profileId);
    const workspace = this.workspaces.get(profileId);
    if (!workspace) return;
    this.workspaces.set(profileId, { ...workspace, syncState: 'error', syncError: error });
  }

  async readDocumentDetail(profileId: string, documentId: string) {
    return structuredClone(this.details.get(scoped(profileId, documentId)) ?? null);
  }

  async writeDocumentDetail(detail: CachedDocumentDetail) {
    this.assertProfileWritable(detail.profileId);
    this.details.set(scoped(detail.profileId, detail.documentId), structuredClone(detail));
  }

  async listTasks(profileId: string) {
    return [...this.tasks.values()]
      .filter((task) => task.profileId === profileId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((task) => migratePersistentTask(structuredClone(task)));
  }

  async readTask(profileId: string, taskId: string) {
    const task = structuredClone(this.tasks.get(scoped(profileId, taskId)) ?? null);
    return task ? migratePersistentTask(task) : null;
  }

  async writeTask(task: PersistentTask) {
    this.assertProfileWritable(task.profileId);
    this.tasks.set(scoped(task.profileId, task.id), structuredClone(task));
  }

  async writeTasks(tasks: readonly PersistentTask[]) {
    for (const task of tasks) this.assertProfileWritable(task.profileId);
    const next = new Map(this.tasks);
    for (const task of tasks) {
      next.set(scoped(task.profileId, task.id), structuredClone(task));
    }
    this.tasks = next;
  }

  async claimTask(
    task: PersistentTask,
    workerId: string,
    now: Date,
    leaseMs = 2 * 60_000,
  ) {
    if (this.isProfileRemoved(task.profileId)) return null;
    const key = scoped(task.profileId, task.id);
    const existing = this.tasks.get(key);
    const existingExpiry = existing?.leaseExpiresAt ? Date.parse(existing.leaseExpiresAt) : 0;
    if (existing?.leaseOwner && existing.leaseOwner !== workerId && existingExpiry > now.getTime()) {
      return null;
    }
    const candidate = {
      ...task,
      createdAt: existing?.createdAt ?? task.createdAt,
    };
    const claimed = acquireTaskLease(candidate, workerId, now, leaseMs);
    if (!claimed) return null;
    this.tasks.set(key, structuredClone(claimed));
    return structuredClone(claimed);
  }

  async renewTaskLease(
    profileId: string,
    taskId: string,
    workerId: string,
    now: Date,
    leaseMs = 2 * 60_000,
  ) {
    if (this.isProfileRemoved(profileId)) return null;
    const key = scoped(profileId, taskId);
    const existing = this.tasks.get(key);
    const expiry = existing?.leaseExpiresAt ? Date.parse(existing.leaseExpiresAt) : 0;
    if (!existing || existing.leaseOwner !== workerId || expiry <= now.getTime()) return null;
    const renewed = {
      ...existing,
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      updatedAt: now.toISOString(),
    };
    this.tasks.set(key, structuredClone(renewed));
    return structuredClone(renewed);
  }

  async commitWorkspaceSync(
    workspace: CachedWorkspace,
    expectedLease: PersistentTask,
    completedTask: PersistentTask,
    now: Date,
  ) {
    if (this.isProfileRemoved(workspace.profileId)) return false;
    if (
      workspace.profileId !== expectedLease.profileId
      || completedTask.profileId !== expectedLease.profileId
      || completedTask.id !== expectedLease.id
      || completedTask.stage !== 'ready'
    ) throw new Error('A workspace sync commit must retain one profile, task, and terminal state.');
    const key = scoped(expectedLease.profileId, expectedLease.id);
    const existing = this.tasks.get(key);
    const expiry = existing?.leaseExpiresAt ? Date.parse(existing.leaseExpiresAt) : 0;
    if (
      !existing
      || !expectedLease.leaseOwner
      || existing.leaseOwner !== expectedLease.leaseOwner
      || existing.leaseExpiresAt !== expectedLease.leaseExpiresAt
      || existing.updatedAt !== expectedLease.updatedAt
      || expiry <= now.getTime()
    ) return false;
    // No await occurs between the lease comparison and both writes, so this is
    // one atomic critical section in the in-memory repository.
    const current = this.workspaces.get(workspace.profileId);
    const pendingTasks = [...this.tasks.values()].filter((task) => task.profileId === workspace.profileId);
    this.workspaces.set(workspace.profileId, structuredClone({
      ...workspace,
      documents: overlayPendingMetadataUpdates(workspace.documents, pendingTasks),
      savedViewSnapshots: mergeWorkspaceSavedViewSnapshots(current, workspace),
    }));
    this.tasks.set(key, structuredClone(completedTask));
    return true;
  }

  async claimNextRunnableTask(
    profileId: string,
    workerId: string,
    now: Date,
    leaseMs = 2 * 60_000,
  ) {
    if (this.isProfileRemoved(profileId)) return null;
    let release!: () => void;
    const previous = this.claimTail;
    this.claimTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.isProfileRemoved(profileId)) return null;
      const tasks = await this.listTasks(profileId);
      const candidate = tasks
        .filter((task) => ['upload', 'paperless-processing', 'pdf-operation', 'bulk-operation'].includes(task.kind))
        .filter((task) => ['queued', 'uploading', 'processing'].includes(task.stage) || isTaskRetryDue(task, now))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .find((task) => acquireTaskLease(task, workerId, now, leaseMs));
      if (!candidate) return null;
      const leased = acquireTaskLease(candidate, workerId, now, leaseMs)!;
      if (this.isProfileRemoved(profileId)) return null;
      this.tasks.set(scoped(profileId, leased.id), structuredClone(leased));
      return structuredClone(leased);
    } finally {
      release();
    }
  }

  async claimNextMetadataTask(
    profileId: string,
    workerId: string,
    now: Date,
    leaseMs = 2 * 60_000,
  ) {
    if (this.isProfileRemoved(profileId)) return null;
    let release!: () => void;
    const previous = this.claimTail;
    this.claimTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.isProfileRemoved(profileId)) return null;
      const candidate = (await this.listTasks(profileId))
        .filter((task) => task.kind === 'metadata-update')
        .filter((task) => task.stage === 'queued' || isTaskRetryDue(task, now))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .find((task) => acquireTaskLease(task, workerId, now, leaseMs));
      if (!candidate) return null;
      const leased = acquireTaskLease(candidate, workerId, now, leaseMs)!;
      if (this.isProfileRemoved(profileId)) return null;
      this.tasks.set(scoped(profileId, leased.id), structuredClone(leased));
      return structuredClone(leased);
    } finally {
      release();
    }
  }

  async claimNextOfflineDownloadTask(
    profileId: string,
    workerId: string,
    now: Date,
    leaseMs = 2 * 60_000,
  ) {
    if (this.isProfileRemoved(profileId)) return null;
    let release!: () => void;
    const previous = this.claimTail;
    this.claimTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.isProfileRemoved(profileId)) return null;
      const candidate = (await this.listTasks(profileId))
        .filter((task) => task.kind === 'offline-download')
        .filter((task) => ['queued', 'uploading'].includes(task.stage) || isTaskRetryDue(task, now))
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .find((task) => acquireTaskLease(task, workerId, now, leaseMs));
      if (!candidate) return null;
      const leased = acquireTaskLease(candidate, workerId, now, leaseMs)!;
      if (this.isProfileRemoved(profileId)) return null;
      this.tasks.set(scoped(profileId, leased.id), structuredClone(leased));
      return structuredClone(leased);
    } finally {
      release();
    }
  }

  async updateLeasedTask(
    expectedLease: PersistentTask,
    updatedTask: PersistentTask,
    now: Date,
  ) {
    if (this.isProfileRemoved(expectedLease.profileId)) return null;
    if (
      expectedLease.profileId !== updatedTask.profileId
      || expectedLease.id !== updatedTask.id
      || expectedLease.kind !== updatedTask.kind
    ) throw new Error('A leased task update must retain its profile, identity, and kind.');
    const key = scoped(expectedLease.profileId, expectedLease.id);
    const existing = this.tasks.get(key);
    const expiry = existing?.leaseExpiresAt ? Date.parse(existing.leaseExpiresAt) : 0;
    if (
      !existing
      || !expectedLease.leaseOwner
      || existing.leaseOwner !== expectedLease.leaseOwner
      || existing.leaseExpiresAt !== expectedLease.leaseExpiresAt
      || existing.updatedAt !== expectedLease.updatedAt
      || expiry <= now.getTime()
    ) return null;
    this.tasks.set(key, structuredClone(updatedTask));
    return structuredClone(updatedTask);
  }

  async writeMetadataTask(
    task: PersistentTask,
    workspaceDocument: import('../types/document.ts').DocumentItem,
    detailDocument?: import('../types/document.ts').DocumentItem,
  ) {
    this.assertProfileWritable(task.profileId);
    if (task.kind !== 'metadata-update' || task.metadataUpdate?.documentId !== workspaceDocument.id) {
      throw new Error('A metadata cache mutation must match its durable task target.');
    }
    const workspace = this.workspaces.get(task.profileId);
    if (!workspace || !workspace.documents.some((document) => document.id === workspaceDocument.id)) {
      throw new Error('A metadata update requires a cached profile document.');
    }
    const nextWorkspace = {
      ...workspace,
      documents: workspace.documents.map((document) => (
        document.id === workspaceDocument.id ? structuredClone(workspaceDocument) : document
      )),
    };
    // All writes are synchronous map operations after validation, making this
    // one in-memory critical section just like a SQLite transaction.
    this.workspaces.set(task.profileId, structuredClone(nextWorkspace));
    if (detailDocument) {
      this.details.set(scoped(task.profileId, detailDocument.id), {
        profileId: task.profileId,
        documentId: detailDocument.id,
        document: structuredClone(detailDocument),
        fetchedAt: task.updatedAt,
      });
    }
    this.tasks.set(scoped(task.profileId, task.id), structuredClone(task));
  }

  async commitMetadataTask(
    expectedLease: PersistentTask,
    completedTask: PersistentTask,
    serverDocument: import('../types/document.ts').DocumentItem | null,
    now: Date,
  ) {
    if (this.isProfileRemoved(expectedLease.profileId)) return false;
    if (
      expectedLease.kind !== 'metadata-update'
      || completedTask.kind !== 'metadata-update'
      || expectedLease.profileId !== completedTask.profileId
      || expectedLease.id !== completedTask.id
    ) throw new Error('A metadata task commit must retain one profile and task.');
    const key = scoped(expectedLease.profileId, expectedLease.id);
    const existing = this.tasks.get(key);
    const expiry = existing?.leaseExpiresAt ? Date.parse(existing.leaseExpiresAt) : 0;
    if (
      !existing
      || !expectedLease.leaseOwner
      || existing.leaseOwner !== expectedLease.leaseOwner
      || existing.leaseExpiresAt !== expectedLease.leaseExpiresAt
      || existing.updatedAt !== expectedLease.updatedAt
      || expiry <= now.getTime()
    ) return false;
    if (serverDocument) {
      const workspace = this.workspaces.get(expectedLease.profileId);
      if (workspace) {
        this.workspaces.set(expectedLease.profileId, structuredClone({
          ...workspace,
          documents: workspace.documents.map((document) => (
            document.id === serverDocument.id ? serverDocument : document
          )),
        }));
      }
      this.details.set(scoped(expectedLease.profileId, serverDocument.id), {
        profileId: expectedLease.profileId,
        documentId: serverDocument.id,
        document: structuredClone(serverDocument),
        fetchedAt: completedTask.updatedAt,
      });
    }
    this.tasks.set(key, structuredClone(completedTask));
    return true;
  }

  async deleteTask(profileId: string, taskId: string) {
    this.tasks.delete(scoped(profileId, taskId));
  }

  async listPresets(profileId: string) {
    return [...this.presets.values()]
      .filter((preset) => preset.profileId === profileId)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((preset) => structuredClone(preset));
  }

  async writePreset(preset: UploadPreset) {
    this.assertProfileWritable(preset.profileId);
    this.presets.set(scoped(preset.profileId, preset.id), structuredClone(preset));
  }

  async deletePreset(profileId: string, presetId: string) {
    this.presets.delete(scoped(profileId, presetId));
  }

  async readRouteAlias(profileId: string, sourceId: string) {
    return structuredClone(this.aliases.get(scoped(profileId, sourceId)) ?? null);
  }

  async listRouteAliases(profileId: string) {
    return [...this.aliases.values()]
      .filter((alias) => alias.profileId === profileId)
      .map((alias) => structuredClone(alias));
  }

  async writeRouteAlias(alias: RouteAlias) {
    this.assertProfileWritable(alias.profileId);
    this.aliases.set(scoped(alias.profileId, alias.sourceId), structuredClone(alias));
  }

  async listOfflineFiles(profileId: string) {
    return [...this.files.values()]
      .filter((file) => file.profileId === profileId)
      .map((file) => structuredClone(file));
  }

  async writeOfflineFile(file: OfflineFileRecord) {
    this.assertProfileWritable(file.profileId);
    this.files.set(scoped(file.profileId, `${file.documentId}\u0000${file.representation}`), structuredClone(file));
  }

  async deleteOfflineFile(
    profileId: string,
    documentId: string,
    representation: OfflineFileRecord['representation'],
  ) {
    this.files.delete(scoped(profileId, `${documentId}\u0000${representation}`));
  }

  async claimTaskNotification(
    profileId: string,
    taskId: string,
    workerId: string,
    dispatchId: string,
    now: Date,
    leaseMs = 60_000,
  ) {
    if (this.isProfileRemoved(profileId)) return null;
    let release!: () => void;
    const previous = this.claimTail;
    this.claimTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.isProfileRemoved(profileId)) return null;
      const task = this.tasks.get(scoped(profileId, taskId));
      if (!task || task.notificationSentAt) return null;
      const key = scoped(profileId, taskId);
      const existing = this.notificationOutbox.get(key);
      const expiry = existing?.leaseExpiresAt ? Date.parse(existing.leaseExpiresAt) : 0;
      if (existing?.state === 'sent') return null;
      if (existing?.leaseOwner && existing.leaseOwner !== workerId && expiry > now.getTime()) return null;
      const claim: TaskNotificationClaim = {
        profileId,
        taskId,
        dispatchId: existing?.dispatchId ?? dispatchId,
        leaseOwner: workerId,
        leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
        updatedAt: now.toISOString(),
      };
      this.notificationOutbox.set(key, { ...structuredClone(claim), state: 'pending' });
      return structuredClone(claim);
    } finally {
      release();
    }
  }

  async completeTaskNotification(claim: TaskNotificationClaim, now: Date) {
    if (this.isProfileRemoved(claim.profileId)) return null;
    const key = scoped(claim.profileId, claim.taskId);
    const existing = this.notificationOutbox.get(key);
    const task = this.tasks.get(key);
    const expiry = existing?.leaseExpiresAt ? Date.parse(existing.leaseExpiresAt) : 0;
    if (
      !existing
      || existing.state !== 'pending'
      || existing.dispatchId !== claim.dispatchId
      || existing.leaseOwner !== claim.leaseOwner
      || existing.leaseExpiresAt !== claim.leaseExpiresAt
      || existing.updatedAt !== claim.updatedAt
      || expiry <= now.getTime()
      || !task
    ) return null;
    const completed = { ...task, notificationSentAt: now.toISOString() };
    this.tasks.set(key, structuredClone(completed));
    this.notificationOutbox.set(key, {
      ...existing,
      state: 'sent',
      leaseOwner: '',
      leaseExpiresAt: '',
      updatedAt: now.toISOString(),
    });
    return structuredClone(completed);
  }

  async releaseTaskNotification(claim: TaskNotificationClaim, now: Date) {
    if (this.isProfileRemoved(claim.profileId)) return false;
    const key = scoped(claim.profileId, claim.taskId);
    const existing = this.notificationOutbox.get(key);
    if (
      !existing
      || existing.state !== 'pending'
      || existing.dispatchId !== claim.dispatchId
      || existing.leaseOwner !== claim.leaseOwner
      || existing.leaseExpiresAt !== claim.leaseExpiresAt
      || existing.updatedAt !== claim.updatedAt
    ) return false;
    this.notificationOutbox.set(key, {
      ...existing,
      leaseOwner: '',
      leaseExpiresAt: '',
      updatedAt: now.toISOString(),
    });
    return true;
  }

  async readCapabilities(profileId: string) {
    return structuredClone(this.capabilities.get(profileId) ?? null);
  }

  async writeCapabilities(capabilities: CachedCapabilitySet) {
    this.assertProfileWritable(capabilities.profileId);
    this.capabilities.set(capabilities.profileId, structuredClone(capabilities));
  }

  async profileDataCounts(profileId: string): Promise<ProfileDataCounts> {
    const workspace = this.workspaces.get(profileId);
    return {
      documents: workspace?.documents.length ?? 0,
      tasks: (await this.listTasks(profileId)).length,
      presets: (await this.listPresets(profileId)).length,
      offlineFiles: (await this.listOfflineFiles(profileId)).length,
    };
  }

  async deleteProfileData(profileId: string) {
    this.deleteProfileDataNow(profileId);
  }

  async deleteProfileDataAndWriteRemovalTombstone(tombstone: ProfileRemovalTombstone) {
    // Keep deletion and the permanent authority marker in one synchronous
    // critical section. Awaiting deleteProfileData() here would let a stale
    // worker insert between the delete and tombstone publication.
    this.deleteProfileDataNow(tombstone.profileId);
    this.profileRemovalTombstones.set(tombstone.operationId, structuredClone(tombstone));
  }

  async writeProfileRemovalManifest(manifest: ProfileRemovalManifestRecord) {
    this.assertProfileWritable(manifest.profileId);
    for (const [operationId, current] of this.profileRemovalManifests) {
      if (
        current.profileId === manifest.profileId
        && !this.profileRemovalTombstones.has(operationId)
      ) {
        this.profileRemovalManifests.delete(operationId);
      }
    }
    this.profileRemovalManifests.set(manifest.operationId, structuredClone(manifest));
  }

  async readProfileRemovalManifest(operationId: string) {
    return structuredClone(this.profileRemovalManifests.get(operationId) ?? null);
  }

  async deleteProfileRemovalManifest(operationId: string) {
    this.profileRemovalManifests.delete(operationId);
  }

  async readProfileRemovalTombstone(operationId: string) {
    return structuredClone(this.profileRemovalTombstones.get(operationId) ?? null);
  }
}
