import { Platform } from 'react-native';

import type { ScanResult } from 'expo-document-scanner';

export type SmartScanPage = {
  uri: string;
  base64?: string;
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
      includeBase64: Platform.OS === 'ios',
      maxNumDocuments: 24,
      galleryImportAllowed: true,
      includePdf: Platform.OS === 'android',
      scannerMode: 'full',
    });

    if (!result.pages.length) throw new Error('The scanner did not return any pages.');
    return {
      pages: result.pages.map((page) => ({ uri: page.uri, base64: page.base64 })),
      pdfUri: result.pdfUri,
    };
  } catch (error) {
    const message = messageFrom(error);
    if (isCancellation(message)) return null;
    if (isUnavailable(message)) throw new SmartScannerUnavailableError(message);
    throw new Error(message || 'The document scanner could not finish this scan.');
  }
}

function pdfHtml(pages: SmartScanPage[]) {
  const pageMarkup = pages
    .map((page) => {
      if (!page.base64) throw new Error('A scanned page could not be prepared for PDF export.');
      const source = `data:${imageMimeType(page.uri)};base64,${page.base64}`;
      return `<section class="page"><img src="${source}" /></section>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      @page { margin: 0; }
      html, body { margin: 0; padding: 0; background: #fff; }
      .page {
        width: 100vw;
        height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        break-after: page;
        page-break-after: always;
      }
      .page:last-child { break-after: auto; page-break-after: auto; }
      img { display: block; width: 100%; height: 100%; object-fit: contain; }
    </style>
  </head>
  <body>${pageMarkup}</body>
</html>`;
}

async function createPdfFromPages(pages: SmartScanPage[]) {
  const { printToFileAsync } = await import('expo-print');
  const result = await printToFileAsync({
    html: pdfHtml(pages),
    width: 595,
    height: 842,
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  return result.uri;
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
