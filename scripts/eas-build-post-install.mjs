if (
  process.env.EAS_BUILD_PLATFORM === 'android'
  && process.env.FOLIO_DISTRIBUTION === 'store'
) {
  // EAS invokes this hook after Continuous Native Generation and before
  // Gradle. Verify that the store-only config plugin wrote the exclusion into
  // settings.gradle and that the corresponding resolver result omits it.
  await import('./prepare-store-autolinking.mjs');
  const { assertAndroidStoreManifestFile } = await import('./assert-android-store-manifest.mjs');
  assertAndroidStoreManifestFile(
    new URL('../android/app/src/main/AndroidManifest.xml', import.meta.url),
  );
} else {
  console.log('No post-install distribution mutation is required for this build.');
}
