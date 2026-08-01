import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import {
  PropsWithChildren,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, Platform } from 'react-native';

import { hapticFeedback } from '@/components/motion';
import {
  DownloadedUpdate,
  EMPTY_UPDATE_CACHE,
  FolioRelease,
  FolioUpdateError,
  UPDATE_REMINDER_INTERVAL_MS,
  UpdateCache,
  compareStableVersions,
  downloadedUpdateExists,
  expectedReleaseSha256,
  fetchLatestFolioRelease,
  getUpdateFileUri,
  readUpdateCache,
  removeDownloadedUpdate,
  versionCodeFor,
  writeUpdateCache,
} from '@/lib/app-updates';
import {
  FolioInstallationInfo,
  getFolioUpdaterModule,
} from '@/lib/folio-updater-native';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'ready'
  | 'permission'
  | 'installing'
  | 'error'
  | 'unsupported';

export type UpdateSupport =
  | 'initializing'
  | 'supported'
  | 'android-release-only'
  | 'development-build'
  | 'module-unavailable';

type UpdateContextValue = {
  status: UpdateStatus;
  support: UpdateSupport;
  currentVersion: string;
  release: FolioRelease | null;
  progress: number;
  error: string | null;
  lastCheckedAt: number | null;
  sheetVisible: boolean;
  noticeVisible: boolean;
  canRequestPackageInstalls: boolean;
  checkForUpdates: () => Promise<void>;
  openUpdateSheet: () => void;
  closeUpdateSheet: () => void;
  remindLater: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  installUpdate: () => Promise<void>;
  retry: () => Promise<void>;
};

const UpdateContext = createContext<UpdateContextValue | null>(null);

function errorMessage(error: unknown) {
  if (error instanceof FolioUpdateError || error instanceof Error) return error.message;
  return 'The update could not be completed. Try again.';
}

function statusForRelease(release: FolioRelease | null, currentVersion: string): UpdateStatus {
  if (!release || compareStableVersions(release.version, currentVersion) <= 0) return 'up-to-date';
  if (!release.apk) return 'error';
  return 'available';
}

