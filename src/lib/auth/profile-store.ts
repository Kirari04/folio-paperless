export const CONNECTION_PROFILE_SCHEMA_VERSION = 1 as const;
export const PROFILE_SECRET_SCHEMA_VERSION = 1 as const;

export const CONNECTION_PROFILE_INDEX_KEY = 'folio.paperless.connection-profiles';
export const LEGACY_CREDENTIALS_KEY = 'folio.paperless.credentials';
export const PROFILE_SECRET_KEY_PREFIX = 'folio.paperless.profile-secret.';
export const PROFILE_REMOVAL_JOURNAL_KEY = 'folio.paperless.profile-removal-journal';
export const PROFILE_REMOVAL_JOURNAL_SCHEMA_VERSION = 2 as const;
export const PROFILE_REMOVAL_MANIFEST_SCHEMA_VERSION = 1 as const;
export const PROFILE_PUBLICATION_JOURNAL_KEY = 'folio.paperless.profile-publication-journal';
export const PROFILE_PUBLICATION_JOURNAL_SCHEMA_VERSION = 1 as const;

export const ALLOWED_CUSTOM_HEADERS = [
  'authorization',
  'remote-user',
  'x-api-key',
  'x-auth-token',
  'x-forwarded-user',
  'x-remote-user',
] as const;

const ALLOWED_CUSTOM_HEADER_SET = new Set<string>(ALLOWED_CUSTOM_HEADERS);

export interface AsyncStringStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

export type ProfileStatusCode =
  | 'unknown'
  | 'available'
  | 'offline'
  | 'authentication-error'
  | 'tls-error'
  | 'unsupported-api'
  | 'insufficient-permissions';

export type ClientIdentityMetadata = {
  identityId: string;
  subject: string;
  issuer: string;
  notBefore?: string;
  expiresAt: string;
  fingerprintSha256?: string;
  hasPrivateKey: boolean;
  source: 'os-credential-store' | 'managed-native-identity';
};

export type AuthenticationMethodMetadata =
  | { kind: 'token'; usernameHint?: string }
  | { kind: 'paperless-credentials'; username: string }
  | {
      kind: 'oidc';
      issuer: string;
      clientId: string;
      redirectUri: string;
      scopes: string[];
    }
  | { kind: 'mutual-tls'; identity: ClientIdentityMetadata }
  | { kind: 'custom-headers'; headerNames: string[] };

export type ConnectionProfile = {
  id: string;
  displayName: string;
  serverUrl: string;
  auth: AuthenticationMethodMetadata;
  customHeaderNames: string[];
  server?: {
    appTitle?: string;
    version?: string;
  };
  lastSuccessfulConnectionAt?: string;
  status: {
    code: ProfileStatusCode;
    checkedAt?: string;
    summary?: string;
  };
  migration?: {
    source: 'legacy-single-credentials';
    migratedAt: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type ConnectionProfileIndexV1 = {
  schemaVersion: typeof CONNECTION_PROFILE_SCHEMA_VERSION;
  revision: number;
  activeProfileId: string | null;
  profiles: ConnectionProfile[];
};

export type StoredOidcSecrets = {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: string;
};

export type ProfileSecrets = {
  apiToken?: string;
  oidc?: StoredOidcSecrets;
  customHeaders?: Record<string, string>;
  clientIdentityRef?: string;
  /** Non-secret binding that prevents credentials being paired with edited connection metadata. */
  connectionFingerprint?: string;
};

type StoredProfileSecretsV1 = ProfileSecrets & {
  schemaVersion: typeof PROFILE_SECRET_SCHEMA_VERSION;
  profileId: string;
};

export class ProfileStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProfileStoreError';
    this.code = code;
  }
}

/**
 * Serializes native identity inventory/deletion with the publication of an
 * mTLS profile's metadata and secret reference. The lock is intentionally
 * process-wide: all repositories in the running app address the same native
 * managed-identity inventory.
 */
export class ManagedClientIdentityCoordinator {
  private queue: Promise<void> = Promise.resolve();

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export const managedClientIdentityCoordinator = new ManagedClientIdentityCoordinator();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProfileStoreError('invalid-profile', `${field} must be a non-empty string.`);
  }
  return value;
}

function requireIsoDate(value: unknown, field: string): string {
  const date = requireString(value, field);
  if (!Number.isFinite(Date.parse(date))) {
    throw new ProfileStoreError('invalid-profile', `${field} must be an ISO date.`);
  }
  return date;
}

function requireApiToken(value: unknown): string {
  const token = requireString(value, 'apiToken').trim();
  if (/\s/.test(token)) {
    throw new ProfileStoreError('invalid-profile-secret', 'The saved API token is invalid.');
  }
  return token;
}

function normalizeCustomHeaderName(value: unknown): string {
  const headerName = requireString(value, 'headerName').trim().toLowerCase();
  if (!ALLOWED_CUSTOM_HEADER_SET.has(headerName)) {
    throw new ProfileStoreError(
      'custom-header-not-allowed',
      'A connection profile contains a custom header that is not allowed.',
    );
  }
  return headerName;
}

export function assertProfileId(profileId: string): string {
  const normalized = profileId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new ProfileStoreError(
      'invalid-profile-id',
      'Profile IDs may contain only letters, numbers, dots, underscores, and hyphens.',
    );
  }
  return normalized;
}

function requireExactProfileId(value: unknown, field: string): string {
  const raw = requireString(value, field);
  const validated = assertProfileId(raw);
  if (validated !== raw) {
    throw new ProfileStoreError(
      'invalid-profile-id',
      `${field} must be an exact canonical profile ID.`,
    );
  }
  return validated;
}

function requireBoundedString(value: unknown, field: string, maximumLength: number): string {
  const result = requireString(value, field);
  if (result.length > maximumLength) {
    throw new ProfileStoreError('invalid-profile-publication-journal', `${field} is too long.`);
  }
  return result;
}

