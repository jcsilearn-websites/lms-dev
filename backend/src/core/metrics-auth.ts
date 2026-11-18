import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Bearer-token check of the metrics endpoints (API `GET /metrics`, the worker's metrics port). Constant-time (the two values are
 * hashed first, so their lengths do not matter). `expected` undefined / empty = the endpoint is disabled: nothing is authorised.
 */
export function metricsAuthorized(
  authorization: string | undefined,
  expected: string | undefined,
): boolean {
  if (!expected || !authorization) return false;
  const m = /^Bearer (.+)$/.exec(authorization);
  if (!m?.[1]) return false;
  const a = createHash('sha256').update(m[1]).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
