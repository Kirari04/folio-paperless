import { getFolioPlatformNativeModule } from './folio-platform-native';

/** Marks a completed private staging copy as ineligible for iCloud backup. */
export async function excludeSensitiveFileFromBackup(fileUri: string) {
  const nativeModule = getFolioPlatformNativeModule();
  if (!nativeModule?.excludeFileFromBackupAsync) {
    throw new Error('Secure iOS staging protection is unavailable in this build.');
  }
  await nativeModule.excludeFileFromBackupAsync(fileUri);
}
