import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const FORBIDDEN_STORE_PERMISSIONS = [
  'android.permission.REQUEST_INSTALL_PACKAGES',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
];

const PERMISSION_DECLARATION = /<uses-permission(?:-sdk-23)?\b[^>]*>/giu;
const ANDROID_NAME = /\bandroid:name\s*=\s*(["'])([^"']+)\1/iu;
const TOOLS_NODE = /\btools:node\s*=\s*(["'])([^"']+)\1/iu;

export function findForbiddenStorePermissionDeclarations(source) {
  const violations = [];
  for (const match of source.matchAll(PERMISSION_DECLARATION)) {
    const permission = ANDROID_NAME.exec(match[0])?.[2];
    const toolsNode = TOOLS_NODE.exec(match[0])?.[2];
    if (permission && FORBIDDEN_STORE_PERMISSIONS.includes(permission) && toolsNode !== 'remove') {
      violations.push({ element: match[0].match(/^<[^\s>]+/u)?.[0].slice(1), permission });
    }
  }
  return violations;
}

export function findMissingStorePermissionBlockers(source) {
  const blockers = new Set();
  for (const match of source.matchAll(PERMISSION_DECLARATION)) {
    const permission = ANDROID_NAME.exec(match[0])?.[2];
    const toolsNode = TOOLS_NODE.exec(match[0])?.[2];
    if (permission && toolsNode === 'remove') blockers.add(permission);
  }
  return FORBIDDEN_STORE_PERMISSIONS.filter((permission) => !blockers.has(permission));
}

export function assertAndroidStoreManifestSource(
  source,
  label = 'AndroidManifest.xml',
  { requireBlockers = true } = {},
) {
  const violations = findForbiddenStorePermissionDeclarations(source);
  if (violations.length > 0) {
    const detail = violations
      .map(({ element, permission }) => `${element}: ${permission}`)
      .join(', ');
    throw new Error(`${label} contains forbidden store permission declarations: ${detail}`);
  }
  if (requireBlockers) {
    const missing = findMissingStorePermissionBlockers(source);
    if (missing.length > 0) {
      throw new Error(`${label} is missing store permission merge blockers: ${missing.join(', ')}`);
    }
  }
}

export function assertAndroidStoreManifestFile(file, options) {
  const source = fs.readFileSync(file, 'utf8');
  assertAndroidStoreManifestSource(source, String(file), options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [manifestPath, mode] = process.argv.slice(2);
  if (!manifestPath) {
    throw new Error(
      'Usage: node scripts/assert-android-store-manifest.mjs <AndroidManifest.xml> [--merged]',
    );
  }
  if (mode && mode !== '--merged') throw new Error(`Unknown option: ${mode}`);
  assertAndroidStoreManifestFile(manifestPath, { requireBlockers: mode !== '--merged' });
  console.log('Android store manifest contains no forbidden permission declarations.');
}
