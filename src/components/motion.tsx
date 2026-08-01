import * as Haptics from 'expo-haptics';
import {
  AccessibilityInfo,
  Animated,
  LayoutAnimation,
  Platform,
  Pressable as NativePressable,
  PressableProps,
  PressableStateCallbackType,
  StyleSheet,
  View,
  ViewStyle,
} from 'react-native';
import {
  PropsWithChildren,
  createContext,
  useContext,
  useEffect,
  useState,
} from 'react';

import { palette } from '@/constants/theme';

export type HapticIntent =
  | 'none'
  | 'selection'
  | 'light'
  | 'medium'
  | 'confirm'
  | 'warning'
  | 'error';

const AnimatedPressable = Animated.createAnimatedComponent(NativePressable);
const ReducedMotionContext = createContext(false);
let globallyReducedMotion = false;

function useReducedMotionPreference() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then((value) => mounted && setReduced(value));
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduced;
}

export function MotionProvider({ children }: PropsWithChildren) {
  const reducedMotion = useReducedMotionPreference();
  useEffect(() => {
    globallyReducedMotion = reducedMotion;
  }, [reducedMotion]);
  return (
    <ReducedMotionContext.Provider value={reducedMotion}>
      {children}
    </ReducedMotionContext.Provider>
  );
}

export function useReducedMotion() {
  return useContext(ReducedMotionContext);
}

export function animateLayout() {
  if (globallyReducedMotion) return;
  LayoutAnimation.configureNext({
    duration: 190,
    create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    update: { type: LayoutAnimation.Types.easeInEaseOut },
    delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
  });
}

export async function hapticFeedback(intent: HapticIntent) {
  if (intent === 'none' || Platform.OS === 'web') return;
  try {
    if (Platform.OS === 'android') {
      const androidType = {
        selection: Haptics.AndroidHaptics.Segment_Tick,
        light: Haptics.AndroidHaptics.Virtual_Key,
        medium: Haptics.AndroidHaptics.Context_Click,
        confirm: Haptics.AndroidHaptics.Confirm,
        warning: Haptics.AndroidHaptics.Context_Click,
        error: Haptics.AndroidHaptics.Reject,
      }[intent];
      await Haptics.performAndroidHapticsAsync(androidType);
      return;
    }

    if (intent === 'selection') await Haptics.selectionAsync();
    else if (intent === 'light') await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    else if (intent === 'medium') await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else {
      const notificationType = intent === 'confirm'
        ? Haptics.NotificationFeedbackType.Success
        : intent === 'warning'
          ? Haptics.NotificationFeedbackType.Warning
          : Haptics.NotificationFeedbackType.Error;
      await Haptics.notificationAsync(notificationType);
    }
  } catch {
    // Haptics are enhancement-only and must never block the interaction.
  }
}

type MotionPressableProps = PressableProps & {
  haptic?: HapticIntent;
  pressedScale?: number;
};

export function MotionPressable({
  haptic = 'selection',
  pressedScale = 0.975,
  disabled,
  accessibilityRole,
  hitSlop,
  onPress,
  onPressIn,
  onPressOut,
  style,
  ...props
}: MotionPressableProps) {
  const reducedMotion = useReducedMotion();
  const [scale] = useState(() => new Animated.Value(1));
  const [pressed, setPressed] = useState(false);

  function animate(toValue: number) {
    if (reducedMotion) return;
    Animated.spring(scale, {
      toValue,
      useNativeDriver: true,
      speed: toValue < 1 ? 42 : 30,
      bounciness: 0,
    }).start();
  }

  const state = { pressed } as PressableStateCallbackType;
  const resolvedStyle = StyleSheet.flatten(
    typeof style === 'function' ? style(state) : style,
  ) as ViewStyle | undefined;
  const existingTransform = Array.isArray(resolvedStyle?.transform) ? resolvedStyle.transform : [];

  return (
    <AnimatedPressable
      {...props}
      accessibilityRole={accessibilityRole ?? (onPress ? 'button' : undefined)}
      disabled={disabled}
      hitSlop={hitSlop ?? (onPress ? 8 : undefined)}
      onPress={(event) => {
        void hapticFeedback(haptic);
        onPress?.(event);
      }}
      onPressIn={(event) => {
        setPressed(true);
        animate(pressedScale);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        setPressed(false);
        animate(1);
        onPressOut?.(event);
      }}
      style={[
        resolvedStyle,
        !disabled && {
          transform: [...existingTransform, { scale: reducedMotion ? 1 : scale }],
        },
      ]}
    />
  );
}

export function MotionScreen({
  backgroundColor = palette.canvas,
  children,
  visible = true,
}: PropsWithChildren<{ backgroundColor?: string; visible?: boolean }>) {
  return (
    <View
      accessibilityViewIsModal={visible}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      pointerEvents={visible ? 'auto' : 'none'}
      style={[
        StyleSheet.absoluteFill,
        {
          backgroundColor,
          display: visible ? 'flex' : 'none',
          zIndex: 30,
        },
      ]}>
      {children}
    </View>
  );
}
