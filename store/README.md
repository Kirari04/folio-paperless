# Store submission metadata

This directory is the reviewed source for the English and German store listing, release notes, and privacy answers. `node scripts/assert-store-metadata.mjs` validates that both locales are complete and that the public privacy/support URLs and platform disclosures are present.

The declarations describe the checked-in application: Folio connects directly to a server chosen by the user, remote push is disabled, and no advertising or developer analytics SDK is included. Store-console questionnaires must be reviewed against the release candidate and current store wording before every submission; these files do not automate or authorize publication.

Before submission, provide final App Store and Play screenshots captured from release-signed builds on the required device sizes, complete content-rating/export-compliance questionnaires in the protected store accounts, verify the public URLs, and copy the locale-specific release notes. Do not use document titles, server identities, credentials, or real user documents in screenshots.

Validation:

```sh
node scripts/assert-store-metadata.mjs
```
