import {
  Bell,
  Check,
  ChevronRight,
  CircleAlert,
  Database,
  Download,
  ExternalLink,
  EyeOff,
  FileText,
  Fingerprint,
  HardDrive,
  Info,
  Languages,
  ListTodo,
  Search,
  RefreshCw,
  Server,
  ShieldCheck,
  SunMoon,
  Trash2,
} from 'lucide-react-native';
import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Switch,
  Text,
  View,
} from 'react-native';

import { AppShell } from '@/components/app-shell';
import { AnimatedSegmentedControl } from '@/components/animated-segmented-control';
import { MotionPressable as Pressable, animateLayout, hapticFeedback } from '@/components/motion';
import { FolioLogo } from '@/components/folio-logo';
import { ProfileManagerSheet } from '@/components/profile-manager-sheet';
import {
  createThemedStyleSheet,
  fonts,
  palette,
  radii,
  resolveThemedPalette,
  useThemedStyles,
} from '@/constants/theme';
import { useApp } from '@/context/app-context';
import { useUpdates } from '@/context/update-context';
import {
  type AppearancePreference,
  type LanguagePreference,
  useI18n,
} from '@/context/ui-preferences-context';
import { presentRuntimeError } from '@/i18n/error-presentation';
import { FOLIO_RELEASES_URL } from '@/lib/app-updates';
import { IN_APP_APK_UPDATES_ENABLED } from '@/lib/distribution-runtime';
import { useRouter } from '@/lib/router';
import { createNativeOsSearchIndexAdapter, type NativeOsSearchEngine } from '@/lib/os-search-native-adapter';
import { presentSyncStatus, type SyncStatusTone } from '@/lib/sync-status-presentation';

type OsSearchCapability = {
  supported: boolean;
  engine: NativeOsSearchEngine;
  reason: string | null;
};

function syncToneColor(tone: SyncStatusTone, colors: typeof palette) {
  if (tone === 'success') return colors.limeDark;
  if (tone === 'progress') return colors.inkSoft;
  if (tone === 'warning') return colors.apricot;
  if (tone === 'danger') return colors.danger;
  return colors.faint;
}

