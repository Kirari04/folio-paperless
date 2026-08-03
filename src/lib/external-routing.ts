export const FOLIO_URL_SCHEME = 'folio-paperless' as const;
export const MAX_EXTERNAL_URL_LENGTH = 2_048;
export const MAX_DEFERRED_EXTERNAL_ROUTES = 16;
export const DEFAULT_EXTERNAL_ROUTE_TTL_MS = 10 * 60 * 1_000;

export type ExternalRouteSource =
  | 'deep-link'
  | 'notification'
  | 'shortcut'
  | 'os-search'
  | 'widget';

export type ExternalProfileScope =
  | { kind: 'active-profile' }
  | { kind: 'profile'; profileId: string };

export type ExternalRoute =
  | { kind: 'home'; source: ExternalRouteSource }
  | { kind: 'library'; source: ExternalRouteSource; scope: ExternalProfileScope }
  | { kind: 'inbox'; source: ExternalRouteSource; scope: ExternalProfileScope }
  | { kind: 'tasks'; source: 'notification'; scope: Extract<ExternalProfileScope, { kind: 'profile' }> }
  | { kind: 'scanner'; source: ExternalRouteSource }
  | { kind: 'settings'; source: ExternalRouteSource }
  | {
      kind: 'search';
      source: ExternalRouteSource;
      scope: ExternalProfileScope;
      query?: string;
    }
  | {
      kind: 'document';
      source: ExternalRouteSource;
      profileId: string;
      documentId: string;
    };

export type ExternalRouteRejectionCode =
  | 'not-a-string'
  | 'url-too-long'
  | 'invalid-url'
  | 'unsupported-scheme'
  | 'unsafe-url-components'
  | 'route-not-allowed'
  | 'unexpected-query-parameter'
  | 'duplicate-query-parameter'
  | 'invalid-profile-id'
  | 'profile-required'
  | 'invalid-document-id'
  | 'invalid-search-query';

export type ExternalRouteParseResult =
  | { accepted: true; route: ExternalRoute }
  | {
      accepted: false;
      code: ExternalRouteRejectionCode;
      fallback: { kind: 'home'; source: ExternalRouteSource };
    };

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** OIDC callbacks are consumed by Expo AuthSession and are never treated as
 * ordinary navigation. Keeping this reservation beside the route parser
 * prevents a successful sign-in callback from being mistaken for Home. */
export function isReservedAuthCallbackUrl(input: unknown) {
  if (typeof input !== 'string' || !input || input.length > MAX_EXTERNAL_URL_LENGTH) return false;
  try {
    const url = new URL(input);
    return url.protocol === `${FOLIO_URL_SCHEME}:`
      && url.hostname.toLocaleLowerCase() === 'oauth'
      && url.pathname === '/callback'
      && !url.username
      && !url.password
      && !url.port
      && !url.hash;
  } catch {
    return false;
  }
}

function rejected(
  code: ExternalRouteRejectionCode,
  source: ExternalRouteSource,
): ExternalRouteParseResult {
  return { accepted: false, code, fallback: { kind: 'home', source } };
}

