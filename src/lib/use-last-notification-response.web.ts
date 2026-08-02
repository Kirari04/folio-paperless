import type { NotificationResponse } from 'expo-notifications';

// Expo Notifications does not implement the last-response native method on
// web. Deep links remain available there through expo-linking.
export function useLastNotificationResponse(): NotificationResponse | undefined {
  return undefined;
}
