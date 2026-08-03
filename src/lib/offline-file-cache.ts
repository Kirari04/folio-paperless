import type { FolioRepository, OfflineFileRecord } from '../types/persistence.ts';

export type OfflineRepresentation = OfflineFileRecord['representation'];

export type OfflineFileLocation = {
  temporaryUri: string;
  committedUri: string;
};

export type OfflineFileStat = {
  exists: boolean;
  byteSize: number;
};

export interface OfflineFileStorage {
  allocate(input: {
    profileId: string;
    documentId: string;
    representation: OfflineRepresentation;
    pinned: boolean;
    operationId: string;
  }): OfflineFileLocation;
  stat(profileId: string, uri: string): Promise<OfflineFileStat>;
  commit(profileId: string, temporaryUri: string, committedUri: string): Promise<void>;
  copy(profileId: string, sourceUri: string, committedUri: string): Promise<void>;
  remove(profileId: string, uri: string): Promise<void>;
  availableDiskBytes(): Promise<number | null>;
}

export interface OfflineFileDownloader {
  expectedSize?(input: {
    profileId: string;
    documentId: string;
    representation: OfflineRepresentation;
    signal?: AbortSignal;
  }): Promise<number | null>;
  download(input: {
    profileId: string;
    documentId: string;
    representation: OfflineRepresentation;
    destinationUri: string;
    signal?: AbortSignal;
    onProgress?: (progress: number) => Promise<void> | void;
  }): Promise<void>;
}

export type OfflineCacheUsage = {
  automaticBytes: number;
  pinnedBytes: number;
  totalBytes: number;
  automaticFiles: number;
  pinnedFiles: number;
  pinnedDocuments: number;
};

export type OfflineCacheCleanupResult = {
  removed: OfflineFileRecord[];
  failed: { file: OfflineFileRecord; message: string }[];
  freedBytes: number;
  usage: OfflineCacheUsage;
};

export type OfflineFileMutationResult =
  | { kind: 'stored'; file: OfflineFileRecord; usage: OfflineCacheUsage }
  | { kind: 'not-downloaded' }
  | { kind: 'requires-confirmation'; detail: string }
  | { kind: 'remove-failed'; detail: string }
  | { kind: 'quota-exceeded'; requiredBytes: number; quotaBytes: number }
  | {
      kind: 'storage-pressure';
      requiredBytes: number;
      availableBytes: number;
      reserveBytes: number;
    };

export type OfflineFileAccess =
  | { kind: 'available'; file: OfflineFileRecord }
  | { kind: 'file-not-downloaded' }
  | { kind: 'missing'; removedRecord: OfflineFileRecord };

export type OfflineFileCacheOptions = {
  repository: FolioRepository;
  storage: OfflineFileStorage;
  downloader: OfflineFileDownloader;
  quotaBytes: number;
  reserveBytes?: number;
  now?: () => Date;
  operationId?: () => string;
};

const DEFAULT_RESERVE_BYTES = 64 * 1024 * 1024;
const profileMutationTails = new Map<string, Promise<void>>();

async function serializeProfileMutation<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
  const previous = profileMutationTails.get(profileId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  profileMutationTails.set(profileId, current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (profileMutationTails.get(profileId) === current) profileMutationTails.delete(profileId);
  }
}

function assertIdentity(value: string, label: string) {
  if (!value.trim() || value.includes('\0')) throw new Error(`${label} is invalid.`);
}

function isPinnable(representation: OfflineRepresentation) {
  return representation === 'original' || representation === 'archive';
}

function usageFor(files: OfflineFileRecord[]): OfflineCacheUsage {
  const automatic = files.filter((file) => !file.pinned);
  const pinned = files.filter((file) => file.pinned);
  const automaticBytes = automatic.reduce((total, file) => total + file.byteSize, 0);
  const pinnedBytes = pinned.reduce((total, file) => total + file.byteSize, 0);
  return {
    automaticBytes,
    pinnedBytes,
    totalBytes: automaticBytes + pinnedBytes,
    automaticFiles: automatic.length,
    pinnedFiles: pinned.length,
    pinnedDocuments: new Set(pinned.map((file) => file.documentId)).size,
  };
}

function sameFile(
  file: OfflineFileRecord,
  documentId: string,
  representation: OfflineRepresentation,
) {
  return file.documentId === documentId && file.representation === representation;
}

export class OfflineFileCacheManager {
  private readonly options: OfflineFileCacheOptions;
  private readonly now: () => Date;
  private readonly operationId: () => string;
  private quotaBytes: number;
  private readonly reserveBytes: number;

