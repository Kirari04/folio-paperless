import { requireOptionalNativeModule } from 'expo';
import { Directory } from 'expo-file-system';
import { Platform } from 'react-native';

import {
  normalizePdfPageThumbnails,
  type PdfPageThumbnailSet,
} from './pdf-page-thumbnails.ts';

type FolioPdfPagesNativeModule = {
  renderPageThumbnails(
    pdfUri: string,
    outputDirectoryUri: string,
    maxWidth: number,
  ): Promise<unknown>;
};

let pdfPagesModule: FolioPdfPagesNativeModule | null | undefined;

function folioPdfPagesModule() {
  if (Platform.OS === 'web') return null;
  if (pdfPagesModule === undefined) {
    pdfPagesModule = requireOptionalNativeModule<FolioPdfPagesNativeModule>('FolioPdfPages');
  }
  return pdfPagesModule;
}

/** True when this build embeds the platform page-thumbnail renderer. */
export function pdfPageThumbnailsAvailable() {
  return folioPdfPagesModule() !== null;
}

/**
 * Renders every page of one local PDF into JPEG thumbnails, sequentially and
 * off the JavaScript thread, and returns them in page order. Resolves to `null`
 * on web or in a build without the native module, so callers can present the
 * "renderer unavailable" state instead of failing.
 */
export async function renderPdfPageThumbnails(
  pdfUri: string,
  outputDirectoryUri: string,
  maxWidth: number,
): Promise<PdfPageThumbnailSet | null> {
  const nativeModule = folioPdfPagesModule();
  if (!nativeModule) return null;
  const rendered = await nativeModule.renderPageThumbnails(pdfUri, outputDirectoryUri, maxWidth);
  return normalizePdfPageThumbnails(rendered);
}

/**
 * Removes one thumbnail directory. Deletion is best-effort: the directory lives
 * in the same bounded, profile-scoped cache as the PDF lease, which is cleaned
 * up by the platform if the process dies before this runs.
 */
export function deletePdfPageThumbnails(directoryUri: string | null | undefined) {
  if (!directoryUri || Platform.OS === 'web') return;
  try {
    const directory = new Directory(directoryUri);
    if (directory.exists) directory.delete();
  } catch {
    // Ignored: a stale thumbnail directory is bounded and profile scoped.
  }
}
