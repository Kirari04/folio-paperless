# Folio for Paperless privacy policy

Last updated: August 2, 2026

Folio for Paperless is a client for a Paperless-ngx server chosen and controlled by the user. Folio does not operate an intermediary document service. The app connects directly to the server URL that a user configures.

## Data handled by the app

Folio may process Paperless-ngx account credentials, server URLs, document metadata, document files and previews, task status, inbox counts, and locally selected files. This data is used to provide the client features the user requests. Credentials and server URLs are not placed in notifications, widgets, OS search entries, in-app route URLs, analytics events, or logs by these integrations.

Native account secrets use operating-system protected storage. Web builds are development/demo surfaces and store API tokens in origin-scoped browser `localStorage`. Local document and task data is isolated by profile. Profile removal always revokes that profile's notification routing records. Removing or switching the active profile reconciles OS search and widget state; removing an inactive profile does not unnecessarily reset the active widget. The storage and deletion model is described in [storage-and-security.md](storage-and-security.md).

## Notifications, widgets, and OS search

Notifications are redacted by default. They use opaque profile and item identifiers only for in-app routing. A user may explicitly choose to show a document title; server names, server URLs, notes, OCR text, credentials, and file contents are never included.

The iOS widget stores only a bounded schema containing a locked/no-data state or an inbox count, a sync timestamp, and the fixed Quick Scan route. The Android widget persists only a locked/no-data/ready state and a capped inbox count; its fixed Quick Scan destination is part of the app code rather than persisted user data. When Folio is locked or signed out, each widget is replaced with a locked snapshot. Neither contains document titles, profile identifiers, or server details.

OS search indexing is off by default. If enabled, it is bounded and profile scoped. Minimal mode uses the generic title “Folio document.” The optional title mode may use a sanitized document title. OCR text, notes, custom fields, correspondents, tags, server details, credentials, and document files are not indexed. Locking, signing out, disabling indexing, or deleting a profile removes affected entries. On Android, this integration requires Android 12 or newer and otherwise remains explicitly unavailable.

## Network services and third parties

Folio communicates with the Paperless-ngx server configured by the user and with operating-system services needed for features the user enables. OIDC profiles also communicate with the identity provider the user configures. Updater-enabled GitHub builds contact GitHub Releases to check and download an explicitly approved update; store builds exclude that native updater capability. App stores and GitHub may process download and diagnostic data under their own policies. Folio does not add an advertising SDK or sell personal data.

Preview, save, print, and share workflows may prepare sanitized, profile-scoped files in app-private temporary storage. Folio removes handoff copies when the platform permits and performs best-effort stale cleanup on later relevant operations; mobile OS share/print consumers can temporarily retain their own copies. A Paperless public link is a bearer URL: anyone who receives it can access the explicitly selected Original or Archive representation without Folio authentication until it expires or is revoked. Folio creates and copies such a link only after an explicit user action and never places the user's app token in it.

Remote push notification delivery is not enabled by the platform foundation described here. Local notifications may be scheduled on the device. If a future release adds remote push, its provider, payload policy, and user controls must be documented before it is enabled.

## User controls and deletion

Users can disable notifications and OS search access in operating-system settings. In-app privacy settings control metadata disclosure where supported. Removing a profile always deletes its locally held credentials and revokes its notification routing records. Active-profile removal or switching reconciles the global OS search and widget state. The user explicitly chooses whether profile-scoped cached metadata, tasks, staged files, and offline files are retained for recovery or deleted. Uninstalling Folio removes app-controlled local data subject to the operating system’s backup and retention behavior.

## Contact

Questions and privacy requests can be submitted through [Folio’s public issue tracker](https://github.com/Kirari04/folio-paperless/issues). Do not include credentials, server URLs, document content, or other sensitive data in an issue.
