import { useEffect, useState } from 'react';
import {
  Animated,
  Platform,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import {
  getNextSegmentValue,
  getSegmentedControlMetrics,
  getSelectedSegmentIndex,
  segmentedControlBorderWidth,
  segmentedControlGap,
  segmentedControlPadding,
  type SegmentedControlOption,
} from '@/components/animated-segmented-control-model';
import { MotionPressable as Pressable, useReducedMotion } from '@/components/motion';
import {
  createThemedStyleSheet,
  fonts,
  palette,
  radii,
  useThemedStyles,
} from '@/constants/theme';
import { useI18n } from '@/context/ui-preferences-context';

type AnimatedSegmentedControlProps<T extends string> = {
  accessibilityLabel: string;
  busy?: boolean;
  compact?: boolean;
  disabled?: boolean;
  onChange: (value: T) => void;
  options: readonly SegmentedControlOption<T>[];
  testID?: string;
  value: T;
};

export function AnimatedSegmentedControl<T extends string>({
  accessibilityLabel,
  busy = false,
  compact = false,
  disabled = false,
  onChange,
  options,
  testID,
  value,
}: AnimatedSegmentedControlProps<T>) {
  const { colorScheme } = useI18n();
  const styles = useThemedStyles(themedStyles, colorScheme);
  const reducedMotion = useReducedMotion();
  const selectedIndex = getSelectedSegmentIndex(options, value);
  const [position] = useState(() => new Animated.Value(selectedIndex));
  const [trackWidth, setTrackWidth] = useState(0);
  const metrics = getSegmentedControlMetrics(trackWidth, options.length);
  const translateX = Animated.multiply(position, metrics.step);

  useEffect(() => {
    position.stopAnimation();
    if (reducedMotion) {
      position.setValue(selectedIndex);
      return;
    }
    Animated.spring(position, {
      toValue: selectedIndex,
      speed: 24,
      bounciness: 5,
      useNativeDriver: true,
    }).start();
  }, [position, reducedMotion, selectedIndex]);

  function measureTrack(event: LayoutChangeEvent) {
    const nextWidth = event.nativeEvent.layout.width;
    setTrackWidth((currentWidth) => (
      Math.abs(currentWidth - nextWidth) > 0.5 ? nextWidth : currentWidth
    ));
  }

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="radiogroup"
      accessibilityState={{ busy }}
      onLayout={measureTrack}
      style={[styles.track, disabled && styles.disabled]}
      testID={testID}>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.indicator,
          {
            opacity: trackWidth > 0 ? 1 : 0,
            transform: [{ translateX }],
            width: metrics.segmentWidth,
          },
        ]}
      />
      {options.map((option, index) => {
        const selected = option.value === value;
        const optionDisabled = busy || disabled || option.disabled === true;
        return (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled: optionDisabled }}
            aria-checked={selected}
            disabled={optionDisabled}
            haptic="none"
            key={option.value}
            onPress={() => {
              const nextValue = getNextSegmentValue(options, index, value, busy || disabled);
              if (nextValue !== null) onChange(nextValue);
            }}
            style={[styles.segment, compact && styles.segmentCompact]}>
            <Text
              numberOfLines={2}
              style={[
                styles.label,
                compact && styles.labelCompact,
                selected && styles.labelSelected,
              ]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const themedStyles = createThemedStyleSheet({
  track: {
    position: 'relative',
    flexDirection: 'row',
    gap: segmentedControlGap,
    padding: segmentedControlPadding,
    borderRadius: radii.sm,
    borderWidth: segmentedControlBorderWidth,
    borderColor: palette.line,
    backgroundColor: palette.canvas,
  },
  indicator: {
    position: 'absolute',
    top: segmentedControlPadding,
    bottom: segmentedControlPadding,
    left: segmentedControlPadding,
    borderRadius: 9,
    backgroundColor: palette.lime,
  },
  segment: {
    zIndex: 1,
    minHeight: Platform.OS === 'android' ? 48 : 44,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    paddingVertical: 8,
    borderRadius: 9,
  },
  segmentCompact: {
    paddingHorizontal: 4,
  },
  label: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '800',
    lineHeight: 16,
    textAlign: 'center',
  },
  labelCompact: {
    fontSize: 10,
    lineHeight: 14,
  },
  labelSelected: {
    color: palette.accentInk,
  },
  disabled: {
    opacity: 0.48,
  },
});
