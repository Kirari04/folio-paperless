import { Image } from 'expo-image';
import { StatusBar } from 'expo-status-bar';
import { ExternalLink, X } from 'lucide-react-native';
import { createElement, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, View } from 'react-native';

import { MotionPressable as Pressable, useReducedMotion } from '@/components/motion';
import { fonts, palette, radii } from '@/constants/theme';
import { useI18n } from '@/i18n';
import {
  hasPdfHeader,
  MAX_PDF_PREVIEW_BYTES,
  MAX_THUMBNAIL_DOWNLOAD_BYTES,
  responseBlobWithinLimit,
} from '@/lib/download-policy';
import { verifyRepresentationDescriptor } from '@/lib/document-representation-verification';
import { Sha256 } from '@/lib/sha256';
import type { PaperlessRepresentation } from '@/types/paperless-advanced';

type DocumentPreviewViewerProps = {
  cacheKey: string;
  clientIdentityRef?: string;
  expectedChecksum?: string | null;
  expectedSize?: number | null;
  fallbackSource: {
    headers: Record<string, string>;
    uri: string;
  } | null;
  headers: Record<string, string>;
  mimeType?: string | null;
  onClose: () => void;
  offline?: boolean;
  pageCount: number;
  profileId: string;
  representation?: PaperlessRepresentation;
  serverUrl: string;
  searchPages?: readonly unknown[] | null;
  title: string;
  uri: string;
  visible: boolean;
};

async function sha256Blob(blob: Blob, signal: AbortSignal) {
  const digest = new Sha256();
  const chunkSize = 64 * 1024;
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    if (signal.aborted) throw new DOMException('Preview verification was canceled.', 'AbortError');
    digest.update(new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer()));
  }
  return digest.digestHex();
}

