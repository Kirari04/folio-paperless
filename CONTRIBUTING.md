# Contributing to Folio

Thanks for helping make Folio better. Changes move through `dev`; `main` is the protected
production branch and the source of GitHub releases.

## Branch flow

Create a short-lived branch from the latest `dev`:

```bash
git switch dev
git pull --ff-only
git switch -c feat/short-description
```

Use `feat/`, `fix/`, `perf/`, `refactor/`, `docs/`, `test/`, `build/`, `ci/`, or `chore/` as the
branch prefix. Open the feature or fix pull request into `dev` and **squash merge** it. The squash
commit title must be the pull-request title.

Promote a tested set of changes with a `dev` → `main` pull request and use a **merge commit**.
This preserves each Conventional Commit for Release Please. Release Please pull requests into
`main` are **squash merged**. After a release, open a `main` → `dev` synchronization pull request
and use a **merge commit** so the changelog and version metadata return to development.

Direct pushes, force pushes, and branch deletion are blocked on both protected branches.

## Pull-request titles and versions

Pull-request titles must use one of these Conventional Commit types:

```text
feat: add offline document queue
fix(sync): retry an interrupted upload
perf(library): reduce thumbnail work
feat(scanner)!: replace the scan result contract
docs: explain development builds
```

- `fix:` proposes a patch release: `0.1.0` → `0.1.1`.
- `feat:` proposes a minor release: `0.1.0` → `0.2.0`.
- `!` or a `BREAKING CHANGE:` footer proposes a major release: `0.1.0` → `1.0.0`.
- Documentation, test, build, CI, and chore-only changes do not start a release by themselves.

## Verify locally

Install with the lockfile and run the same quality checks as CI:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npx expo-doctor
npx expo export --platform web
```

For native Android changes, also generate a clean SDK 57 project and compile it:

```bash
CI=1 npx expo prebuild --platform android --clean --no-install
cd android
./gradlew :app:assembleDebug --no-daemon
```

The Android folder is generated and ignored. Do not commit native build output, credentials, or
signing material. Add screenshots or a recording to the pull request for visible UI changes.

CI performs the equivalent clean iOS prebuild and unsigned Release archive on a macOS 26 runner.
Its seven-day Actions artifact can be locally signed and sideloaded for physical-iPhone testing.

## Releases

Release Please maintains a release pull request on `main`. Merging it creates a draft release and
starts independent Android and iOS builds. Automation verifies the Android application ID,
version, signature, and certificate fingerprint. It also verifies the iOS bundle ID, version,
build number, iPhone-only device family, arm64 binary, production JavaScript bundle, privacy
manifest, and absence of Apple signing material. The iOS job derives an AltStore/SideStore source
from the archived app and verifies its download URL, size, checksum, minimum iOS version,
permissions, and non-notarized entitlement policy.

The release remains a draft until the signed APK, unsigned IPA, both SHA-256 files, and
`altstore-source.json` have been uploaded successfully. The IPA must be signed with the tester's
own Apple credentials before it can be installed on an iPhone.

If the build fails, the release stays in draft. A maintainer can run the `Release` workflow with
`rebuild_tag=vX.Y.Z` after fixing the cause. The workflow refuses to modify an already-published
release. For the initial release only, `release_as=0.1.0` forces the desired starting version.

The built-in GitHub token may leave CI on a Release Please pull request awaiting workflow
approval. Approve or rerun that pull request's CI, wait for `CI / Required checks`, then merge it.
