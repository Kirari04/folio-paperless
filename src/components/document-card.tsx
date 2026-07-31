import { ChevronRight } from 'lucide-react-native';
import { StyleSheet, Text, View } from 'react-native';

import { PaperThumbnail } from '@/components/paper-thumbnail';
import { MotionPressable as Pressable } from '@/components/motion';
import { fonts, palette, radii } from '@/constants/theme';
import { useRouter } from '@/lib/router';
import { DocumentItem } from '@/types/document';

export function DocumentCard({ document }: { document: DocumentItem }) {
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${document.title}`}
      onPressIn={() => router.preload({ pathname: '/document/[id]', params: { id: document.id } })}
      onPress={() => router.push({ pathname: '/document/[id]', params: { id: document.id } })}
      style={styles.card}>
      <PaperThumbnail document={document} />
      <View style={styles.body}>
        <Text numberOfLines={2} style={styles.title}>
          {document.title}
        </Text>
        <Text numberOfLines={1} style={styles.correspondent}>
          {document.correspondent}
        </Text>
        <View style={styles.footer}>
          <Text style={styles.date}>{document.added}</Text>
          {document.tags.slice(0, 1).map((tag) => (
            <View key={tag} style={styles.tag}>
              <Text style={styles.tagText}>{tag}</Text>
            </View>
          ))}
        </View>
      </View>
      <ChevronRight color={palette.faint} size={18} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 12,
    borderRadius: radii.lg,
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: 'rgba(23,35,27,0.04)',
  },
  pressed: {
    opacity: 0.74,
    transform: [{ scale: 0.99 }],
  },
  body: {
    flex: 1,
    alignSelf: 'stretch',
    justifyContent: 'center',
    gap: 3,
  },
  title: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '700',
  },
  correspondent: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 5,
  },
  date: {
    color: palette.faint,
    fontFamily: fonts.sans,
    fontSize: 11,
    fontWeight: '600',
  },
  tag: {
    backgroundColor: palette.canvas,
    borderRadius: radii.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  tagText: {
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '700',
  },
});
