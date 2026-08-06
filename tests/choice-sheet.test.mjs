import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('choice sheet keeps option rows and vertical groups on one spacing rhythm', async () => {
  const source = await readFile(
    new URL('../src/components/choice-sheet.tsx', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /const choiceRowLayout = \{[\s\S]*minHeight: 60,[\s\S]*gap: 10,[\s\S]*paddingHorizontal: 14,[\s\S]*paddingVertical: 10/,
  );
  assert.equal((source.match(/\.\.\.choiceRowLayout/g) ?? []).length, 2);
  assert.match(source, /list: \{\s*gap: 8,\s*paddingBottom: 12/);
  assert.match(source, /listHeader: \{\s*gap: 8/);
  assert.match(source, /empty: \{[\s\S]*paddingVertical: 24/);
  assert.match(source, /footer: \{[\s\S]*paddingTop: 12/);
});