export default function SettingsScreen() {
  const updates = useUpdates();
  const {
    appearance,
    colorScheme,
    language,
    setAppearance,
    setLanguage,
    t,
    formatDate,
    formatFileSize,
    formatNumber,
  } = useI18n();
  const colors = resolveThemedPalette(colorScheme);
  const styles = useThemedStyles(themedStyles, colorScheme);
  const versionLabel = Constants.expoConfig?.version
    ? t('settings.version', { version: Constants.expoConfig.version })
    : t('settings.developmentBuild');
  const router = useRouter();
  const {
    connected,
    profileConfigured,
    activeProfile,
    connectionInfo,
    isSyncing,
    lastSynced,
    syncState,
    online,
    connectionError,
    refresh,
    totalDocuments,
    tasks,
    offlineUsage,
    clearEvictableCache,
    removeAllPinnedFiles,
    refreshOfflineUsage,
    preferences,
    updatePreference,
  } = useApp();
  const [profileManagerVisible, setProfileManagerVisible] = useState(false);
  const [cacheBusy, setCacheBusy] = useState<'clear' | 'pinned' | null>(null);
  const [preferenceSaving, setPreferenceSaving] = useState<keyof typeof preferences | null>(null);
  const [uiPreferenceSaving, setUiPreferenceSaving] = useState<'appearance' | 'language' | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [osSearchCapability, setOsSearchCapability] = useState<OsSearchCapability | null>(() => (
    Platform.OS === 'web'
      ? { supported: false, engine: 'unsupported', reason: 'native-module-unavailable' }
      : null
  ));
  const syncStatus = presentSyncStatus({
    connected: profileConfigured,
    lastSynced,
    online,
    syncState,
  });
  const syncStatusText = t(
    syncStatus.messageKey,
    syncStatus.lastSuccessfulSyncAt
      ? { time: formatDate(syncStatus.lastSuccessfulSyncAt, { dateStyle: 'short', timeStyle: 'short' }) }
      : undefined,
  );

  useEffect(() => {
    let active = true;
    if (Platform.OS === 'web') {
      return () => { active = false; };
    }
    void createNativeOsSearchIndexAdapter()
      .then((adapter) => adapter.capabilities())
      .then((capabilities) => {
        if (active) setOsSearchCapability(capabilities.osSearch);
      })
      .catch(() => {
        if (active) setOsSearchCapability({ supported: false, engine: 'unsupported', reason: 'native-module-unavailable' });
      });
    return () => { active = false; };
  }, []);

  async function handleRefresh() {
    try {
      await refresh();
      animateLayout();
      await hapticFeedback('confirm');
    } catch {
      await hapticFeedback('error');
    }
  }

  async function togglePreference<K extends keyof typeof preferences>(
    key: K,
    value: (typeof preferences)[K],
  ) {
    setPreferenceSaving(key);
    setPreferenceError(null);
    try {
      await updatePreference(key, value);
      await hapticFeedback('selection');
    } catch (error) {
      setPreferenceError(presentRuntimeError(error, t('settings.preferenceError')));
      await hapticFeedback('error');
    } finally {
      setPreferenceSaving(null);
    }
  }

  async function saveUiPreference(
    kind: 'appearance' | 'language',
    value: AppearancePreference | LanguagePreference,
  ) {
    setUiPreferenceSaving(kind);
    setPreferenceError(null);
    try {
      if (kind === 'appearance') await setAppearance(value as AppearancePreference);
      else await setLanguage(value as LanguagePreference);
      await hapticFeedback('selection');
    } catch {
      setPreferenceError(t('settings.preferenceError'));
      await hapticFeedback('error');
    } finally {
      setUiPreferenceSaving(null);
    }
  }

  async function runCacheAction(action: 'clear' | 'pinned') {
    setCacheBusy(action);
    setPreferenceError(null);
    try {
      if (action === 'clear') await clearEvictableCache();
      else await removeAllPinnedFiles();
      await refreshOfflineUsage();
      await hapticFeedback(action === 'clear' ? 'confirm' : 'warning');
    } catch (error) {
      setPreferenceError(presentRuntimeError(error, t('settings.cacheActionError')));
      await hapticFeedback('error');
    } finally {
      setCacheBusy(null);
    }
  }

  function confirmRemovePinned() {
    Alert.alert(
      t('settings.removePinnedTitle'),
      t('settings.removePinnedBody', {
        count: formatNumber(offlineUsage?.pinnedDocuments ?? 0),
        profile: activeProfile?.displayName ?? t('settings.paperlessConnected'),
      }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('settings.removePinnedAction'),
          style: 'destructive',
          onPress: () => void runCacheAction('pinned'),
        },
      ],
    );
  }

  function osSearchUnavailableReason(reason: string | null | undefined) {
    if (reason === 'android-appsearch-requires-api-31') return t('settings.osSearchRequiresApi31');
    if (reason === 'android-appsearch-service-unavailable') return t('settings.osSearchServiceUnavailable');
    if (reason === 'core-spotlight-unavailable') return t('settings.osSearchSpotlightUnavailable');
    return t('settings.osSearchNativeUnavailable');
  }

  async function setOsSearchEnabled(value: boolean) {
    if (value && osSearchCapability?.supported !== true) {
      setPreferenceError(osSearchUnavailableReason(osSearchCapability?.reason));
      await hapticFeedback('error');
      return;
    }
    await togglePreference('osSearchEnabled', value);
  }

  function openSoftwareUpdates() {
    updates.openUpdateSheet();
    if (updates.status === 'idle' || updates.status === 'error') {
      void updates.checkForUpdates();
    }
  }

  const updateSubtitle = (() => {
    if (updates.support === 'initializing') return t('settings.updatePreparing');
    if (updates.support === 'development-build') return t('settings.updateDevelopment');
    if (updates.support === 'module-unavailable') return t('settings.updateRebuild');
    if (updates.support === 'android-release-only') return t('settings.updateAndroidOnly');

    switch (updates.status) {
      case 'checking':
        return t('settings.updateChecking');
      case 'available':
        return t('settings.updateAvailable', {
          version: updates.release?.version || '',
          size: formatFileSize(updates.release?.apk?.size ?? 0),
        });
      case 'downloading':
        return t('settings.updateDownloading', { progress: formatNumber(Math.round(updates.progress * 100)) });
      case 'verifying':
        return t('settings.updateVerifying');
      case 'ready':
        return t('settings.updateReady', { version: updates.release?.version || '' });
      case 'permission':
        return t('settings.updatePermission');
      case 'installing':
        return t('settings.updateInstalling');
      case 'error':
        return t('settings.updateError');
      case 'up-to-date':
        return t('settings.updateCurrent', { version: versionLabel });
      default:
        return t('settings.updateDefault');
    }
  })();

  return (
    <>
    <AppShell showDemoBanner={false}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>{t('settings.yourFolio')}</Text>
          <Text style={styles.title}>{t('settings.title')}</Text>
        </View>
        <FolioLogo inverse size={44} />
      </View>

      <View style={[styles.connectionCard, connected && styles.connectionCardConnected]}>
        <View style={styles.connectionTop}>
          <View style={[styles.serverIcon, connected && styles.serverIconConnected]}>
            {connected ? (
              <ShieldCheck color={colors.accentInk} size={23} />
            ) : (
              <Server color={colors.paper} size={23} />
            )}
          </View>
          <View style={styles.connectionCopy}>
            <View style={styles.connectionStatusRow}>
              <Text style={styles.connectionTitle}>
                {activeProfile?.displayName ?? t('settings.demoWorkspace')}
              </Text>
              <View style={[styles.liveDot, { backgroundColor: syncToneColor(syncStatus.tone, colors) }]} />
            </View>
            <Text style={styles.connectionSubtitle}>
              {activeProfile?.serverUrl ?? t('settings.demoWorkspaceSubtitle')}
            </Text>
          </View>
        </View>

        {connected ? (
          <>
            <View
              accessibilityLabel={syncStatusText}
              accessibilityLiveRegion="polite"
              accessible
              style={styles.syncStatusBanner}>
              <View style={[styles.liveDot, { backgroundColor: syncToneColor(syncStatus.tone, colors) }]} />
              <Text style={styles.syncStatusText}>{syncStatusText}</Text>
            </View>
            <View style={styles.serverStats}>
              <View>
                <Text style={styles.serverStatValue}>{formatNumber(totalDocuments)}</Text>
                <Text style={styles.serverStatLabel}>{t('home.libraryDocuments')}</Text>
              </View>
              <View style={styles.serverDivider} />
              <View>
                <Text style={styles.serverStatValue}>v{connectionInfo?.apiVersion || '10'}</Text>
                <Text style={styles.serverStatLabel}>
                  {t('settings.paperlessServer', {
                    version: connectionInfo?.serverVersion || t('settings.serverFallback'),
                  })}
                </Text>
              </View>
              <Pressable
                accessibilityLabel={t('settings.syncNow')}
                accessibilityState={{ busy: syncStatus.busy, disabled: isSyncing }}
                disabled={isSyncing}
                onPress={handleRefresh}
                style={styles.syncButton}>
                {isSyncing ? (
                  <ActivityIndicator color={colors.accentInk} size="small" />
                ) : (
                  <RefreshCw color={colors.accentInk} size={18} />
                )}
              </Pressable>
            </View>
          </>
        ) : (
          <Pressable
            accessibilityHint={t('settings.connectHint')}
            haptic="medium"
            onPress={() => setProfileManagerVisible(true)}
            style={styles.connectButton}>
            <Server color={colors.accentInk} size={18} />
            <Text style={styles.connectButtonText}>{t('settings.connect')}</Text>
          </Pressable>
        )}

        {profileConfigured && !!connectionError && (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {connectionError}
          </Text>
        )}

        {connected && (
          <View style={styles.connectionActions}>
            <Pressable onPress={() => setProfileManagerVisible(true)} style={styles.manageConnectionsButton}>
              <Server color={colors.inkSoft} size={15} />
              <Text style={styles.changeServer}>{t('settings.manageConnections')}</Text>
              <ChevronRight color={colors.inkSoft} size={15} />
            </Pressable>
          </View>
        )}
      </View>

      <Text style={styles.sectionLabel}>{t('settings.appearanceSection')}</Text>
      <View style={styles.settingsGroup}>
        <PreferenceControl
          busy={uiPreferenceSaving === 'appearance'}
          icon={SunMoon}
          onChange={(value) => saveUiPreference('appearance', value)}
          options={[
            { value: 'system', label: t('settings.system') },
            { value: 'light', label: t('settings.light') },
            { value: 'dark', label: t('settings.dark') },
          ]}
          subtitle={t('settings.appearanceSubtitle')}
          title={t('settings.appearanceTitle')}
          value={appearance}
        />
        <PreferenceControl
          disabled={uiPreferenceSaving === 'language'}
          icon={Languages}
          last
          onChange={(value) => saveUiPreference('language', value)}
          options={[
            { value: 'system', label: t('settings.system') },
            { value: 'en', label: t('settings.english') },
            { value: 'de', label: t('settings.german') },
          ]}
          subtitle={t('settings.languageSubtitle')}
          title={t('settings.languageTitle')}
          value={language}
        />
      </View>

      <Text style={styles.sectionLabel}>{t('settings.privacySection')}</Text>
      <View style={styles.settingsGroup}>
        <SettingRow
          icon={Trash2}
          onPress={() => router.push('/trash')}
          title={t('settings.recentlyDeleted')}
          subtitle={t('settings.recentlyDeletedSubtitle')}
          trailing={<ChevronRight color={colors.faint} size={18} />}
        />
        <SettingRow
          icon={Fingerprint}
          title={t('settings.biometricTitle')}
          subtitle={t('settings.biometricSubtitle')}
          trailing={
            <Switch
              disabled={preferenceSaving === 'biometricLock'}
              onValueChange={(value) => togglePreference('biometricLock', value)}
              trackColor={{ false: colors.lineStrong, true: colors.ink }}
              thumbColor={preferences.biometricLock ? colors.lime : colors.paper}
              value={preferences.biometricLock}
            />
          }
        />
        <SettingRow
          icon={Search}
          title={t('settings.osSearchTitle')}
          subtitle={!osSearchCapability
            ? t('settings.osSearchChecking')
            : osSearchCapability.supported
              ? t('settings.osSearchSubtitle')
              : osSearchUnavailableReason(osSearchCapability.reason)}
          trailing={
            <Switch
              disabled={!osSearchCapability || preferenceSaving === 'osSearchEnabled'}
              onValueChange={(value) => void setOsSearchEnabled(value)}
              trackColor={{ false: colors.lineStrong, true: colors.ink }}
              thumbColor={preferences.osSearchEnabled ? colors.lime : colors.paper}
              value={preferences.osSearchEnabled}
            />
          }
        />
        <PreferenceControl
          disabled={!preferences.osSearchEnabled || osSearchCapability?.supported !== true || preferenceSaving === 'osSearchMetadata'}
          icon={preferences.osSearchMetadata === 'minimal' ? EyeOff : FileText}
          onChange={(value) => togglePreference('osSearchMetadata', value)}
          options={[
            { value: 'minimal', label: t('settings.osSearchMinimal') },
            { value: 'document-title', label: t('settings.osSearchDocumentTitle') },
          ]}
          subtitle={t('settings.osSearchMetadataSubtitle')}
          title={t('settings.osSearchMetadataTitle')}
          value={preferences.osSearchMetadata}
        />
        <SettingRow
          icon={Bell}
          title={t('settings.notificationsTitle')}
          subtitle={t('settings.notificationsSubtitle')}
          trailing={
            <Switch
              disabled={preferenceSaving === 'processingNotifications'}
              onValueChange={(value) => togglePreference('processingNotifications', value)}
              trackColor={{ false: colors.lineStrong, true: colors.ink }}
              thumbColor={preferences.processingNotifications ? colors.lime : colors.paper}
              value={preferences.processingNotifications}
            />
          }
        />
        <PreferenceControl
          disabled={preferenceSaving === 'notificationPrivacy'}
          icon={preferences.notificationPrivacy === 'redacted' ? EyeOff : FileText}
          last
          onChange={(value) => togglePreference('notificationPrivacy', value)}
          options={[
            { value: 'redacted', label: t('settings.notificationPrivacyRedacted') },
            { value: 'document-title', label: t('settings.notificationPrivacyTitleOption') },
          ]}
          subtitle={t('settings.notificationPrivacySubtitle')}
          title={t('settings.notificationPrivacyTitle')}
          value={preferences.notificationPrivacy}
        />
      </View>

      {!!preferenceError && (
        <Text accessibilityLiveRegion="polite" style={styles.preferenceError}>
          {preferenceError}
        </Text>
      )}

      <Text style={styles.sectionLabel}>{t('settings.offlineSection')}</Text>
      {Platform.OS === 'web' ? (
        <View style={styles.storageCard}>
          <View style={styles.storageHeader}>
            <HardDrive color={colors.ink} size={20} />
            <View style={styles.storageCopy}>
              <Text style={styles.storageTitle}>{t('settings.offlineTitle')}</Text>
              <Text style={styles.storageSubtitle}>{t('settings.offlineWeb')}</Text>
            </View>
          </View>
        </View>
      ) : (
        <View style={styles.storageCard}>
          <View style={styles.storageHeader}>
            <HardDrive color={colors.ink} size={20} />
            <View style={styles.storageCopy}>
              <Text style={styles.storageTitle}>{t('settings.offlineTitle')}</Text>
              <Text style={styles.storageSubtitle}>
                {activeProfile
                  ? t('settings.offlineSubtitle', { profile: activeProfile.displayName })
                  : t('settings.demoWorkspaceSubtitle')}
              </Text>
            </View>
            <Text style={styles.storageTotal}>
              {t('settings.cacheTotal', { size: formatFileSize(offlineUsage?.totalBytes ?? 0) })}
            </Text>
          </View>
          <View style={styles.storageBreakdown}>
            <Text style={styles.storageMetric}>
              {t('settings.cacheAutomatic', { size: formatFileSize(offlineUsage?.automaticBytes ?? 0) })}
            </Text>
            <Text style={styles.storageMetric}>
              {t('settings.cachePinned', {
                size: formatFileSize(offlineUsage?.pinnedBytes ?? 0),
                count: formatNumber(offlineUsage?.pinnedDocuments ?? 0),
              })}
            </Text>
          </View>
          <QuotaControl
            disabled={!activeProfile || preferenceSaving === 'automaticCacheLimitBytes'}
            onChange={(value) => togglePreference('automaticCacheLimitBytes', value)}
            title={t('settings.cacheLimit')}
            value={preferences.automaticCacheLimitBytes}
          />
          <View style={styles.storageActions}>
            <StorageAction
              disabled={!activeProfile || cacheBusy !== null}
              icon={Database}
              loading={cacheBusy === 'clear'}
              onPress={() => runCacheAction('clear')}
              subtitle={t('settings.clearCacheSubtitle')}
              title={t('settings.clearCache')}
            />
            <StorageAction
              disabled={!activeProfile || !offlineUsage?.pinnedFiles || cacheBusy !== null}
              icon={Trash2}
              loading={cacheBusy === 'pinned'}
              onPress={confirmRemovePinned}
              subtitle={t('settings.removePinnedSubtitle')}
              title={t('settings.removePinned')}
            />
          </View>
        </View>
      )}

      <View style={[styles.settingsGroup, styles.taskCenterGroup]}>
        <SettingRow
          icon={ListTodo}
          last
          onPress={() => router.push('/tasks')}
          title={t('home.taskCenter')}
          subtitle={t('settings.taskCenterSubtitle', {
            active: formatNumber(tasks.filter((task) => !['ready', 'canceled', 'failed'].includes(task.stage)).length),
            failed: formatNumber(tasks.filter((task) => task.stage === 'failed').length),
          })}
          trailing={<ChevronRight color={colors.faint} size={18} />}
        />
      </View>

      <Text style={styles.sectionLabel}>{t('settings.aboutSection')}</Text>
      <View style={styles.settingsGroup}>
        {IN_APP_APK_UPDATES_ENABLED && (
          Platform.OS === 'android' ? (
            <SettingRow
              icon={Download}
              onPress={openSoftwareUpdates}
              title={t('settings.softwareUpdates')}
              subtitle={updateSubtitle}
              trailing={<UpdateStatusTrailing />}
            />
          ) : (
            <SettingRow
              icon={Download}
              onPress={() => Linking.openURL(FOLIO_RELEASES_URL)}
              title={t('updates.viewReleases')}
              subtitle={t('updates.platformUnsupported')}
              trailing={<ExternalLink color={colors.faint} size={18} />}
            />
          )
        )}
        <SettingRow
          icon={Info}
          onPress={() =>
            Alert.alert(
              t('settings.appName'),
              t('settings.aboutBody', { version: versionLabel }),
            )
          }
          title={t('settings.aboutFolio')}
          subtitle={`${versionLabel} · Expo SDK 57`}
          trailing={<ChevronRight color={colors.faint} size={18} />}
        />
        <SettingRow
          icon={ExternalLink}
          last
          onPress={() => Linking.openURL('https://docs.paperless-ngx.com/')}
          title={t('settings.paperlessDocs')}
          subtitle={t('settings.paperlessDocsSubtitle')}
          trailing={<ChevronRight color={colors.faint} size={18} />}
        />
      </View>

      <Text style={styles.privacyNote}>
        {t(Platform.OS === 'web' ? 'settings.privacyNoteWeb' : 'settings.privacyNoteNative')}
      </Text>
    </AppShell>

    <ProfileManagerSheet
      onDismiss={() => setProfileManagerVisible(false)}
      visible={profileManagerVisible}
    />
    </>
  );
}

