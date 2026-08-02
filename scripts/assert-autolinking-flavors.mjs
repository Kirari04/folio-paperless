import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const UPDATER_PACKAGE = 'folio-updater';
export const DEVELOPMENT_CLIENT_PACKAGES = [
  'expo-dev-client',
  'expo-dev-launcher',
  'expo-dev-menu',
  'expo-dev-menu-interface',
];
export const STORE_AUTOLINKING_EXCLUSIONS = [UPDATER_PACKAGE, ...DEVELOPMENT_CLIENT_PACKAGES];
export const SHARED_LOCAL_MODULES = ['folio-mtls', 'folio-platform'];

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE_PATH = path.join(PROJECT_ROOT, 'package.json');

export function assertNoGlobalStoreOnlyExclusion(packageJson) {
  const rootExclusions = packageJson.expo?.autolinking?.exclude;
  const androidExclusions = packageJson.expo?.autolinking?.android?.exclude;
  for (const [scope, exclusions] of [
    ['expo.autolinking.exclude', rootExclusions],
    ['expo.autolinking.android.exclude', androidExclusions],
  ]) {
    if (exclusions !== undefined && !Array.isArray(exclusions)) {
      throw new Error(`${scope} must be an array when configured.`);
    }
    const leakedExclusions = STORE_AUTOLINKING_EXCLUSIONS.filter((packageName) =>
      exclusions?.includes(packageName));
    if (leakedExclusions.length > 0) {
      throw new Error(
        `${scope} globally excludes ${leakedExclusions.join(', ')}; GitHub builds must autolink them.`,
      );
    }
  }
}

export function resolveNativeModules(platform, { excludeStoreOnlyModules = false } = {}) {
  const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const args = [
    'expo-modules-autolinking',
    'resolve',
    '--platform',
    platform,
    '--json',
  ];
  if (excludeStoreOnlyModules) args.push('--exclude', ...STORE_AUTOLINKING_EXCLUSIONS);
  const result = spawnSync(executable, args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr || `Could not resolve ${platform} native modules for autolinking.`,
    );
  }
  return JSON.parse(result.stdout);
}

export function resolvedPackageNames(resolution) {
  return new Set((resolution.modules ?? []).map((module) => module.packageName));
}

export function assertResolvedFlavor(resolution, {
  flavor,
  platform,
  developmentClientExpected,
  updaterExpected,
}) {
  const names = resolvedPackageNames(resolution);
  for (const packageName of SHARED_LOCAL_MODULES) {
    if (!names.has(packageName)) {
      throw new Error(`${flavor} ${platform} autolinking did not resolve ${packageName}.`);
    }
  }
  if (names.has(UPDATER_PACKAGE) !== updaterExpected) {
    throw new Error(
      `${flavor} ${platform} autolinking ${
        updaterExpected ? 'did not resolve' : 'unexpectedly resolved'
      } ${UPDATER_PACKAGE}.`,
    );
  }
  for (const packageName of DEVELOPMENT_CLIENT_PACKAGES) {
    if (names.has(packageName) !== developmentClientExpected) {
      throw new Error(
        `${flavor} ${platform} autolinking ${
          developmentClientExpected ? 'did not resolve' : 'unexpectedly resolved'
        } ${packageName}.`,
      );
    }
  }
}

export function assertAutolinkingFlavors() {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  assertNoGlobalStoreOnlyExclusion(packageJson);

  assertResolvedFlavor(resolveNativeModules('android'), {
    flavor: 'GitHub',
    platform: 'Android',
    developmentClientExpected: true,
    updaterExpected: true,
  });
  assertResolvedFlavor(resolveNativeModules('android', { excludeStoreOnlyModules: true }), {
    flavor: 'store',
    platform: 'Android',
    developmentClientExpected: false,
    updaterExpected: false,
  });
  assertResolvedFlavor(resolveNativeModules('apple'), {
    flavor: 'GitHub',
    platform: 'Apple',
    developmentClientExpected: true,
    updaterExpected: false,
  });
  assertResolvedFlavor(resolveNativeModules('apple', { excludeStoreOnlyModules: true }), {
    flavor: 'store',
    platform: 'Apple',
    developmentClientExpected: false,
    updaterExpected: false,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  assertAutolinkingFlavors();
  console.log('GitHub and store native-module autolinking boundaries are valid.');
}
