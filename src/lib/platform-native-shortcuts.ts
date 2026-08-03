import type {
  FolioPlatformNativePort,
  NativeEventSubscription,
} from './os-search-native-adapter';
import { parseExternalUrl } from './external-routing.ts';
import { routeForShortcut } from './platform-shortcuts.ts';
import type { ExternalRoute } from './external-routing';

export type FolioShortcutSubscription = NativeEventSubscription & {
  supported: boolean;
};

const unsupportedSubscription: FolioShortcutSubscription = {
  supported: false,
  remove() {},
};

export async function connectFolioShortcutDelivery(
  nativeModule: FolioPlatformNativePort | null,
  listener: (route: ExternalRoute) => void,
): Promise<FolioShortcutSubscription> {
  if (!nativeModule) return unsupportedSubscription;
  const capabilities = await nativeModule.getCapabilitiesAsync();
  if (!capabilities.shortcuts.supported) return unsupportedSubscription;

  const deliver = (value: unknown) => {
    const parsed = routeForShortcut(value);
    if (parsed.accepted) listener(parsed.route);
  };
  const subscriptions = [
    nativeModule.addListener('onShortcut', (event) => deliver(event.id)),
  ];
  if (
    capabilities.shortcuts.transport === 'ios-app-delegate'
    && nativeModule.consumeInitialUrlAsync
  ) {
    const deliverUrl = (value: unknown) => {
      if (typeof value !== 'string') return;
      const parsed = parseExternalUrl(value, 'os-search');
      if (parsed.accepted) listener(parsed.route);
    };
    subscriptions.push(
      nativeModule.addListener('onOpenUrl', (event) => deliverUrl(event.url)),
    );
    const initialUrl = await nativeModule.consumeInitialUrlAsync();
    if (initialUrl) deliverUrl(initialUrl);
  }
  const initialShortcut = await nativeModule.consumeInitialShortcutAsync();
  if (initialShortcut) deliver(initialShortcut);
  return {
    supported: true,
    remove: () => subscriptions.forEach((subscription) => subscription.remove()),
  };
}

export async function listenForFolioShortcuts(
  listener: (route: ExternalRoute) => void,
): Promise<FolioShortcutSubscription> {
  const { getFolioPlatformNativeModule } = await import('./folio-platform-native.ts');
  return connectFolioShortcutDelivery(getFolioPlatformNativeModule(), listener);
}
