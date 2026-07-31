# Folio for Paperless

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
- Native camera scanning and PDF/image import, with upload task polling and failure states.
- Authenticated thumbnails, full OCR text, title/date/correspondent/type/tag editing, and tag creation.
- Saved views, storage paths, archive serial numbers, and every Paperless custom-field type.
- Per-document notes and full version history, including replacement uploads, labels, previews, and export.
- Recoverable deletion with a dedicated Paperless trash screen for restore and permanent erase.
- Native file sharing/export plus document reprocessing and guarded deletion.
- Optional biometric locking and local notifications when an upload finishes processing.
- Reduce-Motion-aware page transitions, tactile press feedback, semantic haptics, and animated state changes.
- Direct Paperless-ngx API v10 connectivity with credentials stored in Secure Store.
- A polished demo workspace so the product can be evaluated without a server.

## Requirements

- Node.js and npm
- Android Studio for Android development, or Xcode for iOS development
- A Paperless-ngx server and API token for live data (optional; Folio includes a demo mode)

Folio uses native modules for document scanning and PDF viewing, so it requires an Expo
development build. It does not run completely in Expo Go.

## Run on Android

```bash
npm install
npx expo run:android
npx expo start --dev-client
```

The first command builds and installs the native app. After that, start Metro with the second
command and open the installed development build. A physical device is recommended for scanning.

## Run on iOS

On macOS with Xcode installed:

```bash
npm install
npx expo run:ios
npx expo start --dev-client
```

Processing notifications are local. Remote push notifications are intentionally not configured.

## Connect Paperless

Open **Settings**, enter the base URL of your Paperless-ngx instance and an API token, then
tap **Test & connect**. Folio sends `Accept: application/json; version=10` and
`Authorization: Token …` with requests.

Paperless tokens are available from **My Profile** in the Paperless web app. On native platforms
the token is stored with `expo-secure-store`; web builds use browser-local storage and are intended
for development/demo use.

Folio never writes a server address or token into the source tree. Do not commit personal `.env`
files, signing keys, or exported Paperless data when contributing.

## Useful checks

```bash
npx tsc --noEmit
npm run lint
npx expo-doctor
npx expo export --platform web
```

## License

[MIT](LICENSE)
