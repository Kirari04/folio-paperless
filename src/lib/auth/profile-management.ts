import type { ProfileDataCounts } from '../../types/persistence.ts';
import {
  connectionProfileAuthFingerprint,
  type AuthenticationMethodMetadata,
  type ClientIdentityMetadata,
  type ConnectionProfile,
  type ConnectionProfileRepository,
  type ManagedClientIdentityCoordinator,
  ProfilePublicationJournalStore,
  ProfileStoreError,
  PROFILE_PUBLICATION_JOURNAL_SCHEMA_VERSION,
  type ProfileSecrets,
  type ProfileSecretStore,
  createConnectionProfile,
  managedClientIdentityCoordinator,
  normalizeServerBaseUrl,
  validateCustomHeaders,
} from './profile-store.ts';
import {
  acceptApiToken,
  type AuthHttpClient,
  type AuthHttpResponse,
  acquirePaperlessToken,
  validateServerRedirect,
} from './session.ts';
import type {
  ProfileConnectionDetails,
  ProfileRequestCredentials,
} from './fetch-adapter.ts';
import { translateRuntime } from '../../i18n/runtime.ts';
import { profileSecretsAuthorizeSameContext } from './credential-authority.ts';

export type ConnectionProfileAuthDraft =
  | { kind: 'token'; token?: string }
  | {
      kind: 'paperless-credentials';
      username: string;
      password?: string;
      otpCode?: string;
    }
  | {
      kind: 'oidc';
      issuer: string;
      clientId: string;
      redirectUri: string;
      scopes: string[];
      forceLogin?: boolean;
    }
  | {
      kind: 'mutual-tls';
      identity?: ClientIdentityMetadata;
      clientIdentityRef?: string;
      identityAction?: 'reuse' | 'select' | 'import';
    }
  | {
      kind: 'custom-headers';
      headers: Record<string, string>;
      retainedHeaderNames?: string[];
    };

export type ConnectionProfileDraft = {
  profileId?: string;
  displayName: string;
  serverUrl: string;
  auth: ConnectionProfileAuthDraft;
};

export type OidcLoginResult = {
  /** Identity-provider token used only for the immediate Paperless exchange. */
  accessToken: string;
  idToken?: string;
  subject: string;
};

export type PaperlessOidcErrorCode =
  | 'canceled'
  | 'invalid-configuration'
  | 'headless-unavailable'
  | 'provider-not-configured'
  | 'provider-token-unsupported'
  | 'provider-token-rejected'
  | 'additional-auth-required'
  | 'rate-limited'
  | 'unsafe-redirect'
  | 'redirect-not-followed'
  | 'unexpected-response'
  | 'network-failure';

export class PaperlessOidcError extends Error {
  readonly code: PaperlessOidcErrorCode;
  readonly retryable: boolean;

  constructor(code: PaperlessOidcErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'PaperlessOidcError';
    this.code = code;
    this.retryable = retryable;
  }
}

export type PaperlessOidcProviderCapability = {
  providerId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseHeader(response: AuthHttpResponse, name: string): string | undefined {
  const match = Object.entries(response.headers ?? {}).find(
    ([headerName]) => headerName.toLowerCase() === name.toLowerCase(),
  );
  return match?.[1];
}

function requireNoAuthRedirect(requestUrl: string, response: AuthHttpResponse) {
  const redirectTarget = response.responseUrl && response.responseUrl !== requestUrl
    ? response.responseUrl
    : response.status >= 300 && response.status < 400
      ? responseHeader(response, 'location')
      : undefined;
  if (!redirectTarget) return;
  try {
    validateServerRedirect(requestUrl, redirectTarget);
  } catch {
    throw new PaperlessOidcError(
      'unsafe-redirect',
      'Paperless redirected OIDC authentication to an unsafe destination.',
    );
  }
  throw new PaperlessOidcError(
    'redirect-not-followed',
    'Paperless redirected OIDC authentication. Confirm the saved server URL before retrying.',
  );
}

async function requestPaperlessOidc(
  client: AuthHttpClient,
  request: Parameters<AuthHttpClient['request']>[0],
  signal?: AbortSignal,
) {
  let response: AuthHttpResponse;
  try {
    response = await client.request(request);
  } catch (error) {
    if (error instanceof PaperlessOidcError) throw error;
    if (signal?.aborted) {
      throw new PaperlessOidcError('canceled', 'OIDC sign-in was canceled.');
    }
    throw new PaperlessOidcError(
      'network-failure',
      'Could not reach the Paperless OIDC authentication endpoint.',
      true,
    );
  }
  requireNoAuthRedirect(request.url, response);
  return response;
}

function canonicalOidcDiscoveryUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      return null;
    }
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Discovers the exact django-allauth provider ID configured by Paperless.
 * This is capability based: forks/backports work without a version check, and
 * an unsupported server fails before Folio opens the identity-provider UI.
 */
