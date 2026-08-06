import { FileText } from 'lucide-react-native';
import { Text, View } from 'react-native';

import { createThemedStyleSheet, fonts, palette, radii } from '@/constants/theme';
import { DocumentItem } from '@/types/document';

export function PaperThumbnail({
  document,
  width = 74,
}: {
  document: DocumentItem;
  width?: number;
}) {
  const height = width * 1.24;
  return (
    <View
      style={[
        styles.backdrop,
        {
          width,
          height,
          borderRadius: width * 0.2,
          backgroundColor: document.color,
        },
      ]}>
      <View
        style={[
          styles.paper,
          {
            width: width * 0.62,
            height: height * 0.71,
            borderRadius: width * 0.06,
          },
        ]}>
        <View style={[styles.masthead, { backgroundColor: document.accent }]} />
        <View style={styles.fakeLine} />
        <View style={[styles.fakeLine, styles.fakeLineShort]} />
        <View style={styles.amountRow}>
          <Text style={[styles.miniText, { color: document.accent }]}>
            {document.documentType.slice(0, 3).toUpperCase()}
          </Text>
          <FileText color={document.accent} size={8} />
        </View>
      </View>
      <View style={[styles.pageBadge, { backgroundColor: document.accent }]}>
        <Text style={styles.pageBadgeText}>{document.pageCount}</Text>
      </View>
    </View>
  );
}

const styles = createThemedStyleSheet({
  backdrop: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  paper: {
    backgroundColor: palette.paperStrong,
    padding: '10%',
    transform: [{ rotate: '-3deg' }],
  },
  masthead: {
    height: 5,
    width: '44%',
    borderRadius: radii.pill,
    marginBottom: 8,
  },
  fakeLine: {
    height: 3,
    width: '100%',
    borderRadius: radii.pill,
    backgroundColor: palette.line,
    marginBottom: 4,
  },
  fakeLineShort: {
    width: '64%',
  },
  amountRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  miniText: {
    fontFamily: fonts.mono,
    fontSize: 6,
    fontWeight: '800',
  },
  pageBadge: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pageBadgeText: {
    color: palette.paper,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '800',
  },
});
