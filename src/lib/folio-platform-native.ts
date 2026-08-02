import { NativeModule, requireOptionalNativeModule } from 'expo';

import type {
  FolioPlatformNativePort,
  NativeOpenUrlEvent,
  NativeShortcutEvent,
} from './os-search-native-adapter';

type FolioPlatformEvents = {
  onShortcut(event: NativeShortcutEvent): void;
  onOpenUrl(event: NativeOpenUrlEvent): void;
};

declare class FolioPlatformNativeModule
  extends NativeModule<FolioPlatformEvents>
  implements FolioPlatformNativePort
{
  getCapabilitiesAsync(): ReturnType<FolioPlatformNativePort['getCapabilitiesAsync']>;
  setSearchAccessStateAsync(
    unlocked: boolean,
    clearOnBackground: boolean,
  ): Promise<void>;
  replaceSearchIndexAsync(
    entries: Parameters<FolioPlatformNativePort['replaceSearchIndexAsync']>[0],
  ): Promise<void>;
  upsertSearchEntriesAsync(
    entries: Parameters<FolioPlatformNativePort['upsertSearchEntriesAsync']>[0],
  ): Promise<void>;
  removeSearchEntriesAsync(identifiers: string[]): Promise<void>;
  removeSearchProfileAsync(profileId: string): Promise<void>;
  clearSearchIndexAsync(): Promise<void>;
  consumeInitialShortcutAsync(): Promise<string | null>;
  consumeInitialUrlAsync(): Promise<string | null>;
  verifyOidcRs256Async(
    signingInput: string,
    signatureBase64Url: string,
    modulusBase64Url: string,
    exponentBase64Url: string,
  ): Promise<boolean>;
  excludeFileFromBackupAsync(fileUri: string): Promise<void>;
  acquireProtectedStorageLeaseAsync(): Promise<string>;
  releaseProtectedStorageLeaseAsync(leaseId: string): Promise<void>;
}

export interface FolioProtectedStorageNativePort {
  acquireProtectedStorageLeaseAsync(): Promise<string>;
  releaseProtectedStorageLeaseAsync(leaseId: string): Promise<void>;
}

const folioPlatformModule =
  requireOptionalNativeModule<FolioPlatformNativeModule>('FolioPlatform');

export function getFolioPlatformNativeModule(): FolioPlatformNativePort | null {
  return folioPlatformModule;
}

export function getFolioProtectedStorageNativeModule(): FolioProtectedStorageNativePort | null {
  return folioPlatformModule;
}
