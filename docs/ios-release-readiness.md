# iOS release readiness

Folio's first iOS distribution is an unsigned iPhone build attached to GitHub Releases. It is not an App Store or TestFlight release. The build workflow belongs in a follow-up change; this document records the app-side contract that should be verified before that workflow ships.

## Included in the app

- iPhone-only targeting. iPad remains a future layout project rather than an accidental enlarged-phone promise.
- Native stack presentation for document detail, scanner, and trash screens, including the standard iOS interactive back gesture.
- A dedicated scan action outside the destination tabs, with SF Symbols in the iOS tab bar.
- File-based, native iOS assembly for multi-page scan PDFs. Scanned images are decoded one at a time and a scan is limited to 24 pages; JavaScript no longer holds a multi-page base64 document.
- A privacy curtain as soon as iOS becomes inactive, before the app-switcher snapshot, plus biometric relocking when enabled.
- HTTPS-only Paperless URLs on iOS, device-trust guidance for certificate failures, and a local-network permission explanation.
- An aggregate Apple privacy manifest based on the required-reason declarations in the installed Expo and React Native dependencies.
- iOS-specific status-bar styling, no unused microphone permission, automatic build numbers derived from the package version, higher-contrast secondary colors, and larger effective press targets.
- Android-only in-app updating. iOS links to GitHub Releases and does not initialize or advertise the APK installer.

## Deliberately not required

The following items from the earlier App Store audit do not apply to unsigned GitHub distribution:

- Apple Developer Program enrollment, App Store Connect records, TestFlight, EAS submit profiles, or production signing credentials
- App Store privacy/support URLs, listing copy, age rating, review notes, and store screenshots
- App Store privacy nutrition-label answers or submission-time privacy validation
- iPad screenshots and iPad multitasking QA

Dark appearance and a complete migration of content UI to native navigation bars are product enhancements, not iOS release blockers. Folio intentionally remains a light, branded interface for this release. Its platform navigation and system-facing controls still follow iOS behavior.

## Physical-device release gate

Before publishing the first IPA, exercise a release build on at least one smaller iPhone and one current standard/large iPhone:

- Fresh install, launch, demo workspace, connect, disconnect, and relaunch
- Trusted public HTTPS server and trusted local-network HTTPS server
- Clear rejection copy for HTTP and an untrusted/self-signed certificate
- Camera denial, Settings recovery, smart-scan cancellation, backgrounding, and low-storage failure
- 1-page and 24-page scans; verify PDF page order, orientation, readability, upload progress, and cleanup after failure
- A 25-or-more-page VisionKit scan; verify Folio refuses it with the 24-page explanation rather than attempting PDF assembly
- App switcher, Control Center, notification shade, Face ID success/cancel/fallback, and biometric lock disabled/enabled
- Edge-swipe back from document and trash screens; swipe/dismiss and explicit close paths from scanning
- VoiceOver reading order, Reduce Motion, Bold Text, Button Shapes, and the largest accessibility text sizes
- Light status bar on camera/preview surfaces and dark status bar on light content surfaces
- Upgrade over an older build without losing the Secure Store token or preferences

The future GitHub Action should run `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npx expo-doctor`, and a clean iOS prebuild before compiling the unsigned release artifact.
