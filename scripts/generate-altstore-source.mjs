#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_IDENTIFIER = "app.folio.paperless.source";
const APP_NAME = "Folio for Paperless";
const APP_SUBTITLE = "A polished mobile client for Paperless-ngx.";
const APP_DESCRIPTION =
  "Scan, upload, organize, search, and review documents on your own Paperless-ngx server.";
const TINT_COLOR = "17231B";
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXPECTED_ENTITLEMENTS = [
  "com.apple.developer.default-data-protection",
  "com.apple.security.application-groups",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertObject(value, label) {
  assert(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object.`,
  );
}

function requireString(value, label) {
  assert(
    typeof value === "string" && value.trim().length > 0,
    `${label} must be a non-empty string.`,
  );
  return value.trim();
}

function sortedObject(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function validateMetadata(metadata) {
  assertObject(metadata, "iOS metadata");
  const bundleIdentifier = requireString(
    metadata.bundleIdentifier,
    "bundleIdentifier",
  );
  const version = requireString(metadata.version, "version");
  const buildVersion = requireString(metadata.buildVersion, "buildVersion");
  const minOSVersion = requireString(metadata.minOSVersion, "minOSVersion");

  assert(
    bundleIdentifier === "app.folio.paperless",
    `Unexpected bundle identifier: ${bundleIdentifier}`,
  );
  assert(
    VERSION_PATTERN.test(version),
    `version must be stable SemVer; received ${version}.`,
  );
  assert(
    /^\d+$/.test(buildVersion),
    `buildVersion must contain only decimal digits; received ${buildVersion}.`,
  );
  assert(
    /^\d+\.\d+(?:\.\d+)?$/.test(minOSVersion),
    `Invalid minimum iOS version: ${minOSVersion}`,
  );

  assert(
    Array.isArray(metadata.entitlements),
    "entitlements must be an array.",
  );
  assert(
    JSON.stringify(metadata.entitlements) === JSON.stringify(EXPECTED_ENTITLEMENTS),
    `Folio's sideloading entitlements do not match the reviewed widget and share-extension policy; received ${metadata.entitlements.join(", ") || "none"}.`,
  );

  assertObject(metadata.privacy, "privacy");
  const privacy = sortedObject(metadata.privacy);
  for (const [key, description] of Object.entries(privacy)) {
    assert(
      /^NS.+UsageDescription$/.test(key),
      `Invalid privacy permission key: ${key}`,
    );
    requireString(description, `privacy.${key}`);
  }

  return {
    bundleIdentifier,
    version,
    buildVersion,
    minOSVersion,
    entitlements: [...EXPECTED_ENTITLEMENTS],
    privacy,
  };
}

function validateRepository(repository) {
  const value = requireString(repository, "repository");
  assert(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value),
    `Invalid GitHub repository: ${value}`,
  );
  return value;
}

function validateDate(date) {
  const value = requireString(date, "date");
  assert(!Number.isNaN(Date.parse(value)), `Invalid release date: ${value}`);
  return value;
}

function validatePreviousSource(source, metadata) {
  if (source === undefined) return [];

  assertObject(source, "previous source");
  assert(
    source.identifier === SOURCE_IDENTIFIER,
    "Previous source identifier does not match Folio.",
  );
  assert(Array.isArray(source.apps), "Previous source apps must be an array.");
  const app = source.apps.find(
    (candidate) => candidate?.bundleIdentifier === metadata.bundleIdentifier,
  );
  assert(app, `Previous source does not contain ${metadata.bundleIdentifier}.`);
  assert(
    !Object.hasOwn(app, "marketplaceID"),
    "Previous source must not contain marketplaceID.",
  );
  assertObject(app.appPermissions, "previous appPermissions");
  const permissionsMatch =
    JSON.stringify(app.appPermissions.entitlements ?? []) ===
      JSON.stringify(metadata.entitlements) &&
    JSON.stringify(sortedObject(app.appPermissions.privacy ?? {})) ===
      JSON.stringify(metadata.privacy);
  assert(
    Array.isArray(app.versions),
    "Previous source versions must be an array.",
  );

  return permissionsMatch ? app.versions : [];
}

function validateVersion(version, label) {
  assertObject(version, label);
  requireString(version.version, `${label}.version`);
  requireString(version.buildVersion, `${label}.buildVersion`);
  validateDate(version.date);
  const downloadURL = requireString(
    version.downloadURL,
    `${label}.downloadURL`,
  );
  assert(
    downloadURL.startsWith("https://"),
    `${label}.downloadURL must use HTTPS.`,
  );
  assert(
    Number.isSafeInteger(version.size) && version.size > 0,
    `${label}.size must be a positive integer.`,
  );
  assert(
    SHA256_PATTERN.test(version.sha256),
    `${label}.sha256 must be a lowercase SHA-256 digest.`,
  );
  requireString(version.minOSVersion, `${label}.minOSVersion`);
}

