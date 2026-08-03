import { NativeModule, requireOptionalNativeModule } from 'expo';

import {
  assertBoundedNativeMtlsResponse,
  assertNativeMtlsRequestUrl,
  validateNativeMtlsResponseUrl,
} from './native-mtls-adapter.ts';
import { normalizeServerBaseUrl, type ClientIdentityMetadata } from './profile-store.ts';
import {
  NativeMtlsCapabilityError,
  assertUsableClientIdentity,
  type AuthenticatedProfileSession,
  type NativeMtlsDownloadRequest,
  type NativeMtlsHttpRequest,
  type NativeMtlsHttpResponse,
  type NativeMtlsMultipartUploadRequest,
  type NativeMtlsTransport,
} from './session.ts';

type NativeIdentitySelection = {
  identity: ClientIdentityMetadata;
  clientIdentityRef: string;
};

type NativeCapability = {
  available: boolean;
  reason?: string;
};

type NativeRequestInput = {
  requestId: string;
  clientIdentityRef: string;
  serverUrl: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

type NativeDownloadInput = Omit<NativeRequestInput, 'body'> & {
  destinationUri: string;
  maxBytes: number;
};

type NativeMultipartInput = Omit<NativeRequestInput, 'body'> & {
  fileUri: string;
  fieldName: string;
  fileName: string;
  mimeType: string;
  parameters: { name: string; value: string }[];
};

type TransferProgressEvent = {
  requestId: string;
  completedBytes: number;
  totalBytes: number | null;
};

type FolioMtlsEvents = {
  onTransferProgress(event: TransferProgressEvent): void;
};

declare class FolioMtlsNativeModule extends NativeModule<FolioMtlsEvents> {
  getCapabilitiesAsync(): Promise<NativeCapability>;
  listManagedClientIdentityRefsAsync(): Promise<unknown>;
  importClientIdentityAsync(serverUrl: string): Promise<NativeIdentitySelection | null>;
  selectClientIdentityAsync(
    serverUrl: string,
    suggestedClientIdentityRef?: string,
  ): Promise<NativeIdentitySelection | null>;
  describeClientIdentityAsync(
    clientIdentityRef: string,
  ): Promise<ClientIdentityMetadata | null>;
  removeClientIdentityAsync(clientIdentityRef: string): Promise<void>;
  requestAsync(input: NativeRequestInput): Promise<NativeMtlsHttpResponse>;
  downloadAsync(input: NativeDownloadInput): Promise<NativeMtlsHttpResponse>;
  uploadMultipartAsync(input: NativeMultipartInput): Promise<NativeMtlsHttpResponse>;
  cancelRequestAsync(requestId: string): Promise<void>;
}

const nativeModule = requireOptionalNativeModule<FolioMtlsNativeModule>('FolioMtls');

function requestId() {
  return globalThis.crypto?.randomUUID?.() ??
    `mtls-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function mappedNativeError(error: unknown): NativeMtlsCapabilityError {
  const rawCode =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : '';
  const code = rawCode.replace(/^ERR_FOLIO_MTLS_/, '');
  switch (code) {
    case 'IDENTITY_NOT_FOUND':
      return new NativeMtlsCapabilityError(
        'client-identity-not-found',
        'The saved client identity is no longer available. Select a replacement.',
      );
    case 'IDENTITY_EXPIRED':
      return new NativeMtlsCapabilityError(
        'client-identity-expired',
        'The selected client certificate has expired and must be replaced.',
      );
    case 'IDENTITY_NOT_YET_VALID':
      return new NativeMtlsCapabilityError(
        'client-identity-not-yet-valid',
        'The selected client certificate is not valid yet.',
      );
    case 'IDENTITY_MISSING_PRIVATE_KEY':
      return new NativeMtlsCapabilityError(
        'client-identity-missing-private-key',
        'The selected certificate has no accessible private key.',
      );
    case 'CANCELED':
      return new NativeMtlsCapabilityError(
        'client-identity-request-canceled',
        'The mutual-TLS request was canceled.',
      );
    case 'ORIGIN':
      return new NativeMtlsCapabilityError(
        'client-identity-origin-mismatch',
        'The native transport refused to present the identity to this URL.',
      );
    case 'IMPORT':
      return new NativeMtlsCapabilityError(
        'client-identity-import-failed',
        'The client identity could not be imported. Check the file and password.',
      );
    default:
      return new NativeMtlsCapabilityError(
        'client-identity-request-failed',
        'The certificate-aware native request failed.',
      );
  }
}

function requireModule(): FolioMtlsNativeModule {
  if (!nativeModule) {
    throw new NativeMtlsCapabilityError(
      'native-mtls-transport-unavailable',
      'This build does not include Folio’s native mutual-TLS module.',
    );
  }
  return nativeModule;
}

function validateManagedClientIdentityRefs(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 512 ||
    value.some((reference) =>
      typeof reference !== 'string' ||
      reference.length === 0 ||
      reference.length > 1_024 ||
      reference.trim() !== reference
    )
  ) {
    throw new NativeMtlsCapabilityError(
      'client-identity-request-failed',
      'The native identity inventory was invalid.',
    );
  }
  return [...new Set(value)];
}

function createSession(
  module: FolioMtlsNativeModule,
  input: { profileId: string; clientIdentityRef: string; serverUrl: string },
): AuthenticatedProfileSession {
  let disposed = false;
  const perform = async (
    request: NativeMtlsHttpRequest | NativeMtlsDownloadRequest | NativeMtlsMultipartUploadRequest,
    operation: (
      nativeInput: NativeRequestInput,
    ) => Promise<NativeMtlsHttpResponse>,
  ) => {
    if (disposed) {
      throw new NativeMtlsCapabilityError(
        'client-identity-request-failed',
        'This mutual-TLS session has already been closed.',
      );
    }
    if (request.signal?.aborted) {
      throw new NativeMtlsCapabilityError(
        'client-identity-request-canceled',
        'The mutual-TLS request was canceled.',
      );
    }
    const url = assertNativeMtlsRequestUrl(input.serverUrl, request.url);
    const id = requestId();
    const abort = () => {
      void module.cancelRequestAsync(id).catch(() => undefined);
    };
    request.signal?.addEventListener('abort', abort, { once: true });
    const onProgress = 'onProgress' in request ? request.onProgress : undefined;
    const progressSubscription = onProgress
      ? module.addListener('onTransferProgress', (event) => {
          if (event.requestId !== id) return;
          onProgress(
            event.totalBytes && event.totalBytes > 0
              ? Math.min(1, event.completedBytes / event.totalBytes)
              : null,
          );
        })
      : null;
    try {
      const response = await operation({
        requestId: id,
        clientIdentityRef: input.clientIdentityRef,
        serverUrl: input.serverUrl,
        url,
        method: request.method,
        headers: request.headers,
        ...('body' in request && request.body !== undefined ? { body: request.body } : {}),
      });
      assertBoundedNativeMtlsResponse(response);
      validateNativeMtlsResponseUrl(url, response.responseUrl);
      return response;
    } catch (error) {
      if (error instanceof NativeMtlsCapabilityError) throw error;
      throw mappedNativeError(error);
    } finally {
      request.signal?.removeEventListener('abort', abort);
      progressSubscription?.remove();
    }
  };

  return {
    profileId: input.profileId,
    async getRequestHeaders() {
      return {};
    },
    async refreshIfNeeded() {},
    async logout() {},
    request(request) {
      return perform(request, (nativeInput) => module.requestAsync(nativeInput));
    },
    download(request) {
      return perform(request, (nativeInput) =>
        module.downloadAsync({
          ...nativeInput,
          destinationUri: request.destinationUri,
          maxBytes: request.maxBytes,
        }),
      );
    },
    uploadMultipart(request) {
      return perform(request, (nativeInput) =>
        module.uploadMultipartAsync({
          ...nativeInput,
          fileUri: request.fileUri,
          fieldName: request.fieldName,
          fileName: request.fileName,
          mimeType: request.mimeType,
          parameters: request.parameters.map(([name, value]) => ({ name, value })),
        }),
      );
    },
    async dispose() {
      disposed = true;
    },
  };
}

export const nativeMtlsTransport: NativeMtlsTransport | null = nativeModule
  ? {
      async isAvailable() {
        try {
          return (await nativeModule.getCapabilitiesAsync()).available;
        } catch {
          return false;
        }
      },
      async listManagedClientIdentityRefs() {
        try {
          return validateManagedClientIdentityRefs(
            await nativeModule.listManagedClientIdentityRefsAsync(),
          );
        } catch (error) {
          if (error instanceof NativeMtlsCapabilityError) throw error;
          throw mappedNativeError(error);
        }
      },
      async selectClientIdentity(input) {
        try {
          const selection = await nativeModule.selectClientIdentityAsync(
            normalizeServerBaseUrl(input.serverUrl),
            input.suggestedClientIdentityRef,
          );
          if (selection) {
            assertUsableClientIdentity(selection.identity, new Date().toISOString());
          }
          return selection;
        } catch (error) {
          throw mappedNativeError(error);
        }
      },
      async importClientIdentity(input) {
        try {
          const selection = await nativeModule.importClientIdentityAsync(
            normalizeServerBaseUrl(input.serverUrl),
          );
          if (selection) {
            assertUsableClientIdentity(selection.identity, new Date().toISOString());
          }
          return selection;
        } catch (error) {
          throw mappedNativeError(error);
        }
      },
      async describeClientIdentity(clientIdentityRef) {
        try {
          return await nativeModule.describeClientIdentityAsync(clientIdentityRef);
        } catch (error) {
          throw mappedNativeError(error);
        }
      },
      async removeClientIdentity(clientIdentityRef) {
        try {
          await nativeModule.removeClientIdentityAsync(clientIdentityRef);
        } catch (error) {
          throw mappedNativeError(error);
        }
      },
      async openAuthenticatedSession(input) {
        try {
          const identity = await nativeModule.describeClientIdentityAsync(input.clientIdentityRef);
          if (!identity) {
            throw new NativeMtlsCapabilityError(
              'client-identity-not-found',
              'The saved client identity is no longer available. Select a replacement.',
            );
          }
          assertUsableClientIdentity(identity, new Date().toISOString());
          return createSession(nativeModule, input);
        } catch (error) {
          if (error instanceof NativeMtlsCapabilityError) throw error;
          throw mappedNativeError(error);
        }
      },
    }
  : null;

export function getNativeMtlsTransport(): NativeMtlsTransport | null {
  return nativeMtlsTransport;
}

export function requireNativeMtlsModuleForTesting(): FolioMtlsNativeModule {
  return requireModule();
}
