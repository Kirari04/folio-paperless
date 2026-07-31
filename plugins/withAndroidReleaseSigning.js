const { withAppBuildGradle } = require('@expo/config-plugins');

const DEFINITIONS_BEGIN = '// @generated begin folio-release-signing-definitions';
const DEFINITIONS_END = '// @generated end folio-release-signing-definitions';
const CONFIG_BEGIN = '        // @generated begin folio-release-signing-config';
const CONFIG_END = '        // @generated end folio-release-signing-config';
const BUILD_TYPE_BEGIN = '            // @generated begin folio-release-signing-build-type';
const BUILD_TYPE_END = '            // @generated end folio-release-signing-build-type';

const ALL_MARKERS = [
  DEFINITIONS_BEGIN,
  DEFINITIONS_END,
  CONFIG_BEGIN,
  CONFIG_END,
  BUILD_TYPE_BEGIN,
  BUILD_TYPE_END,
];

function replaceExpectedOnce(source, expected, replacement, description) {
  const parts = source.split(expected);
  if (parts.length !== 2) {
    throw new Error(
      `[withAndroidReleaseSigning] Expected exactly one ${description} in the Expo SDK 57 ` +
        `android/app/build.gradle template, but found ${parts.length - 1}. ` +
        'The generated template may have changed; review the plugin before releasing.',
    );
  }

  return `${parts[0]}${replacement}${parts[1]}`;
}

function addReleaseSigning(source) {
  const markerCount = ALL_MARKERS.filter((marker) => source.includes(marker)).length;
  if (markerCount === ALL_MARKERS.length) {
    return source;
  }
  if (markerCount !== 0) {
    throw new Error(
      '[withAndroidReleaseSigning] Found a partial Folio signing modification in ' +
        'android/app/build.gradle. Run Expo Prebuild with --clean before retrying.',
    );
  }

  const definitions = `${DEFINITIONS_BEGIN}
def folioSigningPropertyNames = [
    'FOLIO_UPLOAD_STORE_FILE',
    'FOLIO_UPLOAD_STORE_PASSWORD',
    'FOLIO_UPLOAD_KEY_ALIAS',
    'FOLIO_UPLOAD_KEY_PASSWORD',
]
def folioRequireReleaseSigning = (findProperty('FOLIO_REQUIRE_RELEASE_SIGNING') ?: 'false').toBoolean()
def folioMissingSigningProperties = folioSigningPropertyNames.findAll { propertyName ->
    def propertyValue = findProperty(propertyName)
    propertyValue == null || propertyValue.toString().trim().isEmpty()
}
def folioReleaseSigningConfigured = folioMissingSigningProperties.isEmpty()

if (folioRequireReleaseSigning && !folioReleaseSigningConfigured) {
    throw new GradleException(
        "Folio release signing is required, but these Gradle properties are missing: " +
        folioMissingSigningProperties.join(', ')
    )
}
${DEFINITIONS_END}

android {`;

  let result = replaceExpectedOnce(source, 'android {', definitions, 'android block');

  const signingConfigs = `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
${CONFIG_BEGIN}
        release {
            if (folioReleaseSigningConfigured) {
                storeFile file(findProperty('FOLIO_UPLOAD_STORE_FILE'))
                storePassword findProperty('FOLIO_UPLOAD_STORE_PASSWORD')
                keyAlias findProperty('FOLIO_UPLOAD_KEY_ALIAS')
                keyPassword findProperty('FOLIO_UPLOAD_KEY_PASSWORD')
                storeType 'PKCS12'
            }
        }
${CONFIG_END}
    }`;

  result = replaceExpectedOnce(
    result,
    `    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }`,
    signingConfigs,
    'default signingConfigs block',
  );

  const releaseSigning = `        release {
${BUILD_TYPE_BEGIN}
            if (folioReleaseSigningConfigured) {
                signingConfig signingConfigs.release
            }
${BUILD_TYPE_END}`;

  result = replaceExpectedOnce(
    result,
    `        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug`,
    releaseSigning,
    'debug-signed release build type',
  );

  return result;
}

function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (gradleConfig) => {
    if (gradleConfig.modResults.language !== 'groovy') {
      throw new Error(
        `[withAndroidReleaseSigning] Expected a Groovy app build file, received ` +
          `"${gradleConfig.modResults.language}".`,
      );
    }

    gradleConfig.modResults.contents = addReleaseSigning(gradleConfig.modResults.contents);
    return gradleConfig;
  });
}

module.exports = withAndroidReleaseSigning;
module.exports.addReleaseSigning = addReleaseSigning;
