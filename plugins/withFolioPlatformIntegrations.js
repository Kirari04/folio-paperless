const {
  AndroidConfig,
  IOSConfig,
  withAndroidManifest,
  withDangerousMod,
  withFinalizedMod,
  withInfoPlist,
  withXcodeProject,
} = require('@expo/config-plugins');
const fs = require('node:fs');
const path = require('node:path');

const SHORTCUTS = Object.freeze([
  {
    id: 'app.folio.paperless.quick-scan',
    androidId: 'folio_quick_scan',
    titleKey: 'folio_quick_scan_short',
    subtitleKey: 'folio_quick_scan_long',
    title: 'Quick Scan',
    subtitle: 'Scan a paper document',
    icon: 'UIApplicationShortcutIconTypeCapturePhoto',
    route: 'folio-paperless://scan',
  },
  {
    id: 'app.folio.paperless.inbox',
    androidId: 'folio_inbox',
    titleKey: 'folio_inbox_short',
    subtitleKey: 'folio_inbox_long',
    title: 'Inbox',
    subtitle: 'Open your inbox',
    icon: 'UIApplicationShortcutIconTypeTask',
    route: 'folio-paperless://inbox',
  },
  {
    id: 'app.folio.paperless.search',
    androidId: 'folio_search',
    titleKey: 'folio_search_short',
    subtitleKey: 'folio_search_long',
    title: 'Search',
    subtitle: 'Search documents',
    icon: 'UIApplicationShortcutIconTypeSearch',
    route: 'folio-paperless://search',
  },
]);

const SHORTCUTS_RESOURCE = '@xml/folio_shortcuts';
const IOS_SHARE_EXTENSION_TARGET = 'expo-sharing-extension';
const IOS_WIDGET_TARGET = 'ExpoWidgetsTarget';
const IOS_DATA_PROTECTION_KEY = 'com.apple.developer.default-data-protection';
const IOS_DATA_PROTECTION_VALUE = 'NSFileProtectionCompleteUntilFirstUserAuthentication';
const EXPO_SHARING_COPY_ERROR_LOG = 'print("Error copying file: \\(error)")';
const EXPO_SHARING_GENERIC_COPY_ERROR_LOG = 'print("Error copying a shared file")';
const IOS_SHARE_CONTROLLER_REQUIRED_MARKERS = Object.freeze([
  'private let maxIncomingShareBytes = 250 * 1024 * 1024',
  'provider.loadInPlaceFileRepresentation(forTypeIdentifier: identifier)',
  'if copied > maxBytes - chunk.count',
  'results.append(await parseProvider(provider))',
  'value: "folio-share-failure://\\(failure.rawValue)/\\(UUID().uuidString)"',
]);
const ANDROID_LOCALE_FALLBACKS = Object.freeze({
  CFBundleDisplayName: 'Folio for Paperless',
  NSCameraUsageDescription: 'Allow Folio to scan paper documents.',
  NSFaceIDUsageDescription:
    'Allow Folio to protect your document previews with Face ID.',
});
const ANDROID_THEME_COLORS = Object.freeze({
  light: Object.freeze({
    lime: '#D8F678',
    lime_surface: '#EFFBCB',
    lime_dark: '#526C1E',
    mint: '#CDE8D4',
    apricot: '#F2B486',
    lavender: '#D8D2F1',
    sky: '#C9E1EB',
    rose: '#EDC7C1',
    danger_surface: '#F7E8E5',
    viewer_surface: '#E7E2D8',
  }),
  dark: Object.freeze({
    lime: '#C8EA64',
    lime_surface: '#303C20',
    lime_dark: '#B8D957',
    mint: '#294638',
    apricot: '#643F2C',
    lavender: '#3D3859',
    sky: '#294753',
    rose: '#5C3735',
    danger_surface: '#402522',
    viewer_surface: '#171D19',
  }),
});

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function createAndroidShortcutsXml(androidPackage) {
  if (!/^[A-Za-z][A-Za-z0-9_.]+$/.test(androidPackage)) {
    throw new Error(`Invalid Android package ${JSON.stringify(androidPackage)}.`);
  }

  const entries = SHORTCUTS.map(
    (shortcut) => `  <shortcut
    android:shortcutId="${shortcut.androidId}"
    android:enabled="true"
    android:icon="@mipmap/ic_launcher"
    android:shortcutShortLabel="@string/${shortcut.androidId}_short"
    android:shortcutLongLabel="@string/${shortcut.androidId}_long">
    <intent
      android:action="android.intent.action.VIEW"
      android:targetPackage="${escapeXml(androidPackage)}"
      android:targetClass="${escapeXml(androidPackage)}.MainActivity"
      android:data="${escapeXml(shortcut.route)}" />
  </shortcut>`,
  ).join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
${entries}
</shortcuts>
`;
}

function createAndroidShortcutStringsXml() {
  const entries = SHORTCUTS.flatMap((shortcut) => [
    `  <string name="${shortcut.androidId}_short">${escapeXml(shortcut.title)}</string>`,
    `  <string name="${shortcut.androidId}_long">${escapeXml(shortcut.subtitle)}</string>`,
  ]).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
${entries}
</resources>
`;
}

