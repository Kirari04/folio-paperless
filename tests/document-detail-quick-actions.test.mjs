import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [detail, fileActions] = await Promise.all([
  readFile(new URL('../src/app/document/[id].tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/document-file-actions.tsx', import.meta.url), 'utf8'),
]);

test('document quick actions run their named action without opening the file-options sheet', () => {
  assert.match(detail, /saveDocument: saveDocumentFile/);
  assert.match(detail, /onPress=\{openDocumentPreview\}/);
  assert.match(detail, /onPress=\{\(\) => void shareDocument\(\)\}/);
  assert.match(detail, /onPress=\{\(\) => void downloadDocument\(\)\}/);
  assert.doesNotMatch(detail, /setFileActions(?:Open)?\(['"](?:share|save)['"]\)/);
});

test('direct preview clears an advanced representation request before opening the viewer', () => {
  assert.match(
    detail,
    /function openDocumentPreview\(\) \{\s*setPreviewRequest\(null\);\s*setPreviewFailed\(false\);\s*setPreviewOpen\(true\);\s*\}/,
  );
});

test('advanced representation, offline, and public-link controls remain explicitly available', () => {
  assert.match(detail, /t\('detail\.fileOptions'\)/);
  assert.match(detail, /setFileActionsOpen\(true\)/);
  assert.match(detail, /fileActionsOpen && \(\s*<DocumentFileActions/);
  assert.doesNotMatch(fileActions, /DocumentFileActionIntent|intent: DocumentFileActionIntent/);
  assert.match(fileActions, /t\('fileActions\.managePrompt'\)/);
});
