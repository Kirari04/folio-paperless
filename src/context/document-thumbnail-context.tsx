import { createContext, useContext, useMemo, type PropsWithChildren } from 'react';

import { useApp } from '@/context/app-context';
import type { DocumentThumbnailAccess } from '@/lib/document-thumbnail-policy';

/**
 * Nothing is fetched and nothing of the paper is shown until a provider says
 * otherwise, so a tree rendered outside the protected app — a test, a preview —
 * keeps the illustrated card.
 */
const sealed: DocumentThumbnailAccess = {
  enabled: false,
  contentPrivate: true,
  hasCredentials: false,
};

const DocumentThumbnailContext = createContext<DocumentThumbnailAccess & {
  credentials: ReturnType<typeof useApp>['credentials'];
}>({ ...sealed, credentials: null });

/**
 * Publishes the three facts every document card needs to decide between the
 * real Paperless thumbnail and its illustrated stand-in. It is mounted inside
 * the protected app because only that scope knows whether the biometric lock
 * is currently holding previews back.
 */
export function DocumentThumbnailProvider({
  children,
  contentPrivate,
}: PropsWithChildren<{ contentPrivate: boolean }>) {
  const { credentials, preferences, preferencesReady } = useApp();
  const value = useMemo(
    () => ({
      credentials: credentials ?? null,
      contentPrivate,
      enabled: preferencesReady && preferences.realThumbnails,
      hasCredentials: Boolean(credentials),
    }),
    [contentPrivate, credentials, preferences.realThumbnails, preferencesReady],
  );

  return (
    <DocumentThumbnailContext.Provider value={value}>
      {children}
    </DocumentThumbnailContext.Provider>
  );
}

export function useDocumentThumbnailAccess() {
  return useContext(DocumentThumbnailContext);
}