export function UpdateProvider({ children }: PropsWithChildren) {
  const nativeUpdater = getFolioUpdaterModule();
  const configuredVersion = Constants.expoConfig?.version ?? '0.0.0';
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [support, setSupport] = useState<UpdateSupport>('initializing');
  const [currentVersion, setCurrentVersion] = useState(configuredVersion);
  const [release, setRelease] = useState<FolioRelease | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [noticeVisible, setNoticeVisible] = useState(false);
  const [canRequestPackageInstalls, setCanRequestPackageInstalls] = useState(false);
  const cacheRef = useRef<UpdateCache>(EMPTY_UPDATE_CACHE);
  const installationInfoRef = useRef<FolioInstallationInfo | null>(null);
  const downloadRef = useRef<FileSystem.DownloadResumable | null>(null);
  const cancelRequestedRef = useRef(false);
  const checkInFlightRef = useRef<Promise<void> | null>(null);
  const awaitingPermissionRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
    void downloadRef.current?.cancelAsync();
  }, []);

  const persistCache = useCallback(async (nextCache: UpdateCache) => {
    cacheRef.current = nextCache;
    setLastCheckedAt(nextCache.checkedAt);
    try {
      await writeUpdateCache(nextCache);
    } catch {
      // Update checks remain useful even if Android clears or refuses the cache write.
    }
  }, []);

  const showReleaseState = useCallback(
    async (latestRelease: FolioRelease | null, cache: UpdateCache, installedVersion: string) => {
      setRelease(latestRelease);
      const nextStatus = statusForRelease(latestRelease, installedVersion);

      if (nextStatus === 'up-to-date') {
        if (cache.downloaded) {
          await removeDownloadedUpdate(cache.downloaded);
          await persistCache({ ...cache, downloaded: null, remindAfter: null });
        }
        setProgress(0);
        setNoticeVisible(false);
        setStatus('up-to-date');
        return;
      }

      if (nextStatus === 'error') {
        setError('This GitHub release does not include the expected universal Android APK.');
        setNoticeVisible(false);
        setStatus('error');
        return;
      }

      const cachedDownload = cache.downloaded;
      if (
        cachedDownload?.version === latestRelease?.version &&
        (await downloadedUpdateExists(cachedDownload))
      ) {
        setProgress(1);
        setNoticeVisible(false);
        setStatus('ready');
        return;
      }

      if (cachedDownload) {
        await removeDownloadedUpdate(cachedDownload);
        cache = { ...cache, downloaded: null };
        await persistCache(cache);
      }

      setProgress(0);
      setStatus('available');
      setNoticeVisible(!cache.remindAfter || cache.remindAfter <= Date.now());
    },
    [persistCache],
  );

  const performCheck = useCallback(
    async (force: boolean, userInitiated: boolean) => {
      if (support !== 'supported' || !installationInfoRef.current) return;
      if (checkInFlightRef.current) return checkInFlightRef.current;

      const check = (async () => {
        const previousStatus = status;
        setError(null);
        if (userInitiated || previousStatus === 'idle') setStatus('checking');
        try {
          const result = await fetchLatestFolioRelease(cacheRef.current, force);
          if (!mountedRef.current) return;
          await persistCache(result.cache);
          await showReleaseState(result.release, result.cache, installationInfoRef.current!.versionName);
          if (userInitiated) await hapticFeedback('confirm');
        } catch (checkError) {
          if (!mountedRef.current) return;
          if (userInitiated) {
            setError(errorMessage(checkError));
            setStatus('error');
            await hapticFeedback('error');
          } else if (previousStatus === 'idle') {
            setStatus(cacheRef.current.release ? 'up-to-date' : 'idle');
          }
        }
      })();

      checkInFlightRef.current = check;
      try {
        await check;
      } finally {
        checkInFlightRef.current = null;
      }
    },
    [persistCache, showReleaseState, status, support],
  );

  useEffect(() => {
    let cancelled = false;

    async function initialize() {
      if (Platform.OS !== 'android') {
        setSupport('android-release-only');
        setStatus('unsupported');
        return;
      }
      if (!nativeUpdater) {
        setSupport('module-unavailable');
        setStatus('unsupported');
        return;
      }

      try {
        const [installationInfo, cache] = await Promise.all([
          nativeUpdater.getInstallationInfoAsync(),
          readUpdateCache(),
        ]);
        if (cancelled) return;
        installationInfoRef.current = installationInfo;
        cacheRef.current = cache;
        setCurrentVersion(installationInfo.versionName || configuredVersion);
        setCanRequestPackageInstalls(installationInfo.canRequestPackageInstalls);
        setLastCheckedAt(cache.checkedAt);
        setRelease(cache.release);

        if (!installationInfo.isOfficialRelease) {
          setSupport('development-build');
          setStatus('unsupported');
          return;
        }

        setSupport('supported');
        const cachedStatus = cache.checkedAt
          ? statusForRelease(cache.release, installationInfo.versionName)
          : 'idle';
        if (cachedStatus === 'available' && cache.downloaded && await downloadedUpdateExists(cache.downloaded)) {
          setProgress(1);
          setStatus('ready');
        } else {
          setStatus(cachedStatus === 'error' ? 'idle' : cachedStatus);
          if (cachedStatus === 'available') {
            setNoticeVisible(!cache.remindAfter || cache.remindAfter <= Date.now());
          }
        }

        void fetchLatestFolioRelease(cache, false)
          .then(async (result) => {
            if (cancelled) return;
            await persistCache(result.cache);
            await showReleaseState(result.release, result.cache, installationInfo.versionName);
          })
          .catch(() => {
            // Automatic checks are deliberately quiet; a manual check provides recovery copy.
          });
      } catch {
        if (cancelled) return;
        setSupport('module-unavailable');
        setStatus('unsupported');
      }
    }

    void initialize();
    return () => {
      cancelled = true;
    };
  }, [configuredVersion, nativeUpdater, persistCache, showReleaseState]);

  const launchInstaller = useCallback(async () => {
    const downloaded = cacheRef.current.downloaded;
    if (!nativeUpdater || !downloaded || !(await downloadedUpdateExists(downloaded))) {
      setError('The verified update is no longer on this device. Download it again.');
      setStatus('error');
      return;
    }

    try {
      setError(null);
      setStatus('installing');
      await hapticFeedback('medium');
      await nativeUpdater.installApkAsync(downloaded.fileUri);
      setTimeout(() => {
        if (!mountedRef.current) return;
        setStatus('ready');
        setSheetVisible(false);
      }, 650);
    } catch (installError) {
      setError(errorMessage(installError));
      setStatus('ready');
      await hapticFeedback('error');
    }
  }, [nativeUpdater]);

  useEffect(() => {
    if (support !== 'supported') return;
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return;
      if (awaitingPermissionRef.current && nativeUpdater) {
        awaitingPermissionRef.current = false;
        void nativeUpdater.canRequestPackageInstallsAsync().then(async (allowed) => {
          setCanRequestPackageInstalls(allowed);
          if (allowed) await launchInstaller();
          else {
            setError('Android still needs permission to install updates from Folio.');
            setStatus('ready');
          }
        });
        return;
      }
      void performCheck(false, false);
    });
    return () => subscription.remove();
  }, [launchInstaller, nativeUpdater, performCheck, support]);

  const checkForUpdates = useCallback(async () => {
    if (support !== 'supported') return;
    await performCheck(true, true);
  }, [performCheck, support]);

  const openUpdateSheet = useCallback(() => {
    setSheetVisible(true);
    setNoticeVisible(false);
  }, []);

  const closeUpdateSheet = useCallback(() => setSheetVisible(false), []);

  const remindLater = useCallback(async () => {
    const nextCache = {
      ...cacheRef.current,
      remindAfter: Date.now() + UPDATE_REMINDER_INTERVAL_MS,
    };
    setSheetVisible(false);
    setNoticeVisible(false);
    await persistCache(nextCache);
  }, [persistCache]);

  const downloadUpdate = useCallback(async () => {
    if (!nativeUpdater || !release?.apk || !installationInfoRef.current) return;
    if (downloadRef.current || status === 'verifying') return;

    const targetUri = await getUpdateFileUri(release.version);
    const previousDownload = cacheRef.current.downloaded;
    cancelRequestedRef.current = false;
    setError(null);
    setProgress(0);
    setStatus('downloading');

    try {
      if (previousDownload) await removeDownloadedUpdate(previousDownload);
      const targetInfo = await FileSystem.getInfoAsync(targetUri);
      if (targetInfo.exists) await FileSystem.deleteAsync(targetUri, { idempotent: true });

      const task = FileSystem.createDownloadResumable(
        release.apk.downloadUrl,
        targetUri,
        { headers: { Accept: 'application/octet-stream' } },
        ({ totalBytesExpectedToWrite, totalBytesWritten }) => {
          if (!mountedRef.current || totalBytesExpectedToWrite <= 0) return;
          setProgress(Math.min(1, Math.max(0, totalBytesWritten / totalBytesExpectedToWrite)));
        },
      );
      downloadRef.current = task;
      const result = await task.downloadAsync();
      downloadRef.current = null;
      if (cancelRequestedRef.current || !result?.uri) {
        setProgress(0);
        setStatus('available');
        return;
      }

      setProgress(1);
      setStatus('verifying');
      const expectedDigest = await expectedReleaseSha256(release);
      const [actualDigest, apkInfo] = await Promise.all([
        nativeUpdater.calculateFileSha256Async(result.uri),
        nativeUpdater.inspectApkAsync(result.uri),
      ]);
      const expectedVersionCode = versionCodeFor(release.version);

      if (actualDigest.toLocaleLowerCase() !== expectedDigest) {
        throw new FolioUpdateError('The downloaded APK failed its SHA-256 integrity check.');
      }
      if (apkInfo.packageName !== 'app.folio.paperless') {
        throw new FolioUpdateError('The downloaded APK is not a Folio package.');
      }
      if (
        apkInfo.versionName !== release.version ||
        apkInfo.versionCode !== expectedVersionCode ||
        apkInfo.versionCode <= installationInfoRef.current.versionCode
      ) {
        throw new FolioUpdateError('The APK version does not match the GitHub release.');
      }
      if (!apkInfo.hasOfficialCertificate) {
        throw new FolioUpdateError('The APK is not signed by Folio’s official release key.');
      }

      const downloaded: DownloadedUpdate = {
        version: release.version,
        fileUri: result.uri,
        digestSha256: actualDigest.toLocaleLowerCase(),
      };
      await persistCache({ ...cacheRef.current, downloaded });
      setCanRequestPackageInstalls(await nativeUpdater.canRequestPackageInstallsAsync());
      setStatus('ready');
      await hapticFeedback('confirm');
    } catch (downloadError) {
      downloadRef.current = null;
      await removeDownloadedUpdate({ version: release.version, fileUri: targetUri, digestSha256: '' });
      if (cancelRequestedRef.current) {
        setProgress(0);
        setStatus('available');
        return;
      }
      await persistCache({ ...cacheRef.current, downloaded: null });
      setError(errorMessage(downloadError));
      setStatus('error');
      await hapticFeedback('error');
    }
  }, [nativeUpdater, persistCache, release, status]);

  const cancelDownload = useCallback(async () => {
    cancelRequestedRef.current = true;
    const task = downloadRef.current;
    downloadRef.current = null;
    try {
      await task?.cancelAsync();
    } finally {
      if (release) {
        const targetUri = await getUpdateFileUri(release.version);
        await removeDownloadedUpdate({ version: release.version, fileUri: targetUri, digestSha256: '' });
      }
      setProgress(0);
      setStatus(release ? 'available' : 'idle');
    }
  }, [release]);

  const installUpdate = useCallback(async () => {
    if (!nativeUpdater || status === 'installing') return;
    const allowed = await nativeUpdater.canRequestPackageInstallsAsync();
    setCanRequestPackageInstalls(allowed);
    setError(null);
    if (allowed) {
      await launchInstaller();
      return;
    }

    awaitingPermissionRef.current = true;
    setStatus('permission');
    await hapticFeedback('warning');
    try {
      await nativeUpdater.openInstallPermissionSettingsAsync();
    } catch (permissionError) {
      awaitingPermissionRef.current = false;
      setError(errorMessage(permissionError));
      setStatus('ready');
      await hapticFeedback('error');
    }
  }, [launchInstaller, nativeUpdater, status]);

  const retry = useCallback(async () => {
    if (cacheRef.current.downloaded && await downloadedUpdateExists(cacheRef.current.downloaded)) {
      setError(null);
      setStatus('ready');
      return;
    }
    if (release && compareStableVersions(release.version, currentVersion) > 0 && release.apk) {
      await downloadUpdate();
      return;
    }
    await checkForUpdates();
  }, [checkForUpdates, currentVersion, downloadUpdate, release]);

  const value = useMemo<UpdateContextValue>(
    () => ({
      status,
      support,
      currentVersion,
      release,
      progress,
      error,
      lastCheckedAt,
      sheetVisible,
      noticeVisible,
      canRequestPackageInstalls,
      checkForUpdates,
      openUpdateSheet,
      closeUpdateSheet,
      remindLater,
      downloadUpdate,
      cancelDownload,
      installUpdate,
      retry,
    }),
    [
      canRequestPackageInstalls,
      cancelDownload,
      checkForUpdates,
      closeUpdateSheet,
      currentVersion,
      downloadUpdate,
      error,
      installUpdate,
      lastCheckedAt,
      noticeVisible,
      openUpdateSheet,
      progress,
      release,
      remindLater,
      retry,
      sheetVisible,
      status,
      support,
    ],
  );

  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useUpdates() {
  const context = useContext(UpdateContext);
  if (!context) throw new Error('useUpdates must be used inside UpdateProvider.');
  return context;
}
