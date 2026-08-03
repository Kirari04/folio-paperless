import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [viewer, webViewer, documentDetail, pageEditor, mergeSelection, secureCache, workspace, search, nativePdfPatch] = await Promise.all([
  readFile(new URL('../src/components/document-preview-viewer.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/document-preview-viewer.web.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/document/[id].tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/document-pdf-page-editor.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/document-pdf-merge-selection.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/secure-pdf-preview-cache.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/document-paperless3-workspace.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/viewer-search.ts', import.meta.url), 'utf8'),
  readFile(new URL('../patches/react-native-pdf+7.0.4.patch', import.meta.url), 'utf8'),
]);

test('viewer search restores the pre-search page and drives native renderer search/highlights', () => {
  assert.match(viewer, /searchOriginPage\.current = page/);
  assert.match(viewer, /function closeSearch\(\)[\s\S]*setSearchOpen\(false\)[\s\S]*goToPage\(searchOriginPage\.current\)/);
  assert.match(viewer, /searchQuery=\{searchOpen \? nativeSearchQuery : ''\}/);
  assert.match(viewer, /searchCurrentIndex=\{activeMatch\}/);
  assert.match(viewer, /onPdfSearchResult=\{handleNativeSearchResult\}/);
  assert.doesNotMatch(viewer, /searchPdfPages\(searchPages/);
  assert.match(viewer, /viewer\.searchSourceUnavailable/);
  assert.match(search, /if \(pageCount !== 1\) return null/);
  assert.match(search, /source: 'single-page-document' \| 'page-extraction'/);
  assert.match(search, /validateNativePdfSearchEvent/);
  assert.doesNotMatch(search, /fullText\.split\('\\f'\)/);
});

test('native PDF search remains page-aware, cancellable, highlighted, and local-only', () => {
  assert.match(nativePdfPatch, /beginFindString:_runningSearchQuery/);
  assert.match(nativePdfPatch, /hasSearchableText \? "ready" : "unavailable"/);
  assert.match(nativePdfPatch, /pdfDocumentContainsSearchableText/);
  assert.match(nativePdfPatch, /highlightedSelections/);
  assert.match(nativePdfPatch, /findStart\(query/);
  assert.match(nativePdfPatch, /textPageCountRects\(start, length\)/);
  assert.match(nativePdfPatch, /transient final List<RectF> rects/);
  assert.match(nativePdfPatch, /\.onDrawAll\(this\)/);
  assert.match(nativePdfPatch, /task\.cancel\(true\)/);
  assert.match(nativePdfPatch, /Only local PDF files can be searched/);
  assert.doesNotMatch(nativePdfPatch, /^\+.*Load pdf failed\. path=/m);
  assert.doesNotMatch(nativePdfPatch, /^\+.*Log\.[a-z]+\([^\n]*(?:path|query|snippet)/mi);
});

test('page editing renders real single-page thumbnails from one credential-free local PDF', () => {
  assert.match(pageEditor, /prepareSecurePdfPreview\(/);
  assert.match(pageEditor, /<PdfView[\s\S]*singlePage[\s\S]*source=\{\{ uri: localUri \}\}/);
  assert.doesNotMatch(pageEditor, /<PdfView[\s\S]*source=\{\{[\s\S]*headers:/);
  assert.match(pageEditor, /movePdfEditorSelection/);
  assert.match(pageEditor, /rotatePdfEditorSelection/);
  assert.match(pageEditor, /deletePdfEditorSelection/);
  assert.match(pageEditor, /togglePdfEditorSplits/);
});

test('PDF preview caches and merge thumbnails stay profile scoped and mTLS aware', () => {
  assert.match(secureCache, /usesNativeMutualTls\(request\.credentials\)/);
  assert.match(secureCache, /downloadPaperlessFileWithCredentials/);
  assert.match(secureCache, /profileId[\s\S]*digestStringAsync/);
  assert.match(
    secureCache,
    /ensureOwnedProfileRoot\(Paths\.cache, profileId, nativeProfileRootStorage\)/,
  );
  assert.match(secureCache, /new Directory\([\s\S]*'pdf-editor'/);
  assert.doesNotMatch(secureCache, /new File\(Paths\.cache, `folio-pdf-editor/);
  assert.match(secureCache, /assertNativeProfileRootAllocationAllowed\(profileId\)/);
  assert.match(secureCache, /dispose:[\s\S]*destination\.delete\(\)/);
  assert.match(secureCache, /MAX_PDF_PREVIEW_BYTES/);
  assert.match(secureCache, /assertSafePdfFile/);
  assert.match(viewer, /downloadFileWithinLimit/);
  assert.match(viewer, /assertSafePdfFile/);
  assert.match(mergeSelection, /SecureDocumentThumbnail/);
  assert.match(mergeSelection, /downloadPaperlessFileWithCredentials/);
  assert.match(mergeSelection, /selectedIds\.indexOf\(documentId\)/);
});

test('preview remains bound to the explicitly selected representation on native and web', () => {
  assert.match(viewer, /previewKind === 'image'/);
  assert.match(viewer, /representationSupported=\{previewKind !== 'unsupported'\}/);
  assert.match(webViewer, /fetch\(uri/);
  assert.match(webViewer, /responseBlobWithinLimit/);
  assert.match(webViewer, /hasPdfHeader/);
  assert.doesNotMatch(webViewer, /source=\{fallbackSource\}/);
  assert.match(documentDetail, /fallbackSource=\{previewRequest\s*\? null/);
  assert.match(documentDetail, /mimeType=\{previewRequest\?\.mimeType \?\? 'application\/pdf'\}/);
});

test('workspace submits thumbnail plans only through current dedicated API operations', () => {
  assert.match(workspace, /advanced\.api\.editPdf\(/);
  assert.match(workspace, /updateDocument: !plan\.hasSplits/);
  assert.match(workspace, /advanced\.api\.mergeDocuments\(/);
  assert.match(workspace, /deleteOriginals: false/);
  assert.doesNotMatch(workspace, /bulk_edit/);
});
