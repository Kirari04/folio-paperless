import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { inboxStatusFromTags, isInboxTagOption } from '../src/lib/inbox-tag.ts';

test('inbox tags are recognised by the server flag, whatever their name', () => {
  assert.equal(isInboxTagOption({ name: 'À vérifier', isInboxTag: true }), true);
  assert.equal(isInboxTagOption({ name: 'Posteingang', isInboxTag: true }), true);
  assert.equal(isInboxTagOption({ name: 'inbox', isInboxTag: false }), false);
  assert.equal(isInboxTagOption({ name: 'Inbox' }), true);
  assert.equal(isInboxTagOption({ name: 'Maison' }), false);
  assert.equal(inboxStatusFromTags([{ name: 'Maison' }, { name: 'À vérifier', isInboxTag: true }]), 'inbox');
  assert.equal(inboxStatusFromTags([{ name: 'Maison' }]), 'archived');
  assert.equal(inboxStatusFromTags([]), 'archived');
});

test('no module decides inbox membership from the literal tag name any more', async () => {
  const files = [
    '../src/context/app-context.tsx',
    '../src/lib/metadata-update.ts',
    '../src/lib/paperless-workspace-capabilities.ts',
    '../src/lib/bulk-document-reconciliation.ts',
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /toLocaleLowerCase\(\) (?:!==|===) 'inbox'/, file);
  }
});
