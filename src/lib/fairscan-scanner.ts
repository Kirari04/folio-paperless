import { Platform } from 'react-native';

import {
  FairScanUnavailableError,
  isFairScanUnavailableRejection,
  parseFairScanResult,
  type FairScanDocument,
} from '@/lib/fairscan-contract';
import { getFolioFairScanNativeModule } from '@/lib/folio-platform-native';

export {
  FAIRSCAN_FDROID_URL,
  FAIRSCAN_INTENT_ACTION,
  FAIRSCAN_PACKAGE_NAME,
  FAIRSCAN_PLAY_URL,
  FairScanUnavailableError,
  type FairScanDocument,
} from '@/lib/fairscan-contract';

/**
 * The Android side of FairScan's experimental scan-to-PDF intent; see
 * `src/lib/fairscan-contract.ts` for the contract itself and
 * `modules/folio-platform/.../FolioFairScanScanner.kt` for the native half.
 */
export async function isFairScanAvailable(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const native = getFolioFairScanNativeModule();
  if (!native?.isFairScanAvailableAsync) return false;
  try {
    return await native.isFairScanAvailableAsync();
  } catch {
    // An unreadable package list means Folio cannot promise FairScan.
    return false;
  }
}

/** Resolves to null when the person cancelled the scan inside FairScan. */
export async function scanWithFairScan(): Promise<FairScanDocument | null> {
  if (Platform.OS !== 'android') {
    throw new FairScanUnavailableError('FairScan is only available on Android.');
  }
  const native = getFolioFairScanNativeModule();
  if (!native?.scanWithFairScanAsync) {
    throw new FairScanUnavailableError(
      'This build of Folio does not include the FairScan scanner bridge.',
    );
  }
  try {
    return parseFairScanResult(await native.scanWithFairScanAsync());
  } catch (error) {
    if (isFairScanUnavailableRejection(error)) throw new FairScanUnavailableError();
    throw error;
  }
}
