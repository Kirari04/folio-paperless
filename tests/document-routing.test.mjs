import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDocumentReady,
  findRoutedDocument,
  isPendingDocument,
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

test('treats active processing placeholders as pending', () => {
  assert.equal(isPendingDocument({ status: 'processing', taskId: 'upload-1' }), true);
});

test('keeps failed task placeholders pending until Paperless resolves them', () => {
  assert.equal(isPendingDocument({ status: 'inbox', taskId: 'upload-1' }), true);
});

test('treats a finished remote document with task identity as ready', () => {
  assert.equal(
    isPendingDocument({ status: 'inbox', taskId: 'upload-1', remoteId: 42 }),
    false,
  );
});

test('does not block ordinary local documents', () => {
  assert.doesNotThrow(() => assertDocumentReady({ status: 'inbox' }));
});

test('blocks mutations while a task placeholder is pending', () => {
  assert.throws(
    () => assertDocumentReady({ status: 'processing', taskId: 'upload-1' }),
    /still processing in Paperless/,
  );
});