export function normalizeServerBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ProfileStoreError('invalid-server-url', 'Enter a valid Paperless server URL.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ProfileStoreError(
      'unsupported-server-scheme',
      'Paperless server URLs must use HTTPS or HTTP.',
    );
  }
  if (url.username || url.password) {
    throw new ProfileStoreError(
      'credentials-in-server-url',
      'Do not include credentials in the Paperless server URL.',
    );
  }
  if (url.search || url.hash) {
    throw new ProfileStoreError(
      'invalid-server-url',
      'Paperless server URLs cannot include a query or fragment.',
    );
  }

  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path === '/' ? '' : path}`;
}

export function isInsecureServerUrl(serverUrl: string): boolean {
  return new URL(normalizeServerBaseUrl(serverUrl)).protocol === 'http:';
}

export function connectionProfileAuthFingerprint(profile: ConnectionProfile) {
  return JSON.stringify({
    serverUrl: normalizeServerBaseUrl(profile.serverUrl),
    auth: profile.auth,
    customHeaderNames: [...profile.customHeaderNames].map((name) => name.toLowerCase()).sort(),
  });
}

function validateClientIdentityMetadata(value: unknown): ClientIdentityMetadata {
  if (!isRecord(value)) {
    throw new ProfileStoreError('invalid-profile', 'Client identity metadata is invalid.');
  }
  const source = value.source;
  if (source !== 'os-credential-store' && source !== 'managed-native-identity') {
    throw new ProfileStoreError('invalid-profile', 'Client identity source is invalid.');
  }
  if (typeof value.hasPrivateKey !== 'boolean') {
    throw new ProfileStoreError('invalid-profile', 'Client identity key metadata is invalid.');
  }
  return {
    identityId: requireString(value.identityId, 'identityId'),
    subject: requireString(value.subject, 'subject'),
    issuer: requireString(value.issuer, 'issuer'),
    ...(value.notBefore === undefined
      ? {}
      : { notBefore: requireIsoDate(value.notBefore, 'notBefore') }),
    expiresAt: requireIsoDate(value.expiresAt, 'expiresAt'),
    ...(value.fingerprintSha256 === undefined
      ? {}
      : { fingerprintSha256: requireString(value.fingerprintSha256, 'fingerprintSha256') }),
    hasPrivateKey: value.hasPrivateKey,
    source,
  };
}

function validateAuthenticationMetadata(value: unknown): AuthenticationMethodMetadata {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new ProfileStoreError('invalid-profile', 'Authentication metadata is invalid.');
  }

  switch (value.kind) {
    case 'token':
      return {
        kind: 'token',
        ...(value.usernameHint === undefined
          ? {}
          : { usernameHint: requireString(value.usernameHint, 'usernameHint') }),
      };
    case 'paperless-credentials':
      return {
        kind: 'paperless-credentials',
        username: requireString(value.username, 'username'),
      };
    case 'oidc': {
      const scopes = value.scopes;
      if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== 'string')) {
        throw new ProfileStoreError('invalid-profile', 'OIDC scopes are invalid.');
      }
      let issuer: URL;
      let redirectUri: URL;
      try {
        issuer = new URL(requireString(value.issuer, 'issuer'));
        redirectUri = new URL(requireString(value.redirectUri, 'redirectUri'));
      } catch {
        throw new ProfileStoreError('invalid-profile', 'OIDC URL metadata is invalid.');
      }
      if (
        issuer.protocol !== 'https:' ||
        issuer.username ||
        issuer.password ||
        issuer.search ||
        issuer.hash ||
        redirectUri.protocol === 'http:' ||
        ['javascript:', 'data:', 'file:', 'about:', 'blob:'].includes(redirectUri.protocol) ||
        redirectUri.username ||
        redirectUri.password ||
        redirectUri.search ||
        redirectUri.hash
      ) {
        throw new ProfileStoreError('invalid-profile', 'OIDC URL metadata is invalid.');
      }
      const normalizedScopes = [
        ...new Set(scopes.map((scope) => scope.trim()).filter(Boolean)),
      ];
      if (!normalizedScopes.includes('openid')) normalizedScopes.unshift('openid');
      return {
        kind: 'oidc',
        issuer: issuer.toString().replace(/\/$/, ''),
        clientId: requireString(value.clientId, 'clientId'),
        redirectUri: redirectUri.toString(),
        scopes: normalizedScopes,
      };
    }
    case 'mutual-tls':
      return { kind: 'mutual-tls', identity: validateClientIdentityMetadata(value.identity) };
    case 'custom-headers': {
      if (!Array.isArray(value.headerNames)) {
        throw new ProfileStoreError('invalid-profile', 'Custom header names are invalid.');
      }
      return {
        kind: 'custom-headers',
        headerNames: [...new Set(value.headerNames.map(normalizeCustomHeaderName))],
      };
    }
    default:
      throw new ProfileStoreError(
        'unsupported-auth-method',
        'This connection profile uses an unsupported authentication method.',
      );
  }
}

const PROFILE_STATUS_CODES = new Set<ProfileStatusCode>([
  'unknown',
  'available',
  'offline',
  'authentication-error',
  'tls-error',
  'unsupported-api',
  'insufficient-permissions',
]);

function validateConnectionProfile(value: unknown): ConnectionProfile {
  if (!isRecord(value)) {
    throw new ProfileStoreError('invalid-profile', 'Connection profile metadata is invalid.');
  }
  if (!isRecord(value.status) || !PROFILE_STATUS_CODES.has(value.status.code as ProfileStatusCode)) {
    throw new ProfileStoreError('invalid-profile', 'Connection profile status is invalid.');
  }
  if (!Array.isArray(value.customHeaderNames)) {
    throw new ProfileStoreError('invalid-profile', 'Custom header metadata is invalid.');
  }

  const auth = validateAuthenticationMetadata(value.auth);
  const customHeaderNames = [...new Set(value.customHeaderNames.map(normalizeCustomHeaderName))];
  if (auth.kind === 'custom-headers') {
    const authenticationNames = [...auth.headerNames].sort();
    const profileNames = [...customHeaderNames].sort();
    if (JSON.stringify(authenticationNames) !== JSON.stringify(profileNames)) {
      throw new ProfileStoreError(
        'custom-header-metadata-mismatch',
        'Custom header profile metadata is inconsistent.',
      );
    }
  }

  const profile: ConnectionProfile = {
    id: assertProfileId(requireString(value.id, 'id')),
    displayName: requireString(value.displayName, 'displayName').trim(),
    serverUrl: normalizeServerBaseUrl(requireString(value.serverUrl, 'serverUrl')),
    auth,
    customHeaderNames,
    status: {
      code: value.status.code as ProfileStatusCode,
      ...(value.status.checkedAt === undefined
        ? {}
        : { checkedAt: requireIsoDate(value.status.checkedAt, 'checkedAt') }),
      ...(value.status.summary === undefined
        ? {}
        : { summary: requireString(value.status.summary, 'summary') }),
    },
    createdAt: requireIsoDate(value.createdAt, 'createdAt'),
    updatedAt: requireIsoDate(value.updatedAt, 'updatedAt'),
  };

  if (isRecord(value.server)) {
    profile.server = {
      ...(value.server.appTitle === undefined
        ? {}
        : { appTitle: requireString(value.server.appTitle, 'appTitle') }),
      ...(value.server.version === undefined
        ? {}
        : { version: requireString(value.server.version, 'version') }),
    };
  }
  if (value.lastSuccessfulConnectionAt !== undefined) {
    profile.lastSuccessfulConnectionAt = requireIsoDate(
      value.lastSuccessfulConnectionAt,
      'lastSuccessfulConnectionAt',
    );
  }
  if (isRecord(value.migration) && value.migration.source === 'legacy-single-credentials') {
    profile.migration = {
      source: 'legacy-single-credentials',
      migratedAt: requireIsoDate(value.migration.migratedAt, 'migratedAt'),
    };
  }
  return profile;
}

export function createConnectionProfile(input: {
  id: string;
  displayName: string;
  serverUrl: string;
  auth: AuthenticationMethodMetadata;
  customHeaderNames?: string[];
  now: string;
}): ConnectionProfile {
  return validateConnectionProfile({
    id: input.id,
    displayName: input.displayName,
    serverUrl: input.serverUrl,
    auth: input.auth,
    customHeaderNames: input.customHeaderNames ?? [],
    status: { code: 'unknown' },
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function createEmptyProfileIndex(): ConnectionProfileIndexV1 {
  return {
    schemaVersion: CONNECTION_PROFILE_SCHEMA_VERSION,
    revision: 0,
    activeProfileId: null,
    profiles: [],
  };
}

export function parseConnectionProfileIndex(raw: string | null): ConnectionProfileIndexV1 {
  if (raw === null) return createEmptyProfileIndex();

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProfileStoreError('invalid-profile-index', 'Connection profile data is corrupted.');
  }
  if (!isRecord(value)) {
    throw new ProfileStoreError('invalid-profile-index', 'Connection profile data is invalid.');
  }
  if (value.schemaVersion !== CONNECTION_PROFILE_SCHEMA_VERSION) {
    throw new ProfileStoreError(
      'unsupported-profile-schema',
      'Connection profile data was created by an unsupported schema version.',
    );
  }
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    throw new ProfileStoreError('invalid-profile-index', 'Connection profile revision is invalid.');
  }
  if (!Array.isArray(value.profiles)) {
    throw new ProfileStoreError('invalid-profile-index', 'Connection profile list is invalid.');
  }

  const profiles = value.profiles.map(validateConnectionProfile);
  const ids = new Set(profiles.map((profile) => profile.id));
  if (ids.size !== profiles.length) {
    throw new ProfileStoreError('duplicate-profile-id', 'Connection profile IDs must be unique.');
  }
  const activeProfileId = value.activeProfileId;
  if (activeProfileId !== null && (typeof activeProfileId !== 'string' || !ids.has(activeProfileId))) {
    throw new ProfileStoreError(
      'invalid-active-profile',
      'The active profile must refer to a saved connection profile.',
    );
  }

  return {
    schemaVersion: CONNECTION_PROFILE_SCHEMA_VERSION,
    revision: value.revision as number,
    activeProfileId,
    profiles,
  };
}

export class ConnectionProfileRepository {
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly store: AsyncStringStore;
  private readonly key: string;

  constructor(store: AsyncStringStore, key = CONNECTION_PROFILE_INDEX_KEY) {
    this.store = store;
    this.key = key;
  }

  private async readDirect(): Promise<ConnectionProfileIndexV1> {
    return parseConnectionProfileIndex(await this.store.getItem(this.key));
  }

  async getSnapshot(): Promise<ConnectionProfileIndexV1> {
    await this.mutationQueue;
    return cloneValue(await this.readDirect());
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private mutate(
    update: (current: ConnectionProfileIndexV1) => ConnectionProfileIndexV1,
  ): Promise<ConnectionProfileIndexV1> {
    return this.enqueue(async () => {
      const current = await this.readDirect();
      const candidate = update(cloneValue(current));
      const next = parseConnectionProfileIndex(
        JSON.stringify({
          ...candidate,
          schemaVersion: CONNECTION_PROFILE_SCHEMA_VERSION,
          revision: current.revision + 1,
        }),
      );
      await this.store.setItem(this.key, JSON.stringify(next));
      return cloneValue(next);
    });
  }

  add(
    profile: ConnectionProfile,
    options: { makeActive?: boolean; activateWhenFirst?: boolean } = {},
  ) {
    const validated = validateConnectionProfile(profile);
    return this.mutate((current) => {
      if (current.profiles.some((item) => item.id === validated.id)) {
        throw new ProfileStoreError('duplicate-profile-id', 'A profile with this ID already exists.');
      }
      current.profiles.push(validated);
      if (
        options.makeActive
        || (current.activeProfileId === null && options.activateWhenFirst !== false)
      ) {
        current.activeProfileId = validated.id;
      }
      return current;
    });
  }

  update(profile: ConnectionProfile) {
    const validated = validateConnectionProfile(profile);
    return this.mutate((current) => {
      const index = current.profiles.findIndex((item) => item.id === validated.id);
      if (index < 0) {
        throw new ProfileStoreError('profile-not-found', 'Connection profile was not found.');
      }
      current.profiles[index] = validated;
      return current;
    });
  }

  rename(profileId: string, displayName: string, now: string) {
    const id = assertProfileId(profileId);
    const name = displayName.trim();
    if (!name) {
      throw new ProfileStoreError('invalid-profile-name', 'Profile name cannot be empty.');
    }
    return this.mutate((current) => {
      const profile = current.profiles.find((item) => item.id === id);
      if (!profile) {
        throw new ProfileStoreError('profile-not-found', 'Connection profile was not found.');
      }
      profile.displayName = name;
      profile.updatedAt = requireIsoDate(now, 'updatedAt');
      return current;
    });
  }

  setActiveProfile(profileId: string) {
    const id = assertProfileId(profileId);
    return this.mutate((current) => {
      if (!current.profiles.some((profile) => profile.id === id)) {
        throw new ProfileStoreError('profile-not-found', 'Connection profile was not found.');
      }
      current.activeProfileId = id;
      return current;
    });
  }

  remove(profileId: string, options: { nextActiveProfileId?: string | null } = {}) {
    const id = assertProfileId(profileId);
    const requestedNextActive = options.nextActiveProfileId === undefined
      ? undefined
      : options.nextActiveProfileId === null
        ? null
        : assertProfileId(options.nextActiveProfileId);
    return this.mutate((current) => {
      const index = current.profiles.findIndex((profile) => profile.id === id);
      if (index < 0) {
        throw new ProfileStoreError('profile-not-found', 'Connection profile was not found.');
      }
      current.profiles.splice(index, 1);
      if (current.activeProfileId === id) {
        if (
          requestedNextActive !== undefined
          && requestedNextActive !== null
          && !current.profiles.some((profile) => profile.id === requestedNextActive)
        ) {
          throw new ProfileStoreError(
            'profile-not-found',
            'The intended next connection profile was not found.',
          );
        }
        current.activeProfileId = requestedNextActive === undefined
          ? current.profiles[0]?.id ?? null
          : requestedNextActive;
      }
      return current;
    });
  }

  /**
   * Compensates a multi-store operation only when no newer profile-index
   * mutation has been published. The restored snapshot receives a fresh
   * revision so observers never see the index move backwards.
   */
  restoreSnapshot(
    snapshot: ConnectionProfileIndexV1,
    expectedCurrentRevision: number,
  ): Promise<ConnectionProfileIndexV1> {
    const validated = parseConnectionProfileIndex(JSON.stringify(snapshot));
    return this.enqueue(async () => {
      const current = await this.readDirect();
      if (current.revision !== expectedCurrentRevision) {
        throw new ProfileStoreError(
          'concurrent-profile-change',
          'Connection profiles changed while a previous operation was being rolled back.',
        );
      }
      const restored = parseConnectionProfileIndex(JSON.stringify({
        ...validated,
        revision: current.revision + 1,
      }));
      await this.store.setItem(this.key, JSON.stringify(restored));
      return cloneValue(restored);
    });
  }
}

export type CustomHeaderWarning = 'authorization-overrides-profile-auth';

export function validateCustomHeaders(input: Record<string, string>): {
  headers: Record<string, string>;
  warnings: CustomHeaderWarning[];
} {
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  const warnings: CustomHeaderWarning[] = [];
  const entries = Object.entries(input);
  if (entries.length > ALLOWED_CUSTOM_HEADERS.length) {
    throw new ProfileStoreError('too-many-custom-headers', 'Too many custom headers were provided.');
  }

  for (const [name, value] of entries) {
    const normalizedName = name.trim().toLowerCase();
    if (!ALLOWED_CUSTOM_HEADER_SET.has(normalizedName)) {
      throw new ProfileStoreError(
        'custom-header-not-allowed',
        'A custom header is not allowed.',
      );
    }
    if (Object.hasOwn(headers, normalizedName)) {
      throw new ProfileStoreError(
        'duplicate-custom-header',
        `The custom header ${name.trim()} was supplied more than once.`,
      );
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
      throw new ProfileStoreError(
        'invalid-custom-header-value',
        `The custom header ${name.trim()} has an invalid value.`,
      );
    }
    if (/\r|\n/.test(value)) {
      throw new ProfileStoreError(
        'invalid-custom-header-value',
        `The custom header ${name.trim()} contains an invalid line break.`,
      );
    }
    headers[normalizedName] = value;
    if (normalizedName === 'authorization') {
      warnings.push('authorization-overrides-profile-auth');
    }
  }

  return { headers, warnings };
}

export function redactHeaders(input: Record<string, string>): Record<string, '[REDACTED]'> {
  return Object.fromEntries(Object.keys(input).map((name) => [name, '[REDACTED]'])) as Record<
    string,
    '[REDACTED]'
  >;
}

export type ProfilePublicationJournal = {
  schemaVersion: typeof PROFILE_PUBLICATION_JOURNAL_SCHEMA_VERSION;
  operationId: string;
  replacementProfileId: string;
  oldProfileId: string | null;
  intendedActive: boolean;
  createdAt: string;
  connectionFingerprint: string;
  clientIdentityRef: string | null;
};

function validateProfilePublicationJournal(value: unknown): ProfilePublicationJournal {
  const allowedKeys = new Set([
    'schemaVersion',
    'operationId',
    'replacementProfileId',
    'oldProfileId',
    'intendedActive',
    'createdAt',
    'connectionFingerprint',
    'clientIdentityRef',
  ]);
  if (
    !isRecord(value)
    || value.schemaVersion !== PROFILE_PUBLICATION_JOURNAL_SCHEMA_VERSION
    || Object.keys(value).some((key) => !allowedKeys.has(key))
    || typeof value.intendedActive !== 'boolean'
  ) {
    throw new ProfileStoreError(
      'invalid-profile-publication-journal',
      'The pending connection publication record is invalid.',
    );
  }
  const replacementProfileId = requireExactProfileId(
    value.replacementProfileId,
    'replacementProfileId',
  );
  const oldProfileId = value.oldProfileId === null
    ? null
    : requireExactProfileId(value.oldProfileId, 'oldProfileId');
  if (oldProfileId === replacementProfileId) {
    throw new ProfileStoreError(
      'invalid-profile-publication-journal',
      'A replacement connection must use a fresh profile ID.',
    );
  }
  const clientIdentityRef = value.clientIdentityRef === null
    ? null
    : requireBoundedString(value.clientIdentityRef, 'clientIdentityRef', 2_048);
  return {
    schemaVersion: PROFILE_PUBLICATION_JOURNAL_SCHEMA_VERSION,
    operationId: requireExactProfileId(value.operationId, 'operationId'),
    replacementProfileId,
    oldProfileId,
    intendedActive: value.intendedActive,
    createdAt: requireIsoDate(value.createdAt, 'createdAt'),
    connectionFingerprint: requireBoundedString(
      value.connectionFingerprint,
      'connectionFingerprint',
      16_384,
    ),
    clientIdentityRef,
  };
}

/** One protected, bounded publication record; it never contains credentials. */
export class ProfilePublicationJournalStore {
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly store: AsyncStringStore;
  private readonly key: string;

  constructor(store: AsyncStringStore, key = PROFILE_PUBLICATION_JOURNAL_KEY) {
    this.store = store;
    this.key = key;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readDirect(): Promise<ProfilePublicationJournal | null> {
    const raw = await this.store.getItem(this.key);
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ProfileStoreError(
        'invalid-profile-publication-journal',
        'The pending connection publication record is corrupted.',
      );
    }
    return validateProfilePublicationJournal(value);
  }

  read() {
    return this.enqueue(() => this.readDirect());
  }

  begin(journal: ProfilePublicationJournal) {
    return this.enqueue(async () => {
      // Parse an existing value before refusing it so corruption always fails
      // closed and cannot be silently replaced by a new operation.
      const current = await this.readDirect();
      if (current) {
        throw new ProfileStoreError(
          'profile-publication-pending',
          'A previous connection publication must be recovered first.',
        );
      }
      const validated = validateProfilePublicationJournal(journal);
      await this.store.setItem(this.key, JSON.stringify(validated));
      return cloneValue(validated);
    });
  }

  clear(operationId: string) {
    const id = requireExactProfileId(operationId, 'operationId');
    return this.enqueue(async () => {
      const current = await this.readDirect();
      if (!current) return;
      if (current.operationId !== id) {
        throw new ProfileStoreError(
          'profile-publication-changed',
          'The pending connection publication record changed unexpectedly.',
        );
      }
      await this.store.deleteItem(this.key);
    });
  }
}

function profileSecretKey(profileId: string): string {
  return `${PROFILE_SECRET_KEY_PREFIX}${assertProfileId(profileId)}`;
}

function validateStoredSecrets(value: unknown, profileId: string): StoredProfileSecretsV1 {
  if (!isRecord(value)) {
    throw new ProfileStoreError('invalid-profile-secret', 'Profile secret data is corrupted.');
  }
  if (value.schemaVersion !== PROFILE_SECRET_SCHEMA_VERSION || value.profileId !== profileId) {
    throw new ProfileStoreError(
      'profile-secret-isolation-error',
      'Profile secret data does not belong to this connection profile.',
    );
  }

  const allowedKeys = new Set([
    'schemaVersion',
    'profileId',
    'apiToken',
    'oidc',
    'customHeaders',
    'clientIdentityRef',
    'connectionFingerprint',
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new ProfileStoreError(
      'invalid-profile-secret',
      'Profile secret data contains unsupported fields.',
    );
  }

  const result: StoredProfileSecretsV1 = {
    schemaVersion: PROFILE_SECRET_SCHEMA_VERSION,
    profileId,
  };
  if (value.apiToken !== undefined) result.apiToken = requireApiToken(value.apiToken);
  if (value.clientIdentityRef !== undefined) {
    result.clientIdentityRef = requireString(value.clientIdentityRef, 'clientIdentityRef');
  }
  if (value.connectionFingerprint !== undefined) {
    const fingerprint = requireString(value.connectionFingerprint, 'connectionFingerprint');
    if (fingerprint.length > 16_384) {
      throw new ProfileStoreError('invalid-profile-secret', 'Connection binding is invalid.');
    }
    result.connectionFingerprint = fingerprint;
  }
  if (value.customHeaders !== undefined) {
    if (!isRecord(value.customHeaders)) {
      throw new ProfileStoreError('invalid-profile-secret', 'Custom header secrets are invalid.');
    }
    const rawHeaders = Object.fromEntries(
      Object.entries(value.customHeaders).map(([name, headerValue]) => [
        name,
        requireString(headerValue, 'customHeaderValue'),
      ]),
    );
    result.customHeaders = validateCustomHeaders(rawHeaders).headers;
  }
  if (value.oidc !== undefined) {
    if (!isRecord(value.oidc)) {
      throw new ProfileStoreError('invalid-profile-secret', 'OIDC token data is invalid.');
    }
    result.oidc = {
      accessToken: requireString(value.oidc.accessToken, 'accessToken'),
      ...(value.oidc.refreshToken === undefined
        ? {}
        : { refreshToken: requireString(value.oidc.refreshToken, 'refreshToken') }),
      ...(value.oidc.idToken === undefined
        ? {}
        : { idToken: requireString(value.oidc.idToken, 'idToken') }),
      ...(value.oidc.expiresAt === undefined
        ? {}
        : { expiresAt: requireIsoDate(value.oidc.expiresAt, 'expiresAt') }),
    };
  }
  return result;
}

export class ProfileSecretStore {
  private readonly secureStore: AsyncStringStore;
  readonly publicationJournal: ProfilePublicationJournalStore;

  constructor(secureStore: AsyncStringStore) {
    this.secureStore = secureStore;
    this.publicationJournal = new ProfilePublicationJournalStore(secureStore);
  }

  async read(profileId: string): Promise<ProfileSecrets | null> {
    const id = assertProfileId(profileId);
    const raw = await this.secureStore.getItem(profileSecretKey(id));
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ProfileStoreError('invalid-profile-secret', 'Profile secret data is corrupted.');
    }
    const stored = validateStoredSecrets(value, id);
    const { schemaVersion: _schemaVersion, profileId: _profileId, ...secrets } = stored;
    return cloneValue(secrets);
  }

  async write(profileId: string, secrets: ProfileSecrets): Promise<void> {
    const id = assertProfileId(profileId);
    const stored = validateStoredSecrets(
      {
        schemaVersion: PROFILE_SECRET_SCHEMA_VERSION,
        profileId: id,
        ...secrets,
      },
      id,
    );
    await this.secureStore.setItem(profileSecretKey(id), JSON.stringify(stored));
  }

  async delete(profileId: string): Promise<void> {
    await this.secureStore.deleteItem(profileSecretKey(assertProfileId(profileId)));
  }

  async requestHeaders(profileId: string): Promise<{
    headers: Record<string, string>;
    warnings: CustomHeaderWarning[];
  }> {
    const secrets = await this.read(profileId);
    if (!secrets) return { headers: {}, warnings: [] };

    const headers: Record<string, string> = {};
    if (secrets.oidc?.accessToken) headers.authorization = `Bearer ${secrets.oidc.accessToken}`;
    else if (secrets.apiToken) headers.authorization = `Token ${secrets.apiToken}`;
    const custom = validateCustomHeaders(secrets.customHeaders ?? {});
    Object.assign(headers, custom.headers);
    return { headers, warnings: custom.warnings };
  }
}

type LegacyCredentials = { serverUrl: string; token: string };

function parseLegacyCredentials(raw: string): LegacyCredentials {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProfileStoreError(
      'invalid-legacy-credentials',
      'Saved legacy credentials are corrupted.',
    );
  }
  if (!isRecord(value)) {
    throw new ProfileStoreError('invalid-legacy-credentials', 'Saved legacy credentials are invalid.');
  }
  return {
    serverUrl: normalizeServerBaseUrl(requireString(value.serverUrl, 'serverUrl')),
    token: requireApiToken(value.token),
  };
}

export async function migrateLegacyCredentials(options: {
  legacyStore: AsyncStringStore;
  profiles: ConnectionProfileRepository;
  secrets: ProfileSecretStore;
  createProfileId: () => string;
  now: () => string;
  defaultDisplayName?: string;
}): Promise<{ profile: ConnectionProfile; created: boolean } | null> {
  const raw = await options.legacyStore.getItem(LEGACY_CREDENTIALS_KEY);
  if (raw === null) return null;
  const legacy = parseLegacyCredentials(raw);
  const snapshot = await options.profiles.getSnapshot();
  const existing = snapshot.profiles.find(
    (profile) => profile.migration?.source === 'legacy-single-credentials',
  );

  if (existing) {
    const existingSecrets = await options.secrets.read(existing.id);
    if (!existingSecrets) {
      await options.secrets.write(existing.id, {
        apiToken: legacy.token,
        connectionFingerprint: connectionProfileAuthFingerprint(existing),
      });
    } else if (!existingSecrets.connectionFingerprint) {
      await options.secrets.write(existing.id, {
        ...existingSecrets,
        connectionFingerprint: connectionProfileAuthFingerprint(existing),
      });
    }
    await options.legacyStore.deleteItem(LEGACY_CREDENTIALS_KEY);
    return { profile: existing, created: false };
  }

  const timestamp = options.now();
  const profile: ConnectionProfile = {
    ...createConnectionProfile({
      id: options.createProfileId(),
      displayName: options.defaultDisplayName ?? 'Default connection',
      serverUrl: legacy.serverUrl,
      auth: { kind: 'token' },
      now: timestamp,
    }),
    migration: {
      source: 'legacy-single-credentials',
      migratedAt: timestamp,
    },
  };

  if ((await options.secrets.read(profile.id)) !== null) {
    throw new ProfileStoreError(
      'duplicate-profile-id',
      'The generated profile ID already belongs to a saved secret record.',
    );
  }
  const intendedActive = snapshot.activeProfileId === null;
  const operationId = assertProfileId(
    `profile-publication-${globalThis.crypto?.randomUUID?.()
      ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
  );
  const publication = await options.secrets.publicationJournal.begin({
    schemaVersion: PROFILE_PUBLICATION_JOURNAL_SCHEMA_VERSION,
    operationId,
    replacementProfileId: profile.id,
    oldProfileId: null,
    intendedActive,
    createdAt: timestamp,
    connectionFingerprint: connectionProfileAuthFingerprint(profile),
    clientIdentityRef: null,
  });
  let fullyPublished = false;
  try {
    await options.profiles.add(profile, {
      makeActive: false,
      activateWhenFirst: false,
    });
    await options.secrets.write(profile.id, {
      apiToken: legacy.token,
      connectionFingerprint: connectionProfileAuthFingerprint(profile),
    });
    fullyPublished = true;
    if (publication.intendedActive) await options.profiles.setActiveProfile(profile.id);
    await options.secrets.publicationJournal.clear(publication.operationId);
  } catch (error) {
    if (!fullyPublished) {
      // The legacy record is deliberately still present. Restore the exact
      // pre-migration index when possible; otherwise the publication journal
      // makes the partial namespace repairable on restart.
      const current = await options.profiles.getSnapshot().catch(() => null);
      if (current?.profiles.some((candidate) => candidate.id === profile.id)) {
        await options.profiles.restoreSnapshot(snapshot, current.revision).catch(() => undefined);
      }
      await options.secrets.delete(profile.id).catch(() => undefined);
      const restored = await options.profiles.getSnapshot().catch(() => null);
      if (restored && !restored.profiles.some((candidate) => candidate.id === profile.id)) {
        await options.secrets.publicationJournal.clear(publication.operationId).catch(() => undefined);
      }
    }
    throw error;
  }
  await options.legacyStore.deleteItem(LEGACY_CREDENTIALS_KEY);
  return { profile, created: true };
}

