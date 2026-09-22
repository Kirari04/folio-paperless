import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { sameCredentialContext } from '../src/lib/credential-context.ts';

const base = {
  serverUrl: 'https://paperless.example.org',
  token: 'secret-token',
  profileId: 'profile-1',
  clientIdentityRef: 'keychain-ref',
  authorizationScheme: 'Token',
  customHeaders: { 'X-Custom': 'a' },
};

test('sameCredentialContext compares the authority and secrets, not object identity', () => {
  assert.equal(sameCredentialContext(base, { ...base }), true);
  assert.equal(sameCredentialContext(base, { ...base, serverUrl: 'https://paperless.example.org/' }), true);
  assert.equal(sameCredentialContext(base, { ...base, customHeaders: { 'x-custom': 'a' } }), true);
  assert.equal(sameCredentialContext({ ...base, authorizationScheme: undefined }, { ...base, authorizationScheme: 'Token' }), true);

  assert.equal(sameCredentialContext(base, { ...base, token: 'other' }), false);
  assert.equal(sameCredentialContext(base, { ...base, profileId: 'profile-2' }), false);
  assert.equal(sameCredentialContext(base, { ...base, serverUrl: 'https://other.example.org' }), false);
  assert.equal(sameCredentialContext(base, { ...base, clientIdentityRef: undefined }), false);
  assert.equal(sameCredentialContext(base, { ...base, authorizationScheme: 'Bearer' }), false);
  assert.equal(sameCredentialContext(base, { ...base, customHeaders: { 'X-Custom': 'b' } }), false);

  assert.equal(sameCredentialContext(null, null), true);
  assert.equal(sameCredentialContext(base, null), false);
  assert.equal(sameCredentialContext(base, { ...base, serverUrl: 'not a url' }), false);
});

test('the advanced workspace keeps its session across an equal credentials object', async () => {
  const hook = await readFile(new URL('../src/lib/use-paperless-advanced.ts', import.meta.url), 'utf8');
  const workspace = await readFile(new URL('../src/components/document-paperless3-workspace.tsx', import.meta.url), 'utf8');
  // The client, cache and capabilities are bound to the credential context.
  assert.match(hook, /sameCredentialContext\(binding\.credentials, credentials\)/);
  // Re-checking capabilities for the same profile never drops back to 'loading'.
  assert.match(hook, /current\.phase === 'ready' && current\.api\.client\.profileId === client\.profileId\s*\?\s*current/);
  // The workspace shows its loader before the first load only, and keeps the
  // PDF access snapshot while refreshing.
  assert.match(workspace, /\(loading && !loadedOnce\)/);
  assert.doesNotMatch(workspace, /setLoading\(true\);\s*setPdfAccess\(null\);/);
});

test('a republish with the same credential context keeps the credentials object identity', async () => {
  const context = await readFile(new URL('../src/context/app-context.tsx', import.meta.url), 'utf8');
  assert.match(context, /const published = nextCredentials && previous && sameCredentialContext\(previous, nextCredentials\)\s*\?\s*previous\s*:\s*nextCredentials;/);
  assert.match(context, /setCredentials\(published\);/);
  // publishCredentials is the only writer of the credentials state.
  assert.equal((context.match(/setCredentials\(/g) ?? []).length, 1);
});
