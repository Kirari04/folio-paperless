import type { FolioWidgetSnapshot, WidgetSnapshotAdapter } from './widget-privacy';

export type NativeAndroidWidgetPayload = {
  state: FolioWidgetSnapshot['state'];
  inboxCount: number | null;
};

export function createNativeAndroidWidgetPayload(
  snapshot: FolioWidgetSnapshot,
): NativeAndroidWidgetPayload {
  if (snapshot.state !== 'ready') {
    return { state: snapshot.state, inboxCount: null };
  }
  if (!Number.isSafeInteger(snapshot.inboxCount) || snapshot.inboxCount < 0 || snapshot.inboxCount > 999) {
    throw new Error('Android widget inbox count is invalid.');
  }
  return { state: 'ready', inboxCount: snapshot.inboxCount };
}

export const folioAndroidWidgetSnapshotAdapter: WidgetSnapshotAdapter = {
  async updateSnapshot(snapshot) {
    const { getFolioPlatformNativeModule } = await import('./folio-platform-native.ts');
    const nativeModule = getFolioPlatformNativeModule();
    if (!nativeModule?.updateWidgetSnapshotAsync) return;
    const payload = createNativeAndroidWidgetPayload(snapshot);
    await nativeModule.updateWidgetSnapshotAsync(payload.state, payload.inboxCount);
  },
  async clearSnapshot() {
    const { getFolioPlatformNativeModule } = await import('./folio-platform-native.ts');
    await getFolioPlatformNativeModule()?.clearWidgetSnapshotAsync?.();
  },
};
