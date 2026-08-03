import { serializeExternalRoute } from './external-routing.ts';
import {
  osSearchIdentifier,
  type OsSearchIndexAdapter,
  type OsSearchIndexEntry,
} from './os-search-privacy.ts';

export type NativeOsSearchEngine =
  | 'ios-core-spotlight'
  | 'android-platform-appsearch'
  | 'unsupported';

export type FolioPlatformCapabilities = {
  osSearch: {
    supported: boolean;
    engine: NativeOsSearchEngine;
    reason: string | null;
  };
  shortcuts: {
    supported: boolean;
    transport: 'ios-app-delegate' | 'android-static-deep-link' | 'unsupported';
  };
  widgets?: {
    supported: boolean;
    engine: 'android-appwidget-provider' | 'unsupported';
  };
  oidcRs256?: {
    supported: boolean;
    engine: 'security-framework' | 'java-security' | 'unsupported';
  };
};

export type NativeOsSearchEntry = {
  identifier: string;
  profileId: string;
  documentId: string;
  displayTitle: string;
  route: string;
  updatedAtEpochMs: number;
};

export type NativeShortcutEvent = { id: string };
export type NativeOpenUrlEvent = { url: string };

export type NativeOidcRs256Input = {
  signingInput: string;
  signatureBase64Url: string;
  modulusBase64Url: string;
  exponentBase64Url: string;
};

export type NativeEventSubscription = { remove(): void };

export interface FolioPlatformNativePort {
  getCapabilitiesAsync(): Promise<FolioPlatformCapabilities>;
  setSearchAccessStateAsync(unlocked: boolean, clearOnBackground: boolean): Promise<void>;
  replaceSearchIndexAsync(entries: NativeOsSearchEntry[]): Promise<void>;
  upsertSearchEntriesAsync(entries: NativeOsSearchEntry[]): Promise<void>;
  removeSearchEntriesAsync(identifiers: string[]): Promise<void>;
  removeSearchProfileAsync(profileId: string): Promise<void>;
  clearSearchIndexAsync(): Promise<void>;
  consumeInitialShortcutAsync(): Promise<string | null>;
  consumeInitialUrlAsync?(): Promise<string | null>;
  updateWidgetSnapshotAsync?(state: 'locked' | 'no-data' | 'ready', inboxCount: number | null): Promise<void>;
  clearWidgetSnapshotAsync?(): Promise<void>;
  verifyOidcRs256Async?(
    signingInput: string,
    signatureBase64Url: string,
    modulusBase64Url: string,
    exponentBase64Url: string,
  ): Promise<boolean>;
  excludeFileFromBackupAsync?(fileUri: string): Promise<void>;
  addListener(eventName: 'onShortcut', listener: (event: NativeShortcutEvent) => void): NativeEventSubscription;
  addListener(eventName: 'onOpenUrl', listener: (event: NativeOpenUrlEvent) => void): NativeEventSubscription;
}

export async function verifyNativeOidcRs256(
  nativeModule: FolioPlatformNativePort | null,
  input: NativeOidcRs256Input,
): Promise<boolean> {
  if (!nativeModule?.verifyOidcRs256Async) {
    throw new Error('The native RS256 verifier is unavailable.');
  }
  return nativeModule.verifyOidcRs256Async(
    input.signingInput,
    input.signatureBase64Url,
    input.modulusBase64Url,
    input.exponentBase64Url,
  );
}

export class OsSearchUnsupportedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`OS search is unsupported: ${reason}.`);
    this.name = 'OsSearchUnsupportedError';
    this.reason = reason;
  }
}

const UNAVAILABLE_CAPABILITIES: FolioPlatformCapabilities = {
  osSearch: {
    supported: false,
    engine: 'unsupported',
    reason: 'native-module-unavailable',
  },
  shortcuts: {
    supported: false,
    transport: 'unsupported',
  },
};

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertOpaqueId(value: string, field: string): string {
  if (!OPAQUE_ID_PATTERN.test(value)) throw new Error(`${field} is invalid.`);
  return value;
}

