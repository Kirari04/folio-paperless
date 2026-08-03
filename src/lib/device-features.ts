import { Platform } from 'react-native';

import { translateRuntime } from '@/i18n/runtime';

import { PaperlessApiError } from '@/lib/paperless';
import {
  createUploadCompletionNotificationEvent,
  createNotificationContent,
  NotificationRouteRegistry,
  type LocalNotificationEvent,
  type NotificationRouteHandle,
  type NotificationRoutePayload,
  type NotificationPrivacy,
} from '@/lib/platform-notifications';
import { createPlatformStringStore } from '@/lib/platform-storage';

const NOTIFICATION_HANDLES_KEY = 'folio.paperless.notification-route-handles';
let runtimeNotificationPrivacyLocked = false;
let runtimeNotificationsEnabled = false;
let runtimeNotificationPreference: NotificationPrivacy = 'redacted';

export function setRuntimeNotificationPrivacyLocked(locked: boolean) {
  runtimeNotificationPrivacyLocked = locked;
}

export function setRuntimeNotificationPreferences(
  enabled: boolean,
  privacy: NotificationPrivacy,
) {
  runtimeNotificationsEnabled = enabled;
  runtimeNotificationPreference = privacy;
}
const notificationHandleStore = createPlatformStringStore();
const notificationRouteRegistry = new NotificationRouteRegistry({
  async load(): Promise<NotificationRouteHandle[]> {
    const raw = await notificationHandleStore.getItem(NOTIFICATION_HANDLES_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed as NotificationRouteHandle[] : [];
    } catch {
      return [];
    }
  },
  async save(handles) {
    if (!handles.length) {
      await notificationHandleStore.deleteItem(NOTIFICATION_HANDLES_KEY);
      return;
    }
    await notificationHandleStore.setItem(NOTIFICATION_HANDLES_KEY, JSON.stringify(handles));
  },
});

export async function consumeRegisteredNotificationRoute(
  notificationId: string,
): Promise<NotificationRoutePayload | null> {
  return notificationRouteRegistry.consume(notificationId);
}

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
    promptMessage: translateRuntime('device.unlockFolio'),
    cancelLabel: translateRuntime('common.cancel'),
    disableDeviceFallback: false,
  });
  return result.success;
}

export async function cancelAuthenticationForFolio() {
  if (Platform.OS !== 'android') return;
  const LocalAuthentication = await import('expo-local-authentication');
  await LocalAuthentication.cancelAuthenticate();
}

export async function requestProcessingNotificationPermission() {
  if (Platform.OS === 'web') return false;
  const Notifications = await import('expo-notifications');
  const current = await Notifications.getPermissionsAsync();
  const permission = current.granted ? current : await Notifications.requestPermissionsAsync();
  if (!permission.granted) return false;

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('document-processing', {
      name: translateRuntime('notifications.channelName'),
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 180],
    });
  }
  return true;
}

export async function notifyDocumentProcessed(input: {
  profileId: string;
  documentId: string;
  title?: string;
  privacy?: NotificationPrivacy;
}) {
  return notifyLocalEvent(createUploadCompletionNotificationEvent({
    profileId: input.profileId,
    taskId: input.documentId,
    canonicalDocumentId: input.documentId,
    documentTitle: input.title,
    issuedAt: new Date().toISOString(),
  }), input.privacy);
}

export async function notifyLocalEvent(
  event: LocalNotificationEvent,
  privacy?: NotificationPrivacy,
  deliveryId?: string,
) {
  if (Platform.OS === 'web') return;
  if (!runtimeNotificationsEnabled) return;
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
  const safe = createNotificationContent(event,
    runtimeNotificationPrivacyLocked || runtimeNotificationPreference === 'redacted'
      ? 'redacted'
      : privacy);
  const notificationId = await Notifications.scheduleNotificationAsync({
    ...(deliveryId ? { identifier: deliveryId } : {}),
    content: {
      title: safe.title,
      body: safe.body,
      data: safe.data,
    },
    trigger: null,
  });
  try {
    await notificationRouteRegistry.register({
      notificationId,
      profileId: event.profileId,
      payload: safe.data,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    await Promise.allSettled([
      Notifications.dismissNotificationAsync(notificationId),
      Notifications.cancelScheduledNotificationAsync(notificationId),
    ]);
    throw error;
  }
}

export async function notifyUploadCompleted(input: {
  profileId: string;
  taskId: string;
  canonicalDocumentId?: string | null;
  title?: string;
  privacy?: NotificationPrivacy;
  deliveryId?: string;
}) {
  return notifyLocalEvent(createUploadCompletionNotificationEvent({
    profileId: input.profileId,
    taskId: input.taskId,
    canonicalDocumentId: input.canonicalDocumentId,
    documentTitle: input.title,
    issuedAt: new Date().toISOString(),
  }), input.privacy, input.deliveryId);
}

export async function notifyTaskResult(input: {
  profileId: string;
  taskId: string;
  succeeded: boolean;
  privacy?: NotificationPrivacy;
  deliveryId?: string;
}) {
  return notifyLocalEvent({
    kind: 'task-result',
    profileId: input.profileId,
    taskId: input.taskId,
    succeeded: input.succeeded,
    issuedAt: new Date().toISOString(),
  }, input.privacy, input.deliveryId);
}

export async function notifyInboxAction(input: {
  profileId: string;
  inboxCount: number;
  privacy?: NotificationPrivacy;
}) {
  return notifyLocalEvent({
    kind: 'inbox',
    profileId: input.profileId,
    inboxCount: input.inboxCount,
    issuedAt: new Date().toISOString(),
  }, input.privacy);
}

export async function notifySyncAction(input: {
  profileId: string;
  succeeded: boolean;
  privacy?: NotificationPrivacy;
}) {
  return notifyLocalEvent({
    kind: 'sync',
    profileId: input.profileId,
    succeeded: input.succeeded,
    issuedAt: new Date().toISOString(),
  }, input.privacy);
}

export async function dismissProfileNotifications(profileId: string) {
  // Revoke routing authority first. Native notification cleanup is best effort:
  // an OS entry may already be gone, but that must never keep a stale profile
  // route handle alive in persistent storage.
  const identifiers = await notificationRouteRegistry.revokeProfile(profileId);
  if (Platform.OS === 'web' || identifiers.length === 0) return;
  const Notifications = await import('expo-notifications');
  for (const identifier of identifiers) {
    await Promise.allSettled([
      Notifications.dismissNotificationAsync(identifier),
      Notifications.cancelScheduledNotificationAsync(identifier),
    ]);
  }
}

export async function requireBiometricSupport() {
  if (!(await canUseBiometrics())) {
    throw new PaperlessApiError(
      translateRuntime('device.biometricSetup'),
    );
  }
}
