import {
  Check,
  CircleAlert,
  Download,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  DimensionValue,
  Easing,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KeyboardSheet, KeyboardSheetHandle } from '@/components/keyboard-sheet';
import {
  MotionPressable as Pressable,
  hapticFeedback,
  useReducedMotion,
} from '@/components/motion';
import { bottomNavHeight, fonts, palette, radii, shadows } from '@/constants/theme';
import { UpdateStatus, useUpdates } from '@/context/update-context';
import { FOLIO_RELEASES_URL, formatUpdateSize } from '@/lib/app-updates';

type DismissAction = 'close' | 'remind';

function formatCheckedAt(timestamp: number | null) {
  if (!timestamp) return 'Not checked yet';
  return `Checked ${new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

function sheetCopy(
  status: UpdateStatus,
  version: string | null,
  support: ReturnType<typeof useUpdates>['support'],
) {
  if (support === 'development-build') {
    return {
      title: 'Updates for release builds',
      subtitle: 'Your development build and GitHub releases use different signing identities.',
    };
  }
  if (support === 'android-release-only') {
    return {
      title: 'Android releases only',
      subtitle: 'In-app GitHub updates are currently available for signed Android APKs.',
    };
  }
  if (support === 'module-unavailable') {
    return {
      title: 'One rebuild required',
      subtitle: 'This installed build predates Folio’s native update verifier.',
    };
  }

  switch (status) {
    case 'checking':
      return { title: 'Checking GitHub', subtitle: 'Looking for the latest signed Folio release.' };
    case 'up-to-date':
      return { title: 'Folio is up to date', subtitle: 'You already have the newest GitHub release.' };
    case 'available':
      return { title: `Folio ${version} is available`, subtitle: 'Download when you’re ready.' };
    case 'downloading':
      return { title: `Downloading Folio ${version}`, subtitle: 'You can cancel without affecting the app.' };
    case 'verifying':
      return { title: 'Verifying the update', subtitle: 'Checking its file hash, package, version, and signer.' };
    case 'ready':
    case 'permission':
      return { title: 'Ready to install', subtitle: `Folio ${version} passed every integrity check.` };
    case 'installing':
      return { title: 'Opening Android installer', subtitle: 'Android will ask you to confirm the update.' };
    case 'error':
      return { title: 'Update interrupted', subtitle: 'Your current Folio installation is unchanged.' };
    default:
      return { title: 'Software updates', subtitle: 'Stable Android releases come directly from GitHub.' };
  }
}

export function UpdateOverlay() {
  const updates = useUpdates();
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<KeyboardSheetHandle>(null);
  const dismissActionRef = useRef<DismissAction>('close');
  const [bannerEntrance] = useState(() => new Animated.Value(reducedMotion ? 1 : 0));
  const releaseVersion = updates.release?.version ?? null;
  const copy = sheetCopy(updates.status, releaseVersion, updates.support);
  const showProgress = updates.status === 'downloading' || updates.status === 'verifying';

  useEffect(() => {
    if (!updates.noticeVisible) return;
    bannerEntrance.stopAnimation();
    bannerEntrance.setValue(reducedMotion ? 1 : 0);
    if (reducedMotion) return;
    Animated.timing(bannerEntrance, {
      duration: 320,
      easing: Easing.bezier(0.16, 1, 0.3, 1),
      toValue: 1,
      useNativeDriver: true,
    }).start();
  }, [bannerEntrance, reducedMotion, updates.noticeVisible]);

  function closeSheet(action: DismissAction = 'close') {
    dismissActionRef.current = action;
    sheetRef.current?.close();
  }

  function handleSheetDismiss() {
    if (dismissActionRef.current === 'remind') void updates.remindLater();
    else updates.closeUpdateSheet();
    dismissActionRef.current = 'close';
  }

  function openReleasePage() {
    void hapticFeedback('light');
    void Linking.openURL(updates.release?.htmlUrl ?? FOLIO_RELEASES_URL);
  }

  return (
    <>
      {updates.noticeVisible && updates.release && (
        <Animated.View
          accessibilityLiveRegion="polite"
          style={[
            styles.banner,
            {
              bottom: Math.max(insets.bottom, 10) + bottomNavHeight,
              opacity: bannerEntrance,
              transform: [{
                translateY: bannerEntrance.interpolate({
                  inputRange: [0, 1],
                  outputRange: [18, 0],
                }),
              }],
            },
          ]}>
          <Pressable
            accessibilityHint="Opens release notes and download controls"
            accessibilityLabel={`Folio ${updates.release.version} update available`}
            haptic="medium"
            onPress={updates.openUpdateSheet}
            style={styles.bannerMain}>
            <View style={styles.bannerIcon}>
              <Download color={palette.ink} size={18} strokeWidth={2.5} />
            </View>
            <View style={styles.bannerCopy}>
              <Text numberOfLines={1} style={styles.bannerTitle}>
                Folio {updates.release.version} is ready
              </Text>
              <Text numberOfLines={1} style={styles.bannerSubtitle}>
                View what’s new · {formatUpdateSize(updates.release.apk?.size ?? 0)}
              </Text>
            </View>
            <Text style={styles.bannerAction}>View</Text>
          </Pressable>
          <Pressable
            accessibilityHint="Reminds you again tomorrow"
            accessibilityLabel="Remind me about this update later"
            haptic="light"
            onPress={updates.remindLater}
            style={styles.bannerClose}>
            <X color={palette.paper} size={18} />
          </Pressable>
        </Animated.View>
      )}

      {updates.sheetVisible && (
        <KeyboardSheet
          accessibilityLabel="Folio software update"
          maxHeight="88%"
          onDismiss={handleSheetDismiss}
          ref={sheetRef}
          subtitle={copy.subtitle}
          title={copy.title}
          visible>
          <ScrollView
            bounces={false}
            contentContainerStyle={styles.sheetContent}
            showsVerticalScrollIndicator={false}>
            {updates.support !== 'supported' ? (
              <UnsupportedContent support={updates.support} />
            ) : (
              <>
                <View style={styles.releaseOverview}>
                  <View style={[
                    styles.releaseMark,
                    updates.status === 'error' && styles.releaseMarkError,
                  ]}>
                    {updates.status === 'error' ? (
                      <CircleAlert color={palette.paper} size={25} />
                    ) : updates.status === 'up-to-date' ? (
                      <Check color={palette.ink} size={26} strokeWidth={2.6} />
                    ) : (
                      <Download color={palette.lime} size={24} strokeWidth={2.4} />
                    )}
                  </View>
                  <View style={styles.releaseCopy}>
                    <Text style={styles.releaseVersion}>
                      {updates.release ? `Version ${updates.release.version}` : `Version ${updates.currentVersion}`}
                    </Text>
                    <Text style={styles.releaseMeta}>
                      {updates.release && updates.status !== 'up-to-date'
                        ? `${formatUpdateSize(updates.release.apk?.size ?? 0)} · Universal Android APK`
                        : formatCheckedAt(updates.lastCheckedAt)}
                    </Text>
                  </View>
                </View>

                {showProgress && (
                  <View
                    accessibilityLabel="Update download progress"
                    accessibilityRole="progressbar"
                    accessibilityValue={{
                      min: 0,
                      max: 100,
                      now: Math.round(updates.progress * 100),
                      text:
                        updates.status === 'verifying'
                          ? 'Verifying download'
                          : `${Math.round(updates.progress * 100)} percent downloaded`,
                    }}
                    style={styles.progressBlock}>
                    <View style={styles.progressLabels}>
                      <Text style={styles.progressTitle}>
                        {updates.status === 'verifying' ? 'Integrity check' : 'Downloading from GitHub'}
                      </Text>
                      <Text style={styles.progressValue}>
                        {updates.status === 'verifying' ? 'VERIFYING' : `${Math.round(updates.progress * 100)}%`}
                      </Text>
                    </View>
                    <View style={styles.progressTrack}>
                      <View
                        style={[
                          styles.progressFill,
                          { width: `${Math.max(updates.progress * 100, updates.status === 'verifying' ? 100 : 2)}%` as DimensionValue },
                        ]}
                      />
                    </View>
                  </View>
                )}

                {!!updates.error && (
                  <View accessibilityLiveRegion="assertive" style={styles.errorBlock}>
                    <CircleAlert color={palette.danger} size={18} />
                    <Text style={styles.errorText}>{updates.error}</Text>
                  </View>
                )}

                {updates.status === 'permission' && (
                  <View style={styles.permissionBlock}>
                    <Text style={styles.permissionTitle}>Allow this source in Android</Text>
                    <Text style={styles.permissionText}>
                      Turn on “Allow from this source,” then return to Folio. This permission only lets
                      Folio hand a verified APK to Android’s installer; installation still needs your confirmation.
                    </Text>
                  </View>
                )}

                {updates.release && updates.status !== 'up-to-date' && (
                  <View style={styles.notesBlock}>
                    <View style={styles.notesHeader}>
                      <Text style={styles.notesTitle}>What’s new</Text>
                      <Pressable haptic="light" onPress={openReleasePage} style={styles.releaseLink}>
                        <Text style={styles.releaseLinkText}>GitHub</Text>
                        <ExternalLink color={palette.muted} size={13} />
                      </Pressable>
                    </View>
                    <Text selectable style={styles.notesText}>{updates.release.notes}</Text>
                  </View>
                )}

                {updates.status !== 'error' && updates.status !== 'up-to-date' && (
                  <View style={styles.trustRow}>
                    <ShieldCheck color={palette.limeDark} size={19} />
                    <Text style={styles.trustText}>
                      Folio verifies the SHA-256 digest, package ID, exact version, and official signing certificate before installation.
                    </Text>
                  </View>
                )}
              </>
            )}
          </ScrollView>

          <View style={styles.actions}>
            <SheetActions
              canRequestPackageInstalls={updates.canRequestPackageInstalls}
              onCancelDownload={updates.cancelDownload}
              onCheck={updates.checkForUpdates}
              onClose={() => closeSheet('close')}
              onDownload={updates.downloadUpdate}
              onInstall={updates.installUpdate}
              onOpenRelease={openReleasePage}
              onRemind={() => closeSheet('remind')}
              onRetry={updates.retry}
              status={updates.status}
              support={updates.support}
            />
          </View>
        </KeyboardSheet>
      )}
    </>
  );
}

function UnsupportedContent({ support }: { support: ReturnType<typeof useUpdates>['support'] }) {
  const message = support === 'development-build'
    ? 'Development builds are signed with a separate key. Folio keeps this updater disabled so installing a public release can’t strand your existing development data or credentials.'
    : support === 'module-unavailable'
      ? 'Install a freshly built development client once. The updater will then be available in future signed GitHub releases.'
      : 'GitHub currently publishes Folio as a signed Android APK. Other platforms keep their existing installation unchanged.';

  return (
    <View style={styles.unsupportedContent}>
      <View style={styles.unsupportedMark}>
        <ShieldCheck color={palette.lime} size={29} />
      </View>
      <Text style={styles.unsupportedTitle}>Your installation stays protected</Text>
      <Text style={styles.unsupportedText}>{message}</Text>
    </View>
  );
}

function SheetActions({
  canRequestPackageInstalls,
  onCancelDownload,
  onCheck,
  onClose,
  onDownload,
  onInstall,
  onOpenRelease,
  onRemind,
  onRetry,
  status,
  support,
}: {
  canRequestPackageInstalls: boolean;
  onCancelDownload: () => Promise<void>;
  onCheck: () => Promise<void>;
  onClose: () => void;
  onDownload: () => Promise<void>;
  onInstall: () => Promise<void>;
  onOpenRelease: () => void;
  onRemind: () => void;
  onRetry: () => Promise<void>;
  status: UpdateStatus;
  support: ReturnType<typeof useUpdates>['support'];
}) {
  if (support !== 'supported') {
    return (
      <>
        <SecondaryButton label="Close" onPress={onClose} />
        <PrimaryButton icon={<ExternalLink color={palette.ink} size={18} />} label="View GitHub releases" onPress={onOpenRelease} />
      </>
    );
  }
  if (status === 'checking') {
    return (
      <>
        <SecondaryButton label="Close" onPress={onClose} />
        <PrimaryButton loading label="Checking GitHub…" onPress={() => undefined} />
      </>
    );
  }
  if (status === 'up-to-date' || status === 'idle') {
    return (
      <>
        <SecondaryButton label="Done" onPress={onClose} />
        <PrimaryButton icon={<RefreshCw color={palette.ink} size={18} />} label="Check again" onPress={onCheck} />
      </>
    );
  }
  if (status === 'available') {
    return (
      <>
        <SecondaryButton label="Later" onPress={onRemind} />
        <PrimaryButton icon={<Download color={palette.ink} size={18} />} label="Download update" onPress={onDownload} />
      </>
    );
  }
  if (status === 'downloading') {
    return <SecondaryButton fullWidth label="Cancel download" onPress={onCancelDownload} />;
  }
  if (status === 'verifying') {
    return <PrimaryButton loading label="Verifying signature…" onPress={() => undefined} />;
  }
  if (status === 'ready' || status === 'permission') {
    return (
      <>
        <SecondaryButton label="Later" onPress={onRemind} />
        <PrimaryButton
          icon={<ShieldCheck color={palette.ink} size={19} />}
          label={status === 'permission'
            ? 'Check permission'
            : canRequestPackageInstalls
              ? 'Install update'
              : 'Allow installation'}
          onPress={onInstall}
        />
      </>
    );
  }
  if (status === 'installing') {
    return <PrimaryButton loading label="Opening Android…" onPress={() => undefined} />;
  }
  return (
    <>
      <SecondaryButton label="Later" onPress={onRemind} />
      <PrimaryButton icon={<RefreshCw color={palette.ink} size={18} />} label="Try again" onPress={onRetry} />
    </>
  );
}

function PrimaryButton({
  icon,
  label,
  loading = false,
  onPress,
}: {
  icon?: React.ReactNode;
  label: string;
  loading?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      disabled={loading}
      haptic={loading ? 'none' : 'medium'}
      onPress={onPress}
      style={[styles.primaryButton, loading && styles.buttonDisabled]}>
      {loading ? <ActivityIndicator color={palette.ink} size="small" /> : icon}
      <Text numberOfLines={1} style={styles.primaryButtonText}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({
  fullWidth = false,
  label,
  onPress,
}: {
  fullWidth?: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable haptic="light" onPress={onPress} style={[styles.secondaryButton, fullWidth && styles.fullWidth]}>
      <Text style={styles.secondaryButtonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 80,
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'stretch',
    alignSelf: 'center',
    maxWidth: 520,
    borderRadius: radii.md,
    backgroundColor: palette.ink,
    ...shadows.lift,
  },
  bannerMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingLeft: 12,
    paddingVertical: 10,
  },
  bannerIcon: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: palette.lime,
  },
  bannerCopy: { flex: 1, minWidth: 0 },
  bannerTitle: {
    color: palette.paper,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '900',
  },
  bannerSubtitle: {
    color: '#BCC5BD',
    fontFamily: fonts.sans,
    fontSize: 10,
    marginTop: 4,
  },
  bannerAction: {
    color: palette.lime,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '900',
  },
  bannerClose: {
    width: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopRightRadius: radii.md,
    borderBottomRightRadius: radii.md,
  },
  sheetContent: {
    paddingTop: 16,
    paddingBottom: 4,
  },
  releaseOverview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
  },
  releaseMark: {
    width: 54,
    height: 54,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    backgroundColor: palette.ink,
  },
  releaseMarkError: { backgroundColor: palette.danger },
  releaseCopy: { flex: 1, minWidth: 0 },
  releaseVersion: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 15,
    fontWeight: '900',
  },
  releaseMeta: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 3,
  },
  progressBlock: {
    padding: 14,
    borderRadius: radii.md,
    backgroundColor: palette.paper,
    marginTop: 16,
  },
  progressLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  progressTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '800',
  },
  progressValue: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  progressTrack: {
    height: 7,
    overflow: 'hidden',
    borderRadius: radii.pill,
    backgroundColor: palette.line,
    marginTop: 11,
  },
  progressFill: {
    height: '100%',
    borderRadius: radii.pill,
    backgroundColor: palette.limeDark,
  },
  errorBlock: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    padding: 13,
    borderRadius: radii.sm,
    backgroundColor: '#F3E3DF',
    marginTop: 16,
  },
  errorText: {
    flex: 1,
    color: palette.danger,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 17,
    fontWeight: '700',
  },
  permissionBlock: {
    padding: 15,
    borderRadius: radii.md,
    backgroundColor: palette.lavender,
    marginTop: 16,
  },
  permissionTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '900',
  },
  permissionText: {
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 17,
    marginTop: 5,
  },
  notesBlock: {
    paddingTop: 19,
  },
  notesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 9,
  },
  notesTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '900',
  },
  releaseLink: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    borderRadius: radii.pill,
    backgroundColor: palette.paper,
  },
  releaseLinkText: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '800',
  },
  notesText: {
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 18,
  },
  trustRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    paddingTop: 16,
    marginTop: 17,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.lineStrong,
  },
  trustText: {
    flex: 1,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    lineHeight: 16,
  },
  unsupportedContent: {
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 18,
  },
  unsupportedMark: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: palette.ink,
  },
  unsupportedTitle: {
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 23,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 16,
  },
  unsupportedText: {
    maxWidth: 380,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 7,
  },
  actions: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    paddingTop: 12,
    paddingBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.lineStrong,
  },
  primaryButton: {
    flex: 1,
    minWidth: 0,
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 13,
    borderRadius: radii.sm,
    backgroundColor: palette.lime,
  },
  primaryButtonText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '900',
  },
  secondaryButton: {
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
    borderRadius: radii.sm,
    backgroundColor: palette.paper,
  },
  secondaryButtonText: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '800',
  },
  fullWidth: { flex: 1 },
  buttonDisabled: { opacity: 0.72 },
});