export function validateAltStoreSource(source, expected) {
  assertObject(source, "source");
  assert(
    source.identifier === SOURCE_IDENTIFIER,
    `Unexpected source identifier: ${source.identifier}`,
  );
  assert(
    Array.isArray(source.apps) && source.apps.length === 1,
    "Source must contain exactly one app.",
  );

  const app = source.apps[0];
  assert(
    app.bundleIdentifier === expected.metadata.bundleIdentifier,
    "Source bundle identifier does not match the IPA.",
  );
  assert(
    !Object.hasOwn(app, "marketplaceID"),
    "Non-notarized sources must not declare marketplaceID.",
  );
  assertObject(app.appPermissions, "appPermissions");
  assert(
    JSON.stringify(app.appPermissions.entitlements) ===
      JSON.stringify(expected.metadata.entitlements),
    "Source entitlements do not match the IPA metadata.",
  );
  assert(
    JSON.stringify(sortedObject(app.appPermissions.privacy)) ===
      JSON.stringify(sortedObject(expected.metadata.privacy)),
    "Source privacy permissions do not match the IPA metadata.",
  );
  assert(
    Array.isArray(app.versions) && app.versions.length > 0,
    "Source must contain at least one version.",
  );

  const versionKeys = new Set();
  for (const [index, version] of app.versions.entries()) {
    validateVersion(version, `versions[${index}]`);
    const key = `${version.version}|${version.buildVersion}`;
    assert(!versionKeys.has(key), `Duplicate source version: ${key}`);
    versionKeys.add(key);
  }

  const latest = app.versions[0];
  assert(
    latest.version === expected.metadata.version,
    "Latest source version does not match the IPA.",
  );
  assert(
    latest.buildVersion === expected.metadata.buildVersion,
    "Latest source buildVersion does not match the IPA.",
  );
  assert(
    latest.downloadURL === expected.downloadURL,
    "Latest source downloadURL is incorrect.",
  );
  assert(
    latest.size === expected.size,
    "Latest source size does not match the IPA.",
  );
  assert(
    latest.sha256 === expected.sha256,
    "Latest source SHA-256 does not match the IPA.",
  );
  assert(
    latest.minOSVersion === expected.metadata.minOSVersion,
    "Latest source minOSVersion does not match the IPA.",
  );
}

export function generateAltStoreSource({
  metadata: rawMetadata,
  ipaPath,
  repository: rawRepository,
  tag,
  date,
  releaseNotes = "",
  previousSource,
}) {
  const metadata = validateMetadata(rawMetadata);
  const repository = validateRepository(rawRepository);
  const releaseTag = requireString(tag, "tag");
  const releaseDate = validateDate(date);
  assert(
    releaseTag === `v${metadata.version}`,
    `Tag ${releaseTag} does not match IPA version v${metadata.version}.`,
  );

  const ipaName = basename(ipaPath);
  assert(
    ipaName === `Folio-${releaseTag}-ios-unsigned.ipa`,
    `Unexpected IPA name: ${ipaName}`,
  );
  const size = statSync(ipaPath).size;
  assert(size > 0, "IPA must not be empty.");
  const sha256 = createHash("sha256")
    .update(readFileSync(ipaPath))
    .digest("hex");
  const downloadURL = `https://github.com/${repository}/releases/download/${releaseTag}/${ipaName}`;
  const previousVersions = validatePreviousSource(previousSource, metadata);
  const latestKey = `${metadata.version}|${metadata.buildVersion}`;
  const versions = [
    {
      version: metadata.version,
      buildVersion: metadata.buildVersion,
      date: releaseDate,
      localizedDescription: releaseNotes.trim() || `${APP_NAME} ${releaseTag}.`,
      downloadURL,
      size,
      sha256,
      minOSVersion: metadata.minOSVersion,
    },
    ...previousVersions.filter(
      (version) => `${version.version}|${version.buildVersion}` !== latestKey,
    ),
  ];

  const tagURL = encodeURIComponent(releaseTag);
  const source = {
    name: APP_NAME,
    identifier: SOURCE_IDENTIFIER,
    subtitle: APP_SUBTITLE,
    description: `${APP_DESCRIPTION} Builds are unsigned and are signed on-device with the user's Apple ID.`,
    iconURL: `https://raw.githubusercontent.com/${repository}/${tagURL}/assets/images/icon.png`,
    website: `https://github.com/${repository}`,
    tintColor: TINT_COLOR,
    featuredApps: [metadata.bundleIdentifier],
    apps: [
      {
        name: APP_NAME,
        bundleIdentifier: metadata.bundleIdentifier,
        developerName: "Folio contributors",
        subtitle: APP_SUBTITLE,
        localizedDescription: APP_DESCRIPTION,
        iconURL: `https://raw.githubusercontent.com/${repository}/${tagURL}/assets/images/icon.png`,
        tintColor: TINT_COLOR,
        category: "utilities",
        versions,
        appPermissions: {
          entitlements: metadata.entitlements,
          privacy: metadata.privacy,
        },
      },
    ],
    news: [],
  };

  validateAltStoreSource(source, { metadata, downloadURL, size, sha256 });
  return source;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    assert(
      key?.startsWith("--") && value !== undefined,
      `Invalid argument near ${key ?? "<end>"}.`,
    );
    values[key.slice(2)] = value;
  }
  return values;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${label} at ${path}: ${error.message}`);
  }
}

function runCli() {
  const args = parseArguments(process.argv.slice(2));
  for (const required of [
    "metadata",
    "ipa",
    "repository",
    "tag",
    "date",
    "output",
  ]) {
    requireString(args[required], `--${required}`);
  }

  const source = generateAltStoreSource({
    metadata: readJson(resolve(args.metadata), "iOS metadata"),
    ipaPath: resolve(args.ipa),
    repository: args.repository,
    tag: args.tag,
    date: args.date,
    releaseNotes: args["release-notes"]
      ? readFileSync(resolve(args["release-notes"]), "utf8")
      : "",
    previousSource: args.previous
      ? readJson(resolve(args.previous), "previous source")
      : undefined,
  });
  const outputPath = resolve(args.output);
  writeFileSync(outputPath, `${JSON.stringify(source, null, 2)}\n`);
  console.log(`Created AltStore/SideStore source: ${outputPath}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    runCli();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
