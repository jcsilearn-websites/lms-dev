import type { BusyRetry } from './client';

/** Tests shorten the waits; the product leaves this alone (real timers, real jitter). */
export const signInRetryTiming: Pick<BusyRetry, 'sleep' | 'random'> = {};

/**
 * Signing in while the server is saturated (503 `busy`): three more attempts, spread over about 10 seconds by the waits of
 * `busyDelayMs` (2 s, 2 s, 4 s, each plus random jitter), then the ordinary error. The jitter keeps a lab that was refused
 * together from returning together.
 */
export const signInRetry = (onBusy: BusyRetry['onBusy']): BusyRetry => ({
  maxAttempts: 3,
  ...(onBusy ? { onBusy } : {}),
  ...signInRetryTiming,
});
