import { Directory, File, Paths } from 'expo-file-system';

import {
  assertSafeTemporaryPathSegment,
  isExpiredTemporaryFile,
  TEMPORARY_FILE_MAX_AGE_MS,
} from './temporary-file-policy';

function deleteExpiredFiles(directory: Directory, now: number, maxAgeMs: number): boolean {
  if (!directory.exists) return true;

  for (const entry of directory.list()) {
    if (entry instanceof Directory) {
      if (deleteExpiredFiles(entry, now, maxAgeMs) && entry.exists) entry.delete();
      continue;
    }
    if (entry instanceof File && isExpiredTemporaryFile(entry.lastModified, now, maxAgeMs)) {
      entry.delete();
    }
  }
  return directory.list().length === 0;
}

function cleanupRoot(root: Directory, now = Date.now(), maxAgeMs = TEMPORARY_FILE_MAX_AGE_MS) {
  try {
    if (!root.exists) return;
    deleteExpiredFiles(root, now, maxAgeMs);
  } catch {
    // A cache cleanup must never block opening or exporting a document.
  }
}

function removeLegacyUnscopedViewerFiles() {
  try {
    for (const entry of Paths.cache.list()) {
      if (entry instanceof File && /^folio-.*-preview\.pdf$/.test(entry.name)) entry.delete();
    }
  } catch {
    // Legacy cache removal is best effort and never includes protected pins.
  }
}

export function viewerPreviewDirectory(profileId: string): Directory {
  removeLegacyUnscopedViewerFiles();
  const root = new Directory(Paths.cache, 'folio-previews');
  root.create({ idempotent: true, intermediates: true });
  cleanupRoot(root);
  const directory = new Directory(
    root,
    assertSafeTemporaryPathSegment(profileId, 'The connection profile ID'),
  );
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

export function cleanupExpiredExportFiles() {
  cleanupRoot(new Directory(Paths.cache, 'folio-exports'));
}

export function removeProfileTemporaryFiles(profileId: string) {
  const safeProfileId = assertSafeTemporaryPathSegment(
    profileId,
    'The connection profile ID',
  );
  for (const rootName of ['folio-previews', 'folio-exports'] as const) {
    const directory = new Directory(Paths.cache, rootName, safeProfileId);
    if (directory.exists) directory.delete();
  }
}
