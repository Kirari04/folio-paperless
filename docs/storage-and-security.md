# Local storage and cleanup policy

Folio scopes every persisted record and private file by an internal connection
profile ID. Remote document IDs, task IDs, and server URLs are not global
identities. The ID is stable for rename/non-authority edits; an authority-changing
edit deliberately allocates a fresh ID.

- Paperless API tokens, custom-header values, and client-identity references are stored
  separately from profile metadata through the platform secret adapter. They are
  never written to the SQLite document/task database, filenames, notifications,
  route URLs, or logs.
- OIDC provider access, refresh, and ID tokens are transient. After local
  signature and claim validation, Folio sends them only to Paperless's advertised
  headless provider-token endpoint and retains only Paperless's returned DRF API
  token. A provider token is never used directly as a Bearer credential for the
  Paperless document API.
- Legacy protected records that predate the Paperless exchange may contain an
  `oidc` provider token. Request-header construction, foreground credential
  loading, and worker authority validation all reject it. The cached workspace
  remains profile-scoped while Settings offers an explicit reconnect; a fresh
  Paperless token is published before the legacy authority namespace is retired.
- Native profile secrets use Keychain/Keystore through Expo SecureStore. Expo
  SecureStore does not support web. Browser builds are development/demo-only,
  remain token-only, and disclose that their origin-scoped `localStorage` token
  is not protected by an OS credential store; they cannot claim OS-backed secret
  or offline-file protection.