type IconComponent = typeof Bell;

function PreferenceControl<T extends string>({
  busy,
  disabled,
  icon: Icon,
  title,
  subtitle,
  options,
  value,
  onChange,
  last = false,
}: {
  busy?: boolean;
  disabled?: boolean;
  icon: IconComponent;
  title: string;
  subtitle: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  last?: boolean;
}) {
  const { colorScheme } = useI18n();
  const colors = resolveThemedPalette(colorScheme);
  const styles = useThemedStyles(themedStyles, colorScheme);
  return (
    <View style={[styles.preferenceControl, last && styles.settingRowLast]}>
      <View style={styles.preferenceHeading}>
        <View style={styles.settingIcon}>
          <Icon color={colors.ink} size={19} />
        </View>
        <View style={styles.settingCopy}>
          <Text style={styles.settingTitle}>{title}</Text>
          <Text style={styles.settingSubtitle}>{subtitle}</Text>
        </View>
      </View>
      <AnimatedSegmentedControl
        accessibilityLabel={title}
        busy={busy}
        disabled={disabled}
        onChange={onChange}
        options={options}
        value={value}
      />
    </View>
  );
}

function SettingRow({
  icon: Icon,
  title,
  subtitle,
  trailing,
  onPress,
  last = false,
}: {
  icon: IconComponent;
  title: string;
  subtitle: string;
  trailing: React.ReactNode;
  onPress?: () => void;
  last?: boolean;
}) {
  const { colorScheme } = useI18n();
  const colors = resolveThemedPalette(colorScheme);
  const styles = useThemedStyles(themedStyles, colorScheme);
  return (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      style={[styles.settingRow, last && styles.settingRowLast]}>
      <View style={styles.settingIcon}>
        <Icon color={colors.ink} size={19} />
      </View>
      <View style={styles.settingCopy}>
        <Text style={styles.settingTitle}>{title}</Text>
        <Text style={styles.settingSubtitle}>{subtitle}</Text>
      </View>
      {trailing}
    </Pressable>
  );
}

