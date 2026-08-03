import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { assertAutolinkingFlavors } from './assert-autolinking-flavors.mjs';

const [githubConfigPath, storeConfigPath] = process.argv.slice(2);

function generatedConfig(distribution, type = 'prebuild') {
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['expo', 'config', '--type', type, '--json'],
    {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      env: { ...process.env, FOLIO_DISTRIBUTION: distribution },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      result.stderr || `Could not generate the ${distribution} Expo ${type} config.`,
    );
  }
  return JSON.parse(result.stdout);
}

const github = githubConfigPath
  ? JSON.parse(fs.readFileSync(githubConfigPath, 'utf8'))
  : generatedConfig('github');
const store = storeConfigPath
  ? JSON.parse(fs.readFileSync(storeConfigPath, 'utf8'))
  : generatedConfig('store');
const packageJson = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const installPermission = 'android.permission.REQUEST_INSTALL_PACKAGES';
const forbiddenStorePermissions = [
  installPermission,
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function pluginNames(config) {
  return (config.plugins ?? []).map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
}

function hasHttpsAssociation(config) {
  if ((config.ios?.associatedDomains ?? []).length > 0) return true;
  return (config.android?.intentFilters ?? []).some((filter) =>
    (filter.data ?? []).some((data) => data.scheme === 'https' || data.scheme === 'http'),
  );
}

function assertShared(config, name) {
  assert(config.version === packageJson.version, `${name}: Expo version does not match package.json.`);
  assert(config.scheme === 'folio-paperless', `${name}: custom URL scheme is missing.`);
  assert(config.android?.package === 'app.folio.paperless', `${name}: Android package changed.`);
  assert(config.ios?.bundleIdentifier === 'app.folio.paperless', `${name}: iOS bundle ID changed.`);
  assert(!hasHttpsAssociation(config), `${name}: HTTPS association must not be claimed without a domain.`);
  const plugins = pluginNames(config);
  assert(
    plugins.includes('./plugins/withFolioPlatformIntegrations'),
    `${name}: platform integrations plugin is missing.`,
  );
  assert(plugins.includes('expo-widgets'), `${name}: privacy-safe widget configuration is missing.`);
}

assertShared(github, 'github');
assertShared(store, 'store');
assert(github.extra?.folioDistribution === 'github', 'GitHub flavor marker is invalid.');
assert(github.extra?.supportsInAppApkUpdates === true, 'GitHub updater must be enabled.');
assert(
  github.android?.permissions?.includes(installPermission),
  'GitHub flavor must retain REQUEST_INSTALL_PACKAGES for its explicit APK updater.',
);
assert(
  pluginNames(github).includes('./plugins/withAndroidReleaseSigning'),
  'GitHub flavor release-signing plugin is missing.',
);
assert(
  !pluginNames(github).includes('./plugins/withFolioDistributionGuard'),
  'GitHub flavor must not generate the store autolinking guard.',
);

assert(store.extra?.folioDistribution === 'store', 'Store flavor marker is invalid.');
assert(store.extra?.supportsInAppApkUpdates === false, 'Store flavor updater must be disabled.');
for (const permission of forbiddenStorePermissions) {
  assert(
    !store.android?.permissions?.includes(permission),
    `Store flavor leaked ${permission}.`,
  );
  assert(
    store.android?.blockedPermissions?.includes(permission),
    `Store flavor must block transitive ${permission} declarations.`,
  );
}
assert(
  !pluginNames(store).includes('./plugins/withAndroidReleaseSigning'),
  'Store flavor must use EAS-managed signing, not the GitHub APK signing plugin.',
);
assert(
  pluginNames(store).includes('./plugins/withFolioDistributionGuard'),
  'Store flavor distribution guard is missing.',
);

function iOSUrlSchemes(config) {
  return (config._internal?.modResults?.ios?.infoPlist?.CFBundleURLTypes ?? [])
    .flatMap((entry) => entry.CFBundleURLSchemes ?? []);
}

function androidUrlSchemes(config) {
  return (config._internal?.modResults?.android?.manifest?.manifest?.application ?? [])
    .flatMap((application) => application.activity ?? [])
    .flatMap((activity) => activity['intent-filter'] ?? [])
    .flatMap((intentFilter) => intentFilter.data ?? [])
    .map((entry) => entry.$?.['android:scheme'])
    .filter(Boolean);
}

const githubIntrospect = generatedConfig('github', 'introspect');
const storeIntrospect = generatedConfig('store', 'introspect');
const githubInfoPlist = githubIntrospect._internal?.modResults?.ios?.infoPlist ?? {};
const storeInfoPlist = storeIntrospect._internal?.modResults?.ios?.infoPlist ?? {};
assert(
  iOSUrlSchemes(githubIntrospect).includes('exp+folio-paperless')
    && androidUrlSchemes(githubIntrospect).includes('exp+folio-paperless'),
  'GitHub flavor must retain the development-client URL scheme.',
);
assert(
  !iOSUrlSchemes(storeIntrospect).some((scheme) => scheme.startsWith('exp+'))
    && !androidUrlSchemes(storeIntrospect).some((scheme) => scheme.startsWith('exp+')),
  'Store flavor leaked the development-client URL scheme.',
);
assert(
  Array.isArray(githubInfoPlist.NSBonjourServices)
    && githubInfoPlist.NSBonjourServices.includes('_expo._tcp'),
  'GitHub flavor must retain development-client discovery metadata.',
);
assert(
  !Object.keys(storeInfoPlist).some((key) =>
    key.startsWith('EXDev')
      || key.startsWith('DEV_CLIENT_')
      || key === 'NSBonjourServices'),
  'Store flavor leaked development-client Info.plist metadata.',
);

assertAutolinkingFlavors();
console.log('GitHub and store Expo configuration and native-module boundaries are valid.');
