import {
  AlertTriangle,
  Check,
  ChevronRight,
  Cloud,
  Fingerprint,
  KeyRound,
  LogOut,
  Plus,
  Server,
  Shield,
  Trash2,
  UserRound,
} from 'lucide-react-native';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { KeyboardSheet, type KeyboardSheetHandle } from '@/components/keyboard-sheet';
import { MotionPressable as Pressable, animateLayout, hapticFeedback } from '@/components/motion';
import { fonts, palette, radii } from '@/constants/theme';
import { useApp } from '@/context/app-context';
import { useI18n } from '@/context/ui-preferences-context';
import { presentAuthError } from '@/lib/auth/error-presentation';
import {
  folioOidcRedirectUri,
  isOidcSignatureVerificationAvailable,
} from '@/lib/auth/oidc-expo';
import type {
  ConnectionProfileAuthDraft,
  ConnectionProfileDraft,
} from '@/lib/auth/profile-management';
import type { ClientIdentityMetadata, ConnectionProfile } from '@/lib/auth/profile-store';
import type { TranslationKey } from '@/i18n/catalogs';

type AuthKind = ConnectionProfileAuthDraft['kind'];
type BusyAction = 'test' | 'save' | 'rename' | 'switch' | 'remove' | 'revoke' | null;

type HeaderDraft = { name: string; value: string; retained: boolean };

const AUTH_OPTIONS: { kind: AuthKind; icon: typeof KeyRound }[] = [
  { kind: 'token', icon: KeyRound },
  { kind: 'paperless-credentials', icon: UserRound },
  { kind: 'oidc', icon: Shield },
  { kind: 'mutual-tls', icon: Fingerprint },
  { kind: 'custom-headers', icon: Server },
];

function emptyHeaders(): HeaderDraft[] {
  return [
    { name: 'X-Api-Key', value: '', retained: false },
    { name: '', value: '', retained: false },
  ];
}

