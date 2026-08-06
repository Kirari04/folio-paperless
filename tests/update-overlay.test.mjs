import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('checking for updates never presents cached notes for the installed version', async () => {
  const source = await readFile(
    new URL('../src/components/update-overlay.tsx', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /const releaseIsNewer = releaseVersion !== null[\s\S]*compareStableVersions\(releaseVersion, updates\.currentVersion\) > 0/,
  );
  assert.match(
    source,
    /const showReleaseDetails = releaseIsNewer && updates\.status !== 'up-to-date'/,
  );
  assert.match(source, /updates\.release && showReleaseDetails/);
  assert.doesNotMatch(
    source,
    /updates\.release && updates\.status !== 'up-to-date'/,
  );
});
