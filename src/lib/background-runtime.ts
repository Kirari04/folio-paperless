import NetInfo from '@react-native-community/netinfo';
import { File, Paths } from 'expo-file-system';

import {
  ConnectionProfileRepository,
  ProfileRemovalJournalStore,
  ProfileSecretStore,
  connectionProfileAuthFingerprint,
} from './auth/profile-store';
import { defineExpoBackgroundTask, expoBackgroundRegistrationPort } from './background-expo-adapter';
import { requestForegroundUploadReconciliation } from './background-upload-reconciliation';
import {
  notifyLocalEvent,
  notifyTaskResult,
  notifyUploadCompleted,
  setRuntimeNotificationPreferences,
} from './device-features';
import {
  configureBestEffortBackgroundSync,
  runBestEffortBackgroundCycle,
} from './background-sync';
import { OfflineSyncCoordinator } from './offline-sync';
import {
  applyPaperlessUploadOwner,
  fetchPaperlessCreationCapabilities,
  fetchPaperlessTask,
  fetchPaperlessWorkspace,
  uploadToPaperless,
} from './paperless';
import { createPlatformStringStore } from './platform-storage';
import {
  createBackgroundNotificationEvents,
  parseLocalNotificationPreferences,
} from './platform-notifications';
import { getFolioRepository } from './repository-provider';
import { assertProfileStagingUri } from './file-staging';
import { drainUploadQueue } from './upload-queue-worker';
import { translateRuntime } from '../i18n/runtime';
import { restoreNativeRuntimeLocale } from '../i18n/native-runtime';
import type { PaperlessCredentials } from '../types/document';
import { dispatchTaskNotification } from './task-notification-outbox';
import { assertUploadMetadataReferencesCurrent } from './upload-metadata';
import { createRepositoryProfileRemovalManifestStore } from './auth/profile-removal-manifest-store';
import {
  credentialsMatchStoredProfile,
  profileSecretsAuthorizeSameContext,
} from './auth/credential-authority';
import type { ProfileSecrets } from './auth/profile-store';

export const FOLIO_BACKGROUND_TASK = 'folio-background-sync-v1';
const STORAGE_RESERVE_BYTES = 64 * 1024 * 1024;
const PREFERENCES_KEY = 'folio.preferences';

const store = createPlatformStringStore();
const profiles = new ConnectionProfileRepository(store);
const secrets = new ProfileSecretStore(store);
const repository = getFolioRepository();
const profileRemovalJournal = new ProfileRemovalJournalStore(
  store,
  createRepositoryProfileRemovalManifestStore(repository),
);

async function profileRemovalPending() {
  try {
    return (await profileRemovalJournal.read()) !== null;
  } catch {
    // A corrupt or temporarily unreadable deletion journal is an authority
    // failure. Foreground startup owns recovery; headless work must not guess.
    return true;
  }
}

async function notificationPreferencesForBackground() {
  try {
    const raw = await store.getItem(PREFERENCES_KEY);
    const stored: unknown = raw ? JSON.parse(raw) : null;
    const parsed = parseLocalNotificationPreferences(stored);
    return typeof stored === 'object' && stored !== null && 'biometricLock' in stored && stored.biometricLock === true
      ? { ...parsed, privacy: 'redacted' as const }
      : parsed;
  } catch {
    return parseLocalNotificationPreferences(null);
  }
}

function inboxCount(workspace: Awaited<ReturnType<typeof repository.readWorkspace>>) {
  if (!workspace) return null;
  return workspace.documents.filter((document) => document.status !== 'archived').length;
}

type BackgroundCredentialContext = {
  credentials: PaperlessCredentials;
  connectionFingerprint: string;
  authoritySecrets: ProfileSecrets;
};

async function credentialsForBackground(profileId: string): Promise<BackgroundCredentialContext | null> {
  if (await profileRemovalPending()) return null;
  const before = await profiles.getSnapshot();
  const profile = before.profiles.find((item) => item.id === profileId);
  if (!profile || profile.auth.kind === 'mutual-tls') return null;
  const secret = await secrets.read(profileId);
  if (!secret) return null;
  if (await profileRemovalPending()) return null;
  const after = await profiles.getSnapshot();
  if (after.revision !== before.revision) return null;
  const fingerprint = connectionProfileAuthFingerprint(profile);
  if (secret.connectionFingerprint !== fingerprint) return null;
  const token = secret.apiToken ?? secret.oidc?.accessToken ?? '';
  if (!token && !Object.keys(secret.customHeaders ?? {}).length) return null;
  return {
    authoritySecrets: secret,
    connectionFingerprint: fingerprint,
    credentials: {
      profileId,
      serverUrl: profile.serverUrl,
      token,
      authorizationScheme: secret.oidc ? 'Bearer' : 'Token',
      customHeaders: secret.customHeaders,
    },
  };
}

