import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { ExternalLink, X } from 'lucide-react-native';
import { Modal, StyleSheet, Text, View } from 'react-native';

import { MotionPressable as Pressable, useReducedMotion } from '@/components/motion';
import { fonts, palette, radii } from '@/constants/theme';

type DocumentPreviewViewerProps = {
  cacheKey: string;
  fallbackSource: {
    headers: Record<string, string>;
    uri: string;
  };
  headers: Record<string, string>;
  onClose: () => void;
  pageCount: number;
  title: string;
  uri: string;
  visible: boolean;
};

export function DocumentPreviewViewer({
  fallbackSource,
  onClose,
  pageCount,
  title,
  visible,
}: DocumentPreviewViewerProps) {
  const reducedMotion = useReducedMotion();

  return (
    <Modal
      animationType={reducedMotion ? 'none' : 'fade'}
      onRequestClose={onClose}
      presentationStyle="fullScreen"
      visible={visible}>
      <StatusBar style="light" />
      <View style={styles.root}>
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Close document preview"
            onPress={onClose}
            style={styles.closeButton}>
            <X color={palette.paperStrong} size={21} />
          </Pressable>
          <View style={styles.titleBlock}>
            <Text numberOfLines={1} style={styles.title}>
              {title}
            </Text>
            <Text style={styles.meta}>
              First-page preview{pageCount > 1 ? ` · ${pageCount} pages` : ''}
            </Text>
          </View>
          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.stage}>
          <Image
            accessibilityLabel={`First page of ${title}`}
            cachePolicy="memory-disk"
            contentFit="contain"
            source={fallbackSource}
            style={styles.preview}
            transition={reducedMotion ? 0 : 120}
          />
        </View>

        <View style={styles.notice}>
          <ExternalLink color={palette.lime} size={16} />
          <Text style={styles.noticeText}>
            Full PDF zoom and page navigation are available in the Android development and release
            builds.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: '#0B0F0C',
    flex: 1,
    padding: 20,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    marginBottom: 20,
  },
  closeButton: {
    alignItems: 'center',
    backgroundColor: '#202722',
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  titleBlock: {
    flex: 1,
  },
  title: {
    color: palette.paperStrong,
    fontFamily: fonts.sans,
    fontSize: 17,
  },
  meta: {
    color: '#AEB6B0',
    fontFamily: fonts.sans,
    fontSize: 12,
    marginTop: 3,
  },
  headerSpacer: {
    width: 44,
  },
  stage: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    minHeight: 0,
  },
  preview: {
    height: '100%',
    maxHeight: 900,
    maxWidth: 900,
    width: '100%',
  },
  notice: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: '#171D19',
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: 9,
    marginTop: 20,
    maxWidth: 620,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  noticeText: {
    color: '#CBD1CC',
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
  },
});
