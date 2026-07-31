import * as DocumentPicker from 'expo-document-picker';
import { LinearGradient } from 'expo-linear-gradient';
import {
  ArrowRight,
  Camera,
  CheckCircle2,
  FileUp,
  Search,
  Sparkles,
  UserRound,
} from 'lucide-react-native';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppShell } from '@/components/app-shell';
import { MotionPressable as Pressable, hapticFeedback } from '@/components/motion';
import { DocumentCard } from '@/components/document-card';
import { FolioLogo } from '@/components/folio-logo';
import { PaperThumbnail } from '@/components/paper-thumbnail';
import { SectionHeading } from '@/components/section-heading';
import { fonts, palette, radii, shadows } from '@/constants/theme';
import { useApp } from '@/context/app-context';
import { useRouter } from '@/lib/router';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function HomeScreen() {
  const router = useRouter();
  const {
    documents,
    totalDocuments,
    inboxDocuments,
    connected,
    isSyncing,
    lastSynced,
    refresh,
    importDocument,
    connectionError,
  } = useApp();
  const [query, setQuery] = useState('');
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  async function pickDocument() {
    const result = await DocumentPicker.getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
      type: ['application/pdf', 'image/*', 'text/*'],
    });
    if (result.canceled) return;
    const file = result.assets[0];
    setImportError(null);
    setIsImporting(true);
    try {
      await importDocument({ uri: file.uri, name: file.name, mimeType: file.mimeType });
      await hapticFeedback('confirm');
      router.push('/inbox');
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Could not import this document.');
      await hapticFeedback('error');
    } finally {
      setIsImporting(false);
    }
  }

  function submitSearch() {
    const value = query.trim();
    router.push(value ? { pathname: '/documents', params: { q: value } } : '/documents');
  }

  return (
    <AppShell onRefresh={() => void refresh().catch(() => {})} refreshing={isSyncing}>
      <View style={styles.topbar}>
        <View style={styles.brand}>
          <FolioLogo />
          <View>
            <Text style={styles.brandName}>folio</Text>
            <Text style={styles.brandSub}>for Paperless</Text>
          </View>
        </View>
        <Pressable
          accessibilityLabel="Open settings"
          onPress={() => router.push('/settings')}
          style={styles.avatar}>
          <UserRound color={palette.ink} size={20} />
          <View style={[styles.statusDot, connected && styles.statusDotConnected]} />
        </Pressable>
      </View>

      <View style={styles.intro}>
        <Text style={styles.eyebrow}>{greeting()}</Text>
        <Text style={styles.heroTitle}>Paperwork,{'\n'}minus the work.</Text>
        <Text style={styles.heroCopy}>
          Everything important, searchable and in its place.
        </Text>
      </View>

      <View style={styles.search}>
        <Search color={palette.muted} size={20} />
        <TextInput
          accessibilityLabel="Search your documents"
          onChangeText={setQuery}
          onSubmitEditing={submitSearch}
          placeholder="Search titles, text, tags…"
          placeholderTextColor={palette.faint}
          returnKeyType="search"
          style={styles.searchInput}
          value={query}
        />
        <View style={styles.searchShortcut}>
          <Text style={styles.searchShortcutText}>⌘ K</Text>
        </View>
      </View>

      <Pressable
        onPress={() => router.push('/inbox')}
        style={styles.inboxPressable}>
        <LinearGradient
          colors={[palette.ink, '#2B3A30']}
          end={{ x: 1, y: 1 }}
          style={styles.inboxCard}>
          <View style={styles.inboxCopy}>
            <View style={styles.inboxPill}>
              <Sparkles color={palette.ink} size={13} />
              <Text style={styles.inboxPillText}>SMART INBOX</Text>
            </View>
            <Text style={styles.inboxTitle}>
              {inboxDocuments.length
                ? `${inboxDocuments.length} ${inboxDocuments.length === 1 ? 'document' : 'documents'} need a look`
                : 'Your inbox is clear'}
            </Text>
            <View style={styles.reviewLink}>
              <Text style={styles.reviewLinkText}>
                {inboxDocuments.length ? 'Review now' : 'See archive'}
              </Text>
              <ArrowRight color={palette.lime} size={17} />
            </View>
          </View>
          <View style={styles.paperStack}>
            {inboxDocuments.slice(0, 3).map((document, index) => (
              <View
                key={document.id}
                style={[
                  styles.paperStackItem,
                  {
                    transform: [
                      { translateX: index * 12 },
                      { translateY: index * -4 },
                      { rotate: `${(index - 1) * 5}deg` },
                    ],
                    zIndex: index,
                  },
                ]}>
                <PaperThumbnail document={document} width={58} />
              </View>
            ))}
            {!inboxDocuments.length && (
              <View style={styles.completeMark}>
                <CheckCircle2 color={palette.ink} size={34} />
              </View>
            )}
          </View>
        </LinearGradient>
      </Pressable>

      <View style={styles.quickGrid}>
        <Pressable
          onPress={() => router.push('/scan')}
          style={[styles.quickAction, styles.scanAction]}>
          <View style={[styles.quickIcon, { backgroundColor: palette.ink }]}>
            <Camera color={palette.lime} size={21} />
          </View>
          <View style={styles.quickText}>
            <Text style={styles.quickTitle}>Scan paper</Text>
            <Text style={styles.quickSubtitle}>Camera to inbox</Text>
          </View>
          <ArrowRight color={palette.ink} size={18} />
        </Pressable>

        <Pressable
          disabled={isImporting}
          onPress={pickDocument}
          style={styles.quickAction}>
          <View style={[styles.quickIcon, { backgroundColor: palette.lavender }]}>
            {isImporting ? (
              <ActivityIndicator color={palette.ink} size="small" />
            ) : (
              <FileUp color={palette.ink} size={21} />
            )}
          </View>
          <View style={styles.quickText}>
            <Text style={styles.quickTitle}>Import file</Text>
            <Text style={styles.quickSubtitle}>PDF or image</Text>
          </View>
          <ArrowRight color={palette.ink} size={18} />
        </Pressable>
      </View>

      {!!(importError || (connected && connectionError)) && (
        <View accessibilityLiveRegion="polite" style={styles.errorBanner}>
          <Text style={styles.errorText}>{importError || connectionError}</Text>
        </View>
      )}

      <View style={styles.statsCard}>
        <View>
          <Text style={styles.statsValue}>{connected ? totalDocuments : documents.length}</Text>
          <Text style={styles.statsLabel}>
            {connected ? 'documents in library' : 'sample documents'}
          </Text>
        </View>
        <View style={styles.statsDivider} />
        <View>
          <Text style={styles.statsValue}>{inboxDocuments.length}</Text>
          <Text style={styles.statsLabel}>awaiting review</Text>
        </View>
        <View style={styles.syncState}>
          <View style={[styles.syncDot, connected && styles.syncDotConnected]} />
          <Text style={styles.syncText}>{connected ? `Synced ${lastSynced}` : 'Demo workspace'}</Text>
        </View>
      </View>

      <View style={styles.recentSection}>
        <SectionHeading
          title="Recently added"
          action={
            <Pressable onPress={() => router.push('/documents')}>
              <Text style={styles.seeAll}>See all</Text>
            </Pressable>
          }
        />
        <View style={styles.documentList}>
          {documents.slice(0, 3).map((document) => (
            <DocumentCard document={document} key={document.id} />
          ))}
        </View>
      </View>
    </AppShell>
  );
}