async function runProfile(profileId: string) {
  const credentialContext = await credentialsForBackground(profileId);
  if (!credentialContext) {
    return { outcome: 'failed' as const, error: translateRuntime('appError.authMissing') };
  }
  const { credentials, connectionFingerprint, authoritySecrets } = credentialContext;
  const executionGuard = async () => {
    if (await profileRemovalPending()) return false;
    const snapshot = await profiles.getSnapshot();
    const profile = snapshot.profiles.find((item) => item.id === profileId);
    if (!profile || connectionProfileAuthFingerprint(profile) !== connectionFingerprint) return false;
    const currentSecrets = await secrets.read(profileId);
    return !!currentSecrets
      && currentSecrets.connectionFingerprint === connectionFingerprint
      && profileSecretsAuthorizeSameContext(authoritySecrets, currentSecrets)
      && credentialsMatchStoredProfile(credentials, profile, currentSecrets);
  };
  const coordinator = new OfflineSyncCoordinator({
    repository,
    executionGuard,
    transport: {
      async fetchWorkspace() {
        if (!await executionGuard()) {
          throw new Error(translateRuntime('runtimeError.profileChangedReconciliation'));
        }
        const workspace = await fetchPaperlessWorkspace(credentials);
        const syncedAt = new Date().toISOString();
        return { kind: 'full', ...workspace, syncedAt };
      },
    },
  });
  const [notificationPreferences, previousWorkspace] = await Promise.all([
    notificationPreferencesForBackground(),
    repository.readWorkspace(profileId),
  ]);
  setRuntimeNotificationPreferences(
    notificationPreferences.enabled,
    notificationPreferences.privacy,
  );
  let liveUploadCatalogPromise: Promise<Awaited<ReturnType<typeof fetchPaperlessWorkspace>>['catalog']> | null = null;
  let liveCreationCapabilitiesPromise: ReturnType<typeof fetchPaperlessCreationCapabilities> | null = null;
  const liveUploadCatalog = () => {
    liveUploadCatalogPromise ??= fetchPaperlessWorkspace(credentials)
      .then((workspace) => workspace.catalog)
      .catch((error) => {
        liveUploadCatalogPromise = null;
        throw error;
      });
    return liveUploadCatalogPromise;
  };
  const liveCreationCapabilities = () => {
    liveCreationCapabilitiesPromise ??= fetchPaperlessCreationCapabilities(credentials)
      .catch((error) => {
        liveCreationCapabilitiesPromise = null;
        throw error;
      });
    return liveCreationCapabilitiesPromise;
  };
  const uploadResults = await drainUploadQueue({
    profileId,
    workerId: `background-${Date.now()}`,
    repository,
    concurrency: 1,
    executionGuard,
    transport: {
      async validateUpload(task) {
        if (!await executionGuard()) {
          throw new Error(translateRuntime('runtimeError.profileChangedUpload'));
        }
        const liveCatalog = await liveUploadCatalog();
        if (!await executionGuard()) {
          throw new Error(translateRuntime('runtimeError.profileChangedUpload'));
        }
        assertUploadMetadataReferencesCurrent(task.metadata, liveCatalog);
      },
      async upload(task, onProgress) {
        if (!await executionGuard()) {
          throw new Error(translateRuntime('runtimeError.profileChangedUpload'));
        }
        assertProfileStagingUri(profileId, task.localUri!);
        const stagedFile = new File(task.localUri!);
        if (!stagedFile.exists || stagedFile.size <= 0) {
          throw new Error(translateRuntime('appError.stagedMissing'));
        }
        if (task.byteSize && stagedFile.size !== task.byteSize) {
          throw new Error(translateRuntime('appError.stagedChanged'));
        }
        return uploadToPaperless(credentials, {
          uri: task.localUri!,
          name: task.stagedName || task.originalName || 'document',
          mimeType: task.mimeType,
        }, task.metadata, { onProgress: (progress) => { void onProgress(progress); } });
      },
      async poll(task) {
        if (!await executionGuard()) {
          throw new Error(translateRuntime('runtimeError.profileChangedUpload'));
        }
        const remote = task.paperlessTaskId
          ? await fetchPaperlessTask(credentials, task.paperlessTaskId)
          : null;
        if (!remote || !['SUCCESS', 'FAILURE', 'FAILED', 'REVOKED'].includes(remote.status)) {
          throw new Error(translateRuntime('taskRuntime.paperlessPending'));
        }
        if (remote.status !== 'SUCCESS') {
          const error = new Error(remote.message || translateRuntime('taskRuntime.paperlessFailed')) as Error & {
            duplicateDocumentIds?: number[];
          };
          error.duplicateDocumentIds = remote.duplicateDocumentIds;
          throw error;
        }
        return {
          documentId: remote.documentId,
          duplicateDocumentIds: remote.duplicateDocumentIds,
          summary: remote.message,
        };
      },
      async finalizeMetadata(task, result) {
        if (!result.documentId || !await executionGuard()) {
          throw new Error(translateRuntime('runtimeError.profileChangedReconciliation'));
        }
        const requestedOwner = task.metadata?.owner;
        if (!requestedOwner || requestedOwner.state === 'unset') return;
        const capabilities = await liveCreationCapabilities();
        if (!await executionGuard()) {
          throw new Error(translateRuntime('runtimeError.profileChangedReconciliation'));
        }
        await applyPaperlessUploadOwner(
          credentials,
          result.documentId,
          task.metadata,
          capabilities,
        );
        if (!await executionGuard()) {
          throw new Error(translateRuntime('runtimeError.profileChangedReconciliation'));
        }
      },
    },
    onResult: async (result) => {
      if (result.kind !== 'ready') return;
      await requestForegroundUploadReconciliation({
        profileId,
        repository,
        task: result.task,
      });
    },
  });
  const network = await NetInfo.fetch();
  const result = await coordinator.sync({
    profileId,
    workerId: `background-sync-${Date.now()}`,
    network: {
      isConnected: network.isConnected,
      isInternetReachable: network.isInternetReachable,
    },
    trigger: 'background',
  });
  const outcome = result.phase === 'busy'
    ? { outcome: 'busy' as const }
    : result.phase === 'error'
      ? { outcome: 'failed' as const, error: result.error }
      : { outcome: 'completed' as const };

  if (!await executionGuard()) {
    return { outcome: 'busy' as const };
  }

  if (notificationPreferences.enabled) {
    for (const uploadResult of uploadResults) {
      const task = uploadResult.task;
      if (task.notificationSentAt) continue;
      try {
        if (uploadResult.kind !== 'ready'
          && !(uploadResult.kind === 'failed' && task.error?.retryable === false)) continue;
        await dispatchTaskNotification({
          repository,
          task,
          workerId: `background-notification-${profileId}`,
          async notify(deliveryId) {
            if (!await executionGuard()) throw new Error(translateRuntime('runtimeError.profileChangedReconciliation'));
            if (uploadResult.kind === 'ready') {
              const remoteId = task.result?.remoteDocumentId;
              await notifyUploadCompleted({
                profileId,
                taskId: task.id,
                canonicalDocumentId: remoteId ? `remote-${remoteId}` : null,
                privacy: notificationPreferences.privacy,
                deliveryId,
              });
            } else {
              await notifyTaskResult({
                profileId,
                taskId: task.id,
                succeeded: false,
                privacy: notificationPreferences.privacy,
                deliveryId,
              });
            }
          },
        });
      } catch {
        // A later foreground reconciliation can retry a missed completion
        // notification without affecting the durable upload result.
      }
    }

    const events = createBackgroundNotificationEvents({
      profileId,
      issuedAt: new Date().toISOString(),
      syncOutcome: outcome.outcome,
      previousInboxCount: inboxCount(previousWorkspace),
      currentInboxCount: inboxCount(result.workspace),
    });
    for (const event of events) {
      await notifyLocalEvent(event, notificationPreferences.privacy).catch(() => undefined);
    }
  }
  return outcome;
}

async function executeBackgroundWork() {
  await restoreNativeRuntimeLocale();
  await repository.initialize();
  if (await profileRemovalPending()) return 'failed' as const;
  const [snapshot, network] = await Promise.all([profiles.getSnapshot(), NetInfo.fetch()]);
  const result = await runBestEffortBackgroundCycle({
    constraints: {
      availability: 'available',
      network: {
        isConnected: network.isConnected,
        isInternetReachable: network.isInternetReachable,
      },
      availableDiskBytes: Number.isFinite(Paths.availableDiskSpace) ? Paths.availableDiskSpace : null,
      reserveBytes: STORAGE_RESERVE_BYTES,
      deadlineAt: Date.now() + 20_000,
    },
    profileIds: snapshot.profiles.map((profile) => profile.id),
    runProfile,
  });
  return result.kind === 'failed' ? 'failed' as const : 'success' as const;
}

defineExpoBackgroundTask(FOLIO_BACKGROUND_TASK, executeBackgroundWork);

export function registerFolioBackgroundWork() {
  return configureBestEffortBackgroundSync({
    port: expoBackgroundRegistrationPort,
    taskName: FOLIO_BACKGROUND_TASK,
    minimumIntervalMinutes: 12 * 60,
  });
}
