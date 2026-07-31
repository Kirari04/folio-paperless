import {
  Bell,
  Check,
  ChevronRight,
  Cloud,
  ExternalLink,
  Fingerprint,
  Info,
  LockKeyhole,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  Unplug,
} from 'lucide-react-native';
import Constants from 'expo-constants';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { AppShell } from '@/components/app-shell';
import { KeyboardSheet, KeyboardSheetHandle } from '@/components/keyboard-sheet';
import { MotionPressable as Pressable, animateLayout, hapticFeedback } from '@/components/motion';
import { FolioLogo } from '@/components/folio-logo';
import { fonts, palette, radii } from '@/constants/theme';
import { useApp } from '@/context/app-context';
import { useRouter } from '@/lib/router';

export default function SettingsScreen() {
  const versionLabel = Constants.expoConfig?.version
    ? `Version ${Constants.expoConfig.version}`
    : 'Development build';
  const serverSheetRef = useRef<KeyboardSheetHandle>(null);
  const serverInputRef = useRef<TextInput>(null);
  const tokenInputRef = useRef<TextInput>(null);
  const router = useRouter();
  const {
    connected,
    credentials,
    connectionInfo,
    isSyncing,
    lastSynced,
    connectionError,
    connect,
    disconnect,
    refresh,
    totalDocuments,
    preferences,
    updatePreference,
  } = useApp();
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [editingServer, setEditingServer] = useState(false);
  const [success, setSuccess] = useState(false);
  const [preferenceSaving, setPreferenceSaving] = useState<keyof typeof preferences | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);
  const [focusedInput, setFocusedInput] = useState<'server' | 'token' | null>(null);

  async function handleConnect() {
    setSuccess(false);
    try {
      await connect({ serverUrl, token });
      animateLayout();
      setSuccess(true);
      await hapticFeedback('confirm');
      serverSheetRef.current?.close();
    } catch {
      await hapticFeedback('error');
    }
  }

  async function disconnectNow() {
    await disconnect();
    animateLayout();
    setEditingServer(false);
    setServerUrl('');
    setToken('');
    setSuccess(false);
    await hapticFeedback('warning');
  }

  function handleDisconnect() {
    Alert.alert(
      'Disconnect Paperless?',
      'Your server token will be removed from this device. Demo documents will be shown instead.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Disconnect', style: 'destructive', onPress: disconnectNow },
      ],
    );
  }

  async function handleRefresh() {
    try {
      await refresh();
      animateLayout();
      setSuccess(true);
      await hapticFeedback('confirm');
      setTimeout(() => setSuccess(false), 2000);
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
      setPreferenceError(error instanceof Error ? error.message : 'Could not save this preference.');
      await hapticFeedback('error');
    } finally {
      setPreferenceSaving(null);
    }
  }

  function toggleServerForm() {
    if (editingServer) {
      serverSheetRef.current?.close();
      return;
    }
    setServerUrl(credentials?.serverUrl || '');
    setToken(credentials?.token || '');
    setEditingServer(true);
  }

  return (
    <>
    <AppShell showDemoBanner={false}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>YOUR FOLIO</Text>
          <Text style={styles.title}>Settings</Text>
        </View>
        <FolioLogo inverse size={44} />
      </View>

      <View style={[styles.connectionCard, connected && styles.connectionCardConnected]}>
        <View style={styles.connectionTop}>
          <View style={[styles.serverIcon, connected && styles.serverIconConnected]}>
            {connected ? (
              <ShieldCheck color={palette.ink} size={23} />
            ) : (
              <Server color={palette.paper} size={23} />
            )}
          </View>
          <View style={styles.connectionCopy}>
            <View style={styles.connectionStatusRow}>
              <Text style={styles.connectionTitle}>
                {connected ? 'Paperless connected' : 'Demo workspace'}
              </Text>
              <View style={[styles.liveDot, connected && styles.liveDotConnected]} />
            </View>
            <Text style={styles.connectionSubtitle}>
              {connected
                ? credentials?.serverUrl
                : 'Explore with sample documents, or connect your server.'}
            </Text>
          </View>
        </View>

        {connected ? (
          <View style={styles.serverStats}>
            <View>
              <Text style={styles.serverStatValue}>{totalDocuments}</Text>
              <Text style={styles.serverStatLabel}>documents · synced {lastSynced}</Text>
            </View>
            <View style={styles.serverDivider} />
            <View>
              <Text style={styles.serverStatValue}>v{connectionInfo?.apiVersion || '10'}</Text>
              <Text style={styles.serverStatLabel}>
                Paperless {connectionInfo?.serverVersion || 'server'}
              </Text>
            </View>
            <Pressable
              accessibilityLabel="Sync now"
              disabled={isSyncing}
              onPress={handleRefresh}
              style={styles.syncButton}>
              {isSyncing ? (
                <ActivityIndicator color={palette.ink} size="small" />
              ) : (
                <RefreshCw color={palette.ink} size={18} />
              )}
            </Pressable>
          </View>
        ) : (
          <Pressable
            accessibilityHint="Opens a keyboard-safe server connection form"
            haptic="medium"
            onPress={toggleServerForm}
            style={styles.connectButton}>
            <Cloud color={palette.ink} size={18} />
            <Text style={styles.connectButtonText}>Connect Paperless</Text>
          </Pressable>
        )}

        {connected && !!connectionError && (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {connectionError}
          </Text>
        )}

        {connected && (
          <View style={styles.connectionActions}>
            <Pressable onPress={toggleServerForm}>
              <Text style={styles.changeServer}>Change server</Text>
            </Pressable>
            <Pressable onPress={handleDisconnect} style={styles.disconnect}>
              <Unplug color={palette.danger} size={14} />
              <Text style={styles.disconnectText}>Disconnect</Text>
            </Pressable>
          </View>
        )}
      </View>

      {success && (
        <View style={styles.successBanner}>
          <Check color={palette.ink} size={16} />
          <Text style={styles.successText}>Connection saved securely on this device.</Text>
        </View>
      )}

      <Text style={styles.sectionLabel}>PRIVACY & EXPERIENCE</Text>
      <View style={styles.settingsGroup}>
        <SettingRow
          icon={Trash2}
          onPress={() => router.push('/trash')}
          title="Recently deleted"
          subtitle="Restore documents or empty the Paperless trash"
          trailing={<ChevronRight color={palette.faint} size={18} />}
        />
        <SettingRow
          icon={Fingerprint}
          title="Unlock with biometrics"
          subtitle="Keep document previews private"
          trailing={
            <Switch
              disabled={preferenceSaving === 'biometricLock'}
              onValueChange={(value) => togglePreference('biometricLock', value)}
              trackColor={{ false: palette.lineStrong, true: palette.ink }}
              thumbColor={preferences.biometricLock ? palette.lime : palette.paper}
              value={preferences.biometricLock}
            />
          }
        />
        <SettingRow
          icon={Bell}
          title="Processing notifications"
          subtitle="Notify when an uploaded document is ready"
          trailing={
            <Switch
              disabled={preferenceSaving === 'processingNotifications'}
              onValueChange={(value) => togglePreference('processingNotifications', value)}
              trackColor={{ false: palette.lineStrong, true: palette.ink }}
              thumbColor={preferences.processingNotifications ? palette.lime : palette.paper}
              value={preferences.processingNotifications}
            />
          }
        />
      </View>

      {!!preferenceError && (
        <Text accessibilityLiveRegion="polite" style={styles.preferenceError}>
          {preferenceError}
        </Text>
      )}

      <Text style={styles.sectionLabel}>ABOUT</Text>
      <View style={styles.settingsGroup}>
        <SettingRow
          icon={Info}
          onPress={() =>
            Alert.alert(
              'Folio for Paperless',
              `${versionLabel}\nExpo SDK 57\n\nA private, direct-to-server Paperless-ngx client.`,
            )
          }
          title="About Folio"
          subtitle={`${versionLabel} · Expo SDK 57`}
          trailing={<ChevronRight color={palette.faint} size={18} />}
        />
        <SettingRow
          icon={ExternalLink}
          onPress={() => Linking.openURL('https://docs.paperless-ngx.com/')}
          title="Paperless documentation"
          subtitle="API and server setup"
          trailing={<ChevronRight color={palette.faint} size={18} />}
        />
      </View>

      <Text style={styles.privacyNote}>
        Folio talks directly to your Paperless-ngx server. Your token is stored in{' '}
        {Platform.OS === 'web' ? 'this browser' : 'the device secure store'} and is never sent
        anywhere else.
      </Text>
    </AppShell>

    {editingServer && (
      <KeyboardSheet
        accessibilityLabel="Paperless server connection"
        onDismiss={() => {
          setEditingServer(false);
          setFocusedInput(null);
        }}
        onOpened={() => serverInputRef.current?.focus()}
        ref={serverSheetRef}
        subtitle="Your credentials stay on this device and connect directly to Paperless."
        title={connected ? 'Change server' : 'Connect Paperless'}
        visible>
        <View style={styles.sheetForm}>
          <Text style={styles.inputLabel}>SERVER URL</Text>
          <View style={[styles.inputWrap, focusedInput === 'server' && styles.inputWrapFocused]}>
            <Cloud color={palette.muted} size={18} />
            <TextInput
              accessibilityLabel="Paperless server URL"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onBlur={() => setFocusedInput(null)}
              onChangeText={setServerUrl}
              onFocus={() => setFocusedInput('server')}
              onSubmitEditing={() => tokenInputRef.current?.focus()}
              placeholder="https://paperless.example.com"
              placeholderTextColor={palette.faint}
              ref={serverInputRef}
              returnKeyType="next"
              style={styles.input}
              value={serverUrl}
            />
          </View>
          <Text style={styles.inputLabel}>API TOKEN</Text>
          <View style={[styles.inputWrap, focusedInput === 'token' && styles.inputWrapFocused]}>
            <LockKeyhole color={palette.muted} size={18} />
            <TextInput
              accessibilityLabel="Paperless API token"
              autoCapitalize="none"
              autoCorrect={false}
              onBlur={() => setFocusedInput(null)}
              onChangeText={setToken}
              onFocus={() => setFocusedInput('token')}
              onSubmitEditing={serverUrl.trim() && token.trim() ? handleConnect : undefined}
              placeholder="Paste your Paperless token"
              placeholderTextColor={palette.faint}
              ref={tokenInputRef}
              returnKeyType="done"
              secureTextEntry
              style={styles.input}
              value={token}
            />
          </View>
          {!!connectionError && (
            <Text accessibilityLiveRegion="polite" style={styles.error}>{connectionError}</Text>
          )}
        </View>
        <View style={styles.sheetActions}>
          <Pressable haptic="light" onPress={() => serverSheetRef.current?.close()} style={styles.cancelButton}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="Test and connect to Paperless"
            disabled={!serverUrl.trim() || !token.trim() || isSyncing}
            haptic="none"
            onPress={handleConnect}
            style={[
              styles.sheetConnectButton,
              (!serverUrl.trim() || !token.trim()) && styles.connectButtonDisabled,
            ]}>
            {isSyncing ? (
              <ActivityIndicator color={palette.ink} size="small" />
            ) : (
              <Check color={palette.ink} size={19} />
            )}
            <Text style={styles.connectButtonText}>Test & connect</Text>
          </Pressable>
        </View>
      </KeyboardSheet>
    )}
    </>
  );
}

