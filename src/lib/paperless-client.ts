export type PaperlessRequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export type PaperlessRequestHeaders = Readonly<Record<string, string>>;

export type PaperlessRequest = {
  path: string;
  method: PaperlessRequestMethod;
  headers: PaperlessRequestHeaders;
  json?: unknown;
  signal?: AbortSignal;
};

export type PaperlessResponse<T = unknown> = {
  status: number;
  headers?: Headers | Readonly<Record<string, string | undefined>>;
  data: T;
};

/**
 * The caller owns authentication, base-URL handling, TLS policy, and JSON
 * encoding. Keeping those concerns injected prevents advanced helpers from
 * ever receiving or retaining a raw token.
 */
export type AuthenticatedPaperlessRequest = <T = unknown>(
  request: PaperlessRequest,
) => Promise<PaperlessResponse<T>>;

export type PaperlessClientOptions = {
  profileId: string;
  request: AuthenticatedPaperlessRequest;
  apiVersion?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageFromBody(body: unknown): string | null {
  if (typeof body === 'string') return body.slice(0, 500);
  if (!isRecord(body)) return null;

  for (const key of ['detail', 'error', 'message', 'non_field_errors']) {
    const value = body[key];
    if (typeof value === 'string') return value.slice(0, 500);
    if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
      return value.join(' ').slice(0, 500);
    }
  }
  return null;
}

export function getPaperlessHeader(
  response: Pick<PaperlessResponse, 'headers'>,
  name: string,
): string | null {
  const headers = response.headers;
  if (!headers) return null;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(name);
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value;
  }
  return null;
}

export class PaperlessClientError extends Error {
  readonly status: number | null;
  readonly code: string;
  readonly retryable: boolean;
  readonly responseBody?: unknown;

  constructor(
    message: string,
    options: {
      status?: number | null;
      code?: string;
      retryable?: boolean;
      responseBody?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'PaperlessClientError';
    this.status = options.status ?? null;
    this.code = options.code ?? 'paperless-request-failed';
    this.retryable = options.retryable ?? false;
    this.responseBody = options.responseBody;
  }
}

function statusIsRetryable(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function assertRelativeApiPath(path: string) {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new PaperlessClientError('Paperless request paths must be same-server absolute paths.', {
      code: 'unsafe-request-path',
    });
  }
  if (/^\/https?:/i.test(path)) {
    throw new PaperlessClientError('Paperless request paths cannot contain an external URL.', {
      code: 'unsafe-request-path',
    });
  }
}

export class PaperlessClient {
  readonly profileId: string;
  readonly apiVersion: string;
  private readonly authenticatedRequest: AuthenticatedPaperlessRequest;

  constructor(options: PaperlessClientOptions) {
    const profileId = options.profileId.trim();
    if (!profileId) throw new Error('A stable Paperless profile ID is required.');
    this.profileId = profileId;
    this.apiVersion = options.apiVersion ?? '10';
    this.authenticatedRequest = options.request;
  }

  async raw<T = unknown>(
    path: string,
    options: {
      method?: PaperlessRequestMethod;
      headers?: PaperlessRequestHeaders;
      json?: unknown;
      signal?: AbortSignal;
    } = {},
  ): Promise<PaperlessResponse<T>> {
    assertRelativeApiPath(path);
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {
      Accept: `application/json; version=${this.apiVersion}`,
      ...options.headers,
    };
    if (options.json !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }

    try {
      return await this.authenticatedRequest<T>({
        path,
        method,
        headers,
        json: options.json,
        signal: options.signal,
      });
    } catch (error) {
      if (error instanceof PaperlessClientError) throw error;
      throw new PaperlessClientError('Could not reach the Paperless server.', {
        code: 'network-error',
        retryable: true,
        cause: error,
      });
    }
  }

  async request<T = unknown>(
    path: string,
    options: {
      method?: PaperlessRequestMethod;
      headers?: PaperlessRequestHeaders;
      json?: unknown;
      signal?: AbortSignal;
      acceptedStatuses?: number[];
    } = {},
  ): Promise<PaperlessResponse<T>> {
    const response = await this.raw<T>(path, options);
    const accepted = options.acceptedStatuses ?? [];
    if ((response.status < 200 || response.status >= 300) && !accepted.includes(response.status)) {
      const detail = messageFromBody(response.data);
      throw new PaperlessClientError(detail || `Paperless returned status ${response.status}.`, {
        status: response.status,
        code: `http-${response.status}`,
        retryable: statusIsRetryable(response.status),
        responseBody: response.data,
      });
    }
    return response;
  }

  get<T = unknown>(path: string, signal?: AbortSignal) {
    return this.request<T>(path, { signal });
  }

  post<T = unknown>(path: string, json: unknown, signal?: AbortSignal) {
    return this.request<T>(path, { method: 'POST', json, signal });
  }

  patch<T = unknown>(path: string, json: unknown, signal?: AbortSignal) {
    return this.request<T>(path, { method: 'PATCH', json, signal });
  }

  delete<T = unknown>(path: string, signal?: AbortSignal) {
    return this.request<T>(path, { method: 'DELETE', signal });
  }

  options<T = unknown>(path: string, signal?: AbortSignal) {
    return this.request<T>(path, { method: 'OPTIONS', signal });
  }
}
