# Authentication profiles

Folio stores connection metadata separately from credentials. A profile contains a stable ID, display name, normalized Paperless URL, authentication kind, non-secret authentication metadata, test status, and timestamps. Native API tokens, OIDC access/refresh/ID tokens, and custom header values are stored under that profile ID in Expo SecureStore. Expo SecureStore has no web implementation: the web build is an explicitly unsupported-for-production development/demo surface, remains API-token-only, and stores its token in origin-scoped browser `localStorage` after warning the user that it is not OS-protected. Passwords and one-time passcodes are used only to exchange for an API token and are never retained.

Multiple profiles may point to the same Paperless URL. Their internal IDs keep credentials, repository rows, upload tasks, presets, and offline files isolated. Switching the active profile changes the current destination without deleting another profile's local data. Renames and non-authority metadata updates preserve the ID. Changing a server/auth binding, API token, OIDC session, custom-header value, or mTLS identity creates a fresh internal ID instead of reusing the old authority namespace.

On first launch after upgrading from the legacy single-connection format, Folio
creates one stable default token profile and moves the existing credential into
that profile's native protected record or the web origin-scoped token store. The migration is idempotent and ordered so
an interruption cannot delete the only usable credential. Native repository data
separately advances through the transactional SQLite migrations described in
[storage-and-security.md](storage-and-security.md); unsupported newer or corrupt
schemas are surfaced rather than reset silently.

## Connection workflow

The profile manager requires a real connection test before a changed profile can be saved. The test calls the Paperless API at the configured subpath, rejects redirects, checks API version 10, and distinguishes network/TLS, authentication, permission, redirect, and incompatible-API failures. A failed test does not replace the last known-good profile or secret. Before any new or rebound namespace is visible, Folio writes a bounded protected publication journal containing only the operation/replacement/optional-old IDs, intended-active flag, timestamp, non-secret connection binding, and optional opaque mTLS reference. It contains no token or header value. Folio then publishes inactive metadata and its protected secret. A complete new profile is activated only when requested; a complete rebind retires the exact old ID through the permanent delete-data transaction and activates the exact replacement rather than an arbitrary remaining profile. Startup rolls back incomplete or mismatched replacements and restores the old authority, or completes a fully published replacement. Journal deletion is itself retryable, so process death at metadata, secret, old-removal, activation, or final-clear boundaries cannot leave an unjournaled ambiguous authority.

Supported credential workflows are:

- API token: stored directly in SecureStore after a successful test.
- Paperless username and password: exchanged through Paperless's token endpoint. The password and optional OTP are discarded after the exchange; only the resulting API token is stored.
- OIDC authorization code with PKCE: opened in the system browser. The callback validates state and ID-token claims and verifies an RS256 signature against the issuer's JWKS. Browsers use WebCrypto; native builds fall back to the local `FolioPlatform` verifier (`Security.framework` on iOS and Java `Signature` on Android) when WebCrypto is absent. JWK type, use, algorithm, key operations, unique key ID, base64url encoding, RSA size, and exponent remain validated in JavaScript before only the signing input, signature, modulus, and exponent cross the native boundary. Tokens and claims are never logged by the verifier. When profile credentials are loaded in the foreground, an access token expiring within 60 seconds is refreshed; headless workers do not refresh it. Revocation and the provider logout page are offered when discovery advertises those endpoints.
- Custom headers: only a small explicit set is accepted. Header values are secret, retained only when the user chooses to keep them, and never shown again. An `Authorization` header receives an additional warning.

On web, Folio intentionally exposes API-token profiles only. Browser redirects, CORS, browser-managed TLS, and the lack of an OS credential store make the other flows misleading without a trusted backend. Production authentication support targets the native Android and iOS builds.

## mTLS native design

Folio includes the `FolioMtls` local Expo module in native development and production builds. Browser and Expo Go builds remain explicitly unsupported and fail closed.

- Android asks the system `KeyChain` installer/chooser to install or select a client identity. Folio stores only an opaque alias reference per profile. The identity remains user/device-policy owned, so profile removal forgets the alias but does not silently delete the system credential.
- iOS presents its document picker and secure password alert in native code, calls `SecPKCS12Import`, and stores the identity in the app Keychain with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. PKCS#12 bytes and the password never cross the Expo module boundary. App-owned identities can be deleted after the last referencing profile is removed.
- JavaScript receives only subject, issuer, `notBefore`, expiry, SHA-256 fingerprint, private-key availability, and an opaque reference. Reference-counted cleanup prevents one profile from deleting an identity still used by another profile.
- Connection tests, JSON API traffic, multipart uploads, representation/document downloads, and native PDF cache downloads use the same certificate-aware transport. Calls are cancellable; upload/download progress is emitted by request ID.
- Both native transports constrain identity presentation to the saved HTTPS origin and base subpath, disable redirect following, and retain platform default server trust and hostname verification. There is no TLS-error bypass.

The TypeScript lifecycle and native source contracts are automated in `tests/mtls-native.test.mjs`. This Linux checkout cannot compile or device-test iOS Security/Keychain and `URLSession` behavior, so release acceptance still requires an EAS/Xcode build plus physical-device tests against valid, expired, password-protected, missing-key, and untrusted-server fixtures. Android likewise requires a device test for OEM `KeyChain` chooser behavior.

## Removal and cache ownership

Removing a profile is explicit about local ownership. “Keep local data” removes credentials and the profile while leaving the profile-scoped repository/cache available for recovery tooling. “Delete local data” also removes profile-owned repository rows, pending tasks, presets, and offline files. The exact-path native cleanup manifest is written to SQLite first; the protected store receives only a small journal record that references it. Native profile files are then moved to private quarantine before SQLite atomically deletes the profile rows and writes a permanent minimal tombstone. A failure before that commit restores the quarantine and keeps the profile; after commit, the tombstone permanently rejects stale inserts while profile/runtime revocation, secret deletion, quarantine cleanup, and temporary manifest/journal cleanup are retried to completion. OIDC revocation is best-effort before local removal and never prevents the user from removing credentials from the device.

Authority-changing edits use that same delete-data journal to retire the old ID after the fresh ID is durable. An active edit switches to the fresh ID only after retirement; an inactive edit leaves the unrelated active profile unchanged. Every failure before the durable old-ID revocation restores a usable old foreground credential binding at the current generation; after revocation, the old credential is never re-authorized. mTLS publication, complete profile/secret inventory, and native identity deletion share one async coordinator. Direct and startup cleanup fail closed if any saved mTLS profile lacks an opaque reference. A journaled replacement identity is retained while publication is complete and reclaimed after an incomplete publication is rolled back; reference counting still prevents deletion while any other complete profile uses it.

Settings reports automatic-cache and pinned-file usage separately for the active profile. The automatic-cache quota can be changed, evictable files can be cleared without touching pins, and pinned files require a separate destructive confirmation. Offline files are unavailable on web.
