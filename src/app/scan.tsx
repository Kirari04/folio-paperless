import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { FlashList } from '@shopify/flash-list';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import { Image } from 'expo-image';
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronDown,
  CircleAlert,
  FileUp,
  Images,
  Layers3,
  RotateCcw,
  ScanLine,
  Server,
  Sparkles,
  WandSparkles,
  X,
  Zap,
  ZapOff,
} from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MotionPressable as Pressable, animateLayout, hapticFeedback } from '@/components/motion';
import { fonts, palette, radii, shadows } from '@/constants/theme';
import { useApp } from '@/context/app-context';
import { useI18n, type TranslationKey } from '@/i18n';
import { presentRuntimeError } from '@/i18n/error-presentation';
import {
  discardSmartScan,
  discardTemporaryFiles,
  launchSmartScanner,
  prepareSmartScan,
  SmartScannerUnavailableError,
  SmartScanSession,
} from '@/lib/document-scanner';
import { useRouter } from '@/lib/router';
import type { RootStackParamList } from '@/lib/router';
import type { ConnectionProfile } from '@/lib/auth/profile-store';

type CaptureKind = 'smart' | 'manual';

type Translator = (key: TranslationKey, values?: Record<string, string | number>) => string;

function pluralPages(count: number, t: Translator, formatNumber: (value: number) => string) {
  return count === 1 ? t('scan.pageOne') : t('scan.pageMany', { count: formatNumber(count) });
}

function smartScannerMessage(error: unknown, t: Translator) {
  if (error instanceof SmartScannerUnavailableError) {
    if (/hybrid object|nitro|native module/i.test(error.message)) {
      return t('scan.buildRequired');
    }
    return t('scan.unavailable');
  }
  return presentRuntimeError(error, t('scan.openError'));
}

function DestinationControl({
  disabled,
  profile,
  onPress,
  t,
}: {
  disabled?: boolean;
  profile: ConnectionProfile;
  onPress: () => void;
  t: Translator;
}) {
  return (
    <Pressable
      accessibilityHint={t('profiles.destinationHint')}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.destinationControl, disabled && styles.disabledButton]}>
      <View style={styles.destinationIcon}>
        <Server color={palette.accentInk} size={17} />
      </View>
      <View style={styles.destinationCopy}>
        <Text style={styles.destinationLabel}>{t('profiles.activeDestination')}</Text>
        <Text numberOfLines={1} style={styles.destinationName}>{profile.displayName}</Text>
      </View>
      <ChevronDown color={palette.muted} size={18} />
    </Pressable>
  );
}

