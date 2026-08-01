import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findRoutedDocument,
  resolveDocumentAlias,
  taskIdFromPlaceholderId,
} from '../src/lib/document-routing.ts';

test('resolves a processing placeholder to its canonical document', () => {
  const aliases = { 'task-upload-1': 'remote-42' };
  assert.equal(resolveDocumentAlias('task-upload-1', aliases), 'remote-42');
});

test('follows aliases safely without looping', () => {
  const aliases = {
    'task-upload-1': 'remote-42',
    'remote-42': 'task-upload-1',
  };
  assert.equal(resolveDocumentAlias('task-upload-1', aliases), 'task-upload-1');
});

test('finds the finished document by task ID during the atomic handoff', () => {
  const processed = { id: 'remote-42', taskId: 'upload-1' };
  assert.equal(
    findRoutedDocument([processed], 'task-upload-1', 'task-upload-1'),
    processed,
  );
});

test('prefers the canonical document ID after the handoff', () => {
  const processed = { id: 'remote-42' };
  assert.equal(
    findRoutedDocument([processed], 'task-upload-1', 'remote-42'),
    processed,
  );
});

test('does not treat canonical IDs as processing placeholders', () => {
  assert.equal(taskIdFromPlaceholderId('remote-42'), null);
});
