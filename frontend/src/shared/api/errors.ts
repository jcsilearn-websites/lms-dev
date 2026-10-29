import { ApiError } from './client';

/** Messages for codes whose server text is too technical or must not differ per case. */
const FRIENDLY: Record<string, string> = {
  invalid_credentials: 'Wrong email or password.',
  account_locked: 'Too many failed attempts. Try again in a few minutes.',
  unauthenticated: 'Please sign in again.',
  csrf_rejected: 'The request was rejected. Reload the page and try again.',
  tenant_not_found: 'This college does not exist or is not active.',
  network_error: 'You appear to be offline, or the server cannot be reached.',
  FST_ERR_RATE_LIMIT: 'Too many requests. Wait a moment and try again.',
  busy: 'The server is busy. Try again in a moment.',
};

/** A message safe to show to a person for any error thrown by api(). */
export function describeError(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Something went wrong. Try again.';
  const friendly = FRIENDLY[err.code];
  if (friendly) return friendly;
  if (err.status === 429) return FRIENDLY.FST_ERR_RATE_LIMIT as string;
  if (err.status >= 500) {
    return `The server had a problem${err.requestId ? ` (reference ${err.requestId})` : ''}. Try again later.`;
  }
  if (err.status === 403) return err.message || 'You are not allowed to do this.';
  // 4xx: the server wrote these for people (409 conflicts such as "last admin", "in use", ...)
  return err.message || 'The request could not be completed.';
}

/** Field errors of a 400 validation response, keyed by field name ("email" -> message). */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || err.code !== 'validation_error') return {};
  const out: Record<string, string> = {};
  for (const d of err.details) {
    const name = d.path
      .replace(/^\//, '')
      .replace(/\//g, '.')
      .replace(/^body\.?/, '');
    if (name && !out[name]) out[name] = d.message;
  }
  return out;
}

export function isStatus(err: unknown, status: number): boolean {
  return err instanceof ApiError && err.status === status;
}