export async function discoverPaperlessOidcProvider(
  input: {
    serverUrl: string;
    issuer: string;
    clientId: string;
    signal?: AbortSignal;
  },
  client: AuthHttpClient,
): Promise<PaperlessOidcProviderCapability> {
  const serverUrl = normalizeServerBaseUrl(input.serverUrl);
  const expectedDiscoveryUrl = canonicalOidcDiscoveryUrl(
    `${input.issuer.trim().replace(/\/+$/, '')}/.well-known/openid-configuration`,
  );
  const clientId = input.clientId.trim();
  if (!expectedDiscoveryUrl || !clientId) {
    throw new PaperlessOidcError(
      'invalid-configuration',
      'Enter a valid HTTPS OIDC issuer and client ID.',
    );
  }
  const requestUrl = `${serverUrl}/api/auth/headless/app/v1/config`;
  const response = await requestPaperlessOidc(
    client,
    {
      url: requestUrl,
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'manual',
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
    input.signal,
  );
  if (response.status === 404 || response.status === 405) {
    throw new PaperlessOidcError(
      'headless-unavailable',
      'This Paperless server does not expose headless app OIDC. Use API-token authentication or upgrade Paperless.',
    );
  }
  if (response.status === 429) {
    throw new PaperlessOidcError(
      'rate-limited',
      'Paperless temporarily limited OIDC requests. Try again later.',
      true,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new PaperlessOidcError(
      'unexpected-response',
      'Paperless returned an unexpected response while checking OIDC support.',
      response.status >= 500,
    );
  }
  if (
    !isRecord(response.body)
    || response.body.status !== 200
    || !isRecord(response.body.data)
  ) {
    throw new PaperlessOidcError(
      'unexpected-response',
      'Paperless returned invalid headless OIDC configuration.',
    );
  }
  const socialAccount = response.body.data.socialaccount;
  const providers = isRecord(socialAccount) && Array.isArray(socialAccount.providers)
    ? socialAccount.providers
    : [];
  const matches = providers.filter((provider) =>
    isRecord(provider)
    && provider.client_id === clientId
    && canonicalOidcDiscoveryUrl(provider.openid_configuration_url) === expectedDiscoveryUrl,
  );
  if (matches.length === 0) {
    throw new PaperlessOidcError(
      'provider-not-configured',
      'Paperless has no headless OIDC provider matching this issuer and client ID. Check the server and app configuration.',
    );
  }
  if (matches.length !== 1) {
    throw new PaperlessOidcError(
      'unexpected-response',
      'Paperless returned an ambiguous headless OIDC provider configuration.',
    );
  }
  const provider = matches[0];
  if (
    !Array.isArray(provider.flows)
    || !provider.flows.includes('provider_token')
  ) {
    throw new PaperlessOidcError(
      'provider-token-unsupported',
      'The matching Paperless OIDC provider does not support app token authentication.',
    );
  }
  if (typeof provider.id !== 'string' || !provider.id.trim()) {
    throw new PaperlessOidcError(
      'unexpected-response',
      'Paperless returned invalid headless OIDC provider configuration.',
    );
  }
  return { providerId: provider.id.trim() };
}

/** Exchanges verified IdP tokens for the Paperless DRF token used by `/api/`. */
export async function exchangePaperlessOidcToken(
  input: {
    serverUrl: string;
    providerId: string;
    clientId: string;
    accessToken: string;
    idToken?: string;
    signal?: AbortSignal;
  },
  client: AuthHttpClient,
): Promise<{ apiToken: string }> {
  const serverUrl = normalizeServerBaseUrl(input.serverUrl);
  const requestUrl = `${serverUrl}/api/auth/headless/app/v1/auth/provider/token`;
  const response = await requestPaperlessOidc(
    client,
    {
      url: requestUrl,
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        provider: input.providerId,
        process: 'login',
        token: {
          client_id: input.clientId,
          access_token: input.accessToken,
          ...(input.idToken ? { id_token: input.idToken } : {}),
        },
      }),
      redirect: 'manual',
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
    input.signal,
  );
  if (response.status === 404 || response.status === 405) {
    throw new PaperlessOidcError(
      'headless-unavailable',
      'This Paperless server does not expose headless app OIDC. Use API-token authentication or upgrade Paperless.',
    );
  }
  if (response.status === 401) {
    throw new PaperlessOidcError(
      'additional-auth-required',
      'Paperless requires an additional account verification or MFA step that Folio cannot complete. Finish setup in Paperless or use an API token.',
    );
  }
  if (response.status === 400 || response.status === 403) {
    throw new PaperlessOidcError(
      'provider-token-rejected',
      'Paperless rejected the OIDC login. Check the configured provider, client ID, and account signup policy.',
      response.status === 400,
    );
  }
  if (response.status === 429) {
    throw new PaperlessOidcError(
      'rate-limited',
      'Paperless temporarily limited OIDC login attempts. Try again later.',
      true,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new PaperlessOidcError(
      'unexpected-response',
      'Paperless returned an unexpected OIDC authentication response.',
      response.status >= 500,
    );
  }
  const meta = isRecord(response.body) && isRecord(response.body.meta)
    ? response.body.meta
    : null;
  if (
    !meta
    || !isRecord(response.body)
    || response.body.status !== 200
    || meta.is_authenticated !== true
    || typeof meta.access_token !== 'string'
  ) {
    throw new PaperlessOidcError(
      'unexpected-response',
      'Paperless completed OIDC login but did not return an API token.',
    );
  }
  try {
    return acceptApiToken(meta.access_token);
  } catch {
    throw new PaperlessOidcError(
      'unexpected-response',
      'Paperless returned an invalid API token after OIDC login.',
    );
  }
}

export type ProfileOwnershipSummary = ProfileDataCounts & {
  profileId: string;
  automaticBytes: number;
  pinnedBytes: number;
  totalBytes: number;
  pinnedDocuments: number;
};

export type PreparedConnectionProfile = {
  draft: Omit<ConnectionProfileDraft, 'auth'> & {
    auth: AuthenticationMethodMetadata;
  };
  credentials: ProfileRequestCredentials;
  secrets: ProfileSecrets;
  connection: ProfileConnectionDetails;
  warnings: ('authorization-overrides-profile-auth')[];
};

export type ProfilePreparationDependencies = {
  authHttpClient: AuthHttpClient;
  testConnection: (
    credentials: ProfileRequestCredentials,
    signal?: AbortSignal,
  ) => Promise<ProfileConnectionDetails>;
  loginOidc?: (
    input: Extract<ConnectionProfileAuthDraft, { kind: 'oidc' }>,
    signal?: AbortSignal,
  ) => Promise<OidcLoginResult>;
  prepareMutualTls?: (
    input: Extract<ConnectionProfileAuthDraft, { kind: 'mutual-tls' }> & {
      profileId?: string;
      serverUrl: string;
    },
    signal?: AbortSignal,
  ) => Promise<{
    identity: ClientIdentityMetadata;
    clientIdentityRef: string;
    connection: ProfileConnectionDetails;
  }>;
};

export function preparedProfileRebindsAuthority(
  current: ConnectionProfile,
  currentSecrets: ProfileSecrets | null,
  prepared: PreparedConnectionProfile,
) {
  const proposedProfile: ConnectionProfile = {
    ...current,
    serverUrl: prepared.draft.serverUrl,
    auth: prepared.draft.auth,
    customHeaderNames: prepared.draft.auth.kind === 'custom-headers'
      ? prepared.draft.auth.headerNames
      : [],
  };
  return connectionProfileAuthFingerprint(current)
      !== connectionProfileAuthFingerprint(proposedProfile)
    || !profileSecretsAuthorizeSameContext(currentSecrets, prepared.secrets);
}

function requiredName(value: string) {
  const name = value.trim();
  if (!name) throw new Error(translateRuntime('authRuntime.connectionName'));
  if (name.length > 100) throw new Error(translateRuntime('authRuntime.connectionNameLength'));
  return name;
}

function existingSecretFor(
  draft: ConnectionProfileDraft,
  existingProfile: ConnectionProfile | null,
  existingSecrets: ProfileSecrets | null,
) {
  if (!draft.profileId || existingProfile?.id !== draft.profileId) return null;
  return existingSecrets;
}

function mergeRetainedHeaders(
  draft: Extract<ConnectionProfileAuthDraft, { kind: 'custom-headers' }>,
  existingSecrets: ProfileSecrets | null,
) {
  const retained = new Set(draft.retainedHeaderNames?.map((name) => name.toLowerCase()) ?? []);
  const headers: Record<string, string> = {};
  for (const name of retained) {
    const value = existingSecrets?.customHeaders?.[name];
    if (value) headers[name] = value;
  }
  for (const [name, value] of Object.entries(draft.headers)) {
    if (value) headers[name] = value;
  }
  return validateCustomHeaders(headers);
}

export async function prepareConnectionProfile(
  draft: ConnectionProfileDraft,
  context: {
    existingProfile?: ConnectionProfile | null;
    existingSecrets?: ProfileSecrets | null;
    signal?: AbortSignal;
  },
  dependencies: ProfilePreparationDependencies,
): Promise<PreparedConnectionProfile> {
  const displayName = requiredName(draft.displayName);
  const serverUrl = normalizeServerBaseUrl(draft.serverUrl);
  const sameServer = context.existingProfile
    ? normalizeServerBaseUrl(context.existingProfile.serverUrl) === serverUrl
    : false;
  const existingSecrets = existingSecretFor(
    draft,
    context.existingProfile ?? null,
    context.existingSecrets ?? null,
  );
  let auth: AuthenticationMethodMetadata;
  let credentials: ProfileRequestCredentials;
  let secrets: ProfileSecrets;
  let warnings: ('authorization-overrides-profile-auth')[] = [];
  let pretestedConnection: ProfileConnectionDetails | null = null;

  switch (draft.auth.kind) {
    case 'token': {
      const apiToken = draft.auth.token?.trim()
        ? acceptApiToken(draft.auth.token).apiToken
        : sameServer ? existingSecrets?.apiToken : undefined;
      if (!apiToken) throw new Error(translateRuntime('authRuntime.apiToken'));
      auth = { kind: 'token' };
      secrets = { apiToken };
      credentials = { serverUrl, token: apiToken };
      break;
    }
    case 'paperless-credentials': {
      const username = draft.auth.username.trim();
      if (!username) throw new Error(translateRuntime('authRuntime.username'));
      let apiToken: string | undefined;
      if (draft.auth.password) {
        apiToken = (
          await acquirePaperlessToken(
            {
              serverUrl,
              username,
              password: draft.auth.password,
              ...(draft.auth.otpCode?.trim()
                ? { otpCode: draft.auth.otpCode.trim() }
                : {}),
              ...(context.signal === undefined ? {} : { signal: context.signal }),
            },
            dependencies.authHttpClient,
          )
        ).apiToken;
      } else if (
        context.existingProfile?.auth.kind === 'paperless-credentials' &&
        context.existingProfile.auth.username === username &&
        sameServer
      ) {
        apiToken = existingSecrets?.apiToken;
      }
      if (!apiToken) throw new Error(translateRuntime('authRuntime.password'));
      auth = { kind: 'paperless-credentials', username };
      secrets = { apiToken };
      credentials = { serverUrl, token: apiToken };
      break;
    }
    case 'oidc': {
      const issuer = draft.auth.issuer.trim().replace(/\/$/, '');
      const clientId = draft.auth.clientId.trim();
      const scopes = [...new Set(draft.auth.scopes.map((scope) => scope.trim()).filter(Boolean))];
      if (!scopes.includes('openid')) scopes.unshift('openid');
      const canReuse =
        !draft.auth.forceLogin &&
        context.existingProfile?.auth.kind === 'oidc' &&
        sameServer &&
        context.existingProfile.auth.issuer === issuer &&
        context.existingProfile.auth.clientId === clientId &&
        context.existingProfile.auth.redirectUri === draft.auth.redirectUri &&
        [...context.existingProfile.auth.scopes].sort().join('\u0000') === [...scopes].sort().join('\u0000') &&
        existingSecrets?.apiToken;
      let apiToken = canReuse ? existingSecrets.apiToken : undefined;
      if (!apiToken) {
        const provider = await discoverPaperlessOidcProvider(
          {
            serverUrl,
            issuer,
            clientId,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          },
          dependencies.authHttpClient,
        );
        const oidc = await dependencies.loginOidc?.(
          { ...draft.auth, issuer, clientId, scopes },
          context.signal,
        );
        if (!oidc) {
          throw new Error(
            translateRuntime('authRuntime.oidcUnavailable'),
          );
        }
        apiToken = (
          await exchangePaperlessOidcToken(
            {
              serverUrl,
              providerId: provider.providerId,
              clientId,
              accessToken: oidc.accessToken,
              ...(oidc.idToken ? { idToken: oidc.idToken } : {}),
              ...(context.signal === undefined ? {} : { signal: context.signal }),
            },
            dependencies.authHttpClient,
          )
        ).apiToken;
      }
      auth = {
        kind: 'oidc',
        issuer,
        clientId,
        redirectUri: draft.auth.redirectUri,
        scopes,
      };
      // The IdP token only proves identity to Paperless. Paperless's returned
      // DRF token is the sole long-lived credential for its REST API.
      secrets = { apiToken };
      credentials = {
        serverUrl,
        token: apiToken,
        authorizationScheme: 'Token',
      };
      break;
    }
    case 'custom-headers': {
      const custom = mergeRetainedHeaders(draft.auth, sameServer ? existingSecrets : null);
      if (Object.keys(custom.headers).length === 0) {
        throw new Error(translateRuntime('authRuntime.customHeader'));
      }
      auth = { kind: 'custom-headers', headerNames: Object.keys(custom.headers) };
      secrets = { customHeaders: custom.headers };
      credentials = { serverUrl, token: '', customHeaders: custom.headers };
      warnings = custom.warnings;
      break;
    }
    case 'mutual-tls': {
      const prepared = await dependencies.prepareMutualTls?.(
        {
          ...draft.auth,
          profileId: draft.profileId,
          serverUrl,
        },
        context.signal,
      );
      if (!prepared) {
        throw new Error(
          translateRuntime('authRuntime.mtlsUnavailable'),
        );
      }
      auth = { kind: 'mutual-tls', identity: prepared.identity };
      secrets = { clientIdentityRef: prepared.clientIdentityRef };
      credentials = { serverUrl, token: '' };
      pretestedConnection = prepared.connection;
      break;
    }
  }

  const connection =
    pretestedConnection ??
    (await dependencies.testConnection(credentials, context.signal));
  return {
    draft: {
      ...(draft.profileId ? { profileId: draft.profileId } : {}),
      displayName,
      serverUrl,
      auth,
    },
    credentials,
    secrets,
    connection,
    warnings,
  };
}

async function persistPreparedConnectionProfileUnlocked(
  prepared: PreparedConnectionProfile,
  dependencies: {
    profiles: ConnectionProfileRepository;
    secrets: ProfileSecretStore;
    createProfileId: () => string;
    now: () => string;
    createOperationId?: () => string;
    publicationJournal?: ProfilePublicationJournalStore;
    identityCoordinator?: ManagedClientIdentityCoordinator;
  },
  options: { makeActive?: boolean } = {},
): Promise<ConnectionProfile> {
  const publicationJournal = dependencies.publicationJournal
    ?? dependencies.secrets.publicationJournal;
  if (await publicationJournal.read()) {
    throw new ProfileStoreError(
      'profile-publication-pending',
      'A previous connection publication must be recovered first.',
    );
  }
  const snapshot = await dependencies.profiles.getSnapshot();
  const current = prepared.draft.profileId
    ? snapshot.profiles.find((profile) => profile.id === prepared.draft.profileId)
    : undefined;
  if (prepared.draft.profileId && !current) throw new Error(translateRuntime('authRuntime.profileMissing'));
  const now = dependencies.now();
  const previousSecrets = current ? await dependencies.secrets.read(current.id) : null;
  const authorityRebound = !!current
    && preparedProfileRebindsAuthority(current, previousSecrets, prepared);
  const id = current && !authorityRebound ? current.id : dependencies.createProfileId();
  const intendedActive = !!options.makeActive;
  const makeActive = intendedActive && !authorityRebound;
  const base = current && !authorityRebound
    ? current
    : createConnectionProfile({
        id,
        displayName: prepared.draft.displayName,
        serverUrl: prepared.draft.serverUrl,
        auth: prepared.draft.auth,
        customHeaderNames:
          prepared.draft.auth.kind === 'custom-headers'
            ? prepared.draft.auth.headerNames
            : [],
        now,
      });
  const profile: ConnectionProfile = {
    ...base,
    displayName: prepared.draft.displayName,
    serverUrl: prepared.draft.serverUrl,
    auth: prepared.draft.auth,
    customHeaderNames:
      prepared.draft.auth.kind === 'custom-headers'
        ? prepared.draft.auth.headerNames
        : [],
    server: {
      ...(prepared.connection.appTitle ? { appTitle: prepared.connection.appTitle } : {}),
      version: prepared.connection.serverVersion,
    },
    lastSuccessfulConnectionAt: now,
    status: {
      code: 'available',
      checkedAt: now,
      summary: prepared.connection.username
        ? translateRuntime('profiles.connectedAs', { username: prepared.connection.username })
        : translateRuntime('profiles.connected'),
    },
    updatedAt: now,
  };

  if (
    (!current || authorityRebound)
    && (
      snapshot.profiles.some((savedProfile) => savedProfile.id === id)
      || await dependencies.secrets.read(id)
    )
  ) {
    throw new ProfileStoreError(
      'duplicate-profile-id',
      'The generated profile ID already belongs to saved credentials.',
    );
  }
  const nextSecrets = {
    ...prepared.secrets,
    connectionFingerprint: connectionProfileAuthFingerprint(profile),
  };
  if (current && !authorityRebound) {
    // For an unchanged authority namespace, write the same authority values
    // before metadata. The fingerprint binding rejects any interrupted
    // authority-metadata mismatch.
    try {
      await dependencies.secrets.write(id, nextSecrets);
      await dependencies.profiles.update(profile);
      if (makeActive) await dependencies.profiles.setActiveProfile(id);
    } catch (error) {
      await dependencies.profiles.update(current).catch(() => undefined);
      if (previousSecrets) await dependencies.secrets.write(id, previousSecrets);
      else await dependencies.secrets.delete(id);
      throw error;
    }
  } else {
    const publishFreshNamespace = async () => {
      const operationId = dependencies.createOperationId?.()
        ?? `profile-publication-${globalThis.crypto?.randomUUID?.()
          ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
      const pending = await publicationJournal.begin({
        schemaVersion: PROFILE_PUBLICATION_JOURNAL_SCHEMA_VERSION,
        operationId,
        replacementProfileId: id,
        oldProfileId: current?.id ?? null,
        intendedActive,
        createdAt: now,
        connectionFingerprint: nextSecrets.connectionFingerprint,
        clientIdentityRef: profile.auth.kind === 'mutual-tls'
          ? prepared.secrets.clientIdentityRef ?? null
          : null,
      });
      let profileAdded = false;
      let fullyPublished = false;
      try {
        // The journal is durable before this namespace becomes discoverable.
        await dependencies.profiles.add(profile, {
          makeActive: false,
          activateWhenFirst: false,
        });
        profileAdded = true;
        await dependencies.secrets.write(id, nextSecrets);
        fullyPublished = true;
        if (!current) {
          if (pending.intendedActive) await dependencies.profiles.setActiveProfile(id);
          await publicationJournal.clear(pending.operationId);
        }
      } catch (error) {
        // Best-effort in-process compensation; the durable journal remains the
        // authority if any compensation or journal clear fails. Startup then
        // repeats the rollback idempotently.
        if (!fullyPublished) {
          let compensationFailed = false;
          const currentAfterFailure = await dependencies.profiles.getSnapshot().catch(() => {
            compensationFailed = true;
            return null;
          });
          if (
            profileAdded
            || currentAfterFailure?.profiles.some((candidate) => candidate.id === id)
          ) {
            await dependencies.profiles.remove(id).catch(() => {
              compensationFailed = true;
            });
          }
          await dependencies.secrets.delete(id).catch(() => {
            compensationFailed = true;
          });
          if (snapshot.activeProfileId) {
            await dependencies.profiles.setActiveProfile(snapshot.activeProfileId).catch(() => {
              compensationFailed = true;
            });
          }
          if (!compensationFailed) {
            await publicationJournal.clear(pending.operationId).catch(() => undefined);
          }
        }
        throw error;
      }
    };
    await publishFreshNamespace();
  }
  return profile;
}

export function persistPreparedConnectionProfile(
  prepared: PreparedConnectionProfile,
  dependencies: {
    profiles: ConnectionProfileRepository;
    secrets: ProfileSecretStore;
    createProfileId: () => string;
    now: () => string;
    createOperationId?: () => string;
    publicationJournal?: ProfilePublicationJournalStore;
    identityCoordinator?: ManagedClientIdentityCoordinator;
  },
  options: { makeActive?: boolean } = {},
): Promise<ConnectionProfile> {
  return (dependencies.identityCoordinator ?? managedClientIdentityCoordinator).runExclusive(
    () => persistPreparedConnectionProfileUnlocked(prepared, dependencies, options),
  );
}