export type ConnectionDataRemovalPolicy =
  | 'retain-cache-and-jobs'
  | 'delete-cache-and-jobs';

export type ProfileRemovalJournal = {
  schemaVersion: typeof PROFILE_REMOVAL_JOURNAL_SCHEMA_VERSION;
  operationId: string;
  profileId: string;
  policy: ConnectionDataRemovalPolicy;
  createdAt: string;
  phase: 'planned' | 'cleanup-complete';
  /** Opaque reference only. The referenced manifest is never serialized into
   * the protected key-value record. */
  manifestRef: string | null;
  /** Hydrated, non-secret recovery data; never part of the protected record. */
  data: unknown;
};

type StoredProfileRemovalJournal = Omit<ProfileRemovalJournal, 'data'>;

export type ProfileRemovalManifestRecord = {
  schemaVersion: typeof PROFILE_REMOVAL_MANIFEST_SCHEMA_VERSION;
  reference: string;
  operationId: string;
  profileId: string;
  createdAt: string;
  data: unknown;
};

export interface ProfileRemovalManifestStore {
  write(manifest: ProfileRemovalManifestRecord): Promise<void>;
  read(reference: string): Promise<unknown | null>;
  delete(reference: string): Promise<void>;
}

function validateRemovalJournalIdentity(value: unknown): {
  operationId: string;
  profileId: string;
  policy: ConnectionDataRemovalPolicy;
  createdAt: string;
} {
  if (
    !isRecord(value)
    || (value.policy !== 'retain-cache-and-jobs' && value.policy !== 'delete-cache-and-jobs')
  ) {
    throw new ProfileStoreError(
      'invalid-profile-removal-journal',
      'The pending connection removal record is invalid.',
    );
  }
  return {
    operationId: assertProfileId(requireString(value.operationId, 'operationId')),
    profileId: assertProfileId(requireString(value.profileId, 'profileId')),
    policy: value.policy,
    createdAt: requireIsoDate(value.createdAt, 'createdAt'),
  };
}

