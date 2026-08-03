import fs from 'node:fs';
import { createRequire } from 'node:module';

const PACKAGE_PATH = new URL('../package.json', import.meta.url);
const SETTINGS_PATH = new URL('../android/settings.gradle', import.meta.url);
const require = createRequire(import.meta.url);
const distributionGuard = require('../plugins/withFolioDistributionGuard.js');
const {
  assertNoGlobalStoreOnlyExclusion,
  assertResolvedFlavor,
  resolveNativeModules,
} = await import('./assert-autolinking-flavors.mjs');

if (process.env.FOLIO_DISTRIBUTION !== 'store') {
  throw new Error('Store autolinking verification requires FOLIO_DISTRIBUTION=store.');
}

if (!fs.existsSync(SETTINGS_PATH)) {
  throw new Error(
    'android/settings.gradle is missing. Run store-flavored Expo prebuild before this check.',
  );
}

const packageJson = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
assertNoGlobalStoreOnlyExclusion(packageJson);
distributionGuard.assertStoreAutolinkingGradleGuard(fs.readFileSync(SETTINGS_PATH, 'utf8'));
assertResolvedFlavor(resolveNativeModules('android', { excludeStoreOnlyModules: true }), {
  flavor: 'store',
  platform: 'Android',
  developmentClientExpected: false,
  updaterExpected: false,
});
console.log('Verified generated store Android autolinking without mutating package.json.');
