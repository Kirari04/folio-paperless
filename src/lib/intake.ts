import {
  PERSISTED_TASK_SCHEMA_VERSION,
  defaultUploadMetadataDraft,
  type IntakeBatchResult,
  type IntakeCandidate,
  type IntakeSource,
  type PersistentTask,
} from '../types/tasks.ts';
import { translateRuntime } from '../i18n/runtime.ts';

export const DEFAULT_MAX_INTAKE_BYTES = 250 * 1024 * 1024;
export const MAX_SHARED_TEXT_BYTES = 1024 * 1024;
export const SUPPORTED_INTAKE_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/heic',
  'image/heif',
  'text/plain',
]);

export type StagedFileInfo = {
  uri: string;
  name: string;
  size: number;
  mimeType: string;
};

export type IntakeStagingAdapter = {
  stage: (
    candidate: IntakeCandidate,
    stagedName: string,
    profileId: string,
    maxBytes: number,
  ) => Promise<StagedFileInfo>;
  remove: (profileId: string, uri: string) => Promise<void>;
};

function taskError(code: 'missing-file' | 'unsupported-file' | 'unknown', message: string) {
  return { code, message, retryable: false } as const;
}

export function sanitizeIntakeFilename(name: string) {
  const sourceName = name
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .split(/[\\/]/)
    .pop() || '';
  const normalized = sourceName
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. -]+/, '')
    .slice(0, 180);
  return normalized || 'shared-document';
}

function normalizedMimeType(candidate: IntakeCandidate) {
  return (candidate.mimeType || '').split(';', 1)[0].trim().toLocaleLowerCase();
}

export function validateIntakeCandidate(
  candidate: IntakeCandidate,
  maxBytes = DEFAULT_MAX_INTAKE_BYTES,
) {
  const mimeType = normalizedMimeType(candidate);
  const displayName = sanitizeIntakeFilename(candidate.name || translateRuntime('intakeRuntime.thisFile'));
  if (!candidate.uri.trim()) return taskError('missing-file', translateRuntime('intakeRuntime.missingUri'));
  if (!mimeType || !SUPPORTED_INTAKE_MIME_TYPES.has(mimeType)) {
    return taskError('unsupported-file', translateRuntime('intakeRuntime.unsupportedType', { name: displayName }));
  }
  if (candidate.size !== undefined && candidate.size !== null) {
    if (!Number.isSafeInteger(candidate.size)) {
      return taskError('unsupported-file', translateRuntime('intakeRuntime.invalidSize', { name: displayName }));
    }
    if (candidate.size <= 0) return taskError('unsupported-file', translateRuntime('intakeRuntime.empty', { name: displayName }));
    if (candidate.size > maxBytes) {
      return taskError('unsupported-file', translateRuntime('intakeRuntime.overLimit', {
        name: displayName,
        limit: Math.floor(maxBytes / 1024 / 1024),
      }));
    }
  }
  if (candidate.textContent !== undefined) {
    if (mimeType !== 'text/plain') {
      return taskError('unsupported-file', translateRuntime('intakeRuntime.unsupportedType', { name: displayName }));
    }
    const textBytes = new TextEncoder().encode(candidate.textContent).byteLength;
    if (textBytes <= 0) {
      return taskError('unsupported-file', translateRuntime('intakeRuntime.empty', { name: displayName }));
    }
    if (textBytes > Math.min(maxBytes, MAX_SHARED_TEXT_BYTES)) {
      return taskError('unsupported-file', translateRuntime('intakeRuntime.overLimit', {
        name: displayName,
        limit: Math.floor(Math.min(maxBytes, MAX_SHARED_TEXT_BYTES) / 1024 / 1024),
      }));
    }
  }
  return null;
}

export async function stageIntakeBatch(
  candidates: IntakeCandidate[],
  options: {
    adapter: IntakeStagingAdapter;
    profileId: string;
    source: IntakeSource;
    now?: () => Date;
    id?: () => string;
    maxBytes?: number;
  },
): Promise<IntakeBatchResult> {
  const accepted: PersistentTask[] = [];
  const rejected: IntakeBatchResult['rejected'] = [];
  const now = options.now ?? (() => new Date());
  const createId = options.id ?? (() => globalThis.crypto?.randomUUID?.()
    ?? `job-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  for (const candidate of candidates) {
    const validationError = validateIntakeCandidate(candidate, options.maxBytes);
    if (validationError) {
      rejected.push({ candidate, error: validationError });
      continue;
    }

    const id = createId();
    // Preserve the source name exactly as metadata. Only the private storage
    // name is normalized and made collision-resistant.
    const originalName = candidate.name || translateRuntime('intakeRuntime.sharedDocument');
    const safeDisplayName = sanitizeIntakeFilename(originalName);
    const stagedName = `${id}-${safeDisplayName}`;
    try {
      const staged = await options.adapter.stage(
        candidate,
        stagedName,
        options.profileId,
        options.maxBytes ?? DEFAULT_MAX_INTAKE_BYTES,
      );
      const stagedError = validateIntakeCandidate(
        { ...candidate, mimeType: staged.mimeType, size: staged.size, uri: staged.uri },
        options.maxBytes,
      );
      if (stagedError) {
        await options.adapter.remove(options.profileId, staged.uri).catch(() => undefined);
        rejected.push({ candidate, error: stagedError });
        continue;
      }
      const timestamp = now().toISOString();
      accepted.push({
        schemaVersion: PERSISTED_TASK_SCHEMA_VERSION,
        id,
        profileId: options.profileId,
        kind: 'upload',
        stage: 'queued',
        source: options.source,
        originalName,
        stagedName: staged.name,
        localUri: staged.uri,
        byteSize: staged.size,
        mimeType: staged.mimeType,
        metadata: defaultUploadMetadataDraft(safeDisplayName.replace(/\.[^.]+$/, '')),
        progress: 0,
        retryCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch {
      rejected.push({
        candidate,
        error: taskError(
          'missing-file',
          // Native provider errors can contain source paths, filenames, or
          // platform-owned English copy. Keep the durable/user-visible task
          // error translated and free of untrusted provider detail.
          translateRuntime('intakeRuntime.stageFailed', { name: safeDisplayName }),
        ),
      });
    }
  }
  return { accepted, rejected };
}

export type StagedFileRetention = 'delete-now' | 'delete-after-retention' | 'retain';

export function stagedFileRetention(task: PersistentTask): StagedFileRetention {
  if (!task.localUri) return 'delete-now';
  if (task.stage === 'canceled') {
    return task.cancellationDisposition === 'local' ? 'delete-now' : 'retain';
  }
  if (task.stage === 'ready') return 'delete-after-retention';
  return 'retain';
}

export function tasksReadyForStagingCleanup(
  tasks: readonly PersistentTask[],
  now = new Date(),
  retentionMs = 24 * 60 * 60 * 1000,
) {
  return tasks.filter((task) => {
    if (!task.localUri || (task.stage !== 'ready' && task.stage !== 'canceled')) return false;
    if (task.stage === 'canceled') return task.cancellationDisposition === 'local';
    const terminalAt = Date.parse(task.completedAt ?? task.updatedAt);
    return Number.isFinite(terminalAt) && now.getTime() - terminalAt >= retentionMs;
  });
}
