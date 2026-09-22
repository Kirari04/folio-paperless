/**
 * Pure helpers for the page-editor thumbnail pipeline. Nothing here touches the
 * file system or a native module, so the derivation and validation rules can be
 * exercised directly in tests.
 */

export type PdfPageThumbnail = {
  page: number;
  uri: string;
  width: number;
  height: number;
};

export type PdfPageThumbnailSet = {
  pageCount: number;
  pages: PdfPageThumbnail[];
};

/** Matches the widest page count the editor is willing to plan. */
export const MAX_PDF_THUMBNAIL_PAGES = 10_000;

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Derives the private sub-directory that holds one PDF's page thumbnails:
 * `…/pdf-editor/<digest>.pdf` becomes `…/pdf-editor/<digest>-pages`. The name
 * is taken from the cache file the lease already owns, so the thumbnails stay
 * inside the same profile-scoped directory and are removed with it.
 */
export function pdfPageThumbnailDirectoryUri(pdfUri: string): string {
  const trimmed = pdfUri.trim();
  if (!trimmed.toLowerCase().startsWith('file://')) {
    throw new Error('Page previews need a local PDF file URL.');
  }
  const withoutFragment = trimmed.split('#', 1)[0].split('?', 1)[0];
  if (withoutFragment.split('/').includes('..')) {
    throw new Error('Page previews need a local PDF path without traversal.');
  }
  const separator = withoutFragment.lastIndexOf('/');
  const parent = withoutFragment.slice(0, separator);
  const name = withoutFragment.slice(separator + 1);
  const base = name.toLowerCase().endsWith('.pdf') ? name.slice(0, -4) : name;
  if (!base || !SAFE_NAME.test(base) || base === '.' || base === '..') {
    throw new Error('Page previews need an opaque local PDF filename.');
  }
  return `${parent}/${base}-pages`;
}

function thumbnailAt(value: unknown, index: number): PdfPageThumbnail {
  const entry = value as Partial<PdfPageThumbnail> | null | undefined;
  const page = entry?.page;
  const uri = entry?.uri;
  const width = entry?.width;
  const height = entry?.height;
  if (page !== index + 1) {
    throw new Error('The page renderer returned pages out of order.');
  }
  if (typeof uri !== 'string' || !uri.toLowerCase().startsWith('file://')) {
    throw new Error('The page renderer returned a page without a local file.');
  }
  if (
    typeof width !== 'number' || !Number.isFinite(width) || width <= 0
    || typeof height !== 'number' || !Number.isFinite(height) || height <= 0
  ) {
    throw new Error('The page renderer returned a page without a usable size.');
  }
  return { page, uri, width, height };
}

/**
 * Validates one native render result and returns pages in ascending page order.
 * A renderer that skips, duplicates, or reorders a page is rejected rather than
 * silently mapped onto the wrong editor slot.
 */
export function normalizePdfPageThumbnails(value: unknown): PdfPageThumbnailSet {
  const result = value as { pageCount?: unknown; pages?: unknown } | null | undefined;
  const pageCount = result?.pageCount;
  if (
    typeof pageCount !== 'number'
    || !Number.isSafeInteger(pageCount)
    || pageCount < 1
    || pageCount > MAX_PDF_THUMBNAIL_PAGES
  ) {
    throw new Error('The page renderer did not report a usable page count.');
  }
  const rendered = Array.isArray(result?.pages) ? [...result.pages] : [];
  if (rendered.length !== pageCount) {
    throw new Error('The page renderer returned a different number of pages.');
  }
  const ordered = rendered.sort((left, right) => {
    const leftPage = typeof (left as PdfPageThumbnail)?.page === 'number'
      ? (left as PdfPageThumbnail).page
      : Number.POSITIVE_INFINITY;
    const rightPage = typeof (right as PdfPageThumbnail)?.page === 'number'
      ? (right as PdfPageThumbnail).page
      : Number.POSITIVE_INFINITY;
    return leftPage - rightPage;
  });
  return { pageCount, pages: ordered.map(thumbnailAt) };
}
