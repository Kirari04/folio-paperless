import { useIncomingShare } from 'expo-sharing';
import { Check, Server, Trash2, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { MotionPressable as Pressable, hapticFeedback } from '@/components/motion';
import {
  IntakeRejectionList,
  type IntakeRejectionListItem,
} from '@/components/intake-rejection-list';
import { fonts, palette, radii, shadows } from '@/constants/theme';
import { useApp } from '@/context/app-context';
import { useI18n } from '@/i18n';
import { presentRuntimeError } from '@/i18n/error-presentation';
import {
  incomingShareCandidates,
  incomingSharePayloadSignature,
  incomingShareSignature,
} from '@/lib/incoming-share';
import { sanitizeIntakeFilename } from '@/lib/intake';
import { useRouter } from '@/lib/router';

function NativeIncomingShareGateway() {
  const router = useRouter();
  const { t } = useI18n();
  const {
    activeProfile,
    connected,
    dismissIntakeRejectionBatch,
    importDocuments,
    prepareDocuments,
    profiles,
    switchProfile,
  } = useApp();
  const {
    resolvedSharedPayloads,
    clearSharedPayloads,
    error: resolveError,
    isResolving,
  } = useIncomingShare();
  const handling = useRef(false);
  const presentedSignature = useRef('');
  const [visible, setVisible] = useState(false);
  const [staging, setStaging] = useState(false);
  const [switchingProfileId, setSwitchingProfileId] = useState<string | null>(null);
  const [requestedProfileId, setRequestedProfileId] = useState<string | null>(null);
  const [completedSwitchId, setCompletedSwitchId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rejectedItems, setRejectedItems] = useState<IntakeRejectionListItem[]>([]);
  const [rejectionBatchId, setRejectionBatchId] = useState<string | null>(null);

  useEffect(() => {
    if (!resolvedSharedPayloads.length) {
      presentedSignature.current = '';
      return;
    }
    if (isResolving || handling.current) return;
    const candidates = incomingShareCandidates(resolvedSharedPayloads);
    const signature = candidates.length
      ? incomingShareSignature(candidates)
      : incomingSharePayloadSignature(resolvedSharedPayloads);
    if (signature === presentedSignature.current) return;
    presentedSignature.current = signature;
    const frame = requestAnimationFrame(() => {
      if (rejectionBatchId) dismissIntakeRejectionBatch(rejectionBatchId);
      setRejectionBatchId(null);
      setRejectedItems([]);
      setError(candidates.length
        ? null
        : t('share.unsupportedPayload'));
      setVisible(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [dismissIntakeRejectionBatch, isResolving, rejectionBatchId, resolvedSharedPayloads, t]);

  const stageForActiveProfile = useCallback(async (expectedProfileId?: string) => {
    if (handling.current || (expectedProfileId && activeProfile?.id !== expectedProfileId)) return;
    const candidates = incomingShareCandidates(resolvedSharedPayloads);
    if (!candidates.length) {
      setError(t('share.unsupportedPayload'));
      return;
    }
    handling.current = true;
    setStaging(true);
    setError(null);
    setRejectedItems([]);
    if (rejectionBatchId) {
      dismissIntakeRejectionBatch(rejectionBatchId);
      setRejectionBatchId(null);
    }
    try {
      // This component is mounted below the biometric gate. A profile switch
      // must finish and render as active before this closure may stage files.
      const result = connected
        ? await prepareDocuments(candidates, 'share')
        : await importDocuments(candidates, { source: 'share' });
      if (connected && !result.accepted.length) {
        setRejectedItems(result.rejected.map((item, index) => ({
          id: `${result.batchId ?? 'share'}-${index}`,
          name: sanitizeIntakeFilename(item.candidate.name),
          reason: item.error.message,
        })));
        setRejectionBatchId(result.batchId ?? null);
        if (!result.rejected.length) setError(t('share.noFilesStaged'));
        return;
      }
      clearSharedPayloads();
      setVisible(false);
      setRejectedItems([]);
      setRejectionBatchId(null);
      await hapticFeedback('confirm');
      if (connected && result.accepted[0]) {
        router.push({ pathname: '/intake', params: { batchId: result.accepted[0].batchId } });
      } else if (!connected) {
        router.push('/inbox');
      }
    } catch (nextError) {
      setError(presentRuntimeError(nextError, t('share.stagingError')));
      await hapticFeedback('error');
    } finally {
      handling.current = false;
      setStaging(false);
    }
  }, [activeProfile?.id, clearSharedPayloads, connected, dismissIntakeRejectionBatch, importDocuments, prepareDocuments, rejectionBatchId, resolvedSharedPayloads, router, t]);

  async function selectDestination(profileId: string) {
    if (staging || switchingProfileId) return;
    setError(null);
    if (profileId === activeProfile?.id) {
      await stageForActiveProfile(profileId);
      return;
    }
    setRequestedProfileId(profileId);
    setCompletedSwitchId(null);
    setSwitchingProfileId(profileId);
    try {
      await switchProfile(profileId);
      setCompletedSwitchId(profileId);
    } catch (nextError) {
      setRequestedProfileId(null);
      setError(presentRuntimeError(nextError, t('share.switchError')));
      await hapticFeedback('error');
    } finally {
      setSwitchingProfileId(null);
    }
  }

  useEffect(() => {
    if (
      !requestedProfileId
      || completedSwitchId !== requestedProfileId
      || activeProfile?.id !== requestedProfileId
    ) return;
    const profileId = requestedProfileId;
    const frame = requestAnimationFrame(() => {
      setRequestedProfileId(null);
      setCompletedSwitchId(null);
      void stageForActiveProfile(profileId);
    });
    return () => cancelAnimationFrame(frame);
  }, [activeProfile?.id, completedSwitchId, requestedProfileId, stageForActiveProfile]);

  function discardPayloads() {
    if (staging || switchingProfileId) return;
    clearSharedPayloads();
    setVisible(false);
    setError(null);
    setRejectedItems([]);
    if (rejectionBatchId) dismissIntakeRejectionBatch(rejectionBatchId);
    setRejectionBatchId(null);
    setRequestedProfileId(null);
    setCompletedSwitchId(null);
  }

  const message = error || resolveError?.message;
  return (
    <>
      <Modal
        animationType="fade"
        onRequestClose={() => undefined}
        statusBarTranslucent
        transparent
        visible={visible}>
        <View style={styles.backdrop}>
          <View accessibilityViewIsModal style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <View style={styles.sheetIcon}>
                <Server color={palette.accentInk} size={20} />
              </View>
              <View style={styles.sheetHeading}>
                <Text style={styles.sheetTitle}>{t('share.destinationTitle')}</Text>
                <Text style={styles.sheetCopy}>{t('share.destinationCopy')}</Text>
              </View>
              <Pressable
                accessibilityLabel={t('share.discardFiles')}
                disabled={staging || !!switchingProfileId}
                onPress={discardPayloads}
                style={styles.closeButton}>
                <X color={palette.ink} size={20} />
              </Pressable>
            </View>

            {!!message && (
              <Text accessibilityLiveRegion="assertive" style={styles.error}>{message}</Text>
            )}

            {!!rejectedItems.length && (
              <IntakeRejectionList
                acceptedCount={0}
                items={rejectedItems}
                onRetry={() => void stageForActiveProfile(activeProfile?.id)}
                scrollable
              />
            )}

            {!!incomingShareCandidates(resolvedSharedPayloads).length && !rejectedItems.length && (
              <ScrollView contentContainerStyle={styles.profileList} showsVerticalScrollIndicator={false}>
                {connected ? profiles.map((profile) => {
                  const active = profile.id === activeProfile?.id;
                  const busy = switchingProfileId === profile.id || (staging && active);
                  return (
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ disabled: staging || !!switchingProfileId, selected: active }}
                      disabled={staging || !!switchingProfileId}
                      key={profile.id}
                      onPress={() => void selectDestination(profile.id)}
                      style={[styles.profileRow, active && styles.profileRowActive]}>
                      <View style={[styles.profileIcon, active && styles.profileIconActive]}>
                        {busy
                          ? <ActivityIndicator color={active ? palette.accentInk : palette.ink} size="small" />
                          : active
                            ? <Check color={palette.accentInk} size={18} />
                            : <Server color={palette.ink} size={18} />}
                      </View>
                      <View style={styles.profileCopy}>
                        <Text numberOfLines={1} style={styles.profileName}>{profile.displayName}</Text>
                        <Text numberOfLines={1} style={styles.profileUrl}>{profile.serverUrl}</Text>
                      </View>
                      {active && <Text style={styles.activeLabel}>{t('profiles.activeDestination')}</Text>}
                    </Pressable>
                  );
                }) : (
                  <Pressable
                    disabled={staging}
                    onPress={() => void stageForActiveProfile()}
                    style={styles.profileRow}>
                    <View style={styles.profileIcon}>
                      {staging
                        ? <ActivityIndicator color={palette.ink} size="small" />
                        : <Check color={palette.ink} size={18} />}
                    </View>
                    <Text style={styles.profileName}>{t('tasks.localDemo')}</Text>
                  </Pressable>
                )}
              </ScrollView>
            )}

            <Pressable
              disabled={staging || !!switchingProfileId}
              onPress={discardPayloads}
              style={styles.discardButton}>
              <Trash2 color={palette.danger} size={17} />
              <Text style={styles.discardText}>{t('share.discardFiles')}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
      {!!message && !visible && (
        <View accessibilityLiveRegion="assertive" pointerEvents="none" style={styles.banner}>
          <Text style={styles.bannerText}>{message}</Text>
        </View>
      )}
    </>
  );
}

export function IncomingShareGateway() {
  if (Platform.OS === 'web') return null;
  return <NativeIncomingShareGateway />;
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    padding: 14,
    backgroundColor: palette.mediaScrim,
  },
  sheet: {
    width: '100%',
    maxWidth: 620,
    maxHeight: '82%',
    alignSelf: 'center',
    gap: 14,
    padding: 18,
    borderRadius: radii.lg,
    backgroundColor: palette.paper,
    ...shadows.lift,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 11 },
  sheetIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    backgroundColor: palette.lime,
  },
  sheetHeading: { flex: 1, minWidth: 0 },
  sheetTitle: { color: palette.ink, fontFamily: fonts.serif, fontSize: 22, fontWeight: '700' },
  sheetCopy: { marginTop: 4, color: palette.muted, fontFamily: fonts.sans, fontSize: 12, lineHeight: 18 },
  closeButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    backgroundColor: palette.paperStrong,
  },
  error: {
    padding: 12,
    color: palette.danger,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '800',
    lineHeight: 18,
    borderRadius: radii.sm,
    backgroundColor: palette.dangerSurface,
  },
  profileList: { gap: 8 },
  profileRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: radii.md,
    backgroundColor: palette.paperStrong,
  },
  profileRowActive: { borderColor: palette.limeDark, backgroundColor: palette.limeSurface },
  profileIcon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    backgroundColor: palette.paper,
  },
  profileIconActive: { backgroundColor: palette.lime },
  profileCopy: { flex: 1, minWidth: 0 },
  profileName: { color: palette.ink, fontFamily: fonts.sans, fontSize: 13, fontWeight: '900' },
  profileUrl: { marginTop: 2, color: palette.muted, fontFamily: fonts.sans, fontSize: 10 },
  activeLabel: { color: palette.limeDark, fontFamily: fonts.sans, fontSize: 9, fontWeight: '900' },
  discardButton: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderRadius: radii.md,
    backgroundColor: palette.dangerSurface,
  },
  discardText: { color: palette.danger, fontFamily: fonts.sans, fontSize: 12, fontWeight: '900' },
  banner: {
    position: 'absolute',
    right: 18,
    bottom: 104,
    left: 18,
    zIndex: 40,
    padding: 13,
    borderRadius: radii.md,
    backgroundColor: palette.dangerSurface,
    ...shadows.lift,
  },
  bannerText: {
    color: palette.danger,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '800',
    lineHeight: 18,
  },
});