function QuotaControl({ disabled, onChange, title, value }: {
  disabled?: boolean;
  onChange: (value: number) => void;
  title: string;
  value: number;
}) {
  const { colorScheme, formatFileSize } = useI18n();
  const styles = useThemedStyles(themedStyles, colorScheme);
  const options = [128, 256, 512, 1024].map((megabytes) => {
    const bytes = megabytes * 1024 * 1024;
    return { value: String(bytes), label: formatFileSize(bytes) };
  });
  return (
    <View style={styles.quotaControl}>
      <Text style={styles.quotaTitle}>{title}</Text>
      <AnimatedSegmentedControl
        accessibilityLabel={title}
        compact
        disabled={disabled}
        onChange={(nextValue) => onChange(Number(nextValue))}
        options={options}
        value={String(value)}
      />
    </View>
  );
}

function StorageAction({ disabled, icon: Icon, loading, onPress, subtitle, title }: {
  disabled?: boolean;
  icon: IconComponent;
  loading?: boolean;
  onPress: () => void;
  subtitle: string;
  title: string;
}) {
  const { colorScheme } = useI18n();
  const colors = resolveThemedPalette(colorScheme);
  const styles = useThemedStyles(themedStyles, colorScheme);
  return (
    <Pressable disabled={disabled} onPress={onPress} style={[styles.storageAction, disabled && styles.disabled]}>
      <View style={styles.storageActionIcon}>
        {loading ? <ActivityIndicator color={colors.ink} size="small" /> : <Icon color={colors.ink} size={18} />}
      </View>
      <View style={styles.storageActionCopy}>
        <Text style={styles.storageActionTitle}>{title}</Text>
        <Text style={styles.storageActionSubtitle}>{subtitle}</Text>
      </View>
      <ChevronRight color={colors.faint} size={17} />
    </Pressable>
  );
}

