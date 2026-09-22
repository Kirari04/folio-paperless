import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PDF_THUMBNAIL_PAGES,
  normalizePdfPageThumbnails,
  pdfPageThumbnailDirectoryUri,
} from '../src/lib/pdf-page-thumbnails.ts';

const cacheRoot = 'file:///data/user/0/app.folio.paperless/cache/profile-a/pdf-editor';

function page(number, overrides = {}) {
  return {
    page: number,
    uri: `${cacheRoot}/abcdef-pages/page-${number}.jpg`,
    width: 384,
    height: 543,
    ...overrides,
  };
}

test('thumbnail directories stay beside the leased PDF and keep its opaque name', () => {
  assert.equal(
    pdfPageThumbnailDirectoryUri(`${cacheRoot}/abcdef0123456789.pdf`),
    `${cacheRoot}/abcdef0123456789-pages`,
  );
  assert.equal(
    pdfPageThumbnailDirectoryUri(`  ${cacheRoot}/abcdef.PDF  `),
    `${cacheRoot}/abcdef-pages`,
  );
  assert.equal(
    pdfPageThumbnailDirectoryUri(`${cacheRoot}/abcdef`),
    `${cacheRoot}/abcdef-pages`,
  );
});

test('thumbnail directories refuse remote, traversing, or unexpected filenames', () => {
  for (const rejected of [
    'https://paperless.example/api/documents/4/preview/',
    'content://media/external/file/12',
    `${cacheRoot}/`,
    `${cacheRoot}/../escape.pdf`,
    `${cacheRoot}/..`,
    `${cacheRoot}/holiday photo.pdf`,
    `${cacheRoot}/a;rm -rf.pdf`,
  ]) {
    assert.throws(() => pdfPageThumbnailDirectoryUri(rejected), /Page previews need/);
  }
});

test('a native render result maps to contiguous pages in ascending order', () => {
  const normalized = normalizePdfPageThumbnails({
    pageCount: 3,
    pages: [page(3), page(1), page(2)],
  });
  assert.equal(normalized.pageCount, 3);
  assert.deepEqual(normalized.pages.map((entry) => entry.page), [1, 2, 3]);
  assert.deepEqual(normalized.pages[0], {
    page: 1,
    uri: `${cacheRoot}/abcdef-pages/page-1.jpg`,
    width: 384,
    height: 543,
  });
});

test('a native render result that skips, miscounts, or mis-sizes a page is refused', () => {
  assert.throws(
    () => normalizePdfPageThumbnails({ pageCount: 3, pages: [page(1), page(2)] }),
    /different number of pages/,
  );
  assert.throws(
    () => normalizePdfPageThumbnails({ pageCount: 3, pages: [page(1), page(2), page(4)] }),
    /out of order/,
  );
  assert.throws(
    () => normalizePdfPageThumbnails({
      pageCount: 1,
      pages: [page(1, { uri: 'https://paperless.example/page-1.jpg' })],
    }),
    /without a local file/,
  );
  assert.throws(
    () => normalizePdfPageThumbnails({ pageCount: 1, pages: [page(1, { height: 0 })] }),
    /without a usable size/,
  );
  for (const rejected of [
    null,
    {},
    { pageCount: 0, pages: [] },
    { pageCount: 1.5, pages: [page(1)] },
    { pageCount: MAX_PDF_THUMBNAIL_PAGES + 1, pages: [page(1)] },
    { pageCount: 1, pages: 'one' },
  ]) {
    assert.throws(() => normalizePdfPageThumbnails(rejected), /page renderer/);
  }
});
