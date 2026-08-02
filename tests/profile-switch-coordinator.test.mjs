import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  connectionProfileAuthFingerprint,
  createConnectionProfile,
} from '../src/lib/auth/profile-store.ts';
import { LatestProfileSwitchCoordinator } from '../src/lib/profile-switch-coordinator.ts';

const appContextSource = await readFile(
  new URL('../src/context/app-context.tsx', import.meta.url),
  'utf8',
);
const profileManagementSource = await readFile(
  new URL('../src/lib/auth/profile-management.ts', import.meta.url),
  'utf8',
);
const profileStoreSource = await readFile(
  new URL('../src/lib/auth/profile-store.ts', import.meta.url),
  'utf8',
);
const [metadataSource, savedViewsSource, trashSource] = await Promise.all([
  '../src/app/paperless-metadata.tsx',
  '../src/app/saved-views.tsx',
  '../src/app/trash.tsx',
].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));
const [homeSource, documentsSource, appShellSource] = await Promise.all([
  '../src/app/index.tsx',
  '../src/app/documents.tsx',
  '../src/components/app-shell.tsx',
].map((path) => readFile(new URL(path, import.meta.url), 'utf8')));

test('AppProvider preloads profile-scoped state before publishing the active profile', () => {
  const start = appContextSource.indexOf('const switchProfile = useCallback');
  const end = appContextSource.indexOf('const prepareProfileDraft = useCallback', start);
  const source = appContextSource.slice(start, end);
  const preload = source.indexOf('await Promise.all');
  const guardedCommit = source.indexOf('commitIfLatest');
  const persistedActivation = source.indexOf('connectionProfiles.setActiveProfile');
  const publishedActivation = source.indexOf('setActiveProfileId');

  assert.ok(start >= 0 && end > start);
  assert.ok(preload >= 0 && preload < guardedCommit);
  assert.ok(guardedCommit < persistedActivation);
  assert.ok(persistedActivation < publishedActivation);
  assert.match(source, /setActiveProfileId\(profileId\);[\s\S]*publishCredentials\(nextCredentials\);[\s\S]*setDocuments\(/);
  assert.match(source, /if \(!committed\) return;[\s\S]*await sync\(nextCredentials, profileId\)/);
});

test('cold OIDC bootstrap publishes cached workspace before refresh network I/O', () => {
  const start = appContextSource.indexOf('// Hydrate only local repository state first.');
  const end = appContextSource.indexOf('useEffect(() => {', start);
  const source = appContextSource.slice(start, end);
  const localWorkspaceRead = source.indexOf('folioRepository.readWorkspace(profile.id)');
  const workspacePublish = source.indexOf('setDocuments([');
  const bootReady = source.indexOf('setIsBootstrapping(false)');
  const cachedCredentialRead = source.indexOf("credentialsForProfile(profile, { refreshOidc: false })");
  const refresh = source.indexOf('refreshedCredentials = await credentialsForProfile(profile)');
  const remoteSync = source.indexOf("await sync(refreshedCredentials, profile.id, 'cold-start')");

  assert.ok(start >= 0 && end > start);
  assert.ok(localWorkspaceRead >= 0 && localWorkspaceRead < workspacePublish);
  assert.ok(workspacePublish < bootReady);
  assert.ok(bootReady < cachedCredentialRead);
  assert.ok(cachedCredentialRead < refresh);
  assert.ok(refresh < remoteSync);
  assert.match(source, /catch \(error\) \{[\s\S]*setConnectionError[\s\S]*return;[\s\S]*await sync/);
  assert.doesNotMatch(source.slice(workspacePublish, refresh), /setDocuments\(demoWorkspace\.documents\)/);
});

test('a reconnect-required profile keeps its cache out of demo semantics and accepts durable intake', () => {
  assert.match(appContextSource, /profileConfigured: Boolean\(activeProfile\)/);
  assert.match(
    appContextSource,
    /const profileId = credentials\?\.profileId \?\? activeProfileIdRef\.current;[\s\S]*if \(!profileId\) \{[\s\S]*localDocuments/,
  );
  assert.match(appContextSource, /!options\.deferSubmission && credentials\?\.profileId === profileId/);
  assert.match(homeSource, /profileConfigured[\s\S]*home\.libraryDocuments/);
  assert.match(documentsSource, /!profileConfigured && <DemoModeBanner/);
  assert.match(appShellSource, /!profileConfigured && showDemoBanner/);
});

test('profile-owned metadata, saved-view, and trash screens remount at the connection boundary', () => {
  assert.match(
    metadataSource,
    /<PaperlessMetadataScreen key=\{activeProfile\?\.id \?\? 'no-profile'\} \/>/,
  );
  assert.match(
    savedViewsSource,
    /<SavedViewsScreen key=\{activeProfile\?\.id \?\? 'no-profile'\} \/>/,
  );
  assert.match(
    trashSource,
    /<TrashContent key=\{activeProfile\?\.id \?\? credentials\?\.profileId \?\? 'no-profile'\} \/>/,
  );
});

test('metadata and saved-view requests and destructive callbacks reject stale component epochs', () => {
  for (const source of [metadataSource, savedViewsSource]) {
    assert.match(source, /useEffect\(\(\) => \(\) => \{\s*requestEpoch\.current \+= 1;\s*\}, \[\]\)/);
    assert.match(source, /const epoch = requestEpoch\.current;[\s\S]*if \(epoch !== requestEpoch\.current\) return;/);
    assert.match(source, /onPress: \(\) => \{\s*if \(advanced\.phase !== 'ready' \|\| epoch !== requestEpoch\.current\) return;/);
  }
});

test('profile credentials fail closed when connection metadata is rebound to another server', () => {
  const original = createConnectionProfile({
    id: 'profile-a',
    displayName: 'Primary',
    serverUrl: 'https://paper.example.com/archive',
    auth: { kind: 'token' },
    now: '2026-08-02T10:00:00.000Z',
  });
  const rebound = { ...original, serverUrl: 'https://attacker.example.net/archive' };
  assert.notEqual(
    connectionProfileAuthFingerprint(original),
    connectionProfileAuthFingerprint(rebound),
  );

  const start = appContextSource.indexOf('async function credentialsForProfile');
  const end = appContextSource.indexOf('async function loadProfileOwnership', start);
  const source = appContextSource.slice(start, end);
  const mismatchCheck = source.indexOf('secrets.connectionFingerprint !== fingerprint');
  const tokenRead = source.indexOf("const token = secrets.apiToken");
  assert.ok(start >= 0 && end > start);
  assert.ok(mismatchCheck >= 0 && mismatchCheck < tokenRead);
  assert.match(source, /secrets\.connectionFingerprint !== fingerprint\)[\s\S]*throw new Error/);
});

test('foreground OIDC credentials accept only Paperless tokens and fail legacy IdP secrets into reconnect', () => {
  const start = appContextSource.indexOf('async function credentialsForProfile');
  const end = appContextSource.indexOf('async function loadProfileOwnership', start);
  const source = appContextSource.slice(start, end);

  assert.match(
    source,
    /profile\.auth\.kind === 'oidc'[\s\S]*secrets\.oidc \|\| !secrets\.apiToken[\s\S]*profiles\.oidcReconnect/,
  );
  assert.match(source, /const token = secrets\.apiToken \?\? ''/);
  assert.match(source, /authorizationScheme: 'Token'/);
  assert.doesNotMatch(source, /secrets\.oidc\?\.accessToken|authorizationScheme: 'Bearer'/);
});

test('OIDC sign-out clears only the selected profile authority before revoking its runtime', () => {
  const start = appContextSource.indexOf('const revokeProfileOidc = useCallback');
  const end = appContextSource.indexOf('const removeProfile = useCallback', start);
  const source = appContextSource.slice(start, end);
  const durableClear = source.indexOf('await profileSecrets.write(profileId, remainingSecrets)');
  const generationFence = source.indexOf('profileGeneration.current += 1');
  const runtimeRevoke = source.indexOf('publishCredentials(null)');
  const metadataUpdate = source.indexOf('await connectionProfiles.update(updated)');

  assert.match(source, /!secrets\.apiToken && !secrets\.oidc/);
  assert.match(source, /apiToken: _apiToken,[\s\S]*oidc: _oidc,[\s\S]*\.\.\.remainingSecrets/);
  assert.match(source, /revokeOidcSession[\s\S]*\.catch\(\(\) => result\)/);
  assert.ok(durableClear >= 0 && durableClear < generationFence);
  assert.ok(generationFence < runtimeRevoke);
  assert.ok(runtimeRevoke < metadataUpdate);
  assert.doesNotMatch(source, /if \(!secrets\?\.oidc\)/);
});

test('foreground upload work remains bound to one published credential generation', () => {
  const reconcileStart = appContextSource.indexOf('const reconcileReadyUpload = useCallback');
  const start = appContextSource.indexOf('const runUploadQueue = useCallback');
  const end = appContextSource.indexOf('useEffect(() => {', start);
  const reconciliationSource = appContextSource.slice(reconcileStart, start);
  const source = appContextSource.slice(start, end);

  assert.ok(reconcileStart >= 0 && start > reconcileStart && end > start);
  assert.match(
    reconciliationSource,
    /await requireCurrentExecution\(\);[\s\S]*await sync\(taskCredentials, task\.profileId\)[\s\S]*await requireCurrentExecution\(\);[\s\S]*setDocuments\(/,
  );
  assert.match(
    reconciliationSource,
    /await fetchPaperlessDocument\(taskCredentials, remoteId, catalog\)[\s\S]*await requireCurrentExecution\(\);[\s\S]*pendingProcessedDocumentIds\.current\.add/,
  );
  assert.match(source, /credentialBinding\.generation !== profileGeneration\.current/);
  assert.match(source, /const queueKey = `\$\{profileId\}:\$\{generation\}`/);
  assert.match(source, /generation === profileGeneration\.current/);
  assert.match(source, /activeProfileIdRef\.current === profileId/);
  assert.match(source, /before\.activeProfileId !== profileId/);
  assert.match(source, /after\.revision !== before\.revision/);
  assert.match(source, /currentSecrets\.connectionFingerprint === connectionFingerprint/);
  assert.match(source, /credentialsMatchStoredProfile\(taskCredentials, verifiedProfile, currentSecrets\)/);
  assert.match(source, /drainUploadQueue\(\{[\s\S]*executionGuard,/);
  assert.match(
    source,
    /async upload\(task, onProgress\) \{[\s\S]*if \(!await executionGuard!\(\)\)[\s\S]*uploadToPaperless\(/,
  );
  assert.match(
    source,
    /async poll\(task\) \{[\s\S]*if \(!await executionGuard!\(\)\)[\s\S]*waitForPaperlessTask\(/,
  );
  assert.match(
    source,
    /if \(!await executionGuard\(\)\) return;[\s\S]*reconcilePendingUploadResults\(/,
  );
  assert.match(
    source,
    /reconcileReadyUpload\(task, taskCredentials, executionGuard!\)/,
  );

  const taskRefresh = source.indexOf('const refreshedTasks = await folioRepository.listTasks(profileId)');
  const guardedPublish = source.indexOf('if (await executionGuard()) setTasks(refreshedTasks)', taskRefresh);
  assert.ok(taskRefresh >= 0 && guardedPublish > taskRefresh);
});

test('connection authority rebind persists a fresh namespace before journaled old-ID retirement', () => {
  const start = appContextSource.indexOf('const saveConnectionProfile = useCallback');
  const end = appContextSource.indexOf('const renameConnectionProfile = useCallback', start);
  const source = appContextSource.slice(start, end);
  const priorProfileRead = source.indexOf('const previousProfile =');
  const persistence = source.indexOf('await persistPreparedConnectionProfile');
  const rebindComparison = source.indexOf('preparedProfileRebindsAuthority(previousProfile, previousSecrets, prepared)');
  const dismissNotifications = source.indexOf('await dismissProfileNotifications(previousProfile.id)');
  const journalRecovery = source.indexOf('await recoverPendingProfilePublication({');
  const activateProfile = source.indexOf('await switchProfile(profile.id)');

  assert.ok(start >= 0 && end > start);
  assert.ok(priorProfileRead >= 0 && priorProfileRead < persistence);
  assert.ok(rebindComparison >= 0 && rebindComparison < persistence);
  assert.ok(rebindComparison < dismissNotifications);
  assert.ok(persistence < dismissNotifications);
  assert.ok(dismissNotifications < journalRecovery);
  assert.ok(journalRecovery < activateProfile);
  assert.match(source, /publicationJournal: profilePublicationJournal/);
  assert.match(source, /onProfileRevoked: \(snapshot\) => \{[\s\S]*publishProfileRevocation\(previousProfile\.id, snapshot\)/);
  assert.match(source, /\{ makeActive: activate \}/);
  assert.match(source, /if \(profile\.id === previousProfile\.id\)[\s\S]*fresh profile ID/);
  assert.doesNotMatch(source, /await removeProfileWithSecrets\(\{/);
  assert.doesNotMatch(source, /deleteProfileDataAndFiles\(profile\.id\)/);

  const recoveryStart = profileStoreSource.indexOf('export async function recoverPendingProfilePublication');
  const recoveryEnd = profileStoreSource.indexOf('/**\n * Removes an app-owned native identity', recoveryStart);
  const recoverySource = profileStoreSource.slice(recoveryStart, recoveryEnd);
  assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
  assert.match(recoverySource, /profileId: pending\.oldProfileId/);
  assert.match(recoverySource, /policy: 'delete-cache-and-jobs'/);
  assert.match(recoverySource, /nextActiveProfileId: pending\.intendedActive[\s\S]*pending\.replacementProfileId/);

  const original = createConnectionProfile({
    id: 'profile-a',
    displayName: 'Primary',
    serverUrl: 'https://paper.example.com/archive',
    auth: { kind: 'token' },
    now: '2026-08-02T10:00:00.000Z',
  });
  assert.equal(
    connectionProfileAuthFingerprint(original),
    connectionProfileAuthFingerprint({ ...original, displayName: 'Renamed' }),
  );
  assert.notEqual(
    connectionProfileAuthFingerprint(original),
    connectionProfileAuthFingerprint({
      ...original,
      auth: { kind: 'custom-headers', headerNames: ['x-api-key'] },
      customHeaderNames: ['x-api-key'],
    }),
  );
});

test('fresh profile persistence publishes metadata before secrets and activates last', () => {
  const start = profileManagementSource.indexOf('const publishFreshNamespace = async () => {');
  const end = profileManagementSource.indexOf('await publishFreshNamespace();', start);
  const source = profileManagementSource.slice(start, end);
  const journal = source.indexOf('await publicationJournal.begin({');
  const metadata = source.indexOf('await dependencies.profiles.add(profile');
  const secret = source.indexOf('await dependencies.secrets.write(id, nextSecrets)');
  const activation = source.indexOf('await dependencies.profiles.setActiveProfile(id)');
  const journalClear = source.indexOf('await publicationJournal.clear(pending.operationId)');

  assert.ok(start >= 0 && end > start);
  assert.ok(journal >= 0 && journal < metadata);
  assert.ok(metadata >= 0 && metadata < secret);
  assert.ok(secret < activation);
  assert.ok(activation < journalClear);
  assert.match(source, /makeActive: false,[\s\S]*activateWhenFirst: false/);
});

test('profile data removal quarantines native files until transactional repository cleanup commits', () => {
  const start = appContextSource.indexOf('const profileDataRemovalTransaction');
  const end = appContextSource.indexOf('const metadataUpdateController', start);
  const source = appContextSource.slice(start, end);
  const plan = source.indexOf('planNativeProfileFileRemoval(');
  const stage = source.indexOf('stageNativeProfileFilesForRemoval(');
  const repositoryDelete = source.indexOf('deleteProfileDataAndWriteRemovalTombstone({');
  const rollback = source.indexOf('rollbackNativeProfileFileRemoval(');
  const finalize = source.indexOf('commitNativeProfileFileRemoval(');

  assert.ok(start >= 0 && end > start);
  assert.ok(plan >= 0 && plan < stage);
  assert.ok(stage < repositoryDelete);
  assert.ok(repositoryDelete < rollback);
  assert.ok(repositoryDelete < finalize);
});

test('post-commit profile cleanup failure still revokes the active React runtime', () => {
  const callbackStart = appContextSource.indexOf('const publishProfileRevocation = useCallback');
  const callbackEnd = appContextSource.indexOf('const loadRemoteWorkspace = useCallback', callbackStart);
  const callback = appContextSource.slice(callbackStart, callbackEnd);
  assert.ok(callbackStart >= 0 && callbackEnd > callbackStart);
  assert.match(callback, /profileGeneration\.current \+= 1/);
  assert.match(callback, /activeProfileIdRef\.current = null/);
  assert.match(callback, /publishCredentials\(null\)/);
  assert.match(callback, /setTasks\(\[\]\)/);
  assert.match(callback, /setDocuments\(demoWorkspace\.documents\)/);

  for (const anchor of ['const disconnect = useCallback', 'const removeProfile = useCallback']) {
    const start = appContextSource.indexOf(anchor);
    const end = appContextSource.indexOf('\n  const ', start + anchor.length);
    const removal = appContextSource.slice(start, end < 0 ? undefined : end);
    assert.ok(start >= 0);
    assert.match(removal, /removeProfileWithSecrets\(\{/);
    assert.match(removal, /onProfileRevoked: .*publishProfileRevocation/);
  }
});

test('only the latest profile request may begin an atomic commit', async () => {
  const coordinator = new LatestProfileSwitchCoordinator();
  const staleRequest = coordinator.begin();
  const latestRequest = coordinator.begin();
  const commits = [];

  assert.equal(await coordinator.commitIfLatest(staleRequest, () => commits.push('stale')), false);
  assert.equal(await coordinator.commitIfLatest(latestRequest, () => commits.push('latest')), true);
  assert.deepEqual(commits, ['latest']);
});

test('a profile commit that has started finishes atomically before the next request', async () => {
  const coordinator = new LatestProfileSwitchCoordinator();
  const firstRequest = coordinator.begin();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const firstCommit = coordinator.commitIfLatest(firstRequest, async () => {
    events.push('first:start');
    await firstGate;
    events.push('first:publish');
  });
  await Promise.resolve();

  const secondRequest = coordinator.begin();
  const secondCommit = coordinator.commitIfLatest(secondRequest, () => {
    events.push('second:publish');
  });
  releaseFirst();

  assert.equal(await firstCommit, true);
  assert.equal(await secondCommit, true);
  assert.deepEqual(events, ['first:start', 'first:publish', 'second:publish']);
});

test('a failed commit does not poison later profile switches', async () => {
  const coordinator = new LatestProfileSwitchCoordinator();
  const failedRequest = coordinator.begin();
  await assert.rejects(
    () => coordinator.commitIfLatest(failedRequest, () => {
      throw new Error('simulated profile persistence failure');
    }),
    /simulated profile persistence failure/,
  );

  const recoveryRequest = coordinator.begin();
  assert.equal(await coordinator.commitIfLatest(recoveryRequest, () => undefined), true);
});