function DestinationPicker({
  activeProfile,
  disabled = false,
  onDismiss,
  onSelect,
  profiles,
  switchingProfileId,
  t,
  visible,
}: {
  activeProfile: ConnectionProfile | null;
  disabled?: boolean;
  onDismiss: () => void;
  onSelect: (profileId: string) => void;
  profiles: ConnectionProfile[];
  switchingProfileId: string | null;
  t: Translator;
  visible: boolean;
}) {
  return (
    <Modal
      animationType="fade"
      onRequestClose={() => {
        if (!switchingProfileId && !disabled) onDismiss();
      }}
      statusBarTranslucent
      transparent
      visible={visible}>
      <View style={styles.destinationBackdrop}>
        <View accessibilityViewIsModal style={styles.destinationSheet}>
          <Text style={styles.destinationTitle}>{t('share.destinationTitle')}</Text>
          <Text style={styles.destinationDescription}>{t('profiles.destinationHint')}</Text>
          <ScrollView contentContainerStyle={styles.destinationList} showsVerticalScrollIndicator={false}>
            {profiles.map((profile) => {
              const active = activeProfile?.id === profile.id;
              const switching = switchingProfileId === profile.id;
              return (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ disabled: disabled || !!switchingProfileId, selected: active }}
                  disabled={disabled || !!switchingProfileId}
                  key={profile.id}
                  onPress={() => onSelect(profile.id)}
                  style={[styles.destinationRow, active && styles.destinationRowActive]}>
                  <View style={[styles.destinationRowIcon, active && styles.destinationRowIconActive]}>
                    {switching
                      ? <ActivityIndicator color={active ? palette.accentInk : palette.ink} size="small" />
                      : active
                        ? <Check color={palette.accentInk} size={17} />
                        : <Server color={palette.ink} size={17} />}
                  </View>
                  <View style={styles.destinationRowCopy}>
                    <Text numberOfLines={1} style={styles.destinationRowName}>{profile.displayName}</Text>
                    <Text numberOfLines={1} style={styles.destinationRowUrl}>{profile.serverUrl}</Text>
                  </View>
                  {active && <Text style={styles.destinationActive}>{t('profiles.activeDestination')}</Text>}
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable
            disabled={disabled || !!switchingProfileId}
            onPress={onDismiss}
            style={styles.destinationCancel}>
            <Text style={styles.destinationCancelText}>{t('common.cancel')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

export default function ScanScreen() {
  const router = useRouter();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList, 'Scan'>>();
  const { formatNumber, t } = useI18n();
  const cameraRef = useRef<CameraView>(null);
  const mountedRef = useRef(true);
  const scanSessionRef = useRef<SmartScanSession | null>(null);
  const autoLaunchRef = useRef(false);
  const smartLaunchRef = useRef(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [manualMode, setManualMode] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [torch, setTorch] = useState(false);
  const [captureKind, setCaptureKind] = useState<CaptureKind>('smart');
  const [scanSession, setScanSession] = useState<SmartScanSession | null>(null);
  const [selectedPage, setSelectedPage] = useState(0);
  const [isLaunchingSmart, setIsLaunchingSmart] = useState(false);
  const [isTakingPhoto, setIsTakingPhoto] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savingLabel, setSavingLabel] = useState(() => t('scan.uploading'));
  const [scanError, setScanError] = useState<string | null>(null);
  const [destinationVisible, setDestinationVisible] = useState(false);
  const [switchingProfileId, setSwitchingProfileId] = useState<string | null>(null);
  const [requestedProfileId, setRequestedProfileId] = useState<string | null>(null);
  const [completedSwitchId, setCompletedSwitchId] = useState<string | null>(null);
  const {
    activeProfile,
    connected,
    importDocument,
    isBootstrapping,
    prepareDocuments,
    profiles,
    switchProfile,
  } = useApp();

  const rememberScanSession = useCallback((session: SmartScanSession | null) => {
    scanSessionRef.current = session;
    setScanSession(session);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const abandonedSession = scanSessionRef.current;
      scanSessionRef.current = null;
      if (abandonedSession) void discardSmartScan(abandonedSession);
    };
  }, []);

  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !isSaving });
  }, [isSaving, navigation]);

  const startSmartScan = useCallback(async () => {
    if (smartLaunchRef.current) return;
    smartLaunchRef.current = true;
    setIsLaunchingSmart(true);
    setScanError(null);
    try {
      const result = await launchSmartScanner();
      if (!mountedRef.current) return;
      if (result) {
        animateLayout();
        setCaptureKind('smart');
        setSelectedPage(0);
        rememberScanSession(result);
        await hapticFeedback('confirm');
      }
    } catch (error) {
      if (!mountedRef.current) return;
      setScanError(smartScannerMessage(error, t));
      await hapticFeedback('error');
    } finally {
      smartLaunchRef.current = false;
      if (mountedRef.current) setIsLaunchingSmart(false);
    }
  }, [rememberScanSession, t]);

  useEffect(() => {
    if (
      Platform.OS === 'ios'
      || autoLaunchRef.current
      || isBootstrapping
      || profiles.length > 1
    ) return;
    autoLaunchRef.current = true;
    const timer = setTimeout(() => void startSmartScan(), 220);
    return () => clearTimeout(timer);
  }, [isBootstrapping, profiles.length, startSmartScan]);

  async function selectDestination(profileId: string) {
    if (isSaving || switchingProfileId) return;
    setScanError(null);
    if (activeProfile?.id === profileId) {
      setDestinationVisible(false);
      return;
    }
    setRequestedProfileId(profileId);
    setCompletedSwitchId(null);
    setSwitchingProfileId(profileId);
    try {
      await switchProfile(profileId);
      setCompletedSwitchId(profileId);
      await hapticFeedback('selection');
    } catch (error) {
      setRequestedProfileId(null);
      setScanError(presentRuntimeError(error, t('profiles.error')));
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
    const frame = requestAnimationFrame(() => {
      setRequestedProfileId(null);
      setCompletedSwitchId(null);
      setDestinationVisible(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [activeProfile?.id, completedSwitchId, requestedProfileId]);

  function openManualCamera() {
    animateLayout();
    setScanError(null);
    setCameraReady(false);
    setManualMode(true);
  }

  function closeManualCamera() {
    animateLayout();
    setTorch(false);
    setCameraReady(false);
    setManualMode(false);
    setScanError(null);
  }

  async function takePhoto() {
    if (!cameraRef.current || !cameraReady || isTakingPhoto) return;
    setIsTakingPhoto(true);
    setScanError(null);
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.92,
        skipProcessing: false,
      });
      animateLayout();
      setCaptureKind('manual');
      setSelectedPage(0);
      rememberScanSession({ pages: [{ uri: photo.uri }] });
      await hapticFeedback('medium');
    } catch (error) {
      setScanError(presentRuntimeError(error, t('scan.cameraError')));
      await hapticFeedback('error');
    } finally {
      setIsTakingPhoto(false);
    }
  }

  async function uploadScan() {
    if (!scanSession || isSaving) return;
    setDestinationVisible(false);
    setIsSaving(true);
    setScanError(null);
    setSavingLabel(scanSession.pages.length > 1 && !scanSession.pdfUri
      ? t('scan.preparingPdf')
      : t('scan.uploading'));
    try {
      const file = await prepareSmartScan(scanSession);
      const preparedSession = !scanSession.pdfUri && file.mimeType === 'application/pdf'
        ? { ...scanSession, pdfUri: file.uri }
        : scanSession;
      if (preparedSession !== scanSession) rememberScanSession(preparedSession);
      setSavingLabel(connected ? t('scan.securingCopy') : t('scan.adding'));
      const intake = connected ? await prepareDocuments([file], 'camera') : null;
      if (!connected) await importDocument(file);
      await hapticFeedback('confirm');
      scanSessionRef.current = null;
      await discardSmartScan(preparedSession);
      if (intake?.batchId) {
        router.replace({ pathname: '/intake', params: { batchId: intake.batchId } });
      } else {
        router.replace('/inbox');
      }
    } catch (error) {
      setScanError(presentRuntimeError(error, t('scan.saveError')));
      await hapticFeedback('error');
    } finally {
      setIsSaving(false);
    }
  }

  function rescan() {
    if (isSaving) return;
    const discardedSession = scanSessionRef.current;
    scanSessionRef.current = null;
    animateLayout();
    setScanSession(null);
    if (discardedSession) void discardSmartScan(discardedSession);
    setSelectedPage(0);
    setScanError(null);
    if (captureKind === 'manual') {
      setManualMode(true);
      setCameraReady(false);
      return;
    }
    void startSmartScan();
  }

  async function pickFile() {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: true,
      type: ['application/pdf', 'image/*'],
    });
    if (result.canceled) return;
    setDestinationVisible(false);
    setIsSaving(true);
    setSavingLabel(connected ? t('scan.securingCopies') : t('scan.adding'));
    setScanError(null);
    try {
      const files = result.assets.map((file) => ({
        uri: file.uri,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
      }));
      const intake = connected ? await prepareDocuments(files, 'picker') : null;
      if (!connected) await Promise.all(files.map((file) => importDocument(file)));
      await hapticFeedback('confirm');
      if (intake?.batchId) {
        router.replace({ pathname: '/intake', params: { batchId: intake.batchId } });
      } else {
        router.replace('/inbox');
      }
    } catch (error) {
      setScanError(presentRuntimeError(error, t('scan.importError')));
      await hapticFeedback('error');
    } finally {
      await discardTemporaryFiles(result.assets.map((file) => file.uri));
      setIsSaving(false);
    }
  }

  if (scanSession) {
    const pageCount = scanSession.pages.length;
    const currentPage = scanSession.pages[Math.min(selectedPage, pageCount - 1)];
    const smart = captureKind === 'smart';

    return (
      <View style={styles.reviewRoot}>
        <SafeAreaView edges={['top']} style={styles.reviewHeaderSafe}>
          <View style={styles.reviewHeader}>
            <Pressable
              accessibilityLabel={t('scan.closeReview')}
              disabled={isSaving}
              onPress={() => router.back()}
              style={styles.lightIconButton}>
              <X color={palette.ink} size={21} />
            </Pressable>
            <View style={styles.reviewHeading}>
              <Text style={styles.reviewTitle}>{t('scan.review')}</Text>
              <Text style={styles.reviewSubtitle}>
                {smart
                  ? t('scan.enhancedPages', { pages: pluralPages(pageCount, t, formatNumber) })
                  : t('scan.manualCapture')}
              </Text>
            </View>
            <View style={styles.headerBalance} />
          </View>
        </SafeAreaView>

        {!!activeProfile && (
          <DestinationControl
            disabled={isSaving || !!switchingProfileId}
            onPress={() => setDestinationVisible(true)}
            profile={activeProfile}
            t={t}
          />
        )}

        <View style={styles.previewStage}>
          <Image
            accessibilityLabel={t('scan.previewPage', { page: formatNumber(selectedPage + 1) })}
            contentFit="contain"
            recyclingKey={currentPage.uri}
            source={{ uri: currentPage.uri }}
            style={styles.previewImage}
            transition={140}
          />
          <View style={styles.pageBadge}>
            <Text style={styles.pageBadgeText}>
              {formatNumber(selectedPage + 1)} / {formatNumber(pageCount)}
            </Text>
          </View>
        </View>

        <View style={styles.reviewMeta}>
          <View style={styles.reviewMetaIcon}>
            {smart ? (
              <WandSparkles color={palette.accentInk} size={17} />
            ) : (
              <Camera color={palette.accentInk} size={17} />
            )}
          </View>
          <View style={styles.reviewMetaCopy}>
            <Text style={styles.reviewMetaTitle}>
              {smart ? t('scan.readyPaperless') : t('scan.readyUpload')}
            </Text>
            <Text style={styles.reviewMetaText}>
              {smart
                ? t('scan.smartHandled')
                : t('scan.manualHint')}
            </Text>
          </View>
        </View>

        {pageCount > 1 && (
          <FlashList
            contentContainerStyle={styles.thumbnailContent}
            data={scanSession.pages}
            drawDistance={180}
            extraData={selectedPage}
            horizontal
            ItemSeparatorComponent={() => <View style={styles.thumbnailSeparator} />}
            keyExtractor={(page, index) => `${page.uri}-${index}`}
            renderItem={({ item: page, index }) => {
              const selected = index === selectedPage;
              return (
                <Pressable
                  accessibilityLabel={t('scan.showPage', { page: formatNumber(index + 1) })}
                  accessibilityState={{ selected }}
                  haptic="selection"
                  onPress={() => setSelectedPage(index)}
                  style={[styles.thumbnailButton, selected && styles.thumbnailButtonSelected]}>
                  <Image
                    contentFit="cover"
                    recyclingKey={page.uri}
                    source={{ uri: page.uri }}
                    style={styles.thumbnailImage}
                  />
                  <View style={[styles.thumbnailNumber, selected && styles.thumbnailNumberSelected]}>
                    <Text style={[styles.thumbnailNumberText, selected && styles.thumbnailNumberTextSelected]}>
                      {formatNumber(index + 1)}
                    </Text>
                  </View>
                </Pressable>
              );
            }}
            showsHorizontalScrollIndicator={false}
            style={styles.thumbnailRail}
          />
        )}

        <SafeAreaView edges={['bottom']} style={styles.reviewActionsSafe}>
          {!!scanError && (
            <View
              accessibilityLiveRegion="assertive"
              accessibilityRole="alert"
              style={styles.inlineError}>
              <View style={styles.inlineErrorIcon}>
                <CircleAlert color={palette.danger} size={18} />
              </View>
              <View style={styles.inlineErrorCopy}>
                <Text style={styles.inlineErrorTitle}>{t('scan.uploadFailed')}</Text>
                <Text style={styles.inlineErrorText}>{scanError}</Text>
              </View>
            </View>
          )}
          <View style={styles.reviewActions}>
            <Pressable
              disabled={isSaving || !!switchingProfileId}
              haptic="light"
              onPress={rescan}
              style={[styles.rescanButton, isSaving && styles.disabledButton]}>
              <RotateCcw color={palette.ink} size={19} />
              <Text style={styles.rescanText}>{t('scan.rescan')}</Text>
            </Pressable>
            <Pressable
              disabled={isSaving || !!switchingProfileId}
              haptic="none"
              onPress={uploadScan}
              style={[
                styles.uploadButton,
                (isSaving || !!switchingProfileId) && styles.disabledButton,
              ]}>
              {isSaving ? (
                <ActivityIndicator color={palette.accentInk} size="small" />
              ) : (
                <Check color={palette.accentInk} size={20} strokeWidth={2.7} />
              )}
              <Text style={styles.uploadButtonText}>
                {isSaving
                  ? savingLabel
                  : scanError
                    ? connected
                      ? t('scan.retryUpload')
                      : t('scan.retryAdding')
                    : connected
                    ? pageCount === 1
                      ? t('scan.uploadOne')
                      : t('scan.uploadMany', { pages: pluralPages(pageCount, t, formatNumber) })
                    : pageCount === 1
                      ? t('scan.addOne')
                      : t('scan.addMany', { pages: pluralPages(pageCount, t, formatNumber) })}
              </Text>
            </Pressable>
          </View>
        </SafeAreaView>
        <DestinationPicker
          activeProfile={activeProfile}
          disabled={isSaving}
          onDismiss={() => setDestinationVisible(false)}
          onSelect={(profileId) => void selectDestination(profileId)}
          profiles={profiles}
          switchingProfileId={switchingProfileId}
          t={t}
          visible={destinationVisible}
        />
      </View>
    );
  }

  if (manualMode) {
    if (!permission) {
      return (
        <View style={styles.loading}>
          <ActivityIndicator color={palette.lime} />
        </View>
      );
    }

    if (!permission.granted) {
      return (
        <SafeAreaView style={styles.permission}>
          <Pressable
            accessibilityLabel={t('scan.backOptions')}
            onPress={closeManualCamera}
            style={styles.permissionBack}>
            <ChevronLeft color={palette.ink} size={23} />
          </Pressable>
          <View style={styles.permissionMark}>
            <Camera color={palette.accentInk} size={34} />
          </View>
          <Text style={styles.permissionTitle}>{t('scan.allowManual')}</Text>
          <Text style={styles.permissionCopy}>{t('scan.permissionCopy')}</Text>
          {!!scanError && <Text style={styles.permissionError}>{scanError}</Text>}
          <Pressable
            onPress={() => {
              if (permission.canAskAgain) void requestPermission();
              else void Linking.openSettings();
            }}
            style={styles.permissionButton}>
            <Text style={styles.permissionButtonText}>
              {permission.canAskAgain ? t('scan.allowCamera') : t('scan.openSettings')}
            </Text>
          </Pressable>
          <Pressable onPress={pickFile} style={styles.importInstead}>
            <FileUp color={palette.ink} size={17} />
            <Text style={styles.importInsteadText}>{t('scan.importInstead')}</Text>
          </Pressable>
        </SafeAreaView>
      );
    }

    return (
      <View style={styles.cameraRoot}>
        <CameraView
          animateShutter
          enableTorch={torch}
          facing="back"
          flash={torch ? 'off' : 'auto'}
          mode="picture"
          onCameraReady={() => setCameraReady(true)}
          onMountError={({ message }) => {
            setCameraReady(false);
            setScanError(message || t('scan.previewError'));
          }}
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.scrimTop} />
        <View style={styles.scrimBottom} />

        <SafeAreaView style={styles.cameraOverlay}>
          <View style={styles.cameraTopbar}>
            <Pressable
              accessibilityLabel={t('scan.backOptions')}
              onPress={closeManualCamera}
              style={styles.darkIconButton}>
              <ChevronLeft color={palette.onDark} size={23} />
            </Pressable>
            <View style={styles.cameraTitleWrap}>
              <Text style={styles.cameraTitle}>{t('scan.manualCapture')}</Text>
              <Text style={styles.cameraSubtitle}>{t('scan.singlePageFallback')}</Text>
            </View>
            <Pressable
              accessibilityLabel={torch ? t('scan.torchOff') : t('scan.torchOn')}
              onPress={() => setTorch((value) => !value)}
              style={[styles.darkIconButton, torch && styles.torchActive]}>
              {torch ? (
                <Zap color={palette.accentInk} fill={palette.accentInk} size={19} />
              ) : (
                <ZapOff color={palette.onDark} size={19} />
              )}
            </Pressable>
          </View>

          <View style={styles.frameWrap}>
            <View style={styles.guide}>
              <View style={[styles.corner, styles.cornerTL]} />
              <View style={[styles.corner, styles.cornerTR]} />
              <View style={[styles.corner, styles.cornerBL]} />
              <View style={[styles.corner, styles.cornerBR]} />
            </View>
            <View style={styles.cameraHint}>
              <ScanLine color={palette.accentInk} size={14} />
              <Text style={styles.cameraHintText}>
                {cameraReady ? t('scan.cornersVisible') : t('scan.startingCamera')}
              </Text>
            </View>
          </View>

          <View style={styles.cameraControls}>
            {!!scanError && (
              <View accessibilityLiveRegion="polite" style={styles.cameraError}>
                <Text style={styles.cameraErrorText}>{scanError}</Text>
              </View>
            )}
            <Pressable
              accessibilityLabel={t('scan.importDocument')}
              onPress={pickFile}
              style={styles.cameraControlButton}>
              <FileUp color={palette.onDark} size={21} />
            </Pressable>
            <Pressable
              accessibilityLabel={t('scan.takePicture')}
              disabled={!cameraReady || isTakingPhoto}
              haptic="medium"
              onPress={takePhoto}
              pressedScale={0.94}
              style={[
                styles.shutterOuter,
                (!cameraReady || isTakingPhoto) && styles.shutterDisabled,
              ]}>
              <View style={styles.shutterInner}>
                {(!cameraReady || isTakingPhoto) && (
                  <ActivityIndicator color={palette.accentInk} size="small" />
                )}
              </View>
            </Pressable>
            <View style={styles.cameraControlSpacer} />
          </View>
        </SafeAreaView>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.launcher}>
      <View style={styles.launcherHeader}>
        <Pressable
          accessibilityLabel={t('scan.close')}
          onPress={() => router.back()}
          style={styles.lightIconButton}>
          <X color={palette.ink} size={21} />
        </Pressable>
        <Text style={styles.launcherHeaderTitle}>{t('scan.title')}</Text>
        <View style={styles.headerBalance} />
      </View>

      {!!activeProfile && (
        <DestinationControl
          disabled={isSaving || !!switchingProfileId}
          onPress={() => setDestinationVisible(true)}
          profile={activeProfile}
          t={t}
        />
      )}

      <View style={styles.launcherBody}>
        <View style={styles.smartMark}>
          <View style={styles.smartMarkBack} />
          <ScanLine color={palette.lime} size={48} strokeWidth={1.8} />
          {isLaunchingSmart && <ActivityIndicator color={palette.onDark} style={styles.smartSpinner} />}
        </View>
        <Text style={styles.launcherTitle}>
          {isLaunchingSmart ? t('scan.preparing') : t('scan.hero')}
        </Text>
        <Text style={styles.launcherCopy}>
          {isLaunchingSmart
            ? t('scan.firstRunCopy')
            : t('scan.heroCopy')}
        </Text>

        <View style={styles.capabilityList}>
          <View style={styles.capabilityRow}>
            <ScanLine color={palette.limeDark} size={18} />
            <Text style={styles.capabilityText}>{t('scan.detect')}</Text>
          </View>
          <View style={styles.capabilityRow}>
            <Layers3 color={palette.limeDark} size={18} />
            <Text style={styles.capabilityText}>{t('scan.combine')}</Text>
          </View>
          <View style={styles.capabilityRow}>
            <Sparkles color={palette.limeDark} size={18} />
            <Text style={styles.capabilityText}>{t('scan.enhance')}</Text>
          </View>
        </View>

        {!!scanError && (
          <View accessibilityLiveRegion="polite" style={styles.launcherError}>
            <Text style={styles.launcherErrorText}>{scanError}</Text>
          </View>
        )}
      </View>

      <View style={styles.launcherActions}>
        <Pressable
          disabled={isLaunchingSmart || isSaving || !!switchingProfileId}
          haptic="light"
          onPress={startSmartScan}
          style={[
            styles.smartScanButton,
            (isLaunchingSmart || isSaving || !!switchingProfileId) && styles.disabledButton,
          ]}>
          {isLaunchingSmart ? (
            <ActivityIndicator color={palette.accentInk} size="small" />
          ) : (
            <ScanLine color={palette.accentInk} size={21} />
          )}
          <Text style={styles.smartScanButtonText}>
            {isLaunchingSmart ? t('scan.opening') : t('scan.startSmart')}
          </Text>
        </Pressable>
        <View style={styles.secondaryActions}>
          <Pressable
            disabled={isLaunchingSmart || isSaving || !!switchingProfileId}
            onPress={openManualCamera}
            style={styles.secondaryAction}>
            <Camera color={palette.ink} size={19} />
            <Text style={styles.secondaryActionText}>{t('scan.manualCamera')}</Text>
          </Pressable>
          <Pressable
            disabled={isLaunchingSmart || isSaving || !!switchingProfileId}
            onPress={pickFile}
            style={styles.secondaryAction}>
            {isSaving ? (
                  <ActivityIndicator color={palette.accentInk} size="small" />
            ) : (
              <Images color={palette.ink} size={19} />
            )}
            <Text numberOfLines={1} style={styles.secondaryActionText}>
              {isSaving ? savingLabel : t('scan.importFile')}
            </Text>
          </Pressable>
        </View>
      </View>
      <DestinationPicker
        activeProfile={activeProfile}
        disabled={isSaving}
        onDismiss={() => setDestinationVisible(false)}
        onSelect={(profileId) => void selectDestination(profileId)}
        profiles={profiles}
        switchingProfileId={switchingProfileId}
        t={t}
        visible={destinationVisible}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  launcher: {
    flex: 1,
    backgroundColor: palette.canvas,
  },
  launcherHeader: {
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
  },
  launcherHeaderTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 15,
    fontWeight: '900',
  },
  destinationControl: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 18,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: radii.md,
    backgroundColor: palette.paper,
  },
  destinationIcon: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: palette.lime,
  },
  destinationCopy: { flex: 1, minWidth: 0 },
  destinationLabel: {
    color: palette.limeDark,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '900',
  },
  destinationName: {
    marginTop: 2,
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '900',
  },
  destinationBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    padding: 14,
    backgroundColor: palette.mediaScrim,
  },
  destinationSheet: {
    width: '100%',
    maxWidth: 620,
    maxHeight: '82%',
    alignSelf: 'center',
    gap: 12,
    padding: 18,
    borderRadius: radii.lg,
    backgroundColor: palette.paper,
    ...shadows.lift,
  },
  destinationTitle: {
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 22,
    fontWeight: '700',
  },
  destinationDescription: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
  },
  destinationList: { gap: 8 },
  destinationRow: {
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
  destinationRowActive: { borderColor: palette.limeDark, backgroundColor: palette.limeSurface },
  destinationRowIcon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 13,
    backgroundColor: palette.paper,
  },
  destinationRowIconActive: { backgroundColor: palette.lime },
  destinationRowCopy: { flex: 1, minWidth: 0 },
  destinationRowName: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '900',
  },
  destinationRowUrl: {
    marginTop: 2,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
  },
  destinationActive: {
    color: palette.limeDark,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '900',
  },
  destinationCancel: {
    minHeight: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: palette.paperStrong,
  },
  destinationCancelText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '900',
  },
  headerBalance: {
    width: 48,
    height: 48,
  },
  lightIconButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.paper,
  },
  launcherBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  smartMark: {
    width: 126,
    height: 126,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 40,
    backgroundColor: palette.inverseSurface,
    transform: [{ rotate: '-3deg' }],
    ...shadows.lift,
  },
  smartMarkBack: {
    position: 'absolute',
    width: 92,
    height: 106,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: palette.accentBorder,
  },
  smartSpinner: {
    position: 'absolute',
    right: 12,
    top: 12,
  },
  launcherTitle: {
    maxWidth: 360,
    marginTop: 28,
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 34,
    lineHeight: 39,
    fontWeight: '600',
    textAlign: 'center',
    letterSpacing: -0.7,
  },
  launcherCopy: {
    maxWidth: 380,
    marginTop: 11,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  capabilityList: {
    width: '100%',
    maxWidth: 370,
    gap: 13,
    marginTop: 27,
  },
  capabilityRow: {
    minHeight: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
  },
  capabilityText: {
    flex: 1,
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700',
  },
  launcherError: {
    width: '100%',
    maxWidth: 390,
    marginTop: 22,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: radii.sm,
    backgroundColor: palette.dangerSurface,
  },
  launcherErrorText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  launcherActions: {
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 12,
  },
  smartScanButton: {
    height: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    borderRadius: radii.md,
    backgroundColor: palette.lime,
    ...shadows.card,
  },
  smartScanButtonText: {
    color: palette.accentInk,
    fontFamily: fonts.sans,
    fontSize: 14,
    fontWeight: '900',
  },
  secondaryActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 10,
  },
  secondaryAction: {
    flex: 1,
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radii.md,
    backgroundColor: palette.paper,
  },
  secondaryActionText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '800',
  },
  disabledButton: {
    opacity: 0.55,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.accentInk,
  },
  permission: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 30,
    backgroundColor: palette.canvas,
  },
  permissionBack: {
    position: 'absolute',
    top: 16,
    left: 18,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.paper,
  },
  permissionMark: {
    width: 86,
    height: 86,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.lime,
    transform: [{ rotate: '-4deg' }],
  },
  permissionTitle: {
    marginTop: 22,
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 32,
    lineHeight: 37,
    fontWeight: '600',
    textAlign: 'center',
  },
  permissionCopy: {
    maxWidth: 360,
    marginTop: 10,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
  },
  permissionError: {
    maxWidth: 360,
    marginTop: 10,
    color: palette.danger,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
  permissionButton: {
    width: '100%',
    maxWidth: 350,
    height: 54,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    backgroundColor: palette.ink,
    marginTop: 23,
  },
  permissionButtonText: {
    color: palette.paper,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '900',
  },
  importInstead: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 10,
  },
  importInsteadText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '700',
  },
  cameraRoot: {
    flex: 1,
    backgroundColor: palette.accentInk,
  },
  scrimTop: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 150,
    backgroundColor: palette.cameraScrimTop,
  },
  scrimBottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 200,
    backgroundColor: palette.cameraScrimBottom,
  },
  cameraOverlay: {
    flex: 1,
  },
  cameraTopbar: {
    height: 66,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
  },
  darkIconButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.cameraChrome,
  },
  torchActive: {
    backgroundColor: palette.lime,
  },
  cameraTitleWrap: {
    alignItems: 'center',
  },
  cameraTitle: {
    color: palette.onDark,
    fontFamily: fonts.sans,
    fontSize: 14,
    fontWeight: '900',
  },
  cameraSubtitle: {
    color: palette.cameraTextMuted,
    fontFamily: fonts.sans,
    fontSize: 10,
    marginTop: 2,
  },
  frameWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 25,
  },
  guide: {
    width: '100%',
    maxWidth: 440,
    aspectRatio: 0.72,
  },
  corner: {
    position: 'absolute',
    width: 38,
    height: 38,
    borderColor: palette.lime,
  },
  cornerTL: {
    left: 0,
    top: 0,
    borderLeftWidth: 3,
    borderTopWidth: 3,
    borderTopLeftRadius: 13,
  },
  cornerTR: {
    right: 0,
    top: 0,
    borderRightWidth: 3,
    borderTopWidth: 3,
    borderTopRightRadius: 13,
  },
  cornerBL: {
    left: 0,
    bottom: 0,
    borderLeftWidth: 3,
    borderBottomWidth: 3,
    borderBottomLeftRadius: 13,
  },
  cornerBR: {
    right: 0,
    bottom: 0,
    borderRightWidth: 3,
    borderBottomWidth: 3,
    borderBottomRightRadius: 13,
  },
  cameraHint: {
    position: 'absolute',
    bottom: 8,
    minHeight: 34,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
    backgroundColor: palette.lime,
  },
  cameraHintText: {
    color: palette.accentInk,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '800',
  },
  cameraControls: {
    height: 135,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 36,
  },
  cameraError: {
    position: 'absolute',
    left: 18,
    right: 18,
    bottom: 108,
    paddingHorizontal: 13,
    paddingVertical: 11,
    borderRadius: radii.sm,
    backgroundColor: palette.danger,
  },
  cameraErrorText: {
    color: palette.paper,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  cameraControlButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.cameraControl,
  },
  cameraControlSpacer: {
    width: 48,
    height: 48,
  },
  shutterOuter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: palette.onDark,
  },
  shutterInner: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.onDark,
  },
  shutterDisabled: {
    opacity: 0.6,
  },
  reviewRoot: {
    flex: 1,
    backgroundColor: palette.canvas,
  },
  reviewHeaderSafe: {
    backgroundColor: palette.canvas,
  },
  reviewHeader: {
    height: 64,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
  },
  reviewHeading: {
    alignItems: 'center',
  },
  reviewTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 15,
    fontWeight: '900',
  },
  reviewSubtitle: {
    marginTop: 2,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '600',
  },
  previewStage: {
    flex: 1,
    minHeight: 240,
    marginHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: radii.lg,
    backgroundColor: palette.accentInk,
  },
  previewImage: {
    width: '100%',
    height: '100%',
  },
  pageBadge: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    minHeight: 30,
    justifyContent: 'center',
    paddingHorizontal: 11,
    borderRadius: radii.pill,
    backgroundColor: palette.mediaScrim,
  },
  pageBadgeText: {
    color: palette.onDark,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '900',
  },
  reviewMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    marginHorizontal: 20,
    paddingTop: 15,
  },
  reviewMetaIcon: {
    width: 38,
    height: 38,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.lime,
  },
  reviewMetaCopy: {
    flex: 1,
  },
  reviewMetaTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '900',
  },
  reviewMetaText: {
    marginTop: 2,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    lineHeight: 15,
  },
  thumbnailRail: {
    flexGrow: 0,
    height: 82,
    marginTop: 12,
  },
  thumbnailContent: {
    paddingHorizontal: 18,
    paddingVertical: 3,
  },
  thumbnailSeparator: {
    width: 9,
  },
  thumbnailButton: {
    width: 58,
    height: 76,
    padding: 3,
    borderRadius: 12,
    backgroundColor: palette.paper,
  },
  thumbnailButtonSelected: {
    backgroundColor: palette.lime,
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
    borderRadius: 9,
    backgroundColor: palette.line,
  },
  thumbnailNumber: {
    position: 'absolute',
    left: 7,
    bottom: 7,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.mediaScrim,
  },
  thumbnailNumberSelected: {
    backgroundColor: palette.lime,
  },
  thumbnailNumberText: {
    color: palette.onDark,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '900',
  },
  thumbnailNumberTextSelected: {
    color: palette.accentInk,
  },
  reviewActionsSafe: {
    marginTop: 12,
    backgroundColor: palette.paper,
  },
  inlineError: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginHorizontal: 18,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderRadius: radii.sm,
    backgroundColor: palette.dangerSurface,
  },
  inlineErrorIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.paper,
  },
  inlineErrorCopy: {
    flex: 1,
    minWidth: 0,
  },
  inlineErrorTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '900',
  },
  inlineErrorText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 17,
    fontWeight: '600',
    marginTop: 3,
  },
  reviewActions: {
    minHeight: 88,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 18,
  },
  rescanButton: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingHorizontal: 17,
    borderRadius: radii.md,
    backgroundColor: palette.canvas,
  },
  rescanText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '800',
  },
  uploadButton: {
    flex: 1,
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radii.md,
    backgroundColor: palette.lime,
    ...shadows.card,
  },
  uploadButtonText: {
    color: palette.accentInk,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '900',
  },
});
