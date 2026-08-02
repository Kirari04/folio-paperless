import type { PaperlessRepresentation } from '../types/paperless-advanced.ts';
import type { OfflineFileRecord } from '../types/persistence.ts';

export type CachedPreviewSource = {
  filename: string | null;
  mimeType: string | null;
  representation: PaperlessRepresentation;
  uri: string;
};

/**
 * Resolves a pinned representation without consulting live server capabilities.
 * The record is accepted only when every persisted identity matches the active
 * document/profile so a stale profile switch cannot expose another archive.
 */
export function resolveCachedPreviewSource(input: {
  documentId: string;
  expectedProfileId?: string;
  file: OfflineFileRecord | null | undefined;
  filename: string | null;
  mimeType: string | null;
  representation: PaperlessRepresentation;
  versionId?: number;
}): CachedPreviewSource | null {
  const { file } = input;
  if (input.versionId !== undefined || !file) return null;
  if (input.expectedProfileId && file.profileId !== input.expectedProfileId) return null;
  if (file.documentId !== input.documentId || file.representation !== input.representation) return null;
  if (!file.uri.trim() || !Number.isFinite(file.byteSize) || file.byteSize <= 0) return null;
  return {
    representation: input.representation,
    uri: file.uri,
    filename: file.fileName ?? input.filename,
    mimeType: file.mimeType ?? input.mimeType,
  };
}
