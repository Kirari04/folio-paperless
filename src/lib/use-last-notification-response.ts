import * as Notifications from 'expo-notifications';

export function useLastNotificationResponse() {
  return Notifications.useLastNotificationResponse();
}
