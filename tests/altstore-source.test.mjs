import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  generateAltStoreSource,
  validateAltStoreSource,
} from "../scripts/generate-altstore-source.mjs";

const metadata = {
  bundleIdentifier: "app.folio.paperless",
  version: "0.3.0",
  buildVersion: "3000",
  minOSVersion: "16.4",
  entitlements: [],
  privacy: {
    NSCameraUsageDescription: "Allow Folio to scan paper documents.",
    NSFaceIDUsageDescription:
      "Allow Folio to protect your document previews with Face ID.",
    NSLocalNetworkUsageDescription:
      "Allow Folio to connect directly to a Paperless server on your local network.",
  },
};

function makeIpa() {
  const directory = mkdtempSync(join(tmpdir(), "folio-altstore-source-"));
  const ipaPath = join(directory, "Folio-v0.3.0-ios-unsigned.ipa");
  writeFileSync(ipaPath, "representative unsigned IPA bytes");
  return ipaPath;
}

function generate(overrides = {}) {
  return generateAltStoreSource({
    metadata,
    ipaPath: makeIpa(),
    repository: "Kirari04/folio-paperless",
    tag: "v0.3.0",
    date: "2026-08-02T12:00:00Z",
    releaseNotes: "Adds first-class AltStore and SideStore distribution.",
    ...overrides,
  });
}

test("generates a non-notarized AltSource from verified IPA metadata", () => {
  const source = generate();
  const app = source.apps[0];
  const version = app.versions[0];

  assert.equal(source.identifier, "app.folio.paperless.source");
  assert.equal(app.bundleIdentifier, metadata.bundleIdentifier);
  assert.equal(Object.hasOwn(app, "marketplaceID"), false);
  assert.deepEqual(app.appPermissions, {
    entitlements: [],
    privacy: metadata.privacy,
  });
  assert.equal(version.version, metadata.version);
  assert.equal(version.buildVersion, metadata.buildVersion);
  assert.equal(version.minOSVersion, metadata.minOSVersion);
  assert.equal(
    version.downloadURL,
    "https://github.com/Kirari04/folio-paperless/releases/download/v0.3.0/Folio-v0.3.0-ios-unsigned.ipa",
  );
  assert.match(version.sha256, /^[a-f0-9]{64}$/);
  assert.ok(version.size > 0);
});

test("keeps compatible previous versions behind the new release", () => {
  const previous = generate();
  previous.apps[0].versions[0] = {
    ...previous.apps[0].versions[0],
    version: "0.2.0",
    buildVersion: "2000",
    date: "2026-08-01T12:00:00Z",
    downloadURL:
      "https://github.com/Kirari04/folio-paperless/releases/download/v0.2.0/Folio-v0.2.0-ios-unsigned.ipa",
  };

  const source = generate({ previousSource: previous });
  assert.deepEqual(
    source.apps[0].versions.map(({ version }) => version),
    ["0.3.0", "0.2.0"],
  );
});

test("rejects metadata that would require special signing entitlements", () => {
  assert.throws(
    () =>
      generate({
        metadata: { ...metadata, entitlements: ["aps-environment"] },
      }),
    /must not require special entitlements/,
  );
});

test("rejects a marketplace source or source metadata that drifts from the IPA", () => {
  const source = generate();
  source.apps[0].marketplaceID = "unexpected-notarized-app";

  assert.throws(
    () =>
      validateAltStoreSource(source, {
        metadata,
        downloadURL: source.apps[0].versions[0].downloadURL,
        size: source.apps[0].versions[0].size,
        sha256: source.apps[0].versions[0].sha256,
      }),
    /must not declare marketplaceID/,
  );
});
