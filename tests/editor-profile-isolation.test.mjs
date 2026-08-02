import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('text editor state is remounted for every profile, document, field, and version target', async () => {
  const [editor, detail, deep] = await Promise.all([
    readFile(new URL('../src/components/text-edit-sheet.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/document/[id].tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/document-deep-sections.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(editor, /editorKey: string/);
  assert.match(editor, /<TextEditSheetEditor key=\{editorKey\}/);
  assert.match(detail, /editorKey=\{`\$\{activeProfile\?\.id \|\| 'none'\}:\$\{document\.id\}:title`\}/);
  assert.match(detail, /editorKey=\{`\$\{activeProfile\?\.id \|\| 'none'\}:\$\{document\.id\}:created`\}/);
  assert.match(deep, /editorKey=\{`\$\{activeProfile\?\.id \|\| 'none'\}:\$\{document\.id\}:asn`\}/);
  assert.match(deep, /editorKey=\{`\$\{activeProfile\?\.id \|\| 'none'\}:\$\{document\.id\}:new-note`\}/);
  assert.match(deep, /editorKey=\{`\$\{activeProfile\?\.id \|\| 'none'\}:\$\{document\.id\}:version:\$\{editingVersion\.id\}`\}/);
});
