# iOS release readiness

Folio's iOS distribution is an unsigned iPhone build attached to GitHub Releases. It is not an App Store or TestFlight release. The IPA must be signed with the tester's own Apple ID or developer certificate before installation; a stock iPhone cannot install the unsigned artifact directly.

## Included in the app

- iPhone-only targeting. iPad remains a future layout project rather than an accidental enlarged-phone promise.
- Native stack presentation for document detail, scanner, and trash screens, including the standard iOS interactive back gesture.
- A dedicated scan action outside the destination tabs, with SF Symbols in the iOS tab bar.
- File-based, native iOS assembly for scan PDFs with no Folio-imposed page limit. ImageIO downsamples and decodes one page at a time, each PDF page preserves the detected document shape, and JavaScript never holds the scan as base64.
- A privacy curtain as soon as iOS becomes inactive, before the app-switcher snapshot, plus biometric relocking when enabled.
- HTTPS-only Paperless URLs on iOS, device-trust guidance for certificate failures, and a local-network permission explanation.
- An aggregate Apple privacy manifest based on the required-reason declarations in the installed Expo and React Native dependencies.
- iOS-specific status-bar styling, no unused microphone permission, automatic build numbers derived from the package version, higher-contrast secondary colors, and larger effective press targets.
- Android-only in-app updating. iOS links to GitHub Releases and does not initialize or advertise the APK installer.
- Local processing notifications without the unused Apple remote-push entitlement, keeping personal-account resigning simple.

## Deliberately not required

The following items from the earlier App Store audit do not apply to unsigned GitHub distribution:

- Apple Developer Program enrollment, App Store Connect records, TestFlight, EAS submit profiles, or production signing credentials
- App Store privacy/support URLs, listing copy, age rating, review notes, and store screenshots
- App Store privacy nutrition-label answers or submission-time privacy validation
- iPad screenshots and iPad multitasking QA

Dark appearance and a complete migration of content UI to native navigation bars are product enhancements, not iOS release blockers. Folio intentionally remains a light, branded interface for this release. Its platform navigation and system-facing controls still follow iOS behavior.

## Build and publication contract

- Every pull request builds an unsigned Release IPA on a GitHub-hosted macOS 26 runner using Xcode 26 or newer. The IPA and SHA-256 file are retained as an Actions artifact for seven days so the exact PR can be signed and tested on hardware.
- Release Please creates an unpublished draft. Android and iOS build independently from the exact release tag and upload their verified assets to that draft.
- The iOS job rejects a mismatched bundle ID, version, build number, device family, or architecture; a missing JavaScript bundle or privacy manifest; and any app signature or embedded provisioning profile.
- The iOS job generates `altstore-source.json` from the archived app metadata and IPA. The source is compatible with AltStore Classic and SideStore, declares no special entitlements or notarized-marketplace ID, and includes the exact privacy permissions, minimum iOS version, size, and SHA-256 digest.
- A final job verifies the signed APK, unsigned IPA, both checksum files, and AltStore/SideStore source are present and non-empty before publishing. If either platform fails, the release remains a draft and can be rebuilt with `rebuild_tag=vX.Y.Z`.
- Release assets are named `Folio-vX.Y.Z-ios-unsigned.ipa` and `Folio-vX.Y.Z-ios-unsigned.ipa.sha256`.
- The stable source URL is `https://github.com/Kirari04/folio-paperless/releases/latest/download/altstore-source.json`. Each new source retains compatible older entries so AltStore and SideStore can offer updates and fallback builds.

## Physical-device release gate

Before publishing the first IPA, download the PR's unsigned IPA artifact, sign it locally, and exercise it on at least one smaller iPhone and one current standard/large iPhone:

- Fresh install, launch, demo workspace, connect, disconnect, and relaunch
- Trusted public HTTPS server and trusted local-network HTTPS server
- Clear rejection copy for HTTP and an untrusted/self-signed certificate
- Camera denial, Settings recovery, smart-scan cancellation, backgrounding, and low-storage failure
- 1-page, 25-page, and 50-or-more-page VisionKit scans on the oldest supported iPhone; verify PDF page order, orientation, receipt/document proportions, readability, stable memory use, upload progress, retry reuse, and cleanup after failure
- App switcher, Control Center, notification shade, Face ID success/cancel/fallback, and biometric lock disabled/enabled
- Edge-swipe back from document and trash screens; swipe/dismiss and explicit close paths from scanning
- VoiceOver reading order, Reduce Motion, Bold Text, Button Shapes, and the largest accessibility text sizes
- Light status bar on camera/preview surfaces and dark status bar on light content surfaces
- Upgrade over an older build without losing the Secure Store token or preferences
- Add the stable source in current AltStore Classic and SideStore versions; install, launch, refresh/resign, and upgrade Folio through each tool without losing the Secure Store token or preferences
- Confirm the store listing shows only Camera, Face ID, and Local Network permissions, shows no special entitlements, selects only compatible iOS versions, and rejects a deliberately altered IPA checksum

The shared CI gate runs `npm ci`, typechecking, linting, tests, Expo diagnostics, and platform builds. The iOS job performs a clean prebuild, CocoaPods install, device Release archive, unsigned-package verification, and checksum generation.
