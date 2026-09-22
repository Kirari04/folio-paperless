/**
 * FairScan's scan-to-PDF intent contract, with no platform dependency.
 *
 * FairScan (GPL-3, https://github.com/pynicolas/FairScan) is a libre Android
 * document scanner. Its README documents this integration under
 * "Experimental: Scan to PDF via intent", and warns that the contract may
 * change between versions, so everything Folio relies on is stated here:
 *
 *  - Folio starts the implicit action below for a result and sends no extras.
 *  - `RESULT_OK` returns the PDF in `Intent.getData()`, mirrored in `clipData`,
 *    behind a temporary read grant.
 *  - `RESULT_CANCELED` means the person backed out; that is not an error.
 *  - FairScan deletes its own copy, so the native side copies the bytes into
 *    Folio's private cache while the grant is alive and hands back a `file://`
 *    URI. A URI that is not in Folio's own storage is refused here: it would
 *    mean the copy never happened.
 */

export const FAIRSCAN_PACKAGE_NAME = 'org.fairscan.app';
export const FAIRSCAN_INTENT_ACTION = 'org.fairscan.app.action.SCAN_TO_PDF';
export const FAIRSCAN_FDROID_URL = `https://f-droid.org/packages/${FAIRSCAN_PACKAGE_NAME}/`;
export const FAIRSCAN_PLAY_URL =
  `https://play.google.com/store/apps/details?id=${FAIRSCAN_PACKAGE_NAME}`;

/** What the native module resolves with; null when the scan was cancelled. */
export type NativeFairScanResult = {
  uri: string;
  pageCount: number | null;
};

export type FairScanDocument = {
  uri: string;
  pageCount: number | null;
};

export class FairScanUnavailableError extends Error {
  constructor(message = 'FairScan is not installed on this device.') {
    super(message);
    this.name = 'FairScanUnavailableError';
  }
}

export function parseFairScanResult(
  result: NativeFairScanResult | null | undefined,
): FairScanDocument | null {
  if (!result) return null;
  if (typeof result.uri !== 'string' || !result.uri.startsWith('file://')) {
    throw new Error('FairScan did not return a scanned PDF Folio can read.');
  }
  const pageCount = typeof result.pageCount === 'number'
    && Number.isSafeInteger(result.pageCount)
    && result.pageCount > 0
    ? result.pageCount
    : null;
  return { uri: result.uri, pageCount };
}

/** Raised by `FolioFairScanScanner.kt` when nothing answers the intent. */
export const FAIRSCAN_UNAVAILABLE_CODE = 'ERR_FAIRSCAN_UNAVAILABLE';

export function nativeErrorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
}

/**
 * True when a native rejection means "FairScan cannot serve this scan", which
 * the scan screen turns into an install prompt rather than a failure.
 */
export function isFairScanUnavailableRejection(error: unknown): boolean {
  return nativeErrorCode(error) === FAIRSCAN_UNAVAILABLE_CODE;
}
