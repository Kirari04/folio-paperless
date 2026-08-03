# Platform integrations and distribution

Folio’s platform boundary treats every URL, notification response, shortcut, OS search item, and widget interaction as untrusted input. Only the custom `folio-paperless` scheme and a fixed route allowlist are accepted. URLs are length bounded, path and query parameters are strict, duplicate or unknown parameters are rejected, and document routes require an opaque profile ID.

## Route and lock contract

Supported routes are Home, Library, Inbox, Scanner, Settings, Search, and a profile-scoped document ID. Cold-start and warm-start callers use the same parser and resolver. Navigation waits for bootstrap, profile selection, and biometric unlock. A route targeting a different known profile waits for an explicit profile switch; unknown profiles and inaccessible, deleted, or missing documents fall back to Home.

The mounted routing gateway uses the same deferred queue for cold links, warm links, notification responses, shortcuts, Spotlight, and AppSearch handoffs. Expo SDK 57's synchronous `getLinkingURL()` cache is cleared with `clearInitialURL()` before a URL receives routing authority, and warm URL events clear the same cache before entering the queue. A handled URL therefore cannot replay when the gateway unmounts for biometric lock and mounts again after unlock. Deferred routes are bounded to 16 entries, expire after ten minutes, deduplicate canonical targets, and can be cleared entirely or per profile. A second event cannot overwrite an earlier route that is still waiting for bootstrap or unlock.

Notification responses are cleared through Expo SDK 57's synchronous `clearLastNotificationResponse()` API before the first asynchronous registry lookup. The response identifier must consume a matching profile-scoped persistent handle exactly once, its strict payload must match the scheduled payload, and only the default tap action is routed. Rejected, tampered, unsupported-action, and already-consumed responses cannot replay navigation after restart.

Universal links and Android App Links are intentionally not configured. The project has no verified owned web domain or association files, so the app must not claim HTTPS links.

## Privacy boundaries

- Notifications are redacted by default and contain only a versioned allowlisted routing payload. Stored routing handles are bounded and revocable per profile.
- Quick Scan, Inbox, and Search are the only static app shortcuts.
- OS search indexing is opt-in, bounded, profile scoped, permission filtered, and revoked on lock, sign-out, disable, or profile removal. Only documents returned by the authenticated Paperless permission-filtered documents query receive a verified `canView` marker. Revoked rows and legacy cached rows without that marker fail closed before index reconciliation; full synchronization replaces the cached workspace and removes documents no longer visible to the account. A 401/403 workspace refresh also revokes the marker in memory and in the persisted workspace before exposing another index snapshot, so account-wide permission loss does not leave discoverable titles across restart. iOS uses a named Core Spotlight index protected with `NSFileProtectionComplete`; Android uses system-visible Platform AppSearch on Android 12/API 31 and newer and reports an explicit unsupported capability on older versions. OCR, notes, credentials, server data, files, and custom secrets never enter either index.
- The iOS widget is configured without push or frequent updates. Its shared snapshot contains only a locked/no-data state or a capped inbox count, timestamp, and fixed Quick Scan URL. The Android `AppWidgetProvider` persists only the state and capped inbox count in private preferences; its fixed Quick Scan route lives in native code. Neither widget contains a document title, profile ID, or server detail.
- The generated iOS share extension stages files under complete-until-first-user-authentication data protection. Copy failures use a generic message and do not log provider filenames, destination paths, or system error descriptions.

The TypeScript domain contracts do not grant OS permissions or bypass app authentication. The native search module starts locked, validates every identifier and route again, and replaces the complete active-profile snapshot so stale entries cannot survive a restart or profile switch. Native background callbacks revoke the same named Core Spotlight/AppSearch index when biometric background locking is enabled. All native-originated navigation still enters the shared parser/resolver below the lock gate.

## Native support matrix

| Feature | iOS | Android |
| --- | --- | --- |
| OS search | Core Spotlight named index with complete protection | Platform AppSearch, API 31+; schema is displayed by the system |
| Static shortcuts | App-delegate subscriber captures cold and warm launches | Android static shortcut deep links |
| Inbox widget | Expo WidgetKit target, no push/frequent updates | Native `AppWidgetProvider`, state/count only |
| Share staging | App-group extension with complete-until-first-unlock protection | App-private intake staging |
| OIDC RS256 fallback | `Security.framework` verifies signatures | Java `Signature` verifies signatures |

