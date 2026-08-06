import { X } from 'lucide-react-native';
import {
  Animated,
  DimensionValue,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable as NativePressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  PropsWithChildren,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MotionPressable as Pressable, useReducedMotion } from '@/components/motion';
import { createThemedStyleSheet, fonts, maxContentWidth, palette, radii, shadows } from '@/constants/theme';
import { useI18n } from '@/context/ui-preferences-context';

export type KeyboardSheetHandle = {
  close: () => void;
};

type KeyboardSheetProps = PropsWithChildren<{
  accessibilityLabel: string;
  maxHeight?: DimensionValue;
  onDismiss: () => void;
  onOpened?: () => void;
  subtitle?: string;
  title: string;
  visible: boolean;
}>;

export const KeyboardSheet = forwardRef<KeyboardSheetHandle, KeyboardSheetProps>(
  function KeyboardSheet(
    {
      accessibilityLabel,
      children,
      maxHeight = '88%',
      onDismiss,
      onOpened,
      subtitle,
      title,
      visible,
    },
    forwardedRef,
  ) {
    const reducedMotion = useReducedMotion();
    const { t } = useI18n();
    const transition = useRef(new Animated.Value(reducedMotion ? 1 : 0)).current;
    const closing = useRef(false);
    const focusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => () => {
      if (focusTimer.current) clearTimeout(focusTimer.current);
    }, []);

    useEffect(() => {
      if (!visible) return;
      closing.current = false;
      transition.stopAnimation();
      transition.setValue(reducedMotion ? 1 : 0);
      if (reducedMotion) return;

      const frame = requestAnimationFrame(() => {
        Animated.timing(transition, {
          duration: 240,
          easing: Easing.bezier(0.16, 1, 0.3, 1),
          toValue: 1,
          useNativeDriver: true,
        }).start();
      });
      return () => cancelAnimationFrame(frame);
    }, [reducedMotion, transition, visible]);

    const close = useCallback(() => {
      if (closing.current) return;
      closing.current = true;
      if (focusTimer.current) {
        clearTimeout(focusTimer.current);
        focusTimer.current = null;
      }
      Keyboard.dismiss();

      if (reducedMotion) {
        onDismiss();
        return;
      }

      transition.stopAnimation();
      Animated.timing(transition, {
        duration: 170,
        easing: Easing.bezier(0.4, 0, 1, 1),
        toValue: 0,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) onDismiss();
        else closing.current = false;
      });
    }, [onDismiss, reducedMotion, transition]);

    useImperativeHandle(forwardedRef, () => ({ close }), [close]);

    const handleShow = useCallback(() => {
      if (!onOpened) return;
      if (focusTimer.current) clearTimeout(focusTimer.current);
      focusTimer.current = setTimeout(onOpened, reducedMotion ? 0 : 90);
    }, [onOpened, reducedMotion]);

    return (
      <Modal
        animationType="none"
        hardwareAccelerated
        navigationBarTranslucent
        onRequestClose={close}
        onShow={handleShow}
        presentationStyle="overFullScreen"
        statusBarTranslucent
        transparent
        visible={visible}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.overlay}>
          <Animated.View
            pointerEvents="none"
            style={[styles.scrim, { opacity: transition.interpolate({
              inputRange: [0, 1],
              outputRange: [0, 1],
            }) }]}
          />
          <NativePressable
            accessibilityLabel={t('common.closeLabel', { label: accessibilityLabel })}
            onPress={close}
            style={StyleSheet.absoluteFill}
          />
          <Animated.View
            style={[
              styles.sheetFrame,
              {
                maxHeight,
                opacity: transition,
                transform: [{
                  translateY: transition.interpolate({
                    inputRange: [0, 1],
                    outputRange: [30, 0],
                  }),
                }],
              },
            ]}>
            <SafeAreaView
              accessibilityLabel={accessibilityLabel}
              accessibilityViewIsModal
              edges={['bottom']}
              style={styles.sheet}>
              <View style={styles.handle} />
              <View style={styles.header}>
                <View style={styles.headerCopy}>
                  <Text style={styles.title}>{title}</Text>
                  {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
                </View>
                <Pressable
                  accessibilityLabel={t('common.closeLabel', { label: accessibilityLabel })}
                  onPress={close}
                  style={styles.closeButton}>
                  <X color={palette.ink} size={20} />
                </Pressable>
              </View>
              {children}
            </SafeAreaView>
          </Animated.View>
        </KeyboardAvoidingView>
      </Modal>
    );
  },
);

const styles = createThemedStyleSheet({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  scrim: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: palette.scrim,
  },
  sheetFrame: {
    width: '100%',
    maxWidth: maxContentWidth,
    alignSelf: 'center',
  },
  sheet: {
    flexShrink: 1,
    overflow: 'hidden',
    paddingHorizontal: 18,
    paddingTop: 9,
    backgroundColor: palette.canvas,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    ...shadows.lift,
  },
  handle: {
    width: 42,
    height: 4,
    alignSelf: 'center',
    marginBottom: 10,
    borderRadius: radii.pill,
    backgroundColor: palette.lineStrong,
  },
  header: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 27,
    fontWeight: '600',
  },
  subtitle: {
    marginTop: 3,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 11,
    lineHeight: 16,
  },
  closeButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
    backgroundColor: palette.paper,
  },
});
