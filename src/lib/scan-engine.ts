/**
 * Folio can reach a paper document through more than one scanner.
 *
 * - `builtin` is the bundled ML Kit document scanner (`expo-document-scanner`).
 *   It is the best experience, but it needs Google Play Services, so it is
 *   unavailable on de-Googled phones and unshippable on F-Droid.
 * - `fairscan` delegates to FairScan (GPL-3, https://github.com/pynicolas/FairScan)
 *   through its documented, experimental `SCAN_TO_PDF` intent. Android only.
 *
 * This module holds the choice itself, with no platform or native dependency,
 * so the decision stays testable off-device.
 */

export const SCAN_ENGINE_PREFERENCES = ['auto', 'fairscan', 'builtin'] as const;

export type ScanEnginePreference = (typeof SCAN_ENGINE_PREFERENCES)[number];

export const DEFAULT_SCAN_ENGINE_PREFERENCE: ScanEnginePreference = 'auto';

export type ScanEngine = 'fairscan' | 'builtin';

export type ScanEngineUnavailableReason = 'fairscan-not-installed' | 'no-scan-engine';

export type ScanEngineDecision =
  | { engine: ScanEngine }
  | { engine: null; reason: ScanEngineUnavailableReason };

export function isScanEnginePreference(value: unknown): value is ScanEnginePreference {
  return SCAN_ENGINE_PREFERENCES.includes(value as ScanEnginePreference);
}

/** FairScan is an Android application; no other platform can host it. */
export function supportsFairScan(platform: string): boolean {
  return platform === 'android';
}

export function chooseScanEngine(input: {
  platform: string;
  preference: ScanEnginePreference;
  fairScanAvailable: boolean;
  builtInAvailable: boolean;
}): ScanEngineDecision {
  const fairScan = supportsFairScan(input.platform) && input.fairScanAvailable;

  if (input.preference === 'fairscan') {
    // An explicit choice never falls back silently: the caller has to tell the
    // person that FairScan is missing and where to install it.
    return fairScan ? { engine: 'fairscan' } : { engine: null, reason: 'fairscan-not-installed' };
  }

  if (input.preference === 'builtin') {
    return input.builtInAvailable ? { engine: 'builtin' } : { engine: null, reason: 'no-scan-engine' };
  }

  // Automatic: prefer the libre scanner that needs no Google Play Services,
  // then the bundled one. With neither, the caller keeps the manual camera and
  // the file picker, which the scan screen already offers.
  if (fairScan) return { engine: 'fairscan' };
  if (input.builtInAvailable) return { engine: 'builtin' };
  return { engine: null, reason: 'no-scan-engine' };
}