The native implementation and manual validation commands are documented in [native-platform-runtime.md](native-platform-runtime.md).

## Distribution flavors

`FOLIO_DISTRIBUTION=github` is the default flavor. It retains the repository’s explicitly signed universal APK pipeline and the local APK updater, including `REQUEST_INSTALL_PACKAGES` on Android.

`FOLIO_DISTRIBUTION=store` is the store flavor. It blocks `REQUEST_INSTALL_PACKAGES`, disables the updater capability marker, removes the GitHub signing plugin, and configures the generated Android `expoAutolinking.exclude` list during native prebuild. The checked-in `package.json` deliberately has no `folio-updater` exclusion, so GitHub builds resolve the updater. The store config plugin writes the exclusion before both React Native and Expo module resolution; EAS's post-install hook then verifies the generated Gradle guard and a store resolver result without modifying `package.json`. Manifest guards and post-build artifact scans fail if the permission or updater leaks into the candidate.

For a local store-flavored Android build, keep prebuild and Gradle under the same distribution environment and run the read-only post-prebuild verifier before Gradle:

```sh
FOLIO_DISTRIBUTION=store npx expo prebuild --platform android --clean --no-install
FOLIO_DISTRIBUTION=store node scripts/prepare-store-autolinking.mjs
FOLIO_DISTRIBUTION=store ./android/gradlew -p android :app:bundleRelease
```

The generated `settings.gradle` carries the store exclusion. Running ordinary GitHub/default prebuild regenerates settings without it; no validation command mutates the source package manifest.

`eas.json` defines a Play App Bundle profile and a non-simulator iOS archive profile with remote version management. `.github/workflows/store-release.yml` is manual, restricted to a full immutable commit reachable from `main`, and uses the protected `store-release` environment. Configure required reviewers for that environment and provide:

- secret `EXPO_TOKEN` scoped to the correct Expo account;
- variable `EAS_PROJECT_ID` for the EAS project;
- variable `EXPO_OWNER` for that project owner;
- variable `ANDROID_STORE_CERT_SHA256` for the expected Play upload certificate;
- variable `IOS_TEAM_ID` for the expected Apple Developer team.

The workflow requests remotely signed candidates, then checks the Android certificate, bundle contents, iOS code signature, bundle ID, provisioning team, and flavor leakage before uploading seven-day CI artifacts. It does not submit or publish them. Store submissions remain an explicit reviewed action after device QA and metadata review.

`store/metadata` contains complete English and German listing text and release notes. `store/privacy-disclosures.json` records the direct-user-server data model, disabled remote push/tracking/advertising state, and disclosures for notifications, OS search, widgets, shortcuts, and file sharing. Both signed-candidate jobs run `scripts/assert-store-metadata.mjs`; final screenshots and store-console questionnaires remain manual because they must reflect the actual release-signed build and current store wording.

No repository state claims that signing credentials, a verified domain, or published store artifacts exist. Those are deployment-time facts validated by the protected workflow.

## Release QA checklist

Test on physical Android and iOS devices using release candidates:

1. Open every custom route from a terminated app and from a running app.
2. Verify bootstrap, profile selection, and biometric lock defer routing and reveal no protected data.
3. Verify unknown profiles and missing, deleted, or unauthorized documents fall back safely.
4. Tap each notification in redacted and optional title modes; confirm the response is consumed once and cleared.
5. Test Quick Scan, Inbox, and Search shortcuts from locked, signed-out, and signed-in states.
6. Enable OS search, verify only allowed metadata appears, then background with biometric locking enabled, lock, sign out, disable indexing, switch/remove a profile, and confirm entries are revoked after each action. On Android 11 and older, confirm the UI reports OS search as unsupported.
7. Confirm both platform widgets show the locked state while protected and never reveal a title, profile, server, timestamp, or route on Android.
8. On the Play candidate, confirm no self-update UI appears and Android settings do not list installation of unknown apps for Folio.
9. Install the GitHub APK candidate and verify updater behavior remains isolated to that flavor.
10. Re-run accessibility, localization, offline, and upgrade-path checks before submission.
