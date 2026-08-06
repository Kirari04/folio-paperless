import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  getNextSegmentValue,
  getSegmentedControlMetrics,
  getSelectedSegmentIndex,
  segmentedControlBorderWidth,
  segmentedControlGap,
  segmentedControlPadding,
} from '../src/components/animated-segmented-control-model.ts';

const options = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

test('segmented selection returns the exact enabled value once and ignores invalid changes', () => {
  assert.equal(getSelectedSegmentIndex(options, 'light'), 1);
  assert.equal(getNextSegmentValue(options, 2, 'light'), 'dark');
  assert.equal(getNextSegmentValue(options, 1, 'light'), null);
  assert.equal(getNextSegmentValue(options, 2, 'light', true), null);
  assert.equal(getNextSegmentValue([...options, { value: 'locked', label: 'Locked', disabled: true }], 3, 'light'), null);
  assert.equal(getNextSegmentValue(options, 9, 'light'), null);
});

test('two-, three-, and four-option tracks retain equal-width translated segments', () => {
  for (const optionCount of [2, 3, 4]) {
    const trackWidth = 320;
    const metrics = getSegmentedControlMetrics(trackWidth, optionCount);
    assert.ok(metrics.segmentWidth > 0);
    assert.equal(metrics.step, metrics.segmentWidth + segmentedControlGap);
    const occupiedWidth = (metrics.segmentWidth * optionCount)
      + (segmentedControlGap * (optionCount - 1))
      + (segmentedControlPadding * 2)
      + (segmentedControlBorderWidth * 2);
    assert.ok(Math.abs(occupiedWidth - trackWidth) < Number.EPSILON * trackWidth);
  }
});

test('animated segmented control preserves radio semantics, reduced motion, and native-driver transforms', async () => {
  const componentSource = await readFile(
    new URL('../src/components/animated-segmented-control.tsx', import.meta.url),
    'utf8',
  );
  const settingsSource = await readFile(
    new URL('../src/app/settings.tsx', import.meta.url),
    'utf8',
  );

  assert.match(componentSource, /accessibilityRole="radiogroup"/);
  assert.match(componentSource, /accessibilityRole="radio"/);
  assert.match(componentSource, /accessibilityState=\{\{ checked: selected, disabled: optionDisabled \}\}/);
  assert.match(componentSource, /accessibilityState=\{\{ busy \}\}/);
  assert.match(componentSource, /aria-checked=\{selected\}/);
  assert.match(componentSource, /numberOfLines=\{2\}/);
  assert.match(componentSource, /minHeight: Platform\.OS === 'android' \? 48 : 44/);
  assert.match(componentSource, /if \(reducedMotion\) \{[\s\S]*position\.setValue\(selectedIndex\)/);
  assert.match(componentSource, /Animated\.spring\(position, \{[\s\S]*useNativeDriver: true/);
  assert.match(componentSource, /transform: \[\{ translateX \}\]/);
  assert.match(componentSource, /backgroundColor: palette\.lime/);
  assert.match(componentSource, /color: palette\.accentInk/);
  assert.match(componentSource, /const optionDisabled = busy \|\| disabled/);
  assert.match(componentSource, /useThemedStyles\(themedStyles, colorScheme\)/);
  assert.match(settingsSource, /busy=\{uiPreferenceSaving === 'appearance'\}/);
  assert.equal(settingsSource.match(/<AnimatedSegmentedControl/g)?.length, 2);
  assert.equal(settingsSource.includes('quotaOptionSelected'), false);
  assert.equal(settingsSource.includes('segmentSelected'), false);
});