- [Expo SDK 57 documents](https://docs.expo.dev/versions/v57.0.0/sdk/securestore/)
  that underlying native stores can reject large values
  (historically around 2,048 bytes on some iOS releases). The native string-store
  adapter therefore keeps every physical SecureStore value at or below a
  conservative 1,536-byte UTF-8 ceiling. Values up to 1,400 bytes remain direct
  single-key records; larger profile indexes, custom-header bundles, and
  notification-route registries are split into at most 188 chunks with a 256 KiB
  logical-record limit. Each hashed logical-key namespace has two generations.
  A versioned staging manifest is written before its chunks, the complete
  generation is checked by UTF-8 length and SHA-256, and a small pointer is
  published last. Interrupted writes therefore expose the complete old or new
  value, never a partial mix. Corrupt or missing published metadata/chunks fail
  closed. Legacy oversized single values migrate through the same pointer-last
  path on read. Deletion first publishes a bounded tombstone, then removes the
  raw copy and every referenced or staged chunk before removing each manifest
  and, last, the tombstone; a crash leaves enough protected metadata for an
  idempotent cleanup retry. The browser development surface continues to use
  direct `localStorage` and does not use this native chunk protocol.
- Library summaries, catalogs, saved views, fetched detail/OCR, route aliases,
  presets, capabilities, and task records use SQLite database schema version 7
  on native platforms. Individual durable task payloads use their independent
  schema version 4. Ordered database migrations run transactionally; an
  unsupported newer or corrupt database fails closed instead of being
  destructively replaced. The v6 migration adds the profile-removal commit
  tombstone and converts an interrupted pre-task-ID `uploading` record to
  `submission-uncertain`; v7 adds the external removal-manifest table and the
  permanent tombstone insert fences. Workspace replacement, cleanup commits,
  and worker leasing use exclusive transactions.
- Native document and cache roots use the exact validated stable profile ID as
  their directory name and contain `.folio-profile-owner-v1`, whose versioned
  payload binds that root to one exact profile. New allocation never uses the
  older lossy punctuation-to-hyphen normalization. An unmarked legacy root is
  claimed in place only when the complete saved-profile set proves exactly one
  possible owner; its URI remains unchanged so existing offline-file records stay
  valid. Ambiguous collisions such as `a.b`, `a-b`, and `a--b`, a malformed
  marker, or a foreign marker fail closed before file access, allocation, or
  removal.
- Incoming files are copied before use to the app-private Documents directory at
  `folio/profiles/<profile-id>/staging`. Filenames are normalized and prefixed by a
  stable job ID. The original display name is kept only in the task record. Android
  application backup is disabled. On iOS, every completed staging copy is marked
  `NSURLIsExcludedFromBackupKey` through the local native module and read back before
  the queue may retain it; an unavailable or failed protection call deletes the copy
  and fails that intake item instead of leaving a backup-eligible document behind.
  Explicitly pinned offline files use the same verified exclusion after their
  final move or copy; a failed flag write removes the new pinned copy and leaves
  the task retryable instead of retaining a backup-eligible document.
- Immediately before a transport call can send upload bytes, the durable job is
  moved to `submission-uncertain`. A returned Paperless task ID is persisted
  before polling. If a crash, timeout, lost response, or transport error leaves no
  durable task ID, the job remains non-runnable and is never automatically
  re-uploaded. The user must check Paperless and explicitly confirm the duplicate
  risk before the same staged bytes and metadata can be requeued. Schema-v4 task
  migration applies the same conservative state to interrupted legacy records.
- A definitely local, unleased pre-upload cancellation may remove its staged file
  after confirmation. Cancellation while a worker may have submitted bytes, or
  after Paperless returned a task ID, records `acceptance-uncertain`, retains the
  staged file, and stops only local work; it never claims that server processing
  was canceled. Completed upload staging files use a short conservative retention
  window so a handoff can be investigated. Failed, queued, uploading, canceled-
  uncertain, and submission-uncertain files remain until the user safely resolves
  or removes the job, or chooses profile cleanup.
- The cache engine supports quota/LRU eviction for automatic assets, but current
  production representation downloads are explicit pins. Viewer previews and
  handoff files instead use an age-based temporary cleanup policy. Pins live in
  protected persistent storage and are never evicted without confirmation.
- Preview, save, print, OS-share, and export preparation uses sanitized names in
  profile-scoped app-private temporary directories. Folio removes handoff copies
  when possible and lazily removes stale files on later relevant operations; it
  cannot control copies retained by an OS print/share destination. A Paperless
  public link is not a local file: it is an unauthenticated bearer URL for the
  explicitly selected representation and remains sensitive until expiry or
  revocation.
- Removing a profile requires an explicit retain-or-delete policy. Deletion targets
  only that profile’s secrets, records, staged files, cached files, notifications,
  and OS-index/widget state. For delete-data removal, Folio writes a validated
  exact-path manifest to SQLite, then writes only its reference and operation
  identity to the size-constrained protected journal before moving any owned
  document, cache, preview, or export directory to app-private quarantine. SQLite
  then deletes only that profile’s rows and writes the v6 removal tombstone in the
  same exclusive transaction. Startup recovery rolls the quarantine back when no
  commit tombstone exists and the profile still exists; after commit, it finishes
  profile-index/runtime revocation, secret deletion, quarantine deletion, and
  temporary manifest/journal removal. The minimal tombstone remains permanently
  and rejects every later insert for that profile ID. A failed final unlink remains
  journaled for retry.
  Profile metadata is revoked before its credential, so a crash may temporarily
  leave an unreachable secret but cannot leave a usable profile without its
  secret. Every rollback/finish step is idempotent and refuses foreign or
  unexpected paths.
- Authority-changing profile edits never overwrite a same-ID secret. Before any
  fresh namespace is published, Folio stores a bounded, credential-free
  publication journal in the same size-safe protected string store. It binds one
  operation to the preallocated replacement ID, optional old ID, intended-active
  state, timestamp, non-secret connection fingerprint, and optional opaque mTLS
  reference. Metadata is added inactive, then its secret is written. Startup runs
  profile-removal recovery first, publication recovery second, and general native
  identity reconciliation last. An incomplete or mismatched replacement is
  removed, its journaled native identity is reclaimed only after a complete
  fail-closed profile/secret inventory, and the old authority is restored. A
  complete rebind finishes the exact old ID's delete-data removal, activates the
  exact intended replacement, and retries journal clear until it succeeds. A
  complete new profile is similarly activated only when intended. Same-authority
  metadata edits keep their ID and do not create a publication journal.
- Managed native identity inventory, deletion, and fresh mTLS metadata/secret
  publication share one async coordinator. Both direct reference-counted cleanup
  and startup enumeration read every profile secret before listing or deleting
  native identities, and fail closed when any mTLS profile lacks its opaque
  reference. This prevents cleanup from observing the metadata-before-secret
  publication window or deleting an identity while that reference is being
  committed.

Background execution is best effort. Headless workers skip mTLS profiles because
the native client identity cannot be safely selected there. OIDC profiles use the
Paperless DRF token obtained during interactive setup, so workers never need an
identity-provider token or provider refresh flow.
Each worker captures its complete authority-bearing secret values and compares
them directly with the current protected record at execution boundaries, in
addition to checking the non-secret connection fingerprint. Token or
custom-header rotation therefore invalidates stale captured requests without
logging, hashing, or persisting secret derivatives.
Cancellation after Paperless returns a task ID stops local polling only and never
claims to cancel server processing.

Legacy single-connection credentials are migrated idempotently into a stable
default profile. Native secrets remain in protected storage; the development/demo
web surface uses origin-scoped `localStorage`. The migration can resume after
interruption and removes the legacy record only after the new profile and secret
have been persisted successfully. Legacy native file roots are a separate startup
migration: they retain their existing URI, receive a reversible owner marker only
after unambiguous ownership is proven, and otherwise block startup rather than
guessing between colliding profiles.

When an OS background worker finishes an upload, it writes the terminal task first
and then marks it for foreground reconciliation. On the next active launch, only
the matching connection profile replays the UI-owned work: it persists the stale
placeholder route alias, hydrates the Paperless result, and applies the one-time
notification policy. A completion marker is written only after those steps, so an
interrupted handoff is safe to retry and a finished handoff is not replayed.

Pinned files are resolved from their protected profile directory before live API
capability discovery. This is intentional: after an airplane-mode cold start, a
valid local file must remain openable even when the server schema cannot be
negotiated. The profile ID, document ID, representation, non-empty URI, and file
size must all match before the viewer accepts a cached source.

Store flavor is also a storage/security boundary. Store autolinking excludes the
`folio-updater` native module and Expo development-client, launcher, menu, and
menu-interface modules on Android and Apple; store configuration removes
development-client metadata, blocks installer/storage permissions, and disables
the in-app APK updater UI. Deterministic source/configuration and autolinking
assertions pass, but this policy is not a claim about a release binary until the
protected workflow produces and scans the actual signed AAB/archive.
