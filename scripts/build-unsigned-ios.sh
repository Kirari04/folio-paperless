#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 || "$1" != *.ipa ]]; then
  echo "Usage: $0 /path/to/Folio-<label>-ios-unsigned.ipa" >&2
  exit 64
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Unsigned iOS archives must be built on macOS with Xcode." >&2
  exit 1
fi

: "${RUNNER_TEMP:?RUNNER_TEMP must point to an isolated build directory}"

repository_root="$(git rev-parse --show-toplevel)"
output_ipa="$1"
if [[ "$output_ipa" != /* ]]; then
  output_ipa="$repository_root/$output_ipa"
fi

cd "$repository_root"

package_version="$(node -p "require('./package.json').version")"
expected_version="${EXPECTED_VERSION:-$package_version}"
expected_build_number="${EXPECTED_BUILD_NUMBER:-$(node - <<'NODE'
const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(require('./package.json').version);
if (!match) throw new Error('package.json must contain a stable MAJOR.MINOR.PATCH version.');
const [major, minor, patch] = match.slice(1).map(Number);
process.stdout.write(String(major * 1_000_000 + minor * 1_000 + patch));
NODE
)}"

archive_path="$RUNNER_TEMP/Folio.xcarchive"
package_root="$RUNNER_TEMP/folio-unsigned-ipa"
app_path="$archive_path/Products/Applications/FolioforPaperless.app"
info_plist="$app_path/Info.plist"

echo "Building Folio $expected_version ($expected_build_number) with:"
xcodebuild -version
pod --version

xcode_major="$(xcodebuild -version | sed -n 's/^Xcode \([0-9][0-9]*\).*/\1/p')"
if [[ -z "$xcode_major" || "$xcode_major" -lt 26 ]]; then
  echo "Expo SDK 57 release builds require Xcode 26 or newer; found ${xcode_major:-unknown}." >&2
  exit 1
fi

export CI=1
export NODE_ENV=production
export RCT_NO_LAUNCH_PACKAGER=1

npx expo prebuild --platform ios --clean --no-install
pod install --project-directory=ios

xcodebuild \
  -workspace ios/FolioforPaperless.xcworkspace \
  -scheme FolioforPaperless \
  -configuration Release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive_path" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY= \
  DEVELOPMENT_TEAM= \
  COMPILER_INDEX_STORE_ENABLE=NO \
  archive

if [[ ! -d "$app_path" || ! -f "$info_plist" ]]; then
  echo "Xcode did not produce the expected application at $app_path." >&2
  exit 1
fi

read_plist() {
  /usr/libexec/PlistBuddy -c "Print :$1" "$info_plist"
}

actual_identifier="$(read_plist CFBundleIdentifier)"
actual_version="$(read_plist CFBundleShortVersionString)"
actual_build_number="$(read_plist CFBundleVersion)"
executable_name="$(read_plist CFBundleExecutable)"

[[ "$actual_identifier" == "app.folio.paperless" ]] || {
  echo "Unexpected iOS bundle identifier: $actual_identifier" >&2
  exit 1
}
[[ "$actual_version" == "$expected_version" ]] || {
  echo "Unexpected iOS version: expected $expected_version, received $actual_version" >&2
  exit 1
}
[[ "$actual_build_number" == "$expected_build_number" ]] || {
  echo "Unexpected iOS build number: expected $expected_build_number, received $actual_build_number" >&2
  exit 1
}

device_families="$(read_plist UIDeviceFamily)"
if [[ "$device_families" != *"1"* || "$device_families" == *"2"* ]]; then
  echo "The release must target iPhone only; UIDeviceFamily was: $device_families" >&2
  exit 1
fi

executable_path="$app_path/$executable_name"
if [[ ! -x "$executable_path" ]]; then
  echo "The archived application executable is missing." >&2
  exit 1
fi
architectures="$(lipo -archs "$executable_path")"
if [[ " $architectures " != *" arm64 "* ]]; then
  echo "The archived application does not contain an arm64 device binary: $architectures" >&2
  exit 1
fi

if [[ -d "$app_path/_CodeSignature" || -f "$app_path/embedded.mobileprovision" ]]; then
  echo "The iOS archive unexpectedly contains signing material." >&2
  exit 1
fi
if codesign --display "$app_path" >/dev/null 2>&1; then
  echo "The iOS application is signed; the GitHub artifact must remain unsigned." >&2
  exit 1
fi

if ! find "$app_path" -maxdepth 1 -type f -name '*.jsbundle' -size +0 -print -quit | grep -q .; then
  echo "The release application does not contain its production JavaScript bundle." >&2
  exit 1
fi
if ! find "$app_path" -type f -name 'PrivacyInfo.xcprivacy' -print -quit | grep -q .; then
  echo "The release application does not contain an Apple privacy manifest." >&2
  exit 1
fi

mkdir -p "$(dirname "$output_ipa")" "$package_root/Payload"
ditto "$app_path" "$package_root/Payload/FolioforPaperless.app"
(
  cd "$package_root"
  ditto -c -k --sequesterRsrc --keepParent Payload "$output_ipa"
)

if [[ ! -s "$output_ipa" ]]; then
  echo "The unsigned IPA was not created." >&2
  exit 1
fi
unzip -tq "$output_ipa"

checksum_path="$output_ipa.sha256"
(
  cd "$(dirname "$output_ipa")"
  shasum -a 256 "$(basename "$output_ipa")" > "$(basename "$checksum_path")"
)

metadata_path="${output_ipa%.ipa}.metadata.json"
INFO_PLIST="$info_plist" IOS_PROJECT_ROOT="$repository_root/ios" METADATA_PATH="$metadata_path" node <<'NODE'
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function findEntitlementFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'Pods') continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findEntitlementFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith('.entitlements')) files.push(entryPath);
  }
  return files;
}

