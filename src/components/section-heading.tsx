import { ReactNode } from 'react';
import { Text, View } from 'react-native';

import { createThemedStyleSheet, fonts, palette } from '@/constants/theme';

export function SectionHeading({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.title}>{title}</Text>
      {action}
    </View>
  );
}

const styles = createThemedStyleSheet({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 19,
    fontWeight: '800',
    letterSpacing: -0.3,
  },
});
