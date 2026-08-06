import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { documentFileActionContentState } from '../src/lib/document-file-action-state.ts';

test('airplane-mode capability failure resolves to the specific not-downloaded state', () => {
  assert.equal(documentFileActionContentState({
    capabilityLoading: false,
    loading: false,
    offline: true,
    offlineFilesResolved: true,
    hasRepresentations: false,
    hasSelectedChoice: false,
    hasLoadError: true,
  }), 'offline-unavailable');
});

test('a profile-valid pinned representation remains usable after live metadata fails', () => {
  assert.equal(documentFileActionContentState({
    capabilityLoading: false,
    loading: false,
    offline: true,
    offlineFilesResolved: true,
    hasRepresentations: true,
    hasSelectedChoice: true,
    hasLoadError: false,
  }), 'ready');
});

test('file actions resolve local files independently and render the localized offline state', async () => {
  const source = await readFile(
    new URL('../src/components/document-file-actions.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /Promise\.allSettled\(\[/);
  assert.match(source, /archiveResult\.value\?\.profileId === expectedProfileId/);
  assert.match(source, /\(!advancedApi \|\| online === false\) && \(archive \|\| original\)/);
  assert.match(source, /contentState === 'offline-unavailable'[\s\S]*t\('fileActions\.offlineUnavailable'\)/);
});

test('historical file actions fetch version-scoped metadata and verify remote bytes', async () => {
  const [actions, platform, nativeViewer, webViewer] = await Promise.all([
    readFile(new URL('../src/components/document-file-actions.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/document-platform-actions.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/document-preview-viewer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/document-preview-viewer.web.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(actions, /getRepresentations\(document\.remoteId, controller\.signal, versionId\)/);
  assert.match(actions, /checksum: choice\.info\.checksum/);
  assert.match(actions, /size: choice\.info\.size/);
  assert.match(platform, /verifyRepresentationOrCleanup\([\s\S]*verifyDownloadedRepresentationFile/);
  assert.match(platform, /input\.credentials\.profileId !== input\.api\.client\.profileId/);
  assert.match(platform, /input\.representations\.documentId !== input\.documentId/);
  assert.match(platform, /if \(file\.exists\) file\.delete\(\)/);
  assert.match(platform, /if \(operationDirectory\.exists\) operationDirectory\.delete\(\)/);
  assert.match(nativeViewer, /verifyDownloadedRepresentationFile/);
  assert.match(nativeViewer, /destination\.exists\) destination\.delete\(\)/);
  assert.match(webViewer, /verifyRepresentationDescriptor/);
});

test('printing is disabled outside native PDF support and rechecked at handoff', async () => {
  const [actions, platform] = await Promise.all([
    readFile(new URL('../src/components/document-file-actions.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/document-platform-actions.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(actions, /representationSupportsNativePrint\(selectedChoice\.info, Platform\.OS\)/);
  assert.match(actions, /disabled=\{!printSupported \|\| !!busy/);
  assert.match(platform, /Platform\.OS !== 'ios' && Platform\.OS !== 'android'/);
});

test('full-page document modals keep their headers below the system status bar', async () => {
  const [actions, workspace] = await Promise.all([
    readFile(new URL('../src/components/document-file-actions.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/document-paperless3-workspace.tsx', import.meta.url), 'utf8'),
  ]);

  for (const source of [actions, workspace]) {
    assert.match(source, /import \{ SafeAreaView \} from 'react-native-safe-area-context'/);
    assert.match(source, /<SafeAreaView edges=\{\['top'\]\} style=\{styles\.root\}>/);
  }
});