function readPlist(plistPath) {
  return JSON.parse(
    execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
      encoding: 'utf8',
    }),
  );
}

const info = readPlist(process.env.INFO_PLIST);
const privacy = Object.fromEntries(
  Object.entries(info)
    .filter(([key, value]) => /^NS.+UsageDescription$/.test(key) && typeof value === 'string')
    .sort(([left], [right]) => left.localeCompare(right)),
);
const entitlements = [
  ...new Set(
    findEntitlementFiles(process.env.IOS_PROJECT_ROOT).flatMap((plistPath) =>
      Object.keys(readPlist(plistPath)),
    ),
  ),
].sort();
const expectedEntitlements = [
  'com.apple.developer.default-data-protection',
  'com.apple.security.application-groups',
];
const metadata = {
  bundleIdentifier: info.CFBundleIdentifier,
  version: info.CFBundleShortVersionString,
  buildVersion: info.CFBundleVersion,
  minOSVersion: info.MinimumOSVersion,
  entitlements,
  privacy,
};

if (!metadata.minOSVersion || Object.keys(privacy).length === 0) {
  throw new Error('The archived app is missing AltStore compatibility metadata.');
}
if (JSON.stringify(entitlements) !== JSON.stringify(expectedEntitlements)) {
  throw new Error(
    `The sideloading entitlements do not match Folio's reviewed widget and share-extension policy; received ${entitlements.join(', ') || 'none'}.`,
  );
}
fs.writeFileSync(process.env.METADATA_PATH, `${JSON.stringify(metadata, null, 2)}\n`);
NODE

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "ipa_path=$output_ipa"
    echo "checksum_path=$checksum_path"
    echo "metadata_path=$metadata_path"
  } >> "$GITHUB_OUTPUT"
fi

echo "Created unsigned iPhone artifact: $output_ipa"
echo "Created sideloading metadata: $metadata_path"
echo "This IPA contains no provisioning profile or code signature and must be signed before installation."
