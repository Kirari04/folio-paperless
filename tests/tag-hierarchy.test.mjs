import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildVisibleTagOptions,
  selectedTagAncestorIds,
  selectTagFilterOptions,
} from '../src/lib/tag-hierarchy.ts';

test('visible tag hierarchy creates stable paths, depth, reverse children, and inbox state', () => {
  const tags = buildVisibleTagOptions([
    { id: 1, name: 'Finance' },
    { id: 2, name: 'Invoices', parent: 1, is_inbox_tag: true },
    { id: 3, name: '2026', parent: 2 },
  ]);
  assert.deepEqual(tags.map(({ remoteId, pathLabel, depth, parentRemoteId, childRemoteIds }) => ({
    remoteId, pathLabel, depth, parentRemoteId, childRemoteIds,
  })), [
    { remoteId: 1, pathLabel: 'Finance', depth: 0, parentRemoteId: undefined, childRemoteIds: [2] },
    { remoteId: 2, pathLabel: 'Finance / Invoices', depth: 1, parentRemoteId: 1, childRemoteIds: [3] },
    { remoteId: 3, pathLabel: 'Finance / Invoices / 2026', depth: 2, parentRemoteId: 2, childRemoteIds: [] },
  ]);
  assert.equal(tags[1].isInboxTag, true);
});

test('missing parents and cycles cannot leak ancestor identities or unsafe paths', () => {
  const tags = buildVisibleTagOptions([
    { id: 4, name: 'Visible child', parent: 999 },
    { id: 5, name: 'Cycle A', parent: 6 },
    { id: 6, name: 'Cycle B', parent: 5 },
  ]);
  for (const tag of tags) {
    assert.equal(tag.pathLabel, tag.name);
    assert.equal(tag.depth, 0);
    assert.equal(tag.parentRemoteId, undefined);
    assert.deepEqual(tag.childRemoteIds, []);
  }
});

test('permission-filtered hierarchy drops private recursive references and safely rebases visible descendants', () => {
  const tags = buildVisibleTagOptions([
    { id: 1, name: 'Public root', children: [2, 700, 701] },
    { id: 2, name: 'Public child', parent: 1, children: [3, 702] },
    { id: 3, name: 'Public leaf', parent: 2 },
    { id: 4, name: 'Visible below private', parent: 900, children: [5, 901] },
    { id: 5, name: 'Visible descendant', parent: 4 },
    { id: 4, name: 'Conflicting duplicate', parent: 1 },
    { id: 0, name: 'Invalid ID' },
  ]);

  assert.deepEqual(tags.map(({ remoteId, pathLabel, depth, parentRemoteId, childRemoteIds }) => ({
    remoteId, pathLabel, depth, parentRemoteId, childRemoteIds,
  })), [
    { remoteId: 1, pathLabel: 'Public root', depth: 0, parentRemoteId: undefined, childRemoteIds: [2] },
    { remoteId: 2, pathLabel: 'Public root / Public child', depth: 1, parentRemoteId: 1, childRemoteIds: [3] },
    { remoteId: 3, pathLabel: 'Public root / Public child / Public leaf', depth: 2, parentRemoteId: 2, childRemoteIds: [] },
    { remoteId: 4, pathLabel: 'Visible below private', depth: 0, parentRemoteId: undefined, childRemoteIds: [5] },
    { remoteId: 5, pathLabel: 'Visible below private / Visible descendant', depth: 1, parentRemoteId: 4, childRemoteIds: [] },
  ]);
  const serialized = JSON.stringify(tags);
  for (const inaccessibleId of [700, 701, 702, 900, 901]) {
    assert.equal(serialized.includes(String(inaccessibleId)), false);
  }
  assert.equal(serialized.includes('Conflicting duplicate'), false);
  assert.equal(serialized.includes('Invalid ID'), false);
});

test('tag filter rows collapse by visible ancestry and search both names and safe paths', () => {
  const tags = buildVisibleTagOptions([
    { id: 1, name: 'Finance' },
    { id: 2, name: 'Invoices', parent: 1 },
    { id: 3, name: '2026', parent: 2 },
    { id: 4, name: 'People' },
  ]);
  const remoteIds = (rows) => rows.map((row) => row.remoteId);

  assert.deepEqual(remoteIds(selectTagFilterOptions(tags, '', new Set())), [1, 4]);
  assert.deepEqual(remoteIds(selectTagFilterOptions(tags, '', new Set([1]))), [1, 2, 4]);
  assert.deepEqual(remoteIds(selectTagFilterOptions(tags, '', new Set([1, 2]))), [1, 2, 3, 4]);
  assert.deepEqual(remoteIds(selectTagFilterOptions(tags, '2026', new Set())), [3]);
  assert.deepEqual(remoteIds(selectTagFilterOptions(tags, 'finance / invoices', new Set())), [2, 3]);
});

test('existing child selections expand only their visible ancestor chain', () => {
  const tags = buildVisibleTagOptions([
    { id: 1, name: 'Finance' },
    { id: 2, name: 'Invoices', parent: 1 },
    { id: 3, name: '2026', parent: 2 },
    { id: 4, name: 'Other' },
  ]);
  assert.deepEqual(
    [...selectedTagAncestorIds(tags, ['remote-tag-3'])].sort((left, right) => left - right),
    [1, 2],
  );
  assert.deepEqual([...selectedTagAncestorIds(tags, ['removed-tag'])], []);
});

test('library filter wires disclosure separately from direct parent-only selection', async () => {
  const [component, translations] = await Promise.all([
    readFile(new URL('../src/components/library-filter-sheet.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/i18n/catalogs.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(component, /selectTagFilterOptions\(options, query, expandedTagIds\)/);
  assert.match(component, /accessibilityState=\{\{ expanded \}\}/);
  assert.match(component, /event\.stopPropagation\(\)/);
  assert.match(component, /onPress=\{\(\) => toggle\(item\.id\)\}/);
  assert.match(component, /filter\.tagSelectionScope/);
  assert.match(component, /filter\.parentOnlyHint/);
  assert.match(translations, /Selecting a parent matches that tag only\. Descendants are separate choices\./);
});
