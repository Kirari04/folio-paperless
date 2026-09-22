import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { canServeCachedLibraryResults } from '../src/lib/library-search-policy.ts';

const appContextSource = await readFile(
  new URL('../src/context/app-context.tsx', import.meta.url),
  'utf8',
);
const documentsSource = await readFile(
  new URL('../src/app/documents.tsx', import.meta.url),
  'utf8',
);

function apiError(message, status) {
  const error = new Error(message);
  error.name = 'PaperlessApiError';
  error.status = status;
  return error;
}

// Mirrors the remote branch of searchLibrary. The shipped guard is pinned to
// this behavior by the source assertions at the end of this file.
async function searchWithCacheFallback(remote, cached) {
  try {
    return await remote();
  } catch (error) {
    if (!canServeCachedLibraryResults(error)) throw error;
  }
  return cached;
}

test('a rejected API token fails the filtered search instead of returning the cache', async () => {
  await assert.rejects(
    searchWithCacheFallback(
      () => Promise.reject(apiError(
        'The API token was rejected. Create a new token in your Paperless profile.',
        401,
      )),
      ['cached document'],
    ),
    /The API token was rejected/,
  );
});

test('removed permissions and refused API versions fail the filtered search', async () => {
  await assert.rejects(
    searchWithCacheFallback(
      () => Promise.reject(apiError(
        'This Paperless account does not have permission to perform that action.',
        403,
      )),
      ['cached document'],
    ),
    /does not have permission/,
  );
  await assert.rejects(
    searchWithCacheFallback(
      () => Promise.reject(apiError('This Paperless server does not support API version 10.', 406)),
      ['cached document'],
    ),
    /does not support API version 10/,
  );
});

test('an unclassified failure fails the filtered search rather than serving the cache', async () => {
  await assert.rejects(
    searchWithCacheFallback(
      () => Promise.reject(new Error('Paperless returned an invalid tag.')),
      ['cached document'],
    ),
    /Paperless returned an invalid tag/,
  );
});

test('a network failure still falls back to the synchronized cache', async () => {
  assert.deepEqual(
    await searchWithCacheFallback(
      () => Promise.reject(new TypeError('Network request failed')),
      ['cached document'],
    ),
    ['cached document'],
  );
});

test('server, rate-limit, and timeout failures still fall back to the cache', async () => {
  for (const error of [
    apiError('The Paperless server encountered an error. Try again in a moment.', 503),
    apiError('Paperless is receiving too many requests. Wait a moment and try again.', 429),
    new Error('The request timed out.'),
  ]) {
    assert.deepEqual(
      await searchWithCacheFallback(() => Promise.reject(error), ['cached document']),
      ['cached document'],
      `${error.message} must keep the cached fallback`,
    );
  }
});

test('the cache fallback classifies failures with the shared task typology', () => {
  assert.equal(canServeCachedLibraryResults(apiError('Unauthorized', 401)), false);
  assert.equal(canServeCachedLibraryResults(apiError('Forbidden', 403)), false);
  assert.equal(canServeCachedLibraryResults(apiError('Not acceptable', 406)), false);
  assert.equal(canServeCachedLibraryResults(apiError('Gone', 404)), false);
  assert.equal(canServeCachedLibraryResults(apiError('Too many requests', 429)), true);
  assert.equal(canServeCachedLibraryResults(apiError('Bad gateway', 502)), true);
  assert.equal(canServeCachedLibraryResults(new Error('connection reset')), true);
  assert.equal(canServeCachedLibraryResults(new Error('AbortError')), true);
});

test('searchLibrary only keeps the cached fallback for transient failures', () => {
  assert.match(
    appContextSource,
    /} catch \(error\) \{\n\s+\/\/ Continue with cached metadata for transient network\/server errors\./,
  );
  assert.match(appContextSource, /if \(!canServeCachedLibraryResults\(error\)\) throw error;/);
  assert.match(
    appContextSource,
    /import \{ canServeCachedLibraryResults \} from '@\/lib\/library-search-policy';/,
  );
});

test('the library screen presents a rejected filtered search as an error', () => {
  assert.match(documentsSource, /void searchLibrary\(\{[\s\S]*?\}\)\n[\s\S]*?\.catch\(\(error\) => \{/);
  assert.match(documentsSource, /message: presentRuntimeError\(error, t\('library\.refreshFilteredError'\)\)/);
});