  constructor(options: OfflineFileCacheOptions) {
    this.options = options;
    if (!Number.isFinite(options.quotaBytes) || options.quotaBytes < 0) {
      throw new Error('The automatic cache quota must be a non-negative number.');
    }
    this.quotaBytes = Math.floor(options.quotaBytes);
    this.reserveBytes = Math.max(0, Math.floor(options.reserveBytes ?? DEFAULT_RESERVE_BYTES));
    this.now = options.now ?? (() => new Date());
    this.operationId = options.operationId ?? (() => `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  setQuotaBytes(quotaBytes: number) {
    if (!Number.isFinite(quotaBytes) || quotaBytes < 0) {
      throw new Error('The automatic cache quota must be a non-negative number.');
    }
    this.quotaBytes = Math.floor(quotaBytes);
  }

  async usage(profileId: string) {
    assertIdentity(profileId, 'Profile ID');
    const records = await this.options.repository.listOfflineFiles(profileId);
    const available = await Promise.all(records.map(async (file) => {
      try {
        const stat = await this.options.storage.stat(profileId, file.uri);
        return stat.exists && stat.byteSize > 0 && stat.byteSize === file.byteSize
          ? file
          : null;
      } catch {
        // A record that cannot currently be verified must not inflate the
        // user-facing cache usage. Do not delete it here: a concurrent
        // replacement may have changed the row after it was listed.
        return null;
      }
    }));
    return usageFor(available.filter((file): file is OfflineFileRecord => file !== null));
  }

  private async removeRecords(
    files: OfflineFileRecord[],
    profileId: string,
  ): Promise<OfflineCacheCleanupResult> {
    const removed: OfflineFileRecord[] = [];
    const failed: { file: OfflineFileRecord; message: string }[] = [];
    let freedBytes = 0;
    for (const file of files) {
      try {
        if (file.profileId !== profileId) {
          throw new Error('The offline record does not belong to this connection profile.');
        }
        await this.options.storage.remove(file.profileId, file.uri);
        await this.options.repository.deleteOfflineFile(
          file.profileId,
          file.documentId,
          file.representation,
        );
        removed.push(file);
        freedBytes += file.byteSize;
      } catch (error) {
        failed.push({
          file,
          message: error instanceof Error ? error.message : 'The cached file could not be removed.',
        });
      }
    }
    return {
      removed,
      failed,
      freedBytes,
      usage: profileId ? await this.usage(profileId) : usageFor([]),
    };
  }

  private async makeAutomaticSpace(
    profileId: string,
    incomingBytes: number,
    excluded?: { documentId: string; representation: OfflineRepresentation },
  ) {
    if (incomingBytes > this.quotaBytes) {
      return { kind: 'quota-exceeded' as const, requiredBytes: incomingBytes, quotaBytes: this.quotaBytes };
    }
    const files = await this.options.repository.listOfflineFiles(profileId);
    const existing = excluded
      ? files.find((file) => sameFile(file, excluded.documentId, excluded.representation) && !file.pinned)
      : undefined;
    let automaticBytes = usageFor(files).automaticBytes - (existing?.byteSize ?? 0);
    const candidates = files
      .filter((file) => !file.pinned && file !== existing)
      .sort((left, right) => left.lastAccessedAt.localeCompare(right.lastAccessedAt));
    for (const candidate of candidates) {
      if (automaticBytes + incomingBytes <= this.quotaBytes) break;
      const cleaned = await this.removeRecords([candidate], profileId);
      if (cleaned.removed.length > 0) automaticBytes -= candidate.byteSize;
    }
    if (automaticBytes + incomingBytes > this.quotaBytes) {
      return { kind: 'quota-exceeded' as const, requiredBytes: incomingBytes, quotaBytes: this.quotaBytes };
    }
    return null;
  }

  private async makeDiskSpace(profileId: string, requiredBytes: number) {
    let available = await this.options.storage.availableDiskBytes();
    if (available === null || available >= requiredBytes + this.reserveBytes) return null;
    const candidates = (await this.options.repository.listOfflineFiles(profileId))
      .filter((file) => !file.pinned)
      .sort((left, right) => left.lastAccessedAt.localeCompare(right.lastAccessedAt));
    for (const candidate of candidates) {
      if (available >= requiredBytes + this.reserveBytes) break;
      const cleaned = await this.removeRecords([candidate], profileId);
      if (cleaned.removed.length > 0) {
        available = await this.options.storage.availableDiskBytes() ?? available + cleaned.freedBytes;
      }
    }
    if (available < requiredBytes + this.reserveBytes) {
      return {
        kind: 'storage-pressure' as const,
        requiredBytes,
        availableBytes: available,
        reserveBytes: this.reserveBytes,
      };
    }
    return null;
  }

  async download(input: {
    profileId: string;
    documentId: string;
    representation: OfflineRepresentation;
    pinned: boolean;
    fileName?: string;
    mimeType?: string;
    signal?: AbortSignal;
    onProgress?: (progress: number) => Promise<void> | void;
  }): Promise<OfflineFileMutationResult> {
    return serializeProfileMutation(input.profileId, () => this.downloadSerialized(input));
  }

  private async downloadSerialized(input: {
    profileId: string;
    documentId: string;
    representation: OfflineRepresentation;
    pinned: boolean;
    fileName?: string;
    mimeType?: string;
    signal?: AbortSignal;
    onProgress?: (progress: number) => Promise<void> | void;
  }): Promise<OfflineFileMutationResult> {
    assertIdentity(input.profileId, 'Profile ID');
    assertIdentity(input.documentId, 'Document ID');
    const priorRecord = (await this.options.repository.listOfflineFiles(input.profileId))
      .find((file) => sameFile(file, input.documentId, input.representation));
    // An automatic-cache refresh must never silently demote a file the user
    // explicitly pinned. If the protected copy needs replacing, retain its
    // storage class and pin intent throughout the replacement.
    const pinned = input.pinned || priorRecord?.pinned === true;
    if (pinned && !isPinnable(input.representation)) {
      throw new Error('Only original and archive representations can be pinned.');
    }
    const expected = Math.max(0, await this.options.downloader.expectedSize?.(input) ?? 0);
    if (!pinned) {
      const quota = await this.makeAutomaticSpace(input.profileId, expected, input);
      if (quota) return quota;
    }
    const pressure = await this.makeDiskSpace(input.profileId, expected);
    if (pressure) return pressure;

    const operationId = this.operationId();
    const location = this.options.storage.allocate({ ...input, pinned, operationId });
    let committed = false;
    try {
      await this.options.downloader.download({
        profileId: input.profileId,
        documentId: input.documentId,
        representation: input.representation,
        destinationUri: location.temporaryUri,
        signal: input.signal,
        onProgress: input.onProgress,
      });
      const stat = await this.options.storage.stat(input.profileId, location.temporaryUri);
      if (!stat.exists || stat.byteSize <= 0) throw new Error('The downloaded file is empty or missing.');
      if (!pinned) {
        const quota = await this.makeAutomaticSpace(input.profileId, stat.byteSize, input);
        if (quota) return quota;
      }
      const finalPressure = await this.makeDiskSpace(input.profileId, 0);
      if (finalPressure) return finalPressure;

      const previous = (await this.options.repository.listOfflineFiles(input.profileId))
        .find((file) => sameFile(file, input.documentId, input.representation));
      await this.options.storage.commit(input.profileId, location.temporaryUri, location.committedUri);
      committed = true;
      const timestamp = this.now().toISOString();
      const file: OfflineFileRecord = {
        profileId: input.profileId,
        documentId: input.documentId,
        representation: input.representation,
        uri: location.committedUri,
        ...(input.fileName?.trim() ? { fileName: input.fileName.trim() } : {}),
        ...(input.mimeType?.trim() ? { mimeType: input.mimeType.trim() } : {}),
        byteSize: stat.byteSize,
        pinned,
        lastAccessedAt: timestamp,
        createdAt: previous?.createdAt ?? timestamp,
      };
      try {
        await this.options.repository.writeOfflineFile(file);
      } catch (error) {
        await this.options.storage.remove(input.profileId, location.committedUri).catch(() => undefined);
        committed = false;
        throw error;
      }
      if (previous && previous.uri !== file.uri) await this.options.storage.remove(input.profileId, previous.uri);
      return { kind: 'stored', file, usage: await this.usage(input.profileId) };
    } finally {
      if (!committed) await this.options.storage.remove(input.profileId, location.temporaryUri).catch(() => undefined);
    }
  }

  async resolve(
    profileId: string,
    documentId: string,
    representation: OfflineRepresentation,
  ): Promise<OfflineFileAccess> {
    const record = (await this.options.repository.listOfflineFiles(profileId))
      .find((file) => sameFile(file, documentId, representation));
    if (!record) return { kind: 'file-not-downloaded' };
    const stat = await this.options.storage.stat(profileId, record.uri);
    if (!stat.exists || stat.byteSize <= 0 || stat.byteSize !== record.byteSize) {
      await this.options.repository.deleteOfflineFile(profileId, documentId, representation);
      return { kind: 'missing', removedRecord: record };
    }
    const accessed = { ...record, lastAccessedAt: this.now().toISOString() };
    await this.options.repository.writeOfflineFile(accessed);
    return { kind: 'available', file: accessed };
  }

  async setPinned(
    profileId: string,
    documentId: string,
    representation: OfflineRepresentation,
    pinned: boolean,
  ): Promise<OfflineFileMutationResult> {
    return serializeProfileMutation(profileId, () => this.setPinnedSerialized(
      profileId,
      documentId,
      representation,
      pinned,
    ));
  }

  private async setPinnedSerialized(
    profileId: string,
    documentId: string,
    representation: OfflineRepresentation,
    pinned: boolean,
  ): Promise<OfflineFileMutationResult> {
    if (pinned && !isPinnable(representation)) {
      throw new Error('Only original and archive representations can be pinned.');
    }
    const files = await this.options.repository.listOfflineFiles(profileId);
    const current = files.find((file) => sameFile(file, documentId, representation));
    if (!current) return { kind: 'not-downloaded' };
    if (current.pinned === pinned) {
      return { kind: 'stored', file: current, usage: usageFor(files) };
    }
    if (!pinned) {
      const quota = await this.makeAutomaticSpace(profileId, current.byteSize, { documentId, representation });
      if (quota) return quota;
    }
    const location = this.options.storage.allocate({
      profileId,
      documentId,
      representation,
      pinned,
      operationId: this.operationId(),
    });
    await this.options.storage.copy(profileId, current.uri, location.committedUri);
    const updated = { ...current, uri: location.committedUri, pinned, lastAccessedAt: this.now().toISOString() };
    try {
      await this.options.repository.writeOfflineFile(updated);
    } catch (error) {
      await this.options.storage.remove(profileId, location.committedUri).catch(() => undefined);
      throw error;
    }
    await this.options.storage.remove(profileId, current.uri);
    return { kind: 'stored', file: updated, usage: await this.usage(profileId) };
  }

  async remove(
    profileId: string,
    documentId: string,
    representation: OfflineRepresentation,
    confirmPinned = false,
  ): Promise<OfflineFileMutationResult> {
    return serializeProfileMutation(profileId, () => this.removeSerialized(
      profileId,
      documentId,
      representation,
      confirmPinned,
    ));
  }

  private async removeSerialized(
    profileId: string,
    documentId: string,
    representation: OfflineRepresentation,
    confirmPinned: boolean,
  ): Promise<OfflineFileMutationResult> {
    const file = (await this.options.repository.listOfflineFiles(profileId))
      .find((candidate) => sameFile(candidate, documentId, representation));
    if (!file) return { kind: 'not-downloaded' };
    if (file.pinned && !confirmPinned) {
      return { kind: 'requires-confirmation', detail: 'Pinned offline files require confirmation before removal.' };
    }
    const cleanup = await this.removeRecords([file], profileId);
    if (cleanup.failed.length > 0) {
      return { kind: 'remove-failed', detail: cleanup.failed[0].message };
    }
    return { kind: 'not-downloaded' };
  }

  async clearEvictable(profileId: string) {
    return serializeProfileMutation(profileId, () => this.clearEvictableSerialized(profileId));
  }

  private async clearEvictableSerialized(profileId: string) {
    const files = (await this.options.repository.listOfflineFiles(profileId))
      .filter((file) => !file.pinned)
      .sort((left, right) => left.lastAccessedAt.localeCompare(right.lastAccessedAt));
    return this.removeRecords(files, profileId);
  }

  async trimToQuota(profileId: string) {
    return serializeProfileMutation(profileId, async () => {
      await this.makeAutomaticSpace(profileId, 0);
      return this.usage(profileId);
    });
  }

  async removeAllPinned(profileId: string, confirm = false) {
    if (!confirm) {
      return { kind: 'requires-confirmation' as const, detail: 'Removing all pinned files requires confirmation.' };
    }
    return serializeProfileMutation(profileId, async () => {
      const pinned = (await this.options.repository.listOfflineFiles(profileId))
        .filter((file) => file.pinned);
      return { kind: 'removed' as const, result: await this.removeRecords(pinned, profileId) };
    });
  }
}
