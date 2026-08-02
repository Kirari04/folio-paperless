import { Platform } from 'react-native';

import type { FolioRepository } from '@/types/persistence';
import { MemoryFolioRepository } from './memory-repository';
import { SQLiteFolioRepository } from './sqlite-repository';

let repository: FolioRepository | null = null;

export function getFolioRepository(): FolioRepository {
  repository ??= Platform.OS === 'web'
    ? new MemoryFolioRepository()
    : new SQLiteFolioRepository();
  return repository;
}

export function setFolioRepositoryForTests(next: FolioRepository | null) {
  repository = next;
}
