import { useEffect, useMemo, useRef } from 'react';

import { useApp } from '@/context/app-context';
import { useI18n } from '@/context/ui-preferences-context';
import { createNativeOsSearchIndexAdapter } from '@/lib/os-search-native-adapter';
import {
  reconcileNativeOsSearch,
  revokeNativeOsSearch,
} from '@/lib/os-search-runtime';
import { searchableSummariesForDocuments } from '@/lib/os-search-document-summaries';
import type { OsSearchPrivacyPolicy } from '@/lib/os-search-privacy';
import type { AppPreferences } from '@/types/document';

type OsSearchPreferences = AppPreferences & {
  osSearchEnabled?: boolean;
  osSearchMetadata?: OsSearchPrivacyPolicy['metadata'];
};

/**
 * Mount only inside ProtectedApp's unlocked branch. Unmounting is the lock
 * signal and immediately revokes the native index.
 */
export function OsSearchRuntimeGateway() {
  const { activeProfile, connected, documents, preferences, preferencesReady } = useApp();
  const { localeTag } = useI18n();
  const osSearchPreferences = preferences as OsSearchPreferences;
  const profileId = activeProfile?.id ?? null;
  const enabled = preferencesReady && osSearchPreferences.osSearchEnabled === true;
  const metadata = osSearchPreferences.osSearchMetadata ?? 'minimal';
  const clearOnBackground = preferences.biometricLock;
  const adapterPromise = useMemo(() => createNativeOsSearchIndexAdapter(), []);
  const operationQueue = useRef<Promise<void>>(Promise.resolve());
  const operationGeneration = useRef(0);
  const latestClearOnBackground = useRef(clearOnBackground);

  useEffect(() => {
    latestClearOnBackground.current = clearOnBackground;
  }, [clearOnBackground]);

  useEffect(() => {
    const generation = ++operationGeneration.current;
    const run = async () => {
      const adapter = await adapterPromise;
      if (generation !== operationGeneration.current) return;
      try {
        await reconcileNativeOsSearch(adapter, {
          policy: { enabled, metadata, maxItems: 250 },
          profileId,
          unlocked: true,
          authenticated: connected,
          clearOnBackground,
          documents: profileId
            ? searchableSummariesForDocuments(profileId, documents)
            : [],
        });
        if (generation !== operationGeneration.current) {
          await revokeNativeOsSearch(adapter, latestClearOnBackground.current);
        }
      } catch {
        // A failed reconciliation must not leave an older, broader snapshot.
        await adapter.clear().catch(() => undefined);
      }
    };
    operationQueue.current = operationQueue.current
      .catch(() => undefined)
      .then(run);
    return () => {
      if (operationGeneration.current === generation) operationGeneration.current += 1;
    };
  }, [
    adapterPromise,
    clearOnBackground,
    connected,
    documents,
    enabled,
    localeTag,
    metadata,
    profileId,
  ]);

  useEffect(() => () => {
    operationGeneration.current += 1;
    void adapterPromise.then(async (adapter) => {
      try {
        await revokeNativeOsSearch(adapter, latestClearOnBackground.current);
      } catch {
        // The optional native module is unavailable in Expo Go and on web.
      }
    });
  }, [adapterPromise]);

  return null;
}
