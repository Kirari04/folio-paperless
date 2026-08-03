import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [detail, viewer] = await Promise.all([
  readFile(new URL('../src/app/document/[id].tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/document-preview-viewer.tsx', import.meta.url), 'utf8'),
]);

test('same document IDs remount every profile and credential-bound detail state', () => {
  assert.match(detail, /new WeakMap<PaperlessCredentials, number>\(\)/);
  assert.match(
    detail,
    /profileBindingKey = `\$\{activeProfile\?\.id \?\? 'none'\}:\$\{credentialBindingGeneration\(credentials\)\}`/,
  );
  assert.match(
    detail,
    /<ProfileBoundDocumentDetailScreen key=\{profileBindingKey\} profileBindingKey=\{profileBindingKey\}/,
  );
  assert.match(
    detail,
    /const loadSignature = `\$\{profileBindingKey\}:\$\{id\}:\$\{documentDetailsVersion\}`/,
  );
  assert.match(
    detail,
    /const presentedDocumentId = useRef\(\{[\s\S]*profileBindingKey,[\s\S]*documentId: document\?\.id/,
  );
  assert.doesNotMatch(detail, /profileBindingKey\s*=.*credentials\.(?:token|customHeaders)/);
});

test('preview requests require the current profile authority and hide stale prepared bytes', () => {
  assert.match(
    detail,
    /credentials\.profileId === activeProfile\?\.id;[\s\S]*activeCredentials = credentialsMatchActiveProfile \? credentials : null/,
  );
  assert.match(detail, /<DocumentPreviewViewer[\s\S]*bindingKey=\{profileBindingKey\}/);
  assert.match(
    detail,
    /key=\{`\$\{profileBindingKey\}:\$\{previewCacheKey\}:\$\{previewRequest \? 'selected' : 'server'\}`\}/,
  );
  assert.match(detail, /<DocumentFileActions[\s\S]*credentials=\{activeCredentials\}/);
  assert.match(viewer, /bindingKey: string/);
  assert.match(
    viewer,
    /const localPreviewUri = preparedPreview\?\.bindingKey === bindingKey[\s\S]*\? preparedPreview\.uri[\s\S]*: null/,
  );
  assert.match(viewer, /setPreparedPreview\(\{ bindingKey, uri: downloadedFile\.uri \}\)/);
  assert.match(viewer, /\}, \[bindingKey, cacheKey,/);
});
