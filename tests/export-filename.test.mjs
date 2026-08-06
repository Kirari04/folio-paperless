import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeExportFilename } from '../src/lib/export-filename.ts';

test('export filenames remove raw characters rejected by Android file URIs', () => {
  assert.equal(
    sanitizeExportFilename('[Docker] Confirmation ^ Invoice Paid.pdf', 'document.pdf'),
    '-Docker- Confirmation - Invoice Paid.pdf',
  );
});

test('export filenames remain portable and fall back when empty', () => {
  assert.equal(
    sanitizeExportFilename('../Tax:Return?.pdf', 'document.pdf'),
    '-Tax-Return-.pdf',
  );
  assert.equal(sanitizeExportFilename('   ', 'document.pdf'), 'document.pdf');
  assert.equal(sanitizeExportFilename('Invoice\u0000.pdf', 'document.pdf'), 'Invoice-.pdf');
  assert.equal(sanitizeExportFilename('Rechnung März.pdf', 'document.pdf'), 'Rechnung März.pdf');
});