export function DocumentPreviewViewer({
  clientIdentityRef,
  expectedChecksum,
  expectedSize,
  headers,
  mimeType,
  offline = false,
  onClose,
  pageCount,
  representation,
  title,
  uri,
  visible,
}: DocumentPreviewViewerProps) {
  const { colorScheme, formatNumber, t } = useI18n();
  const reducedMotion = useReducedMotion();
  const normalizedMimeType = mimeType?.split(';', 1)[0]?.trim().toLocaleLowerCase() ?? null;
  const previewKind = normalizedMimeType === null || normalizedMimeType === 'application/pdf'
    ? 'pdf'
    : normalizedMimeType.startsWith('image/') && normalizedMimeType !== 'image/svg+xml'
      ? 'image'
      : 'unsupported';
  const [retryKey, setRetryKey] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!visible || offline || clientIdentityRef || previewKind === 'unsupported') return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    let mounted = true;
    const frame = requestAnimationFrame(() => {
      setPreviewUrl(null);
      setLoadError(false);
      void (async () => {
        try {
          const response = await fetch(uri, {
            headers,
            redirect: 'manual',
            signal: controller.signal,
          });
          if (
            response.type === 'opaqueredirect'
            || (response.status >= 300 && response.status < 400)
            || !response.ok
          ) {
            throw new Error(`The representation preview failed with HTTP ${response.status}.`);
          }
          const blob = await responseBlobWithinLimit(
            response,
            previewKind === 'pdf' ? MAX_PDF_PREVIEW_BYTES : MAX_THUMBNAIL_DOWNLOAD_BYTES,
          );
          if (previewKind === 'pdf') {
            const header = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
            if (!hasPdfHeader(header)) throw new Error('Paperless returned a malformed PDF preview.');
          } else {
            const contentType = blob.type.split(';', 1)[0]?.trim().toLocaleLowerCase();
            if (!contentType?.startsWith('image/') || contentType === 'image/svg+xml') {
              throw new Error('Paperless returned an unsupported image preview.');
            }
          }
          if (representation) {
            verifyRepresentationDescriptor({
              actualChecksum: await sha256Blob(blob, controller.signal),
              actualSize: blob.size,
              expectedChecksum,
              expectedSize: expectedSize ?? null,
              representation,
            });
          }
          objectUrl = URL.createObjectURL(blob);
          if (mounted) setPreviewUrl(objectUrl);
        } catch (error) {
          if (!mounted || (error instanceof Error && error.name === 'AbortError')) return;
          setLoadError(true);
        }
      })();
    });
    return () => {
      mounted = false;
      cancelAnimationFrame(frame);
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [clientIdentityRef, expectedChecksum, expectedSize, headers, offline, previewKind, representation, retryKey, uri, visible]);

  const exactPdfPreview = useMemo(() => previewKind === 'pdf' && previewUrl
    ? createElement('iframe', {
        src: previewUrl,
        title: t('viewer.fullPreview', { title }),
        style: { border: 0, height: '100%', width: '100%' },
      })
    : null, [previewKind, previewUrl, t, title]);

  return (
    <Modal
      animationType={reducedMotion ? 'none' : 'fade'}
      onRequestClose={onClose}
      presentationStyle="fullScreen"
      visible={visible}>
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
      <View style={styles.root}>
        <View style={styles.header}>
          <Pressable
            accessibilityLabel={t('viewer.close')}
            onPress={onClose}
            style={styles.closeButton}>
            <X color={palette.ink} size={21} />
          </Pressable>
          <View style={styles.titleBlock}>
            <Text numberOfLines={1} style={styles.title}>
              {title}
            </Text>
            <Text style={styles.meta}>
              {t('viewer.firstPagePreview')}
              {pageCount > 1
                ? ` · ${t('viewer.pages', { count: formatNumber(pageCount) })}`
                : ''}
            </Text>
          </View>
          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.stage}>
          {offline || clientIdentityRef ? (
            <View style={styles.offlineState}>
              <Text style={styles.offlineTitle}>
                {clientIdentityRef ? t('viewer.mtlsRendererRequired') : t('viewer.offlineRendererUnavailable')}
              </Text>
              <Text style={styles.offlineCopy}>
                {clientIdentityRef
                  ? t('viewer.mtlsRendererRequiredCopy')
                  : t('viewer.offlineWebUnavailableCopy')}
              </Text>
            </View>
          ) : previewKind === 'unsupported' ? (
            <View style={styles.offlineState}>
              <Text style={styles.offlineTitle}>{t('viewer.representationUnsupported')}</Text>
              <Text style={styles.offlineCopy}>{t('viewer.representationUnsupportedCopy')}</Text>
            </View>
          ) : loadError ? (
            <View style={styles.offlineState}>
              <Text style={styles.offlineTitle}>{t('viewer.errorTitle')}</Text>
              <Text style={styles.offlineCopy}>{t('viewer.errorCopy')}</Text>
              <Pressable onPress={() => setRetryKey((value) => value + 1)} style={styles.retryButton}>
                <Text style={styles.retryText}>{t('common.retry')}</Text>
              </Pressable>
            </View>
          ) : previewUrl && previewKind === 'image' ? (
            <Image
              accessibilityLabel={t('viewer.fullPreview', { title })}
              contentFit="contain"
              source={{ uri: previewUrl }}
              style={styles.preview}
            />
          ) : exactPdfPreview ? (
            exactPdfPreview
          ) : (
            <View style={styles.offlineState}>
              <ActivityIndicator color={palette.lime} />
              <Text style={styles.offlineCopy}>{t('viewer.preparingSecure')}</Text>
            </View>
          )}
        </View>

        <View style={styles.notice}>
          <ExternalLink color={palette.lime} size={16} />
          <Text style={styles.noticeText}>
            {t('viewer.nativeBuildNotice')}
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: palette.canvas,
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
    backgroundColor: palette.paper,
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  titleBlock: {
    flex: 1,
  },
  title: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 17,
  },
  meta: {
    color: palette.muted,
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
  offlineState: {
    backgroundColor: palette.paper,
    borderRadius: radii.md,
    maxWidth: 520,
    padding: 24,
  },
  offlineTitle: {
    color: palette.ink,
    fontFamily: fonts.sans,
    fontSize: 16,
    fontWeight: '800',
    textAlign: 'center',
  },
  offlineCopy: {
    color: palette.muted,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 8,
    textAlign: 'center',
  },
  retryButton: {
    alignSelf: 'center',
    backgroundColor: palette.lime,
    borderRadius: radii.sm,
    marginTop: 14,
    minHeight: 42,
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  retryText: {
    color: palette.accentInk,
    fontFamily: fonts.sans,
    fontSize: 12,
    fontWeight: '900',
  },
  notice: {
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: palette.paper,
    borderRadius: radii.md,
    flexDirection: 'row',
    gap: 9,
    marginTop: 20,
    maxWidth: 620,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  noticeText: {
    color: palette.inkSoft,
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 12,
    lineHeight: 18,
  },
});
