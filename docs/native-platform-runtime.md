# Native platform runtime

Folio's `modules/folio-platform` local Expo module is the privacy enforcement boundary for OS search, iOS shortcut delivery, and the Android inbox widget. JavaScript policy filters run first; the native module independently validates its small allowlisted payload and starts in a locked state.

The module also provides an RS256 verification fallback for native OIDC login when WebCrypto is absent. JavaScript selects and validates a single RSA signing JWK and retains all claim validation. Native code receives only the encoded signing input, signature, modulus, and exponent, then verifies SHA-256 with RSA PKCS#1 v1.5 using `Security.framework` on iOS or Java `Signature` on Android. It returns only a boolean and never logs token material or claims.

## OS search

iOS writes to the named `FolioDocuments` Core Spotlight index with `NSFileProtectionComplete`. Each entry contains only an opaque Folio identifier/domain, a sanitized or generic title, and a modification date. Native code validates the URL/profile/document tuple before indexing but does not persist that URL as Spotlight metadata. When a user selects a result, the app-delegate subscriber validates the Spotlight activity identifier and derives the custom route from its opaque components. The subscriber and module use the same named index for background revocation.

Android uses the framework Platform AppSearch service, not an app-local AndroidX database. It is supported only on Android 12/API 31 and newer. The system-displayed `FolioDocument` schema contains a sanitized or generic title and a required Folio custom-route URL. That route contains only validated, opaque profile/document identifiers; it contains no server address, credential, OCR text, correspondent, tag, or filename. The same opaque identity is used for AppSearch's required namespace and document ID. Devices below API 31 and devices without the platform service return a stable unsupported reason.

Reconciliation replaces the entire active-profile snapshot, capped at 250 entries by the current UI policy. Index writes are allowed only while the app is authenticated, unlocked, opted in, and has an active profile. Disable, sign-out, lock-gateway unmount, or missing profile clears the index. Profile switching cannot retain an older profile because every successful reconciliation starts with a full replacement. If biometric background locking is enabled, native lifecycle callbacks lock and clear the index without waiting for JavaScript.

## Shortcuts and navigation

The config plugin generates exactly Quick Scan, Inbox, and Search. Android uses static deep links. On iOS, an Expo app-delegate subscriber captures both the launch-options shortcut used for a terminated app and `performActionFor` events used while the app is alive. Native code maps only known shortcut types to short IDs and ignores shortcut `userInfo`. Delivery is held until the JavaScript routing gateway is mounted beneath the biometric lock, then the same strict external-route resolver handles navigation.

The JavaScript gateway owns a bounded `DeferredExternalNavigationQueue`, rather than one pending React state value, so concurrent cold/warm handoffs cannot replace one another while bootstrap, profile selection, biometric unlock, or an explicit profile switch is pending. It consumes Expo SDK 57's cached linking URL synchronously and clears that native cache before parsing or queuing the URL; warm URL events follow the same clear-before-queue ordering. Gateway remounts after biometric lock therefore cannot replay a handled link. Local notification taps additionally require a one-time registered notification handle and an exact allowlisted payload match. Expo's last response is cleared synchronously before the registry lookup, preventing a later response from being cleared by completion of an older lookup.

## Widgets

The iOS WidgetKit target has push and frequent updates disabled and consumes the bounded shared snapshot defined in `widget-privacy.ts`. The Android `AppWidgetProvider` stores only `state` and `inbox-count` in private preferences. The fixed Quick Scan URL is native code, not stored snapshot data. Invalid/missing state, an invalid count, sign-out, or protected backgrounding produces the locked presentation.

## iOS share staging

Expo Sharing generates the share extension during prebuild. The checked-in Expo Sharing package patch emits a generic copy-error message without the provider filename, path, or native error description. `withFolioPlatformIntegrations` runs an iOS finalized mod after generation, adds `com.apple.developer.default-data-protection = NSFileProtectionCompleteUntilFirstUserAuthentication` to the extension entitlement, and verifies the generic-log source contract. Prebuild fails if the expected extension files or source contract disappear so an SDK template change cannot silently remove this hardening.

Incoming iOS sharing remains experimental in Expo SDK 57. Release acceptance
therefore requires physical-device extension-to-main-app handoff tests from Files,
Mail/browser, and a third-party scanner; generated configuration and unit tests do
not substitute for that OS-level verification.

After the main app streams a provider file into its persistent private staging
directory, or commits an explicitly pinned offline file, the app calls
`FolioPlatform.excludeFileFromBackupAsync`. The module validates that the resolved
regular file remains below `Documents/folio/profiles`, applies
`NSURLIsExcludedFromBackupKey`, and reads the value back. Intake and pinned-file
creation fail closed and remove the new copy if that protection cannot be
established. Android uses its application-wide backup prohibition instead of a
per-file flag.

## Printing result limits

Folio uses Expo Print's SDK 57 `printAsync({ uri })` contract for private,
verified local PDFs. On iOS, Expo rejects with `ERR_PRINT_INCOMPLETE` when the
system sheet is dismissed before printing begins; Folio reports that exact case
as user cancellation and reports other rejections as printer/preparation
failures. On Android, Expo resolves as soon as the native print window opens and
does not report a later dismissal. Folio therefore reports only that the dialog
opened on Android—it does not claim that the job printed or classify a later
dismissal as success or failure.

## Verification

From the repository root:

```sh
npx expo-modules-autolinking resolve --platform android --json
npx expo-modules-autolinking resolve --platform apple --json
npm run assert:autolinking
npx expo prebuild --no-install --platform all
ANDROID_HOME=/path/to/android-sdk ./android/gradlew \
  :folio-platform:compileDebugKotlin \
  :app:processDebugResources \
  :app:compileDebugKotlin
npm test
npm run lint
npx tsc --noEmit
```

An iOS compile still requires macOS with Xcode and CocoaPods. On physical release-candidate devices, test each shortcut from terminated/running and locked/unlocked states; enable both search metadata modes; exercise background, lock, sign-out, profile switch/removal, and disable revocation; verify the unsupported Android path below API 31; add both widgets; and confirm incoming share failures reveal no provider filename or path in device logs.

Implementation references: [Expo SDK 57 linking](https://docs.expo.dev/versions/v57.0.0/sdk/linking/), [Expo SDK 57 Print](https://docs.expo.dev/versions/v57.0.0/sdk/print/), [Expo Modules API](https://docs.expo.dev/modules/module-api/), [Expo app-delegate subscribers](https://docs.expo.dev/modules/appdelegate-subscribers/), [Apple Core Spotlight](https://developer.apple.com/documentation/corespotlight/cssearchableindex), [Apple static shortcuts](https://developer.apple.com/documentation/uikit/uiapplicationshortcutitem), [Apple signature verification](https://developer.apple.com/documentation/security/signing-and-verifying), [Java `Signature`](https://docs.oracle.com/en/java/javase/26/docs/api/java.base/java/security/Signature.html), [Android Platform AppSearch](https://developer.android.com/develop/ui/views/search/appsearch), and [Android app widgets](https://developer.android.com/develop/ui/views/appwidgets/overview).
