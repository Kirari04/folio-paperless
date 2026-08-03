import Constants from 'expo-constants';

import { allowsInAppApkUpdates } from './distribution';

export const IN_APP_APK_UPDATES_ENABLED = allowsInAppApkUpdates(
  Constants.expoConfig?.extra,
);