function validateStoredProfileRemovalJournal(value: unknown): StoredProfileRemovalJournal {
  const identity = validateRemovalJournalIdentity(value);
  if (!isRecord(value) || value.schemaVersion !== PROFILE_REMOVAL_JOURNAL_SCHEMA_VERSION) {
    throw new ProfileStoreError(
      'invalid-profile-removal-journal',
      'The pending connection removal record is invalid.',
    );
  }
  if (value.phase !== 'planned' && value.phase !== 'cleanup-complete') {
    throw new ProfileStoreError(
      'invalid-profile-removal-journal',
      'The pending connection removal phase is invalid.',
    );
  }
  const manifestRef = value.manifestRef === null
    ? null
    : assertProfileId(requireString(value.manifestRef, 'manifestRef'));
  if (
    (identity.policy === 'delete-cache-and-jobs' && manifestRef === null)
    || (identity.policy === 'retain-cache-and-jobs' && manifestRef !== null)
    || Object.hasOwn(value, 'data')
  ) {
    throw new ProfileStoreError(
      'invalid-profile-removal-journal',
      'The pending connection removal reference is invalid.',
    );
  }
  return {
    schemaVersion: PROFILE_REMOVAL_JOURNAL_SCHEMA_VERSION,
    ...identity,
    phase: value.phase,
    manifestRef,
  };
}

