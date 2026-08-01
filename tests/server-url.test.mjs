import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePaperlessServerUrl } from '../src/lib/server-url.ts';

test('normalizes a trusted Paperless origin and optional subpath', () => {
  assert.equal(
    normalizePaperlessServerUrl('  https://paperless.example.com/archive///  '),
    'https://paperless.example.com/archive',
  );
});

test('requires HTTPS when the platform policy requests it', () => {
  assert.throws(
    () => normalizePaperlessServerUrl('http://paperless.local', { requireHttps: true }),
    /iOS requires an HTTPS Paperless address/,
  );
});

test('keeps HTTP available to platforms whose transport policy allows it', () => {
  assert.equal(
    normalizePaperlessServerUrl('http://paperless.local'),
    'http://paperless.local',
  );
});

test('rejects credentials, query strings, and fragments in server URLs', () => {
  assert.throws(
    () => normalizePaperlessServerUrl('https://user:secret@paperless.example.com'),
    /username or password/,
  );
  assert.throws(
    () => normalizePaperlessServerUrl('https://paperless.example.com?token=secret'),
    /query string or fragment/,
  );
  assert.throws(
    () => normalizePaperlessServerUrl('https://paperless.example.com/#settings'),
    /query string or fragment/,
  );
});
