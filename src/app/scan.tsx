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
  CircleAlert,
  FileUp,
  Images,
  Layers3,
  RotateCcw,
  ScanLine,
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
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MotionPressable as Pressable, animateLayout, hapticFeedback } from '@/components/motion';
import { fonts, palette, radii, shadows } from '@/constants/theme';
import { useApp } from '@/context/app-context';
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

type CaptureKind = 'smart' | 'manual';

function pluralPages(count: number) {
  return `${count} ${count === 1 ? 'page' : 'pages'}`;
}

function smartScannerMessage(error: unknown) {
  if (error instanceof SmartScannerUnavailableError) {
    if (/hybrid object|nitro|native module/i.test(error.message)) {
      return 'Smart scanning needs the updated Folio development build. Manual capture still works.';
    }
    return 'Smart scanning is unavailable on this device. You can still use manual capture.';
  }
  return error instanceof Error
    ? error.message
    : 'The smart scanner could not open. Try again or use manual capture.';
}

export default function ScanScreen() {
  const router = useRouter();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList, 'Scan'>>();
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
  const [savingLabel, setSavingLabel] = useState('Uploading…');
  const [scanError, setScanError] = useState<string | null>(null);
  const { importDocument, connected } = useApp();

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
      setScanError(smartScannerMessage(error));
      await hapticFeedback('error');
    } finally {
      smartLaunchRef.current = false;
      if (mountedRef.current) setIsLaunchingSmart(false);
    }
  }, [rememberScanSession]);

  useEffect(() => {
    if (Platform.OS === 'ios') return;
    if (autoLaunchRef.current) return;
    autoLaunchRef.current = true;
    const timer = setTimeout(() => void startSmartScan(), 220);
    return () => clearTimeout(timer);
  }, [startSmartScan]);

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
      setScanError(error instanceof Error ? error.message : 'The camera could not take a picture.');
      await hapticFeedback('error');
    } finally {
      setIsTakingPhoto(false);
    }
  }

  async function uploadScan() {
    if (!scanSession || isSaving) return;
    setIsSaving(true);
    setScanError(null);
    setSavingLabel(Platform.OS === 'ios' && !scanSession.pdfUri ? 'Preparing PDF…' : 'Uploading…');
    try {
      const file = await prepareSmartScan(scanSession);
      const preparedSession = !scanSession.pdfUri && file.mimeType === 'application/pdf'
        ? { ...scanSession, pdfUri: file.uri }
        : scanSession;
      if (preparedSession !== scanSession) rememberScanSession(preparedSession);
      setSavingLabel(connected ? 'Uploading…' : 'Adding…');
      let reportedProgress = -1;
      await importDocument(file, {
        onProgress: (progress) => {
          if (!connected) return;
          const percent = Math.min(100, Math.max(0, Math.round(progress * 20) * 5));
          if (percent === reportedProgress) return;
          reportedProgress = percent;
          setSavingLabel(
            percent >= 100 ? 'Handing off…' : percent > 0 ? `Uploading ${percent}%` : 'Starting upload…',
          );
        },
      });
      setSavingLabel(connected ? 'Sent to Paperless' : 'Added');
      await hapticFeedback('confirm');
      scanSessionRef.current = null;
      void discardSmartScan(preparedSession);
      router.replace('/inbox');
    } catch (error) {
      setScanError(error instanceof Error ? error.message : 'Could not save this scan.');
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
      multiple: false,
      type: ['application/pdf', 'image/*'],
    });
    if (result.canceled) return;
    const file = result.assets[0];
    setIsSaving(true);
    setSavingLabel(connected ? 'Uploading…' : 'Adding…');
    setScanError(null);
    try {
      let reportedProgress = -1;
      await importDocument(
        { uri: file.uri, name: file.name, mimeType: file.mimeType },
        {
          onProgress: (progress) => {
            if (!connected) return;
            const percent = Math.min(100, Math.max(0, Math.round(progress * 20) * 5));
            if (percent === reportedProgress) return;
            reportedProgress = percent;
            setSavingLabel(
              percent >= 100 ? 'Handing off…' : percent > 0 ? `Uploading ${percent}%` : 'Starting upload…',
            );
          },
        },
      );
      await hapticFeedback('confirm');
      router.replace('/inbox');
    } catch (error) {
      setScanError(error instanceof Error ? error.message : 'Could not import this file.');
      await hapticFeedback('error');
    } finally {
      await discardTemporaryFiles([file.uri]);
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
              accessibilityLabel="Close scan review"
              disabled={isSaving}
              onPress={() => router.back()}
              style={styles.lightIconButton}>
              <X color={palette.ink} size={21} />
            </Pressable>
            <View style={styles.reviewHeading}>
              <Text style={styles.reviewTitle}>Review scan</Text>
              <Text style={styles.reviewSubtitle}>
                {smart ? `${pluralPages(pageCount)} · cropped and enhanced` : 'Manual capture'}
              </Text>
            </View>
            <View style={styles.headerBalance} />
          </View>
        </SafeAreaView>

        <View style={styles.previewStage}>
          <Image
            accessibilityLabel={`Preview of page ${selectedPage + 1}`}
            contentFit="contain"
            recyclingKey={currentPage.uri}
            source={{ uri: currentPage.uri }}
            style={styles.previewImage}
            transition={140}
          />
          <View style={styles.pageBadge}>
            <Text style={styles.pageBadgeText}>{selectedPage + 1} / {pageCount}</Text>
          </View>
        </View>

        <View style={styles.reviewMeta}>
          <View style={styles.reviewMetaIcon}>
            {smart ? (
              <WandSparkles color={palette.ink} size={17} />
            ) : (
              <Camera color={palette.ink} size={17} />
            )}
          </View>
          <View style={styles.reviewMetaCopy}>
            <Text style={styles.reviewMetaTitle}>{smart ? 'Ready for Paperless' : 'Ready to upload'}</Text>
            <Text style={styles.reviewMetaText}>
              {smart
                ? 'Crop, perspective and document contrast were handled on-device.'
                : 'For automatic cleanup and multiple pages, use smart scan.'}
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
                  accessibilityLabel={`Show page ${index + 1}`}
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
                      {index + 1}
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
                <Text style={styles.inlineErrorTitle}>Upload didn’t finish</Text>
                <Text style={styles.inlineErrorText}>{scanError}</Text>
              </View>
            </View>
          )}
          <View style={styles.reviewActions}>
            <Pressable
              disabled={isSaving}
              haptic="light"
              onPress={rescan}
              style={[styles.rescanButton, isSaving && styles.disabledButton]}>
              <RotateCcw color={palette.ink} size={19} />
              <Text style={styles.rescanText}>Rescan</Text>
            </Pressable>
            <Pressable
              disabled={isSaving}
              haptic="none"
              onPress={uploadScan}
              style={[styles.uploadButton, isSaving && styles.disabledButton]}>
              {isSaving ? (
                <ActivityIndicator color={palette.ink} size="small" />
              ) : (
                <Check color={palette.ink} size={20} strokeWidth={2.7} />
              )}
              <Text style={styles.uploadButtonText}>
                {isSaving
                  ? savingLabel
                  : scanError
                    ? connected
                      ? 'Try upload again'
                      : 'Try adding again'
                    : connected
                    ? `Upload ${pageCount === 1 ? 'scan' : pluralPages(pageCount)}`
                    : `Add ${pageCount === 1 ? 'scan' : pluralPages(pageCount)}`}
              </Text>
            </Pressable>
          </View>
        </SafeAreaView>
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
            accessibilityLabel="Back to scan options"
            onPress={closeManualCamera}
            style={styles.permissionBack}>
            <ChevronLeft color={palette.ink} size={23} />
          </Pressable>
          <View style={styles.permissionMark}>
            <Camera color={palette.ink} size={34} />
          </View>
          <Text style={styles.permissionTitle}>Allow manual capture</Text>
          <Text style={styles.permissionCopy}>
            Folio only uses camera access while this screen is open. Your photo stays on this device
            until you confirm the upload.
          </Text>
          {!!scanError && <Text style={styles.permissionError}>{scanError}</Text>}
          <Pressable
            onPress={() => {
              if (permission.canAskAgain) void requestPermission();
              else void Linking.openSettings();
            }}
            style={styles.permissionButton}>
            <Text style={styles.permissionButtonText}>
              {permission.canAskAgain ? 'Allow camera access' : 'Open device settings'}
            </Text>
          </Pressable>
          <Pressable onPress={pickFile} style={styles.importInstead}>
            <FileUp color={palette.ink} size={17} />
            <Text style={styles.importInsteadText}>Import a file instead</Text>
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
            setScanError(message || 'The camera preview could not start.');
          }}
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.scrimTop} />
        <View style={styles.scrimBottom} />

        <SafeAreaView style={styles.cameraOverlay}>
          <View style={styles.cameraTopbar}>
            <Pressable
              accessibilityLabel="Back to scan options"
              onPress={closeManualCamera}
              style={styles.darkIconButton}>
              <ChevronLeft color={palette.paper} size={23} />
            </Pressable>
            <View style={styles.cameraTitleWrap}>
              <Text style={styles.cameraTitle}>Manual capture</Text>
              <Text style={styles.cameraSubtitle}>Single page fallback</Text>
            </View>
            <Pressable
              accessibilityLabel={torch ? 'Turn torch off' : 'Turn torch on'}
              onPress={() => setTorch((value) => !value)}
              style={[styles.darkIconButton, torch && styles.torchActive]}>
              {torch ? (
                <Zap color={palette.ink} fill={palette.ink} size={19} />
              ) : (
                <ZapOff color={palette.paper} size={19} />
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
              <ScanLine color={palette.ink} size={14} />
              <Text style={styles.cameraHintText}>
                {cameraReady ? 'Keep all four corners visible' : 'Starting camera…'}
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
              accessibilityLabel="Import a document"
              onPress={pickFile}
              style={styles.cameraControlButton}>
              <FileUp color={palette.paper} size={21} />
            </Pressable>
            <Pressable
              accessibilityLabel="Take picture"
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
                  <ActivityIndicator color={palette.ink} size="small" />
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
          accessibilityLabel="Close scanner"
          onPress={() => router.back()}
          style={styles.lightIconButton}>
          <X color={palette.ink} size={21} />
        </Pressable>
        <Text style={styles.launcherHeaderTitle}>Scan</Text>
        <View style={styles.headerBalance} />
      </View>

      <View style={styles.launcherBody}>
        <View style={styles.smartMark}>
          <View style={styles.smartMarkBack} />
          <ScanLine color={palette.lime} size={48} strokeWidth={1.8} />
          {isLaunchingSmart && <ActivityIndicator color={palette.paper} style={styles.smartSpinner} />}
        </View>
        <Text style={styles.launcherTitle}>
          {isLaunchingSmart ? 'Preparing smart scan' : 'Paper in. Clean scan out.'}
        </Text>
        <Text style={styles.launcherCopy}>
          {isLaunchingSmart
            ? 'The first scan can take a moment while Google prepares the on-device scanner.'
            : 'Automatic edges, perspective correction and multi-page capture—before Paperless starts its OCR.'}
        </Text>

        <View style={styles.capabilityList}>
          <View style={styles.capabilityRow}>
            <ScanLine color={palette.limeDark} size={18} />
            <Text style={styles.capabilityText}>Detects and straightens each page</Text>
          </View>
          <View style={styles.capabilityRow}>
            <Layers3 color={palette.limeDark} size={18} />
            <Text style={styles.capabilityText}>Combines every scanned page into one PDF</Text>
          </View>
          <View style={styles.capabilityRow}>
            <Sparkles color={palette.limeDark} size={18} />
            <Text style={styles.capabilityText}>Enhances contrast without cloud processing</Text>
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
          disabled={isLaunchingSmart || isSaving}
          haptic="light"
          onPress={startSmartScan}
          style={[
            styles.smartScanButton,
            (isLaunchingSmart || isSaving) && styles.disabledButton,
          ]}>
          {isLaunchingSmart ? (
            <ActivityIndicator color={palette.ink} size="small" />
          ) : (
            <ScanLine color={palette.ink} size={21} />
          )}
          <Text style={styles.smartScanButtonText}>
            {isLaunchingSmart ? 'Opening scanner…' : 'Start smart scan'}
          </Text>
        </Pressable>
        <View style={styles.secondaryActions}>
          <Pressable
            disabled={isLaunchingSmart || isSaving}
            onPress={openManualCamera}
            style={styles.secondaryAction}>
            <Camera color={palette.ink} size={19} />
            <Text style={styles.secondaryActionText}>Manual camera</Text>
          </Pressable>
          <Pressable
            disabled={isLaunchingSmart || isSaving}
            onPress={pickFile}
            style={styles.secondaryAction}>
            {isSaving ? (
              <ActivityIndicator color={palette.ink} size="small" />
            ) : (
              <Images color={palette.ink} size={19} />
            )}
            <Text numberOfLines={1} style={styles.secondaryActionText}>
              {isSaving ? savingLabel : 'Import file'}
            </Text>
          </Pressable>
        </View>
      </View>
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
    backgroundColor: palette.ink,
    transform: [{ rotate: '-3deg' }],
    ...shadows.lift,
  },
  smartMarkBack: {
    position: 'absolute',
    width: 92,
    height: 106,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: 'rgba(216,246,120,0.24)',
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
    backgroundColor: palette.rose,
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
    color: palette.ink,
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
    backgroundColor: palette.black,
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
    backgroundColor: palette.black,
  },
  scrimTop: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 150,
    backgroundColor: 'rgba(5,10,7,0.48)',
  },
  scrimBottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 200,
    backgroundColor: 'rgba(5,10,7,0.58)',
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
    backgroundColor: 'rgba(17,23,19,0.72)',
  },
  torchActive: {
    backgroundColor: palette.lime,
  },
  cameraTitleWrap: {
    alignItems: 'center',
  },
  cameraTitle: {
    color: palette.paper,
    fontFamily: fonts.sans,
    fontSize: 14,
    fontWeight: '900',
  },
  cameraSubtitle: {
    color: 'rgba(255,253,248,0.72)',
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
    color: palette.ink,
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
    backgroundColor: 'rgba(255,255,255,0.12)',
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
    borderColor: palette.paper,
  },
  shutterInner: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.paper,
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
    backgroundColor: palette.black,
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
    backgroundColor: 'rgba(17,23,19,0.82)',
  },
  pageBadgeText: {
    color: palette.paper,
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
    backgroundColor: 'rgba(17,23,19,0.82)',
  },
  thumbnailNumberSelected: {
    backgroundColor: palette.lime,
  },
  thumbnailNumberText: {
    color: palette.paper,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '900',
  },
  thumbnailNumberTextSelected: {
    color: palette.ink,
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
    backgroundColor: palette.rose,
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
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '900',
  },
});