function safeDecodePathSegment(segment: string): string | null {
  let value: string;
  try {
    value = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (!value || value === '.' || value === '..' || /[/\\\u0000-\u001f\u007f]/.test(value)) {
    return null;
  }
  return value;
}

function routeSegments(url: URL): string[] | null {
  const rawSegments = [url.hostname, ...url.pathname.split('/')].filter(Boolean);
  const decoded = rawSegments.map(safeDecodePathSegment);
  return decoded.every((segment): segment is string => segment !== null) ? decoded : null;
}

function readAllowedQuery(
  url: URL,
  allowed: readonly string[],
): { values: Record<string, string>; error?: ExternalRouteRejectionCode } {
  const values: Record<string, string> = {};
  const allowedSet = new Set(allowed);
  for (const key of new Set(url.searchParams.keys())) {
    if (!allowedSet.has(key)) return { values, error: 'unexpected-query-parameter' };
    const all = url.searchParams.getAll(key);
    if (all.length !== 1) return { values, error: 'duplicate-query-parameter' };
    values[key] = all[0];
  }
  return { values };
}

function parseProfileScope(
  profileId: string | undefined,
): ExternalProfileScope | ExternalRouteRejectionCode {
  if (profileId === undefined || profileId === '') return { kind: 'active-profile' };
  if (!PROFILE_ID_PATTERN.test(profileId)) return 'invalid-profile-id';
  return { kind: 'profile', profileId };
}

export function parseExternalUrl(
  input: unknown,
  source: ExternalRouteSource = 'deep-link',
): ExternalRouteParseResult {
  if (typeof input !== 'string') return rejected('not-a-string', source);
  const raw = input.trim();
  if (!raw || raw.length > MAX_EXTERNAL_URL_LENGTH) {
    return rejected(raw.length > MAX_EXTERNAL_URL_LENGTH ? 'url-too-long' : 'invalid-url', source);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return rejected('invalid-url', source);
  }
  if (url.protocol !== `${FOLIO_URL_SCHEME}:`) return rejected('unsupported-scheme', source);
  if (url.username || url.password || url.port || url.hash) {
    return rejected('unsafe-url-components', source);
  }

  const segments = routeSegments(url);
  if (!segments) return rejected('route-not-allowed', source);
  const routeName = segments[0]?.toLowerCase() ?? 'home';

  if ((routeName === 'home' || routeName === '') && segments.length <= 1) {
    const query = readAllowedQuery(url, []);
    return query.error
      ? rejected(query.error, source)
      : { accepted: true, route: { kind: 'home', source } };
  }

  if (routeName === 'settings' && segments.length === 1) {
    const query = readAllowedQuery(url, []);
    return query.error
      ? rejected(query.error, source)
      : { accepted: true, route: { kind: 'settings', source } };
  }

  if ((routeName === 'scan' || routeName === 'scanner') && segments.length === 1) {
    const query = readAllowedQuery(url, []);
    return query.error
      ? rejected(query.error, source)
      : { accepted: true, route: { kind: 'scanner', source } };
  }

  if (
    (routeName === 'library' || routeName === 'documents' || routeName === 'inbox') &&
    segments.length === 1
  ) {
    const query = readAllowedQuery(url, ['profile']);
    if (query.error) return rejected(query.error, source);
    const scope = parseProfileScope(query.values.profile);
    if (typeof scope === 'string') return rejected(scope, source);
    return {
      accepted: true,
      route: { kind: routeName === 'inbox' ? 'inbox' : 'library', source, scope },
    };
  }

  if (routeName === 'search' && segments.length === 1) {
    const query = readAllowedQuery(url, ['profile', 'q']);
    if (query.error) return rejected(query.error, source);
    const scope = parseProfileScope(query.values.profile);
    if (typeof scope === 'string') return rejected(scope, source);
    const searchQuery = query.values.q?.trim();
    if (
      searchQuery !== undefined &&
      (!searchQuery || searchQuery.length > 160 || /[\u0000-\u001f\u007f]/.test(searchQuery))
    ) {
      return rejected('invalid-search-query', source);
    }
    return {
      accepted: true,
      route: {
        kind: 'search',
        source,
        scope,
        ...(searchQuery === undefined ? {} : { query: searchQuery }),
      },
    };
  }

  if (routeName === 'document' && segments.length === 2) {
    const query = readAllowedQuery(url, ['profile']);
    if (query.error) return rejected(query.error, source);
    if (!query.values.profile) return rejected('profile-required', source);
    if (!PROFILE_ID_PATTERN.test(query.values.profile)) return rejected('invalid-profile-id', source);
    if (!DOCUMENT_ID_PATTERN.test(segments[1])) return rejected('invalid-document-id', source);
    return {
      accepted: true,
      route: {
        kind: 'document',
        source,
        profileId: query.values.profile,
        documentId: segments[1],
      },
    };
  }

  return rejected('route-not-allowed', source);
}

function scopeProfileId(route: ExternalRoute): string | null {
  if (route.kind === 'document') return route.profileId;
  if ('scope' in route && route.scope.kind === 'profile') return route.scope.profileId;
  return null;
}

export function serializeExternalRoute(route: ExternalRoute): string {
  const url = new URL(`${FOLIO_URL_SCHEME}://home`);
  switch (route.kind) {
    case 'home':
      url.hostname = 'home';
      break;
    case 'library':
      url.hostname = 'library';
      break;
    case 'inbox':
      url.hostname = 'inbox';
      break;
    case 'tasks':
      // Task Center is an internal notification target. parseExternalUrl does
      // not accept it as a public custom-scheme route.
      url.hostname = 'tasks';
      break;
    case 'scanner':
      url.hostname = 'scan';
      break;
    case 'settings':
      url.hostname = 'settings';
      break;
    case 'search':
      url.hostname = 'search';
      if (route.query) url.searchParams.set('q', route.query);
      break;
    case 'document':
      url.hostname = 'document';
      url.pathname = `/${encodeURIComponent(route.documentId)}`;
      break;
  }
  const profileId = scopeProfileId(route);
  if (profileId) url.searchParams.set('profile', profileId);
  return url.toString();
}

export type ExternalNavigationState = {
  bootstrap: 'pending' | 'ready' | 'failed';
  profileSelection: 'pending' | 'ready';
  biometric: 'locked' | 'unlocked';
  authenticated: boolean;
  activeProfileId: string | null;
  knownProfileIds: readonly string[];
};

export type DocumentRouteAccess = 'allowed' | 'missing' | 'deleted' | 'unauthorized';

export type InternalNavigationTarget =
  | { pathname: '/' }
  | { pathname: '/documents'; params?: { q?: string } }
  | { pathname: '/inbox' }
  | { pathname: '/tasks' }
  | { pathname: '/scan' }
  | { pathname: '/settings' }
  | { pathname: '/document/[id]'; params: { id: string } };

export type ExternalNavigationDecision =
  | {
      kind: 'defer';
      reason: 'bootstrap' | 'profile-selection' | 'biometric-lock' | 'profile-switch-required';
      requiredProfileId?: string;
    }
  | { kind: 'navigate'; target: InternalNavigationTarget }
  | {
      kind: 'fallback';
      target: { pathname: '/' };
      reason:
        | 'bootstrap-failed'
        | 'authentication-required'
        | 'profile-unavailable'
        | 'profile-mismatch'
        | 'document-missing'
        | 'document-deleted'
        | 'document-unauthorized';
    };

function routeNeedsAuthentication(route: ExternalRoute): boolean {
  return route.kind !== 'home' && route.kind !== 'settings';
}

function routeTarget(route: ExternalRoute): InternalNavigationTarget {
  switch (route.kind) {
    case 'home':
      return { pathname: '/' };
    case 'library':
      return { pathname: '/documents' };
    case 'inbox':
      return { pathname: '/inbox' };
    case 'tasks':
      return { pathname: '/tasks' };
    case 'scanner':
      return { pathname: '/scan' };
    case 'settings':
      return { pathname: '/settings' };
    case 'search':
      return {
        pathname: '/documents',
        ...(route.query ? { params: { q: route.query } } : {}),
      };
    case 'document':
      return { pathname: '/document/[id]', params: { id: route.documentId } };
  }
}

export async function resolveExternalNavigation(
  route: ExternalRoute,
  state: ExternalNavigationState,
  documentAccess?: (profileId: string, documentId: string) => Promise<DocumentRouteAccess>,
): Promise<ExternalNavigationDecision> {
  if (state.bootstrap === 'pending') return { kind: 'defer', reason: 'bootstrap' };
  if (state.bootstrap === 'failed') {
    return { kind: 'fallback', target: { pathname: '/' }, reason: 'bootstrap-failed' };
  }
  if (state.profileSelection === 'pending') {
    return { kind: 'defer', reason: 'profile-selection' };
  }
  if (state.biometric === 'locked') return { kind: 'defer', reason: 'biometric-lock' };
  if (routeNeedsAuthentication(route) && !state.authenticated) {
    return { kind: 'fallback', target: { pathname: '/' }, reason: 'authentication-required' };
  }

  const intendedProfileId = scopeProfileId(route);
  if (intendedProfileId) {
    if (!state.knownProfileIds.includes(intendedProfileId)) {
      return { kind: 'fallback', target: { pathname: '/' }, reason: 'profile-unavailable' };
    }
    if (state.activeProfileId !== intendedProfileId) {
      return {
        kind: 'defer',
        reason: 'profile-switch-required',
        requiredProfileId: intendedProfileId,
      };
    }
  } else if (routeNeedsAuthentication(route) && state.activeProfileId === null) {
    return { kind: 'fallback', target: { pathname: '/' }, reason: 'profile-unavailable' };
  }

  if (route.kind === 'document') {
    if (!documentAccess) {
      return { kind: 'fallback', target: { pathname: '/' }, reason: 'document-missing' };
    }
    const access = await documentAccess(route.profileId, route.documentId);
    if (access !== 'allowed') {
      const reason =
        access === 'deleted'
          ? 'document-deleted'
          : access === 'unauthorized'
            ? 'document-unauthorized'
            : 'document-missing';
      return { kind: 'fallback', target: { pathname: '/' }, reason };
    }
  }
  return { kind: 'navigate', target: routeTarget(route) };
}

type DeferredRoute = {
  route: ExternalRoute;
  receivedAt: number;
  expiresAt: number;
};

export interface DeferredExternalNavigationContract {
  enqueue(route: ExternalRoute, receivedAt: number): void;
  pending(): ExternalRoute[];
  clear(): void;
  clearProfile(profileId: string): void;
  drain(
    state: ExternalNavigationState,
    now: number,
    documentAccess?: (profileId: string, documentId: string) => Promise<DocumentRouteAccess>,
  ): Promise<ExternalNavigationDecision[]>;
}

export class DeferredExternalNavigationQueue implements DeferredExternalNavigationContract {
  private queue: DeferredRoute[] = [];
  private readonly capacity: number;
  private readonly ttlMs: number;

  constructor(
    capacity = MAX_DEFERRED_EXTERNAL_ROUTES,
    ttlMs = DEFAULT_EXTERNAL_ROUTE_TTL_MS,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 64) {
      throw new Error('Deferred external route capacity must be between 1 and 64.');
    }
    if (!Number.isFinite(ttlMs) || ttlMs < 1_000 || ttlMs > 60 * 60 * 1_000) {
      throw new Error('Deferred external route TTL must be between one second and one hour.');
    }
    this.capacity = capacity;
    this.ttlMs = ttlMs;
  }

  enqueue(route: ExternalRoute, receivedAt: number): void {
    if (!Number.isFinite(receivedAt)) throw new Error('External route receipt time is invalid.');
    const fingerprint = serializeExternalRoute(route);
    this.queue = this.queue.filter((entry) => serializeExternalRoute(entry.route) !== fingerprint);
    this.queue.push({ route, receivedAt, expiresAt: receivedAt + this.ttlMs });
    if (this.queue.length > this.capacity) this.queue.splice(0, this.queue.length - this.capacity);
  }

  pending(): ExternalRoute[] {
    return this.queue.map((entry) => entry.route);
  }

  clear(): void {
    this.queue = [];
  }

  clearProfile(profileId: string): void {
    this.queue = this.queue.filter((entry) => scopeProfileId(entry.route) !== profileId);
  }

  async drain(
    state: ExternalNavigationState,
    now: number,
    documentAccess?: (profileId: string, documentId: string) => Promise<DocumentRouteAccess>,
  ): Promise<ExternalNavigationDecision[]> {
    this.queue = this.queue.filter((entry) => entry.expiresAt > now);
    const decisions: ExternalNavigationDecision[] = [];
    const stillDeferred: DeferredRoute[] = [];
    for (const entry of this.queue) {
      const decision = await resolveExternalNavigation(entry.route, state, documentAccess);
      decisions.push(decision);
      if (decision.kind === 'defer') stillDeferred.push(entry);
    }
    this.queue = stillDeferred;
    return decisions;
  }
}