export function ProfileManagerSheet({ visible, onDismiss }: {
  visible: boolean;
  onDismiss: () => void;
}) {
  const {
    profiles,
    activeProfile,
    profileOwnership,
    testConnectionProfile,
    discardConnectionProfileTest,
    saveConnectionProfile,
    renameConnectionProfile,
    revokeProfileOidc,
    switchProfile,
    removeProfile,
  } = useApp();
  const { t, formatDate, formatNumber } = useI18n();
  const sheetRef = useRef<KeyboardSheetHandle>(null);
  const testController = useRef<AbortController | null>(null);
  const pendingDiscard = useRef<Promise<void>>(Promise.resolve());
  const [screen, setScreen] = useState<'list' | 'form'>('list');
  const [editing, setEditing] = useState<ConnectionProfile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [authKind, setAuthKind] = useState<AuthKind>('token');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [otpRequired, setOtpRequired] = useState(false);
  const [oidcIssuer, setOidcIssuer] = useState('');
  const [oidcClientId, setOidcClientId] = useState('');
  const [oidcScopes, setOidcScopes] = useState('openid profile email');
  const [headers, setHeaders] = useState<HeaderDraft[]>(emptyHeaders());
  const [testResult, setTestResult] = useState<{
    preparationId: string;
    serverVersion: string;
    apiVersion: string;
    username?: string;
    authorizationWarning: boolean;
    clientIdentity?: ClientIdentityMetadata;
  } | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const oidcVerifierAvailable = isOidcSignatureVerificationAvailable();

  function queueTestDiscard(preparationId: string) {
    pendingDiscard.current = pendingDiscard.current
      .then(() => discardConnectionProfileTest(preparationId))
      .catch(() => undefined);
  }

  function invalidateTest() {
    testController.current?.abort();
    testController.current = null;
    if (busy === 'test') setBusy(null);
    if (testResult?.preparationId) {
      queueTestDiscard(testResult.preparationId);
    }
    setTestResult(null);
    setError(null);
    setNotice(null);
  }

  function setField(setter: (value: string) => void, value: string) {
    setter(value);
    invalidateTest();
  }

  function startAdd() {
    setEditing(null);
    setDisplayName('');
    setServerUrl('');
    setAuthKind('token');
    setToken('');
    setUsername('');
    setPassword('');
    setOtpCode('');
    setOtpRequired(false);
    setOidcIssuer('');
    setOidcClientId('');
    setOidcScopes('openid profile email');
    setHeaders(emptyHeaders());
    invalidateTest();
    setError(null);
    setNotice(null);
    setScreen('form');
    animateLayout();
  }

  function startEdit(profile: ConnectionProfile) {
    setEditing(profile);
    setDisplayName(profile.displayName);
    setServerUrl(profile.serverUrl);
    setAuthKind(profile.auth.kind);
    setToken('');
    setUsername(profile.auth.kind === 'paperless-credentials' ? profile.auth.username : '');
    setPassword('');
    setOtpCode('');
    setOtpRequired(false);
    setOidcIssuer(profile.auth.kind === 'oidc' ? profile.auth.issuer : '');
    setOidcClientId(profile.auth.kind === 'oidc' ? profile.auth.clientId : '');
    setOidcScopes(profile.auth.kind === 'oidc' ? profile.auth.scopes.join(' ') : 'openid profile email');
    const retained = profile.customHeaderNames.map((name) => ({
      name,
      value: '',
      retained: true,
    }));
    setHeaders([...retained, ...emptyHeaders()].slice(0, Math.max(2, retained.length)));
    setTestResult(null);
    setError(null);
    setNotice(null);
    setScreen('form');
    animateLayout();
  }

  function backToList() {
    testController.current?.abort();
    testController.current = null;
    setScreen('list');
    setEditing(null);
    setToken('');
    setPassword('');
    setOtpCode('');
    invalidateTest();
    setError(null);
    animateLayout();
  }

  function buildDraft(identityAction?: 'reuse' | 'select' | 'import'): ConnectionProfileDraft {
    let auth: ConnectionProfileAuthDraft;
    switch (authKind) {
      case 'token':
        auth = { kind: 'token', ...(token ? { token } : {}) };
        break;
      case 'paperless-credentials':
        auth = {
          kind: 'paperless-credentials',
          username,
          ...(password ? { password } : {}),
          ...(otpCode ? { otpCode } : {}),
        };
        break;
      case 'oidc':
        auth = {
          kind: 'oidc',
          issuer: oidcIssuer,
          clientId: oidcClientId,
          redirectUri: folioOidcRedirectUri(),
          scopes: oidcScopes.split(/\s+/).filter(Boolean),
          forceLogin: !editing || editing.auth.kind !== 'oidc',
        };
        break;
      case 'mutual-tls':
        auth = {
          kind: 'mutual-tls',
          ...(identityAction ? { identityAction } : {}),
          ...(editing?.auth.kind === 'mutual-tls'
            ? { identity: editing.auth.identity }
            : {}),
        };
        break;
      case 'custom-headers':
        auth = {
          kind: 'custom-headers',
          headers: Object.fromEntries(
            headers
              .filter((header) => header.name.trim() && header.value)
              .map((header) => [header.name.trim(), header.value]),
          ),
          retainedHeaderNames: headers
            .filter((header) => header.retained && header.name.trim() && !header.value)
            .map((header) => header.name.trim()),
        };
        break;
    }
    return {
      ...(editing ? { profileId: editing.id } : {}),
      displayName,
      serverUrl,
      auth,
    };
  }

  async function handleTest(identityAction?: 'reuse' | 'select' | 'import') {
    testController.current?.abort();
    const controller = new AbortController();
    testController.current = controller;
    setBusy('test');
    setError(null);
    setNotice(null);
    try {
      if (testResult?.preparationId) {
        queueTestDiscard(testResult.preparationId);
        setTestResult(null);
      }
      await pendingDiscard.current;
      const result = await testConnectionProfile(buildDraft(identityAction), controller.signal);
      if (controller.signal.aborted || testController.current !== controller) {
        queueTestDiscard(result.preparationId);
        return;
      }
      setOtpRequired(false);
      setTestResult({
        preparationId: result.preparationId,
        serverVersion: result.connection.serverVersion,
        apiVersion: result.connection.apiVersion,
        username: result.connection.username,
        authorizationWarning: result.warnings.includes('authorization-overrides-profile-auth'),
        clientIdentity: result.clientIdentity,
      });
      await hapticFeedback('confirm');
    } catch (caught) {
      if (controller.signal.aborted || testController.current !== controller) return;
      const code = caught && typeof caught === 'object' && 'code' in caught
        ? String(caught.code)
        : '';
      if (code === 'otp-required' || code === 'otp-invalid') setOtpRequired(true);
      setError(presentAuthError(caught));
      await hapticFeedback('error');
    } finally {
      if (testController.current === controller) {
        testController.current = null;
        setBusy(null);
      }
    }
  }

  async function handleSave() {
    if (!testResult) return;
    setBusy('save');
    setError(null);
    try {
      await saveConnectionProfile(buildDraft(), testResult.preparationId);
      setToken('');
      setPassword('');
      setOtpCode('');
      setNotice(t('profiles.saved'));
      await hapticFeedback('confirm');
      backToList();
    } catch (caught) {
      setError(presentAuthError(caught));
      await hapticFeedback('error');
    } finally {
      setBusy(null);
    }
  }

  async function handleRename() {
    if (!editing || displayName.trim() === editing.displayName) return;
    setBusy('rename');
    setError(null);
    try {
      await renameConnectionProfile(editing.id, displayName);
      setNotice(t('profiles.renamed'));
      await hapticFeedback('confirm');
      backToList();
    } catch (caught) {
      setError(presentAuthError(caught));
      await hapticFeedback('error');
    } finally {
      setBusy(null);
    }
  }

  async function handleSwitch(profile: ConnectionProfile) {
    if (profile.id === activeProfile?.id) return;
    setBusy('switch');
    setError(null);
    try {
      await switchProfile(profile.id);
      await hapticFeedback('selection');
    } catch (caught) {
      setError(presentAuthError(caught));
      await hapticFeedback('error');
    } finally {
      setBusy(null);
    }
  }

  function confirmRemove(profile: ConnectionProfile) {
    const ownership = profileOwnership[profile.id];
    Alert.alert(
      t('profiles.removeTitle', { name: profile.displayName }),
      t('profiles.removeBody', {
        documents: formatNumber(ownership?.documents ?? 0),
        tasks: formatNumber(ownership?.tasks ?? 0),
        files: formatNumber(ownership?.offlineFiles ?? 0),
      }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('profiles.keepData'),
          onPress: () => void removeNow(profile.id, false),
        },
        {
          text: t('profiles.deleteData'),
          style: 'destructive',
          onPress: () => void removeNow(profile.id, true),
        },
      ],
    );
  }

  async function removeNow(profileId: string, deleteData: boolean) {
    setBusy('remove');
    setError(null);
    try {
      await removeProfile(profileId, deleteData);
      await hapticFeedback('warning');
      backToList();
    } catch (caught) {
      setError(presentAuthError(caught));
      await hapticFeedback('error');
    } finally {
      setBusy(null);
    }
  }

  function confirmRevoke(profile: ConnectionProfile) {
    Alert.alert(
      t('profiles.revokeTitle'),
      t('profiles.revokeBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('profiles.revokeAction'),
          style: 'destructive',
          onPress: () => void revokeNow(profile.id),
        },
      ],
    );
  }

  async function revokeNow(profileId: string) {
    setBusy('revoke');
    setError(null);
    try {
      await revokeProfileOidc(profileId);
      await hapticFeedback('warning');
      backToList();
    } catch (caught) {
      setError(presentAuthError(caught));
      await hapticFeedback('error');
    } finally {
      setBusy(null);
    }
  }

  function updateHeader(index: number, field: 'name' | 'value', value: string) {
    setHeaders((current) => current.map((header, currentIndex) =>
      currentIndex === index ? { ...header, [field]: value, retained: field === 'value' && value ? false : header.retained } : header));
    invalidateTest();
  }

  const isPlainHttp = /^http:\/\//i.test(serverUrl.trim());
  const isBusy = busy !== null;
  const displayedMtlsIdentity = testResult?.clientIdentity ?? (editing?.auth.kind === 'mutual-tls'
    ? editing.auth.identity
    : null);
  const title = screen === 'list'
    ? t('profiles.managerTitle')
    : editing
      ? t('profiles.editTitle', { name: editing.displayName })
      : t('profiles.addTitle');
  const subtitle = screen === 'list'
    ? t('profiles.managerSubtitle')
    : t('profiles.formSubtitle');

  return (
    <KeyboardSheet
      accessibilityLabel={t('profiles.managerLabel')}
      maxHeight="94%"
      onDismiss={() => {
        testController.current?.abort();
        if (testResult?.preparationId) {
          queueTestDiscard(testResult.preparationId);
        }
        setScreen('list');
        setEditing(null);
        setTestResult(null);
        setError(null);
        onDismiss();
      }}
      ref={sheetRef}
      subtitle={subtitle}
      title={title}
      visible={visible}>
      {screen === 'list' ? (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          {Platform.OS === 'web' && (
            <Callout icon={AlertTriangle} text={t('profiles.webLimit')} tone="warning" />
          )}
          {!!error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
          {!!notice && <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text>}
          {profiles.length === 0 && <Text style={styles.empty}>{t('profiles.empty')}</Text>}
          <View style={styles.profileList}>
            {profiles.map((profile) => {
              const active = profile.id === activeProfile?.id;
              const ownership = profileOwnership[profile.id];
              return (
                <View key={profile.id} style={[styles.profileRow, active && styles.profileRowActive]}>
                  <View style={styles.profileHeading}>
                    <View style={[styles.profileIcon, active && styles.profileIconActive]}>
                      <Server color={active ? palette.accentInk : palette.ink} size={19} />
                    </View>
                    <View style={styles.profileCopy}>
                      <View style={styles.nameRow}>
                        <Text numberOfLines={1} style={styles.profileName}>{profile.displayName}</Text>
                        {active && <Text style={styles.destinationBadge}>{t('profiles.activeDestination')}</Text>}
                      </View>
                      <Text numberOfLines={1} style={styles.profileUrl}>{profile.serverUrl}</Text>
                    </View>
                  </View>
                  <View style={styles.metaRow}>
                    <Text style={styles.metaText}>
                      {t(`profiles.auth.${profile.auth.kind}` as TranslationKey)}
                    </Text>
                    <Text style={styles.metaDot}>·</Text>
                    <Text style={styles.metaText}>
                      {t(`profiles.status.${profile.status.code}` as TranslationKey)}
                    </Text>
                  </View>
                  <Text style={styles.ownership}>
                    {t('profiles.ownership', {
                      documents: formatNumber(ownership?.documents ?? 0),
                      tasks: formatNumber(ownership?.tasks ?? 0),
                      files: formatNumber(ownership?.offlineFiles ?? 0),
                    })}
                  </Text>
                  {active && <Text style={styles.destinationHint}>{t('profiles.destinationHint')}</Text>}
                  <View style={styles.rowActions}>
                    {!active && (
                      <Pressable
                        disabled={isBusy}
                        onPress={() => handleSwitch(profile)}
                        style={styles.secondaryButton}>
                        {busy === 'switch' ? <ActivityIndicator color={palette.ink} size="small" /> : <Check color={palette.ink} size={16} />}
                        <Text style={styles.secondaryButtonText}>{t('profiles.switch')}</Text>
                      </Pressable>
                    )}
                    <Pressable disabled={isBusy} onPress={() => startEdit(profile)} style={styles.secondaryButton}>
                      <Text style={styles.secondaryButtonText}>{t('profiles.edit')}</Text>
                      <ChevronRight color={palette.ink} size={16} />
                    </Pressable>
                  </View>
                </View>
              );
            })}
          </View>
          <Pressable haptic="medium" onPress={startAdd} style={styles.primaryButton}>
            <Plus color={palette.accentInk} size={18} />
            <Text style={styles.primaryButtonText}>{t('profiles.add')}</Text>
          </Pressable>
        </ScrollView>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          <Field
            autoCapitalize="words"
            label={t('profiles.name')}
            onChangeText={(value) => setField(setDisplayName, value)}
            placeholder={t('profiles.namePlaceholder')}
            value={displayName}
          />
          <Field
            autoCapitalize="none"
            keyboardType="url"
            label={t('profiles.server')}
            onChangeText={(value) => setField(setServerUrl, value)}
            placeholder="https://paperless.example.com/subpath"
            value={serverUrl}
          />
          {isPlainHttp && <Callout icon={AlertTriangle} text={t('profiles.httpWarning')} tone="warning" />}

          <Text style={styles.fieldLabel}>{t('profiles.authMethod')}</Text>
          <View accessibilityRole="radiogroup" style={styles.authOptions}>
            {AUTH_OPTIONS.map(({ kind, icon: Icon }) => {
              const disabled = (Platform.OS === 'web' && kind !== 'token')
                || (kind === 'oidc' && !oidcVerifierAvailable);
              const selected = authKind === kind;
              return (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected, disabled }}
                  disabled={disabled || isBusy}
                  key={kind}
                  onPress={() => {
                    setAuthKind(kind);
                    invalidateTest();
                  }}
                  style={[styles.authOption, selected && styles.authOptionSelected, disabled && styles.disabled]}>
                  <Icon color={selected ? palette.paper : palette.ink} size={16} />
                  <Text style={[styles.authOptionText, selected && styles.authOptionTextSelected]}>
                    {t(`profiles.auth.${kind}` as TranslationKey)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {!oidcVerifierAvailable && Platform.OS !== 'web' && (
            <Callout icon={AlertTriangle} text={t('profiles.oidcVerifierUnavailable')} tone="warning" />
          )}

          {authKind === 'token' && (
            <>
              <Field
                autoCapitalize="none"
                label={t('settings.apiToken')}
                onChangeText={(value) => setField(setToken, value)}
                placeholder={editing ? '••••••••' : t('settings.apiTokenPlaceholder')}
                secureTextEntry
                value={token}
              />
              <Text style={styles.hint}>{t('profiles.tokenHint')}</Text>
            </>
          )}
          {authKind === 'paperless-credentials' && (
            <>
              <Field
                autoCapitalize="none"
                label={t('profiles.username')}
                onChangeText={(value) => setField(setUsername, value)}
                placeholder="paperless-user"
                value={username}
              />
              <Field
                autoCapitalize="none"
                label={t('profiles.password')}
                onChangeText={(value) => setField(setPassword, value)}
                placeholder={editing ? '••••••••' : ''}
                secureTextEntry
                value={password}
              />
              <Text style={styles.hint}>{t('profiles.passwordHint')}</Text>
              {otpRequired && (
                <>
                  <Field
                    keyboardType="number-pad"
                    label={t('profiles.otp')}
                    maxLength={10}
                    onChangeText={(value) => setField(setOtpCode, value)}
                    placeholder="123456"
                    secureTextEntry
                    value={otpCode}
                  />
                  <Text style={styles.hint}>{t('profiles.otpHint')}</Text>
                </>
              )}
            </>
          )}
          {authKind === 'oidc' && (
            <>
              <Field
                autoCapitalize="none"
                keyboardType="url"
                label={t('profiles.oidcIssuer')}
                onChangeText={(value) => setField(setOidcIssuer, value)}
                placeholder="https://identity.example.com"
                value={oidcIssuer}
              />
              <Field
                autoCapitalize="none"
                label={t('profiles.oidcClient')}
                onChangeText={(value) => setField(setOidcClientId, value)}
                placeholder="folio-mobile"
                value={oidcClientId}
              />
              <Field
                autoCapitalize="none"
                label={t('profiles.oidcScopes')}
                onChangeText={(value) => setField(setOidcScopes, value)}
                placeholder="openid profile email"
                value={oidcScopes}
              />
              <Text style={styles.hint}>{t('profiles.oidcHint')}</Text>
            </>
          )}
          {authKind === 'mutual-tls' && (
            <>
              {displayedMtlsIdentity && (
                <View style={styles.identityCard}>
                  <Text style={styles.identityLine}>{t('profiles.mtlsSubject', { subject: displayedMtlsIdentity.subject })}</Text>
                  <Text style={styles.identityLine}>{t('profiles.mtlsIssuer', { issuer: displayedMtlsIdentity.issuer })}</Text>
                  <Text style={styles.identityLine}>{t('profiles.mtlsExpires', { date: formatDate(displayedMtlsIdentity.expiresAt) })}</Text>
                </View>
              )}
              <Text style={styles.hint}>{t('profiles.mtlsHint')}</Text>
              <View style={styles.formActions}>
                <Pressable
                  disabled={isBusy}
                  onPress={() => void handleTest('select')}
                  style={[styles.testButton, isBusy && styles.disabled]}>
                  <Fingerprint color={palette.ink} size={17} />
                  <Text style={styles.testButtonText}>{t('profiles.mtlsSelectTest')}</Text>
                </Pressable>
                <Pressable
                  disabled={isBusy}
                  onPress={() => void handleTest('import')}
                  style={[styles.testButton, isBusy && styles.disabled]}>
                  <Plus color={palette.ink} size={17} />
                  <Text style={styles.testButtonText}>{t('profiles.mtlsImportTest')}</Text>
                </Pressable>
              </View>
            </>
          )}
          {authKind === 'custom-headers' && (
            <>
              {headers.map((header, index) => (
                <View key={`${index}-${header.retained}`} style={styles.headerFields}>
                  <Field
                    autoCapitalize="none"
                    label={t('profiles.headerName')}
                    onChangeText={(value) => updateHeader(index, 'name', value)}
                    placeholder="X-Api-Key"
                    value={header.name}
                  />
                  <Field
                    autoCapitalize="none"
                    label={t('profiles.headerValue')}
                    onChangeText={(value) => updateHeader(index, 'value', value)}
                    placeholder={header.retained ? '••••••••' : ''}
                    secureTextEntry
                    value={header.value}
                  />
                </View>
              ))}
              <Text style={styles.hint}>{t('profiles.headerHint')}</Text>
              {headers.some((header) => header.retained) && <Text style={styles.hint}>{t('profiles.headerRetained')}</Text>}
              {headers.some((header) => header.name.trim().toLocaleLowerCase() === 'authorization') && (
                <Callout icon={AlertTriangle} text={t('profiles.authorizationWarning')} tone="warning" />
              )}
            </>
          )}

          {!!error && <Text accessibilityLiveRegion="assertive" style={styles.error}>{error}</Text>}
          {testResult && (
            <View accessibilityLiveRegion="polite" style={styles.testResult}>
              <Check color={palette.ink} size={18} />
              <View style={styles.testResultCopy}>
                <Text style={styles.testResultTitle}>{t('profiles.tested')}</Text>
                <Text style={styles.testResultText}>
                  {t('profiles.testedSummary', {
                    server: testResult.serverVersion,
                    api: testResult.apiVersion,
                    user: testResult.username ?? t('profiles.unknownUser'),
                  })}
                </Text>
              </View>
            </View>
          )}
          <View style={styles.formActions}>
            <Pressable disabled={isBusy} onPress={backToList} style={styles.cancelButton}>
              <Text style={styles.cancelButtonText}>{t('common.cancel')}</Text>
            </Pressable>
            {authKind !== 'mutual-tls' && (
              <Pressable
                disabled={isBusy}
                onPress={() => void handleTest()}
                style={[styles.testButton, isBusy && styles.disabled]}>
                {busy === 'test' ? <ActivityIndicator color={palette.ink} size="small" /> : <Cloud color={palette.ink} size={17} />}
                <Text style={styles.testButtonText}>{busy === 'test' ? t('profiles.testing') : t('profiles.test')}</Text>
              </Pressable>
            )}
          </View>
          <Pressable
            disabled={!testResult || isBusy}
            onPress={handleSave}
            style={[styles.primaryButton, (!testResult || isBusy) && styles.disabled]}>
            {busy === 'save' ? <ActivityIndicator color={palette.accentInk} size="small" /> : <Check color={palette.accentInk} size={18} />}
            <Text style={styles.primaryButtonText}>{t('profiles.save')}</Text>
          </Pressable>
          {editing && displayName.trim() && displayName.trim() !== editing.displayName && (
            <Pressable disabled={isBusy} onPress={handleRename} style={styles.renameButton}>
              <Text style={styles.renameButtonText}>{t('profiles.renameOnly')}</Text>
            </Pressable>
          )}
          {editing?.auth.kind === 'oidc' && (
            <Pressable disabled={isBusy} onPress={() => confirmRevoke(editing)} style={styles.destructiveButton}>
              <LogOut color={palette.danger} size={17} />
              <Text style={styles.destructiveButtonText}>{t('profiles.revoke')}</Text>
            </Pressable>
          )}
          {editing && (
            <Pressable disabled={isBusy} onPress={() => confirmRemove(editing)} style={styles.destructiveButton}>
              {busy === 'remove' ? <ActivityIndicator color={palette.danger} size="small" /> : <Trash2 color={palette.danger} size={17} />}
              <Text style={styles.destructiveButtonText}>{t('common.remove')}</Text>
            </Pressable>
          )}
        </ScrollView>
      )}
    </KeyboardSheet>
  );
}

function Field({ label, ...props }: {
  label: string;
} & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        autoCorrect={false}
        placeholderTextColor={palette.faint}
        style={styles.input}
        {...props}
      />
    </View>
  );
}

function Callout({ icon: Icon, text, tone }: {
  icon: typeof AlertTriangle;
  text: string;
  tone: 'warning';
}) {
  return (
    <View style={[styles.callout, tone === 'warning' && styles.calloutWarning]}>
      <Icon color={palette.danger} size={17} />
      <Text style={styles.calloutText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scrollContent: { paddingTop: 14, paddingBottom: 30 },
  profileList: { gap: 10 },
  profileRow: {
    padding: 14,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.paper,
  },
  profileRowActive: { backgroundColor: palette.limeSurface, borderColor: palette.lineStrong },
  profileHeading: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  profileIcon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 14, backgroundColor: palette.canvas },
  profileIconActive: { backgroundColor: palette.lime },
  profileCopy: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  profileName: { flexShrink: 1, color: palette.ink, fontFamily: fonts.sans, fontSize: 14, fontWeight: '900' },
  destinationBadge: { color: palette.limeDark, fontFamily: fonts.sans, fontSize: 7, fontWeight: '900', letterSpacing: 0.5 },
  profileUrl: { color: palette.muted, fontFamily: fonts.sans, fontSize: 10, marginTop: 3 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 5, marginTop: 11 },
  metaText: { color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 10, fontWeight: '700' },
  metaDot: { color: palette.faint, fontSize: 10 },
  ownership: { color: palette.muted, fontFamily: fonts.sans, fontSize: 9, lineHeight: 14, marginTop: 5 },
  destinationHint: { color: palette.limeDark, fontFamily: fonts.sans, fontSize: 9, lineHeight: 14, marginTop: 6, fontWeight: '700' },
  rowActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, marginTop: 12 },
  secondaryButton: { minHeight: 42, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 13, borderRadius: radii.sm, backgroundColor: palette.canvas },
  secondaryButtonText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 10, fontWeight: '900' },
  primaryButton: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 12, paddingHorizontal: 18, borderRadius: radii.sm, backgroundColor: palette.lime },
  primaryButtonText: { color: palette.accentInk, fontFamily: fonts.sans, fontSize: 12, fontWeight: '900' },
  empty: { color: palette.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18, textAlign: 'center', paddingVertical: 28 },
  error: { color: palette.danger, fontFamily: fonts.sans, fontSize: 11, lineHeight: 17, marginBottom: 10 },
  notice: { color: palette.limeDark, fontFamily: fonts.sans, fontSize: 11, lineHeight: 17, marginBottom: 10, fontWeight: '700' },
  field: { marginTop: 12 },
  fieldLabel: { color: palette.muted, fontFamily: fonts.sans, fontSize: 9, fontWeight: '900', letterSpacing: 0.8, marginBottom: 6, marginTop: 12 },
  input: { minHeight: 50, color: palette.ink, fontFamily: fonts.sans, fontSize: 16, paddingHorizontal: 13, paddingVertical: 11, borderRadius: radii.sm, borderWidth: 1, borderColor: palette.line, backgroundColor: palette.paperStrong },
  hint: { color: palette.muted, fontFamily: fonts.sans, fontSize: 10, lineHeight: 15, marginTop: 6 },
  authOptions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  authOption: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, borderRadius: radii.sm, backgroundColor: palette.paper, borderWidth: 1, borderColor: palette.line },
  authOptionSelected: { backgroundColor: palette.ink, borderColor: palette.ink },
  authOptionText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 10, fontWeight: '800' },
  authOptionTextSelected: { color: palette.paper },
  disabled: { opacity: 0.42 },
  callout: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, padding: 12, borderRadius: radii.sm, marginBottom: 10 },
  calloutWarning: { backgroundColor: palette.dangerSurface },
  calloutText: { flex: 1, color: palette.danger, fontFamily: fonts.sans, fontSize: 10, lineHeight: 16, fontWeight: '700' },
  identityCard: { gap: 5, padding: 13, borderRadius: radii.sm, backgroundColor: palette.paper, marginTop: 12 },
  identityLine: { color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 10, lineHeight: 15 },
  headerFields: { marginTop: 4 },
  testResult: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 13, borderRadius: radii.sm, backgroundColor: palette.limeSurface, marginTop: 14 },
  testResultCopy: { flex: 1, minWidth: 0 },
  testResultTitle: { color: palette.ink, fontFamily: fonts.sans, fontSize: 11, fontWeight: '900' },
  testResultText: { color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 9, lineHeight: 14, marginTop: 2 },
  formActions: { flexDirection: 'row', gap: 8, marginTop: 16 },
  cancelButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, borderRadius: radii.sm, backgroundColor: palette.paper },
  cancelButtonText: { color: palette.muted, fontFamily: fonts.sans, fontSize: 11, fontWeight: '800' },
  testButton: { flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderRadius: radii.sm, backgroundColor: palette.mint },
  testButtonText: { color: palette.ink, fontFamily: fonts.sans, fontSize: 11, fontWeight: '900' },
  renameButton: { minHeight: 46, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  renameButtonText: { color: palette.inkSoft, fontFamily: fonts.sans, fontSize: 11, fontWeight: '800' },
  destructiveButton: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 7 },
  destructiveButtonText: { color: palette.danger, fontFamily: fonts.sans, fontSize: 11, fontWeight: '800' },
});
