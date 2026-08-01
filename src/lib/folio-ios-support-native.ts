import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

type FolioIOSSupportNativeModule = {
  createPdfAsync: (pageUris: string[]) => Promise<string>;
};

const iosSupportModule = Platform.OS === 'ios'
  ? requireOptionalNativeModule<FolioIOSSupportNativeModule>('FolioIOSSupport')
  : null;

export async function createIOSScanPdf(pageUris: string[]) {
  if (!iosSupportModule) {
    throw new Error(
      'Multi-page scanning needs the current Folio iOS build. Rebuild the app and scan again.',
    );
  }
  return iosSupportModule.createPdfAsync(pageUris);
}
