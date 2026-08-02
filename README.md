# Folio for Paperless

<p align="center">
  <img src="docs/showcase/banner.svg" alt="Folio for Paperless — Paperwork, minus the work" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/Kirari04/folio-paperless/actions/workflows/ci.yml"><img src="https://github.com/Kirari04/folio-paperless/actions/workflows/ci.yml/badge.svg?branch=dev" alt="CI status" /></a>
  <a href="https://github.com/Kirari04/folio-paperless/releases/latest"><img src="https://img.shields.io/github/v/release/Kirari04/folio-paperless?display_name=tag&sort=semver" alt="Latest release" /></a>
</p>

Folio is a clean, mobile-first client for [Paperless-ngx](https://docs.paperless-ngx.com/).
It is built with Expo SDK 57 and React Native. Folio is an independent community project and is
not affiliated with or endorsed by the Paperless-ngx project.

> [!IMPORTANT]
> Folio is under active development. Keep reliable backups of your Paperless data and review
> destructive actions carefully.

## What is included

- A focused home dashboard with global search, inbox status, and recent documents.
- A searchable, filterable document library with list and grid views.
- A guided inbox triage flow that removes the Paperless `inbox` tag when filed.
- Native camera scanning, file/share intake, reusable metadata presets, and a restart-safe
  multi-file upload queue.
- Authenticated thumbnails, full OCR text, title/date/correspondent/type/tag editing, and tag creation.
- Multi-select bulk actions, saved-view CRUD, nested tags, catalog management, ownership,
  object permissions, duplicates, server-hosted AI suggestions, and current PDF operations.
- Per-document notes and full version history, including replacement uploads, labels, previews, and export.
- Recoverable deletion with a dedicated Paperless trash screen for restore and permanent erase.
- Offline metadata and pinned files, background reconciliation, a persistent Task Center,
  PDF search/printing, explicit representation export, and public-link management.
- Optional biometric locking and local notifications when an upload finishes processing.
- GitHub Releases with a signed Android APK, an unsigned iPhone IPA, checksums, an AltStore/SideStore source, and Android update checks.
- Secure routes, notification routing, shortcuts, opt-in OS search, privacy-minimal widgets,
  and separate GitHub/store distribution flavors.
- Reduce-Motion-aware page transitions, tactile press feedback, semantic haptics, and animated state changes.
- Multiple profile-scoped connections using tokens, password/OTP exchange, OIDC with PKCE,
  approved custom headers, or native mutual TLS identities.
- System/light/dark appearance, English/German localization, and locale-aware formatting.
- A polished demo workspace so the product can be evaluated without a server.

## Inside Folio

<p align="center">
  <img src="docs/screenshots/home.svg" alt="Folio home dashboard in demo mode" width="23%" />
  <img src="docs/screenshots/library.svg" alt="Folio document library in grid view" width="23%" />
  <img src="docs/screenshots/inbox.svg" alt="Folio quick-triage inbox" width="23%" />
  <img src="docs/screenshots/document.svg" alt="Folio document details and preview" width="23%" />
</p>

<p align="center">
  <sub>Dashboard · Grid library · Quick triage · Document details</sub>
</p>

## Requirements

- Node.js 22.13 or newer and npm (CI uses Node.js 24)
- Android 7/API 24 or newer, with Android SDK/compile target 36 and Android Studio for development
- iOS 16.4 or newer, with Xcode 26.4 or newer on macOS for development
- A Paperless-ngx 3.0.0+ server with REST API v10 for live data (optional; Folio includes a demo mode)

Folio uses native modules for document scanning and PDF viewing, so it requires an Expo
development build. It does not run completely in Expo Go.

## Distribution

Each [GitHub Release](https://github.com/Kirari04/folio-paperless/releases) contains a signed
universal Android APK, an unsigned iPhone IPA, a SHA-256 checksum for each file, and an
`altstore-source.json` manifest. Folio is not distributed through Google Play or the App Store.

The IPA intentionally contains no Apple provisioning profile or code signature. It cannot be
installed directly on an iPhone: sign it with your own Apple ID or developer certificate using a
sideloading tool, then install the signed copy. The IPA targets iPhone only and does not require
the project maintainers to hold or distribute Apple credentials.

### Install with AltStore or SideStore

The stable Folio source URL is:

```text
https://github.com/Kirari04/folio-paperless/releases/latest/download/altstore-source.json
```

Add that URL as a source in AltStore Classic or SideStore. The same source works in both apps and
offers future Folio versions as updates. SideStore users can also open this URL on their iPhone:

```text
sidestore://source?url=https%3A%2F%2Fgithub.com%2FKirari04%2Ffolio-paperless%2Freleases%2Flatest%2Fdownload%2Faltstore-source.json
```

The generated source is checked against the IPA's bundle ID, version, build number, minimum iOS
version, size, SHA-256 digest, and privacy permissions before a release can be published. It
deliberately omits `marketplaceID` because Folio is not notarized for an alternative marketplace.
Signing validity, refresh requirements, and app limits depend on the Apple account and sideloading
tool. Follow the current [AltStore](https://faq.altstore.io/altstore-classic/how-to-install-altstore-macos)
or [SideStore](https://docs.sidestore.io/docs/installation/prerequisites) setup guide.

A separate store
flavor disables the updater capability and UI, excludes the native updater module, and blocks
`REQUEST_INSTALL_PACKAGES`; the main-ref-restricted, environment-gated manual workflow can produce
a Play AAB and iOS device archive once the `store-release` environment and secrets are configured.
It does not submit them. This repository does not claim that store candidates have been signed,
device-tested, or published.

Signed release builds check GitHub Releases once per day and also provide a manual check in
**Settings → Software updates**. Folio never installs silently: it downloads only after confirmation,
verifies the SHA-256 digest, package ID, version, and official signing certificate, then hands the
APK to Android's system installer for final approval. The first updater-enabled release must be
installed manually; later signed releases can update from inside Folio.

Development builds and GitHub release APKs use different signing identities. Android will not
install one as an update over the other, so the in-app updater is intentionally disabled in
development builds. Keep the development build if it contains Paperless credentials, and test a
release on a clean emulator or spare device.

## Run on Android

```bash
npm install
npx expo run:android
npx expo start --dev-client
```

`npx expo run:android` builds and installs the native app. After that, start Metro with
`npx expo start --dev-client` and open the installed development build. A physical device is
recommended for scanning.

## Run on iOS

On macOS with Xcode installed:

```bash
npm install
npx expo run:ios
npx expo start --dev-client
```

Processing notifications are local. Remote push notifications are intentionally not configured.
The iOS project therefore omits the Apple push entitlement so personal-account signing does not
request an unused capability.
The first GitHub-distributed iOS build is iPhone-only and requires an HTTPS Paperless address with
a certificate trusted by the device. See the [iOS release-readiness checklist](docs/ios-release-readiness.md)
for signing, sideloading, and the physical-device release gate.

## Connect Paperless

Open **Settings → Connections**, add a profile, choose an authentication method, and run the real
connection test before saving. Folio supports API token, Paperless username/password with optional
OTP, OIDC authorization code with PKCE, approved custom authentication headers, and native mTLS.
Authenticated Paperless JSON API requests send `Accept: application/json; version=10`.

Paperless tokens are available from **My Profile** in the Paperless web app. Native secrets use
`expo-secure-store`; mTLS key material stays in the OS identity store. Web builds are token-only and
intended for development/demo use. Credentials never enter URLs, logs, notifications, widgets, or
OS search. See [authentication profiles](docs/authentication-profiles.md) and
[storage and cleanup](docs/storage-and-security.md).

Folio never writes a server address or token into the source tree. Do not commit personal `.env`
files, signing keys, or exported Paperless data when contributing.

See [Paperless compatibility](docs/paperless-compatibility.md) for the tested API matrix,
capability negotiation, PDF task correlation, and the remaining live-server QA requirements.

## Documentation

- [Authentication profiles](docs/authentication-profiles.md)
- [Local storage, migrations, and cleanup](docs/storage-and-security.md)
- [Appearance and localization](docs/appearance-and-localization.md)
- [Platform integrations and distribution](docs/platform-integrations-and-distribution.md)
- [Native platform runtime](docs/native-platform-runtime.md)
- [Paperless compatibility](docs/paperless-compatibility.md)
- [Privacy policy](docs/privacy-policy.md)
- [Issues #14–#23 verification record](docs/issue-14-23-progress.md)

## Useful checks

```bash
npm run typecheck
npm run lint
npm test
npx expo install --check
npx expo-doctor
npx expo export --platform web
npm run assert:distribution-config
npm run assert:autolinking
npm run assert:store-metadata
```

## Development workflow

The persistent branches are protected. Create feature and fix branches from `dev`, open a pull
request back to `dev`, and squash merge after `CI / Required checks` passes. Promotions from
`dev` to `main` use merge commits so Release Please can calculate the next semantic version from
the individual Conventional Commits.

Release Please opens the version/changelog pull request on `main`. Merging that pull request
builds and verifies both the signed Android APK and unsigned iPhone IPA, then publishes them only
after both artifacts and their checksums are present. See [CONTRIBUTING.md](CONTRIBUTING.md) for
branch naming, accepted PR titles, merge methods, and release recovery.

## License

[MIT](LICENSE)