const styles = StyleSheet.create({
  topbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  brandName: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 20,
    lineHeight: 21,
    fontWeight: '900',
    letterSpacing: -0.8,
  },
  brandSub: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 9,
    lineHeight: 11,
    fontWeight: '600',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: palette.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusDot: {
    position: 'absolute',
    right: 0,
    bottom: 1,
    width: 11,
    height: 11,
    borderRadius: 6,
    backgroundColor: palette.faint,
    borderWidth: 2,
    borderColor: palette.canvas,
  },
  statusDotConnected: {
    backgroundColor: '#64AE72',
  },
  intro: {
    marginTop: 38,
    marginBottom: 22,
  },
  eyebrow: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 7,
  },
  heroTitle: {
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 43,
    lineHeight: 46,
    fontWeight: '600',
    letterSpacing: -1.5,
  },
  heroCopy: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 10,
  },
  search: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingHorizontal: 16,
    backgroundColor: palette.paper,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: palette.line,
  },
  searchInput: {
    flex: 1,
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 15,
  },
  searchShortcut: {
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: 7,
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  searchShortcutText: {
    color: palette.faint,
    fontFamily: fonts.mono,
    fontSize: 9,
    fontWeight: '700',
  },
  inboxPressable: {
    marginTop: 18,
  },
  inboxCard: {
    minHeight: 198,
    borderRadius: radii.lg,
    padding: 22,
    flexDirection: 'row',
    overflow: 'hidden',
    ...shadows.card,
  },
  inboxCopy: {
    flex: 1,
    zIndex: 10,
  },
  inboxPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: palette.lime,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.pill,
  },
  inboxPillText: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  inboxTitle: {
    maxWidth: 230,
    color: palette.paper,
    fontFamily: fonts.serif,
    fontSize: 26,
    lineHeight: 30,
    fontWeight: '600',
    marginTop: 20,
  },
  reviewLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 16,
  },
  reviewLinkText: {
    color: palette.lime,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '800',
  },
  paperStack: {
    width: 105,
    justifyContent: 'center',
    alignItems: 'center',
  },
  paperStackItem: {
    position: 'absolute',
  },
  completeMark: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: palette.lime,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickGrid: {
    gap: 10,
    marginTop: 12,
  },
  errorBanner: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: radii.sm,
    backgroundColor: '#F5E2DD',
    marginTop: 12,
  },
  errorText: {
    color: palette.danger,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700',
  },
  quickAction: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 13,
    paddingVertical: 11,
    borderRadius: radii.md,
    backgroundColor: palette.paper,
    borderWidth: 1,
    borderColor: palette.line,
  },
  scanAction: {
    backgroundColor: palette.lime,
    borderColor: palette.lime,
  },
  quickIcon: {
    width: 44,
    height: 44,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickText: {
    flex: 1,
  },
  quickTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 15,
    fontWeight: '800',
  },
  quickSubtitle: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    marginTop: 2,
  },
  statsCard: {
    marginTop: 12,
    minHeight: 108,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    padding: 18,
    borderRadius: radii.md,
    backgroundColor: '#E8E3D8',
    overflow: 'hidden',
  },
  statsValue: {
    color: palette.ink,
    fontFamily: fonts.serif,
    fontSize: 25,
    fontWeight: '700',
  },
  statsLabel: {
    maxWidth: 110,
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 10,
    fontWeight: '600',
    lineHeight: 14,
  },
  statsDivider: {
    width: 1,
    height: 42,
    backgroundColor: palette.lineStrong,
  },
  syncState: {
    position: 'absolute',
    right: 12,
    top: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  syncDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: palette.faint,
  },
  syncDotConnected: {
    backgroundColor: '#64AE72',
  },
  syncText: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 9,
    fontWeight: '600',
  },
  recentSection: {
    marginTop: 30,
    gap: 14,
  },
  seeAll: {
    color: palette.inkSoft,
    fontFamily: fonts.sans,
    fontSize: 13,
    fontWeight: '700',
  },
  documentList: {
    gap: 10,
  },
  pressed: {
    opacity: 0.8,
    transform: [{ scale: 0.985 }],
  },
});