type IconComponent = typeof Bell;

function SettingRow({
  icon: Icon,
  title,
  subtitle,
  trailing,
  onPress,
}: {
  icon: IconComponent;
  title: string;
  subtitle: string;
  trailing: React.ReactNode;
  onPress?: () => void;
}) {
  return (
    <Pressable disabled={!onPress} onPress={onPress} style={styles.settingRow}>
      <View style={styles.settingIcon}>
        <Icon color={palette.ink} size={19} />
      </View>
      <View style={styles.settingCopy}>
        <Text style={styles.settingTitle}>{title}</Text>
        <Text style={styles.settingSubtitle}>{subtitle}</Text>
      </View>
      {trailing}
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
    backgroundColor: '#E4EBD8',
    borderColor: '#D4DFC2',
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
  liveDotConnected: {
    backgroundColor: '#4C9B60',
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
    height: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingHorizontal: 13,
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
    height: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
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
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
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
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radii.sm,
    backgroundColor: palette.lime,
  },
  connectButtonDisabled: {
    opacity: 0.45,
  },
  connectButtonText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '900',
  },
  serverStats: {
    minHeight: 75,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    paddingTop: 16,
    marginTop: 15,
    borderTopWidth: 1,
    borderColor: '#CDD9BB',
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
    backgroundColor: '#CDD9BB',
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
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 13,
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
    color: palette.ink,
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
  privacyNote: {
    color: palette.faint,
    fontFamily: fonts.sans,
    fontSize: 10,
    lineHeight: 16,
    textAlign: 'center',
    paddingHorizontal: 20,
    marginTop: 18,
  },
  pressed: {
    opacity: 0.75,
    transform: [{ scale: 0.985 }],
  },
});
