import fs from 'node:fs';

const storeRoot = new URL('../store/', import.meta.url);
const metadataRoot = new URL('metadata/', storeRoot);
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', metadataRoot), 'utf8'));
const privacy = JSON.parse(fs.readFileSync(new URL('privacy-disclosures.json', storeRoot), 'utf8'));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function text(url) {
  return fs.readFileSync(url, 'utf8').trim();
}

assert(manifest.schemaVersion === 1, 'Store metadata schema version is unsupported.');
assert(manifest.defaultLocale === 'en-US', 'Store metadata must define en-US as the default locale.');
assert(Array.isArray(manifest.locales) && manifest.locales.includes('en-US'), 'English store metadata is missing.');
assert(manifest.locales.includes('de-DE'), 'German store metadata is missing.');
assert(manifest.submissionMode === 'reviewed-manual', 'Store publishing must remain review-gated.');

for (const locale of manifest.locales) {
  const localeRoot = new URL(`${locale}/`, metadataRoot);
  const app = JSON.parse(text(new URL(manifest.appMetadataFile, localeRoot)));
  for (const field of [
    'name',
    'subtitle',
    'shortDescription',
    'fullDescription',
    'keywords',
    'promotionalText',
    'category',
    'privacyPolicyUrl',
    'supportUrl',
  ]) {
    assert(typeof app[field] === 'string' && app[field].trim(), `${locale}: ${field} is missing.`);
  }
  assert(new URL(app.privacyPolicyUrl).protocol === 'https:', `${locale}: privacy URL must use HTTPS.`);
  assert(new URL(app.supportUrl).protocol === 'https:', `${locale}: support URL must use HTTPS.`);
  assert(app.shortDescription.length <= 80, `${locale}: short description exceeds 80 characters.`);
  assert(app.subtitle.length <= 30, `${locale}: subtitle exceeds 30 characters.`);
  assert(app.keywords.length <= 100, `${locale}: keywords exceed 100 characters.`);
  const releaseNotes = text(new URL(manifest.releaseNotesFile, localeRoot));
  assert(releaseNotes.length >= 80, `${locale}: release notes are incomplete.`);
  assert(!/\b(?:TODO|TBD|placeholder)\b/i.test(releaseNotes), `${locale}: release notes contain a placeholder.`);
}

assert(privacy.schemaVersion === 1, 'Privacy disclosure schema version is unsupported.');
assert(privacy.developerTracking === false, 'Tracking disclosure does not match this release.');
assert(privacy.advertisingSdk === false, 'Advertising disclosure does not match this release.');
assert(privacy.remotePushEnabled === false, 'Remote push must remain disabled for this release.');
assert(privacy.directUserServerConnection === true, 'Direct user-server connection disclosure is missing.');
assert(privacy.storeConsoleReviewRequired === true, 'Store privacy answers must remain manually review-gated.');
for (const integration of ['notifications', 'osSearch', 'widgets', 'shortcuts', 'sharing']) {
  assert(
    typeof privacy.platformIntegrations?.[integration] === 'string'
      && privacy.platformIntegrations[integration].trim(),
    `Privacy disclosure for ${integration} is missing.`,
  );
}

console.log('Store metadata, release notes, and privacy disclosures are complete.');