function validateProfileRemovalManifest(
  value: unknown,
  pending: StoredProfileRemovalJournal,
): ProfileRemovalManifestRecord {
  if (
    !isRecord(value)
    || value.schemaVersion !== PROFILE_REMOVAL_MANIFEST_SCHEMA_VERSION
    || !Object.hasOwn(value, 'data')
  ) {
    throw new ProfileStoreError(
      'invalid-profile-removal-manifest',
      'The pending connection removal manifest is invalid.',
    );
  }
  const manifest: ProfileRemovalManifestRecord = {
    schemaVersion: PROFILE_REMOVAL_MANIFEST_SCHEMA_VERSION,
    reference: assertProfileId(requireString(value.reference, 'reference')),
    operationId: assertProfileId(requireString(value.operationId, 'operationId')),
    profileId: assertProfileId(requireString(value.profileId, 'profileId')),
    createdAt: requireIsoDate(value.createdAt, 'createdAt'),
    data: cloneValue(value.data),
  };
  if (
    manifest.reference !== pending.manifestRef
    || manifest.operationId !== pending.operationId
    || manifest.profileId !== pending.profileId
    || manifest.createdAt !== pending.createdAt
  ) {
    throw new ProfileStoreError(
      'profile-removal-manifest-mismatch',
      'The pending connection removal manifest belongs to a different operation.',
    );
  }
  return manifest;
}

export class ProfileRemovalJournalStore {
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly store: AsyncStringStore;
  private readonly key: string;
  private readonly manifests?: ProfileRemovalManifestStore;

