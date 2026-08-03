import {
  DeferredExternalNavigationQueue,
  isReservedAuthCallbackUrl,
  parseExternalUrl,
  type DeferredExternalNavigationContract,
  type DocumentRouteAccess,
  type ExternalNavigationDecision,
  type ExternalNavigationState,
  type ExternalRoute,
  type ExternalRouteSource,
} from './external-routing.ts';
import {
  parseNotificationRoutePayload,
  type NotificationRoutePayload,
} from './platform-notifications.ts';

export type ExternalRouteIngressResult =
  | { accepted: true; route: ExternalRoute }
  | { accepted: false; reason: 'auth-callback' | 'invalid-url' | 'invalid-notification' };

export type NotificationResponseIngressResult = ExternalRouteIngressResult
  | {
      accepted: false;
      reason: 'unsupported-action' | 'unknown-handle' | 'payload-mismatch';
    };

function sameNotificationPayload(
  registered: NotificationRoutePayload,
  received: NotificationRoutePayload,
) {
  const registeredEntries = Object.entries(registered).sort(([left], [right]) =>
    left.localeCompare(right));
  const receivedEntries = Object.entries(received).sort(([left], [right]) =>
    left.localeCompare(right));
  return JSON.stringify(registeredEntries) === JSON.stringify(receivedEntries);
}

/**
 * Shared cold/warm external-navigation ingress. The queue deliberately lives
 * outside React state so a second event cannot overwrite a route that is still
 * waiting for bootstrap, profile selection, or unlock.
 */
export class ExternalRoutingRuntime {
  private readonly queue: DeferredExternalNavigationContract;
  private readonly now: () => number;

  constructor(
    queue: DeferredExternalNavigationContract = new DeferredExternalNavigationQueue(),
    now: () => number = Date.now,
  ) {
    this.queue = queue;
    this.now = now;
  }

  acceptRoute(route: ExternalRoute): ExternalRouteIngressResult {
    this.queue.enqueue(route, this.now());
    return { accepted: true, route };
  }

  acceptUrl(
    input: unknown,
    source: ExternalRouteSource = 'deep-link',
  ): ExternalRouteIngressResult {
    if (isReservedAuthCallbackUrl(input)) {
      return { accepted: false, reason: 'auth-callback' };
    }
    const parsed = parseExternalUrl(input, source);
    if (!parsed.accepted) return { accepted: false, reason: 'invalid-url' };
    return this.acceptRoute(parsed.route);
  }

  acceptNotificationPayload(input: unknown): ExternalRouteIngressResult {
    const parsed = parseNotificationRoutePayload(input);
    if (!parsed.accepted) return { accepted: false, reason: 'invalid-notification' };
    return this.acceptRoute(parsed.route);
  }

  acceptRegisteredNotification(payload: NotificationRoutePayload): ExternalRouteIngressResult {
    return this.acceptNotificationPayload(payload);
  }

  pending(): ExternalRoute[] {
    return this.queue.pending();
  }

  clear(): void {
    this.queue.clear();
  }

  clearProfile(profileId: string): void {
    this.queue.clearProfile(profileId);
  }

  drain(
    state: ExternalNavigationState,
    documentAccess?: (profileId: string, documentId: string) => Promise<DocumentRouteAccess>,
  ): Promise<ExternalNavigationDecision[]> {
    return this.queue.drain(state, this.now(), documentAccess);
  }
}

/**
 * Clears Expo's singleton response immediately, consumes the corresponding
 * persistent allowlisted handle exactly once, and only then queues navigation.
 * The clear happens before the first await so a new response cannot be erased
 * by completion of an older registry lookup.
 */
export async function consumeNotificationResponseIntoRuntime(
  input: {
    notificationId: string;
    actionIdentifier: string;
    data: unknown;
  },
  dependencies: {
    defaultActionIdentifier: string;
    clearLastResponse(): void;
    consumeHandle(notificationId: string): Promise<NotificationRoutePayload | null>;
  },
  runtime: ExternalRoutingRuntime,
): Promise<NotificationResponseIngressResult> {
  try {
    dependencies.clearLastResponse();
  } catch {
    // Consuming the persistent handle below still prevents a replay even when
    // the current runtime does not expose Expo's optional native clear method.
  }

  const registered = await dependencies.consumeHandle(input.notificationId);
  if (input.actionIdentifier !== dependencies.defaultActionIdentifier) {
    return { accepted: false, reason: 'unsupported-action' };
  }
  if (!registered) return { accepted: false, reason: 'unknown-handle' };

  const received = parseNotificationRoutePayload(input.data);
  if (!received.accepted || !sameNotificationPayload(registered, received.payload)) {
    return { accepted: false, reason: 'payload-mismatch' };
  }
  return runtime.acceptRegisteredNotification(registered);
}
