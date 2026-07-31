import { Platform } from 'react-native';

import { PaperlessApiError } from '@/lib/paperless';

export async function canUseBiometrics() {
  if (Platform.OS === 'web') return false;
  const LocalAuthentication = await import('expo-local-authentication');
  const [hasHardware, isEnrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  return hasHardware && isEnrolled;
}

export async function authenticateForFolio() {
  if (Platform.OS === 'web') return true;
  const LocalAuthentication = await import('expo-local-authentication');
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: 'Unlock Folio',
    cancelLabel: 'Cancel',
    disableDeviceFallback: false,
  });
  return result.success;
}

export async function requestProcessingNotificationPermission() {
  if (Platform.OS === 'web') return false;
  const Notifications = await import('expo-notifications');
  const current = await Notifications.getPermissionsAsync();
  const permission = current.granted ? current : await Notifications.requestPermissionsAsync();
  if (!permission.granted) return false;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('document-processing', {
      name: 'Document processing',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 180],
    });
  }
  return true;
}

export async function notifyDocumentProcessed(title: string) {
  if (Platform.OS === 'web') return;
  const Notifications = await import('expo-notifications');
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Document ready',
      body: `${title} has finished processing in Paperless.`,
      data: { screen: 'inbox' },
    },
    trigger: null,
  });
}

export async function requireBiometricSupport() {
  if (!(await canUseBiometrics())) {
    throw new PaperlessApiError(
      'Set up fingerprint or face unlock in your device settings before enabling this option.',
    );
  }
}