function createAndroidLocaleFallbackStringsXml() {
  const entries = Object.entries(ANDROID_LOCALE_FALLBACKS)
    .map(([name, value]) => `  <string name="${name}">${escapeXml(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
${entries}
</resources>
`;
}

function createAndroidThemeColorsXml(colors) {
  const entries = Object.entries(colors)
    .map(([name, value]) => `  <color name="folio_${name}">${escapeXml(value)}</color>`)
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<resources>
${entries}
</resources>
`;
}

function createIosShortcutItems() {
  return SHORTCUTS.map((shortcut) => ({
    UIApplicationShortcutItemType: shortcut.id,
    // Static quick actions use Localizable.strings keys so iOS can render the
    // OS-selected language even before JavaScript starts.
    UIApplicationShortcutItemTitle: shortcut.titleKey,
    UIApplicationShortcutItemSubtitle: shortcut.subtitleKey,
    UIApplicationShortcutItemIconType: shortcut.icon,
    UIApplicationShortcutItemUserInfo: { route: shortcut.route },
  }));
}

function escapeAppleStrings(value) {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r');
}

function createAppleStringsFile(strings) {
  return `${Object.entries(strings)
    .map(([key, value]) => `"${escapeAppleStrings(key)}" = "${escapeAppleStrings(value)}";`)
    .join('\n')}\n`;
}

function writeIosWidgetLocalizations(projectRoot, platformProjectRoot, locales) {
  if (!locales || typeof locales !== 'object') {
    throw new Error('[withFolioPlatformIntegrations] native locales are required.');
  }
  const relativeFiles = [];
  for (const [locale, source] of Object.entries(locales)) {
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale) || typeof source !== 'string') {
      throw new Error('[withFolioPlatformIntegrations] native locale configuration is invalid.');
    }
    const localePath = path.resolve(projectRoot, source);
    const parsed = JSON.parse(fs.readFileSync(localePath, 'utf8'));
    const strings = parsed?.ios?.['Localizable.strings'];
    if (
      !strings
      || typeof strings !== 'object'
      || Array.isArray(strings)
      || Object.values(strings).some((value) => typeof value !== 'string')
    ) {
      throw new Error(
        `[withFolioPlatformIntegrations] ${locale} needs iOS Localizable.strings entries.`,
      );
    }
    const relativeFile = path.join(
      IOS_WIDGET_TARGET,
      `${locale}.lproj`,
      'Localizable.strings',
    );
    const targetFile = path.join(platformProjectRoot, relativeFile);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, createAppleStringsFile(strings));
    relativeFiles.push(relativeFile);
  }
  return relativeFiles;
}

function addIosWidgetLocalizationResources(project, relativeFiles) {
  const [targetUuid, target] = IOSConfig.Target.findNativeTargetByName(project, IOS_WIDGET_TARGET);
  const resourcePhaseReference = target.buildPhases?.find((phase) => phase.comment === 'Resources');
  const existing = resourcePhaseReference
    ? project.hash.project.objects.PBXResourcesBuildPhase?.[resourcePhaseReference.value]
    : null;
  if (!existing) {
    project.addBuildPhase(
      relativeFiles,
      'PBXResourcesBuildPhase',
      'Resources',
      targetUuid,
      'app_extension',
      '""',
    );
    return project;
  }
  const references = project.pbxFileReferenceSection();
  const existingPaths = new Set(existing.files.flatMap((entry) => {
    const buildFile = project.pbxBuildFileSection()[entry.value];
    const reference = buildFile ? references[buildFile.fileRef] : null;
    return typeof reference?.path === 'string' ? [reference.path.replaceAll('"', '')] : [];
  }));
  const missing = relativeFiles.filter((file) => !existingPaths.has(file));
  if (missing.length) {
    throw new Error(
      '[withFolioPlatformIntegrations] widget localization resource phase drifted; run a clean prebuild.',
    );
  }
  return project;
}

function addAndroidShortcutMetadata(androidManifest) {
  const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(androidManifest);
  mainActivity['meta-data'] ??= [];
  const metadata = mainActivity['meta-data'];
  const existing = metadata.find(
    (entry) => entry.$?.['android:name'] === 'android.app.shortcuts',
  );
  if (existing) {
    existing.$['android:resource'] = SHORTCUTS_RESOURCE;
  } else {
    metadata.push({
      $: {
        'android:name': 'android.app.shortcuts',
        'android:resource': SHORTCUTS_RESOURCE,
      },
    });
  }
  return androidManifest;
}

function hardenIosShareEntitlements(contents) {
  const entitlementPattern = new RegExp(
    `<key>${IOS_DATA_PROTECTION_KEY}<\\/key>\\s*<string>[^<]*<\\/string>`,
  );
  const protectedEntitlement = `<key>${IOS_DATA_PROTECTION_KEY}</key>\n    <string>${IOS_DATA_PROTECTION_VALUE}</string>`;
  if (entitlementPattern.test(contents)) {
    return contents.replace(entitlementPattern, protectedEntitlement);
  }
  if (!contents.includes('</dict>')) {
    throw new Error(
      '[withFolioPlatformIntegrations] malformed iOS share-extension entitlements.',
    );
  }
  return contents.replace(
    '</dict>',
    `  ${protectedEntitlement}\n  </dict>`,
  );
}

function hardenIosShareController(contents) {
  if (contents.includes(EXPO_SHARING_COPY_ERROR_LOG)) {
    throw new Error(
      '[withFolioPlatformIntegrations] expo-sharing still contains a path-bearing copy-error log.',
    );
  }
  if (!contents.includes(EXPO_SHARING_GENERIC_COPY_ERROR_LOG)) {
    throw new Error(
      '[withFolioPlatformIntegrations] expo-sharing copy-error source contract changed.',
    );
  }
  const missingMarkers = IOS_SHARE_CONTROLLER_REQUIRED_MARKERS.filter(
    (marker) => !contents.includes(marker),
  );
  if (missingMarkers.length) {
    throw new Error(
      '[withFolioPlatformIntegrations] expo-sharing bounded per-item source contract changed.',
    );
  }
  return contents;
}

function hardenIosShareExtension(platformProjectRoot) {
  const extensionRoot = path.join(platformProjectRoot, IOS_SHARE_EXTENSION_TARGET);
  const entitlementsPath = path.join(
    extensionRoot,
    `${IOS_SHARE_EXTENSION_TARGET}.entitlements`,
  );
  const controllerPath = path.join(extensionRoot, 'ShareIntoViewController.swift');
  for (const requiredPath of [entitlementsPath, controllerPath]) {
    if (!fs.existsSync(requiredPath)) {
      throw new Error(
        `[withFolioPlatformIntegrations] expected expo-sharing output at ${requiredPath}.`,
      );
    }
  }
  fs.writeFileSync(
    entitlementsPath,
    hardenIosShareEntitlements(fs.readFileSync(entitlementsPath, 'utf8')),
  );
  fs.writeFileSync(
    controllerPath,
    hardenIosShareController(fs.readFileSync(controllerPath, 'utf8')),
  );
}

function withFolioPlatformIntegrations(config) {
  let next = withInfoPlist(config, (plistConfig) => {
    plistConfig.modResults.UIApplicationShortcutItems = createIosShortcutItems();
    return plistConfig;
  });

  next = withAndroidManifest(next, (manifestConfig) => {
    manifestConfig.modResults = addAndroidShortcutMetadata(manifestConfig.modResults);
    return manifestConfig;
  });

  let iosWidgetLocalizationFiles = [];
  next = withDangerousMod(next, [
    'ios',
    async (modConfig) => {
      iosWidgetLocalizationFiles = writeIosWidgetLocalizations(
        modConfig.modRequest.projectRoot,
        modConfig.modRequest.platformProjectRoot,
        modConfig.locales,
      );
      return modConfig;
    },
  ]);
  next = withXcodeProject(next, (xcodeConfig) => {
    xcodeConfig.modResults = addIosWidgetLocalizationResources(
      xcodeConfig.modResults,
      iosWidgetLocalizationFiles,
    );
    return xcodeConfig;
  });

  // expo-sharing creates its extension from a template in an iOS dangerous mod.
  // Finalization is the first point at which both generated files are guaranteed
  // to exist. Add data protection and fail prebuild if the patched template drifts.
  next = withFinalizedMod(next, [
    'ios',
    async (modConfig) => {
      hardenIosShareExtension(modConfig.modRequest.platformProjectRoot);
      return modConfig;
    },
  ]);

  return withDangerousMod(next, [
    'android',
    async (modConfig) => {
      const androidPackage = modConfig.android?.package;
      if (!androidPackage) {
        throw new Error('[withFolioPlatformIntegrations] android.package is required.');
      }
      const resourceRoot = path.join(
        modConfig.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
      );
      const xmlDirectory = path.join(resourceRoot, 'xml');
      const valuesDirectory = path.join(resourceRoot, 'values');
      const nightValuesDirectory = path.join(resourceRoot, 'values-night');
      fs.mkdirSync(xmlDirectory, { recursive: true });
      fs.mkdirSync(valuesDirectory, { recursive: true });
      fs.mkdirSync(nightValuesDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDirectory, 'folio_shortcuts.xml'),
        createAndroidShortcutsXml(androidPackage),
      );
      fs.writeFileSync(
        path.join(valuesDirectory, 'folio_shortcuts.xml'),
        createAndroidShortcutStringsXml(),
      );
      // Expo's top-level locale catalogs are emitted to Android as well as iOS.
      // Android lint requires every translated key to exist in an unqualified
      // values directory, even when a key is consumed only by Info.plist.
      fs.writeFileSync(
        path.join(valuesDirectory, 'folio_locale_fallbacks.xml'),
        createAndroidLocaleFallbackStringsXml(),
      );
      fs.writeFileSync(
        path.join(valuesDirectory, 'folio_theme_colors.xml'),
        createAndroidThemeColorsXml(ANDROID_THEME_COLORS.light),
      );
      fs.writeFileSync(
        path.join(nightValuesDirectory, 'folio_theme_colors.xml'),
        createAndroidThemeColorsXml(ANDROID_THEME_COLORS.dark),
      );
      return modConfig;
    },
  ]);
}

module.exports = withFolioPlatformIntegrations;
module.exports.ANDROID_THEME_COLORS = ANDROID_THEME_COLORS;
module.exports.SHORTCUTS = SHORTCUTS;
module.exports.addAndroidShortcutMetadata = addAndroidShortcutMetadata;
module.exports.addIosWidgetLocalizationResources = addIosWidgetLocalizationResources;
module.exports.createAppleStringsFile = createAppleStringsFile;
module.exports.createAndroidLocaleFallbackStringsXml = createAndroidLocaleFallbackStringsXml;
module.exports.createAndroidShortcutStringsXml = createAndroidShortcutStringsXml;
module.exports.createAndroidShortcutsXml = createAndroidShortcutsXml;
module.exports.createAndroidThemeColorsXml = createAndroidThemeColorsXml;
module.exports.createIosShortcutItems = createIosShortcutItems;
module.exports.hardenIosShareController = hardenIosShareController;
module.exports.hardenIosShareEntitlements = hardenIosShareEntitlements;
module.exports.hardenIosShareExtension = hardenIosShareExtension;
module.exports.writeIosWidgetLocalizations = writeIosWidgetLocalizations;
module.exports.IOS_SHARE_CONTROLLER_REQUIRED_MARKERS = IOS_SHARE_CONTROLLER_REQUIRED_MARKERS;
