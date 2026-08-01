import { Platform } from 'react-native';

import type { ScanResult } from 'expo-document-scanner';

import { createIOSScanPdf } from '@/lib/folio-ios-support-native';

export const MAX_SCAN_PAGES = 24;

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
      maxNumDocuments: MAX_SCAN_PAGES,
      galleryImportAllowed: true,
      includePdf: Platform.OS === 'android',
      scannerMode: 'full',
    });

    if (!result.pages.length) throw new Error('The scanner did not return any pages.');
    if (result.pages.length > MAX_SCAN_PAGES) {
      throw new Error(
        `This scan has ${result.pages.length} pages. Folio supports up to ${MAX_SCAN_PAGES} pages per scan.`,
      );
    }
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

  return {
    uri: await createPdfFromPages(session.pages),
    name: scanName('pdf'),
    mimeType: 'application/pdf',
    pageCount,
  };
}