  constructor(
    store: AsyncStringStore,
    manifests?: ProfileRemovalManifestStore,
    key = PROFILE_REMOVAL_JOURNAL_KEY,
  ) {
    this.store = store;
    this.manifests = manifests;
    this.key = key;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private requireManifestStore() {
    if (!this.manifests) {
      throw new ProfileStoreError(
        'profile-removal-manifest-store-required',
        'Pending connection data removal requires its durable manifest store.',
      );
    }
    return this.manifests;
  }

  private async readStored(): Promise<StoredProfileRemovalJournal | null> {
    const raw = await this.store.getItem(this.key);
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ProfileStoreError(
        'invalid-profile-removal-journal',
        'The pending connection removal record is corrupted.',
      );
    }
    if (isRecord(parsed) && parsed.schemaVersion === 1) {
      const identity = validateRemovalJournalIdentity(parsed);
      const manifestRef = identity.policy === 'delete-cache-and-jobs'
        ? identity.operationId
        : null;
      const migrated: StoredProfileRemovalJournal = {
        schemaVersion: PROFILE_REMOVAL_JOURNAL_SCHEMA_VERSION,
        ...identity,
        phase: 'planned',
        manifestRef,
      };
      if (manifestRef) {
        const manifests = this.requireManifestStore();
        const existing = await manifests.read(manifestRef);
        if (existing === null) {
          await manifests.write({
            schemaVersion: PROFILE_REMOVAL_MANIFEST_SCHEMA_VERSION,
            reference: manifestRef,
            operationId: identity.operationId,
            profileId: identity.profileId,
            createdAt: identity.createdAt,
            data: cloneValue(parsed.data),
          });
        } else {
          validateProfileRemovalManifest(existing, migrated);
        }
      }
      await this.store.setItem(this.key, JSON.stringify(migrated));
      return migrated;
    }
    return validateStoredProfileRemovalJournal(parsed);
  }

  private async hydrate(pending: StoredProfileRemovalJournal): Promise<ProfileRemovalJournal> {
    if (pending.phase === 'cleanup-complete' || pending.manifestRef === null) {
      return { ...pending, data: null };
    }
    let rawManifest: unknown | null;
    try {
      rawManifest = await this.requireManifestStore().read(pending.manifestRef);
    } catch (error) {
      if (error instanceof ProfileStoreError) throw error;
      throw new ProfileStoreError(
        'invalid-profile-removal-manifest',
        'The pending connection removal manifest could not be read.',
      );
    }
    if (rawManifest === null) {
      throw new ProfileStoreError(
        'profile-removal-manifest-missing',
        'The pending connection removal manifest is missing.',
      );
    }
    const manifest = validateProfileRemovalManifest(rawManifest, pending);
    return { ...pending, data: manifest.data };
  }

  read() {
    return this.enqueue(async () => {
      const pending = await this.readStored();
      return pending ? this.hydrate(pending) : null;
    });
  }

  begin(journal: Omit<ProfileRemovalJournal, 'phase' | 'manifestRef'>) {
    return this.enqueue(async () => {
      if (await this.store.getItem(this.key)) {
        throw new ProfileStoreError(
          'profile-removal-pending',
          'A previous connection removal must be recovered first.',
        );
      }
      const identity = validateRemovalJournalIdentity(journal);
      const manifestRef = identity.policy === 'delete-cache-and-jobs'
        ? identity.operationId
        : null;
      if (manifestRef) {
        await this.requireManifestStore().write({
          schemaVersion: PROFILE_REMOVAL_MANIFEST_SCHEMA_VERSION,
          reference: manifestRef,
          operationId: identity.operationId,
          profileId: identity.profileId,
          createdAt: identity.createdAt,
          data: cloneValue(journal.data),
        });
      }
      const stored: StoredProfileRemovalJournal = {
        schemaVersion: PROFILE_REMOVAL_JOURNAL_SCHEMA_VERSION,
        ...identity,
        phase: 'planned',
        manifestRef,
      };
      try {
        await this.store.setItem(this.key, JSON.stringify(stored));
      } catch (error) {
        if (manifestRef) {
          try {
            await this.requireManifestStore().delete(manifestRef);
          } catch {
            throw new ProfileStoreError(
              'profile-removal-manifest-cleanup-failed',
              'Connection removal did not begin, and its unused manifest could not be removed.',
            );
          }
        }
        throw error;
      }
      return { ...stored, data: cloneValue(journal.data) };
    });
  }

  markCleanupComplete(operationId: string) {
    const id = assertProfileId(operationId);
    return this.enqueue(async () => {
      const current = await this.readStored();
      if (!current || current.operationId !== id) {
        throw new ProfileStoreError(
          'profile-removal-changed',
          'The pending connection removal record changed unexpectedly.',
        );
      }
      if (current.phase === 'cleanup-complete') return;
      await this.store.setItem(this.key, JSON.stringify({
        ...current,
        phase: 'cleanup-complete',
      } satisfies StoredProfileRemovalJournal));
    });
  }

  clear(operationId: string) {
    const id = assertProfileId(operationId);
    return this.enqueue(async () => {
      const current = await this.readStored();
      if (!current) return;
      if (current.operationId !== id) {
        throw new ProfileStoreError(
          'profile-removal-changed',
          'The pending connection removal record changed unexpectedly.',
        );
      }
      if (current.phase !== 'cleanup-complete') {
        throw new ProfileStoreError(
          'profile-removal-cleanup-incomplete',
          'The pending connection removal cleanup is not complete.',
        );
      }
      if (current.manifestRef) {
        await this.requireManifestStore().delete(current.manifestRef);
      }
      await this.store.deleteItem(this.key);
    });
  }
}

export type ProfileDataRemovalTransaction = {
  plan(profileId: string, operationId: string): Promise<unknown> | unknown;
  stage(data: unknown): Promise<void>;
  /** Must atomically delete profile-scoped data and persist a commit marker. */
  commit(profileId: string, operationId: string, createdAt: string, data: unknown): Promise<void>;
  isCommitted(operationId: string): Promise<boolean>;
  rollback(data: unknown): Promise<void>;
  finalize(operationId: string, data: unknown): Promise<void>;
};

type ProfileRemovalDependencies = {
  profiles: ConnectionProfileRepository;
  secrets: ProfileSecretStore;
  journal: ProfileRemovalJournalStore;
  dataRemoval?: ProfileDataRemovalTransaction;
  onProfileRevoked?: (snapshot: ConnectionProfileIndexV1) => void;
  /** Used by authority rebinds so removing the active old namespace never
   * persists an arbitrary profile as active. */
  nextActiveProfileId?: string | null;
};

export class ProfileRemovalCleanupPendingError extends ProfileStoreError {
  readonly operationId: string;
  readonly profileId: string;
  readonly snapshot: ConnectionProfileIndexV1;
  override readonly cause: unknown;

  constructor(
    pending: ProfileRemovalJournal,
    snapshot: ConnectionProfileIndexV1,
    cause: unknown,
  ) {
    super(
      'profile-removal-cleanup-pending',
      'The connection is removed and blocked, but private cleanup is pending and will be retried.',
    );
    this.operationId = pending.operationId;
    this.profileId = pending.profileId;
    this.snapshot = cloneValue(snapshot);
    this.cause = cause;
  }
}

function snapshotWithoutProfile(
  snapshot: ConnectionProfileIndexV1,
  profileId: string,
  nextActiveProfileId?: string | null,
): ConnectionProfileIndexV1 {
  const profiles = snapshot.profiles.filter((profile) => profile.id !== profileId);
  return {
    ...cloneValue(snapshot),
    activeProfileId: snapshot.activeProfileId === profileId
      ? nextActiveProfileId === undefined
        ? profiles[0]?.id ?? null
        : nextActiveProfileId
      : snapshot.activeProfileId,
    profiles,
  };
}

