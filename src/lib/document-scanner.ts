import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

import type { ScanResult } from 'expo-document-scanner';

import { createIOSScanPdf } from '@/lib/folio-ios-support-native';
import {
  FairScanUnavailableError,
  isFairScanAvailable,
  scanWithFairScan,
} from '@/lib/fairscan-scanner';
import {
  chooseScanEngine,
  type ScanEngine,
  type ScanEnginePreference,
  type ScanEngineUnavailableReason,
} from '@/lib/scan-engine';

export type SmartScanPage = {
  uri: string;
};

export type SmartScanSession = {
  pages: SmartScanPage[];
  pdfUri?: string;
};

export type PreparedScanFile = {
  uri: string;
  name: string;
  mimeType: string;
  pageCount: number;
};

export async function discardTemporaryFiles(uris: (string | undefined)[]) {
  const localUris = [...new Set(uris.filter((uri): uri is string => Boolean(uri?.startsWith('file://'))))];
  await Promise.all(
    localUris.map((uri) => FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined)),
  );
}

export async function discardSmartScan(session: SmartScanSession) {
  await discardTemporaryFiles([
    ...session.pages.map((page) => page.uri),
    session.pdfUri,
  ]);
}

export class SmartScannerUnavailableError extends Error {
  constructor(message = 'Smart scanning is not available in this build.') {
    super(message);
    this.name = 'SmartScannerUnavailableError';
  }
}

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isCancellation(message: string) {
  return /cancel(?:led|ed)?/i.test(message);
}

function isUnavailable(message: string) {
  return /not supported|not available|hybrid object|nitro|native module|play services|no activity/i.test(
    message,
  );
}

function imageMimeType(uri: string) {
  return /\.png(?:$|[?#])/i.test(uri) ? 'image/png' : 'image/jpeg';
}

function imageExtension(uri: string) {
  return imageMimeType(uri) === 'image/png' ? 'png' : 'jpg';
}

function scanName(extension: string) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const time = now.toTimeString().slice(0, 5).replace(':', '-');
  return `Scan ${day} ${time}.${extension}`;
}

export async function launchSmartScanner(): Promise<SmartScanSession | null> {
  let scanDocument: (options: {
    quality?: number;
    includeBase64?: boolean;
    maxNumDocuments?: number;
    galleryImportAllowed?: boolean;
    includePdf?: boolean;
    scannerMode?: 'full' | 'base' | 'base_with_filter';
  }) => Promise<ScanResult>;

  try {
    ({ scanDocument } = await import('expo-document-scanner'));
  } catch (error) {
    throw new SmartScannerUnavailableError(messageFrom(error));
  }

  try {
    const result = await scanDocument({
      quality: 0.9,
      includeBase64: false,
      galleryImportAllowed: true,
      includePdf: Platform.OS === 'android',
      scannerMode: 'full',
    });

    if (!result.pages.length) throw new Error('The scanner did not return any pages.');
    return {
      pages: result.pages.map((page) => ({ uri: page.uri })),
      pdfUri: result.pdfUri,
    };
  } catch (error) {
    const message = messageFrom(error);
    if (isCancellation(message)) return null;
    if (isUnavailable(message)) throw new SmartScannerUnavailableError(message);
    throw new Error(message || 'The document scanner could not finish this scan.');
  }
}

async function createPdfFromPages(pages: SmartScanPage[]) {
  if (Platform.OS !== 'ios') {
    throw new Error('The document scanner did not return its expected multi-page PDF.');
  }
  return createIOSScanPdf(pages.map((page) => page.uri));
}

export async function prepareSmartScan(session: SmartScanSession): Promise<PreparedScanFile> {
  const pageCount = session.pages.length;

  if (session.pdfUri) {
    return {
      uri: session.pdfUri,
      name: scanName('pdf'),
      mimeType: 'application/pdf',
      pageCount,
    };
  }

  if (Platform.OS === 'ios') {
    return {
      uri: await createPdfFromPages(session.pages),
      name: scanName('pdf'),
      mimeType: 'application/pdf',
      pageCount,
    };
  }

  if (pageCount === 1) {
    const page = session.pages[0];
    const extension = imageExtension(page.uri);
    return {
      uri: page.uri,
      name: scanName(extension),
      mimeType: imageMimeType(page.uri),
      pageCount,
    };
  }

  throw new Error('The document scanner did not return its expected multi-page PDF.');
}

export class ScanEngineUnavailableError extends Error {
  readonly reason: ScanEngineUnavailableReason;

  constructor(reason: ScanEngineUnavailableReason, message: string) {
    super(message);
    this.name = 'ScanEngineUnavailableError';
    this.reason = reason;
  }
}

export type ScanLaunchResult =
  /** The person backed out of the scanner. */
  | { kind: 'cancelled' }
  /** Page images Folio reviews itself before uploading. */
  | { kind: 'session'; engine: ScanEngine; session: SmartScanSession }
  /** A finished PDF; the external engine already offered its own review. */
  | { kind: 'document'; engine: ScanEngine; file: PreparedScanFile };

export async function isSmartScannerAvailable(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    await import('expo-document-scanner');
    return true;
  } catch {
    return false;
  }
}

/**
 * The single entry point every scan goes through. It resolves the engine from
 * the stored preference and what this device actually offers, then returns
 * either page images for Folio's review step or a finished PDF.
 */
export async function launchScanner(
  preference: ScanEnginePreference,
): Promise<ScanLaunchResult> {
  const [fairScanAvailable, builtInAvailable] = await Promise.all([
    preference === 'builtin' ? Promise.resolve(false) : isFairScanAvailable(),
    preference === 'fairscan' ? Promise.resolve(false) : isSmartScannerAvailable(),
  ]);
  const decision = chooseScanEngine({
    platform: Platform.OS,
    preference,
    fairScanAvailable,
    builtInAvailable,
  });

  if (decision.engine === null) {
    throw new ScanEngineUnavailableError(
      decision.reason,
      decision.reason === 'fairscan-not-installed'
        ? 'FairScan is not installed on this device.'
        : 'No document scanner is available on this device.',
    );
  }

  if (decision.engine === 'fairscan') {
    let document: Awaited<ReturnType<typeof scanWithFairScan>>;
    try {
      document = await scanWithFairScan();
    } catch (error) {
      if (error instanceof FairScanUnavailableError) {
        throw new ScanEngineUnavailableError('fairscan-not-installed', error.message);
      }
      throw error;
    }
    if (!document) return { kind: 'cancelled' };
    return {
      kind: 'document',
      engine: 'fairscan',
      file: {
        uri: document.uri,
        name: scanName('pdf'),
        mimeType: 'application/pdf',
        pageCount: document.pageCount ?? 1,
      },
    };
  }

  const session = await launchSmartScanner();
  if (!session) return { kind: 'cancelled' };
  return { kind: 'session', engine: 'builtin', session };
}
