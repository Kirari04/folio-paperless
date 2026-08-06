import type { PaperlessRepresentation } from '../types/paperless-advanced.ts';
import type { OfflineFileRecord } from '../types/persistence.ts';

export type CachedPreviewSource = {
  filename: string | null;
  mimeType: string | null;
  representation: PaperlessRepresentation;
  uri: string;
};

export type PreferredCachedPreviewSource = CachedPreviewSource & {
  byteSize: number;
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

/**
 * Selects the user's preferred pinned representation, falling back only to a
 * different representation that is also present in the same profile-scoped
 * offline cache. This never substitutes a remote URL.
 */
export function resolvePreferredCachedPreviewSource(input: {
  documentId: string;
  expectedProfileId?: string;
  files: Partial<Record<PaperlessRepresentation, OfflineFileRecord | null | undefined>>;
  filenames?: Partial<Record<PaperlessRepresentation, string | null>>;
  mimeTypes?: Partial<Record<PaperlessRepresentation, string | null>>;
  preference: PaperlessRepresentation | null;
  versionId?: number;
}): PreferredCachedPreviewSource | null {
  const order: PaperlessRepresentation[] = input.preference
    ? [input.preference, input.preference === 'archive' ? 'original' : 'archive']
    : ['archive', 'original'];
  for (const representation of order) {
    const file = input.files[representation];
    const source = resolveCachedPreviewSource({
      documentId: input.documentId,
      expectedProfileId: input.expectedProfileId,
      file,
      filename: input.filenames?.[representation] ?? null,
      mimeType: input.mimeTypes?.[representation] ?? null,
      representation,
      versionId: input.versionId,
    });
    if (source && file) return { ...source, byteSize: file.byteSize };
  }
  return null;
}
