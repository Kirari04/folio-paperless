import { useCallback, useEffect, useMemo, useState } from 'react';

import { useApp } from '@/context/app-context';
import { translateRuntime } from '@/i18n/runtime';
import {
  discoverPaperlessCapabilities,
  PaperlessCapabilityCache,
} from '@/lib/paperless-capabilities';
import { PaperlessAdvancedApi } from '@/lib/paperless-advanced';
import {
  PaperlessClient,
  type AuthenticatedPaperlessRequest,
  type PaperlessRequest,
} from '@/lib/paperless-client';
import {
  normalizeServerUrl,
  paperlessRequestHeaders,
  requestPaperlessRawResponse,
  usesNativeMutualTls,
} from '@/lib/paperless';
import type { PaperlessCredentials } from '@/types/document';
import type { PaperlessCapabilities } from '@/types/paperless-advanced';

type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, 'status' | 'headers' | 'text'>>;

const capabilityCache = new PaperlessCapabilityCache();
let nextCredentialGeneration = 0;

function parseResponseBody(value: string) {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function createAuthenticatedPaperlessRequest(
  credentials: PaperlessCredentials,
  fetchImplementation?: FetchLike,
): AuthenticatedPaperlessRequest {
  const baseUrl = normalizeServerUrl(credentials.serverUrl);
  const request: AuthenticatedPaperlessRequest = async <T>(options: PaperlessRequest) => {
    const { path, method, headers, json, signal } = options;
    const credentialHeaders = paperlessRequestHeaders(
      credentials,
      headers.Accept ?? headers.accept,
    );
    const init = {
      method,
      headers: { ...credentialHeaders, ...headers },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      redirect: 'manual' as const,
      signal,
    };
    const response = usesNativeMutualTls(credentials) || !fetchImplementation
      ? await requestPaperlessRawResponse(credentials, path, init)
      : await fetchImplementation(`${baseUrl}${path}`, init);
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 32 * 1024 * 1024) {
      throw new Error('Paperless returned a response that exceeds Folio\'s safety limit.');
    }
    return {
      status: response.status,
      headers: response.headers,
      data: parseResponseBody(text) as T,
    };
  };
  return request;
}

export function createPaperlessAdvancedClient(
  credentials: PaperlessCredentials,
  fetchImplementation?: FetchLike,
) {
  if (!credentials.profileId?.trim()) {
    throw new Error(translateRuntime('runtimeError.profileIdentity'));
  }
  return new PaperlessClient({
    profileId: credentials.profileId,
    request: createAuthenticatedPaperlessRequest(credentials, fetchImplementation),
  });
}

export type PaperlessAdvancedBridgeState =
  | { phase: 'disconnected'; api: null; capabilities: null; error: null }
  | { phase: 'loading'; api: null; capabilities: null; error: null }
  | { phase: 'ready'; api: PaperlessAdvancedApi; capabilities: PaperlessCapabilities; error: null }
  | { phase: 'error'; api: null; capabilities: null; error: string };

export function usePaperlessAdvanced() {
  const { credentials } = useApp();
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<PaperlessAdvancedBridgeState>(() => (
    credentials
      ? { phase: 'loading', api: null, capabilities: null, error: null }
      : { phase: 'disconnected', api: null, capabilities: null, error: null }
  ));
  const client = useMemo(() => {
    if (!credentials) return null;
    try {
      return createPaperlessAdvancedClient(credentials);
    } catch {
      return null;
    }
  }, [credentials]);
  const credentialGeneration = useMemo(
    () => credentials ? ++nextCredentialGeneration : 0,
    [credentials],
  );
  const cacheBinding = useMemo(() => credentials ? JSON.stringify({
    serverUrl: normalizeServerUrl(credentials.serverUrl),
    credentialGeneration,
  }) : null, [credentialGeneration, credentials]);
  const handleCapabilityMismatch = useCallback(() => {
    if (!client) return;
    capabilityCache.invalidate(client.profileId);
    setReloadKey((value) => value + 1);
  }, [client]);

  useEffect(() => {
    if (!credentials) {
      const timer = setTimeout(() => {
        setState({ phase: 'disconnected', api: null, capabilities: null, error: null });
      }, 0);
      return () => clearTimeout(timer);
    }
    if (!client) {
      const timer = setTimeout(() => {
        setState({
          phase: 'error',
          api: null,
          capabilities: null,
          error: translateRuntime('runtimeError.profileIdentity'),
        });
      }, 0);
      return () => clearTimeout(timer);
    }
    const controller = new AbortController();
    const cached = capabilityCache.get(client.profileId, Date.now(), cacheBinding ?? undefined);
    if (cached && reloadKey === 0) {
      const timer = setTimeout(() => {
        setState({
          phase: 'ready',
          api: new PaperlessAdvancedApi(client, cached, {
            onCapabilityMismatch: handleCapabilityMismatch,
          }),
          capabilities: cached,
          error: null,
        });
      }, 0);
      return () => {
        clearTimeout(timer);
        controller.abort();
      };
    }
    const loadingTimer = setTimeout(() => {
      setState({ phase: 'loading', api: null, capabilities: null, error: null });
    }, 0);
    void discoverPaperlessCapabilities(client, { signal: controller.signal })
      .then((capabilities) => {
        if (controller.signal.aborted) return;
        capabilityCache.set(capabilities, undefined, undefined, cacheBinding ?? undefined);
        setState({
          phase: 'ready',
          api: new PaperlessAdvancedApi(client, capabilities, {
            onCapabilityMismatch: handleCapabilityMismatch,
          }),
          capabilities,
          error: null,
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState({
          phase: 'error',
          api: null,
          capabilities: null,
          error: error instanceof Error
            ? error.message
            : translateRuntime('runtimeError.capabilityDiscovery'),
        });
      });
    return () => {
      clearTimeout(loadingTimer);
      controller.abort();
    };
  }, [cacheBinding, client, credentials, handleCapabilityMismatch, reloadKey]);

  useEffect(() => {
    const profileId = client?.profileId;
    return () => {
      if (profileId) capabilityCache.invalidate(profileId);
    };
  }, [client]);

  const reload = useCallback(() => {
    if (client) capabilityCache.invalidate(client.profileId);
    setReloadKey((value) => value + 1);
  }, [client]);

  return { ...state, reload };
}