function toNativeEntry(entry: OsSearchIndexEntry): NativeOsSearchEntry {
  const profileId = assertOpaqueId(entry.profileId, 'Profile ID');
  const documentId = assertOpaqueId(entry.documentId, 'Document ID');
  if (entry.identifier !== osSearchIdentifier(profileId, documentId)) {
    throw new Error('OS search identifier does not match its profile and document.');
  }
  if (entry.keywords.length !== 0) {
    throw new Error('OS search keywords are not permitted by the Folio privacy policy.');
  }
  if (
    entry.route.kind !== 'document'
    || entry.route.source !== 'os-search'
    || entry.route.profileId !== profileId
    || entry.route.documentId !== documentId
  ) {
    throw new Error('OS search route does not match its profile and document.');
  }
  const updatedAtEpochMs = Date.parse(entry.updatedAt);
  if (!Number.isFinite(updatedAtEpochMs) || updatedAtEpochMs < 0) {
    throw new Error('OS search update date is invalid.');
  }
  return {
    identifier: entry.identifier,
    profileId,
    documentId,
    displayTitle: entry.displayTitle,
    route: serializeExternalRoute(entry.route),
    updatedAtEpochMs,
  };
}

function boundedEntries(entries: readonly OsSearchIndexEntry[]): NativeOsSearchEntry[] {
  if (entries.length > 1_000) throw new Error('OS search writes are limited to 1000 entries.');
  return entries.map(toNativeEntry);
}

export class NativeOsSearchIndexAdapter implements OsSearchIndexAdapter {
  private readonly nativeModule: FolioPlatformNativePort | null;

  constructor(nativeModule: FolioPlatformNativePort | null) {
    this.nativeModule = nativeModule;
  }

  async capabilities(): Promise<FolioPlatformCapabilities> {
    return this.nativeModule?.getCapabilitiesAsync() ?? UNAVAILABLE_CAPABILITIES;
  }

  async setAccessState(input: {
    unlocked: boolean;
    clearOnBackground: boolean;
  }): Promise<void> {
    await this.nativeModule?.setSearchAccessStateAsync(
      input.unlocked,
      input.clearOnBackground,
    );
  }

  async replace(entries: readonly OsSearchIndexEntry[]): Promise<void> {
    const nativeModule = await this.requireSupported();
    await nativeModule.replaceSearchIndexAsync(boundedEntries(entries));
  }

  async upsert(entries: OsSearchIndexEntry[]): Promise<void> {
    if (!entries.length) return;
    const nativeModule = await this.requireSupported();
    await nativeModule.upsertSearchEntriesAsync(boundedEntries(entries));
  }

  async remove(identifiers: string[]): Promise<void> {
    if (!identifiers.length) return;
    if (identifiers.length > 1_000) throw new Error('OS search removals are limited to 1000 entries.');
    const nativeModule = await this.requireSupported();
    await nativeModule.removeSearchEntriesAsync([...identifiers]);
  }

  async removeProfile(profileId: string): Promise<void> {
    const nativeModule = await this.requireSupported();
    await nativeModule.removeSearchProfileAsync(assertOpaqueId(profileId, 'Profile ID'));
  }

  async clear(): Promise<void> {
    if (!this.nativeModule) return;
    const capabilities = await this.nativeModule.getCapabilitiesAsync();
    if (!capabilities.osSearch.supported) return;
    await this.nativeModule.clearSearchIndexAsync();
  }

  nativePort(): FolioPlatformNativePort | null {
    return this.nativeModule;
  }

  private async requireSupported(): Promise<FolioPlatformNativePort> {
    if (!this.nativeModule) throw new OsSearchUnsupportedError('native-module-unavailable');
    const capabilities = await this.nativeModule.getCapabilitiesAsync();
    if (!capabilities.osSearch.supported) {
      throw new OsSearchUnsupportedError(capabilities.osSearch.reason ?? 'platform-unavailable');
    }
    return this.nativeModule;
  }
}

export async function createNativeOsSearchIndexAdapter(): Promise<NativeOsSearchIndexAdapter> {
  const { getFolioPlatformNativeModule } = await import('./folio-platform-native.ts');
  return new NativeOsSearchIndexAdapter(getFolioPlatformNativeModule());
}