async function finishProfileRemoval(
  pending: ProfileRemovalJournal,
  options: ProfileRemovalDependencies,
  irreversible: boolean,
) {
  const current = await options.profiles.getSnapshot();
  let snapshot = current;
  try {
    if (current.profiles.some((profile) => profile.id === pending.profileId)) {
      snapshot = await options.profiles.remove(pending.profileId, {
        ...(options.nextActiveProfileId === undefined
          ? {}
          : { nextActiveProfileId: options.nextActiveProfileId }),
      });
    }
  } catch (error) {
    if (!irreversible) throw error;
    snapshot = snapshotWithoutProfile(
      current,
      pending.profileId,
      options.nextActiveProfileId,
    );
    options.onProfileRevoked?.(snapshot);
    throw new ProfileRemovalCleanupPendingError(pending, snapshot, error);
  }
  options.onProfileRevoked?.(snapshot);
  // Metadata is revoked before its credential. A crash can therefore leave an
  // unreachable secret temporarily, but never a connectable profile without
  // credentials. Startup recovery retries this deletion.
  try {
    await options.secrets.delete(pending.profileId);
    if (pending.policy === 'delete-cache-and-jobs') {
      if (!options.dataRemoval) {
        throw new ProfileStoreError(
          'connection-cleanup-required',
          'Recovering deleted connection data requires its scoped cleanup adapter.',
        );
      }
      await options.dataRemoval.finalize(pending.operationId, pending.data);
    }
    await options.journal.markCleanupComplete(pending.operationId);
    await options.journal.clear(pending.operationId);
  } catch (error) {
    throw new ProfileRemovalCleanupPendingError(pending, snapshot, error);
  }
  return snapshot;
}

/** Recovers the one durable removal operation before profiles become usable. */
export async function recoverPendingProfileRemoval(options: ProfileRemovalDependencies): Promise<
  | { kind: 'none'; snapshot: ConnectionProfileIndexV1 }
  | { kind: 'rolled-back' | 'completed'; profileId: string; snapshot: ConnectionProfileIndexV1 }
> {
  const pending = await options.journal.read();
  if (!pending) return { kind: 'none', snapshot: await options.profiles.getSnapshot() };
  if (pending.phase === 'cleanup-complete') {
    await options.journal.clear(pending.operationId);
    return {
      kind: 'completed',
      profileId: pending.profileId,
      snapshot: await options.profiles.getSnapshot(),
    };
  }
  const snapshot = await options.profiles.getSnapshot();
  const profileExists = snapshot.profiles.some((profile) => profile.id === pending.profileId);

  if (pending.policy === 'delete-cache-and-jobs') {
    if (!options.dataRemoval) {
      throw new ProfileStoreError(
        'connection-cleanup-required',
        'Recovering deleted connection data requires its scoped cleanup adapter.',
      );
    }
    const dataCommitted = await options.dataRemoval.isCommitted(pending.operationId);
    if (profileExists && !dataCommitted) {
      await options.dataRemoval.rollback(pending.data);
      await options.journal.markCleanupComplete(pending.operationId);
      await options.journal.clear(pending.operationId);
      return {
        kind: 'rolled-back',
        profileId: pending.profileId,
        snapshot: await options.profiles.getSnapshot(),
      };
    }
  }

  return {
    kind: 'completed',
    profileId: pending.profileId,
    snapshot: await finishProfileRemoval(pending, options, !profileExists || pending.policy === 'delete-cache-and-jobs'),
  };
}

export async function removeProfileWithSecrets(options: ProfileRemovalDependencies & {
  profileId: string;
  policy: ConnectionDataRemovalPolicy;
  createOperationId?: () => string;
  now?: () => string;
}): Promise<ConnectionProfileIndexV1> {
  const profileId = assertProfileId(options.profileId);
  const snapshot = await options.profiles.getSnapshot();
  if (!snapshot.profiles.some((profile) => profile.id === profileId)) {
    throw new ProfileStoreError('profile-not-found', 'Connection profile was not found.');
  }
  if (options.policy === 'delete-cache-and-jobs' && !options.dataRemoval) {
    throw new ProfileStoreError(
      'connection-cleanup-required',
      'Deleting cached connection data requires a connection-scoped cleanup adapter.',
    );
  }
  const operationId = assertProfileId(
    options.createOperationId?.()
      ?? `profile-removal-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`,
  );
  const createdAt = requireIsoDate(
    options.now?.() ?? new Date().toISOString(),
    'createdAt',
  );
  const data = options.policy === 'delete-cache-and-jobs'
    ? await options.dataRemoval!.plan(profileId, operationId)
    : null;
  const pending = await options.journal.begin({
    schemaVersion: PROFILE_REMOVAL_JOURNAL_SCHEMA_VERSION,
    operationId,
    profileId,
    policy: options.policy,
    createdAt,
    data,
  });

  if (pending.policy === 'delete-cache-and-jobs') {
    try {
      await options.dataRemoval!.stage(pending.data);
      await options.dataRemoval!.commit(
        pending.profileId,
        pending.operationId,
        pending.createdAt,
        pending.data,
      );
    } catch (error) {
      // A transport/storage error can be reported after the SQLite transaction
      // committed. Never restore files until the durable marker disproves it.
      const committed = await options.dataRemoval!.isCommitted(pending.operationId);
      if (committed) return finishProfileRemoval(pending, options, true);
      try {
        await options.dataRemoval!.rollback(pending.data);
        await options.journal.markCleanupComplete(pending.operationId);
        await options.journal.clear(pending.operationId);
      } catch {
        throw new ProfileStoreError(
          'profile-removal-rollback-failed',
          'Connection removal failed and its staged files require startup recovery.',
        );
      }
      throw error;
    }
  }

  return finishProfileRemoval(
    pending,
    options,
    pending.policy === 'delete-cache-and-jobs',
  );
}

export type ProfilePublicationRecovery = {
  kind: 'none' | 'rolled-back' | 'completed';
  replacementProfileId?: string;
  oldProfileId?: string | null;
  snapshot: ConnectionProfileIndexV1;
  removalCleanupPending?: boolean;
};

function replacementMatchesPublication(
  pending: ProfilePublicationJournal,
  profile: ConnectionProfile | undefined,
  secrets: ProfileSecrets | null,
) {
  if (!profile || !secrets) return false;
  if (connectionProfileAuthFingerprint(profile) !== pending.connectionFingerprint) return false;
  if (secrets.connectionFingerprint !== pending.connectionFingerprint) return false;
  if (profile.auth.kind === 'mutual-tls') {
    return pending.clientIdentityRef !== null
      && secrets.clientIdentityRef === pending.clientIdentityRef;
  }
  return pending.clientIdentityRef === null && secrets.clientIdentityRef === undefined;
}

async function rollbackPendingProfilePublication(
  pending: ProfilePublicationJournal,
  options: {
    profiles: ConnectionProfileRepository;
    secrets: ProfileSecretStore;
    publicationJournal: ProfilePublicationJournalStore;
    removeClientIdentity?(clientIdentityRef: string): Promise<void>;
  },
) {
  let snapshot = await options.profiles.getSnapshot();
  if (snapshot.profiles.some((profile) => profile.id === pending.replacementProfileId)) {
    snapshot = await options.profiles.remove(pending.replacementProfileId, {
      ...(pending.intendedActive
        && pending.oldProfileId
        && snapshot.profiles.some((profile) => profile.id === pending.oldProfileId)
        ? { nextActiveProfileId: pending.oldProfileId }
        : {}),
    });
  }
  await options.secrets.delete(pending.replacementProfileId);
  if (
    pending.oldProfileId
    && pending.intendedActive
    && snapshot.profiles.some((profile) => profile.id === pending.oldProfileId)
    && snapshot.activeProfileId !== pending.oldProfileId
  ) {
    snapshot = await options.profiles.setActiveProfile(pending.oldProfileId);
  }
  if (pending.clientIdentityRef) {
    if (!options.removeClientIdentity) {
      throw new ProfileStoreError(
        'managed-identity-cleanup-required',
        'Recovering an interrupted mutual-TLS connection requires native identity cleanup.',
      );
    }
    await removeClientIdentityIfUnreferencedUnlocked({
      clientIdentityRef: pending.clientIdentityRef,
      profiles: options.profiles,
      secrets: options.secrets,
      removeClientIdentity: options.removeClientIdentity,
    });
  }
  await options.publicationJournal.clear(pending.operationId);
  return snapshot;
}

