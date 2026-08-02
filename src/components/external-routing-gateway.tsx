import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useRef } from 'react';
import { Alert } from 'react-native';

import { useApp } from '@/context/app-context';
import { useI18n } from '@/context/ui-preferences-context';
import {
  type DocumentRouteAccess,
  type ExternalNavigationState,
} from '@/lib/external-routing';
import {
  consumeNotificationResponseIntoRuntime,
  ExternalRoutingRuntime,
} from '@/lib/external-routing-runtime';
import {
  consumeCachedLinkingUrl,
  consumeLinkingUrl,
} from '@/lib/consumable-linking';
import { consumeRegisteredNotificationRoute } from '@/lib/device-features';
import { listenForFolioShortcuts } from '@/lib/platform-native-shortcuts';
import { useRouter } from '@/lib/router';
import { useLastNotificationResponse } from '@/lib/use-last-notification-response';

export function ExternalRoutingGateway() {
  const router = useRouter();
  const notification = useLastNotificationResponse();
  const { t } = useI18n();
  const {
    activeProfile,
    connected,
    documents,
    isBootstrapping,
    profiles,
    switchProfile,
  } = useApp();
  const handledNotification = useRef<string | null>(null);
  const promptingProfile = useRef<string | null>(null);
  const runtime = useRef(new ExternalRoutingRuntime());
  const drainQueue = useRef<Promise<void>>(Promise.resolve());
  const drainRequest = useRef<() => void>(() => undefined);
  const gatewayMounted = useRef(true);

  useEffect(() => () => {
    gatewayMounted.current = false;
  }, []);

  const navigationState = useCallback((): ExternalNavigationState => ({
    bootstrap: isBootstrapping ? 'pending' : 'ready',
    profileSelection: promptingProfile.current ? 'pending' : 'ready',
    biometric: 'unlocked',
    authenticated: connected,
    activeProfileId: activeProfile?.id ?? null,
    knownProfileIds: profiles.map((profile) => profile.id),
  }), [activeProfile?.id, connected, isBootstrapping, profiles]);

  const documentAccess = useCallback(async (
    profileId: string,
    documentId: string,
  ): Promise<DocumentRouteAccess> => {
    if (profileId !== activeProfile?.id) return 'unauthorized';
    const normalized = documentId.startsWith('remote-') ? documentId : `remote-${documentId}`;
    const document = documents.find((item) => item.id === normalized || item.id === documentId);
    if (!document) return 'missing';
    if (document.deletedAt) return 'deleted';
    if (document.canView !== true) return 'unauthorized';
    return 'allowed';
  }, [activeProfile?.id, documents]);

  const drainExternalRoutes: () => void = useCallback(() => {
    drainQueue.current = drainQueue.current
      .catch(() => undefined)
      .then(async () => {
        const decisions = await runtime.current.drain(navigationState(), documentAccess);
        for (const decision of decisions) {
          if (decision.kind === 'defer') {
            if (decision.reason !== 'profile-switch-required' || !decision.requiredProfileId) {
              continue;
            }
            if (promptingProfile.current) continue;
            promptingProfile.current = decision.requiredProfileId;
            const profile = profiles.find((item) => item.id === decision.requiredProfileId);
            Alert.alert(
              t('routing.switchProfileTitle'),
              t('routing.switchProfileBody', {
                profile: profile?.displayName ?? decision.requiredProfileId,
              }),
              [
                {
                  text: t('common.cancel'),
                  style: 'cancel',
                  onPress: () => {
                    runtime.current.clearProfile(decision.requiredProfileId!);
                    promptingProfile.current = null;
                    drainRequest.current();
                  },
                },
                {
                  text: t('routing.switchProfile'),
                  onPress: () => {
                    const requiredProfileId = decision.requiredProfileId!;
                    void switchProfile(requiredProfileId).then(
                      () => {
                        promptingProfile.current = null;
                        drainRequest.current();
                      },
                      () => {
                        runtime.current.clearProfile(requiredProfileId);
                        promptingProfile.current = null;
                        drainRequest.current();
                      },
                    );
                  },
                },
              ],
            );
            continue;
          }

          router.navigate(decision.kind === 'fallback' ? '/' : decision.target);
        }
      });
  }, [documentAccess, navigationState, profiles, router, switchProfile, t]);

  useEffect(() => {
    drainRequest.current = drainExternalRoutes;
  }, [drainExternalRoutes]);

  const queueRoute = useCallback((route: Parameters<ExternalRoutingRuntime['acceptRoute']>[0]) => {
    runtime.current.acceptRoute(route);
    drainExternalRoutes();
  }, [drainExternalRoutes]);

  useEffect(() => {
    const frames = new Set<number>();
    const scheduleDrain = () => {
      const frame = requestAnimationFrame(() => {
        frames.delete(frame);
        drainExternalRoutes();
      });
      frames.add(frame);
    };
    const acceptDeepLink = (input: string) => {
      const accepted = runtime.current.acceptUrl(input, 'deep-link');
      if (accepted.accepted) {
        scheduleDrain();
      } else if (accepted.reason === 'invalid-url') {
        runtime.current.acceptRoute({ kind: 'home', source: 'deep-link' });
        scheduleDrain();
      }
    };

    // Subscribe first, then synchronously consume the SDK 57 native cache. No
    // URL can arrive between those operations on the JavaScript event loop.
    const subscription = Linking.addEventListener('url', ({ url }) => {
      consumeLinkingUrl(url, Linking, acceptDeepLink);
    });
    consumeCachedLinkingUrl(Linking, acceptDeepLink);

    return () => {
      subscription.remove();
      for (const frame of frames) cancelAnimationFrame(frame);
    };
  }, [drainExternalRoutes]);

  useEffect(() => {
    const response = notification;
    const identifier = response?.notification.request.identifier;
    if (!identifier || handledNotification.current === identifier) return;
    handledNotification.current = identifier;

    void consumeNotificationResponseIntoRuntime({
      notificationId: identifier,
      actionIdentifier: response.actionIdentifier,
      data: response.notification.request.content.data,
    }, {
      defaultActionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
      clearLastResponse: Notifications.clearLastNotificationResponse,
      consumeHandle: consumeRegisteredNotificationRoute,
    }, runtime.current).then((accepted) => {
      if (!gatewayMounted.current) return;
      if (accepted.accepted) drainExternalRoutes();
    });
  }, [drainExternalRoutes, notification]);

  useEffect(() => {
    let active = true;
    let remove = () => {};
    void listenForFolioShortcuts((route) => {
      if (active) queueRoute(route);
    }).then((subscription) => {
      if (active) {
        remove = () => subscription.remove();
      } else {
        subscription.remove();
      }
    });
    return () => {
      active = false;
      remove();
    };
  }, [queueRoute]);

  useEffect(() => {
    if (!promptingProfile.current) drainExternalRoutes();
  }, [activeProfile?.id, connected, documents, drainExternalRoutes, isBootstrapping, profiles]);

  return null;
}
