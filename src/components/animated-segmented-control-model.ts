export type SegmentedControlOption<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

export const segmentedControlGap = 6;
export const segmentedControlPadding = 4;
export const segmentedControlBorderWidth = 1;

export function getSegmentedControlMetrics(trackWidth: number, optionCount: number) {
  if (trackWidth <= 0 || optionCount <= 0) {
    return { segmentWidth: 0, step: 0 };
  }
  const availableWidth = Math.max(
    0,
    trackWidth
      - (segmentedControlBorderWidth * 2)
      - (segmentedControlPadding * 2)
      - (segmentedControlGap * (optionCount - 1)),
  );
  const segmentWidth = availableWidth / optionCount;
  return {
    segmentWidth,
    step: segmentWidth + segmentedControlGap,
  };
}

export function getSelectedSegmentIndex<T extends string>(
  options: readonly SegmentedControlOption<T>[],
  value: T,
) {
  return Math.max(0, options.findIndex((option) => option.value === value));
}

export function getNextSegmentValue<T extends string>(
  options: readonly SegmentedControlOption<T>[],
  index: number,
  currentValue: T,
  disabled = false,
) {
  const option = options[index];
  if (disabled || !option || option.disabled || option.value === currentValue) return null;
  return option.value;
}
