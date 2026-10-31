import type { ErrorResponse } from '@lms/backend/contracts';

// The browser talks to /api on its own origin; the dev/preview server (and in production the load
// balancer) forwards it to the backend. Cookies are host-only per college, so each college host has
// its own session.
const BASE = import.meta.env.VITE_API_BASE_URL ?? '/api';
/** For the few calls that cannot go through `api()` (raw bytes, XHR progress). */
export const API_BASE = BASE;

/** An error answered by the API (standard error shape) or a network failure (status 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null = null,
    readonly details: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** JSON body (objects) or a ready body such as FormData. */
  body?: unknown;
  /** Query string values; undefined, null and '' are left out. */
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal | undefined;
  /** Lets the request finish after the page is gone (page hide). Not sendBeacon: CSRF needs the X-Requested-With header. */
  keepalive?: boolean;
  /**
   * A 401 on this call means "not signed in", which is an ordinary answer (login page, /auth/me):
   * do not clear the cache and redirect.
   */
  anonymousOk?: boolean;
}

let onUnauthorized: (() => void) | null = null;

/** The app registers what happens on a 401 of a signed-in session (clear cache, go to login). */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

export function buildQuery(query: ApiOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

function isErrorBody(body: unknown): body is ErrorResponse {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof (body as ErrorResponse).error?.code === 'string'
  );
}

/** The one place that sends a request: credentials, the CSRF header, JSON, error mapping, 401 handling. */
export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    // required by the backend on every POST/PUT/PATCH/DELETE (CSRF); harmless on GET
    'x-requested-with': 'lms',
  };
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    body = opts.body;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}${buildQuery(opts.query)}`, {
      method: opts.method ?? 'GET',
      credentials: 'include',
      headers,
      body,
      signal: opts.signal,
      ...(opts.keepalive ? { keepalive: true } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Cannot reach the server');
  }

  if (res.ok) {
    if (res.status === 204) return undefined as T;
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('application/json')) return (await res.json()) as T;
    return (await res.text()) as T;
  }

  const parsed: unknown = await res.json().catch(() => null);
  const err = isErrorBody(parsed)
    ? new ApiError(
        res.status,
        parsed.error.code,
        parsed.error.message,
        parsed.error.requestId,
        parsed.error.details,
      )
    : new ApiError(res.status, 'unknown_error', res.statusText || 'Request failed');
  if (res.status === 401 && !opts.anonymousOk) onUnauthorized?.();
  throw err;
}

/** Downloads a text/CSV response as a file in the browser (credentials included). */
export async function download(path: string, fileName: string): Promise<void> {
  const text = await api<string>(path);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Multipart upload with progress (fetch cannot report upload progress, XHR can). Same contract as
 * api(): credentials, CSRF header, standard error shape.
 */
export function upload<T>(
  path: string,
  form: FormData,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('x-requested-with', 'lms');
    xhr.setRequestHeader('accept', 'application/json');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'network_error', 'Cannot reach the server'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    xhr.onload = () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        // not JSON
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve(parsed as T);
        return;
      }
      if (xhr.status === 401) onUnauthorized?.();
      reject(
        isErrorBody(parsed)
          ? new ApiError(
              xhr.status,
              parsed.error.code,
              parsed.error.message,
              parsed.error.requestId,
              parsed.error.details,
            )
          : new ApiError(xhr.status, 'unknown_error', 'Upload failed'),
      );
    };
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(form);
  });
}
