import { withTimeout } from '../resilience';
import { counter } from '../telemetry';
import { createMemoryRateLimitStore, type RateLimitHit, type RateLimitStore } from './store';

// THE STRICT TIER (step 14a): anonymous and authentication endpoints (login, password reset, invite accept, provider webhooks, CSP
// and client-error reports) count in the SHARED store on every request: an attacker must not get N times the budget by spreading
// requests over N instances. One database round trip per request, on routes whose budgets say so (docs/adr/0022).
// If the shared store fails, or does not answer within its deadline, the limiter DEGRADES to per-instance counting (and counts the
// failure) instead of failing or holding the request: a limiter outage must not become a login outage.

/** A sign-in waits at most this long for the shared counter. */
export const STRICT_STORE_TIMEOUT_MS = 1000;

export interface StrictLimiter {
  hit(key: string, windowMs: number): Promise<RateLimitHit>;
}

export function createStrictLimiter(opts: {
  shared: RateLimitStore | null;
  onError?: (err: unknown) => void;
  timeoutMs?: number;
}): StrictLimiter {
  const { timeoutMs = STRICT_STORE_TIMEOUT_MS } = opts;
  const fallback = createMemoryRateLimitStore();
  return {
    async hit(key, windowMs) {
      const { shared } = opts;
      if (shared) {
        try {
          return await withTimeout('rate-limit store', timeoutMs, () =>
            shared.hit(key, windowMs, 1),
          );
        } catch (err) {
          counter('lms_rate_limit_store_errors_total', 'shared rate-limit store failures').add(1);
          opts.onError?.(err);
        }
      }
      return fallback.hit(key, windowMs, 1);
    },
  };
}