function UpdateStatusTrailing() {
  const { status } = useUpdates();
  const { colorScheme, t } = useI18n();
  const colors = resolveThemedPalette(colorScheme);
  const styles = useThemedStyles(themedStyles, colorScheme);
  if (status === 'checking' || status === 'downloading' || status === 'verifying' || status === 'installing') {
    return <ActivityIndicator color={colors.ink} size="small" />;
  }
  if (status === 'available') {
    return (
      <View style={styles.updateBadge}>
        <Text style={[styles.updateBadgeText, styles.updateBadgeTextAccent]}>{t('settings.badgeNew')}</Text>
      </View>
    );
  }
  if (status === 'ready' || status === 'permission') {
    return (
      <View style={[styles.updateBadge, styles.updateBadgeReady]}>
        <Text style={styles.updateBadgeText}>{t('settings.badgeReady')}</Text>
      </View>
    );
  }
  if (status === 'error') return <CircleAlert color={colors.danger} size={18} />;
  if (status === 'up-to-date') return <Check color={colors.limeDark} size={19} strokeWidth={2.5} />;
  return <ChevronRight color={colors.faint} size={18} />;
}

const themedStyles = createThemedStyleSheet({
  header: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginTop: 8,
    marginBottom: 22,
  },
  eyebrow: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  title: {
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 40,
    fontWeight: '600',
    letterSpacing: -1.3,
  },
  connectionCard: {
    padding: 17,
    borderRadius: radii.lg,
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: palette.line,
  },
  connectionCardConnected: {
    backgroundColor: palette.mint,
    borderColor: palette.lineStrong,
  },
  connectionTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  serverIcon: {
    width: 46,
    height: 46,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.ink,
  },
  serverIconConnected: {
    backgroundColor: palette.lime,
  },
  connectionCopy: {
    flex: 1,
  },
  connectionStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  connectionTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 15,
    fontWeight: '900',
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: palette.faint,
  },
  connectionSubtitle: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 3,
  },
  sheetForm: { paddingTop: 12 },
  inputLabel: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.9,
    marginBottom: 6,
    marginTop: 10,
  },
  inputWrap: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 13,
    paddingVertical: 9,
    borderRadius: radii.sm,
    backgroundColor: palette.paperStrong,
    borderWidth: 1,
    borderColor: palette.line,
  },
  inputWrapFocused: {
    borderColor: palette.ink,
    borderWidth: 2,
  },
  input: {
    flex: 1,
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
  },
  error: {
    color: palette.danger,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 9,
  },
  preferenceError: {
    color: palette.danger,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: 12,
    marginTop: 9,
  },
  connectButton: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: radii.sm,
    backgroundColor: palette.lime,
    marginTop: 15,
  },
  sheetActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingTop: 16,
    paddingBottom: 8,
  },
  cancelButton: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: radii.sm,
    backgroundColor: palette.paper,
  },
  cancelText: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '800',
  },
  sheetConnectButton: {
    flex: 1,
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderRadius: radii.sm,
    backgroundColor: palette.lime,
  },
  connectButtonDisabled: {
    opacity: 0.45,
  },
  connectButtonText: {
    color: palette.accentInk,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '900',
  },
  serverStats: {
    minHeight: 75,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    paddingTop: 8,
    marginTop: 4,
  },
  syncStatusBanner: {
    minHeight: 35,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingTop: 13,
    marginTop: 13,
    borderTopWidth: 1,
    borderColor: palette.lineStrong,
  },
  syncStatusText: {
    flex: 1,
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 16,
  },
  serverStatValue: {
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 23,
    fontWeight: '700',
  },
  serverStatLabel: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 9,
    marginTop: 1,
  },
  serverDivider: {
    width: 1,
    height: 35,
    backgroundColor: palette.lineStrong,
  },
  syncButton: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.lime,
    marginLeft: 'auto',
  },
  connectionActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginTop: 13,
  },
  manageConnectionsButton: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: radii.sm,
    backgroundColor: palette.paperScrim,
  },
  changeServer: {
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '700',
  },
  disconnect: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  disconnectText: {
    color: palette.danger,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '700',
  },
  successBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 13,
    paddingVertical: 11,
    borderRadius: radii.sm,
    backgroundColor: palette.lime,
    marginTop: 10,
  },
  successText: {
    color: palette.accentInk,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '700',
  },
  sectionLabel: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1.1,
    marginTop: 27,
    marginBottom: 9,
  },
  settingsGroup: {
    paddingHorizontal: 14,
    borderRadius: radii.lg,
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: palette.line,
  },
  settingRow: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    borderBottomWidth: 1,
    borderColor: palette.line,
  },
  settingRowLast: {
    borderBottomWidth: 0,
  },
  preferenceControl: {
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderColor: palette.line,
  },
  preferenceHeading: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
  },
  settingIcon: {
    width: 36,
    height: 36,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.canvas,
  },
  settingCopy: {
    flex: 1,
  },
  settingTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '800',
  },
  settingSubtitle: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    marginTop: 3,
  },
  storageCard: {
    padding: 15,
    borderRadius: radii.lg,
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: palette.line,
  },
  storageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
  },
  storageCopy: { flex: 1, minWidth: 0 },
  storageTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '900',
  },
  storageSubtitle: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    lineHeight: 15,
    marginTop: 3,
  },
  storageTotal: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '900',
    textAlign: 'right',
  },
  storageBreakdown: {
    gap: 4,
    paddingVertical: 12,
    marginTop: 12,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: palette.line,
  },
  storageMetric: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    lineHeight: 15,
  },
  quotaControl: { paddingTop: 13 },
  quotaTitle: {
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '800',
    marginBottom: 8,
  },
  storageActions: { marginTop: 10 },
  storageAction: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderTopWidth: 1,
    borderColor: palette.line,
  },
  storageActionIcon: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: palette.canvas,
  },
  storageActionCopy: { flex: 1, minWidth: 0 },
  storageActionTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '800',
  },
  storageActionSubtitle: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 9,
    lineHeight: 14,
    marginTop: 2,
  },
  taskCenterGroup: { marginTop: 10 },
  updateBadge: {
    minWidth: 42,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderRadius: radii.pill,
    backgroundColor: palette.lime,
  },
  updateBadgeReady: {
    backgroundColor: palette.mint,
  },
  updateBadgeText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  updateBadgeTextAccent: { color: palette.accentInk },
  privacyNote: {
    color: palette.faint,
    fontFamily: fonts.sans,
    fontSize: 10,
    lineHeight: 16,
    textAlign: 'center',
    paddingHorizontal: 20,
    marginTop: 18,
  },
  disabled: { opacity: 0.42 },
  pressed: {
    opacity: 0.75,
    transform: [{ scale: 0.985 }],
  },
});
