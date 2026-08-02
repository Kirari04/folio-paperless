# Paperless compatibility

## Supported baseline

Folio requires **Paperless-ngx 3.0.0 or newer** and REST API **version 10**. Every API request sends `Accept: application/json; version=10`; a server that responds with `406 Not Acceptable` is rejected during connection testing. Paperless-ngx 2.20.x and earlier expose API version 9 at most and are therefore outside the supported range.

The semantic version is used only to describe the support boundary. Runtime behavior is gated by the authenticated OpenAPI schema, `OPTIONS` responses, `X-Api-Version`, permissions from UI settings, and feature-specific responses. A restricted account receives the supported subset it can safely use.

Primary references used for the implementation:

- [Paperless-ngx 3.0.5 API documentation](https://github.com/paperless-ngx/paperless-ngx/blob/v3.0.5/docs/api.md)
- [Paperless-ngx 3.0.5 tag serializer and hierarchy view](https://github.com/paperless-ngx/paperless-ngx/blob/v3.0.5/src/documents/serialisers.py)
- [Paperless-ngx 3.0.5 dedicated document-operation views](https://github.com/paperless-ngx/paperless-ngx/blob/v3.0.5/src/documents/views.py)
- [Paperless-ngx 3.0.5 PDF operation implementation](https://github.com/paperless-ngx/paperless-ngx/blob/v3.0.5/src/documents/bulk_edit.py)
- [Paperless-ngx 3.0.5 task model and API](https://github.com/paperless-ngx/paperless-ngx/blob/v3.0.5/src/documents/models.py)

## Compatibility matrix

| Server | API | Expected support | Verification status |
| --- | --- | --- | --- |
| Paperless-ngx 2.20.x and older | 9 or older | Unsupported; connection fails with an API-version explanation | Automated `406`/incompatible-API coverage |
| Paperless-ngx 3.0.0 | 10 | Minimum supported baseline; every optional feature remains schema-, endpoint-, and permission-gated | Automated API-10 fallback/restricted-capability fixtures; live-server QA still required |
| Paperless-ngx 3.0.5 | 10 | Current reference target for nested tags, task v10, Paperless AI, file versions, and dedicated PDF operations | Automated 3.0.5 schema/response fixtures; source contract reviewed at tag `v3.0.5`; live-server QA still required |
| Future Paperless/API-10 server | 10 | Supported only for capabilities still advertised by schema/runtime probes | Cache invalidates and discovery reruns on relevant `401`, `403`, `404`, `405`, `406`, `415`, schema-response, and explicit API/schema incompatibility errors |

## PDF task behavior

The API-10 PDF endpoints return `{"result":"OK"}` after scheduling one or more `consume_file` jobs; that response does **not** mean the edit has completed. Folio takes a profile-scoped task snapshot before the operation, serializes local PDF submissions for the profile/API instance, and correlates new task rows by the deterministic filenames used by Paperless 3.0.5. Only unique matches become persistent task IDs and are then polled by Task Center across restart.

If the task feed is unavailable, no matching task appears, or concurrent server activity makes a match ambiguous, Folio stores a non-retryable attention item. It never fabricates a task ID or reports the PDF operation as complete. The user must inspect the server task list before deciding whether a new operation is safe.

## Server suggestions

Paperless 3.0.5 advertises server-hosted LLM suggestions at
`GET /api/documents/{id}/ai_suggestions/` (distinct from the classic classifier
`suggestions` action). Folio enables the feature only when that
exact authenticated OpenAPI operation is present, the server runtime has not
disabled AI, and the account can change documents. Responses remain an
untrusted, separate suggestion model; catalog identities are intersected with
the current visible catalog and nothing is written until the user explicitly
accepts individual fields.

## Representation identity

Paperless 3.0.5 resolves `?version=<id>` on metadata, preview, and download
against the same document-version record. Folio fetches metadata with that
version before a historical file action and always sends either
`original=true` or `original=false`. This explicit parameter is necessary but
not sufficient: Paperless serves the original when an archive is absent even
when the archive path was requested. Folio therefore compares every remote
preview/export/print/share download with the selected representation's
version-scoped SHA-256 (and size, when present) before exposing it. Missing or
malformed verification metadata fails closed; mismatched temporary bytes are
deleted and are never labeled as the selected representation.

## Capability cache lifecycle

Capability entries are isolated by connection profile and expire after fifteen minutes. They are discarded when the server fingerprint changes, on explicit reload, on profile removal, and when an advertised operation produces an endpoint, permission, API-version, media/schema, or invalid-response mismatch. Discovery is then rerun against the active profile; data from another profile is never reused.

## Required release QA

Before a release is described as live-server verified, exercise the acceptance suite against both the minimum Paperless-ngx 3.0.0 baseline and the current 3.0.x target with accounts that have full and restricted permissions. Include failed and simultaneous PDF jobs, an interrupted app/restart while a job runs, malformed/deep tag trees, concurrent tag moves, and a server upgrade that changes the schema. This environment did not provide those two server deployments, so this remains explicit external QA rather than a claimed pass.
