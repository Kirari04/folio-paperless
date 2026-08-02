# Issues 14–23 acceptance and verification record

This document reconciles the current working tree with the complete GitHub issue
bodies for [#14](https://github.com/Kirari04/folio-paperless/issues/14) through
[#23](https://github.com/Kirari04/folio-paperless/issues/23). The issues were
read through the authenticated GitHub API on 2026-08-02. All ten issues are open
and each has one implementation-status comment. Those comments do not change the
issue bodies' acceptance criteria; this record supersedes their older test counts
and verification notes.

Status language is intentionally strict:

- `[x] Software-verified` means the implementation path exists and is supported
  by the frozen tree's automated tests, static checks, or deterministic
  configuration/source-contract assertions. It does **not** imply a live server,
  physical-device, signing, store-console, or release-artifact pass.
- `[ ] External/manual` means the acceptance criterion is not complete in this
  environment. Configuration or unit-test coverage may exist, but the criterion
  requires hardware, a real service, protected credentials, a signed artifact,
  or visual/OS behavior that was not exercised here.
- Additional live-server QA is retained even where a protocol path is
  software-verified against fixtures. A mock response is not called a live
  Paperless pass.

## Candidate-tree baseline

- Stack tip: `stack/issues-20-21-platform`, above
  `stack/issues-17-19-22-23-workflows`, `stack/issues-14-16-intake`, and
  `stack/issues-14-23-foundation`.
- Integration base: `216664347245d42ca540586a01301de0ea122085`
  (`origin/dev`, including merged PRs #24, #13, and #26).
- Delivery state: draft PRs #27–#30 are open in dependency order. Final hardening
  is split into its owning stack layers and propagated bottom-up without history
  rewrites.
- Local database schema: **version 7**
  (`FOLIO_DATABASE_VERSION` in `src/lib/database-schema.ts`).
- Persistent task payload schema: **version 4**
  (`PERSISTED_TASK_SCHEMA_VERSION` in `src/types/tasks.ts`).
- Upload preset, connection-profile, profile-secret, notification-route, widget,
  update-cache, profile-removal journal, native profile-directory owner, and
  native removal-manifest payloads currently remain independently versioned at
  **1**.
- The ten issue bodies contain **121** acceptance criteria. This record maps all
  **121/121**: **107** are software-verified and **14** remain external/manual.
- Independently run on the candidate tree on 2026-08-02:
  - `npm test` — pass, **573/573** tests; 0 failed, 0 skipped, 0 todo.
  - `npx tsc --noEmit` — pass.
  - `npm run lint` — pass.
  - `npx expo-doctor` — pass, **20/20** checks.
  - Clean GitHub-flavor Android release APK — pass; APK signature verified and
    installed as an in-place upgrade on a connected Android 16 device without
    changing its original install time or clearing application data.
  - Clean store-flavor Android release AAB — build pass; the local artifact is
    not a Play-signed candidate and does not satisfy store signing verification.
- Disposable Paperless 3.0.0 and 3.0.5 stacks were exercised with full and
  restricted users. Identity-provider, real mTLS, iOS-device, printer, and store
  account checks remain unavailable.

## Live summary

| Issue | Workstream | Software-verified criteria | External/manual criteria | Status | Precise remaining blocker |
| --- | --- | ---: | ---: | --- | --- |
| #14 | Intake and durable upload | 11/13 | 2/13 | Android PDF/text intake and restart verified; cross-platform matrix open | Android registration, a real Files PDF share, synthetic text share, durable staging, and restart were exercised. iOS plus Mail/browser/scanner, biometric-entry, and full multi-provider device coverage remain. |
| #15 | Profiles and authentication | 12/13 | 1/13 | Software path verified; native mTLS/live auth QA open | Linux cannot build/test the iOS Keychain/`URLSession` path; no device certificate identity or live OTP/OIDC/Paperless fixtures were available. |
| #16 | Upload metadata and presets | 11/11 | 0/11 | Software acceptance verified; live compatibility partially exercised | Both Paperless versions accepted a multipart upload and exact title/date/tag/filename readback. Workflow, custom-field clear/value matrix, owner-transfer visibility loss, matching, and preset UI still need device/live coverage. |
| #17 | Bulk library operations | 13/13 | 0/13 | Software acceptance verified; live error-matrix QA open | Restricted 403 and permission readback were exercised on both versions. Live 404/429, mixed partial results, retry, export, and reprocess task correlation remain. |
| #18 | Offline and Task Center | 14/15 | 1/15 | Durable restart verified; background device matrix open | Android intake state survived force-stop/relaunch. Reboot, OS scheduler timing, notification routing, connectivity return, disk pressure, and iOS process behavior remain. |
| #19 | Saved views and catalogs | 14/14 | 0/14 | Software acceptance verified; live CRUD/web-UI readback open | Full/restricted catalog visibility was exercised on both versions; mutation ownership, concurrent edits, and Paperless web-UI parity were not. |
| #20 | Appearance and localization | 7/10 | 3/10 | Software path verified; visual/device QA open | No physical runtime OS-theme/locale run, frame-by-frame cold-start review, or approximately 200% text audit was performed. |
| #21 | Platform and distribution | 6/10 | 4/10 | Android artifacts/registration verified; device/store QA open | A connected Android device resolves the custom routes, shortcuts, share targets, widget provider, and background job; release APK/AAB builds pass. Final rendered routing, widget/search/notification UI, Play signing, TestFlight, store-console, iOS, and owned-domain association remain. |
| #22 | Viewer and public sharing | 9/11 | 2/11 | Software path verified; device/live-server QA open | No physical printing/search/highlight/share run and no live Paperless public-link lifecycle test were performed. |
| #23 | Paperless 3 capabilities | 10/11 | 1/11 | Live minimum/current compatibility partially verified | Paperless 3.0.0/3.0.5 full and restricted documents, catalog denial, owner/ACL shapes, metadata filename, OIDC capability, and PDF schemas were exercised. Configured AI/OIDC and actual PDF jobs/failures/restart remain. |
| **Total** | **All ten issues** | **107/121** | **14/121** | **All criteria mapped; external verification remains open** | **Device, live-service, signed-artifact, store-console, and visual/manual checks are not claimed.** |

## External environment facts

- The verification host is Linux. A previous hosted Xcode 26.6 archive exposed
  concrete `FolioMtls` Swift/Security API errors; the candidate tree replaces
  those APIs and delegate signatures, but the corrected source still needs a new
  hosted archive. No signed IPA or TestFlight candidate was produced.
- A Samsung SM-G781B on Android 16/API 36 is connected through ADB. The GitHub
  release APK was rebuilt, signature-matched to the installed QA app, and upgraded
  in place. The device is currently locked, so the post-fix rendered deep-link,
  theme, locale, widget, and large-text matrix remains pending unlock.
- A store-flavor AAB was built and structurally audited locally, but protected
  Play signing credentials, the expected store certificate, EAS project/owner
  credentials, Apple team identity, and store accounts are unavailable.
- No owned HTTPS domain or Apple/Android association files were supplied, so
  universal links/App Links correctly remain deferred and unclaimed.
- Disposable Paperless 3.0.0 and 3.0.5 servers are attached locally. No configured
  OIDC provider, OTP challenge, client-certificate matrix, printer, iOS device,
  Spotlight surface, or store console is attached.

## Issue #14 — intake and durable upload

Primary local evidence: `tests/incoming-share.test.mjs`, `tests/intake.test.mjs`,
`tests/intake-destination-wiring.test.mjs`, `tests/task-policy.test.mjs`,
`tests/upload-queue-worker.test.mjs`, `src/app/scan.tsx`, `src/app/intake.tsx`,
`src/app/tasks.tsx`, and the generated native integration contracts.

- [ ] **External/manual:** Folio appears as a share/open target for supported files
  on Android and iOS. The manifest/extension configuration and handoff source
  contracts are locally asserted, but OS registration was not exercised.
- [x] **Software-verified:** Sharing one or multiple files retains every valid
  candidate through bounded private staging before temporary input expires, while
  preserving individual provider failures.
- [x] **Software-verified:** The in-app picker enqueues multiple documents.
- [x] **Software-verified:** Each file becomes an independent visible task with
  destination, state, progress, MIME/name information, and actionable errors.
- [x] **Software-verified:** Queued and processing jobs persist, reclaim expired
  leases after restart, and resume polling from a stored Paperless task ID without
  re-uploading bytes. An interrupted submission without a durable task ID moves
  to non-runnable `submission-uncertain`; it is never automatically re-uploaded
  and can be requeued only after explicit duplicate-risk confirmation.
- [x] **Software-verified:** Network, timeout, rate-limit, and server failures use
  bounded backoff only while the failure is proven to precede submission;
  acceptance-uncertain failures stop automatic retry, and permanent failures
  remain user-actionable without an infinite retry path.
- [x] **Software-verified:** Mixed-result batches retain successes and retry only
  the failed/retryable subset.
- [x] **Software-verified:** Cancel/remove semantics distinguish definite local
  cancellation from acceptance-uncertain server work, retain the uncertain staged
  bytes, and expose confirmed resubmission as a separate destructive-risk action.
- [x] **Software-verified:** Successful tasks reconcile the remote document and a
  stable placeholder route alias before exposing Open result.
- [x] **Software-verified:** Unsupported, empty, unreadable, over-limit, and
  failed-copy inputs produce per-item errors without discarding valid siblings.
- [x] **Software-verified:** Staging and task metadata follow the profile-private,
  exact-profile-owned, backup-excluded, bounded-retention cleanup policy
  documented in `docs/storage-and-security.md`; ambiguous legacy path ownership
  fails closed.
- [x] **Software-verified:** Automated coverage includes share configuration and
  handoff contracts, migrations, staging, worker leases, retry, restart,
  submission uncertainty, confirmation-gated resubmission, cancellation,
  reconciliation, mixed batches, exact profile-path ownership, legacy migration,
  and cleanup policy.
- [ ] **External/manual:** Physical-device tests must share single and multiple
  files from Files, Mail/browser, and a third-party scanner on both Android and
  iOS, including biometric-lock entry and process restart.

## Issue #15 — profiles and authentication

Primary local evidence: `tests/auth-foundation.test.mjs`,
`tests/profile-management.test.mjs`, `tests/profile-switch-coordinator.test.mjs`,
`tests/mtls-native.test.mjs`, `src/lib/auth/`, and
`src/components/profile-manager-sheet.tsx`.

- [x] **Software-verified:** Legacy single credentials migrate idempotently into
  one default token profile without deleting the only usable secret on a failed
  migration.
- [x] **Software-verified:** Users can add, rename, test, switch, and remove stable
  profiles, including multiple users on the same normalized server URL.
- [x] **Software-verified:** Profile switches fence documents, actions, tasks,
  caches, notifications, routes, and secrets from the previous connection
  generation. A bounded protected publication journal durably preallocates every
  fresh ID before metadata is visible. Recovery rolls back incomplete metadata/
  secret pairs or completes the exact old-ID removal and exact replacement
  activation; foreground credential epochs restore the old authority only before
  its durable revocation. Rename/non-authority edits retain their ID. Native directories preserve the
  exact validated profile ID and require a durable matching owner marker, so
  formerly colliding IDs such as `a.b`, `a-b`, and `a--b` cannot share files.
- [x] **Software-verified:** API-token authentication remains supported.
- [x] **Software-verified:** Password/token acquisition handles required and
  invalid/expired OTP states without retaining a password or OTP.
- [x] **Software-verified:** OIDC uses the system authorization flow with S256
  PKCE and validates state, callback URI, issuer, audience, nonce, expiry, and the
  RS256 signature. Folio capability-discovers the matching Paperless headless
  provider, exchanges the verified IdP tokens through the provider-token endpoint,
  and persists only the returned Paperless DRF token. Legacy raw-IdP-token
  profiles fail closed in foreground and background work and reconnect through
  the existing transactional authority-rebind path.
- [ ] **External/manual:** A supported mTLS connection must be built and exercised
  with a real securely stored client identity, including selection/import,
  password-protected identity, missing private key, expiry, replacement, hostname
  trust, and cleanup on Android and iOS. Source contracts and adapter tests pass,
  but the criterion is not complete without native compile/device evidence.
- [x] **Software-verified:** Custom headers are allowlisted, profile-scoped,
  secret-stored, value-redacted, and applied only through the owning session.
- [x] **Software-verified:** No configuration or transport path disables global
  certificate or hostname verification; HTTPS downgrade and redirects fail closed.
- [x] **Software-verified:** Users can switch away from an unavailable profile by
  hydrating the selected profile independently of the failing connection.
- [x] **Software-verified:** Profile removal deletes the selected secret and offers
  an explicit keep/delete policy for connection-scoped data. Delete-data removal
  stores the exact plan in the v7 SQLite manifest table before publishing its
  small protected journal reference, atomically commits scoped database deletion
  with a permanent minimal tombstone, and either rolls back or completes after a
  crash without touching another profile.
- [x] **Software-verified:** Authentication/test failures are typed and actionable
  and do not overwrite a previously valid profile or secret.
- [x] **Software-verified:** Automated coverage includes migration, isolation,
  switching during work, deletion rollback, OTP, OIDC, native mTLS contracts,
  redirects, redaction, profile-bound request generations, exact native path
  ownership, unambiguous legacy-root migration, crash-consistent removal
  journal/tombstone recovery, publication crashes at every metadata/secret/
  retirement/activation/clear boundary, exact A/B/A-prime activation, journal
  corruption and restart idempotency, and mTLS cleanup/publication interleaving.

Additional external QA remains for live token/OTP/OIDC/custom-header servers even
though those software criteria pass against deterministic fixtures.

## Issue #16 — upload metadata and presets

Primary local evidence: `tests/upload-metadata.test.mjs`,
`tests/upload-queue-worker.test.mjs`, `tests/upload-persistence-restart.test.mjs`,
`tests/intake-destination-wiring.test.mjs`,
`src/app/intake.tsx`, and `src/lib/upload-metadata.ts`.

- [x] **Software-verified:** Scanner, picker, and native-share candidates converge
  on the same durable intake task and `/intake` metadata editor.
- [x] **Software-verified:** The editor supports title, created date,
  correspondent, document type, tags, storage path, ASN, owner, and negotiated
  custom fields before queue submission; workflow is shown only when advertised.
- [x] **Software-verified:** Unset remains distinct from explicit values and clear
  states so Paperless matching/workflows can decide omitted fields.
- [x] **Software-verified:** Users can create, edit, duplicate, delete, select, and
  assign source defaults for reusable presets.
- [x] **Software-verified:** Batch intake applies common fields to all while
  retaining independent title/ASN values and per-file overrides.
- [x] **Software-verified:** Drafts and selected presets are stored in schema-v4
  task payloads and survive repository restart.
- [x] **Software-verified:** Remote identities are profile-scoped; missing, stale,
  wrong-type, or changed preset references enter an explicit repair state.
- [x] **Software-verified:** Serialization preserves zero, false, negative/decimal
  monetary values, select IDs, ISO dates, and validated document links.
- [x] **Software-verified:** Known permissions disable unavailable assignments and
  quick-create actions; runtime 403/metadata failures keep the staged file and
  editable draft.
- [x] **Software-verified:** Completion persists the remote identity, performs any
  required post-upload metadata step, refetches the result, and keeps a failed
  post-processing draft repairable.
- [x] **Software-verified:** Automated coverage includes serialization, preset
  migration/default behavior, validation, permission gating, stale references,
  restart recovery, and multi-file overrides.

External release QA must still compare the submitted and server-applied metadata,
matching/workflow effects, and permission behavior on supported live Paperless
versions.

## Issue #17 — bulk library operations

Primary local evidence: `tests/paperless-ui-controllers.test.mjs`,
`tests/paperless-advanced.test.mjs`,
`tests/bulk-document-reconciliation.test.mjs`, `src/app/documents.tsx`, and
`src/components/bulk-action-sheet.tsx`.

- [x] **Software-verified:** List/grid selection is reachable by long press and an
  explicit accessible Select action; cards expose selected accessibility state.
- [x] **Software-verified:** Stable document-ID selection preserves count/state
  across layout and sort changes.
- [x] **Software-verified:** Select shown targets exactly the current loaded result
  set and reports its count.
- [x] **Software-verified:** Filter/search changes retain and disclose hidden
  selected items before an action.
- [x] **Software-verified:** Add/remove tag operations do not overwrite unrelated
  tags; exact replacement is a separate destructive path.
- [x] **Software-verified:** Correspondent, type, storage path, and owner can be set
  or cleared when capabilities and permissions allow.
- [x] **Software-verified:** Filing removes only inbox tags and preserves all other
  tag identities.
- [x] **Software-verified:** Reprocess, Original/Archive export, and trash actions
  operate only on eligible remote documents.
- [x] **Software-verified:** Processing, non-remote, read-only, and duplicate
  selections are skipped with explicit reasons and are never silently mutated.
- [x] **Software-verified:** Results retain succeeded, pending, failed, and skipped
  items, while durable retry submits only the failed/retryable subset.
- [x] **Software-verified:** Confirmed successes reconcile in-session; trash totals
  change only for rows actually removed after server acceptance.
- [x] **Software-verified:** Typed transport/reconciliation covers network,
  permission, not-found, rate-limit, asynchronous, stale-profile, and partial
  outcomes without applying ambiguous local state.
- [x] **Software-verified:** Automated tests cover stable selection, eligibility,
  bulk transport shapes, tag semantics, durable retries, and reconciliation.

External live-server QA remains for real permission matrices, endpoint versions,
partial task results, 403/404/429 responses, and OS multi-file export behavior.

## Issue #18 — offline access and Task Center

Primary local evidence: `tests/offline-foundation.test.mjs`,
`tests/offline-sync-acceptance.test.mjs`,
`tests/background-sync-foundation.test.mjs`,
`tests/offline-download-worker.test.mjs`, `tests/task-center-foundation.test.mjs`,
`tests/repository.test.mjs`, `src/lib/sqlite-repository.ts`, and
`src/app/tasks.tsx`.

- [x] **Software-verified:** After cached hydration, an airplane-mode relaunch
  returns the connected profile workspace instead of demo documents.
- [x] **Software-verified:** Cached query/filter/sort, server-evaluated saved-view
  membership, and fetched detail/OCR metadata remain available offline.
- [x] **Software-verified:** A valid protected pinned representation resolves after
  restart without requiring capability discovery or network access.
- [x] **Software-verified:** An absent local representation returns a specific
  offline-unavailable state rather than substituting another file.
- [x] **Software-verified:** A failed refresh preserves the last complete cache and
  persists an actionable sync task.
- [x] **Software-verified:** Current, syncing, cached/offline, and cached/error states
  carry accessible last-success information.
- [x] **Software-verified:** Settings exposes automatic/pinned usage, quota,
  evictable cleanup, pin removal, and connection-scoped cleanup controls.
- [x] **Software-verified:** Processing tasks, placeholders, leases, aliases, and
  one-time notification/reconciliation markers persist across service restart;
  a pre-task-ID upload interruption persists as non-runnable
  `submission-uncertain` instead of silently resubmitting bytes.
- [x] **Software-verified:** Background executions bind both connection metadata
  and the captured API-token/OIDC/custom-header authority to the current protected
  record, so secret rotation rejects stale work without storing a secret hash.
- [x] **Software-verified:** Task Center projects active/failed/completed counts and
  task-appropriate retry, cancel/stop-tracking, dismiss, conflict, and Open result
  actions.
- [x] **Software-verified:** Workspace replacement and sync-task completion commit
  transactionally, and stale/lost leases cannot replace valid state.
- [x] **Software-verified:** Overlapped incremental synchronization plus periodic
  full reconciliation handles additions, changes, deletions, permission loss, and
  clock/watermark overlap conservatively.
- [x] **Software-verified:** Automatic file-cache policy applies quota/LRU without
  demoting or silently evicting explicit pins.
- [x] **Software-verified:** Disconnect/profile removal follows the documented
  profile-scoped secret, database, task, file, notification, search, and widget
  cleanup policy, including exact native owner markers, conservative legacy-root
  claiming, durable quarantine journaling, and the transactional v6 deletion
  tombstone.
- [x] **Software-verified:** Automated coverage includes ordered migrations,
  cache-first hydration, reconciliation, task resumption, lease deduplication,
  bounded backoff, uncertain-submission migration, notification outbox recovery,
  profile-path collision rejection, and crash-consistent cleanup.
- [ ] **External/manual:** Best-effort background scheduling, process death,
  force-close/relaunch, reboot, connectivity return, notification timing, and disk
  pressure must be exercised on physical iOS and Android devices. iOS scheduling
  timing must not be presented as deterministic.

## Issue #19 — saved views and catalog management

Primary local evidence: `tests/paperless-advanced.test.mjs`,
`tests/paperless-ui-controllers.test.mjs`,
`tests/saved-view-publication.test.mjs`, `src/app/saved-views.tsx`,
`src/app/paperless-metadata.tsx`, and `src/lib/saved-view-controller.ts`.

- [x] **Software-verified:** The current query, filters, and sort serialize into a
  Paperless saved-view create request.
- [x] **Software-verified:** A returned created view is published to the repository
  before fallible refresh and survives cache rehydration.
- [x] **Software-verified:** Refined views support update or Save as new.
- [x] **Software-verified:** Management UI and typed transport support rename,
  duplicate, and confirmed delete.
- [x] **Software-verified:** Supported rules round-trip with exact remote IDs and
  preserved query/sort/date/ASN semantics.
- [x] **Software-verified:** Unknown, invisible, and extra rules remain opaque and
  are never silently dropped; unsafe material overwrite is blocked.
- [x] **Software-verified:** Negotiated view display mode, display fields, page
  size, visibility fields, and sort are retained where supported.
- [x] **Software-verified:** Permission-gated typed CRUD exists for tags,
  correspondents, document types, and storage paths.
- [x] **Software-verified:** Sparse edits preserve unedited resource-specific
  values, including tag color/matching data and storage templates.
- [x] **Software-verified:** Renames preserve stable IDs and reconcile catalog,
  documents, filters, saved views, and visible tag paths.
- [x] **Software-verified:** Delete confirmation is usage-aware; local removal and
  dependent-reference reconciliation occur only after server success.
- [x] **Software-verified:** Read-only/unknown capability states retain browse
  access while failing closed for mutation controls.
- [x] **Software-verified:** Runtime 403 or failed refresh publishes no optimistic
  delete and cannot roll back a confirmed server mutation to stale local data.
- [x] **Software-verified:** Automated coverage includes serialization,
  opaque-rule preservation, capabilities, sparse typed CRUD, duplicate handling,
  mutation publication, and reconciliation.

External live-server QA must verify ownership rules, duplicate-name responses,
runtime permission changes, server-specific fields, and Paperless web-UI readback.

## Issue #20 — appearance and localization

Primary local evidence: `tests/i18n-theme.test.mjs`, `src/i18n/`,
`src/context/ui-preferences-context.tsx`, semantic theme tokens, and native locale
resources.

- [x] **Software-verified:** New installs resolve System appearance and System
  language by default, with safe English fallback.
- [x] **Software-verified:** Appearance and language overrides can be changed
  independently and apply through the shared provider.
- [x] **Software-verified:** Stored overrides hydrate independently of
  authentication/profile state and survive provider restart; corrupt values fail
  safe.
- [x] **Software-verified:** First-party app copy, errors, notifications, status,
  and accessibility strings use the translation path; deliberate product names,
  URLs, filenames, identifiers, and server-owned content remain unlocalized.
- [x] **Software-verified:** English/German catalogs have exact non-empty key and
  interpolation parity, unsupported system locales fall back to English, and the
  native config/plugin resources provide Android defaults for every shared
  shortcut/widget locale key.
- [x] **Software-verified:** Dates, times, counts, page numbers, numbers, lists, and
  file sizes use the active locale while raw server/user values remain unchanged.
- [ ] **External/manual:** The splash/provider gate and dark native splash are
  software-verified, but absence of any visible light-theme frame still requires
  frame-by-frame cold-start and biometric unlock inspection on Android and iOS.
- [ ] **External/manual:** Automated WCAG contrast assertions pass for semantic
  roles, but every first-party screen/modal must still be inspected at roughly
  200% text scaling in both themes, including longer German copy, reachability,
  clipping, and non-color status cues.
- [x] **Software-verified:** Automated tests cover stored preferences, system
  reactivity/fallback, locale formatting, complete catalogs, diagnostic mappings,
  representative provider renders, semantic contrast, and native locale/widget
  resource parity.
- [ ] **External/manual:** Change System theme and locale at runtime on physical
  Android and iOS devices and verify the app plus native widget/shortcut surfaces
  update without bypassing authentication or exposing protected data.

## Issue #21 — deep links, OS integrations, and distribution

Primary local evidence: `tests/platform-foundation.test.mjs`,
`tests/os-search-native-runtime.test.mjs`, `src/lib/external-routing.ts`,
`src/lib/external-routing-runtime.ts`, `src/lib/platform-notifications.ts`,
`modules/folio-platform/`, `app.config.js`, `eas.json`,
`scripts/assert-autolinking-flavors.mjs`,
`plugins/withFolioDistributionGuard.js`, and the release/store workflows and
assertions.

- [x] **Software-verified:** The central external-route parser is documented,
  length/shape/route allowlisted, and covered for cold, warm, queued, expired,
  duplicate, and invalid custom-scheme inputs.
- [x] **Software-verified:** Document routes require bootstrap, authentication,
  biometric unlock, the exact profile, repository ownership, and current view
  permission; cross-profile or inaccessible targets fall back safely.
- [x] **Software-verified:** Notification responses use a strict versioned payload,
  one-time profile-scoped handle, clear-before-route consumption, the central
  resolver, and redacted-by-default content.
- [ ] **External/manual:** Quick Scan, Inbox, and Search shortcut configuration and
  native handoff contracts are asserted, but the shortcuts must work from cold,
  warm, locked, and signed-out states on supported Android and iOS devices.
- [x] **Software-verified:** OS search policy is opt-in, bounded, profile-scoped,
  permission-filtered, minimal by default, and revocable; OCR, credentials, server
  URLs, notes, custom-field values, and files are excluded.
- [x] **Software-verified:** Widget payload/native contracts expose only approved
  count/state data and a fixed Quick Scan action and fail closed to a locked or
  no-data presentation.
- [ ] **External/manual:** Protected CI must produce and read back a release-signed
  Play AAB and TestFlight-ready iOS archive with the intended version/build number,
  certificate/team, entitlements, and bundle identity. No such artifacts exist in
  this environment.
- [ ] **External/manual:** Inspect the actual signed store Android artifact and
  installed app to prove it contains neither `REQUEST_INSTALL_PACKAGES` nor the
  GitHub self-updater. Source/configuration guards now exclude `folio-updater`
  plus Expo development-client/launcher/menu modules from store autolinking on
  Android and Apple, strip development-client metadata, hide updater UI at
  runtime, and scan packaged payloads; no release artifact was supplied, so this
  criterion remains external/manual.
- [x] **Software-verified:** Store/privacy documentation covers links,
  notifications, search, widgets, shortcuts, sharing, distribution flavors, and
  the direct-user-to-Paperless data model. Store-console answers/screenshots remain
  a release task.
- [ ] **External/manual:** Complete the full physical Android/iOS matrix for real
  links/intents, notification taps, shortcuts, Spotlight/AppSearch revocation,
  widget states/actions, biometric deferral, flavor isolation, and signed release
  candidates.

Universal/App Links are not claimed: they remain intentionally blocked until an
owned HTTPS domain and valid Apple/Android association files are available.

## Issue #22 — viewer, printing, representations, and public links

Primary local evidence: `tests/document-production.test.mjs`,
`tests/pdf-viewer-workflows.test.mjs`, `tests/download-safety.test.mjs`,
`tests/document-representation-verification.test.mjs`,
`src/components/document-preview-viewer.tsx`, and
`src/components/document-preview-viewer.web.tsx`.

- [x] **Software-verified:** Find consumes only bounded page-aware native renderer
  events, exposes query/current/count/next/previous state, navigates to the matched
  page, and renders native-coordinate highlights.
- [x] **Software-verified:** Image-only/no-page-text documents receive an explicit
  no-searchable-text state rather than whole-document OCR being mislabeled as
  page-accurate search.
- [ ] **External/manual:** The print software path uses Expo Print with the exact
  verified selected PDF and typed unsupported/preparation/cancellation errors, but
  printing must be exercised on supported Android and iOS devices with Original
  and Archive, cancellation, printer failure, and lock/unlock return.
- [x] **Software-verified:** Preview, save, print, and OS share use the same explicit
  Original/Archive selection and show the chooser when both are advertised.
- [x] **Software-verified:** Missing/malformed representation metadata or a
  checksum/size mismatch fails closed and never silently substitutes the other
  representation.
- [x] **Software-verified:** Authorized/capable sessions expose explicit create,
  list, copy/share, and confirmation-gated revoke operations with Never, 1-day,
  7-day, 30-day, and custom expiry serialization.
- [x] **Software-verified:** Public-link UI explains unauthenticated bearer access
  and the selected representation; app credentials are not embedded in the URL.
- [x] **Software-verified:** Unsupported schema/capability and insufficient
  permission states fail closed and invalidate stale capability evidence where
  appropriate.
- [x] **Software-verified:** Prepared files are profile/operation scoped, private,
  size-bounded, redirect-safe, verified, lifecycle-guarded, and cleaned according
  to bounded retention.
- [x] **Software-verified:** Automated tests cover explicit representation/no
  fallback, checksum verification, permission/capability gates, expiry, revocation,
  page-aware search/highlighting, private file bounds, and stale-profile fencing.
- [ ] **External/manual:** Complete physical-device viewer search/highlight
  alignment, large-PDF cancellation, scanned-PDF behavior, printing, OS sharing,
  biometric return, and temporary-file cleanup on Android/iOS, plus create/list/
  copy/share/expiry/concurrent-revoke/permission-failure workflows on a live
  Paperless server and web-UI readback.

## Issue #23 — Paperless 3-era capabilities

Primary local evidence: `tests/paperless-advanced.test.mjs`,
`tests/tag-hierarchy.test.mjs`, `tests/document-production.test.mjs`,
`tests/pdf-viewer-workflows.test.mjs`, `tests/task-center-foundation.test.mjs`,
`tests/upload-queue-worker.test.mjs`, `src/lib/paperless-capabilities.ts`, and
`src/lib/paperless-advanced.ts`.

- [x] **Software-verified:** Nested tags preserve visible hierarchy identity,
  parent/children/path/depth, render/search/collapse by safe ancestry, exclude
  private/malformed ancestors, reject cycles, and verify creates/moves by readback.
- [x] **Software-verified:** Authorized users can load and edit document owner and
  full user/group view/change permissions with explicit merge/replace semantics.
- [x] **Software-verified:** Permission replacement requires explicit self-lockout
  confirmation and canonical owner/ACL readback before local acceptance.
- [x] **Software-verified:** Duplicate task/result identities appear in Task Center
  and document review/navigation without automatic delete or merge behavior.
- [x] **Software-verified:** AI suggestions require advertised schema/runtime and
  change permission, remain separate bounded untrusted data, intersect catalog
  identities, and apply only explicitly accepted fields without mobile-to-provider
  content or credential traffic.
- [x] **Software-verified:** Reorder, rotate, delete, split, and merge use
  independently gated API-10 PDF-operation adapters, detail/permission preflight,
  page-plan validation, and explicit destructive/metadata-source choices rather
  than deprecated bulk-edit actions.
- [x] **Software-verified:** Correlated long-running PDF operations persist task
  IDs and resume through the profile-scoped Task Center; ambiguous/unavailable
  correlation becomes an honest attention item instead of fabricated success.
- [x] **Software-verified:** Unsupported/unauthorized capabilities return typed
  per-feature explanations on older schemas and restricted accounts.
- [x] **Software-verified:** Capability discovery/cache state is schema-first,
  profile/fingerprint scoped, time bounded, and invalidated on server changes and
  relevant permission/endpoint/schema errors.
- [x] **Software-verified:** Automated coverage includes malformed/deep/private
  hierarchies, concurrent tag moves, permission conflicts/self-lockout/readback,
  duplicate results, hostile AI values, exact task correlation, Paperless 3.0.5
  PDF permission matrices, failed/concurrent PDF jobs, restart, and profile
  isolation.
- [ ] **External/manual:** Run the complete matrix against at least one declared
  older supported Paperless server (minimum documented baseline 3.0.0) and one
  current 3.0.x server with full/restricted accounts. Exercise nested/private tags,
  owner/ACL editing, genuine duplicates, advertised server-hosted AI, every PDF
  operation, failed/concurrent tasks, app restart/process death, metadata and
  permission preservation, and physical Android/iOS Task Center recovery.
