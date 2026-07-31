import { View, StyleSheet } from 'react-native';

import { palette, radii } from '@/constants/theme';

export function FolioLogo({ size = 38, inverse = false }: { size?: number; inverse?: boolean }) {
  const pageColor = inverse ? palette.lime : palette.ink;
  const lineColor = inverse ? palette.ink : palette.lime;
  return (
    <View
      accessibilityLabel="Folio"
      style={[
        styles.mark,
        {
          width: size,
          height: size,
          borderRadius: size * 0.32,
          backgroundColor: pageColor,
        },
      ]}>
      <View
        style={[
          styles.page,
          {
            width: size * 0.46,
            height: size * 0.58,
            borderRadius: size * 0.06,
            backgroundColor: inverse ? palette.ink : palette.paper,
          },
        ]}>
        <View style={[styles.line, { backgroundColor: lineColor, width: '62%' }]} />
        <View style={[styles.line, { backgroundColor: lineColor, width: '82%' }]} />
        <View style={[styles.line, { backgroundColor: lineColor, width: '45%' }]} />
      </View>
      <View
        style={[
          styles.fold,
          {
            borderTopWidth: size * 0.14,
            borderLeftWidth: size * 0.14,
            borderTopColor: inverse ? palette.lime : palette.inkSoft,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  mark: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  page: {
    paddingTop: '21%',
    paddingHorizontal: '10%',
    gap: 2,
  },
  line: {
    height: 2,
    borderRadius: radii.pill,
  },
  fold: {
    position: 'absolute',
    right: '21%',
    top: '21%',
    width: 0,
    height: 0,
    borderLeftColor: 'transparent',
  },
});