/**
 * Recovers the one durable fresh-namespace publication. Call this after
 * pending profile-removal recovery and before general managed-identity
 * reconciliation, so a journaled mTLS identity is never mistaken for an
 * orphan while its profile publication is being repaired.
 */
export async function recoverPendingProfilePublication(options: {
  profiles: ConnectionProfileRepository;
  secrets: ProfileSecretStore;
  publicationJournal?: ProfilePublicationJournalStore;
  removalJournal: ProfileRemovalJournalStore;
  dataRemoval: ProfileDataRemovalTransaction;
  removeClientIdentity?(clientIdentityRef: string): Promise<void>;
  onProfileRevoked?: (snapshot: ConnectionProfileIndexV1) => void;
  coordinator?: ManagedClientIdentityCoordinator;
}): Promise<ProfilePublicationRecovery> {
  const publicationJournal = options.publicationJournal ?? options.secrets.publicationJournal;
  return (options.coordinator ?? managedClientIdentityCoordinator).runExclusive(async () => {
    const pending = await publicationJournal.read();
    if (!pending) {
      return { kind: 'none', snapshot: await options.profiles.getSnapshot() };
    }
    let snapshot = await options.profiles.getSnapshot();
    const replacement = snapshot.profiles.find(
      (profile) => profile.id === pending.replacementProfileId,
    );
    let replacementSecrets: ProfileSecrets | null = null;
    if (replacement) {
      try {
        replacementSecrets = await options.secrets.read(pending.replacementProfileId);
      } catch (error) {
        // Durable schema/binding corruption is an incomplete publication and
        // is safe to roll back. Transient protected-store read failures must
        // fail closed without deleting anything.
        if (!(error instanceof ProfileStoreError)) throw error;
      }
    }
    if (!replacementMatchesPublication(pending, replacement, replacementSecrets)) {
      snapshot = await rollbackPendingProfilePublication(pending, {
        profiles: options.profiles,
        secrets: options.secrets,
        publicationJournal,
        ...(options.removeClientIdentity
          ? { removeClientIdentity: options.removeClientIdentity }
          : {}),
      });
      return {
        kind: 'rolled-back',
        replacementProfileId: pending.replacementProfileId,
        oldProfileId: pending.oldProfileId,
        snapshot,
      };
    }

    let removalCleanupPending = false;
    if (
      pending.oldProfileId
      && snapshot.profiles.some((profile) => profile.id === pending.oldProfileId)
    ) {
      try {
        snapshot = await removeProfileWithSecrets({
          profileId: pending.oldProfileId,
          policy: 'delete-cache-and-jobs',
          profiles: options.profiles,
          secrets: options.secrets,
          journal: options.removalJournal,
          dataRemoval: options.dataRemoval,
          createOperationId: () => pending.operationId,
          now: () => pending.createdAt,
          nextActiveProfileId: pending.intendedActive
            ? pending.replacementProfileId
            : undefined,
          ...(options.onProfileRevoked ? { onProfileRevoked: options.onProfileRevoked } : {}),
        });
      } catch (error) {
        if (!(error instanceof ProfileRemovalCleanupPendingError)) throw error;
        snapshot = await options.profiles.getSnapshot();
        if (snapshot.profiles.some((profile) => profile.id === pending.oldProfileId)) {
          throw error;
        }
        // The old namespace is durably revoked. Its remaining secret/file
        // cleanup is owned by the removal journal and must not prevent the
        // intended replacement from becoming the sole active authority.
        removalCleanupPending = true;
      }
    }

    snapshot = await options.profiles.getSnapshot();
    if (!snapshot.profiles.some((profile) => profile.id === pending.replacementProfileId)) {
      throw new ProfileStoreError(
        'profile-publication-replacement-missing',
        'The completed replacement connection disappeared during recovery.',
      );
    }
    if (pending.intendedActive && snapshot.activeProfileId !== pending.replacementProfileId) {
      snapshot = await options.profiles.setActiveProfile(pending.replacementProfileId);
    }
    await publicationJournal.clear(pending.operationId);
    return {
      kind: 'completed',
      replacementProfileId: pending.replacementProfileId,
      oldProfileId: pending.oldProfileId,
      snapshot,
      ...(removalCleanupPending ? { removalCleanupPending: true } : {}),
    };
  });
}

/**
 * Removes an app-owned native identity only after no saved profile references
 * it. Android's implementation intentionally only forgets Folio's reference;
 * the system-owned KeyChain entry remains under user/device-policy control.
 */
type ClientIdentityInventoryDependencies = {
  profiles: ConnectionProfileRepository;
  secrets: ProfileSecretStore;
};

async function readCompleteClientIdentityInventory(
  options: ClientIdentityInventoryDependencies,
) {
  const snapshot = await options.profiles.getSnapshot();
  const secretInventory = await Promise.all(
    snapshot.profiles.map((profile) => options.secrets.read(profile.id)),
  );
  for (const [index, profile] of snapshot.profiles.entries()) {
    if (
      profile.auth.kind === 'mutual-tls'
      && !secretInventory[index]?.clientIdentityRef
    ) {
      throw new ProfileStoreError(
        'incomplete-managed-identity-inventory',
        'A mutual-TLS profile has no durable client identity reference.',
      );
    }
  }
  return {
    snapshot,
    referenced: new Set(
      secretInventory.flatMap((secrets) =>
        secrets?.clientIdentityRef ? [secrets.clientIdentityRef] : [],
      ),
    ),
  };
}

async function removeClientIdentityIfUnreferencedUnlocked(options: {
  clientIdentityRef: string;
  profiles: ConnectionProfileRepository;
  secrets: ProfileSecretStore;
  removeClientIdentity(clientIdentityRef: string): Promise<void>;
}): Promise<'still-referenced' | 'removed'> {
  const reference = requireString(options.clientIdentityRef, 'clientIdentityRef');
  const inventory = await readCompleteClientIdentityInventory(options);
  if (inventory.referenced.has(reference)) return 'still-referenced';
  await options.removeClientIdentity(reference);
  return 'removed';
}

export async function removeClientIdentityIfUnreferenced(options: {
  clientIdentityRef: string;
  profiles: ConnectionProfileRepository;
  secrets: ProfileSecretStore;
  removeClientIdentity(clientIdentityRef: string): Promise<void>;
  coordinator?: ManagedClientIdentityCoordinator;
}): Promise<'still-referenced' | 'removed'> {
  return (options.coordinator ?? managedClientIdentityCoordinator).runExclusive(
    () => removeClientIdentityIfUnreferencedUnlocked(options),
  );
}

export type ManagedClientIdentityReconciliation = {
  retained: string[];
  removed: string[];
};

/**
 * Reclaims app-owned native identities that have no durable profile-secret
 * reference. The complete profile and secret inventory is read before native
 * identities are listed, so an inventory read failure always fails closed
 * without exposing any identity to deletion.
 */
export async function reconcileManagedClientIdentities(options: {
  profiles: ConnectionProfileRepository;
  secrets: ProfileSecretStore;
  listManagedClientIdentityRefs(): Promise<readonly string[]>;
  removeClientIdentity(clientIdentityRef: string): Promise<void>;
  coordinator?: ManagedClientIdentityCoordinator;
}): Promise<ManagedClientIdentityReconciliation> {
  return (options.coordinator ?? managedClientIdentityCoordinator).runExclusive(async () => {
    const { referenced } = await readCompleteClientIdentityInventory(options);
    const rawManaged = await options.listManagedClientIdentityRefs();
    if (!Array.isArray(rawManaged) || rawManaged.length > 512) {
      throw new ProfileStoreError(
        'invalid-managed-identity-inventory',
        'The native managed identity inventory is invalid.',
      );
    }
    // Validate the entire native inventory before the first destructive call.
    const managed = [...new Set(
      rawManaged.map((reference) => requireBoundedString(
        reference,
        'clientIdentityRef',
        2_048,
      )),
    )];
    const retained: string[] = [];
    const removed: string[] = [];
    for (const reference of managed) {
      if (referenced.has(reference)) {
        retained.push(reference);
        continue;
      }
      await options.removeClientIdentity(reference);
      removed.push(reference);
    }
    return { retained, removed };
  });
}
