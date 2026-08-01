import { requireOptionalNativeModule } from 'expo';

export type FolioInstallationInfo = {
  packageName: string;
  versionName: string;
  versionCode: number;
  certificateSha256: string;
  isOfficialRelease: boolean;
  canRequestPackageInstalls: boolean;
};

export type FolioApkInfo = {
  packageName: string;
  versionName: string;
  versionCode: number;
  certificateSha256: string;
  hasOfficialCertificate: boolean;
};

type FolioUpdaterNativeModule = {
  getInstallationInfoAsync(): Promise<FolioInstallationInfo>;
  calculateFileSha256Async(fileUri: string): Promise<string>;
  inspectApkAsync(fileUri: string): Promise<FolioApkInfo>;
  canRequestPackageInstallsAsync(): Promise<boolean>;
  openInstallPermissionSettingsAsync(): Promise<void>;
  installApkAsync(fileUri: string): Promise<void>;
};

const updaterModule = requireOptionalNativeModule<FolioUpdaterNativeModule>('FolioUpdater');

export function getFolioUpdaterModule() {
  return updaterModule;
}
